#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双臂并行循环 — 调试台 :7010 协调器 (⑮ 卡片)
================================================
左右各一条"道"(lane), 各自顺序执行本道队列项, 两道【同时跑】。底层已验证
支持真并行: :8000 fd_arm_http = FastAPI 线程池不排队, 运动闸门 Semaphore(2)
恰=双臂, fd_arm_server 每 goal 独立线程 + 每臂独立 ArmRuntime/锁, tl_driver
每臂独立 250Hz servo 线程 + 独立 TCP —— 全链路无跨臂串行锁。

轮末对齐(替代"掐表配平时长"): 每轮快的道在轮末等慢的道 → 两道每轮周期
自动相等、相位永不漂移(视觉对准耗时逐轮波动也被吸收)。右道每轮比左道晚
offset_s 出发(错峰, 防"两臂同时去中间料箱")。

失败/停止: 任一道任一项失败 → 置 stop + 双臂 exec/abort, 双臂立即同停
(与⑨"任一项失败整队停"同哲学); 停止=当前动作行进到最近检查点停、臂停原位。

道内容从现有队列预设加入(queue_presets.json 按 item.side 拆分, 道内保序);
项执行复用 queue_hub._exec(超时/停止语义完全同)。状态存内存, 重启即清。
与⑨队列双向互斥: 同一时刻只允许一个运动编排者(锁序恒为 hub→duo)。
"""

import threading
import time

from flask import Blueprint, jsonify, request

import queue_hub
from queue_hub import _abort_arm, _exec, _load_presets, _valid_item

bp = Blueprint("duo_hub", __name__)

SIDES = ("left", "right")
_lock = threading.Lock()
_stop = threading.Event()
_running = [False]
_uid = [0]
_lanes = {s: {"items": [], "batch": [], "done": [], "current": None,
              "cycle": 0, "cycle_t0": 0.0, "last_s": 0.0, "finished": False}
          for s in SIDES}
_cfg = {"loops": 1, "offset_s": 0.0}
_start_evt = {s: threading.Event() for s in SIDES}


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


def _lane_run(side):
    """道线程: 等放行 → 逐项执行本道 batch → 标记本轮完成, 等下一轮。"""
    lane = _lanes[side]
    while True:
        _start_evt[side].wait()
        if _stop.is_set():
            break
        _start_evt[side].clear()
        with _lock:
            lane["cycle_t0"] = time.time()
            cyc = lane["cycle"] + 1
        _log("[%s] 第 %d 轮开始(%d 项)" % (side, cyc, len(lane["batch"])))
        for item in lane["batch"]:
            if _stop.is_set():
                break
            with _lock:
                lane["current"] = item
            t0 = time.time()
            ok, detail = _exec(item, _stop)      # 停止/超时语义与⑨完全同
            dur = time.time() - t0
            with _lock:
                lane["current"] = None
                lane["done"].append({"uid": _uid[0], "side": side, "kind": item["kind"],
                                     "label": item["label"],
                                     "params": item.get("params") or {},
                                     "cycle": cyc, "ok": ok,
                                     "detail": detail[:100],
                                     "t": round(time.time(), 2),
                                     "dur_s": round(dur, 1)})
                _uid[0] += 1
            if not ok:
                _fail_all("[%s] %s 失败: %s" % (side, item["label"], detail[:60]))
                break
        with _lock:
            lane["cycle"] += 1
            lane["last_s"] = round(time.time() - lane["cycle_t0"], 1)
            lane["finished"] = True
        _log("[%s] 第 %d 轮结束(%.1fs)" % (side, lane["cycle"], lane["last_s"]))
        if _stop.is_set():
            break
    _log("[%s] 道线程退出" % side)


def _coord_run():
    """协调者: 等两道都完成本轮 → 左道立即放行, 右道错峰 offset_s 后放行。"""
    loops, offset = _cfg["loops"], _cfg["offset_s"]
    done_rounds = 0                               # 已完成轮数(放行过的轮都跑完才算)
    while not _stop.is_set():
        while not _stop.is_set():                 # 等两道本轮都 finished(轮末对齐)
            with _lock:
                if all(_lanes[s]["finished"] for s in SIDES):
                    break
            time.sleep(0.1)
        if _stop.is_set():
            break
        if loops and done_rounds >= loops:        # 检查在放行决策之前(差一错误防)
            _log("全部 %d 轮完成" % done_rounds)
            break
        done_rounds += 1
        with _lock:
            for s in SIDES:
                _lanes[s]["finished"] = False
        _start_evt["left"].set()                  # 左道立即
        if offset > 0 and _stop.wait(offset):     # 右道错峰; 被停止打断则不放
            break
        _start_evt["right"].set()
    _stop.set()                                   # 收尾: 唤醒并退出两道线程
    _start_evt["left"].set()
    _start_evt["right"].set()
    with _lock:
        _running[0] = False
    _log("并行循环结束(完成 %d 轮)" % done_rounds)


# ---------------- HTTP API (/api/duo/*) ----------------

@bp.route("/duo/state")
def d_state():
    with _lock:
        now = time.time()
        lanes = {}
        for s in SIDES:
            lane = _lanes[s]
            lanes[s] = {
                "pending": [{"uid": it["uid"], "label": it["label"]}
                            for it in lane["items"]],
                "current": {"label": lane["current"]["label"]}
                          if lane["current"] else None,
                "done": lane["done"][-10:],
                "cycle": lane["cycle"],
                "finished": lane["finished"],
                "elapsed_s": round(now - lane["cycle_t0"], 1)
                            if _running[0] and lane["cycle_t0"] else 0,
                "last_s": lane["last_s"],
                "waiting_next": _running[0] and lane["finished"],
            }
        return jsonify({"ok": True, "running": _running[0],
                        "loops": _cfg["loops"], "offset_s": _cfg["offset_s"],
                        "lanes": lanes})


@bp.route("/duo/preset/add", methods=["POST"])
def d_preset_add():
    """把现有队列预设按 item.side 拆进左右道(追加, 道内保序, 重编 uid)。
    混含左右的预设返回 mixed=true(前端提示串行先后不保留)。"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    ps = _load_presets()
    if name not in ps:
        return jsonify({"ok": False, "error": "预设不存在: %s" % name}), 400
    items = [it for it in ps[name] if _valid_item(it)]
    if not items:
        return jsonify({"ok": False, "error": "预设里没有有效项"}), 400
    mixed = len({it.get("side") for it in items}) > 1
    with _lock:
        if _running[0]:
            return jsonify({"ok": False, "error": "执行中不能加入, 先停止"}), 400
        added = {s: 0 for s in SIDES}
        for it in items:
            s = it["side"]
            _lanes[s]["items"].append({"uid": _uid[0], "side": s, "kind": it["kind"],
                                       "label": str(it.get("label") or it["kind"])[:80],
                                       "params": it.get("params") or {}})
            _uid[0] += 1
            added[s] += 1
        pending = {s: len(_lanes[s]["items"]) for s in SIDES}
    _log("预设「%s」已拆分加入: 左+%d 右+%d" % (name, added["left"], added["right"]))
    return jsonify({"ok": True, "added": added, "mixed": mixed, "pending": pending})


