#!/bin/bash
# QQ聊天机器人 · Termux 启动脚本
#
# 用法:
#   本机访问:            bash start.sh
#   局域网访问（带口令）: QQROBOT_PASSWORD='你的口令' QQROBOT_BIND=0.0.0.0 bash start.sh
#   后台常驻:            nohup bash start.sh > $HOME/qqrobot.log 2>&1 &
#
# 环境变量:
#   QQROBOT_PASSWORD  局域网登录口令（绑定 0.0.0.0 时必填，至少 8 位）
#   QQROBOT_BIND      127.0.0.1（默认）| 0.0.0.0
#   QQROBOT_PORT      面板端口，默认 38121
#   QQ_ACCOUNT        机器人 QQ 号
#   GROUP_ALLOW       允许的群号（逗号分隔）
#   QQROBOT_DATA_DIR  数据目录，默认 $HOME/qqrobot-data
#   QQROBOT_VERSION   镜像版本，默认 0.2.0
set -eu

VERSION="${QQROBOT_VERSION:-0.2.0}"
DATA_DIR="${QQROBOT_DATA_DIR:-$HOME/qqrobot-data}"
BIND="${QQROBOT_BIND:-127.0.0.1}"
PORT="${QQROBOT_PORT:-38121}"
PASSWORD="${QQROBOT_PASSWORD:-}"

say()  { printf '\033[1;36m[qqrobot]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[qqrobot] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "${PREFIX:-}" ] || die "这不是 Termux 环境"
mkdir -p "$DATA_DIR"

# --- 校验（与容器 entrypoint 的规则保持一致，提前在宿主侧拦住） --------------
case "$BIND" in
  127.0.0.1|0.0.0.0) ;;
  *) die "QQROBOT_BIND 只能是 127.0.0.1 或 0.0.0.0" ;;
esac
if [ "$BIND" = "0.0.0.0" ]; then
  [ -n "$PASSWORD" ] || die "对外暴露需要口令: QQROBOT_PASSWORD='至少8位的口令' QQROBOT_BIND=0.0.0.0 bash start.sh"
  [ "${#PASSWORD}" -ge 8 ] || die "QQROBOT_PASSWORD 至少 8 位"
fi

# --- udocker 环境（必须显式指定，否则会误用 /system/bin 下的玩具版工具） ------
export UDOCKER_USE_PROOT_EXECUTABLE="$PREFIX/bin/proot"
export UDOCKER_USE_CURL_EXECUTABLE="$PREFIX/bin/curl"
export UDOCKER_DIR="$HOME/.udocker"

command -v udocker >/dev/null 2>&1 || die "未安装 udocker，先跑: bash install.sh"
udocker images 2>/dev/null | grep -q "qqrobot:${VERSION}" || die "镜像 qqrobot:${VERSION} 不存在，先跑: bash install.sh"

# --- 容器参数 ---------------------------------------------------------------
# udocker 的 -p / -v 语法与 docker 类似，但需要 --publish / --volume 全称在部分版本才稳；
# 这里统一用长参数并显式给出 host:container。
run_args=(
  --name=qqrobot-run
  "--volume=${DATA_DIR}:/data"
  "--publish=${PORT}:${PORT}"
  "--env=QQROBOT_BIND=${BIND}"
  "--env=QQROBOT_PORT=${PORT}"
  "--env=QQROBOT_DATA_DIR=/data"
)
[ -n "$PASSWORD" ] && run_args+=("--env=QQROBOT_PASSWORD=${PASSWORD}")
[ -n "${QQ_ACCOUNT:-}" ] && run_args+=("--env=QQ_ACCOUNT=${QQ_ACCOUNT}")
[ -n "${GROUP_ALLOW:-}" ] && run_args+=("--env=GROUP_ALLOW=${GROUP_ALLOW}")

# 清理上一次同名的运行容器（udocker run 会新建匿名容器，残留会堆积）
udocker ps 2>/dev/null | grep -q qqrobot-run && udocker rm qqrobot-run >/dev/null 2>&1 || true

LAN_IP="$(ifconfig 2>/dev/null | awk '/^wlan0/{found=1} found && /inet /{print $2; exit}' | cut -d/ -f1)"
[ -z "$LAN_IP" ] && LAN_IP="$(ip -4 addr show 2>/dev/null | awk '/wlan0/{f=1} f && /inet /{print $2; exit}' | cut -d/ -f1)"

say "启动 qqrobot:${VERSION}"
say "  绑定: $BIND:$PORT$([ -n "$PASSWORD" ] && echo '  (需要登录口令)' || echo '  (仅本机)')"
say "  数据: $DATA_DIR"
if [ "$BIND" = "0.0.0.0" ] && [ -n "$LAN_IP" ]; then
  say "  局域网地址: http://${LAN_IP}:${PORT}"
fi
say "  首次启动会初始化配置并拉起 QQ/NapCat，约 1–2 分钟"
say "  停止: 另开一个 Termux 会话执行 bash stop.sh"
say ""

exec udocker run "${run_args[@]}" "qqrobot:${VERSION}"