# Runtime 动态状态投影与 Prompt Cache

状态：active

读取时机：修改模型消息顺序、Runtime context、Plan/Mode/Authorization 提醒、上下文压缩或 prompt cache 布局时。

验证：`bun test tests/context.test.ts tests/runtime-context.test.ts tests/runtime/plan-transcript.test.ts tests/model.test.ts`、`bun run typecheck`。

## 规则

静态 Agent contract 与 cacheable Runtime context 必须保持稳定。Plan、phase、interaction mode、authorization、sandbox、verification repair 等高频动态事实应由当前 `RuntimeState` 投影到会话尾部，不能写入静态 system prompt 前缀。

推荐消息顺序：

```text
System(static agent contract)
System(cacheable runtime context)
...compacted transcript messages
Synthetic runtime-state message(s)
```

动态投影必须明确标记为 Runtime 生成，不得伪装成用户原始输入。投影是给模型的视图，不是状态权威；下一轮始终从 RuntimeState 重建。

工具协议链必须保留原始 assistant tool call 与对应 tool result 关系。不得为了缓存命中率把工具结果改写为普通用户消息，或将 transient binding/tool schema 固化进长期 transcript。

Runtime schema v15 起，持久 transcript 的每条消息都由 reducer 或 snapshot migration 补齐 `messageId`、`turnId`、`ordinal` 与 `createdAt`。Tool Result 的 `path`、`totalLines`、`command`、`intent`、`contentDigest`、resource revision 和 workspace mutation scope 等结构化事实同时保存在 `ToolCallRecord.result.resultMeta` 与 tool transcript message；模型上下文投影必须读取这些字段，不得通过解析 stdout 正文恢复领域元数据。v13 及更早快照恢复时使用稳定的 legacy identity 和 epoch 时间占位，不能猜测原始时间或结果事实。

M1 V2 只在 provider-neutral canonical frame 层执行，默认完整保留最近 3 个 semantic turns。`read_file`/resource read 仅可在同一资源 revision 已有更新、完整、成功观察保留时折叠较早观察；精确 mutation scope 只失效对应资源，未知或无 scope 的副作用失效整个 workspace observation set。搜索折叠必须保留 query、scope、match count、top matches、truncated 状态与 result digest。重复只读调用即使折叠也必须为每个 tool call 保留独立 Tool Result。失败、未知 effect、写工具、plan/approval/verification、ask_user 和 subagent 结果不得由 M1 折叠。

每次模型调用前必须估算完整请求的 system、tool schema、transcript、checkpoint summary、dynamic runtime 和 framing token 分项。可用输入预算由 resolved context window 减去请求/模型的 max output reservation 与配置的 provider safety margin 得出；preflight 默认使用 80% warning、88% compact、94% hard 和 62% target 阈值，并产生持久的 `model.context_metrics` telemetry。模型窗口 unknown 时 utilization 必须保持 unknown，不能用虚构默认值触发或绕过压缩。正常模型调用、compaction、`/context` 与 reset preflight 必须共用同一个 projection environment resolver 和包含 adapter metadata 的 `ResolvedModelCapabilities`，不得让状态或 reset 回退到仅配置推断的不同窗口。

M2 checkpoint lifecycle 与 `StructuredContextSummaryV1` 校验已进入 Runtime。`contextCompactionV2` 默认开启基础契约，自动 M2 仍由默认关闭的 `contextCompactionAutoV1` 单独灰度。启用自动 M2 后，模型调用 preflight 在 soft/hard threshold 上返回 durable `context.compaction_requested`，再由 scheduler 产生 `compact_context`；completed/failed 结果只能通过原有 Kernel effect lease 提交。active checkpoint 替代已覆盖历史前缀并与 live tail 组成模型投影，但不删除或改写原 transcript；manual reset 只撤销当前投影。

摘要候选必须匹配严格 Zod schema，并同时通过 source provenance、message coverage、mandatory fact IDs 和 token reduction 校验。Mandatory ledger 由 RuntimeState 与结构化 transcript 确定性提取；模型不得删除用户目标/约束、已完成副作用、失败/拒绝、verification、plan 引用或最近可靠资源观察。Durable checkpoint 不接受模型生成的自由文本 `unresolvedQuestions`；新候选必须为空，恢复旧 checkpoint 时也丢弃该字段，未完成事项只能来自确定性的 `pendingWork` fact。当前 planning、authorization、interaction、active tools、binding、Skill、verification lifecycle 和 task status 继续由 RuntimeState 动态投影，摘要不是这些事实的权威来源。Chunked compaction 只能在完整 turn/tool block 边界切分，中间 chunk summary 永不持久化为 active checkpoint。

Soft 自动压缩要求安全边界、最小收益和 turn cooldown；hard 忽略普通 cooldown，但无安全边界时禁止调用 provider。只有 `auto_soft` / `auto_hard` 的 `insufficient_reduction` 才累计自动 low-gain breaker；手动失败不得污染自动计数，成功的 `manual` / `manual_recovery` 是解除 breaker 的明确 manual action。Provider context overflow 不进入普通 transient retry，而是在每个 Runtime turn 最多产生一次 `overflow_recovery`；恢复后仍 overflow 或 hard compaction 失败时 fail closed。阈值、target、minimum reduction、cooldown、recent turns 与 summary token budgets 来自受 Zod 校验的 `compaction` 配置；窗口 unknown 时仍不自动触发。Compaction requested/completed/failed、hard block 与 context pressure 必须写入 session trace；completed/failed 记录真实 effect duration，completed 同时记录 before/after 与 token savings，不能只依赖进程内 singleton。

`contextCompactionManualV1` 默认开启后，`/compact` 命令触发上下文压缩并接受可选的自定义摘要指令（例如 `/compact focus on auth changes`）。命令必须先持久化不进入模型 transcript 的 `user.command_invoked`，再形成 `context.compaction_requested(reason=manual)`，因此退出并重新进入 TUI 后仍会显示命令，但不会把 slash command 当成用户目标发送给模型；不跳过安全边界、lease、schema、mandatory facts 或 reduction 校验。运行中的命令通过 live Kernel control 写入同一状态机，交互、工具或 verification 未结算时保持 pending，不能另开 Kernel 与当前 runner 竞争。没有足够历史消息时返回 `Not enough messages to compact.`，对应失败事件也必须持久化以供会话重放。

启用 MCP progressive disclosure 时，稳定前缀只加入安全排序的 Provider/Tool 名称摘要和内置 `tool_search`；完整 Schema 仅为 session-loaded set 在当前 turn 生成。Provider health、connecting/failed 状态和短暂重连不得进入工具缓存键，也不得改变已保留 descriptor 的名称摘要；revision 或 schema digest 变化仍必须使旧缓存与 Binding 失效。Resources 通过独立内置列表/读取工具披露，不混入 Tool 名称摘要。

上下文压缩可以摘要旧对话，但不能覆盖 Plan Artifact、Execution Receipt、required Verification 或恢复状态。实证缓存数据属于 completed/understanding 记录，不在本 active 规则中充当当前实现事实。
