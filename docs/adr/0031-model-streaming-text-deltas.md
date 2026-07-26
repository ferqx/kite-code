# ADR-0031: 模型响应流式化（streamText + text delta 事件）

**Status**: accepted
**Date**: 2026-07-26  
**Decision makers**: @chenchao  

## Context

Core 模型调用使用 `generateText`（`src/core/model/invoke.ts`，`stopWhen: stepCountIs(1)` 单步非流式）。整个响应（reasoning + text + toolCalls）在 `model.responded` 一次性到达——ADR-0025/0030 的事件模型即建立于此。

后果（用户反馈："最终回复前，Thought 聚合无法正确结束 Loading"）：

1. **最终回答合成期间屏幕空白**：最后一次模型调用可能耗时数十秒（长总结），期间阶段块保持 `运行中 (Σs)` 闪烁、时长冻结，用户看不到任何产出，直到整段回答写完才与 settle 同帧出现。
2. **"回答开始"与"回答完成"不可区分**：非流式下两者是同一个事件，阶段块的 loading 结束点只能与完整回复出现的瞬间重合——无法在回答开始时 settle。
3. TUI reducer 的流式文本机制（`state.running` 按行拆分、`prevFullText` 去重、`finalizeLastTurnStreaming`）是为此保留的死代码，从未被激活。

唯一能在回答开始前结束 loading 的信号是**第一个文本字符**——这需要流式调用。

## Decision

### 1. Core：invoke.ts 切换 streamText（单步语义不变）

`generateText` → `streamText`（AI SDK 同一 provider 接口，`stopWhen: stepCountIs(1)` 保留）。消费流并实时发出 Runtime 事件，流结束时发出既有 `model.responded`（完整消息 + `durationMs` + toolCalls）——**kernel 工具分发链路不变**（工具仍在响应完成后执行）。

### 2. 新增两个 Runtime 事件（TUI 专用，不入会话日志）

- `model.reasoning_delta { text: string }`：reasoning 增量（累计全文语义，见下）。
- `model.text_delta { text: string }`：text 增量（**累计全文**——与 reducer 既有流式文本路径的 `prevFullText` 去重/按行拆分逻辑直接对接）。

recorder 不记录 delta 事件（events.jsonl 只记录 `model.responded` 终态，日志体积与回放数据不变；回放走 responded 全量路径，与实时渲染终态一致）。

### 3. TUI：流式文本实时渲染于阶段块顶部（pendingCaption 流式化）

关键设计决策——流式文本在响应**完成前**无法预知是"阶段内旁白（后有工具）"还是"最终回答（无工具）"。两个候选：

- **A（采纳）：delta 实时写入活跃阶段块的 `pendingCaption`**（累计全文替换，ADR-0030 的 `startsWith` 识别逻辑直接复用），渲染于块顶字幕槽。响应完成（`model.responded`）后按 ADR-0030 确认制分流：
  - 响应含探索工具 → 确认进 `captions`（旁白留在块顶）；
  - 响应含非探索工具 → 阶段关闭，字幕脱离为块后独立文本块；
  - 响应纯文本（最终回答）→ 阶段关闭，字幕脱离为独立回答文本块——**回答在合成过程中已逐字可见**，settle 时从字幕槽移入独立块（一次布局迁移，无跳变累积）。
- **B（否决）：首个 text delta 即关闭阶段、回答流式渲染为独立块；若响应结束发现含工具调用再回收文本块为字幕**。最终回答体验略好（settle 在回答开始），但 deepseek 类模型几乎每次旁白都是"文本+工具"响应——回收动画会在每段旁白上演，布局反复跳变。否决。

方案 A 的 loading 语义：阶段块在回答流式期间仍闪烁（"阶段进行中——正在产出回答"，语义为真），回答逐字可见；settle 发生在响应完成帧。用户的核心痛点（合成期间屏幕空白、loading 与回答同帧突然出现）消除。

纯思考块（整轮无工具）的流式文本同理：delta 写入 pendingCaption，final 关闭时并入文本题头（ADR-0026 路径不变）。

`model.reasoning_delta`：更新活跃阶段块的 thinking 预览（替换 `latestActivity.text`，不追加——累计语义）。无活跃块时丢弃（reason 块由 `model.responded` 的完整 reasoningText 统一创建，避免增量拼接分歧）。

### 4. 能力与回退

- `ResolvedModelCapabilities` 新增 `streaming: boolean`（遵循 ADR-0023：显式配置 / adapter metadata 解析，模型名不推断）。
- `streaming === false` 的 provider 走现有 `generateText` 路径（双实现共存于 invoke.ts，调用点不变）。
- abort：invoke 已有的 AbortSignal 透传 streamText（Esc 中断时流取消，TUI 经现有 cancel 路径 settle）。

