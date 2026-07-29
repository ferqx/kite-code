# ADR-0048: 用户停止当前轮次先持久收敛工具，再传播 AbortSignal

**Status**: accepted
**Date**: 2026-07-29
**Decision makers**: @chenchao

## Context

TUI 的 Esc/Ctrl+C 原先直接传播共享 AbortSignal，并在 reducer 中把可见 block 临时标成 cancelled。该路径能停止进程，却没有通过 Runtime Kernel 为已排队或运行中的 Tool Call 写入终态。结果是 event log、snapshot 和 TUI projection 可能分叉：运行中的 Bash 丢失指令，未启动的并行读取在取消后被错误统计为 `read N files`，重放时还会恢复出没有 Tool Result 的悬空调用。

同一模型响应中的并行 Tool Call 属于一个 turn。用户停止该 turn 与某个工具自身失败不同：前者应放弃当前批次的所有未终结调用，后者不应默认取消无关 sibling。turn 中止也不等于用户永久取消顶层 task；用户仍可能在下一条消息中纠正要求并继续。

## Decision

1. live Runtime 向 App shell 暴露 `cancelRun` control。用户停止当前 turn 时，App shell 必须先调用它，再触发共享 AbortSignal。
2. `cancelRun` 基于 Kernel 当前 revision，为全部非终态 Tool Call 生成 `tool.cancelled`，随后生成带 `cause: user` 的 `turn.aborted`，并通过 `processEventBatch` 原子持久化。revision 前移使仍在执行的 Effect lease 失效，晚到结果不得覆盖取消事实。
3. 用户停止 turn 不生成 `task.cancelled`。活动 task、规划和已有 transcript 保留，下一条用户消息可以继续当前任务；显式取消 task 的业务入口仍使用独立的 `task.cancelled` 语义。
4. `tool.cancelled` reducer 必须幂等，移出 queue/active、清理匹配的人机交互与 Subagent suspension，并只生成一个配对的失败 Tool Result。已经终结的调用不被取消事件覆盖。
5. TUI 以 `turn.aborted(cause=user)` 作为整轮取消投影边界：保留实际开始工具的名称、参数和已有输出；移除从未开始的 queued 探索统计；Bash 只显示 cancelled footer，不显示 `exit: 0`、重复的 `Cancelled` 输出或独立的整轮取消提示。实时展示与 event-log replay 使用同一 reducer 路径。
6. 意外 Runtime 异常使用 `turn.aborted(cause=error)`，继续由 `run.error` 展示，不伪装成用户取消。

## Alternatives considered

- **只传播 AbortSignal**：能够停止工作，但无法收敛 RuntimeStore、工具队列和 transcript 配对。
- **只清理 TUI block**：实时界面暂时正确，重启或重放后仍会恢复错误状态。
- **只取消正在运行的 Tool Call**：queued sibling 会留下永久 pending 状态，且模型上下文缺少对应 Tool Result。
- **同时取消顶层 task**：会把“停止这一轮并继续对话”错误提升为任务永久终止，破坏纠正与续接语义。

## Consequences

- 用户取消会多写一组明确的 Runtime terminal events，但这些事件可以稳定恢复、审计和重放。
- 活动 Effect 的晚到结果通过 lease revision 检查自然丢弃，不需要 TUI 猜测竞态结果。
- 工具级失败仍可独立处理，不会因为并行读取或其他 sibling 存在而自动级联。
- 新增取消入口必须复用 Kernel control 或产生等价的 durable batch，不能绕过为纯 UI 状态修改。

## Verification

- Kernel 测试覆盖 running + queued 工具的原子取消、Tool Result 配对、事件落盘以及 task 保持 active。
- reducer 测试覆盖 interaction 清理与重复 `tool.cancelled` 幂等。
- SessionRuntime 测试验证 durable cancellation 发生在 AbortSignal 之前，并将事件投影到前台。
- TUI reducer/layout 测试覆盖实时/重放一致、queued 读取统计移除、Bash 指令保留、取消 footer 与无独立轮次提示。
