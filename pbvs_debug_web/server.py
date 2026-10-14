#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PBVS 调试聚合服务 — 0.0.0.0:7010
================================================
单页调试界面的后端,不修改 PBVS 任何代码:
  - 同源代理  PBVS 双实例 (:7004 left / :7005 right) 与 fd_arm_http (:8000)
  - MJPEG     优先转发 WS 远程相机流(Windows 采集电脑, 2026-10-11 起相机物理在其上,
              原始 JPEG 零转码); WS 断流回退拉 PBVS /preview, 再不行发占位图
  - 状态缓存  1Hz 轮询双实例 /status + :8000 关节角,环形存 10 分钟
  - reference 解析 J 矩阵 → 列模长([0.8,1.2] 门限) + 条件数(<50 门限)
  - 日志尾随  /tmp/pbvs_{left,right}.log

以 user 身份运行(flask/numpy 在 user 的 ~/.local),本身不需要 ROS 环境。
systemd: pbvs-debug-web.service;手动: sudo -u user bash start.sh
"""

import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque

from flask import Flask, jsonify, request, Response, send_from_directory

from recover import bp as recover_bp   # 一键恢复(总电源重启后)
from queue_hub import bp as queue_bp   # 左右共用动作队列(协调器)
from duo_hub import bp as duo_bp       # ⑮ 双臂并行循环(左右道同时跑, 轮末对齐)
from runpage import bp as runpage_bp   # /run 运行页(整流程循环, config/run_page.json 持久化)
import pose_cache                      # ⑩姿态缓存 + ⑧🧭转正步解析(⑩卡片/⑭扫描写, ⑧读)

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
PBVS_ROOT = os.path.join(ROOT, "..", "PBVS")

SIDES = {"left": 7004, "right": 7005}          # side → PBVS 实例端口
ARM_NAME = {"left": "Left_Arm", "right": "Right_Arm"}
LOG_FILES = {"left": "/tmp/pbvs_left.log", "right": "/tmp/pbvs_right.log"}

# ---------------------------------------------------------------- WS 远程相机中继
# 2026-10-11 起两台 D435 插在 Windows 采集电脑(192.168.2.200)上, 由其经
# WebSocket 转发彩色 JPEG 流。本服务作为中继客户端(每相机一条常驻连接,
# 断线自动重连), /api/<side>/video 优先转发该流, 原始 JPEG 零转码。
# 相机若回插 Jetson(7004/7005 preview 复活), video 自动回退旧链路。

sys.path.insert(0, PBVS_ROOT)   # 复用 PBVS 侧客户端 core/ws_camera.py
from core.ws_camera import WsCamera, SERIAL_LEFT, SERIAL_RIGHT

WS_SERIAL = {"left": SERIAL_LEFT, "right": SERIAL_RIGHT}
_ws_cams = {"left": None, "right": None}
_ws_lock = threading.Lock()
_WS_RETRY_SEC = 5.0             # 启动失败后的重试间隔
_ws_next_try = {"left": 0.0, "right": 0.0}


def _ws_cam(side):
    """取该侧 WS 相机实例; 未启动则懒启动(不阻塞, 后台自行连/重连)"""
    with _ws_lock:
        cam = _ws_cams[side]
        if cam is not None and cam.is_running:
            return cam
        if time.time() < _ws_next_try[side]:
            return None
        if cam is not None:
            try:
                cam.stop()
            except Exception:
                pass
        cam = WsCamera(WS_SERIAL[side])
        try:
            cam.start(wait_first_frame=False)
        except Exception:
            _ws_next_try[side] = time.time() + _WS_RETRY_SEC
            return None
        _ws_cams[side] = cam
        return cam

ARM_HTTP = "http://127.0.0.1:8000"             # fd_arm_http
HIST_SECONDS = 600                             # 误差历史缓存窗口
POLL_INTERVAL = 1.0
POST_TIMEOUT = 300.0                           # 标定/对准等长操作
GET_TIMEOUT = 5.0

app = Flask(__name__, static_folder=None)
app.register_blueprint(recover_bp, url_prefix="/api")
app.register_blueprint(queue_bp, url_prefix="/api")
app.register_blueprint(duo_bp, url_prefix="/api")
app.register_blueprint(runpage_bp, url_prefix="/api")

# ---------------------------------------------------------------- HTTP 工具

def _http(method, url, body=None, timeout=GET_TIMEOUT):
    """最小 HTTP 转发,返回 (status, bytes, headers);网络异常 status=0"""
    data = None
    req = urllib.request.Request(url, method=method)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except Exception as e:  # 连接拒绝/超时等
        return 0, str(e).encode("utf-8"), {}


# ---------------------------------------------------------------- 状态轮询

# 每侧:{t,xy,z,total,stage,running} 环形序列 + 最新 status 原文
_hist = {s: {"t": deque(), "xy": deque(), "z": deque(), "total": deque()} for s in SIDES}
_status = {s: None for s in SIDES}      # (fetch_time, pbvs status dict)
_joints = {"time": 0.0, "data": None}   # :8000 get_joint_angle 缓存

_placeholder = None

def _placeholder_jpeg():
    global _placeholder
    if _placeholder is None:
        with open(os.path.join(STATIC, "placeholder.jpg"), "rb") as f:
            _placeholder = f.read()
    return _placeholder


def _poll_once(side):
    code, data, _ = _http("GET", "http://127.0.0.1:%d/pbvs/api/status" % SIDES[side], timeout=3)
    if code != 200:
        _status[side] = None
        return
    try:
        st = json.loads(data)
    except ValueError:
        _status[side] = None
        return
    _status[side] = (time.time(), st)

    al = st.get("aligner", {})
    now = time.time()
    xy = al.get("current_error_xy_m")
    z = al.get("current_error_z_m")
    h = _hist[side]
    # 只有真实测到误差才记点(对准未运行时字段可能为 0/None 的旧值)
    if al.get("is_running") or (xy is not None and al.get("has_target")):
        h["t"].append(now)
        h["xy"].append((xy or 0.0) * 1000.0)
        h["z"].append((z or 0.0) * 1000.0)
        h["total"].append(math.hypot((xy or 0.0) * 1000.0, (z or 0.0) * 1000.0))
    cutoff = now - HIST_SECONDS
    while h["t"] and h["t"][0] < cutoff:
        for k in h:
            h[k].popleft()


def _poll_loop():
    while True:
        t0 = time.time()
        for side in SIDES:
            try:
                _poll_once(side)
            except Exception:
                pass
        try:
            code, data, _ = _http("GET", ARM_HTTP + "/get_joint_angle", timeout=2)
            if code == 200:
                _joints["time"] = time.time()
                _joints["data"] = json.loads(data)
        except Exception:
            pass
        time.sleep(max(0.1, POLL_INTERVAL - (time.time() - t0)))


# ---------------------------------------------------------------- 静态页

@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC, path)


@app.route("/run")
def run_page():
    """⑮ 独立运行页 — 整流程展示/逐步编辑/一键循环执行(实机工作页)。"""
    return send_from_directory(STATIC, "run.html")


@app.route("/duo")
def duo_page():
    """双臂并行运行页 — 同套整流程, 左右拆道真并行, 中间区互斥防撞。"""
    return send_from_directory(STATIC, "duo.html")


# ---------------------------------------------------------------- 代理

@app.route("/api/<side>/pbvs/<path:rest>", methods=["GET", "POST"])
def proxy_pbvs(side, rest):
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    url = "http://127.0.0.1:%d/pbvs/api/%s" % (SIDES[side], rest)
    body = request.get_json(silent=True) if request.method == "POST" else None
    # ⑧ 🧭转正步: 执行时刻按最近一次⑩/⑭检测把 pose_align 标记解析成具体旋转步。
    # 只拦 grasp/sequence 且确有 🧭步; 解析失败=整序列拦下(不动臂), 附 pose_resolved 说明。
    pose_notes = None
    if rest == "grasp/sequence" and request.method == "POST" and isinstance(body, dict):
        # ⑧序列审计(10-08): 落盘"浏览器实际发来的步骤"原样 — 结果区回显的是执行结果,
        # 此行是请求侧铁证, 排"列表显示N步/实际发出M步"争议(journalctl 查 [⑧SEQ])
        try:
            print("[⑧SEQ] %s 收到 %d 步: %s" % (side, len(body.get("moves") or []),
                  json.dumps(body.get("moves"), ensure_ascii=False)), flush=True)
        except Exception:
            pass
        # ⑧ 🧭转正步: 执行时刻按最近一次⑩/⑭检测把 pose_align 标记解析成具体旋转步。
        # 只拦 grasp/sequence 且确有 🧭步; 解析失败=整序列拦下(不动臂), 附 pose_resolved 说明。
        if any(isinstance(m, dict) and "pose_align" in m for m in body.get("moves") or []):
            try:
                body["moves"], pose_notes = pose_cache.resolve_moves(side, body["moves"])
            except pose_cache.ResolveError as e:
                return jsonify({"ok": False, "error": "🧭⑩转正步: %s" % e})
    code, data, headers = _http(request.method, url, body,
                                timeout=POST_TIMEOUT if request.method == "POST" else GET_TIMEOUT)
    if pose_notes is not None and code == 200:
        try:                                  # 把解析说明附进响应, 前端在结果区显示
            r = json.loads(data)
            r["pose_resolved"] = pose_notes
            data = json.dumps(r).encode("utf-8")
        except Exception:
            pass
    if code == 0:
        return jsonify({"ok": False, "error": data.decode("utf-8", "replace"),
                        "upstream": "pbvs-%s:%d" % (side, SIDES[side])}), 502
    ctype = headers.get("Content-Type", "application/json")
    return Response(data, status=code, mimetype=ctype.split(";")[0].strip())


@app.route("/api/arm/<path:rest>", methods=["GET"])
def proxy_arm(rest):
    """fd_arm_http 只读代理(调试页不下发臂运动指令,运动全部经 PBVS)"""
    code, data, headers = _http("GET", ARM_HTTP + "/" + rest, timeout=GET_TIMEOUT)
    if code == 0:
        return jsonify({"ok": False, "error": data.decode("utf-8", "replace"),
                        "upstream": "fd_arm_http:8000"}), 502
    return Response(data, status=code,
                    mimetype=headers.get("Content-Type", "application/json").split(";")[0].strip())


# ---------------------------------------------------------------- 整箱检测

BOX_DETECT = "http://127.0.0.1:7020"           # weilong-box-detect.service

@app.route("/api/<side>/boxdetect")
def boxdetect(side):
    """整箱卫龙捆检测代理(GPU 旁路服务,只读相机 preview,不动 PBVS)"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    conf = request.args.get("conf", "0.3")
    url = "%s/detect?side=%s&conf=%s" % (BOX_DETECT, side, conf)
    code, data, _ = _http("GET", url, timeout=20)
    if code == 0:
        return jsonify({"ok": False, "error": data.decode("utf-8", "replace"),
                        "upstream": "weilong-box-detect:7020"}), 502
    return Response(data, status=code, mimetype="application/json")


