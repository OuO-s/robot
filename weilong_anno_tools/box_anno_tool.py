#!/usr/bin/env python3
"""箱内卫龙 手动标注工具服务器 (weilongBox-data, 50张, 848x480)
打开: http://<IP>:8765

- GET  /                标注页面
- GET  /img/<f>         图片
- GET  /thumb/<f>       缩略图
- GET  /api/bootstrap   图片列表 + 当前进度
- POST /api/save        保存单张 {key, shapes, empty}
- POST /api/export      提交: 写 labelme JSON + YOLO txt + 可视化到数据集
"""
import json, os, glob, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = "/home/tianlian/weilong"
DS = os.path.join(ROOT, "dataset_seg", "weilongBox-data")
THUMB_DIR = os.path.join(ROOT, "anno", ".anno_thumbs_box")
STATE_F = os.path.join(ROOT, "anno", "box_anno_state.json")
UI_F = os.path.join(ROOT, "anno", "box_anno_ui.html")
VIS_DIR = os.path.join(ROOT, "dataset_seg_vis", "weilongBox")
IMG_W, IMG_H = 848, 480


def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def image_list():
    return [{"key": os.path.basename(f).replace("_Color.png", ""), "file": os.path.basename(f)}
            for f in sorted(glob.glob(os.path.join(DS, "*_Color.png")), key=natkey)]


def load_state():
    if os.path.exists(STATE_F):
        try:
            return json.load(open(STATE_F))
        except Exception:
            pass
    return {}


def save_state(st):
    tmp = STATE_F + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE_F)


def get_thumb(fname):
    import cv2
    os.makedirs(THUMB_DIR, exist_ok=True)
    tp = os.path.join(THUMB_DIR, fname.replace(".png", ".jpg"))
    if not os.path.exists(tp):
        im = cv2.imread(os.path.join(DS, fname))
        if im is None:
            return None
        cv2.imwrite(tp, cv2.resize(im, (168, 95)), [cv2.IMWRITE_JPEG_QUALITY, 72])
    with open(tp, "rb") as f:
        return f.read()


def write_outputs(st, imgs):
    """写 labelme JSON / YOLO txt / 可视化 / 汇总."""
    import cv2, numpy as np
    for old in glob.glob(os.path.join(DS, "*_Color.json")) + glob.glob(os.path.join(DS, "*_Color.txt")):
        os.remove(old)
    os.makedirs(VIS_DIR, exist_ok=True)
    summary = {"annotated": 0, "empty": 0, "skipped": 0}
    rows = []
    for it in imgs:
        k, fname = it["key"], it["file"]
        e = st.get(k) or {}
        shapes = [s for s in (e.get("shapes") or []) if len(s) >= 3]
        empty, done = bool(e.get("empty")), bool(e.get("done"))
        tag = "未标注"
        if empty:
            summary["empty"] += 1
            tag = "空"
        elif shapes and done:
            summary["annotated"] += 1
            tag = "OK"
            with open(os.path.join(DS, fname.replace(".png", ".json")), "w") as f:
                json.dump({"version": "5.2.1", "flags": {},
                           "shapes": [{"label": "weilong", "points": s,
                                       "group_id": None, "shape_type": "polygon",
                                       "flags": {}} for s in shapes],
                           "imagePath": fname, "imageData": None,
                           "imageHeight": IMG_H, "imageWidth": IMG_W}, f, ensure_ascii=False)
            with open(os.path.join(DS, fname.replace(".png", ".txt")), "w") as f:
                for s in shapes:
                    f.write("0 " + " ".join(f"{p[0]/IMG_W:.6f} {p[1]/IMG_H:.6f}" for p in s) + "\n")
        else:
            summary["skipped"] += 1
        img = cv2.imread(os.path.join(DS, fname))
        if img is not None:
            for s in shapes:
                cv2.polylines(img, [np.array(s, np.int32)], True, (0, 255, 0), 2)
            if tag != "OK":
                cv2.rectangle(img, (0, 0), (200, 40), (0, 0, 0), -1)
                cv2.putText(img, tag, (10, 30), 0, 1.0,
                            (0, 0, 255) if tag == "空" else (0, 165, 255), 2)
            cv2.imwrite(os.path.join(VIS_DIR, fname), img)
        rows.append((fname, tag, len(shapes)))
    with open(os.path.join(VIS_DIR, "index.html"), "w") as f:
        f.write("<html><head><meta charset='utf-8'><title>箱内标注检查</title></head><body "
                "style='background:#222;color:#ddd;font-family:sans-serif'>"
                f"<h2>箱内标注结果 — 有框 {summary['annotated']} / 空 {summary['empty']} / 未标 {summary['skipped']}</h2>")
        for fname, tag, n in rows:
            f.write(f"<div style='display:inline-block;margin:4px;text-align:center'>"
                    f"<img src='{fname}' width='400'>"
                    f"<div>{fname} <b style='color:"
                    f"{'#7f7' if tag=='OK' else ('#f77' if tag=='空' else '#fa5')}'>"
                    f"{tag}{'·'+str(n)+'框' if tag=='OK' else ''}</b></div></div>")
        f.write("</body></html>")
    with open(os.path.join(ROOT, "anno", "box_anno_summary.json"), "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    return summary


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if "json" in ctype or "html" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = unquote(self.path)
        if p == "/" or p.startswith("/index"):
            self._send(200, open(UI_F, "rb").read(), "text/html")
        elif p.startswith("/img/"):
            fp = os.path.join(DS, p[5:])
            self._send(200, open(fp, "rb").read(), "image/png") if os.path.isfile(fp) else self._send(404, {"err": fp})
        elif p.startswith("/thumb/"):
            tb = get_thumb(p[7:]) if p[7:].endswith(".png") else None
            if tb:
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(tb)))
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                self.wfile.write(tb)
            else:
                self._send(404, {"err": "no thumb"})
        elif p == "/api/bootstrap":
            self._send(200, {"images": image_list(), "state": load_state(), "w": IMG_W, "h": IMG_H})
        elif p.startswith("/api/last/"):
            self._send(200, load_state().get(p[10:], {"shapes": []}))
        else:
            self._send(404, {"err": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"err": "bad json"})
        if self.path == "/api/save":
            st = load_state()
            k = req.get("key", "")
            if k and any(k == i["key"] for i in image_list()):
                st[k] = {"shapes": [s for s in req.get("shapes", []) if len(s) >= 3],
                         "empty": bool(req.get("empty")),
                         "done": req.get("done", True)}
                save_state(st)
                return self._send(200, {"ok": True})
            return self._send(400, {"err": "bad key"})
        if self.path == "/api/export":
            return self._send(200, {"ok": True, "summary": write_outputs(load_state(), image_list())})
        self._send(404, {"err": "not found"})


if __name__ == "__main__":
    port = 8765
    print(f"箱内标注工具: http://0.0.0.0:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
