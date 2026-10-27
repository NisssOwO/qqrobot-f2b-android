#!/bin/bash
# QQ聊天机器人 · Termux 停止脚本
set -u
say() { printf '\033[1;36m[qqrobot]\033[0m %s\n' "$*"; }
say "停止容器…"
udocker ps 2>/dev/null | grep -q qqrobot-run && udocker rm -f qqrobot-run 2>/dev/null
# udocker rm 在某些版本的 -f 不生效，兜底清理容器内进程
pkill -f 'Napcat/opt/QQ/qq' 2>/dev/null
pkill -f 'qqrobot-app/service.mjs' 2>/dev/null
pkill -f 'qqrobot-app/src' 2>/dev/null
pkill -f 'Xvfb :97' 2>/dev/null
say "已停止"