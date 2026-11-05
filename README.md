# jarvis

在自己的 Mac 上创建有角色、有记忆、能接任务的私人数字员工团队。

本项目基于 [bug-origin/Personal-OpenBot-Group](https://github.com/bug-origin/Personal-OpenBot-Group)，保留其 MIT 许可证、版权声明和第三方许可。`jarvis` 是个人定制发行项目，不是 Grok、OpenAI 或原作者的官方产品。

## 当前版本

- 复用上游本地聊天、Bot 角色、记忆、任务委托和交付机制。
- 通过本机 Codex 或 Claude Code 执行授权任务。
- 提供 macOS 双击启动入口，首次运行采用手动审批。
- 不依赖 D-Chat，不接入 Reason Network。

当前多个 Bot 共用一套活跃对话模型配置。按 Bot 分别绑定 DeepSeek、豆包、Kimi 等服务属于后续扩展，不是已完成能力。

## 首次使用

准备一个对话模型服务的 API Key，以及已安装、已登录且版本兼容的 **Codex CLI 或 Claude Code**。

1. 在「设置」中选择模型服务，填写 API Key，并选择或手动填写主会话模型。
2. 创建 Bot，填写名称与角色，选择 Codex 或 Claude Code 作为执行工具。
3. 开始私聊，或创建群组并邀请 Bot 加入。

对话模型服务支持 **DeepSeek、OpenAI、Anthropic、Gemini、通义千问、Moonshot/Kimi、智谱**及**其他 OpenAI 兼容服务**。模型列表来自所选服务的接口；无法获取列表时可手动填写模型 ID。使用的模型需要支持项目所需的工具调用能力。

注意力判断默认使用主会话模型，也可以在设置中单独选择或填写注意力模型 ID。当前两者使用同一服务地址和 API Key，不代表可以给注意力模型单独配置另一家服务商。

对话模型负责理解、沟通和任务安排，Codex 或 Claude Code 负责本机执行。选择 Anthropic 对话模型不等于必须选择 Claude Code；选择 OpenAI 对话模型也不等于只能用 Codex。

配置支持和本地测试不等于所有服务的真实调用均已验收。各服务还需要有效密钥、可用额度、模型权限和网络连通。

### 源码版与桌面安装包

当前 `jarvis` 交付的是源码启动版，仍需 Node.js 与 npm 依赖。仓库保留了将 Node.js、后台、Bridge 和 SQLite 一起打入桌面安装包的构建流程，但尚未产出并验收 `jarvis` 安装包，因此目前不声明「安装包已包含应用运行环境」。

正式桌面包需要单独完成构建、安装、启动验证；Codex CLI 或 Claude Code 及其登录仍由使用者准备。详情见[构建与发布](docs/releasing.md)。

## 在 Mac 上运行

需要 Node.js 22.18 或更新版本，以及已安装并登录的 Codex CLI 或 Claude Code。

```sh
npm ci
bash ./启动jarvis.command
```

浏览器入口为 `http://127.0.0.1:1420`。保持启动终端开启，按 Control+C 停止。

在界面设置中填写你自己的模型 API Key，并选择该账号可用的模型。密钥不需要提交到 GitHub，也不要在 Issue 中粘贴。Codex 登录不等于已开通其他模型的 API。

操作步骤和权限边界见[本地使用说明](本地使用说明.md)。上游的完整安装说明见 [UPSTREAM.md](UPSTREAM.md)，系统结构见[架构文档](docs/architecture.md)。

## 数据与权限

服务只监听本机。聊天、任务、记忆及配置保存在 `.data`。对话上下文会发送到你配置的模型服务，Codex 使用自己的远程服务。

不要输入未经批准的公司代码、聊天、客户信息或凭据。工作目录与只读模式不是完整的系统隔离。Mac 睡眠或关机后，本地任务不能持续运行。

`.env`、`.data`、数据库、日志和依赖目录不进入版本控制。公开源码不意味着公开你的员工记忆或登录信息。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

这些检查不代替真实模型、Codex 任务和跨员工协作的联调验收。

## 许可证

[MIT License](LICENSE)。上游版权信息保留在许可证中，第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
