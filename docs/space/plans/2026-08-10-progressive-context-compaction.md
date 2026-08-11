# 渐进式三级上下文压缩实施计划

状态：archived
日期：2026-08-10
优先级：P0
设计依据：[`../../design/2026-08-10-progressive-context-compaction-rfc.md`](../../design/2026-08-10-progressive-context-compaction-rfc.md)
架构依据：[`../../adr/0100-checkpoint-working-set-compaction.md`](../../adr/0100-checkpoint-working-set-compaction.md)、
[`../../adr/0101-verified-checkpoint-working-set-protocol.md`](../../adr/0101-verified-checkpoint-working-set-protocol.md)（accepted）
前置清场：[`2026-08-10-progressive-session-memory-compaction.md`](2026-08-10-progressive-session-memory-compaction.md)

## 当前边界

PSMC-01～06 已完成。整体 review 与唯一最终回归复审发现的 P1 已通过后续实施收敛：strict-v24 branch
receipt/closure/completion、opaque Core candidate、resumable event/fence/named-proof migration、250ms contention、
ACK resolution、全域 nested exact schema、六 crash cuts、quota/fault matrix 与独立 semantic/performance verifier
均已落地。2026-08-11 最终 Gate 为 3325 pass、8 skip、0 fail，20 条语义 fixture 100% retention/continuation，
2000-block/8.5MiB 性能阈值全部通过。实现完成不改变 rollout：auto/Micro live flag 保持默认关闭，不声明
production support、default-on 或无限会话。

Session Memory、memory updater、memory shadow/live、memory schema 和 memory Provider 不属于本计划，也不是
任何 Task 或 Gate 的依赖。ADR-0099 保持独立 proposed；未来需要时另立计划。

## 目标

交付一套单入口的三级压缩机制：

1. MicroCompact 确定性回收旧工具输出；
2. Checkpoint Working Set 复用活动摘要并保留 recent window 和全部 uncovered tail；
3. SummaryCompact 在必要时生成或更新 checkpoint，再回到第二级构造最终 payload。

原始 transcript、工具协议、Runtime authority、Provider admission、Store exact CAS 与 generation fence 不回退。

## 执行原则

- 先完成当前 Task 的实现与定向验证，再做一次阶段级整体 review；不按每个文件或每个小步骤反复调用 reviewer；
- 任一阶段发现架构冲突、双 producer、不可恢复持久格式或 final admission 绕过时立即停工；
- 所有行为 flag 默认关闭；auto flag 只控制自动调度。schema v24 cutover 后 manual 成功写入也只能产生 V3，
  v1/v2 仅只读兼容，rollback 不得降写旧 schema；
- 不恢复旧 checkpoint-v2/cache-safe/route qualification/refill guard 生产链；
- 不把 Session Memory 顺手加入当前 schema、事件、配置、测试或文档声明。

## Task 矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| PSMC-03（completed） | RFC reviewed、ADR-0100/0101 accepted、PSMC-02 completed | Micro policy v1、ephemeral candidate boundary、primary-used commit、projection base identity；把既有 deterministic reclaim 收敛到冻结年龄/收益语义 | raw/off bytes、pairing、verified provenance、两 turn 年龄、2 blocks/1024/5%、current/recent/tail must-keep、mixed/legacy、writer ownership、perf | 关闭 micro flag 后精确回到 raw/现有 Slice A projection；不改 transcript |
| PSMC-04（completed） | PSMC-03 | schema v24、RuntimeEvent canonical ID、thread write fence、event ledger base migration、`VerifiedContextCheckpointV3`、legacy-v1 trust discriminant、半开区间 selector、ephemeral Working Set、restore/fork-rebind/rewind/reset | v1 非资格、v23 cutover/旧writer、首次/增量/>128 history、`[0,c)+[w,c)+[c,n)` property、文本消息计数、active/barrier/oversized block、tamper/fault/migration | V3 派生无效回退 raw；flag-off 可读；真源损坏保持 correctness failure；不创建 memory |
| PSMC-05（completed） | PSMC-03..04 | 单一 orchestrator、summary attempt/normal continuation events、manual/auto、V3 writer、source identity/cooldown、start/terminal/resolution/stale/fork CAS、final admission | plain/custom/no-new-source、同源一次/3-success cooldown、双 dispatch-started、crash recovery、reconciled/released/unknown、late-resolution、resource/provider denial、no generic-400 | auto flag off 仍由 manual 写 V3；v1/v2 只读；不恢复旧 Slice B；started attempt 不重放 |
| PSMC-06（completed） | PSMC-03..05 | 结构/语义/continuation/perf evidence，local producer+独立 verifier，active/book/root/map，完成记录与 rollout 判定 | focused/full/typecheck/format/lint/core/legacy/docs/diff、restart/resume/fork/rewind、20 条 long-session eval、fault soak、75/100ms 与 96MiB | Gate 已通过；rollout flags 仍默认关闭，后续 default-on 另行决策 |

