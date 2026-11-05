# Claude Code 本地接入

安装并配置 Claude Code 后，Bridge 自动检测本机执行能力，Bot 创建时连接可用设备。桌面界面不要求手动选择底层执行工具。Agent 暂不可用时先保留身份，就绪后自动上线。每位 Bot 使用设置页配置的对话模型，独立判断消息、安排执行和验收结果。Claude Code 与 Codex 共用进度查询、停止、独立执行会话和动态卡片能力；同一 Bot 可根据任务在两种 Worker 之间接力。

## 安装与配置

先在本机安装 Claude Code 并运行 `claude auth login`。Bridge 启动时检查 CLI 版本、`auth status` 的实际登录状态和必要受限模式参数。未安装、未登录或接口版本不足时显示不可用原因。

默认从 PATH 查找 `claude`；需要时在项目根 `.env` 配置 `OPENBOT_CLAUDE_PATH=/absolute/path/to/claude`，重启本地 Bridge 生效。沿用 CLI 自身的登录，不需要把 Claude 凭据填写到客户端。`BRAIN_*`、`DEEPSEEK_*` 和 `OPENBOT_*` 等平台变量在启动原生进程前移除，保留 CLI 自身需要的认证配置。

如果 CLI 的认证与模型通过用户 `settings.json` 的环境变量配置，Bridge 仅将认证、服务地址和模型相关白名单变量传给原生进程，进程已有变量优先；支持 `CLAUDE_CONFIG_DIR`。不会加载该文件中的 hooks、插件或密钥辅助程序，也不会把凭据放进命令行参数、群消息或客户端。这样受限模式可以继续使用本机已配置的 Provider。

## 执行方式

使用 [官方非交互 CLI](https://code.claude.com/docs/en/headless) 的 stream-json 输入输出，转发文本进度、Read / Glob / Grep 工具活动及完整最终结果。隐藏推理、子 Agent 的文本和环境配置不回传到群聊。

新工作指定独立会话 ID；继续同一件工作时 `--resume` 精确恢复该 ID，只发送尚未确认的新要求。会话确认与输入确认分开，恢复到其他会话、无最终结果、无效协议或进程提前退出都会报错，不把中间汇报当完成结果。会话由 Claude Code 自己持久保存，OpenBot 保存任务与会话映射。

取消先 SIGINT，让原生会话有机会记录中断；未退出时按时限终止该进程组。Bridge 等真实进程退出后才把 Bot 交给下一项工作。显式总时长限制仍使用 `OPENBOT_TASK_TIMEOUT_MS`，超时记录为失败而非用户取消。

## 当前工具范围

默认允许 Read、Glob、Grep、WebSearch；同时暴露 WebFetch、Bash、Edit、Write 和 AskUserQuestion。使用 restricted、safe-mode 与空 MCP 配置。设置页的“执行权限”默认选择自动模式：本机 CLI 明确支持 `--permission-mode auto` 且任务目录明确时，由原生分类器审批命令、网页读取等操作，移除逐项强制 ask 规则；文件操作沿用原生 Auto 权限。保留主机问答及审批通道，原生拒绝不会被 Bridge 自动放行。旧版工具、未知任务目录及只读任务使用 manual 模式；只读任务不开放写入与命令工具。联网工具仍受原生服务、账号策略和网络限制，不能把启动参数当作联网成功的证明。原生子 Agent、外部 MCP、用户插件和项目 hooks 不开放。Auto 的可用性仍受账号、模型与管理员策略约束，声明支持参数不保证当前连接的分类器可用；错误会作为实际执行失败返回，不自动切换为绕过审批。

AskUserQuestion 保留原问题、选项和多选能力；回答转回同一 Claude 进程的 `control_response`，按原问题填写 `updatedInput.answers`。工具授权只使用 Bridge 保存的原始工具输入，客户端不能替换文件路径、命令或写入内容。拒绝返回 deny；原生取消请求、停止或断线使卡片失效。不会把人类回答转换成新群消息或另开执行。

Agent 按消息中的资源引用定位文件，不绑定固定项目路径。自动模式以当前任务的 resourceKey 目录或独立工作副本为工作目录，不传入文件系统根路径作为额外目录，也不把用户主目录或根目录当作整个任务的自动写入范围；目录不存在时明确失败。逐次确认模式保留原来的跨目录资源访问与逐项审批。restricted 不代表完整的多租户文件保密隔离，也不是操作系统级的命令隔离。OpenBot 不实现群组持续共享资源、撤销授权或文件占位。

## 验证

`npm test` 使用隔离的协议测试进程，覆盖会话、增量输入、工具限制、错误、隐藏推理隔离、取消、超时、原生问答和精确工具审批。`npm run test:e2e` 验证群内展示、提交、刷新恢复、秘密输入掩码和失效状态。

运行 `node --import tsx scripts/smoke/claude.mjs` 会实际调用已登录的 Claude，并在 Codex 可用时验证混合群组。它使用临时数据库和临时 README，验证实际读文件、边执行边聊天、动态卡片、点击回传与原生会话记忆；不修改日常群组或 Bot 绑定。原生验证会话仍由各自 CLI 保存在本机。
