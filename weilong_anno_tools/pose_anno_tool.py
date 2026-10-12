#!/usr/bin/env python3
"""pose 手动标注工具服务器 (YOLO11-pose: 正面/反面两类 + 4 脚点)
打开: http://localhost:8765  (VSCode 远程时会自动转发端口)

- GET  /                标注页面
- GET  /img/<fol>/<f>   图片
- GET  /api/bootstrap   图片列表 + 当前进度状态
- POST /api/save        保存单张标注 {key, shapes:[{kpts,cls}], empty}
- POST /api/export      提交: 写 *_Color.pose.json + *_Color.pose.txt + 可视化
                        (不动旧 seg 标注 *_Color.json / *_Color.txt)

脚点顺序约定: 左上→右上→右下→左下 (顺时针); box 由 4 脚点 AABB 自动得出。
YOLO pose 标签行: cls cx cy w h kx1 ky1 kx2 ky2 kx3 ky3 kx4 ky4 (归一化)
"""
import json, os, glob, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = "/home/tianlian/weilong"
DS = os.path.join(ROOT, "dataset_seg")
THUMB_DIR = os.path.join(ROOT, "anno", ".anno_thumbs")     # 与旧工具共用缩略图缓存
STATE_F = os.path.join(ROOT, "anno", "pose_anno_state.json")
UI_F = os.path.join(ROOT, "anno", "pose_anno_ui.html")
SUGG_F = os.path.join(ROOT, "anno", "manual_anno_state.json")  # 旧四边形 → 预填脚点
VIS_DIR = os.path.join(ROOT, "dataset_seg_pose_vis")
FOLDERS = ["weilong-data1", "weilong-data2", "weilong-data3"]
IMG_W, IMG_H = 1280, 720
CLS_NAMES = ["front", "back"]  # 0=正面 1=反面
N_KPT = 4


def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def image_list():
    out = []
    for fol in FOLDERS:
        for f in sorted(glob.glob(os.path.join(DS, fol, "*_Color.png")), key=natkey):
            out.append({"key": fol + "/" + os.path.basename(f).replace("_Color.png", ""),
                        "file": os.path.basename(f), "folder": fol})
    return out


def load_state():
    if os.path.exists(STATE_F):
        try:
            return json.load(open(STATE_F))
        except Exception:
            pass
    st = {}
    if os.path.exists(SUGG_F):          # 旧 seg 四边形预填为脚点, 待确认(done=False)
        for k, e in json.load(open(SUGG_F)).items():
            quads = e.get("shapes") or []
            if e.get("empty") or not quads:
                st[k] = {"shapes": [], "empty": True, "done": False}
            else:
                st[k] = {"shapes": [{"kpts": q, "cls": 0} for q in quads if len(q) == N_KPT],
                         "empty": False, "done": False}
    return st


def save_state(st):
    tmp = STATE_F + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE_F)


def get_thumb(fol, fname):
    """192x108 JPEG 缩略图, 生成一次后走磁盘缓存."""
    import cv2
    os.makedirs(THUMB_DIR, exist_ok=True)
    tp = os.path.join(THUMB_DIR, fol + "_" + fname.replace(".png", ".jpg"))
    if not os.path.exists(tp):
        im = cv2.imread(os.path.join(DS, fol, fname))
        if im is None:
            return None
        cv2.imwrite(tp, cv2.resize(im, (192, 108)),
                    [cv2.IMWRITE_JPEG_QUALITY, 72])
    with open(tp, "rb") as f:
        return f.read()


def kpt_line(s):
    """一个形状 -> YOLO pose 标签行 (cls cx cy w h + 4 脚点, 归一化)."""
    xs = [p[0] for p in s["kpts"]]
    ys = [p[1] for p in s["kpts"]]
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (x1 + x2) / 2 / IMG_W, (y1 + y2) / 2 / IMG_H
    w, h = (x2 - x1) / IMG_W, (y2 - y1) / IMG_H
    kpts = " ".join(f"{p[0]/IMG_W:.6f} {p[1]/IMG_H:.6f}" for p in s["kpts"])
    return f"{s['cls']} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f} {kpts}"


