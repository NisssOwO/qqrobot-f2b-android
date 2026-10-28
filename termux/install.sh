#!/bin/bash
# QQ聊天机器人 · Termux 一键安装（免 root，用 udocker 加载镜像）
#
# 用法: bash install.sh
# 前置: pkg install -y proot python curl git tar xz-utils
#
# 做了什么:
#   1. 校验/安装依赖（proot、python、curl、GNU tar、xz）
#   2. pip 安装 udocker
#   3. 下载 udockertools（经 GitHub 镜像，官方源国内常不通）
#   4. 下载 qqrobot 镜像 tar.xz（经 GitHub 镜像），校验 sha256
#   5. udocker load 导入镜像，建一个数据目录
#
# 数据目录: $HOME/qqrobot-data （config、QQ 登录态、NapCat 配置都在这）
set -eu

VERSION="${QQROBOT_VERSION:-0.2.8}"
REPO="${QQROBOT_REPO:-NisssOwO/qqrobot-f2b-android}"
PROXY="${QQROBOT_PROXY:-https://gh-proxy.com/}"
DATA_DIR="${QQROBOT_DATA_DIR:-$HOME/qqrobot-data}"
DOWNLOAD_DIR="${TMPDIR:-/tmp}/qqrobot-dl"

say()  { printf '\033[1;36m[qqrobot]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[qqrobot]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[qqrobot] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. 环境检查 ------------------------------------------------------------
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] || die "这不是 Termux 环境（PREFIX 未设置）。桌面环境请用 docker load。"

# udocker 自带的 proot/curl 是给普通 Linux 的，在 Android 上不可用；不指定这三个
# 变量时 udocker 会报 "installation of udockertools failed" 并拒绝执行任何命令。
export UDOCKER_USE_PROOT_EXECUTABLE="${UDOCKER_USE_PROOT_EXECUTABLE:-$PREFIX/bin/proot}"
export UDOCKER_USE_CURL_EXECUTABLE="${UDOCKER_USE_CURL_EXECUTABLE:-$PREFIX/bin/curl}"
export UDOCKER_DIR="${UDOCKER_DIR:-$HOME/.udocker}"

# udocker 先在 Config.conf["root_path"] 里查找外部命令，默认
# "/usr/sbin:/sbin:/usr/bin:/bin"。Android 上 /bin/tar 是 toybox 的软链，它
# 不认识 --delay-directory-restore 等 GNU 参数，于是 load 阶段解压直接失败，
# 只留下一句 "Error: failed to extract container"。把 root_path 指到 Termux
# 自己的 bin，udocker 才会用到真正的 GNU tar。
# 用户配置只读 [DEFAULT] 段，写成别的段落不会生效。
mkdir -p "$UDOCKER_DIR"
if ! grep -qs '^root_path' "$UDOCKER_DIR/udocker.conf" 2>/dev/null; then
  cat > "$UDOCKER_DIR/udocker.conf" <<EOF
[DEFAULT]
root_path = $PREFIX/bin
EOF
fi

say "版本 $VERSION  数据目录 $DATA_DIR"

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) die "当前只提供 arm64 镜像（检测到 $(uname -m)）" ;;
esac

# --- 1. 依赖 ----------------------------------------------------------------
say "检查依赖…"
MISSING=""
for bin in proot python curl tar xz sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || MISSING="$MISSING $bin"
done
if [ -n "$MISSING" ]; then
  say "安装缺失依赖:$MISSING"
  pkg install -y proot python curl tar xz-utils coreutils || die "pkg install 失败，请手动执行: pkg install -y proot python curl tar xz-utils"
fi

# udocker 解压镜像层依赖 GNU tar；toybox 的 tar 会报
# "Error: while extracting image layer"
if tar --version 2>/dev/null | grep -qi toybox; then
  warn "当前 tar 是 toybox，udocker 会解压失败，正在安装 GNU tar…"
  pkg install -y tar || die "安装 GNU tar 失败"
fi
tar --version 2>/dev/null | grep -qi 'GNU tar' || die "tar 不是 GNU tar，udocker 无法解压镜像层"

# --- 2. udocker -------------------------------------------------------------
if ! command -v udocker >/dev/null 2>&1; then
  say "安装 udocker…"
  pip install --no-cache-dir udocker || die "pip install udocker 失败"
