# 完整三级上下文缩减可用性 RFC

状态：superseded（由 `2026-08-10-progressive-session-memory-compaction-rfc.md` 取代）
最终后续：`2026-08-10-progressive-context-compaction-rfc.md`
日期：2026-08-10
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0069、ADR-0090、ADR-0091、ADR-0095
前置：`2026-08-09-three-tier-context-reduction-rfc.md`、已完成的 Context Reclaim Foundation

## 摘要

本 RFC 定义“完整三级上下文缩减可用”的最终交付契约。它不改写 ADR-0095 已接受的 Foundation 历史；
Foundation 只证明 L1 policy identity、可信 provenance、L2 pure planner/applier 和 `off|shadow` 零回归。
本 RFC 在其上补齐：

1. **L1 全工具结果预算**：所有进入模型历史的工具结果都必须有有限、版本化的模型输出预算；
2. **L2 live 确定性回收**：在资源预算和 Provider data admission 之前形成并应用固定 plan；
3. **L3 source convergence**：summary source 使用与普通请求相同的 L2 policy，并由 checkpoint v2 持久化
   raw/source projection identity；
4. **长会话可用性**：缓存稳定 watermark、cache-safe summary fork、最低收益、
   cooldown、可持久 refill breaker 和 source manifest 共同限制反复压缩与上下文快速回填。

“可用”在本 RFC 中表示：功能默认关闭。完整三级自动路径的显式启用公式是
`toolResultBudgetV2 && contextReclaimV1 && reclaimMode=live && contextCompactionV2 &&`
`contextCompactionAutoV1 && autoMode=live && trustedRouteQualification=experimental`。其中
`trustedRouteQualification` 只能由受信 evidence registry 根据 route identity 派生，不是用户可写配置。
完整三级 manual 开发路径改用 `contextCompactionManualV1=true`、不要求 auto flag/mode，但仍要求
`toolResultBudgetV2 && contextReclaimV1 && reclaimMode=live && contextCompactionV2`；若要声称
experimental route-qualified，仍必须通过同一受信 route 证据。只有通过结构、语义、continuation、缓存和真实
Provider route 资格的路由才可以标记为 experimental route-qualified。它不表示
合入后默认开启，
也不表示所有 Provider 自动获得资格。本文把这种状态固定称为 `experimental route-qualified`；
`production-supported` 只允许由后续产品准入 ADR 使用。

## 权威与历史边界

- 本文在进入 accepted ADR 与 active 实施计划前只是未来设计，不描述当前行为。
- ADR-0095 与 Foundation 计划永久保持 accepted/archived，不扩大其完成范围。
- 当前不可变 transcript、单 narrative checkpoint、`manual|auto` reason、RuntimeStore lease/CAS、
  Provider data policy 和 correctness hard-block 语义继续有效。
- 完整实现需要两个后续 ADR：L1/L2 live projection，以及 checkpoint v2/L3 source convergence。
- production-supported 或 default-on 是第三个独立产品准入决定，不由本 RFC 自动授权。

## 外部参考的采用边界

Claude Code 官方行为支持以下方向：旧工具输出应先于语义总结清理；原会话记录与活动模型上下文分离；
压缩后的稳定项目规则和运行时状态需要重新提供；快速回填时必须停止无限自动压缩。社区源码分析还报告
history snip、micro-compaction、context collapse、工作集恢复和 Provider cache edit 等机制。

Kite 只把可在 provider-neutral Core 内证明的原则写成契约：

- cheap and deterministic first，semantic and lossy last；
- tool call/result 作为完整协议 block 处理；
- 最终实际 payload 才能进入资源与 Provider data admission；
- 稳定前缀、批量提交和滞回优先于每轮重写旧历史；
- summary 与 source manifest 都不是 Runtime 权威；
- 通用 HTTP 400/413 文本不能推断 context overflow。

以下内容不是 Core 常量：Claude 的固定字符数、recent-N、固定缓存 buffer、固定恢复文件数、内部模块名、
XML 摘要格式、`.task_outputs` 路径和 `cache_edits`。它们可以形成测试样本或 Provider adapter 优化，不能
冒充跨 Provider 架构。

## 可用性定义

### 开发可用

同时满足下列条件才可以称为完整三级“开发可用”：

- 新路径的 `toolResultBudgetV2=false`、`contextReclaimV1=false`、`reclaimMode=off`、
  `contextCompactionAutoV1=false`、`autoMode=off` 继续是默认值；现有
  `contextCompactionV2=true` 与 `contextCompactionManualV1=true` 保持不变，schema 只新增接受显式
  `compaction.reclaimMode=live`；因此完整三级新路径仍默认关闭，但不关闭现有 manual compaction；
- 所有 production ToolSpec 声明有限 L1 模型结果预算，未声明的工具不能注册；
- normal、preflight、`/context`、candidate validation、restore/debug 和 L3 source 使用同一 projection
  policy identity；
- warning 后可以应用 L2，L2 后仍达到 compact threshold 且 auto 完整布尔门、safe boundary、
  cooldown 与 durable breaker 全部允许时才进入 L3；
- summary source 已先应用同一 L2 policy，checkpoint v2 能在 restart/resume/fork/reset 后重新证明 source；
- 工具配对、原 transcript、Provider data classification、Runtime authority 和失败收敛保持不变。

### Experimental route-qualified

开发可用不自动等于 experimental route-qualified。每个 Provider/model route 还必须通过 ADR-0057 的
结构、语义事实和
continuation non-inferiority，并补充缓存、重复读取、refill 和真实输入上限资格。route、model、adapter、
token estimator、prompt、tool schema、L1/L2 policy 或 checkpoint schema 任一变化都会使旧证据失效。

### 默认开启

本 RFC 不授权默认开启。默认开启需要独立产品准入 ADR，定义 release profile、route 支持集、迁移、用户
退出路径和回滚指标。

## 三级架构

本文的 `raw transcript/raw projection` 统一指 **L1 已完成预算后的不可变 canonical transcript 及其未应用
L2/L3 的投影**，不是工具执行器持有的 pre-L1 原始字节。pre-L1 正文只用于 digest、受治理 artifact 或工具
自身返回值，不得借 “raw fallback” 进入模型上下文。

```text
Tool result
  -> L1 bounded model result + raw/model provenance
  -> immutable transcript
  -> build raw canonical projection
  -> raw complete-request estimate
  -> L2 fixed plan + stable watermark (when eligible)
  -> apply + pairing validation + final estimate
  -> if below compact threshold: final resource/provider-data admission -> Provider
  -> if still above compact threshold and auto policy is live/eligible: request L3
  -> otherwise: final admission -> Provider decides real capacity
  -> L3 source projection uses the same L2 policy identity
  -> cache-safe one-narrative summary -> checkpoint v2 + source manifest
  -> rebuild final projection once -> admission -> Provider
```

L1 总是在工具完成边界执行。L2 和 L3 只能由 Core 的统一请求准备器编排，Controller、`/context`、
compactor、candidate validator 和 debug 不能各自重新选择候选。

## L1：全工具结果预算

### 封闭注册契约

`ToolResultBudgetPolicyV2` 扩展现有 V1 identity，并由独立 `toolResultBudgetV2=false` 控制新结果是否采用
V2。每个可进入主模型或 Sub-agent 模型历史的 ToolSpec 必须
声明一个 `modelResultBudget`：

```ts
type ToolModelResultBudgetV2 =
  | { kind: 'stream_head_tail'; maxCharsPerStream: number }
  | { kind: 'line_window'; maxUtf8Bytes: number; continuation: 'line_byte_cursor_v2' }
  | { kind: 'serialized'; maxUtf8Bytes: number }
  | { kind: 'structured'; maxUtf8Bytes: number; projectorId: ToolResultProjectorIdV2 };

type ToolResultProjectorIdV2 =
  | 'stream-head-tail:v1'
  | 'read-line-window:v1'
  | 'utf8-envelope:v1'
  | 'structured-receipt:v1';
```

`ToolResultProjectorIdV2` 由封闭 Registry 解析；projector implementation、validator 和 revision 都进入
budget policy identity。Registry conformance 必须拒绝缺少 budget、非有限正整数、未知 projector、没有
稳定 truncation marker 或没有 continuation 语义的 production spec。Tool-specific 边界可以比全局安全
上限更严格，但不能更宽。

