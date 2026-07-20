# 上下文压缩生产化优化方案

创建日期：2026-07-20
状态：draft
优先级：P0
依赖：`docs/space/plans/2026-07-20-context-compaction-refinement.md`（V2 精化方案）
关联 ADR：`docs/adr/0021-context-compaction-checkpoint.md`（accepted，2026-07-20 修订）
基线提交：`771babf2873188134c62aad066291f3e7cb660d6`（`compact` 分支）

## 概要

本方案以 `compact` 分支最新提交 `771babf` 为基线，目标是把当前 `compact` 分支从"手动可灰度"推进到"自动压缩可默认开启"。该提交已完善 `/compact` 命令持久化、会话切换后 stale closure 和失败结果重放。

现有架构继续保留：canonical context frames、M1 确定性工具折叠、M2 structured summary、durable checkpoint、Runtime event/effect/reducer、自动与手动压缩统一管线、checkpoint summary 作为低权限 assistant history。

本轮优化不重新设计压缩系统，改为修复以下生产阻断项：

| # | 阻断项 | 严重程度 |
|---|--------|----------|
| 1 | durable event 中保存了非 JSON-safe ToolSet | 高 |
| 2 | 增量 merge 可丢失旧 mandatory facts | 高 |
| 3 | ledger 混入 covered range 外的 RuntimeState | 高 |
| 4 | summary evidence 校验不足 | 高 |
| 5 | soft failure 可能错误触发 hard block | 高 |
| 6 | thrash breaker 没有真正接入 reducer | 高 |
| 7 | repeated provider overflow 不持久阻断 | 高 |
| 8 | before/after projection 环境不一致 | 中 |
| 9 | legacy turn migration、raw digest 和工具 schema token 链路未闭环 | 中 |

---

## 1. 最终设计原则

所有改动遵守以下约束：

```text
Transcript
  = 不可变事实历史

RuntimeState
  = 当前运行状态唯一权威

Checkpoint
  = 经过验证的历史派生投影

ContextProjectionEnvironment
  = 当前一次模型请求所需的可重建环境

Provider Request
  = 当前 checkpoint + live tail + runtime state 的临时组合
```

**绝对禁止：**

```text
把 ToolSet、函数、closure、Zod runtime object 写进 RuntimeEvent
把当前 plan/verification/task status 写进历史 summary
把旧 summary 仅靠 prompt 指令"尽量保留"
依赖模型自行维护 mandatory facts
用不同输入构建 before 和 after token estimate
```

---

## 2. PR 1：清理 durable event 中的 ToolSet

### 2.1 当前问题

自动压缩请求当前把完整工具对象写入事件：

```ts
tools: tools as unknown as Record<string, unknown>
```

该字段随后进入 `PendingContextCompaction` 和 RuntimeState。

ToolSet 可能包含 `execute` 函数、Zod schema 实例、provider adapter 对象、closure、非稳定 prototype、无法 JSON replay 的成员。这是 event sourcing 边界错误。

### 2.2 目标方案

从 `PendingContextCompaction` 删除：

```ts
tools?: Record<string, unknown>;
```

新增纯数据类型：

```ts
export interface SerializedToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
  schemaDigest: string;
}
```

引入统一环境解析器：

```ts
export interface ContextProjectionEnvironment {
  providerTools: ToolSet;
  serializedTools: SerializedToolDescriptor[];
  activeSkillInstructions?: string;
  workflowSkills: Array<{
    capabilityId: string;
    description: string;
  }>;
  modelCapabilities: ResolvedModelCapabilities;
  policy: ResolvedContextPolicy;
}
```

```ts
export async function resolveContextProjectionEnvironment(input: {
  state: Readonly<RuntimeState>;
  config: AgentConfig;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
}): Promise<ContextProjectionEnvironment>;
```

正常模型调用和 compaction effect 都调用该解析器。

### 2.3 RuntimeEvent 改造

`context.compaction_requested` 只保留稳定事实：

```ts
interface ContextCompactionRequestedEvent {
  type: 'context.compaction_requested';
  compactionId: string;
  reason: ContextCompactionReason;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  force: boolean;
  estimate: ContextTokenEstimate;
  customInstructions?: string;
  projectionEnvironmentDigest?: string;
}
```

