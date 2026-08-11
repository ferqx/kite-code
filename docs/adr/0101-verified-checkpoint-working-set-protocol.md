# ADR-0101：Verified Checkpoint、Working Set 区间与摘要续跑协议

状态：accepted
日期：2026-08-11
决策者：`github:@ferqx`
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0090、ADR-0091、ADR-0096、ADR-0100
局部取代：ADR-0100 中 custom manual 可无条件直达 SummaryCompact、本地容量估算可返回容量错误，以及
Micro/Working Set 共用持久 compact boundary 的表述；ADR-0096 第 7 节“late resource reconciliation 不得复活
scheduling”的结论仅在本 ADR 定义的、已有 durable auto Summary continuation 的专用 late-summary-resolution
双事件 CAS 中被局部取代；ADR-0096 的 release-proof union 仅为 Summary 增加 Core-owned
`prepared_dispatch_not_entered_v1`。普通 model/tool late reconciliation、release proof 与其他 ADR-0096 边界保持
不变；pre-v24 Kernel generic event-ID builder 仅在 schema v24 writer 中被完整 RuntimeEvent canonical envelope ID
取代，历史 event ID 与 reader 不改写
关联：`docs/design/2026-08-10-progressive-context-compaction-rfc.md`、
`docs/space/plans/2026-08-10-progressive-context-compaction.md`

## 背景

ADR-0100 已确定 `MicroCompact → Checkpoint Working Set → SummaryCompact` 的成本顺序，但没有冻结旧
checkpoint-v1 的信任边界、Working Set 的唯一分段公式、Summary 终态到 normal primary 的持久续跑，以及
Micro commit 与 checkpoint activation 的所有权。若这些协议留到编码阶段，恢复、自动触发和 projection
writer 会重新分叉。

## 决策一：新增独立可验证 checkpoint

首个新格式命名为 `VerifiedContextCheckpointV3`，避免与只读兼容的历史 checkpoint-v2 混淆；Runtime schema
由 v23 升为 v24。V3 必须包含：

- `checkpointId`、`compactionId`、`reason`、`createdAt`；
- 起始/截止 message identity、截止 turn identity、source revision 和只指向最后一个 transcript-producing event 的
  `sourceProducingEventCutV1`；
- 对完整 canonical transcript prefix 独立重算的 `sourceRangeDigest` 与 `sourceProjectionPolicyId`；
- 唯一 Markdown `summary`、`summaryContentDigest`、before/after token；
- prompt contract、route identity；增量生成时可记录 base checkpoint/content digest，但 base 只用于审计和输入
  绑定，不能替代完整 prefix 重算。

每份 V3 的资格独立于历史 checkpoint chain。滚动 history 即使截断为 128 条，也不影响 active checkpoint
验证。restore 必须从 immutable transcript 与 source event cut 重算完整 prefix；不能只检查 digest 非空或 ID
存在。

checkpoint-v1 以及只读 reader 降级得到的 v1 一律标记为 `legacy_unverified`。它们在新 route 关闭时继续满足
当前兼容投影，但不得成为 `CompactPrefixProvider` 的 verified prefix。启用新 route 后只能回退 raw，或从完整
canonical transcript 重新生成 V3；不得把旧 v1 narrative/digest 自动升级、续链或作为可信 base。

V3 proof、summary digest 或 coverage 派生验证失败且 Store/transcript 真源完整时，只使该 prefix
`unavailable` 并隔离该 projection。Store checksum、event ordering、tool pairing 或 transcript 真源损坏仍是
Runtime correctness failure。

## 决策二：Working Set 使用唯一半开区间

把 durable canonical transcript 规范化为完整协议块序列 `B=[b0...b(n-1)]`。Verified checkpoint 覆盖
`C=[0,c)`；overlap recent window 为 `W=[w,c)`；uncovered tail 为 `T=[c,n)`，其中 `0≤w≤c≤n`。最终历史投影
严格为：

