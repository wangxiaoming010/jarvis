# 原生 Agent 问答与权限请求

Agent 在执行期间发出原生请求，OpenBot 通过 Bridge 在原群中显示该 Bot 的系统交互卡片。人类回答后，程序将回应返回同一进程、同一任务租约及原始 requestId；不调用对话模型，不生成新的人类群消息，不新建任务或会话。

## 权限模式

设置 → 执行权限提供“自动模式”和“逐次确认”，默认自动；配置独立保存在本机 execution-settings.json，仅所有者认证的设置接口可以修改，群消息和 Bot 工具不能修改。更改从下一次派发执行生效，不改变已运行任务。

Codex 检查本机协议是否支持 auto_review；明确任务目录内使用 workspace-write + on-request + auto_review，原生自动审批越权或联网等申请。每次 turn/start 显式设置 sandboxPolicy 和审批者，避免恢复旧会话时沿用较宽权限。Claude 检查 CLI 的 auto 参数，使用原生 auto 分类器并移除日常操作的强制 ask 规则。两者均保留问题和剩余审批的原生通道，不设置 never、danger-full-access 或 bypassPermissions。

只读任务保持只读。CLI 不支持自动模式，或任务目录尚不明确、是主目录/根目录时回退逐次确认，并记录实际执行提示。设置页显示设备支持情况。Auto 可能直接批准或拒绝操作，不能保证发布、发消息或删除等操作一定再弹窗；执行要求仍需遵循人类明确授权，原生自动拒绝不能通过换工具或换模式绕过。原生权限审批结果不会由 OpenBot 改写为允许。

## 支持范围

| Provider    | 原生请求                                             | 客户端行为                                            |
| ----------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Codex       | `item/tool/requestUserInput`                         | 保留问题和选项，单选、自由文本及秘密输入              |
| Codex       | `item/commandExecution/requestApproval`              | 展示命令、位置和原生原因；允许或拒绝                  |
| Codex       | `item/fileChange/requestApproval`                    | 展示原生文件变更详情；允许或拒绝                      |
| Codex       | `item/permissions/requestApproval`                   | 展示请求的文件/网络权限；允许本次、当前原生会话或拒绝 |
| Claude Code | `can_use_tool` / `AskUserQuestion`                   | 保留原问题、单选、多选及补充文本                      |
| Claude Code | `can_use_tool` / Read、Glob、Grep、Bash、Edit、Write | 展示具体操作；逐项允许或拒绝                          |

未适配的原生请求返回明确拒绝或协议错误，不自动批准。需要专门终端或登录界面的交互不在此范围。

## 有效期与历史

- 请求必须由当前执行的认证 Bridge 发起，任务、设备及 leaseId 全部匹配。
- 系统卡片与 Agent 生成的动态 UI 使用不同的持久化记录和回应接口，普通卡片不能授予权限。
- 用户只能回应原问题与原权限范围；Bridge 返回保存的原始命令/文件操作，客户端不能替换执行参数。
- 提交相同回答可安全重试，已经回答的请求不会重复发送；不同回答返回冲突。
- 原生撤回、任务结束、停止、断线和服务重启使未回答请求失效，迟到回答不会继续执行。
- 已提交的非秘密回答在刷新后保留，并变为只读；秘密回答只送到原生进程，数据库历史保存掩码。
- 「本次会话允许」指当前原生会话，不代表给整个群共享权限。主动共享资源、长期授权及撤销管理尚未实现。

## 验证

```sh
npx vitest run tests/server/native.test.ts tests/bridge/native-adapters.test.ts tests/bridge/claude.test.ts
npm run test:e2e -- tests/e2e/native.spec.ts
```

这些测试使用临时数据库与隔离的协议进程，不调用真实模型、不修改日常群组。浏览器验证涵盖原生问答提交、刷新后只读、多选与补充文本、秘密输入掩码、拒绝、会话授权和停止后失效；整个流程保持只有原来的一次执行。

真实 Claude 验证可运行 `node --import tsx scripts/smoke/native.mjs`。它会使用本机登录调用模型，在临时目录发起原生问答，只允许一次写入该目录内指定文件，核对文件内容后清理；不会操作日常群组。原生会话仍保存在 Claude 本地历史。实际执行时的登录必须有效，`auth status` 本身不保证模型请求可用。
