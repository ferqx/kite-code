# 第八章 TUI 交互全景

## 8.1 任务输入

```text
用户提交输入
  → App 校验当前 overlay / interrupt / run 状态
  → SessionRuntime.runTask()
  → buildRunAgentParams()
  → runRuntimeAgent()
  → AgentEvent 流
  → reducer / blocks / status
```

多行输入、粘贴、软换行、宽字符和终端 resize 由 InputLine 与专用 hooks 处理；这些行为不进入 Core。

## 8.2 运行中的结构化交互

| 交互 | Runtime 行为 |
| --- | --- |
| 工具审批 | `approval` interrupt → approve/reject/replacement → RuntimeUserAction |
| 用户问答 | `input` interrupt → 文本/结构化 answers → 恢复 Agent |
| 计划审核 | `plan_review` interrupt → approve/revise/cancel |
| Verification 决策 | replan、compensation 或带理由 waiver |
| Subagent 审批 | 保存 continuation，用户决策后恢复 |
| 取消 | AbortSignal 传播并形成一致的终止/恢复状态 |

Esc 不等价于静默成功：overlay 关闭、审批拒绝和任务取消根据当前交互类型显式处理。

## 8.3 斜杠命令

Slash command 由 `useSlashCommand`、suggestions 和 reducer 协作完成，可进入会话、模型、模式、MCP、Skill、帮助等产品功能。命令只是 App 入口；涉及 Runtime 状态的操作仍通过正式 action/event 边界执行。

`/mcp` 是静态候选命令；输入 `/m` 或 `/mc` 时，候选面板显示“管理 MCP Servers”，并支持 Tab、右方向键和 Enter 补全。命令不接受 Server 参数或管理子命令，管理动作只在 Overlay 的可见 Select 中执行。MCP Prompt 使用独立的动态 `/mcp__<server>__<prompt>` 命令。

## 8.4 Session 与恢复点

会话选择、删除、重命名、恢复点 restore 和 fork 基于 Runtime Store，而不是旧图 checkpoint。切换会话不会把一个 thread 的授权、pending approval 或 transient binding 隐式复制到另一个 thread。

TUI 的 token stats 连接与 RuntimeStore 共用同一数据库时必须采用 Core 提供的统一 journal mode；Windows 为 DELETE，其他平台为 WAL。长期 stats 连接保持打开期间，RuntimeStore 仍须能够打开、持久化和关闭，不能因两个连接各自设置 journal mode 而在启动时报 `database is locked`。

## 8.5 MCP 与 Skill 交互

MCP Overlay 订阅 Core control snapshot。Server List 只显示 effective Server、状态和 Add 入口，只负责 selection/navigation；Enter 打开只读 Detail，操作菜单按 config/auth/health/diagnostic 动态生成。所有 MCP 业务流程统一使用 `↑/↓/Enter/Esc`，不使用 `A/L/R/D/Space` 等功能键。模型可调用能力仍来自 revisioned catalog/binding，而不是 UI 选中状态。

项目 Server 尚未批准时出现在 `/mcp` 的 Approval required 状态行。Detail 的 Review server 进入脱敏审批页，默认选择 Decide later，并提供 Approve and connect 与 Reject server；决定继续绑定当前 config digest 并执行 TOCTOU 复核。批准属于 MCP control plane，不是任务 Runtime Tool Approval。

HTTP Server 真实进入 `login_required` 或 `reauth_required` 时，Detail 提供 Authenticate。认证页只有选择 Open browser 才启动 loopback callback 并调用系统 browser opener；authorizing 时 Esc/Cancel authentication 取消当前 flow。页面不显示 token、scope、authorization code 或 secret，成功认证只影响后续 discovery 与新 model turn，不重放旧 Tool Call。

开启 `mcpProviderActionV1` 后，Runtime 可在 Tool 失败后请求固定的 Login、Approve 或 Retry Provider Action。TUI 复用既有 input interrupt 收集决定并委托 MCP controller；成功恢复只开始新 turn，Later 或恢复失败都不会重放旧 Tool Call。新任务首次模型调用前还会对 unavailable required Provider 逐个显示 Retry、Session Waive 或 Cancel Run，waiver 只解除当前 session 的准入门禁。

Add Wizard 只收集 transport、name、URL/command 和 availability：Current project 写 `<project>/.kite-code/mcp.json`，All projects 写 `~/.kite-code/mcp.json`。Detail 可 retry/reconnect、enable/disable 和 remove；disable/remove 使用安全默认确认，remove 同时尝试清理对应本地 OAuth credential。高级配置、legacy migrate、Tool policy 和手动 reload 不进入 TUI。

Skill 命令触发正式 activation，不能把 SKILL.md 正文直接拼接到用户任务。

`tool_search` 在对话区渲染为 "Searched for tools"，搜索结果以 `Provider · Tool` 树展示。`list_mcp_tools` 渲染为 "Listed MCP tools"。

## 8.6 终端稳定性

TUI 的关键质量边界包括：DEC synchronized output、无 viewport culling、静态内容引用稳定、Footer resize、输入光标和 mixed-script wrapping。Spinner 帧由 elapsed time 的纯函数确定；测试使用受控时间验证帧序列，不依赖真实事件循环恰好在 120ms 内调度。对应规则位于 `docs/active/tui-*.md`。