# ---------------------------------------------------------------- ⑩ 姿态 3D (bag/scan + 手眼→基座系)

EYE_FILES = {"left": os.path.join(PBVS_ROOT, "eye_in_hand_Left_Arm.json"),
             "right": os.path.join(PBVS_ROOT, "eye_in_hand_Right_Arm.json")}
# 右臂手眼未标 → 文件不存在自动跳过, 只给相机系 3D


def _rpy_to_R(rx, ry, rz):
    """R = Rz@Ry@Rx, 输入弧度 — 与 /cart/fk 与 hover_above.rpy_to_R 同约定(纯 python 免 numpy)"""
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx]]


def _pose_enrich_base(side, dets):
    """有手眼标定文件的臂: p_cam → p法兰(手眼 X) → p_base(FK), 给 det 附 p_base_mm。
    附加信息, 任何失败都只跳过, 不挡姿态检测本身。
    返回 (tcp_x, tcp_y) 米(供 _pose_layer_order 算左右向); 无手眼/FK 失败返回 None。"""
    path = EYE_FILES.get(side)
    if not path or not os.path.exists(path):
        return None
    try:
        e = json.load(open(path))["T_flange_cam"]
        Re, te = e["R"], e["t_m"]
        code, data, _ = _http(
            "GET", "http://127.0.0.1:%d/pbvs/api/cart/fk" % SIDES[side], timeout=5)
        fkj = json.loads(data)
        if code != 200 or not fkj.get("ok"):
            return None
        p = fkj["pose"]                        # 法兰位姿(rpy 弧度); 算 p_base 用法兰
        Rf = _rpy_to_R(p["rx"], p["ry"], p["rz"])
        tf = (p["x"], p["y"], p["z"])
        for d in dets:
            if not d.get("p3d_mm"):
                continue
            pc = [v / 1000.0 for v in d["p3d_mm"]]
            pe = [sum(Re[i][k] * pc[k] for k in range(3)) + te[i]
                  for i in range(3)]           # 相机系 → 法兰系
            pb = [sum(Rf[i][k] * pe[k] for k in range(3)) + tf[i]
                  for i in range(3)]           # 法兰系 → 基座系
            d["p_base_mm"] = [round(v * 1000.0, 1) for v in pb]
        pt = fkj.get("pose_tcp") or p          # 左右向基准=当前 TCP(无则法兰近似)
        return (pt["x"], pt["y"])
    except Exception:
        return None


