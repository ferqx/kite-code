# ADR-0167：分离 Block 完成语义与终端 Static 所有权

**Status**: accepted
**Date**: 2026-09-03
**Decision makers**: @chenchao
**Partially supersedes**: ADR-0035 的纯 reasoning 即时展示、ADR-0036 的所有流式文本均切分 Thought、ADR-0040、ADR-0045 第 1/9 条中的纯 reasoning 展示与即时 Static 提升

## Context

TUI 曾把“block 已完成”直接等同于“立即从 Ink dynamic tree 迁入 `<Static>`”。这在组件测试中只会看到一次最终内容，但真实终端中的 `<Static>` 是 append-only：dynamic tree 已经绘制过的 Thought、文本或工具卡被移入 `<Static>` 时，旧动态帧可能留在原生 scrollback，新静态帧又写出一次。典型结果是同一模型请求只产生一次 reasoning 和一次 terminal，界面仍依次留下 `Thinking 1s` 与 `Thinking 3s`。

事件去重或 reducer identity 无法解决这种重复，因为两行来自同一个 presentation block 的两种物理 owner，而不是两份 Runtime event。为即时提升增加擦除、游标回退或 synchronized-output 事务，还会把终端差异和恢复状态引入正常消息生命周期。

## Decision

1. Block 的完成状态仍由 reducer 按各自生命周期独立决定；Turn 不是工具、文本、Thought 或交互完成的事实来源。
2. 完成状态不自动改变当前终端帧中的物理 owner。已经由 dynamic tree 绘制过的 live-tail block，在同一 live sequence 内继续由 dynamic tree 渲染，即使它已经语义完成。
3. 尚无工具或其他稳定消息 owner 的纯 reasoning 只保存在 request-scoped reducer state，不在 message tree 中物化临时 `tool_summary`。最终回答一次性消费其 Thinking 题头；若随后出现探索工具或人机交互等真实边界，边界处理才物化对应 Thought 摘要。运行反馈由既有 Footer Thinking/Working 状态承担。
4. `model.text_delta` 本身不构成 Thought 边界。`model.responded(toolCallCount>0)` 将累计文本判定为探索旁白，保留在当前 Thought 的 `pendingCaption`；只有匹配 `presentationGroupId` 的探索工具开始后才转入可见 `captions`。`toolCallCount=0` 才确认最终回答并结算 Thought。
5. 未确认的 `pendingCaption` 不进入视觉树，避免最终回答脱离时在 scrollback 留下临时副本。带工具旁白确认后按模型顺序显示，连续模型调用、reasoning 与探索工具继续共享一个 Thought。
6. 只有未经过可变展示、且已有 PTY 证据证明可安全交接的 user prompt 前缀可以在当前 live turn 提前进入 `<Static>`。
7. 后继 user turn 使旧 turn 成为不可变 history，或 Session/resize/presentation remount 先清屏时，旧 live tail 才整体进入 `<Static>`。这些只是物理提交边界，不参与 reducer 完成判定。
8. Run terminal、取消终态和 presentation-only 本地命令都不得单独触发 live tail 的 Static 迁移。
9. 真实 PTY 必须覆盖纯 reasoning 延迟正文和多次“旁白 + 探索工具”的序列，分别断言 scrollback 中只有一条 Thinking 标题、连续探索只有一个 Thought。仅使用 Ink 最终 frame 的组件测试不足以证明无重复。

## Alternatives

- 按 block terminal 立即提升：拒绝；真实 PTY 已证明 dynamic→Static 会重复写入 scrollback。
- 为每次提升执行清屏并重绘全部内容：拒绝；会破坏原生 scrollback 连续性，并放大 resize、输入和本地命令的闪烁风险。
- 引入两阶段终端擦除/提交协议：延期；当前没有跨终端可靠性证据，复杂度明显高于保留一个稳定物理 owner。

## Consequences

- 用户仍会按完整 Markdown 组件看到渐进回答，已完成 block 也会立即停止动画、冻结结果并隐藏活动详情；没有工具的纯 reasoning 在正文稳定前只显示 Footer Thinking/Working 状态。
- 带工具的中间旁白在对应模型响应结束并由工具开始确认后显示；这段有界延迟换取确定归属、单一 Thinking 和无重复 scrollback。
- 当前最新 turn 的已完成内容在下一条用户消息前仍位于 dynamic tree；下一 turn 或清屏重挂载后进入 `<Static>`。
- 输入期间的引用稳定缓存继续避免无内容变化的重复 diff；超长单轮回答的性能由现有稳定引用和有界动态组件测试约束。
- ADR-0045 的完整块提交语义保留；纯 reasoning 不再为了建立临时视觉节点而进入 `awaiting_terminal`，并撤销“可见即立即迁入 Static”的物理要求。

## Rollback

恢复逐 block 的 `isBlockSettledInRun` 判定及即时 `<Static>` 提升；回滚前必须先提供真实终端上不会留下 dynamic scrollback 副本的跨平台机制与 PTY 证据。
