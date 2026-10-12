#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卫龙采集集标注服务 — 独立端口, 与调试台(:7010)分离
================================================================
- 页面:  http://192.168.10.127:7030/  (10 网段 WiFi 口; 192.168.2.201:7030 亦可达)
- 数据:  /home/tianlian/weilong/collect_wrist/{front,back}/   采集原图(⑩ 存帧按钮写入)
         /home/tianlian/weilong/collect_wrist/labels/{...}/   YOLO11-pose 标签(本服务写入)
- 标签:  cls cx cy w h x1 y1 x2 y2 x3 y3 x4 y4 (归一化, 与 yolo_pose 旧数据集同格式)
         空文件 = 负样本(无袋)

以 user 身份运行(flask 在 user 的 ~/.local)。
systemd: pbvs-label-web.service
"""

import os

from flask import Flask, jsonify, request, Response, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))
COLLECT_DIR = "/home/tianlian/weilong/collect_wrist"
COLLECT_LBL = os.path.join(COLLECT_DIR, "labels")

app = Flask(__name__)


def _img_dir(lab):
    """lab(front|back) → 图片目录; 非法返回 None"""
    return os.path.join(COLLECT_DIR, lab) if lab in ("front", "back") else None


def _txt_path(lab, jpg_name):
    """left_xxx.jpg → labels/{lab}/left_xxx.txt"""
    base = os.path.splitext(os.path.basename(jpg_name))[0]
    return os.path.join(COLLECT_LBL, lab, base + ".txt")


@app.route("/")
def index():
    return send_from_directory(ROOT, "label.html")


@app.route("/collect/list")
def collect_list():
    """标注页清单: 全部采集帧 + 已标状态(done=有 txt, empty=负样本空 txt)"""
    items = []
    for lab in ("front", "back"):
        d = _img_dir(lab)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".jpg"):
                continue
            tf = _txt_path(lab, f)
            items.append({"label": lab, "file": f, "done": os.path.exists(tf),
                          "empty": os.path.exists(tf) and os.path.getsize(tf) == 0})
    return jsonify({"ok": True, "count": len(items),
                    "done": sum(1 for i in items if i["done"]), "items": items})


@app.route("/collect/img/<lab>/<name>")
def collect_img_file(lab, name):
    d = _img_dir(lab)
    if d is None or "/" in name or ".." in name:
        return jsonify({"ok": False, "error": "非法路径"}), 400
    return send_from_directory(d, name)


@app.route("/collect/label/<lab>/<name>")
def collect_label_get(lab, name):
    """读回已标内容(重编辑用): {ok, empty} 或 {ok, line}"""
    if _img_dir(lab) is None or "/" in name or ".." in name:
        return jsonify({"ok": False, "error": "非法路径"}), 400
    tf = _txt_path(lab, name)
    if not os.path.exists(tf):
        return jsonify({"ok": False, "error": "未标注"}), 404
    if os.path.getsize(tf) == 0:
        return jsonify({"ok": True, "empty": True})
    with open(tf) as f:
        return jsonify({"ok": True, "line": f.read().strip()})


@app.route("/collect/save", methods=["POST"])
def collect_save():
    """保存 YOLO-pose 标签: 归一化后写 labels/{lab}/xxx.txt。
    body: {label, file, cls:0|1, kpts:[[x,y]像素x4], w, h, empty:bool}"""
    b = request.get_json(silent=True) or {}
    lab, fname = b.get("label"), b.get("file")
    if _img_dir(lab) is None or not isinstance(fname, str) \
            or "/" in fname or ".." in fname or not fname.endswith(".jpg"):
        return jsonify({"ok": False, "error": "非法 label/file"}), 400
    tf = _txt_path(lab, fname)
    os.makedirs(os.path.dirname(tf), exist_ok=True)
    if b.get("empty"):
        open(tf, "w").close()          # 空文件 = YOLO 负样本(make_split 惯例)
        return jsonify({"ok": True, "empty": True, "file": tf})
    try:
        cls = int(b.get("cls"))
        w, h = int(b.get("w")), int(b.get("h"))
        kpts = [(float(p[0]), float(p[1])) for p in b.get("kpts", [])]
        if cls not in (0, 1) or w <= 0 or h <= 0 or len(kpts) != 4:
            raise ValueError("cls/w/h/kpts 不合法")
    except (TypeError, ValueError, IndexError) as e:
        return jsonify({"ok": False, "error": "标注数据无效: %s" % e}), 400
    xs = [min(max(p[0], 0.0), float(w)) for p in kpts]
    ys = [min(max(p[1], 0.0), float(h)) for p in kpts]
    cx, cy = (min(xs) + max(xs)) / 2 / w, (min(ys) + max(ys)) / 2 / h
    bw, bh = (max(xs) - min(xs)) / w, (max(ys) - min(ys)) / h
    line = "%d %.6f %.6f %.6f %.6f" % (cls, cx, cy, bw, bh)
    line += "".join(" %.6f %.6f" % (x / w, y / h) for x, y in zip(xs, ys))
    tmp = tf + ".tmp"
    with open(tmp, "w") as f:
        f.write(line + "\n")
    os.replace(tmp, tf)
    return jsonify({"ok": True, "line": line, "file": tf})


@app.route("/health")
def health():
    return jsonify({"ok": True, "service": "weilong-label-web", "port": 7030})


if __name__ == "__main__":
    # 0.0.0.0: WiFi 口 192.168.10.127:7030 与有线口 192.168.2.201:7030 均可达;
    # 调试台仍在 :7010, 两者完全独立
    app.run(host="0.0.0.0", port=7030, threaded=True)