POSE_LAYER_MM = 25.0   # 与 suction_bag.LAYER_MM 同值(袋#深度分层阈值 mm)


def _pose_layer_order(dets, tcp_xy):
    """⑩表序对齐⑭袋#定序(10-08晚用户定案, 与⑪整箱同规则): 深度分层(离相机最近=
    最上层先) + 同层内左→右 — 最近层最左边=#1。旧版按基座高排, 实机核对与实物层序
    相反; 深度=原始传感量(区域中值)同机位稳定(基座高仍给⑩表"基座3D"列与⑭悬停用)。
    左右向 e_left=ẑ×d̂(d̂=TCP→袋群平均水平方向)=朝袋看的物理左右, 与相机画面轴无关。
    任一 det 缺 p_base_mm/p3d_mm(右臂无手眼)则不动原序(保持旧行为)。重排后覆写
    d.order(表格#/缓存序/⑧🧭袋# 全与⑭ --index 一致), PBVS bag_pick 原序存进
    d.bag_order — ⑩🎯伺服/示教仍走 PBVS 内部序, 前端换算。"""
    if not dets or not all(d.get("p_base_mm") and d.get("p3d_mm") for d in dets):
        return
    pb = [[v / 1000.0 for v in d["p_base_mm"]] for d in dets]
    mx = sum(q[0] for q in pb) / len(pb)
    my = sum(q[1] for q in pb) / len(pb)
    tx, ty = tcp_xy if tcp_xy else (0.0, 0.0)
    dx, dy = mx - tx, my - ty
    n = math.hypot(dx, dy)
    if n < 1e-6:
        return
    ex, ey = -dy / n, dx / n                          # e_left = ẑ×d̂(朝袋看的左向)
    dep = [float(d["p3d_mm"][2]) for d in dets]       # 相机深度 mm
    idx = sorted(range(len(dets)), key=lambda i: dep[i])        # 近→远
    layers = []
    for i in idx:
        if not layers or (dep[i] - dep[layers[-1][0]]) > POSE_LAYER_MM:
            layers.append([])                         # 比层内最近袋远>25mm → 新层
        layers[-1].append(i)
    out = []
    for lay in layers:
        lay.sort(key=lambda i: -(pb[i][0] * ex + pb[i][1] * ey))  # 层内左→右
        out.extend(lay)
    for d in dets:
        if "bag_order" not in d:
            d["bag_order"] = d.get("order")           # PBVS bag_pick 内部序(🎯用)
    dets[:] = [dets[i] for i in out]
    for k, d in enumerate(dets, 1):
        d["order"] = k