`projectionEnvironmentDigest` 仅用于诊断，不作为执行数据源。

### 2.4 需要修改的文件

```text
src/core/runtime/context-compaction.ts
src/core/runtime/events.ts
src/core/runtime/reducer.ts
src/core/controllers/model-controller.ts
src/core/runtime/executor.ts
src/core/model/context-projection.ts
src/core/model/context-budget.ts
```

### 2.5 测试

新增断言：

```ts
expect(() => JSON.stringify(event)).not.toThrow();
expect(JSON.parse(JSON.stringify(event))).toEqual(event);
```

覆盖：内置工具、MCP 工具、Zod schema、session restart、pending compaction replay、manual compaction、automatic compaction。

### 2.6 验收标准

```text
RuntimeEvent 和 RuntimeState 中不存在函数
不存在 ToolSet
不存在 Zod 实例
不存在 provider adapter runtime object
replay 后 candidate projection 与原执行路径一致
```

---

## 3. PR 2：修复增量 checkpoint 的 mandatory fact 继承

### 3.1 当前问题

当前增量流程使用：

```text
baseSummary + 新 tail + 新 tail ledger → 新 summary
```

但 mandatory validation 只检查新 tail ledger，旧 summary 中的用户约束、决定和副作用可以在 merge 时被模型删除。

### 3.2 新增 BaseSummary Ledger

```ts
export function buildLedgerFromBaseSummary(
  summary: StructuredContextSummaryV2,
): DeterministicFactLedger;
```

映射规则：

| Base summary 字段  | Ledger kind     | mandatory |
| ------------------- | --------------- | --------- |
| objective           | objective       | true      |
| userConstraints     | user_constraint | true      |
| decisions           | decision        | true      |
| completedEffects    | completed_work  | true      |
| failures            | failure         | true      |
| pendingWork         | pending_work    | true      |
| observations        | observation     | 条件保留  |
| userRequests        | user_request    | true      |

`CompactionFactKind` 扩展：

```ts
type CompactionFactKind =
  | 'objective'
  | 'user_request'
  | 'user_constraint'
  | 'decision'
  | 'completed_work'
  | 'observation'
  | 'failure'
  | 'pending_work';
```

### 3.3 合并 Ledger

```ts
export function mergeCompactionLedgers(
  base: DeterministicFactLedger | undefined,
  tail: DeterministicFactLedger,
): DeterministicFactLedger {
  return {
    objective: tail.objective || base?.objective || '',
    facts: mergeFactsById(base?.facts ?? [], tail.facts),
    mandatoryFactIds: unique([
      ...(base?.mandatoryFactIds ?? []),
      ...tail.mandatoryFactIds,
    ]),
    coveredUserMessageIds: unique([
      ...(base?.coveredUserMessageIds ?? []),
      ...tail.coveredUserMessageIds,
    ]),
  };
}
```

覆盖规则：

- 同 factId 的新 tail fact 可更新旧 fact；
- completed effect、failure、user constraint 不允许无原因删除；
- observation 只有被明确 invalidation 时允许删除；
- pending work 可以在新 tail 明确完成后转为 completed effect；
- 旧 fact 的 immutable 字段不得被模型修改。

### 3.4 修复 sourceDigest

当前 source digest 使用字符串拼接会无限增长，改为固定长度 hash：

```ts
function nextCompactionSourceDigest(input: {
  baseDigest?: string;
  tailDigest: string;
  policyVersion: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseDigest: input.baseDigest ?? null,
        tailDigest: input.tailDigest,
        policyVersion: input.policyVersion,
      }),
    )
    .digest('hex');
}
```

### 3.5 provenance

V2 provenance 改为：

```ts
interface SummaryProvenanceV2 {
  baseCheckpointId?: string;
  firstTailMessageId?: string;
  lastMessageId: string;
  sourceDigest: string;

  coveredUserMessageIds: string[];
  mandatoryFactIds: string[];

  inheritedMandatoryFactIds: string[];
  tailMandatoryFactIds: string[];

  policyVersion: string;
}
```

