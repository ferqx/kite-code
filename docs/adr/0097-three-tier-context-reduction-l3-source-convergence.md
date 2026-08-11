# ADR-0097：三级上下文缩减 L3 Source Convergence、Cache-safe Fork 与 Durable Refill Guard

状态：superseded
日期：2026-08-10
决策者：`github:@ferqx`（Capability + Evaluation + Release，single-maintainer）
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0069、ADR-0090、ADR-0091、ADR-0095、ADR-0096
关联：`docs/design/2026-08-10-three-tier-context-reduction-complete-rfc.md`、
`docs/space/plans/2026-08-10-three-tier-context-reduction-slice-b.md`
由 ADR-0098 取代：停止把 cache-safe fork、checkpoint v2 三段证明、Provider cache 资格和 durable refill
guard 作为完整三级的必要架构；本文保留为历史设计与在途实现审计依据。
后续 ADR-0100 进一步把当前主链固定为 MicroCompact、Checkpoint Working Set 与 SummaryCompact。
局部取代：ADR-0022 §3 和 ADR-0057 决策 1 中“独立最小无工具 summary request”的请求形态，仅限
通过缓存资格的 route；以及 ADR-0022 §2 中 pending-without-terminal 重新 lease/执行规则，
仅限 v21/v22→v23 migration cutover。不取代单次 Provider request、唯一 Markdown narrative、零工具执行、
零 SDK retry、不可变 transcript 与 Runtime authority 边界。

## 背景

ADR-0095 只接受了 L1 policy identity、可信 Tool Result provenance、L2 pure planner/applier 和默认关闭的
`off|shadow` Foundation。ADR-0096 进一步负责全工具 L1 budget、L2 live、统一 prepared artifact、稳定
watermark/cache epoch 和最终 payload admission，并把 Runtime schema 从 v21 升级到 v22。它们都没有
授权 L3 summary source 消费 L2；checkpoint 仍为 v1，现有 summary request 形态也未改变。

若 L3 继续直接从 transcript 数组构造另一套 source，会出现四类不可接受的漂移：normal 与 summary 使用不同
projection policy；checkpoint 只能证明 raw transcript 而不能证明模型实际总结的 projection；每次改写旧前缀会
破坏 Provider prompt cache；restart、fork 或 rewind 可以绕过只存在内存中的快速回填防抖。单靠两份持久 digest
互相比较也不能证明它们来自真实的不可变 transcript。

同时，ADR-0022 的独立最小无工具 summary request 会主动改变 system、tool schema 和 prompt-affecting 参数。
对支持前缀缓存的 Provider，这种形态无法复用最近一次成功 primary request 的 cacheable prefix，可能让每次
压缩同时支付完整历史读取、summary 和首个续写请求的成本。为缓存而恢复工具 schema 又不能授权 compactor
执行工具。

因此，L3 必须在不改变单 narrative、零工具副作用、零 retry 和 Provider-neutral Core 边界的前提下，统一
summary source、持久 source 证明、缓存父身份、schema migration 与 durable refill guard。该能力仍然是
默认关闭的未来行为；本 ADR 的 accepted 状态固定未来实现边界，不描述当前实现，也不授权
`production-supported` 或 default-on。

## 决策

### 1. 启用边界和默认值

完整三级自动路径只在下式全部成立时可进入 L3：

```text
toolResultBudgetV2
&& contextReclaimV1
&& reclaimMode=live
&& contextCompactionV2
&& contextCompactionAutoV1
&& autoMode=live
&& trustedRouteQualification=experimental
```

`trustedRouteQualification` 只能由受信 evidence registry 根据完整 route identity 派生，不是用户可写配置。
完整三级 manual 开发路径不要求 auto flag、auto mode 或 rollout bucket，但仍要求
`toolResultBudgetV2 && contextReclaimV1 && reclaimMode=live && contextCompactionV2 &&`
`contextCompactionManualV1`。manual 若要声称 experimental route-qualified，仍须通过同一受信证据。

