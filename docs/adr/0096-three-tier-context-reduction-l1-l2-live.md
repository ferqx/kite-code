# ADR-0096：三级上下文缩减的 L1 全工具预算与 L2 Live 投影

状态：accepted
日期：2026-08-10
决策者：@chenchao
补充：ADR-0024、ADR-0048、ADR-0049、ADR-0057、ADR-0090、ADR-0091、ADR-0095
关联：`docs/design/2026-08-10-three-tier-context-reduction-complete-rfc.md`、
`docs/space/plans/2026-08-10-three-tier-context-reduction-slice-a.md`
后续：ADR-0097（L3 source convergence、checkpoint v2、cache-safe summary 与 durable refill guard）
当前后续：ADR-0100（MicroCompact、Checkpoint Working Set 与 SummaryCompact）
局部取代：ADR-0048 决策 4 中“terminal reducer 现场生成 Tool Result 正文”的 producer 方式；
ADR-0049 决策 6 中 `approval.rejected` 直接生产 Tool Result 及其原子批次成员的部分，改为
control event + self-contained companion terminal 同批提交。ADR-0048/0049 的拒绝语义、原子取消、
先持久后传播 AbortSignal、sibling 收敛、`turn.aborted` 顺序、`ask_user` continuation 与
live/replay 一致性继续有效。

## 术语

- **pre-L1 raw result**：工具执行器返回、尚未经过模型结果投影的值或字节。它可以用于 digest、受治理
  artifact 或执行收据，但不能直接进入模型 transcript。
- **L1 result budgeting**：工具完成时，把 pre-L1 result 投影为有有限预算、可验证 provenance 的模型结果。
- **raw transcript / raw projection**：L1 已完成后的不可变 canonical transcript，以及尚未应用 L2/L3 的
  projection；本文中的 raw 从不表示 pre-L1 原始字节。
- **L2 deterministic reclaim**：在 canonical tool-call block 上运行的纯、确定性、无模型正文替换。
- **prepared artifact**：统一请求准备器产生的 deep-frozen raw/effective projection、estimate、identity 与
  next-state 证据。
- **source identity**：证明 projection 依赖了哪份 transcript、checkpoint、policy、environment 与 estimator。
- **request identity**：证明某个 purpose 最终要发送的 Provider payload、工具 schema、prompt 参数与输出预留。
- **applied plan**：本次 purpose projection 已应用但尚未获得 durable primary success 的固定 plan 证据。
- **reclaim commit / watermark**：成功 primary Provider 请求已经实际使用的稳定 reclaimed prefix 身份。
- **cache epoch**：会改变可缓存 prefix 字节的 checkpoint、policy、schema、contract 或 environment 身份集合。

## 背景

ADR-0095 接受了三级术语、`ToolResultBudgetPolicyV1` identity、可信 result provenance，以及 L2 的
`off|shadow` pure planner/applier。它刻意没有授权以下行为：

1. 所有 production 工具统一采用 UTF-8 model-envelope 预算；
2. 把 L2 候选实际用于 Provider payload；
3. 在各上下文入口之间共享同一份 raw/final projection 与 admission identity；
4. 持久化已经被成功 primary request 使用的稳定 L2 prefix；
5. 把 Runtime schema 从 v21 升级以保存 commit、receipt 和新的 tool terminal provenance。

当前 terminal reducer 还会根据 `tool.finished|failed|rejected|cancelled` 或交互事件现场拼接模型正文。预算、
serialization、失败文案与 transcript append 因而分散在 Registry、Runner、Controller、MCP、interaction 和
recovery 路径中。新增工具或历史兼容分支可以绕过已有 Shell/Search 4000 字符和 MCP 128 KiB 边界；若把
terminal 与一个独立 model-result event 分两次持久，又会产生崩溃后的 tool call/result orphan。

当前 `prepareRuntimeEffectForBudgetV1()` 还先对 raw projection 做 resource admission，Model Controller、
`/context`、candidate/debug 和 compactor 也可能分别构建 projection。L2 live 若直接接在其中任一路径，会使
planner 所见 bytes、Provider data policy 所见 bytes、resource reservation 和实际 dispatch bytes 不一致。

逐轮重新选择更早历史还会反复改写 prompt prefix。没有 durable watermark 时，planner 即使确定性，也无法
证明下一轮重放的是已经被成功 Provider 请求实际使用的表示；summary、candidate 或 diagnostic 的成功也不能
证明 primary request 使用过该 prefix。

本 ADR 接受 Slice A：L1 V2、统一 prepared artifact、L2 live、稳定 commit/cache epoch 和 Runtime schema
v22。它不接受 L3 checkpoint v2 或完整三级 route qualification；这些由 ADR-0097 单独决定。

## 决策

### 1. 功能范围与默认值

新增并保持以下默认值：

```text
toolResultBudgetV2=false
contextReclaimV1=false
compaction.reclaimMode=off
```

`reclaimMode` schema 扩展为 `off | shadow | live`。其 effective mode 遵循：

- `contextReclaimV1=false` 时恒为 `off`；
- `off` 不运行 L2 planner，也不应用历史 commit；
- `shadow` 可以计算候选与脱敏 metrics，但不改变 payload、Runtime 或 watermark；
- `live` 只有在 `toolResultBudgetV2=true && contextReclaimV1=true` 时才可以应用 L2。

本 ADR 不改变现有 `contextCompactionV2=true`、`contextCompactionManualV1=true`，也不打开
`contextCompactionAutoV1`。合入实现不等于 default-on、production-supported 或所有 Provider route 获得资格。

关闭 V2 只影响之后完成的工具。已经以 V2 有界形式进入不可变 transcript 的正文不会恢复成 pre-L1 raw
result；关闭 L2 live 则必须忽略 commit 并恢复从该不可变 raw transcript 构建的 projection。

schema v22 cutover 后，统一 finalizer 与 self-contained terminal choke point 始终启用；
`toolResultBudgetV2` 只选择 `compat_v1 | budget_v2` 投影策略，不得恢复 reducer 现场生成
正文。`compat_v1` 保持当前 V1 model bytes/marker 语义，但仍生成 self-contained verified
receipt；它不声称有限 V2 budget，不获得 L2 live 或 route qualification。

