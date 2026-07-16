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
| [0011](0011-mcp-config-scopes-and-mutation.md) | accepted | MCP 配置使用三层可写作用域、乐观冲突检测与显式 legacy 迁移 |
| [0012](0012-mcp-tui-readonly-list.md) | accepted | TUI `/mcp` 只显示 effective Server 的连接状态与名称 |
