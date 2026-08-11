# 三级上下文缩减 Slice A：全工具 L1 与 L2 Live 实施计划

状态：archived
日期：2026-08-10
优先级：P0
设计依据：[`../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md`](../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md)
Foundation：[`../execution/completed/2026-08-10-context-reclaim-foundation.md`](../execution/completed/2026-08-10-context-reclaim-foundation.md)
架构前置：ADR-0095（accepted）、
[`ADR-0096`](../../adr/0096-three-tier-context-reduction-l1-l2-live.md)（accepted）
后续：[`2026-08-10-three-tier-context-reduction-slice-b.md`](2026-08-10-three-tier-context-reduction-slice-b.md)（draft；依赖 Gate A）
完成记录：[`../execution/completed/2026-08-10-three-tier-context-reduction-slice-a.md`](../execution/completed/2026-08-10-three-tier-context-reduction-slice-a.md)

## 生命周期与执行授权

本计划已在 A-G0..A-G3、独立 evidence replay、全量/静态/docs gate 通过后归档。当前行为以
[`../../active/three-tier-context-reduction.md`](../../active/three-tier-context-reduction.md) 为准，验证数字与排除项
见独立完成记录；本文保留为实施与验收历史，不再授权新的 Slice A 行为变更、rollout 或默认开启。

Slice A 通过本文 Gate A 后只能宣称“全工具 L1 V2 与 L2 live 在受控、默认关闭路径可用”。它不能宣称
“完整三级上下文缩减可用”、auto L3、production-supported、默认开启、Claude Code parity、无限会话或
Provider 等价。Gate 未全部通过、真实证据缺失、文档未同步或计划仍为 `draft|active` 时，禁止建立完成记录、
归档计划或使用任何完成表述。

## 目标

在 Foundation 的 immutable transcript、`ReclaimPlanV1` 与 shadow 基线上，完成以下可执行闭环：

1. 所有 production ToolSpec 的模型可见结果都有封闭、有限、可重放的 `ToolResultBudgetV2`；
2. 每个 tool terminal 自包含唯一、已验证的模型结果，取消/拒绝/失败路径不再由 reducer 临时生成无预算正文；
3. 所有上下文入口消费同一个 deep-frozen `PreparedContextRequestV2`，Provider 只接收经过 effect-only
   final admission 的精确 payload；
4. L2 在 `live` 模式实际应用有正收益的 settled tool block，并以 schema v22 的持久 commit/receipt 保持
   watermark 单调、cache prefix 稳定和恢复确定性；
5. 新能力默认关闭，route qualification 只来自受信 evidence registry，不接受用户配置自证。

## 范围与不变量

### 包含

- `ToolResultBudgetPolicyV2`、resolved budget/binding digest、封闭 projector registry 和 registry conformance；
- Shell/Search 既有 4000 字符语义、MCP 与其他工具 128 KiB UTF-8 envelope、`read_file` 的
  `line_byte_cursor_v2`；
- 统一 result finalizer、四类 tool terminal 的 verified result、控制事件 companion terminal 与 legacy-v2..v21
  cutover 归一；
- `ProjectionArtifactV2`、source/request identity、purpose-specific `next`、pure prepare 与
  effect-only admit/dispatch；
- L2 live 触发、fixed plan/apply、`applied_commit|applied_plan|valid_noop_plan|raw_fallback` 证据、
  watermark/cache epoch、schema v21→v22；
- normal、preflight、`/context`、candidate、restore/debug 对同一 prepared artifact 的消费；
- 默认关闭 flag、受信 route qualification、隐私 telemetry、synthetic/golden/cache/continuation 证据；
- 与实际行为一同完成 active/book/map/索引和完成记录同步。

### 不包含

- L3 Provider summary、checkpoint v2、Runtime schema v23、cache-safe summary fork、refill guard；
- Provider overflow 后自动压缩、retry 或伪造零执行证明；
- effectful tool、动态 MCP、Shell 或 Web 的 L2 正文替换资格扩面；
- artifact store、第二份模型 memory ledger、message snip、Provider `cache_edits`；
- 默认开启、external/production rollout 或完整三级可用声明。

### 不变量

