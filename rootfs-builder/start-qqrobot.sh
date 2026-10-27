#!/bin/bash
# guest 常驻启动: Xvfb:97 + NapCat QQ + 自家后端（proot 容器内; docker 只管构建）
# 由宿主 proot 会话以 /root/start-qqrobot.sh 调用; 不退出
set +e
export HOME=/root
export DISPLAY=:97
export QT_QPA_PLATFORM=xcb
export QQROBOT_DATA_DIR="${QQROBOT_DATA_DIR:-/root/qqrobot-data}"

echo "== QQROBOT_START $(date) =="

# 0) 运行时配置（幂等; 不含凭据, token 首启随机生成）
bash /root/init-napcat-config.sh
INIT_RC=$?
if [ "$INIT_RC" != 0 ]; then echo "init-napcat-config failed rc=$INIT_RC"; exit 1; fi

# 1) 清理残留
pkill -f 'Xvfb :97' 2>/dev/null
pkill -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
pkill -f 'network-guard.cjs' 2>/dev/null
sleep 1

# 2) 显示服务器（QQ 二维码在这里画出来）
Xvfb :97 -screen 0 480x800x24 > /tmp/xvfb97.log 2>&1 &
XVFB_PID=$!
sleep 2
echo "xvfb pid=$XVFB_PID"

# 3) 启动 QQ（NapCat 载荷已注入 app_launcher; root 下 --no-sandbox; proot 无 /dev/shm → --disable-dev-shm-usage）
cd /root
nohup /root/Napcat/opt/QQ/qq --no-sandbox --disable-dev-shm-usage --disable-gpu --ozone-platform=x11 > /tmp/qq.log 2>&1 &
QQ_PID=$!
echo "qq pid=$QQ_PID"

# 4) 自家后端（supervisor: network-guard + server.mjs; 面板 38121 / 控制 38122）
cd /root/qqrobot-app
nohup node ./service.mjs run > /tmp/qqrobot-managed.log 2>&1 &
MH_PID=$!
echo "managed pid=$MH_PID"

sleep 5
echo "== procs =="
ps -ef | grep -E 'Xvfb|/qq |/qq$|qqrobot|network-guard' | grep -v grep
echo "== qq.log head =="
head -20 /tmp/qq.log 2>&1
echo "== QQROBOT_UP =="

# 常驻: 保持 proot 会话与子进程存活（qq 退出则整体重启）
while true; do
  sleep 60
  if ! kill -0 "$QQ_PID" 2>/dev/null; then
    echo "== QQ_DIED $(date), restarting =="
    pkill -f '/root/Napcat/opt/QQ/qq' 2>/dev/null
    cd /root
    nohup /root/Napcat/opt/QQ/qq --no-sandbox --disable-dev-shm-usage --disable-gpu --ozone-platform=x11 > /tmp/qq.log 2>&1 &
    QQ_PID=$!
    echo "qq restarted pid=$QQ_PID"
  fi
done