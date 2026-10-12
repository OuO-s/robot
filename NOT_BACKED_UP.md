# 未备份内容清单

> 本仓库只备份网页/服务代码。以下是**有意不备份**的内容、大小和原因。
> 机器：Jetson 主控 `/home/tianlian/`。首次整理：2026-10-12。

## 一、weilong/（YOLO 数据与训练，约 550M+）

| 内容 | 大小 | 说明 |
|---|---|---|
| `dataset_seg/` | 308M | 原始采集图片 + **手动标注**（labelme json / YOLO txt 与图片同目录）。人工劳动成果，删了无法重算；需要时单独拷盘备份 |
| `runs/` | 67M | 训练输出。生产模型 `runs/weilong11n/weights/best.pt`（另有 box/pose/wrist 各 run） |
| `weights/` | 36M | 底模 + 长期使用的权重（yolo11n-seg.pt、yolo26n.pt 等） |
| `scratch/` | 91M | 可重算的中间产物（crops/sheets/cls） |
| `collect_wrist/`、`train_pack_wrist/`(+tar.gz) | 34M | 腕相机数据采集与训练打包；tar.gz 已另传训练服务器 152 |
| `yolo/`、`yolo_box/` 等 | ~10M | 划分工程（images 是 symlink）+ `weilong.yaml` |
| `logs/` | 3.3M | 服务日志 |
| 根目录脚本 | <1M | `infer_weilong*.py`、`train_yolo11*.py`、`make_split*.py` 等——是我们写的，但依赖本机数据/venv，未入本仓库；文件很小，需要可随时补 |

## 二、PBVS代码包/（PBVS 主程序，~285M）

| 内容 | 大小 | 说明 |
|---|---|---|
| `PBVS/` | 11M | **PBVS 视觉伺服主程序**：厂商原始代码 + 我们的大量修改（`core/ws_camera.py` WS相机客户端、fd_bridge 6D IK、`suction_bag.py`/`suction_pick.py`/`hover_above.py` 吸取链等）。⚠️ 内含**标定/示教成果 JSON**（全部 <100KB）：`eye_in_hand_Left_Arm.json`（手眼标定）、`tool_frame_{L,R}_Arm.json`（TCP 标定）、`teach_points_*.json`（示教点）、`suct_adj/suck_ref/hover_ref/pick_ref`（分袋偏移与吸取参考）、`speed_*.json`——这些是数周实机标定的结果，机器损坏即丢失，**建议将来单独打包**。另有 9M gui_backup zip |
| `Ti5_SDK/` | 273M | 厂商 SDK（可向厂商再要） |
| `cartesian/`、`common/`、`xbox控制/` | <1M | 厂商示例/公共库 |
| 根目录 | <1M | `交接文档.md`、`使用说明.md`、`启动.sh` |

调试台 `debug_web/` 与其 `label_web/` 已备份（见 README）；`debug_web` 只备份了代码与 `config/*.json`，运行日志 `run_log.jsonl`/`run_timing.jsonl` 未备份。

## 三、其他

| 内容 | 大小 | 说明 |
|---|---|---|
| `archive/` | 310M | 一次性归档（调试图、旧日志、旧 runs、`D435_SDK_v2.58.4_Windows.zip`）——按约定可随时删除 |
| `yolo11_env/` | 6.2G | Python venv（torch sm_87 等），不可迁移，崩了需重装 |
| `docs/` | 148K | 故障报告、`ws_depth_query/`（WS 深度查询协议规格+部署文档）、`右放复刻包_20261012` |
| systemd unit | — | 已收副本在 `systemd_units/`；实机以 `/etc/systemd/system/` 为准 |

## 四、不在本机的东西（另需单独备份）

1. **Win 采集电脑 192.168.2.200**：`camera-check/`（`realsense_server.py`，WS 相机服务端 :8766 + 深度查询），双 D435 直插那台机器。协议与部署说明在本机 `docs/ws_depth_query/`，**服务端代码本身未备份**。
2. **训练服务器 192.168.10.152**（SSH 端口 2189）：`/home/storage/weilong`（train_pack_wrist 等）。
3. GitHub 本仓库 `OuO-s/robot` 之外的任何远端副本。