1. `src/core/` 不依赖 `src/app/` 或 TUI 类型；transcript、ToolCallBlock pairing 和 Runtime authority 不变。
2. ADR-0096 只能局部取代 ADR-0048 决策 4 的“terminal reducer 生成未预算正文”producer，以及
   ADR-0049 决策 6 中 approval control event 直接生产 Tool Result/批次成员的部分；ADR-0048/0049 的
   拒绝语义、原子取消、先持久后 `AbortSignal`、sibling 收敛、terminal 先于 `turn.aborted`、
   `ask_user` continuation 与 live/replay 一致性保持。
3. ADR-0024 的 ratio/window estimate 不是 correctness hard block；最终实际 Provider 仍决定真实容量。
4. `toolResultBudgetV2=false` 且 L2 off 时，最终 Provider payload 与当前 main raw 路径字节级一致；关闭
   L1 V2 不恢复已经持久的截断正文。
5. L2 只替换 reviewed RFC 白名单内、完整 settled 的 tool block；current turn、live tail、混合/未知/
   legacy block 和 fail-closed block 保留正文。
6. 任何 pairing、projection 或 terminal 唯一性破坏都走既有 correctness hard-block；L2 无效候选本身不
   制造 hard block。
7. 所有 builder DTO 在边界 canonical serialize、digest、deep-freeze；调用者不得保留可变
   frame/message/array 别名。
8. telemetry 不记录 path、args、call/message ID、digest 值、stub、tool content、summary、transcript 或
   manifest。
9. 本文的 raw transcript/projection 始终指 L1 后的 immutable canonical model result；executor 的 pre-L1 raw
   bytes 只能进入受治理 digest/receipt，绝不能作为 fallback 进入 transcript 或 Provider payload。

## 入口 Gate A0

开始实现前必须同时满足：

- ADR-0096 为 `accepted`，明确 L1/L2/prepare/final-admission 决策、schema v22、性能与 metadata 上限，
  并准确记录对 ADR-0048 决策 4 与 ADR-0049 决策 6 producer/批次成员的局部取代；
- ADR-0095 与 Foundation 完成记录保持历史原样，仅允许增加后续链接；
- 当前 schema v21、ToolSpec registry、terminal variants、所有上下文入口、Provider admission、checkpoint、
  cache identity 和 feature default 已形成可复跑 baseline；
- 实施者用 `rg --files` 解析下文预期新增测试路径，禁止空 glob 或 skipped suite 冒充验证；
- 本计划状态为 `active`，且 Slice B 仍保持 `draft`。

任一项不满足均为 blocked，不得先实现再补 ADR。

## 逐 Task 设计

### TCR-A01：冻结契约、入口与默认值基线

建立 machine-readable contract inventory：列出所有 production ToolSpec、terminal variant、context purpose、
Provider dispatch 入口、schema v21 event/snapshot 分支和 route/config default。为 raw payload、ToolSet schema、
prompt-affecting parameters、existing manual defaults 与 L1 Foundation bytes 建 golden。确认新 flag 默认值为 off，
现有 `contextCompactionV2`/manual 默认 true 不回退。

本 Task 复述 ADR-0096 已冻结的 performance/metadata 上限，并在首个实现结果前冻结 fixture 和
evidence identity；计划不得改写 ADR 数值。任何未登记的 production tool、
terminal 或 prompt/cache-key 参数使后续 Task fail closed，不能以“暂不支持”绕过全工具 L1。

### TCR-A02：封闭 ToolResultBudget V2 与解析注册表

在 Core ToolSpec registry 增加 `ToolModelResultBudgetV2` 封闭 union：
`stream_head_tail|line_window|serialized|structured`。`structured` 只接受闭集 projector ID；每个策略必须声明
有限 envelope、截断/continuation 语义和 policy ID。由 builtin spec 或 turn-bound runtime binding 解析
`ResolvedToolResultBudgetV2`；动态 MCP 绑定 catalog revision 与 binding digest，禁止执行中漂移。

projector ID 首版固定为 `stream-head-tail:v1|read-line-window:v1|utf8-envelope:v1|structured-receipt:v1`；
projector implementation、validator、revision、binding digest 与 budget 一同进入 policy identity。枚举必须覆盖
主模型/Sub-agent 可见的 builtin、MCP、Runtime action、interaction、Task、Skill、Plan 与 Verification result。

registry conformance 必须拒绝缺 budget、未知 projector、无有限上界、需要 continuation 却未声明 cursor、
或 runtime binding 不可重验的 ToolSpec。Shell/Search 继续使用现有 4000 字符与 stream bytes；不可借 V2
无意改变 stdout/stderr、head/tail 或 marker。