finalizer 不直接假设所有工具都是 builtin `ToolSpec`，而是只消费封闭解析结果：

```ts
type ResolvedToolResultBudgetV2 =
  | { source: 'builtin_spec'; toolIdentity: string; bindingDigest: string; budget: ToolModelResultBudgetV2 }
  | { source: 'runtime_binding'; toolIdentity: string; bindingDigest: string; budget: ToolModelResultBudgetV2 };
```

builtin 由 ToolSpec Registry 解析；动态 MCP 由已经 turn-bound、revisioned catalog 的 runtime binding 解析。
两者都必须绑定 projector/revision/policy digest；缺少或未知 binding 的动态工具不得暴露给模型或
执行。

### V2 初始策略

- Shell/Search 保持现有每 stream 4000 字符 head/tail，输出字节不借 V2 静默变化；
- V2 off 时 MCP 保持当前按 JS 字符数执行的 128 KiB 兼容行为；V2 on 时把 128 KiB 解释为最终模型
  envelope 的 UTF-8 byte 上限，不能在截取正文后再因 JSON 包装超过名义上限；
- 其他没有更严格边界的模型结果采用 128 KiB UTF-8 byte 全局安全上限；
- `read_file` 使用 line-window 投影：保留从请求 cursor 开始能放入安全上限的完整行，并返回
  `nextCursor={lineOffset,utf8ByteOffsetInLine,endLineExclusive,pathDigest,resourceRevision}`/`totalLines`
  continuation metadata。单行本身超过上限时，按合法
  UTF-8 边界返回可重放的行内片段并向前推进 `utf8ByteOffsetInLine`；新 cursor 必须比输入 cursor
  大，不得返回无法前进的 oversize marker；
- structured projector 必须保证截断后仍是合法结构，不能在序列化字符串中间切断 JSON；
- `rawResultDigest` 在任何模型截断前计算，`modelContentDigest` 精确描述实际模型正文。

读取输入 schema 同时升级为判别联合：首次读取使用 `{path,offset?,limit?,cursor?:never}`；继续读取
使用
`{path,cursor:{lineOffset,utf8ByteOffsetInLine,endLineExclusive,pathDigest,resourceRevision},offset?:never,limit?:never}`。
cursor 与 offset/limit 互斥，path digest 和 content/resource revision 必须逐项匹配；文件变化返回有界
`stale_continuation`，不得把不同版本的行内片段拼接。行号全部为 1-based，
`initialOffset = offset ?? 1`，schema 先拒绝非正整数 offset/limit；`initialOffset > totalLines`
返回无 cursor 的有界 `completed_empty`。`pathDigest` 覆盖
`read-file-path:v2\0 + resolvePath()` 规范绝对路径，`resourceRevision` 覆盖
`digest('read-file-resource:v2\0' + decoderContractId + '\0' + UTF8(normalizeEOL(decodeTextBuffer(raw))))`。
decoder contract 先处理 UTF-8、UTF-16LE/BE 和 BOM，其 ID 进入 cursor/projector/policy identity；decoded
normalized content 相同时 BOM/编码/EOL-only 变化不使 revision 漂移，内容或 decoder contract 变化则漂移。
`utf8ByteOffsetInLine` 指向加模型行号前
的规范原始行 UTF-8 bytes；行号和 marker 仍计入最终 envelope budget。
`effectiveInitialLimit = initialLimit ?? (totalLines - initialOffset + 1)`，
`endLineExclusive = min(totalLines + 1, initialOffset + effectiveInitialLimit)`，且在所有 continuation 中
保持不变；完成超大的最后允许行后必须停止，不读取窗口外下一行。

所有 Registry builtin、动态 MCP、Runtime action、interaction、Task/Skill/Plan/Verification result 都必须经过
统一 `finalizeProjectedToolResultV2()`。生产路径的 tool executor 只返回 `RawToolExecutionResultV2`；唯一
`finalizeToolTerminalEventV2()` 在任何模型可见 Tool Result 持久化前调用 projector，并把
`VerifiedToolModelResultV2` 直接嵌入对应的 `tool.finished|tool.failed|tool.rejected|tool.cancelled`
终态事件。该单一 event 在同一 reducer transition 中同时更新执行状态并追加恰好一个
配对 Tool Result，不存在 terminal 与 model result 分批崩溃窗口。

schema v22 后 finalizer/self-contained terminal 无条件启用；`toolResultBudgetV2` 只选择
receipt 的 `projectionMode:'compat_v1'|'budget_v2'`。`compat_v1` 保持当前 V1 model bytes，但仍生成
verified receipt 且不获得 L2/route 资格；`budget_v2` 必须携带有限 budget identity。关闭 flag
不得恢复 reducer 正文 producer，`legacy_unverified` 仍只属于 cutover 前 migration。

`approval.rejected|provider.action_required` 等交互/控制事件自身不再生成 transcript 正文；若它们需要
收敛 tool call，Kernel 必须在同一 CAS event batch 中提交对应的已嵌入 verified result 的 tool
terminal。control reducer 只清理 interaction/记录 audit，不修改 terminal status、不追加 Tool Result；
紧随的 target terminal 独占 status/result。顺序固定为 control → target terminal → sibling terminals →
resource facts → 可选 `turn.aborted`；`ask_user` 拒答不 abort turn。sandbox elevation/policy rejection 等单独
producer 同样迁移到完整 constructor；非法顺序整批 fail closed。整批持久成功后才传播
AbortSignal。同一 `toolCallId+terminalIdentity` 重放幂等，相同 verified result 去重，冲突 result
整批 fail closed。

finalizer 输入是 `ResolvedToolResultBudgetV2`、tool-call identity、status、pre-L1
raw value/bytes 与 continuation provenance；输出是已编码 model envelope、`rawResultDigest`、
`modelContentDigest`、projector identity 和 continuation receipt。最后一步必须对完整 UTF-8 model envelope
重测，超上限整体拒绝；两个 digest 分别覆盖 projector 前 raw bytes 与最终实际模型字节。
未知工具、schema-invalid call 或无法解析 runtime binding 时，只能使用封闭 builtin
`core-tool-failure:v1` budget/projector identity 生成有界失败结果，不得将未受信 error/raw args 直接
进入模型。新 terminal event 入口只接受 `{kind:'verified_v2',receipt}`，以阻断 Registry、interaction、MCP 和 Sub-agent
recovery 绕过 choke point。`SupportedLegacySchemaVersionV22` 是当前可恢复整数版本 2..21 的
封闭 union。Store load/migration 另有一个不可由生产 event API 构造的
`{kind:'legacy_unverified',migratedFromSchemaVersion:SupportedLegacySchemaVersionV22,originalEventPosition}`
分支：它只允许对迁移 cutover
position 之前已持久的上述全部 transcript-producing terminal variants 的 snapshot/event tail 进行
规范化。normalizer 以现有 canonical transcript 中每个 toolCallId 的唯一 Tool Result 为准：
`provider.action_required` 只能在历史确实缺少先前结果时 backfill；重复且字节相同的结果去重；
同一 call 的冲突结果整个 session/checkpoint 隔离并 fail closed，不自行选择。legacy 分支不伪造
raw digest 或 V2 receipt，不获得 L2/route qualification。Kernel 对 cutover 后
新事件或越界 legacy branch 一律拒绝。
L1 projector 失败时产生有界、配对完整的失败 Tool Result，不能放行原始大正文，也不能自动重试已经发生
外部副作用的工具。

这保证 current turn 的单次大读取也有有限上界；L2 不能被用来补救一个已经无界进入 transcript 的结果。
L1 改变的是工具完成时进入不可变 transcript 的模型正文：关闭 V2 只影响后续工具结果，不能恢复已截断
正文。具体工具采用更小边界必须有单独 golden、continuation 和真实任务证据。

## 统一请求准备器

新增 Core-owned `prepareContextRequestV2()`，它是所有上下文入口的唯一编排器：

