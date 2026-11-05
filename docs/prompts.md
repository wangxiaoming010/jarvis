# 提示词与工具定义

运行时以源码中的模板和 Schema 为准。本文记录入口和职责；不再维护整份提示词与工具参数的手工副本。

## 默认消息链路

| 环节           | 源码                                                                                             | 职责                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 共同性格       | [persona.ts](../packages/shared/src/persona.ts) 的 `botPersona`                                  | 所有 Bot 共用的性格、工作主线和表达原则；主会话与 Worker 都以它开头                   |
| 注意力         | [attention-model.ts](../apps/server/src/models/attention-model.ts) 的 `attentionInstructions`    | 只返回是否唤醒，不执行工具；私聊、直接提及、人类回复及本人的任务事件跳过判断          |
| Bot 主会话     | [bot-prompt.ts](../apps/server/src/bot/bot-prompt.ts) 的 `coordinatorInstructions`               | 按“性格 → 对话职责 → 当前事件 → 相关规则”分层组装；进行中工作的验收与交付规则按需加入 |
| 主会话上下文   | [bot-coordinator.ts](../apps/server/src/bot/bot-coordinator.ts) 的 `context`                     | 长期偏好、历史记忆、成员关系、目标与任务等运行时数据                                  |
| 记忆整理       | [memory-curator.ts](../apps/server/src/memory/memory-curator.ts) 的 `memoryCurationInstructions` | 后台整理人类消息中的长期偏好和事实；与是否回复无关，不发言、不执行                    |
| 工具定义       | [coordinator-model.ts](../apps/server/src/models/coordinator-model.ts) 的 `coordinatorTools`     | 调度工具说明、模型请求和返回校验                                                      |
| 目标与交付参数 | [work-schemas.ts](../apps/server/src/work/work-schemas.ts) 的 `ownershipSchemas`                 | 目标、项目事实和交付物工具的参数；转换为模型使用的 JSON Schema                        |
| 工作区工具参数 | [workspace-tool-schemas.ts](../apps/server/src/bot/workspace-tool-schemas.ts)                    | 群组、成员、资料、消息和实时查询；同一份定义用于模型 Schema 和执行校验                |
| Worker 规则    | [instructions.ts](../apps/bridge/src/instructions.ts) 的 `botInstructions`                       | 当前执行身份、资源模式、版本化事实及验证输入                                          |
| Worker 正文    | [prompt.ts](../apps/bridge/src/prompt.ts)                                                        | 初始要求、引用与会话续接增量                                                          |
| 交互卡片       | [prompt.ts](../packages/shared/src/ui/prompt.ts) 的 `uiCapabilityInstructions`                   | Bot 与 Worker 共用的声明式 UI 规则                                                    |

注意力模型独立调用；主会话拥有调度工具；Worker 使用本机 Agent 执行。模型服务和 Bot 职责来自本机配置，不写入仓库模板。

主会话判断没有有用贡献时可单独调用 `stay_silent`，平台直接完成当前事件，不再要求模型生成结束语。此操作不取消任务，也不能跳过待验收执行。`conversation-output.ts` 为已知的纯静默旁白提供保守的发布兜底，普通正文发布及 `send_message` 共用；原始聊天记录仍保留，不将这类错误输出作为近期对话示例。

## 输入与权限

新增工作区工具的用途与访问规则见 [Bot 工作区工具](bot-tools.md)。Bot 可调用 `list_tools` 检索实际可调用工具和参数。群组／自身资料变更和显式转发需要当前所有者要求；目录查询不自动授予消息访问权限。

消息、记忆、Worker 结果和其他 Bot 的请求都是待判断的材料，不能授予本机权限。工具参数通过平台校验，文件与命令执行遵守原生 Agent 的授权流程。提示词本身不能替代访问控制或执行隔离。

完整历史保存在 SQLite 中，模型请求只带近期上下文、相关的本人跨对话历史和按需读取的记录。`bot-conversations.ts` 校验本人当前成员归属，提供 `get_self`、`list_conversations`、`get_conversation`、`search_messages`、`read_conversation`、`read_message` 和 `send_message`；当前窗口不是知识或沟通能力的边界。`remember` 可以引用任何可访问对话中的来源消息，`recall_memory` 可检索本人跨对话记忆。读取不会自动广播，其他 Bot 的私聊和未加入的群不可访问。恢复 Worker 时按已确认的要求游标发送增量，避免重复执行旧指令。详见[持续工作架构](super-agent.md)。

上下文压缩由 `bot-context.ts` 在模型调用前自动触发，摘要规则位于 `coordinator-model.ts` 的 `contextSummaryInstructions`，整理调用不提供工具。主会话通过 `read_context` 引用回查原始工具收据与不可变上下文快照。摘要属于待核实的工作上下文，不自动写入 BotMemory，也不充当所有者新指令或验收证据。

## 修改与验证

修改规则时直接修改对应源码，行为变化补充相应测试。注意力见 `tests/server/attention.test.ts`，协调与任务见 `tests/server/coordinator.test.ts`、`tests/server/durable-work.test.ts` 和 `tests/server/work-ownership.test.ts`，Worker 协议见 `tests/bridge/codex.test.ts`、`tests/bridge/claude.test.ts` 和 `tests/bridge/native-adapters.test.ts`。

```sh
npm run typecheck
npm test
```

模型措辞和行为还需要显式的真实模型验证；确定性测试不证明所有模型都会遵循模板。可运行的真实验证脚本见[贡献指南](../CONTRIBUTING.md)。