### TCR-A03：全工具 projector、UTF-8 envelope 与 continuation

实现统一、纯 `finalizeProjectedToolResultV2()`。MCP 在 V2 off 时保留当前 JavaScript-char 128 KiB；V2 on
时及其他非 Shell/Search production tool 使用 128 KiB UTF-8 最终 envelope。结构化结果始终生成有效 envelope；
`rawResultDigest` 覆盖 projection 前原结果，`modelContentDigest` 覆盖实际持久模型 bytes，不能混用。

`read_file` 使用 `line_byte_cursor_v2`，区分 initial 与 continuation；cursor 至少绑定 `lineOffset`、
`utf8ByteOffsetInLine`、`endLineExclusive`、`pathDigest`、`resourceRevision`。行号为 1-based，首次请求遵守
`initialOffset=offset??1` 与 `effectiveInitialLimit`；offset 越过 EOF 返回无 cursor 的
`completed_empty`。`pathDigest` 覆盖 `resolvePath()` 规范绝对路径 domain，`resourceRevision` 覆盖
decoder contract ID 与 `UTF8(normalizeEOL(decodeTextBuffer(raw)))`；decoder 先处理 UTF-8、UTF-16LE/BE 和
BOM，其 revision 进入 cursor/projector/policy identity。`utf8ByteOffsetInLine` 指向加行号前的原始
规范行 bytes。最后允许行
即使超大也完成该行后停止，并在相同 revision/endLineExclusive 内续读。path/revision 不匹配返回
typed stale continuation，不猜测或静默重启。

### TCR-A04：自包含 terminal 与唯一 ToolResult

在 executor/raw producer 和 Runtime 之间建立唯一 choke point：`finalizeToolTerminalEventV2()` 只接收 raw
outcome，调用 TCR-A03 后让每个 `finished|failed|rejected|cancelled` terminal 自包含一个
`VerifiedToolModelResultV2`。同一 reducer transition 原子更新 call terminal state 与 canonical transcript 中
唯一 ToolResult；公开 production terminal API 不接受未验证正文。

schema v22 后 finalizer/terminal choke point 无条件启用；`toolResultBudgetV2` 只选择
`projectionMode:'compat_v1'|'budget_v2'`。前者保留 V1 model bytes 但仍生成 verified receipt 且不获得
L2/route 资格；后者必须携带有限 budget identity。关闭 flag 不得恢复 reducer 正文 producer，
`legacy_unverified` 仍只能由 cutover 前 migration 构造。

approval/provider-action 等需收敛 call 的 control event 必须在同一 CAS batch 带 companion terminal。
control reducer 只清理 interaction/记录 audit，不改 terminal status、不生产 Tool Result；紧随的
self-contained target terminal 独占 status/result。原子顺序固定为 control → target terminal → sibling
terminals → resource facts → 可选 `turn.aborted`；`ask_user` 拒答不 abort turn。sandbox elevation/policy
rejection 等当前单独 producer 也必须迁移到完整 batch constructor。多取消持久完成后才触发
`AbortSignal`。replay 以 toolCall+terminal identity 幂等：byte-equal
结果去重，冲突 fail closed 并隔离 session/checkpoint。核心失败使用封闭、有限 `core-tool-failure:v1`，不得
泄露 raw args/error。

### TCR-A05：legacy-v2..v21 terminal 归一与 schema v22 前置迁移

枚举 cutover 前所有可能产生 transcript 的 v2..v21 terminal variants。它们只能在 migration/replay 层生成
`legacy_unverified`；新 production API 无法构造该分支。canonical transcript 是每个 tool call 唯一结果来源，
provider-action 只在缺失时 backfill；byte-equal 去重，冲突 quarantine，不做“最后写入胜”。

任何 legacy 结果不得被标为 verified L1V2；任何 L2 coverage 含 `legacy_unverified` 时均不得 live apply 或
获得 route-qualified 身份。cutover 后的新 terminal 仍可各自生成 verified V2，不能因同 session 存在 legacy
而关闭未来结果预算。迁移必须覆盖 interrupted event tail、重复 replay、finished/failed/rejected/cancelled、
控制事件 companion 和混合新旧结果。schema v2..v21 输入保留可恢复 raw transcript，不伪造 verified proof。
实现 Store snapshot-only `compareAndSaveMigratedSnapshot()`，同事务分别验证
`sourceSnapshot{schemaVersion v2..v21,stateRevision,snapshotEventPosition,stateChecksum}` 与
`observedEventHead{eventPosition,revision,eventId}`，把 next v22 写在 exact observed head，替换 Kernel restore
中无条件 `saveSnapshot()`。snapshot 未变但并发 tail 前进也必须 stale、丢弃候选并 reload/replay。
双 Kernel slow writer 不得覆盖已前进 snapshot。只读 history/inspection 入口不得触发 migration write；
v22 reader 保持读取 v2..v21，但 v22 写入后不支持旧 v21
binary 就地读取，回滚不得忽略未知 event 或删除 durable receipt。

