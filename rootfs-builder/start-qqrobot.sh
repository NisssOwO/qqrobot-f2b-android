#!/bin/bash
# QQ聊天机器人 常驻启动: Xvfb:97 + NapCat QQ + 自家后端
# 前台运行; 收到 TERM/INT 时清理所有子进程后退出（供 docker stop / tini 转发）
set +e

export HOME="${HOME:-/root}"
export DISPLAY=:97
export QT_QPA_PLATFORM=xcb
export QQROBOT_DATA_DIR="${QQROBOT_DATA_DIR:-/data}"

XVFB_PID=""
QQ_PID=""
MH_PID=""
SHUTTING=0

log() { echo "[qqrobot] $*"; }

cleanup() {
  [ "$SHUTTING" = 1 ] && return
  SHUTTING=1
  log "收到停止信号，正在清理子进程…"
  # 先停控制面，避免 supervisor 在我们清 QQ 时重启子进程
  [ -n "$MH_PID" ] && kill -TERM "$MH_PID" 2>/dev/null
  pkill -f 'network-guard.cjs' 2>/dev/null
  pkill -f 'service.mjs run' 2>/dev/null
  [ -n "$QQ_PID" ] && kill -TERM "$QQ_PID" 2>/dev/null
  pkill -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
  [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null
  pkill -f 'Xvfb :97' 2>/dev/null
  sleep 1
  pkill -KILL -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
  pkill -KILL -f 'network-guard.cjs' 2>/dev/null
  log "已停止"
  exit 0
}
trap cleanup TERM INT HUP

log "== QQROBOT_START $(date) =="

# 0) 运行时配置（幂等; 不含凭据, token 首启随机生成）
bash /root/init-napcat-config.sh || { log "init-napcat-config 失败"; exit 1; }

# 1) 清理上次残留（容器重启时 /data 保留，但进程应已不在）
pkill -f 'Xvfb :97' 2>/dev/null
pkill -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
pkill -f 'network-guard.cjs' 2>/dev/null
pkill -f 'service.mjs run' 2>/dev/null
sleep 1

# 2) 虚拟显示（QQ 的扫码窗口画在这里；NapCat 会把它转成二维码图片）
Xvfb :97 -screen 0 480x800x24 > /tmp/xvfb97.log 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  log "Xvfb 启动失败:"; tail -20 /tmp/xvfb97.log; exit 1
fi
log "xvfb pid=$XVFB_PID"

# 3) 启动 QQ（NapCat 载荷已注入 app_launcher）
#    --no-sandbox: 容器内 root; --disable-dev-shm-usage: proot 无 /dev/shm
cd /root || exit 1
/root/Napcat/opt/QQ/qq --no-sandbox --disable-dev-shm-usage --disable-gpu --ozone-platform=x11 > /tmp/qq.log 2>&1 &
QQ_PID=$!
log "qq pid=$QQ_PID"

# 4) 自家后端（supervisor: network-guard + server.mjs; 面板 38121 / 控制面 38122）
cd /root/qqrobot-app || exit 1
node ./service.mjs run > /tmp/qqrobot-managed.log 2>&1 &
MH_PID=$!
log "managed pid=$MH_PID  bind=${QQROBOT_BIND:-127.0.0.1}:${QQROBOT_PORT:-38121}"

sleep 5
log "== 进程 =="
ps -ef | grep -E 'Xvfb|Napcat/opt/QQ/qq|qqrobot|network-guard' | grep -v grep
log "== 后端日志 =="
tail -5 /tmp/qqrobot-managed.log 2>&1
log "== QQROBOT_UP =="

# 5) 看门狗: 任一核心进程退出则整体退出，交给容器重启策略（或 tini 退出）
while true; do
  sleep 30
  [ "$SHUTTING" = 1 ] && exit 0

  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    log "Xvfb 退出，整体停止"; cleanup
  fi

  if ! kill -0 "$MH_PID" 2>/dev/null; then
    log "后端 supervisor 退出，整体停止"; cleanup
  fi

  # QQ 崩溃: 单独重启（NapCat 在 QQ 内部运行，重启 QQ 即可恢复）
  if ! kill -0 "$QQ_PID" 2>/dev/null; then
    log "== QQ_DIED $(date)，重启中 =="
    pkill -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
    sleep 2
    cd /root || exit 1
    /root/Napcat/opt/QQ/qq --no-sandbox --disable-dev-shm-usage --disable-gpu --ozone-platform=x11 > /tmp/qq.log 2>&1 &
    QQ_PID=$!
    log "qq restarted pid=$QQ_PID"
  fi
done