fi
say "udocker: $(udocker --version 2>/dev/null | head -1)"

# 3. 运行期工具包（官方源 download.a.incd.pt 在部分网络不可达）
mkdir -p "$DOWNLOAD_DIR"
if [ ! -d "$HOME/.udocker/bin" ] || [ -z "$(ls -A "$HOME/.udocker/bin" 2>/dev/null)" ]; then
  ENG_URL="${PROXY}https://raw.githubusercontent.com/jorge-lip/udocker-builds/master/tarballs/udocker-englib-1.2.11.tar.gz"
  say "下载 udocker 运行工具包…"
  curl -fL --retry 3 --retry-delay 2 -o "$DOWNLOAD_DIR/udt.tar.gz" "$ENG_URL" \
    || die "下载 udockertools 失败，检查网络或设置 QQROBOT_PROXY"
  UDOCKER_TARBALL="$DOWNLOAD_DIR/udt.tar.gz" udocker install || die "udocker install 失败"
fi

# --- 4. 镜像 ----------------------------------------------------------------
mkdir -p "$DATA_DIR"
IMG_XZ="$DOWNLOAD_DIR/qqrobot-arm64.tar.xz"
IMG_TAR="$DOWNLOAD_DIR/qqrobot-arm64.tar"

if udocker images 2>/dev/null | grep -q "qqrobot:${VERSION}"; then
  say "镜像 qqrobot:${VERSION} 已存在，跳过下载"
else
  BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
  ok=0
  # 预置镜像优先：用 adb push 或 U 盘拷进来的文件，没网也能装。有校验文件就必须匹配。
  if [ -s "$IMG_XZ" ]; then
    if [ ! -f "$IMG_XZ.sha256" ] || ( cd "$DOWNLOAD_DIR" && sha256sum -c "$(basename "$IMG_XZ").sha256" >/dev/null 2>&1 ); then
      say "使用已下载的镜像，跳过下载"
      ok=1
    else
      warn "本地镜像校验不通过，重新下载"
      rm -f "$IMG_XZ"
    fi
  fi
  if [ "$ok" != 1 ]; then
    say "下载镜像（约 400–600MB，视网络可能需要几分钟）…"
    for prefix in "$PROXY" ""; do
      url="${prefix}${BASE}/qqrobot-arm64.tar.xz"
      say "  尝试 $url"
      if curl -fL --retry 2 --retry-delay 3 -C - -o "$IMG_XZ" "$url"; then ok=1; break; fi
      rm -f "$IMG_XZ"
    done
  fi
  [ "$ok" = 1 ] || die "下载镜像失败。可换镜像: QQROBOT_PROXY=https://ghproxy.net/ bash install.sh"

  # 校验
  if curl -fsL -o "$IMG_XZ.sha256" "${PROXY}${BASE}/qqrobot-arm64.tar.xz.sha256" 2>/dev/null; then
    expect="$(awk '{print $1}' "$IMG_XZ.sha256")"
    actual="$(sha256sum "$IMG_XZ" | awk '{print $1}')"
    if [ "$expect" != "$actual" ]; then
      rm -f "$IMG_XZ"; die "镜像校验失败（期望 $expect，实际 $actual）"
    fi
    say "sha256 校验通过"
  else
    warn "未取到校验文件，跳过校验"
  fi

  say "解压…"
  xz -dkf "$IMG_XZ"
  say "导入 udocker…"
  udocker load -i "$IMG_TAR" || die "udocker load 失败"

  # udocker 1.3.17 的 load 只写悬空软链接 layers/<id>.layer -> ../<sha>.tar，
  # 那个 tar 从不落盘，于是 create 永远报 "getting layers or json"。
  # 镜像包里真实层数据是顶层 <sha>.tar，这里按 <id>/layer.tar 的链接补成真文件。
  say "修复镜像层（udocker 1.3.17 的已知缺陷）…"
  LAYER_TMP="$TMPDIR/qqrobot-layers"
  rm -rf "$LAYER_TMP"
  mkdir -p "$LAYER_TMP"
  tar -xf "$IMG_TAR" -C "$LAYER_TMP" || die "解压镜像层失败"
  layer_count=0
  for d in "$LAYER_TMP"/*/; do
    [ -d "$d" ] || continue
    hex="${d%/}"
    hex="${hex##*/}"
    [ -e "$d/layer.tar" ] || continue
    tgt="$(readlink "$d/layer.tar" 2>/dev/null || true)"
    if [ -n "$tgt" ]; then
      src="$LAYER_TMP/${tgt#../}"
    else
      src="$d/layer.tar"
    fi
    [ -f "$src" ] || src="$LAYER_TMP/${tgt##*/}"
    if [ -f "$src" ]; then
      rm -f "$HOME/.udocker/layers/$hex.layer"
      cp "$src" "$HOME/.udocker/layers/$hex.layer" && layer_count=$((layer_count + 1))
    fi
  done
  rm -rf "$LAYER_TMP"
  say "  补回 $layer_count 个层文件"
  [ "$layer_count" -gt 0 ] || die "没能从镜像包里取出层文件，打包方式可能变了"

  # localrepo 的 v1 分支要求 repository 目录里每个 <id>.layer 都在，
  # 这里把它们指向刚补好的真实文件。
  IMG_REPO="$(ls -dt "$HOME/.udocker/repos"/*/qqrobot/"$VERSION" 2>/dev/null | head -1)"
  if [ -n "$IMG_REPO" ] && [ -f "$IMG_REPO/ancestry" ]; then
    for id in $(tr -d '[]",' < "$IMG_REPO/ancestry" | tr ' ' '\n' | grep -v '^$'); do
      if [ -f "$HOME/.udocker/layers/$id.layer" ]; then
        ln -sf "$HOME/.udocker/layers/$id.layer" "$IMG_REPO/$id.layer"
      fi
    done
  fi
