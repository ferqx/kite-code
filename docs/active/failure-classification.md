# Failure classification

状态：active
读取时机：新增工具或模型失败路径、调整重试/升级策略、修改运行时错误日志时。
验证：`bun test tests/runtime/failures.test.ts`。

Runtime failures use `ClassifiedFailure` from `src/core/runtime/failures.ts`. Its `kind` gives policy a stable semantic category, while retryability, model-fixability, intervention, turn termination, and journal flags centralize handling choices. Model argument parsing, tool execution/policy decisions, approval rejection, and auto-review rejection all retain the classification on their tool call record.

`ClassifiedFailure` also carries an optional `parseFailureCode` (from `ParseFailureCode` in `src/core/tools/registry/registry.ts`), propagated through `InvalidToolRequest` when the Registry rejects a tool call. This preserves the structured origin (`unknown_tool` | `tool_unavailable` | `invalid_arguments`) for diagnostic observability without introducing new `FailureKind` values.

New `tool.failed` producers must emit `failure: classifyFailure(...)`. The legacy `error` field remains accepted only so existing persisted v3 events can replay; reducers and trace logging prefer the structured value.

Choose the narrowest kind. Add a kind only when it has a distinct recovery policy, test its strategy, and update this document.
