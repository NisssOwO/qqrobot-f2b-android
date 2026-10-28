#!/bin/bash
# QQ聊天机器人 · Termux 启动脚本
#
# 用法:
#   本机访问:              bash start.sh
#   局域网访问（带口令）:   QQROBOT_PASSWORD='你的口令' QQROBOT_BIND=0.0.0.0 bash start.sh
#   后台常驻:              nohup bash start.sh > $HOME/qqrobot.log 2>&1 &
#
# 环境变量:
#   QQROBOT_PASSWORD  局域网登录口令（绑定 0.0.0.0 时必填，至少 8 位）
#   QQROBOT_BIND      127.0.0.1（默认）| 0.0.0.0
#   QQROBOT_PORT      面板端口，默认 38121
#   QQ_ACCOUNT        机器人 QQ 号，默认 3836367204
#   GROUP_ALLOW       允许的群号，默认 620765931
#   QQROBOT_DATA_DIR  数据目录，默认 $HOME/qqrobot-data
#   QQROBOT_VERSION   镜像版本，默认 0.2.2
set -eu

VERSION="${QQROBOT_VERSION:-0.2.3}"
DATA_DIR="${QQROBOT_DATA_DIR:-$HOME/qqrobot-data}"
BIND="${QQROBOT_BIND:-127.0.0.1}"
PORT="${QQROBOT_PORT:-38121}"
PASSWORD="${QQROBOT_PASSWORD:-}"
CONTAINER_NAME="${QQROBOT_CONTAINER:-qqrobot}"

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
  [ -n "$PASSWORD" ] || die "对外暴露需要口令，例如：
  QQROBOT_PASSWORD='至少8位的口令' QQROBOT_BIND=0.0.0.0 bash start.sh"
  [ "${#PASSWORD}" -ge 8 ] || die "QQROBOT_PASSWORD 至少 8 位（当前 ${#PASSWORD} 位）"
fi

# --- udocker 环境（必须显式指定，否则会误用 /system/bin 下的玩具版工具） ------
export UDOCKER_USE_PROOT_EXECUTABLE="$PREFIX/bin/proot"
export UDOCKER_USE_CURL_EXECUTABLE="$PREFIX/bin/curl"
export UDOCKER_DIR="$HOME/.udocker"

command -v udocker >/dev/null 2>&1 || die "未安装 udocker，先跑: bash install.sh"
# 镜像名可能带仓库前缀（docker.io/library/… 或 localhost/…），取决于打包工具；
# 直接问 udocker 实际导入了什么，不要按标签拼名字。
# udocker prints only the REPOSITORY column, so match on the ":<version>"
# suffix rather than assuming a repository/tag column split.
IMG_REF="$(udocker images 2>/dev/null | awk -v v="$VERSION" 'NR>1 { n = split($1, p, ":"); if (n == 2 && p[2] == v) { print $1; exit } }')"
[ -n "$IMG_REF" ] || die "镜像 qqrobot:${VERSION} 不存在，先跑: bash install.sh"

# --- 容器参数 ---------------------------------------------------------------
# 注意: udocker 的 proot 模式复用宿主网络栈，没有 --publish/-p 端口映射，
# 容器内监听 0.0.0.0:PORT 就是手机在监听该端口。想被局域网访问必须 BIND=0.0.0.0。
run_args=(
  "--name=${CONTAINER_NAME}"
  "--volume=${DATA_DIR}:/data"
  "--env=QQROBOT_BIND=${BIND}"
  "--env=QQROBOT_PORT=${PORT}"
  "--env=QQROBOT_DATA_DIR=/data"
  "--env=QQ_ACCOUNT=${QQ_ACCOUNT:-3836367204}"
  "--env=GROUP_ALLOW=${GROUP_ALLOW:-620765931}"
)
[ -n "$PASSWORD" ] && run_args+=("--env=QQROBOT_PASSWORD=${PASSWORD}")

# 清理上一次同名容器（udocker run --name 重复使用会报名称冲突）
# 注意: `udocker rm <name>` 报 "Error: invalid container id"，只能按 ID 删
existing_ids=$(udocker ps 2>/dev/null | awk '/qqrobot/{print $1}')
if [ -n "$existing_ids" ]; then
  say "清理旧容器…"
  for cid in $existing_ids; do
    udocker rm -f "$cid" >/dev/null 2>&1 || true
  done
fi

LAN_IP="$(ifconfig 2>/dev/null | awk '/^wlan0/{found=1} found && /inet /{print $2; exit}' | cut -d/ -f1)"
[ -z "$LAN_IP" ] && LAN_IP="$(ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)"

say "启动 $IMG_REF"
say "  绑定: ${BIND}:${PORT}$([ -n "$PASSWORD" ] && echo '  (需要登录口令)' || echo '  (仅本机)')"
say "  数据: $DATA_DIR"
if [ "$BIND" = "0.0.0.0" ] && [ -n "$LAN_IP" ]; then
  say "  局域网地址: http://${LAN_IP}:${PORT}"
elif [ "$BIND" = "127.0.0.1" ]; then
  say "  只能在本机访问 http://127.0.0.1:${PORT}"
  say "  想被局域网访问: QQROBOT_PASSWORD='口令' QQROBOT_BIND=0.0.0.0 bash start.sh"
fi
say "  首次启动会初始化配置并拉起 QQ/NapCat，约 1–2 分钟"
say "  停止: 另开一个 Termux 会话执行 bash stop.sh"
say ""

# --rm: 退出后自动删容器，避免堆积匿名容器
exec udocker run --rm "${run_args[@]}" "$IMG_REF"