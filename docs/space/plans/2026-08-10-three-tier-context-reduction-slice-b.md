# 三级上下文缩减 Slice B：L3 Source Convergence 与 Checkpoint V2 实施计划

状态：superseded
日期：2026-08-10
优先级：P0
设计依据：[`../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md`](../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md)
前置计划：[`2026-08-10-three-tier-context-reduction-slice-a.md`](2026-08-10-three-tier-context-reduction-slice-a.md)
架构前置：ADR-0095（accepted）、
[`ADR-0096`](../../adr/0096-three-tier-context-reduction-l1-l2-live.md)（accepted）、
[`ADR-0097`](../../adr/0097-three-tier-context-reduction-l3-source-convergence.md)（accepted）
Runtime 前置：已满足——Slice A Gate A 全部通过，完成记录与 schema v22 migration/回滚证据可重放

替代计划：[`2026-08-10-progressive-session-memory-compaction.md`](2026-08-10-progressive-session-memory-compaction.md)
最终后续：[`2026-08-10-progressive-context-compaction.md`](2026-08-10-progressive-context-compaction.md)

> 2026-08-10 路线转向后停止实施。本文保留已经完成的分析、测试和迁移细节，但不再授权继续扩展
> `cache_safe_fork:v1`、checkpoint v2 三段证明、真实 Provider cache 资格或 durable refill guard。

## 生命周期与执行授权

Slice A 的 A-G0..A-G3、独立完成记录、schema v22 migration/回滚 evidence 以及 ADR-0096/0097 accepted
前置曾经满足，因此本文曾授权按 TCR-B01..B12 实施和验证。ADR-0098 接受后该授权终止，以下 owner、
kill switch、evidence 和 Gate 只保留为历史审计信息，不再允许继续实现。Owner 为 `github:@ferqx`。原 rollout
kill switch 顺序固定为关闭
`contextCompactionAutoV1/autoMode=live` → 移除 exact route qualification → 必要时关闭 L2 live/L1 V2；任何
回滚不得降低 durable guard floor。deterministic evidence 只在显式 `--output` 路径保存 bounded、可独立 replay
artifact；真实 Provider evidence 必须显式 opt-in、只保留聚合/identity，不保留 credential、transcript、summary、
message/header 或正文，并按 exact route identity 失效/撤销。

ADR-0097 只能在 cache-qualified summary request 形态上局部取代 ADR-0022 §3 与 ADR-0057 决策 1 的独立
无工具请求形态，并仅在 v21/v22→v23 migration cutover 局部取代 ADR-0022 §2 的
pending-without-terminal 重新执行规则；单一 Markdown narrative、零 Runtime 工具执行、零自动 retry 保留。其他 accepted ADR、
Foundation 范围和 Slice A 证据不得改写。

本计划完成前禁止声明“完整三级上下文缩减可用”。完成后也只能按 Gate B 实际证据声明开发可用或特定
route 的 experimental-qualified；不得据此声明默认开启、production-supported、Claude Code parity、无限会话
或所有 Provider 等价。真实 Provider Gate 不能由 mock、synthetic cache receipt、手工截图或 skipped runner
替代。

## 目标

在 Slice A 唯一 prepared/final-admission 路径与 schema v22 L2 commit 上，交付：

1. manual/auto L3 使用同一 canonical safe source、同一 L1/L2 policy 与可重验 source identity；
2. cache-qualified route 通过冻结父 primary prefix 的 `cache_safe_fork:v1` 生成一次、零工具执行的 summary；
3. checkpoint v2、bounded SourceManifest 与 schema v23 migration 能从真实 immutable transcript 重算证明；
4. auto L3 只在完整 flag/mode/route/cooldown/breaker/pressure gates 下发生，并由 durable two-step refill guard
   阻止重启、fork 或 rewind 绕过；
5. restore/reset/resume/fork/rewind、unknown external outcome、overflow 和隐私语义闭合；
6. 每个 route/model 以预注册 paired warm/cold 真实 Provider 证据通过 correctness、cache、cost、latency、
   continuation 与 repeated-read 非劣门禁。

## 范围与不变量

### 包含

- `buildCompactionSourceProjectionV2()`、purpose-specific before/source/after plan 与同一
  `ProjectionSourceIdentityV2`；
- Provider 前零 lease 的 `PreparedCompactionProjectionBundleV1` 与 summary admission 后在 compaction lease
  下形成的 `FinalizedCompactionProjectionBundleV1`，共享 source/environment 但保留 purpose-specific
  request identity/output limit；
