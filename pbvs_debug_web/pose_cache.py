#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⑩ 姿态缓存 + ⑧ 🧭转正步解析 — 调试台(server.py/queue_hub.py)与 ⑭(suction_bag.py)共用。

写方(谁更新缓存):
  · ⑩卡片 /api/{side}/posedetect      → save(side, dets, "web10")   序号=⑩表格序
  · ⑭扫描 suction_bag.py ②bag/scan    → 直接写文件(source="suction") 序号=高度序=袋#
读方(谁用缓存):
  · ⑧抓取序列里的 🧭转正步 {"pose_align":{"index":N}} — 不带任何角度参数:
    在【执行时刻】由 resolve_moves() 解析成具体的 {"rx":0,"ry":0,"rz":±deg,"frame":"tool"}:
      action=ok   (偏角≤30°, ✓可抓)        → 该步删除(跳过不转)
      action=rotate(⟳调转)                 → 腕RZ = 检测调转角 rotate_deg 原样(说转177就转177)
      action=flip (⇄反面)                  → 修正量 = −偏角(吸取不挑面)
      action=none / 无缓存 / 过期 / 序号越界 → 拒绝执行并明确报错(绝不瞎转)
    步骤在序列里的位置 = 用户自己把控的旋转时机; 角度永远跟执行时刻的检测缓存。
    解析发生在调试台侧(代理拦截 + 队列派发前), PBVS 实例零改动。
  · 10-08 定版: 两栏 angle_pos/angle_neg 与旧式 sign/angle 参数已删(ui33→ui39),
    带这些键的旧步骤一律按裸步处理(键被忽略); 方向=检测符号直接当腕RZ符号。
"""

import json
import os
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PBVS_ROOT = os.path.normpath(os.path.join(ROOT, "..", "PBVS"))
ARM_NAME = {"left": "Left_Arm", "right": "Right_Arm"}

STALE_S = 600.0          # 缓存过期上限(⑭扫描→⑧执行通常只隔几秒; 给手动流程留足)
ACT_CN = {"ok": "✓", "rotate": "⟳", "flip": "⇄", "none": "?"}


class ResolveError(Exception):
    """🧭步无法解析 — 调用方应把整个序列拦下(不执行任何动作)。"""


def _path(side):
    return os.path.join(PBVS_ROOT, "last_pose_%s.json" % ARM_NAME.get(side, side))


def _norm_det(d):
    """bag/scan det → 缓存精简字段(orient 摊平)。"""
    o = d.get("orient") or {}
    return {"cls": d.get("cls"),
            "action": o.get("action"),
            "head_dev_deg": o.get("head_dev_deg"),
            "rotate_deg": o.get("rotate_deg"),
            "conf": d.get("conf"),
            "z_mm": d.get("z_mm"),
            "centroid": d.get("centroid")}


def save(side, dets, source):
    """⑩卡片路径写入(suction_bag.py 自己直接写文件, 不经此函数)。失败只打印不抛。"""
    try:
        dump(side, [_norm_det(d) for d in (dets or [])], source)
    except Exception as e:
        print("[POSE-CACHE] save(%s) 失败: %s" % (side, e))


def dump(side, norm_dets, source):
    """原子写缓存文件(调用方保证目录可写; suction_bag 直接调本函数)。"""
    path = _path(side)
    tmp = path + ".tmp"
    obj = {"t": time.time(), "source": source, "arm": ARM_NAME.get(side, side),
           "dets": norm_dets}
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)
    return path


def load(side):
    path = _path(side)
    try:
        with open(path) as f:
            c = json.load(f)
        if isinstance(c, dict) and isinstance(c.get("dets"), list):
            return c
    except Exception:
        pass
    return None


def _need_cache(side):
    c = load(side)
    if not c or not c.get("dets"):
        raise ResolveError("没有可用的⑩检测缓存 — 先⑩「📷单次检测」或跑一次⑭扫描")
    age = time.time() - float(c.get("t") or 0)
    if age > STALE_S:
        raise ResolveError("缓存是 %.0f 分钟前的(>%.0f 分) — 重新做一次⑩检测/⑭扫描再用"
                           % (age / 60, STALE_S / 60))
    return c


def resolve_moves(side, moves):
    """moves 里的 🧭pose_align 步 → 具体旋转步/删除。→ (新moves, 说明行列表)。
    moves 无 🧭步时原样返回(不读缓存)。任何 🧭步解析失败抛 ResolveError。"""
    if not any(isinstance(m, dict) and "pose_align" in m for m in (moves or [])):
        return moves, []
    cache = _need_cache(side)
    dets = cache["dets"]
    src = "⑭扫描序=袋#" if cache.get("source") == "suction" else "⑩表序"
    out, notes = [], []
    for m in moves:
        if not (isinstance(m, dict) and "pose_align" in m):
            out.append(m)
            continue
        pa = m.get("pose_align") or {}
        try:
            idx = max(1, int(pa.get("index", 1) or 1))
        except (TypeError, ValueError):
            raise ResolveError("袋#须为整数(收到 %r)" % pa.get("index"))
        if not 1 <= idx <= len(dets):
            raise ResolveError("袋#%d 超出缓存检出 1~%d(%s, %.0f 秒前) — 先重新检测"
                               % (idx, len(dets), src,
                                  time.time() - float(cache.get("t") or 0)))
        d = dets[idx - 1]
        act = d.get("action")
        dev = d.get("head_dev_deg")
        if act == "none" or (dev is None and d.get("rotate_deg") is None):
            raise ResolveError("袋#%d 姿态无法判定(脚点不足 action=none) — 不转, 换袋或重检" % idx)
        if act == "ok":
            notes.append("#%d ✓姿态正确(α%.0f°≤30) 跳过转正" % (idx, dev or 0))
            continue
        rot = d.get("rotate_deg")
        if rot is None:
            rot = -(dev or 0.0)                     # flip: rotate_deg=None, 仍按偏角转
        # 10-08 定版: 无参数 — 腕RZ=检测调转角原样(说转177就转177)。
        # 旧步骤若还带着 angle_pos/angle_neg/sign/angle 键, 一律忽略(当裸步)。
        rz = max(-180.0, min(180.0, float(rot)))
        out.append({"rx": 0, "ry": 0, "rz": round(rz, 1), "frame": "tool"})
        notes.append("#%d %s%s α%.0f° → 腕RZ%+.0f°(检测调转值,工具系)"
                     % (idx, ACT_CN.get(act, "?"),
                        "反面," if act == "flip" else "", dev or 0, rz))
    return out, notes


def summary(c):
    """poselast 展示用: '#1⟳175° #2✓8° …'"""
    if not c:
        return ""
    return " ".join("#%d%s%.0f°" % (i + 1, ACT_CN.get(d.get("action"), "?"),
                                    d.get("head_dev_deg") or 0)
                    for i, d in enumerate(c.get("dets") or []))
