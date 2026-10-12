#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
左右共用动作队列 — 调试台 :7010 做协调器
================================================
④对准 / ⑦示教 / ⑧抓取 / ⑭单袋吸取 从网页入队(自动带 左/右 前缀),
队列全局只有一条, 按项调用对应 PBVS 实例(7004/7005)顺序执行 —— 左右臂绝不并行。

停止语义(与旧单臂队列一致): 置 stop 旗 + 调当前臂 /pbvs/api/exec/abort,
当前动作在最近检查点(平移每 ≤18mm / dwell 每 0.1s)停下、臂停在原位,
剩余项清空; 任一项失败整队停(项间有位置依赖)。⑭ 吸取项=当前一次到位段
走完即停(子进程终止, 已下发段控制器会完整执行)。

循环执行(2026-10-07): /queue/run 带 loops(N≥1 轮数, 0=无限直到停止),
启动时把待执行项快照成「本轮子」; 每轮跑完整队自动重灌下一轮,
任一轮任何一项失败或点停止 → 整个循环终止。执行中热追加的项只进当前轮,
后续轮仍按启动时的快照重灌。待执行项支持 /queue/move ↑↓ 调序;
预设可 append 追加到现有队列(拼接多个预设后再调序、循环跑)。

历史项(已执行)保留 kind/params → 网页上可「↻ 重新入队」复活重跑或单条移除。
队列存本服务内存: 重启 pbvs-debug-web 即清空(与旧实现一致)。

/run 运行页(2026-10-11): 步骤存 config/run_page.json(⑮「保存到运行页」快照来,
文件持久化重启不丢), 「一键开始」= load_and_run 换入+启动原子完成;
运行中改文件不影响本轮(轮末按启动快照重灌), 下次启动才生效。

运行日志(2026-10-11): 启动/轮次/逐步结果/停止请求/结束原因 持久化到
config/run_log.jsonl(超 1MB 留末 3000 行) — 内存队列重启即清, 这份文件
还在, 中断原因可追溯; 服务启动时发现上次运行没写 run_end(进程被杀/重启)
→ 补 abandoned 记录。GET /api/queue/log?limit=N 读。

