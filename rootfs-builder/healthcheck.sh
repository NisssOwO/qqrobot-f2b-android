#!/bin/bash
# 容器健康检查: 面板可响应 即视为健康
# 退出码 0 = healthy, 1 = unhealthy
set -u
PORT="${QQROBOT_PORT:-38121}"

# 面板首页会要求登录口令；只要能拿到 200 或 401 都说明 HTTP 服务活着。
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/api/status" 2>/dev/null || echo 000)
case "$code" in
  200|401) exit 0 ;;
  *) echo "panel http=${code:-000}"; exit 1 ;;
esac