### TCR-A06：不可变 pure prepare 与 purpose 合同

实现 Core-owned `prepareContextRequestV2()` 及 reviewed RFC 的完整 `ProjectionArtifactV2`、
`ReclaimApplicationEvidenceV2`、`ProjectionSourceIdentityV2`、`RequestAdmissionIdentityV2`、
`PreparedContextRequestV2`。source identity 必须绑定 source revision/turn/checkpoint/transcript prefix、
projection 与 cache-affecting environment、projection contract、L1/L2 policy、estimator；request identity 必须
绑定 purpose、最终 payload、ToolSet schema、所有 prompt-affecting parameters 与 max output。

prepare 固定执行“解析稳定环境/工具/输出预算 → raw → purpose plan → apply/pairing/final → purpose-specific next”，
且零持久写、零 lease、零 reservation、零 dispatch。purpose 是闭集：inspection/debug 只 diagnostic，
candidate 只 validation，normal 不得产生 summary dispatch；为 Slice B 预留的
`refill_observation_required|auto_compaction_eligible|summary_*` 类型在 Slice A 不具备完整 gates 时不得激活。
完整 `next` 闭集固定为 `primary_ready|refill_observation_required|auto_compaction_eligible|summary_ready|`
`summary_input_too_large|cache_parent_incompatible|candidate_ready|candidate_invalid|diagnostic_only|`
`correctness_blocked`，未知分支 fail closed。

### TCR-A07：effect-only final admission 与单次 dispatch

实现 Slice A 版本的 `admitAndDispatchPreparedContextRequestV2()`，类型层只接受 `primary_ready`。未来
`summary_ready` 必须由 ADR-0097 的 sealed capability/gate 扩展；伪造 summary artifact 在 Slice A 必须零
dispatch。resource waiter 期间不写 `dispatch_started`，唤醒后重新 pure prepare。Kernel single-runner
取得资格后，本地 precheck，建立 effect lease，并在同一 apply path 原子持久 reservation 与
`resource_budget.dispatch_started`。

Provider 边界逐项重验 prepared/source/request digest、最终 payload bytes、ToolSet schema、prompt-affecting
parameters、max output 与 Provider-data receipt，然后立即 dispatch。projection dependency 漂移使 artifact
stale；不得临时重建“看起来相同”的 payload。最终本地 admission 拒绝可用既有证明释放 started reservation；
其他 started 后无 terminal 的 crash 只能成为 `unknown_external_outcome`，禁止重放。

### TCR-A08：L2 Live planner、应用证据与失败收敛

在已接受 ADR-0096 的阈值下扩展 Foundation planner：window 已知且 raw pressure 至少 warning，或达到显式
absolute threshold 时才尝试 live；window unknown 且无 absolute threshold 不按 ratio 触发。plan 必须同时
满足最小绝对 saving、最小比例 saving和完整 block 正收益，并保持 Foundation 白名单与 settled boundary。
初始 L2 替换白名单仍仅为 `read_file|search_content|search_files`；其他工具即使 L1 已有界也不获得 L2 资格。
每个 eligible block 的所有 Tool Result 还必须满足 `receipt.projectionMode==='budget_v2'`；
`compat_v1|budget_v2` mixed block 与纯 compat block 都不得 apply。

normal/candidate/diagnostic 各自产生固定 purpose plan，不共享可变候选。应用结果明确为
`off|applied_commit|applied_plan|valid_noop_plan|raw_fallback`；`applied_plan` 只是 purpose evidence，不能推进
watermark。无效 plan/apply 候选不发送；按 raw final pressure 收敛到 raw primary，或在 Slice B gates 完成后
由 L3 处理。只有 canonical pairing/projection 损坏才 hard-block。

### TCR-A09：ContextReclaimCommit、applied receipt 与 v22 持久化

