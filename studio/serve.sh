#!/usr/bin/env sh
# 小部件设计工具 · 本地服务器（Mac/Linux；Windows 用 serve.cmd）
# 必须用服务器打开：file:// 下创建不了 worker。
# 用法：./serve.sh [端口] [App 仓库路径]
#                        ↑ 给了 App 仓库就直读它的 res/ 与组件库，否则用主题快照。
PORT="${1:-8611}"
APP="$2"
if [ -n "$APP" ]; then
  exec python3 "$(dirname "$0")/serve.py" "$PORT" --app "$APP"
fi
exec python3 "$(dirname "$0")/serve.py" "$PORT"