- `cache_safe_fork:v1`、`PromptCacheParentIdentityV1`、Provider cache-key registry 与 isolated manual fallback；
- checkpoint v2 的完整 v1 envelope、source identity/base union/proof chain、8 KiB fixed SourceManifest；
- schema v22→v23 与 v2..v21→v22→v23、checkpoint v1/legacy-v2、pending event tail 迁移矩阵；
- reducer-owned `AutoCompactionGuardV2`、two-step refill observation、Store rewind/fork join、合法 reset；
- manual/auto L3、reservation/final admission、checkpoint commit/rebuild-once、restore/reset/resume/fork/rewind；
- overflow typed classification 的非自动恢复边界、隐私 telemetry、real-provider route qualification；
- 与当前行为同步的 active/book/map/索引/完成记录。

### 不包含

- Provider overflow 后自动 L2/L3、normal retry 或独立 retry reservation；
- cache-incompatible auto 路径暗中切换 isolated request shape；
- Provider `cache_edits`、message snip、渐进/chunk/merge/partial checkpoint；
- model-visible recovery hint、mustKeep frame、自动重读或 artifact store；
- 第二份模型 memory/fact ledger 或改变 Runtime/transcript 权威；
- effectful/dynamic MCP/Shell/Web 的 L2 正文替换扩面；
- default-on 或 production rollout。

### 不变量

1. 原 transcript 永不删除；checkpoint 只替换 active model narrative，不成为事实/Plan/Verification 的新权威。
2. 所有入口继续使用 Slice A 的 pure prepare 与 effect-only admission；summary/candidate/diagnostic 不建立
   primary L2 commit，Provider 只能接收 immutable admitted payload。
3. L3 source 只覆盖 safe settled canonical frames；同一次候选的 before、summary source、after projection 是
   distinct purpose plans，但必须绑定同一 source identity/environment/lease。
4. summary 是单一 Markdown narrative；compactor 不持有 executor，任何 tool-call candidate、非文本终态或
   多正文 artifact 都 invalid，绝不执行工具。
5. auto L3 不使用 raw pressure，不在 incomplete gates 下 hard-block normal；不满足 auto 条件时 dispatch 经
   final admission 的 effective primary，由 Provider 决定真实容量。
6. `applied_plan` 是 purpose-specific 临时应用证明，不是 L2 watermark commit；只有成功 primary receipt 才能
   推进 commit。
7. started Provider attempt 无 durable terminal 时为 `unknown_external_outcome`，不能自动重放；overflow 也是
   普通 terminal，不合成 compaction reason。
8. manifest、checkpoint 和 telemetry 不记录 model-visible recovery hint、path、args、tool content 或
   transcript；manifest 只允许 ADR-0097 固定的单值 boundary/identity/digest 字段，不允许 ID/digest 列表，
   也不是模型上下文或 authority。telemetry 额外禁止 call/message ID、digest 值、summary 和 manifest。
9. raw transcript/projection 只表示 L1 已预算的 immutable canonical model result；pre-L1 executor bytes 绝不因
   `raw_fallback`、restore 或 migration 进入 summary/normal Provider payload。

## 入口 Gate B0

开始实现前必须同时满足：

- Slice A 已完成，A-G0..A-G3 evidence identity 可重放，schema v22 是当前唯一写入版本；
- ADR-0097 为 `accepted`，准确记录局部取代边界，并冻结 cache reuse/cost/latency/repeated-read CI margin、
  guard policy与本地性能/metadata 上限；
- ADR-0096 为 `accepted`，Slice A 的 prepared artifact、terminal result、commit/receipt 不再有平行 producer；
- route capability/evidence registry 当前资格与真实 Provider cache receipt 格式已盘点；未知 cache-key 参数默认
  fail closed；
- 本计划从 `draft` 改为 `active`，并登记明确 owner、rollout kill switch 和 evidence retention 边界。

任一项不满足均为 blocked；不得先开启 manual/auto L3 再补 checkpoint/guard/migration。

## 逐 Task 设计

### TCR-B01：冻结 v22、route 与 L3 基线

复跑 Slice A Gate A，并建立 v22 session/checkpoint/reclaim commit、manual v1 checkpoint、pending compaction、
Provider request/receipt、cache identity、rewind/fork/reset 与 legacy migration golden。列出所有 Provider adapter 的
prompt/cache-key-affecting 参数、execution-disable 能力和真实 cache receipt 字段；未登记参数使 route
`cache_parent_incompatible`。