```ts
type ContextPreparationPurposeV2 =
  | 'normal'
  | 'context_inspection'
  | 'candidate_validation'
  | 'restore_debug'
  | 'summary_source';

interface ProjectionArtifactV2 {
  frames: readonly ContextFrame[];
  providerMessages: readonly BaseMessage[];
  estimate: CompleteRequestEstimate;
  framesDigest: string;
  projectionDigest: string;
}

type ReclaimApplicationEvidenceV2 =
  | { kind: 'off'; rawFramesDigest: string }
  | { kind: 'applied_commit'; planDigest: string; commitDigest: string; appliedFramesDigest: string }
  | {
      kind: 'applied_plan';
      planDigest: string;
      baseCommitDigest?: string;
      selectedCoverageDigest: string;
      appliedFramesDigest: string;
    }
  | { kind: 'valid_noop_plan'; planDigest: string; appliedFramesDigest: string }
  | {
      kind: 'raw_fallback';
      failure: 'ineligible' | 'plan_rejected' | 'apply_rejected' | 'cache_parent_frozen';
      rawFramesDigest: string;
    };

interface ProjectionSourceIdentityV2 {
  projectionSourceRevision: number;
  sourceTurnId: string;
  checkpointIdentity?: string;
  transcriptPrefixDigest: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  projectionContractId: string;
  toolResultBudgetPolicyId: string;
  reclaimPolicyId: string;
  estimatorId: string;
}

interface RequestAdmissionIdentityV2 {
  purpose: ContextPreparationPurposeV2;
  finalProviderPayloadDigest: string;
  toolSetSchemaDigest: string;
  promptAffectingParametersDigest: string;
  requestedMaxOutputTokens: number;
}

interface RefillObservationEvidenceV2 {
  anchorCheckpointId: string;
  anchorResponseOrdinal: number;
  observationIdentity: string;
  effectiveProjectionDigest: string;
  effectivePressure: 'compact' | 'hard';
  guardGeneration: number;
  previousGuardDigest: string;
  policyEpochId: string;
}

interface ContextCompactionRequestEvidenceV2 {
  sourceIdentity: ProjectionSourceIdentityV2;
  effectiveProjectionDigest: string;
  guardGeneration: number;
  guardDigest: string;
  policyEpochId: string;
  anchorCheckpointId?: string;
  observedAnchorCheckpointId?: string;
  refillObservationIdentity?: string;
}

interface PreparedContextRequestV2 {
  purpose: ContextPreparationPurposeV2;
  sourceIdentity: ProjectionSourceIdentityV2;
  requestIdentity: RequestAdmissionIdentityV2;
  raw: ProjectionArtifactV2;
  rawPreflight: ContextPreflight;
  reclaim: ReclaimApplicationEvidenceV2;
  effective: ProjectionArtifactV2;
  effectivePreflight: ContextPreflight;
  identity: ContextProjectionIdentityV2;
  next:
    | { kind: 'primary_ready' }
    | { kind: 'refill_observation_required'; evidence: RefillObservationEvidenceV2 }
    | { kind: 'auto_compaction_eligible'; request: ContextCompactionRequestEvidenceV2 }
    | { kind: 'summary_ready' }
    | { kind: 'summary_input_too_large' }
    | { kind: 'cache_parent_incompatible' }
    | { kind: 'candidate_ready' }
    | { kind: 'candidate_invalid' }
    | { kind: 'diagnostic_only' }
    | { kind: 'correctness_blocked'; reason: ContextPreparationBlockReasonV2 };
}

interface AdmittedContextRequestV2 {
  preparedDigest: string;
  sourceIdentity: ProjectionSourceIdentityV2;
  requestIdentity: RequestAdmissionIdentityV2;
  requestId: string;
  effectLeaseId: string;
  reservationIds: readonly string[];
  admissionReceiptDigest: string;
  finalProviderPayloadDigest: string;
  finalMaxOutputTokens: number;
  finalToolSetSchemaDigest: string;
}
```

上述 DTO 在离开 builder 时必须通过 canonical serializer 计算 digest 并 deep-freeze；调用者不得
持有可变 frames/messages/array 别名。

请求准备器只完成以下 pure 阶段，调用者不得拆分或重排：

1. 在 Runtime reservation 前解析一次稳定 `ContextProjectionEnvironment`、实际 ToolSet/schema 与
   purpose-specific `requestedMaxOutputTokens`，分别形成 `ProjectionSourceIdentityV2` 与
   `RequestAdmissionIdentityV2`；
2. 构建 raw canonical frames/messages/estimate 和 raw identity；
3. 基于 flag、mode、pressure、checkpoint boundary、watermark 和 policy 产生该 purpose 独立的固定 plan；
4. 应用 plan、再次验证 pairing、构建 final projection 和 final estimate；
5. 以 purpose、final estimate 和对应 rollout policy 产生 purpose-specific `next`并返回 deep-frozen artifact。

`prepareContextRequestV2()` 零持久写、零 lease、零 reservation；
`context_inspection|restore_debug|candidate_validation` 永远只停在这一 pure 阶段。只有
`primary_ready|summary_ready` 可以传入 Core-owned `admitAndDispatchPreparedContextRequestV2()`，其顺序固定为：
其他可持久 `next`（当前只有 `refill_observation_required`）必须由独立无 Provider/resource
reservation 的 Kernel transition 处理后重新 prepare，不得传入 dispatch 函数。

1. 在已持有 Kernel single-runner ownership 且 resource waiter 已获资格后，对 final payload 执行本地
   Provider-data precheck 和 resource precheck；waiting 事实不创建 Provider `dispatch_started`，唤醒后重做 pure
   prepare；
2. 在当前 revision 上建立 effect lease，通过该 lease 的 Kernel apply path 原子持久该请求的
   reservation 与 `resource_budget.dispatch_started`，并推进 lease expected revision；
3. 在 Provider 边界重验 prepared/source/request digest、final payload、ToolSet/schema、所有
   prompt-affecting parameters 和 max output；Provider-data gate 对这份精确 payload 给出最终 receipt
   后才生成 `AdmittedContextRequestV2`；
4. 重验后立即 dispatch，中间不再持久其他状态。最后一次本地 admission 拒绝可以使用现有
   `local_provider_admission_denied` proof 释放 started reservation；其他 started 后无 terminal 的崩溃只能
   进入 `resource_budget.unknown`。

purpose 约束是封闭的：

- `normal` 只能得到
  `primary_ready|refill_observation_required|auto_compaction_eligible|correctness_blocked`；
- `summary_source` 只能得到
  `summary_ready|summary_input_too_large|cache_parent_incompatible|correctness_blocked`，不能递归请求 L3；
- `candidate_validation` 只能得到 `candidate_ready|candidate_invalid|correctness_blocked`；
- `context_inspection|restore_debug` 只能得到 `diagnostic_only|correctness_blocked`，不得调度或 dispatch。

final compact threshold 只是 auto 尝试资格。只有 `contextCompactionV2=true`、
`contextCompactionAutoV1=true`、`autoMode=live`、route 已
experimental-qualified、safe boundary/cooldown/breaker 全部允许时，`normal` 才返回
`auto_compaction_eligible`。其余情况必须返回 `primary_ready`，让最终实际 Provider 决定容量；ratio、
window estimate 或本地预留失败不能产生 capacity hard block。这保留 ADR-0024 的边界。

若 final pressure 首次在当前 unobserved checkpoint anchor 的 refill window 内达 compact，pure prepare 必须先
返回 `refill_observation_required`，不能基于旧 guard 同时返回 auto request。Core orchestrator 以
Kernel lease/CAS 持久 observation，验证 previous guard digest 后重新运行 pure prepare。第二次 prepare
才能根据新 guard 返回 `auto_compaction_eligible` 或 `primary_ready`；如果该 observation 打开
breaker，本次 L3 不得 dispatch。当前 anchor 已 observed 时，
`ContextCompactionRequestEvidenceV2.refillObservationIdentity` 必填；在任何 L3 lease/resource admission 前，
Kernel 必须把它与持久 observation event、guard digest/generation、policy epoch 和 anchor 逐项重验。