### 2. L1 V2 是所有模型可见工具结果的封闭注册契约

每个可能进入主模型或 Sub-agent 模型历史的 production ToolSpec 和 turn-bound dynamic binding 都必须解析为
一个有限 budget：

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

type ResolvedToolResultBudgetV2 =
  | {
      source: 'builtin_spec';
      toolIdentity: string;
      bindingDigest: string;
      budget: ToolModelResultBudgetV2;
    }
  | {
      source: 'runtime_binding';
      toolIdentity: string;
      bindingDigest: string;
      budget: ToolModelResultBudgetV2;
    };
```

Registry conformance 必须拒绝缺少 budget、非有限正整数、未知 projector、没有稳定 truncation marker 或没有
可前进 continuation 的 production spec。Builtin 从 ToolSpec Registry 解析；动态 MCP 等工具只从当前 turn
已经绑定 revision 和 catalog digest 的 runtime binding 解析。projector implementation、validator、revision、
binding digest 和 budget 共同进入 `ToolResultBudgetPolicyV2` identity。

缺少或未知 runtime binding 的动态工具不得向模型披露或执行。schema-invalid、unknown tool 或在 terminal
边界仍无法解析 binding 时，只能使用封闭 builtin `core-tool-failure:v1` budget/projector 生成有界失败结果；
未受信 raw args、error text 或 Provider body 不得直接进入模型。

V2 初始边界为：

- Shell/Search 继续使用现有每 stream 4000 字符 head/tail，启用 V2 不静默改变这两个 stream 的输出字节；
- MCP 在 V2 off 时保持现有按 JS 字符数执行的 128 KiB 兼容行为；V2 on 时，128 KiB 是最终完整 UTF-8
  model envelope 上限；
- 其他没有更严格 tool-specific contract 的结果使用 128 KiB UTF-8 model-envelope 全局上限；
- structured projector 截断后必须仍是合法结构，不能切断 JSON 字符串或 UTF-8 code point；
- tool-specific budget 可以更小，不得超过全局安全上限。

### 3. `read_file` 使用可重放的 line-byte cursor

首次读取与 continuation 使用判别联合：

```ts
type ReadFileInputV2 =
  | { path: string; offset?: number; limit?: number; cursor?: never }
  | {
      path: string;
      cursor: {
        lineOffset: number;
        utf8ByteOffsetInLine: number;
        endLineExclusive: number;
        pathDigest: string;
        resourceRevision: string;
      };
      offset?: never;
      limit?: never;
    };
```

行号为 1-based。首次请求定义：

```text
initialOffset = offset ?? 1
effectiveInitialLimit = initialLimit ?? (totalLines - initialOffset + 1)
endLineExclusive = min(totalLines + 1, initialOffset + effectiveInitialLimit)
```

schema 在进入 projector 前拒绝非正整数 `offset|limit`。`initialOffset > totalLines` 返回有界
`completed_empty`，不生成 continuation cursor。`pathDigest` 的 domain 固定为
`read-file-path:v2\0 + resolvePath()` 返回的规范绝对路径（已完成 MSYS 转换、分隔符规范化和
workspace/allowExternal 验证）。`resourceRevision` 是
`digest('read-file-resource:v2\0' + decoderContractId + '\0' + UTF8(normalizeEOL(decodeTextBuffer(raw))))`；
读取器先按固定 decoder contract 处理 UTF-8、UTF-16LE/BE 与 BOM，再做 EOL 规范化，不对 UTF-16
raw bytes 直接调用字符串规范化。`decoderContractId` 同时进入 cursor/projector/policy identity；
它不依赖 mtime。只要 decoded normalized content 相同，BOM/编码或 EOL-only 变化不使 revision
漂移；规范内容或 decoder contract 变化必须漂移。
`utf8ByteOffsetInLine` 针对 EOL 规范化后、加 `N|` 模型行号前的原始行 UTF-8 bytes；行号/
marker 仍计入最终 model envelope budget。

所有 continuation 必须返回完整
`{lineOffset,utf8ByteOffsetInLine,endLineExclusive,pathDigest,resourceRevision}`，且 cursor 严格向前推进。
正文优先保留安全上限内的完整行；单行本身超过上限时，按合法 UTF-8 边界返回行内片段。path digest 或
resource revision 变化返回有界 `stale_continuation`，不能拼接两个版本。完成窗口内超大的最后允许行后停止，
不得读取 `endLineExclusive` 之外的下一行。

### 4. 模型结果只由 self-contained verified terminal 写入 transcript

所有 Registry builtin、动态 MCP、Runtime action、interaction、Task、Skill、Plan 和 Verification 的模型可见
结果统一经过：

```text
RawToolExecutionResultV2
  -> finalizeProjectedToolResultV2(ResolvedToolResultBudgetV2, call identity, status, raw, provenance)
  -> finalizeToolTerminalEventV2(...)
  -> one self-contained tool terminal event
  -> one reducer transition updates status and appends exactly one Tool Result
