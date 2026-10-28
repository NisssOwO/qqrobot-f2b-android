#!/bin/bash
# QQ聊天机器人 · Termux 状态查看
set -u
VERSION="${QQROBOT_VERSION:-0.2.2}"
DATA_DIR="${QQROBOT_DATA_DIR:-$HOME/qqrobot-data}"
PORT="${QQROBOT_PORT:-38121}"
export UDOCKER_USE_PROOT_EXECUTABLE="${PREFIX:-}/bin/proot"
export UDOCKER_USE_CURL_EXECUTABLE="${PREFIX:-}/bin/curl"
export UDOCKER_DIR="$HOME/.udocker"

echo "== 镜像 =="
udocker images 2>/dev/null | grep qqrobot || echo "  （无）"

echo
echo "== 容器 =="
# 注意: udocker ps 不支持 -a / -l，直接 ps 就是全部容器
udocker ps 2>/dev/null | grep -E 'CONTAINER|qqrobot' || echo "  （无）"

echo
echo "== 进程 =="
for pat in 'Napcat/opt/QQ/qq' 'server.mjs' 'network-guard.cjs' 'Xvfb :97'; do
  n=$(pgrep -f "$pat" 2>/dev/null | wc -l)
  echo "  $pat: $n"
done

echo
echo "== 端口 =="
if command -v ss >/dev/null 2>&1; then
  ss -lnt 2>/dev/null | awk 'NR==1 || /:38121 |:38122 |:3001 |:6099 /'
elif command -v netstat >/dev/null 2>&1; then
  netstat -lnt 2>/dev/null | awk 'NR<=2 || /:38121 |:38122 |:3001 |:6099 /'
else
  echo "  （没有 ss/netstat，安装: pkg install -y net-tools）"
fi

echo
echo "== 面板 =="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/api/status" 2>/dev/null || echo 000)
case "$code" in
  200) echo "  http=$code 可达（本机免口令）" ;;
  401) echo "  http=$code 可达（需要登录口令）" ;;
  000) echo "  不可达" ;;
  *)   echo "  http=$code" ;;
esac

echo
echo "== 数据目录 $DATA_DIR =="
if [ -d "$DATA_DIR" ]; then
  du -sh "$DATA_DIR" 2>/dev/null
  ls -1 "$DATA_DIR" 2>/dev/null | head -10
  [ -f "$DATA_DIR/config.json" ] && echo "  config.json: ok" || echo "  config.json: missing"
  [ -f "$DATA_DIR/napcat-config/webui.json" ] && echo "  napcat webui.json: ok" || echo "  napcat webui.json: missing"
  [ -d "$DATA_DIR/napcat-config" ] && echo "  登录态目录: $(ls -1 "$DATA_DIR/napcat-config" 2>/dev/null | wc -l) 个文件"
else
  echo "  不存在"
fi

LAN_IP="$(ifconfig 2>/dev/null | awk '/^wlan0/{found=1} found && /inet /{print $2; exit}' | cut -d/ -f1)"
[ -n "$LAN_IP" ] && { echo; echo "局域网地址: http://${LAN_IP}:${PORT}"; }