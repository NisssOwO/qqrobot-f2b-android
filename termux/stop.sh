#!/bin/bash
# QQ聊天机器人 · Termux 停止脚本
set -u
say() { printf '\033[1;36m[qqrobot]\033[0m %s\n' "$*"; }
export UDOCKER_USE_PROOT_EXECUTABLE="${PREFIX:-}/bin/proot"
export UDOCKER_USE_CURL_EXECUTABLE="${PREFIX:-}/bin/curl"
export UDOCKER_DIR="$HOME/.udocker"

say "停止容器…"
# udocker ps 的输出形如:
#   3c15eb16-3293-37e5-bc98-5464701dc95e . W ['qqrobot'] qqrobot:0.2.0
# 按 ID 删除（--name 生成的容器按名字删未必生效）
for cid in $(udocker ps 2>/dev/null | awk '/qqrobot/{print $1}'); do
  udocker rm -f "$cid" >/dev/null 2>&1 && say "  已移除容器 $cid"
done

# 兜底：udocker rm 有时只摘掉仓库记录，容器内进程仍在
sleep 1
for pat in 'Napcat/opt/QQ/qq' 'server.mjs' 'network-guard.cjs' 'service.mjs' 'Xvfb :97'; do
  if pgrep -f "$pat" >/dev/null 2>&1; then
    pkill -TERM -f "$pat" 2>/dev/null
    say "  终止进程: $pat"
  fi
done
sleep 2
for pat in 'Napcat/opt/QQ/qq' 'server.mjs' 'network-guard.cjs' 'Xvfb :97'; do
  pkill -KILL -f "$pat" 2>/dev/null
done
say "已停止"