```text
checkpoint summary + B[w,c) + B[c,n)
```

因此每个 `index≥c` 的 block 恰好出现一次，window 与 tail 的 message identity 不相交；summary 可以在语义上
覆盖 window，但不能靠事后 message-ID 去重修复选择器错误。

`W` 只能从 checkpoint coverage 内的完整 settled turn/tool block 选择。`T` 包含 coverage 之后全部 durable、
Provider-safe 消息，包括当前 active turn 已经 settled 的 user/text/tool pairs。未终结 tool pair、interaction、
required verification 和非 durable streaming fragment 是 scheduler barrier：在它们以更高优先级收敛前，不得
进入 `call_model`，也不得被 window selector 猜测或裁剪。

recent window 与全部 tail 保持 raw，不应用 MicroCompact。窗口按冻结的 min token、最少文本消息、max token、
稳定向旧 tie-break 选择；不可分割 block 超过 max 时整体保留。所有这些值必须在 RFC review 阶段冻结并进入
policy identity。

Working Set 是每次 prepare 的 deep-frozen ephemeral artifact，不写持久 boundary。V3 checkpoint 自身就是
summary coverage boundary；window/tail 身份进入 request identity，并在 final admission 前重验。

## 决策三：manual 与 auto 只改变触发原因

plain manual 与 custom manual 均可不依赖本地 pressure 请求 SummaryCompact，但必须满足 ADR-0090：存在新的
safe source、best-case saving 足够、source 可安全构造且 Provider/resource admission 允许。没有新 safe source
时以 durable no-op 收敛，Provider call count 为零；custom 只改变新摘要的侧重点。

auto 的 token/window estimate 只决定是否尝试一次 SummaryCompact，不能阻止普通 primary。只有 auto Summary
代表一个已持久化、被暂停的 normal request；它在 Summary 终态且资源已经 `reconciled(actual)`，或以“外部请求
确定未执行”的 proof `released` 后，scheduler 才对 raw/Micro/Working Set 中当前可构造的最佳候选执行一次 fresh
normal dispatch。资源进入 `unknown` 时 continuation 必须停在 `resource_resolution_required`，不得立即创建 primary
reservation；只有后续 bounded late reconciliation 提供 actual usage 后才可转为 `normal_reprepare_required`。
plain/custom manual 从不派生 normal continuation。

本地 over-window/ratio 不能产生 typed capacity failure；只有明确的 Provider/adapter typed overflow 或权威请求
上限合同可以返回容量失败。通用 HTTP 400/413 和错误文本仍不得推断 overflow。

## 决策四：Summary 与 primary 是两个持久 effect

自动 SummaryCompact 是 normal primary 之前的独立 durable scheduler phase，不与 primary 共用 reservation、
dispatch identity 或 Provider attempt。

1. auto 路径由 Kernel 在同一 CAS batch 持久 summary request、normal continuation、resource reservation、
   `resource_budget.dispatch_started` 与 `context.summary_dispatch_started_v1`，初始 continuation 为
   lifecycle=`dispatch_started` 且 auto continuation 必填；该 batch 前 admission denial 不创建 auto
   attempt/continuation。manual request 可先由命令持久，但 reservation、`resource_budget.dispatch_started` 与
   `context.summary_dispatch_started_v1` 仍须原子同批；
2. terminal batch 必须使用现有资源 ledger 的判别终态：有可信 actual usage 时 `resource_budget.reconciled`；有本地
   Provider admission denial 等零外部执行 proof 时 `resource_budget.released`；已经 dispatch、usage 不可知时
   `resource_budget.unknown`。不得把三者统称或伪造成 reconciliation；
