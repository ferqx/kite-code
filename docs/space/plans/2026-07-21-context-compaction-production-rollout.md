# 上下文压缩生产化实施与灰度计划

创建日期：2026-07-21
状态：draft
优先级：P0
基线分支：`compact`
基线提交：`8b9d33a5cb039c9faf29e46a008ac27136b7c4e0`
替代：`2026-07-20-context-compaction-productionization.md`、`2026-07-20-context-compaction-refinement.md`
关联：`docs/adr/0021-context-compaction-checkpoint.md`、`docs/active/real-model-test-boundary.md`

## 1. 结论

当前实现已经具备 canonical frame、M1 确定性折叠、结构化 M2 摘要、checkpoint、手动命令、自动阈值决策、overflow recovery、fact/evidence 校验和候选投影验证。生产默认值应继续保持：

```json
{
  "features": {
    "contextCompactionV2": true,
    "contextCompactionManualV1": true,
    "contextCompactionAutoV1": false
  }
}
```

自动压缩当前不得默认开启。剩余工作不是重做压缩架构，而是关闭持久阻断、请求新鲜度、token 预算、状态机配置、序列化恢复、可观测性和真实 provider 验证方面的生产缺口。

本计划保留 ADR-0021 的以下已接受决策：

- transcript 是不可变历史；
- RuntimeState 是当前状态权威；
- checkpoint 是经过验证的历史派生投影；
- summary 以普通 assistant history 注入，不获得 system 权限；
- 自动与手动压缩共用 event/effect/checkpoint 管线；
- effect lease 是唯一并发与 stale-result 门禁。

## 2. 对输入方案的审查与修正

### 2.1 已确认成立的诊断

以下问题在当前基线上仍然存在，应进入实施范围：

1. `src/core/token-counter.ts` 固定使用 `cl100k_base`，未消费已解析的 `tokenizerFamily`。
2. 配置只校验比例顺序，未校验 summary request、output reservation、context window 等跨字段预算。
3. thrash breaker 的三个阈值已暴露在配置中，但 `THRASH_CONFIG` 和 reducer helper 仍使用硬编码值。
4. `currentContextPreflight()` 可直接复用 `lastPreflight`，且无 revision/environment/capability 新鲜度字段；无缓存时使用不含 system/tool schema 的 fallback estimate。
5. 手动请求没有携带 projection environment digest；手动路径注释已明确承认缺失 live tool schemas。
6. `context.compaction_failed` 在 reducer 内构造 hard block 时写入空 `sourceDigest`。
7. metrics collector 是进程内 singleton，没有稳定 export/flush 责任边界。
8. 仓库没有受维护的真实模型 provider 测试套件；现有 `test:mock` 只是 Runtime mock E2E。
9. 仓库只有 MCP live smoke workflows，没有覆盖常规质量、单元、Runtime E2E、TUI system 和序列化恢复的 required CI workflow。

### 2.2 原方案中的过时或不准确项

以下内容不得按原文直接排期：

1. **“repeated overflow 仍抛普通异常”已过时。** 当前 model controller 已生成 `context.hard_blocked`，并有 reducer 与测试覆盖。后续工作是统一 hard-block factory、补全 digest/错误分类及恢复语义，而不是再次实现该事件。
2. **“checkpoint、hard block、breaker、pending 均已完成恢复语义”表述过强。** 它们存在于 RuntimeState，不等于 pending effect 能在重启后安全重建；必须以 snapshot + event tail + effect lease 的实际测试证明。
3. **四个开关的方案与 ADR-0021 冲突。** ADR 已规定 `contextCompactionV2=false` 时 fail closed，不回落到 legacy context projection。若要恢复旧 provider context 路径或把 canonical/M1 再拆开，属于新的架构决策，必须先新增 ADR；本计划不引入 legacy 双路径。
4. **“关闭 auto 同时关闭 hard-limit safety”不安全。** `contextCompactionAutoV1` 应控制 proactive auto 和自动 overflow recovery；模型调用前的 hard-limit fail-closed 安全门禁不能因 rollout flag 关闭而消失。具体语义需在 PR-2 固化。
5. **Shadow 指标混入不可测项目。** 不调用 summary model、不写 checkpoint 的 shadow 模式无法测量真实 mandatory-fact retention、narrative 完整性或真实压缩后 refill。Shadow 只验证触发、边界、估算和回放安全；摘要正确性由 contract/live canary 验证。
6. **`sourceDigest` 与 environment digest 职责混淆。** source digest 标识被覆盖历史及 base checkpoint 链；projection environment digest 标识工具、技能、模型和预算环境。两者分别计算和校验，不能用环境变化重写历史 source digest。
7. **配置只要求重启后生效。** 本方案不设计配置热重载，也不把它列为后续交付。
8. **“所有 job 绑定同一 SHA”不是测试脚本即可保证。** workflow 默认针对触发提交运行；真正的门禁还需要 GitHub branch protection/ruleset 配置。仓库内交付 workflow 与 required-check 名称，仓库外配置单独留存证据。
9. **固定 6～8 周排期缺少容量依据。** 本计划使用依赖和退出条件排序；日历排期由负责人基于人力、真实流量和 provider 预算确定。
10. **“0 次事故”必须附样本窗口。** Go/No-Go 指标均需声明时间窗、会话数、模型和版本，否则不能作为可审计门槛。