`prepareRuntimeEffectForBudgetV1()` 当前先对 raw projection 做 admission；live 实施必须拆成上述 pure
prepare 和 effect-only admit/dispatch，并让 reservation、Model Controller 与 Provider invoke 消费同一个
immutable prepared artifact。`projectionSourceRevision` 不等于 dispatch 时的全局 revision：从 prepare 到
effect lease 之间不允许 projection dependency 变化；lease 建立后只允许通过该 lease apply path
提交的该请求 reservation/`dispatch_started` 事件推进 revision。任何会改变
transcript、turn、checkpoint、ToolSet、projection environment 或 output limit 的事件都使 artifact stale。
任何 identity 不一致都 fail closed，不能重新构建一个“看起来相同”的 payload。

## L2：live、watermark 与缓存稳定性

### 触发

L2 live 只在以下任一条件满足时应用：

- context window 已知且 raw pressure 至少为 warning；
- 配置了绝对 `reclaimAfterEstimatedTokens` 且 raw estimate 达到该值。

window unknown 且没有绝对阈值时不进行 pressure-driven live。planner 必须同时满足最小绝对 saving、最小
比例 saving 和完整 block 正收益；没有足够收益时发送 raw projection 或继续由最终 pressure 决定 L3。
每个 L2 eligible block 的全部 Tool Result 必须满足
`kind:'verified_v2' && receipt.projectionMode==='budget_v2'`；`compat_v1|budget_v2` mixed block 与纯 compat
block 都不得替换正文。

### 稳定提交

每轮重新折叠更早历史会反复破坏后续 prompt cache prefix。新增持久、metadata-only
`ContextReclaimCommitV1`：

```ts
interface ContextReclaimCommitV1 {
  version: 1;
  policyId: string;
  toolResultBudgetPolicyId: string;
  committedThroughMessageId: string;
  committedThroughTurnId: string;
  checkpointIdentity?: string;
  rawPrefixDigest: string;
  appliedPrefixDigest: string;
  selectedCoverageDigest: string;
  estimatorId: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  toolSetSchemaDigest: string;
  projectionContractId: string;
  cacheEpochId: string;
  committedAtTurnIndex: number;
}

interface ContextReclaimAppliedReceiptV1 {
  version: 1;
  previousCommitDigest: string | 'none';
  effectiveProjectionDigest: string;
  requestId: string;
  admittedRequestDigest: string;
  modelResponseMessageId: string;
  terminalBatchId: string;
  sourceIdentity: ProjectionSourceIdentityV2;
  requestIdentity: RequestAdmissionIdentityV2;
  proposedCommit: ContextReclaimCommitV1;
}

interface ContextPrimaryRequestEvidenceV1 {
  version: 1;
  requestId: string;
  purpose: 'normal';
  effectiveProjectionDigest: string;
  requestIdentityDigest: string;
  admittedRequestDigest: string;
  modelResponseMessageId: string;
  terminalBatchId: string;
  reclaimReceiptDigest: string | 'none';
}
```

- commit 只能在完整 settled turn boundary 向前移动，不能回退；
- 一次 commit 必须达到预注册 batch saving 和 hysteresis；
- 同一 policy 下，commit boundary 之前的 reclaimed prefix 字节稳定；
- policy、estimator、tool schema、projection contract 或 cache-affecting environment 变化使旧 commit 失效，
  并形成显式 cache epoch；
  `cacheEpochId` 由 checkpoint identity、L1/L2 policy、estimator、ToolSet/schema 与 projection contract 的
  canonical identity 以及 `cacheAffectingEnvironmentDigest` 确定性派生，不从进程时间或当前
  全局 revision 派生。该窄 digest 覆盖项目/用户/system instructions、active Skill 投影、prompt
  contract、sandbox/runtime system frames 等会改变可缓存前缀的 environment 字节，不包含单纯
  运行时 revision 或时间；
- current active turn、commit boundary 之后的 live tail 和所有 fail-closed block 保留原正文；
- commit 只保存 identity，不保存 tool content、path、args、digest 列表或 selected entries。

watermark 只在使用该 effective projection 的 primary Provider dispatch 成功后，通过持久
`ContextReclaimAppliedReceiptV1` 推进；崩溃丢失未提交 watermark 只允许降低下一轮 cache hit，不能改变
正确性。已有 watermark 在 live mode 下持续重放，即使当前 pressure 回落；只有扩展 watermark 需要重新
满足 warning、batch saving 和 hysteresis，避免 raw/stub 每轮抖动。
`applied_plan` 只是某个 purpose projection 使用的固定计划证据，不等于 durable watermark；
summary/candidate/diagnostic 成功均不能把它晋升为 commit。只有使用该 plan 的 primary
`model.responded` 终态原子 batch 才能提交 proposed commit。

Runtime ownership 固定为：Model Controller 只返回可选 proposed commit；Executor 在同一 effect lease 下完成
实际 Provider dispatch。primary 成功时使用封闭 terminal-batch union：无 proposed commit 是
`model.responded{reclaimReceiptDigest:'none'} + resource_budget.reconciled` 两 event；有 proposed commit 是
`model.responded{reclaimReceiptDigest:digest(receipt)} + context.reclaim_commit_advanced{receipt} +`
`resource_budget.reconciled` 三 event。无推进分支不构造 receipt/伪造 commit；推进分支中
`context.reclaim_commit_advanced` 的唯一 payload 是上述 receipt，commit 只能从该 event 晋升。
v22 primary `model.responded` 持久 bounded `ContextPrimaryRequestEvidenceV1`；每个分支共享
`terminalBatchId`、`causationId` 和连续 revision。Kernel/replay batch validator 在 reduce 前验证完整
2/3-event branch；推进 reducer 只消费紧邻、未消费且 request/purpose/projection/request identity/
admission/message/batch/receipt digest 逐项匹配的 primary evidence。standalone、reordered、mismatched、
candidate/summary response、none 后出现 reclaim event 或 non-none 后缺 reclaim event 都整批 fail closed，批内
pending evidence 不得进入 post-batch snapshot。Kernel 的
`applyEffectResult()` 是唯一可以校验内存 effect lease 和当前 revision 的层；Store 对整个
event+snapshot batch 执行 CAS。snapshot/replay/fork/rewind 只消费 reducer 状态，不能由 composition root 写 singleton。
Provider 已成功但 terminal batch 未提交的崩溃恢复会保留旧 commit；
这只牺牲 cache 命中，不得推断新 commit 已生效。Provider dispatch 前仍先持久化现有 resource
`dispatch_started`/reservation fact；恢复时存在 started 而无 terminal 的 attempt 必须进入
现有 durable `resource_budget.unknown`/Runtime recovery terminal（用户可见语义为
`unknown_external_outcome`），禁止为了补 commit 重放 Provider dispatch。

off 关闭所有 L2 应用并恢复 raw transcript projection；shadow 计算候选但不移动 commit；live 才能应用已提交
prefix 和满足批量门禁的新 commit。checkpoint 激活、替换、reset、rewind 或 policy epoch 变化必须按新
source boundary 清除或重基线 commit，不能让旧 prefix identity 跨越新的 narrative boundary。

### L2 失败

planner、plan identity 或 pairing validator 失败时：

- 不发送候选 projection；
- 记录严格脱敏的 invariant telemetry；
- 重新评估 raw final pressure：满足完整 auto rollout/guard 时可以返回 `auto_compaction_eligible`；否则
  返回 `primary_ready` 并对 raw payload 执行最终 admission。只有 pairing/projection corruption 可以进入
  `correctness_blocked`，容量估算本身不能阻止普通请求。

这里的 raw fallback 只适用于 eligibility、plan identity 或 apply mismatch。若 raw canonical frames 本身
不能通过 pairing/projection invariant，属于可证明的 Runtime correctness failure，必须零 dispatch 并进入
现有 hard-block factory，不能用 raw fallback 掩盖损坏。

## L3：source convergence 与 checkpoint v2

### Canonical summary source

L3 不再直接 `JSON.stringify(TranscriptMessage[])`。`buildCompactionSourceProjectionV2()` 必须：

1. 使用现有 safe settled boundary；
2. 构建 canonical `ContextFrame[]`；
3. 使用与 normal 请求相同的 L1/L2 policy、checkpoint boundary 和 cache epoch；
4. 应用固定 reclaim plan 并验证 pairing；
5. 把最终 source projection 作为不可信 summary data；
6. 让 Provider data admission 检查 summary 的最终实际 payload。

