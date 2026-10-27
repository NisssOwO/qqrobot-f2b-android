#!/data/data/dev.qqrobot.f2b/files/usr/bin/bash
# ============================================================================
# QQ聊天机器人 (dev.qqrobot.f2b) — 首次启动安装向导
#
# 运行环境: Termux bootstrap 解压完成后（bash/curl/tar/xz 已就绪）
# 流程:     读 rootfs URL → 下载 → 解压到 $FILES/rootfs → 装 proot → 体检
#           → 后台启动 proot 容器(容器内 /root/start-qqrobot.sh 常驻: Xvfb+QQ+node 后端)
#           → 打开面板 http://127.0.0.1:38121
# 幂等:     重复执行时 rootfs 已存在则跳过下载/解压; 标记 .qqrobot-ready 后 Java 不再触发
# ============================================================================
set -euo pipefail

FILES=/data/data/dev.qqrobot.f2b/files
PREFIX=$FILES/usr
URL_FILE=$FILES/qqrobot-rootfs-url.txt
ROOTFS_TAR=$FILES/rootfs.tar.xz
ROOTFS_DIR=$FILES/rootfs
MARKER=$FILES/.qqrobot-ready
LOG_DIR=$FILES/logs
PANEL_URL="http://127.0.0.1:38121/"

say()  { printf '\n[QQ机器人] %s\n' "$*"; }
fail() { printf '\n[QQ机器人] 失败: %s\n' "$*" >&2; exit 1; }

say "首次初始化开始"

# ---- 0) 读 rootfs URL ----
[ -f "$URL_FILE" ] || fail "缺少 $URL_FILE（rootfs 下载地址），请重装或手动放置"
ROOTFS_URL="$(head -n 1 "$URL_FILE" | tr -d '[:space:]')"
[ -n "$ROOTFS_URL" ] || fail "rootfs URL 为空"

# ---- 1) 磁盘空间提示 ----
say "磁盘可用空间:"
df -h "$FILES" | tail -n 1

# ---- 2) 下载 rootfs（断点续传 + 重试）----
if [ ! -f "$ROOTFS_DIR/etc/os-release" ] && [ ! -s "$ROOTFS_TAR" ]; then
  say "下载 rootfs（体积较大，请保持网络与前台运行）…"
  echo "$ROOTFS_URL"
  # 下载到 .part, 成功后再改名, 避免半截文件被当成完成
  curl -fL -C - --retry 5 --retry-delay 5 --connect-timeout 30 \
       -o "$ROOTFS_TAR.part" "$ROOTFS_URL" || fail "下载失败: $ROOTFS_URL"
  mv "$ROOTFS_TAR.part" "$ROOTFS_TAR"
fi

# ---- 3) 解压到 rootfs（docker export 的 tar 根即 /, 直接展开到 $ROOTFS_DIR）----
if [ ! -f "$ROOTFS_DIR/etc/os-release" ]; then
  [ -s "$ROOTFS_TAR" ] || fail "rootfs.tar.xz 不存在或为空，请重新下载"
  say "解压 rootfs（需要几分钟）…"
  mkdir -p "$ROOTFS_DIR"
  xz -dkc "$ROOTFS_TAR" | tar -x -C "$ROOTFS_DIR" || fail "解压失败"
fi

# ---- 4) 安装 proot（Termux 官方源）----
if ! command -v proot >/dev/null 2>&1; then
  say "安装 proot …"
  apt-get update -qq && apt-get install -y proot || {
    # 备选: pkg 是同名封装, 部分版本无 apt-get 直装
    command -v pkg >/dev/null 2>&1 && pkg install -y proot || fail "proot 安装失败"
  }
fi
command -v proot >/dev/null 2>&1 || fail "proot 不可用"

# ---- 5) 幂等体检 ----
say "体检: rootfs / proot …"
[ -f "$ROOTFS_DIR/etc/os-release" ] || fail "rootfs 缺少 /etc/os-release"
[ -x "$PREFIX/bin/proot" ] || fail "proot 不可执行"
grep -qs 'ubuntu' "$ROOTFS_DIR/etc/os-release" 2>/dev/null || true   # 提示性, 不强校验
command -v bash >/dev/null 2>&1 || true

# ---- 6) 后台启动 proot 容器（容器内 start-qqrobot.sh 自带 Xvfb/QQ/node 常驻循环）----
if ! pgrep -f "proot.*$ROOTFS_DIR" >/dev/null 2>&1; then
  say "启动 QQ 机器人容器（日志: logs/qqrobot.log）…"
  mkdir -p "$LOG_DIR" "$FILES/tmp"
  export LD_LIBRARY_PATH="$PREFIX/lib"
  export PROOT_LOADER="$PREFIX/libexec/proot/loader"
  export PROOT_LOADER_32="$PREFIX/libexec/proot/loader32"
  export PROOT_TMP_DIR="$FILES/tmp"
  export PROOT_NO_SECCOMP=1
  nohup "$PREFIX/bin/proot" --kill-on-exit --link2symlink -0 \
        -r "$ROOTFS_DIR" -b /dev -b /proc -w /root \
        /usr/bin/env -i HOME=/root \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        LANG=C.UTF-8 TMPDIR=/tmp \
        /root/start-qqrobot.sh >"$LOG_DIR/qqrobot.log" 2>&1 &
  disown || true
fi

# ---- 7) 标记就绪, 打开面板 ----
touch "$MARKER"

if command -v am >/dev/null 2>&1 || [ -x /system/bin/am ]; then
  AM=${AM:-$(command -v am || echo /system/bin/am)}
  say "打开面板 $PANEL_URL"
  "$AM" start -a android.intent.action.VIEW -d "$PANEL_URL" >/dev/null 2>&1 || \
    say "请手动用浏览器打开 $PANEL_URL"
else
  say "请用浏览器打开 $PANEL_URL（QQ 扫码与机器人控制面板）"
fi

say "首次初始化完成。机器人已在后台运行；手机浏览器访问 $PANEL_URL"
exit 0