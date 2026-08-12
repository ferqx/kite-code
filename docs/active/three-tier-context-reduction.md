# 三级上下文缩减：渐进式实现与资格边界

状态：active

读取时机：修改 Runtime context、Provider/resource admission、MicroCompact、checkpoint、Working Set、
SummaryCompact、Runtime schema、恢复/分支或上下文资格化时。

验证：`bun test tests/context-reclaim.test.ts tests/context-working-set.test.ts
tests/context-working-set-performance.test.ts tests/progressive-context-orchestrator.test.ts
tests/runtime/context-reclaim-live.test.ts tests/runtime/context-reclaim-commit.test.ts
tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-compaction-summary.test.ts
tests/runtime/runtime-event-v24.test.ts tests/runtime/summary-lifecycle-v1.test.ts
tests/runtime/schema-v22-migration.test.ts tests/runtime/schema-v23-migration.test.ts
tests/runtime/checkpoint-v2.test.ts tests/runtime/legacy-slice-b-removal.test.ts`、
`bun run qualify:context`、`bun run test`、`bun run typecheck`、
`bun run check:core-boundary`、`bun run check:compaction-legacy`、`bun run check:docs-impact`、
`bun run check:docs`。

相关：ADR-0095、ADR-0096、ADR-0100、ADR-0101、ADR-0102（accepted）、
[`../space/plans/2026-08-10-progressive-context-compaction.md`](../space/plans/2026-08-10-progressive-context-compaction.md)。

## 当前结论

三级路线已实现并通过 PSMC-06 本地资格 Gate。首次整体 review 与唯一一次最终回归复审曾判定 NO-GO；随后按
复审清单补齐 opaque branch candidate/nonce 所有权、同 candidate contention retry、ACK completion resolution、
逐 cut `LegacyNamedCutProof`、旧 fence active/deleted/orphan 分类、fresh target `1/v24/1`、catalog-version CAS、
全域 nested exact schema、length-first/ledger/quota 门禁、六个 Summary crash cut 与 continuation exactly-once。

2026-08-11 最终验证为 3325 pass、8 skip、0 fail；20 条语义 fixture 的 mandatory retention 与 continuation
success 均为 100%，相对 raw 为 0pp；2000-block/8,545,671-byte fixture 的 producer 实测 prepare p95
40.245ms、restore p95 42.810ms、peak RSS 0.922MiB，独立重放 verifier 同样通过阈值。实现完成不等于 rollout：
auto 与 Micro live flag 继续默认关闭，不声明 default-on、无限会话或 production qualification。

当前实现只有一条渐进式路线：

```text
raw
  → MicroCompact
  → Verified Checkpoint Working Set
  → L2.5 Oversized Block Offload（默认关闭）
  → SummaryCompact
  → fresh normal primary
```

### 单一调度机制与执行时机

每个 normal primary 在 effect lease/reservation 之前，只调用一次 pure
`prepareProgressiveContextDecisionV1()`。它接收同一轮的 raw/Micro/Working Set 预估、有效 feature policy、可用
tool set、checkpoint route identity 和 Summary lifecycle；它不写状态、不调用 Provider，也不重试。因而四层不是四个
相互竞争的后台任务，而是一次请求准备中的固定优先级选择：

| 阶段 | 何时尝试 | 成功后如何协作 | 不适用或仍有压力时 |
| --- | --- | --- | --- |
| L1（工具结果预算） | 每个 tool terminal 写 transcript 时 | 先把所有模型可见 tool result 变为有界、verified `budget_v2`；它是后续层唯一可用的 canonical 输入 | 保留 compat/raw，绝不把 pre-L1 原文回填到模型 |
| MicroCompact | raw preflight 达到 `warning` 以上，或达到 `reclaimAfterEstimatedTokens`；还须完整 read-only block、收益和缓存世代门槛 | effective projection 已回落至 `normal/unknown` 时，直接 primary；成功 primary 才 commit | 不合格、未回落或未 live 时继续检查 Working Set |
| L2 Working Set | 已有完整、route-matched V3 checkpoint，且 Working Set preflight 回落至 `normal/unknown` | primary 使用 `summary + W + T`；不写 Micro commit | 无 checkpoint、proof/barrier 失败或仍有压力时才考虑 SummaryCompact |
| L2.5 offload | 仅 L2 的 `W` 因完整 tool block 超过容量且 `oversizedBlockOffloadV1 && toolResultBudgetV2` effective 时 | 用相同 policy 和当前 Provider tool set 将合格的整块 read/search result 换为 stub，使 L2 可用；它不写 durable state | 不可重读、无正向节省或仍超容量时 fail-closed，按 L2 unavailable 处理 |
| L3 SummaryCompact | manual 有新的 safe source；或 auto 已开、window 已知、raw utilization ≥90%、压力为 warning/compact/hard，且前述本地投影都未降压 | 成功后写 V3 checkpoint；下一次 normal primary 再从该 checkpoint 建 L2 | cooldown、同源去重、resource resolution 或安全/收益 gate 任一失败时保留最佳 local projection，不自动 retry |