normal-before、summary-source 与 candidate-after 的 frame set 不同，不能复用同一份 `ReclaimPlanV1`。
正确不变量是三者由相同 policy、budget、estimator 和 projection environment 产生，并在一次
`PreparedCompactionProjectionBundleV1` 中固定各自的 raw/applied digest：

```ts
interface PreparedCompactionProjectionBundleV1 {
  before: PreparedContextRequestV2;
  summarySource: PreparedContextRequestV2;
  sourceManifest: ContextCompactionSourceManifestV1;
}

interface FinalizedCompactionProjectionBundleV1
  extends PreparedCompactionProjectionBundleV1 {
  afterCandidate: PreparedContextRequestV2;
}
```

时序固定为：Provider 前使用同一 `ProjectionSourceIdentityV2` 构造
`before+summarySource+sourceManifest`；summary
Provider 成功后，在同一 effect lease 下用 candidate summary 构造 `afterCandidate`，再形成 finalized bundle
并执行 candidate validation。三者各自持有独立 `ReclaimApplicationEvidenceV2`/plan digest，
不能在 Provider 前同时伪造，也不能在 Provider 后重新解析一套不同的
policy/environment。before、summary-source 与 after-candidate 必须分别持有 purpose-specific
`RequestAdmissionIdentityV2`；normal output limit 与 `maxSummaryTokens` 不得伪造成相同 request identity。
该 source identity 只允许该 compaction lease 下 reservation/`dispatch_started` 推进全局 revision；任何
projection source drift 走 `stale_context`，不写 checkpoint。

summary source 不递归触发另一次 L3。isolated manual/development request 中 L2 source plan 失败时，
只有 raw summary source 仍能通过最终输入上限和 Provider data admission 才能回退 raw；否则形成
typed failure。`cache_safe_fork:v1` 则必须先满足父前缀冻结规则：冻结区只重放父
committed representation，不能回退到不同字节的 raw 或应用当轮 proposed 扩展。无父 commit
且 raw 正是父字节时可记为 `raw_fallback/cache_parent_frozen`。若 source 在这一规则后仍超过
`maxSummaryInputTokens`，本版本以 typed
`summary_input_too_large` 失败，不静默 chunk/merge 或裁剪自然语言消息。

### Checkpoint v2

`ContextCompactionCheckpointV2` 兼容扩展 v1 envelope，保持唯一模型正文 `summary:string`，并增加持久
审计 identity：

```ts
type DurableReclaimApplicationV2 =
  | { kind: 'off'; rawFramesDigest: string }
  | {
      kind: 'applied_commit';
      planDigest: string;
      commitDigest: string;
      selectedCoverageDigest: string;
      appliedFramesDigest: string;
    }
  | {
      kind: 'applied_plan';
      planDigest: string;
      baseCommitDigest?: string;
      selectedCoverageDigest: string;
      appliedFramesDigest: string;
    }
  | { kind: 'valid_noop_plan'; planDigest: string; appliedFramesDigest: string }
  | {
      kind: 'raw_fallback';
      failure: 'ineligible' | 'plan_rejected' | 'apply_rejected' | 'cache_parent_frozen';
      rawFramesDigest: string;
    };

interface ContextCompactionCheckpointV2 {
  version: 2;
  compactionId: string;
  sourceRevision: number;
  sourceDigest: string;
  summary: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  reason: 'manual' | 'auto';
  createdAt: string;
  baseCheckpointId?: string;
  sourceIdentity: 'verified_v2' | 'legacy_raw_source';
  rawSourceDigest: string;
  summarySourceProjectionDigest: string;
  normalizedSummaryDigest: string;
  candidateAfterFramesDigest: string;
  candidateAfterProjectionDigest: string;
  reclaimPolicyId: string;
  reclaimApplication: DurableReclaimApplicationV2;
  toolResultBudgetPolicyId: string;
  estimatorId: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  projectionContractId: string;
  summaryRouteIdentity: string;
  sourceManifest: ContextCompactionSourceManifestV1;
}
```

v2 中兼容字段 `sourceDigest` 必须逐字节等于 `rawSourceDigest`；前者保留现有 reducer/event 消费者，后者让
raw source 与 summary source projection identity 在类型上不再混淆。before/after token 字段继续使用现有
完整请求 estimator，`summaryRouteIdentity`、normalized summary 与 candidate-after 两个 digest 一同进入
qualification identity。`reclaimApplication` 必须使用显式判别联合表达 off、applied、valid no-op
或 raw fallback；不得为默认关闭/manual-first 或 plan 失败伪造 commit/plan digest。

Slice A 为持久 reclaim commit 把 Runtime schema 从 v21 提升到 v22；本切片再提升到 v23 并引入 checkpoint
v2。Runtime type 是 `ContextCompactionCheckpointV1 | ContextCompactionCheckpointV2` 的显式 union；v1
checkpoint 在读取时保持 version 1，不原地伪造 v2。以 v1 为 base 的 incremental v2 设置
`sourceIdentity=legacy_raw_source`，在 manifest 中保留 base source identity，但不得声称 legacy source 使用过
L2。任何以 `legacy_raw_source` v2 为 base 的后续 incremental v2 必须继续传播
`sourceIdentity=legacy_raw_source`，不得升格为 verified；只有不使用 legacy base、从 raw transcript 全量
重建，且覆盖范围内每个 Tool Result 都能追溯到
`kind:'verified_v2' && receipt.projectionMode==='budget_v2'`，才可清除 legacy 标记。范围内任一
terminal/result 为 `legacy_unverified`，或 verified receipt 为 `projectionMode==='compat_v1'` 时，即使不使用
legacy checkpoint base，
新 checkpoint 仍必须为 `legacy_raw_source`，不得资格洗白。v1 仍可正常 restore/reset；
只有从 raw transcript 完整重建、
`sourceIdentity=verified_v2` 且所有 digest
重算通过的新 v2 checkpoint 可以通过完整三级 qualification identity。`summaryRouteIdentity` 只保存稳定
route/model/prompt qualification identity，不保存 endpoint、credential 或用户正文。

`baseCheckpointId` 存在时，`sourceManifest.baseCheckpoint` 也必须存在，且 compaction ID、version、
source digest 与当前 active base checkpoint 逐项一致；任何一项缺失或不一致都不能激活
candidate。

candidate activation、restore 和 history normalization 都必须执行三段证明，不得只把两份持久
副本互相比较：

1. **checkpoint ↔ manifest**：`rawSourceDigest/rawTranscriptSourceDigest`、
   `summarySourceProjectionDigest`、`reclaimApplication` canonical bytes、`reclaimPolicyId`、
   `toolResultBudgetPolicyId`、`estimatorId`、`projectionEnvironmentDigest`、
   `cacheAffectingEnvironmentDigest` 和 `projectionContractId` 必须逐项相等，base union 与
   active base 一致；checkpoint 顶层与 manifest 的 `coveredThroughMessageId`/
   `coveredThroughTurnId` 必须分别相等，不得各自控制投影/裁剪边界；
2. **manifest ↔ 实际 canonical safe source**：从不可变 transcript 重新定位
   `firstSourceMessageId..coveredThroughMessageId/TurnId`，重验 complete settled boundary。
   `rawTranscriptSourceDigest = H('context-raw-source:v2', firstId, coveredId, canonical bytes of every`
   `immutable raw transcript message in that inclusive range)`；即使是 incremental checkpoint 也要全量回查
   原 transcript，不用两个持久 digest 串联冒充 raw source。随后使用存储的
   `projectionContractId`/policy/environment 从真实 base checkpoint + boundary 后 tail 重建 raw frames、应用
   `reclaimApplication` 并重算 raw/applied frames 与 summary-source projection digest；
3. **summary ↔ candidate-after**：从 normalized `summary` 重算 `normalizedSummaryDigest`，并严格使用
   第 1 段已统一的 covered message/turn boundary 和同一 source/policy identity 重建 candidate-after
   frames/projection，校验 pending compaction/candidate safe boundary、两个 candidate digest 及 pairing。

无法解析旧 projection contract/policy implementation，无法回查真实 source，或任一段 digest/boundary 不匹配
时，fail closed 为 unqualified legacy/invalid checkpoint，不猜测。

### Schema 迁移与规范化矩阵

