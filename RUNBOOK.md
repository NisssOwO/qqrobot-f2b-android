# QQ聊天机器人 · 容器版运行手册

一个跑在手机上的 QQ 机器人：容器里装着 **Ubuntu 24.04 + Node 24 + NapCat + QQ 客户端 + 管理面板**，用 proot 在 Termux 里免 root 运行。

- 面板：`http://<手机局域网IP>:38121`
- 扫码登录、发消息、改白名单、切模型都在面板里做，不需要 adb。

---

## 1. 手机上装一遍（Termux）

```bash
# 1) 基础工具（tar 必须是 GNU tar，toybox 的不能解 docker 层）
pkg update -y && pkg install -y proot python curl tar xz-utils coreutils

# 2) 验证 tar
tar --version | head -1        # 必须出现 "GNU tar"

# 3) 装 udocker（不需要 root，不需要 docker 守护进程）
pkg install -y udocker

# 4) 装 udocker 的运行期工具包（走镜像站，约 44MB）
curl -fL -o "$TMPDIR/udt.tar.gz" \
  https://gh-proxy.com/https://raw.githubusercontent.com/jorge-lip/udocker-builds/master/tarballs/udocker-englib-1.2.11.tar.gz
UDOCKER_TARBALL="$TMPDIR/udt.tar.gz" udocker install

# 5) 让 udocker 用 Termux 自己的 proot 和 curl（否则它会找到 /system/bin 里坏掉的 curl）
cat >> ~/.bashrc <<'EOF'
export UDOCKER_USE_PROOT_EXECUTABLE=$PREFIX/bin/proot
export UDOCKER_USE_CURL_EXECUTABLE=$PREFIX/bin/curl
export UDOCKER_DIR=$HOME/.udocker
EOF
```

一键脚本（在 `termux/` 目录里）：

```bash
bash install.sh      # 自动完成上面 1-5，再下载镜像 tar.xz 并导入
bash start.sh        # 启动（默认只听 127.0.0.1）
bash status.sh       # 看进程/端口/HTTP 状态
bash stop.sh         # 停止
bash boot.sh install # 开机自启（需要 Termux:Boot 插件）
```

## 2. 启动

```bash
# 只本机访问（默认，不需要口令）
bash start.sh

# 局域网访问（必须设口令，至少 8 位）
QQROBOT_PASSWORD='你的口令' QQROBOT_BIND=0.0.0.0 bash start.sh
```

手动等价命令：

```bash
udocker run --rm --name=qqrobot \
  --env=QQROBOT_BIND=0.0.0.0 \
  --env=QQROBOT_PORT=38121 \
  --env=QQROBOT_PASSWORD='你的口令' \
  --env=QQ_ACCOUNT=3836367204 \
  --env=GROUP_ALLOW=620765931 \
  --volume="$HOME/qqrobot-data:/data" \
  qqrobot:0.2.1
```

> proot 模式共享手机的网络栈，**没有 `-p` 端口映射**。容器里监听 `0.0.0.0:38121` 就是手机在监听 38121。

桌面 / 服务器（有 Docker，不需要 Termux）：

```bash
sha256sum -c qqrobot-arm64.tar.xz.sha256
xz -dk qqrobot-arm64.tar.xz
docker load -i qqrobot-arm64.tar
docker run -d --name qqrobot \
  -e QQROBOT_BIND=0.0.0.0 -e QQROBOT_PASSWORD='至少8位口令' \
  -e QQ_ACCOUNT=3836367204 -e GROUP_ALLOW=620765931 \
  -p 38121:38121 -v "$PWD/qqrobot-data:/data" \
  --restart unless-stopped qqrobot:0.2.1
```

桌面 Docker 有真正的端口映射（`-p`）；手机 proot 没有，容器里监听就是手机在监听。

## 3. 首次登录

1. 浏览器打开 `http://<手机IP>:38121`，输入口令（用户名留空即可）。
2. 找到「登录 QQ」区块，等二维码出现（QQ 启动约需 20–40 秒）。
3. 手机 QQ 扫码 → 确认登录。
4. 页面上「网关 ready · 已登录」出现即成功；二维码会自动隐藏。

二维码过期就点「获取新二维码」：它会重启 QQ 并重新出码，约 30–60 秒，期间面板会短暂断开。