新路径默认保持：

- `toolResultBudgetV2=false`；
- `contextReclaimV1=false`；
- `reclaimMode=off`；
- `contextCompactionAutoV1=false`；
- `autoMode=off`。

现有 `contextCompactionV2=true` 与 `contextCompactionManualV1=true` 不回退。schema 只新增接受显式
`compaction.reclaimMode=live`，不能因迁移或 route capability 自动打开。开发可用、experimental
route-qualified 与 production-supported 是三个不同状态；后者和 default-on 必须另立产品准入 ADR。

### 2. Canonical summary source 与双重 identity

本文的 raw transcript/raw projection 是 **L1 已完成预算后的不可变 canonical transcript** 及其尚未应用
L2/L3 的投影，不是 executor 持有的 pre-L1 原始字节。pre-L1 正文不得通过 raw fallback 进入模型。

`buildCompactionSourceProjectionV2()` 必须通过 Core-owned 统一准备器：

1. 定位现有 complete safe settled boundary；
2. 构建 canonical `ContextFrame[]`；
3. 使用 normal 请求相同的 L1/L2 policy、checkpoint boundary、cache epoch、estimator 和 projection
   environment；
4. 为 summary purpose 产生并应用固定 reclaim plan，再验证 tool pairing；
5. 把 final source projection 仅作为不可信 summary data；
6. 对 summary 的最终实际 payload 执行 Provider data 与 resource admission。

normal-before、summary-source 与 candidate-after 的 frame set 不同，必须各自持有 purpose-specific plan 和
`ReclaimApplicationEvidenceV2`，不得复用同一 plan。Provider 前在同一 source identity 下固定
`before + summarySource + sourceManifest`；summary 成功后，才在同一 effect lease 下使用 candidate
summary 构造 after-candidate 并验证，不能在 Provider 前伪造 after digest，也不能在 Provider 后重新解析
另一套 policy/environment。

`ProjectionSourceIdentityV2` 至少绑定 source revision、turn、checkpoint、transcript prefix、完整
projection environment、`cacheAffectingEnvironmentDigest`、projection contract、Tool Result budget policy、
reclaim policy 和 estimator。窄的 cache-affecting digest 覆盖会改变可缓存前缀的 system/project/user
instructions、active Skill projection、prompt contract 与 sandbox/runtime system frames；它不因普通 runtime
revision 或时间变化而变化。

`RequestAdmissionIdentityV2` 另行绑定 purpose、最终 Provider payload、实际 ToolSet/schema、全部
prompt-affecting 参数和 purpose-specific max output。normal output limit 与 `maxSummaryTokens` 不得伪造成
同一 request identity。source identity 只允许当前 compaction lease 自己的 reservation 与
`dispatch_started` 推进 revision；任何 transcript、turn、checkpoint、ToolSet、environment、output limit
或 identity 漂移都走 `stale_context`，不写 checkpoint。

`applied_plan` 只证明某个 purpose 使用了固定 plan；它不是 durable L2 watermark。summary、candidate 或
diagnostic 成功都不能晋升 commit，只有使用该 effective projection 的 primary `model.responded` 原子终态
才能推进 proposed commit。

summary source 不递归触发 L3。isolated manual/development 形态中，L2 plan 失败只有在 raw source 仍满足
输入上限和最终 Provider data admission 时才能回退；否则返回 typed failure。

### 3. `cache_safe_fork:v1` 与局部取代边界

通过缓存资格的 route 必须采用 `cache_safe_fork:v1`。父身份必须来自最近一次已成功持久的 primary
Provider dispatch 及其真实 cache receipt，不能使用尚未 dispatch 的 hypothetical normal-before：

