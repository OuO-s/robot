# robot — 卫龙/双臂项目 网页代码备份

> 备份来源：Jetson 主控机 `/home/tianlian/`，首次备份 2026-10-12。
> 只备份**我们自己写的网页/服务代码**；数据集、YOLO 权重、厂商 SDK 等大文件不在此仓库，
> 见 [NOT_BACKED_UP.md](NOT_BACKED_UP.md)。

## 目录 ↔ 机器路径对照

| 仓库目录 | 机器上的位置 | 是什么 |
|---|---|---|
| `pbvs_debug_web/` | `/home/tianlian/PBVS代码包/debug_web/` | **调试台 :7010**（systemd `pbvs-debug-web`）：双臂点动/示教/抓取队列/⑩⑪⑫⑬⑭⑮各卡片/`/run` 整流程循环运行页/`/duo` 双臂并行运行页（按臂分道真并行，中区互斥）/一键恢复。核心文件 `server.py` + `static/`（前端 app.js/run.js/duo.js/viewer3d.js）+ `queue_hub.py`（串行队列协调）+ `duo_hub.py`（双臂并行）+ `runpage.py` + `pose_cache.py` + `recover.py` |
| `pbvs_debug_web/label_web/` | 同上 `label_web/` | 采集标注网页 :7030（systemd `pbvs-label-web`），collect_wrist YOLO-pose 标注用 |
| `weilong_anno_tools/` | `/home/tianlian/weilong/anno/` | 标注工具网页：`box_anno_tool.py` :8765（箱内多捆）、`anno_tool.py`/`pose_anno_tool.py`（单袋分割/姿态）+ 各 `*_ui.html` + 标注状态 json/pkl |
| `weilong_box_detect/` | `/home/tianlian/weilong/box_detect_service.py` | 视觉检测旁路服务 :7020（systemd `weilong-box-detect`，GPU）：调试台 ⑪⑫⑭ 的模型推理后端 |
| `dataset_vis_pages/` | `/home/tianlian/weilong/dataset_seg{,_pose}_vis/index.html` | 标注结果可视化页（**只有 index.html，图片未备份**，可由数据集重新生成） |
| `systemd_units/` | `/etc/systemd/system/` | 上述服务的 unit 文件副本（pbvs-debug-web.service 在 `pbvs_debug_web/` 内也有一份） |

`pbvs_debug_web/static/` 里的 `vendor/`（three.js + urdf-loader）和 `robot/`（URDF + STL 网格，
约 19M）是 3D 预览的依赖资产（来自厂商），一并打包，保证拷走即可运行。
`config/` 里的 `queue_presets.json`、`run_page.json`（/run 页）、`duo_page.json`（/duo 页）
是保存的队列预设/运行页配置；运行日志 `run_log.jsonl`、`run_timing.jsonl` 不备份。

## 恢复方法

```bash
# 1. 拷回机器（路径、目录名必须一致，systemd unit 里写死了）
rsync -a pbvs_debug_web/ "/home/tianlian/PBVS代码包/debug_web/"
rsync -a weilong_anno_tools/ /home/tianlian/weilong/anno/
rsync -a weilong_box_detect/box_detect_service.py /home/tianlian/weilong/
# 2. unit 文件装回并重启
sudo cp systemd_units/*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart pbvs-debug-web weilong-box-detect
```

注意：调试台依赖同机的 PBVS 后端（:7004/:7005）、臂驱动 HTTP（:8000）、相机 WS 流
（Win 采集电脑 192.168.2.200:8766）和 GPU 检测服务（:7020），单独恢复网页只能看不能控。

## 更新备份

```bash
cd /home/tianlian/robot
rsync -a --exclude='__pycache__' --exclude='*.pyc' --exclude='logs/' \
      --exclude='config/*.jsonl' --exclude='config/*.bak*' \
      "/home/tianlian/PBVS代码包/debug_web/" pbvs_debug_web/
rsync -a --exclude='__pycache__' --exclude='.anno_thumbs*' /home/tianlian/weilong/anno/ weilong_anno_tools/
cp /home/tianlian/weilong/box_detect_service.py weilong_box_detect/
cp /home/tianlian/weilong/dataset_seg_vis/index.html dataset_vis_pages/dataset_seg_vis.index.html
cp /home/tianlian/weilong/dataset_seg_pose_vis/index.html dataset_vis_pages/dataset_seg_pose_vis.index.html
git add -A && git commit -m "备份更新 $(date +%F)" && git push
```
