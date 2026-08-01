# ADR-0032: 模型流断线重连保持展示连续性

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

ADR-0031 引入模型文本与 reasoning 的实时 delta，但原有 transient retry middleware 只包装非流式 `doGenerate`。模型服务在已经输出部分 SSE 后断开时，流直接失败；TUI 会结算当前流，重连后也无法继续更新同一份文本或 Thought。流中的工具参数可能尚不完整，不能安全执行。

多数 OpenAI-compatible 服务不提供可携带 SSE 游标的续传协议。所谓“重连”实际上是以同一上下文重新发起整次模型请求，新流通常会重放已有前缀，也可能重新生成不同内容。

## Decision

1. streaming 调用的 transient retry 边界覆盖完整的 stream 消费，而不只覆盖 HTTP 建连。连接错误、超时和 5xx 使用已有的有界指数退避策略；abort、4xx、格式错误不重试。
2. 断线前已经派发的累计 text/reasoning 保留在 TUI。`model.retry` 只更新重连状态，不关闭 Thought、不 finalize 流式文本，也不追加会打断流式块的通知文本。
3. 新流从空累计值重新消费。重放值尚未追上已展示前缀时不回退 UI；追平后继续以累计全文更新原有块。若新生成内容发生分歧，累计值按现有替换式流渲染语义更新，最终以成功流的 `model.responded` 为准。
4. 任一未完整结束的 stream 都不产生 durable `model.responded`、`tool.queued` 或工具执行。只有成功流的 `finalStep` 可以一次性提交完整文本、reasoning 和工具调用，因此断线前的 partial tool call 不创建工具状态，也不会被执行或与重连后的工具重复。
5. `model.retry` 在退避开始时即时派发，使 TUI 进入 Retrying；任一恢复后的 delta 或最终 `model.responded` 清除 retry 状态。

## Consequences

- 用户在重连期间仍能看到断线前的文本和 Thought；恢复后同一展示继续增长。
- 工具状态采用终态提交，而不是展示不可靠的半截 JSON 参数。
- 重连会重新消耗模型请求配额；供应商不支持游标续传时无法保证逐 token 完全相同，因此终态消息仍是唯一权威结果。
- delta 继续保持 ephemeral；重试事件和最终响应沿用现有 Runtime 事件边界。

## Verification

- 模型边界测试模拟“部分文本和 partial tool call 后连接错误”，随后重放文本前缀并返回不同的完整工具调用；验证文本不回退、只返回成功尝试的工具。
- reducer 测试验证 `model.retry` 不关闭流式块，恢复 delta 继续更新同一 block id 并清除 retry 状态。
- PTY 场景验证断线期间的部分文本保持可见，恢复后完成文本和工具生命周期。
