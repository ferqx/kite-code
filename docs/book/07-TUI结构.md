# 第七章 TUI 结构

TUI 位于 `src/app/tui/`，负责输入、渲染和会话前台管理，不拥有 Agent 业务状态。所有可恢复事实来自 Core Runtime，UI reducer 只维护展示投影。

## 7.1 主要结构

```text
App.tsx
├── Header / OutputArea / Footer
├── InputLine 与交互面板
├── SessionManager / SessionRuntime
├── hooks/          键盘、窗口、会话、MCP controller、Skill、slash command
├── mcp/            MCP Select 管理 overlay、ViewModel 与 controller
├── reducers/       AgentEvent → UI state
├── components/     Block、Overlay primitives、审批、计划、子 Agent、模型选择
└── render/         静态内容与终端输出稳定性
```

TUI 入口在创建 Runtime、读取配置或挂载 Ink 前处理 `--version`，只输出 `package.json` 中的产品版本并退出；候选包的启动 smoke 使用这一无副作用入口验证独立 executable 可运行。

## 7.2 状态边界

- RuntimeState：Kernel 的持久事实；
- AgentEvent：Core 向 UI 的中立投影；
- TUI state：焦点、overlay、block、输入框、选择器等展示状态；
- SessionRuntime：连接某一 thread 的运行、缓冲与取消控制。

TUI 不应根据展示文本反推工具是否成功，也不能自行构造 verification passed、approval granted 等 Runtime 事实。

终端 focus reporting 由进程级 store 复用：所有 React subscriber 共享一个 stdin listener，
首订阅开启 DEC 1004，最后退订移除 listener 并关闭该模式，避免 session/mount 增长造成
listener warning。

MCP 是相同边界的 control-plane 示例：`App` 只接收 `McpController`，通过稳定订阅读取 Core `McpControlSnapshot`；TUI 不持有 `McpManager`，不读取或修改其内部 Map。`/mcp` 的 list、detail、add、authenticate、project approval 和 confirm route，以及 selection、draft 和动态操作菜单都属于 App。业务键只产生 move/confirm/back，再由 controller 调用 Core retry、typed mutation、摘要决定和 auth flow；Core 不依赖 Select 或 TUI 展示类型。

普通交互 Overlay 共用 `OverlayFrame` 与 `OverlayPrimitives`。Frame 统一标题、正文、可选消息、快捷键及外层间距；Section、ListRow、DetailList、Message 和 EmptyState 统一内容层级。页面不得复制选择箭头、选中背景或用空白 Text 固定高度。MCP 宿主保留 route/input/controller 编排，`McpViews` 只负责纯视图。完整当前 contract 见 [`../active/tui-overlay-design-system.md`](../active/tui-overlay-design-system.md)。

## 7.3 事件渲染

`handleEvent` 和 reducer 把 AgentEvent 转为稳定 block。工具生命周期、审批、计划、Subagent、thought、错误和最终回答分别投影；事件类型不以固定数量作为文档契约。

模型流式展示采用分层完整提交：reasoning delta 只进入缓存，连续 reasoning 段完成后一次性更新 Thought 的活动窗口，最终回答可见后移除 reasoning 正文并只保留 `Thought for Xs` 摘要。普通文本按整段提交，列表按完整 item 提交；围栏代码与表格在结构可识别后先建立完整组件外壳，再只追加已经换行完成的内部行，组件关闭后进入静态历史。

静态历史区与动态输入/状态区分离，以减少 Ink 重排和终端闪烁。交互式入口直接使用终端主屏缓冲区，不启用 Ink alternate screen；运行内容保留在终端原生 scrollback 中，退出时不恢复进入 TUI 前的旧画面。软换行、宽字符、粘贴占位、resize 和同步输出均有专门测试。

Header 是每个会话写入 Static scrollback 的启动快照：低对比度圆角边框包裹 `──◆ Kite Code` 品牌字标，品牌行、模型和工作区在边框内统一左对齐。它不承担 working/error 等实时状态；同一会话切换模型时不重绘历史 Header，当前模型继续由 Footer 展示。窄屏会隐藏推理强度，并从中部截断过长路径。完整视觉与状态契约见 [`../active/tui-session-startup-card.md`](../active/tui-session-startup-card.md)。

## 7.4 会话前后台

前台 SessionRuntime 将事件实时 dispatch 到 UI；后台会话缓存可丢弃的展示事件和必要状态，切回时重放/重建投影。取消、切换和组件卸载必须清理 AbortController 与订阅。

TUI 的 Shell executor 不在 `SessionRuntime` 内自行拼装 sandbox；它通过 App 层统一 composition root，
与 foreground Headless CLI 共享 workspace、release ceiling、network mode 和平台 capability admission。
composition 失败时会话在执行工具前 fail closed，不能由 TUI 入口单独放宽。

`SessionManager` 可持有当前运行中 Kernel 的受限控制面，只暴露读取 RuntimeState 和提交 RuntimeEvent。`/compact` 等运行时命令必须通过该入口写入持久事件，由 scheduler 按工具、交互和 verification 的安全顺序处理；App 不直接改写 Core 状态。提交新事件会推进 revision，使旧的模型或执行 effect 结果按 lease 规则失效。

## 7.5 边界规则

Core 不得导入 TUI 类型或格式化函数；截断、折叠、颜色、preview 和用户文案属于 App 层。见 [`../active/layer-boundary-enforcement.md`](../active/layer-boundary-enforcement.md)。