| 输入 | 目标 | 规范化结果 |
| --- | --- | --- |
| v2..v21 snapshot | v22 | 保留现有 legacy migration chain；`reclaimCommit=none`；checkpoint v1 原样保留 |
| v2..v21 snapshot | v23 | 必须经 v22 normalizer；checkpoint v1 保留；guard 只统计 snapshot position 之前可重放 `model.responded`，tail 由 reducer 递增；legacy `disabledUntilManualAction=true` 保守映射为 `breaker=open`，不伪造 anchor/count |
| v22 snapshot | v23 | 校验后保留 commit；checkpoint v1 不升级；guard 计数同样以 snapshot position 为唯一 cut，tail 不双计；legacy open breaker 同样保守传播 |
| v1 active/history checkpoint | v23 | 保留 `version:1`；restore/reset 可用，不获得 verified-v2 qualification |
| v21/v22 pending compaction | v23 | 无 `dispatch_started`：stale cancel；有 started 无 terminal：`unknown_external_outcome`；有 terminal：只 replay terminal reducer；三者均不重放 Provider |
| v2..v21 snapshot + legacy tool terminal tail | v22/v23 | 对 cutover position 之前所有历史 transcript-producing finished/failed/rejected/cancelled/approval/provider-action variants 建立 `legacy_unverified`；无 V2 digest/L2/route 资格 |
| invalid v2/source manifest | v23 | 隔离 candidate/checkpoint，回到 raw projection；只在 canonical correctness 失败时 hard-block |
| snapshot + event tail | v22/v23 | 先规范化 snapshot，再按 schema 支持集 replay；无法证明的新版事件 fail closed，不跳过 |

迁移测试必须覆盖每一行、重复 replay、中断 event tail、base checkpoint 错配和 mixed v1/v2
history。迁移不调用 Provider，不重算或伪造 legacy digest。

v2..v21→v22 snapshot write 必须使用 Store snapshot-only `compareAndSaveMigratedSnapshot()` 事务
CAS，同时验证 `sourceSnapshot{schemaVersion,stateRevision,snapshotEventPosition,stateChecksum}` 和
`observedEventHead{eventPosition,revision,eventId}`，并把 next v22 写在 exact observed head；不得沿用无条件
`saveSnapshot()`。snapshot 未变但 tail 并发前进也 stale，必须丢弃候选并 reload/replay。故障矩阵
覆盖 v2/v11/v12/v13/v16/v17/v18/v20/v21 与双 Kernel slow writer。

### SourceManifest

`ContextCompactionSourceManifestV1` 是 bounded、JSON-safe、无正文的 source 证明，不复制权限、
文件正文或 Runtime authority：

```ts
interface ContextCompactionSourceManifestV1 {
  version: 1;
  firstSourceMessageId: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  rawTranscriptSourceDigest: string;
  rawFramesDigest: string;
  summarySourceProjectionDigest: string;
  appliedFramesDigest: string;
  toolResultBudgetPolicyId: string;
  reclaimPolicyId: string;
  reclaimApplication: DurableReclaimApplicationV2;
  estimatorId: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  projectionContractId: string;
  baseCheckpoint?:
    | {
        version: 1;
        identity: 'legacy_v1';
        compactionId: string;
        sourceDigest: string;
      }
    | {
        version: 2;
        identity: 'legacy_raw_source' | 'verified_v2';
        compactionId: string;
        sourceDigest: string;
      };
}
```

manifest 证明 summary 覆盖了哪份 raw source、应用了哪种确定性投影；它不能直接作为模型
上下文或授权。canonical stable JSON 的 UTF-8 大小上限为 8 KiB，字段和 union branch
数量固定，不得加入数组、map 或自由文本。
当前 task、turn、authorization、tool descriptors、计划 artifact、项目规则和 workspace 状态始终从最新
Runtime 与 projection environment 重新解析并确定性重注入。最近工作集正文恢复、自动重读和 artifact replay
不进入本版本。本版本不生成 model-visible recovery hint/mustKeep frame/第二段事实 payload，
完整保留 ADR-0022 §9 的单 narrative 边界。

## L3 请求与 prompt cache

本 RFC 保持 ADR-0022 的“一次 Provider request、唯一 Markdown narrative、零 SDK retry、无 Runtime
工具副作用”，但要求 ADR-0097 **局部取代** ADR-0022 §3 的“独立最小无工具请求”以及
ADR-0057 决策 1 中的“无工具请求”形态，仅对已通过缓存资格的 route 采用以下
`cache_safe_fork:v1`：

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

1. 父身份必须来自最近一次已成功持久的 primary Provider dispatch/cache receipt，不能使用尚未
   dispatch 的 hypothetical `normal-before` 伪造 cache parent；
2. summary 使用父请求相同的 cache-eligible system/context/tool schema/history prefix，在 L2 后 safe
   settled source 末尾只追加固定 compaction instruction，不改写可复用前缀；
3. `tool_choice`、thinking、effort、context-management、output-format、beta headers、citations、
   web-search/image state 以及 adapter 声明的其他 prompt/cache-key-affecting 参数必须与父请求逐项
   一致，并进入 `promptAffectingParametersDigest`；不得为禁用工具而把父请求的 `auto`
   改为 `none`；
4. 零工具副作用由“compactor 不持有 executor + tool-call candidate invalid”保证。若 Provider 有不改变
   cache key 的 execution-disable 能力，adapter receipt 可以声明；否则保持父 `tool_choice`，即使
   模型返回 tool call 也只会使 candidate 失效，绝不执行；
5. request-shape ID、`PromptCacheParentIdentityV1`、可复用 eligible-prefix token 数和 Provider cache
   capability 进入 `summaryRouteIdentity`。Provider cache-key registry 未覆盖的参数使 route fail closed，
   不得只凭本地 message bytes digest 声称 cache-safe。

`messagePrefixDigest`/`parentPrefixProjectionDigest` 精确覆盖最近成功父请求从第一个
cache-eligible message/frame 到 `coveredThroughMessageId/FrameId` 的字节，边界不随当前候选 plan
移动。为复用该父缓存，summary source 在冻结范围内只能重放父请求已实际使用的
committed L2 表示；当前轮 proposed watermark 扩展若会改写冻结前缀，该扩展必须延后，
不进入 summary-source plan，也不提交 commit。冻结边界之后的 tail 仍可按同一 L2 policy
生成 purpose-specific plan，并以 `applied_plan {baseCommitDigest,...}` 持久证明其与父 commit 的组合；
该证明不晋升 watermark。

如果重放父 committed representation 后的 summary source 超过输入上限，或父 cache identity
无法重验，返回 typed `cache_parent_incompatible`（容量超限时可继续区分
`summary_input_too_large`）。auto 本轮终止，不暗中切换 `isolated_minimal_no_tools:v1`、不自动
重试 normal dispatch；manual/development 只能在一开始就明确选择 isolated request shape。

不支持可证明前缀复用或无法禁用 tool execution 的 route 可以保留
`isolated_minimal_no_tools:v1` 作为 manual/development fallback，但不得借此获得 cache-capable 的完整三级
route qualification。Provider-specific `cache_edits` 仍明确排除；它与标准 cache-safe prefix fork 不是
同一能力。任何 tool call、非文本终态或多正文 artifact 都使 candidate 无效。

## 触发、预留与防抖

完整状态机使用 final pressure，而不是 raw pressure 决定 L3：

```text
normal
  -> warning: try L2 when eligible
  -> final below compact: dispatch
  -> final at/above compact + auto flags/route/guards eligible: request L3
  -> final at/above compact + auto not eligible: dispatch; Provider decides real capacity
  -> L3 committed: rebuild once and dispatch
  -> refill within protected window: count refill
  -> refill limit reached: stop auto compaction and require explicit recovery
```

- proactive L3 前必须证明 summary input、summary output reservation 和 Provider safety margin 能同时放入窗口；
- 每次成功 L3 同时满足现有至少 1024 token 绝对收益与配置的最小比例收益；
- cooldown 内不再次主动 L3；同一 turn 最多提交一个 proactive L3；
- post-compact refill window 以已成功持久的 primary `model.responded` 序号计数，不以 wall clock
  或进程内计时代替；
- 达到 refill breaker 后停止 auto，提示 focused `/compact`、拆分任务、Sub-agent 或 `/clear`，不得循环付费；
- manual `/compact` 继续使用同一 source/policy，但不受 auto rollout bucket 控制。