@bp.route("/duo/lane", methods=["POST"])
def d_lane():
    """道内项调序/移除。body: {side, op:"move"|"remove", uid, dir:"up"|"down"}。"""
    data = request.get_json(silent=True) or {}
    side = data.get("side")
    if side not in _lanes:
        return jsonify({"ok": False, "error": "side 需是 left/right"}), 400
    uid, op = data.get("uid"), data.get("op", "move")
    with _lock:
        if _running[0] and op == "move":
            return jsonify({"ok": False, "error": "执行中不能调序(移除仅影响未跑轮次)"}), 400
        items = _lanes[side]["items"]
        idx = next((i for i, it in enumerate(items) if it.get("uid") == uid), None)
        if idx is None:
            return jsonify({"ok": False, "error": "未找到该 uid"}), 400
        if op == "remove":
            items.pop(idx)
            return jsonify({"ok": True, "removed": True})
        if op != "move":
            return jsonify({"ok": False, "error": "op 需是 move|remove"}), 400
        d = data.get("dir")
        j = idx - 1 if d == "up" else idx + 1 if d == "down" else None
        if j is None:
            return jsonify({"ok": False, "error": "dir 需是 up|down"}), 400
        if j < 0 or j >= len(items):
            return jsonify({"ok": False, "error": "已在边界"}), 400
        items[idx], items[j] = items[j], items[idx]
    return jsonify({"ok": True})


