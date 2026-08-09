# Runtime 动态状态投影与 Prompt Cache

状态：active

读取时机：修改模型消息顺序、Runtime context、Plan/Mode/Authorization 提醒、上下文压缩或 prompt cache 布局时。

验证：`bun test tests/context.test.ts tests/runtime-context.test.ts tests/runtime/plan-transcript.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime/context-compaction-manual.test.ts tests/model.test.ts`、`bun run typecheck`。

相关：ADR-0021、ADR-0022、ADR-0024、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

压缩 effect 在模型调用前后重新解析实际 projection environment，并把 provider/model、能力、estimator、summary policy、工具 schema、active Skill 与 workflow descriptor 的稳定 digest 纳入同一 lease；环境变化产生 retryable `stale_context` failed 终态并清除 pending，不写 checkpoint。安全 source 只能由从最旧消息开始的完整 settled turns 组成，tool call/result 必须一一配对；manual 覆盖全部 safe source，但 Runtime 当前 turn 仍为 active 时同样必须保护该 turn；auto 始终保护当前 turn。Correctness hard block 只能由带 invariant reason、source digest、turn 和诊断证据的统一 factory 创建，且只允许匹配原 reason/digest 的恢复事件清除。

## 规则

静态 Agent contract 与 cacheable Runtime context 必须保持稳定。Plan、phase、interaction mode、authorization、sandbox、verification repair 等高频动态事实应由当前 `RuntimeState` 投影到会话尾部，不能写入静态 system prompt 前缀。

推荐消息顺序：

```text
System(static agent contract)
System(cacheable runtime context)
Synthetic user(project instructions, V2 only)
...compacted transcript messages
Synthetic runtime-state message(exactly one)
```

动态投影必须明确标记为 Runtime 生成，不得伪装成用户原始输入。V2 不再追加独立的 Plan reminder；phase、interaction mode、authorization、真实 sandbox backend、副作用状态和完整 PlanningState 只在一个 runtime block 中出现。投影是给模型的视图，不是状态权威；下一轮始终从 RuntimeState 重建。

`promptContractV2` 默认关闭。开启后，项目 `CLAUDE.md`/`AGENTS.md` 作为带来源标记的早期 synthetic user context 注入，不能提升为 System 权限；其 snapshot revision 与 Prompt 版本共同进入环境 digest。加载预算为单文件 16 KiB、快照 64 KiB 且最多 16,384 tokens，超限文件产生 warning 并整体跳过，不静默截断。Planning 阶段的模型工具面隐藏 edit/write/shell，`task` 只允许 explore/plan，动态 MCP 只披露 effective effects 不超过 read 的能力。Runtime Policy 和 Controller 仍必须独立复核，工具面裁剪不是执行授权。

工具协议链必须保留原始 assistant tool call 与对应 tool result 关系。不得为了缓存命中率把工具结果改写为普通用户消息，或将 transient binding/tool schema 固化进长期 transcript。

Runtime schema v15 起，持久 transcript 的每条消息都由 reducer 或 snapshot migration 补齐 `messageId`、`turnId`、`ordinal` 与 `createdAt`。Tool Result 的 `path`、`totalLines`、`command`、`intent`、`contentDigest`、resource revision 和 workspace mutation scope 等结构化事实同时保存在 `ToolCallRecord.result.resultMeta` 与 tool transcript message；模型上下文投影必须读取这些字段，不得通过解析 stdout 正文恢复领域元数据。v13 及更早快照恢复时使用稳定的 legacy identity 和 epoch 时间占位，不能猜测原始时间或结果事实。

