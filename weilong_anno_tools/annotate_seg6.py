#!/usr/bin/env python3
"""v6: annotate bags LYING FLAT on the black display ramp.

Scene insight (2026-09-30): the "mat" is a ramp tilted toward the camera, so a
bag lying flat on it spans y~180-600 and looks almost identical to a bag
clamped upright on the clip stand. The reliable discriminator is the black bar
at the bag's top edge:
  - clamped: the clip is a solid black (V<45, S<20) bar ~140px wide sitting
    directly on the bag's top edge;
  - lying on ramp: above the bag top is dark ramp surface (S>=40) plus at most
    the thin pole (~40px wide) -> max contiguous black run stays small.
So: reject a bag only if the widest black run in the band above its top edge,
measured over the bag's own x-range, exceeds CLIP_RUN px.

v5 params otherwise relaxed: MIN 140x90, aspect 0.75-3.6.
"""
import cv2
import numpy as np
import sys, os, glob, collections, json

RIM_Y0, RIM_Y1, RIM_X0, RIM_X1 = 136, 192, 200, 1080
MIN_LONG, MIN_SHORT = 140, 90
ASPECT_LO, ASPECT_HI = 0.75, 3.6
CLIP_RUN = 100          # px of contiguous black above top edge => clamped
BAND_UP, BAND_DN = 50, 3

sys.path.insert(0, "/home/tianlian/weilong/anno")
from annotate_seg import mat_roi, bag_mask, order_quad


def black_run_above(img, x0, x1, y_top):
    """Widest contiguous run of clip-black pixels in the band above y_top,
    measured along x within [x0, x1] at each row, max over rows."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    ya = max(int(y_top - BAND_UP), 0)
    yb = max(int(y_top - BAND_DN), 0)
    if yb <= ya or x1 <= x0:
        return 0
    best = 0
    for y in range(ya, yb):
        row_black = ((hsv[y, x0:x1, 2] < 45) & (hsv[y, x0:x1, 1] < 20))
        run = cur = 0
        for b in row_black:
            cur = cur + 1 if b else 0
            run = max(run, cur)
        best = max(best, run)
    return best


def find_flat_bags(img):
    h, w = img.shape[:2]
    roi = mat_roi(img)
    if roi is None:
        return [], "no-mat"
    m = bag_mask(img, roi)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if min(bw, bh) < 40 or area < 1800:
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
        bx, by, bw, bh = cv2.boundingRect(cnt)
        if long < MIN_LONG or short < MIN_SHORT:
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} SMALL]")
            continue
        if not (ASPECT_LO <= long / short <= ASPECT_HI):
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} ASP {long/short:.2f}]")
            continue
        run = black_run_above(img, bx, bx + bw, by)
        if run >= CLIP_RUN:
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} CLAMP run={run}]")
            continue
        q = cv2.boxPoints(((cx, cy), (rw, rh), ang)).astype(np.float32)
        quads.append(order_quad(q))
        dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} OK run={run}]")
    return quads, " ".join(dbg)


if __name__ == "__main__":
    files = sys.argv[1:] or sorted(
        glob.glob("/home/tianlian/weilong/dataset_seg/weilong-data[123]/*_Color.png"))
    outdir = "/home/tianlian/weilong/scratch/vis_v6"
    os.makedirs(outdir, exist_ok=True)
    cnt = collections.Counter()
    results = {}
    for f in files:
        img = cv2.imread(f)
        quads, dbg = find_flat_bags(img)
        cnt[len(quads)] += 1
        key = f.split("dataset_seg/")[-1].replace("_Color.png", "")
        results[key] = [q.round(1).tolist() for q in quads]
        vis = img.copy()
        for q in quads:
            cv2.polylines(vis, [q.astype(int)], True, (0, 255, 0), 4)
            for p in q.astype(int):
                cv2.circle(vis, tuple(p), 6, (0, 0, 255), -1)
        if not quads:
            cv2.putText(vis, "NONE", (60, 100), 0, 2, (0, 0, 255), 6)
        tag = "_".join(f.split("/")[-2:]).replace(".png", "")
        cv2.imwrite(os.path.join(outdir, tag + ".png"), vis)
    json.dump(results, open("/home/tianlian/weilong/anno/v6_quads.json", "w"), indent=0)
    print("bags-per-image:", dict(cnt), "total:", len(files))
    zero = [k for k, v in results.items() if not v]
    print("zero-detection:", zero)