复述 ADR-0097 已冻结的 source contract、manifest 8 KiB 上限、guard policy epoch、summary
input/output/safety reservation、绝对 1024 token与比例收益下限及所有 qualification margin；
在首个实现结果前冻结 fixture 与 evidence identity，不得改写 ADR 数值。本 Task 不 dispatch Provider。

### TCR-B02：Canonical summary source 与同 lease bundle

实现 `buildCompactionSourceProjectionV2()`：从 immutable transcript/checkpoint base 与 settled live tail 重建
canonical safe frames，使用 Slice A 同一 L1/L2/checkpoint/cache environment。normal-before、summary-source、
candidate-after 分别生成 purpose-specific fixed plan/request identity，但共享一个
`ProjectionSourceIdentityV2`；summary-source 不能递归 L3。

Provider 前由 pure prepare 只生成 deep-frozen `PreparedCompactionProjectionBundleV1`，其本身零
effect lease、零 reservation。summary request 获得 admission 并建立 compaction lease 后，summary 返回且
通过结构验证时，才在该 lease 下生成 `FinalizedCompactionProjectionBundleV1`。两个 bundle
共享 source/environment/route，但 before、summary-source、after-candidate 各自保留 purpose-specific
request identity、prompt-affecting parameters 和 max-output；任何 drift 都 stale，不能拼接另一轮
candidate。isolated manual/development 只有从入口明确选择且 admitted 时才能 raw fallback，且 raw
source 仍须满足 summary input 上限与最终 Provider-data admission。

### TCR-B03：PromptCacheParentIdentity 与 cache-safe fork

实现 closed Provider cache-key registry 与 `PromptCacheParentIdentityV1` 全字段：最近一次已成功持久的 primary
request/route/model/cache epoch/system/ToolSet/message+frame coverage/parent projection/prompt params/eligible tokens/
真实 cache receipt。不能用 hypothetical normal-before 构造 parent。

`cache_safe_fork:v1` 精确重放父请求 cache-eligible system/context/tool schema/history prefix，只在 safe source
末尾追加固定 compaction instruction。`tool_choice`、thinking/effort、context management、output format、beta
headers、citations、web/image state 及 adapter registry 参数必须逐项相同并进入 digest；若改 `auto→none` 会改变
cache key，则保持父值，以“compactor 无 executor + tool call invalid”保证零执行。

冻结范围内只重放父请求实际使用的 committed L2 bytes；本轮 proposed watermark 若改写父 prefix 必须延后。
冻结边界后的 tail 可用 `applied_plan {baseCommitDigest,...}`，但不得 commit。无法重验 parent 或输入超限返回
typed `cache_parent_incompatible|summary_input_too_large`；auto 终止本轮，不切 isolated、不 retry normal。
`raw_fallback {failure:'cache_parent_frozen'}` 也只能重放父请求精确 frozen representation，不能借 fallback
恢复本轮会改写父 prefix 的 proposed plan。

### TCR-B04：Checkpoint V2、SourceManifest 与三重证明

定义 checkpoint v2 为 checkpoint v1 完整 envelope 的向前兼容扩展，并加入 verified/legacy
`sourceIdentity`、raw/source-projection/normalized-summary/after digests、L1/L2/summary policy、projection/cache
environment、projection contract、route identity、SourceManifest identity 与
`off|applied_commit|applied_plan|valid_noop_plan|raw_fallback` 证据。base 是显式 v1/v2 union，不把 v1 原地升级。
v1 compatibility 字段 `sourceDigest` 必须逐字节等于 `rawSourceDigest`；任何不等都 fail closed。

实现三重 proof：checkpoint↔manifest exact；manifest↔从 immutable canonical safe source range 现场重建的完整
digest（不能只链已持久 digest）；normalized summary↔candidate-after/pairing/digest。覆盖范围含任一
`legacy_unverified`、`projectionMode==='compat_v1'`、缺 contract/source、base mismatch 或 source mismatch 时不得
生成/激活 verified-v2。只有范围内每个 Tool Result 都是 `budget_v2` receipt 的全量 raw rebuild 才能产生
`sourceIdentity='verified_v2'`；含 compat 的 source 必须保持 `legacy_raw_source`。

SourceManifest 是 canonical fixed-field JSON，最大 8 KiB，不允许数组、map、自由文本、正文、路径、参数、
ID/digest 列表、recovery hint、mustKeep、artifact pointer 或自动读取指令。它只做持久证明，既不注入模型上下文，
也不成为 Runtime authority。task/turn/authorization、tool descriptors、Plan artifact、项目规则与 workspace
状态必须从最新 Runtime 与 projection environment 确定性重注入，不能从 manifest 或 summary 恢复权威。