```ts
interface PromptCacheParentIdentityV1 {
  version: 1;
  successfulPrimaryRequestId: string;
  providerRouteIdentity: string;
  modelIdentity: string;
  cacheEpochId: string;
  systemDigest: string;
  toolSetSchemaDigest: string;
  messagePrefixDigest: string;
  coveredThroughMessageId: string;
  coveredThroughFrameId: string;
  parentPrefixProjectionDigest: string;
  promptAffectingParametersDigest: string;
  eligiblePrefixTokens: number;
  providerCacheReceiptDigest: string;
}
```

summary 重放父请求相同的 cache-eligible system/context/tool schema/history prefix，只在 L2 后 safe settled
source 末尾追加固定 compaction instruction。`tool_choice`、thinking、effort、context management、output
format、beta headers、citations、web-search/image state 及 adapter 声明的所有 cache-key-affecting 参数必须
逐项相同并进入 digest；不得为了禁用工具把父请求的 `auto` 改为 `none`。

零工具副作用由 compactor 不持有 executor 且 tool-call candidate 无条件 invalid 保证。Provider 若能提供
不改变 cache key 的 execution-disable，adapter receipt 可以声明；否则保持父 `tool_choice`，模型返回
tool call 也只会使 candidate 失败，绝不执行。

父 `messagePrefixDigest`/`parentPrefixProjectionDigest` 精确覆盖最近成功请求的 eligible prefix，边界不随
当前 plan 移动。冻结范围只允许重放父请求实际使用的 committed L2 字节；会改写冻结前缀的当轮 proposed
watermark 扩展必须延期，不能进入 summary source 或提交。冻结边界后的 tail 可按同一 L2 policy 使用
`applied_plan {baseCommitDigest,...}`，但该证明不晋升 watermark。

父 identity 无法重验时返回 `cache_parent_incompatible`；冻结 representation 后 source 仍超限时返回
`summary_input_too_large`。auto 本轮终止，不切换 `isolated_minimal_no_tools:v1`，也不重试 normal request。
manual/development 可在请求开始前显式选择 isolated 形态，但该形态不能获得 cache-capable 完整三级资格。
Provider-specific `cache_edits` 不属于本决定。

本节在本 ADR accepted 后仅对 cache-qualified route 局部取代 ADR-0022 §3 与 ADR-0057 决策 1 的“独立
最小无工具请求”形态。以下既有决定继续有效：一次 Provider request、唯一 Markdown narrative、无 Runtime
工具副作用、零 SDK retry、原 transcript 不变、唯一 `summary:string` checkpoint 内容产物，以及不增加第二份
事实正文。

### 4. Checkpoint v2 与 bounded SourceManifest

Runtime schema v23 引入显式 `ContextCompactionCheckpointV1 | ContextCompactionCheckpointV2` union。v2
保持唯一模型正文 `summary:string`，并持久化：raw source、summary-source projection、normalized summary、
candidate-after frames/projection、covered message/turn、base checkpoint、L1/L2/estimator/environment/
projection contract、summary route 和 reclaim application identity。

`sourceDigest` 是 v1 消费者兼容字段，必须逐字节等于 `rawSourceDigest`。`sourceIdentity` 只能是
`verified_v2 | legacy_raw_source`。`reclaimApplication` 使用封闭判别联合：`off`、`applied_commit`、
`applied_plan`、`valid_noop_plan` 或 typed `raw_fallback`；不得为默认关闭、manual-first 或 plan 失败伪造
commit/plan digest。

`ContextCompactionSourceManifestV1` 是 bounded、JSON-safe、无正文的 source 证明。它固定包含 source 起点、
covered message/turn、raw transcript/raw frames/summary projection/applied frames digest、policy/estimator/
environment/projection contract、reclaim application 及判别式 base checkpoint identity。canonical stable JSON
UTF-8 上限为 8 KiB；不得增加数组、map、自由文本、权限、文件正文、Runtime authority 或 summary。