模型上下文当前不执行 live 工具结果投影折叠。默认关闭的 `contextReclaimV1` 只允许
`compaction.reclaimMode=off|shadow`：仅在可信窗口的 warning pressure 下，对规范
`ContextProjection` 运行纯 planner，并把严格脱敏、固定容量的候选计数交给可选的进程内 reporter；它不应用
plan、不改 Provider payload/admission、模型调用次数、Runtime event、transcript 或 checkpoint。缺 reporter、
flag 关闭、mode=off、窗口 unknown/normal 时均为零副作用。旧 metadata 在恢复时归一为
`digestScope=legacy_unknown`，不得成为 reclaim 候选。正式生效的压缩仍只有会话总结这一条路径：manual
覆盖全部安全、完整、已结算 turn；auto 仅保护当前尚未完成的最新 turn。原始 transcript 保持持久化，工具
call/result 配对仍在总结边界与最终投影两处 fail closed 校验。任何 live reclaim 或 L3 source identity
变更都需要新的 ADR、计划和 payload golden。

每次模型调用前必须估算完整请求的 system、tool schema、transcript、checkpoint summary、dynamic runtime 和 framing token 分项。可用输入预算由 resolved context window 减去请求/模型的 max output reservation 与配置的 provider safety margin 得出；preflight 默认使用 80% warning、90% compact 和 94% hard 阈值，并产生 `model.context_metrics` telemetry，但瞬时 preflight 不进入 RuntimeState。模型窗口 unknown 时 utilization 必须保持 unknown，不能用虚构默认值触发或绕过压缩。正常模型调用、compaction 与 `/context` 必须共用同一个 projection environment resolver 术语（投影环境解析器）和包含 adapter metadata 术语（适配器元数据）的 `ResolvedModelCapabilities`，不得让正式验收读取旧 preflight 术语（调用前预检）的 estimate 术语（估算值）。`/compact reset` 不以本地比例或窗口估算做容量门禁，重置后的下一次真实请求由 Provider admission 术语（模型供应商接纳）决定。

M2 checkpoint lifecycle 术语（检查点生命周期）已进入 Runtime 术语（运行时）。当前唯一 generator 使用当前对话模型执行一次无工具、零 SDK retry 的 Markdown narrative 请求；不存在 JSON schema、fact ledger、repair、chunk 或 merge 路径。Checkpoint 的唯一模型内容字段是规范化 `summary: string`，投影通过同一纯函数把 `&`、`<`、`>` 转义后生成一个 `<compacted_history>` assistant history frame。`contextCompactionV2` 默认开启基础契约，自动 M2 仍由默认关闭的 `contextCompactionAutoV1` 单独灰度。自动模式为 `off | shadow | live`：只有 flag 术语（功能开关）开启且模式为 `live` 时，才会在可信窗口下命中 `triggerRatio`，或命中显式 `compactAfterEstimatedTokens` 绝对策略并返回 durable `context.compaction_requested(reason=auto)`；`shadow` 只计算资格。scheduler 术语（调度器）随后产生 `compact_context`，completed/failed 结果只能通过原有 Kernel effect lease 术语（内核副作用租约）提交。active checkpoint 术语（活动检查点）替代已覆盖历史前缀并与 live tail 术语（实时尾部）组成模型投影，但不删除或改写原 transcript 术语（原始消息记录）；manual reset 术语（手动重置）只撤销当前投影。

摘要候选必须通过非空、finish reason、无 tool call、可序列化、narrative token 上限和统一 token reduction 术语（文本计量缩减）校验。Manual 与 auto 使用同一最低绝对缩减 1024 token 术语（文本计量单位）；candidate 术语（候选产物）是否低于 target ratio 术语（目标比例）不影响激活。Prompt 要求 narrative 保留用户目标与约束、重要决定、已完成工作、失败与验证结论、未完成事项和继续工作所需路径；模型输出是低权限历史数据，不能决定当前 planning、authorization、interaction、active tools、binding、Skill、verification lifecycle 或 task status。Manual 输入覆盖全部 safe history，auto 仅排除当前 turn；显式 summary input 上限超出时整体失败，不得静默总结局部前缀。不运行 chunk/merge/repair。