@app.route("/api/<side>/posedetect")
def posedetect(side):
    """单袋姿态检测代理(正/反+4脚点+整姿决策+质心3D)
    走 PBVS bag/scan: 同一帧做 :7020 姿态推理 + hub 深度反投影(p3d_mm 相机系),
    kpts 与深度同源; 有手眼文件的臂再附 p_base_mm(基座系)。纯像素 :7020 /pose 仍可直连。"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    conf = request.args.get("conf", "0.25")
    url = "http://127.0.0.1:%d/pbvs/api/bag/scan?conf=%s" % (SIDES[side], conf)
    code, data, _ = _http("GET", url, timeout=40)
    if code == 0:
        return jsonify({"ok": False, "error": data.decode("utf-8", "replace"),
                        "upstream": "PBVS bag/scan(:7004/7005)"}), 502
    try:
        res = json.loads(data)
    except Exception:
        return Response(data, status=code, mimetype="application/json")
    if res.get("ok") and res.get("dets"):
        tcp_xy = _pose_enrich_base(side, res["dets"])
        _pose_layer_order(res["dets"], tcp_xy)        # ⑩表序=⑭袋#(分层+同层左→右)
        pose_cache.save(side, res["dets"], "web10")   # ⑧🧭转正步执行时读(序=⑭袋#)
    return jsonify(res)


@app.route("/api/<side>/poselast")
def poselast(side):
    """⑩姿态缓存速览(⑧卡片的 🧭转正步用它): 检出数/每袋动作+偏角/缓存新鲜度/来源。
    两种来源的序现在同规则(⑭层序=袋#): suction=⑭扫描, web10=⑩检测(代理侧重排)。"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    c = pose_cache.load(side)
    if not c or not c.get("dets"):
        return jsonify({"ok": False, "error": "尚无缓存 — 先⑩📷单次检测或跑一次⑭"})
    age = time.time() - float(c.get("t") or 0)
    if age > pose_cache.STALE_S:
        return jsonify({"ok": False, "error": "缓存 %.0f 分钟前已过期" % (age / 60),
                        "t": c.get("t"), "source": c.get("source")})
    return jsonify({"ok": True, "t": c.get("t"), "now": time.time(),
                    "source": c.get("source"), "count": len(c["dets"]),
                    "summary": pose_cache.summary(c),
                    # 逐袋精简(⑧确认弹窗预判每个🧭步将跳过/将转多少)
                    "dets": [{"action": d.get("action"),
                              "head_dev_deg": d.get("head_dev_deg"),
                              "rotate_deg": d.get("rotate_deg")}
                             for d in c["dets"]]})


@app.route("/api/<side>/snapshot")
def snapshot(side):
    """单帧 preview JPEG(检测卡片快照用,一次一帧不走 MJPEG)"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    code, data, _ = _http("GET", "http://127.0.0.1:%d/pbvs/api/preview" % SIDES[side], timeout=5)
    if code != 200 or not data:
        return jsonify({"ok": False, "error": "取不到 %s 相机 preview" % side}), 502
    return Response(data, mimetype="image/jpeg")


# ---------------------------------------------------------------- 采集集存帧 (TinyCNN 重训用)

COLLECT_DIR = "/home/tianlian/weilong/collect_wrist"


@app.route("/api/<side>/collect", methods=["GET", "POST"])
def collect_frame(side):
    """⑩ 卡片「存帧」: 当前相机原帧存 collect_wrist/{front,back}/。
    配合 YOLO 框自动裁剪 → 重训 TinyFrontBack(正/反分类器)的腕相机域数据。"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    if request.method == "GET":      # 只读两张数
        cnt = {}
        for lab in ("front", "back"):
            d = os.path.join(COLLECT_DIR, lab)
            cnt[lab] = len([f for f in os.listdir(d) if f.endswith(".jpg")]) \
                if os.path.isdir(d) else 0
        return jsonify({"ok": True, **cnt})
    body = request.get_json(silent=True) or {}
    label = body.get("label")
    if label not in ("front", "back"):
        return jsonify({"ok": False, "error": "label 必须是 front 或 back"}), 400
    # 采集必须存原图: /preview 常驻中心十字+CAM 标注会污染训练裁剪
    code, data, _ = _http("GET", "http://127.0.0.1:%d/pbvs/api/frame" % SIDES[side], timeout=5)
    if code != 200 or not data:
        hint = "相机原图不可用(相机未连?)" if code == 503 else \
               "PBVS 实例过旧无 /frame 端点(需重启 PBVS 实例)"
        return jsonify({"ok": False, "error": hint}), 502
    d = os.path.join(COLLECT_DIR, label)
    try:
        os.makedirs(d, exist_ok=True)
        name = "%s_%s.jpg" % (side, time.strftime("%m%d_%H%M%S"))
        with open(os.path.join(d, name), "wb") as f:
            f.write(data)
        n = len([f for f in os.listdir(d) if f.endswith(".jpg")])
    except OSError as e:
        return jsonify({"ok": False, "error": "写采集集失败(%s): %s" % (d, e)}), 500
    return jsonify({"ok": True, "label": label, "side": side, "file": name, "count": n})


# 采集集标注(YOLO-pose 标签页)已拆到独立服务 :7030 (label_web/label_server.py,
# systemd pbvs-label-web) — 本服务只保留 ⑩ 卡片的存帧入口


# ---------------------------------------------------------------- 工具标定 (TCP 多点法)

_toolcal = {s: [] for s in SIDES}     # side → [{t, pose:{x,y,z,rx,ry,rz}(法兰, m/rad)}]


def _rpy_to_R(rx, ry, rz):
    """rpy(rad) → R = Rz@Ry@Rx(与 fd_bridge._rpy_to_R 同约定)"""
    import numpy as np
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    return np.array([
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy,     cy * sx,                cy * cx]])


