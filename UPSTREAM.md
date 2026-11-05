# Personal OpenBot Group

**简体中文** | [English](README.en.md)

在自己的电脑上，和一群有记忆、能做事的 Bot 一起工作。

Personal OpenBot Group 是一个 AI 协作桌面应用。你可以给 Bot 设定不同的角色，与它们私聊，或把它们邀请到同一个群里，从讨论想法到执行任务，再到检查结果，都在对话中完成。

## 让协作持续下去

每个 Bot 都有自己的记忆和任务。它能在私聊和群聊之间延续上下文，保留偏好、决定和工作经验；在群里，则根据话题和其他成员的发言判断是否参与。你也可以直接 @ 它，让它接手一件事。

对话模型负责理解需求、安排工作和检查结果，连接到本机的 Codex 或 Claude Code 负责读写文件、执行命令和访问网页。多个 Bot 可以委托、交付和复核任务，你可以查看进度、补充要求，或停止执行。任务及其后续处理会保留在原有会话中。

关闭窗口后，应用会留在菜单栏或托盘中继续运行，直到你明确退出。

## 快速开始

从 [GitHub Releases](https://github.com/bug-origin/Personal-OpenBot-Group/releases) 下载安装包。目前提供并验证的是 **macOS Apple Silicon** 版本。

首次使用需要准备对话模型的 API Key，以及已安装并登录的 **Codex CLI 或 Claude Code**。安装包已包含应用运行环境。

1. 在「设置」中选择模型服务、填写 API Key，并选择主会话模型。
2. 创建 Bot，填写名称与角色，选择 Codex 或 Claude Code 作为执行工具。
3. 开始私聊，或创建群组并邀请 Bot 加入。

支持 DeepSeek、OpenAI、Anthropic、Gemini、通义千问、Moonshot、智谱及其他 OpenAI 兼容服务。注意力判断默认使用主会话模型，也可以单独配置。

## 在本机运行

聊天、记忆和任务保存在本机，对话内容会发送给你配置的模型服务。本地执行沿用 Codex / Claude Code 的配置和登录状态，文件与命令操作遵循对应工具的权限机制。

当前面向单人在单台电脑上使用。数据位置、备份及连接问题见[故障排查与数据恢复](docs/troubleshooting.md)，安全边界见[安全说明](SECURITY.md)。

## 参与开发

源码运行需要 **Node.js 22.18+** 和 npm；桌面窗口还需要 Rust 与 [Tauri 前置工具链](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run desktop
```

仅在浏览器中开发可运行 `npm run dev`。模型可在应用设置中配置，环境变量见 [.env.example](.env.example)。

界面使用 React 与 Tauri，本地服务使用 Fastify 与 SQLite，Bridge 连接本机执行工具。进一步了解[整体架构](docs/architecture.md)、[贡献指南](CONTRIBUTING.md)或[构建与发布](docs/releasing.md)，其余说明见[文档索引](docs/README.md)。

项目采用 [MIT License](LICENSE)，第三方代码与依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