计时日志(2026-10-12): 每步 开始/结束/耗时 + 每轮 开始/结束/墙钟耗时
(= 各步之和 + 开销)与轮起跑时两臂全局速度 + 每次运行摘要(总时长/均轮/各轮)
持久化到 config/run_timing.jsonl(超 1MB 留末 3000 行) — 分析每轮执行耗时用。
GET /api/queue/timing?pretty=1 出人读格式, ?excel=1 下载 .xlsx。
"""

import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

from flask import Blueprint, Response, jsonify, request

bp = Blueprint("queue_hub", __name__)

PORT = {"left": 7004, "right": 7005}
Q_KINDS = ("align_step", "align_wait", "teach_goto", "teach_play",
           "gripper", "grasp_seq", "dwell", "suction")

_lock = threading.Lock()          # _items/_done 与工作线程并发增删
_items, _done = [], []
_current = [None]
_cur_t0 = [0.0]                     # 当前项开始时刻(0=无) — 网页显示实时已耗时
_running = [False]
_stop = threading.Event()
_uid = [0]
_plan = {"batch": [], "total": 0, "cycle": 0}   # 循环执行: 启动快照/总轮数(0=∞)/当前轮


def _log(msg):
    try:
        print("[QUEUE-HUB] %s" % msg, flush=True)
    except Exception:
        pass


# ---------------- 运行日志(持久化 jsonl — 中断原因排查用) ----------------

_RLOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "config", "run_log.jsonl")
_rlog_lock = threading.Lock()      # 只保护日志文件; 绝不与 _lock 嵌套


def _rlog(event, **kw):
    """追加一条运行日志。任何失败只吞掉 — 日志绝不影响执行。不持 _lock 调用。"""
    try:
        with _rlog_lock:
            os.makedirs(os.path.dirname(_RLOG_FILE), exist_ok=True)
            if os.path.exists(_RLOG_FILE) and os.path.getsize(_RLOG_FILE) > 1_000_000:
                try:               # 超 1MB: 留末 3000 行
                    with open(_RLOG_FILE) as f:
                        lines = f.readlines()[-3000:]
                    with open(_RLOG_FILE + ".tmp", "w") as f:
                        f.writelines(lines)
                    os.replace(_RLOG_FILE + ".tmp", _RLOG_FILE)
                except Exception:
                    pass
            with open(_RLOG_FILE, "a") as f:
                f.write(json.dumps({"t": round(time.time(), 2), "event": event, **kw},
                                   ensure_ascii=False) + "\n")
    except Exception:
        pass


def _rlog_check_abandoned():
    """服务启动时: 上次运行没等到 run_end(进程被杀/整机重启) → 补一条中断记录。
    这是最难排查的静默中断 — 内存队列没了, 只有日志知道当时跑到哪。"""
    try:
        with _rlog_lock:
            if not os.path.exists(_RLOG_FILE):
                return
            with open(_RLOG_FILE) as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
        if not lines:
            return
        try:
            last = json.loads(lines[-1])
        except Exception:
            return
        if last.get("event") not in ("run_end", "abandoned"):
            _rlog("abandoned", cycle=last.get("cycle"),
                  note="服务重启/进程退出, 上次运行到此被丢弃"
                       "(最后事件: %s)" % last.get("event"))
    except Exception:
        pass


_rlog_check_abandoned()


# ---------------- 计时日志(专门记录时间 — 分析每轮/每步执行耗时) ----------------
# 独立文件 config/run_timing.jsonl, 每步一条(开始/结束/耗时) + 每轮一条
# (墙钟 = 步和 + 开销) + 每次运行一条摘要(总时长/均轮/各轮)。
# GET /api/queue/timing?pretty=1 出人读格式。

_TIMING_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "config", "run_timing.jsonl")
_timing_seq = [0]                 # 运行序号(计时日志分组用; 同时刻只有一次运行)


def _tlog(obj):
    """追加一条计时记录(超 1MB 留末 3000 行)。绝不影响执行; 不持 _lock 调用。"""
    try:
        with _rlog_lock:          # 与 _rlog 共用一把小锁(都是单行追加)
            os.makedirs(os.path.dirname(_TIMING_FILE), exist_ok=True)
            if os.path.exists(_TIMING_FILE) and os.path.getsize(_TIMING_FILE) > 1_000_000:
                try:
                    with open(_TIMING_FILE) as f:
                        lines = f.readlines()[-3000:]
                    with open(_TIMING_FILE + ".tmp", "w") as f:
                        f.writelines(lines)
                    os.replace(_TIMING_FILE + ".tmp", _TIMING_FILE)
                except Exception:
                    pass
            with open(_TIMING_FILE, "a") as f:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _tlog_init_seq():
    """服务启动: 运行序号接续文件里已有的最大 seq。进程内计数器随重启归零,
    不接续的话重启后新运行又从 #1 编 → 与文件里旧运行撞号, pretty 按
    (seq,cycle) 分组会把两次运行的步骤混进同一轮(10-12 实机踩过)。"""
    try:
        with _rlog_lock:
            if not os.path.exists(_TIMING_FILE):
                return
            with open(_TIMING_FILE) as f:
                lines = f.read().splitlines()
        mx = 0
        for l in lines:                     # 扫全文件(非只尾巴): 轮转后旧代也可能高
            try:
                s = json.loads(l).get("seq")
                if isinstance(s, int) and s > mx:
                    mx = s
            except Exception:
                pass
        _timing_seq[0] = mx
    except Exception:
        pass


_tlog_init_seq()


_SIDE_CN = {"left": "左", "right": "右"}


def _hms(t):
    try:
        return time.strftime("%H:%M:%S", time.localtime(t or 0))
    except Exception:
        return "?"


def _spfmt(v):                                # 速度值 → 整数字符串(离线/缺 → ?)
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return "?"


def _timing_pretty(evs):
    """计时事件 → 人读文本: 运行头 → 每轮(墙钟=步和+开销) → 逐步明细 → 摘要。"""
    by_cycle = {}                                # (seq,cycle) → 逐步行(时间序)
    out = []
    for e in evs:
        ev = e.get("event")
        if ev == "step":
            by_cycle.setdefault((e.get("seq"), e.get("cycle")), []).append(
                "    %2d. %s→%s %7.2fs %s [%s] %s" %
                (e.get("idx") or 0, _hms(e.get("start")), _hms(e.get("end")),
                 e.get("dur_s") or 0.0, "✓" if e.get("ok") else "✗",
                 _SIDE_CN.get(e.get("side"), e.get("side")), e.get("label", "?")))
        elif ev == "run_start":
            out.append("===== 运行#%s · %s · %s 步 × %s · %s =====" %
                       (e.get("seq"), e.get("source"), e.get("steps"),
                        e.get("loops") if e.get("loops") else "∞",
                        time.strftime("%m-%d %H:%M:%S",
                                      time.localtime(e.get("t") or 0))))
        elif ev == "round":
            sp = e.get("speed") or {}
            sptxt = ""
            if any(sp.get(s) is not None for s in ("left", "right")):
                sptxt = " · 速L%s/R%s%%" % (_spfmt(sp.get("left")),
                                            _spfmt(sp.get("right")))
            out.append("  第%s轮  %s→%s  墙%.2fs = 步和%.2fs + 开销%.2fs  (%s步·%s%s)" %
                       (e.get("cycle"), _hms(e.get("start")), _hms(e.get("end")),
                        e.get("dur_s") or 0.0, e.get("step_sum_s") or 0.0,
                        e.get("overhead_s") or 0.0, e.get("steps"),
                        {"ok": "完成", "failed": "失败中断",
                         "stopped": "停止"}.get(e.get("ended"), e.get("ended")),
                        sptxt))
            out.extend(by_cycle.get((e.get("seq"), e.get("cycle")), []))
        elif ev == "run_summary":
            durs = e.get("round_durs") or []
            out.append("  ── 摘要: %s · %s轮 · 总%.2fs · 均轮%.2fs%s" %
                       ({"completed": "正常跑完", "failed": "失败中断",
                         "stopped": "用户停止"}.get(e.get("reason"), e.get("reason")),
                        e.get("rounds"), e.get("dur_s") or 0.0,
                        e.get("avg_round_s") or 0.0,
                        (" · 各轮[%s]" % ", ".join("%.1f" % v for v in durs))
                        if durs else ""))
    return "\n".join(out) + "\n"


# ---- Excel 导出(纯 stdlib: zipfile+XML 手写 .xlsx, 不依赖 openpyxl) ----

_XL_ENDED = {"ok": "完成", "failed": "失败中断", "stopped": "停止"}
_XL_REASON = {"completed": "正常跑完", "failed": "失败中断", "stopped": "用户停止"}


def _xl_esc(s):
    s = "".join(c if c >= " " or c == "\t" else " " for c in str(s))
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _xl_col(i):                              # 0→A, 25→Z, 26→AA
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _xl_sheet(rows, widths):
    """行列表 → sheet XML。str=inlineStr 文本, int/float=数字(Excel 可直接求和);
    首行冻结 + 表头自动筛选, 方便透视/求和。"""
    body = []
    for ri, row in enumerate(rows, 1):
        cs = []
        for ci, v in enumerate(row):
            ref = "%s%d" % (_xl_col(ci), ri)
            if isinstance(v, bool):
                v = "✓" if v else "✗"
            if isinstance(v, (int, float)):
                n = ("%d" % v) if isinstance(v, int) else \
                    ("%.4f" % v).rstrip("0").rstrip(".") or "0"
                cs.append('<c r="%s"><v>%s</v></c>' % (ref, n))
            else:
                cs.append('<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                          % (ref, _xl_esc(v if v is not None else "")))
        body.append('<row r="%d">%s</row>' % (ri, "".join(cs)))
    cols = "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>'
                   % (i + 1, i + 1, w) for i, w in enumerate(widths))
    tail = ('<autoFilter ref="A1:%s%d"/>' % (_xl_col(len(rows[0]) - 1), len(rows))
            if len(rows) > 1 else "")
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
            'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            '<cols>%s</cols><sheetData>%s</sheetData>%s</worksheet>'
            % (cols, "".join(body), tail))


def _timing_xlsx(evs):
    """计时事件 → .xlsx 字节(3 表: 逐步明细/每轮汇总/运行摘要)。失败向上抛(端点兜 500)。"""
    starts = {e.get("seq"): e for e in evs if e.get("event") == "run_start"}
    step_rows = [["运行#", "轮次", "步序", "臂", "类型", "步骤名称", "结果",
                  "开始时刻", "结束时刻", "耗时(s)"]]
    round_rows = [["运行#", "轮次", "开始时刻", "结束时刻", "墙钟耗时(s)",
                   "各步之和(s)", "开销(s)", "步数", "左臂速度(%)", "右臂速度(%)", "结局"]]
    sum_rows = [["运行#", "来源", "模式", "每轮步数", "结束原因", "开始", "结束",
                 "总耗时(s)", "平均每轮(s)", "各轮耗时(s)"]]
    for e in evs:
        ev = e.get("event")
        if ev == "step":
            step_rows.append([e.get("seq"), e.get("cycle"), e.get("idx") or 0,
                              _SIDE_CN.get(e.get("side"), e.get("side")),
                              e.get("kind"), e.get("label"),
                              "✓" if e.get("ok") else "✗",
                              _hms(e.get("start")), _hms(e.get("end")),
                              e.get("dur_s") or 0.0])
        elif ev == "round":
            sp = e.get("speed") or {}
            round_rows.append([e.get("seq"), e.get("cycle"),
                               _hms(e.get("start")), _hms(e.get("end")),
                               e.get("dur_s") or 0.0, e.get("step_sum_s") or 0.0,
                               e.get("overhead_s") or 0.0, e.get("steps") or 0,
                               sp.get("left") if sp.get("left") is not None else "",
                               sp.get("right") if sp.get("right") is not None else "",
                               _XL_ENDED.get(e.get("ended"), e.get("ended"))])
        elif ev == "run_summary":
            st = starts.get(e.get("seq"), {})
            durs = e.get("round_durs") or []
            sum_rows.append([e.get("seq"), st.get("source") or "?",
                             ("%d轮" % st["loops"]) if st.get("loops") else "∞",
                             st.get("steps"), _XL_REASON.get(e.get("reason"), e.get("reason")),
                             _hms(e.get("start")), _hms(e.get("end")),
                             e.get("dur_s") or 0.0, e.get("avg_round_s") or 0.0,
                             ", ".join("%.1f" % v for v in durs)])
    sheets = [_xl_sheet(step_rows, [7, 6, 6, 5, 11, 30, 5, 10, 10, 9]),
              _xl_sheet(round_rows, [7, 6, 10, 10, 11, 11, 9, 6, 10, 10, 10]),
              _xl_sheet(sum_rows, [7, 9, 7, 9, 10, 15, 15, 10, 11, 34])]
    CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType='
                    '"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i
                    for i in (1, 2, 3)) + '</Types>')
    RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>')
    WB = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets><sheet name="逐步明细" sheetId="1" r:id="rId1"/>'
          '<sheet name="每轮汇总" sheetId="2" r:id="rId2"/>'
          '<sheet name="运行摘要" sheetId="3" r:id="rId3"/></sheets></workbook>')
    WBRELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
              + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/'
                        'officeDocument/2006/relationships/worksheet" '
                        'Target="worksheets/sheet%d.xml"/>' % (i, i) for i in (1, 2, 3))
              + '</Relationships>')
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("xl/workbook.xml", WB)
        z.writestr("xl/_rels/workbook.xml.rels", WBRELS)
        for i, s in enumerate(sheets, 1):
            z.writestr("xl/worksheets/sheet%d.xml" % i, s)
    return bio.getvalue()


def _pbvs(side, path, body=None, timeout=300):
    """直连对应臂的 PBVS 实例(不走浏览器代理)。GET=body None。"""
    req = urllib.request.Request(
        "http://127.0.0.1:%d/pbvs/api/%s" % (PORT[side], path),
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _abort_arm(side):
    """让该臂当前长动作在检查点停下(不报错就算成功)。"""
    try:
        _pbvs(side, "exec/abort", {}, timeout=5)
    except Exception as e:
        _log("abort %s 失败(可能实例离线): %s" % (side, e))


def _exec(item, stop=None):
    """执行一个队列项 → (ok, detail)。stop=外部注入的停止事件(⑮双臂并行道用),
    默认⑨队列自己的 _stop —— ⑨ 调用方不传, 行为不变。"""
    ev = _stop if stop is None else stop
    side, kind, p = item["side"], item["kind"], item.get("params") or {}
    try:
        if kind == "align_step":
            r = _pbvs(side, "align/step", {}, timeout=120)
            if r.get("ok"):
                return True, "XY %s / Z %s mm" % (r.get("error_xy_mm"), r.get("error_z_mm"))
            return False, str(r.get("error"))[:80]

        if kind == "align_wait":
            st = _pbvs(side, "status", None, timeout=8).get("aligner", {})
            if st.get("is_running"):
                return False, "该臂对准已在运行(冲突)"
            _pbvs(side, "align/start", {}, timeout=15)
            timeout_s = max(10.0, min(600.0, float(p.get("timeout_s", 120))))
            t0 = time.time()
            while True:
                time.sleep(0.25)
                if ev.is_set():
                    _abort_arm(side)
                    return False, "用户停止"
                if time.time() - t0 > timeout_s:
                    _abort_arm(side)
                    return False, "超时(%.0fs)已停" % timeout_s
                if not _pbvs(side, "status", None, timeout=8).get("aligner", {}).get("is_running"):
                    break
            # 收敛判定用 grasp/state(含 iteration_count≥1, 防静止态 0/0 误判)
            g = _pbvs(side, "grasp/state", None, timeout=8)
            return bool(g.get("aligned")), \
                "XY %s / Z %s mm%s" % (g.get("error_xy_mm") if g.get("error_xy_mm") is not None else "—",
                                       g.get("error_z_mm") if g.get("error_z_mm") is not None else "—",
                                       "(已收敛)" if g.get("aligned") else "(未收敛)")

        if kind == "teach_goto":
            r = _pbvs(side, "teach/goto", {"name": p.get("name", "")}, timeout=180)
            return bool(r.get("ok")), str(r.get("error") or "")[:80] or "已到位"

        if kind == "teach_play":
            names = p.get("names") or []
            if not names:
                return False, "names 为空"
            r = _pbvs(side, "teach/play",
                      {"names": names, "dwell_s": float(p.get("dwell_s", 0.5))},
                      timeout=120 + 30 * len(names))
            if r.get("ok"):
                return True, "回放 %d 点" % len(r.get("done") or [])
            fl = r.get("failed") or []
            return False, "中断: " + (pretty_fail(fl) if fl else str(r.get("error"))[:80])

        if kind == "gripper":
            try:
                pos = max(0.0, min(1000.0, float(p.get("position", 0.0))))
            except (TypeError, ValueError):
                return False, "position 非数字"
            r = _pbvs(side, "grasp/gripper",
                      {"action": "set", "position": pos}, timeout=15)
            return bool(r.get("ok")), "开度→%.0f" % pos

        if kind == "grasp_seq":
            moves = p.get("moves") or []
            # 🧭⑩转正步: 派发前按最近一次⑩/⑭检测解析(⑨⑮共用 _exec 都走这里);
            # 解析失败=整项失败(臂不动), 队列按既有语义整队停
            note = ""
            if any(isinstance(m, dict) and "pose_align" in m for m in moves):
                try:
                    import pose_cache
                    moves, notes = pose_cache.resolve_moves(side, moves)
                    note = " | ".join(notes)[:60]
                except pose_cache.ResolveError as e:
                    return False, "🧭⑩转正步: %s" % e
            # smooth 默认 true = 与网页 ▶执行序列(一次到位) 同走法(每步一口气到);
            # 旧预设没存 smooth → 也按一次到位执行(10-07 起标准走法)
            r = _pbvs(side, "grasp/sequence",
                      {"moves": moves,
                       "require_aligned": bool(p.get("require_aligned", True)),
                       "dry_run": False,
                       "smooth": bool(p.get("smooth", True))},
                      timeout=min(900, 120 + 45 * max(1, len(moves))))
            d = r.get("aborted_at") or r.get("error") or \
                ("完成 %d 步" % len(r.get("steps") or []))
            if note:
                d = "%s · 🧭%s" % (d, note)
            return bool(r.get("ok")), str(d)[:100]

        if kind == "dwell":
            s = max(0.0, min(120.0, float(p.get("s", 1.0))))
            for _ in range(int(s * 10)):
                if ev.is_set():
                    return False, "用户停止"
                time.sleep(0.1)
            return True, "等待 %.1fs" % s

        if kind == "suction":
            # ⑭ 单袋吸取: 拉起 PBVS/suction_bag.py 子进程(扫描→直线直达→压紧 全链在
            # 脚本里)。仅左臂(示教点/偏移都在左臂)。
            # 10-10 用户定案: 队列版与网页🎯直达一致, 同样 --no-scan-move 不回放扫描位
            #   (在轮到它时的当前臂位扫)。⚠循环[⑭→⑧]里⑧结束后臂停在袋上, 下轮⑭
            #   在该位扫不到袋群会被拦下整队停 — 需循环时在⑧序列末尾加一步回扫描位
            #   (或其它能看全袋群的机位)再回到⑭。
            # params: {run:"direct"|"go"|"press", index, press_mm, hold_s, jog}
            if side != "left":
                return False, "⑭ 仅左臂(示教点/偏移都在左臂)"
            script = os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), "PBVS", "suction_bag.py")
            if not os.path.exists(script):
                return False, "脚本不存在: %s" % script
            run = p.get("run") if p.get("run") in ("direct", "go", "press") else "direct"
            try:
                idx = max(1, int(p.get("index", 1)))
            except (TypeError, ValueError):
                idx = 1
            cmd = [sys.executable, script, "--yes", "--index", str(idx)]
            if run == "direct":
                cmd += ["--direct", "--no-scan-move"]
            # 压紧/停留只在队列项显式带 press_mm 时下发(10-08 定版: 到位即停不等待,
            # 压紧/开真空移⑧序列做); 旧预设显式带了参数的仍照跑
            if run in ("press", "direct") and p.get("press_mm") is not None:
                try:
                    press = max(0.0, min(10.0, float(p.get("press_mm"))))
                    hold = max(0.0, min(5.0, float(p.get("hold_s", 1.0))))
                except (TypeError, ValueError):
                    return False, "press_mm/hold_s 须为数字"
                cmd += ["--press", "%.1f" % press, "--hold", "%.1f" % hold]
            if p.get("jog"):
                cmd.append("--jog")
            _log("suction: %s" % " ".join(cmd))
            proc = subprocess.Popen(
                cmd, cwd=os.path.dirname(script), text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            tail = []
            while proc.poll() is None:
                ln = proc.stdout.readline()
                if ln:
                    tail.append(ln.rstrip())
                    if len(tail) > 6:
                        tail.pop(0)
                    continue
                if ev.is_set():
                    # 停止语义=当前段走完即停: 杀客户端进程后, 已下发到 :8000 的
                    # 当前一次到位段仍会完整走完(臂不停在半段), 后续段不再下发
                    _abort_arm(side)
                    proc.terminate()
                    proc.wait(10)
                    return False, "用户停止(当前段走完即停): %s" % \
                        (tail[-1] if tail else "")[:56]
                time.sleep(0.1)
            out = proc.stdout.read()          # 收尾余量
            for ln in out.splitlines():
                if ln.strip():
                    tail.append(ln.strip())
            rc = proc.wait()
            d = " | ".join(tail[-3:])[:88]
            return rc == 0, ("rc=%d %s" % (rc, d)) if rc else (d or "完成")

        return False, "未知 kind: %s" % kind
    except Exception as e:
        return False, "异常: %s" % e


def pretty_fail(fl):
    f = fl[0] if fl else {}
    return "%s(%s)" % (f.get("name", "?"), f.get("error", "?"))


def _refill_batch():
    """把启动时的快照重灌进待执行队列(新一轮, 重新编 uid)。调用方持 _lock。"""
    for it in _plan["batch"]:
        _items.append({"uid": _uid[0], "side": it["side"], "kind": it["kind"],
                       "label": it["label"], "params": it.get("params") or {}})
        _uid[0] += 1


def _run():
    fail_info = None                             # 失败步信息(run_end 落日志)
    run_t0 = time.time()
    round_durs = []                              # 每轮墙钟耗时(计时日志摘要用)
    while True:                                  # 外层 = 轮次(循环执行)
        with _lock:
            _plan["cycle"] += 1
            cyc, total = _plan["cycle"], _plan["total"]
            n_items = len(_items)
        cyc_t0 = time.time()
        step_durs = []                           # 本轮各步耗时(步和/开销)
        speeds = {}                              # 本轮起跑时两臂全局速度(计时日志)
        for s in ("left", "right"):
            try:
                speeds[s] = _pbvs(s, "speed", None, timeout=5).get("speed")
            except Exception:
                speeds[s] = None                 # 实例离线 → 记 null(pretty 显 ?)
        _log("—— 第 %d 轮开始(%s, %d 项) ——" %
             (cyc, "无限循环" if not total else "共 %d 轮" % total, n_items))
        _rlog("cycle_start", cycle=cyc, items=n_items)
        failed = False
        idx = 0                                  # 本轮已执行到第几步(1起)
        while True:                              # 内层 = 单轮逐项
            with _lock:
                if _stop.is_set() or not _items:
                    break
                item = _items.pop(0)
                _current[0] = item
                _cur_t0[0] = time.time()
            idx += 1
            _log("执行: [%s] %s" % (item["side"], item["label"]))
            t0 = time.time()
            ok, detail = _exec(item)
            dur = time.time() - t0
            with _lock:
                _current[0] = None
                _cur_t0[0] = 0.0
                cyc_done = _plan["cycle"]
                # 历史保留 kind/params/独立 uid → 可「重新入队」直接复活重跑
                # t=完成时刻(服务器钟) dur_s=本项耗时 — 网页逐步计时显示
                _done.append({"uid": _uid[0], "side": item["side"],
                              "kind": item["kind"], "label": item["label"],
                              "params": item.get("params") or {},
                              "cycle": cyc_done,
                              "ok": ok, "detail": detail[:100],
                              "t": round(time.time(), 2),
                              "dur_s": round(dur, 1)})
                _uid[0] += 1
            _rlog("step_done", cycle=cyc_done, side=item["side"],
                  label=item["label"], ok=ok, dur_s=round(dur, 1), detail=detail)
            _tlog({"t": round(time.time(), 2), "event": "step",
                   "seq": _timing_seq[0], "cycle": cyc_done, "idx": idx,
                   "side": item["side"], "kind": item["kind"],
                   "label": item["label"], "ok": ok,
                   "start": round(t0, 2), "end": round(t0 + dur, 2),
                   "dur_s": round(dur, 2)})
            step_durs.append(dur)
            if not ok:
                fail_info = {"side": item["side"], "label": item["label"],
                             "detail": detail}
                with _lock:
                    _items.clear()               # 位置依赖安全: 任一项失败停整队
                failed = True
                break
        cyc_t1 = time.time()
        wall = cyc_t1 - cyc_t0
        round_durs.append(wall)
        _tlog({"t": round(cyc_t1, 2), "event": "round", "seq": _timing_seq[0],
               "cycle": cyc, "start": round(cyc_t0, 2), "end": round(cyc_t1, 2),
               "dur_s": round(wall, 2), "steps": idx,
               "step_sum_s": round(sum(step_durs), 2),
               "overhead_s": round(wall - sum(step_durs), 2),
               "speed": speeds,                 # 轮起跑时两臂全局速度(离线=null)
               "ended": "failed" if failed
               else ("stopped" if _stop.is_set() else "ok")})
        if _stop.is_set() or failed:
            break
        if total and _plan["cycle"] >= total:    # 规定轮数跑满
            break
        with _lock:
            _refill_batch()                      # 下一轮: 快照原样重灌
    reason = "stopped" if _stop.is_set() else ("failed" if failed else "completed")
    _log("队列结束(用户停=%s, 进行到第 %d 轮)" % (_stop.is_set(), _plan["cycle"]))
    end = {"reason": reason, "cycle": _plan["cycle"]}
    if fail_info:
        end["failed"] = fail_info                # 哪一步、什么错 — 中断主因
    _rlog("run_end", **end)
    now = time.time()
    _tlog({"t": round(now, 2), "event": "run_summary", "seq": _timing_seq[0],
           "reason": reason, "rounds": _plan["cycle"],
           "start": round(run_t0, 2), "end": round(now, 2),
           "dur_s": round(now - run_t0, 2),
           "avg_round_s": round(sum(round_durs) / len(round_durs), 2)
           if round_durs else 0.0,
           "round_durs": [round(w, 2) for w in round_durs[-100:]]})
    with _lock:
        _running[0] = False
        _plan.update({"batch": [], "total": 0})


# ---------------- HTTP API (/api/queue/*) ----------------

@bp.route("/queue/add", methods=["POST"])
def q_add():
    """入队(执行中可热追加)。body: {items:[{side:"left|right", kind, label, params}]}"""
    data = request.get_json(silent=True) or {}
    items = data.get("items") or []
    if not isinstance(items, list) or not items:
        return jsonify({"ok": False, "error": "需要 items 数组"})
    for it in items:
        if not isinstance(it, dict) or it.get("kind") not in Q_KINDS:
            return jsonify({"ok": False, "error": "kind 需是: %s" % "/".join(Q_KINDS)})
        if it.get("side") not in PORT:
            return jsonify({"ok": False, "error": "side 需是 left/right"})
    with _lock:
        for it in items:
            _items.append({"uid": _uid[0], "side": it["side"], "kind": it["kind"],
                           "label": str(it.get("label") or it["kind"])[:80],
                           "params": it.get("params") or {}})
            _uid[0] += 1
        n = len(_items)
    return jsonify({"ok": True, "pending": n})


def _begin_run_locked(items, loops):
    """锁内启动检查+置位(不动 _items): 三拒 → 清停止旗 → 快照 batch → total/cycle → 置运行。
    q_run 与 load_and_run 共用。返回 (pending数, err) — err 非 None 时未启动、状态未动。
    调用方持 _lock; items=本次要跑的 uid-free 项列表。"""
    from duo_hub import duo_running          # late import 防 circular(duo_hub 顶层 import 本模块)
    if _running[0]:
        return 0, "队列已在执行"
    if duo_running():
        return 0, "⑮ 双臂并行循环正在执行, 先停止它"
    if not items:
        return 0, "队列为空"
    _stop.clear()
    _plan["batch"] = [{"side": it["side"], "kind": it["kind"], "label": it["label"],
                       "params": it.get("params") or {}} for it in items]
    _plan["total"] = loops
    _plan["cycle"] = 0
    _running[0] = True
    return len(items), None


@bp.route("/queue/run", methods=["POST"])
def q_run():
    """开始执行。body: {loops:N} — N≥1 循环 N 轮, 0=无限(直到停止)。默认 1。
    启动时把待执行项快照为「本轮子」, 每轮跑完自动重灌; 失败/停止终止整个循环。"""
    data = request.get_json(silent=True) or {}
    try:
        loops = int(data.get("loops", 1))
    except (TypeError, ValueError):
        loops = 1
    loops = max(0, min(999, loops))
    with _lock:
        snapshot = [{"side": it["side"], "kind": it["kind"], "label": it["label"],
                     "params": it.get("params") or {}} for it in _items]
        n, err = _begin_run_locked(snapshot, loops)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    # 先落 run_start 再起线程 — 否则线程可能先写 cycle_start, 日志乱序
    _timing_seq[0] += 1
    _rlog("run_start", source="⑨队列", loops=loops, steps=n,
          plan=[{"side": it["side"], "label": it["label"]} for it in snapshot])
    _tlog({"t": round(time.time(), 2), "event": "run_start", "seq": _timing_seq[0],
           "source": "⑨队列", "loops": loops, "steps": n})
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"ok": True, "pending": n, "loops": loops})


def load_and_run(items, loops):
    """用 items 整体替换待执行队列并立即开始循环 — 「换入+启动」在同一把 _lock 下原子完成
    (拒绝条件与 /queue/run 相同; 拒绝时 _items 原样未动)。/run 运行页「一键开始」用
    (/api/runpage/start)。返回 (result, err)。"""
    norm = [{"side": it["side"], "kind": it["kind"],
             "label": str(it.get("label") or it["kind"])[:80],
             "params": it.get("params") or {}} for it in items]
    with _lock:
        n, err = _begin_run_locked(norm, loops)
        if err is None:
            _items.clear()
            for it in norm:
                _items.append({"uid": _uid[0], **it})
                _uid[0] += 1
    if err:
        return None, err
    _timing_seq[0] += 1               # 先落 run_start 再起线程(防乱序, 同 q_run)
    _rlog("run_start", source="运行页", loops=loops, steps=n,
          plan=[{"side": it["side"], "label": it["label"]} for it in norm])
    _tlog({"t": round(time.time(), 2), "event": "run_start", "seq": _timing_seq[0],
           "source": "运行页", "loops": loops, "steps": n})
    threading.Thread(target=_run, daemon=True).start()
    return {"pending": n, "loops": loops}, None


@bp.route("/queue/stop", methods=["POST"])
def q_stop():
    """停止: 当前动作在最近检查点停下(臂停原位), 剩余项清空。"""
    _stop.set()
    cur = _current[0]
    if cur:
        _abort_arm(cur["side"])
    with _lock:
        _items.clear()
    _rlog("stop_req", at=({"side": cur["side"], "label": cur["label"]}
                          if cur else None))
    return jsonify({"ok": True, "message": "停止信号已发, 剩余项已清空"})


@bp.route("/queue/clear", methods=["POST"])
def q_clear():
    with _lock:
        if _running[0]:
            return jsonify({"ok": False, "error": "执行中, 先停止"})
        _items.clear()
        _done.clear()
    return jsonify({"ok": True})


@bp.route("/queue/remove", methods=["POST"])
def q_remove():
    data = request.get_json(silent=True) or {}
    uid = data.get("uid")
    with _lock:
        for i, it in enumerate(_items):
            if it.get("uid") == uid:
                _items.pop(i)
                return jsonify({"ok": True, "removed": it.get("label")})
    return jsonify({"ok": False, "error": "未找到该 uid(可能已在执行或已完成)"})


@bp.route("/queue/move", methods=["POST"])
def q_move():
    """待执行项调序。body: {uid, dir:"up"|"down"} 或 {uid, to:目标下标}。
    执行中也可用(只影响后续取项顺序; 循环模式下后续轮仍按启动快照重灌)。"""
    data = request.get_json(silent=True) or {}
    uid = data.get("uid")
    with _lock:
        idx = next((i for i, it in enumerate(_items) if it.get("uid") == uid), None)
        if idx is None:
            return jsonify({"ok": False, "error": "未找到该 uid(可能已在执行或已完成)"})
        if data.get("dir") == "up":
            if idx == 0:
                return jsonify({"ok": False, "error": "已在最前"})
            j = idx - 1
        elif data.get("dir") == "down":
            if idx == len(_items) - 1:
                return jsonify({"ok": False, "error": "已在最后"})
            j = idx + 1
        else:
            try:
                j = max(0, min(len(_items) - 1, int(data.get("to", idx))))
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "需要 dir:up|down 或 to:下标"}), 400
        _items[idx], _items[j] = _items[j], _items[idx]
        label = _items[j].get("label")
    return jsonify({"ok": True, "moved": label, "index": j})


@bp.route("/queue/requeue", methods=["POST"])
def q_requeue():
    """把历史(已执行)项重新入队。body: {uids:[历史uid...]} 或 {all:true} 全部。
    执行中也可用(热追加); 复制 kind/params/side 原样追加到队尾。"""
    data = request.get_json(silent=True) or {}
    with _lock:
        if data.get("all"):
            src = [dict(d) for d in _done]
        else:
            uids = set(data.get("uids") or [])
            if not uids:
                return jsonify({"ok": False, "error": "需要 uids 数组或 all:true"})
            src = [dict(d) for d in _done if d.get("uid") in uids]
        if not src:
            return jsonify({"ok": False, "error": "没有匹配的历史项(可能已被清空)"})
        for d in src:
            _items.append({"uid": _uid[0], "side": d["side"], "kind": d["kind"],
                           "label": d["label"], "params": d.get("params") or {}})
            _uid[0] += 1
        n = len(_items)
    return jsonify({"ok": True, "requeued": len(src), "pending": n})


@bp.route("/queue/dismiss", methods=["POST"])
def q_dismiss():
    """从历史里移除一项(不影响待执行队列)。body: {uid}"""
    data = request.get_json(silent=True) or {}
    uid = data.get("uid")
    with _lock:
        for i, d in enumerate(_done):
            if d.get("uid") == uid:
                _done.pop(i)
                return jsonify({"ok": True, "removed": d.get("label")})
    return jsonify({"ok": False, "error": "未找到该历史项"})


@bp.route("/queue/state")
def q_state():
    with _lock:
        return jsonify({
            "ok": True,
            "running": _running[0],
            "current": _current[0],
            "current_t0": _cur_t0[0],               # 当前项开始时刻 — 配合 now 算实时已耗时
            "now": time.time(),
            "loop": {"cycle": _plan["cycle"], "total": _plan["total"],
                     "left": max(0, _plan["total"] - _plan["cycle"])
                     if _plan["total"] else -1},      # total=0 → left=-1(∞)
            "pending": [{"uid": it["uid"], "side": it["side"], "label": it["label"]}
                        for it in _items],
            "done": _done[-30:],
        })


@bp.route("/queue/log")
def q_log():
    """读运行日志(config/run_log.jsonl, 持久化重启不丢)。?limit=N 默认200 上限1000,
    返回旧→新时间序的事件数组(坏行跳过)。"""
    try:
        limit = max(1, min(1000, int(request.args.get("limit", 200))))
    except (TypeError, ValueError):
        limit = 200
    with _rlog_lock:
        try:
            with open(_RLOG_FILE) as f:
                lines = f.read().splitlines()
        except Exception:
            lines = []
    evs = []
    for l in lines[-limit:]:
        try:
            evs.append(json.loads(l))
        except Exception:
            pass
    return jsonify({"ok": True, "events": evs, "file": _RLOG_FILE})


@bp.route("/queue/timing")
def q_timing():
    """读计时日志(config/run_timing.jsonl)。?limit=N 默认300 上限2000(旧→新);
    ?pretty=1 → 人读文本(运行头/每轮 墙钟=步和+开销/逐步明细/摘要, text/plain);
    ?excel=1 → 下载 .xlsx(3 表: 逐步明细/每轮汇总/运行摘要, 导出默认全量)。"""
    want_excel = bool(request.args.get("excel"))
    try:
        limit = max(1, min(2000, int(request.args.get("limit",
                                                      2000 if want_excel else 300))))
    except (TypeError, ValueError):
        limit = 2000 if want_excel else 300
    with _rlog_lock:
        try:
            with open(_TIMING_FILE) as f:
                lines = f.read().splitlines()
        except Exception:
            lines = []
    evs = []
    for l in lines[-limit:]:
        try:
            evs.append(json.loads(l))
        except Exception:
            pass
    if want_excel:
        try:
            data = _timing_xlsx(evs)
        except Exception as e:
            return jsonify({"ok": False, "error": "生成 Excel 失败: %s" % e}), 500
        fname = time.strftime("run_timing_%Y%m%d_%H%M%S.xlsx", time.localtime())
        return Response(data, mimetype="application/vnd.openxmlformats-"
                        "officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": "attachment; filename=%s" % fname})
    if request.args.get("pretty"):
        return _timing_pretty(evs), 200, {"Content-Type": "text/plain; charset=utf-8"}
    return jsonify({"ok": True, "events": evs, "file": _TIMING_FILE})


def snapshot_pending():
    """待执行项全量快照(含 kind/params, 不含 uid) — /run 运行页「⑮保存」用。
    /queue/state 的 pending 只有 uid/side/label, 拿全量必须走这里。调用方不持锁。"""
    with _lock:
        return [{"side": it["side"], "kind": it["kind"], "label": it["label"],
                 "params": json.loads(json.dumps(it.get("params") or {}))} for it in _items]


def running():
    """/run 运行页守卫用 — 锁内读运行标志(外部模块不碰 _lock)。"""
    with _lock:
        return _running[0]


# ---------------- 队列预设 (存共用队列, 含左/右标记) ----------------

_PRESET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "config", "queue_presets.json")


def _load_presets():
    try:
        with open(_PRESET_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_presets(d):
    os.makedirs(os.path.dirname(_PRESET_FILE), exist_ok=True)
    tmp = _PRESET_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _PRESET_FILE)


def _valid_item(it):
    return isinstance(it, dict) and it.get("side") in PORT and it.get("kind") in Q_KINDS


@bp.route("/queue/presets")
def q_presets():
    ps = _load_presets()
    return jsonify({"ok": True, "presets": [
        {"name": n, "count": len(v),
         "sides": sorted({it.get("side") for it in v if _valid_item(it)})}
        for n, v in ps.items()]})


@bp.route("/queue/presets/save", methods=["POST"])
def q_preset_save():
    """把当前未执行的队列项(含左右标记)存为预设, 同名覆盖。"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "需要 name"})
    with _lock:
        items = [{"side": it["side"], "kind": it["kind"], "label": it["label"],
                  "params": it.get("params") or {}} for it in _items]
    if not items:
        return jsonify({"ok": False, "error": "队列为空, 没有可保存的项"})
    ps = _load_presets()
    ps[name] = items
    try:
        _save_presets(ps)
    except Exception as e:
        return jsonify({"ok": False, "error": "写文件失败: %s" % e})
    _log("队列预设已保存: %s(%d 项)" % (name, len(items)))
    return jsonify({"ok": True, "count": len(items)})


