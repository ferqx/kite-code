# 上下文压缩生产化实施与灰度计划

创建日期：2026-07-21
修订日期：2026-07-22
状态：archived（PR-0/PR-1/PR-1A/PR-2/PR-3/PR-4/PR-5/PR-6/PR-7 已于 2026-07-22 完成；验证记录见 `docs/space/execution/completed/2026-07-22-context-compaction-production-rollout.md`）
优先级：P0
基线分支：`compact`
基线提交：`8b9d33a5cb039c9faf29e46a008ac27136b7c4e0`
复核提交：`46bf50119267154c3b3ab31c71a088311c267ce4`
替代：`2026-07-20-context-compaction-productionization.md`、`2026-07-20-context-compaction-refinement.md`
关联：`docs/adr/0021-context-compaction-checkpoint.md`、`docs/adr/0022-context-compaction-single-narrative.md`、`docs/adr/0023-model-capabilities-no-builtin-catalog.md`、`docs/adr/0024-context-compaction-manual-auto-only.md`、`docs/active/model-provider-boundary.md`、`docs/active/plan-state-reminder.md`、`docs/active/six-concept-runtime-architecture.md`、`docs/active/tui-run-status-bar.md`、`docs/active/real-model-test-boundary.md`

归档后首版定稿（2026-07-23）：最终产品行为收敛为单一会话总结机制。M1 工具结果投影折叠、固定 `recentTurns` 和 bounded safe prefix 已移除。首版假设所选模型的 `contextWindowTokens` 配置正确；live 自动压缩在完整请求达到可用输入预算的 90% 时先于普通模型调用执行，summary 直接使用当前对话的全部安全历史。自动压缩失败或取消时不得在同一 turn 回落到普通模型调用；下一用户 turn 若仍达到阈值，则重新尝试一次自动压缩。Provider 拒绝 summary（包括配置窗口大于服务商真实窗口导致的上下文超限）不触发清理、分块、重试或错误文本推断，只提示用户检查模型上下文配置或执行 `/clear`。本文后续与该定稿冲突的段落仅记录实施时的历史设计，不再代表当前行为；当前规则以关联的 `docs/active/` 文档为准。

## 1. 决策摘要

本计划把首版生产目标收敛为一条可验证的最小压缩管线：

```text
不可变 transcript
→ 选择完整的 settled turn/tool boundary
→ 使用当前对话模型执行一次 Markdown 总结
→ 验证并持久化轻量 checkpoint
→ 后续投影 summary + live tail + 当前 RuntimeState
```

自动压缩和手动 `/compact` 只在触发来源、当前 turn 保护以及可选的用户侧重点数据上不同，执行同一套 boundary 术语（安全边界）、summary 术语（历史总结）、validation 术语（候选验证）、event/effect 术语（事件与副作用）和 checkpoint 术语（派生检查点）逻辑。最终原因类型只保留：

```ts
type ContextCompactionReason = "manual" | "auto";
```

压缩模型的唯一内容产物是一份 Markdown summary。Checkpoint、RuntimeEvent、correctness block 术语（运行时正确性阻断）和遥测可以携带由 Core 生成的边界、digest、revision、估算值和诊断元数据，但不得携带第二份事实正文、结构化事实图、文件正文、工具输出副本或模型生成的控制状态。换言之，模型生成的数据面始终只有 `summary: string`。

最终运行契约固定为：

1. manual 与 auto 只在触发来源和可选 custom instructions 上不同；从 safe boundary 开始到 checkpoint 激活结束，必须调用同一套 Core pipeline，使用相同验收阈值，禁止分叉 summary 算法或序列化格式；
2. 压缩后的唯一模型内容是 summary；Core 将其确定性 XML 转义后包装为唯一的 `CompactionSummaryFrame`，放在新请求的历史消息区第一位；
3. 压缩不删除、改写或重排持久化 conversation transcript，也不改写既有 RuntimeEvent；只允许追加 compaction lifecycle event 并替换派生 checkpoint，从而只改变 `buildContextProjection()` 产生的模型上下文结构；lifecycle event 不是 conversation history message；
4. manual 与 auto 都必须展示 preparing/summarizing/validating 进度，并对 completed/failed/cancelled 给出一次明确的用户提示；这些 UI notice 不进入 transcript 或后续模型上下文；
5. active checkpoint 通过 Runtime event + snapshot 持久化；退出 TUI 或进程重启后无模型调用地恢复同一 summary frame 和 live tail，不重复压缩或提示；
6. Footer 当前 context 统计来自恢复后/当前的统一 `ContextProjection`，压缩完成后立即切换到 fresh after/current 值，不能使用累计 usage 或模型名静态窗口代替。
7. live 自动压缩默认在可用输入预算的 90% 触发；失败或取消时停止本 turn，下一用户 turn 重新 preflight，仍超阈值则再次尝试。
8. summary Provider 请求失败直接收敛为一次失败提示；不清理工具输出、不分块、不自动重试，并提示检查 `contextWindowTokens` 或执行 `/clear`。

首版明确不实现：

- 第二次模型调用选择关键文件；
- `FileLedger`、`RefreshedFilesFrame`、文件快照及失效协议；
- 完整 fact/evidence graph 与用户消息逐条覆盖证明；
- chunk/merge/repair JSON 多阶段摘要；
- 多 summary model 自动路由；
- Provider HTTP 400 文本识别或通用 overflow recovery；
- 为所有模型维护精确 tokenizer、真实窗口和逐组件预算矩阵。

本地 trigger ratio 术语（自动触发比例）和 trigger tokens 术语（自动触发绝对令牌数）只决定何时尝试 `reason=auto`。它们不证明 Provider admission 术语（Provider 接受真实请求），也不得创建或维持 durable hard block 术语（持久阻断）。

同时删除 `BUILTIN_MODEL_CAPABILITIES` 及其他按模型名称硬编码的窗口、输出、tokenizer、usage 和 prompt-cache 能力。内置模型列表只负责默认选择，不再成为 Runtime 正确性输入。

生产默认值保持：

```json
{
  "features": {
    "contextCompactionV2": true,
    "contextCompactionManualV1": true,
    "contextCompactionAutoV1": false
  }
}
```

本计划只批准 manual compaction 的生产化和 auto compaction 的受控验证，不批准自动压缩默认开启。

## 2. 为什么需要收敛

当前实现已经具备 canonical frame、M1 确定性折叠、结构化 M2 摘要、checkpoint、手动命令、自动阈值、overflow recovery、fact/evidence 校验和候选投影验证。但原计划同时试图解决：

```text
会话压缩
+ 事实完整性审计
+ 关键文件工作集预测
+ Prompt Cache 文件快照
+ 精确模型预算
+ Provider overflow 自动恢复
+ 生产灰度与可观测性
```

这些能力耦合后产生了不必要的主流程失败面：长 JSON 截断、schema repair、chunk/merge、file-ID 选择、文件安全读取、snapshot invalidation、token 装箱和 Provider 能力降级都会影响一次本应简单的压缩。`BUILTIN_MODEL_CAPABILITIES` 还会把公开模型规格误当成当前 endpoint/route 的真实能力，使未知窗口被错误标记为已知。

首版的真实目标不是证明“模型记住了所有事实”，而是保证：

1. 原始历史不丢失；
2. tool call/result 不被拆散；
3. 压缩后请求明显变小；
4. 压缩失败不会破坏当前会话；
5. checkpoint 可 replay、可 reset、可替换；
6. 用户在正常模型请求失败后仍能手动执行 `/compact`；
7. manual 稳定后再验证 auto 触发是否可靠。

文件重复读取、摘要事实遗漏和 prompt-cache 收益先通过真实指标观察。只有数据证明这些问题显著影响任务继续成功率，才单独立项，不把推测性的优化放进首版正确性边界。

## 3. ADR 与当前行为边界

本文是实施计划，不直接改变当前行为。ADR-0022、ADR-0023 与 ADR-0024 已接受；PR-1 已删除通用 overflow recovery 术语（溢出恢复），PR-1A 已把当前源码收敛为 `manual | auto`、`off | shadow | live`，并删除 ratio-driven hard block 术语（比例驱动硬阻断）与压缩失败阻断。当前仍保留结构化摘要实现，直到 PR-3 原地切换为单次 Markdown narrative 术语（Markdown 叙事摘要）；不得改写 ADR-0021 至 ADR-0023 的历史结论。

ADR-0022 至少明确以下替代决定：

1. 新生成的 checkpoint 使用 Markdown narrative，而不是模型生成的 `StructuredContextSummaryV2`。
2. 首版不要求模型或代码生成完整 fact/evidence ledger；RuntimeState 继续是当前状态权威。
3. 增量压缩使用“旧 narrative + 新 settled tail → 新 narrative”，不再做结构化 summary merge。
4. Core 不解析通用 Provider 400，也不从自由文本推断 context overflow。
5. `overflow_recovery` 不再是首版自动压缩触发原因；Provider 请求失败后由用户决定是否执行 `/compact`。
6. tokenizer 和 context window 只服务于本地 auto trigger、诊断和普通请求 preflight，不作为 manual compaction 的准入前提。

ADR-0023 明确能力来源边界：