## 3. 范围与非范围

### 3.1 范围

- 统一 hard-limit durable block 生成与恢复；
- 明确 feature flag 的安全语义；
- tokenizer-aware 估算与自动模型准入；
- 完整 summary request 预算与 oversized turn 处理；
- preflight/environment 新鲜度；
- 可配置 thrash policy；
- JSON round-trip、snapshot/replay 和 crash recovery；
- CI、可观测性、shadow、真实 provider 测试和分阶段灰度。

### 3.2 非范围

- 修改原始 transcript 或删除历史 RuntimeEvent；
- 新增数据库或第二套运行时锁；
- 重写已接受的 ADR-0021；
- 在 V2 关闭时维护 legacy projection 双路径；
- 配置热重载；
- dashboard 后端或遥测平台选型；
- 把摘要变成 system instruction。
- 行范围、symbol、AST 或语义片段预读；
- 文件评分、embedding、reranker 或学习型选择；
- 预读文件后台刷新、智能替换或多版本缓存；
- 多 summary model 自动路由；
- `Ctrl+O` 或摘要展开器；
- 自动压缩默认开启。

这些项目不是当前阶段的延期任务，本方案不为其预留接口、PR 或验收项。若未来出现经过验证的新需求，应重新立项，而不是从本计划自然延伸。

## 4. 必须先固定的安全语义

### 4.1 Hard block

新增唯一构造入口，例如：

```ts
createContextHardBlockedEvent({
  state,
  reason: 'hard_limit' | 'overflow_recovery_failed',
  errorKind,
  message,
  sourceDigest,
  projectionEnvironmentDigest,
})
```

下列 hard 路径必须生成 durable event，不能抛普通异常结束：

- hard limit 且无 safe boundary；
- `auto_hard` 摘要生成、校验、预算或收益失败；
- overflow recovery 后 provider 再次 overflow；
- hard/overflow 下 oversized turn 无允许的 summary model 可处理；
- hard/overflow 下 narrative 生成、截断重试或合并失败。

soft auto 和普通 manual 失败不得创建 hard block。hard block 只允许在以下动作后重新 preflight，并在低于 hard limit或成功 checkpoint 后解除：

- compaction 成功；
- clear/新会话；
- rewind；
- reset checkpoint；
- 已验证会降低请求体的 model/tool/skill/config 变化。

单纯 revision 增长不得清除 block。`/compact reset` 不能无条件清除与 checkpoint 无关的 block。

### 4.2 Feature flags

保持现有三个 flag，先固定语义：

| Flag | 关闭后的行为 |
|---|---|
| `contextCompactionV2` | 整个 V2 projection/compaction 路径 fail closed；不回落到 legacy M1 |
| `contextCompactionManualV1` | 禁止创建 manual/manual_recovery 请求；`/context` 可保持只读 |
| `contextCompactionAutoV1` | 禁止 proactive auto 与自动 overflow recovery；不关闭 hard-limit fail-closed 门禁 |

已有 checkpoint 的读取不能依赖 auto/manual flag。是否把 canonical frame 与 M1 拆成独立 kill switch，先做故障演练；只有演练证明需要 legacy fallback 时才新增 ADR 和迁移计划。

### 4.3 压缩产物与关键文件刷新

压缩后的核心产物保持简单，只包含：

1. 一份完整的长会话总结；
2. 一份全量文件活动台账；
3. 一组受预算限制、压缩后重新读取的关键文件快照。

```ts
interface CompactedContextPayload {
  narrative: {
    objective: string;
    currentState: string;
    decisions: string[];
    completedWork: string[];
    failuresAndFindings: string[];
    pendingWork: string[];
    constraints: string[];
  };
  fileLedger: Array<{
    path: string;
    activities: Array<'referenced' | 'read' | 'created' | 'modified' | 'deleted'>;
    summary: string;
    lastKnownDigest?: string;
    lastRelevantTurnId?: string;
  }>;
  refreshedFiles: Array<{
    path: string;
    reason: string;
    digest: string;
    content: string;
  }>;
}
```

所有读取、引用、创建、修改和删除过的文件都进入 `fileLedger`，但不全部重新读取。模型在生成总结时直接从确定性 file ledger 中选择需要预读取的文件，并以返回顺序表达优先级；不再引入额外评分系统。

代码只做硬校验和预算裁剪：file ID 必须来自候选清单，路径必须位于 workspace，文件必须存在且可读，数量和 token 不得超限。只支持整文件读取，默认最多 5 个文件，总预算不超过 12,000 tokens，单文件不超过 4,000 tokens；超限时按模型返回顺序保留，单文件超限则跳过并记录原因。deleted、vendor、generated、binary、lock file 和超出安全大小的文件不进入可选候选或降级为 metadata。本方案不设计行范围、symbol、AST 或语义片段读取。