### 3.6 禁止 V1 fallback

当前新生成 summary 仍允许回退到 V1 并跳过 user coverage。拆分为两个解析路径：

`parsePersistedCheckpointSummary()` — 允许 V1/V2，仅用于 restore 和 migration。

`parseGeneratedSummaryCandidate()` — 只允许 V2。

### 3.7 测试

必须覆盖：

```text
checkpoint 1: 用户要求永远不要修改 package-lock.json
checkpoint 2: 只有新 tail，没有再次提到该约束
期望: 新 summary 仍保留该约束
```

以及：

- 旧 completed effect 不能消失；
- 旧 failure 不能消失；
- observation 被 write invalidation 后可以消失；
- sourceDigest 始终固定长度；
- 连续 20 次 compaction digest 不增长；
- V1 provider output 被新生成路径拒绝；
- 旧 V1 checkpoint 仍能恢复并在下一次压缩升级为 V2。

---

## 4. PR 3：重构 Deterministic Fact Ledger

### 4.1 当前问题

ledger 遍历全部 verification records、capability invocations、task plan history，部分 fact 没有 evidence 却被标记为 mandatory。同时 objective 文本可能来自 active task，但 evidence 来自 covered range 的另一个用户消息。

### 4.2 Ledger 只接受 CoveredContext

新增输入类型：

```ts
interface CoveredContext {
  messages: TranscriptMessage[];
  messageIds: Set<string>;
  toolCallIds: Set<string>;
  turnIds: Set<string>;
}
```

```ts
function buildCoveredContext(messages: TranscriptMessage[]): CoveredContext;
```

所有 fact 必须满足：

```ts
fact.evidenceMessageIds.length > 0;
fact.evidenceMessageIds.every(id => covered.messageIds.has(id));
```

没有 evidence 的 fact 不允许进入 ledger。

### 4.3 Objective

objective 只能从 covered messages 中获得：

```ts
const firstUser = coveredMessages.find(
  (message): message is UserTranscriptMessage =>
    message.kind === 'user',
);

const objective = firstUser?.content ?? '';
```

当前 task goal 继续由 dynamic Runtime projection 注入，不进入历史 summary。

### 4.4 删除当前状态扫描

删除以下模式的遍历：

```ts
for (const record of Object.values(state.verification.records))
for (const invocation of Object.values(state.capabilities.invocations))
for (const task of Object.values(state.tasks))
```

替代为 transcript evidence 映射：只有当某个 verification/capability/plan 结果已形成 covered transcript message，才允许从该 message 或关联 tool result 构建 fact。

### 4.5 用户消息覆盖

不再依赖关键词识别 constraint。所有 user message 都必须至少生成一个基础 `user_request` fact：

```ts
for (const message of coveredMessages) {
  if (message.kind !== 'user') continue;

  facts.push({
    factId: factId('user_request', message.messageId),
    kind: 'user_request',
    text: message.content.slice(0, 2_000),
    mandatory: true,
    evidenceMessageIds: [message.messageId],
  });
}
```

模型可将其归纳到 objective、userRequests、userConstraints、decisions、pendingWork、unresolvedQuestions，但不能完全省略。

### 4.6 Completed Work

保持正确的新逻辑：

```ts
const isCompletedEffect =
  call.status === 'succeeded' &&
  (
    call.effectClass === 'workspace_write' ||
    call.effectClass === 'external_side_effect' ||
    call.sideEffect === true
  );
```

补充要求：

- `unknown + sideEffect=false` 不算 completed work；
- `unknown + sideEffect=true` 算 completed effect，但标记 uncertain classification；
- `plan_only` 不算 completed external effect。

---

## 5. PR 4：统一资源观察和失效模型

### 5.1 当前问题

M1 已考虑 mutation generation，但 M2 ledger 的 observation 只按 resource 覆盖最后一个 tool message，可能把 edit diff、write 输出或旧 read 当成当前观察。

### 5.2 提取 ResourceObservationTracker