manifest 只证明 summary 覆盖哪份 raw source以及使用何种确定性 projection，不是模型上下文或授权。
task、turn、authorization、tool descriptors、计划 artifact、项目规则和 workspace 状态始终从最新 Runtime
与 projection environment 重新解析并确定性重注入。

### 5. 激活、恢复与规范化执行三段真实证明

candidate activation、restore 和 history normalization 都必须从真实 source 重新证明，不能只比较
checkpoint 与 manifest 两份持久副本：

1. **checkpoint ↔ manifest**：逐项校验 raw/source projection/reclaim/policy/estimator/environment/
   projection contract/base identity；顶层与 manifest 的 covered message/turn 必须相等；
2. **manifest ↔ 实际 canonical safe source**：从不可变 transcript 重新定位 inclusive message/turn 范围，
   重验 complete settled boundary，从真实 canonical message bytes 重算 raw digest；incremental checkpoint
   也必须全量回查原 transcript，再从真实 base checkpoint + tail 应用已存版本化 contract/policy/environment，
   重算 raw/applied frames 与 summary-source projection；
3. **summary ↔ candidate-after**：规范化唯一 summary，在第一段统一的 covered boundary 和同一 identity 下
   重建 candidate-after，校验 pending/candidate safe boundary、frames/projection digest 与 pairing。

无法解析旧 contract/policy implementation、无法回查真实 source、base identity 不一致或任一 digest/
boundary 不匹配时，fail closed 为 unqualified legacy/invalid checkpoint，不猜测。损坏派生 checkpoint 应隔离并
回到可验证 raw projection；只有 canonical transcript/pairing correctness 本身损坏才进入既有 hard block。

### 6. Schema v23 迁移与 legacy 传播

Slice A 先把当前写入 schema v21 升到 v22，并以 ADR-0096 的 snapshot+observed-head CAS 将受支持的
v2..v21 历史规范化到 v22；本决定再由 v22 升到 v23。端到端迁移遵守：

- v2..v21→v23 必须先运行 v22 normalizer；v22 commit 只有校验后保留；迁移写入继续复用 ADR-0096
  的 source snapshot + exact observed event head CAS，任何并发 tail 前进都 stale 并 reload/replay；
- v1 checkpoint 始终保持 version 1，可 restore/reset，但不原地伪造 v2 或获得 verified-v2 qualification；
- v21/v22 pending compaction 按 durable attempt 事实迁移：无 `dispatch_started` 作为 stale pending 取消；
  有 started 无 terminal 进入 `unknown_external_outcome`；有 terminal 只 replay terminal reducer；三者均不重放
  summary Provider dispatch；
- snapshot position 是 `model.responded` 计数的唯一 cut，event tail 只由 reducer 递增，不能双计；
- cutover 前历史 transcript-producing terminal/result 可规范化为 `legacy_unverified`，不伪造 V2 receipt、
  raw digest、L2 或 route 资格；cutover 后 event API 不能构造 legacy branch；
- invalid v2/manifest 隔离并回到 raw；无法证明的新版 event fail closed，不跳过；
- migration 不调用 Provider，不重算或伪造 legacy digest。

上述 pending 矩阵仅在 v21/v22→v23 migration cutover 局部取代 ADR-0022 §2 的
pending-without-terminal 重新 lease/执行规则。非迁移的 v1 Runtime 行为继续由 ADR-0022 管理，不从本文
推导为已改变的当前行为。

以 v1 或 `legacy_raw_source` checkpoint 为 base 的 incremental v2 必须继续标记
`legacy_raw_source`。覆盖范围内任一 Tool Result 是 `legacy_unverified`，或 verified receipt 的
`projectionMode==='compat_v1'` 时，即使不使用 legacy base 也不能资格洗白。只有不使用 legacy base、
从 raw transcript 全量重建、范围内所有 Tool Result 都可追溯到
`kind:'verified_v2' && receipt.projectionMode==='budget_v2'`，且三段证明全部通过，才能产生
`sourceIdentity='verified_v2'`。含 `compat_v1` 的 source 保持 `legacy_raw_source`，直到从全
`budget_v2` raw transcript range 重建。