实现 metadata-only `ContextReclaimCommitV1` 的 reviewed RFC 全字段：policy/L1 policy、settled message/turn、
checkpoint、raw/applied/coverage digest、estimator、projection/cache environment、ToolSet schema、projection
contract、cache epoch 与 turn index。commit boundary 只向前移动；batch saving/hysteresis 达标；同 policy 的
committed prefix bytes 稳定。

`cacheEpochId` 由 checkpoint、L1/L2/estimator/ToolSet/projection contract 与窄
`cacheAffectingEnvironmentDigest` 确定性派生。持久 metadata 不保存 raw content/path/args，但任何会改变
cacheable prefix bytes 的规范化 project/user/system instructions、active Skill、prompt contract 和
sandbox/runtime frames 内容都必须改变 digest；wall clock/global revision 不改变 epoch。正向/负向 golden
必须分别覆盖“prefix bytes 改变则换 epoch”和“纯 revision/时间改变则不换 epoch”。watermark
只能在使用该 effective projection 的 primary Provider 成功后，由同一 Kernel lease、Store CAS batch 持久
封闭 2/3-event terminal union：无 proposed commit 时是
`model.responded{reclaimReceiptDigest:'none'} + resource_budget.reconciled`，不构造 receipt；有 proposed commit 时才是
`model.responded + context.reclaim_commit_advanced{receipt} + resource_budget.reconciled`。primary response 携带
bounded request evidence，receipt 除 previous commit/effective projection/request/source/proposed commit 外，还绑定
admitted request digest、response message ID 和 terminal batch ID。分支内 events 共享 batch/causation identity 与连续
revision；Kernel/replay 在 reduce 前验证完整 branch。推进 reducer 只消费紧邻、未消费且逐项匹配的
primary response evidence，standalone/reordered/mismatched/candidate/summary response、none 后出现 reclaim event 或
non-none 后缺 event 均整批失败；不设第四个 commit 写入。candidate/summary/diagnostic、
`applied_plan` 或失败 dispatch 均不得 commit。schema v22 migration 保留 v21 raw baseline；checkpoint reset、
policy/env mismatch 与 clear 使用显式 invalidation/rebase，不伪造旧 commit。A05 的 snapshot-only CAS 在本 Task
纳入 v22 migration/restart/fork/rewind 故障矩阵。
已提交 prefix 在 live mode 下即使 pressure 回落仍稳定重放，只有扩展重新过 trigger/saving/hysteresis；若 Provider
成功但 terminal CAS batch 未落盘，只保留旧 commit，不推断成功、不补写且不重放 Provider。

### TCR-A10：入口收敛、restore 与错误矩阵

让 normal、preflight、resource estimator、`/context`、candidate validation、restore/debug 与 Model Controller
只消费 TCR-A06 的 artifact/identity，不各自重算 frames 或 token estimate。off、shadow、live 都经相同 raw
builder；只有 admitted primary payload 可调用 Provider。

restart/resume/fork/reset/rewind 在相同 v22 identity 下重建同一 canonical projection；fork/rewind 不保留越过
恢复点的 commit。L1 projector/budget contract 无效时 tool result fail closed；L2 identity 无效按 TCR-A08
fallback；Provider/lease/validator failure 不重复 dispatch、不循环、不把容量估计错误升级为 correctness block。
Provider overflow 仍是普通 terminal，绝不自动 L2/L3/retry。

### TCR-A11：Flag、route qualification、缓存与隐私证据

登记且保持默认 `toolResultBudgetV2=false`、`contextReclaimV1=false`、`reclaimMode=off`，schema 严格接受
`off|shadow|live`；只有前两个 flag 都 true 时 live 才可 effective。完整 automatic gate 的其他 flag/type 可登记
但 Slice A 不激活 auto L3。trusted route qualification 只从受信 evidence registry 派生，
用户 config、model name 或本地自报不能开启；未满足时最多记录 experimental evidence，不得称 production。

增加 synthetic 大 current-turn read、tool-heavy settled history、mixed/legacy blocks、stable prefix/cache epoch、
continuation 和 privacy negative cases。metrics 只输出 reviewed RFC 允许的聚合：mode/policy/schema、token/char
saving、block counts、pressure/reason/duration、cache counts、planner/apply latency/memory/metadata bytes；类型层与
snapshot 测试共同阻断敏感字段。

### TCR-A12：Gate A 证据、文档与生命周期收敛

