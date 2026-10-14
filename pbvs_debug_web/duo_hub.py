#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
/duo 双臂并行运行页 — 整流程循环 · 双臂同时工作 · 中间区互斥
================================================
(原⑮并行循环卡后端, 2026-10-12 重写为独立运行页引擎。)

配置 config/duo_page.json: 与 /run 页同 schema 的左右混排单序列(每步可带
mid:true|false 覆盖), 启动时按 side 拆两道 —— 各臂内部保序, 跨臂先后
【不保留】(两臂真并行, 与⑨/run 页的串行语义不同)。

防撞 = 中间区互斥锁 _mid_lock: 两臂绝不同时进中间区。每步是否中区由自动
规则打默认(_compute_mid 状态机), 可逐步手动覆盖(强制中/强制非中):
  段外: 文本(label+示教点名)含「中」=入口步; 段内: teach_goto 不含「中」
  =退出步(回侧边途中仍经过中间 → 仍持锁), 其余一律中区。
连续中区段的第一步前取锁(等待中 UI 显⏳等中), 段尾步完成后放锁;
轮末仍持锁也放(轮边界=天然放锁点, 不跨轮霸占)。

节奏 = 自由循环: 两道各自独立循环, 无轮末对齐、无错峰(旧版机制已删),
唯一交互是中区锁。任一道任一步失败 → 双臂立即同停(与⑨同哲学)。

执行复用 queue_hub._exec(item, _stop)(超时/停止语义/🧭解析与⑨完全同);
计时/运行日志写同一对文件(run_log.jsonl / run_timing.jsonl, round 事件
带 side)。与⑨队列双向互斥: 同一时刻只允许一个运动编排者(锁序恒 hub→duo,
启动检查在 hub._lock 内做掉, 与 q_run 的 TOCTOU 也一并堵死)。