1. 删除 `BUILTIN_MODEL_CAPABILITIES` 和其他模型名静态能力 fallback；
2. `ResolvedModelCapabilities` 只接受显式模型配置、实际 adapter runtime metadata 和兼容配置；
3. 每个 resolved 字段保留 source，缺失时保持 unknown；
4. unknown window 不产生利用率或 ratio auto；
5. unknown tokenizer 只允许 provider-neutral approximate estimator，不作为 Provider admission 证明；
6. 用户可显式配置 absolute auto threshold，但它是 policy，不是模型能力。

ADR-0024 进一步替代容量阻断语义：

1. `ContextCompactionReason` 只保留 `manual | auto`；
2. ratio threshold 和 absolute threshold 都只是自动尝试启发式；
3. 删除 `auto_hard`，并把 `auto_soft` 重命名为 `auto`；
4. 自动压缩失败只产生 `context.compaction_failed`，不创建 hard block；
5. token estimate、配置窗口、Provider 400 和 candidate pressure 都不能阻断普通调用；
6. `ContextHardBlock` 若保留，只能保护可证明的 Runtime correctness failure 术语（运行时正确性故障）。

每个改变当前行为的实现 PR 必须在同一改动中更新受影响的 `docs/active/`、`docs/book/` 和 `docs/documentation-map.json`。PR-1A 必须一次性收敛 reason、阻断语义、持久 schema、配置、指标和测试，不能只改类型名而保留 ratio-driven block。

## 4. 核心不变量

### 4.1 Transcript 永远不可变

压缩不得删除、覆盖或改写 `RuntimeEvent` 和 `RuntimeState.transcript`。所谓“清除旧工具输出”仅表示在压缩输入或正常模型上下文投影中折叠正文，不表示从持久历史删除结果。

因此必须满足：

- `/compact reset` 可以丢弃 checkpoint，并从原始 transcript 重建上下文；
- summary 失败、超时、截断、stale 或序列化失败时，原会话保持不变；
- checkpoint 损坏时可以被拒绝或重建；
- session replay 不依赖模型输出恢复当前 RuntimeState。

### 4.2 RuntimeState 是当前事实权威

当前 plan、authorization、interaction、verification、pending effect、mode 和工具状态始终从 RuntimeState 动态投影。Summary 只描述已发生的历史，不得决定当前授权、计划步骤或验证结论。

### 4.3 Summary 是低权限历史数据

Summary 继续使用且只使用一个 `CompactionSummaryFrame`，最终序列化为普通 assistant history。不得进入 system message，也不得获得覆盖 system、policy、authorization 或 tool contract 的权限。它在“历史消息区”中必须排第一：稳定 system instructions 和 tool schema 不属于历史消息，因此仍位于它之前；checkpoint 之后的 live transcript tail 必须位于它之后。

Frame content 使用唯一规范格式：

```text
<compacted_history>
{XML-escaped normalized Markdown summary}
</compacted_history>
```

Core 必须先把 summary 规范化为 LF、移除外围空白，再依次执行 `& → &amp;`、`< → &lt;`、`> → &gt;`，防止 summary 正文伪造闭合标签或注入兄弟 XML 节点。Wrapper 不携带 fact、file、plan、authorization、digest、token 或其他内容字段；这些 Core 元数据只存在于 checkpoint/event，不得序列化进历史 frame。投影和 replay 必须使用同一纯函数 serializer，已有 active checkpoint 在生命周期内产生逐字节一致的 frame。

### 4.4 完整 turn 与 tool pair

压缩范围只落在完整 turn boundary。一个 assistant message 中的多个 tool calls 及其全部 terminal results 必须作为完整 block 保留或覆盖，不允许产生 orphan tool call/result。

### 4.5 单一 effect lease

压缩继续复用 Runtime Kernel 的 effect lease 和 revision 机制，并把 projection environment digest 作为同一份 lease 的环境新鲜度组成部分。该 digest 至少覆盖 active provider/model、字段级 model capability source、estimator kind/version、summary policy、稳定 system/tool schema、active Skill 和 workflow descriptor。

完成时 Runtime revision、turn、pending compaction identity 或 projection environment digest 任一变化，模型结果都按 stale 丢弃，不写 `context.compaction_failed`、checkpoint 或 hard block，也不引入第二套锁。注入式 reporter 可以记录不含正文的 `stale_result`；非持久化 progress 必须在 executor 的 `finally` 中清除。若当前 state 中同一 pending request 仍然有效，scheduler 可以用当前 revision 和新环境重新 lease；若 reset、clear、session 切换或 reducer 已取消 pending，则不得重试。

## 5. 触发与 Provider 错误语义

### 5.1 手动触发

用户执行：

```text
/compact
/compact focus on the current implementation and unresolved failures
```

手动压缩：

- 不要求达到本地 warning/compact ratio；
- 不要求 tokenizer 精确；
- 不要求已知真实 context window；
- 不要求前一个 Provider 请求返回特定错误；
- 不因本地 estimate 不可信而被禁止；
- `customInstructions` 只改变总结侧重点，不改变 boundary 和安全规则。

### 5.2 自动触发

自动压缩只由 Kite 自己的 preflight 和显式策略触发，不读取模型名称内置目录：

- 显式模型配置或实际 adapter runtime metadata 提供 `contextWindow` 时，可以使用 `triggerRatio`；
- `contextWindow` unknown 时不计算 utilization，也不运行 ratio auto；
- unknown window 下只有用户显式配置 `compactAfterEstimatedTokens` 一类 absolute threshold 时才运行 absolute auto；
- absolute threshold 只属于 auto policy，不写入 `ResolvedModelCapabilities`，也不证明 Provider 窗口；
- 两种 auto trigger 都继续受 thrash breaker 约束。

无论使用 ratio 还是 absolute threshold，命中后都只产生：

```text
reason=auto
→ 尝试压缩
→ 成功则激活 checkpoint
→ 失败则记录失败并继续交互
```

本地估算不产生 hard decision，不阻止普通模型请求，也不创建 durable block。

供应商若在客户端不知情的情况下缩小窗口，auto 仍可能触发过晚；用户看到实际错误后可以执行 `/compact`。这是允许且诚实的退化路径。

### 5.3 通用 HTTP 400

Core 不解释通用 HTTP 400。它可能表示上下文过长，也可能表示 schema、参数、工具、网关、路由或安全策略错误。

正常模型请求失败后：

```text
call_model failed
→ 展示脱敏后的 Provider 错误
→ session 返回可交互状态
→ 不自动创建 compaction request
→ 不自动创建 context hard block
→ 用户自行决定是否执行 /compact
```

禁止在 Core 中维护 `message.includes(...)` 一类 Provider 错误文本矩阵。若未来某个 adapter 能提供稳定、结构化且经过测试的 overflow error kind，应另行设计；它不是首版依赖。

### 5.4 Feature flags

| Flag                        | 关闭后的行为                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contextCompactionV2`       | V2 projection/compaction fail closed，不回退 legacy 路径                                                                 |
| `contextCompactionManualV1` | 禁止新建 manual compaction；`/context` 保持只读                                                                          |
| `contextCompactionAutoV1`   | auto master kill switch 术语（自动压缩总开关）；禁止 shadow 和 `reason=auto` 的 summary，不影响 manual，也不改变 Provider 请求错误语义 |

已有 checkpoint 的读取不能依赖 manual/auto flag。关闭 flag 不删除 checkpoint，也不修改 transcript。

### 5.5 灰度策略与稳定分桶

三个 feature flag 只负责全局能力和紧急回滚，不承担百分比灰度。Auto 另有一份不写入 `ResolvedModelCapabilities` 的 rollout policy：

```ts
type ContextCompactionAutoMode = "off" | "shadow" | "live";