重新读取发生在摘要成功之后、checkpoint 激活之前，读取当前 workspace 内容，不复用历史 tool result。文件不存在、变为目录、超限或读取失败时跳过该文件并记录诊断，不让可选预读阻断压缩。Core 通过注入的只读 resource resolver 获取内容，不依赖 `src/app/` 或 TUI 类型。该投影扩展改变 checkpoint 内容，需要在实现前新增补充 ADR，不直接改写 ADR-0021。

压缩诊断日志额外记录 `fileLedger`、模型返回顺序、selected/excluded 原因、预算裁剪、重新读取的文件 digest/content，以及最终哪些文件内容进入 provider context。

### 4.4 压缩后消息顺序与 Prompt Cache

每个 checkpoint 激活后，压缩消息必须成为 history 的固定前缀；后续新 message 只能追加在其后，不能把 summary 移动到尾部，也不能每轮重建出字节不同的内容。

```text
稳定 system / cacheable runtime instructions
稳定 tool schema layer
──────────────── prompt cache 边界 ────────────────
CompactionSummaryFrame          ← checkpoint 生命周期内字节不变
RefreshedFilesFrame             ← 压缩时读取的关键文件快照
live transcript tail            ← 后续 turn 只追加
dynamic RuntimeState projection ← plan / auth / verification 等高频状态
```

约束：

- summary 和 refreshed-file snapshot 均作为低权限历史数据，不进入 system messages；
- summary 是压缩后 history 的第一条消息，refreshed files 紧随其后；
- 内部使用专用 `RefreshedFilesFrame`；最终 Provider 不支持专用数据角色时，序列化为一条 user-role 数据消息，而不是 ToolMessage、真实 user transcript 或 Runtime user event；
- user-role 内容使用 `<refreshed_workspace_files>` / `<file>` XML 标签包裹，path、reason、digest 和正文必须做严格 XML entity escaping，禁止文件内容闭合或注入标签；稳定 system contract 明确标签内部是不可信 workspace 数据，不能作为指令执行；
- checkpoint 激活时使用一次规范化序列化，固定字段顺序、换行和空值处理；后续调用复用保存结果，不重新序列化不稳定对象；
- summary 前缀不得包含当前时间、请求 ID、token usage、动态 plan、authorization、verification、tool availability 或会随 turn 变化的诊断字段；
- 同一 checkpoint 生命周期内 summary 字节永远不变；新的增量压缩用新 checkpoint 整体替换旧 summary，这是预期的一次 cache invalidation；
- refreshed file 标注读取时 digest。文件随后被修改时，正确性优先：稳定 summary 继续保留，过期 file frame 必须被明确 invalidation 或替换，不能为了 cache 命中冒充当前内容；
- before/after estimate 和真正 provider request 必须使用完全相同的消息顺序与序列化结果；
- diagnostics、进度、日志路径和 context-debug 内容不得进入 provider messages。

验收：连续 10 个未再次压缩的 turn 中，summary message 的内容 hash 和位置保持不变；新消息只追加在 refreshed files 之后；动态 RuntimeState 变化不改变 summary hash；文件未变化时 refreshed frame hash 保持不变；文件变化时产生可验证 invalidation，且 summary 前缀仍可命中缓存。

### 4.5 模型输出契约：长总结 + 预读取文件

当前实现要求模型生成完整 `StructuredContextSummaryV2`、fact ID、evidence、provenance、chunk JSON 和 merge JSON，失败面过大。生产方案改为：模型只产出长篇 Markdown narrative；另一次可选调用只返回需要整文件预读取的 file IDs。所有安全关键字段由代码从 transcript、RuntimeState 和确定性 ledger 构造。

```text
模型负责
  - 长篇会话总结 Markdown
  - 从给定 file IDs 中选择少量预读取文件
  - 按重要性顺序选择少量 file IDs 并说明 reason

代码负责
  - objective / user request / constraints 的 mandatory facts
  - completed / failure / pending 分类
  - fact IDs / evidence message IDs
  - source digest / provenance / covered boundary
  - 全量 file ledger
  - 文件 ID/path/range 安全校验、预算裁剪和 refresh
  - checkpoint schema 与规范化序列化
```

新的 checkpoint payload 由代码组装：

```ts
interface ContextCompactionCheckpointPayload {
  narrative: string;
  facts: DeterministicFactLedgerProjection;
  fileLedger: FileActivityLedger;
  refreshedFiles: RefreshedFileSnapshot[];
  provenance: DeterministicCompactionProvenance;
}
```

chunk 阶段不再要求 JSON。每个 chunk 只返回 Markdown 文本，代码在请求前后绑定 `chunkId/sourceDigest/coveredMessageIds`，并单独携带该 chunk 的 deterministic facts。最终 merge 只返回 Markdown narrative；mandatory facts 由代码直接附加到最终低权限历史消息，不依赖模型是否在 prose 中复述。

当前阶段使用两个解耦调用：

1. 必需调用：生成或 merge Markdown narrative；失败则压缩失败并保留原会话。
2. 可选调用：narrative 成功后，从 file ledger 选择预读取 file IDs；失败、超时或不支持 structured output 时返回空列表，继续完成压缩。