### TCR-B05：Schema v23 与 legacy/pending migration

将 Runtime 写入版本从 v22 提升到 v23，新增 checkpoint v2、guard、observation/carry/reset 与所需 receipt/event。
迁移矩阵必须覆盖 v22→v23、v2..v21→v22→v23、checkpoint v1 保持 v1、v1 base 派生
`legacy_raw_source`、legacy-v2 source identity 永久传播，直至从完整 raw transcript 重建，不能随 replay 洗白。
v2..v21→v22 的前半段必须复用 Slice A 的
`sourceSnapshot{schemaVersion,stateRevision,snapshotEventPosition,stateChecksum}` +
`observedEventHead{eventPosition,revision,eventId}` exact-head CAS；snapshot 未变但 event tail 并发前进时也必须
stale、reload/replay，不得把 v23 候选写到已前进历史上。

v21/v22 `disabledUntilManualAction=true` 映射为 breaker open，保留 guard safety floor，不伪造 anchor/count。
pending summary/request 以 durable attempt 事实确定性分流：没有 `dispatch_started` 时作为 stale pending
cancel；已有 `dispatch_started` 但没有 terminal 时进入 `unknown_external_outcome`；已有 terminal 时只重放
terminal 的 reducer 收敛。三个分支都绝不重放 Provider。所有 legacy terminal variant 继续遵守 Slice A cutover；invalid
v2 隔离并保留 raw，unknown newer event fail closed。重复迁移、interrupted tail、base mismatch、mixed source、
mixed `compat_v1|budget_v2` source 不升格、snapshot position/tail 去重必须 deterministic。

### TCR-B06：AutoCompactionGuard V2 与 two-step observation

实现 reducer-owned `AutoCompactionGuardV2` 全字段：generation、policy epoch、primary model response ordinal、
anchor/observed anchor、rapid-refill count、cooldown ordinal、breaker/opened checkpoint。ordinal 只在 primary
`model.responded` 成功持久时增加；checkpoint v2 激活时设置 anchor 并清空 observed anchor。

首次在 refill window 达到 final compact pressure 时，pure prepare 只能返回
`refill_observation_required`，不得同轮返回 auto request。Kernel 用独立、无 Provider/resource reservation 的
CAS transition 持久 `context.compaction_refill_observed`，事件绑定 anchor/ordinal/effective projection+pressure/
previous guard digest/policy epoch；reducer 对同一 anchor 幂等一次并在达到 limit 时原子开 breaker。随后重新
prepare；若本 observation 开 breaker，则本次 L3 dispatch 为 0。任何 auto admission 前逐项重验 observation
identity、guard digest/generation、policy epoch 和 anchor。
若已超过 policy 的 N 个 completed primary responses，下一 observation 可以重建 rapid-refill chain，但 cooldown
独立保留；summary 失败也不能让同一 anchor 再次累计。

### TCR-B07：Store guard join、fork/rewind 与合法 reset

在 RuntimeStore 同一 rewind/fork transaction 中读取 operation 前 session guard floor，与目标 snapshot guard
执行 `joinAutoCompactionGuardV2()`，持久 `context.compaction_guard_carried_forward` 后才暴露 snapshot。较大
generation 胜；同 generation open 胜，ordinal/count/cooldown 取最大。dangling anchor 可清除但不得降低
count/breaker；policy epoch 迁移保留 monotonic safety floor 和 carry digest。

fork 即使来自早期 boundary，也与源 session 当前 floor join；checkpoint reset 不降低 guard。只有成功的显式
manual `/compact`、`/clear` 新会话或专用用户/管理员 reset action 可以原子递增 generation 并持久 reset；
失败/取消 manual、flag/mode 切换、restart/resume 不得 reset。两步 observation、join 和 snapshot/event tail
在任意中断点可恢复且不重复计数。

### TCR-B08：Manual/Auto L3 orchestration、预留与 checkpoint commit

完整 auto gate 固定为：

```text
toolResultBudgetV2
&& contextReclaimV1 && reclaimMode=live
&& contextCompactionV2
&& contextCompactionAutoV1 && autoMode=live
&& trustedRouteQualification=experimental
&& finalPressure>=compact
&& safeBoundary && cooldownAllows && breaker=closed
```