interface ContextCompactionRolloutPolicy {
  mode: ContextCompactionAutoMode;
  percentage: number; // 0..100
  cohortSalt: string; // 版本化、窗口内冻结
  providerAllowlist?: string[];
  modelAllowlist?: string[];
}
```

按 `hash(cohortSalt, sessionId)` 做稳定 session 分桶；不得按 turn 重新抽样。Provider/model allowlist 在分桶之后继续收窄范围。`contextCompactionAutoV1=false` 时 resolved mode 强制为 `off`。生产默认配置仍为 flag=false、mode=off；灰度环境只对命中的 cohort 显式覆盖 master flag 和 policy，不改变仓库默认值。

各 mode 语义固定：

- `off`：不运行 shadow 或 proactive summary 术语（主动总结）；
- `shadow`：shadow evaluator 术语（影子评估器）只计算 preflight、M1 后 source size、safe-boundary eligibility 和理论 trigger，不调用 summary model、不构造 candidate after、不写 compaction RuntimeEvent/checkpoint；结果只进入低敏感度 reporter；
- `live`：ratio 或 absolute policy 命中后产生 `reason=auto`，执行统一压缩管线；失败只记录 `context.compaction_failed`。

所有 mode 都不得根据 token ratio、配置窗口或 candidate pressure 创建 hard block。关闭或降级 auto mode 只停止自动尝试，不改变普通 Provider 请求是否发送。

## 6. V1 详细执行流程

### 6.1 创建请求

统一入口只保留：

```ts
interface ContextCompactionRequest {
  reason: "manual" | "auto";
  customInstructions?: string;
}
```

请求事件记录 `compactionId`、`reason`、`requestedAtRevision`、`requestedAtTurnId`、用于诊断的 estimate 和请求时的 `projectionEnvironmentDigest`。manual 与 auto 之后进入同一个 `compact_context` effect 和同一个 controller。Effect 开始时必须重新解析环境并建立 `{revision, turnId, compactionId, projectionEnvironmentDigest}` lease；请求时 digest 只用于诊断和判断是否需要以新环境重新 lease，不作为环境数据源。

### 6.2 选择安全边界

从 canonical frames 中选择最老的一段 settled history，并保留最近若干完整 turn 作为 live tail。

不得覆盖：

- 当前最新 user request；
- 正在生成的 assistant turn；
- running、waiting approval 或非 terminal 的 tool call；
- 无法验证 pairing 的消息；
- 缺少稳定 message/turn identity 的 legacy preamble；
- 策略要求保留的 recent turns。

若没有安全边界：

- manual 返回 `unsafe_boundary`；
- auto 记录 `unsafe_boundary` 并退出；
- 两者都不创建 hard block；只有后续独立的不变量检查证明 Runtime 无法安全构造任何 context projection 时，才进入 correctness block。

### 6.3 确定性折叠旧工具输出

对压缩 source 先运行现有 canonical M1 folding。折叠只改变模型输入投影，不改变 transcript。

折叠结果至少保留：

- tool name 和 tool call/result 关联；
- terminal status：success、failure、rejected、cancelled、exhausted；
- 可安全提取的关键参数，例如 path、command、query；
- 结构化 result metadata；
- 原始输出被折叠/截断的明确标记；
- 可用于审计的稳定 digest 或资源 revision（若现有工具边界已提供）。

首版不要求代码理解任意 stdout 的“关键结论”，也不新增模型调用总结工具输出。无法确定性提取的正文按 M1 现有策略折叠；确需保留的错误和结论由 summary 模型从仍在 source 中的短文本、assistant 解释和 Runtime 事件理解。

M1 必须满足幂等、provider-neutral、不拆 tool pair、不改变执行状态、同一输入产生同一输出。

### 6.4 构建专用 summary request

Summary request 使用当前 active provider 和 active model，但不是普通 agent request，也不是在完整历史末尾追加“请总结”。

输入只包含：

```text
固定且最小的 compaction system prompt
+ 当前 checkpoint narrative（增量压缩时）
+ 折叠后的 compactable settled history
+ customInstructions（存在时，作为不可信数据）
```

它不携带：

- 正常 agent 的完整 system prompt；
- tool schemas 或可调用工具；
- MCP inventory；
- 当前 authorization、plan、verification UI 投影；
- recent live tail；
- 文件正文或额外文件快照。

使用同一模型是语义一致性和配置简化的默认选择。可能的 prompt-cache 命中只是成本与延迟优化，不能作为窗口正确性的依据。

### 6.5 简单输入上限，而非模型矩阵

V1 保留应用级 `maxSummaryInputTokens`、`maxSummaryTokens`、`maxNarrativeTokens` 和 `minimumIncrementalHeadroomTokens`，用统一 estimator 限制单次 summary request。`maxSummaryInputTokens` 约束完整 request，而不只是历史正文；固定 prompt、分隔 framing、旧 narrative、限长后的 custom instructions 和 compactable history 都必须计入。上述值用于资源保护和选择 bounded safe prefix，不声称等于 Provider 的真实窗口。

Estimator 遵守 ADR-0023：显式配置或实际 adapter runtime metadata 提供受支持 tokenizer 时可以采用对应实现；否则使用固定、provider-neutral、带版本号的 approximate estimator。Before/after 必须使用同一个 estimator version。Approximate estimate 只能证明相对缩减和应用级上限，不能证明 Provider admission 或真实 utilization，也不能产生阻断。

配置必须满足 `maxSummaryTokens <= maxNarrativeTokens`，并为固定 envelope 与 `minimumIncrementalHeadroomTokens` 保留空间。模型请求实际设置 `maxSummaryTokens`；输出验证同时要求 narrative estimate 不超过 `maxNarrativeTokens`，防止旧 narrative 吞尽下一次增量输入。

边界选择按完整 turn 从旧到新装入，超过完整 request 上限时停止；不得拆分单个 turn。已有 checkpoint 时，先为旧 narrative 和最小增量 headroom 记账，再装入新 turn。若没有新 turn 能装入，但“旧 narrative 的重新压缩”能够产生预登记的绝对缩减，则允许本次模型调用只把旧 narrative 重写为更短的单一 narrative，covered boundary 保持不变；后续 `/compact` 再继续推进。该路径仍是一次调用、一个 summary，不是 chunk/merge。

若下一个完整 turn 在 M1 后单独加固定 envelope 仍超过应用上限，则返回稳定的 `oversized_turn`，不得拆 turn、自动切模型或循环重试。这个限制必须在 `/context` 和失败诊断中明确显示。

V1 不实现：

- direct 失败后自动 chunk；
- 多次 chunk summary；
- rolling/hierarchical merge；
- JSON repair retry；
- 因任意 400 自动缩块重试；
- 自动切换其他 summary model。

这样每次压缩固定只有一次逻辑模型调用。Provider SDK 的传输重试必须在 summary request 上显式关闭或固定为零；否则遥测和文档必须把 HTTP attempt 与逻辑调用分别计数，不能宣称只有一次实际 Provider 请求。压缩 source 太大时，通过“只覆盖一个有界的最老 safe prefix”或“只缩短当前 narrative”控制请求，而不是把整段历史拆成多次模型任务。

### 6.6 模型输出契约

模型只输出普通 Markdown narrative。不得要求或解析 JSON metadata、fact ledger、file selection、RuntimeState 或第二个附加产物。固定 prompt 要求它保留：

- 用户目标和明确约束；
- 已做出的重要决定；
- 已完成工作；
- 失败、重要发现和验证结论；
- 当前未完成事项和下一步；
- 后续继续工作所需的文件路径或符号名称（仅作为文本历史，不自动读取）。

模型不得输出 tool call，也不负责生成：

- fact ID、evidence message ID；
- source digest、covered boundary；
- checkpoint ID、schema version；
- RuntimeState；
- file ID、文件选择或文件正文；
- Provider-specific token metadata。

输出只做最低必要验证：

1. 非空且不是纯空白；
2. finish reason 不是 length；
3. 没有 tool call；
4. 可稳定序列化；
5. 没有被误解析为 Provider 错误响应；
6. 候选投影相对压缩前有实际缩减。
7. narrative estimate 不超过 `maxNarrativeTokens`。

首版不做 schema repair。验证失败即本次压缩失败，保留原 checkpoint 和 transcript。

### 6.7 轻量 checkpoint

新 checkpoint 收敛为：

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
  reason: "manual" | "auto";
  createdAt: string;
  provider?: string;
  model?: string;
  baseCheckpointId?: string;
}
```

`inputTokensBefore/After` 是同一应用 estimator 下的相对诊断值，不宣称等于 Provider 计费或真实窗口 token。是否持久化 provider/model 只用于审计，不参与 replay 正确性。

不进入 checkpoint：

- 完整 fact/evidence ledger；
- file ledger；
- refreshed file content；
- 动态 RuntimeState；
- progress；
- Provider 原始响应和 usage；
- debug 日志路径。

### 6.8 增量压缩

已有 checkpoint 时，新 source 为：

```text
当前 checkpoint narrative
+ checkpoint boundary 之后的新 settled safe prefix
```

模型仍只调用一次，返回一份新的完整 narrative。新 checkpoint 整体替换当前 active checkpoint，Provider context 中始终只有一个有效 summary，不产生嵌套 summary 链。

`sourceDigest` 使用当前 checkpoint source digest 与新 tail digest 的稳定 hash chain；`baseCheckpointId` 仅用于诊断增量链路。Narrative-only shrink 不覆盖新 transcript，因此保留原 `coveredThroughMessageId`、`coveredThroughTurnId` 和 `sourceDigest`，不得对空 tail 再 hash 出一个伪造的新 source；只更新 checkpoint identity、summary、revision、estimate、reason 和 createdAt。

`baseCheckpointId` 明确定义为上一 active checkpoint 的 `compactionId`。实现不得引入第二个含义重复的 checkpoint identity。Replay 校验必须能从原 transcript 按规范算法重算 covered prefix digest；hash chain 的序列化格式和版本属于 Core 元数据，不由模型生成。

### 6.9 候选验证与激活

Summary 返回后，先重新解析当前 projection environment。只有 Runtime revision、turn、pending identity 和 environment digest 都仍匹配 effect lease，才用统一 `buildContextProjection()` 构建 before 与 candidate after；两次使用同一份完成时 state、tool schema、skill、model capability、estimator 和 runtime projection 环境。若环境不匹配，按 4.5 的 stale 语义丢弃并由当前 state 决定是否重新 lease。

最低验收：

- candidate boundary 仍存在；
- source digest 与 covered source 匹配；
- effect lease 仍有效；
- source revision 未 stale；
- summary message 是低权限 assistant history；
- live tail 未被覆盖；
- canonical frame 和最终 Provider message pairing 均通过；
- candidate 可 JSON round-trip；
- `inputTokensAfter < inputTokensBefore`；
- manual 与 auto 都达到同一个预登记最小绝对缩减。

