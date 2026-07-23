# 上下文压缩精化执行计划

创建日期：2026-07-20
状态：superseded
优先级：P0
依赖：`docs/space/plans/2026-07-19-context-compaction-v2.md`（原始 V2 设计方案）

替代者：`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。本文件保留为历史设计参考，不再作为当前实施依据。
关联 ADR：`docs/adr/0021-context-compaction-checkpoint.md`（accepted，2026-07-20 修订）

## 概要

`compact` 分支（`6262a65c`）已具备完整 V2 骨架：canonical context frames、M1 确定性折叠、结构化摘要、durable checkpoint、自动 soft/hard/overflow 触发、手动 `/compact`、Runtime event/scheduler/effect lease 和恢复机制。1830 项测试通过。

本方案不是重写，而是在现有事件化 checkpoint 架构上的精化。目标：修复信任边界、事实覆盖、重复压缩、预算估算和 hard-failure 状态机，使其达到可默认开启自动压缩的生产标准。

参考基线：Claude Code 公开文档描述的上下文管理行为（优先清理旧工具输出 → 必要时总结历史；支持 `/compact [instructions]`；`/context` 显示占用；系统规则、项目记忆、技能不依赖摘要；PreCompact/PostCompact 扩展点）。Kite Code 借鉴这些行为契约，但不复制私有实现。

---

## 1. 现状差距分析

### 1.1 已实现能力

| 维度 | 状态 | 核心文件 |
|---|---|---|
| Canonical Context Frames | ✅ | `model/context-frame.ts`, `model/context-frame-builder.ts` |
| M1 确定性折叠 | ✅ | `model/context-frame-compactor.ts`（去重读文件、折叠搜索结果、资源失效追踪） |
| M2 结构化摘要 | ✅ | `model/compaction-summary.ts`（schema 验证、provenance、mandatory fact、repair） |
| 事件驱动 checkpoint | ✅ | `runtime/events.ts:65-98`, `runtime/context-compaction.ts` |
| Effect lease 并发安全 | ✅ | scheduler 优先级 + revision 校验 |
| Safe boundary | ✅ | `model/compaction-v2.ts`（turn 完整性、tool 配对、terminal 状态） |
| Deterministic fact ledger | ✅ | `model/compaction-fact-ledger.ts` |
| Token 估算 | ✅ | `model/context-budget.ts`（分项 + preflight） |
| 自动决策 | ✅ | `model/context-compaction-decision.ts` |
| 手动 `/compact` | ✅ | `model/context-compaction-manual.ts` + TUI hook |
| Feature flag 灰度 | ✅ | `contextCompactionV2` / `autoV1` / `manualV1` |
| 测试（7 套） | ✅ | frame compactor、compaction、auto、manual、summary、e2e、metrics |

### 1.2 关键缺陷

按严重程度排列：

| # | 缺陷 | 影响 | 对应 PR |
|---|---|---|---|
| 1 | **checkpoint summary 注入为 SystemMessage** | 历史用户文本、工具输出、文件内容获得 system 权限，可被 prompt injection 利用 | PR 1 |
| 2 | **read_file 被归类为 completed work** | `completed_work` 判定条件 `call.sideEffect \|\| path`，所有 `read_file` 都有 path | PR 3 |
| 3 | **无 user message 覆盖验证** | 整轮用户修正可能被静默漏掉 | PR 3 |
| 4 | **每次压缩从 transcript 开头重新读取** | 摘要成本随会话长度增长；旧历史反复总结导致语义漂移 | PR 4 |
| 5 | **收益用减法近似** | `before - sourceTokens + summaryTokens` 不计 system/tool schema/framing 开销 | PR 5 |
| 6 | **hard failure 不持久** | 基于 `revision <= sourceRevision + 1` 的临时判断，无关 event 可解除 | PR 6 |
| 7 | **无 auto thrash breaker** | 上下文快速回填后反复压缩，浪费 token | PR 6 |
| 8 | **无 provider overflow error 标准化** | Runtime 解析任意错误字符串判断 overflow | PR 6 |
| 9 | **配置无跨字段校验** | 不检查 `maxSummaryInputTokens + maxSummaryTokens + safetyMargin <= contextWindow` | PR 6 |
| 10 | **无 `/context` 命令** | 用户无法查看上下文分项占用 | PR 8 |
| 11 | **无 legacy session migration** | 旧消息归入当前 turn，sentinel 不一致 | PR 7 |
| 12 | **无 PreCompact/PostCompact hooks** | 缺少扩展点 | PR 9 |
| 13 | **无 estimator calibration** | 估算不与 provider actual usage 对齐 | PR 9 |

---

## 2. 分阶段 PR 计划

### PR 1：修复信任边界

**修改范围**：

- `model/context-frame.ts`：`CompactionSummaryFrame` 序列化逻辑（已有类型定义，需接入）
- `controllers/model-controller.ts:162-187`：`compactedTranscriptProjection()` 改为注入 assistant history message，而非 SystemMessage
- `model/compaction-summary.ts`：自定义指令从 system prompt 移至数据字段 `customPreferences`
- `model/context.ts`：system prompt 增加 untrusted-history 规则声明
- 新增 prompt injection 测试

**验收**：

- checkpoint summary 在 provider messages 中以 `role: 'assistant'` 出现
- system prompt 永远不包含用户历史内容
- 自定义 `/compact` 指令不会进入 system prompt
- prompt injection 测试无法通过历史内容提升权限

**上线条件**：`contextCompactionManualV1 = true`, `contextCompactionAutoV1 = false`

### PR 2：统一 ContextProjection

**修改范围**：

- 新建 `model/context-projection.ts`：`buildContextProjection()` 纯函数入口
- 正常模型调用、preflight、candidate validation、`/context` 四路径统一调用
- 使用真实 `SerializedToolDescriptor[]` 计算 tool schema tokens
- 删除各路径中的分散 token 计算和 transcript 截取

**验收**：

- 所有路径使用同一入口函数
- `ContextProjection` 包含 systemMessages / summaryMessages / transcriptMessages / dynamicRuntimeMessages / tools / frames / providerMessages / estimate 八个字段
- tool schema tokens 基于实际 provider adapter 输出的 schema

### PR 3：Fact Ledger V2

**修改范围**：

- `model/compaction-fact-ledger.ts`：
  - `isCompletedEffect` 改为 `effectClass === 'workspace_write' \|\| effectClass === 'external_side_effect'`，read-only 不进入 completed work
  - 每个 ledger fact 增加 `evidenceMessageIds` 校验（全部位于 covered range）
  - 新增 `coveredUserMessageIds` 计算
  - 新增 raw/projected digest 分层（`ToolResultMeta.digestScope`）
- `model/compaction-schema.ts`：新增 `StructuredContextSummaryV2` schema（向后兼容读取 V1）
- `model/compaction-summary.ts`：校验时增加 user message coverage 检查

**验收**：

- `read_file` 成功结果不进入 `completedWork`
- workspace write / external side effect 必须进入 `completedWork`
- failed / rejected / cancelled 必须进入 `failures`
- `coveredUserMessageIds` 与 compacted range 全部 user message ID 相等
- 每条 user message 被至少一个 fact category 引用

### PR 4：增量 checkpoint

**修改范围**：

- `model/compaction-summary.ts`：`IncrementalCompactionSource`（base summary + new settled tail）
- `runtime/context-compaction.ts`：`ContextCompactionCheckpointV2`（增加 `baseCheckpointId`、`summaryVersion`、`policyVersion`）
- `model/compaction-schema.ts`：`StructuredContextSummaryV2.provenance.sourceDigest` 链式计算
- V1 checkpoint 向后兼容读取
- 新增 repeated-compaction 测试（10 轮连续压缩）

**验收**：

- 已有 checkpoint 后压缩时 source 不包含已覆盖的原始 transcript
- summary token 不指数增长
- `baseCheckpointId` 链正确
- V1 checkpoint 可正常投影，下次压缩升级为 V2

### PR 5：候选投影验证收益

**修改范围**：

- `controllers/compaction-controller.ts`：summary 生成后构建候选 checkpoint → 调用 `buildContextProjection()` → 计算真实 after estimate
- 删除减法近似逻辑
- 分别应用自动和手动的收益规则（自动必须低于 target，手动必须有正收益）
- manual minimum saved tokens = 1024

**验收**：

- after estimate 包含 system / tool schema / framing / summary serialization 全部开销
- 自动压缩后 `after.totalInputTokens <= targetInputTokens`
- 手动压缩收益不足时返回明确提示

### PR 6：自动压缩状态机

**修改范围**：

- `model/context-compaction-decision.ts`：`ContextPressure` 五态（unknown / normal / warning / compact_due / hard_limit）
- `runtime/context-compaction.ts`：`ContextHardBlock` 类型 + `autoGuard: AutoCompactionGuard`
- `runtime/reducer.ts`：hard block 持久化与解除逻辑
- `runtime/events.ts`：`context.hard_block_set` / `context.hard_block_cleared` 事件
- `controllers/model-controller.ts`：标准化 `ProviderContextOverflowError`
- `config/index.ts`：跨字段关系校验（`warningRatio < compactRatio < hardRatio` 等）
- 阈值调整：`softRatio` → `compactRatio: 0.88`，`hardRatio: 0.94`，新增 `warningRatio: 0.80`

**验收**：

- warning 不触发摘要，只记录 telemetry
- hard 无 safe boundary → durable block
- hard block 经无关 event 后仍阻断
- overflow 每 turn 只恢复一次；重复 overflow → durable hard block
- auto thrash breaker 触发后停止 proactive auto
- 配置非法值在 parse 阶段拒绝

### PR 7：Legacy session migration

**修改范围**：

- `model/compaction-v2.ts` 或新文件：按 user boundary 恢复 synthetic turns
- sentinel 统一（`turnKey = message.turnId \|\| SENTINEL_NO_TURN`）
- `ToolResultMeta.digestScope = 'legacy_unknown'` 标记
- M1 对 legacy metadata 缺失的消息 fail closed

**验收**：

- v13/v14 transcript 正确分组为 synthetic turns
- 缺失 messageId / turnId 的消息受保护
- 旧 V1 checkpoint 可投影，下次压缩升级为 V2
- 旧 tool result 不折叠

### PR 8：用户体验

**修改范围**：

- `app/tui/` 新增 `/context` 命令处理
- `/compact reset` 实现（含 hard block 预检）
- `controllers/compaction-controller.ts`：进度事件流（非持久 UI progress）
- StatsLine 分项或 tooltip
- warning / hard block / thrash 提示文案

**`/context` 输出示例**：

```text
Context usage: 86,420 / 121,856 usable tokens (70.9%)

