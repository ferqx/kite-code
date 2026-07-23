# ADR-0022：上下文压缩采用单次 narrative 总结，不推断通用 Provider 400

状态：accepted
日期：2026-07-22
补充：ADR-0021、ADR-0023
后续：ADR-0024 进一步替代本 ADR 中的 `auto_soft`、`auto_hard` 与容量型 hard block 决定；本 ADR 的历史结论不改写
接受后替代：ADR-0021 中关于结构化 summary、完整 fact/evidence coverage、chunk/merge repair、`overflow_recovery` 自动调度和 manual summary 精确预算准入的决定
关联：`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`、`docs/active/tui-run-status-bar.md`

## 背景

ADR-0021 已经确立上下文压缩的基础安全模型：原始 transcript 不可变，RuntimeState 是当前状态权威，checkpoint 只是历史派生投影，summary 是低权限历史数据，自动与手动压缩共用 Runtime event/effect/checkpoint 管线，并复用 Kernel effect lease 处理并发与 stale result。

当前实现进一步加入了 `StructuredContextSummaryV2`、deterministic fact ledger、mandatory fact/evidence coverage、用户消息覆盖、JSON repair、完整 turn chunk、merge、候选投影验证和 Provider overflow recovery。这些能力增强了审计性，但也把首版生产压缩扩展为多个相互依赖的子系统：

```text
结构化事实提取
+ 长 JSON 生成与修复
+ chunk summary 与 merge
+ 精确 summary request 预算
+ Provider overflow 识别与恢复
+ checkpoint schema 与验证
```

在多 Provider 环境中，通用 HTTP 400 不能可靠表示 context overflow。它也可能来自请求 schema、参数、tool definition、网关大小、模型路由或供应商安全策略。Core 若解析自由文本，会形成无法完整维护的 Provider 错误矩阵，并可能把普通参数错误误判为上下文已满。

同时，manual `/compact` 的核心价值是：即使本地不知道供应商真实窗口，用户仍可主动请求一次更小的专用总结调用。若 manual 必须先证明 tokenizer 和真实 context window 精确，它反而无法承担这一恢复路径。

因此，需要在保留 ADR-0021 安全不变量的前提下，缩小首版模型契约和失败面。

## 决策

本 ADR 一旦 accepted，采用以下决定。

### 1. 保留 ADR-0021 的基础架构

以下决定继续有效，不被本 ADR 替代：

1. 原始 `RuntimeEvent` 与 `RuntimeState.transcript` 不可变。
2. RuntimeState 是 plan、authorization、interaction、verification、mode 和 pending effect 的当前事实权威。
3. `ContextCompactionCheckpoint` 是可替换、可 reset、可重建的历史派生投影。
4. `CompactionSummaryFrame` 作为普通 assistant history 注入，不得进入 system instructions。
5. canonical frames、完整 turn/tool pair、M1 deterministic folding 和最终 pairing validator 继续作为安全边界。
6. manual 与 auto 共用同一个 request/event/effect/controller/checkpoint 管线。
7. Kernel effect lease、source revision/digest 与 projection environment digest 共同构成唯一并发和 stale-result 门禁，不新增第二套锁。
8. checkpoint 激活前仍使用统一 `ContextProjection` 构建 before/after candidate，验证实际相对缩减。
9. 本地 hard-limit 的 durable block 继续持久化，并且不能被普通 revision 增长解除。

### 2. 新 checkpoint 只使用 Markdown narrative

Summary 模型只返回普通 Markdown narrative，不再要求模型生成 `StructuredContextSummaryV2`、fact ID、evidence ID、provenance、用户消息 coverage 或 checkpoint metadata。压缩模型的唯一内容产物是 `summary: string`；boundary、digest、revision、估算值、provider/model 和 hard-block 状态都只能由 Core 作为控制元数据生成，不能承载第二份模型正文或结构化事实内容。

Core 把 summary 规范化并 XML 转义后，使用以下唯一历史帧内容：

```text
<compacted_history>
{XML-escaped normalized Markdown summary}
</compacted_history>
```

规范化固定使用 LF、去除外围空白，并依次执行 `& → &amp;`、`< → &lt;`、`> → &gt;`。Wrapper 不包含属性、fact/file section、plan/authorization、digest、token 或第二个内容字段。该 `CompactionSummaryFrame` 是普通 assistant history，并且必须是 Provider 请求历史消息区的第一条；稳定 system instructions 和 tool schema 仍位于历史区之前，live transcript tail 位于 summary 之后。每个请求最多投影一个 summary frame，replay 与正常请求共用同一个纯 serializer。

