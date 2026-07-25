# ADR-0025: model.requested 即时发出（请求时而非响应后补发）

**Status**: accepted  
**Date**: 2026-07-25  
**Decision makers**: @chenchao  

## Context

`model.requested` 原本在 `model-controller` 中于 `await invokeBoundModel(...)` **完成后**与 `model.responded` 一起打包进返回的事件数组（补发）。由于模型调用是非流式的 `generateText`（单次完整响应），一次调用期间不产生任何 RuntimeEvent。

后果：上一轮工具全部完成后、到下一轮 `model.responded` 到达之间（即最终回复的生成期间，可达数十秒），TUI 没有任何时机信号可以 settle 上一轮的 Thought 聚合块——块在所有工具已完成的情况下持续显示"运行中"（闪烁圆点 + 运行中 footer），与真实状态矛盾。

`model-controller` 已有即时发送通道 `emitRuntimeEvent`（`capability.bindings_issued`、`skill.catalog_refreshed` 等均通过它即时发出并经 kernel 持久化）。

## Decision

1. `model.requested` 在 `await invokeBoundModel(...)` **之前**通过 `emitRuntimeEvent` 即时发出，从响应后的事件数组中移除。compaction 提前返回分支不发起模型调用，不发此事件。
2. TUI 在 `model.requested` 时关闭**带工具**的活跃 Thought 块（kernel 只在上一轮工具结果全部收齐后才会再次调用模型，此时块内工具必然全部 settled，走 `closeCurrentThought` 路径）。纯思考块（无工具）不受影响——思考链仍只由 `text` 等边界打断（`docs/active/thought-pre-consolidation.md` 规则 1/19/21）。

## Alternatives

- **TUI 显示层 settle**（工具全部 settled 时渲染为 settled 形态，数据层 `active` 保持）：聚合语义零改动，但引入"看起来 settled、链仍可续"的中间渲染态，且最终 settle 时耗时标签跳变。
- **reducer 在最后一个工具 `tool_done` 时 settle**：无需 core 改动，但 settle 时机与"新一轮调用开始"这一事实脱钩，且 `model.requested` 仍名不副实（事后补发）。
- 两者可见行为与本方案相近，但都不修正持久化事件时间线的失真。

## Consequences

- 持久化事件时间线变得真实：`model.requested` 的 revision/时间戳记录在请求发起时，与 `model.responded` 相隔实际调用耗时；`model.retry` 事件自然落在 requested 之后。
- 顺序不变量保持：`turn.started` → `model.requested` → `model.responded`（现有集成测试断言不变）。
- 行为变化（记录于 thought-pre-consolidation.md 规则 21）：多轮探索被新一轮模型调用切分为多个 Thought 块；思考模型在工具轮之后回答时，末轮思考呈现为独立的纯思考块。
- 回放兼容：新旧日志均经 `handleRuntimeEventAction` 重放，最终状态一致（旧日志中 requested 紧邻 responded，settle 与关闭背靠背发生）。
- `model.requested` 对 RuntimeState 仍为信息性事件（core reducer 不消费），语义变化仅在发出时机与 TUI 呈现层。

## Rollback

将 `model.requested` 的发出移回响应后的事件数组，并移除 TUI `model_requested` 分支（或令其 no-op）。事件顺序回到旧时间线，不影响状态一致性。