自动压缩要求安全边界、最小收益、turn cooldown 术语（轮次冷却）与 low-gain breaker 术语（低收益熔断器）；`compact_due` / `hard_limit` 只保留为 context pressure 术语（上下文压力）诊断。live 自动压缩是当前 turn 普通模型调用的 admission gate：失败或 `summary_aborted` 后 scheduler 必须停止该 turn，不得回落到普通 `call_model`；下一 `turn.started` 后重新 preflight，只允许一次 retryable 恢复尝试绕过旧 cooldown/breaker，恢复再次失败后必须等待成功压缩或明确手动动作。只有 `auto` 的 `insufficient_reduction` 才累计 breaker，手动失败不得污染自动计数，成功的 `manual` 是解除 breaker 的明确手动动作。`ContextCompactionReason` 只允许 `manual | auto`。Token ratio 术语（文本计量比例）、窗口估算、candidate pressure 术语（候选压力）、Provider 术语（模型供应商）错误或压缩失败都不得创建、保持或刷新 hard block 术语（硬阻断）。Hard block 只表示 Runtime correctness failure 术语（运行时正确性故障），scheduler 不用压缩成功或 reset 术语（重置）清除它。通用 HTTP 400 或其他 Provider 失败不会自动创建压缩请求或硬阻断；summary Provider 失败提示检查模型、credential、连接、Provider data policy 与 context/output limits，或执行 `/clear`，不清理、分块或自动重试。压缩请求、完成、失败、正确性阻断与上下文压力必须写入 session trace 术语（会话追踪记录）；完成/失败记录真实 effect duration 术语（副作用耗时），完成同时记录压缩前后与 token 节省，不能只依赖进程内 singleton 术语（单例）。

`contextCompactionManualV1` 默认开启后，`/compact` 命令触发上下文压缩并接受可选的自定义摘要指令（例如 `/compact focus on auth changes`）。命令必须先持久化不进入模型 transcript 的 `user.command_invoked`，再形成 `context.compaction_requested(reason=manual)`，因此退出并重新进入 TUI 后仍会显示命令，但不会把 slash command 当成用户目标发送给模型；不跳过安全边界、lease、schema、mandatory facts 或 reduction 校验。运行中的命令通过 live Kernel control 写入同一状态机，交互、工具或 verification 未结算时保持 pending，不能另开 Kernel 与当前 runner 竞争。若 Runtime 已发出 terminal event、但 live control 尚在收尾，命令必须等待该 control 释放后立刻重新 preflight 和执行，不能遗留为永远等待的 queued 请求。没有足够历史消息时返回 `Not enough messages to compact.`；active checkpoint 已覆盖最新安全消息时，无论是否带自定义摘要指令都不得再次调用 summary Provider，而应返回非错误提示 `No new messages to compact.`。自定义指令只有存在新 safe source 时才能改变摘要侧重点。上述拒绝对应的失败事件必须持久化以供会话重放。

压缩进度使用非持久化 `preparing → summarizing → validating` 并在所有终态（包括 `stale_context`）后清除。Core 统一生成脱敏 terminal notice，App 按 `compactionId` 去重；Footer 百分比只来自 fresh `ContextStatusSnapshot`。Reporter/exporter 由 Runtime 组合根注入，稳定 rollout bucket 使用 `cohortSalt + sessionId`，shadow 不调用 summary model。Local debug 必须显式启用，只允许脱敏结构数据，并执行 POSIX 0700/0600 或 Windows owner-only ACL、原子写与链接拒绝。

启用 MCP progressive disclosure 时，稳定前缀只加入安全排序的 Provider/Tool 名称摘要和内置 `tool_search`；完整 Schema 仅为 session-loaded set 在当前 turn 生成。Provider health、connecting/failed 状态和短暂重连不得进入工具缓存键，也不得改变已保留 descriptor 的名称摘要；revision 或 schema digest 变化仍必须使旧缓存与 Binding 失效。Resources 通过独立内置列表/读取工具披露，不混入 Tool 名称摘要。

上下文压缩可以摘要旧对话，但不能覆盖 Plan Artifact、Execution Receipt、required Verification 或恢复状态。实证缓存数据属于 completed/understanding 记录，不在本 active 规则中充当当前实现事实。