def _toolcal_solve(points):
    """多点法解 TCP 平移: 每点满足 p法兰_i + R_i·t = p尖点(同一定值)
    → 线性最小二乘同时解出 t(法兰→工具尖端) 与 p尖点(基座系)。"""
    import numpy as np
    n = len(points)
    if n < 3:
        return {"ok": False, "error": "至少 3 个点(建议 4 个, 姿态差异 ≥15°)"}
    A = np.zeros((3 * n, 6))
    b = np.zeros(3 * n)
    Rs, ps = [], []
    for i, pt in enumerate(points):
        p = pt["pose"]
        R = _rpy_to_R(p["rx"], p["ry"], p["rz"])
        pv = np.array([p["x"], p["y"], p["z"]])
        Rs.append(R); ps.append(pv)
        A[3 * i:3 * i + 3, 0:3] = R
        A[3 * i:3 * i + 3, 3:6] = -np.eye(3)
        b[3 * i:3 * i + 3] = -pv
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    t, tip = x[0:3], x[3:6]
    res = [float(np.linalg.norm(Rs[i] @ t + ps[i] - tip)) for i in range(n)]
    rms = math.sqrt(sum(r * r for r in res) / n)
    # 姿态多样性(法兰 Z 轴两两最大夹角)与法兰原点散布 → 条件数提示
    zs = [R[:, 2] for R in Rs]
    maxang = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            c = float(max(-1.0, min(1.0, float(np.dot(zs[i], zs[j])))))
            maxang = max(maxang, math.degrees(math.acos(c)))
    spread = max(float(np.linalg.norm(ps[i] - ps[j]))
                 for i in range(n) for j in range(i + 1, n))
    return {"ok": True, "n": n,
            "t_mm": [round(float(v) * 1000, 2) for v in t],
            "tip_mm": [round(float(v) * 1000, 1) for v in tip],
            "residuals_mm": [round(r * 1000, 2) for r in res],
            "rms_mm": round(rms * 1000, 2), "max_mm": round(max(res) * 1000, 2),
            "orient_spread_deg": round(maxang, 1),
            "flange_spread_mm": round(spread * 1000, 1),
            "qc_pass": bool(rms < 0.0025 and maxang >= 10.0)}


