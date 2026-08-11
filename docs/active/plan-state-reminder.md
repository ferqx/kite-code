# Runtime 动态状态投影与 Prompt Cache

状态：active

读取时机：修改模型消息顺序、Runtime context、Plan/Mode/Authorization 提醒、上下文压缩或 prompt cache 布局时。

验证：`bun test tests/context.test.ts tests/runtime-context.test.ts tests/runtime/plan-transcript.test.ts tests/runtime/context-compaction.test.ts tests/runtime/context-compaction-manual.test.ts tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-preparation-v2.test.ts tests/runtime/context-reclaim-live.test.ts tests/runtime/context-reclaim-commit.test.ts tests/runtime/legacy-slice-b-removal.test.ts tests/model.test.ts`、`bun run typecheck`。

相关：ADR-0021、ADR-0022、ADR-0024、ADR-0096、ADR-0100、ADR-0101（accepted）、
`three-tier-context-reduction.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

当前 checkpoint-v1 手动压缩 effect 在模型调用前后重新验证安全 source；source 只能由从最旧消息开始的
完整 settled turns 组成，tool call/result 必须一一配对，Runtime 当前 turn 必须受到保护。旧 auto 请求、pending
和 effect 在 live admission/reducer/scheduler 均不产生执行；历史 auto 数据只会被丢弃或 no-op，不能重新调度。

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

上下文投影统一由 pure、deep-frozen `PreparedContextRequestV2` 构造；normal、inspection、candidate 与
restore/debug 共享同一 source/request identity，只有 normal `primary_ready` 可进入 effect-only final admission。
`toolResultBudgetV2=false` 时保持 `compat_v1` bytes；`contextReclaimV1=true + reclaimMode=live` 才可对完整
settled、全 `budget_v2` verified、read-only 的旧 `read_file|search_content|search_files` block 应用 L2。
shadow 仍不应用 plan，只把 bounded 聚合计数交给可选进程内 reporter；off/shadow 不改变 Provider payload、
admission、调用次数或 Runtime 事件。

旧路线中的 live commit 只在成功 primary 的封闭 2/3-event batch 中推进，并绑定 cache-affecting environment；原始
transcript 与 tool call/result 配对不删除。旧 metadata/terminal 归一为
`legacy_unknown + legacy_unverified`，compat/legacy/mixed block 不得成为候选。当前 trusted route registry
为空，live 只属 development-only。现有会话总结是 checkpoint-v1 手动兼容 narrative；旧 canonical L3
source/cache-safe fork/checkpoint-v2 writer、route cache gate 与 refill guard producer 已物理清场。新基准是
MicroCompact、活动 checkpoint summary 加最近原文窗口与全部 uncovered tail、必要时 SummaryCompact 更新；
PSMC-03 已成为活动计划的当前入口，但尚未实施；对应 Gate 通过前不得把 L2 或本次清场表述为完整三级。
Session Memory 不属于当前实现计划。

每次模型调用前必须估算完整请求的 system、tool schema、transcript、checkpoint summary、dynamic runtime 和 framing token 分项。可用输入预算由 resolved context window 减去请求/模型的 max output reservation 与配置的 provider safety margin 得出；preflight 默认使用 80% warning、90% compact 和 94% hard 阈值，并产生 `model.context_metrics` telemetry，但瞬时 preflight 不进入 RuntimeState。模型窗口 unknown 时 utilization 必须保持 unknown，不能用虚构默认值触发或绕过压缩。正常模型调用、compaction 与 `/context` 必须共用同一个 projection environment resolver 术语（投影环境解析器）和包含 adapter metadata 术语（适配器元数据）的 `ResolvedModelCapabilities`，不得让正式验收读取旧 preflight 术语（调用前预检）的 estimate 术语（估算值）。`/compact reset` 不以本地比例或窗口估算做容量门禁，重置后的下一次真实请求由 Provider admission 术语（模型供应商接纳）决定。

M2 checkpoint lifecycle 术语（检查点生命周期）已进入 Runtime 术语（运行时）。当前唯一 generator 使用当前对话模型执行一次无工具、零 SDK retry 的 Markdown narrative 请求；不存在 JSON schema、fact ledger、repair、chunk 或 merge 路径。Checkpoint 的唯一模型内容字段是规范化 `summary: string`，投影通过同一纯函数把 `&`、`<`、`>` 转义后生成一个 `<compacted_history>` assistant history frame。当前只有 `/compact` 可以产生新 checkpoint-v1；旧 `contextCompactionAutoV1`/`autoMode` 只保留配置解析兼容，没有 scheduler producer，不能启用自动 shadow/live。scheduler 只消费已经持久化的 manual request，completed/failed 结果只能通过原有 Kernel effect lease 术语（内核副作用租约）提交。active checkpoint 术语（活动检查点）替代已覆盖历史前缀并与 live tail 术语（实时尾部）组成模型投影，但不删除或改写原 transcript 术语（原始消息记录）；manual reset 术语（手动重置）只撤销当前投影。

摘要候选必须通过非空、finish reason、无 tool call、可序列化、narrative token 上限和统一 token reduction 术语（文本计量缩减）校验。当前 manual producer 使用最低绝对缩减 1024 token；candidate 术语（候选产物）是否低于 target ratio 术语（目标比例）不影响激活。Prompt 要求 narrative 保留用户目标与约束、重要决定、已完成工作、失败与验证结论、未完成事项和继续工作所需路径；模型输出是低权限历史数据，不能决定当前 planning、authorization、interaction、active tools、binding、Skill、verification lifecycle 或 task status。Manual 输入覆盖全部 safe history；显式 summary input 上限超出时整体失败，不得静默总结局部前缀。不运行 chunk/merge/repair。

`compact_due` / `hard_limit` 当前只保留为 context pressure 术语（上下文压力）诊断，不会创建自动压缩请求。`ContextCompactionReason` 为旧事件兼容仍允许 `manual | auto`，但新 producer 只写 `manual`。Token ratio 术语（文本计量比例）、窗口估算、candidate pressure 术语（候选压力）、Provider 术语（模型供应商）错误或压缩失败都不得创建、保持或刷新 hard block 术语（硬阻断）。Hard block 只表示 Runtime correctness failure 术语（运行时正确性故障），scheduler 不用压缩成功或 reset 术语（重置）清除它。通用 HTTP 400 或其他 Provider 失败不会自动创建压缩请求或硬阻断；summary Provider 失败提示检查模型、credential、连接、Provider data policy 与 context/output limits，或执行 `/clear`，不清理、分块或自动重试。压缩请求、完成、失败、正确性阻断与上下文压力必须写入 session trace 术语（会话追踪记录）；完成/失败记录真实 effect duration 术语（副作用耗时），完成同时记录压缩前后与 token 节省，不能只依赖进程内 singleton 术语（单例）。

`contextCompactionManualV1` 默认开启后，`/compact` 命令触发上下文压缩并接受可选的自定义摘要指令（例如 `/compact focus on auth changes`）。命令必须先持久化不进入模型 transcript 的 `user.command_invoked`，再形成 `context.compaction_requested(reason=manual)`，因此退出并重新进入 TUI 后仍会显示命令，但不会把 slash command 当成用户目标发送给模型；不跳过安全边界、lease、schema、mandatory facts 或 reduction 校验。运行中的命令通过 live Kernel control 写入同一状态机，交互、工具或 verification 未结算时保持 pending，不能另开 Kernel 与当前 runner 竞争。若 Runtime 已发出 terminal event、但 live control 尚在收尾，命令必须等待该 control 释放后立刻重新 preflight 和执行，不能遗留为永远等待的 queued 请求。没有足够历史消息时返回 `Not enough messages to compact.`；active checkpoint 已覆盖最新安全消息时，无论是否带自定义摘要指令都不得再次调用 summary Provider，而应返回非错误提示 `No new messages to compact.`。自定义指令只有存在新 safe source 时才能改变摘要侧重点。上述拒绝对应的失败事件必须持久化以供会话重放。

压缩进度使用非持久化 `preparing → summarizing → validating` 并在所有终态（包括 `stale_context`）后清除。Core 统一生成脱敏 terminal notice，App 按 `compactionId` 去重；Footer 百分比只来自 fresh `ContextStatusSnapshot`。Reporter/exporter 由 Runtime 组合根注入。旧 rollout bucket/shadow producer 已删除；Local debug 必须显式启用，只允许脱敏结构数据，并执行 POSIX 0700/0600 或 Windows owner-only ACL、原子写与链接拒绝。

启用 MCP progressive disclosure 时，稳定前缀只加入安全排序的 Provider/Tool 名称摘要和内置 `tool_search`；完整 Schema 仅为 session-loaded set 在当前 turn 生成。Provider health、connecting/failed 状态和短暂重连不得进入工具缓存键，也不得改变已保留 descriptor 的名称摘要；revision 或 schema digest 变化仍必须使旧缓存与 Binding 失效。Resources 通过独立内置列表/读取工具披露，不混入 Tool 名称摘要。

上下文压缩可以摘要旧对话，但不能覆盖 Plan Artifact、Execution Receipt、required Verification 或恢复状态。实证缓存数据属于 completed/understanding 记录，不在本 active 规则中充当当前实现事实。