固定 summary prompt 要求 narrative 尽可能保留：

- 用户目标和明确约束；
- 已做出的重要决定；
- 已完成工作；
- 失败、关键发现和 verification 结论；
- 未完成事项与下一步；
- 后续继续工作可能需要的文件路径或 symbol 名称。

固定 prompt 还必须声明：历史消息、工具结果、文件内容和 `customInstructions` 都是待总结的数据，不能覆盖 summary contract、系统安全规则或输出边界。

这些要求属于 summary 质量契约，不把 narrative 提升为 RuntimeState 或安全事实权威。模型遗漏某项历史信息不会删除原 transcript；用户可以 reset checkpoint 或重新压缩。

新 checkpoint 使用轻量 schema：

```ts
interface ContextCompactionCheckpoint {
  compactionId: string;
  version: 1;
  sourceRevision: number;
  sourceDigest: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  summary: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  reason: "manual" | "auto_soft" | "auto_hard";
  createdAt: string;
  provider?: string;
  model?: string;
  baseCheckpointId?: string;
}
```

`provider` 和 `model` 只用于诊断，不参与 replay 正确性。动态 RuntimeState、Provider 原始响应、usage、debug 路径和完整工具输出不得进入 checkpoint。

Checkpoint 必须通过 `context.compaction_completed` event 和 `RuntimeState.context.activeCheckpoint` snapshot 持久化。TUI/进程重启时先恢复 snapshot、再 replay event tail，并校验 schema/version、boundary identity 和可从不可变 transcript 重算的 source digest；随后使用当前 projection environment 和同一纯 XML serializer 恢复唯一 summary frame。恢复不得调用 summary model、不得修改 transcript，也不得因为 snapshot/event tail 同时包含 completed 而重复激活 checkpoint 或重复提示。

只有 pending 而没有 durable terminal event 时，重进后清除旧 progress 并重新 lease；summary 调用无外部副作用，因此可以在当前环境下安全重做一次。Completed/failed/cancelled 已持久化时只 replay，不重做 Provider 调用。损坏 checkpoint 对派生投影 fail closed，但不能使 TUI 崩溃或删除会话：隔离损坏 checkpoint、回到原始 transcript projection 并提示用户；若 fresh preflight 为 hard limit，则只阻断普通模型调用，保留 `/compact`、reset、rewind、clear 和切换模型恢复路径。

### 3. 每次压缩固定一次模型调用

压缩使用当前 active provider 和 active model。它构建独立、最小、无工具的 summary request，而不是复用完整普通 agent request。

输入只包含：

```text
固定 compaction system prompt
+ 当前 checkpoint narrative（增量压缩时）
+ M1 折叠后的 bounded settled history
+ custom instructions（存在时，作为不可信数据）
```

不携带完整 agent system prompt、tool schemas、MCP inventory、动态 plan/authorization/verification、recent live tail 或额外文件正文。

首版不执行：

- JSON repair；
- chunk summary；
- rolling 或 hierarchical merge；
- 因任意 Provider 400 自动缩块重试；
- 第二次模型调用选择关键文件；
- 自动切换其他 summary model。

若单次 request 失败或输出不合格，本次 compaction 失败并保留原 checkpoint/transcript。Summary request 必须关闭 SDK 自动传输重试，或把逻辑调用数与 HTTP attempt 数分别计量；不能在文档宣称“一次调用”却由 SDK 隐式发送多次 Provider 请求。

### 4. 使用 bounded safe prefix，而不是复杂模型预算

V1 保留应用级 `maxSummaryInputTokens`、`maxSummaryTokens`、`maxNarrativeTokens` 和 `minimumIncrementalHeadroomTokens`，用统一 estimator 限制资源使用。输入上限计算完整 request，包含固定 prompt/framing、旧 narrative、限长后的 custom instructions 和新 settled history。上述值不是 Provider 真实窗口的声明，也不要求为每个模型精确校准。

系统从最老的 settled history 开始，按完整 turn 依次加入 summary source；超过应用上限时停止，剩余 history 继续作为 live tail。配置和输出验证必须限制 narrative 大小，并为后续至少一个正常增量保留 headroom。

已有 narrative 导致下一个 turn 无法装入时，允许一次 narrative-only shrink：输入只有固定 prompt 和旧 narrative，输出仍是一份更短的完整 narrative，covered boundary 不前移。它必须达到最小绝对缩减，且仍然只调用一次模型。若下一个完整 turn 在 M1 后单独加固定 envelope 仍超过上限，则不拆分，返回稳定的 `oversized_turn`。