selector 必须向 L2 Working Set 传入 L2.5 的 effective flag 与当前 Provider tool names；否则“offload 后可用”的
Working Set 会被错误判为 unavailable，破坏上述优先级。该输入与 `buildContextProjection()` 使用同一 projection
environment，确保选择和最终 Provider payload 一致。

候选设计要求三层共享同一 pure prepare/orchestrator、最终 resource admission 与 Provider data admission。原始 transcript
始终不可变；摘要、Working Set 和 Micro 都只是请求投影。旧 Slice B producer、checkpoint-v2 writer、cache-safe
fork、route cache qualification 和 refill guard producer仍保持物理关闭。checkpoint-v1/v2 仅为 bounded legacy
reader；schema v24 下所有成功的 manual/auto summary 都写 `VerifiedContextCheckpointV3`。

这次实现没有加入 Session Memory 类型、事件、配置、shadow/live producer、后台维护或跨会话记忆。Session
Memory 仍是独立 backlog，不是三级路线的前置条件。

## MicroCompact

- 只选择完整 settled、verified `budget_v2`、read-only ToolCallBlock；current turn、最近窗口、checkpoint
  uncovered tail、pending interaction/verification、effectful、legacy、mixed 和失败 block 保持 raw。
- 候选至少早于 active turn 两个 settled turn。首次 live commit 同时满足 2 blocks、4096 tokens 和 raw transcript
  5% saving；它是一次有意的缓存世代切换，而不是每轮的微小改写。
- 已有 commit 时，先逐字重建该稳定投影；只有距上次 commit 至少 10 个 turn、至少积累 2 个新增完整 eligible
  block、增量节省 8192 tokens 且仍有 5% saving，才允许下一次 commit。`hard_limit` 只可跳过十回合等待，不能
  跳过其余安全和收益门槛；不满足时保持旧世代并交给 Working Set/Summary。
- candidate/boundary 是 deep-frozen ephemeral artifact，prepare 零写；只有成功 normal primary 确实使用该
  artifact 时，primary terminal batch 才能推进 bounded commit/receipt。
- summary、Working Set prepare、failed/unknown/aborted primary 都不能推进 Micro commit。V3 activation/reset
  清除旧 commit，新的 base identity 为 `checkpoint:<checkpointId>:<sourceRangeDigest>`。
- `contextReclaimV1=false` 或 effective mode 非 live 时，Provider bytes、调用、admission 和 Runtime event 与 raw
  路径保持一致。
- `cacheEpochId` 包含 reclaim policy identity，重放已提交 commit 前也重新验证；升级后的不同 policy 不会复用旧
  commit。每次实际切换应分别观测 summary fork cache hit、切换后首轮主请求 cache miss，以及后续稳定前缀命中率。

## VerifiedContextCheckpointV3 与 Working Set

V3 从完整 canonical transcript prefix 独立重算 message/turn/tool pairing、source range digest、summary digest、
route identity 和最后 transcript-producing event cut。control、resource、lease、checkpoint 和 cooldown event
不会推进 source cut。首次和增量 checkpoint 都不信任历史 chain；base checkpoint 只用于审计绑定。

Working Set 使用唯一半开区间。规范 block 序列为 `B=[b0..b(n-1)]`，V3 覆盖 `[0,c)`，recent overlap 为
`[w,c)`，uncovered tail 为 `[c,n)`；最终投影严格为：

```text
checkpoint summary + B[w,c) + B[c,n)
```

recent 与 tail 不相交，全部 tail 恰好出现一次。窗口策略冻结为最少 2048 tokens、4 条 durable 非空
user/assistant text、最多 8192 tokens 和已知 context window 的 25%。不可分 block 不拆分。Working Set 不调用
Provider，不持久化 boundary；最终 bytes 仍经过 effect-only resource admission 与 Provider data admission。

若候选 checkpoint 的 recent overlap 因单个不可分 block 或合计容量超过该上限而得到
`recent_window_exceeds_capacity`，SummaryCompact 必须在 Provider dispatch 前以可诊断的 no-dispatch 终态收敛；
不得为一个永远无法形成 L2 的 checkpoint 消耗摘要调用。原始 transcript 与 raw projection 保持可用。该规则不拆分
tool block，也不扩大 Working Set 容量。