## Gate

### G0：设计与单入口

- ADR-0101 accepted，RFC 独立评审 P0/P1/P2 清零；
- 源码 inventory 证明只有一个 normal compaction orchestrator 和一个 checkpoint writer ownership；
- Session Memory 相关类型/事件/config 不进入实现 diff；
- 旧 Slice B no-producer/legacy-reader isolation 回归保持通过。

### G1：MicroCompact

- flag-off Provider model bytes、调用次数、admission 和事件精确不变；
- 候选只含完整 verified settled block，current turn、pin、legacy、mixed、effectful 和失败块保持 raw；
- policy 精确执行早于 active 两个 settled turn、至少 2 blocks、1024 tokens 与 5% saving；
- candidate boundary 零写；只有实际使用 Micro 的成功 primary terminal batch 推进 commit，summary/working-set/
  failed-primary 均零推进；checkpoint activation/reset 同批清除旧 Micro commit；
- boundary/telemetry 无正文、路径、参数、ID 或 digest 值，metadata 上限由测试冻结；
- 2000-block/8MiB fixture 的增量 latency/heap 不回退既有安全门槛。

### G2：Working Set

- V3 coverage=`[0,c)`，最终投影=`summary + B[w,c) + B[c,n)`；window/tail identity 不相交，全部 tail 恰好一次；
- recent 的 4 条文本消息只计 durable user/assistant 非空白 text；tool-only、Tool Result、runtime/system/summary 与
  空文本不计，multipart 每条 durable message 只计一次；
- current active turn 的 durable settled blocks 只在 tail；未完成 tool/interaction/verification/stream 是 scheduler barrier；
- 第二级 Provider call count 为零；legacy v1、无 V3 和派生 proof failure 是 `unavailable`，不是 failure；
- 首次/增量 V3 都从完整 prefix 独立重算；history 截断 >128 不影响验证；
- checkpoint tamper、stale、rewind、fork、restart 均 fail closed 并可回退 raw；Working Set 不持久化 boundary；
- 最终 payload 必须再次经过 effect-only resource 与 Provider data admission。

### G3：SummaryCompact

- 一次请求、单 narrative、无工具、零 SDK retry；started 无 terminal 不自动重放；
- 自动触发只接受本地容量证明与显式 flag，不解释通用 HTTP 400/413；
- plain/custom manual 均要求新 safe source；no-new-source durable no-op 且零 Provider；
- `SummarySourceIdentityV1` 独立于 checkpoint/environment；持久 successful-primary ordinal 精确执行 3-success
  cooldown，紧随 summary 的成功 primary 计作第一个，failed/unknown/aborted 不计；所有真正 dispatch 的 manual/
  auto Summary 都推进 attempt identity/cooldown baseline，pure/no-op/未 reservation 拒绝不推进；
- control-only event 任意序列不得改变 SummarySourceIdentity；只有新增 settled source block 才改变。V3 restore proof
  的 source-producing cut 与 dedupe identity 分离；
- auto start 必须原子包含 `summary_requested → resource reserved → resource dispatch_started → context summary
  dispatch_started`，manual dispatch 必须包含后三项；start key 只绑定当时已存在的 requestId、expected payload、
  lease 与 reservation，且不得包含尚未生成的 admitted evidence 或自身 event ID；terminal key 复制 start binding，
  final-admission evidence 再绑定 admitted request/payload/receipt，按 Provider-result/local-denial/unknown 分支验证
  必填/禁止/可选；resolution key 独立绑定 original terminal/unknown/continuation；