```

`finalizeProjectedToolResultV2()` 输出完整 model envelope、`rawResultDigest`、`modelContentDigest`、projector
identity、budget identity 和 continuation receipt。`rawResultDigest` 覆盖 projector 前的 canonical raw bytes；
`modelContentDigest` 精确覆盖最终模型实际看到的 bytes。finalizer 最后一步必须重新序列化并测量完整 UTF-8
model envelope；正文看似在限额内但 envelope 超限时不得落盘。

receipt 显式携带 `projectionMode:'compat_v1'|'budget_v2'`。`budget_v2` 必须携带有限
`ResolvedToolResultBudgetV2` identity；`compat_v1` 携带版本化 V1 compat projector identity 并验证最终
bytes/digest，但不伪造 V2 budget provenance。两者都只能通过同一 terminal constructor 写入
transcript；`legacy_unverified` 永远只属于 cutover 前迁移。

`tool.finished|tool.failed|tool.rejected|tool.cancelled` 的生产 event 必须直接嵌入
`VerifiedToolModelResultV2`，新 terminal event API 只接受 `{kind:'verified_v2', receipt}`。同一个 event 在一次
reducer transition 中完成执行终态和 Tool Result append，不新增可独立持久的
`tool.model_result_finalized` event，因此不存在两次持久之间的崩溃窗口。

这条决定局部取代 ADR-0048 决策 4 的 producer 方式：reducer 不再现场从 error/reason/stdout 拼接未预算
正文，而是验证 terminal 内已经 final 的 receipt 后投影。它也局部取代 ADR-0049 决策 6 中
`approval.rejected` 直接生产 Tool Result 及其批次成员的方式：拒绝 control event 自身不生产正文，
而是与唯一 self-contained rejected/cancelled terminal 同 CAS batch 提交。以下 ADR-0048/0049 边界保留：

- `approval.rejected` 仅验证/清理 interaction 并记录 audit，不修改 tool terminal status、不追加
  Tool Result；紧随其后的 self-contained `tool.rejected` 独占目标 call 的 terminal status 与唯一模型结果；
- 需要收敛 call 的 `provider.action_required`、sandbox elevation/policy rejection 与其他 control producer
  遵守同一所有权；不需终结 call 的纯 control event 不伪造 companion；
- 原子拒绝批次顺序固定为：control event → target self-contained terminal → sibling terminals →
  resource facts →（若 ADR-0049 要求终止 turn）`turn.aborted`；`ask_user` 拒答只到失败 terminal，
  不生成 `turn.aborted`；
- production constructor 只能生成完整、有序 batch；缺 companion、terminal 先于 control、重复 terminal、
  `turn.aborted` 提前或终态冲突都整批 fail closed，不选一个分支继续；

- `tool.cancelled` 仍幂等清理 queue、active、interaction 和 suspended subagent；
- 用户取消多个 call 时，同一 CAS event batch 先提交全部 self-contained `tool.cancelled`，再提交
  `turn.aborted(cause=user)`；
- 整批持久成功后才传播 AbortSignal；
- 已终结 call 不被取消覆盖，late effect 继续由 lease/revision 判 stale；
- live 与 event-log replay 通过同一 reducer 得到相同 tool pairing。

`approval.rejected|provider.action_required` 等 interaction/control event 自身不再生成 transcript 正文。若该
控制事件需要收敛 tool call，Kernel 必须在同一 CAS batch 中加入对应 self-contained tool terminal。对相同
`toolCallId+terminalIdentity` 的重放，verified result 字节相同时去重；result 冲突时整批 fail closed，不能选择
其中一个正文。

Projector 失败必须产生封闭、有界、配对完整的失败 Tool Result。已经发生外部副作用的工具不得因 finalizer
失败被自动重试；pre-L1 raw result 也不得作为 fallback 进入 transcript。

### 5. v2..v21 历史 Tool Result 使用迁移专用 legacy branch

Store load/migration 拥有一个生产 event API 无法构造的分支：

```ts
type SupportedLegacySchemaVersionV22 =
  | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11
  | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;

