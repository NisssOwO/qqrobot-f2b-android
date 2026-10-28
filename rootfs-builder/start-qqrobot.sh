#!/bin/bash
# QQ聊天机器人 常驻启动: Xvfb:97 → QQ(NapCat 注入) → 等 OneBot ws:3001 → 后端面板
#
# 顺序是硬约束（真机踩过）:
#   - 后端的 OneBot 端口是「单次连接」，3001 没就绪就 connect 会永久 faulted 且不自愈
#   - 但面板不能等 QQ 登录才起（用户要扫码就得先能打开面板）
#   所以: 先起 QQ → 短暂等 3001 → 无论如何都起后端 → 看门狗在 3001 出现后重启后端让它连上
#
# 前台运行；收到 TERM/INT 时清理全部子进程（供 docker stop / tini 转发）
set +e

export HOME="${HOME:-/root}"
export DISPLAY=:97
export QT_QPA_PLATFORM=xcb
export QQROBOT_DATA_DIR="${QQROBOT_DATA_DIR:-/data}"
export QQROBOT_BIND="${QQROBOT_BIND:-127.0.0.1}"
export QQROBOT_PORT="${QQROBOT_PORT:-38121}"

QQ_BIN=/root/Napcat/opt/QQ/qq
QQ_ACCOUNT="${QQ_ACCOUNT:-3836367204}"
XVFB_PID=""
QQ_PID=""
MH_PID=""
SHUTTING=0
LAST_BACKEND_RESTART=0

log() { echo "[qqrobot] $(date -u +%H:%M:%S) $*"; }

cleanup() {
  [ "$SHUTTING" = 1 ] && return
  SHUTTING=1
  log "收到停止信号，清理子进程…"
  [ -n "$MH_PID" ] && kill -TERM "$MH_PID" 2>/dev/null
  pkill -f 'network-guard.cjs' 2>/dev/null
  pkill -f 'service.mjs run' 2>/dev/null
  [ -n "$QQ_PID" ] && kill -TERM "$QQ_PID" 2>/dev/null
  pkill -f "$QQ_BIN" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null
  pkill -f 'Xvfb :97' 2>/dev/null
  sleep 1
  pkill -KILL -f "$QQ_BIN" 2>/dev/null
  pkill -KILL -f 'network-guard.cjs' 2>/dev/null
  log "已停止"
  exit 0
}
trap cleanup TERM INT HUP

log "== QQROBOT_START =="

# 0) 运行时配置（幂等；镜像不含凭据）
bash /root/init-napcat-config.sh || { log "init-napcat-config 失败"; exit 1; }

# 1) 清理上次残留
pkill -f 'Xvfb :97' 2>/dev/null
pkill -f "$QQ_BIN" 2>/dev/null
pkill -f 'network-guard.cjs' 2>/dev/null
pkill -f 'service.mjs run' 2>/dev/null
sleep 1

# 2) 虚拟显示
Xvfb :97 -screen 0 480x800x24 > /tmp/xvfb97.log 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  log "Xvfb 启动失败:"; tail -20 /tmp/xvfb97.log; exit 1
fi
log "xvfb pid=$XVFB_PID"

# --- 辅助函数 ---------------------------------------------------------------
# PIDs get recycled, and QQ dies often enough that `kill -0 $QQ_PID` eventually
# points at some unrelated process and the watchdog silently stops restarting
# it. Verify the PID still *is* QQ by reading its command line.
qq_alive() {
  [ -n "$QQ_PID" ] || return 1
  tr '\0' ' ' < "/proc/$QQ_PID/cmdline" 2>/dev/null | grep -qF "$QQ_BIN"
}

start_qq() {
  pkill -f "$QQ_BIN" 2>/dev/null
  sleep 2
  cd /root || return 1
  # Chromium's crash reporter is what usually raises SIGTRAP inside a proot
  # container; nothing can read the minidumps here anyway, so turn it off.
  "$QQ_BIN" --no-sandbox --disable-dev-shm-usage --disable-gpu --ozone-platform=x11 \
      --disable-crash-reporter --disable-breakpad -q "$QQ_ACCOUNT" \
      >> /tmp/qq.log 2>&1 &
  QQ_PID=$!
  log "qq pid=$QQ_PID account=$QQ_ACCOUNT"
}

