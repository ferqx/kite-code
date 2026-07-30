# Failure classification

状态：active
读取时机：新增工具或模型失败路径、调整重试/升级策略、修改运行时错误日志时。
验证：`bun test tests/runtime/failures.test.ts tests/runtime/failure-taxonomy.test.ts tests/runtime/schema-v17-migration.test.ts`。

Runtime failures use `ClassifiedFailure` from `src/core/runtime/failures.ts`. Its `kind` gives policy a stable semantic category, while retryability, model-fixability, intervention, turn termination, and journal flags centralize handling choices. Model argument parsing, tool execution/policy decisions, approval rejection, and auto-review rejection all retain the classification on their tool call record.

`ClassifiedFailure` also carries an optional `parseFailureCode` (from `ParseFailureCode` in `src/core/tools/registry/registry.ts`), propagated through `InvalidToolRequest` when the Registry rejects a tool call. This preserves the structured origin (`unknown_tool` | `tool_unavailable` | `invalid_arguments`) for diagnostic observability without introducing new `FailureKind` values.

New `tool.failed` producers must emit `failure: classifyFailure(...)`. The legacy `error` field remains accepted only so existing persisted v3 events can replay; reducers and trace logging prefer the structured value.

Choose the narrowest kind. Add a kind only when it has a distinct recovery policy, test its strategy, and update this document.

Runtime schema v19 adds `RunTerminalOutcomeV1`. New `run.completed` and `run.error` events are
normalized before persistence and retain a stable reason code, known/unknown external-effects
state, safe-retry decision, recovery entry, and pending-verification bit. TUI and headless
consumers use `projectTerminalOutcomeV1`; they do not infer terminal meaning from localized error
strings.

The production reason-code set distinguishes artifact/profile/digest invalid, workspace
untrusted, sandbox/network/worktree unavailable, model retry exhausted, Provider/MCP unavailable,
persistence unavailable, budget exhausted, resource saturation, tool/shell concurrency
saturation, process limit exceeded, cancel incomplete, compaction unqualified/failed,
verification failed/inconclusive, mandatory policy unavailable, blocked, and unknown.
`completed` is the only projection with `complete=true`; `unknown` requires reconciliation and is
never safe to retry automatically.

`recovery_blocked` 不能只生成瞬态字符串。Runtime 必须将不兼容/未知恢复映射为结构化
`unknown`，将损坏的持久化恢复映射为 `persistence_unavailable`，持久化 error-caused
`turn.aborted` 与带 outcome 的 `run.error`，并保留 recovery hard block。`cancel_incomplete`
表示 descendant 退出未确认，external effects 固定为 unknown，不能与普通 cancelled 合并。

`terminalOutcomeV1=false` 只关闭 CLI 派生的 `terminalPresentation`；Runtime 仍规范化和持久化
outcome，因此 rollback 客户端仍可直接读取 status/reasonCode，不能把 unknown 当 completed。