v21/v22 的 `disabledUntilManualAction=true` 必须保守迁移为 v23 `breaker=open`，不伪造 anchor 或 count；
restart、fork 和 rewind 不能将其关闭。

### 7. Final-pressure 触发与 durable refill guard

L3 只看 L2 后的 final pressure。只有 final pressure 仍达到 compact、summary input/output reservation 与
Provider safety margin 可证明可容纳、auto 完整 flags、route qualification、safe boundary、cooldown 和 breaker
全部允许时，才能提出一次 proactive L3。同一 turn 最多提交一个；成功 L3 必须满足至少 1024 token 绝对
收益和预注册最小比例收益。若 auto 不合格，普通请求继续经过 final admission，让 Provider 决定真实容量。

schema v23 持久 reducer-owned `AutoCompactionGuardV2`，至少包含 guard generation、policy epoch、成功
primary response ordinal、anchor checkpoint/ordinal、observed anchor、连续快速回填数、ordinal-based
cooldown、breaker 和 opened-by identity。window、limit、cooldown 与状态机版本都进入 policy epoch 与
qualification identity。

`modelResponseOrdinal` 只在 primary `model.responded` 成功持久时递增。checkpoint 成功激活时以当前 ordinal
建立 anchor，并清空 observed anchor。若 final pressure 在该 anchor 后配置的 N 个 completed primary
responses 内再次达到 compact，必须使用两步协议：

1. pure prepare 只返回 `refill_observation_required`，不得基于旧 guard 同时返回 auto request；
2. Kernel/Store 以 lease/CAS 持久 `context.compaction_refill_observed`，校验 previous guard digest、anchor、
   ordinal、effective projection/pressure、policy epoch 后重新 prepare。

第二次 prepare 才能返回 auto eligibility 或 primary ready。当前 anchor 已 observed 时，auto request 必须携带
对应 observation identity；在任何 L3 lease/resource admission 前逐项重验持久 observation、guard digest/
generation、policy epoch 与 anchor。如果 observation 达到 limit 并打开 breaker，本次及后续 auto L3 均为零
dispatch。同一 anchor 最多累计一次，即使后续 summary 失败也不能重复计数；超过 N 后的新 observation 可重建
rapid-refill chain，但 cooldown 独立生效。

restart/resume 恢复完整 guard。rewind/fork 不能把 guard 当作普通可回卷 snapshot 字段；RuntimeStore 必须在
同一 transaction 中把操作前 session guard floor 与恢复点 guard 做 `joinAutoCompactionGuardV2()`，追加
`context.compaction_guard_carried_forward` 后才能暴露新 snapshot：

- generation 较大者胜，只有显式合法 reset 能增加 generation；
- 同 generation 内 open 胜于 closed，ordinal/count/cooldown 取最大值；
- 恢复点不存在 anchor 时清除悬空 anchor/observed anchor，但不降低 count 或 breaker；
- policy epoch 变化按新 policy 重建可用字段，同时保留单调 safety floor 与 carry digest；
- fork 即使来自更早 boundary，也与源 session 当前 floor join，不因新 session ID 清零。

checkpoint reset、flag/mode 切换、取消或失败的 manual compaction 不得降低 count 或关闭 breaker。只有成功的
显式 manual `/compact`、`/clear` 创建全新会话，或专用管理员/用户 reset action，才能原子增加 generation
并持久 `context.compaction_guard_reset`。

### 8. Qualification 与发布证据

完整三级“开发可用”不自动等于 experimental route-qualified。每个 Provider/model route 必须继续通过
ADR-0057 的结构 conformance、版本化 semantic facts/forbidden claims 和 control-treatment continuation
non-inferiority，并增加：