3. auto 的 reconciled/released terminal batch 把 continuation 置为 `normal_reprepare_required`；unknown batch
   置为 `resource_resolution_required`，后续只有 bounded late reconciliation 与
   `normal_reprepare_required` 经专用 Kernel path 同批提交后才可续跑。该 path 必须验证原 unknown
   reservation、仍有效的同一 auto continuation、current generation/source/turn，并使用新的 resolution batch
   identity；普通 `applyLateResourceReconciliation` 仍只记账，不能复活调度。manual terminal 不创建任何
   continuation；
4. 状态持久化独立的 `SummarySourceIdentityV1`、`successfulPrimaryOrdinal` 与 `AutoSummaryCooldownV1`，禁止同一
   canonical source 重试，并要求 summary attempt 后出现 3 个成功 normal primary terminal 才能再次 auto；
5. scheduler 从 committed state fresh prepare；随后把 `normal_reprepare_consumed` 与新的 primary
   lease/reservation/resource-dispatch identity 在同一 CAS 中提交并切 lifecycle=idle，再执行一次 normal Provider
   调用；consume 前 crash 可重新 prepare，consume 后 crash 不得再次 dispatch；
6. 新用户事件或 projection environment drift 使旧 continuation stale，并从最新 state 重新求值，不能使用旧
   prepared bytes。

`SummarySourceIdentityV1` 只绑定 canonical transcript prefix 的 covered message/turn identities、source digest 与
source projection policy，不包含 Runtime revision/event cut，也不得包含 checkpoint output、summary digest、模型
route 或 projection environment。V3 的 restore proof 另存 `sourceProducingEventCutV1`：它只能指向构成 covered
prefix 的最后一个 durable transcript-producing event，control/resource/lease/config/telemetry/checkpoint/cooldown
事件不得推进。`successfulPrimaryOrdinal` 只在
成功 normal primary terminal 后递增；summary 后紧接的 normal primary 若成功，计作三个 cooldown turn 的第一个，
failed/unknown/aborted 不计。restart 保留计数；rewind 按目标 event cut 重算；fork 从目标 cut 复制已完成计数并以
fork generation 隔离，不能继承未终结 attempt/continuation。

所有真正到达 `resource_budget.dispatch_started` 的 manual/auto Summary attempt 都更新
`lastAttemptSourceIdentity` 与三次成功 primary cooldown baseline；pure/no-op/no-reservation denial 不更新。这样
manual attempt 后不能立即由 auto 对同一 source 再 dispatch。

该状态只参与 auto eligibility，不阻止用户显式 manual retry。若上次 manual failed/stale、active checkpoint 未
推进，而 checkpoint 后仍有同一批 safe source，用户可串行重试；它仍须通过 no-new-source（相对 active
checkpoint）、best-case saving、resource/data admission。上次成功已覆盖该 source 时，manual retry 因没有新
safe source 以 durable no-op 收敛。

恢复必须冻结以下 crash cut：request 前、reservation 后但 dispatch 前、`dispatch_started` 后、summary terminal
batch 前后、checkpoint activation 后但 primary reservation 前、primary `dispatch_started` 后。started 无 terminal
恢复为 `unknown_external_outcome` 与 `resource_budget.unknown`，相同 attempt/source 不重放且不立即续跑；activation
后崩溃仅在资源已 reconciled/released 时由 durable continuation 恢复 fresh primary，而不是再次摘要。

Provider 返回时原 effect lease 若因新事件而 stale，不得丢弃 attempt。专用 current-state
`stale-summary-settlement` CAS 只在同 generation 且同一 started attempt/dispatch binding 仍存在时接受：候选一律
不激活 V3；known actual 提交 typed stale terminal + reconciled，零执行 proof 提交 failed + released，usage
unknown 提交 unknown terminal + resource unknown。若旧 normal turn 已被新用户 source supersede，同批写
`normal_continuation_superseded` 且不续跑；仅 projection environment drift、原 normal turn/source 仍有效时，才按
资源终态进入 reprepare 或 resource-resolution。该入口不能接受任意 model/tool terminal，也不能绕过 generation
fence 或复用旧 lease expected revision。