@bp.route("/duo/run", methods=["POST"])
def d_run():
    """开始并行循环。body: {loops:N(0=∞), offset_s:右臂每轮错峰秒}。
    轮末对齐: 每轮快的道等慢的道; 任一项失败双臂同停。"""
    data = request.get_json(silent=True) or {}
    try:
        loops = int(data.get("loops", 1))
    except (TypeError, ValueError):
        loops = 1
    loops = max(0, min(999, loops))
    try:
        offset = float(data.get("offset_s", 0.0))
    except (TypeError, ValueError):
        offset = 0.0
    offset = max(0.0, min(60.0, offset))
    with queue_hub._lock:                        # 锁序恒 hub→duo, 与 q_run 相反方向不死锁
        hub_running = queue_hub._running[0]
    with _lock:
        if _running[0]:
            return jsonify({"ok": False, "error": "并行循环已在执行"}), 400
        if hub_running:
            return jsonify({"ok": False, "error": "⑨ 队列正在执行, 先停止它"}), 400
        if not _lanes["left"]["items"] or not _lanes["right"]["items"]:
            return jsonify({"ok": False, "error": "左右两道都要有项(各至少 1 项, 从预设加入)"}), 400
        for s in SIDES:
            lane = _lanes[s]
            lane["batch"] = [dict(it) for it in lane["items"]]   # 启动快照
            lane["done"] = []
            lane["current"] = None
            lane["cycle"] = 0
            lane["cycle_t0"] = 0.0
            lane["last_s"] = 0.0
            lane["finished"] = True   # 首道闸门直通(协调者等"上轮完成"才放行, 第1轮无上轮)
        _cfg.update({"loops": loops, "offset_s": offset})
        _stop.clear()
        for s in SIDES:
            _start_evt[s].clear()
        _running[0] = True
    threading.Thread(target=_coord_run, daemon=True).start()
    for s in SIDES:
        threading.Thread(target=_lane_run, args=(s,), daemon=True).start()
    _log("并行循环启动: %s, 右臂错峰 %.1fs" %
         ("无限循环" if not loops else "%d 轮" % loops, offset))
    return jsonify({"ok": True, "loops": loops, "offset_s": offset})


@bp.route("/duo/stop", methods=["POST"])
def d_stop():
    """用户停止: 双臂当前动作到最近检查点停下, 剩余轮次不再执行。"""
    was_running = duo_running()
    _fail_all("用户停止")
    return jsonify({"ok": True, "running": was_running,
                    "message": "停止信号已发, 双臂将在最近检查点停下"})


@bp.route("/duo/clear", methods=["POST"])
def d_clear():
    with _lock:
        if _running[0]:
            return jsonify({"ok": False, "error": "执行中, 先停止"}), 400
        for s in SIDES:
            _lanes[s].update({"items": [], "batch": [], "done": [], "current": None,
                              "cycle": 0, "cycle_t0": 0.0, "last_s": 0.0,
                              "finished": False})
    return jsonify({"ok": True})