# 等 OneBot ws 端口可连；$1=最长秒数。0=就绪 1=超时 2=QQ 中途退出
wait_onebot() {
  local deadline=$(( $(date +%s) + ${1:-240} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if timeout 2 bash -c '</dev/tcp/127.0.0.1/3001' 2>/dev/null; then return 0; fi
    if ! qq_alive; then return 2; fi
    sleep 5
  done
  return 1
}

start_backend() {
  if [ -n "$MH_PID" ]; then kill -TERM "$MH_PID" 2>/dev/null; sleep 1; fi
  pkill -f 'network-guard.cjs' 2>/dev/null
  pkill -f 'service.mjs run' 2>/dev/null
  sleep 1
  cd /root/qqrobot-app || return 1
  node ./service.mjs run >> /tmp/qqrobot-managed.log 2>&1 &
  MH_PID=$!
  LAST_BACKEND_RESTART=$(date +%s)
  log "backend pid=$MH_PID bind=${QQROBOT_BIND}:${QQROBOT_PORT}"
}

# 读面板里的 gateway 状态（内部环回 + Basic 口令；无口令时直接不带认证）
gateway_state() {
  local auth=()
  [ -n "${QQROBOT_PASSWORD:-}" ] && auth=(-u ":${QQROBOT_PASSWORD}")
  curl -s -m 3 "${auth[@]}" "http://127.0.0.1:${QQROBOT_PORT}/api/gateway" 2>/dev/null \
    | grep -o '"state":"[a-z-]*"' | head -1 | cut -d'"' -f4
}

# 3) QQ
#    QQROBOT_SKIP_QQ=1 只起面板（CI 冒烟测试用：QEMU 下跑 Electron 版 QQ 既慢又无意义）
if [ "${QQROBOT_SKIP_QQ:-0}" = "1" ]; then
  log "QQROBOT_SKIP_QQ=1 — 跳过 Xvfb/QQ，仅启动面板"
  [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null
  pkill -f 'Xvfb :97' 2>/dev/null
  XVFB_PID=""
  start_backend
  log "== QQROBOT_UP (panel only) =="
  while true; do
    sleep 30
    [ "$SHUTTING" = 1 ] && exit 0
    if ! kill -0 "$MH_PID" 2>/dev/null; then
      log "后端 supervisor 退出，重启"
      start_backend
    fi
  done
fi

start_qq

# 4) 短暂等 OneBot（已登录时快速登录很快；没登录就继续，面板优先）
if wait_onebot 60; then
  log "onebot 3001 ready"
else
  log "onebot 3001 未就绪（可能需要扫码），先起面板"
fi

# 5) 后端（无论 3001 是否就绪都起，否则用户打不开面板扫码）
start_backend

log "== 进程 =="
ps -ef | grep -E 'Xvfb|Napcat/opt/QQ/qq|qqrobot|network-guard' | grep -v grep
log "== QQROBOT_UP =="

# 6) 看门狗
while true; do
  sleep 30
  [ "$SHUTTING" = 1 ] && exit 0

  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    log "Xvfb 退出，整体停止"; cleanup
  fi

  # QQ 崩溃/被杀: 重启后 OneBot 端口会重建，旧后端连接已断，必须一并重启后端
  if ! qq_alive; then
    log "QQ 退出，重启"
    start_qq
    if wait_onebot 240; then
      log "onebot 3001 恢复，重启后端以重建连接"
    else
      log "onebot 3001 仍未就绪（等扫码），后端保持运行供面板使用"
    fi
    start_backend
    continue
  fi

  if ! kill -0 "$MH_PID" 2>/dev/null; then
    log "后端 supervisor 退出，重启"
    start_backend
    continue
  fi

  # 3001 在、但后端 gateway 没连上（例如扫码后才起来）→ 重启后端一次（带冷却）
  if timeout 2 bash -c '</dev/tcp/127.0.0.1/3001' 2>/dev/null; then
    st="$(gateway_state)"
    if [ -n "$st" ] && [ "$st" != "ready" ]; then
      now=$(date +%s)
      if [ $(( now - LAST_BACKEND_RESTART )) -gt 90 ]; then
        log "gateway state=$st 且 3001 可用，重启后端重连"
        start_backend
      fi
    fi
  fi
done