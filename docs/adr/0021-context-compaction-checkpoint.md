# ADR-0021：上下文压缩采用事件驱动 checkpoint 模型，不直接改写 transcript

状态：accepted
日期：2026-07-19
修订：2026-07-20（补充信任边界、增量 checkpoint、持久 hard block、候选投影验证等决策）
补充：ADR-0001、ADR-0007、ADR-0008

## 决策

上下文压缩不对原始 `RuntimeEvent` 日志或 `RuntimeState.transcript` 做不可逆删除。改为在模型上下文投影层引入可持久化的 `ContextCompactionCheckpoint` 作为派生数据，由事件驱动的 `compact_context` effect 统一生成、校验和替换。

核心边界：

1. **原始 transcript 是不可变历史**。即使 checkpoint 存在，session restore 和 `/compact reset` 始终可以回退到原始 transcript 重建上下文。
2. **RuntimeState 是当前状态权威**。plan、authorization、interaction、verification 等动态事实永远从 RuntimeState 投影，不得写入 checkpoint summary 成为替代事实来源。
3. **checkpoint 是模型上下文投影**。它只描述已完成的历史事实，不影响状态机决策。旧的 checkpoint 被新的 checkpoint 替换，不会反复嵌套摘要。
4. **summary 是受验证的派生数据**。必须通过 Zod schema、provenance、mandatory fact IDs、message coverage 和基于候选投影的 token gain 共计五道校验才可写入 checkpoint。
5. **自动和手动压缩共用同一个 event/effect/checkpoint 管线**。唯一区别是触发来源 `reason`。

## 架构约束

### Canonical Context Frame 作为 provider-neutral 中间层

所有压缩逻辑（M1 确定性折叠、M2 摘要注入）必须在 provider-neutral `ContextFrame` 层执行：

```text
RuntimeState.transcript
  → canonical frames（ToolCallBlockFrame 保证 tool-pair 完整性）
  → checkpoint + live tail（摘要覆盖已结算历史，活跃尾部保持不变）
  → M1 确定性折叠（幂等、不修改 RuntimeState）
  → runtime state 投影（plan / mode / authorization）
  → provider 序列化（LangChain BaseMessage[] 只在最后一步生成）
  → pairing validator（阻止不合规消息进入模型调用）
```

多工具调用必须保持为一个 `ToolCallBlockFrame`，不允许被错误地切开或合并。

### 统一 ContextProjection 服务

所有模型上下文构建路径（正常调用、preflight、`/context`、M2 candidate validation、checkpoint restore、debug export、shadow evaluation）必须调用同一个纯函数入口，禁止不同路径各自实现一套 token 计算或 transcript 截取规则。

### 信任边界：摘要不是 system instruction

checkpoint summary 必须序列化为普通 assistant history message（`CompactionSummaryFrame`），不得进入 provider system instructions。历史用户文本、工具结果、文件内容、外部日志等不可信数据不得获得 system 权限。

System prompt 中只保留稳定规则，并明确声明 `<compacted_history>` 是派生历史数据而非系统策略。当前 permissions、plans、tools 和 verification state 仅由 RuntimeState 动态注入的独立 section 提供。

### 自定义压缩指令不得提升为 system prompt

`/compact focus on ...` 的自定义文本必须作为数据字段（`customPreferences`）传入摘要模型，不得拼接到摘要模型的 system prompt。摘要模型的固定 system prompt 必须明确规定：custom preferences 只能改变侧重点，不能覆盖 output schema、mandatory facts、provenance、coverage rules、safety requirements 或 token limits。

### 增量 checkpoint，而非重新总结全部 transcript

已有 checkpoint 后再次压缩时，source = 旧结构化 summary + checkpoint 之后的新 settled tail，而非从 transcript 开头重新读取全部原始消息。不把旧 summary 当普通自然语言重新总结，而是执行结构化 merge：`validated old StructuredContextSummaryV2 + deterministic ledger for new tail + new tail source messages → StructuredContextSummaryV2`。

### 候选投影验证压缩收益

禁止使用近似减法（`before - sourceTokens + summaryTokens`）判断收益。必须在生成 summary 后构建候选 checkpoint，通过同一个 ContextProjection 服务完整重建模型请求，计算真实 after estimate，再与 target 比较。

### 自动与手动压缩共用同一 controller/effect

自动压缩（soft/hard threshold 触发）和手动压缩（`/compact` 命令）的唯一区别是触发来源（`reason: 'auto_soft' | 'auto_hard' | 'overflow_recovery' | 'manual'`）。两者共用：

- `compact_context` effect
- `CompactionController`
- structured summary 生成与校验流程
- checkpoint 持久化与替换逻辑

### 复用 Kernel effect lease 做并发控制

压缩期间如果 RuntimeState 被新事件更新（revision 递增），`applyEffectResult` 返回 false，摘要结果丢弃，不写 checkpoint。不引入第二套锁或版本号。

### hard failure 必须持久阻断

hard-limit 导致的压缩失败（`hard_limit`、`overflow_recovery_failed`）必须写入 `ContextHardBlock` 并持久化到 `ContextRuntimeState`。只允许以下情况解除：