```ts
export interface ResourceObservation {
  toolCallId: string;
  messageId: string;
  resource: string;
  revision?: string;
  rawDigest?: string;
  modelDigest?: string;
  truncated: boolean;
  effectClass: ToolEffectClass;
}

export class ResourceObservationTracker {
  private globalGeneration = 0;
  private pathGenerations = new Map<string, number>();
  private observations = new Map<string, ResourceObservation>();

  applyToolResult(input: ToolObservationInput): void;
  invalidatePath(path: string): void;
  invalidateWorkspace(): void;
  latestReliable(resource: string): ResourceObservation | undefined;
  allReliable(): ResourceObservation[];
}
```

### 5.3 规则

**Read observation：** 只有同时满足 `status = succeeded`、`effectClass = read_only`、resource path 存在、`truncated = false`、`rawDigest` 或 `resourceRevision` 存在、`digestScope != legacy_unknown` 才可进入可靠 observation。

**Workspace mutation：** `workspace_write + workspaceMutationScope` → invalidate 对应 path；`workspace_write` 无 scope → invalidate workspace；unknown side effect → invalidate workspace。

**Search：** search 是查询观察，不是资源版本观察，不能和 file revision observation 共用 resource key：

```ts
interface SearchObservation {
  query: string;
  scope?: string;
  matchCount: number;
  topMatches: string[];
  rawDigest?: string;
}
```

### 5.4 M1/M2 共用

替换 M1 当前局部 generation 逻辑：

```ts
const tracker = buildResourceObservationTracker(frames);
```

- M1 用它判断能否 fold；
- M2 用它生成 latest reliable observations。

### 5.5 测试

```text
read A → read A        → 第一条可 fold
read A → write A       → read A 不可作为当前 observation
read A → write A → read A → 只保留最后一次 read
read A truncated → read A full → truncated read 可 fold
read A full → write unknown workspace mutation → 所有旧 observation 失效
```

---

## 6. PR 5：强化 Summary Validation

### 6.1 当前问题

当前 validation 验证 schema、provenance digest、mandatory fact ID 出现、user message 被引用，但尚未验证：

- evidence ID 是否真实；
- evidence 是否在 covered range；
- factId 是否属于 ledger；
- path/digest/revision 是否被模型修改；
- optional fact 是否为模型虚构。

### 6.2 ValidationContext

```ts
interface SummaryValidationContext {
  coveredMessageIds: Set<string>;
  ledgerById: Map<string, CompactionFact>;
  mandatoryFactIds: Set<string>;
  expectedProvenance: ExpectedSummaryProvenance;
}
```

### 6.3 Evidence validation

```ts
function validateEvidenceIds(
  ids: string[],
  context: SummaryValidationContext,
): void {
  for (const id of ids) {
    if (!context.coveredMessageIds.has(id)) {
      throw new ContextCompactionValidationError(
        'invalid_evidence',
        `Evidence message ${id} is outside the compacted source.`,
      );
    }
  }
}
```

所有 summary entry 都执行。

### 6.4 Fact ID validation

```ts
function validateFactReference(
  factId: string,
  entry: SummaryEntry,
  context: SummaryValidationContext,
): void {
  const ledgerFact = context.ledgerById.get(factId);
  if (!ledgerFact) {
    throw new ContextCompactionValidationError(
      'invalid_evidence',
      `Summary invented fact ID ${factId}.`,
    );
  }

  validateImmutableFactFields(entry, ledgerFact);
}
```

### 6.5 Immutable fields

必须完全匹配 ledger：

```text
factId / path / resource / revision / digest / 操作成功/失败类型
```

模型只允许改写 narrative text、rationale、concise outcome wording、key facts 的自然语言表达。

模型不能改写文件路径、digest、revision、effect 成功状态、error 分类。

### 6.6 Optional facts

允许模型补充非 mandatory fact，但必须：

```text
有 covered evidence
factId 由 deterministic extractor 生成
或明确标记为 narrative-only，不进入 durable fact section
```

生产规则：durable structured sections 只允许 ledger fact，模型自由归纳内容仅进入 narrative 字段。

### 6.7 Error 类型扩展

