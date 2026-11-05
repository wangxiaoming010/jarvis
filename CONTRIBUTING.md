# 参与开发

欢迎通过 Issue 讨论问题，或提交 Pull Request。先阅读 [README](README.md) 和[架构说明](docs/architecture.md)，说明具体使用场景和预期行为。

## 本地环境

需要 Node.js 22.18 或更高版本及 npm。桌面窗口和安装包还需要 Rust 与 [Tauri 前置工具链](https://v2.tauri.app/start/prerequisites/)。自动化测试不需要模型 Key 或本地 Agent 登录。

```sh
npm ci
npm run dev
```

`npm run desktop` 启动 Tauri 桌面开发窗口。首次配置模型及本地执行工具见 [README](README.md#快速开始)。

## 提交前检查

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run release:check
```

CI 在 Linux 上执行上述源码与浏览器检查。macOS 桌面打包、签名、公证和真实模型调用由维护者另行验证，不能以 CI 通过代替。

修改 UI 协议后运行 `npm run generate:ui`，一同提交 Schema、组件目录和生成的 TypeScript。生成结果提交前应没有额外差异。修改数据库时新增迁移，保留历史迁移，并验证旧数据升级。迁移代码位于 `apps/server/migrations/`。

改动说明请写清问题、最终行为和验证结果；有界面变化时附截图。涉及 Bot 注意力、委托、停止或恢复时，说明对现有任务和数据的影响。

## 专项验证

以下两项不调用模型：

```sh
npm run build:runtime
node scripts/smoke/embedded-runtime.mjs
node --import tsx scripts/smoke/ui.mjs
```

第一项验证内置后台的独立启动、Bridge 连接、持久化和退出恢复；第二项在前端构建后检查生产资源的 CSP 与卡片交互，包含旧路由兼容场景。

以下脚本会使用已配置的模型或本机 Agent，可能产生费用；请自行选择运行。它们使用临时资源，不向日常群组发送消息，原生会话仍可能保存在 CLI 历史中。

| 命令（前缀为 `node --import tsx`）   | 验证内容                          |
| ------------------------------------ | --------------------------------- |
| `scripts/smoke/attention.mjs --live` | 真实注意力判断                    |
| `scripts/smoke/social.mjs --live`    | 主会话日常交流                    |
| `scripts/smoke/coordinator.mjs`      | 主会话、只读 Worker 与证据验收    |
| `scripts/smoke/claude.mjs`           | Claude 执行、续接与混合 Provider  |
| `scripts/smoke/native.mjs`           | Claude 原生提问及临时文件写入审批 |

## 数据和许可

不要提交 `.env`、数据库、聊天记录、模型配置、证书、凭据、运行日志或构建产物。Issue、截图和日志片段也需要移除 Key、令牌、个人路径和聊天内容。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

新增依赖或移植代码时保留原许可与来源，更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。提交的原创贡献按项目 [MIT 许可证](LICENSE) 发布。