@app.route("/api/<side>/toolcal", methods=["GET", "POST"])
def toolcal(side):
    """TCP 多点法标定: op=list|record|undo|clear|solve(记录位姿来自 PBVS cart/fk)"""
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    data = request.get_json(silent=True) or {}
    op = data.get("op", "list")
    if op == "record":
        code, raw, _ = _http("GET", "http://127.0.0.1:%d/pbvs/api/cart/fk" % SIDES[side], timeout=10)
        if code != 200:
            return jsonify({"ok": False, "error": "取法兰位姿失败(PBVS 实例/cart 未就绪?)  %s"
                            % raw.decode("utf-8", "replace")[:120]}), 502
        try:
            fk = json.loads(raw)
        except ValueError:
            return jsonify({"ok": False, "error": "fk 响应解析失败"}), 502
        if not fk.get("ok"):
            return jsonify({"ok": False, "error": "fk 失败: %s" % fk.get("error", "?")})
        _toolcal[side].append({"t": time.time(), "pose": fk["pose"]})
    elif op == "undo":
        if _toolcal[side]:
            _toolcal[side].pop()
    elif op == "clear":
        _toolcal[side] = []
    elif op == "solve":
        return jsonify(_toolcal_solve(_toolcal[side]))
    pts = [{"t": p["t"],
            "pos_mm": [round(p["pose"][k] * 1000, 1) for k in "xyz"],
            "rpy_deg": [round(math.degrees(p["pose"][k]), 1)
                        for k in ("rx", "ry", "rz")]}
           for p in _toolcal[side]]
    return jsonify({"ok": True, "side": side, "count": len(pts), "points": pts})


# ---------------------------------------------------------------- ⑭ 单袋吸取 (suction_bag.py 网页入口)

import subprocess

SUCT_SCRIPT = os.path.join(PBVS_ROOT, "suction_bag.py")