```ts
type ContextCompactionErrorKind =
  | 'unsafe_boundary'
  | 'summary_model_failed'
  | 'invalid_schema'
  | 'invalid_provenance'
  | 'invalid_evidence'
  | 'missing_user_coverage'
  | 'missing_mandatory_facts'
  | 'insufficient_reduction'
  | 'stale_source';
```

---

## 7. PR 6：修复 Hard Block 和 Thrash State Machine

### 7.1 Soft failure 不得 hard-block

当前 reducer 对任何 `insufficient_reduction` 都可能建立 hard block。改为：

```ts
const shouldHardBlock =
  reason === 'auto_hard' ||
  reason === 'overflow_recovery';
```

状态行为表：

| 原因                | insufficient reduction 行为       |
| ------------------- | --------------------------------- |
| manual              | 返回失败，不 block                |
| auto_soft           | cooldown + low-gain 计数，继续运行 |
| auto_hard           | durable hard block                |
| overflow_recovery   | durable hard block                |

### 7.2 接入统一 Thrash Helper

当前 helper 已实现频率窗口和快速 refill，但 reducer 没有使用。completed reducer 改为：

```ts
const isAutomatic =
  checkpoint.reason === 'auto_soft' ||
  checkpoint.reason === 'auto_hard';

const autoGuard =
  checkpoint.reason === 'manual'
    ? updateAutoCompactionGuard(
        state.context.autoGuard,
        { kind: 'manual_reset' },
      )
    : isAutomatic
      ? updateAutoCompactionGuard(
          state.context.autoGuard,
          {
            kind: 'completed',
            turnIndex: state.turn.turnIndex,
            reductionRatio,
            tokensAfter: checkpoint.inputTokensAfter,
          },
        )
      : state.context.autoGuard;
```

注意：manual success 可以解除 breaker；manual compaction 不计入 automatic history；overflow recovery 不计入 proactive auto history；auto success 不能无条件清除 breaker。

### 7.3 Refill 判定

当前快速 refill 只比较两个 compaction 的 turn index。新增 record：

```ts
interface AutoCompactionRecord {
  turnIndex: number;
  tokensAfter: number;
  targetTokens: number;
  reductionRatio: number;
}
```

下一次进入 `compact_due` 时判断：

```ts
const last = recentAutomaticCompactions.at(-1);

const refilledFast =
  last &&
  currentTurnIndex - last.turnIndex <= 1 &&
  currentInputTokens >= compactThresholdTokens;
```

### 7.4 Repeated overflow durable block

当前第二次 provider overflow 只抛普通 Error。新增事件：

```ts
interface ContextHardBlockedEvent {
  type: 'context.hard_blocked';
  reason: 'overflow_recovery_failed' | 'hard_limit';
  sourceDigest: string;
  message: string;
  createdAtTurnId: string;
}
```

第二次 overflow 返回：

```ts
return [
  contextMetricsEvent,
  {
    type: 'context.hard_blocked',
    reason: 'overflow_recovery_failed',
    sourceDigest: currentSourceDigest,
    message: 'Provider context overflow persisted after compaction recovery.',
    createdAtTurnId: state.turn.turnId,
  },
];
```

scheduler 继续根据 `state.context.hardBlock` fail closed。

### 7.5 `/compact reset` 不能随意解除 unrelated hard block

reset 只清除由 active checkpoint 引起且 reset preflight 安全的 hard block。`overflow_recovery_failed` 不应通过简单 reset 自动解除，除非 reset 后重新 preflight 已低于 hard threshold。

### 7.6 测试

- auto_soft low gain 不 block；
- auto_hard low gain block；
- manual low gain 不 block；
- successful auto 不错误清除 breaker；
- manual success 清除 breaker；
- 3 次/10 turn 自动压缩触发 pause；
- 1 turn 内 refill 触发 pause；
- repeated overflow 写入 durable hard block；
- restart 后 hard block 仍存在。

---

## 8. PR 7：统一 Before/After Projection 和 Token Budget

### 8.1 当前问题

正常调用和 candidate projection 使用的输入不同：正常调用包含 tools、active skill instructions、workflow skills，candidate projection 缺少部分环境。

此外：production M1 recentTurns 仍硬编码 3；target 仍按 `inputTokensBefore * ratio`；providerSafetyRatio 配置没有真正生效。