1. `context.compaction_completed` 成功
2. `/clear` 或创建新会话
3. transcript rewind 后重新 preflight，已低于 hard
4. 用户 reset checkpoint 后重新 preflight，仍然低于 hard
5. 工具/capability 配置变化显著减少上下文，并重新 preflight 成功

任何无关 event 或 revision 增长不得解除 hard block。

### 防止自动压缩抖动

新增 session 级 circuit breaker (`AutoCompactionGuard`)：最近 10 turn 内自动压缩 >= 3 次，或连续 2 次压缩后 1 turn 内再次达到 compactRatio，或连续 2 次 reductionRatio < minimumReductionRatio，则停止 proactive auto-compaction，但仍允许手动 `/compact` 和一次 overflow recovery。

### Structured Summary 不替代模型判断关键事实

采用 Deterministic Fact Ledger + Summary Model 的混合模式：

1. 从 RuntimeState 和事件结构中确定性提取 mandatory fact IDs：用户目标、约束、文件修改、失败结论、verification 结果、pending work。
2. 模型只负责压缩叙述文本，不决定哪些事实可以丢失。
3. 校验时 mandatory fact ID 覆盖率必须为 100%，否则摘要被拒绝。
4. 每个 ledger fact 至少有一条 evidence 位于 covered range 内。
5. read-only 结果只进入 observation，不进入 completed work。

### 用户消息覆盖验证

`summary.provenance.coveredUserMessageIds` 必须与 compacted range 中全部 user message ID 相等。每条 user message 至少被 objective、userRequests、userConstraints、decisions、pendingWork 或 unresolvedQuestions 之一引用。

### Feature flag 渐进灰度

新增三个 feature flag，按阶段独立开启：

| Flag | 职责 |
|---|---|
| `contextCompactionV2` | Canonical frame + 安全 M1 + pairing validator。第一阶段开启，替换旧 M1。 |
| `contextCompactionAutoV1` | 自动软/硬阈值触发 + overflow recovery。第二阶段灰度。 |
| `contextCompactionManualV1` | `/compact` 命令。可先于自动 M2 开放。 |

任一 flag 关闭时，对应路径 fail closed（不执行压缩），不进入 legacy 兼容路径。

## 理由

当前 `src/core/model/compaction.ts` 的 `shouldCompact()` 和 `estimateTokens()` 已实现但从未接入模型调用路径（model-controller 未传递 `contextBudget`）。直接在现有 `BaseMessage[]` 压缩代码上增加 M2 对话摘要会加剧以下问题：

- **数据层混乱**：LangChain message 是 provider 边界格式，不应承担领域级压缩；ToolMessage content 既是对模型展示的正文，又是压缩器反解析结构化元数据的唯一来源（`extractPath` / `extractTotalLines` / `extractCommand` 均通过 `JSON.parse(content)` 猜测）。
- **tool-pair 风险**：多 tool-call AIMessage 可能被错误地作为一个压缩块处理；压缩后无再次校验。
- **不可恢复**：没有 checkpoint 概念，摘要一旦混入消息列表就无法回退、审计或失效。
- **信任边界缺失**：checkpoint summary 被构造为 SystemMessage 注入 provider system instructions，使历史用户文本、工具输出、文件内容获得 system 权限。
- **重复压缩低效**：已有 checkpoint 后再次压缩仍从 transcript 开头读取全部消息，摘要成本随会话长度增长。
- **收益验证不准确**：token reduction 使用近似减法而非候选投影完整重建。
- **hard failure 可绕过**：基于 `revision <= sourceRevision + 1` 的临时判断可被无关事件解除。

把压缩提升为 first-class Runtime 概念（effect + event + checkpoint）可以复用已验证的 Kernel 并发控制、snapshot 持久化和 session restore 机制，同时保持原始 transcript 的不可变性。

## 后果

- **RuntimeState schema 版本递增**：新增 `context` 字段（`ContextRuntimeState`），旧 snapshot migration 默认 `{ history: [] }`。
- **新增 RuntimeEffect**：`compact_context`，scheduler 优先级位于 verification 之后、call_model 之前。
- **新增 RuntimeEvent**：`context.compaction_requested`、`context.compaction_completed`、`context.compaction_failed`、`context.compaction_reset`。
- **新增 CompactionController**：负责 summary 模型调用、schema 校验和 fact ledger 构建。
- **摘要消息角色**：checkpoint summary 必须作为 `CompactionSummaryFrame` 序列化为 assistant history message，不得作为 SystemMessage 注入。
- **旧 M1 代码生命周期**：`microCompactToolOutputs()` 和 `foldToolOutputs()` 在 V2 稳定后标记 deprecated 并删除。
- **文档映射**：新增文件需要更新 `docs/documentation-map.json` 的 `model-and-context` zone。
- **未知上下文窗口**：无法解析 `contextWindow` 时标记为 explicit unknown 状态，不假设默认值，向用户输出明确配置提示。proactive auto M2 不运行。
- **测试要求**：除单元测试外，需要真实数据链路测试（RuntimeEvent → reduce → canonical frames → M1 → provider messages → validator）和属性测试。
- **配置跨字段校验**：`warningRatio < compactRatio < hardRatio`、`maxSummaryInputTokens + maxSummaryTokens + safetyMargin <= contextWindow` 等必须在 Zod schema 层 enforce。
