#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""卫龙视觉检测旁路服务 — 0.0.0.0:7020 (yolo11_env, GPU)

调试台(:7010)的视觉后端: 拉取 PBVS 实例(:7004/:7005)的 preview JPEG 跑模型,
不占用相机(只读 HTTP)。两类模型共用本服务与 GPU 锁(推理串行):
  - 整箱多捆检测 weilong11n_box: 每捆 {框/质心/角度/抓取序}
  - 单袋姿态 weilong11n_pose: 正/反类别 + 4脚点 + 整姿决策(flip/rotate/ok)

端点:
  GET  /health
  GET  /detect?side=left|right&conf=0.3      整箱多捆
  POST /detect_img  (body=JPEG bytes, conf 查询参数)
  GET  /pose?side=left|right&conf=0.25        单袋姿态
  POST /pose_img    (body=JPEG bytes, conf 查询参数)
运行: /home/tianlian/yolo11_env/bin/python box_detect_service.py
systemd: weilong-box-detect.service
"""
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

sys.path.insert(0, "/home/tianlian/weilong")
from infer_weilong_box import WeilongBoxDetector   # noqa: E402
from infer_weilong_pose import WeilongPoseDetector, orient_action   # noqa: E402

SIDES = {"left": 7004, "right": 7005}
BOX_WEIGHTS = "/home/tianlian/weilong/weights/weilong11n_box_best.pt"
POSE_WEIGHTS = "/home/tianlian/weilong/weights/weilong11n_pose_best.pt"

_det = None      # 整箱多捆分割
_pdet = None     # 单袋姿态(正/反+4脚点)
_lock = threading.Lock()


def get_detector():
    global _det
    if _det is None:
        _det = WeilongBoxDetector(weights=BOX_WEIGHTS, device=0, conf=0.3)
    return _det


def get_pose_detector():
    global _pdet
    if _pdet is None:
        # crop_cls_weights=None: 2026-10-05 换腕相机域微调权重后 YOLO cls 头已可靠
        # (test 20/20 含全部反面), 停用展示台域 TinyCNN(它把腕相机反面全判成 front)
        _pdet = WeilongPoseDetector(weights=POSE_WEIGHTS, device=0, conf=0.25,
                                    crop_cls_weights=None)
    return _pdet


def fetch_preview(side):
    # /frame = 相机原图(无中心十字/QR 标注): 与采集集/训练数据同分布,
    # 标注像素对检测无助益, 还会让 TinyCNN 正/反分类器训练-推理输入不一致
    url = "http://127.0.0.1:%d/pbvs/api/frame" % SIDES[side]
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.read()


def run_detect(jpeg, conf):
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "error": "JPEG 解码失败"}
    det = get_detector()
    det.conf = float(conf)
    t0 = time.time()
    with _lock:                          # GPU 单流串行
        targets = det.detect(img)
    ms = (time.time() - t0) * 1000
    h, w = img.shape[:2]
    return {"ok": True, "w": w, "h": h, "count": len(targets),
            "infer_ms": round(ms, 1),
            "dets": [{"order": i, "conf": round(t["conf"], 3),
                      "box": [round(v, 1) for v in t["box"]],
                      "centroid": [round(v, 1) for v in t["centroid"]] if t["centroid"] else None,
                      "angle": round(t["angle"], 1) if t["angle"] is not None else None,
                      "poly": ([[round(x, 1), round(y, 1)] for x, y in t["poly"]]
                               if t.get("poly") else None)}
                     for i, t in enumerate(targets, 1)]}


def run_pose_detect(jpeg, conf):
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "error": "JPEG 解码失败"}
    det = get_pose_detector()
    det.conf = float(conf)
    t0 = time.time()
    with _lock:                          # GPU 单流串行(与整箱检测共用)
        targets = det.detect(img)
    ms = (time.time() - t0) * 1000
    h, w = img.shape[:2]
    dets = []
    for i, t in enumerate(targets, 1):
        dets.append({"order": i, "conf": round(t["conf"], 3),
                     "box": [round(v, 1) for v in t["box"]],
                     "cls": t["cls"],
                     "kpts": [[round(x, 1), round(y, 1)] for x, y in t["kpts"]],
                     "centroid": [round(v, 1) for v in t["centroid"]] if t["centroid"] else None,
                     "angle": round(t["angle"], 1) if t["angle"] is not None else None,
                     "orient": orient_action(t)})
    return {"ok": True, "w": w, "h": h, "count": len(dets),
            "infer_ms": round(ms, 1), "dets": dets}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            ready = _det is not None
            return self._send(200, {"ok": True, "ready": ready,
                                    "weights": BOX_WEIGHTS,
                                    "pose_ready": _pdet is not None,
                                    "pose_weights": POSE_WEIGHTS})
        if u.path == "/detect":
            side = (q.get("side") or [""])[0]
            if side not in SIDES:
                return self._send(400, {"ok": False, "error": "side 必须是 left 或 right"})
            conf = (q.get("conf") or ["0.3"])[0]
            try:
                jpeg = fetch_preview(side)
            except Exception as e:
                return self._send(502, {"ok": False, "error": "取不到 %s 相机 preview: %s" % (side, e)})
            try:
                return self._send(200, run_detect(jpeg, conf))
            except Exception as e:
                return self._send(500, {"ok": False, "error": str(e)})
        if u.path == "/pose":
            side = (q.get("side") or [""])[0]
            if side not in SIDES:
                return self._send(400, {"ok": False, "error": "side 必须是 left 或 right"})
            conf = (q.get("conf") or ["0.25"])[0]
            try:
                jpeg = fetch_preview(side)
            except Exception as e:
                return self._send(502, {"ok": False, "error": "取不到 %s 相机 preview: %s" % (side, e)})
            try:
                return self._send(200, run_pose_detect(jpeg, conf))
            except Exception as e:
                return self._send(500, {"ok": False, "error": str(e)})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path in ("/detect_img", "/pose_img"):
            conf = (parse_qs(u.query).get("conf")
                    or ["0.3" if u.path == "/detect_img" else "0.25"])[0]
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            if not body:
                return self._send(400, {"ok": False, "error": "body 为空"})
            runner = run_detect if u.path == "/detect_img" else run_pose_detect
            try:
                return self._send(200, runner(body, conf))
            except Exception as e:
                return self._send(500, {"ok": False, "error": str(e)})
        return self._send(404, {"ok": False, "error": "not found"})


if __name__ == "__main__":
    print("预加载模型(box + pose)…", flush=True)
    get_detector()
    get_pose_detector()
    print("卫龙视觉检测服务: http://0.0.0.0:7020  (left:7004 / right:7005 | /detect /pose)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 7020), H).serve_forever()