trusted qualification 只来自 evidence registry。manual/development 还必须显式
`contextCompactionManualV1=true`，并在入口选择 cache-safe 或 isolated request shape；manual 不受 auto bucket，
但仍受 source/correctness/final admission。proactive L3 前必须分别预留 summary input/output 与 Provider safety
margin；成功 L3 同时达到 1024 tokens 和比例收益；同 turn 至多一个，cooldown 按 durable primary ordinal。

summary 通过 TCR-B02/B03 admission 后只调用一次 Provider；candidate 必须是一个 normalized Markdown
narrative，无 tool call/多 artifact。checkpoint、terminal、reservation reconciliation 用同 lease/CAS 持久；
commit 后恰好 rebuild 一次 normal final payload并重新通过 resource/Provider-data admission。任何 source、lease、
route、environment、cache parent 或 prompt param stale 都零 checkpoint/零二次 dispatch。

### TCR-B09：Restore/reset/resume/fork/rewind 收敛

所有 lifecycle 入口只通过 checkpoint v2/base union、reclaim commit 和 guard join 重建：restart/resume 在相同
identity 得到相同 projection；`/compact reset` 撤销 active narrative checkpoint但按当前 L2 mode/policy/commit
决定 projection；flag/mode off 恢复 raw transcript projection；fork 复制 boundary 前 checkpoint/commit并执行
TCR-B07 join；rewind 回退越界的派生 checkpoint/commit但保留/增强 guard safety floor。

policy/environment/revision/base/source/manifest mismatch 均 fail closed，保留 raw或要求显式重新 compact，不猜测。
checkpoint v1/legacy-v2 不能获得 verified route qualification；冷 resume 必须验证 cache 过期后的完整
history→summary handoff、首个 normal continuation 与无 recovery hint 行为。

### TCR-B10：失败、overflow、零重放与隐私收敛

实现 reviewed RFC 失败矩阵：summary source/manifest/candidate 无效不写 checkpoint；source input 超限不 chunk/snip；
cache parent incompatible 终止 auto；summary Provider/validation 失败保留旧 checkpoint/transcript；stale lease 走
现有 `stale_context`；breaker open 禁止 auto 但保留显式 manual/clear。任何路径都不得产生恢复 hint 或自动读正文。

Provider overflow 只可按 adapter 稳定证明做 typed 普通 terminal，不能触发 L2/L3/retry、释放已 started
reservation或伪造 zero usage。负例必须覆盖通用 400/413/错误文本与已产生输出的 window-exceeded；started
无 terminal 继续 `unknown_external_outcome`。metrics 只保留 reviewed RFC 聚合闭集及 typed failure kind；类型、
serializer、sink 和 snapshot 负例共同证明无敏感内容/manifest 泄露。

### TCR-B11：真实 Provider route qualification 与统计 Gate

扩展 ADR-0057 route evidence schema，绑定 provider route/model/adapter、prompt/ToolSet/L1/L2/L3/guard policy、
estimator identity、projection contract ID、checkpoint schema/version、完整 projection environment 与窄
`cacheAffectingEnvironmentDigest`、cache-key registry、request shape、seed/order、suite/scorer、父 cache receipt、TTL或
namespace proof。为每个 route/model 预注册 paired warm/cold cohort，各至少 30 对，control/treatment 使用相同
transcript、eligible prefix、cache breakpoint/TTL、prompt params 和请求顺序。

计算 `min(cacheReadTokens, eligiblePrefixTokens)/eligiblePrefixTokens`，paired 95% bootstrap CI 的 warm 下界
≥0.95；summary+首 normal 的 billed-input 与 cache-create 分别判定，ratio CI 上界 warm≤1.05、cold≤1.10；
端到端 p95 latency ratio CI 上界≤1.10；重复 read/search ratio CI 上界≤1.10。不得把 billed/cache-create 相加
掩盖回归。cache miss reason 只存闭集枚举。

case 必须包含：warning 首次提出 watermark extension 且同轮仍需 L3、父 prefix冻结/extension 延后、
parent incompatible/input-too-large、完整 gates 单次 L3、breaker/restart/fork/rewind、cold resume、事实/Plan/
Verification/continuation non-inferiority、mixed `compat_v1|budget_v2` qualification 拒绝、summary failure 与真实
cache miss。planner/apply latency、peak memory、
checkpoint/guard/manifest metadata bytes 也必须低于 ADR-0097 冻结上限。任一 CI 或 correctness case 失败即撤销
该 exact route identity 资格，不能改样本或阈值补过。