`features.oversizedBlockOffloadV1` 默认关闭；开启还要求 `toolResultBudgetV2`。它只在 verified checkpoint 的
`W=[w,c)` 内、且 raw Working Set 因容量无法接纳时，尝试将**整个**已结算 tool block 的所有 result 投影为
确定性 stub。资格严格限于当前 Provider 仍提供的 `read_file`、`search_content`、`search_files`，每个 call 都必须
成功、`read_only`、`budget_v2` verified、拥有匹配 digest 和稳定 locator；任一 call 不合格则整个 block 不替换。
assistant tool call、参数、顺序和 tool-result pairing 仍完整进入 Provider，stub 只提示模型以原参数重做只读调用。
这不是 transcript rehydrate：重读的目标资源可能已变化，digest 只标识原结果。L2.5 不处理 `T=[c,n)`、active/current
turn、用户/普通 assistant/runtime 文本、失败/副作用/legacy/MCP/Shell block 或任一 unsafe barrier；不写 durable
event、manifest 或 Micro commit，且不改变 canonical transcript、V3 proof/coverage、摘要 source。没有可用重读工具或
不能获得正向节省时，保持 `recent_window_exceeds_capacity` fail-closed/raw fallback。仅 effective=true 的 policy 进入
route identity；关闭时保留 pre-L2.5 digest 形状与 Provider payload 字节。

无 V3、legacy checkpoint、source/cut/summary/route proof 不完整、tamper、future cut 或 active tool/interaction/
verification/stream barrier 时，Working Set 返回 `unavailable` 并回退 raw，不猜测或提升资格。fork/rewind 的
generation-fenced branch base 先移除旧 projection ownership；child Kernel 只有在完整 transcript prefix 重验
成功后才发布 child-generation `checkpoint_v3_rebound`，否则保持 raw。

## SummaryCompact 与 continuation

- manual plain、manual custom 和 auto 共用 `prepareProgressiveContextDecisionV1()`、同一 source builder、同一
  one-request Markdown writer；无工具、零 SDK retry，不存在 chunk/merge/repair/overflow retry。
- SummaryCompact 在 Provider dispatch 前必须通过完整 canonical transcript block/source 校验；缺失 identity、
  incomplete/reordered tool block 或跨 turn tool pairing 一律以 `unsafe_boundary`、不可重试收敛，Provider 调用为零。
  Provider 返回只接受显式正常结束值（`stop`、`end_turn`、`completed`、`complete`）；缺失、截断、过滤或其他结束原因
  一律作为 `truncated_summary` 拒绝，绝不激活 checkpoint。
- V3 仍从完整 canonical safe prefix 独立重算；不会把旧摘要作为新的摘要输入，因而不存在摘要套摘要。为防止该
  全前缀重算在长会话里以很小的边际主请求节省反复付费，L3 在 dispatch 前计算
  `summary_input_tokens / maximum_primary_projection_reduction`。默认上限为 5；超过时 manual 和 auto 都不调用
  Provider，保留 raw 与既有 checkpoint。`compaction.maxSummaryInputToReductionRatio` 可收紧或放宽该有限正值；这
  只是 admission 门禁，不改变 checkpoint 的全前缀独立验证语义。
- manual/custom 必须存在新的 safe source；active V3 已覆盖相同 source 时，request 以 durable no-op 收敛且
  Provider 调用为零。`SummarySourceIdentityV1` 只绑定 canonical source message/turn identity、digest 和 policy，
  不绑定 checkpoint、route/environment 或 control revision。
- auto 只在 `contextCompactionAutoV1=true`、本地 window 已知且 utilization ≥90% 时尝试；估算只选择是否
  SummaryCompact，不能阻止普通 primary，也不解释通用 HTTP 400/413。
- 所有真正到达 summary `resource_budget.dispatch_started` 的 manual/auto attempt 都推进同 source 去重和
  cooldown baseline；auto 默认需要之后 3 个成功 normal primary 才能再次 eligibility，或使用
  `compaction.cooldownTurns` 的非负整数覆盖。failed/unknown/aborted primary 不计数；同一 source 无论配置值均
  不会重新 dispatch。
- auto start 把 request、continuation、reservation、resource dispatch 和 summary start 放在一个 CAS batch；manual
  request 可先持久化，但后三项仍同批。started 无 terminal 的恢复只生成 unknown，不重新调用 Provider。
