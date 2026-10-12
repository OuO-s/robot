#!/usr/bin/env python3
"""Annotate FLAT Weilong konjac bags lying on the black display mat.

Scene (fixed camera): white desk -> dark mat (~x230-1040, y145-695).
data1/data2 hold flat bags (long strips ~2.15:1, or folded squares ~190px);
data2 images may ALSO hold a bag clamped upright on a black clip+pole stand
(clip = solid black V<45 S<20 blob directly above the bag's top) — those are
NOT targets. data3 (clamped bags only) is skipped by the caller.

v5: mask -> drop slivers -> erase rim band -> close -> dilate(25)-merge ->
intersect back -> minAreaRect -> size/aspect sanity -> reject if black clip
sits directly on top of the component.
"""
import cv2
import numpy as np

RIM_Y0, RIM_Y1, RIM_X0, RIM_X1 = 136, 192, 200, 1080
MIN_LONG, MIN_SHORT = 160, 110
ASPECT_LO, ASPECT_HI = 0.9, 3.2
CLIP_FRAC, CLIP_V, CLIP_S = 0.15, 45, 20

def mat_roi(img):
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    dark = (((hsv[:, :, 2] < 90) & (hsv[:, :, 1] < 90)).astype(np.uint8)) * 255
    win = np.zeros_like(dark)
    win[int(h*0.08):int(h*0.95), int(w*0.20):int(w*0.80)] = 255
    dark = cv2.bitwise_and(dark, win)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, 8)
    if n <= 1:
        return None
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[idx, cv2.CC_STAT_AREA] < 0.15 * w * h:
        return None
    return cv2.dilate((labels == idx).astype(np.uint8) * 255,
                      cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))

def bag_mask(img, roi):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    red = (((h < 14) | (h > 160)) & (s > 110) & (v > 80)).astype(np.uint8)
    blue = ((h > 90) & (h < 130) & (s > 110) & (v > 60)).astype(np.uint8)
    bright = ((v > 150) & (s < 95)).astype(np.uint8)
    return ((red | blue | bright) * 255).astype(np.uint8) & roi

def clip_frac_above(img, cx, y0):
    """Black-clip coverage in the 40px band above y0 around cx."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    x0, x1 = max(int(cx - 70), 0), min(int(cx + 70), img.shape[1])
    ya, yb = max(int(y0 - 42), 0), max(int(y0 - 2), 0)
    if x1 <= x0 or yb <= ya:
        return 0.0
    win = hsv[ya:yb, x0:x1]
    return float(((win[:, :, 2] < CLIP_V) & (win[:, :, 1] < CLIP_S)).mean())

def find_bags(img):
    """Return (quads TL-TR-BR-BL, debug) for flat bags."""
    h, w = img.shape[:2]
    roi = mat_roi(img)
    if roi is None:
        return [], "no-mat"
    m = bag_mask(img, roi)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if min(bw, bh) < 45 or area < 2500:
            m[labels == i] = 0
    m[RIM_Y0:RIM_Y1, RIM_X0:RIM_X1] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    md = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(md, 8)
    quads, dbg = [], []
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 0.004 * w * h:
            continue
        bag = m.copy()
        bag[labels != i] = 0
        cnts, _ = cv2.findContours(bag, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        if cv2.contourArea(cnt) < 0.004 * w * h:
            continue
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(cnt)
        long, short = max(rw, rh), min(rw, rh)
        x, y, bw, bh = cv2.boundingRect(cnt)
        if long < MIN_LONG or short < MIN_SHORT:
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} SMALL]")
            continue
        if not (ASPECT_LO <= long / short <= ASPECT_HI):
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} ASPECT {long/short:.2f}]")
            continue
        cf = clip_frac_above(img, cx, y)
        if cf > CLIP_FRAC:
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} CLIPPED {cf:.2f}]")
            continue
        q = cv2.boxPoints(((cx, cy), (rw, rh), ang)).astype(np.float32)
        quads.append(order_quad(q))
        dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} OK c{cf:.2f}]")
    return quads, " ".join(dbg)

def order_quad(q):
    q = np.asarray(q, np.float64)
    s = q.sum(1); d = np.diff(q, axis=1).ravel()
    return np.array([q[np.argmin(s)], q[np.argmin(d)],
                     q[np.argmax(s)], q[np.argmax(d)]], dtype=np.float32)

if __name__ == "__main__":
    import sys, os, glob, collections
    files = sys.argv[1:] or sorted(
        glob.glob("/home/tianlian/weilong/dataset_seg/weilong-data[12]/*_Color.png"))
    outdir = "/home/tianlian/weilong/dataset_seg_vis_debug"
    os.makedirs(outdir, exist_ok=True)
    cnt = collections.Counter()
    for f in files:
        img = cv2.imread(f)
        quads, dbg = find_bags(img)
        cnt[len(quads)] += 1
        vis = img.copy()
        for q in quads:
            cv2.polylines(vis, [q.astype(int)], True, (0, 255, 0), 4)
            for p in q.astype(int):
                cv2.circle(vis, tuple(p), 6, (0, 0, 255), -1)
        if not quads:
            cv2.putText(vis, "NONE", (60, 100), 0, 2, (0, 0, 255), 6)
        tag = "_".join(f.split("/")[-2:]).replace(".png", "")
        cv2.imwrite(os.path.join(outdir, tag + ".png"), vis)
        status = "" if (len(quads) == 1 and "OK" in dbg) else "  <<<"
        print(tag, len(quads), dbg, status)
    print("bags-per-image:", dict(cnt), "total:", len(files))