因此，一次 compaction 可以只覆盖有界的最老 safe prefix。用户可以再次 `/compact`，增量地覆盖后续 settled history，而不需要在一次 effect 中执行多轮 chunk/merge。

### 5. Manual 不依赖精确窗口准入

Manual `/compact`：

- 不要求达到本地 warning/compact ratio；
- 不要求 tokenizer 为 exact；
- 不要求已知 Provider 真实 context window；
- 不要求前一个 Provider 请求返回某种错误；
- 不因 capability unknown 而禁止发起。

应用级 summary 输入上限、输出上限、完整 turn boundary 和资源安全限制仍然适用。Manual 调用若被 Provider 拒绝，按普通 compaction failure 处理，不猜测拒绝原因。

Proactive auto 的 capability 来源遵守 ADR-0023：不得使用模型名称内置目录推断窗口。存在显式或实际 adapter runtime window 时可以使用 ratio policy；窗口 unknown 时，只有用户显式配置 absolute threshold 才允许 proactive auto。

### 6. Core 不解释通用 Provider 400

普通 `call_model` 返回 HTTP 400 或等价 Provider failure 时：

```text
当前 model effect 失败
→ 展示脱敏后的 Provider 错误
→ session 返回可交互状态
→ 不自动创建 compaction request
→ 不自动创建 ContextHardBlock
→ 用户自行决定是否执行 /compact
```

Core 禁止通过错误 message 子串推断 context overflow。`overflow_recovery` 不再是 V1 的 `ContextCompactionReason`。`contextCompactionAutoV1` 是 auto master kill switch，控制 shadow、`auto_soft` 和 `auto_hard` summary；可信窗口下独立的本地 hard-limit safety 不因该 flag 关闭而放行请求。

未来若某个 Provider adapter 能提供稳定、结构化且有 contract test 的 `context_length_exceeded` signal，必须通过新的 ADR 决定是否恢复自动 recovery；不能把它作为本 ADR 的隐式扩展。

### 7. 最低 summary 与 candidate 验证

新 narrative 只做以下最低验证：

1. 非空且不是纯空白；
2. finish reason 不是 length；
3. 响应没有 tool call；
4. summary 可以规范化序列化和 JSON round-trip；
5. source boundary、revision 和 digest 仍匹配；
6. effect lease 的 Runtime revision、turn、pending identity 和 projection environment digest 仍有效；
7. live tail 未被覆盖，最终 tool pairing 有效；
8. 同一 `ContextProjection` 下 `inputTokensAfter < inputTokensBefore`；
9. manual 达到最小绝对缩减，auto 达到对应 target ratio；
10. narrative 不超过 `maxNarrativeTokens`；
11. 若当前存在 hard block 或完成时 pressure 为 hard limit，使用完成时环境对 candidate 重新 preflight；只有 candidate 已低于 hard limit，Reducer 才能解除 block。

不再执行 mandatory fact coverage、evidence intersection、covered user message equality 或 JSON schema repair。

Runtime revision、turn、pending identity 或 projection environment 在模型调用期间变化时，结果属于 stale discard：不生成 `context.compaction_failed`，不写 checkpoint 或 hard block，只允许注入式 reporter 记录无正文的 `stale_result`。非持久化 progress 在 executor `finally` 中清除；当前 pending 是否按新 lease 重试完全由最新 RuntimeState 决定。

若最新 state 决定不再 re-lease，取消必须由最新 Runtime revision 产生 `context.compaction_cancelled`，不能由被拒绝的 stale effect 提交。该事件只清除仍匹配的 pending identity，不替换 checkpoint、不创建 hard block、不累计 failure/breaker，并映射为一次不进入 transcript 的 cancelled notice。Reset/clear 已经清除 pending 时不得再写重复取消事件。

### 8. 增量 checkpoint 使用 narrative replacement

已有 checkpoint 时，新 summary source 为当前 narrative 加 checkpoint boundary 之后的新 settled safe prefix。模型生成一份新的完整 narrative，新 checkpoint 整体替换当前 active checkpoint。`baseCheckpointId` 固定表示上一 checkpoint 的 `compactionId`，不引入第二套 checkpoint identity。Narrative-only shrink 没有覆盖新 transcript，必须保留原 covered boundary 和 source digest，不能对空 tail 继续 hash。

Provider context 中始终只有一个当前有效 summary，不形成嵌套 summary 链。`sourceDigest` 继续使用 base digest 与 tail digest 的稳定 hash chain。

### 9. 文件预读与完整事实审计延期