不要要求同一次模型响应同时稳定地产生长文本和 tool call；不同 Provider 对 text + tool call 混合响应支持不一致，拆开后更容易重试、记录和降级。

文件选择只允许最小契约，并且只能引用代码提供的 candidate ID：

```ts
const selectionSchema = z.object({
  files: z.array(z.object({
    fileId: z.string(),
    reason: z.string(),
  })).max(5),
});
```

可选的第二次调用优先使用原生 structured output 或受 schema 约束的 `select_preload_files` tool call。代码必须验证返回 ID 属于候选集合；调用失败、非法或 provider 不支持时保留 narrative，并降级为不预读取文件，不能让可选文件选择阻断压缩。

Provider 能力降级顺序：

1. Markdown narrative 成功 + 独立的原生 JSON Schema 文件选择；
2. Markdown narrative 成功 + 独立的 schema tool call；
3. Markdown narrative 成功，不预读取文件；
4. 不允许把长篇 summary 包进普通文本 JSON 后手工 `JSON.parse()`。

narrative 验收只检查：非空、未因 `finishReason=length` 截断、在输出预算内、没有工具调用，并能通过候选投影收益验证。它不是状态权威，因此 narrative 遗漏某个 mandatory fact 不会造成事实丢失；代码生成的 mandatory facts 段仍会进入压缩消息。截断时优先缩小 chunk、增加允许的输出预算或重新 merge，不执行“修复 JSON”循环。

实现该契约会改变 ADR-0021 当前的 structured-summary 生成职责，必须通过新的补充 ADR 明确“模型 narrative、代码权威结构”的边界，而不是改写已接受 ADR。

### 4.6 当前阶段最小生产范围

本阶段目标是稳定开放 manual compaction，并为后续 auto rollout 建立可靠基础。只实现必要能力：

- 一次 direct narrative，超预算时按完整 turn 顺序分 chunk，再做一次 narrative merge；
- chunk、merge 全部是普通 Markdown 文本，不生成 JSON；
- deterministic ledger、provenance、mandatory facts 和 file ledger 由代码生成；
- 独立、可选的 file-ID 选择调用；最多 5 个，只整文件读取，失败降级为空；
- 稳定的 summary-first message 顺序和规范化序列化；
- 文件被后续 write 命中时，简单移除对应 refreshed snapshot，并记录 invalidation；不做智能增量刷新；
- 手动进度、最终提示、完整 context-debug 日志和 `current-context.json`；
- restart/replay、tool pairing、stale result、原 transcript 不变和 cache-prefix hash 测试。

本方案明确不做：

- 模型评分、embedding、reranker 或学习型文件选择；
- 行范围、symbol、AST 或语义片段预读；
- 预读文件自动替换、后台刷新或多版本缓存；
- 多个 summary model 自动路由和成本优化；
- 配置热重载；
- 面向普通用户的 summary 展开器或 `Ctrl+O`；
- 自动压缩默认开启。

以上项目不属于后续阶段，也不要求实现预留扩展点。25% 灰度仅用于验证已定义的简单自动压缩路径，不代表继续扩大流量或切换默认值。

Manual Canary 的最小 Go 条件：100 次有效 `/compact` 中没有 transcript 损坏、orphan tool pair、跨 session 污染或无法恢复的 checkpoint；summary 成功率达到预登记门槛；所有失败均可从 debug 日志定位到 provider、截断、timeout、chunk、merge 或 validation 分类；文件预读失败不得计为压缩失败。

## 5. 实施 PR 拆分

### PR-1：统一 durable hard block

修改范围：model controller、decision、runtime event/reducer、scheduler、manual recovery。

交付：

- decision 的 `block` 返回结构化 reason/errorKind/source 信息；
- hard-limit 无 safe boundary 不再由普通 `Error` 表示；
- pending request 持久化 `sourceDigest` 与 environment digest；
- reducer 不再生成空 digest；
- `context.hard_blocked` 保留真实 error kind，不用 `unsafe_boundary`/`insufficient_reduction` 代替所有原因；
- block 解除集中到显式 helper，并重新 preflight。

验收：restart/replay 后仍 blocked；无关事件不解除；soft/manual failure 不误阻断；重复 overflow 不循环。

### PR-2：Flag 语义与故障演练

交付：

- 为三个现有 flag 建立真值表测试；
- auto 关闭时仍执行只读 preflight 与 hard-limit fail-closed；
- manual 关闭时 `/compact` 与 recovery 请求均不可创建；
- checkpoint projection 与创建开关解耦；
- 文档明确重启生效，不承诺热重载。

若需要第四个开关或 legacy projection，PR 停止并先提交 superseding ADR。

### PR-3：Tokenizer 与模型自动准入

引入：

```ts
interface TokenCounter {
  family: string;
  confidence: 'exact' | 'mapped' | 'approximate';
  countText(text: string): number;
  countMessages(messages: readonly BaseMessage[]): number;
}
```