- cache parent/eligible-prefix 字节一致性，mismatch 容忍度为 0；
- 真实输入上限、summary source 和首个 normal continuation；
- refill breaker、restart/resume/fork/rewind/reset；
- 重复 read/search、关键事实保留和冷 resume；
- Provider cache capability、request shape 与 prompt/cache-key registry conformance。

route、model、adapter、token estimator、prompt、ToolSet/schema、L1/L2 policy、projection contract、
cache-affecting environment、checkpoint schema 或 guard policy 任一变化都会使旧 evidence 失效。route 资格只能
来自 registry 中匹配完整 identity 的证据；不得以用户配置或模型名称推断。

缓存实验必须对 treatment/control 使用相同 transcript、eligible prefix、route/model、cache breakpoint/TTL、
prompt-affecting 参数和请求顺序；每个 route/model 的 warm 与 cold cohort 各至少 30 个对配样本。warm 必须有
未过期真实父 cache receipt；cold 必须有 TTL 过期证据或独立 cache namespace。预注册 bootstrap seed、顺序
和 cache proof 均进入 evidence identity。

冻结以下资格门槛，route 不得自行放宽：

- `eligible-prefix reuse ratio = min(cacheReadTokens, eligiblePrefixTokens) / eligiblePrefixTokens`，paired
  95% bootstrap CI 的 warm 下界不少于 0.95；
- summary + 首个 normal 的 billed-input tokens 与 cache-create tokens 分别计算 treatment/control ratio，
  paired 95% CI 上界 warm 不超过 1.05、cold 不超过 1.10；
- summary + 首个 normal 端到端 p95 latency ratio CI 上界不超过 1.10；
- 重复 read/search 次数 ratio 的 95% CI 上界不超过 1.10；
- critical fact loss、invalid checkpoint、tool pair/replay/state 损坏和 cache prefix mismatch 容忍度为 0。

必须包含“warning 首次提出 L2 watermark 扩展且本轮仍需 L3”的真实用例，证明父 committed prefix 冻结、
proposed 扩展延期、冻结后 tail 的 `applied_plan` 及 typed failure 收敛。冷 resume 必须覆盖 cache 过期后的
summary 成本、history→summary handoff、首个 normal continuation，以及没有 model-visible recovery hint 时的
自然重读行为。planner/apply 性能、峰值内存和持久 metadata bytes 必须满足 ADR-0096/0097 本文冻结、
实施计划在首个结果前复述的本地上限；上限或证据未冻结时不能通过 qualification。

本 ADR 冻结 Slice B 的本地资源上限：在 Slice A 同一 2,000-block/8 MiB mixed
fixture 上加入 v1 base + 10 段 incremental tail、最大合法 manifest、rapid-refill
guard/event-tail 和 cache-parent-frozen watermark-extension case。canonical summary-source
plan+apply+proof preparation p95 不超过 75 ms；checkpoint activation/三段真实 source 重验
p95 不超过 100 ms；相对 Slice A normal prepare 的额外 peak heap 不超过 96 MiB；
manifest 不超过 8 KiB；checkpoint v2 identity metadata（不含唯一 `summary:string`）不超过
32 KiB；单个 guard observation/carry/reset event 不超过 8 KiB；guard join/reducer transition
p95 不超过 10 ms 且 Provider dispatch count 为 0。Bun、OS/CPU、warm-up、采样、GC、
policy/route/request-shape identity 必须进入 evidence；不得事后更换 fixture、排除失败
样本或放宽上限。

通过上述门禁只能标记 `experimental route-qualified`，不得宣称 Claude Code parity、无限会话、所有 Provider
等价或 production-supported。

### 9. Provider overflow 继续延期

本决定不实施 Provider overflow 后自动 L2/L3 或 normal retry，继续保留 ADR-0022/0024 的延期结论。adapter
可以对稳定信号做 typed classification，但 Runtime 只把它作为普通 Provider terminal，不合成 compaction
reason、不释放已 started reservation、不重放 request。

