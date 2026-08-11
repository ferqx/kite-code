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
`bun run qualify:context:produce <artifact.json>`、
`bun run qualify:context:verify <artifact.json>`、`bun run test`、`bun run typecheck`、
`bun run check:core-boundary`、`bun run check:compaction-legacy`、`bun run check:docs-impact`、
`bun run check:docs`。

相关：ADR-0095、ADR-0096、ADR-0100、ADR-0101（accepted）、
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
  → SummaryCompact
  → fresh normal primary
```

候选设计要求三层共享同一 pure prepare/orchestrator、最终 resource admission 与 Provider data admission。原始 transcript
始终不可变；摘要、Working Set 和 Micro 都只是请求投影。旧 Slice B producer、checkpoint-v2 writer、cache-safe
fork、route cache qualification 和 refill guard producer仍保持物理关闭。checkpoint-v1/v2 仅为 bounded legacy
reader；schema v24 下所有成功的 manual/auto summary 都写 `VerifiedContextCheckpointV3`。

这次实现没有加入 Session Memory 类型、事件、配置、shadow/live producer、后台维护或跨会话记忆。Session
Memory 仍是独立 backlog，不是三级路线的前置条件。

## MicroCompact

- 只选择完整 settled、verified `budget_v2`、read-only ToolCallBlock；current turn、最近窗口、checkpoint
  uncovered tail、pending interaction/verification、effectful、legacy、mixed 和失败 block 保持 raw。
- 候选至少早于 active turn 两个 settled turn，同时满足 2 blocks、1024 tokens 和 raw transcript 5% saving。
- candidate/boundary 是 deep-frozen ephemeral artifact，prepare 零写；只有成功 normal primary 确实使用该
  artifact 时，primary terminal batch 才能推进 bounded commit/receipt。
- summary、Working Set prepare、failed/unknown/aborted primary 都不能推进 Micro commit。V3 activation/reset
  清除旧 commit，新的 base identity 为 `checkpoint:<checkpointId>:<sourceRangeDigest>`。
- `contextReclaimV1=false` 或 effective mode 非 live 时，Provider bytes、调用、admission 和 Runtime event 与 raw
  路径保持一致。

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

无 V3、legacy checkpoint、source/cut/summary/route proof 不完整、tamper、future cut 或 active tool/interaction/
verification/stream barrier 时，Working Set 返回 `unavailable` 并回退 raw，不猜测或提升资格。fork/rewind 的
generation-fenced branch base 先移除旧 projection ownership；child Kernel 只有在完整 transcript prefix 重验
成功后才发布 child-generation `checkpoint_v3_rebound`，否则保持 raw。

## SummaryCompact 与 continuation

- manual plain、manual custom 和 auto 共用 `prepareProgressiveContextDecisionV1()`、同一 source builder、同一
  one-request Markdown writer；无工具、零 SDK retry，不存在 chunk/merge/repair/overflow retry。
- manual/custom 必须存在新的 safe source；active V3 已覆盖相同 source 时，request 以 durable no-op 收敛且
  Provider 调用为零。`SummarySourceIdentityV1` 只绑定 canonical source message/turn identity、digest 和 policy，
  不绑定 checkpoint、route/environment 或 control revision。
- auto 只在 `contextCompactionAutoV1=true`、本地 window 已知且 utilization ≥90% 时尝试；估算只选择是否
  SummaryCompact，不能阻止普通 primary，也不解释通用 HTTP 400/413。
- 所有真正到达 summary `resource_budget.dispatch_started` 的 manual/auto attempt 都推进同 source 去重和
  cooldown baseline；auto 需要之后 3 个成功 normal primary 才能再次 eligibility。failed/unknown/aborted
  primary 不计数。
- auto start 把 request、continuation、reservation、resource dispatch 和 summary start 放在一个 CAS batch；manual
  request 可先持久化，但后三项仍同批。started 无 terminal 的恢复只生成 unknown，不重新调用 Provider。
- terminal 严格区分 `reconciled(actual)`、`released(zero-execution proof)` 和 `unknown`。Provider callback entry
  由进程内 single-use `open → entered | closed_without_entry` guard 决定；只有 close winner 可生成
  `prepared_dispatch_not_entered_v1`，崩溃后不能补造。
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

本地 PSMC-06 producer 固定生成 20 条长会话 fixture 和 2000-block/≥8MiB 性能 fixture；独立 verifier要求
mandatory retention=100%、continuation success≥95%、相对 raw 不低于 -2pp、prepare p95≤75ms、restore proof
p95≤100ms、incremental RSS≤96MiB。该证据是确定性本地 structural/semantic gate，不等同真实 Provider 质量背书。

新自动 Summary 与 Micro producer 仍默认关闭；manual V3 writer 不由 auto flag 控制。完成本地 Gate 不等于
default-on、production-supported、无限会话或跨 Provider 等价决定，这些需要独立 rollout 证据和 ADR。

## 明确排除

- Session Memory lifecycle、后台维护、跨会话记忆与 memory shadow/live；
- checkpoint-v1/v2 新 writer、旧 Slice B producer 或 legacy-to-V3 自动提升；
- Provider overflow 后自动 shrink/chunk/repair/retry；
- 删除/改写 transcript，或从摘要恢复 Plan、authorization、Verification、Tool/Runtime authority；
- 未经独立 rollout 的 default-on、production-supported 或无限会话声明。