在 Provider callback 尚未进入时，source、environment 或仅 Runtime control revision 的漂移也必须收敛。
Kernel/Runner 共持有单次 `ProviderDispatchEntryGuardV1`，状态机固定为同步原子
`open → entered | closed_without_entry`。只有 `tryEnter()` 的 winner 可调用 Provider；只有
`closeWithoutEntry()` 的 winner 可生成一次性 `prepared_dispatch_not_entered_v1` release proof，loser 永久失败，
close 赢后迟到 callback 必须在边界前退出。proof 绑定同进程、generation、durable started receipt 与 guard nonce，
Controller/adapter 不能自报或重放。进程崩溃会丢失 open guard，恢复不能补造 proof，只能把 started reservation
归为 unknown。

## 决策五：分离 Micro 与 checkpoint 所有权

Micro plan/boundary 在 prepare 阶段只存在于内存。只有成功 primary 确实使用该 Micro artifact 时，现有 primary
terminal CAS batch 才能推进 bounded Micro commit/receipt；summary source、candidate、failed primary 或
Working Set recent/tail 不能推进它。

V3 checkpoint activation 是另一种 writer ownership。activation batch 必须清除或按新
`projectionBaseIdentity=checkpoint:<checkpointId>:<sourceRangeDigest>` 重基 Micro commit；V1 首版选择清除。
checkpoint reset 同样清除 Micro commit，并生成新的 raw base identity，禁止旧 commit 复活。rewind/fork 由目标
event cut 与 Store generation fence 决定可见 checkpoint/base；两个 writer 不能独立推进同一 coverage。

## 决策六：v24 类型、事件与 reducer

实施前必须冻结并由 schema/golden/fault tests 验证：

- `VerifiedContextCheckpointV3`、`LegacyUnverifiedCheckpointV1`、`SummarySourceIdentityV1`、
  `NormalCompactionContinuationV1`、`SummaryAttemptV1`、`AutoSummaryCooldownV1` 和 `projectionBaseIdentity`；
- summary requested、两类 dispatch-started、completed、failed、unknown-outcome、resource-resolution-required、
  normal-reprepare-required、normal-reprepare-consumed/consumption-detached、continuation-superseded、
  branch-abandoned 与 checkpoint-rebound 事件及其 exact union；
- success/failure terminal CAS batch validator、resource reconciled/released/unknown 判别终态、continuation
  transition、terminalBatch/causation linkage 和同源去重；
- `SummaryDispatchStartBindingV1`、`SummaryStartedReceiptV1`、`SummaryLifecycleStateV1`、
  `SummaryTerminalAdmissionEvidenceV1`、`SummaryTerminalAdmissionStateV1`、`SummaryStartBatchKeyV1`、`SummaryTerminalBatchKeyV1`、
  `SummaryResolutionBatchKeyV1`、`PendingSummaryResolutionV1`、`NormalReprepareReceiptV1` 与
  `NormalReprepareConsumptionKeyV1`、`NormalReprepareConsumptionDetachKeyV1/ReceiptV1`、
  `NormalRepreparePrimaryTerminalEvidenceV1`；start key 只绑定
  start 时已存在的 prepared/expected identity、requestId、effect lease 与 reservation，terminal evidence 才绑定
  final admitted request、payload/admission receipt、output/ToolSet；
- summary reducer 消费完整 event envelope metadata：requested state 保存 requested event ID，started state 原子保存
  四个 start event IDs、完整 start key/binding；Pending 嵌入该 durable receipt，禁止依赖 last event 或无界 log scan；
- immutable attempt/continuation 不携带 phase；`SummaryLifecycleStateV1` 是唯一 rolling owner，manual 不得拥有 auto
  continuation，resource-resolution/reprepare 只能是 auto，schema/replay/fork/rewind 对多副本或非法 phase fail closed；