### 5. TUI 流式渲染管线（帧级合帧，非逐 delta 渲染）

SSE delta 频率可达每秒数十次；逐 delta 派发会让每个 delta 触发 reducer 状态重建 → React 协调 → Yoga 布局 → Ink ANSI diff 全链路，长回答下动态区逐帧重写量线性增长（闪烁 + CPU）。因此 TUI 侧按帧合帧：

- **派发边界合帧层**（`session-manager.ts` live dispatch 路径新增）：`text_delta` / `reasoning_delta` 不立即 dispatch，缓冲区只保留最新累计全文；定时 flush（50–66ms，对齐终端刷新）派发单个合并事件，渲染频率有界。
- **事件序保证**：任何非 delta 事件（`model.responded` / `tool.queued` / 错误…）到达时先同步 flush 再派发该事件——字幕确认/脱离与 settle 同帧，无中间态。卸载 / 会话切换 / 中断时 flush 并清理。
- **reducer**：`text_delta` 有活跃阶段块时累计全文替换 `pendingCaption`（复用 ADR-0030 的 `startsWith` 去重），无活跃块时走既有流式文本建块路径（`state.running` 按行拆分、`prevFullText` 去重、表格/代码块结构合并、`finalizeLastTurnStreaming` 均为流式预留，直接接入）；`reasoning_delta` 替换活跃块 thinking 预览（`latestActivity.text`）；`model.responded` 全文与 pendingCaption 相同，去重天然 no-op。
- **渲染层零新增**：块顶字幕槽（ADR-0030 已实现）以 MarkdownBlock 渲染 `pendingCaption`，流式即逐字可见；流式文本块 `streaming: true` 留 Dynamic、settle 后一次性进 Static（既有边界机制）；MarkdownBlock 为轻量正则解析 + `useMemo`，每次 flush 重解析成本微秒级；fingerprint + `BlockRenderer.memo` 保证每次 flush 仅流式块重渲染，Ink 自身行级增量 diff，无全屏重绘。
- **中断**：Esc 先 flush 再 `cancelRunningBlocks` 脱离字幕并 finalize 流式标志。

### 6. 不变量

- `model.responded` 仍是工具分发与轮次推进的唯一依据（delta 不触发任何 kernel 状态机）。
- `model.requested` 即时发出保留（ADR-0025）。
- 会话日志 / 回放数据格式不变（delta 不入 events.jsonl）。
- `reviewer.ts` 等内部调用保持 generateText（无 TUI 消费者）。

## Alternatives

- **维持非流式 + 启发式**（model.requested 后超时推测"最终调用"）：每轮请求的信号完全相同，无法区分最终调用与又一轮工具调用；超时阈值纯猜测。否决。
- **reasoning 也按增量分事件、TUI 逐段拼接 reason 块**：reason case 的 `\n\n` 追加语义与增量冲突，需要新 delta 语义 + 拼接状态；thinking 预览只需最新全文，方案 3 的"替换最新预览 + responded 统一建 reason 块"已满足。增量建块收益极低。不采纳。
- **delta 事件持久化进 events.jsonl**：日志体积膨胀数十倍，回放无需（responded 含全文）。否决。

## Consequences

- 代码：`src/core/model/invoke.ts`（streamText 消费 + delta 事件发射，generateText 回退分支）；`src/protocol/events.ts`（两个 RuntimeEvent 变体）；`src/core/runtime/events.ts`；TUI `handleRuntimeEventAction`（delta 映射：text_delta → pendingCaption 流式写入 / 无活跃块时走既有流式文本建块路径；reasoning_delta → thinking 预览替换）；`ResolvedModelCapabilities` + 解析链路（streaming 字段）。
- 行为变化（实现时记录于 thought-pre-consolidation.md 规则 25）：最终回答在合成期间逐字可见（块顶字幕槽），响应完成帧 settle 并脱离为独立块；支持流式的 provider 上 reasoning 预览实时更新。
- 测试：reducer delta 用例（累计去重、确认分流三路径、无活跃块回退）；e2e mock server 已按 SSE 发送（harness 现成），新增流式场景；golden/回放不受影响（数据格式不变）。
- 风险：provider SSE 边缘行为（截断流、空 delta、usage 在最后一帧）——streamText finish 统一结算 durationMs/usage/cache_metrics，异常走现有 model.retry / error 路径。

## Rollback

`streaming` 能力默认解析为 false（或 feature flag 关闭）即回退 generateText 路径；delta 事件无发射源时 TUI 行为与现行完全一致。双实现共存，无迁移成本。
