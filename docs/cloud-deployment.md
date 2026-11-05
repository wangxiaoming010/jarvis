# 通过 SSH 私有部署 Jarvis

把云端工作台部署在独立目录，通过 SSH 转发访问，由 Mac 专用工作区执行任务。本指南不开放公网应用端口，不修改既有网站配置。手机访问需要另行配置可用的 SSH 转发客户端并验收。

## 先核对服务器

准备能登录服务器的 SSH 账号或已配置的 Host 别名。不要把密码、私钥或模型 Key 发到聊天中。首次连接时，使用阿里云控制台提供的信息核对服务器 host key，不关闭 `StrictHostKeyChecking`。

登录后先只读检查服务、端口、空间和运行环境。

```bash
ss -lntp
systemctl --type=service --state=running
free -h
df -h
node --version
npm --version
```

确认 `4321` 未占用。若已占用，选择另一个未用端口，并在 cloud 启动参数、SSH 转发和 Mac 的 `JARVIS_CLOUD_ORIGIN` 中保持一致。需要 Node.js 22.18 或更高版本。不要为本项目替换其他业务共用的 Node 或服务配置。

## 在独立目录准备云端

下面命令在事先准备好的、当前账号可写的专用部署父目录执行。不要在现有业务目录执行，不使用 `git reset --hard` 覆盖其他代码。

```bash
git clone --branch feature/cloud-mac-control --single-branch https://github.com/wangxiaoming010/jarvis.git jarvis-cloud
cd jarvis-cloud
npm ci
npm run build
npm run cloud:init
npm run cloud:start
```

`cloud:init` 从终端隐藏输入管理员密码。密码至少 16 个字符，不通过命令行参数或环境变量传递。初始化已存在时拒绝覆盖。运行期间保持终端，按 `Ctrl+C` 停止本服务。

默认云端数据保存在这个目录的 `.jarvis-cloud/`。使用固定数据目录时，初始化和启动都传同一个绝对路径。

```bash
npm run cloud:init -- --data-dir /srv/jarvis-state
npm run cloud:start -- --data-dir /srv/jarvis-state --port 4321
```

`/srv/jarvis-state` 只是示例。先由管理员创建独立目录并赋予专用服务账号权限，不把已有目录递归改属主。云端不需要安装 Codex，也不保存模型 Key。

启动后再次运行 `ss -lntp`。只应出现 `127.0.0.1:4321`，不能是 `0.0.0.0:4321`。如果要配置开机启动，先核对本机 Node 可执行文件路径、专用服务账号和数据目录，再单独创建 systemd 单元。本项目不自动改已有 systemd 或 Nginx 配置。

## 在 Mac 建立 SSH 转发

使用已核实的 SSH Host 别名。下面的 `已配置的SSH别名` 需要替换。

```bash
ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:4321:127.0.0.1:4321 \
  已配置的SSH别名
```

若没有 Host 别名，使用 `SSH账号@服务器IP`。保持转发终端运行。在 Mac 浏览器打开 `http://127.0.0.1:4321`，输入 cloud 初始化时的管理员密码。

不要把云端服务绑定到公网地址，也不要为 `4321` 增加公网防火墙规则。此版本的 Cookie 和 HTTP 配置仅适用于受信本机及 SSH 通道，不是公网 HTTPS 方案。

## 配对新的 Mac 工作区

在 Mac 的新项目目录安装和构建同一开发分支，不覆盖正在运行的本地版本。

```bash
npm ci
npm run build
npm run worker:pair
```

在云端页面点击 **生成 Mac 配对码**。将五分钟内有效的一次性码粘贴到 Mac 终端提示中。不要把配对码放进 URL、命令行参数或 Git。

默认通过 `http://127.0.0.1:4321` 配对，新工作区使用 `.jarvis-worker/`。非默认端口或目录时，配对和启动使用相同配置。

```bash
JARVIS_CLOUD_ORIGIN=http://127.0.0.1:4321 \
JARVIS_DATA_DIR=/你的专用绝对目录/jarvis-worker \
npm run worker:pair

JARVIS_CLOUD_ORIGIN=http://127.0.0.1:4321 \
JARVIS_DATA_DIR=/你的专用绝对目录/jarvis-worker \
JARVIS_OPEN=1 npm run worker:start
```

Mac 本地工作台默认监听 `127.0.0.1:4322`。用自动打开的一次性入口登录，在 **设置** 配置模型服务和 Key。Codex CLI 必须在这个 Mac 账号下安装并登录。Claude Code 仍未完成受限执行适配，选择后不能执行，不会替换工具。

## 验收链路

1. 云端显示 **Mac 已连接**，最后同步时间更新。
2. 云端创建员工，再创建一个仅在专用目录内生成无敏感测试文件的任务。
3. 观察派单回执，从等待 Mac 接收到 Mac 已应用。不要把 HTTP 接收成功当成任务完成。
4. 核对任务专用目录别名和权限后批准。Mac 生成结果，云端出现待验收交付物。
5. 检查实际文件，再人工验收。
6. 停止 Mac 执行端。云端显示离线，后续派单只能排队。恢复连接后，检查排队操作只应用一次。
7. 比对部署前后的服务器服务、端口和现有网站可用性，不影响原业务才算部署验收完成。

浏览器中的 `mac-task:任务ID` 是目录别名。真实文件位于 Mac 专用数据目录的 `tasks/任务ID` 下，云端没有任意路径读取或选择功能。

## 撤销、恢复和备份

使用云端 **撤销 Mac 连接** 停止新派单。Mac 观察到撤销或连接租约过期后尝试中止在途工作。没有确认子进程退出时仍须人工核实，不能仅凭离线标记断言已经停止。

忘记云端密码时，先停止 cloud 服务，再在受信服务器终端运行下列命令。使用过自定义数据目录时传入相同 `--data-dir`。

```bash
npm run cloud:reset
```

重置会撤销浏览器会话和设备身份，需要重新配对。执行结果不明的命令不能点击重试来“恢复”，先核实 Mac 当前任务和旧进程，再决定是否创建新的操作。

备份前正常停止服务。分别备份云端 `.jarvis-cloud/` 与 Mac `.jarvis-worker/`，保留 `0700` 目录和 `0600` 文件权限。备份含会话、记忆及凭据，不上传公开仓库。恢复数据库时不要恢复运行中授权并自动执行。回滚代码不等于可任意回滚数据，当前没有跨版本自动数据回滚工具。