Anthropic 通用 `400 invalid_request_error`、`413 request_too_large`、自由错误文本，以及已经产生输出的
`model_context_window_exceeded` 都是负例，不能伪造零 usage 或未执行证明。未来 reactive recovery 必须另立
ADR，定义 adapter receipt、原 attempt 计费、独立 summary/retry reservation、durable state machine 与
crash/restart；不能从本文推断授权。

### 10. 隐私、失败与明确排除

所有 admission 检查最终实际 payload；L2/L3 减少正文不能降低原数据分类、route policy 或 consent。
checkpoint/manifest/guard 只保存 bounded identity。telemetry 只允许聚合的 policy/schema/mode、tokens、
saving、pressure、typed refusal、cache token、refill count、性能和 metadata byte 数；不得记录 path、args、
call/message ID、digest 值、stub、tool content、summary、transcript 或 manifest。

失败使用 typed、有限且可收敛的结果：source identity 无效为 `invalid_candidate`；source 超限为
`summary_input_too_large`；cache parent 无法重放为 `cache_parent_incompatible`；summary/validator 失败保留
旧 checkpoint/transcript；environment/lease drift 走 `stale_context`；breaker open 禁止 auto L3。auto 不因
这些失败暗中切 isolated fallback 或重试 normal Provider request。

本决定明确不包括：

- 按消息数量 head/tail 删除自然语言历史；
- Core 直接使用 Provider `cache_edits`；
- 明文 tool artifact store、跨 session 检索或第二份模型生成 memory/fact ledger；
- model-visible recovery hint、mustKeep frame、自动重读或工作集正文恢复；
- 渐进 summary、chunk/merge 或部分 checkpoint commit；
- 未经独立证据将 L2 正文替换扩大到 effectful tool、动态 MCP、Shell 或 Web；
- 从 Provider overflow/错误自动压缩或 retry；
- 合入即默认开启或自动宣称 production-supported。

## 备选方案

### 继续从 raw transcript 单独构造 L3 source

实现简单，但 normal 与 summary projection policy 漂移，checkpoint 无法证明模型实际总结的 source，也会让
L1/L2 identity、cache epoch 与恢复资格脱节。不采用。

### 所有 route 都使用 isolated minimal no-tools request

保持 ADR-0022 的 V1 形态，但会主动破坏 cacheable prefix。它保留为 manual/development fallback，不能取得
cache-capable 完整三级资格。

### 为缓存直接开放工具执行或 Provider cache edits

开放 executor 会让 summary 产生 Runtime 副作用；`cache_edits` 又是 Provider-specific mutation，不能作为
Provider-neutral Core 契约。两者均不采用。

### 只在内存中记录 cooldown/refill count

实现成本较低，但 restart、fork、rewind 和 crash 可以绕过付费循环保护。不采用。

### 遇到 Provider overflow 自动压缩并重试

无法从通用错误证明 request 未执行、usage 为零或可安全重放，会破坏 resource accounting 与 crash recovery。
继续延期。

## 后果

### 正面后果

- normal、summary 和 candidate 使用同一 policy family，checkpoint 能证明实际 source projection；
- 三段真实验证消除“两个持久 digest 互相证明”的循环；
- cache-qualified route 可复用真实父前缀，且不会为缓存授权工具执行；
- v23 migration、legacy propagation 和 guard join 使 restart/fork/rewind 结果可证明；
- 两步 observation 在打开 breaker 的同一轮阻止 L3 dispatch，避免快速回填导致无限自动压缩。

### 负面后果