`resolveTokenCounter(modelCapabilities)` 至少支持 `cl100k_base`、`o200k_base` 和 unknown 保守估算。自动 soft/hard 只允许 exact，或在给定 provider+model+tokenizer 版本校准窗口内 P95 绝对误差不超过 10% 的 mapped counter。approximate 只允许 manual 和一次 overflow recovery；unknown context window 一律不运行 proactive auto。

actual usage 校准必须按 provider、model、tokenizer version 分桶，不能用全局 EWMA 掩盖模型差异。

### PR-4：完整 summary request 预算

预算对象必须包含固定 system prompt、custom preferences、base narrative、deterministic ledger、chunk framing、source messages、关键文件选择输入和 refreshed file content；只有最小文件选择契约使用 schema budget。

```text
summaryUsableInput = summaryModelContextWindow
  - maxSummaryTokens
  - providerSafetyMargin

fullSummaryRequestTokens <= summaryUsableInput
```

先构建完整逻辑请求再决定 direct/chunk/fail closed。chunk 也必须包含每个 chunk 的固定开销，并给最终 merge 预留独立预算。

额外约束：

- custom instructions 在配置/命令边界限长，并作为不可信数据；
- ledger canonical text 和 evidence 数量有确定性上限；
- 单 turn 超限时 soft 跳过、manual 明确失败、hard/overflow fail closed 并生成 durable block；本方案不自动路由其他 summary model；
- chunk 和 merge 改为 text narrative，不再解析 chunk JSON；
- mandatory facts、evidence、provenance 和 checkpoint schema 全部由代码生成，模型不得自由裁剪；
- 实现 4.3 的 file ledger、模型有序选择、硬校验、预算裁剪和只读 refresh；
- 使用受 schema 约束的 tool call 处理可选的最小文件选择，不支持或失败时降级为不预读取文件；
- 实现前新增 checkpoint payload 和模型职责边界的补充 ADR。

### PR-5：Preflight 新鲜度与统一 projection

`ContextPreflight` 至少记录：

```ts
{
  stateRevision: number;
  turnId: string;
  projectionEnvironmentDigest: string;
  modelCapabilityDigest: string;
  policyVersion: string;
  createdAt: string;
}
```

transcript/checkpoint、tool catalog/schema、MCP binding、skills/workflow、model/provider、output reservation、policy、runtime prompt、authorization 或 workspace 变化均使缓存失效。

`/context` 和 `/compact` 必须通过同一 `buildContextProjection()` 使用真实环境。fallback estimate 只能用于带“approximate”标记的诊断，不能授权压缩、reset 或 hard-block 解除。before/after 必须使用相同环境快照；环境漂移时结果 stale，重新 preflight，不写 checkpoint。

### PR-6：配置校验与 thrash policy

新增 `ResolvedAutoCompactionPolicy`，decision 与 reducer event application 使用同一 policy version 和关键阈值。不要把完整 config 对象写入 RuntimeState。

启动期至少校验：

```text
warningRatio < compactRatio < hardRatio
targetRatio < compactRatio
recentTurns >= 1
maxSummaryTokens + providerSafetyMargin < summaryModelContextWindow
reservedOutputTokens + providerSafetyMargin < agentModelContextWindow
```

`maxSummaryInputTokens` 若保留，必须定义为完整请求上限并与模型窗口联合校验；否则删除该重复配置，避免两个上限漂移。

breaker 至少覆盖频率窗口、快速 refill、连续低收益和压缩后仍处 hard ratio。narrative 截断、merge 失败和可选文件选择失败只属于 pipeline 指标；只有定义了持久事件输入后才可纳入 reducer breaker。

### PR-7：序列化、恢复与性质测试

建立 table-driven JSON round-trip 测试，覆盖每一种 RuntimeEvent、RuntimeState context 分支和 snapshot migration；不能只对示例对象抽样。

恢复矩阵：

- request 落事件后、effect 开始前退出；
- summary provider 调用中退出；
- completed event 后、snapshot 前退出；
- hard block、breaker、reset 后重启；
- environment digest 变化后 pending 变 stale；
- V1/V2 checkpoint、legacy synthetic turns、旧 snapshot migration；
- event tail 与 snapshot 不一致时保持现有 corrupted recovery 语义。

性质测试覆盖 transcript 不变、完整 turn boundary、tool pair、recent turn、user coverage、mandatory fact 继承、失败/完成分类、prompt injection 与连续 20 次增量 merge。

### PR-8：CI 门禁

新增常规 pull-request workflow，固定 job 名称：

```text
quality: bun install --frozen-lockfile; typecheck; format:check; lint;
         check:core-boundary; check:docs; check:docs-impact
unit: bun run test
compaction-contract: bun run test:mock
runtime-e2e: bun run test:e2e
tui-system: bun run test:tui:system
```

序列化/replay 测试先纳入 `unit` 或 `compaction-contract`，只有运行时间和所有权证明需要时再拆 job。避免 `test:e2e` 与 `test:tui:system` 重复执行同一 TUI scenarios；PR 中应调整脚本职责或明确只保留一个 required job。

仓库外验收：GitHub ruleset 将上述最终 job 名设为 required，并保存同一提交 SHA 的 run 链接。live model suite 不进入默认 CI。