- v24 完整 closed durable RuntimeEvent subset 使用域 `runtime-event:v24` 对最终持久 envelope projection
  （schemaVersion、thread、generation、revision、normalized null|string causationId、occurredAt、已注入
  timestamp/default 的 exact event payload，排除且只
  排除 eventId）统一计算 canonical
  ID；Kernel 必须在 hash 前完成全部持久字段，Store/live reducer/tail replay/snapshot lookup/fork-rebind 都使用同一
  pure function重算并校验 type/role/cut。generic causation保持ADR-0096的opaque 1..128 UTF-8-byte batch
  correlation（可等于 terminalBatchId）并进入hash，不解释为event edge；Store mirror有byte CHECK/length-first gate，
  具名payload event-ID字段才验证前序关系。pre-v24 ID不追认，
  Summary不再有第二套ID公式。`RuntimeEventEnvelopeV24`/Store row必须持久canonical producer
  thread/generation，owner identity另存，replay不能从current fence猜测；exhaustive `CanonicalRuntimeEventRegistryV24`
  只覆盖durable subset并冻结每类字段/default/timestamp/limit，任何 durable union/encoding变化都升schema/registry
  版本。tool.progress与三类model delta/reasoning presentation event无ID/revision且Store/reducer硬拒；
- terminal admission state 判别 `not_completed|denied|admitted|indeterminate_after_crash`：admitted 必须有 final
  evidence，其他分支禁止；prepared-not-entered proof 可与 not_completed/admitted 配对，local denial 只能 denied，
  crash indeterminate 只能 resource unknown；
- normal-reprepare lifecycle 保存 terminal 或 late-resolution 的 durable origin receipt；scheduler 必须在同一 CAS
  原子提交 continuation-consumed、独立 primary invocationId/requestId/reservation 与 resource dispatch-started 后
  才切 idle。invocationId 匹配 resource reservation，requestId 匹配 admitted/model/terminal；两者不要求相等，而以
  同一 canonical consumption key 成对绑定，不另存冗余 pair digest。consume 前 crash 可
  fresh prepare，consume 后 crash 只能沿 primary unknown 收敛，双 scheduler 只能一胜；
- continuation-derived primary 的 final data denial 必须原子提交 matching run.error + resource released +
  turn.aborted；consume 后、terminal 前 crash 必须原子提交 unknown run.error + resource unknown + turn.aborted。
  两者都绑定 consumption/request/invocation/turn evidence，三个 turnId 必须等于 continuation.turnId，并逐项校验
  failure、knownExternalEffects、resource proof 与 abort cause；denial 只映射既有
  `policy_denied|mandatory_policy_unavailable`，unknown 映射既有 `unknown` 及 reconcile terminal outcome，不新增
  FailureKind；缺任一 terminal ID 都不是 settled。startup 只从纯 dispatch-started/零 terminal 子集生成 unknown
  batch；完整三事件仅 exact replay，孤立 unknown 或任意半批 quarantine；禁止 App 分步补终态或重新 dispatch；
- 独立 `applyLateSummaryResourceResolutionV1` 与 `applyStaleSummarySettlementV1` Kernel CAS owner；前者只在原
  unknown auto continuation 仍有效时局部唤醒，后者只收敛同一 started Summary，不接受候选激活或任意工具/模型
  terminal；
- v23→v24 migration、flag-off 新格式读取、legacy v1/v2 raw fallback、restart/rewind/fork/reset；
- projection failure 与 Runtime correctness failure 的判别式恢复结果。

`contextCompactionAutoV1` 只控制自动 Summary 调度，不控制 manual writer 格式。schema v24 生效后，所有成功的
plain/custom manual Summary 也必须写 V3；checkpoint-v1/v2 仅可经 bounded compatibility reader 读取，任何路径
都不得再新写 v1/v2。rollback 关闭 auto 与 Micro producer，但不降写持久 schema，也不把 manual writer 切回 v1。