### TCR-B12：Gate B、文档与完成生命周期

执行全部验证，保存 deterministic migration/golden 与真实 Provider evidence。与实现同批更新
`docs/active/three-tier-context-reduction.md`、feature flags、Provider boundary、compaction、observability/privacy、
file/tool boundary、Runtime persistence，及相关 `docs/book/`、根/docs README、documentation map 和计划索引。

文档必须区分 current behavior、route-qualified experimental、default-on 与 production-supported；只登记真实
通过的 route/model identity。只有 B-G0..B-G3 全部通过，才新增 Slice B 独立完成记录并归档本计划。Foundation、
ADR-0095/0096 与 Slice A 完成证据只加反链，不改历史范围。任何缺口使本计划保持 `active`，禁止完成表述。

## 预注册本地资源门禁

TCR-B01 必须在首次实现结果产生前冻结与 Slice A 相同的 2,000-block/8 MiB mixed canonical fixture，并增加
一个 v1 base + 10 段 incremental tail、一个最大合法 manifest、一个 rapid-refill guard/event-tail 与一个
cache-parent-frozen watermark-extension case。benchmark identity 固定 Bun、OS/CPU、warm-up、采样次数、GC、
policy/route/request shape；不得事后替换 fixture 或放宽上限。

- canonical summary-source plan+apply+proof preparation p95 ≤ 75 ms；
- checkpoint activation/三段真实 source 重验 p95 ≤ 100 ms；
- 相对 Slice A normal prepare 的额外 peak heap ≤ 96 MiB；
- `ContextCompactionSourceManifestV1` canonical UTF-8 bytes ≤ 8 KiB；
- checkpoint v2 identity metadata（不含唯一 `summary:string`）≤ 32 KiB；
- 单个 guard observation/carry/reset event canonical UTF-8 bytes ≤ 8 KiB；
- guard join/reducer transition p95 ≤ 10 ms，且 Provider dispatch count 必须为 0。

预期新增 `scripts/evals/context-reduction-slice-b-local-gate.ts` 输出 bounded JSON evidence。任何超限、用均值替代
p95、排除失败样本或缩小 fixture 均使 Gate B 失败；真实 Provider CI 门槛仍按 ADR-0097，不能用本地资源门禁
替代。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| TCR-B01 | Gate B0 | v22/route/cache baseline、ADR-0097 limits | Gate A replay、adapter registry/golden | 只读冻结；不满足即保持 draft |
| TCR-B02 | TCR-B01 | canonical source、prepared/finalized bundles | source drift/pairing/purity/lease tests | 无 Provider 前可删除；stale fail closed |
| TCR-B03 | TCR-B02 | cache parent identity、cache-safe/isolated shapes | exact-prefix、params、tool-call negative tests | auto 不 fallback；撤销 route qualification |
| TCR-B04 | TCR-B02 | checkpoint v2、base union、8 KiB manifest/proofs | recompute/tamper/legacy/mismatch/size tests | v1 保持 v1；invalid v2 隔离保留 raw |
| TCR-B05 | TCR-B04 | schema v23、v2..v21→v22→v23/v22/pending migration | repeated/interrupted/mixed migration matrix | 不降级覆盖；unknown event fail closed |
| TCR-B06 | TCR-B02、TCR-B05 | guard reducer、two-step observation | idempotence/breaker-open-zero-dispatch tests | flag off 不清 guard；event durable |
| TCR-B07 | TCR-B05、TCR-B06 | Store guard join、carry/reset transactions | rewind/fork/crash/policy-epoch tests | open/count floor 保留；仅合法 reset 增 generation |
| TCR-B08 | TCR-B03、TCR-B04、TCR-B06、TCR-B07 | manual/auto orchestrator、reservations/checkpoint | full-gate/single-L3/rebuild/final-admission tests | auto kill switch；started attempt 不重放 |
| TCR-B09 | TCR-B05、TCR-B07、TCR-B08 | lifecycle convergence | restore/reset/resume/fork/rewind/cold tests | raw transcript 保留；派生 state 按 boundary 回退 |
| TCR-B10 | TCR-B08、TCR-B09 | failure/overflow/privacy matrix | 400/413/output/stale/leak negative tests | 无自动 recovery；关闭 rollout保留旧 checkpoint |
| TCR-B11 | TCR-B03、TCR-B08、TCR-B10 | paired live runner、CI/evidence/route registry | ≥30 paired warm/cold、continuation/cache/perf | exact identity失败即撤销资格，不降阈值 |
| TCR-B12 | TCR-B01..B11 | Gate B evidence、active/book/map/index、完成记录 | 全量命令、docs/evidence replay | 任一 gate 失败保持 active，无完整三级声明 |