锁纪律: _lock 守道/运行态; _mid_lock 等待循环绝不持 _lock(否则堵死另一道
的 state 读); 文件 _flock 只串行化 duo_page.json 读-改-写, 三把锁互不嵌套
(_lock 与 _mid_lock 由道线程按「先 _lock 改标志 → 再碰 _mid_lock」使用)。
"""

import json
import os
import threading
import time

from flask import Blueprint, jsonify, request

import queue_hub
from queue_hub import (_abort_arm, _exec, _pbvs, _rlog, _tlog,
                       _timing_seq)
from runpage import _load_run as _load_runpage, _norm_loops, _valid_step

bp = Blueprint("duo_hub", __name__)

SIDES = ("left", "right")
SIDE_CN = {"left": "左", "right": "右"}
PAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "config", "duo_page.json")
_flock = threading.Lock()          # 串行化 duo_page.json 读-改-写(绝不与 _lock 嵌套)

_lock = threading.Lock()           # 守 _lanes/_running/_loops/_run_fail/_lane_alive
_stop = threading.Event()          # 全局停止旗(两道共用, 同⑨哲学)
_mid_lock = threading.Lock()       # 中间区互斥锁: 两臂绝不同时进中间
_running = [False]
_loops = [0]                       # 本次运行轮数(0=∞)
_run_t0 = [0.0]                    # 本次运行起点(run_summary 用)
_run_fail = [None]                 # 首个失败步信息(run_end 落日志)
_lane_alive = {s: False for s in SIDES}
_lanes = {s: {"batch": [], "mids": [], "sections": [], "done": [],
              "current": None, "cur_t0": 0.0, "cur_idx": -1,
              "cycle": 0, "cycle_t0": 0.0, "last_s": 0.0, "durs": [],
              "waiting_mid": False, "holding_mid": False}
          for s in SIDES}


def _log(msg):
    try:
        print("[DUO] %s" % msg, flush=True)
    except Exception:
        pass


def duo_running():
    with _lock:
        return _running[0]


def _fail_all(reason):
    """失败/用户停止: 双臂立即同停(置 stop + 双臂 exec/abort)。"""
    _stop.set()
    for s in SIDES:
        _abort_arm(s)
    _log("双停: %s" % reason)


# ---------------- 页面文件(config/duo_page.json) ----------------

def _load_page():
    try:
        with open(PAGE_FILE) as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {"saved_at": 0, "loops": 1, "steps": []}


def _save_page(d):
    os.makedirs(os.path.dirname(PAGE_FILE), exist_ok=True)
    tmp = PAGE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PAGE_FILE)


def _norm_page_step(it):
    """归一化一步(剥多余字段, 保留 mid 覆盖: True/False, 缺省=自动)。"""
    out = {"side": it["side"], "kind": it["kind"],
           "label": str(it.get("label") or it["kind"])[:80],
           "params": it.get("params") or {}}
    if it.get("mid") is True or it.get("mid") is False:
        out["mid"] = it["mid"]
    return out


# ---------------- 中区判定(自动规则状态机) ----------------

def _step_text(it):
    """中区判定用文本 = label + 示教点名(teach_goto 的 name / teach_play 的 names)。"""
    p = it.get("params") or {}
    parts = [str(it.get("label") or "")]
    if isinstance(p.get("name"), str):
        parts.append(p["name"])
    if isinstance(p.get("names"), list):
        parts.extend(str(n) for n in p["names"])
    return " ".join(parts)


def _compute_mid(items):
    """一道步骤 → (每步有效 mid 列表, 连续中区段 sections[(i0,i1),...])。

    显式覆盖永远赢: mid:true=中区且开段; mid:false=非中区且段在该步前收
    (锁放行后此步才跑)。无覆盖: 段外=文本含「中」开段(入口步); 段内=
    teach_goto 不含「中」是退出步(本步仍持锁走完, 段在此步闭合), 其余中区。
    """
    mids = []
    in_mid = False
    for it in items:
        ov = it.get("mid")
        if ov is True:
            mid, in_mid = True, True
        elif ov is False:
            mid, in_mid = False, False
        elif not in_mid:
            mid = "中" in _step_text(it)
            if mid:
                in_mid = True
        else:
            mid = True                          # 段内默认持锁
            if it.get("kind") == "teach_goto" and "中" not in _step_text(it):
                in_mid = False                   # 退出步: 本步仍中区, 段在此闭合
        mids.append(mid)
    sections, i = [], 0
    while i < len(mids):
        if mids[i]:
            j = i
            while j + 1 < len(mids) and mids[j + 1]:
                j += 1
            sections.append((i, j))
            i = j + 1
        else:
            i += 1
    return mids, sections


def _mid_preview(steps):
    """混排单序列 → UI 预览(每步有效 mid + 纯自动值交错列表, 各道 sections)。
    autos = 剥掉全部 mid 覆盖后的自动判定 — 前端「中」徽章三态循环靠它对
    比当前覆盖; mids = 含覆盖的有效值(=启动时同一 _compute_mid, 所见即所跑)。"""
    split = {s: [it for it in steps if it.get("side") == s] for s in SIDES}
    out = {"mids": [], "autos": [], "sections": {}}
    lane_mids, lane_autos = {}, {}
    for s in SIDES:
        lane_mids[s], out["sections"][s] = _compute_mid(split[s])
        stripped = [{k: v for k, v in it.items() if k != "mid"} for it in split[s]]
        lane_autos[s], _ = _compute_mid(stripped)
    lane_idx = {s: 0 for s in SIDES}
    for it in steps:
        s = it.get("side")
        ok = s in SIDES and lane_idx[s] < len(lane_mids[s])
        out["mids"].append(bool(lane_mids[s][lane_idx[s]]) if ok else False)
        out["autos"].append(bool(lane_autos[s][lane_idx[s]]) if ok else False)
        if s in SIDES:
            lane_idx[s] += 1
    return out


# ---------------- 中区锁(等待绝不持 _lock) ----------------

def _acquire_mid(side):
    """stop 感知取中区锁(阻塞中标 waiting_mid 供 UI 显⏳)。False=等锁中被停止。"""
    lane = _lanes[side]
    while True:
        if _stop.is_set():
            return False
        if _mid_lock.acquire(timeout=0.25):
            with _lock:
                lane["waiting_mid"] = False
                lane["holding_mid"] = True
            return True
        with _lock:
            lane["waiting_mid"] = True


def _release_mid(side):
    lane = _lanes[side]
    with _lock:
        lane["waiting_mid"] = False
        lane["holding_mid"] = False
    try:
        _mid_lock.release()
    except RuntimeError:
        pass


# ---------------- 道线程(自由循环) ----------------

def _lane_run(side):
    """道线程: 本道 batch 逐项执行 → 轮数跑满/停止/失败退出。中区段按
    mids 取放锁(段前取、段尾放、轮末放); 每步/每轮落 rlog+tlog(带 side)。"""
    lane = _lanes[side]
    holding = False
    fail = None
    try:
        while not _stop.is_set():
            if _loops[0] and lane["cycle"] >= _loops[0]:
                break                            # 本道轮数跑满
            with _lock:
                lane["cycle"] += 1
                cyc = lane["cycle"]
                cyc_t0 = time.time()
                lane["cycle_t0"] = cyc_t0
                lane["cur_idx"] = -1
            batch, mids = lane["batch"], lane["mids"]
            try:                                 # 本轮起跑时本臂全局速度(离线=null)
                spd = _pbvs(side, "speed", None, timeout=5).get("speed")
            except Exception:
                spd = None
            _log("[%s] 第 %d 轮开始(%d 项, 中区段 %s)" %
                 (side, cyc, len(batch),
                  ",".join("%d-%d" % sec for sec in lane["sections"]) or "无"))
            _rlog("cycle_start", side=side, cycle=cyc, items=len(batch))
            step_durs = []
            idx = 0
            for i, item in enumerate(batch):
                if _stop.is_set():
                    break
                need = mids[i]
                if need and not holding:
                    if not _acquire_mid(side):   # 等锁中被停止
                        break
                    holding = True
                elif not need and holding:
                    _release_mid(side)           # 段尾步已完成 → 放锁
                    holding = False
                with _lock:
                    lane["current"] = item
                    lane["cur_t0"] = time.time()
                    lane["cur_idx"] = i
                idx += 1
                t0 = time.time()
                ok, detail = _exec(item, _stop)  # 停止/超时语义与⑨完全同
                dur = time.time() - t0
                with _lock:
                    lane["current"] = None
                    lane["cur_t0"] = 0.0
                    lane["done"].append({"side": side, "kind": item["kind"],
                                         "label": item["label"], "mid": bool(need),
                                         "cycle": cyc, "ok": ok,
                                         "detail": (detail or "")[:100],
                                         "t": round(time.time(), 2),
                                         "dur_s": round(dur, 1)})
                    if len(lane["done"]) > 200:  # ∞循环不涨爆
                        del lane["done"][:-200]
                _rlog("step_done", side=side, cycle=cyc, label=item["label"],
                      ok=ok, dur_s=round(dur, 1), detail=detail)
                _tlog({"t": round(time.time(), 2), "event": "step",
                       "seq": _timing_seq[0], "cycle": cyc, "idx": idx,
                       "side": side, "kind": item["kind"],
                       "label": item["label"], "ok": ok,
                       "start": round(t0, 2), "end": round(t0 + dur, 2),
                       "dur_s": round(dur, 2)})
                step_durs.append(dur)
                if not ok:
                    fail = {"side": side, "label": item["label"], "detail": detail}
                    _fail_all("[%s] %s 失败: %s" % (side, item["label"],
                                                    (detail or "")[:60]))
                    break
            if holding:                          # 轮末仍持锁 → 放(轮边界不霸占)
                _release_mid(side)
                holding = False
            cyc_t1 = time.time()
            wall = cyc_t1 - cyc_t0
            with _lock:
                lane["durs"].append(wall)
                if len(lane["durs"]) > 100:
                    del lane["durs"][:-100]
                lane["last_s"] = round(wall, 1)
            _tlog({"t": round(cyc_t1, 2), "event": "round",
                   "seq": _timing_seq[0], "side": side, "cycle": cyc,
                   "start": round(cyc_t0, 2), "end": round(cyc_t1, 2),
                   "dur_s": round(wall, 2), "steps": idx,
                   "step_sum_s": round(sum(step_durs), 2),
                   "overhead_s": round(wall - sum(step_durs), 2),
                   "speed": {side: spd},
                   "ended": "failed" if fail
                   else ("stopped" if _stop.is_set() else "ok")})
            _log("[%s] 第 %d 轮结束(%.1fs)" % (side, cyc, wall))
    finally:
        if holding:                              # 兜底: 异常退出也不吊着锁
            _release_mid(side)
    _lane_done(side, fail)


def _lane_done(side, fail):
    """道线程收尾: 记失败信息; 最后一道退出者(锁内判)写 run_end/run_summary。"""
    _log("[%s] 道线程退出" % side)
    finalize = False
    with _lock:
        if fail:
            _run_fail[0] = _run_fail[0] or fail
        _lane_alive[side] = False
        finalize = not any(_lane_alive[s] for s in SIDES)
    if finalize:
        try:
            _finalize_run()
        except Exception as e:
            _log("finalize 异常: %s" % e)
            with _lock:
                _running[0] = False


def _finalize_run():
    """两道都退出后收尾: run_end + run_summary(带各道轮数) + 复位运行态。
    reason 先查 stopped 再查 failed(与⑨同序 — stop 触发的步失败不算失败)。"""
    with _lock:
        cycs = {s: _lanes[s]["cycle"] for s in SIDES}
        durs = {s: list(_lanes[s]["durs"]) for s in SIDES}
    reason = "stopped" if _stop.is_set() else \
        ("failed" if _run_fail[0] else "completed")
    end = {"reason": reason, "cycle": cycs}
    if _run_fail[0]:
        end["failed"] = _run_fail[0]
    _rlog("run_end", **end)
    now = time.time()
    lanes_sum = {}
    for s in SIDES:
        lanes_sum[s] = {"rounds": cycs[s],
                        "avg_round_s": round(sum(durs[s]) / len(durs[s]), 2)
                        if durs[s] else 0.0,
                        "round_durs": [round(w, 2) for w in durs[s][-100:]]}
    _tlog({"t": round(now, 2), "event": "run_summary", "seq": _timing_seq[0],
           "reason": reason, "rounds": max(cycs.values()),
           "lanes": lanes_sum,
           "start": round(_run_t0[0], 2), "end": round(now, 2),
           "dur_s": round(now - _run_t0[0], 2)})
    _log("双臂并行结束(%s): 左 %d 轮 / 右 %d 轮" %
         (reason, cycs["left"], cycs["right"]))
    with _lock:
        _running[0] = False
        for s in SIDES:
            lane = _lanes[s]
            lane["current"] = None
            lane["cur_t0"] = 0.0
            lane["waiting_mid"] = False
            lane["holding_mid"] = False


# ---------------- HTTP API (/api/duopage/* 与 /api/duo/*) ----------------

@bp.route("/duopage/state")
def dp_state():
    """页面文档 + 中区预览(与启动同一 _compute_mid, 所见即所跑)。"""
    with _flock:
        d = _load_page()
    steps = d.get("steps") or []
    valid = [it for it in steps if isinstance(it, dict)]
    prev = _mid_preview(valid)
    return jsonify({"ok": True, "saved_at": d.get("saved_at", 0),
                    "loops": d.get("loops", 1), "steps": steps,
                    "mid_preview": prev, "file": PAGE_FILE})


@bp.route("/duopage/save", methods=["POST"])
def dp_save():
    """整文档保存。body: {loops?, steps?} — 缺键保留现值。执行中允许(只写文件,
    本轮由启动快照驱动, 改动下次启动才生效)。"""
    data = request.get_json(silent=True) or {}
    with _flock:
        d = _load_page()
        if "loops" in data:
            d["loops"] = _norm_loops(data.get("loops"))
        if "steps" in data:
            steps = data.get("steps")
            if not isinstance(steps, list):
                return jsonify({"ok": False, "error": "steps 需是数组"}), 400
            for i, it in enumerate(steps):
                if not (isinstance(it, dict) and _valid_step(it)):
                    return jsonify({"ok": False, "error":
                                    "第 %d 项无效(需 side=left/right, kind∈%s, params为字典)"
                                    % (i + 1, "/".join(queue_hub.Q_KINDS))}), 400
            d["steps"] = [_norm_page_step(it) for it in steps]
        d["saved_at"] = time.time()
        try:
            _save_page(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    return jsonify({"ok": True, "count": len(d.get("steps") or []),
                    "saved_at": d["saved_at"]})


@bp.route("/duopage/import_run", methods=["POST"])
def dp_import_run():
    """从 /run 运行页拷步骤过来(mid 覆盖清零, loops 保留本页现值)。
    duo 执行中拒绝(跑中导入会误导「跑的是新流程」)。"""
    if duo_running():
        return jsonify({"ok": False, "error": "执行中不能导入 — 先停止"}), 400
    src = _load_runpage()
    steps = [it for it in (src.get("steps") or [])
             if isinstance(it, dict) and _valid_step(it)]
    if not steps:
        return jsonify({"ok": False, "error":
                        "/run 页流程为空 — 先在那边保存或从⑮快照"}), 400
    split = {s: [it for it in steps if it.get("side") == s] for s in SIDES}
    if not split["left"] or not split["right"]:
        return jsonify({"ok": False, "error":
                        "/run 页流程只有单臂(%d左/%d右) — 并行页需要两臂都有步骤"
                        % (len(split["left"]), len(split["right"]))}), 400
    norm = [_norm_page_step(it) for it in steps]
    with _flock:
        d = _load_page()
        d["steps"] = norm
        d["saved_at"] = time.time()
        try:
            _save_page(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    _log("从运行页导入 %d 步(左%d/右%d)" %
         (len(norm), len(split["left"]), len(split["right"])))
    return jsonify({"ok": True, "count": len(norm),
                    "lanes": {"left": len(split["left"]),
                              "right": len(split["right"])}})


@bp.route("/duopage/start", methods=["POST"])
def dp_start():
    """「一键开始」: 读文件 → 拆道+算中区 → 起两道线程自由循环。
    互斥检查在 queue_hub._lock 内做(锁序 hub→duo): 与 q_run 的
    「查duo→置hub」「查hub→置duo」双向 TOCTOU 一并堵死。"""
    data = request.get_json(silent=True) or {}
    loops = _norm_loops(data.get("loops"))
    with _flock:
        d = _load_page()
        steps = d.get("steps") or []
        for i, it in enumerate(steps):
            if not (isinstance(it, dict) and _valid_step(it)):
                return jsonify({"ok": False, "error":
                                "文件第 %d 项无效, 先在双臂页修正后保存" % (i + 1)}), 400
        d["loops"] = loops                       # 起线程前先持久化, 防丢
        try:
            _save_page(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    split = {s: [_norm_page_step(it) for it in steps if it.get("side") == s]
             for s in SIDES}
    if not split["left"] or not split["right"]:
        return jsonify({"ok": False, "error":
                        "左右两臂都要有步骤(左%d/右%d) — 并行页两道都不能为空"
                        % (len(split["left"]), len(split["right"]))}), 400
    with queue_hub._lock:                        # 锁序恒 hub→duo
        with _lock:
            if _running[0]:
                return jsonify({"ok": False, "error": "双臂并行已在执行"}), 400
            if queue_hub._running[0]:
                return jsonify({"ok": False, "error":
                                "⑨ 队列正在执行, 先停止它"}), 400
            _stop.clear()
            _run_fail[0] = None
            _run_t0[0] = time.time()
            for s in SIDES:
                lane = _lanes[s]
                lane["batch"] = split[s]
                lane["mids"], lane["sections"] = _compute_mid(split[s])
                lane["done"] = []
                lane["current"] = None
                lane["cur_t0"] = 0.0
                lane["cur_idx"] = -1
                lane["cycle"] = 0
                lane["cycle_t0"] = 0.0
                lane["last_s"] = 0.0
                lane["durs"] = []
                lane["waiting_mid"] = False
                lane["holding_mid"] = False
                _lane_alive[s] = True
            _loops[0] = loops
            _running[0] = True
    # 先落 run_start 再起线程 — 否则道线程可能先写 cycle_start, 日志乱序
    _timing_seq[0] += 1
    _rlog("run_start", source="双臂并行页", loops=loops, steps=len(steps),
          plan=[{"side": it["side"], "label": it["label"]} for it in steps])
    _tlog({"t": round(time.time(), 2), "event": "run_start", "seq": _timing_seq[0],
           "source": "双臂并行页", "loops": loops, "steps": len(steps),
           "lanes": {"left": len(split["left"]), "right": len(split["right"])}})
    for s in SIDES:
        threading.Thread(target=_lane_run, args=(s,), daemon=True).start()
    _log("双臂并行启动: %s, 左 %d 步 / 右 %d 步" %
         ("无限循环" if not loops else "%d 轮" % loops,
          len(split["left"]), len(split["right"])))
    return jsonify({"ok": True, "loops": loops,
                    "lanes": {"left": len(split["left"]),
                              "right": len(split["right"])}})


@bp.route("/duo/state")
def d_state():
    """双道实时状态(1s 轮询): 当前步/步序/轮次/最近完成/⏳等中/🔒持中。"""
    with _lock:
        now = time.time()
        lanes = {}
        for s in SIDES:
            lane = _lanes[s]
            cur = lane["current"]
            lanes[s] = {
                "current": {"label": cur["label"],
                            "mid": bool(lane["mids"][lane["cur_idx"]])
                            if cur and 0 <= lane["cur_idx"] < len(lane["mids"])
                            else False} if cur else None,
                "cur_t0": lane["cur_t0"],
                "cur_idx": lane["cur_idx"],
                "steps": len(lane["batch"]),
                "done": lane["done"][-10:],
                "cycle": lane["cycle"],
                "cycle_total": _loops[0],
                "elapsed_s": round(now - lane["cycle_t0"], 1)
                             if _running[0] and lane["cycle_t0"] else 0,
                "last_s": lane["last_s"],
                "waiting_mid": lane["waiting_mid"],
                "holding_mid": lane["holding_mid"],
                "sections": lane["sections"],
            }
        mid_holder = next((s for s in SIDES if lanes[s]["holding_mid"]), None)
        return jsonify({"ok": True, "running": _running[0], "loops": _loops[0],
                        "mid_holder": mid_holder, "now": round(now, 2),
                        "lanes": lanes})


@bp.route("/duo/stop", methods=["POST"])
def d_stop():
    """用户停止: 等锁的道立即放弃, 持锁/执行中的臂到最近检查点停下,
    剩余轮次不再执行(道线程各自收尾, 最后退出者写 run_end)。"""
    was_running = duo_running()
    _fail_all("用户停止")
    return jsonify({"ok": True, "running": was_running,
                    "message": "停止信号已发, 双臂将在最近检查点停下"})