执行下文全部验证并生成可复核 evidence identity；真实 Provider 数据不能由 mock、synthetic receipt 或 skipped
runner替代。若 ADR-0096 冻结的本地性能/metadata 上限、G0/G2 基线或隐私门禁任一失败，保持计划 `active`
并回滚 live flag，不能降低阈值。

与实现同批新增/更新 `docs/active/three-tier-context-reduction.md`、feature flags、model-provider boundary、
compaction、observability/privacy、file/tool boundary、persistence 文档，以及相应 `docs/book/`、根/docs README、
`docs/documentation-map.json` 和计划索引。只有 Gate A 全绿才新增 Slice A 独立完成记录并按生命周期归档本计划；
文档必须明确 Slice B 尚未完成。

## 预注册本地资源门禁

TCR-A01 必须固化一份 deterministic fixture：2,000 个 settled tool-call blocks、至少 8 MiB L1 后 canonical
model content、10% eligible/90% ineligible mixed blocks，以及相同 bytes 的 off/live 对照；benchmark 固定 Bun、
OS/CPU、warm-up、采样次数、GC 方式和 policy identity，并在首次实现结果产生前提交。不得在看到结果后更换
fixture 或放宽上限。

- `prepareContextRequestV2` 的 L2 plan+apply+final-estimate p95 ≤ 50 ms；
- 相对 off/raw prepare 的额外 peak heap ≤ 64 MiB；
- 每次成功 primary 新增的 reclaim commit + applied receipt + event identity canonical UTF-8 bytes ≤ 16 KiB；
- 单个 verified terminal 的 metadata（不含受 budget 控制的 model content）canonical UTF-8 bytes ≤ 8 KiB；
- off 路径 p95 相对当前 frozen baseline 回归 ≤ 5%，payload byte mismatch 为 0。

预期新增 `scripts/evals/context-reduction-slice-a-local-gate.ts` 输出 bounded JSON evidence；超限即 Gate A 失败，
不得用机器更换、缩小 fixture、均值替代 p95 或排除失败样本通过。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| TCR-A01 | Gate A0 | contract inventory、raw/default/schema-v2..v21 golden | registry、config、projection、terminal baseline | 只冻结事实；漂移即 blocked |
| TCR-A02 | TCR-A01 | `src/core/tools/registry/` budget union/resolver/conformance | registry conformance、dynamic MCP binding tests | V2 flag off；未知 spec fail closed |
| TCR-A03 | TCR-A02 | unified projector、UTF-8 envelope、read cursor | budget、Unicode/UTF-16/BOM/huge-line/stale golden | 保留 V1 bytes；cursor/decoder versioned |
| TCR-A04 | TCR-A03 | verified terminal finalizer、ordered control/terminal CAS batch | terminal/reducer/cancel/replay/非法顺序 fault injection | 不回写历史；冲突 quarantine |
| TCR-A05 | TCR-A04 | legacy v2..v21 normalizer、snapshot/head migration CAS、fixtures | representative schemas、event-tail/replay/双 Kernel stale-writer | legacy 永不升级 verified；CAS stale reload/replay |
| TCR-A06 | TCR-A02、TCR-A05 | immutable prepared artifact、closed purpose/next | purity、alias mutation、digest/pairing tests | 新 orchestrator 未 dispatch，可切回 raw |
| TCR-A07 | TCR-A06 | effect-only admission、lease/reservation/dispatch | waiter/stale/final-recheck/crash tests | started 后只按 durable terminal 恢复 |
| TCR-A08 | TCR-A06 | L2 live planner/apply/evidence | threshold/saving/mixed/fallback tests | mode off 恢复 raw；不删除 transcript |
| TCR-A09 | TCR-A07、TCR-A08 | commit/receipt/cache epoch、schema v22 | event-shape CAS、restart、v2..v21→v22、cache-prefix tests | schema 可读旧 v2..v21；flag off 不应用 commit |
| TCR-A10 | TCR-A07、TCR-A09 | all-entry convergence、restore/error matrix | e2e、context/debug/candidate、reset/fork tests | 入口一次回滚；禁止双路径 dispatch |
| TCR-A11 | TCR-A10 | flags、trusted registry、privacy/cache evidence | rollout admission、privacy snapshot、continuation | kill switch 全 off；撤销 route evidence |
| TCR-A12 | TCR-A01..A11 | Gate A evidence、active/book/map/index、完成记录 | 全量命令、docs gates、evidence replay | 任一 gate 失败保持 active，无完成声明 |

