# ADR-0036: 流式文本始终渲染在 Thought 之后

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

ADR-0031 将 text delta 写入活跃 Thought 的 `pendingCaption`。该槽位位于 Thought 标题与步骤树内部，因此用户可见回答会在 Thought 过程中间出现；长文本还会把 Thinking 和工具步骤分隔开，破坏消息列表顺序。

## Decision

1. `model.text_delta` 不再写入 Thought 的 `pendingCaption`。
2. 首个 text delta 先冻结当前 Thought，再创建同级 text block；后续累计 delta 只更新该 text block。
3. text delta 之后到达的探索或非探索工具都排在文本之后，不得把已经显示的文本回收进 Thought。
4. 非流式终态文本与既有阶段旁白规则保持不变；本决定只改变实时 `model.text_delta`。
5. 终态 reasoning/text 只补齐时长与权威内容，不得重新创建 Thought 或复制全文。

该决定取代 ADR-0031 中“流式文本写入活跃阶段 pendingCaption”的展示条款。

## Consequences

- 消息顺序稳定为 Thought → text → tool，不再出现 text 插入 Thought 树中间。
- 流式旁白不再成为 Thought 内 caption，而是独立可见消息。
- Thought 与回答之间的边界更清晰，代价是探索阶段可能拆成前后两个 Thought 块。

## Verification

Reducer 测试覆盖累计文本位于 Thought 之后、探索工具排在文本之后、reasoning/text 两种到达顺序和终态去重；PTY 覆盖正常 streaming 与完整 Thought 生命周期。