## Gate B

### B-G0：正确性、证明与迁移

- checkpoint↔manifest、manifest↔真实 canonical source、summary↔candidate-after 三重证明全绿，source/coverage/
  safe boundary mismatch 的 checkpoint 激活数为 0；
- coverage 含 legacy、v1 base、invalid manifest 或 mixed proof 时绝不伪造 verified-v2；
- coverage 含 `compat_v1` receipt 或 mixed `compat_v1|budget_v2` 时同样保持
  `legacy_raw_source`，不得获得 L2/route qualification；
- v2..v21→v22→v23、v22→v23、v1/v2、pending/event-tail、重复 replay 与 invalid/newer data 全矩阵通过；
  代表版本至少覆盖 v2/v11/v12/v13/v16/v17/v18/v20/v21，snapshot 未变但 event head 并发前进的 writer
  必须 stale；
- pure prepare/two-step observation/diagnostic/candidate 零 Provider reservation/dispatch；started attempt 零重放；
- fork/rewind guard join 原子，breaker/count/cooldown 不因重启、reset checkpoint、fork 或 rewind 降低。

### B-G1：三级闭环

- 大 current-turn result 由 L1 有界，tool-heavy settled history 在 warning 应用 L2；
- L2 后低于 compact 不调用 summary；仍超 compact 且完整 auto gates 允许时只进入一次 L3，否则 primary
  effective projection 通过 final admission直接 dispatch；
- summary source 使用同一 L1/L2 policy和冻结 cache parent，checkpoint v2 commit 后只 rebuild 一次；
- refill observation 必须经过 CAS 后 re-prepare；若它打开 breaker，本次及后续 auto dispatch 为 0；
- window unknown、legacy checkpoint、policy/env drift、cache incompatible 和 mixed block 均按 typed 规则收敛。

### B-G2：真实 Provider 收益、缓存与 continuation

- 每个 qualified route/model 各有至少 30 对 paired warm 与 30 对 paired cold 样本及可复核 cache proof；
- warm reuse ratio paired 95% CI 下界≥0.95；billed-input/cache-create ratio CI 上界 warm≤1.05、cold≤1.10；
  e2e p95 latency ratio CI 上界≤1.10；repeated read/search ratio CI 上界≤1.10；
- watermark extension+L3、cold resume、fact/constraint/Plan/Verification、continuation non-inferiority 与
  no-recovery-hint case 全绿；
- 本地 planner/apply p95、peak memory、checkpoint/guard/manifest bytes 不超过 ADR-0097 上限；
- route/model/adapter/prompt/ToolSet/policy/estimator/projection-contract/checkpoint-schema、完整 environment 与窄
  `cacheAffectingEnvironmentDigest`、seed/order/evidence identity 全绑定，任一漂移自动失效。

### B-G3：隐私、默认值与产品表述

- shadow/live/summary/guard/cache telemetry 和 evidence artifact 内容泄露为 0；manifest 永不进入模型上下文；
- 新 L1 V2、L2 live、auto L3 默认 off，既有 manual 默认不回退；显式受控 live 路径可复跑；
- 未通过真实 Gate 的 route 不得标 qualified；通过者最多标 exact route experimental；
- active/book/README/map/index 与实现同步，docs gates 全绿；无 parity、无限会话、Provider 等价或 production
  声明。

## 验证命令

实现至少运行以下命令；标为“预期新增”的文件必须真实存在且被收集：

