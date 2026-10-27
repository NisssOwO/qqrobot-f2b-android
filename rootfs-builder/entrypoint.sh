#!/bin/bash
# QQ聊天机器人 容器入口
#
# 职责: 校验环境变量 → 交给 start-qqrobot.sh 拉起 NapCat + QQ + 后端 → 前台等信号
# 退出码: 2 = 配置错误, 1 = 启动失败
set -u

log() { echo "[entrypoint] $*"; }
die() { echo "[entrypoint] ERROR: $*" >&2; exit 2; }

# --- 环境变量校验 -----------------------------------------------------------
DATA_DIR="${QQROBOT_DATA_DIR:-/data}"
BIND="${QQROBOT_BIND:-127.0.0.1}"
PORT="${QQROBOT_PORT:-38121}"
PASSWORD="${QQROBOT_PASSWORD:-}"

case "$BIND" in
  127.0.0.1|0.0.0.0) ;;
  *) die "QQROBOT_BIND 只能是 127.0.0.1 或 0.0.0.0（当前: $BIND）" ;;
esac

if [ "$BIND" = "0.0.0.0" ]; then
  if [ -z "$PASSWORD" ]; then
    die "对外暴露(QQROBOT_BIND=0.0.0.0)必须设置 QQROBOT_PASSWORD，否则局域网内任何人都能操作机器人"
  fi
  if [ "${#PASSWORD}" -lt 8 ]; then
    die "QQROBOT_PASSWORD 至少 8 位（当前 ${#PASSWORD} 位）"
  fi
fi

case "$PORT" in
  ''|*[!0-9]*) die "QQROBOT_PORT 必须是数字（当前: $PORT）" ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  die "QQROBOT_PORT 必须在 1024-65535 之间（当前: $PORT）"
fi

mkdir -p "$DATA_DIR" || die "无法创建数据目录 $DATA_DIR（检查挂载和权限）"
if [ ! -w "$DATA_DIR" ]; then
  die "数据目录 $DATA_DIR 不可写（检查 volume 属主；用 docker 时通常是 uid 不匹配）"
fi

export QQROBOT_DATA_DIR="$DATA_DIR"
export QQROBOT_BIND="$BIND"
export QQROBOT_PORT="$PORT"
export QQROBOT_PASSWORD="$PASSWORD"
export HOME="${HOME:-/root}"

log "数据目录: $DATA_DIR"
log "面板监听: $BIND:$PORT $([ -n "$PASSWORD" ] && echo '(需要登录口令)' || echo '(仅本机)')"
[ -n "${QQ_ACCOUNT:-}" ] && log "QQ 账号: $QQ_ACCOUNT"
[ -n "${GROUP_ALLOW:-}" ] && log "允许群: $GROUP_ALLOW"

# --- 启动主体 ---------------------------------------------------------------
# start-qqrobot.sh 以前台 wait 的方式运行，收到 TERM 后清理全部子进程。
exec /bin/bash /root/start-qqrobot.sh