V3 的 event cut 不保存 Store 物理 position，只保存 fork-local `sourceProducingEventCutV1` 并由 canonical prefix
digest 重验。fork transaction 对可见 V3 生成 bounded `checkpoint_v3_rebound` receipt，绑定 parent checkpoint
identity、fork-local source-producing cut、重算 source digest 与新 generation。未终结 Summary 使用独立
`summary_branch_abandoned(reason=fork|rewind)` 分支而不是普通 auto unknown terminal：requested 未 started 时清除 attempt/continuation；
started 或 resource-resolution-pending 时，在 child 将复制的 reservation 保守置/保持 unknown，写 bounded abandon
receipt，清除 continuation，永不 dispatch/replay，也不因 parent 的 late actual 自动退款。manual/auto 都适用。
若目标 cut 已 consume continuation，fork/rewind 先有界重验 idle.lastConsumption，再从 child rolling state detach；
primary settled 由复制的普通 resource ledger/terminal 事实恢复；primary in-flight 必须在 branch transaction 内
固定以 `run.error(unknown) → resource_budget.unknown → turn.aborted → consumption_detached` 四事件同一 CAS 收敛，
前三事件形成 error-terminal、第四事件引用其三个 IDs，禁止旧两事件 detach 与 event-ID 自引用。旧 generation
consumption receipt 仅保留历史审计权，不重绑成 child ownership。detach key 必须绑定 source/target thread、
generation/cut、opaque branch mutation receipt ID、完整 consumption receipt 与判别式
`in_flight|settled(success|error_terminal)` primary state；settled
只写 detach，并在 target state 清 lastConsumption、保存 bounded historical detach receipt。unknown reservation
缺 matching 三事件属于非法半批并 quarantine。旧
generation receipt 只允许 Store fork/rewind transaction 在 target mutation 前验证，普通 restore 不享有该例外。
write-time 完整 `RuntimePersistenceIdentityV1` 只用于 mutation CAS，不是 durable proof。Store 同事务持久 bounded、
immutable `BranchMutationReceiptV1`：不含物理 eventPosition 的 selected-cut/copied-target logical digests、四/一事件
manifest、base/final revision 与 checksum。settled 分支还必须同事务写 target-owned immutable
`BranchCopiedTerminalClosureV1`，保存 consumed/reserved/resource-dispatch-started 三个依赖，加 success 两个或 error
三个 terminal，共五或六个 exact original `RuntimeEventEnvelopeV24`、canonical producer thread/generation/ID、角色、
source selected proof 与独立 checksum；source event rows可删除，envelope不能改写成target
identity。唯一恢复例外是判别式 committed branch mutation receipt：
`in_flight_quartet` 验证四事件、共享 receiptId 与三 terminal IDs；`settled_detach` 验证单 detach、base+1、source/
target proof 与 target-owned copied terminal closure。snapshot-before 可跨 tail page 按 receipt 缓冲，
snapshot-after 以 lastDetach+receipt bounded lookup 重验，结果只保留 historical lastDetach。恢复不依赖已删除/推进
的 source 或滚动 live identity；普通三事件/无 receipt detach 仍必须 current-generation，任一缺失/拆批/篡改均
quarantine。receipt/closure 归 target session：target delete 同事务全删，source delete 不级联；closure与receipt同生
共死，仅在 retained events、rolling/named snapshots 全无引用时回收。closure单项≤768KiB/五或六envelope、session
≤1024/96MiB；closure authority 采用唯一 `BCTC` binary grammar（version/kind/count/target+source identity/receipt+
source proof/ordered role-tag+u32be envelope frames），checksum直接hash exact canonical BLOB；DB CHECK≤786432，reader
先查SQLite raw length，再验exact 5/6 count/role、单event128KiB、depth/string/array/unknown/trailing budget后才materialize/
exact decode并逐字节重编码；row/checksum/
ref/counter错配quarantine。receipt硬上限1024/16MiB，且两者字段禁止进入 telemetry/log/context。
唯一 Store writer 使用 fork/rewind 判别 request：fork 同事务逐字段 fence expected source、exact selected
rolling/named cut 与 expected target，rewind fence expected current 与 selected cut；完整 proof/events/snapshot
在锁外用共享 validator/reducer重算，Store 锁内只比较固定 precommit digests/counters，collision 或任一漂移零写。
receipt authority 是 CHECK≤16KiB 的 canonical BLOB，reader 先
SQLite length 再 materialize；固定 string/depth/count budget、事务性 receipt-ref index 与 session count/byte ledger
保证 quota/GC 无正文扫描，超 1024/16MiB 使用现有 `resource_saturated` 且发生在 mutation 前。