@app.route("/api/<side>/suctionbag", methods=["POST"])
def suctionbag(side):
    """⑭ 一键单袋吸取对准: subprocess 跑 PBVS/suction_bag.py, 输出原样返回。
    run=go(一键到吸取位) | press(到位+压紧密封) | scan(只扫描看袋心)
       | direct(实验: 一条合成直线直达, 无巡航走廊) | teach(当前臂位姿覆盖存示教点
       「对准中心位置」, 不动臂)。仅左臂。
    走法: 脚本默认每段一次到位(/cart/step); body.jog=true 回退旧分块点动。
    go_smooth 为旧别名(等价 go, 兼容缓存页面)。"""
    if side != "left":
        return jsonify({"ok": False, "error": "单袋吸取目前仅左臂(示教点/偏移都在左臂)"}), 400
    if not os.path.exists(SUCT_SCRIPT):
        return jsonify({"ok": False, "error": "脚本不存在: %s" % SUCT_SCRIPT}), 500
    body = request.get_json(silent=True) or {}
    run = body.get("run", "go")
    try:
        idx = int(body.get("index", 1))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "index 须为整数"}), 400
    cmd = ["python3", SUCT_SCRIPT]
    if run == "scan":
        cmd.append("--list")
    elif run == "teach":
        cmd.append("--teach-align")
    elif run in ("go", "go_smooth"):            # go_smooth=旧别名, 已统一一次到位
        cmd += ["--yes", "--index", str(idx)]
    elif run == "direct":                       # 直线直达(press_mm>0 时带压紧)
        # 10-10 用户要求: 网页直达不再先回放扫描位(--no-scan-move, 在当前臂位扫描,
        # 须先把臂停在能看全袋群的机位); 队列版(queue_hub suction)仍回放 — 轮到它时
        # 臂可能停在袋上/别处, 必须先回扫描位才扫得到袋群。
        cmd += ["--yes", "--index", str(idx), "--direct", "--no-scan-move"]
        try:
            press = max(0.0, min(10.0, float(body.get("press_mm", 0.0))))
            hold = max(0.0, min(5.0, float(body.get("hold_s", 1.0))))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "press_mm/hold_s 须为数字"}), 400
        if press > 0:
            cmd += ["--press", "%.1f" % press, "--hold", "%.1f" % hold]
    elif run == "press":
        try:
            press = float(body.get("press_mm", 3.0))
            hold = float(body.get("hold_s", 2.0))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "press_mm/hold_s 须为数字"}), 400
        cmd += ["--yes", "--index", str(idx), "--press", str(press), "--hold", str(hold)]
    else:
        return jsonify({"ok": False, "error": "run 须 go|press|scan|direct|teach"}), 400
    if body.get("jog"):
        cmd.append("--jog")
    try:
        p = subprocess.run(cmd, cwd=PBVS_ROOT, capture_output=True,
                           text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "脚本超时(180s) — 查 PBVS/相机状态后重试"}), 504
    out = (p.stdout or "") + (("\n[stderr]\n" + p.stderr) if p.stderr else "")
    return jsonify({"ok": p.returncode == 0, "returncode": p.returncode,
                    "log": out.strip() or "(无输出)"})


# ---------------------------------------------------------------- MJPEG