成功后写入 `context.compaction_completed`。Reducer 原子替换 active checkpoint、清除 pending request、更新 history/guard，并保留完整 transcript。Candidate pressure 只进入诊断；它不影响 checkpoint 激活，也不创建、保留或解除 correctness block。

### 6.10 压缩后消息顺序

```text
稳定 system instructions
稳定 tool schema layer
CompactionSummaryFrame（历史消息区第 1 条，普通 assistant message）
checkpoint 之后的 live transcript tail
动态 RuntimeState projection
```

`CompactionSummaryFrame` 的 message content 必须且只能是 4.3 定义的 `<compacted_history>...</compacted_history>`。每个 Provider request 最多存在一个该 frame；不得额外生成“以下是摘要”、fact section、file section 或隐藏 assistant preamble。Summary 在 checkpoint 生命周期内使用规范化序列化，字节内容和位置保持稳定。动态 plan、authorization、verification、时间戳、request ID、usage 和诊断不得写入 summary frame。

这里的“历史消息区第 1 条”不表示 summary 位于 system/tool instruction 之前。Provider 最终请求必须先保持稳定指令层，再以 summary 开始历史层；这样既满足历史最前位置，也不提升 summary 权限。

### 6.11 Checkpoint 持久化与 TUI 重进恢复

压缩历史必须持久化。`context.compaction_completed` 事件携带完整轻量 checkpoint，Reducer 将其写入 `RuntimeState.context.activeCheckpoint`；RuntimeStore 同时保存 event log 和包含 active checkpoint 的 snapshot。Checkpoint 中只持久化原始规范化 Markdown `summary` 与 Core 元数据，不持久化 XML wrapper；重进时由 4.3 的纯 serializer 重新生成逐字节一致的 `<compacted_history>` frame。

退出 TUI、进程重启或切回 dormant session 后，恢复顺序固定：

1. 加载最新受支持的 Runtime snapshot；
2. replay snapshot 之后的 event tail；
3. 校验 checkpoint schema/version、compaction identity、covered message/turn boundary 和可从原 transcript 重算的 source digest；
4. 使用当前实际 provider/model/tool/skill/config 重新解析 projection environment；
5. 从恢复后的 active checkpoint 构建且只构建一个 XML summary frame，并把它放在历史消息区第一位；
6. 重新计算当前 context status，然后才允许下一次普通模型请求。

恢复过程不得调用 summary model、不得再次压缩、不得把 summary 追加回 transcript，也不得生成第二个 summary frame。最后一个 durable 事件是 completed 而 snapshot 尚未写入时，event-tail replay 必须正常激活 checkpoint；snapshot 已包含 completed 时，event ID/revision 去重必须阻止重复激活和重复用户提示。

崩溃点语义：

- 只有 requested/pending、尚无 durable terminal event：重进后清除旧的非持久化 progress，重新解析当前环境；该 summary 调用没有外部副作用，因此 scheduler 可以用同一 `compactionId` 安全地重新执行一次，仍受 lease/stale 规则约束；
- Provider 已返回但 completed/failed 尚未持久化：视同 pending，允许重新调用，不能假设上一次模型结果存在；
- completed/failed/cancelled 已持久化：只 replay terminal event，不重新调用 Provider；
- session 切换或 TUI 退出：先 flush RuntimeStore；UI token/cache 辅助统计写入失败不能影响 checkpoint durability。

损坏或不受支持的 checkpoint 必须“对派生投影 fail closed、对原会话可恢复”：不得投影损坏 summary，也不得导致 TUI 崩溃或删除 transcript。Runtime 隔离该 checkpoint，使用原始 transcript 重建上下文并展示一次脱敏恢复提示；只要原 transcript 能构造安全投影，就继续允许普通 Provider 请求。只有原 transcript 也无法满足 canonical pairing 或其他 Runtime 不变量时，才创建 correctness block。不得静默把损坏 checkpoint 当作成功摘要继续使用。

## 7. 失败、阻断与恢复

### 7.1 Manual failure

Provider 400、timeout、abort、空 summary、length truncation、unexpected tool call、unsafe boundary、serialization failure、oversized turn 和 insufficient reduction 都生成 `context.compaction_failed`，但：

- 不修改 transcript；
- 不替换当前 active checkpoint；
- 不创建普通 hard block；
- session 保持可交互；
- 用户可再次尝试、切换模型、rewind、reset 或 clear。

Runtime/effect lease 或 projection environment 变化导致的 stale result 不属于 compaction failure，不生成 `context.compaction_failed`；它按 4.5 丢弃并记录低敏感度 reporter 指标。这样不会让已经过时的 effect 通过“失败事件”修改新 state。

### 7.2 Auto failure

记录失败并更新 breaker，不创建 hard block，不在同一 turn 无限重试。用户仍可手动 `/compact`。

### 7.3 Runtime correctness block

`ContextHardBlock` 不属于自动压缩等级。它只保护可以由 Kite 确定证明的 Runtime correctness failure，例如：

- canonical frame 或最终 projection 无法保持 tool pairing；
- RuntimeState、snapshot 或 event tail 被验证为 corrupted；
- checkpoint 损坏且无法从原 transcript 安全恢复；
- reducer、lease 或状态机出现不可恢复的一致性违规；
- 所有允许的确定性降级都无法构造安全 Provider request。

下列情况一律不得创建或维持 hard block：

- 达到 warning、compact、target 或原 hard ratio；
- estimated tokens 高于配置的 context window；
- manual 或 auto 压缩失败；
- candidate 压缩后仍高于某个本地比例；
- Provider 返回 HTTP 400 或其他请求错误；
- tokenizer、context window 或 capability unknown；
- 单个 stale effect result。

Correctness block 必须携带独立、可审计的不变量错误原因，并且只在对应损坏被修复、隔离或通过安全重建消除后解除。Token preflight 不参与其创建或解除。

### 7.4 Cancelled 与 stale 终止

用户取消、session 切换、reset/clear 使 pending 不再适用，或 stale discard 后最新 state 决定不再 re-lease 时，必须由最新 Runtime revision 生成 `context.compaction_cancelled`。该事件不是 stale effect result：它只在 reducer 确认相同 `compactionId` 仍 pending 时清除 pending，不替换 checkpoint、不创建 hard block、不累计 failure/breaker，并为 App/API 提供唯一 cancelled 终态。

若 reset/clear 已经在同一批 state transition 中清除了 pending，则不得再追加重复 cancelled event；App result service 仍以该 transition 映射一次 cancelled notice。任何路径都不得让被拒绝的旧 effect 自己提交取消事件。

### 7.5 稳定失败分类

首版持久失败分类固定为：

```text
unsafe_boundary
oversized_turn
summary_model_failed
summary_timeout
summary_aborted
empty_summary
truncated_summary
unexpected_tool_call
serialization_failed
invalid_candidate
insufficient_reduction
```

Provider 原始状态码和脱敏消息只作为诊断字段，不改变 `errorKind`。`stale_result`、shadow eligibility 和 cohort miss 只属于 reporter result，不进入 `ContextCompactionErrorKind`。新增或合并失败种类必须同步更新 Runtime round-trip、TUI 文案和指标分母。

### 7.6 开发期 checkpoint 处理

当前 agent 尚未正式上线，不为现有结构化 checkpoint 提供兼容 reader、数据迁移或跨版本回滚。实现切换时直接更新开发期 session、snapshot、fixture 和测试；无法读取的本地开发数据可以清理或重建。

## 8. 明确延期的能力

以下能力从本计划移除，不要求预留接口：

### 8.1 关键文件预读

不做第二次文件选择调用，不创建 `FileLedger`、`RefreshedFilesFrame`、digest/invalidation 和 workspace resolver。压缩后模型需要代码正文时，正常调用现有读取工具。

只有真实数据同时证明“压缩后频繁重复读取”和“重复读取显著影响成本、延迟或任务成功率”时，才新建立项和 ADR。建议观察：前三个 turn 的重复 read 次数、首次有效操作延迟、3-turn refill 和任务继续成功率。

### 8.2 完整事实审计

不要求模型生成 fact ID，也不在首版构建完整 evidence graph、mandatory coverage 和 user-message coverage。若 canary 发现重要目标、约束、失败或 pending work 经常遗漏，先调整单一 narrative prompt、模型选择策略和人工 reset/retry 指引。任何代码生成的 `mustKeep` frame、第二段事实正文或附加 payload 都不属于本计划；若未来确需引入，必须新建 ADR，并仍需说明为什么不能保持单一 summary 产物。

### 8.3 Provider overflow 自动识别

不解析错误文本，不维护供应商适配矩阵，不把任意 400 映射为 compaction。结构化 adapter signal、自动 recovery 和跨 provider 一致语义需要独立证据与设计。

### 8.4 精确预算与模型路由

不维护逐模型摘要最佳长度、文件预算、summary model 路由或 tokenizer 校准矩阵。`ResolvedModelCapabilities` 继续存在，但只聚合显式配置和实际 runtime metadata；模型名称内置能力目录属于本阶段明确删除项，不是延期能力。Manual summary 采用当前模型、单次调用、简单上限和失败可恢复语义。

## 9. 用户进度、诊断与隐私

### 9.1 进度

V1 只需要三个非持久化阶段：

```ts
type ContextCompactionStage = "preparing" | "summarizing" | "validating";
```

