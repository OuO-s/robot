#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键恢复 (总电源重启后) — POST /api/recover, 进度 GET /api/recover/progress
================================================================
2026-09-30 四次实机演练定型的恢复链(详见 PBVS文档.md「总电源重启恢复流程」):

  0) 相机 USB 抢救    —— 任一 D435 不在 USB(-71) → sudo xhci-reset 复位 + 等上树
  1) 重启 tl_driver   —— tl_driver 只在节点启动时建 TCP, 总电源重启后永不重连
  2) 双臂上电         —— 断电后 servo 掉电, 此时 move_robotarm 会「假成功」不动
  3) 夹爪诊断         —— Inspire「内部通讯故障」软件清不掉, 只能再断总电 → 如实上报
  4) PBVS/相机自愈    —— 实例掉线则重启(仅 Jetson 重启才会), 相机未连则自动连
  5) move=true: 回放取料示教点(断电抱闸不锁、臂会垮, 先回位) → PBVS 对准收敛

⚠ 步骤 0 必须在 1 之前: xHCI 复位会连带重置 AX88179 USB 网卡(eth0→br-lan→
192.168.2.x 臂控制器), 双臂 TCP 会话必断(2026-10-10 实战: 复位后 ~1min 臂楔死),
靠紧随的驱动重启一并修复。sudo 白名单见 /etc/sudoers.d/xhci-reset-user(仅放行
/usr/local/bin/xhci-reset.sh 一个脚本, 勿放宽)。

本服务以 user 身份跑(systemd), 与 tl_driver / app_fd 同用户, 有权直接重启它们。
恢复全程有 _state 快照, 前端 1s 轮询 progress 展示步骤日志。

