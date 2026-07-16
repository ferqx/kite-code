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

`/mcp` 是静态候选命令；输入 `/m` 或 `/mc` 时，候选面板显示“查看 MCP 连接状态”，并支持 Tab、右方向键和 Enter 补全。命令不接受 Server 参数或管理子命令。MCP Prompt 使用独立的动态 `/mcp__<server>__<prompt>` 命令。

## 8.4 Session 与恢复点

会话选择、删除、重命名、恢复点 restore 和 fork 基于 Runtime Store，而不是旧图 checkpoint。切换会话不会把一个 thread 的授权、pending approval 或 transient binding 隐式复制到另一个 thread。

TUI 的 token stats 连接与 RuntimeStore 共用同一数据库时必须采用 Core 提供的统一 journal mode；Windows 为 DELETE，其他平台为 WAL。长期 stats 连接保持打开期间，RuntimeStore 仍须能够打开、持久化和关闭，不能因两个连接各自设置 journal mode 而在启动时报 `database is locked`。

## 8.5 MCP 与 Skill 交互

MCP 状态面板订阅 Core control snapshot，只显示 effective Server 的连接/门禁状态与名称。面板不显示被遮蔽来源、scope、transport、typed diagnostic、Tools/Resources/Prompts 或配置动作；只允许滚动和 Esc 关闭。模型可调用能力仍来自 revisioned catalog/binding，而不是状态面板本身。

项目 Server 尚未批准时会出现在 `/mcp` 的 pending 状态行，同时 App shell 独立显示脱敏信任提示。连续两次按 `a` 确认批准当前摘要，连续两次按 `r` 确认拒绝，Esc 只延后本次提示；决定后 Supervisor 重新加载 catalog。批准属于 MCP control plane，不是任务 Runtime Tool Approval。

MCP 配置由文件位置确定来源并由 Core watcher/reconcile 加载。TUI 不提供 scope、Add Wizard、启停、删除、迁移、retry 或 reload；这些能力仍可由 Core Repository 供非 TUI 调用方复用。

Skill 命令触发正式 activation，不能把 SKILL.md 正文直接拼接到用户任务。

## 8.6 终端稳定性

TUI 的关键质量边界包括：DEC synchronized output、无 viewport culling、静态内容引用稳定、Footer resize、输入光标和 mixed-script wrapping。Spinner 帧由 elapsed time 的纯函数确定；测试使用受控时间验证帧序列，不依赖真实事件循环恰好在 120ms 内调度。对应规则位于 `docs/active/tui-*.md`。
