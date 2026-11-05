# 动态卡片与渲染

OpenBot 的声明式渲染器保留 `opsique-ui/0.1` 协议。组件、状态绑定、条件显示、公式、动画与图表实现保存在本仓库，不依赖原项目运行。来源与许可见 [PROVENANCE](../apps/desktop/src/renderer/PROVENANCE.md)。

## 消息与交互

Bot 主会话可以调用 `render` 展示表单、选项和图表。Worker 也可返回合法协议文档或 `opsique-ui` 代码围栏，由宿主接收与校验。普通文字仍以聊天消息显示，不将模型输出当 HTML、JSX 或 JavaScript 执行。

提交后，填写结果以用户消息交给对应 Bot 继续处理；卡片保留已提交内容并只读。未提交草稿在当前客户端会话中保存，刷新可以恢复。提示词来源见[提示词与工具定义](prompts.md)。

## 实现入口

- [桌面 Renderer](../apps/desktop/src/renderer/Renderer.tsx)：组件呈现与本地交互。
- [共享引擎](../packages/shared/src/ui/engine.ts)：Schema 校验、状态绑定与纯计算。
- [UI 服务](../apps/server/src/host/ui.ts)：文档持久化、提交校验与幂等处理。
- [协议参考](../packages/shared/ui-contract/README.md)：格式、组件和示例。修改后运行 `npm run generate:ui` 并提交生成结果。

已认证客户端可通过 `POST /api/groups/:id/cards` 发布 `{botId, document, replyTo?}`，通过 `POST /api/cards/:messageId/actions` 提交 ActionEnvelope。

宿主只接受预定义的 `reply` 操作；旧版本生成的 `choose_bots` 分工卡仍可提交，但不再生成新的分工卡。客户端不能任意指定执行对象、命令或目标 URL。

提交时校验群组、成员、版本、可见组件、实例、表单字段及原始绑定。同一请求重试只产生一条用户消息，旧版本和已处理卡片拒绝再次操作。原生权限卡片走[独立审批协议](native-interactions.md)，普通 UI 不能授予本机执行权限。

图表与 Mermaid 按需加载，地图当前关闭。图片受 CSP 和外部内容可用性限制。

## 验证

`npm test` 覆盖协议、公式、篡改、版本与重复提交；`npm run test:e2e` 覆盖表单、草稿恢复与窄屏布局。构建后运行 `node --import tsx scripts/smoke/ui.mjs` 可验证生产资源、严格 CSP、表单和图表，不调用真实模型。