V1 不创建 `FileLedger`、`RefreshedFilesFrame`、文件 digest/invalidation 或独立 file-selection 调用。压缩后需要代码正文时，模型使用现有读取工具按需读取。

V1 也不构建完整 fact/evidence graph。若 canary 证明 narrative 经常遗漏用户目标、约束、失败或 pending work，先调整单一 narrative prompt、模型策略和 reset/retry 指引。本 ADR 不允许追加代码生成的 `mustKeep` frame、第二段事实正文或其他内容 payload；未来若要改变单一 summary 产物约束，必须用新 ADR 重新论证。

这些延期能力不属于 checkpoint 正确性依赖，也不要求当前实现预留接口。

### 10. 实现收敛为单一路径

当前 agent 尚未正式上线，因此实现本 ADR 时不保留 structured-summary legacy path，也不在旧代码旁新增一套 `narrative-v2` 平行实现。相关模块必须删除或原地收敛：

- 删除 `compaction-schema.ts` 和 `compaction-fact-ledger.ts`；
- 将 `compaction-summary.ts` 重写为单次 Markdown generator + narrative compactor，不保留 `repair/chunk/merge` mode；
- 将 `compaction-v2.ts` 收敛为 boundary/digest/bounded-prefix helper，删除 chunk 和开发期 legacy-turn recovery；
- 删除旧 `compaction.ts` 中 deprecated `estimateTokens()`/`shouldCompact()` 双重决策；
- Runtime reason 删除 `manual_recovery`/`overflow_recovery`，error kind 删除 schema/provenance/evidence/coverage 专用分支；
- 删除 `overflowRecoveryTurnId`、summary version/provenance 字段和 cached `lastPreflight`；projection environment digest 必须进入 effect lease 与完成时 acceptance，不能只记录后删除；
- 删除 Provider overflow 文本识别、自动 recovery 分支及其 metrics；
- Manual 始终通过统一入口并构建 fresh projection，不保留 fallback estimate 或第二套 event 组装；
- `ContextProjection` 直接投影规范化 Markdown，不保留 structured-summary 的 JSON 序列化或版本兼容分支；
- 缺少稳定 turn identity 时保护相关 frame 并 fail closed，不再通过 legacy synthetic turn recovery 猜测边界；
- Runtime executor、kernel、event/invariant 不得保留 structured compactor、legacy replay、overflow reason 或 cached preflight 接线；stale effect 不得通过失败事件修改更新后的 state；
- TUI 不得手工构造 compaction lifecycle event 或重复 capability/preflight；只调用 Core 的统一命令服务；
- metrics 使用注入式 reporter/exporter，不保留无明确 flush owner 的进程级 singleton；
- 删除旧结构化测试，不得通过 skip、deprecated wrapper 或 compatibility fixture 保留死代码。

共享且仍有价值的 canonical frame、M1 folding、safe boundary、source digest、ContextProjection、pairing validator、effect lease、checkpoint lifecycle 和 hard-limit state machine 原地保留。重构完成后，生产入口只能解析和生成 narrative checkpoint。

Manual 和 auto 只允许 reason、custom instructions、触发阈值与验收门槛不同；boundary、M1、summary request、XML serializer、candidate validation、event/effect、checkpoint activation、progress 和终态 result 必须共用同一 Core service。App/TUI 不得为 manual 或 auto 复制压缩算法。

压缩过程暴露非持久化 `preparing/summarizing/validating` progress。每个 compaction identity 最终必须映射为一次用户可见 completed、failed 或 cancelled notice；auto 不得静默结束。Notice 只包含脱敏状态和可选 approximate reduction，不包含 summary 正文，也不进入 transcript 或后续模型上下文。Stale 且重新 lease 时回到 preparing；不再重试时映射为 cancelled。中间 progress 不 replay；终态展示可由持久 lifecycle event 按 `compactionId` 去重恢复为静态记录，但不能再次触发 toast。

TUI Footer 的当前 context 统计必须来自与普通请求相同的 `ContextProjection`/preflight snapshot，而不是累计 token usage 或按模型名查询的静态窗口。Checkpoint 激活后显示 fresh candidate/current projection；失败、取消和 stale 保持原 projection；重启时从恢复后的 RuntimeState 与当前环境重算。Window unknown 时只显示 approximate absolute tokens，不显示 percentage。Footer 不显示 last compact、reduction、checkpoint reason 或 before/after；这些只属于 checkpoint、终态提示和遥测。该 UI snapshot 是派生数据，不进入 checkpoint，也不得由 TUI 重复实现 estimator/capability resolution。

