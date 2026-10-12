#!/usr/bin/env python3
"""v7: bags lying flat on the black display ramp.

Clamp test redesigned: find the clip first (solid black blob V<45 S<20 in the
upper band y<270, wide >=80px). A bag is CLAMPED only if its top edge sits
inside/near the clip's y-range AND the clip spans >=35% of the bag's width.
A bag lying high on the ramp just below the clip therefore survives (its top
edge is clearly below the clip bottom); a gripped bag whose top edge is hidden
inside the clip gets rejected. data3 (all gripped) must end at zero.

Same relaxed size sanity as v6: >=140x90, aspect 0.75-3.6.
"""
import cv2
import numpy as np
import sys, os, glob, collections, json

RIM_Y0, RIM_Y1, RIM_X0, RIM_X1 = 136, 192, 200, 1080
MIN_LONG, MIN_SHORT = 140, 90
ASPECT_LO, ASPECT_HI = 0.75, 3.6

sys.path.insert(0, "/home/tianlian/weilong/anno")
from annotate_seg import mat_roi, bag_mask, order_quad


def find_clip(img):
    """bbox (x0, y0, x1, y1) of the black clip in the upper band, else None."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    black = (((hsv[:, :, 2] < 45) & (hsv[:, :, 1] < 20)).astype(np.uint8)) * 255
    band = np.zeros_like(black)
    band[90:270, :] = 255
    black = cv2.morphologyEx(black & band, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(black, 8)
    best, bw_max = None, 0
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if 80 <= w <= 280 and 25 <= h <= 90 and area > 1500 and w > bw_max:
            best, bw_max = (x, y, x + w, y + h), w
    return best


def find_flat_bags(img):
    h, w = img.shape[:2]
    roi = mat_roi(img)
    if roi is None:
        return [], "no-mat"
    clip = find_clip(img)
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
        why = ""
        if clip is not None:
            cx0, cy0, cx1, cy1 = clip
            if by <= cy1 + 10 and by + bh >= cy0 - 8:          # vertical overlap w/ clip
                ov = max(0, min(bx + bw, cx1) - max(bx, cx0))
                if ov >= 0.35 * bw and by <= cy1 + 10 and by >= cy0 - 12:
                    why = f"CLAMP clip={clip}"
        if why:
            dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} {why}]")
            continue
        q = cv2.boxPoints(((cx, cy), (rw, rh), ang)).astype(np.float32)
        quads.append(order_quad(q))
        dbg.append(f"[{int(cx)},{int(cy)} {int(long)}x{int(short)} OK clip={clip}]")
    return quads, " ".join(dbg)


if __name__ == "__main__":
    files = sys.argv[1:] or sorted(
        glob.glob("/home/tianlian/weilong/dataset_seg/weilong-data[123]/*_Color.png"))
    outdir = "/home/tianlian/weilong/scratch/vis_v7"
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
            cv2.polylines(vis, [np.array(q, int)], True, (0, 255, 0), 4)
            for p in np.array(q, int):
                cv2.circle(vis, tuple(p), 6, (0, 0, 255), -1)
        if not quads:
            cv2.putText(vis, "NONE", (60, 100), 0, 2, (0, 0, 255), 6)
        tag = "_".join(f.split("/")[-2:]).replace(".png", "")
        cv2.imwrite(os.path.join(outdir, tag + ".png"), vis)
        if not quads:
            print(key, dbg[:220])
    json.dump(results, open("/home/tianlian/weilong/anno/v7_quads.json", "w"), indent=0)
    print("bags-per-image:", dict(cnt), "total:", len(files))