## Gate A

### A-G0：正确性、唯一性与迁移

- 所有 production tool 都有有限 L1 budget；marker/continuation 可重放，巨大末行 cursor 行为精确；
- finished/failed/rejected/cancelled terminal 各自自包含唯一 verified result；所有控制/取消中断点无 orphan、
  重复或冲突正文，terminal 持久先于 `turn.aborted`/`AbortSignal`；
- pure prepare、inspection/debug/candidate 的 lease、reservation、`dispatch_started` 与 Provider dispatch 均为 0；
- v2/v11/v12/v13/v16/v17/v18/v20/v21→v22、所有 legacy terminal tail、重复 replay、mixed/invalid
  data 全绿；snapshot 不变但 tail head 并发前进时 slow writer 必须 stale；legacy 不得 route-qualified；
- off 路径与 baseline bytes 相同，原 transcript 与 Runtime authority 不变。

### A-G1：L2 Live 与持久恢复

- tool-heavy settled history 在 eligible warning/absolute threshold 后实际应用 L2，且每次满足预注册 absolute、
  proportional 和 complete-block saving；无正收益不改 payload；
- commit 只在成功 primary receipt 后单调推进，cache epoch 可解释，连续 turn 不反复改写 committed prefix；
- mismatched request、candidate/summary response、standalone/reordered reclaim event 都零 commit；只有 exact
  primary response/receipt/batch replay 可晋升；
- no-advance 分支固定两 event 且禁止 reclaim event；advance 分支固定三 event 且禁止缺/多/乱序；
- restart/resume/fork/reset/rewind 在相同 identity 下重建相同 projection；stale/invalid plan 不发送候选，
  不重复 dispatch、不无限循环。

### A-G2：性能、缓存、continuation 与隐私

- synthetic/golden/Unicode/MCP/read continuation 与 ADR-0096 的本地 p95 latency、peak memory、metadata bytes
  上限全部通过；
- cache prefix 对照、重复 read/search 与 continuation non-inferiority 证据满足 ADR-0096/ADR-0057 约束；
- UTF-16LE/BE BOM、BOM/编码切换、非法 UTF-8/force 和 EOL-only 变化的 decoder/resource-revision
  golden 符合 ADR domain；
- shadow/live telemetry 泄露为 0；默认 config 关闭，route qualification 不能由用户配置伪造。
- mixed `compat_v1|budget_v2` history 中只有全 `budget_v2` eligible block 可 L2；compat result 永不
  提升 L1V2/route qualification。

### A-G3：文档与表述

- active/book/README/map/index 与当前实现同步，`check:docs-impact`/`check:docs` 通过；
- 完成记录只声称 Slice A，明确 L3/checkpoint v2/refill guard/完整三级仍未实现；
- Slice B 仍为 `draft`，直到 ADR-0097 accepted 且本 Gate 的证据可重放。

## 验证命令

实现至少运行以下命令；标为“预期新增”的测试文件必须先真实创建并被 Bun 收集：

| 预期新增测试 | Task | 必跑覆盖 |
| --- | --- | --- |
| `tests/tool-result-budget-v2.test.ts` | TCR-A03 | UTF-8 envelope、cursor、UTF-16/BOM/invalid-force/EOL、compat/budget mode |
| `tests/runtime/tool-terminal-v2.test.ts` | TCR-A04 | self-contained terminal、control ownership/order、replay conflict |
| `tests/runtime/schema-v22-migration.test.ts` | TCR-A05/TCR-A09 | v2..v21 cutover、snapshot+head CAS、concurrent-tail/双 Kernel stale writer |
| `tests/runtime/context-preparation-v2.test.ts` | TCR-A06/TCR-A07 | pure prepare、deep freeze、primary-only dispatch、stale identity |
| `tests/runtime/context-reclaim-live.test.ts` | TCR-A08 | live eligibility、fixed plan/apply、raw fallback |
| `tests/runtime/context-reclaim-commit.test.ts` | TCR-A09 | 无推进两 event/有推进三 event、exact/mismatch/reordered batch、cache epoch |