本 ADR 保留 ADR-0091/ADR-0096 的唯一所有权：Kernel 的纯 `deriveBranchMutationV1()` 复用 canonical builder、batch
validator 与 reducer生成 opaque candidate；RuntimeStore 仅做 identity/CAS、机械重算与 event+snapshot+receipt/closure
transaction，不成为 Summary/resource/turn producer。最终写使用短 `BEGIN IMMEDIATE` 后全量重读双端/selected
identity并比较 precommit proof，锁内禁止完整 validator/reducer、await/Provider/外部 callback；COMMIT 前250ms
超时及 `SQLITE_BUSY|SQLITE_BUSY_SNAPSHOT` 由专用连接判别为 `contention_timeout`，绝不冒充 stale；任何写前再次检查
monotonic deadline。Kernel 首次 derive 生成16-byte nonce，receiptId 按 domain hash(nonce,requestDigest)确定；未知
ACK 重用同 candidate。已有同 ID completion 且 request/candidate/manifest/postSnapshotDigest 全等返回
already_committed，不同正文是
collision/corruption；identity_stale、contention、invalid、quota、commit_ack_unknown 与 committed 分开返回。
precommit contention 最多同 candidate重试一次；COMMIT进入后ACK不明必须保持unknown并只走completion resolution，
不得映射 unchanged/persistence_unavailable或换nonce；WAL/DELETE journal 行为一致。
requestDigest 使用 domain-separated exact canonical request。branch commit 同事务另写 target-owned immutable
completion tombstone（receiptId+request/candidate/manifest/postSnapshot digests，≤1KiB），full receipt/events/snapshot
GC 后仍可 already_committed；completion 复合PK唯一、canonical BLOB CHECK≤1KiB且length-first bounded decode，只在
target session delete 时删除，session 上限1024/1MiB。完整 candidate/
reducer验证在写锁外且 snapshot/events/copied-closure 硬上限16MiB/64KiB/768KiB，锁内只比较固定 identity/precommit digests/counters并
执行 capped writes；source/target/named raw basis与tail同样在materialize前受32/64/96MiB和50,000条门禁。
result 映射封闭：success结束；stale须显式重发；contention仅同candidate一次；ack unknown只resolution；quota=
resource_saturated；invalid=transcript_invariant_error quarantine；collision=digest_invalid quarantine。
resolution 使用单一 SQLite consistent snapshot 同查 completion row+ledger/version+current identity；不可达返回
resolution_unavailable并保持 ack unknown；fork 同 snapshot 还查 source/selected rolling|named identity 与全部ledger
versions，rewind查同thread current+selected，target missing/delete+recreate无proof为unknown_or_superseded。completion
fast path 必须先验row↔ledger/counter/version一致，不能用孤立matching row洗白。