⚠⚠ 2026-10-04 排查出的头号地雷(当日两起"恢复刚成功、几分钟后又失联"均因此):
本模块 setsid 拉起的 tl_driver / app_fd 仍留在 pbvs-debug-web 的 systemd cgroup 里,
而单位默认 KillMode=control-group —— 任何一次 systemctl restart/stop pbvs-debug-web
都会把它们连带 SIGTERM 杀死。已加 drop-in /etc/systemd/system/pbvs-debug-web.service.d/
killmode.conf (KillMode=process) 修复, **勿删**; 若迁移服务需一并带走。
"""

import json
import os
import socket
import subprocess
import threading
import time
import urllib.request

from flask import Blueprint, jsonify, request

bp = Blueprint("recover", __name__)

ROOT = os.path.dirname(os.path.abspath(__file__))
CONF_DIR = os.path.join(ROOT, "config")
SAVED_PARAMS = os.path.join(CONF_DIR, "launch_params_saved.yaml")

TL_BIN = "/home/user/fd_ws/install/tl_driver/lib/tl_driver/tl_driver_node"
TL_CFG_DIR = "/home/user/fd_ws/install/tl_driver/share/tl_driver/config/"
TL_CFG = ["arm_config.yaml", "end_effector_config.yaml", "sensor_6d_config.yaml"]
TL_LOG = "/tmp/tl_driver_recover.log"

SIDES = {"left": 7004, "right": 7005}
ARM_NAME = {"left": "Left_Arm", "right": "Right_Arm"}
RECOVER_POSE = {"left": "左臂取new", "right": "右臂取"}  # 断电垮臂后回放的取料示教点(teach_points_*.json 里改名需同步改这里)
CTRL_IPS = ("192.168.2.13", "192.168.2.14")
ARM_HTTP = "http://127.0.0.1:8000"

SOURCE_ENV = ("source /opt/ros/humble/setup.bash && "
              "source /home/user/fd_ws/install/setup.bash && "
              "export ROS_DOMAIN_ID=25 HOME=/home/user && ")

_state = {"running": False, "t0": 0, "steps": [], "final": None}
_lock = threading.Lock()


# ---------------------------------------------------------------- 基础工具

def _log(ok, msg):
    """记一步: ok=True/False/None(信息), msg 一行文字"""
    mark = "✓" if ok is True else ("✗" if ok is False else "•")
    line = "%s %s" % (mark, msg)
    _state["steps"].append(line)
    print("[recover] " + line, flush=True)


def _run(cmd, timeout=30):
    """shell 命令 → (rc, stdout+stderr); 超时 rc=-1。
    必须显式用 bash: shell=True 默认 /bin/sh=dash, `source` 会直接报 not found
    (首版实测: 整条恢复链静默失败, tl_driver 没拉起来)。"""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout,
                           executable="/bin/bash")
        out = (r.stdout + b"\n" + r.stderr).decode("utf-8", "replace").strip()
        return r.returncode, out
    except subprocess.TimeoutExpired:
        return -1, "超时(%ds): %s" % (timeout, cmd[:80])


def _post(url, body, timeout=15):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"success": False, "message": str(e)}


def _get(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


# ---------------------------------------------------------------- 0) 相机 USB 抢救

def _rs_count():
    """USB 上 RealSense D435 台数(左右臂相机, 正常 2)"""
    rc, out = _run("lsusb", timeout=8)
    return sum(1 for ln in (out or "").splitlines() if "8086:0b07" in ln)


def _camera_usb_rescue():
    """任一 D435 不在 USB 上(重启后 error -71 不上树) → xHCI 控制器复位 + 等上树。
    2026-10-09/10 实战: -71 后复位有时几秒回、有时要等几分钟、偶尔须物理重插 —
    等不到不阻塞臂恢复(返回 False 照走后续链), 相机留给第 4 步自愈/人工重插。
    2026-10-11: ×0(两台全无)=相机被整体取下属预期 — 不复位不等待直接放行。复位
    救不回不在场的相机, 反而连带断臂会话(当日"上电假成功"事故根因), 还白等 120s。
    真·整树死(相机明明装着却 ×0)时: 人工跑 sudo xhci-reset 后重点一次恢复。"""
    n = _rs_count()
    if n >= 2:
        _log(True, "相机 USB 正常(RealSense ×%d)" % n)
        return True
    if n == 0:
        _log(False, "RealSense ×0/2 — 相机未装(已整体取下?)属预期, 跳过 USB 抢救"
                    "直接继续臂恢复; 若相机明明装着(整树死): sudo /usr/local/bin/"
                    "xhci-reset.sh 后重点一次恢复")
        return False
    _log(False, "RealSense 仅 %d/2 在 USB 上(error -71?) — 复位 xHCI 控制器" % n)
    rc, out = _run("sudo -n /usr/local/bin/xhci-reset.sh", timeout=30)
    if rc != 0:
        _log(False, "xHCI 复位失败(%s) — 人工做: sudo /usr/local/bin/xhci-reset.sh,"
                    " 或重插相机 USB 线(换口别插原位); 臂恢复继续" % out[:80])
        return False
    for waited in range(5, 126, 5):
        time.sleep(5)
        n = _rs_count()
        if n >= 2:
            _log(True, "相机已上 USB(等 %ds, RealSense ×2); 臂会话被复位连带断开,"
                       " 驱动重启随后修复" % waited)
            return True
        if waited % 30 == 0:
            _log(None, "等待相机重新枚举… %ds(RealSense ×%d)" % (waited, n))
    _log(False, "120s 后仍 ×%d/2 — 相机线需现场重插(换口别插原位), 插好等 1~2 分钟"
                "再点一次恢复; 臂恢复继续不受影响" % n)
    return False


# ---------------------------------------------------------------- 1) tl_driver

def _tcp_per_ip():
    """每台控制器的 ESTAB 连接数(正常各 2: 6001+7000)"""
    rc, out = _run("ss -tn state established", timeout=8)
    if rc != 0:
        return {ip: 0 for ip in CTRL_IPS}
    return {ip: sum(1 for ln in out.splitlines() if ip in ln) for ip in CTRL_IPS}


def _tcp_count():
    """到两台控制器的 ESTAB 连接数(正常 4: 6001+7000 × 左右)"""
    return sum(_tcp_per_ip().values())


def _ctrl_probe(ip):
    """单台控制器体检: ping + 状态口 7000 → (ping通, 服务在监听)。
    2026-10-04 实战: 右臂控制器 ping 通/SSH 通但端口拒接 = 控制器上控制服务
    没监听, Jetson 侧无解, 只能现场断电重启该控制器。
    ⚠ 只探 7000: 6001 控制口有连接频率限制(驱动在线时连测两次就 RST 拒接、
    等 ~8s 才放行, 实测)——探它既误报又可能干扰驱动会话; 7000 服务在则永远接受。"""
    ping_ok = (_run("ping -c1 -W1 %s >/dev/null 2>&1" % ip, timeout=4)[0] == 0)
    alive = False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.5)
    try:
        s.connect((ip, 7000))
        alive = True
    except OSError:
        pass
    finally:
        s.close()
    return ping_ok, alive


def _ctrl_diagnose():
    """逐台诊断并给出可执行的下一步 → 拼成一行日志"""
    msgs = []
    for name, ip in (("左臂控制器", CTRL_IPS[0]), ("右臂控制器", CTRL_IPS[1])):
        ping_ok, alive = _ctrl_probe(ip)
        if not ping_ok:
            msgs.append("%s(%s) ping 不通 → 查总电源/网线/该控制器供电" % (name, ip))
        elif not alive:
            msgs.append("%s(%s) 网络在线但状态口 7000 拒接 → 控制器服务未监听, "
                        "现场断电重启该控制器, 指示灯稳定后再点一次恢复" % (name, ip))
        else:
            msgs.append("%s(%s) 在线且监听正常(驱动侧问题, 直接再点一次恢复即可)" % (name, ip))
    return "; ".join(msgs)


def _mem_warn():
    """内存余量预检: 2026-10-04 实锤 OOM 在恢复过程中随机杀进程(tl_driver/debug-web 连环崩)"""
    rc, out = _run("free -m | awk '/^Mem:/{print $7}'", timeout=5)
    try:
        avail = int(out.split()[0])
    except Exception:
        return
    if avail < 800:
        _log(None, "⚠ 内存可用仅 %dMB(<800MB), OOM 可能随机杀进程破坏恢复 — "
                   "建议先停 YOLO 训练/推理等大进程(free -h 排查)再点恢复" % avail)


def _tl_params_file():
    """取 tl_driver 的 launch 参数文件 —— 必须是本机器人(y4_ft_705vh 双臂)这份。
    选择顺序: ①运行中进程 cmdline 里的(指纹校验过) ②config/ 快照 ③/tmp 里带正确指纹的任一份。
    ⚠ 不能按时间盲扫 /tmp: 实测 /tmp 里混着 30 份 launch_params_*(含 w2 等其他机器人
    配置, 30KB urdf.xacro), 盲选到 w2 → tl_driver 启动即崩(URDF 不存在)。"""
    def _good(path):
        try:
            with open(path, "r", errors="replace") as f:
                c = f.read()
            return ("arm_mode: dual" in c) and ("y4_ft_705vh" in c)
        except Exception:
            return False

    rc, out = _run("pgrep -f '^%s'" % TL_BIN, timeout=8)
    if rc == 0:
        for pid in out.split():
            try:
                with open("/proc/%s/cmdline" % pid, "rb") as f:
                    args = f.read().decode().split("\0")
                for a in args:
                    if "launch_params_" in a and _good(a):
                        _snapshot_params(a)
                        return a, None
            except Exception:
                pass
    if _good(SAVED_PARAMS):
        return SAVED_PARAMS, "用快照 %s" % os.path.basename(SAVED_PARAMS)
    import glob
    for p in sorted(glob.glob("/tmp/launch_params_*")):
        if _good(p):
            _snapshot_params(p)
            return p, None
    return None, "找不到 y4_ft_705vh 双臂的 launch_params(快照与 /tmp 均无有效文件)"


def _snapshot_params(src):
    """把 /tmp 的 launch 参数快照到 config/(原子替换), Jetson 重启后兜底"""
    try:
        os.makedirs(CONF_DIR, exist_ok=True)
        tmp = SAVED_PARAMS + ".tmp"
        with open(src, "rb") as f, open(tmp, "wb") as g:
            g.write(f.read())
        os.replace(tmp, SAVED_PARAMS)
    except Exception:
        pass


def _tl_restart():
    """杀掉 tl_driver 并用原 argv 拉起, 等到 4 条 TCP"""
    params, note = _tl_params_file()
    if params is None:
        _log(False, "tl_driver 参数文件缺失, 无法重启: %s" % note)
        return False
    _run("pkill -f '^%s'" % TL_BIN, timeout=8)
    time.sleep(1.5)
    cmd = ("%s setsid %s --ros-args -r __node:=tl_driver %s > %s 2>&1 < /dev/null &"
           % (SOURCE_ENV, TL_BIN,
              " ".join("--params-file " + TL_CFG_DIR + c for c in TL_CFG) +
              " --params-file " + params,
              TL_LOG))
    rc, out = _run(cmd, timeout=15)
    waited = 0
    while waited < 90:  # 控制器上电启动需一段时间, 刚开总电源时这里会等
        time.sleep(3)
        waited += 3
        per = _tcp_per_ip()
        n = sum(per.values())
        if n >= 4:
            _log(True, "tl_driver 已重启, TCP×%d(左右控制器各 6001+7000)%s" % (n, " " + note if note else ""))
            return True
        if waited % 15 == 0:
            _log(None, "等待控制器上线… %ds(左×%d 右×%d, 各应为2)" % (waited, per[CTRL_IPS[0]], per[CTRL_IPS[1]]))
    _log(False, "90s 内 TCP 未到 4 条(现在 %d): %s" % (_tcp_count(), _ctrl_diagnose()))
    return False


# ---------------------------------------------------------------- 2)~4) 上电/夹爪/PBVS

def _arms_power():
    ok_all = True
    for arm, key in (("左", "armleft"), ("右", "armright")):
        r = None
        for attempt in range(3):
            r = _post(ARM_HTTP + "/initialize_robotarm", {"robot_name": key}, timeout=25)
            if r.get("success"):
                break
            time.sleep(2.5)
        good = bool(r.get("success"))
        ok_all = ok_all and good
        _log(good, "%s臂上电 initialize_robotarm: %s" % (arm, r.get("message", r)))
    return ok_all


def _gripper_diag():
    rc, out = _run(SOURCE_ENV + "timeout 6 ros2 topic echo --once /fd_robot/manipulator/gripper_status",
                   timeout=15)
    if rc != 0 or "jaw" not in out:
        _log(None, "夹爪诊断读取失败(不影响后续步骤)")
        return {}
    diag = {}
    cur = None
    for ln in out.splitlines():
        if "name:" in ln and "jaw" in ln:
            cur = ln.split("name:")[1].strip().replace("_jaw", "")
        elif "message:" in ln and cur:
            diag[cur] = ln.split("message:")[1].strip().strip("'\"")
            cur = None
    for side, msg in diag.items():
        if "内部通讯故障" in msg:
            _log(False, "%s夹爪: %s —— 软件清不掉, 请等臂停稳后再断一次总电源, 然后再点恢复" % (side, msg))
        elif msg == "正常":
            _log(True, "%s夹爪: 正常" % side)
        else:
            _log(None, "%s夹爪: %s" % (side, msg))
    return diag


def _pbvs_selfheal():
    """PBVS 实例掉线 → 重启; 相机未连 → 连接。总电源重启不影响它们(Jetson 不重启), 属兜底。"""
    all_ok = True
    for side, port in SIDES.items():
        st = _get("http://127.0.0.1:%d/pbvs/api/status" % port, timeout=4)
        if st is None:
            all_ok = False
            cmd = ("%s cd '%s' && PBVS_SIDE=%s setsid python3 app_fd.py "
                   "> /tmp/pbvs_%s.log 2>&1 < /dev/null &"
                   % (SOURCE_ENV, os.path.join(ROOT, "..", "PBVS"), side, side))
            _run(cmd, timeout=15)
            for _ in range(20):
                time.sleep(1)
                st = _get("http://127.0.0.1:%d/pbvs/api/status" % port, timeout=4)
                if st is not None:
                    break
            if st is None:
                _log(False, "%s PBVS 实例重启失败(看 /tmp/pbvs_%s.log)" % (side, side))
                continue
            _log(True, "%s PBVS 实例已自动重启(:%d)" % (side, port))
        cam = st.get("camera", {})
        if not cam.get("running"):
            r = _post("http://127.0.0.1:%d/pbvs/api/camera/connect" % port, {}, timeout=40)
            good = bool(r.get("ok"))
            all_ok = all_ok and good
            _log(good, "%s 相机连接: %s" % (side, r.get("camera") or r.get("error")))
        if not st.get("aligner", {}).get("has_target"):
            all_ok = False
            _log(False, "%s 无对准目标(reference 文件未加载?), 需重新示教" % side)
    return all_ok


# ---------------------------------------------------------------- 5) 回位 + 对准

def _teach_and_align(side):
    port = SIDES[side]
    name = RECOVER_POSE[side]
    pts = _get("http://127.0.0.1:%d/pbvs/api/teach/points" % port, timeout=5) or {}
    have = any(p.get("name") == name for p in (pts.get("points") or []))
    if have:
        r = None
        for attempt in range(2):  # 断电后第一次下发偶发瞬时失败, 重试一次
            r = _post("http://127.0.0.1:%d/pbvs/api/teach/goto" % port, {"name": name}, timeout=45)
            if r.get("ok"):
                break
            time.sleep(3)
        if r.get("ok"):
            _log(True, "%s臂回放取料位「%s」" % (side, name))
        else:
            _log(False, "%s臂回放失败: %s(继续尝试对准)" % (side, r.get("error")))
    else:
        _log(None, "%s臂无取料示教点「%s」, 跳过回放" % (side, name))

    r = _post("http://127.0.0.1:%d/pbvs/api/align/start" % port, {}, timeout=10)
    if not r.get("ok"):
        _log(False, "%s臂对准启动失败: %s" % (side, r.get("error")))
        return None
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(3)
        st = _get("http://127.0.0.1:%d/pbvs/api/status" % port, timeout=4)
        if st is None:
            continue
        al = st.get("aligner", {})
        if al.get("is_running"):
            continue
        # ⚠ aligner 静止态误差是 0.0/0.0 而非 None(与抓取门禁同坑):
        # measured_count<1 = 一次测量都没做成(跟踪丢失中止), 0.0 是初值, 不是收敛
        # (measured_count 含"首测即收敛"那次; 旧版 PBVS 无此字段则退回 iteration_count)
        if (al.get("measured_count", al.get("iteration_count")) or 0) < 1:
            _log(False, "%s臂对准未测到QR(跟踪丢失) — 相机画面里没有二维码? "
                        "摆好QR后再点一次恢复(或用页面对准)" % side)
            return None
        xy = (al.get("current_error_xy_m") or 0) * 1000
        z = (al.get("current_error_z_m") or 0) * 1000
        last = [l for l in al.get("log", []) if "收敛" in l or "对准完成" in l or "对准结束" in l]
        good = xy < 3.0 and abs(z) < 3.0
        _log(good, "%s臂对准结束: XY=%.1fmm Z=%.1fmm %s" % (side, xy, z, last[-1] if last else ""))
        return {"xy": round(xy, 1), "z": round(z, 1)}
    _log(False, "%s臂对准 120s 未结束(可在页面手动接管)" % side)
    return None


# ---------------------------------------------------------------- 主流程

def run_recovery(move):
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, t0=time.time(), steps=[], final=None)
    try:
        _log(None, "===== 一键恢复开始(move=%s) %s =====" % (move, time.strftime("%H:%M:%S")))
        _mem_warn()
        st = _get("http://127.0.0.1:%d/pbvs/api/status" % SIDES["left"], timeout=4)
        if st and st.get("aligner", {}).get("is_running"):
            _log(False, "左臂对准循环运行中, 先停止再恢复")
            _state["final"] = {"ok": False}
            return
        _camera_usb_rescue()  # 0) 相机不在 USB 才复位 xHCI; 连带断臂会话, 故必在驱动重启前
        ok_tl = _tl_restart()
        if not ok_tl:
            _state["final"] = {"ok": False}
            return
        _arms_power()
        grippers = _gripper_diag()
        _pbvs_selfheal()
        align = {}
        if move:
            for side in SIDES:
                align[side] = _teach_and_align(side)
        ok = (not move) or all(v and v["xy"] < 3.0 for v in align.values() if v) and len(align) == len(SIDES)
        gripper_bad = any("内部通讯故障" in (m or "") for m in grippers.values())
        _state["final"] = {"ok": bool(ok), "align": align,
                           "gripper_fault": gripper_bad,
                           "elapsed_s": round(time.time() - _state["t0"], 1)}
        _log(bool(ok), "===== 恢复完成(%s) =====" % ("成功" if ok else "有失败步骤, 看上方日志"))
        if gripper_bad:
            _log(False, "夹爪内部通讯故障未消除: 等臂停稳 → 再断一次总电源 → 再点本按钮")
    except Exception as e:
        _log(False, "恢复异常中断: %r" % e)
        _state["final"] = {"ok": False, "error": str(e)}
    finally:
        _state["running"] = False


@bp.route("/recover", methods=["POST"])
def recover():
    if _state["running"]:
        return jsonify({"ok": False, "error": "恢复已在进行中"}), 409
    body = request.get_json(silent=True) or {}
    move = bool(body.get("move", True))
    threading.Thread(target=run_recovery, args=(move,), daemon=True).start()
    return jsonify({"ok": True, "started": True, "move": move})


@bp.route("/recover/progress")
def progress():
    return jsonify(_state)