## 备选方案

### 保留现有结构化 summary 与 fact/evidence graph

优点是可审计、可证明 mandatory coverage。缺点是长 JSON、schema validation、repair 和 chunk/merge 共同扩大 Provider 兼容性与失败面。首版生产目标不采用。

### 在同一次响应中返回 narrative 和文件选择

不同 Provider 对长文本加 structured output/tool call 的组合支持不一致，且可选文件选择会阻断核心 summary。首版不采用。

### 使用第二次模型调用选择关键文件

能够减少压缩后重复读取，但引入 File Ledger、路径安全、文件 I/O、snapshot invalidation、上下文 refill 和额外延迟。没有真实指标前不采用。

### 解析 Provider 错误文本自动恢复

能覆盖部分 context overflow，但无法可靠区分普通 400，且在代理、兼容 API、区域和语言变化后容易误判。Core 不采用。

### 自动路由独立 summary model

可能获得更大窗口或更低成本，但会引入模型选择、权限、语义漂移、配置和计费边界。首版固定使用当前模型。

### 保留 chunk/merge 作为超长 source fallback

能在一次 compaction 中覆盖更多历史，但会增加模型调用、失败恢复、进度、预算与事实重写风险。V1 选择 bounded safe prefix 和后续增量 compaction。

## 后果

### 正面后果

- 每次 compaction 固定一次模型调用，延迟、成本和终态更容易理解。
- Manual 在真实窗口未知时仍可作为用户主动恢复路径。
- Provider-neutral Core 不需要维护不完整的 400 错误矩阵。
- 删除结构化生成、repair、chunk/merge 和文件选择后，主流程状态与测试矩阵显著缩小。
- 不可变 transcript、pairing、lease、checkpoint 和候选投影仍保留原有安全属性。

### 负面后果

- Narrative 无法形式化证明每个 mandatory fact 都被保留。
- 单次 bounded prefix 可能需要用户连续执行多次 `/compact`。
- 单个 oversized turn 无法通过 V1 自动拆分总结。
- Provider 窗口突然缩小时，proactive auto 可能触发过晚。
- Core 不自动解释 400，恢复依赖用户读取 Provider 错误并决定是否 `/compact`。
- 压缩后模型可能重新读取之前看过的代码文件。

### 风险控制

- Transcript 永久保留，summary 质量问题可通过 reset/retry 恢复。
- Manual 与 auto 使用同一实现，避免两套算法漂移。
- Summary 截断、tool call、pairing 和 insufficient reduction 均以当前 lease 写入失败事件并 fail closed；revision/environment stale 则丢弃整个 effect 结果，不让过时事件接触新 state。
- Auto 默认关闭，先通过 manual canary 收集遗漏、重复 read 和 refill 数据。
- 任何文件预读、附加事实 payload 或结构化 overflow signal 都必须独立立项，不直接扩张 V1；本 ADR 范围内始终只有单一 summary 内容产物。

## 实施与发布顺序

1. 本 ADR accepted；只更新 ADR 索引和计划引用，不提前把未来行为写入 active 文档。
2. 先把 Runtime reason 收敛为 `manual/auto_soft/auto_hard`，移除 Core 通用 overflow inference，并在同一 PR 更新对应 active/book，验证 400 后 session 可交互。
3. 在当前唯一 structured pipeline 上先固定 projection environment lease、stale discard、完成时 candidate preflight 与 hard-block 保留语义。
4. 再原子切换到 narrative checkpoint schema，删除旧结构化 summary 生成、解析与验证路径，同时加入 narrative headroom/shrink，并在同一 PR 更新 narrative/checkpoint active/book、fixture、snapshot 和 round-trip 测试。
5. 完成 manual canary 后，才进入 shadow auto 和小比例 proactive auto。

当前 agent 尚未正式上线，不提供开发期结构化 checkpoint 的兼容 reader 或数据迁移。已有本地开发 session、snapshot 和 fixture 可以清理或随实现同步更新。在步骤 2 的实现、active 文档与测试未共同更新前，不得宣称 Provider 400 语义已经改变。

## 回滚

关闭 `contextCompactionAutoV1` 停止 shadow、`auto_soft` 和 `auto_hard` summary；可信窗口下的本地 hard-limit safety 仍可直接 fail closed 并允许 manual 恢复。关闭 `contextCompactionManualV1` 停止新建 manual checkpoint。已有 checkpoint 继续投影，不删除 transcript。

如果本 ADR 在实现前被拒绝，保留 ADR-0021 和当前 active 文档的全部现有语义，不产生运行时变化。