### 8.2 统一入口

```ts
function buildContextProjection(input: {
  state: Readonly<RuntimeState>;
  environment: ContextProjectionEnvironment;
  candidateCheckpoint?: ContextCompactionCheckpoint;
}): ContextProjection;
```

禁止单独传 `tools`、`skills`、`workflowSkills`、`recentTurns`，统一放入 environment。

### 8.3 Compaction Effect 执行流程

```ts
const environment =
  await resolveContextProjectionEnvironment(...);

const beforeProjection = buildContextProjection({
  state,
  environment,
});

const beforePreflight = preflightModelContext({
  estimate: beforeProjection.estimate,
  capabilities: environment.modelCapabilities,
  policy: environment.policy,
});

const summary = await generateSummary(...);

const candidateProjection = buildContextProjection({
  state,
  environment,
  candidateCheckpoint,
});

const afterPreflight = preflightModelContext({
  estimate: candidateProjection.estimate,
  capabilities: environment.modelCapabilities,
  policy: environment.policy,
});
```

### 8.4 Target

自动压缩 target 使用 `beforePreflight.targetTokens`（即 `usableInputTokens * targetRatio`），而非 `inputTokensBefore * targetRatio`。

### 8.5 Manual before estimate

手动 `/compact` 事件中的 estimate 只用于 UI。真正校验必须以 effect 开始时重新构建的 before projection 为准。

### 8.6 Provider safety ratio

```ts
const safetyRatio = providerSafetyRatio ?? 0.02;

const providerSafetyMarginTokens = Math.max(
  1_024,
  Math.floor(contextWindowTokens * safetyRatio),
);
```

### 8.7 工具 schema token

当前 estimator 对 runtime tool object 做 JSON stringify。改为基于 descriptor：

```ts
function toolSchemaTokens(
  descriptors: SerializedToolDescriptor[],
): number {
  return countTokens(
    JSON.stringify(
      descriptors.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ),
  );
}
```

该 descriptor 必须和 provider adapter 实际发送的 schema 来自同一个 serializer。

### 8.8 配置命名迁移

将 `softRatio` 迁移为 `compactRatio`，兼容读取旧字段：

```ts
compactRatio:
  config.compaction?.compactRatio ??
  config.compaction?.softRatio ??
  0.88;
```

文档和 UI 不再使用 soft。

---

## 9. PR 8：补齐 Legacy Migration 和 Digest 数据链

### 9.1 Legacy turn migration

`recoverLegacySyntheticTurns()` 已存在但 migration 把缺失 turnId 的消息统一赋值为当前 turn。改为：

```ts
const normalizedMessages =
  recoverLegacySyntheticTurns(
    state.transcript?.messages ?? [],
    stableThreadHash(state.session.threadId),
  );
```

然后再补 ordinal 和 createdAt。注意：`legacy-preamble-*` 永久保护；每个 user message 开始新 synthetic turn；已有 turnId 不覆盖；messageId 稳定；replay 结果确定性一致。

### 9.2 Raw digest 生产链

ToolResultMeta 类型已增加 raw/model digest，但生产路径未完成。工具执行流程改为：

```ts
const rawStdout = result.stdout ?? '';
const rawStderr = result.stderr ?? '';

const rawResultDigest = digest(
  JSON.stringify({
    stdout: rawStdout,
    stderr: rawStderr,
    exitCode: result.exitCode,
    status: result.status,
  }),
);

const projectedStdout = truncateToolOutput(rawStdout);
const projectedStderr = truncateToolOutput(rawStderr);

const modelContentDigest = digest(
  JSON.stringify({
    stdout: projectedStdout,
    stderr: projectedStderr,
  }),
);
```

写入 `resultMeta` 时附带 `rawResultDigest`、`modelContentDigest`、`digestScope: 'raw'`。Legacy 标记为 `digestScope: 'legacy_unknown'`。

### 9.3 M1 使用 raw digest

```ts
const reliableDigest =
  meta.rawResultDigest ??
  (
    meta.digestScope === 'projected'
      ? meta.modelContentDigest
      : undefined
  );
```