type MigratedToolModelResultV2 = {
  kind: 'legacy_unverified';
  migratedFromSchemaVersion: SupportedLegacySchemaVersionV22;
  originalEventPosition: number;
};
```

它只允许规范化 migration cutover position 之前已经持久的全部 transcript-producing terminal 变体，包括
finished、failed、rejected、cancelled、approval rejection 和 provider action 历史路径。normalizer 以当前
canonical transcript 中每个 `toolCallId` 的唯一 Tool Result 为准：相同字节的重复结果去重；冲突结果隔离整个
session/checkpoint 并 fail closed；`provider.action_required` 只有在历史确实没有先前结果时才能 backfill。

legacy branch 不伪造 raw digest、V2 receipt 或 budget provenance，不获得 L2 live 或 route qualification。
Kernel 必须拒绝 cutover 后的新 legacy branch 和 original position 越界。任何未来 checkpoint 覆盖到
`legacy_unverified` result 时都必须传播 legacy source identity；具体 checkpoint v2 规则由 ADR-0097 冻结。

### 6. 所有上下文入口共享 pure `prepareContextRequestV2()`

Core 新增唯一上下文编排入口：

```ts
type ContextPreparationPurposeV2 =
  | 'normal'
  | 'context_inspection'
  | 'candidate_validation'
  | 'restore_debug'
  | 'summary_source';

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
```

source identity 与 request identity 不得合并：相同 transcript/policy source 可以为 normal、summary 或
diagnostic 产生不同的 tool schema、prompt parameters、output reservation 和 final payload；dispatch receipt
必须证明精确 request，而不是只证明 source 没变。

`PreparedContextRequestV2` 至少包含：purpose、source identity、request identity、raw projection 与完整
estimate、raw preflight、reclaim application evidence、effective projection 与完整 estimate、effective
preflight、canonical projection identity，以及封闭 `next`。raw/effective artifact 均包含 readonly frames、
provider messages、complete-request estimate、frames digest 和 projection digest。

`next` 的合法集合为：

```text
primary_ready
refill_observation_required
auto_compaction_eligible
summary_ready
summary_input_too_large
cache_parent_incompatible
candidate_ready
candidate_invalid
diagnostic_only
correctness_blocked
```

本 ADR 接受统一 artifact 和 purpose contract；`summary_source`、refill 与 checkpoint-specific next 的 Provider
形态只有 ADR-0097 accepted 后才能启用。当前 purpose 约束为：normal 只产生 primary/auto/refill/correctness；
summary source 只产生 summary ready/typed failure/correctness；candidate validation 只产生 candidate
ready/invalid/correctness；inspection/debug 只产生 diagnostic/correctness。

准备器严格按以下 pure 顺序运行：

1. 在任何 lease、reservation 前解析一次稳定 projection environment、实际 ToolSet/schema 和 purpose-specific
   max output，分别生成 source 与 request identity；
2. 构建 raw canonical frames/messages、完整请求 estimate 和 raw identity；
3. 根据 flags、mode、pressure、checkpoint boundary、durable watermark 和 policy 产生该 purpose 的固定 plan；
4. 应用 plan，重新验证 tool pairing，构建 final projection 和 final estimate；
5. 根据 purpose、final pressure 和 rollout policy 返回 fixed `next`。

离开 builder 前，所有 DTO 使用 canonical serializer 计算 digest 并 deep-freeze；不得向调用方泄露可变
frames/messages/array alias。`prepareContextRequestV2()` 为零持久写、零 effect lease、零 resource
reservation、零 `dispatch_started` 和零 Provider dispatch。inspection、debug、candidate purpose 永远停在 pure
阶段。

`projectionSourceRevision` 是 projection dependency revision，不等于 dispatch 时的全局 Runtime revision。
从 prepare 到 lease 建立前，任何 transcript、turn、checkpoint、ToolSet、projection environment 或 output
limit 变化都使 artifact stale。lease 建立后，只允许该 lease apply path 提交本请求自己的 reservation 和
`dispatch_started` 来推进 expected revision；不能因这些自有事件错误判 source drift。

### 7. Admission 只消费同一 immutable prepared artifact

只有 Provider-ready purpose 可以进入 Core-owned `admitAndDispatchPreparedContextRequestV2()`。其他需要持久化
的 `next` 必须由独立、无 Provider/resource reservation 的 Kernel CAS transition 处理，然后重新运行 pure
prepare；不能把旧 artifact 直接改成 ready。

admit/dispatch 顺序固定为：

1. Kernel 已持有 single-runner ownership，resource waiter 已经获得资格；对 prepared final payload 执行本地
   Provider-data precheck 和 resource precheck。等待事实不创建 `dispatch_started`，waiter 被唤醒后必须重新
   prepare；
2. 在当前 revision 建立 effect lease，通过该 lease 的 Kernel apply path 原子持久 reservation 与
   `resource_budget.dispatch_started`，并推进 lease expected revision；
3. 在 Provider 边界逐项重验 prepared/source/request digest、final payload、ToolSet/schema、所有
   prompt-affecting parameters 和 max output reservation；Provider-data gate 对这份精确 payload 返回最终
   receipt 后，才生成 `AdmittedContextRequestV2`；
4. 重验后立即 dispatch，中间不再持久其他状态，也不重新构建 payload。

admitted receipt 必须绑定 prepared digest、source/request identity、request ID、effect lease、reservation
IDs、admission receipt、final payload digest、final max output 和 final ToolSet schema digest。

只有带现有 `local_provider_admission_denied` proof 的最后一次本地 admission 拒绝可以释放已经 started 的
reservation。started 后崩溃或 outcome 不明时，恢复必须进入 durable `resource_budget.unknown` 和
`unknown_external_outcome`，不得重放 Provider dispatch。

这条所有权遵守 ADR-0091：Model Controller 不能直接写 Store 或 singleton；Kernel 的 effect apply path 是
唯一验证内存 lease/current revision 的层；Store 在一个事务中对 event+snapshot batch 执行 revision CAS。
App Promise barrier 只负责用户交互顺序，不替代 durable lease/CAS。

### 8. L2 Live 继续使用 Foundation 的 fail-closed eligibility

初始 L2 live 正文替换白名单仍固定为 `read_file`、`search_content`、`search_files`。一个完整
`ToolCallBlockFrame` 只有在以下条件全部满足时才可进入 plan：

- block 完整配对、所有结果成功、且不属于当前 active turn；
- 所有 call 都在白名单，effective effect 为 read-only，没有 mutation scope；
- canonical args 和可信 result metadata 能提供稳定 locator；
- `modelContentDigest` provenance 不是 legacy/unknown，且每个 Tool Result receipt 的
  `projectionMode==='budget_v2'`；
- 固定 stub 小于原模型正文，整个 block 的 token saving 为正。

失败/取消、mixed block、legacy metadata、动态 MCP、Shell、Web、Task、Skill、Plan、Verification、write/edit、
approval 和 interaction 保留原正文。L1 对所有工具强制有限预算不等于 L2 获得正文替换资格；扩大 L2 白名单
需要独立 qualification/ADR，不能只改配置。

L2 live 只在以下任一条件成立时规划应用：

- context window 已知且 raw pressure 至少为 warning；
- 用户配置了绝对 `reclaimAfterEstimatedTokens`，raw complete-request estimate 达到阈值。

window unknown 且没有绝对阈值时不运行 pressure-driven live。候选必须同时达到预注册的最小绝对 saving、
最小比例 saving、完整 block 正收益和批量 hysteresis。planner 从 canonical frames 生成固定 plan；applier 必须
重验 raw/applied digests、selected entries、exact stub 和 pairing，不能边扫描边改变选择。

### 9. 每个 purpose 持久表达实际应用，不把计划冒充 watermark

prepared artifact 使用显式判别联合：

```ts
type ReclaimApplicationEvidenceV2 =
  | { kind: 'off'; rawFramesDigest: string }
  | {
      kind: 'applied_commit';
      planDigest: string;
      commitDigest: string;
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
```

`applied_plan` 证明某个 purpose 的 immutable final projection 使用了哪份 plan，以及它基于哪个已提交 prefix；
它不等于 durable watermark。summary、candidate、inspection、debug 或 shadow 的成功都不得晋升该 plan。
`baseCommitDigest` 只有在确实重放父 commit 时填写；没有父 commit 且 raw bytes 正是基线时允许省略，不能伪造
一个空 commit。

### 10. 只有成功 primary request 可以推进稳定 reclaim commit

Runtime schema v22 新增 metadata-only `ContextReclaimCommitV1`：

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

interface ContextReclaimCommitAdvancedEventV1 {
  type: 'context.reclaim_commit_advanced';
  receipt: ContextReclaimAppliedReceiptV1;
}
```

commit/watermark 必须满足：

- 只在完整 settled turn boundary 向前移动，不能回退或跨过 active turn；
- 一次扩展达到固定 batch saving 和 hysteresis；
- 同 policy/cache epoch 下，boundary 之前的 applied prefix bytes 保持稳定；
- 只保存 identity，不保存 tool content、path、args、selected digest 数组或正文；
- 已有 commit 在 live mode 下持续重放，即使当前 pressure 回落；只有扩展需要重新满足 warning/absolute trigger、
  saving 和 hysteresis；
- checkpoint 激活、替换、reset、rewind 或 policy epoch 变化时，按新的 source boundary 清除或重基线，不能让
  旧 prefix identity 穿过 narrative boundary。

Model Controller 只返回可选 proposed commit。Executor 在同一 effect lease 下 dispatch；Provider 成功后，
Kernel 按是否存在 proposed commit 提交封闭判别联合：

```text
no_reclaim_advance:
  model.responded { evidence.reclaimReceiptDigest = 'none' }
  resource_budget.reconciled

reclaim_advanced:
  model.responded { evidence.reclaimReceiptDigest = digest(receipt) }
  context.reclaim_commit_advanced { receipt: ContextReclaimAppliedReceiptV1 }
  resource_budget.reconciled
```

无推进分支固定为两个 event，不构造 receipt、不伪造 proposed commit；推进分支固定为三个
event，commit 只能由 `context.reclaim_commit_advanced.receipt` 推进，不存在第四个独立 commit
写入。v22 新的 primary `model.responded` 必须持久 bounded `ContextPrimaryRequestEvidenceV1`。
每个分支内的 events 使用相同 `terminalBatchId`，并在 event metadata 中共享
`causationId=terminalBatchId` 和连续 revision。

Kernel/replay 的 batch validator 必须在调用 reducer 前验证完整 2/3-event branch。推进分支的 reducer
只接受紧邻、未消费且
`requestId|purpose|effectiveProjectionDigest|requestIdentityDigest|admittedRequestDigest|modelResponseMessageId|`
`terminalBatchId|reclaimReceiptDigest` 逐项匹配的 primary response evidence，再验证 receipt 的 previous
digest、checkpoint、policy/cache epoch 和单调 boundary。standalone、reordered、重复消费、candidate/
summary purpose 或与另一 response 拼接都整批 fail closed。`reclaimReceiptDigest='none'` 后出现 reclaim
event，或非 none 后缺 reclaim event，同样整批失败。临时 pending response evidence 只能存在推进批内
reducer 计算，持久 post-batch snapshot 中必须已消费。纯 reducer 不读取内存 lease。

Provider 已成功但 terminal batch 未提交时保留旧 commit，只牺牲下一轮 cache 命中；不能根据 Provider 调用
可能成功而推断 commit。started 无 terminal 的 attempt 继续按 ADR-0091 和 resource budget 恢复为 unknown，
禁止为补 commit 重放 Provider。

### 11. Cache epoch 只由会改变 prefix bytes 的稳定身份派生

`cacheEpochId` 确定性绑定：

```text
checkpoint identity
+ ToolResultBudgetPolicyV2 identity
+ L2 reclaim policy identity
+ estimator identity
+ ToolSet/schema digest
+ projection contract identity
+ cacheAffectingEnvironmentDigest
```

它不得从进程时间、当前全局 revision 或瞬时 health 状态派生。
`cacheAffectingEnvironmentDigest` 只覆盖会改变可缓存 prefix bytes 的项目/用户/system instructions、active
Skill projection、prompt contract、sandbox/runtime system frames 等环境；单纯 runtime revision、时间、
Provider health 或连接状态不能进入。任一上述稳定身份变化都会使旧 commit 失效并形成显式新 epoch。

L2 不为 cache hit 牺牲正确性：current active turn、commit boundary 后的 live tail、Runtime authority 与所有
fail-closed block 保留原表示。tool call/result 仍作为完整 protocol block，不改写为普通 user message。

### 12. Capacity、Provider error 与失败语义继续服从 ADR-0024

raw/final pressure 只决定是否尝试 L2 或请求后续 L3，不证明 Provider admission。L2 后 final pressure 低于
compact threshold 时进入最终 admission；达到或超过 threshold 但完整 auto gate 不允许时，仍把经过最终
admission 的 effective projection 发送给 Provider，让真实 Provider 决定容量。

以下事实不得创建、保持或刷新 `ContextHardBlock`：

- warning/compact/hard ratio 或 token estimate；
- local output reservation 或 safety-margin 估算失败；
- L2 eligibility、plan、apply 或收益不足；
- Provider overflow、HTTP 400/413、错误字符串或普通 Provider failure；
- compaction failure。

只有 canonical frames/pairing/projection 本身损坏、且所有允许降级都不能安全构造请求时，才能通过现有统一
factory 创建 correctness hard block。单纯 L2 plan/application identity 失败时不发送候选，重新以 raw final
pressure 决定 primary 或后续 L3；raw canonical projection 能安全构造时不能误报 correctness block。

本 ADR 不从 Provider overflow 自动触发 L2/L3，不自动 retry normal request，也不从通用错误推断零 usage 或
未执行。未来 reactive recovery 仍需要独立 ADR。

### 13. Provider data、权限与观测不因正文减少而放宽

Provider-data policy、route classification、consent、authorization、sandbox、tool binding 和 execution effect
均在缩减前后保持原权威。最终 Provider-data gate 必须读取实际 effective payload；不能因为 L2 删除了正文就
降低原数据分类或切换 route。

telemetry 明确区分 `candidate|planned|committed|applied`，只允许固定、聚合字段：policy/schema/mode/cache
epoch、raw/final tokens、saved chars/tokens、candidate/applied block count、pressure、typed rejection、duration、
cache read/create tokens、planner/apply latency、峰值内存和持久 metadata bytes。

metrics、logs、session trace 和 reporter 禁止记录 path、args、call/message ID、digest 值、stub、tool content、
transcript 或 selected entries。shadow reporter 继续是可选注入、bounded、严格 DTO；不能复用会写磁盘的 local
debug reporter。本 ADR 冻结 planner/apply p95、峰值内存和 metadata bytes 上限；实现计划
必须在首个实现结果前复述 fixture 与上限，并在 route evidence 中按相同 policy identity 验证，
不能在结果出来后放宽阈值。

本 ADR 冻结 Slice A 的本地资源上限：在实现结果产生前固定的 2,000 个 settled
tool-call blocks、至少 8 MiB L1 后 canonical model content、10% eligible/90% ineligible mixed
blocks fixture 上，`prepareContextRequestV2()` 的 L2 plan+apply+final-estimate p95 不超过
50 ms；相对 off/raw prepare 的额外 peak heap 不超过 64 MiB；每次成功 primary 新增的
reclaim commit + applied receipt + event identity canonical UTF-8 bytes 不超过 16 KiB；单个
verified terminal 的 metadata（不含 model content）不超过 8 KiB；off 路径 p95 相对冻结基线
回归不超过 5%，payload byte mismatch 为 0。Bun、OS/CPU、warm-up、采样、GC 和 policy
identity 必须进入 evidence identity；不得事后更换 fixture、排除失败样本或放宽上限。

### 14. Runtime schema v22、迁移与 replay

Slice A 把 Runtime schema 从 v21 提升到 v22。v22 至少持久：

- self-contained verified terminal receipt 或 migration-only `legacy_unverified` identity；
- `ContextReclaimCommitV1`；
- primary `model.responded` 的 bounded `ContextPrimaryRequestEvidenceV1` 与 terminal-batch identity；
- `ContextReclaimAppliedReceiptV1` / `context.reclaim_commit_advanced`；
- replay 所需 previous commit、projection、request、policy/cache epoch identities。

迁移顺序固定为：

1. 读取当前可恢复的 legacy schema v2..v21 snapshot，确定 snapshot event position 与本次已观察/
   replay 的 event-log head；
2. 规范化 snapshot 中已有 transcript/tool terminal，`reclaimCommit=none`，现有 checkpoint v1 原样保留；
3. 只对 cutover position 之前的历史 terminal 建立 `legacy_unverified`，不伪造 V2 digest 或 budget receipt；
4. 从 cutover 后按 v22 支持集 replay event tail；无法证明或不支持的新版 event fail closed，不能跳过；
5. migration snapshot 只有在 Kernel/Store CAS 成功后持久，观察历史的只读入口不得产生迁移写入。

Store 必须提供 snapshot-only 事务原语，不得继续使用无条件 `saveSnapshot()`：

```ts
compareAndSaveMigratedSnapshot(
  threadId: string,
  expected: {
    sourceSnapshot: {
      schemaVersion: SupportedLegacySchemaVersionV22; // any integer in [2, 21]
      stateRevision: number;
      snapshotEventPosition: number;
      stateChecksum: string;
    };
    observedEventHead: {
      eventPosition: number;
      revision: number | 'legacy_unknown';
      eventId: string | 'legacy_none';
    };
  },
  nextV22: RuntimeSnapshotV22,
): 'saved' | 'stale';
```

Store 在同一 transaction 中重验 source snapshot 与 observed event head 的全部字段，并只在完全相等时
把 v22 snapshot 写在该 exact observed head。即使 snapshot 未变，并发 append 使 event head 前进也必须返回
`stale`。`stale` 必须丢弃 migration candidate，reload snapshot + replay tail 后重新决定；不能 retry
旧候选或覆盖已前进 snapshot。实现与故障测试必须保留当前 v2、v11、v12、v13、v16、
v17、v18、v20、v21 代表性恢复链，并覆盖“snapshot 不变但 tail head 并发前进”的 slow writer。

迁移不调用 Provider、不重算历史正文、不创建 reclaim commit、不晋升 route qualification。重复 migration/replay
必须幂等；中断 tail、重复 terminal、terminal conflict、snapshot/event cutover、restart、resume、fork、rewind、
reset 和删除后的 stale writer 都需要 contract test。

v22 reader 必须继续读取 v2..v21；一旦写入 v22 terminal/event，v21 binary 不再被假定能够安全 replay。发布与回滚
必须先保证 v22 reader/migration 可用，不能通过忽略未知事件实现二进制降级。

## 所有权摘要

| 组件 | 唯一职责 | 禁止事项 |
| --- | --- | --- |
| ToolSpec/runtime binding Registry | 解析有限 budget、projector、revision 与 binding identity | 不生成 transcript，不根据工具名猜动态 binding |
| Tool executor | 返回 pre-L1 raw result 与可信 provenance | 不自行截断成最终模型 envelope，不写 Runtime |
| L1 finalizer | 生成 bounded verified result、两个 digest 与 continuation receipt | 不执行工具，不因 finalizer 失败重放副作用 |
| Tool terminal constructor | 把 verified result 嵌入一个 self-contained terminal | 不拆成 terminal/model-result 两次持久 |
| reducer | 验证 event、纯更新状态、追加唯一 Tool Result/commit | 不现场构造未预算正文，不读取 lease/singleton |
| request preparer | 纯构建 raw/final artifacts、plan、estimate、identity 与 next | 不建 lease/reservation，不 dispatch |
| Model Controller | 消费 immutable artifact，返回 Provider result/proposed commit | 不重建 payload，不写 Store，不晋升 watermark |
| Executor/Kernel | waiter、lease、最终 admission、dispatch、terminal batch | 不绕过 source/request identity，不盲 replay unknown dispatch |
| RuntimeStore | event+snapshot transaction、revision CAS、durable recovery | 不解释模型正文，不做 last-writer-wins |
| App/TUI | 配置、用户交互与脱敏投影 | 不持有 Core 状态权威，不直接推进 commit |

## 状态机

```text
tool execution
  -> resolve finite budget
  -> finalize complete UTF-8 envelope
  -> self-contained verified terminal
  -> immutable L1-bounded transcript

normal/context/diagnostic input
  -> pure prepare raw projection + complete estimate
  -> off/shadow: raw effective projection
  -> live eligible: fixed plan -> apply -> pairing validation -> final estimate
  -> diagnostic/candidate: return frozen artifact, zero side effect
  -> primary ready: waiter qualified -> precheck -> lease
  -> atomic reservation + dispatch_started
  -> final source/request/provider-data admission
  -> Provider dispatch
  -> primary success without proposed commit: responded + reconciliation atomic pair
  -> primary success with proposed commit: responded + reclaim receipt + reconciliation atomic triplet
  -> failure/unknown: keep previous commit; never infer success or replay blindly
```

## 与既有 ADR 的关系

- **ADR-0024 保留**：local pressure 只触发尝试，不证明 capacity；Provider error 不自动压缩或 hard block。
- **ADR-0048 局部取代**：`tool.cancelled` 等 terminal 不再由 reducer 现场生成模型正文，改为 event 嵌入 verified
  result；原子取消与 AbortSignal 顺序保留。
- **ADR-0049 局部取代并保留其余语义**：决策 6 中 approval control event 的 Tool Result producer/
  批次成员改为 companion terminal；原子拒绝、并发 sibling 取消、turn 收敛、`ask_user`
  continuation 与实时/replay 一致性保留。
- **ADR-0057 保留并待扩展**：本 ADR 只提供开发实现契约，不自动授予真实 route qualification。
- **ADR-0090 保留**：stale environment、无新 source、低收益和 terminal convergence 语义不变。
- **ADR-0091 保留**：effect lease、Kernel ownership、Store revision CAS 与 unknown outcome 是唯一并发/恢复边界。
- **ADR-0095 扩展**：Foundation 的 off/shadow、纯 planner/applier、白名单和正文隐私边界不被改写；本 ADR
  只新增 V2/live/commit。

## 明确排除与延期

本 ADR 不授权：

- L3 summary source 消费 L2、checkpoint v2、SourceManifest 或 schema v23；
- cache-safe summary fork、durable rapid-refill guard 或完整三级 auto route；
- L2 扩大到动态 MCP、Shell、Web、Task、Skill、Plan、Verification、effectful 或 mixed tool block；
- message-count snip、自然语言历史 head/tail 删除、chunk/merge、渐进 summary 或第二份 fact ledger；
- tool raw-content artifact store、跨 session retrieval、自动重读或 model-visible recovery hint；
- Provider `cache_edits` 或通用 Provider overflow 后的自动压缩/retry；
- default-on、production-supported 或所有 Provider 等价声明。

上述 L3 与 route qualification 由 ADR-0097/后续准入 ADR 决定；不能通过放宽 flag、schema 或 adapter 配置
静默获得授权。

## 备选方案

### 保留分散的 V1 工具限额

拒绝。它不能证明所有 transcript-producing terminal 都经过同一 UTF-8 envelope 上限，新增 dynamic binding、
interaction 或 recovery producer 仍可绕过。

### terminal 与 model result 使用两个独立事件

拒绝。即使 reducer 要求最终成对，两次持久之间仍存在 crash window，scheduler/replay 也可能先观察到已经
settled 但没有 Tool Result 的 call。self-contained terminal 能直接复用现有单 event 与 batch CAS。

### 继续由 reducer 根据 stdout/error/reason 构造 Tool Result

拒绝。reducer 不拥有 ToolSpec/runtime binding budget，也无法可靠证明 raw/model digest、UTF-8 envelope 或
continuation provenance；历史 reducer 分支还是绕过 finalizer 的入口。

### 在 Model Controller、`/context` 和 compactor 中分别应用 L2

拒绝。多入口会产生不同 plan、estimate、payload 和 admission bytes，无法建立同一 source/request identity，
也不能可靠判 stale。

### 先对 raw projection reservation，再在 dispatch 前缩减

拒绝。reservation、Provider-data policy 和实际 payload 不一致；如果反过来临时重算 reservation，又会引入
TOCTOU 与重复 dispatch。

### 每轮重新选择旧工具结果，不持久 commit

拒绝。结果虽然可能语义相同，但 prefix bytes/boundary 会移动，持续破坏 prompt cache，且无法证明 Provider
实际使用过哪份 representation。

### summary/candidate 成功也晋升 watermark

拒绝。purpose 的 payload 与 normal primary request 不同；非 primary 成功不能证明后续普通请求使用了该 prefix。

### final estimate 超阈值时本地阻断

拒绝。违反 ADR-0024；estimate/ratio 不是 Provider admission 事实。

### 将 v2..v21 历史结果补写成 verified V2

拒绝。旧事件没有 raw digest、binding revision 或 V2 receipt，补写会伪造 provenance 和 route qualification。

## 后果

### 正面

- 所有 production tool model result 获得统一、有限、版本化的 L1 choke point；
- tool terminal 与模型结果在一个 event 内收敛，消除新增双事件 orphan crash window；
- raw/final projection、resource reservation、Provider-data gate 和 Provider invoke 消费同一 immutable artifact；
- source identity 与 request identity 分离，purpose/output/tool-schema drift 可以精确 fail closed；
- L2 首次可以实际减少符合资格的旧工具正文，同时保持原 transcript 与 tool pairing；
- primary-only commit 和 cache epoch 让 reclaimed prefix 跨轮稳定，并可在 restart/replay 中审计；
- v2..v21 历史不被伪造成 V2，迁移和 route qualification 保持保守。

### 负面

- 所有 ToolSpec、dynamic binding、terminal producer、migration 和 golden 都要升级，实施面较大；
- event/snapshot 增加 receipt、commit 和 identity metadata；
- UTF-8 envelope finalizer 与 line-byte cursor 增加序列化和 continuation 复杂度；
- live planner/apply/final estimate 会增加每次请求的本地延迟和峰值内存；
- V2 已截断正文不可通过关 flag 恢复，必要信息仍需用户/模型显式重读；
- v22 写入后不能假设旧 v21 binary 可安全读取。

## 验收门禁

ADR accepted 和实现计划 active 之后，Slice A 仍必须同时通过以下门禁才能称为开发可用；任一失败都保持
新路径默认关闭。

### G0：L1 完整性与 replay

1. Registry conformance 枚举全部 production builtin、MCP runtime binding、Runtime action、interaction、
   Task/Skill/Plan/Verification result；缺少/未知/非有限 budget 为零漏网。
2. Shell/Search 兼容 golden、MCP V2 off 兼容 golden 和 V2 UTF-8 complete-envelope 上限全绿；structured
   output 截断后仍为合法结构。
3. `read_file` 覆盖首次 offset/limit、limit 省略、跨多次 continuation、UTF-8 多字节边界、超大单行、最后
   允许行、stale path/revision、cursor 单调前进、UTF-16LE/BE BOM、BOM/编码切换、非法
   UTF-8/force 与 EOL-only 变化。
4. finished/failed/rejected/cancelled 每个 terminal 自包含唯一 verified result；approval/provider action companion
   terminal、control-only 与 terminal-only 所有权、合法/非法批内顺序、多 sibling cancellation、
   `turn.aborted` 顺序、persist-before-AbortSignal、重复 replay 与 conflict quarantine 全绿。
5. v2..v21 所有历史 transcript-producing terminal 变体只在 cutover 前生成 `legacy_unverified`；生产 event API
   无法构造 legacy branch，且 legacy 永不获得 live/route 资格。
6. tool call/result orphan、重复、错配为零；live 与 replay transcript 字节一致。

### G1：Pure prepare 与 final admission

1. normal、preflight、`/context`、candidate、restore/debug 使用同一 prepared artifact 和 projection policy
   identity；artifact canonical digest 稳定且 deep-freeze 后无法通过 alias 修改。
2. 所有 diagnostic/candidate purpose 的 lease、reservation、`dispatch_started` 与 Provider dispatch 均为零。
3. source dependency、purpose、ToolSet/schema、prompt parameters、max output 或 final payload 任一 drift 都在
   Provider socket 前 fail closed 为 stale，不发送旧 artifact。
4. resource waiter 未获得资格时不创建 started fact；唤醒后重新 prepare。reservation 与
   `dispatch_started` 同 lease 原子提交，最终 Provider-data gate 读取实际 effective payload。
5. `local_provider_admission_denied` proof、started crash、unknown recovery、restart 与重复 apply 都不产生重复
   Provider dispatch；Store revision conflict 不能覆盖新 snapshot。

### G2：L2 Live、watermark 与 cache epoch

1. `toolResultBudgetV2=false` 且 L2 off 时，现有 main Provider payload byte golden 不变；shadow 不写 Runtime、
   不改 payload、不调用额外模型。
2. live 只替换完整、settled、read-only、白名单 block；current turn、mixed、failed、legacy、effectful 和未知
   block 保持原正文并维持 pairing。
3. plan/applier 的 raw/applied/selected identity、重复 apply 幂等、拒绝顺序、最小绝对/比例 saving、完整 block
   正收益和 hysteresis 均有 deterministic golden。
4. `applied_plan` 在 summary/candidate/diagnostic/shadow success 后不产生 commit；只有使用 exact projection 的
   primary `model.responded` 原子 batch 推进 watermark。
5. commit boundary 只在 settled turn 上单调前移；低 pressure 时稳定重放，扩展才重新触发门禁。
6. checkpoint、L1/L2 policy、estimator、ToolSet/schema、projection contract 或 cache-affecting environment 变化
   必须形成新 epoch 并使旧 commit 失效/重基线；单纯 revision/时间不改变 epoch。
7. restart/resume/fork/reset/rewind 在同一 identity 下重建相同 effective projection；Provider 成功但 commit
   batch 丢失只保留旧 watermark，不补写、不重放请求。

### G3：Failure、capacity、迁移与隐私

1. L2 plan/application identity 失败不发送候选；raw canonical projection 安全时继续走 final pressure，只有
   pairing/projection correctness 损坏才 hard block。
2. window unknown、local ratio/output estimate、Provider HTTP 400/413/overflow/error 均不创建 capacity hard
   block、不自动 L2/L3、不自动 retry。
3. v2..v21→v22 snapshot、snapshot+tail、重复 migration、中断 tail、legacy terminal conflict、v1 checkpoint、
   pending Runtime effect、restart/fork/rewind/reset 和 stale writer 矩阵全绿；migration Provider call count 为零。
4. metrics/reporter/session trace 的 path、args、IDs、digest values、stub、tool content 和 transcript 泄漏为零。
5. planner/apply p95、峰值内存与 metadata bytes 不超过本 ADR 冻结、实现计划复述的上限；off path 性能和 payload golden 无
   非预期回归。
6. Core 新实现不依赖 App/TUI 类型；相关 typecheck、unit、Runtime E2E、Store fault/replay、tool conformance、
   documentation impact 和真实 route shadow/live evidence 门禁通过。

## 回滚

行为回滚按以下顺序执行：

1. 把 `reclaimMode` 设为 `off` 或关闭 `contextReclaimV1`，立即停止新的 L2 planning/application，并从不可变
   L1 transcript 构建 raw projection；已有 commit 保留为 metadata 但不应用、不推进。
2. 关闭 `toolResultBudgetV2`，后续工具在同一 finalizer/self-contained terminal 上选择
   `compat_v1` projector；不恢复 reducer 正文 producer。已经持久的 verified V2 terminal 和已经截断的
   model result 保持可 replay，不能从 pre-L1 raw result 猜测或恢复正文。
3. 保留 v22 reader、event union、migration normalizer 和 commit/receipt 字段，即使所有新行为 flag 已关闭；
   删除 reader 或忽略未知 event 会破坏 restart/replay，不属于安全回滚。
4. 二进制回退到只理解 v21 的版本不被视为支持路径。若发布系统必须执行旧二进制回退，只能使用升级前的
   完整数据库备份或单独、经验证的离线降级工具；不得就地删 v22 event、伪造 v21 snapshot 或回卷 revision。
5. 回滚不得恢复 reducer 解析正文/现场生成无预算 Tool Result、拆分 terminal/model result、ratio capacity
   hard block、Provider overflow auto retry，或把 legacy 结果提升为 verified。

如果回滚仍不能安全构造 canonical raw projection，使用现有 Runtime correctness hard-block/recovery 路径；
不得以删除 transcript、checkpoint、event 或 commit 历史换取继续运行。