### PR-9：压缩进度、可观测性与隐私

先定义 exporter/flush 所有权，再增加低基数指标。没有完成本 PR，不得开始任何按天计时的自动灰度窗口。label 禁止直接包含 thread ID、compaction ID、自由文本 error、完整 model string 或 digest；这些字段只进入采样后的结构化日志并做 hash/prefix。

#### 用户可见进度

当前实现的 `compact_context` 分支没有使用 effect executor 的流式 `emit` 通道，`executeContextCompaction()` 只在全部工作完成后返回 `completed/failed`；手动 `/compact` 会一直等待，TUI 期间没有任何状态反馈。这是 Manual Canary 前的阻断项。

新增 provider-neutral、非持久化的 `ContextCompactionProgress`，通过独立 effect progress 通道从 compactor 传到 app，不能进入 reducer、snapshot、event replay 或 durable RuntimeEvent 日志。只有 requested/completed/failed/hard-blocked 继续作为持久事件。

```ts
interface ContextCompactionProgress {
  compactionId: string;
  stage:
    | 'preparing'
    | 'building_ledger'
    | 'summarizing'
    | 'retrying'
    | 'merging'
    | 'validating'
    | 'estimating';
  chunkIndex?: number;
  chunkCount?: number;
  elapsedMs: number;
}
```

展示要求：

- `/compact` 提交后立即显示单行动态状态，例如 `Compacting context… preparing`；
- 分块后显示真实计数，例如 `Summarizing chunk 2/6`；
- retry、merge、validation 和候选 token estimation 必须可区分；
- 不使用无法从真实工作量推导的虚假百分比；未知总量时只显示 spinner + stage；
- completed、failed、cancelled 或 stale result 必须清除动态状态并生成一条最终静态结果；
- session 切换后进度只属于目标 session，不能渲染到当前新 session；切回目标 session 时根据 pending effect 显示 `Compaction in progress`，但不伪造已丢失的阶段；
- 重启后不 replay 历史进度；若 pending compaction 恢复执行，从 `preparing` 重新开始；
- manual 与 auto 使用同一 progress 数据模型，auto 默认只在状态区展示，不插入用户 transcript；
- 进度不得包含用户文本、摘要正文、文件路径、tool output、custom instructions 或原始模型输出。

进度通道必须与 durable event 通道类型隔离，不能为了复用现有 `emit(RuntimeEvent)` 而把每个 chunk 阶段写入事件存储。Core 只定义 progress 数据和回调，不依赖 TUI 展示类型。

验收测试：

- 单块成功：`preparing → building_ledger → summarizing → validating → estimating → completed`；
- 分块成功：包含稳定递增的 `chunkIndex/chunkCount`，然后 `merging`；
- narrative 截断重试时进入 `retrying`，最终成功或 failed 均正确收尾；
- provider timeout、abort、可选文件选择 validation failure 和 stale result 不留下永久 spinner；
- session 切换、重启恢复和并发请求不会串进度；
- progress 不出现在 RuntimeState JSON、snapshot 或 replay event tail。

#### 开发诊断日志

本项只用于开发阶段排查，不改变 checkpoint schema、RuntimeEvent、reducer、replay、TUI 产品交互或压缩完成语义。诊断文件不得成为 Runtime 正确性依赖。

启用显式 debug 配置后，每次压缩创建一份独立 JSON 日志，无论成功还是失败都保留：

```text
~/.kite-code/sessions/<frontend>/<threadId>/
  events.jsonl
  summary.json
  current-context.json
  compactions/
    <createdAt>-<compactionId>.json
```

路径必须复用现有 `sessionLogDir(frontend, threadId)`，不得再创建平行的全局 context-debug 根目录。文件与 session 日志共址，但职责保持分离：`events.jsonl` 只记录常规事件，完整压缩诊断只进入 `compactions/`。

单次压缩日志记录完整执行链：

```text
release SHA / threadId / compactionId / trigger / timestamps
provider / model / tokenizer / policy / feature flags
source revision / boundary / source digest / environment digest
完整 summary request（system prompt + input）
每个 chunk 的序号、输入、原始模型输出、finish reason 和 usage
每次 narrative retry 的输入、原始输出、finish reason、validation error 和 usage
merge 的输入、原始输出、finish reason 和 usage
最终 accepted Markdown narrative 与代码生成的 checkpoint 元数据，或最终 error kind/message
before/after/target token estimate 和真实 provider usage（若存在）
```

它的目标是让 Code Agent 能直接判断 narrative 是否被截断、模型是否添加异常内容、哪个 chunk 失败、retry 是否执行，以及可选文件选择或最终 digest 校验为何失败。日志文件不写入 `events.jsonl`，不参与 session restore，也不要求 checkpoint 引用其路径。

每个 session 另外维护一个独立的当前总上下文文件：

```text
~/.kite-code/sessions/<frontend>/<threadId>/current-context.json
```

