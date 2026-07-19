# ADR-0021：上下文压缩采用事件驱动 checkpoint 模型，不直接改写 transcript

状态：proposed
日期：2026-07-19
补充：ADR-0001、ADR-0007、ADR-0008

## 决策

上下文压缩不对原始 `RuntimeEvent` 日志或 `RuntimeState.transcript` 做不可逆删除。改为在模型上下文投影层引入可持久化的 `ContextCompactionCheckpoint` 作为派生数据，由事件驱动的 `compact_context` effect 统一生成、校验和替换。

核心边界：

1. **原始 transcript 是不可变历史**。即使 checkpoint 存在，session restore 和 `/compact reset` 始终可以回退到原始 transcript 重建上下文。
2. **RuntimeState 是当前状态权威**。plan、authorization、interaction、verification 等动态事实永远从 RuntimeState 投影，不得写入 checkpoint summary 成为替代事实来源。
3. **checkpoint 是模型上下文投影**。它只描述已完成的历史事实，不影响状态机决策。旧的 checkpoint 被新的 checkpoint 替换，不会反复嵌套摘要。
4. **summary 是受验证的派生数据**。必须通过 Zod schema、provenance、mandatory fact IDs、message coverage 和 token gain 五道校验才可写入 checkpoint。

## 架构约束

### Canonical Context Frame 作为 provider-neutral 中间层

当前 M1 压缩直接在 LangChain `BaseMessage[]` 上执行，这违反了 provider 边界隔离原则。所有压缩逻辑（M1 确定性折叠、M2 摘要注入）必须迁移到 provider-neutral `ContextFrame` 层：

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

### 自动与手动压缩共用同一 controller/effect

自动压缩（soft/hard threshold 触发）和手动压缩（`/compact` 命令）的唯一区别是触发来源（`reason: 'auto_soft' | 'auto_hard' | 'overflow_recovery' | 'manual'`）。两者共用：

- `compact_context` effect
- `CompactionController`
- structured summary 生成与校验流程
- checkpoint 持久化与替换逻辑

### 复用 Kernel effect lease 做并发控制

压缩期间如果 RuntimeState 被新事件更新（revision 递增），`applyEffectResult` 返回 false，摘要结果丢弃，不写 checkpoint。不引入第二套锁或版本号。

### Structured Summary 不替代模型判断关键事实

采用 Deterministic Fact Ledger + Summary Model 的混合模式：

1. 从 RuntimeState 和事件结构中确定性提取 mandatory fact IDs：用户目标、约束、文件修改、失败结论、verification 结果、pending work。
2. 模型只负责压缩叙述文本，不决定哪些事实可以丢失。
3. 校验时 mandatory fact ID 覆盖率必须为 100%，否则摘要被拒绝。

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

把压缩提升为 first-class Runtime 概念（effect + event + checkpoint）可以复用已验证的 Kernel 并发控制、snapshot 持久化和 session restore 机制，同时保持原始 transcript 的不可变性。

## 后果

- **RuntimeState schema 版本递增**：新增 `context` 字段（`ContextRuntimeState`），旧 snapshot migration 默认 `{ history: [] }`。
- **新增 RuntimeEffect**：`compact_context`，scheduler 优先级位于 verification 之后、call_model 之前。
- **新增 RuntimeEvent**：`context.compaction_requested`、`context.compaction_completed`、`context.compaction_failed`、`context.compaction_reset`。
- **新增 CompactionController**：负责 summary 模型调用、schema 校验和 fact ledger 构建。
- **旧 M1 代码生命周期**：`microCompactToolOutputs()` 和 `foldToolOutputs()` 在 V2 稳定后标记 deprecated 并删除。
- **文档映射**：新增文件需要更新 `docs/documentation-map.json` 的 `model-and-context` zone。
- **未知上下文窗口**：无法解析 `contextWindow` 时标记为 explicit unknown 状态，不假设默认值，向用户输出明确配置提示。
- **测试要求**：除单元测试外，需要真实数据链路测试（RuntimeEvent → reduce → canonical frames → M1 → provider messages → validator）和属性测试。
