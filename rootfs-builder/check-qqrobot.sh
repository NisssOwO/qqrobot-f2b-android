#!/bin/bash
# 幂等体检（首启/每次验证）: 输出容器内服务状态, 供宿主脚本解析
# 退出码: 0=全部就绪 1=部分缺失 2=严重缺失
set +e
export HOME=/root
export QQROBOT_DATA_DIR="${QQROBOT_DATA_DIR:-/root/qqrobot-data}"
FAIL=0

echo "== QQROBOT_CHECK $(date) =="

# 1) 进程
XVFB=$(pgrep -f 'Xvfb :97' | head -1)
QQP=$(pgrep -f '/root/Napcat/opt/QQ/qq' | head -1)
MH=$(pgrep -f 'network-guard.cjs' | head -1)
echo "xvfb=${XVFB:-none} qq=${QQP:-none} managed=${MH:-none}"
[ -n "$XVFB" ] || FAIL=1
[ -n "$QQP" ]  || FAIL=1
[ -n "$MH" ]   || FAIL=1

# 2) 端口（proot 容器与宿主共享网络命名空间? 不—用 guest 视角监听检查）
echo "--- listeners ---"
ss -tlnp 2>/dev/null | grep -E ':3001|:38121|:38122|:6099' || netstat -tlnp 2>/dev/null | grep -E ':3001|:38121|:38122|:6099' || echo "(ss/netstat unavailable)"
ss_out=$(ss -tln 2>/dev/null | grep -cE ':38121' )
echo "panel_listening_38121=${ss_out:-?}"

# 3) 文件
[ -f "$QQROBOT_DATA_DIR/config.json" ] && echo "config.json=ok" || { echo "config.json=missing"; FAIL=1; }
[ -f /root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json ] && echo "webui.json=ok" || { echo "webui.json=missing"; FAIL=1; }

echo "== QQROBOT_CHECK_DONE rc=${FAIL} =="
exit $FAIL