- requested/started rolling state 必须从完整 envelope metadata 保存 requested、reserved、resource/context-started
  causation handles；restart 加任意 intervening control events 后仍可精确 terminal/stale，不依赖 last event 或全 log；
- v24 完整 durable RuntimeEvent subset 统一按 `runtime-event:v24` 对最终持久 envelope projection 重算；Kernel 必须先注入
  schemaVersion/canonical thread/generation/revision/null|string causationId/occurredAt 与 payload timestamps/defaults 再 hash，Store
  使用同一 pure function机械复核。`RuntimeEventEnvelopeV24`/Store row持久producer generation，owner另存，普通event
  两者必须等于active fence，copied closure允许target owner/source producer但不推进target ledger。覆盖
  user/model/tool/plan/context/resource/run/turn、caller/auto timestamp、field-order、重复正文不同 revision/time、caller
  envelope/schemaVersion/causation tamper、null/absent与causationId=terminalBatchId、pre-v24/v24 mixed ID；generic
  causation只作1..128 UTF-8-byte opaque correlation，覆盖128/+1与mirror length/DB CHECK；具名payload event edge覆盖
  forward/self/cross-generation拒绝。live/replay/
  snapshot bounded lookup/fork-rebind拒绝 payload 不变 ID 变、ID
  不变 payload 变、start 角色互换与 cut 外引用，且后续 causation 只能引用先行 ID；
- `CanonicalRuntimeEventRegistryV24` 由durable/ephemeral单一显式类型源和双向编译期断言驱动，对durable subset
  exhaustive ratchet；每类exact fields/default/timestamp owner/bytes有
  golden，新增type/field或改变default/encoding必须升schema+registry ID，旧reader fail closed；`tool.progress`与三类
  model delta/reasoning presentation event无ID/generation/revision，durable builder/reducer/Store/snapshot admission均有
  compile-time与runtime负测；
- `SummaryLifecycleStateV1` 是 attempt/continuation/pending 的唯一 phase owner；manual/auto presence、每次原子转移、
  decode/migration/replay/fork/rewind 多副本/phase mismatch 均有负面测试；
- summary terminal 按现有 ledger 判别提交 `reconciled(actual)`、`released(zero-execution proof)` 或 `unknown`；
  auto 仅在前两者后进入 `normal_reprepare_required`，unknown 保持 `resource_resolution_required` 直到 late actual
  reconciliation，manual 永不创建 normal continuation；
- success batch 原子提交 V3、terminal 与上述资源终态；primary 使用独立 lease/reservation 并从 committed state
  fresh prepare；
- request 前、reserved 未 started、started 无 terminal、terminal batch 前后、activation 后 primary 前、primary
  started 后六个 crash cut 都有唯一恢复终态；
- failure/stale/denial 保留 transcript 与旧 checkpoint，同一 auto continuation 不重试同 source；只有
  reconciled/released 的 auto continuation 才 fresh dispatch raw/Micro/Working Set 最佳候选，unknown 不续跑；
  local over-window/ratio 不阻断普通 primary 或产生 typed capacity failure；
- 专用 late-summary-resolution 只接受原 unknown reservation + matching resolution continuation，并以新的双事件
  resolution CAS 唤醒 reprepare；普通 late-resource channel 仍不能复活调度，非法跨用必须拒绝；
- unknown terminal 同批物化自包含 `PendingSummaryResolutionV1`；restart/replay/fork/rewind 后 exact restore，成功
  resolution 同批清除，重复/缺失/original-terminal 或 unknown-event identity 漂移全部拒绝；
- stale result 使用 current-state bounded settlement：候选不激活，actual/released/unknown 正确记账；新用户 source
  写 continuation-superseded，只有 environment/control revision drift 且原 turn/source 有效才 reprepare；final
  dispatch callback 前 source/environment/control stale 必须使用 Core-owned single-use zero-execution proof，callback
  已进入或伪造 proof 必须拒绝，崩溃恢复只能 unknown；