### 可持久 AutoCompactionGuard

Slice B 在 schema v23 持久 reducer-owned `AutoCompactionGuardV2`：

```ts
interface AutoCompactionGuardV2 {
  version: 2;
  guardGeneration: number;
  policyEpochId: string;
  modelResponseOrdinal: number;
  anchorCheckpointId?: string;
  anchorResponseOrdinal?: number;
  observedAnchorCheckpointId?: string;
  consecutiveRapidRefills: number;
  cooldownUntilResponseOrdinal: number;
  breaker: 'closed' | 'open';
  openedByCheckpointId?: string;
}
```

`modelResponseOrdinal` 只在 primary `model.responded` 成功持久时递增。每次 L3 checkpoint 成功激活时，
以当前 ordinal 作为 anchor 并清空 `observedAnchorCheckpointId`。若 effective final pressure 在该
anchor 后配置的 `N` 个 completed primary model responses 内再达 compact，Kernel/Store 持久
`context.compaction_refill_observed`，纯 reducer 验证并归约后把
`consecutiveRapidRefills` 加一；达到 policy 中固定的 `maxConsecutiveRapidRefills` 后原子打开
breaker，该次与后续 auto L3 均不得 dispatch。事件必须携带 anchor checkpoint、ordinal、
effective projection/pressure evidence、previous guard digest 和 policy epoch；同一 anchor 只能把
`observedAnchorCheckpointId` 从空设为自身一次，即使后续 L3 失败也不能重复累计。若超过 `N`
个应答未快速回填，下一次
observation 重建 rapid-refill chain，但 cooldown 仍独立生效。`N`、limit、cooldown 和状态机版本全部
进入 policy epoch/qualification identity；guard digest 与 refill observation identity 进入每次 auto eligibility。

restart/resume 必须恢复该状态。由于当前 rewind 会删除目标位置后的 event/snapshot，
guard 不能只是普通可回卷 snapshot 字段。RuntimeStore 必须在同一 rewind/fork transaction 内取
pre-operation session guard floor 与恢复点 guard 做 `joinAutoCompactionGuardV2()`，并追加
`context.compaction_guard_carried_forward`后才暴露新 snapshot：

- `guardGeneration` 较大者胜；只有显式合法 reset 才能递增 generation；
- 同 generation 内 `open` 胜于 `closed`，ordinal/count/cooldown 取最大值；
- 恢复点已不存在 anchor checkpoint 时清除悬空 anchor/observed-anchor，但不降低 count/breaker；
- policy epoch 变化以新 policy 重建可用字段，同时保留上述单调 safety floor 和 carry digest。

fork 即使从早期 boundary 创建，也必须与源 session 当前 floor 做同样的 join，不因新
session ID 清零。checkpoint reset 不得减少 count 或关闭 breaker。只有成功的显式 manual
`/compact`、`/clear` 创建全新会话，或专用管理员/用户 reset action 可以原子递增
generation 并持久 `context.compaction_guard_reset`；取消、失败 manual 或单纯切换 flag 不能 reset。

## Provider overflow 边界

本版本不实施 Provider overflow 后自动 L2/L3 或 normal retry，继续保留 ADR-0022/0024 的延期
结论。adapter 可以对稳定 Provider 信号做有类型分类，但 Runtime 只把它作为普通 Provider
terminal，不合成 `ContextCompactionReason`、不释放已 started reservation、不重放。Anthropic 通用
`400 invalid_request_error`、`413 request_too_large`、错误字符串，以及已产生输出的
`model_context_window_exceeded` 都是必须覆盖的负例，不得伪造零 usage/未执行证明。
未来 reactive recovery 必须另立 ADR，完整定义 adapter receipt、原 attempt 计费、独立 summary/retry
reservation、durable state machine 与 crash/restart 行为，不得从本 RFC 推断已获授权。

## Reset、restore、resume 与 fork

- 原 transcript 永不由 L1/L2/L3 删除；
- `/compact reset` 撤销 active narrative checkpoint，L2 是否应用由当前 mode/policy/commit 决定；
- flag/mode off 必须恢复 raw transcript projection；
- restart/resume 从 checkpoint v2 和 reclaim commit identity 重建相同 canonical projection；
- fork 复制 fork boundary 之前的 checkpoint/commit，并把 boundary guard 与源 session 当前 guard floor
  做单调 join；新 session identity 使 rollout 与后续 lease 独立，但不能用来清零已开启的
  refill breaker；
- rewind 到 commit/checkpoint 之前时，同时回退派生 commit/checkpoint，不保留超出恢复点的 projection identity；
  guard 作为 session safety floor 只能保留或增强，不随 rewind 降低；
- policy/environment/revision 不匹配时 fail closed，保留 raw content 或要求重新压缩，不能猜测。

## Provider data、隐私与观测

所有 admission 都读取最终实际 payload。L2/L3 减少正文不能改变原数据分类、route policy 或 consent。
metrics 明确区分 `candidate`、`planned`、`committed`、`applied` 和 `summarized`，只允许聚合值：

- policy/schema/mode/cache epoch；
- raw/final input tokens、saved chars/tokens、candidate/applied block 数；
- pressure、trigger、拒绝原因、duration；
- cache read/create tokens、refill count、重复 read/search count；
- planner/apply p50/p95 duration、峰值内存、commit/checkpoint/source-manifest 持久 metadata bytes；
- checkpoint version、source identity 与 typed failure kind。

禁止记录 path、args、call/message ID、digest 值、stub、tool content、summary、transcript 或 manifest。

## 失败语义

| 失败 | 结果 |
| --- | --- |
| L1 projector/budget contract 无效 | 工具结果 fail closed；不得进入无界模型历史 |
| L2 plan/application identity 无效 | 候选不发送；按 raw final pressure 和完整 auto gates 选择 raw 或 L3 |
| canonical pairing/projection invariant 无效 | 零 Provider dispatch；进入现有 correctness hard-block factory |
| summary source identity 无效 | `invalid_candidate`，不写 checkpoint |
| summary source 超上限 | `summary_input_too_large`，不隐式 chunk/snip |
| cache parent 无法重放 | `cache_parent_incompatible`；auto 本轮终止，不切 isolated fallback 或重试 normal |
| summary Provider/validation 失败 | 保留旧 checkpoint/transcript；auto 终止本 turn，manual 返回脱敏失败 |
| environment/lease stale | 现有 `stale_context` 路径收敛 |
| Provider overflow/通用 Provider error | 普通 Provider terminal；不触发 L2/L3 或 retry |
| refill breaker open | 禁止 auto L3；保留 manual/clear 等显式恢复路径 |

## 实施切片

### Slice A：L1 完整预算与 L2 live

- 新 ADR 接受 ToolResultBudgetPolicyV2、统一准备器、live mode、watermark/cache epoch 和 final admission；
- Runtime schema v22 持久化 reclaim commit/applied receipt，并提供 v21 安全迁移；
- 所有 production ToolSpec 迁移到封闭 budget contract；
- normal/preflight/`/context`/candidate/debug 消费同一 prepared artifact；
- route 仍默认 off，完成 synthetic、golden、cache 与 continuation shadow/live 对比。

### Slice B：L3 source convergence 与 checkpoint v2

- 新 ADR 接受 canonical summary source、cache-safe summary fork、checkpoint v2、Runtime schema v23
  migration、durable refill guard 和 source manifest；
- manual/auto summary、restore/reset/resume/fork/rewind 使用 v2 identity；
- L2 后仍超 compact threshold 且 auto flags、route qualification、cooldown、breaker 都允许时进入 L3；
- 完成 ADR-0057 扩展 qualification 和真实 Provider route 证据。

Slice A 独立产生用户可见 L2 saving，但不能称为完整三级；只有 Slice B 通过才达到本 RFC 的开发可用定义。

## 验收门禁

### G0：正确性与恢复

- 所有 production tool model result 有有限 L1 budget；超界 marker/continuation 可重放；
- `read_file` 最后允许行超大时 cursor 在同一 revision/endLineExclusive 内完成该行后停止；
- tool call/result orphan、重复、错配为 0；原 transcript 和 Runtime authority 不变；
- finished/failed/rejected/cancelled 每个 terminal 事件自包含唯一 verified model result；交互/取消
  CAS batch 中所有 tool terminal 在 `turn.aborted` 前收敛，任意中断点不产生孤儿或重复正文；