fi

# --- 5. 建容器（不启动） -----------------------------------------------------
# 注意: udocker ps 不支持 -a/-l，直接 ps 列出全部容器（含已停止）
if udocker ps 2>/dev/null | grep -q 'qqrobot'; then
  say "容器已存在，跳过创建"
else
  # 镜像名取决于打包方式：可能是 qqrobot:0.2.2、docker.io/library/qqrobot:0.2.2
  # 或 localhost/qqrobot:0.2.2。直接问 udocker 实际导入了什么，别猜。
  # udocker prints only the REPOSITORY column, and the loader may store the name
  # with a registry prefix, so match on the ":<version>" suffix instead of
  # assuming a repository/tag column split.
  IMG_REF="$(udocker images 2>/dev/null | awk -v v="$VERSION" 'NR>1 { n = split($1, p, ":"); if (n == 2 && p[2] == v) { print $1; exit } }')"
  [ -n "$IMG_REF" ] || IMG_REF="qqrobot:${VERSION}"
  say "用镜像 $IMG_REF 建容器"
  udocker create --name=qqrobot "$IMG_REF" || die "udocker create 失败"
fi

say ""
say "安装完成 ✔"
say "  镜像: qqrobot:${VERSION}"
say "  数据: $DATA_DIR"
say "        （配置、QQ 登录态、模型 Key 都在这里，别删）"
say ""
say "接下来三步："
say ""
say "  1) 启动"
say "       QQROBOT_PASSWORD='换成你的口令' QQROBOT_BIND=0.0.0.0 bash start.sh"
say "     只给手机自己用就不加这两个变量，直接 bash start.sh 即可"
say ""
say "  2) 打开面板"
say "     手机浏览器访问 http://127.0.0.1:38121"
say "     同一个 WiFi 下，电脑也可以访问 http://<手机局域网IP>:38121"
say ""
say "  3) 扫码登录"
say "     页面顶部「开始使用」里就是二维码，用手机 QQ 扫它并确认。"
say "     登录成功后，去群里发一句「@机器人 你好」，几秒内会收到回复。"
say ""
say "常用命令："
say "  bash status.sh    看服务、面板和登录态"
say "  bash stop.sh      停止"
say "  bash start.sh     再次启动（已在运行时会跳过）"
say ""
say "建议：系统设置里把 Termux 的省电策略设为「无限制」，"
say "      否则锁屏久了可能被系统冻结；通知栏的 Termux 常驻通知不要划掉。"
say ""
say "完整说明见同目录的 RUNBOOK.md。"