- admission gate 未完成后 stale 必须 evidence-forbidden，gate 已通过但 callback 前 stale 必须 evidence-required；
  `tryEnter` 与 `closeWithoutEntry` 双向竞态分别证明唯一 winner，close winner 后迟到 callback 零调用，enter winner
  后 release proof 不可构造；
- admission×guard×resource 完整矩阵覆盖 not_completed/denied/admitted/indeterminate；表外的
  not_completed+actual/unknown、denied+prepared-proof、admitted+local-denial、indeterminate+released/reconciled、
  guard-open terminal 全部拒绝；矩阵同时覆盖 admitted+completed+resource-unknown 和 manual requested-only denial；
- normal-reprepare 保存 terminal/resolution origin receipt；消费 continuation 与新 primary lease/reservation/resource
  dispatch-started 同一 CAS，在同一 canonical key 分别绑定 primary invocationId/requestId，并保存 consumed receipt。
  consume 前/后 crash、双
  scheduler、exact replay、intervening control、new-source supersede、fork/rewind 都证明一次且仅一次 primary
  ownership；resource invocation、admitted/terminal requestId 各自 mismatch 或 swapped pair 必须拒绝；
- target cut 位于 consume 后 primary terminal 前/后时，fork/rewind 必须先重验再 detach idle.lastConsumption；旧
  generation receipt 仅历史可见，child current ownership 只由普通 primary resource/terminal facts承担；detach
  key/receipt 绑定 source/target thread+generation+cut、完整 consumed receipt 与
  in-flight/settled(success|error_terminal) 状态；in-flight 必须以
  `run.error(unknown) → resource unknown → turn.aborted → detached` 四事件同 target-generation CAS 收敛，settled
  只写 detach；wrong cut/generation、旧两事件、missing/reordered/single-event、tamper 与 exact replay 均有
  fork/rewind 双矩阵；
- A→B(detach)→C、B 上 rewind 到 detach 前/后、named snapshot 与 tampered lastDetach 都验证“源 cut 重验后 target
  原子丢弃、不复制/重绑”；Branch cut 的 revision/eventId 空非空 invariant 与 targetBase 时点有 golden，Store
  并发仍使用完整 RuntimePersistenceIdentity 而非 branch cut；
- terminal/resolution origin 与 consumed receipt 的全部 event IDs 均进入 bounded canonical hash/type/role/cut lookup；
  payload/ID 篡改、角色互换及 fork/rewind cut 漂移必须 quarantine；
- continuation-derived primary final admission denial 必须原子提交 matching run.error + resource released +
  turn.aborted；consume→denial terminal 前 crash 只可原子收敛 unknown+aborted，绝不重派。覆盖 consume→release 后/
  run.error 前、run.error→turn.aborted 间原有分步 crash 探针，并证明新协议不存在这些 durable cut；fork/rewind
  将 denial/unknown 三事件识别为 settled，半批一律 quarantine；三个 terminal ID、turnId=continuation.turnId、
  failure/knownExternalEffects、resource proof、abort cause、outcome 与角色互换均有负面测试；denial 的
  policy_denied/mandatory_policy_unavailable 与 unknown 的 status/reason/safeRetry/reconcile 均走现有 failure taxonomy
  conformance，不新增 kind；
- fork/rewind 的 target cut 分别覆盖 consume 后 final gate 前、gate 后 callback 前、完整三事件后，以及仅存在
  resource unknown/任一半批；前两者原子写 unknown 三事件+detach，完整三事件只 detach，非法半批 quarantine，
  target turn 必须 aborted 且全分支零 redispatch；
- committed branch mutation 的 in-flight quartet 覆盖 snapshot-before+完整 tail、snapshot-after、strip/reorder、payload/ID/role/cut/
  source-generation/branch-receipt tamper；只有同 target generation、receipt manifest 连续固定顺序、前三 IDs 与
  detach error-terminal 精确对应的完整 quartet 可在恢复时使用嵌套旧-generation consumption，归约后仅 lastDetach
  留存，ordinary 三事件仍 current-generation only；