Progress 不进入 RuntimeEvent、RuntimeState、snapshot 或 replay。它不包含用户文本、文件路径、工具输出、custom instructions 或 summary 正文。completed、failed、cancelled 和 stale 后必须清除；session 切换不得串状态；不展示虚假百分比。

Manual 和 auto 使用同一个 progress callback/service，只允许 source label 不同：

```ts
interface ContextCompactionProgressNotice {
  compactionId: string;
  source: "manual" | "auto";
  stage: "preparing" | "summarizing" | "validating";
}
```

阶段语义固定：

- `preparing`：解析 projection environment、选择 safe boundary、执行 M1、构建 bounded summary request；
- `summarizing`：唯一一次 summary model 调用正在执行；
- `validating`：执行 XML-safe normalization、candidate projection、pairing、reduction、lease/environment freshness 和完成时 hard preflight；
- narrative-only shrink 仍按同样三个阶段展示，不新增另一套 UI 流程。

### 9.2 用户终态提示

每个 `compactionId` 必须恰好产生一个用户可见终态 notice；auto 不能静默成功或静默失败：

- completed：提示“上下文压缩完成”，可附 approximate before/after 和 reduction；不得展示 summary 正文，也不展示 token hard 状态；
- failed：提示“上下文压缩失败”，展示稳定、本地化且脱敏的 error kind，并明确“会话历史未更改，可重试”；
- cancelled：提示“上下文压缩已取消，会话历史未更改”；
- stale 且将自动重新 lease：不产生终态，只把进度切回 `preparing` 并显示“上下文已变化，正在重新准备”；stale 且不再重试时归一为一次 cancelled notice；
- Provider 原始错误、prompt、custom instructions、summary 和工具正文不得进入 notice。

终态 notice 是 App/API 展示事件，不是 `user`、`assistant` 或 `tool` transcript message，不得改变下一次模型请求。TUI 必须在 notice 发出前清除 spinner；API/CLI 使用同一类型化 result 映射，不能各自猜测成功或失败。Replay 可以从持久的 completed/failed/cancelled lifecycle event 按 `compactionId` 去重并重建一条静态终态记录，但不得再次触发 toast，也不得重放非持久化中间 progress。

### 9.3 Footer 上下文统计

TUI 底部 `Footer` 中的 `StatsLine` 必须展示“当前下一次模型请求的 context projection”，不能把累计 usage 当成当前上下文大小。Core 提供唯一只读状态：

```ts
interface ContextStatusSnapshot {
  projectedInputTokens: number;
  estimatorKind: "exact" | "approximate";
  estimatorVersion: string;
  usableInputBudgetTokens?: number;
  contextWindowSource?: "explicit_config" | "adapter_runtime" | "compatibility_config";
  utilization?: number;
  pressure: "normal" | "warning" | "compact_due" | "unknown";
  runtimeRevision: number;
  projectionEnvironmentDigest: string;
}
```

该 snapshot 必须通过与正常请求、preflight、`/context` 和 compaction candidate 相同的 `buildContextProjection()`、estimator 和 resolved capability 生成。`StatsLine` 禁止调用 `listAvailableModels()` 或按模型名查静态 `contextWindow`，禁止使用累计 `StatusState.totalTokens` 计算 context percentage；累计 usage/cache 可以继续显示，但必须使用不同标签，不能冒充当前 context。

显示规则：

- window/usable budget known：`ctx 12.4k/60k · 21%`，百分比直接使用 Core preflight utilization；
- window unknown：`ctx ≈12.4k`，不显示百分比或 ratio；
- pressure 颜色：normal=muted、warning=warning、compact_due=warning 强调、unknown=muted；颜色只表达自动压缩启发式，不表示 Provider admission；
- Footer 不显示 last compact、历史 reduction、checkpoint reason 或 before/after；这些只保留在 checkpoint、用户终态提示和遥测中；
- 窄终端优先保留 `ctx` 当前值，依次省略 denominator、percentage，不得显示历史压缩指标替代当前 context。

更新时机：

- `context.compaction_completed` 激活 checkpoint 后，在同一 state/render commit 中用 candidate/fresh projection 更新 `ctx`；不能先显示成功、状态栏仍保留压缩前数值；
- compaction failed/cancelled/stale 不激活 checkpoint，保持 last committed projection，并在 pending 清除后重新计算一次；
- reset/rewind/clear、user/model/tool transcript、tool schema、Skill、model/provider/config 或 capability source 变化都会使 snapshot 失效并重算；
- TUI 重进会话时按 6.11 从恢复后的 RuntimeState 和当前环境重算，不能依赖独立 `token_stats` 表恢复 context truth；
- progress 期间 `StatusBar` 展示 preparing/summarizing/validating，`StatsLine` 保持 last committed context；只有 completed 激活后才切换到 after，避免展示尚未接受的 candidate。

`ContextStatusSnapshot` 是派生 UI 数据，不进入 checkpoint、transcript 或 Runtime 正确性事实。可以按 `runtimeRevision + projectionEnvironmentDigest` 缓存，但不得由 TUI 自行拼装。计算只在相关 event/environment 变化时发生，不挂到 100ms spinner timer，避免 Footer 重绘抖动。

### 9.4 生产遥测

最小低敏感度字段：

```text
releaseSha / policyVersion / cohort
reason / result / errorKind
providerType / modelHash
contextWindowSource / tokenizerSource / estimatorKind / estimatorVersion
inputTokensBefore / inputTokensAfter / reductionRatio
durationMs / staleResult / correctnessBlocked
turnsSincePreviousCompaction
```

压缩成功后的第 1～3 个 turn 记录 refill follow-up，用于判断是否频繁再次压缩或重复读取。

生产遥测不得包含用户 prompt、summary input/output、文件正文、tool stdout、custom instructions、凭据、完整模型名或工具 schema。

### 9.5 本地 debug

显式开启时，单次 compaction debug 文件可以记录 summary request、原始响应、finish reason、usage、boundary、digest 和 before/after projection。它只用于本地排障：

- 不上传；
- 不参与 Runtime 正确性；
- 不随普通 session export；
- POSIX 目录/文件权限分别为 `0700/0600`；Windows 使用当前用户 owner-only ACL、禁用权限继承，并拒绝 reparse point/junction/symlink 目标；
- atomic rename；
- 有保留期或总大小清理；
- 防目录穿越和 symlink 覆盖；
- 写入失败不导致 compaction 失败。

权限、atomic rename、cleanup 和路径防护必须分别覆盖 Windows 与 POSIX 测试；不能用 `chmod` 成功作为 Windows 隔离已成立的证明。

V1 不新增持续覆盖的 `current-context.json`，避免把所有普通模型请求的完整敏感内容引入本次交付。

## 10. 代码收敛与删除矩阵

实现目标是替换旧方案，不是增加第三套 compaction。当前 agent 未正式上线，不保留 structured checkpoint、overflow recovery 或 builtin capability 的兼容分支。

截至复核提交，compaction 专用 Core 文件约 3,000 行、相关 Runtime 测试约 5,000 行。其中 `compaction-schema.ts`、`compaction-fact-ledger.ts`、`compaction-summary.ts` 和 `context-compaction-summary.test.ts` 构成最大的旧结构化集群；model controller、Runtime state/reducer 和 manual helper 还分散着 overflow/manual recovery、cached preflight 与双重估算逻辑。以下矩阵按真实 symbol/import 审计形成，实施 PR 必须逐项收敛。