@bp.route("/queue/presets/load", methods=["POST"])
def q_preset_load():
    """载入预设。默认替换当前未执行队列; body {append:true} = 追加到队尾
    (可拼接多个预设一起跑, 执行中也允许 — 等同批量热追加)。重新编 uid。"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    append = bool(data.get("append"))
    ps = _load_presets()
    if name not in ps:
        return jsonify({"ok": False, "error": "预设不存在: %s" % name})
    items = [it for it in ps[name] if _valid_item(it)]
    if not items:
        return jsonify({"ok": False, "error": "预设里没有有效项"})
    with _lock:
        if _running[0] and not append:
            return jsonify({"ok": False, "error": "执行中不能整体载入(可先停止, 或用 ＋追加)"}), 400
        if not append:
            _items.clear()
        for it in items:
            _items.append({"uid": _uid[0], **it})
            _uid[0] += 1
        n = len(_items)
    _log("预设%s: %s(%d 项, 队列现 %d 项)" % ("追加" if append else "载入", name, len(items), n))
    return jsonify({"ok": True, "appended": len(items), "pending": n})


@bp.route("/queue/presets/delete", methods=["POST"])
def q_preset_delete():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    ps = _load_presets()
    if name not in ps:
        return jsonify({"ok": False, "error": "预设不存在: %s" % name})
    del ps[name]
    try:
        _save_presets(ps)
    except Exception as e:
        return jsonify({"ok": False, "error": "写文件失败: %s" % e})
    return jsonify({"ok": True})