- settled success/error detach 分别覆盖 snapshot-before 单事件 tail、snapshot-after、source delete、rolling prune、
  proof/terminal ID 与 copied closure owner/producer/role/checksum tamper、closure缺失/超限/GC及 A→B→C；仅 exact
  `settled_detach` receipt + target-owned `BranchCopiedTerminalClosureV1` 可使用嵌套旧 generation，普通无 receipt/
  closure detach 拒绝；
- branch mutation receipt 与 events/snapshot 同 SQLite transaction、immutable+checksum+16KiB；writer 仍以完整
  RuntimePersistenceIdentity CAS，但 durable proof 排除物理 eventPosition。覆盖 named-source-behind-head、source
  delete、source/target rolling snapshot overwrite、fork physical-position remap、tail page 恰切在第1/2/3/4事件、
  receipt missing/duplicate/不同 transaction/manifest tamper 与 A→B→C；恢复只用 target-owned prefix chain+receipt/
  copied closure；
- receipt/closure retention 覆盖 target delete 全删、source delete 不级联、rewind/target replacement、rolling/named snapshot
  引用与删除、retained event manifest，以及 1024/16MiB 上限前置拒绝；ID/digest/snapshotId/proof/manifest 不进入
  telemetry、session log、模型上下文或用户错误正文。copied closure另测单项768KiB/每event128KiB/session
  1024/96MiB、consumed/reserved/dispatch三个依赖+success两/error三terminal的exact五/六角色，与receipt同生共死；
  `BCTC` binary grammar golden覆盖magic/version/kind/count、target/source/receipt/proof、ordered role tags、u32be frames、
  decode→re-encode byte equality与checksum；canonical BLOB CHECK/length-first覆盖768KiB+1、单frame+1、超长nested/
  string/array、unknown/extra/trailing frame、getter sentinel及row↔checksum/ref/counter错配，所有拒绝发生在
  materialize/parse/hash前；
- fork Store API 双端 CAS 覆盖 source-only/target-only advance、target delete+recreate ABA、named snapshot replace、
  双 fork 与 fork/rewind race；Kernel pure producer 生成 opaque candidate，Store 只能用共享 validator/reducer机械
  重验，不能构造任意 run/resource/turn/context event；receiptId collision 整批零写；
- 两个独立 Store connection 在 WAL/DELETE journal 下覆盖 source/target 交叉 fork、delete/recreate、fork/rewind
  race、BUSY/BUSY_SNAPSHOT 与250ms锁预算；专用250ms连接不改变普通5000ms配置，BEGIN IMMEDIATE 后全量重读，
  busy/timeout=`contention_timeout`、identity变化=`identity_stale`，锁内零await/Provider/外部callback。真实 wall-clock
  ≤预算+tolerance，身份未变时 contention 不触发 stale/rederive/abandon；live/replay/restore复用同一 builder/
  validator/reducer golden；
- pre-COMMIT CAS matrix 覆盖16-byte CSPRNG输入、receiptId domain golden、同nonce exact retry、completion不存在且
  source/target/selected identity在BEGIN前漂移→identity_stale、同ID不同completion→collision；未进入COMMIT时结果
  只能contention/stale/invalid/quota/collision，COMMIT成功且ACK明确后才是committed，COMMIT entered且结果不明才是
  commit_ack_unknown；
- completion tombstone 与 mutation 同事务；覆盖 ACK lost→target advance→event prune→snapshot overwrite→full
  receipt GC→same candidate 仍 already_committed，以及completion tamper/缺失/同ID不同digest、target delete全删、
  source delete不级联、raw BLOB>1KiB/重复PK/ledger错配、1024/1MiB前置quota；completion在session存续期间不得GC，
  v23→v24只对receipt/completion/ref/quota空初始化且不伪造backfill；
- 非空v23 runtime_events迁移以SQL count/sum(BLOB length)/row+revision metadata+≤64KiB流式payload digest建立256-row
  resumable event ledger；所有TEXT长度用CAST AS BLOB，覆盖ASCII/quote/backslash/CJK/emoji/孤立surrogate、大tail、
  单event>128KiB记录、chunk中断/重试、source identity漂移、并发append/rewind/fork/delete、final CAS、ledger
  count/bytes/prefix tamper，未完整安装前branch API不可用；
