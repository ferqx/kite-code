# Architecture decision records

ADRs preserve decisions that alter runtime boundaries, lifecycle, policy, or execution engines. They are historical: do not rewrite an accepted decision; add a newer ADR and mark the old one superseded when necessary.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-runtime-kernel.md) | accepted | Runtime Kernel is the state-transition authority |
| [0002](0002-plan-lifecycle.md) | accepted | PlanningState replaces the plan-reviewed boolean |
| [0003](0003-auto-review-policy.md) | accepted | Auto-review is policy-gated and feature-flagged |
| [0005](0005-interaction-state.md) | accepted | InteractionState owns waiting UI states |
| [0006](0006-loop-mode-design.md) | proposed | Loop mode requires a separate design decision |
| [0007](0007-capability-bindings.md) | accepted | Dynamic capabilities require revisioned turn bindings |
| [0008](0008-verification-completion-semantics.md) | accepted | Only required verification gates completion |
| [0009](0009-project-mcp-local-approval.md) | accepted | 项目 MCP transport 必须获得绑定配置摘要的本地批准 |
| [0010](0010-mcp-supervisor-control-plane.md) | accepted | MCP 连接由 Supervisor 统一投影到 control snapshot |
| [0011](0011-mcp-config-scopes-and-mutation.md) | superseded | MCP 配置使用三层可写作用域、乐观冲突检测与显式 legacy 迁移 |
| [0012](0012-mcp-tui-readonly-list.md) | superseded | TUI `/mcp` 只显示 effective Server 的连接状态与名称 |
| [0013](0013-mcp-credential-store-and-oauth-session.md) | accepted | MCP secret 只进入原生系统保险库，OAuth 由独立恢复提示显式启动 |
| [0014](0014-mcp-tool-visibility-and-policy.md) | accepted | MCP Tool filter 与 policy 必须进入同一 revision，并按配置来源限制放宽能力 |
| [0015](0015-mcp-provider-availability-boundary.md) | accepted | Supervisor 向 Runtime 提供脱敏 Provider directory 与 typed failure |
| [0016](0016-mcp-provider-action-runtime-lifecycle.md) | accepted | Provider 恢复使用独立持久交互，成功后强制进入新 turn |
| [0017](0017-required-mcp-provider-admission.md) | accepted | unavailable required Provider 在首次模型调用前进入可 retry/waive/cancel 的会话门禁 |
| [0018](0018-mcp-tui-select-management-center.md) | accepted | MCP TUI 使用可见 Select 完成详情、添加、认证、审批和管理操作 |
| [0019](0019-mcp-two-config-locations.md) | accepted | MCP 默认配置收敛为用户与项目两个规范位置 |
| [0020](0020-mcp-stable-on-demand-tool-loading.md) | accepted | MCP Tool 使用稳定目录、会话级按需加载与执行时连接检查 |
| [0021](0021-context-compaction-checkpoint.md) | proposed | 上下文压缩采用事件驱动 checkpoint 模型，不直接改写 transcript |
