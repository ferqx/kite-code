# 第七章 TUI 结构

TUI 位于 `src/app/tui/`，负责输入、渲染和会话前台管理，不拥有 Agent 业务状态。所有可恢复事实来自 Core Runtime，UI reducer 只维护展示投影。

## 7.1 主要结构

```text
App.tsx
├── Header / OutputArea / Footer
├── InputLine 与交互面板
├── SessionManager / SessionRuntime
├── hooks/          键盘、窗口、会话、MCP controller、Skill、slash command
├── mcp/            MCP 只读状态 overlay、项目配置信任提示与 controller
├── reducers/       AgentEvent → UI state
├── components/     Block、审批、计划、子 Agent、模型选择
└── render/         静态内容与终端输出稳定性
```

## 7.2 状态边界

- RuntimeState：Kernel 的持久事实；
- AgentEvent：Core 向 UI 的中立投影；
- TUI state：焦点、overlay、block、输入框、选择器等展示状态；
- SessionRuntime：连接某一 thread 的运行、缓冲与取消控制。

TUI 不应根据展示文本反推工具是否成功，也不能自行构造 verification passed、approval granted 等 Runtime 事实。

MCP 是相同边界的 control-plane 示例：`App` 只接收 `McpController`，通过稳定订阅读取 Core `McpControlSnapshot`；TUI 不持有 `McpManager`，不读取或修改其内部 Map。`/mcp` 只过滤 effective Server 并渲染状态与名称，不存在搜索、selection、详情或配置 route。项目配置摘要决定由独立信任提示调用 controller；HTTP 认证阻塞由独立 `McpAuthPrompt` 调用 Login/Cancel，Core Repository 的 typed mutation 不进入 TUI。

## 7.3 事件渲染

`handleEvent` 和 reducer 把 AgentEvent 转为稳定 block。工具生命周期、审批、计划、Subagent、thought、错误和最终回答分别投影；事件类型不以固定数量作为文档契约。

静态历史区与动态输入/状态区分离，以减少 Ink 重排和终端闪烁。软换行、宽字符、粘贴占位、resize 和同步输出均有专门测试。

## 7.4 会话前后台

前台 SessionRuntime 将事件实时 dispatch 到 UI；后台会话缓存可丢弃的展示事件和必要状态，切回时重放/重建投影。取消、切换和组件卸载必须清理 AbortController 与订阅。

## 7.5 边界规则

Core 不得导入 TUI 类型或格式化函数；截断、折叠、颜色、preview 和用户文案属于 App 层。见 [`../active/layer-boundary-enforcement.md`](../active/layer-boundary-enforcement.md)。