- terminal 严格区分 `reconciled(actual)`、`released(zero-execution proof)` 和 `unknown`。Provider callback entry
  由进程内 single-use `open → entered | closed_without_entry` guard 决定；只有 close winner 可生成
  `prepared_dispatch_not_entered_v1`，崩溃后不能补造。
- 所有已进入 Summary Provider 的终态都持久化脱敏 `providerUsage`：可用时记录 input/output 与 prompt-cache
  hit/miss token counters。该记录适用于成功、stale 和产物校验拒绝；有完整 input/output 时资源账本即使拒绝
  checkpoint 也以 actual reconciled 结算，缺失 authoritative usage 则保持 unknown，绝不把已执行调用伪装为零成本。
  `CompactionReporter` 同步聚合这些数值（包括 rejected），不记录 summary、prompt、transcript 或工具正文。
- auto 的 reconciled/released terminal 进入 `normal_reprepare_required`；unknown 进入
  `resource_resolution_required`。普通 late-resource 通道不能唤醒它；只有专用 late-summary-resolution 双事件
  CAS 可绑定原 unknown reservation、actual usage、continuation 和新 resolution identity 后进入 reprepare。
- continuation 从 committed state fresh prepare。consume event、新 primary effect lease、独立 requestId/
  invocationId、reservation 和 resource dispatch 在同一 CAS；consume 后 crash 原子收敛
  `run.error(unknown) + resource unknown + turn.aborted`，不得重派。

## Runtime schema v24 候选

所有新 durable event 使用 `runtime-event:v24` 最终 envelope canonical bytes：schema、producer thread/generation、
revision、normalized causation、occurredAt 和完整 payload 一起计算 event ID。Kernel 注入默认/timestamp 后再 hash；
Store 持久 producer generation/canonical byte count 并用同一 pure builder机械复核。`tool.progress`、model text/
reasoning delta 与 reasoning-completed 是 closed ephemeral subset，不获得 event ID/revision，也不能进入 Store/reducer。

rolling state 已有 `RuntimeStorageFormatV1`、per-thread event migration build、Store-wide fence ledger build、
immutable branch receipt/closure/completion、双端 CAS、typed commit result 与 ACK-unknown resolution。strict-v24
fork/rewind 已使用 250ms `BEGIN IMMEDIATE`、写前 identity/proof 重验并在同事务保存 authority；迁移 build 未完成时
branch API fail-closed。legacy named cut 尚未生成 eager proof，且当前兼容入口仍在 Store 内调用 pure branch
candidate producer；这两项未收口前 strict-v24 候选仍不能通过 ADR-0101 最终所有权验收。

Runtime correctness failure（Store checksum、canonical ordering、tool pairing、illegal half-batch）仍 hard fail；单个
V3 projection proof 失败只隔离该 projection 并回退 raw。

## 资格与 rollout

`bun run qualify:context` 是本地 PSMC-06 的唯一日常入口：它生成 20 条长会话 fixture 和
2000-block/≥8MiB 性能 fixture，再由独立 verifier 重放并删除自有临时 artifact。诊断需要保留 artifact 时，
可使用 `bun run qualify:context --artifact=<path>`；底层 producer/verifier 不再作为日常命令。
独立 verifier要求
mandatory retention=100%、continuation success≥95%、相对 raw 不低于 -2pp、prepare p95≤75ms、restore proof
p95≤100ms、incremental RSS≤96MiB。该证据是确定性本地 structural/semantic gate，不等同真实 Provider 质量背书。

旧 Slice-A local gate 与 synthetic route/rollout/semantic contracts 继续作为 L2 回归和 fail-closed 历史资产，
但不是当前机制资格或策略质量的入口。真实质量只由显式 opt-in 的 live pilot 与后续四臂 agent benchmark 判断；
本地 PSMC-06 通过不能抵消真实模型质量失败。

新自动 Summary 与 Micro producer 仍默认关闭；manual V3 writer 不由 auto flag 控制。完成本地 Gate 不等于
default-on、production-supported、无限会话或跨 Provider 等价决定，这些需要独立 rollout 证据和 ADR。

## 明确排除

- Session Memory lifecycle、后台维护、跨会话记忆与 memory shadow/live；
- checkpoint-v1/v2 新 writer、旧 Slice B producer 或 legacy-to-V3 自动提升；
- Provider overflow 后自动 shrink/chunk/repair/retry；
- 删除/改写 transcript，或从摘要恢复 Plan、authorization、Verification、Tool/Runtime authority；
- 未经独立 rollout 的 default-on、production-supported 或无限会话声明。
- `rehydrate_context_block`；精确读取历史 transcript 的模型工具需要独立的 authority、range budget 和 fork/rewind
  失效协议，未随本期引入。