| 当前区域                               | 必须删除或原地重写                                                                                                                       | 最终保留                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `model/compaction-schema.ts`           | 整文件删除；移除 V1/V2 Zod schema、parser、migration、fact ID helper                                                                     | 无                                                                                            |
| `model/compaction-fact-ledger.ts`      | 整文件删除；移除 deterministic ledger、base merge 和 coverage                                                                            | 无；不得以 `mustKeep` frame 或其他附加事实 payload 回填                                       |
| `model/compaction-summary.ts`          | 原地重写；删除 structured prompt、JSON parse/repair、chunk/merge、ledger/provenance validation                                           | 单次 Markdown generator、narrative compactor、最小 validation error                           |
| `model/compaction-v2.ts`               | 删除 `ContextMessageChunk`、`chunkCompactionMessages()`、开发期 legacy synthetic turn recovery；文件按职责改名                           | safe boundary、source digest、bounded safe prefix                                             |
| `model/compaction.ts`                  | 整文件删除；移除 deprecated `estimateTokens()`、`shouldCompact()` 和第二套 threshold math                                                | `context-budget.ts`/统一 estimator 是唯一估算入口                                             |
| `model/context-frame-compactor.ts`     | 删除 legacy turn inference；缺少稳定 turn identity 时不得合成边界或继续压缩                                                              | M1 resource tracker、完整 turn/tool block 折叠；缺失 identity 时保护并 fail closed            |
| `model/context-projection.ts`          | 删除 structured summary 的 `JSON.stringify`、版本分支和兼容投影                                                                          | 唯一 XML-safe `CompactionSummaryFrame` serializer、历史区首位投影、before/after 共用序列化与 tool-pair validation |
| `model/context-budget.ts`              | 删除 `hard_limit` pressure、hard ratio 和任何 admission/block 语义                                                                       | `normal/warning/compact_due/unknown` 诊断与 auto trigger estimate                             |
| `model/model-capabilities.ts`          | 删除 `BUILTIN_MODEL_CAPABILITIES`、隐式 4096 reservation 和 boolean false fallback；重写 resolver                                        | 带字段来源的 explicit/runtime/compatibility/unknown 聚合                                      |
| `model/context-compaction-decision.ts` | 删除 `ProviderContextOverflowError`、`isProviderContextOverflow()`、`auto_soft/auto_hard` 和 hard decision                               | 只产生 `reason=auto` 的 ratio/absolute decision 和单一 thrash breaker                         |
| `controllers/model-controller.ts`      | 删除 overflow catch/recovery、ratio hard gate、`createHash` 和 recovery metrics                                                           | 普通 Provider error 直接返回上层；本地 preflight 只产生可选 auto trigger                       |
| `controllers/compaction-controller.ts` | 删除 structured schema imports、provenance validation 和 hard-ratio acceptance                                                           | revision + environment lease、boundary、summary string、统一 relative reduction               |
| `runtime/context-compaction.ts`        | 删除 `manual_recovery`、`overflow_recovery`、`overflowRecoveryTurnId`、`auto_soft`、`auto_hard`、structured error kinds 和 token hard block | `manual/auto`、轻量 checkpoint、独立 Runtime correctness block                                 |
| `runtime/executor.ts`                  | 删除 structured compactor factory 与重复 capability resolution 接线                                                                      | 注入单次 narrative compactor；共享已解析的可信 capability                                     |
| `runtime/kernel.ts` / RuntimeStore     | 删除 snapshot replay 中的 `recoverLegacySyntheticTurns()`                                                                                | snapshot + event tail 恢复 active checkpoint；terminal 去重；损坏派生 checkpoint 隔离恢复     |
| `runtime/events.ts` / `invariants.ts`  | 删除 `overflow_recovery_failed`、`auto_soft`、`auto_hard`、`lastPreflight` invariant 和 structured checkpoint 约束                        | 轻量 checkpoint、pending、lease、completed/failed/cancelled 和 correctness invariants         |
| `runtime/reducer.ts` / scheduler       | 删除 recovery reason、soft/hard reason、ratio block 与 `lastPreflight` 特判                                                              | manual/auto 共用 reducer；只有独立 invariant failure 可创建 correctness block                 |
| `model/context-compaction-manual.ts`   | 删除 cached `lastPreflight`、`fallbackEstimate()`、manual_recovery/force 和重复 rejection event 组装                                     | fresh projection、统一 manual request、`/context`、可信 reset preflight                       |
| `app/tui/session-manager.ts`           | 删除手工拼装 manual requested/failed event、重复 capability resolution 与 preflight                                                      | 调用 Core 统一 command/progress/result service，展示三个阶段和唯一终态 notice                  |
| `app/tui/StatsLine.tsx` / `types.ts`   | 删除 `listAvailableModels()` 静态窗口查询、`totalTokens/contextWindow` 百分比和 `compactionBefore/After` 常驻展示                         | 只消费 Core `ContextStatusSnapshot`；展示当前 projected context、known/unknown window 与 pressure |
| `model/compaction-metrics.ts`          | 删除 overflowRecoveries、auto soft/hard、chunk/retry/schema 专用指标和全局 singleton                                                     | 注入式 reporter/exporter；requested/completed/failed、duration、reduction、source、stale      |
| `config/index.ts` / `types.ts`         | 删除 `softRatio`、`hardRatio`、`targetRatio`、`recentWindowSize`、`ContextBudget.maxTokens/compactionThreshold` 和未消费的 breaker 配置  | `recentTurns`、summary input/output/narrative/headroom 上限、trigger ratio/tokens、rollout/breaker policy |
| tests                                  | 删除 structured fact/provenance/chunk/repair/overflow/legacy capability 断言，不保留 skip 或 compatibility fixture                       | narrative、boundary、M1、checkpoint、unknown capability、manual/auto 共管线测试               |

额外收敛规则：

- 不新增 `compaction-summary-v3.ts`、`legacy-compactor.ts` 或双 checkpoint union；优先原地重写稳定入口。
- `ContextPreflight` 是一次 projection 的临时结果，不在 `ContextRuntimeState.lastPreflight` 中作为后续 manual/reset/acceptance 权威复用。
- `projectionEnvironmentDigest` 必须进入 effect lease 和完成时 stale/acceptance 判断；请求事件中的 digest 只用于诊断，effect 开始与完成时都要从实际环境重新计算。若实现无法消费该字段，必须阻断 PR，不能降级为只写日志。
- Public config 只保留实现实际读取的字段。V1 breaker 使用一份集中 policy；当前未消费的三项 breaker 配置要么接入同一 policy，要么删除，本计划选择删除。Rollout policy 必须真正控制稳定分桶和 `off/shadow/live`，不得只出现在遥测标签中。
- 删除量应大于新增兼容层；Code Review 不接受仅标记 `@deprecated`、保留无人调用 export 或用新 facade 包住旧 pipeline。

完成实现后，下列搜索应无结果：

```text
StructuredContextSummary
compaction-fact-ledger
createStructuredContextCompactor
chunkCompactionMessages
mode: 'repair' | 'chunk' | 'merge'
manual_recovery
overflow_recovery
overflow_recovery_failed
overflowRecoveryTurnId
auto_soft
auto_hard
ProviderContextOverflowError
isProviderContextOverflow
recoverLegacySyntheticTurns
BUILTIN_MODEL_CAPABILITIES
lastPreflight
softRatio
recentWindowSize
shouldCompact(
```

`provenance`、`repair`、`chunk` 等通用词可在其他非 compaction 子系统存在；门禁只扫描 compaction/model-controller/runtime-context 相关文件。

## 11. 实施 PR 顺序

### PR-0：评审并接受 ADR-0022/0023

状态：completed（2026-07-22）

交付：

- 评审并接受部分替代 structured-summary/overflow-recovery 决定的 ADR-0022；
- 评审并接受删除 builtin capability catalog、固定能力来源的 ADR-0023；
- 更新 ADR 索引与计划引用；
- 不修改描述当前运行行为的 active/book，除非只是修正文档链接且不声称未来行为已经生效。

退出：ADR-0022/0023 accepted，文档检查通过，后续 PR 的行为边界无歧义，active 文档仍准确描述当前结构化实现。

后续说明：ADR-0024 是 PR-1 完成后接受的追加决策，不追溯改写 PR-0 只评审 ADR-0022/0023 的完成事实。

### PR-1：先统一 reason、manual/auto 管线与 400 语义

状态：completed（2026-07-22）

交付：

- request reason 先收敛为 `manual/auto_soft/auto_hard`；
- 删除 `manual_recovery`、Core 通用 overflow inference、`overflow_recovery` 自动调度及其 RuntimeState/metrics；
- call_model 失败后 session 可继续接收 `/compact`；
- hard block 下仍使用普通 `manual`，scheduler 明确放行 manual effect；
- 保持当前 structured summary generator 作为此 PR 的唯一现有实现，不新增兼容 facade 或第二套 compactor；
- 更新与 400、reason、manual recovery 当前行为直接相关的 active/book 和 feature flag 真值表。

退出：代码和持久 schema 中不再存在 `manual_recovery`、`overflow_recovery`、`overflow_recovery_failed`；Provider 400 不自动压缩、不自动 hard block；用户随后执行 `/compact` 可进入当前唯一压缩管线。这为 PR-1A 删除 `auto_soft/auto_hard` 与容量型 hard block 提供了无 overflow recovery 的稳定基线。

该 PR 完成时仍保留 `auto_soft/auto_hard`，属于当时 ADR-0022/0023 下的阶段性状态。ADR-0024 接受后由 PR-1A 继续收敛，不能把这段完成记录改写成最终设计。

### PR-1A：实施 ADR-0024 并收敛 manual/auto

状态：completed（2026-07-22）

交付：

- 以已接受的 ADR-0024 作为实现依据；
- `ContextCompactionReason`、pending、checkpoint、event、metrics 和 breaker 收敛为 `manual | auto`；
- `auto_soft` 重命名为 `auto`，删除 `auto_hard`；
- 删除 ratio-driven hard gate 术语（比例驱动硬门禁）和 compaction-failure hard block；
- rollout mode 收敛为 `off/shadow/live`；
- `ContextHardBlock` 只保留 Runtime correctness failure 原因；
- 同步更新 active/book/config 与 Runtime round-trip 测试。

退出：新代码和新持久数据不再生成 `auto_soft/auto_hard`；任何 token ratio、estimated window、candidate pressure、Provider error 或 compaction failure 都不能创建或维持 hard block；manual/auto 使用相同验收阈值。

### PR-2：先固定边界、environment lease 与 correctness block

状态：completed（2026-07-22）

交付：

- bounded safe prefix 与完整 turn/tool-pair property tests；
- M1 幂等、状态保真和 before/after 统一 projection；
- revision + projection environment lease、完成时环境重新解析和 stale discard；
- correctness block 唯一 factory、明确 invariant reasons 与恢复 helper；
- 先在当前唯一 structured pipeline 上证明这些不变量，不新增 narrative/legacy 平行实现；
- 更新 environment freshness、stale 和 correctness-block 当前行为对应的 active/book。