```bash
bun test tests/context.test.ts tests/context-budget.test.ts tests/context-reclaim.test.ts
bun test tests/runtime/context-compaction.test.ts tests/runtime/context-compaction-summary.test.ts
bun test tests/runtime/context-compaction-manual.test.ts tests/runtime/context-compaction-auto.test.ts
bun test tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-compaction-rollout.test.ts
bun test tests/runtime/reducer.test.ts tests/runtime/kernel.test.ts tests/runtime/store.test.ts
bun test tests/runtime/file-checkpoints.test.ts tests/runtime/cancel-resume.test.ts tests/runtime/fault-injection.test.ts
bun test tests/runtime/resource-budget.test.ts tests/runtime/resource-budget-admission.test.ts
bun test tests/runtime/context-preparation-v2.test.ts tests/runtime/context-reclaim-commit.test.ts
bun test tests/runtime/checkpoint-v2.test.ts tests/runtime/schema-v23-migration.test.ts
bun test tests/runtime/compaction-source-v2.test.ts tests/runtime/compaction-cache-safe-fork.test.ts
bun test tests/runtime/auto-compaction-guard-v2.test.ts tests/runtime/compaction-lifecycle-v2.test.ts
bun test tests/runtime/provider-overflow-boundary.test.ts tests/runtime/compaction-privacy-v2.test.ts
bun run scripts/evals/context-reduction-slice-b-local-gate.ts
bun test tests/evals/compaction/schema.test.ts tests/evals/compaction/structure.test.ts
bun test tests/evals/compaction/fact-matcher.test.ts tests/evals/compaction/semantic-evidence.test.ts
bun test tests/evals/compaction/continuation.test.ts tests/evals/compaction/route-qualification.test.ts
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

真实 route qualification 另须运行显式 opt-in live runner（当前入口为 `bun run test:model:live`，若实施新增
专用 runner，必须同步 `package.json` 与文档）。runner 输出只含 case/route alias、聚合计数、CI、failure enum
和 evidence identity，不输出 transcript/summary/message/header；真实 credential 不进入 artifact。

## 文档同步清单

- 将 `docs/active/three-tier-context-reduction.md` 从 Slice A 实况扩展到已通过 Gate B 的 L3/checkpoint/guard；
- 更新 feature flags、model-provider boundary、compaction、observability/privacy、file/tool boundary、Runtime
  persistence 对应 active 文档；
- 更新 `docs/book/` 相关章节、根 `README.md`/`docs/README.md`（若映射要求）、
  `docs/documentation-map.json`、`docs/space/plans/index.md` 与 `docs/space/index.md`；
- ADR-0097 接受时登记精确局部取代边界和反链，不改写 ADR-0022/0057/0095/0096 的 accepted 历史正文；
- Gate B 通过后新增独立完成记录并归档本计划；route evidence 状态只反映精确 route/model，不泛化。

## 风险与回滚

- **summary source 与 final candidate 分叉**：同 source identity/lease 的 prepared→finalized state machine；任何
  drift 零 checkpoint，保留旧 narrative。
- **缓存资格被本地 digest 伪造**：parent 必须来自成功持久 primary receipt，未知 cache-key 参数 fail closed；
  回滚为 auto off，manual 仅显式 isolated 开始。
- **manifest 成为隐私或 authority 旁路**：固定字段、8 KiB、无数组/自由文本，serializer 与模型消息负例验证；
  发现泄露立即撤销 route、删除不合规 evidence，不读取 manifest 恢复正文。
- **迁移洗白 legacy**：legacy identity 单调传播，只有完整 raw transcript rebuild 可建立新 verified checkpoint；
  不降级覆盖 v23 数据。
- **rewind/fork 绕过 breaker**：Store transaction join、open/max floor、crash injection；异常时 fail closed 保持
  breaker open。
- **Provider 重复计费**：durable dispatch_started/terminal/unknown outcome；started 无 terminal 不重放，overflow
  不触发 retry。
- **统计过拟合或缓存噪声**：预注册 cohort/seed/order/CI，warm/cold proof 分离；不得改变 threshold 或删除失败
  样本，exact route qualification 失败即撤销。
- **产品误表述**：default-off 与 route registry 分离；文档 Gate 失败则无完成记录、无 qualified/production 声明。

紧急行为回滚首先关闭 `contextCompactionAutoV1`/`autoMode=live`，再关闭 L3 route qualification；必要时关闭
L2 live/L1 V2 回到 raw future projection。回滚不删除 transcript/checkpoint，不降低 guard floor，不把 v2 伪装
成 v1，不自动重放 started attempt。schema/ADR 回滚必须另立迁移与决策，不属于 kill switch。

## 完成声明禁令

只有 B-G0..B-G3、全部本地命令、真实 Provider paired evidence、ADR-0097 accepted、Slice A Gate replay 与
文档同步全部通过，才能建立 Slice B 完成记录并称 reviewed RFC 的“开发可用”定义已满足。对外仍必须写明
exact qualified route、default-off 和 experimental 边界；没有另一个产品 ADR 与 rollout 计划时，禁止称
default-on 或 production-supported。任何 mock-only、单 route 单样本、过期 evidence、CI 不达标、迁移缺口、
privacy 泄露或 docs gate 失败都使计划保持 `active`，不得宣称完成。
