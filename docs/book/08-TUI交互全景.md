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

`/mcp` 是静态候选命令；输入 `/m` 或 `/mc` 时，候选面板显示管理面板说明，并支持 Tab、右方向键和 Enter 补全。`/mcp <server>` 直接进入 Server detail，`/mcp retry <server>` 重新经过配置/审批门禁。`/mcp add`、`enable|disable|remove`、`approve|reject` 与 `reload` 进入同一管理中心 controller；破坏性命令只打开确认页。MCP Prompt 使用独立的动态 `/mcp__<server>__<prompt>` 命令。

## 8.4 Session 与恢复点

会话选择、删除、重命名、恢复点 restore 和 fork 基于 Runtime Store，而不是旧图 checkpoint。切换会话不会把一个 thread 的授权、pending approval 或 transient binding 隐式复制到另一个 thread。

TUI 的 token stats 连接与 RuntimeStore 共用同一数据库时必须采用 Core 提供的统一 journal mode；Windows 为 DELETE，其他平台为 WAL。长期 stats 连接保持打开期间，RuntimeStore 仍须能够打开、持久化和关闭，不能因两个连接各自设置 journal mode 而在启动时报 `database is locked`。

## 8.5 MCP 与 Skill 交互

MCP 管理中心订阅 Core control snapshot，显示所有有效/被遮蔽 Server、连接 health、typed diagnostic 和 Tools/Resources/Prompts 只读详情；模型可调用能力仍来自 revisioned catalog/binding，而不是管理页列表本身。list/detail/tools/resources/prompts/error/approval/add/confirm 是 overlay 内部 route，Esc 逐层返回，搜索、selection、Wizard 和确认状态不进入 Runtime。

项目 Server 尚未批准时也会以脱敏条目出现。detail 中按 `a` 进入 approval route，然后连续两次按 `a` 确认批准当前摘要，或连续两次按 `r` 确认拒绝；决定后 Supervisor 重新加载 catalog。批准属于 MCP control plane，不是任务 Runtime Tool Approval。

列表按 `a` 打开 HTTP/STDIO Add Wizard；detail 中可以启用、禁用、删除当前可写来源或迁移 legacy 项目来源。Preview 不显示 secret、URL query 或参数内容。project 保存后只进入 pending approval，不与添加按钮合并授权。

Skill 命令触发正式 activation，不能把 SKILL.md 正文直接拼接到用户任务。

## 8.6 终端稳定性

TUI 的关键质量边界包括：DEC synchronized output、无 viewport culling、静态内容引用稳定、Footer resize、输入光标和 mixed-script wrapping。Spinner 帧由 elapsed time 的纯函数确定；测试使用受控时间验证帧序列，不依赖真实事件循环恰好在 120ms 内调度。对应规则位于 `docs/active/tui-*.md`。