退出：transcript 不变、无 orphan pair；revision/environment stale 结果不产生 RuntimeEvent 或 checkpoint；token pressure 不产生 block；只有可复现的 Runtime invariant failure 才能阻断。后续 narrative 切换直接继承已验证的 lease/boundary/correctness safety。

### PR-3：单次 Markdown summary 与轻量 checkpoint

状态：completed（2026-07-22）

交付：

- 新 narrative prompt 和纯文本 generator，模型内容产物只有 `summary: string`；
- 删除 `compaction-schema.ts`、`compaction-fact-ledger.ts` 和全部 JSON schema/repair/chunk/merge 路径；
- 原地重写 `compaction-summary.ts`，不新增平行 compactor；
- 删除 legacy `model/compaction.ts`、chunk helper 和 synthetic-turn recovery；
- `ContextBudget` 收敛为只含 `recentTurns` 的 projection policy；
- narrative checkpoint 正式 schema，Runtime 不再使用 structured summary union；
- 单次调用、summary envelope/headroom、finish reason、`maxNarrativeTokens`、narrative-only shrink、oversized-turn 与最低输出验证；
- 唯一 `<compacted_history>` XML-safe serializer，summary 固定为历史消息区第一条且每个 request 最多一条；
- 更新 narrative/checkpoint 当前行为对应的 active/book。

退出：structured summary/fact ledger/chunk/repair export 与测试引用均为零；checkpoint 的唯一模型内容字段是 Markdown `summary`；首次压缩、增量压缩、narrative-only shrink、manual/auto 同构和 reset 测试通过。

### PR-4：删除内置模型能力目录

状态：completed（2026-07-22）

交付：

- 删除 `BUILTIN_MODEL_CAPABILITIES`；
- 清理默认 Provider/模型列表中的静态 context window、max output、tokenizer、usage 和 cache capability；
- 删除 `usableInputBudget()` 的隐式 4096 reservation 和 unknown→false fallback；
- `ResolvedModelCapabilities` 增加字段级 source 和 tri-state unknown；
- resolver 只接受 explicit config、adapter runtime 和 compatibility config；
- known 官方模型名在无可信来源时同样返回 unknown；
- TUI、`/context`、disclosure、auto decision 和 metrics 适配 unknown/approximate；
- 增加显式 `compactAfterEstimatedTokens` absolute auto policy，默认未配置。
- 更新 model-provider/capability/config 当前行为对应的 active/book。

退出：模型名称不再影响 capability；unknown window 不显示百分比、不运行 ratio auto；任何 window source 都不产生 token-driven hard block；manual `/compact` 不受影响。

### PR-5：序列化与恢复

状态：completed（2026-07-22）

交付：

- 每一种 context RuntimeEvent/RuntimeState 分支的 JSON round-trip；
- snapshot + event tail restore；
- request 后退出、effect 中退出、completed 后 snapshot 前退出；
- narrative checkpoint round-trip 和 corrupted checkpoint fail-closed；
- TUI/进程重启恢复 active checkpoint、唯一 XML frame 和 current context status，不调用 summary model；
- pending/in-flight、completed 后 snapshot 前、snapshot 已含 completed 的 crash matrix与 terminal notice 去重；
- 删除 `lastPreflight`、unused environment digest、summaryVersion/policyVersion/targetTokens 和旧 error kinds；
- 删除 `softRatio`、`recentWindowSize` 及未消费的 breaker config；
- 连续增量压缩和 reset/replay。

退出：crash/replay matrix 全绿，原 transcript 可恢复；退出 TUI 再进入同一会话时 summary frame、live tail、correctness block 和 Footer current context 均正确且无重复 Provider 调用/终态提示。

### PR-6：进度、遥测与本地 debug

状态：completed（2026-07-22）

交付：

- preparing/summarizing/validating 非持久化进度；
- Core 统一的 completed/failed/cancelled result 与 App/API 用户提示映射，每个 compactionId 恰好一个终态 notice；
- Core `ContextStatusSnapshot` 与 Footer `StatsLine` 投影；删除静态模型窗口和累计 usage 伪 context 百分比；
- 最小结构化指标及 3-turn follow-up；
- 删除 overflow/chunk/repair 专用指标和全局 singleton，改为由 Runtime 组合根注入 reporter/exporter，并明确 flush owner；
- 实现稳定 session 分桶与 `off/shadow/live` rollout policy；shadow 不调用模型、不构造 candidate after；
- 显式 opt-in 的本地 compaction debug；
- 更新 `docs/active/tui-run-status-bar.md`、model-provider/context active 文档；
- POSIX mode 与 Windows owner-only ACL、atomic write、cleanup 和 session 隔离测试。

退出：manual/auto 都展示三个阶段；任何终态和 stale discard 不遗留 spinner；每个 compactionId 恰好一个脱敏终态 notice且不进入 transcript；Footer 使用 fresh ContextProjection，在完成、reset、环境变化和 TUI 重进后数值正确；相同 salt/session 始终落入同一 cohort；各 mode 真值表通过；生产日志无正文泄漏。

### PR-7：Required CI 与真实 Provider 套件

状态：completed（2026-07-22）

新增固定 job：

```text
quality: typecheck + format:check + lint + core-boundary + docs
unit: bun run test
compaction-contract: bun run test:mock
runtime-e2e: bun run test:e2e
tui-system: bun run test:tui:system
```

`quality` 中的 docs 明确同时执行 `bun run check:docs` 与 `bun run check:docs-impact`。PR-7 同步把 `test:e2e` 收敛为只运行 `tests/e2e/local/`；TUI scenarios 只由 `test:tui:system` 运行，避免重复且符合真实模型测试边界。

真实模型测试放在 `tests/e2e/live/model/*.live.ts`，通过显式 `bun run` wrapper 执行，不进入默认测试发现。真实 Provider 套件覆盖 Provider 敏感的 manual direct summary 与增量压缩；400 后手动压缩、空/截断/timeout、stale 和 auto 等确定性控制语义由 `test:mock` contract 套件覆盖，避免消耗真实配额重复验证本地分支。

CI 增加第 10 节的残留符号扫描；出现 structured summary、overflow recovery、builtin capability 或 legacy compaction symbol 时直接失败，不允许用 ignored/skip/deprecated wrapper 绕过。仓库内 workflow 和固定 job 名是本计划的 CI 交付边界，不要求配置仓库外 GitHub ruleset。

## 12. 测试矩阵

### 12.1 不变量

- 原 transcript message 的数量、顺序和内容在成功/失败压缩前后不变；压缩只追加 lifecycle RuntimeEvent；
- reset 后恢复原始历史投影；
- summary 永不进入 system message；
- active summary 经过 XML 转义后是历史消息区第 1 条且恰好出现一次；`</compacted_history>`、`&`、`<` 等正文不能逃逸 wrapper；
- complete turn/tool pair 始终完整；
- recent tail 未被覆盖；
- stale result 不写 checkpoint；
- revision/environment stale result 不写 lifecycle RuntimeEvent，progress 在 `finally` 清除；
- manual 与 auto 产生同一 schema 的 checkpoint；
- 对相同 state、summary response 和 projection environment，manual/auto 产生逐字节相同的 summary frame 与同构 checkpoint，差异只允许出现在 reason 和 Core 诊断元数据；
- Provider 400 不自动触发压缩或 hard block。
- ratio、absolute threshold、estimated over-window 和 compaction failure 均不创建 hard block。

### 12.2 Model capability resolution

- `BUILTIN_MODEL_CAPABILITIES` 不存在；
- DeepSeek/OpenAI/Ollama 等已知模型名在无显式/runtime metadata 时仍为 unknown；
- explicit config 覆盖 adapter runtime 与 compatibility config；
- adapter runtime 覆盖 compatibility config；
- static SDK/model catalog 不能伪装成 adapter runtime；
- unknown boolean capability 与显式 `false` 可区分；
- unknown window 不显示 utilization、不运行 ratio auto；
- 显式 absolute threshold 可以触发 auto，但不改变 capability；
- approximate estimator 在 before/after 使用相同 version。
- effect 开始/完成之间 model/tool/skill/config digest 变化时 candidate 不激活；

### 12.3 Summary contract

- 单次 Markdown 成功；
- custom instructions 作为数据且限长；
- 空白输出；
- finish reason length；
- 意外 tool call；
- timeout/abort/400；
- insufficient reduction；
- 一个完整 turn 超出 summary 输入上限；
- 旧 narrative 占满输入时先执行 narrative-only shrink，covered boundary 不前移；
- narrative 输出不超过 `maxNarrativeTokens`，checkpoint 中不存在第二个模型内容字段；
- 当前 narrative + 新 tail 的增量压缩。

### 12.4 M1 与边界

- 大型 read/search/shell 输出；
- success/failure/rejected/cancelled/exhausted；
- 多工具并行调用；
- result 顺序变化；
- missing/orphan result；
- running tool；
- 缺少稳定 message/turn identity 时 fail closed；
- 同一输入重复折叠结果一致。

### 12.5 恢复

- pending request 重启；
- provider 调用中崩溃；
- completed event 后、snapshot 前崩溃；
- correctness block、breaker、reset 后重启；
- compaction 成功后 candidate pressure 只进入诊断，不影响 checkpoint 激活；
- narrative checkpoint round-trip；
- 退出 TUI/进程后重新进入同一 session：不调用 summary model，恢复唯一 XML summary frame、live tail、correctness block 和 checkpoint identity；
- snapshot 落后于 completed event、snapshot 已包含 completed、event tail 重复输入均只激活一次 checkpoint；
- checkpoint 损坏时隔离派生数据、原 transcript 可见、TUI 可交互且有一次恢复提示；
- 连续 20 次增量 checkpoint digest chain 长度稳定。