重复读取和 duplicate output 优先用 raw digest。禁止对 `legacy_unknown` 做 dedup/fold。

---

## 10. PR 9：接入 `/context` 和 `/compact reset`

### 10.1 当前状态

Core 已实现 `buildContextStatusReport()` 和 `compactResetPreflight()`，但 slash parser 尚未接入。

### 10.2 命令语义

```text
/context
/compact
/compact focus on auth changes
/compact reset
```

Parser：

```ts
case 'context':
  return { type: 'context' };

case 'compact':
  if (args[0] === 'reset' && args.length === 1) {
    return { type: 'compact_reset' };
  }
  return {
    type: 'compact',
    ...(arg ? { customInstructions: arg } : {}),
  };
```

禁止把 `/compact reset` 解释成摘要指令。

### 10.3 `/context` 输出

必须使用完整 `ContextProjectionEnvironment`，显示：

```text
Context usage: 88,120 / 121,856 usable tokens (72.3%)

System instructions        8,211
Project / skills           6,104
Tool schemas              17,841
Compacted history          7,422
Live transcript           42,612
Dynamic runtime            5,150
Provider framing             780

Output reservation         8,192
Safety margin              2,560

Pressure                   warning
Auto-compaction            disabled by feature flag
Active checkpoint          cmp_...
Last reduction             111,280 → 88,120
Next compact threshold     107,233
Hard threshold             114,545
```

当前 report 的 auto 状态只根据 guard/hardBlock，未反映 feature flag，需要修正。

### 10.4 `/compact reset`

流程：

```text
1. 确认 active checkpoint 存在
2. 构建 without-checkpoint projection
3. 完整 preflight
4. 若 >= hardRatio，拒绝 reset
5. 写入 context.compaction_reset
6. 清除 active checkpoint
7. 重新计算 context status
```

reset 命令本身继续使用 `user.command_invoked` 持久化。

---

## 11. 测试矩阵

### 11.1 Durable Event

```text
JSON stringify/parse 后完全等价
pending compaction 重启恢复
不包含函数
不包含 Zod runtime object
不包含 ToolSet
```

### 11.2 Incremental Checkpoint

```text
旧 constraint 不丢
旧 completed effect 不丢
旧 failure 不丢
旧 pending work 可被新 completed effect 关闭
失效 observation 可删除
source digest 固定长度
20 次连续 compaction 无摘要链膨胀
```

### 11.3 Ledger

```text
所有 fact evidence 位于 covered range
所有 user message 被覆盖
active task goal 不伪装成旧 objective
verification current state 不进入 summary
plan current state 不进入 summary
read_only 不进入 completed work
```

### 11.4 Validation

```text
伪造 message ID 被拒绝
live-tail evidence 被拒绝
伪造 factId 被拒绝
修改 path 被拒绝
修改 digest 被拒绝
修改 success/failure 被拒绝
新 V1 summary 被拒绝
旧 V1 checkpoint 可以恢复
```

### 11.5 State Machine

```text
auto_soft low gain 不 hard-block
auto_hard low gain hard-block
manual failure 不 hard-block
repeated overflow durable block
breaker 跨 restart 保留
manual success 清除 breaker
auto success 不无条件清除 breaker
```

### 11.6 Projection

```text
before/after 使用相同 tool descriptors
相同 skill context
相同 workflow descriptors
相同 recentTurns
相同 provider margin
candidate estimate 与生效 checkpoint projection 相等
```

### 11.7 Legacy

```text
每个 user message 新 synthetic turn
preamble 永久保护
旧 transcript 能产生 safe boundary
replay 后 turnId/messageId 不变化
```

---

## 12. 自动压缩开启标准

完成 PR 1～8 后先进入 shadow 模式。

### 12.1 Shadow 指标

记录假设执行自动压缩的 turn、压力状态、safe boundary 可用率、预计 before/after、真实 provider input usage、是否实际 overflow。不实际调用 summary model。

### 12.2 自动启用条件

至少满足：

```text
0 次 durable event serialization failure
0 次 mandatory fact 丢失
0 次 orphan tool call/result
0 次 soft failure hard-block
0 次 repeated overflow 未持久化
连续 checkpoint source digest 固定长度
P95 token estimate 误差 <= 10%
自动压缩成功后至少 3 turn 内不再次 compact_due
```