```bash
bun test tests/tools/tool-registry-conformance.test.ts tests/tool-runner.test.ts tests/runtime/tool-controller.test.ts
bun test tests/context.test.ts tests/context-budget.test.ts tests/context-reclaim.test.ts
bun test tests/runtime/reducer.test.ts tests/runtime/actions.test.ts tests/runtime/action-emission.test.ts
bun test tests/runtime/concurrent-shell-cancel.test.ts tests/runtime/cancel-resume.test.ts tests/runtime/fault-injection.test.ts
bun test tests/runtime/context-reclaim-shadow.test.ts tests/runtime/context-compaction-shadow-gate.test.ts
bun test tests/runtime/context-compaction.test.ts tests/runtime/context-compaction-e2e.test.ts
bun test tests/runtime/context-compaction-manual.test.ts tests/runtime/context-compaction-auto.test.ts
bun test tests/runtime/resource-budget.test.ts tests/runtime/resource-budget-admission.test.ts
bun test tests/runtime/kernel.test.ts tests/runtime/store.test.ts tests/runtime/file-checkpoints.test.ts
bun test tests/evals/compaction/continuation.test.ts tests/evals/compaction/route-qualification.test.ts
bun test tests/tool-result-budget-v2.test.ts tests/runtime/tool-terminal-v2.test.ts
bun test tests/runtime/schema-v22-migration.test.ts tests/runtime/context-preparation-v2.test.ts
bun test tests/runtime/context-reclaim-live.test.ts tests/runtime/context-reclaim-commit.test.ts
bun run scripts/evals/context-reduction-slice-a-local-gate.ts
bun run test:mock
bun run test
bun run typecheck
bun run format:check
bun run lint
bun run check:core-boundary
bun run check:compaction-legacy
bun run check:docs-impact
bun run check:docs
git diff --check
```

若 route evidence 包含真实 Provider 资格，还必须显式运行对应 live runner，并保存 route/model/adapter/prompt/
ToolSet/policy identity；mock 只验证结构，不能替代真实证据。

## 文档同步清单

- 新增 `docs/active/three-tier-context-reduction.md`，只描述已通过 Gate A 的 L1/L2 当前行为；
- 更新 feature flags、Provider boundary、compaction、observability/privacy、file/tool boundary、Runtime
  persistence 对应 active 文档；
- 更新 `docs/book/` 相关章节、根 `README.md`/`docs/README.md`（若映射要求）、
  `docs/documentation-map.json`、`docs/space/plans/index.md` 与 `docs/space/index.md`；
- ADR-0096 接受后只更新其状态/索引/反链，不改写 ADR-0095 或其他 accepted ADR 的历史结论；
- Gate A 通过后新增独立完成记录并归档本计划；失败时不写 completed evidence。

## 风险与回滚

- **工具结果双 producer**：用类型删除 production legacy constructor，以 reducer/event conformance 阻断；
  发现冲突立即关闭 V2/live 并 quarantine，不能选一个结果继续。
- **UTF-8/cursor 边界漂移**：按 byte/line/revision property test；回滚新 V2 flag，不修改已持久正文。
- **prepare/admission 双建 payload**：只允许 admitted artifact 到 Provider；identity 漂移 fail closed，禁止 fallback
  到旧的第二 dispatch 路径。
- **watermark 错进或缓存抖动**：commit 与 primary receipt 同 CAS；关闭 live 后从 raw transcript 重建，保留
  metadata 供诊断而不应用。
- **schema v22 中断**：迁移保持 v21 可读和 raw source；不得降级覆盖数据库或伪造 verified/commit receipt。
- **隐私旁路**：DTO 与 sink 使用闭集聚合字段；任何泄露为 Gate failure，删除证据并关闭 rollout。
- **性能回归**：不得放宽 ADR-0096 阈值；关闭新 flag、撤销 route evidence，计划保持 active。

紧急行为回滚顺序为 `reclaimMode=off` → `contextReclaimV1=false` → `toolResultBudgetV2=false`；它只影响后续
projection/tool results，不删除 transcript、不逆写 migration、不宣称恢复已截断正文。架构或 schema 回滚必须另立
迁移计划，不能以配置回滚替代 durable state 兼容性验证。

## 完成声明禁令

只有 A-G0..A-G3、全部验证命令、ADR-0096 accepted、实现文档同步和独立 evidence replay 均通过，才能把
Slice A 记为 completed。即使如此，也必须继续写明：Slice B、ADR-0097、schema v23、checkpoint v2、
cache-safe summary fork、durable refill guard 与真实 L3 route qualification 尚未由本计划交付，因此“完整三级
上下文缩减可用”仍是禁止声明。
