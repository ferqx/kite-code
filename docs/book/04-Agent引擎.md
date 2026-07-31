# 第四章 核心层：Agent 与 Runtime Kernel

Kite Code 使用自有事件化 Runtime。`runRuntimeAgent()` 负责模型循环，`AgentKernel` 负责事实、调度和恢复，两者职责分离。

## 4.1 主循环

```text
RuntimeState
  → decideNextEffect()
  → invoke_model / execute_tools / compact_context / request_approval / run_verification / emit_final
  → RuntimeEffectExecutor
  → RuntimeEvent
  → reduceRuntimeState()
  → 持久化并继续调度
```

| 实现 | 职责 |
| --- | --- |
| `runtime/agent.ts` | 组装并运行 Agent loop |
| `runtime/kernel.ts` | Effect lease、事件提交、状态权威 |
| `runtime/scheduler.ts` | 根据 State 决定下一 Effect |
| `runtime/reducer.ts` | 将 Event 归纳为新 State |
| `runtime/executor.ts` | 把 Effect 路由到模型、工具、验证或交互边界；持有 RuntimeStore 引用，供工具写入前记录文件原像（ADR-0025 §4） |
| `runtime/runner.ts` | 驱动 Kernel 直至暂停或完成 |
| `runtime/store.ts` | 事件、快照、恢复点与文件原像 |

## 4.2 模型边界

Model Controller 只负责模型调用与 transcript 投影。模型获得：

- 静态 system prompt；
- cacheable Runtime context；
- 当前计划、模式和恢复信息；
- 当前轮有限 Capability binding；
- 对应的 transcript messages。

模型输出被转换为 Runtime 事实。它不能直接写文件、批准操作、修改 State、签发 binding 或宣布 required verification 已通过。

## 4.3 Plan 生命周期

计划是 Runtime 管理的版本化 Artifact，而非模型消息中的临时文本。计划创建、更新、审核、批准、执行和恢复均有明确事件；结构摘要用于防止审核后计划被静默替换。

Plan mode 与普通执行共享同一个 Kernel，只通过策略和可用工具边界限制行为，不建立第二套 Agent 引擎。

## 4.4 完成与恢复

Scheduler 只有在没有待执行工具、审批、Provider Action、恢复动作或 required verification 门禁时才可 `emit_final`。失败根据分类进入重试、repair、replan、用户决策或终止；关闭 feature flag 不能绕过已持久化的安全门禁。

MCP Provider Action 是持久化交互。旧 Tool Call 必须先失败并退出调度，Runtime 才向 App shell 请求固定的 login、approve 或 retry。恢复成功会开始新 turn，旧 binding、approval、参数和 invocation 都不重放；延后或失败也会形成明确事实并清除交互。
工具失败与紧随其后的 Provider Action 使用同一有序 event batch 提交，确保 Kernel 不会在
Tool Call 仍为 running 时拒绝或提前展示恢复交互。

新 run 还会在第一次模型调用前执行 required Provider 准入。ready/degraded 可继续，其余 Provider 逐个等待 retry、当前 session waiver 或 cancel。Waiver 是持久事实但不会恢复能力可见性；cancel 会取消任务并中止 turn。

启用 `resourceBudgetV1` 的新 run 在所有 Runtime invocation 前执行累计预算 admission。
reservation 与 FIFO waiter 先持久化，`dispatch_started` 落盘后才允许 Controller 调用模型、
工具、MCP、Skill/Sub-agent、Verification 或 compaction；terminal fact 与实际 usage 原子
reconcile。Shell 同时取得 tool/shell 两类 permit，不会部分占位。累计耗尽、并发等待超时和
未知外部结果分别保留不同终态，不会投影为普通完成。

Runtime schema v19 的终态使用 `RunTerminalOutcomeV1`。展示层读取 reason code、external
effects、safe retry、recovery entry 与 pending verification，不解析错误字符串；只有
`status=completed` 可进入完成展示。

Runtime schema v20 保留上述终态，并把每个网络 hop 的 allow/deny admission receipt 持久化到
对应 Tool Call。获准 socket 只有在 receipt event 提交成功后才能打开；恢复 v19 snapshot 时
不会为历史调用补造网络决定。

## 4.5 上下文与缓存

静态 prompt、稳定工具契约和 cacheable Runtime context 尽量保持前缀稳定；动态状态、Skill disclosure、搜索结果和 turn binding 放在轮次投影中。上下文压缩保留任务事实、计划和工具结果语义，不取代 Runtime Store。

Runtime schema v16 把 M2 checkpoint lifecycle 纳入事件循环。`context.compaction_requested` 形成 pending 状态，scheduler 在工具、交互、verification 和 final 等更高优先级工作结束后调度 `compact_context`，controller 以 completed/failed 事件收敛。压缩复用普通 Effect lease；来源 revision 或完成时重新解析的 projection environment 变化时，结果按 stale 丢弃且不生成 lifecycle event。恢复通过 snapshot 加严格 event tail 重建 pending 或 active checkpoint，已收敛的 completed 不会重复激活。安全边界和输入上限都以完整 settled turn/tool pair 为单位，不能拆分调用与结果。Checkpoint 只是一种可 reset 的模型上下文投影，原始 transcript 仍保持不变。

压缩原因只有 `manual | auto`。Token ratio 术语（文本计量比例）、窗口估算、Provider 术语（模型供应商）错误和压缩失败不会产生 hard block 术语（硬阻断）；`ContextHardBlock` 只表示 Runtime correctness failure 术语（运行时正确性故障），普通压缩或 reset 术语（重置）不能清除它。Core 不解释通用 Provider HTTP 400；模型请求失败不自动触发压缩或硬阻断，用户可在会话恢复交互后自行执行 `/compact`。

会话压缩使用当前对话模型执行一次无工具、零 SDK retry 的专用 summary request，并且只接受一份 Markdown narrative。输入只包含最小固定 prompt、已有 narrative、全部 safe settled history 和作为不可信数据的 custom instructions；不携带普通 Agent system prompt、工具 schema 或 live tail。手动压缩总结全部安全历史；自动压缩只保护当前 turn。显式 summary input 上限超出时整体失败，不会静默总结局部前缀。输出必须非空、未因长度截断、没有 tool call、低于 narrative 上限，并使统一 candidate projection 至少减少 1024 个估算 token。Checkpoint 只持久化规范化 summary 字符串与 Core 边界元数据；投影时通过唯一 XML-safe serializer 生成一个历史区首位的 `<compacted_history>` assistant frame。