System instructions       8,210
Project and skills        6,310
Tool schemas             17,880
Compacted history         7,420
Live transcript          40,210
Dynamic runtime           5,620
Provider framing            770

Output reservation        8,192
Safety margin             2,560

Active checkpoint: cmp_01...  Covered through: turn_37
Last reduction: 112,400 → 86,420 (23.1%)
Auto-compaction: enabled
Next proactive threshold: 107,233 tokens
```

### PR 9：hooks 与可观测性

**修改范围**：

- plugin/app 边界提供 PreCompact / PostCompact 扩展点
- metrics 增强（compaction_duration_ms、source_tokens、utilization_before/after、estimation_error_ratio、turns_until_refill、hard_block_total 等）
- estimator calibration：provider 返回 usage 后按 provider+model 维护 EWMA correctionFactor
- 隐私保护：默认日志禁止包含 summary 正文、用户消息正文、文件正文、tool stdout、custom instructions

---

## 3. 灰度上线

| 阶段 | 配置 | 目标 |
|---|---|---|
| A — Manual Only | `autoV1=false, manualV1=true` | 收集手动成功率、schema repair 率、reduction ratio |
| B — Shadow Auto | 记录"本应触发"但不执行 | 比较预估 vs 实际 overflow、safe boundary 可用率 |
| C — Model Allowlist | 仅已知窗口 + 可靠 usage metadata 的模型启用 | 控制风险面 |
| D — 小比例执行 | 逐步增加比例，kill switch 保持可用 | 验证 thrash breaker、estimator calibration |
| E — 默认开启 | `autoV1=true` 作为默认值 | 验收标准持续满足后执行 |

---

## 4. 推荐最终默认配置

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
    "minimumManualSavedTokens": 1024,
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

完成 PR 1～7 和 shadow evaluation 后，再将 `contextCompactionAutoV1` 改为 `true`。

---

## 5. 验收标准

自动压缩默认开启前必须满足：

### 正确性

- tool-pair 属性测试 100% 通过
- mandatory fact coverage 100%
- user message coverage 100%
- prompt injection 测试无法提升历史内容权限
- stale checkpoint 永不落盘
- hard failure 不因无关事件解除
- restart/replay 结果一致

### 效果

- 自动 M2 成功后 below target
- reduction ratio 达到配置标准
- 连续压缩没有 summary 膨胀
- candidate estimate 与最终实际 provider request 使用同一投影

### 预算

- actual usage 样本足够后，P95 估算误差不超过 10%
- 不发生系统性低估导致的频繁 provider overflow
- summary 请求不在 hard boundary 才首次启动

### 稳定性

- pending compaction crash 后可恢复
- overflow recovery 不循环
- legacy session 可压缩
- auto thrash breaker 生效

---

## 6. 架构原则

整个实现坚持五条：

1. **原始 transcript 永远不被压缩器修改。**
2. **RuntimeState 永远是当前状态的唯一权威。**
3. **摘要只作为低权限的派生历史数据。**
4. **自动和手动压缩必须共用同一个 event/effect/checkpoint 管线。**
5. **任何 checkpoint 都必须经过完整候选请求重建与收益验证后才能生效。**

按此方案收敛后，Kite Code 保留当前 V2 的工程优势，同时在用户体验上接近 Claude Code：平时自动管理上下文，必要时允许用户带 focus 手动压缩，压缩前后状态可观察，失败可恢复，且不牺牲工具协议和 Runtime 正确性。

执行优先级：先完成信任边界、ledger、增量 checkpoint、真实候选估算和 durable hard block，再考虑默认开启自动压缩。