### 12.3 上线阶段

| 阶段 | 范围 | 操作 |
|------|------|------|
| A | manual only | 收工手动成功率 |
| B | shadow auto | 记录但不下发摘要请求 |
| C | model allowlist | 已知模型窗口灰度 |
| D | 5% session | 小比例执行 |
| E | 25% session | 扩大验证 |
| F | 默认开启 | 全面上线 |

任何阶段可通过 `contextCompactionAutoV1 = false` 立即关闭 proactive auto，而不影响 M1、manual `/compact`、现有 checkpoint、`/context`、overflow 错误提示。

---

## 13. 推荐实施顺序

### 第一周：正确性边界

```text
PR 1  Durable ToolSet 清理
PR 2  Incremental mandatory inheritance
PR 3  Ledger covered-range
PR 4  Observation invalidation
PR 5  Summary evidence validation
```

完成后，手动 `/compact` 可以进入更广灰度。

### 第二周：状态机与估算

```text
PR 6  Hard block + thrash + repeated overflow
PR 7  Projection environment + token budget
PR 8  Legacy migration + raw digest
```

完成后，可以开启 shadow auto。

### 第三周：产品化

```text
PR 9  /context + /compact reset
token calibration
long-session soak tests
provider allowlist rollout
```

---

## 14. 最终验收检查表

### 数据边界

- [ ] Event/State 全部 JSON-safe
- [ ] ToolSet 不进入 durable state
- [ ] Summary 不具备 system 权限
- [ ] Custom instructions 始终是不可信数据

### 历史完整性

- [ ] Base summary mandatory facts 单调保留
- [ ] 所有 user message 有 coverage
- [ ] 所有 fact 有 covered evidence
- [ ] current RuntimeState 不进入历史摘要
- [ ] observation 正确失效

### 状态机

- [ ] Soft failure 不 block
- [ ] Hard failure durable block
- [ ] Repeated overflow durable block
- [ ] Thrash breaker 真正接入 reducer
- [ ] Manual 操作可安全恢复

### Token

- [ ] Before/after 同环境
- [ ] Target 基于 usable window
- [ ] Tool schema 来自 provider serializer
- [ ] Safety ratio 配置生效
- [ ] recentTurns 全链统一

### 恢复能力

- [ ] Legacy turn migration 生效
- [ ] Pending compaction 可 replay
- [ ] Checkpoint 可 restart
- [ ] V1 checkpoint 可读取
- [ ] 新 summary 只接受 V2

### 用户体验

- [ ] `/context`
- [ ] `/compact`
- [ ] `/compact focus ...`
- [ ] `/compact reset`
- [ ] Feature flag 状态显示准确
- [ ] Hard block 提示有明确恢复动作

---

## 15. 推荐最终默认配置

在自动压缩正式启用前：

```json
{
  "features": {
    "contextCompactionV2": true,
    "contextCompactionManualV1": true,
    "contextCompactionAutoV1": false
  },
  "compaction": {
    "warningRatio": 0.80,
    "compactRatio": 0.88,
    "hardRatio": 0.94,
    "targetRatio": 0.62,
    "minimumReductionRatio": 0.15,
    "cooldownTurns": 3,
    "recentTurns": 3,
    "maxSummaryTokens": 6000,
    "maxSummaryInputTokens": 32000,
    "providerSafetyRatio": 0.02,
    "maxAutoCompactionsPerWindow": 3,
    "autoCompactionWindowTurns": 10,
    "maxConsecutiveLowGain": 2
  }
}
```

完成验收和 shadow auto 后，再调整：

```json
{
  "contextCompactionAutoV1": true
}
```

核心判断标准不是测试数量，而是：

```text
增量摘要不丢事实
状态机不会误阻断
事件可以稳定 replay
before/after 估算完全同源
自动压缩不会形成抖动
```

建议首先落地 PR 1、PR 2 和 PR 6：它们分别解决 durable state 污染、增量事实丢失和错误 hard-block，是当前最直接的生产风险。