- pure prepare 和 diagnostic/candidate purpose 的 resource reservation、lease、`dispatch_started` 与 Provider dispatch
  全部为 0；
- `toolResultBudgetV2=false` 且 L2 off 时与 main raw payload 字节级一致；L2 live 只改变 eligible
  tool result content；
- restart/resume/fork/reset/rewind 在同一 identity 下产生相同 canonical projection；
- Provider、summary、lease 或 validator 失败不产生重复 dispatch、无限循环或错误 hard block；
- v2..v21→v22、v2..v21→v23、v22→v23、v1/v2 checkpoint、pending/event-tail 与 invalid manifest 的
  迁移矩阵全绿；
- checkpoint/manifest covered message/turn 边界错配、pending safe boundary 错配、真实 source 错配全部
  零激活；覆盖范围含任一 `legacy_unverified` 时不得生成 verified-v2；
- v2..v21 所有历史 transcript-producing tool terminal tail 只能在 cutover 前规范化，新 event API
  无法构造 legacy branch；
- destructive rewind/fork 的 guard join 原子性、中断恢复、policy-epoch carry 与同 checkpoint
  refill observation 去重测试全绿；v21/v22 `disabledUntilManualAction=true` 迁移、restart、fork/rewind
  始终保持 V2 breaker open；
- `refill_observation_required → CAS event → re-prepare` 在 observation 打开 breaker 时对本次 L3 零 dispatch。

### G1：三级闭环

- synthetic 大 current-turn read 由 L1 有界；
- tool-heavy settled history 在 warning 后实际应用 L2；
- L2 后低于 compact threshold 时不调用 summary；
- L2 后仍超 threshold 且完整 auto gates 允许时进入一次 L3；否则发送经过 final admission 的 effective
  projection。进入 L3 时 summary source 已使用同一 reclaim policy；
- checkpoint v2 commit 后重建一次 final payload 并通过最终 resource/provider-data admission；
- window unknown、legacy checkpoint、policy change 和 mixed block 全部按明确规则 fail closed。

### G2：收益、缓存与 continuation

- 每次 live 应用达到预注册的绝对和比例 saving；无正收益不改 payload；
- L2 commit 不在每个 turn 重写 cache prefix；cache epoch 变化可诊断；
- 支持缓存的 route 必须使用 `cache_safe_fork:v1`；父请求与 summary 的 eligible-prefix digest
  mismatch 容忍度为 0；
- 必须有“warning 首次提出 L2 watermark 扩展，本轮仍需 L3”的真实 cache 用例；证明
  summary 冻结父已 committed prefix、延后会改写前缀的 proposed 扩展，并对
  `cache_parent_incompatible|summary_input_too_large` 稳定收敛；
- treatment/control 必须使用相同 transcript、eligible prefix、route/model、cache breakpoint/TTL、
  prompt-affecting 参数和请求次序；每个 route/model 的 warm/cold cohort 各至少 30 **对配样本**。
  warm 必须有未过期的真实父 cache receipt，cold 必须由 TTL 过期证据或独立 cache namespace
  证明；paired bootstrap/randomization seed、顺序与 cache proof 全部进入 evidence identity；
- `eligible-prefix reuse ratio = min(cacheReadTokens, eligiblePrefixTokens) / eligiblePrefixTokens`；使用预注册
  paired 95% bootstrap CI，warm 的该 ratio 下界不得低于 0.95。summary+首个 normal 的
  billed-input tokens 与 cache-create tokens 分别判定，两者的 treatment/control ratio CI 上界在 warm
  不得超过 1.05、cold 不得超过 1.10；不得把两项相加掩盖单项回归；
- summary+首个 normal 端到端 p95 延迟的 treatment/control ratio CI 上界不得超过 1.10。
  Provider 支持诊断时，cache miss reason 只能记录封闭枚举，不记录原始 message、header 或错误文本。
  这些 margin 由 ADR-0097 冻结，route 不得自定义放宽；
- refill breaker 在限定 completed primary model responses 内停止反复 auto compaction，且
  restart/resume/fork/rewind/reset 不能绕过；
- 重复 read/search 次数的 treatment/control ratio 95% CI 上界不得超过 1.10；关键事实保留和
  continuation 仍满足 ADR-0057 non-inferiority；
- 冷 resume 必须覆盖 Provider cache 过期后的 summary 成本、完整 history→summary handoff、首个
  normal continuation 与无 model-visible recovery hint 的重读行为；
- planner/apply p95 延迟、峰值内存与持久 metadata bytes 都不得超过 ADR-0096/0097 冻结的
  本地上限；
- 真实 Provider route、模型、adapter、prompt、tool schema 和 policy identity 全部进入证据身份。

### G3：隐私与产品表述

- shadow/live/summary telemetry 内容泄露为 0；
- 新 L1 V2/L2 live/auto L3 的 default config 保持 off，现有 manual compaction 的两个默认 true
  不回退；显式 live 可完整运行；
- 未通过真实 route qualification 时只能标记 experimental，不得写 production-supported；
- 不声称 Claude Code parity、无限会话、固定 Claude 内部参数或所有 Provider 等价。

## 明确排除

- 按消息数量 head/tail 删除自然语言历史；
- Core 直接使用 Provider `cache_edits`；
- 未治理的明文 tool artifact store 或跨 session 检索；
- 第二份模型生成 memory/fact ledger 作为 checkpoint 或 Runtime 权威；
- model-visible recovery hint/mustKeep frame、自动重读或工作集正文恢复；
- 渐进 summary、chunk/merge 和部分 checkpoint commit；
- 未经独立证据扩大 **L2 正文替换资格** 到 effectful tool、动态 MCP、Shell 或 Web；
  这不影响 L1 对所有工具强制有限结果预算；
- 从任何 Provider overflow/错误自动压缩或 retry；
- 合入即默认开启或自动宣称 production supported。

## 文档与决策产出

本 RFC 评审通过后应新增：

1. [`ADR-0096`](../adr/0096-three-tier-context-reduction-l1-l2-live.md)：L1 完整预算、L2 live、统一 prepared
   artifact、watermark/cache epoch、final admission；
   其中局部取代 ADR-0048 决策 4 中“terminal reducer 现场生成未预算 Tool Result 正文”的
   producer 方式，以及 ADR-0049 决策 6 中 approval control event 的 Tool Result producer/
   批次成员，改为 control event + self-contained companion terminal 同批提交；保留拒绝语义、
   原子取消、先持久后 AbortSignal、sibling 收敛、`turn.aborted` 顺序、`ask_user`
   continuation 与 live/replay 一致性；
2. [`ADR-0097`](../adr/0097-three-tier-context-reduction-l3-source-convergence.md)：L3 canonical source、cache-safe
   summary fork、checkpoint v2、Runtime schema v23 migration、
   durable refill guard 与 source manifest；对 cache-qualified route 局部取代 ADR-0022/ADR-0057 的独立
   无工具 summary request 形态，并仅在 v21/v22→v23 migration cutover 局部取代 ADR-0022
   §2 的 pending-without-terminal 重新执行规则；不取代单 narrative/零工具执行/零 retry 边界；
3. `docs/adr/README.md` 登记 ADR-0095、0096、0097；ADR-0096/0097 初始为 `proposed`；
4. [Slice A 计划](../space/plans/2026-08-10-three-tier-context-reduction-slice-a.md) 初始为 `draft`；
   [Slice B 计划](../space/plans/2026-08-10-three-tier-context-reduction-slice-b.md) 在 Slice A 门禁通过前仍为
   `draft`，依赖满足且 ADR accepted 后才改为 `active`；
5. 同步 `docs/space/plans/index.md`、`docs/space/index.md`，每个切片完成后新增独立完成记录并归档原计划；
6. 实施时新增统一 `docs/active/three-tier-context-reduction.md`，并同步 feature flags、Provider boundary、
   compaction、observability、file/tool boundary、持久化、book、README 与 documentation map。

现有 Foundation RFC/ADR/plan 只增加后续链接，不修改其已接受范围或完成证据。