- legacy migration覆盖多个revision=0/eventId=null、mixed legacy/metadata rows及其fork/rewind/named snapshot；全部
  pre-v24历史折叠成normalized state/transcript+row count/raw bytes/raw digest的legacy base，v24 tail从空开始且只对
  新event要求连续identity。不能选择单个legacy row作branch cut；final BEGIN只比head/build checksum，禁止全表重扫；
- legacy base golden覆盖normalized pre-v24 state（排除新ledger字段）、canonical transcript、u64be长度前缀raw-row
  chain、baseId/D0/nextRevision；证明rolling snapshot是semantic authority、只strict replay tail，raw chain仅storage
  identity。verified named/fork rebound base落盘后首个D1 revision精确；
- named eager migration覆盖catalog version与raw/state/transcript/prefix proof；migration前/中/后create/replace/delete、
  named before/at/after rolling cut、mixed legacy rows、source delete均有Gate。只有verified_metadata_prefix可fork/rewind，
  legacy_unverified只能read/export且不能自hash升级；按 evidence→evidenceDigest→named ledger base→proofChecksum 的
  无环顺序给出固定golden，覆盖field/evidence/base/checksum tamper，branch request只接受exact proofChecksum；
- `RuntimeThreadWriteFenceV1` 覆盖既有thread v23_compat/epoch1初始化、v24新thread、cutover、generation-changing
  rewind/fork target replacement/delete-recreate、active|deleted tombstone、epoch safe-integer overflow；所有writer与
  `deleteSession`都CAS generation+format+epoch，delete无admin bypass且先推进永久retained fence/切deleted再清理，
  recreate再次推进并保持v24，只有从未存在fence的新thread可1/v24/1创建。覆盖completion unknown lookup、cutover后
  旧connection generic append、metadata-less revision0/null、mixed batch、旧appendAndSnapshot/named/fork/delete writer
  与stale delete-recreate；冲突
  零写/reload，不新增FailureKind；
- Store fence ledger覆盖单row256B、1,048,576 rows/256MiB的limit-1/limit/+1、唯一thread create/delete/recreate、
  quota crash consistency与row↔counter/version tamper；只有首次insert增加count，但generation/writeEpoch/lifecycle改变
  row canonical bytes时必须同事务更新total bytes、ledger version/checksum（含saturated_legacy）；超限
  resource_saturated零写，禁止tombstone GC/reset；
- v23 fence migration覆盖active session、active empty、已delete tombstone、orphan rows、missing/conflicting fence与非法
  generation；resumable≤4096-row build逐chunk CAS store schema epoch/fence-catalog/progress checksum，覆盖竞争builder、
  create/delete/recreate并发、crash resume、旧count/bytes超quota安装saturated_legacy及单row>256 quarantine，未完成前
  不开放新writer；
- resumable migration build 的每个chunk都CAS v23_compat fence/generation/writeEpoch、source snapshot/head、
  namedCatalogVersion与上一progress/checksum；覆盖竞争worker、catalog/source漂移、delete/recreate、chunk commit后崩溃、
  final cutover后旧worker继续chunk与stale build bounded GC，均不得追加/覆盖/复活artifact；
- requestDigest 有 `branch-mutation-request:v1` domain/canonical golden，覆盖field-order等价与kind/identity/named digest/
  fork-rewind tamper；receipt/candidate/manifest/completion四类digest构造顺序无环并有固定golden；
- 完整candidate/reducer/canonical snapshot验证在BEGIN IMMEDIATE外执行；16MiB snapshot、64KiB events、16KiB
  receipt、768KiB copied closure、16项ref delta逐一测limit-1/limit/+1，锁内仅固定precommit proof/identity/counter和capped write；progress
  handler超时回滚，writer reservation wall-clock满足Gate；
