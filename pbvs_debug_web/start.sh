#!/bin/bash
# PBVS 调试台手动启动(与 systemd 单元二选一;需以 user 身份运行,flask 在 ~/.local)
#   sudo -u user bash /home/tianlian/PBVS代码包/debug_web/start.sh
cd "$(dirname "$0")" || exit 1
mkdir -p logs
if pgrep -f "python3 server.py" >/dev/null 2>&1; then
  echo "已在运行:"; pgrep -af "python3 server.py"; exit 0
fi
nohup /usr/bin/python3 server.py > logs/debug_web.log 2>&1 &
sleep 1
echo "已启动 pid $(pgrep -f 'python3 server.py' | head -1)  →  http://0.0.0.0:7010/"
tail -n 5 logs/debug_web.log