它在每次实际模型调用前覆盖写入，记录该次真实请求的完整应用层上下文：system messages、tool schemas、checkpoint summary、live history、dynamic Runtime messages、最终 provider messages、token breakdown、preflight、model identity、state revision、turn ID 和 projection environment digest。shadow、候选估算和纯 `/context` 查询不能覆盖它。

两个文件使用临时文件 + atomic rename；目录权限 `0700`、文件权限 `0600`。由于会包含完整用户消息、文件内容、工具输出和模型响应，只允许显式 debug 配置开启，不上传遥测、不进入 dashboard、不随普通 session export 导出，并提供按天数或总大小清理策略。路径必须防目录穿越和 symlink 覆盖。

验收测试：

- 单块、分块、retry、merge、成功和失败路径均生成可解析的独立日志；
- narrative 截断案例能从 raw output、finish reason 和 usage 直接确认；
- 连续压缩不会覆盖旧日志；
- `current-context.json` 与最近一次真实 provider 请求一致，shadow 不覆盖；
- debug 关闭时不创建文件且不改变压缩行为；
- 日志写入失败不得导致压缩失败，只产生本地 diagnostic warning；
- 并发 session、atomic write、权限、清理、路径穿越和 symlink 测试通过。

最小指标集：requested/completed/failed、duration、reason/error kind、before/after/saved、estimate error、retry/chunk count、hard block、overflow recovery、thrash pause、stale result、restore/serialization failure。

每次压缩结束必须输出一条可独立分析的结构化记录，至少包含：

```text
releaseSha / policyVersion / featureFlagsDigest / cohort
sessionIdHash / compactionId / timestamp
reason / result / errorKind
provider / model / tokenizerFamily / tokenizerConfidence
sourceRevision / sourceDigestPrefix / environmentDigestPrefix
coveredThroughTurnId
estimatedInputTokens / actualProviderInputTokens
inputTokensBefore / inputTokensAfter / targetTokens / reductionRatio
summaryCalls / retryCount / chunkCount / durationMs
turnsSincePreviousCompaction / hardBlocked / staleResult
```

压缩完成后还必须在第 1～3 个后续 turn 记录 follow-up，或者在会话结束时生成等价汇总，用于计算 `turnsUntilRefill`、3-turn refill、再次 overflow 和 breaker 状态。只记录压缩完成事件不足以验证 refill 指标。

为 Code Agent 提供按 `releaseSha + sessionIdHash + compactionId` 导出的最小诊断包：压缩原因和结果、策略/flag digest、provider/model/tokenizer、source revision、digest 前缀、token 数据、相关 RuntimeEvent 类型及序号、前后 3 个 turn 的状态摘要和日志查询位置。默认不得包含完整 transcript；内容级排查只能在明确授权后生成脱敏 replay fixture。

遥测、`events.jsonl`、普通错误日志和 dashboard 不得记录 summary input/output 正文、用户 prompt、文件正文、tool stdout、custom instructions、凭据或完整工具 schema。只有显式开启的本地 context debug 文件允许保存完整内容，且不得上传。

### PR-10：Shadow 与真实 provider 套件

Shadow 只执行 projection、preflight、safe boundary 和预估收益，不调用 summary model、不写 checkpoint、不改变调度。验证指标：触发混淆矩阵、token estimate error、safe-boundary eligibility、预测 after/refill、实际 overflow、序列化错误。

真实 provider 文件放在 `tests/e2e/live/model/*.live.ts`，由显式 `bun run` wrapper 启动，遵守 `docs/active/real-model-test-boundary.md`。runner 必须限制 provider allowlist、并发、超时、最大 token 和总预算，并输出脱敏报告。

真实场景至少覆盖 direct/chunk narrative、截断重试、可选文件选择降级、软/硬压缩、overflow recovery 成功/二次失败、oversized turn、长 checkpoint merge、中英代码混合、MCP schema 密集、rate limit、timeout 和 pending restart。

## 6. 发布阶段与退出条件

每阶段报告必须记录 commit SHA、配置、provider/model、样本量、起止时间和指标查询版本。灰度 cohort 必须按 session 的稳定标识做一致性哈希；同一 session 不能在运行中随机切换实验组。

按天计时的窗口只有在下列条件同时满足时有效：

- release SHA、compaction policy version、tokenizer mapping 和模型 allowlist 保持不变；
- metrics、结构化日志和 follow-up 数据持续可用；
- 指标定义、查询版本和分母没有变化；
- 部署、回滚、监控缺口和 provider 事故均记录在阶段报告中。

压缩算法、阈值、tokenizer、allowlist 或关键状态机发生行为变化后，窗口从新版本重新计时。只改变 dashboard 或修复无行为影响的日志展示可以保留窗口，但必须登记变更及缺失数据范围。监控缺失时段不计入连续观察天数。

### A. 代码正确性

完成 PR-1 至 PR-8；全部 required checks 通过。配置保持 M1 开启、manual 小范围、auto/shadow 关闭。

退出：所有 hard-block/replay/property tests 通过，且同一 SHA 的 CI 证据可追溯。

### B. Manual canary

仅允许模型白名单和受信用户；至少覆盖 100 个达到 warning ratio 的有效手动请求，并运行不少于 7 天。