v23→v24 对非空 runtime_events 以 SQL count/sum(length(CAST TEXT AS BLOB))/row metadata 与流式 raw payload digest
分段构建resumable event count/byte ledger；所有pre-metadata revision0/null与metadata rows经strict restore折叠为
domain-separated normalized legacy base，v24 tail从空开始。source identity漂移即丢弃重建，full核对在锁外，final
短事务只比head/build checksum后同CAS切v24。
迁移中branch API不可用，crash/retry/concurrent append均不得暴露半ledger；receipt/completion/ref/quota表才是空初始化。
rolling snapshot通过既有checksum/invariant后是semantic authority，strict replay仅覆盖其tail；历史raw chain只是storage
identity。legacy state/transcript/raw row chain、baseId/D0/nextRevision均有独立domain公式并持久于
RuntimeStorageFormatV1。historical named snapshots eager生成LegacyNamedCutProof；只有metadata-prefix verified可branch，
其余legacy_unverified只读/导出。named proof 按 evidence→evidenceDigest→named ledger base→proofChecksum 的单向
DAG构造，ledger base只能依赖evidenceDigest，最终checksum不得反哺base；namedCatalogVersion参与每个build chunk与
final CAS。

独立 `RuntimeThreadWriteFenceV1` 冻结 generation、`v23_compat|v24_strict` format 与 positive monotonic
writeEpoch及`active|deleted` lifecycle；v23 additive migration必须按verified session/rolling authority识别active，
按“无任何session-owned row”识别deleted并保留existing generation，active empty由空authority而非event count判定；
orphan/歧义/缺失冲突quarantine，不能统一标active。cutover与fence同事务切v24_strict并+1，generation-changing
rewind/fork target replacement/delete-recreate同样推进且不得overflow/wrap。所有event/snapshot/named/fork/rewind
writer与`deleteSession`都必须CAS generation+format+epoch；delete无admin bypass，验证后推进retained fence再清理target
owned数据并将fence永久保留为deleted tombstone；recreate exact CAS tombstone后再次推进并保持v24_strict，只有从未
存在fence的新thread可用1/v24/1创建，禁止reset/ABA/降级。completion resolution同时读取该tombstone。v24拒绝
generic metadata-less append、revision0/null ID、mixed/noncanonical batch；旧connection得到
storage-format conflict零写并restore，防止cutover后污染strict tail。
永久fence受Store级事务ledger限制：单row≤256 bytes、count≤1,048,576、总bytes≤256MiB，active/deleted都计入；
只有首次thread insert消耗quota，delete/recreate不递减。超限=`resource_saturated`零写，row/ledger错配quarantine，
禁止无Store-wide incarnation协议的GC/reset。
首次升级必须用带store schema epoch、fence-catalog version、≤4096-row progress与checksum的resumable build真实回填
全部旧fence count/bytes/active/deleted；每chunk与final CAS basis，并发create/delete/recreate使build stale。合法旧数据
已超quota时安装真实`saturated_legacy` ledger、仅拒新unique thread；单row超限或分类歧义仍quarantine，禁止空ledger
cutover或半build可见。

resumable migration build row 必须持久并在**每个chunk** CAS generation、v23_compat format、writeEpoch、source
snapshot/head、namedCatalogVersion与上一progress/checksum；final短事务再次比较同一basis后才安装v24并删除build。
format已切v24或旧worker/竞争worker/cutover后续chunk只能typed stale/零写，不能遗留、覆盖或复活build artifact；
startup只允许bounded internal GC清理无引用旧build。
已有 lastDetach 的分支再次 fork/rewind 时，只在 source/current selected cut 有界重验后于 target generation 丢弃，
不得复制、重绑或再生成 detach；named snapshot 同样按其 cut 处理。Branch cut 的空/非空 eventId invariant 固定，
但它不是 CAS identity，Store 仍以完整 RuntimePersistenceIdentity 比较 snapshot/head/generation。
rewind 从目标 cut 重算 checkpoint、cooldown 与
successful-primary ordinal。

具体字段、batch 顺序和负面矩阵已在 reviewed RFC 中冻结，独立整体架构验收为 GO。该接受决定允许计划进入
active 并从 PSMC-03 渐进实施；在对应 Task 与 Gate 完成前，本文仍是未来协议，不得写入 current behavior 或宣称
新三级已经可用。