def write_outputs(st, imgs):
    """清理旧 .pose.* -> 写 pose JSON / YOLO pose txt / 可视化 / 汇总.
    只管理 *.pose.json / *.pose.txt, 不触碰旧 seg 的 *_Color.json / *_Color.txt."""
    import cv2, numpy as np
    summary = {"annotated": 0, "empty": 0, "skipped": 0, "front": 0, "back": 0,
               "per_folder": {}}
    for fol in FOLDERS:                              # 只清理本工具的旧文件
        for old in glob.glob(os.path.join(DS, fol, "*_Color.pose.json")) + \
                   glob.glob(os.path.join(DS, fol, "*_Color.pose.txt")):
            os.remove(old)
    os.makedirs(VIS_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(VIS_DIR, "*.png")) + \
               glob.glob(os.path.join(VIS_DIR, "index.html")):
        os.remove(old)
    rows = []
    for it in imgs:
        k, fol, fname = it["key"], it["folder"], it["file"]
        e = st.get(k) or {}
        shapes = [s for s in (e.get("shapes") or [])
                  if len(s.get("kpts") or []) == N_KPT and s.get("cls") in (0, 1)]
        empty = bool(e.get("empty"))
        done = bool(e.get("done"))
        vis_path = os.path.join(VIS_DIR, fol + "_" + fname)
        if empty:
            summary["empty"] += 1
        elif shapes and done:
            summary["annotated"] += 1
            summary["front"] += sum(1 for s in shapes if s["cls"] == 0)
            summary["back"] += sum(1 for s in shapes if s["cls"] == 1)
            jname = fname.replace(".png", ".pose.json")
            yname = fname.replace(".png", ".pose.txt")
            with open(os.path.join(DS, fol, jname), "w") as f:
                json.dump({"version": "pose-1", "flags": {},
                           "imgW": IMG_W, "imgH": IMG_H,
                           "kpt_order": ["左上", "右上", "右下", "左下"],
                           "shapes": [{"label": CLS_NAMES[s["cls"]],
                                       "kpts": s["kpts"], "cls": s["cls"]}
                                      for s in shapes],
                           "imagePath": fname}, f, ensure_ascii=False, indent=1)
            with open(os.path.join(DS, fol, yname), "w") as f:
                for s in shapes:
                    f.write(kpt_line(s) + "\n")
        else:
            summary["skipped"] += 1
        # 可视化 (未标注也生成, 方便检查)
        img = cv2.imread(os.path.join(DS, fol, fname))
        if img is None:
            continue
        for s in shapes:
            pts = np.array(s["kpts"], np.int32)
            color = (0, 255, 0) if s["cls"] == 0 else (255, 255, 0)  # 绿=正面 青=反面
            cv2.polylines(img, [pts], True, color, 3)
            for j, p in enumerate(pts):
                cv2.circle(img, tuple(p), 6, (0, 0, 255), -1)
                cv2.putText(img, str(j + 1), (p[0] + 8, p[1] - 6), 0, 0.8,
                            (255, 255, 255), 2)
        tag = "空" if empty else ("" if shapes and done else "未标注")
        if tag:
            cv2.rectangle(img, (0, 0), (260, 44), (0, 0, 0), -1)
            cv2.putText(img, tag, (12, 32), 0, 1.0,
                        (0, 0, 255) if tag == "空" else (0, 165, 255), 2)
        cv2.imwrite(vis_path, img)
        rows.append((fol, fname, tag or "OK"))
    with open(os.path.join(VIS_DIR, "index.html"), "w") as f:
        f.write("<html><head><meta charset='utf-8'><title>pose标注检查</title></head><body "
                "style='background:#222;color:#ddd;font-family:sans-serif'>"
                "<h2>pose 手动标注结果可视化 (绿=正面 青=反面, 红点编号=脚点顺序)</h2>")
        for fol in FOLDERS:
            fs = [r for r in rows if r[0] == fol]
            if not fs:
                continue
            n_ok = sum(1 for r in fs if r[2] == "OK")
            n_emp = sum(1 for r in fs if r[2] == "空")
            f.write(f"<h3>{fol} — 有目标 {n_ok} / 空 {n_emp} / 共 {len(fs)}</h3>")
            for fol2, fname, tag in fs:
                base = fol2 + "_" + fname
                f.write(f"<div style='display:inline-block;margin:4px;text-align:center'>"
                        f"<img src='{base}' width='400'>"
                        f"<div>{fname} <b style='color:"
                        f"{'#7f7' if tag=='OK' else ('#f77' if tag=='空' else '#fa5')}'>"
                        f"{tag}</b></div></div>")
        f.write("</body></html>")
    summary["per_folder"] = {
        fol: {"annotated": sum(1 for r in rows if r[0] == fol and r[2] == "OK"),
              "empty": sum(1 for r in rows if r[0] == fol and r[2] == "空"),
              "skipped": sum(1 for r in rows if r[0] == fol and r[2] == "未标注")}
        for fol in FOLDERS}
    with open(os.path.join(ROOT, "anno", "pose_anno_summary.json"), "w") as f:
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
            fp = os.path.join(DS, *p[5:].split("/"))
            if os.path.isfile(fp):
                self._send(200, open(fp, "rb").read(), "image/png")
            else:
                self._send(404, {"err": fp})
        elif p.startswith("/thumb/"):
            fol, fname = p[7:].split("/")[:2]
            tb = get_thumb(fol, fname) if fname.endswith(".png") else None
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
            self._send(200, {"images": image_list(), "state": load_state(),
                             "w": IMG_W, "h": IMG_H})
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
                st[k] = {"shapes": [s for s in req.get("shapes", [])
                                    if len(s.get("kpts") or []) == N_KPT
                                    and s.get("cls") in (0, 1)],
                         "empty": bool(req.get("empty")),
                         "done": req.get("done", True)}
                save_state(st)
                return self._send(200, {"ok": True})
            return self._send(400, {"err": "bad key"})
        if self.path == "/api/export":
            summary = write_outputs(load_state(), image_list())
            return self._send(200, {"ok": True, "summary": summary})
        self._send(404, {"err": "not found"})


if __name__ == "__main__":
    port = 8765
    print(f"pose 标注工具: http://localhost:{port}  (Ctrl+C 退出)")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
