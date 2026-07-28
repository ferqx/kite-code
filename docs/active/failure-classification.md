# Failure classification

状态：active
读取时机：新增工具或模型失败路径、调整重试/升级策略、修改运行时错误日志时。
验证：`bun test tests/runtime/failures.test.ts`。

Runtime failures use `ClassifiedFailure` from `src/core/runtime/failures.ts`. Its `kind` gives policy a stable semantic category, while retryability, model-fixability, intervention, turn termination, and journal flags centralize handling choices. Model argument parsing, tool execution/policy decisions, approval rejection, and auto-review rejection all retain the classification on their tool call record.

New `tool.failed` producers must emit `failure: classifyFailure(...)`. The legacy `error` field remains accepted only so existing persisted v3 events can replay; reducers and trace logging prefer the structured value.

Choose the narrowest kind. Add a kind only when it has a distinct recovery policy, test its strategy, and update this document.

稳定性加固使用以下结构化 kind，不得降级为通用字符串：

- `deadline_exceeded`：总预算耗尽，可由上层在剩余策略允许时重试。
- `output_limit_exceeded`：硬输出上限触发，终止当前调用并记 journal。
- `cancellation_cleanup_failed`：无法确认受控进程树收敛，终止并要求人工恢复。
- `storage_busy`：确定性 busy/lock，可重试。
- `storage_conflict`：unique/sequence 冲突，整个 transaction 回滚。
- `storage_io_error`：disk-full 或 I/O failure，fail closed。
- `transaction_interrupted`：transaction 中断且结果不能被当作已提交。