- checkpoint、manifest、migration、cache evidence 和 guard state machine 显著扩大实现与测试矩阵；
- cache-safe route 必须维护 Provider-specific cache-key registry 和真实 receipt 证据；
- 父前缀不兼容或 summary source 超限时，auto 会保守终止而不是尝试更多 fallback；
- 不提供 recovery hint、自动重读或工作集恢复，冷 resume 可能产生可测量的重复读取；
- legacy session 可以长期保持 unqualified，只有完整 raw rebuild 才能清除标记。

## 验收

1. canonical summary source 与 normal 使用相同 L1/L2/checkpoint/cache epoch identity；三种 purpose 的 plan、
   source/request digest 各自固定，pure diagnostic/candidate 不产生 lease、reservation 或 Provider dispatch。
2. checkpoint v2/source manifest 的 message/turn boundary、base、真实 raw source、reclaim application、summary 和
   candidate-after 三段验证全部通过才可激活；任一错配零激活。
3. v2..v21→v22→v23、v22→v23、v1/v2、pending/event-tail、invalid manifest、mixed legacy history 的
   migration 与重复 replay 全绿；代表版本至少覆盖 v2/v11/v12/v13/v16/v17/v18/v20/v21，迁移期间
   Provider dispatch 为 0，snapshot 未变但 event head 并发前进的 writer 必须 stale。
4. `legacy_raw_source`、`legacy_unverified` 与 `compat_v1` receipt 不得资格洗白；legacy open breaker
   在 restart/fork/rewind 后仍 open。
5. `cache_safe_fork:v1` 父身份来自真实成功 primary receipt；eligible-prefix mismatch 为 0；当轮 proposed L2
   扩展不得改写冻结父前缀，typed cache/source-too-large failure 稳定收敛且 auto 不 fallback/retry。
6. `refill_observation_required → CAS event → re-prepare` 去重；observation 打开 breaker 时本轮 L3 dispatch 为
   0；restart/resume/fork/rewind/reset 不能降低 safety floor。
7. L2 后低于 compact 不调用 summary；仍超 compact 时只有完整 flags、route、safe boundary、cooldown 和
   breaker 允许才调用一次 L3；checkpoint 成功后只重建一次 final payload 并重新执行最终 admission。
8. warm/cold 对配实验、cache reuse/cost/latency、重复读取、continuation non-inferiority 和 cold resume 达到
   §8 冻结指标；真实 route/model/adapter/prompt/tool schema/policy identity 完整进入 evidence。
9. Provider/summary/lease/validator/overflow 失败不产生重复 dispatch、无限循环、错误 hard block 或自动 retry；
   原 transcript、Runtime authority、Provider data classification 与唯一 narrative 保持不变。
10. 新 L1 V2、L2 live、auto L3 默认 off；现有 `contextCompactionV2`/manual 默认 true 不回退；未通过真实
    qualification 时只能标记 experimental，不能标记 production-supported。

## 回滚

关闭 `contextCompactionAutoV1` 或设置 `autoMode=off` 立即停止新的 proactive L3；移除 route 的 trusted
qualification 只关闭对应 route 的完整三级 auto。关闭 `contextReclaimV1` 或设置 `reclaimMode=off` 停止
L2/live source convergence 并恢复该模式定义的 raw transcript projection，但不得借此改变现有 manual
compaction 默认值或删除原 transcript。

关闭 `contextCompactionManualV1` 只停止新建 manual checkpoint。已经持久的 v2 checkpoint、schema v23 event、
source manifest 和 guard 必须继续由兼容 reader/reducer 安全 replay；回滚不得降级 snapshot、删除 checkpoint、
伪造 v1、清空 breaker 或移除 rewind/fork safety floor。无资格或无兼容 reader 时隔离派生 checkpoint并回到
可验证 raw projection。

如果本 ADR 在 accepted/实施前被拒绝，ADR-0022/0057 的独立最小无工具请求形态继续完整有效，checkpoint
保持 v1，Runtime schema 不升 v23；ADR-0095 Foundation 和 ADR-0096 的独立范围不受影响。
