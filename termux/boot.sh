#!/bin/bash
# QQ聊天机器人 · 开机自启 + 防休眠（可选）
#
# 用法:
#   bash boot.sh install    安装自启钩子 + 唤醒锁
#   bash boot.sh status     查看状态
#   bash boot.sh remove     卸载
#
# 说明:
#   Termux:Boot 是独立 APK，需先从 F-Droid 安装，勾选「允许自启」。
#   脚本会写到 ~/.termux/boot/，由 Termux:Boot 在开机时执行。
#   唤醒锁防止 Android 休眠时杀掉 CPU，代价是耗电增加。
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOT_DIR="$HOME/.termux/boot"
HOOK="$BOOT_DIR/qqrobot-boot.sh"
CMD="${1:-status}"

case "$CMD" in
  install)
    mkdir -p "$BOOT_DIR"
    cat > "$HOOK" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# 由 boot.sh 生成
termux-wake-lock 2>/dev/null || true
cd "$SELF_DIR" || exit 1
nohup bash start.sh >> "\$HOME/qqrobot.log" 2>&1 &
EOF
    chmod 700 "$HOOK"
    echo "已安装自启钩子: $HOOK"
    echo "  → 需要安装 Termux:Boot APK 并在其设置里允许自启"
    echo "  → 日志: \$HOME/qqrobot.log"
    ;;
  remove)
    rm -f "$HOOK"
    termux-wake-lock --remove 2>/dev/null || true
    echo "已移除自启钩子"
    ;;
  status)
    [ -f "$HOOK" ] && echo "自启钩子: 已安装 ($HOOK)" || echo "自启钩子: 未安装"
    if command -v termux-wake-lock >/dev/null 2>&1; then
      echo "termux-wake-lock: 可用"
    else
      echo "termux-wake-lock: 不可用（需要 Termux:API）"
    fi
    [ -f "$HOME/qqrobot.log" ] && { echo "最近日志:"; tail -5 "$HOME/qqrobot.log"; }
    ;;
  *)
    echo "用法: bash boot.sh {install|status|remove}"
    exit 2
    ;;
esac