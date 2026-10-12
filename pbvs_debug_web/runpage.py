#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
/run 运行页后端 — 实机整流程循环执行
================================================
⑮「保存到运行页」把当前组好的队列快照成本页自己的最终流程
(config/run_page.json, 文件持久化重启不丢, 与队列预设/示教点/抓取预设完全脱钩)。
本页可逐项改名/改参数(⑧序列含逐条 moves) → /runpage/save 只写本文件;
「一键开始」→ /runpage/start 读文件 → queue_hub.load_and_run 在同一把锁内
原子完成「换入共用队列+启动循环」(拒绝条件与 /queue/run 相同)。
停止/进度不加端点: 复用 /api/queue/stop、/api/queue/state。

锁纪律: 队列访问只经 queue_hub.snapshot_pending()/running(), 文件访问只持 _flock,
绝不嵌套两把锁(照 q_preset_save 先快照后写文件的模式)。
执行中允许 save(只写文件); 本轮由 queue_hub 启动快照驱动, 改动下次启动才生效。
"""

import json
import os
import threading
import time

from flask import Blueprint, jsonify, request

import queue_hub

bp = Blueprint("runpage", __name__)

_RUN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "config", "run_page.json")
_flock = threading.Lock()          # 串行化文件的读-改-写
_PBVS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "PBVS")


def _load_run():
    try:
        with open(_RUN_FILE) as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {"saved_at": 0, "loops": 1, "steps": []}


def _save_run(d):
    os.makedirs(os.path.dirname(_RUN_FILE), exist_ok=True)
    tmp = _RUN_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _RUN_FILE)


def _valid_step(it):
    """同 queue_hub._valid_item, 再要求 params 是 dict。"""
    return (queue_hub._valid_item(it)
            and isinstance(it.get("params") or {}, dict))


# ---------------- ⑧抓取预设按 moves 匹配 → 步骤名用预设名 ----------------

_LEGACY_PA = ("angle_pos", "angle_neg", "sign", "angle", "pa_angle_pos", "pa_angle_neg")


def _norm_moves(moves):
    """moves 归一化供比较: 剥 legacy pose_align 键 + 浮点圆整(消除 JSON 往返误差)。"""
    out = []
    for mv in moves or []:
        if not isinstance(mv, dict):
            out.append(mv)
            continue
        m = {}
        for k, v in mv.items():
            if k == "pose_align" and isinstance(v, dict):
                m[k] = {kk: vv for kk, vv in v.items() if kk not in _LEGACY_PA}
            elif isinstance(v, float):
                m[k] = round(v, 6)
            else:
                m[k] = v
        out.append(m)
    return out


_GRASP_CACHE = {"t": 0.0, "data": None}     # 抓取预设缓存(5s, 按臂)


def _grasp_presets(side):
    now = time.time()
    if _GRASP_CACHE["data"] is None or now - _GRASP_CACHE["t"] > 5:
        data = {}
        for s, arm in (("left", "Left_Arm"), ("right", "Right_Arm")):
            try:
                with open(os.path.join(_PBVS_ROOT,
                                       "grasp_presets_%s.json" % arm)) as f:
                    d = json.load(f)
                data[s] = {p.get("name"): _norm_moves(p.get("moves"))
                           for p in d.get("presets", []) if p.get("name")}
            except Exception:
                data[s] = {}
        _GRASP_CACHE["data"] = data
        _GRASP_CACHE["t"] = now
    return _GRASP_CACHE["data"].get(side, {})


def _grasp_preset_name(step):
    """⑧步骤的 moves 与已存抓取预设完全一致 → 预设名(找不到 None, 尽力而为)。"""
    if step.get("kind") != "grasp_seq":
        return None
    mv = _norm_moves((step.get("params") or {}).get("moves"))
    for name, pmv in _grasp_presets(step.get("side")).items():
        if pmv == mv:
            return name
    return None


def _norm_loops(v, default=1):
    try:
        return max(0, min(999, int(v)))
    except (TypeError, ValueError):
        return default


@bp.route("/runpage/state")
def rp_state():
    with _flock:
        d = _load_run()
    return jsonify({"ok": True, "saved_at": d.get("saved_at", 0),
                    "loops": d.get("loops", 1),
                    "steps": d.get("steps") or [],
                    "file": _RUN_FILE})


@bp.route("/runpage/save", methods=["POST"])
def rp_save():
    """整文档保存(运行页「保存全部修改」)。body: {loops?, steps?} — 缺键保留现值。
    执行中允许: 只写本文件, 不碰共用队列。"""
    data = request.get_json(silent=True) or {}
    with _flock:
        d = _load_run()
        if "loops" in data:
            d["loops"] = _norm_loops(data.get("loops"))
        if "steps" in data:
            steps = data.get("steps")
            if not isinstance(steps, list):
                return jsonify({"ok": False, "error": "steps 需是数组"}), 400
            for i, it in enumerate(steps):
                if not _valid_step(it):
                    return jsonify({"ok": False, "error":
                                    "第 %d 项无效(需 side=left/right, kind∈%s, params为字典)"
                                    % (i + 1, "/".join(queue_hub.Q_KINDS))}), 400
            d["steps"] = [{"side": it["side"], "kind": it["kind"],
                           "label": str(it.get("label") or it["kind"])[:80],
                           "params": it.get("params") or {}} for it in steps]
        d["saved_at"] = time.time()
        try:
            _save_run(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    return jsonify({"ok": True, "count": len(d.get("steps") or []), "saved_at": d["saved_at"]})


@bp.route("/runpage/fromqueue", methods=["POST"])
def rp_fromqueue():
    """⑮「保存到运行页」: 把当前组好的队列(共用待执行项, 按实际顺序含左右标记)
    快照成本页最终流程。执行中拒绝(跑中 pending 只是本轮剩余, 不是完整流程)。"""
    if queue_hub.running():
        return jsonify({"ok": False, "error":
                        "执行中不能保存 — 先停止(跑中的待执行项只是本轮剩余)"}), 400
    steps = queue_hub.snapshot_pending()
    if not steps:
        return jsonify({"ok": False, "error":
                        "队列为空 — 先在 ⑮「＋加入」预设或到 ④⑦⑧⑭ 入队再保存"}), 400
    named = 0
    for st in steps:                        # ⑧步骤名 = 抓取预设名(moves 完全一致才匹配)
        n = _grasp_preset_name(st)
        if n:
            st["label"] = ("⑧抓取·" + n)[:80]
            named += 1
    with _flock:
        d = _load_run()
        d["steps"] = steps                 # loops 保留现值
        d["saved_at"] = time.time()
        try:
            _save_run(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    return jsonify({"ok": True, "count": len(steps), "named": named})


@bp.route("/runpage/start", methods=["POST"])
def rp_start():
    """「一键开始」: 读文件 → 持久化 loops → queue_hub.load_and_run(换入+启动原子)。
    跑的就是文件里存的(所见即所跑)。"""
    data = request.get_json(silent=True) or {}
    loops = _norm_loops(data.get("loops"))
    with _flock:
        d = _load_run()
        steps = d.get("steps") or []
        for i, it in enumerate(steps):
            if not _valid_step(it):
                return jsonify({"ok": False, "error":
                                "文件第 %d 项无效, 先在运行页修正后保存" % (i + 1)}), 400
        d["loops"] = loops                 # 起线程前先持久化, 防丢
        try:
            _save_run(d)
        except Exception as e:
            return jsonify({"ok": False, "error": "写文件失败: %s" % e}), 500
    res, err = queue_hub.load_and_run(steps, loops)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "pending": res["pending"], "loops": res["loops"]})