@app.route("/api/<side>/video")
def video(side):
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    try:
        fps = min(15.0, max(0.5, float(request.args.get("fps", 2))))
    except ValueError:
        fps = 3.0
    port = SIDES[side]
    boundary = "pbvsframe"

    def gen():
        interval = 1.0 / fps
        frame = None        # 最新帧: WS 原始 JPEG / preview / 占位图
        last_count = -1
        while True:
            t0 = time.time()
            # 1) 优先: WS 远程流(Windows 采集电脑, 原始 JPEG 零转码)
            cam = _ws_cam(side)
            if cam is not None and cam.is_streaming:
                cnt = cam.frame_count
                if cnt != last_count:
                    jpeg = cam.get_jpeg()
                    if jpeg:
                        frame, last_count = jpeg, cnt
            else:
                frame, last_count = None, -1   # WS 断流: 丢弃旧帧走回退
            # 2) 回退: app_fd preview(相机回插 Jetson 时) / 占位图
            if frame is None:
                code, data, _ = _http("GET", "http://127.0.0.1:%d/pbvs/api/preview" % port, timeout=5)
                frame = data if (code == 200 and data) else _placeholder_jpeg()
            yield (("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                    % (boundary, len(frame))).encode("ascii") + frame + b"\r\n")
            time.sleep(max(0.05, interval - (time.time() - t0)))

    resp = Response(gen(), mimetype="multipart/x-mixed-replace; boundary=%s" % boundary)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------------------------------------------------------------- 历史 / 健康

@app.route("/api/<side>/history")
def history(side):
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    h = _hist[side]
    return jsonify({"ok": True, "now": time.time(),
                    "t": list(h["t"]), "xy": list(h["xy"]),
                    "z": list(h["z"]), "total": list(h["total"])})


@app.route("/api/health")
def health():
    out = {"ok": True, "time": time.time(), "sides": {}}
    for side, port in SIDES.items():
        cached = _status[side]
        entry = {"port": port, "up": cached is not None,
                 "age": (time.time() - cached[0]) if cached else None}
        if cached:
            st = cached[1]
            al = st.get("aligner", {})
            cam = st.get("camera", {})
            entry.update({
                "arm": al.get("arm"),
                "camera_attached": cam.get("attached"),
                "camera_running": cam.get("running"),
                "align_running": al.get("is_running"),
                "has_target": al.get("has_target"),
                "current_target_name": al.get("current_target_name"),
            })
        # WS 远程相机中继状态(顺带懒启动: 页面开着 health 轮询即自动连接)
        ws_cam = _ws_cam(side)
        entry["ws_camera"] = ws_cam.stats if ws_cam is not None else {"connected": False}
        out["sides"][side] = entry
    out["arm_http"] = {"port": 8000, "up": _joints["data"] is not None
                       and (time.time() - _joints["time"]) < 10,
                       "age": time.time() - _joints["time"] if _joints["data"] else None}
    return jsonify(out)


@app.route("/api/arm/joints")
def arm_joints():
    return jsonify({"ok": _joints["data"] is not None,
                    "age": time.time() - _joints["time"] if _joints["data"] else None,
                    "data": _joints["data"]})


# ---------------------------------------------------------------- reference 质检

def _j_qc(J):
    """J(3x3) → 列模长 + 条件数;门限:模长∈[0.8,1.2],cond<50"""
    try:
        import numpy as np
        M = np.array(J, dtype=float)
        norms = [float(np.linalg.norm(M[:, i])) for i in range(3)]
        sv = np.linalg.svd(M, compute_uv=False)
        cond = float(sv[0] / sv[-1]) if sv[-1] > 1e-12 else float("inf")
    except Exception:
        norms = [math.sqrt(sum(float(M[r][c]) ** 2 for r in range(3))) for c in range(3)]
        cond = None
    return norms, cond


@app.route("/api/<side>/reference")
def reference(side):
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    path = os.path.normpath(os.path.join(
        PBVS_ROOT, "reference_%s.json" % ARM_NAME[side]))
    if not os.path.exists(path):
        return jsonify({"ok": False, "error": "参考文件不存在: %s(未示教/标定过)" % path})
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception as e:
        return jsonify({"ok": False, "error": "解析失败: %s" % e})

    J = d.get("J")
    norms, cond = _j_qc(J) if J else ([], None)
    targets = {}
    for name, t in (d.get("targets") or {}).items():
        p = t.get("marker_3d_target")
        targets[name] = {
            "marker_mm": [round(float(x) * 1000, 1) for x in p] if p else None,
            "joints": t.get("joints_target"),
        }
    return jsonify({
        "ok": True, "file": os.path.basename(path), "path": path,
        "mtime": os.path.getmtime(path),
        "arm": d.get("arm"), "current_target_name": d.get("current_target_name"),
        "J": J, "col_norms": [round(n, 3) for n in norms], "cond": round(cond, 2) if cond else None,
        "col_norms_pass": all(0.8 <= n <= 1.2 for n in norms) if norms else False,
        "cond_pass": (cond is not None and cond < 50),
        "targets": targets,
    })


# ---------------------------------------------------------------- 日志尾随

@app.route("/api/<side>/tail")
def tail_log(side):
    if side not in SIDES:
        return jsonify({"ok": False, "error": "side 必须是 left 或 right"}), 400
    try:
        lines = min(500, max(10, int(request.args.get("lines", 120))))
    except ValueError:
        lines = 120
    path = LOG_FILES[side]
    if not os.path.exists(path):
        return jsonify({"ok": False, "error": "日志不存在: %s(PBVS 实例未按标准方式启动?)" % path})
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - 128 * 1024))  # 最多回读 128KB
        chunk = f.read().decode("utf-8", "replace").splitlines()
    return jsonify({"ok": True, "lines": chunk[-lines:]})


# ---------------------------------------------------------------- 入口

if __name__ == "__main__":
    threading.Thread(target=_poll_loop, daemon=True).start()
    threading.Thread(target=lambda: [_ws_cam(s) for s in SIDES],
                     daemon=True).start()   # WS 相机中继预热(常驻重连)
    print("=" * 60)
    print("  PBVS 调试台  http://0.0.0.0:7010/")
    print("  代理: left:7004  right:7005  arm:8000 | MJPEG: /api/{side}/video")
    print("  WS相机中继: Windows采集电脑:8766 → /api/{side}/video (优先) / preview(回退)")
    print("=" * 60)
    app.run(host="0.0.0.0", port=7010, debug=False, use_reloader=False, threaded=True)