进入条件：结构化终局日志、用户可见 progress 和 context debug 日志能力均已上线；内部 canary 开启 debug 后能定位 narrative 截断、retry、merge、可选文件选择和 digest failure；失败、取消和 session 切换不会遗留 spinner。

退出：无 transcript/tool-pair/session 污染；manual 成功率和延迟达到产品负责人预先登记的 SLO；所有 validation failure 均有分类；progress 完成率为 100%，即每个已开始的 progress stream 都有 completed、failed、cancelled 或 stale 终态。

### C. Shadow auto

按 session 稳定采样 25%，至少 1,000 个长会话；每个候选模型至少 100 个 warning 样本，中英、代码和 MCP 密集场景有代表性覆盖。

退出：P95 绝对 token estimate error ≤ 10%，P99 ≤ 15%，hard-threshold 漏判为 0，0 个 serialization/tool-pair 异常。mandatory fact retention 不在本阶段宣称。

### D. Live canary 与 1% soft auto

先运行 live suite，再对 1% 会话仅开启 soft auto；overflow recovery 使用独立 rollout cohort，避免同时改变两个变量。

立即回滚：任何 mandatory fact 丢失、orphan tool pair、跨 session 污染或不可恢复 hard block；或自动失败率、refill、estimate error 超过预登记阈值。

### E. 5% hard/overflow

soft auto 稳定后才加入 hard auto 和 overflow recovery。至少运行 7 天，要求压缩成功率 ≥ 97%、overflow recovery 成功率 ≥ 95%、非预期 hard block < 0.1%、3 turn 内 refill < 2%、P95 estimate error ≤ 10%。

### F. 25% 验证上限

25% 阶段按 session 稳定分桶，连续覆盖至少 14 个完整自然日，并同时达到以下最低样本；时间和样本两个条件缺一不可：

- 至少 5,000 个进入 cohort 的有效会话；
- 至少 1,000 个达到 warning ratio 的长会话；
- 每个候选 provider/model 至少 200 次压缩尝试；
- soft auto、hard auto 和 overflow recovery 均达到发布负责人在阶段开始前登记的最低分母；样本不足时延长窗口，不降低门槛。

阶段报告必须自动聚合成功率、estimate error、3-turn refill、非预期 hard block、breaker、manual reset、成本、延迟、cache hit、长会话完成率和 provider/model 分布，并附 error kind 排名。报告至少包含：窗口起止时间、release SHA、policy/config version、cohort 算法、各指标分子与分母、模型分布、部署/回滚记录以及监控缺口。

窗口内继续满足：压缩成功率 ≥ 97%、overflow recovery 成功率 ≥ 95%、非预期 hard block < 0.1%、3 turn 内 refill < 2%、P95 estimate error ≤ 10%，且 transcript 损坏、mandatory fact 丢失、orphan tool pair、session 污染和 durable serialization failure 均为 0。

本阶段结束后仍保持自动压缩默认关闭。25% 是本计划的验证上限，不包含继续扩大流量或切换默认值的动作。

## 7. 回滚

1. 关闭 `contextCompactionAutoV1`：停止 proactive auto 和自动 overflow recovery，保留 checkpoint、manual、V2 projection 与 hard-limit fail-closed。
2. 同时关闭 `contextCompactionManualV1`：禁止新建 manual checkpoint，已有 checkpoint 继续投影。
3. 只有确认 V2 projection 本身造成故障时关闭 `contextCompactionV2`；按 ADR fail closed，不静默切入 legacy 路径。

回滚不删除 checkpoint、不修改 transcript、不自动 reset 用户状态、不在事故期间批量迁移历史数据。每次回滚后重新 preflight，并保留明确诊断。

## 8. 最终 Go / No-Go

### Go

- required CI、mock contract、replay/property 和 live suite 在发布 SHA 全绿；
- 所有 rollout 报告包含可审计样本窗口；
- 样本窗口内 transcript 损坏、mandatory fact 丢失、orphan tool pair、session 污染和 durable serialization failure 均为 0；
- P95 token estimate error ≤ 10%；
- auto 成功率 ≥ 97%，overflow recovery ≥ 95%，3 turn refill < 2%；
- 三层回滚完成演练，GitHub ruleset 和告警已验证。

### No-Go

- 任一事实完整性、tool pairing、跨 session 或 replay 确定性事故；
- hard block 无明确恢复路径；
- unknown/approximate tokenizer 进入 proactive auto；
- live provider 行为未验证；
- CI 不是发布 SHA，或 required checks/ruleset 未生效；
- 指标没有样本窗口、版本或分母；
- kill switch 语义与 ADR/测试不一致。

## 9. 验证命令

文档阶段：

```bash
bun run check:docs
bun run check:docs-impact
```

各实现 PR 按影响范围至少运行：

```bash
bun run typecheck
bun run format:check
bun run lint
bun run check:core-boundary
bun run test
bun run test:mock
bun run test:e2e
bun run test:tui:system
```

真实模型测试只能在 PR-10 提供的显式 opt-in runner 存在后执行；在此之前不得宣称真实 provider 已验证。
