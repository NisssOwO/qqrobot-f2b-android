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

# ---- 0) 关键环境修复 ----
# 0a) 动态链接: bootstrap 二进制编译期 DT_RUNPATH 指向官方包名 com.termux,
#     fork 改名 dev.qqrobot.f2b 后失效; 必须显式给 LD_LIBRARY_PATH
#     (TermuxShellEnvironment.java 已设, 这里再兜底一份, 保证手动 bash 也能跑)
export LD_LIBRARY_PATH="$PREFIX/lib"

# 0b) TLS 证书: curl/openssl 编译期 CA bundle 路径同样硬编码 com.termux,
#     必须指到本包名的 cert.pem, 否则任何 https 都会 error 77
export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
export CURL_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"

# 0c) shebang: bootstrap 里的 shell 脚本工具(如 df) shebang 硬编码
#     #!/data/data/com.termux/files/usr/bin/sh, 跨包名无权限执行(bad interpreter 126)
#     → 把 usr/bin 下所有脚本的该前缀重写为本包名 (幂等, 只处理以 #! 开头的文本)
fix_shebang() {
  local f sig n=0
  for f in "$PREFIX"/bin/*; do
    [ -f "$f" ] || continue
    sig="$(head -c 2 "$f" 2>/dev/null)" || continue
    [ "$sig" = "#!" ] || continue
    if head -c 512 "$f" | grep -qa '/data/data/com.termux/files/usr/' 2>/dev/null; then
      sed -i 's#/data/data/com.termux/files/usr/#/data/data/dev.qqrobot.f2b/files/usr/#g' "$f" 2>/dev/null \
        && n=$((n+1))
    fi
  done
  if [ "$n" -gt 0 ]; then echo "[QQ机器人] 已修复 $n 个脚本路径"; fi
}
fix_shebang

say()  { printf '\n[QQ机器人] %s\n' "$*"; }
fail() { printf '\n[QQ机器人] 失败: %s\n' "$*" >&2; exit 1; }

say "首次初始化开始"

# ---- 1) 读 rootfs URL ----
[ -f "$URL_FILE" ] || fail "缺少 $URL_FILE（rootfs 下载地址），请重装或手动放置"
ROOTFS_URL="$(head -n 1 "$URL_FILE" | tr -d '[:space:]')"
[ -n "$ROOTFS_URL" ] || fail "rootfs URL 为空"

# ---- 2) 磁盘空间提示 ----
say "磁盘可用空间:"
df -h "$FILES" | tail -n 1

# ---- 3) 下载 rootfs（多镜像 fallback + 断点续传 + 重试）----
# github 直连在国内网络常被墙(TCP 卡死), 依次尝试镜像前缀, 先用 RANGE 探活再全量拉
# 提示: 公司/家庭 WiFi 可达性不同; 某镜像挂了会自动跳过
dl() {  # dl <label> <url>: 探活+全量下载, 成功返回 0
  local label="$1" url="$2"
  say "尝试镜像: $label ($url)"
  if curl -fL -s --connect-timeout 8 --max-time 15 -r 0-1023 -o /dev/null "$url"; then
    say "镜像可达, 开始下载…"
    if curl -fL -C - --retry 5 --retry-delay 3 --connect-timeout 15 \
         -o "$ROOTFS_TAR.part" "$url"; then
      mv "$ROOTFS_TAR.part" "$ROOTFS_TAR"
      return 0
    fi
  fi
  rm -f "$ROOTFS_TAR.part"
  return 1
}
if [ ! -f "$ROOTFS_DIR/etc/os-release" ] && [ ! -s "$ROOTFS_TAR" ]; then
  say "下载 rootfs（体积较大，请保持网络与前台运行）…"
  OK=0
  for cand in "$ROOTFS_URL" \
              "https://gh-proxy.com/$ROOTFS_URL" \
              "https://ghproxy.net/$ROOTFS_URL" \
              "https://ghfast.top/$ROOTFS_URL"; do
    if dl "候选 $cand" "$cand"; then OK=1; break; fi
  done
  [ "$OK" = 1 ] || fail "所有下载源都不可达，请检查网络重试: $ROOTFS_URL"
fi

# ---- 4) 解压到 rootfs（docker export 的 tar 根即 /, 直接展开到 $ROOTFS_DIR）----
if [ ! -f "$ROOTFS_DIR/etc/os-release" ]; then
  [ -s "$ROOTFS_TAR" ] || fail "rootfs.tar.xz 不存在或为空，请重新下载"
  say "解压 rootfs（需要几分钟）…"
  mkdir -p "$ROOTFS_DIR"
  xz -dkc "$ROOTFS_TAR" | tar -x -C "$ROOTFS_DIR" || fail "解压失败"
fi

# ---- 5) 安装 proot（Termux 官方源, CA 已导出）----
if ! command -v proot >/dev/null 2>&1; then
  say "安装 proot …"
  apt-get update -qq && apt-get install -y proot || {
    # 备选: pkg 是同名封装, 部分版本无 apt-get 直装
    command -v pkg >/dev/null 2>&1 && pkg install -y proot || fail "proot 安装失败"
  }
fi
command -v proot >/dev/null 2>&1 || fail "proot 不可用"

# ---- 6) 幂等体检 ----
say "体检: rootfs / proot …"
[ -f "$ROOTFS_DIR/etc/os-release" ] || fail "rootfs 缺少 /etc/os-release"
[ -x "$PREFIX/bin/proot" ] || fail "proot 不可执行"
grep -qs 'ubuntu' "$ROOTFS_DIR/etc/os-release" 2>/dev/null || true   # 提示性, 不强校验
command -v bash >/dev/null 2>&1 || true

# ---- 7) 后台启动 proot 容器（容器内 start-qqrobot.sh 自带 Xvfb/QQ/node 常驻循环）----
if ! pgrep -f "proot.*$ROOTFS_DIR" >/dev/null 2>&1; then
  say "启动 QQ 机器人容器（日志: logs/qqrobot.log）…"
  mkdir -p "$LOG_DIR" "$FILES/tmp"
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

# ---- 8) 标记就绪, 打开面板 ----
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