### 12.6 Rollout、隐私与 CI

- 同一 `cohortSalt + sessionId` 稳定分桶，salt 变化才允许重新分配；
- `off/shadow/live` 真值表覆盖 known/unknown window；
- shadow evaluator 的 Provider 调用数、compaction request/completed/failed event 和 checkpoint 写入数均为 0；
- auto master flag 关闭后 resolved mode 恒为 off，普通 Provider 请求仍由 Provider 实际决定是否接受；
- POSIX `0700/0600` 与 Windows owner-only ACL、no-inheritance、reparse-point rejection；
- `test:e2e` 不发现 TUI 或 `*.live.ts`，`test:tui:system` 不被其他 required job 重复执行；
- `quality` 同时执行 docs structure 与 docs impact gate。

### 12.7 进度与用户提示

- manual 与 auto 都按 `preparing → summarizing → validating` 顺序展示，不跳过 summarizing 或伪造百分比；
- completed、failed、cancelled 分别恰好一个终态 notice，且先清 spinner 再提示；
- stale re-lease 回到 preparing，不重复终态；stale 不重试时只提示一次 cancelled；
- failed notice 使用稳定脱敏 error kind，并明确 transcript 未改变；
- 所有 progress/notice 均不增加 transcript message、不进入 candidate projection，session 切换不串状态；
- replay 只恢复终态提示，不重放 preparing/summarizing/validating。

### 12.8 Footer 上下文统计

- completed 激活前 Footer 保持 before，激活后同一 render commit 切换为 fresh after/current projection；
- 新增 user/model/tool tail 后 `ctx` 从 after 继续增长，不把 last checkpoint `inputTokensAfter` 固定冒充当前值；
- Footer 不显示 last compact、reduction 或 checkpoint before/after，只显示当前 projected context；
- failed/cancelled/stale 不显示未接受 candidate；reset 后恢复原 transcript projection；
- known window 使用 Core utilization，unknown window 只显示 `ctx ≈N` 且无百分比；
- model/provider/tool schema/Skill/config/capability source 变化使 projection cache 失效；
- 退出 TUI 重进后从 RuntimeState 重算，与退出前相同环境下数值一致；不得读取 `listAvailableModels()` 静态窗口或用累计 `totalTokens` 计算 context；
- 窄终端裁剪优先保留当前 `ctx`，StatsLine 更新不依赖 100ms StatusBar timer。

## 13. 发布与灰度

### A. 代码正确性

完成 PR-0、PR-1、PR-1A 和 PR-2 至 PR-7；仓库内 Required workflow 的全部 job 在同一 SHA 全绿；仓库默认 auto flag=false、rollout mode=off。灰度环境只对受控 cohort 显式覆盖，不改变默认配置。

### B. Manual canary

受信用户和模型 allowlist；至少 100 次有效 `/compact`，覆盖不少于 7 天。

退出条件：

- transcript 损坏、orphan tool pair、跨 session 污染、不可恢复 checkpoint 均为 0；
- 每次 progress 都有终态；
- Provider/timeout/truncation/validation/stale 失败均可分类；
- 成功率、P95 延迟和最小 reduction 门槛在阶段开始前登记；
- 400 后手动恢复场景有真实 Provider 证据，但不宣称 Core 能识别 400 原因。

### C. Shadow auto

Shadow evaluator 只执行本地 trigger、M1 后 source size、safe boundary 和 before projection，不调用 summary model、不伪造 candidate after、不写 compaction request/completed/failed event 或 checkpoint，也不制造任何 block。分别覆盖“已配置窗口 + ratio policy”和“未知窗口 + 显式 absolute policy”，至少 1,000 个长会话；每种 capability source 和 auto policy 都记录独立分母。

退出条件：trigger 混淆矩阵、estimator kind/version、capability source 和 safe-boundary eligibility 均有报告；unknown window 不运行 ratio decision；Shadow 不宣称 summary 质量。

### D. 1% live auto

命中 1% 稳定 cohort 的 policy mode=`live`，只产生 `reason=auto`，至少运行 7 天。任何 transcript/tool-pair/session/replay 事故立即回滚。观察成功率、失败后会话可交互性、延迟、reduction、3-turn refill、manual reset 和重复文件读取。

### E. 5% live auto

1% 稳定后扩大到 5%，ratio 与 absolute cohort 都继续使用同一个 `reason=auto`。不加入 Provider 400 recovery，也不增加 hard gate。要求压缩成功率 ≥ 97%、自动失败后 session 可交互率 100%、3-turn refill < 2%，且零数据完整性事故和零 ratio-driven block。

### F. 25% 验证上限

连续至少 14 个完整自然日，同时达到：

- 5,000 个 cohort 会话；
- 1,000 个达到 ratio warning 或 absolute threshold 的长会话，并按 policy/source 分组；
- 每个候选 provider/model 至少 200 次压缩尝试；
- release SHA、policy、模型 allowlist 和指标定义在窗口内冻结。

25% 是本计划验证上限。完成后仓库默认 `contextCompactionAutoV1=false`、mode=off 保持不变；生产覆盖仅存在于冻结的受控 policy。继续扩大流量或改变默认值必须另行批准。

## 14. 回滚

1. 将 cohort mode 从 `live` 降为 `shadow`：停止新的 auto summary，只保留只读 trigger 评估。
2. 将 cohort mode 降为 `off`：连 shadow 也停止。
3. 关闭 `contextCompactionAutoV1`：作为 master kill switch 强制所有 cohort mode=off，保留 manual 和已有 checkpoint。
4. 关闭 `contextCompactionManualV1`：禁止新建 manual checkpoint，已有 checkpoint 继续投影。
5. 只有 V2 projection 本身故障时关闭 `contextCompactionV2`；按 ADR fail closed，不静默回退 legacy。

功能回滚不删除 checkpoint、不修改 transcript、不自动 reset 用户状态。开发期 schema 数据不提供跨版本兼容保证，可以随实现重置。

## 15. Go / No-Go

### Go

- ADR-0022/0023/0024 和 active 文档已与实现共同收敛；
- required CI、mock contract、replay/property 和 live suite 在发布 SHA 全绿；
- 样本窗口内 transcript 损坏、orphan tool pair、session 污染和 durable serialization failure 均为 0；
- manual 失败不破坏当前 active checkpoint；
- manual/auto 共享同一 Core pipeline、XML serializer、progress/result service；
- summary 是历史消息区第一条且唯一使用 `<compacted_history>` wrapper；
- completed/failed/cancelled 都有且只有一个不进入 transcript 的用户提示；
- active checkpoint 可跨 TUI/进程重启恢复，重进不重新总结、不重复 frame/notice，Footer context 与恢复后的投影一致；
- revision/environment stale result 不改变当前 state，且不会遗留 progress；
- 400 后 session 可交互且能手动 `/compact`；
- auto 成功率 ≥ 97%，自动失败后 session 可交互率 100%，3-turn refill < 2%；
- token ratio、配置窗口、candidate pressure、Provider error 和 compaction failure 产生的 hard block 均为 0；
- `off/shadow/live` 降级与三层 flag 回滚均已演练。

### No-Go

- 实现继续生成 `auto_soft/auto_hard`，或保留 token-driven hard block，从而违反 ADR-0024；
- 任一 transcript、tool pairing、跨 session 或 replay 确定性事故；
- manual 依赖精确 tokenizer/context window 才能执行；
- 任何模型名称、provider type 或静态 SDK catalog 被用于补齐 capability；
- unknown window 产生 utilization 或 ratio auto；
- Core 通过通用 400 文本猜测 overflow；
- auto 与 manual 使用不同压缩算法；
- checkpoint 出现 summary 之外的第二个模型生成内容载荷；
- summary 不在历史消息区首位、缺少 XML wrapper、出现多个 wrapper 或正文能够逃逸 wrapper；
- auto/manual 任一路径没有进度、静默终止、重复终态提示，或提示被写进 transcript；
- TUI 重进丢失 checkpoint、重新调用 summary model、重复投影 summary，或 Footer 使用累计 usage/静态模型目录计算 context；
- stale effect 通过 `context.compaction_failed` 修改更新后的 RuntimeState；
- candidate 未通过完成时 environment freshness 就激活；
- shadow 调用 summary model、构造虚假 candidate after 或写入 compaction RuntimeEvent；
- `auto_soft`、`auto_hard`、`soft_hard` 或 ratio-driven hard block 重新进入最终 schema；
- 文件预读、fact graph、chunk/merge 被重新塞回 V1 必选范围；
- live Provider 行为未验证或指标缺少版本、窗口、分子与分母；
- 仓库内 Required workflow 缺失或任一固定 job 未通过。

## 16. 验证命令

仅修改本计划时：

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
bun run check:docs
bun run check:docs-impact
bun run test
bun run test:mock
bun run test:e2e
bun run test:tui:system
```

真实模型测试只能通过显式 opt-in runner 执行；未运行时只能声明本地/mock 验证结果。
