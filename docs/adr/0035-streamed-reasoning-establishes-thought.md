# ADR-0035: 首个 reasoning delta 建立实时 Thought

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

ADR-0031 规定没有活跃阶段块时丢弃 `model.reasoning_delta`，等待终态 `model.responded.reasoningText` 创建 Thought。流式默认开启后，这会让 text delta 先创建回答块，终态 reasoning 随后才补建 Thought，消息列表出现“回答在前、Thought 在后”的错误顺序。

## Decision

1. 没有活跃 Thought 时，首个 `model.reasoning_delta` 立即创建实时纯 Thought。
2. 后续累计 reasoning delta 继续替换该 Thought 的 thinking preview。
3. text delta 按既有 pendingCaption 规则进入该 Thought；终态 `model.responded` 补齐真实 duration，`run.completed` 再按 ADR-0026 将 Thought 时长合并到回答题头。
4. 已有活跃 Thought 时的增量替换语义不变。
5. 若兼容 Provider 跨帧先发送 text、后发送 reasoning，仍在变化的尾部文本迁入新建 Thought 的 pendingCaption，再按 Thought → 回答顺序结算；终态 reasoning 只更新最后一条 thinking timeline 和耗时，不追加重复项。

该决定取代 ADR-0031 中“无活跃块时丢弃 reasoning delta”的展示条款。

## Consequences

- 流式消息顺序稳定为 Thought → 回答，不再在回答后补出 Thought。
- reasoning delta 仍不持久化，回放继续使用终态 `model.responded`。
- 纯文本模型不产生 reasoning delta，行为不变。

## Verification

Reducer 测试覆盖 reasoning → text、text → reasoning 两种跨帧顺序以及 reasoning-only 终态去重；两种文本路径最终都保持 Thought → 回答。