**注意**：QQ 进程重启后登录态可能失效（腾讯的快速登录有时要求手 Q 验证），需要重新扫码。所以 `stop.sh` 之后重新 `start.sh` 可能需要再扫一次。

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QQ_ACCOUNT` | `3836367204` | 机器人 QQ 号 |
| `GROUP_ALLOW` | `620765931` | 允许的群号（逗号分隔） |
| `QQROBOT_BIND` | `127.0.0.1` | 面板监听地址，设 `0.0.0.0` 才能被局域网访问 |
| `QQROBOT_PORT` | `38121` | 面板端口 |
| `QQROBOT_PASSWORD` | 空 | 面板登录口令；`BIND=0.0.0.0` 时必填且 ≥ 8 位 |
| `QQROBOT_DATA_DIR` | `/data` | 容器内数据目录（映射到宿主的 `$HOME/qqrobot-data`） |
| `QQROBOT_SKIP_QQ` | 空 | 设 `1` 只启动面板、不启动 QQ（调试/冒烟测试用） |

## 5. 数据都在哪

宿主 `$HOME/qqrobot-data/`：

| 路径 | 内容 |
| --- | --- |
| `config.json` | 机器人配置（白名单、角色、网关地址） |
| `napcat-config/` | NapCat 配置（含 OneBot token、WebUI token） |
| `qq-user-data/` | QQ 客户端自己的数据（登录态在这里） |
| `onebot-token.txt` | 后端与 NapCat 之间的握手令牌 |
| `standalone/` | 运行日志、计数器、模型诊断 |

**换手机/重装只要把整个 `qqrobot-data` 拷过去**，登录态也在里面（但 QQ 可能仍要求重新验证）。

## 6. 常见问题

**`udocker create` 报 `while extracting image layer`**
→ `tar` 不是 GNU tar。`pkg install -y tar`，确认 `tar --version` 出现 "GNU tar 1.35"。

**`udocker pull` 报 `Error: in download` 或 `image not found`**
→ udocker 用了 `/system/bin/curl`。设 `export UDOCKER_USE_CURL_EXECUTABLE=$PREFIX/bin/curl`。

**`udocker pull` 报 `no image found for platform (android/arm64)`**
→ 拉取时加 `--platform=linux/arm64`。

**面板打得开但没有二维码**
→ QQ 还没启动完（等 40 秒）；或 QQ 崩了，看 `qqrobot-data/standalone/service.log` 和容器输出。

**面板显示「已登录」但群里 @ 没反应**
→ 看 `napcat-config/onebot11_<QQ号>.json` 的 `port` 是否为 3001，`path` 是否为空字符串。多一个字段、少一个 `path` 都会让 3001 不监听。

**端口被占**
→ 上次没退干净：`bash stop.sh`，或 `udocker ps` 找容器后 `udocker rm -f <ID>`。

**手机锁屏后机器人不响应**
→ Termux 需要 `termux-wake-lock`（`start.sh` 已自动设置），并在系统设置里关掉 Termux 的电池优化。

**`udocker create` 报 `getting layers or json`**
→ udocker 1.3.17 的 `load` 只写悬空软链接 `layers/<id>.layer -> ../<sha>.tar`，那个 tar 从不落盘。`install.sh` 现在会在 `load` 之后自动把真实层数据从镜像包里的 `<sha>.tar` 补成文件、并给 repository 目录重建软链接；如果你手动跑过 `udocker load`，删掉容器重新执行 `bash install.sh` 即可。

**`udocker run` 报 `invalid host volume path: /tmp/udocker-...`**
→ `TMPDIR` 没设。Android 上没有 `/tmp`，udocker 却默认往那儿写绑定文件。`start.sh` 已经导出 `TMPDIR=$PREFIX/tmp`；手动跑 udocker 时要自己 `export TMPDIR="$PREFIX/tmp"`。

**QQ 进程反复 `Trace/breakpoint trap` 退出（SIGTRAP）**
→ 已知问题。QQ 会在登录后一段时间内偶发崩溃，`start.sh` 的看门狗会在 30 秒内重启它并重新等 3001；重启后**可能需要重新扫码**（腾讯会拒绝无感快速登录）。如果崩溃变成高频循环，先 `bash stop.sh`，再 `bash start.sh`，让 Xvfb 和 QQ 一起重建。

**面板提示「页面凭据失效，请刷新」**
→ 面板的 `x-lab-token` 现在存盘复用（`qqrobot-data/.runtime/panel-token`），正常重启不会失效。仍看到这个提示时按一次 F5 即可；如果频繁出现，说明后端在反复重启，去看 `qqrobot-data/.runtime/service.log`。

## 7. 安全

- 面板只在 `QQROBOT_BIND=0.0.0.0` 时对外，且强制要求口令；口令用 Basic 认证，明文传输，**只在信任的局域网里用**。
- 面板会拒绝来自公网 IP 的请求（Host 头必须匹配本机/局域网地址）。
- 容器内的网络守卫（`network-guard.cjs`）只允许监听 loopback/局域网通配地址、只允许出站到 loopback 与显式登记的模型端点。
- 镜像里不含任何凭据：OneBot token 首次启动随机生成，WebUI token 也是随机的。

## 8. 面板里的其它功能

- **消息投递**：模拟一条消息走完整流程，不碰 QQ。
- **真实文字模型**：填 OpenAI 兼容端点 + Key，可以试聊；保存后机器人才会用真模型回复。

  已实测可用的组合：

  | 服务 | baseUrl | 模型名 |
  |---|---|---|
  | 阿里云百炼（DashScope 兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `deepseek-v4.1-flash`、`qwen-plus` |
  | DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-chat` |

  阿里云的 `ws-*.maas.aliyuncs.com`「工作区专属端点」在公网直连时会返回 `Workspace endpoint access denied`，换用上面的 DashScope 兼容端点即可（同一把 key 通常能通用）。

  Key 存在 `qqrobot-data/model-config.json`，面板接口不回显；备份导出也不会带上它。
- **白名单与身份**：私聊/群聊允许与拒绝名单、是否必须 @。
- **静默时段**：按工作日/非工作日设置不回复的时间窗。
- **私有备份与恢复**：导出/导入配置与对话记录（不含密钥）。

## 9. 升级

```bash
bash stop.sh
QQROBOT_VERSION=0.3.0 bash install.sh   # 新版会再下一份镜像，旧版留着可回退
QQROBOT_PASSWORD='你的口令' bash start.sh
```

`$HOME/qqrobot-data` 里的配置、白名单、登录态都不动；模型密钥也在里面（`standalone/model-config.json`），升级后不用重填。

回退：`QQROBOT_VERSION=0.2.0 bash start.sh`（旧镜像还在 `udocker images` 里）。