- basis 输入在materialize前覆盖source/target/named raw snapshot 32MiB、tail单event128KiB/50,000条/64MiB、combined
  96MiB的limit-1/limit/+1与getter sentinel；thread event count/byte ledger错配quarantine。Precommit basis/ref-delta
  domain golden绑定source/target/selected/named digest及ref/receipt/completion ledger versions；proof生成后BEGIN前逐项
  source-only/target-only/named/ref/quota变化均identity_stale零写；
- commit result conformance逐项验证：committed/already成功且无重复event，stale不自动rederive，contention只同candidate
  一次，commit_ack_unknown不得宣称unchanged或换nonce，quota→resource_saturated零mutation，invalid→
  transcript_invariant_error quarantine，collision→digest_invalid quarantine；覆盖commit crossed→ACK lost→retry
  BUSY/timeout→resolution_unavailable→later completion lookup，以及matching completion=committed、completion absent+
  preidentity same=definitely_not_committed、identity changed/target missing/delete+recreate=unknown_or_superseded；
  resolution必须单一consistent read snapshot并覆盖与commit/delete/replacement并发线性化；错误输出不得含receipt/
  candidate digest；
- receipt bounded-read 覆盖 raw BLOB>16KiB、超长各 string、unknown/deep/array getter sentinel、1025th receipt、
  session canonical bytes=16MiB-1/+1、counter/ref-index mismatch、GC 与 snapshot mutation 竞态；所有 raw length/
  indexed quota/ref checks 必须先于 materialize/parse/normalize/正文扫描，quota 固定为 resource_saturated；
- startup matrix 分别覆盖纯 dispatch_started/零 terminal 子集、完整三事件 exact replay、孤立 resource unknown、
  run+unknown 缺 abort 与其余半批；只有第一类可生成 unknown batch，后三类除完整 replay 外均 quarantine；
- fork matrix 覆盖无/有 V3、manual/auto requested、started、unknown、resolution-pending、reprepare-pending；
  copied started reservation 保守转 unknown，fork-abandon 不继承或恢复旧 continuation；
- schema v24 下 auto flag-off 的 manual plain/custom、V1→V3、flag toggle、V3 restore/fork-rebind/rewind 均有测试，
  且不存在任何新 v1/v2 writer。
- manual failed/stale 同 source 显式串行 retry、manual success 后 no-new-source no-op，以及 manual dispatch 对 auto
  cooldown 的推进均有独立测试。

### G4：资格与文档

- 长会话 fixture 验证目标、约束、决定、失败、验证结论、未完成事项和 continuation；
- 至少 20 条 fixture，mandatory retention=100%、continuation success≥95%，相对 raw baseline 下降≤2pp；
- 2000-block/8MiB fixture 上 Working Set prepare p95≤75ms、restore proof p95≤100ms、增量 peak RSS≤96MiB；
- 完整默认测试、故障/replay、typecheck、格式、lint、Core 边界、legacy 清场、文档与 diff 门禁全绿；
- active 文档只在实现同批更新；完成记录只能写实测命令、阈值、artifact identity 和未支持边界；
- default-on、production-supported 或无限会话声明必须另有明确 rollout 决定。

## 实施顺序

1. 已完成：RFC 整体评审、ADR-0100/0101 接受与 PSMC-03；
2. 已完成：PSMC-04 schema v24、V3/Working Set、migration/fence/named proof；
3. 已完成：PSMC-05 单一 orchestrator、Summary lifecycle、continuation 与 branch protocol；
4. 已完成：PSMC-06 full/fault/semantic/performance/documentation Gate；
5. 当前仅保留 rollout 决策：auto/Micro live flag 默认关闭，default-on/production qualification 另立计划。

## 明确排除

- Session Memory lifecycle、shadow/live、后台维护或跨会话记忆；
- checkpoint-v2 三段 proof、cache-safe fork、Provider cache receipt 资格与 durable refill guard；
- 通用 Provider overflow 后的自动 shrink、chunk、repair、summary retry；
- 用 local ratio/window estimate 阻断普通 primary 或把 legacy v1 晋升为 verified prefix；
- 删除或改写 transcript、从摘要恢复授权/Plan/Verification/Tool 状态；
- 未经 Gate 的 default-on、production qualification 或完整三级完成声明。
