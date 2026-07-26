# ADR-0040：流式 Markdown 按安全边界渐进冻结

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

ADR-0037 将一次模型连接的累计 Markdown 保存在一个 streaming text block
中，避免逐行拆分破坏 Markdown 组件层级。ADR-0038/0039 进一步把段落和结构
块细分为稳定子组件。

但单一 dynamic block 会随长回答持续增高。当其高度超过终端视口时，Ink
为了重绘溢出帧会清除并重写整个终端；用户此时使用原生 scrollback 阅读历史，
滚动位置会被重置。降低 delta 频率只能减少触发次数，不能消除整屏清除。

## Decision

1. 一次连接仍维护一份累计 Markdown 原文，但展示投影允许形成多个连续 text
   block：已完整形成的前缀进入 settled block，最后一个仍可能变形的组件保留为
   streaming block。
2. 只在 fenced code 之外、已经出现后继内容的空行边界冻结前缀。边界本身保留
   在前缀中，使所有 block 内容直接拼接后严格等于模型累计原文。
3. 未闭合的代码围栏、当前尾段、当前表格、连续列表和引用不得从中间冻结。
   Markdown 组件内部继续遵守 ADR-0038/0039 的稳定身份与子行 memo 规则。
4. 每次冻结后，`useStaticContent` 按现有 settled/dynamic 分界把前缀写入
   `<Static>`；dynamic tree 只保留尚未完成的尾段，因此其高度不随整篇回答
   单调增长。
5. 终态、重连和回放对账以 text block 原文直接拼接为准。旧版逐行 block 没有
   保留分隔符，兼容路径仍使用换行拼接。

本决定取代 ADR-0037/0038 中“每次连接始终只有一个 streaming text block”的
条款；它们关于组件层级、源位置身份和 memoization 的其余决定继续有效。

## Consequences

- 长流式回答不会因为一个 dynamic block 超过视口而持续触发 Ink 整屏清除，
  用户滚动历史时的位置更稳定。
- 已冻结内容只渲染一次，流式更新的布局成本与当前尾部组件大小相关。
- 单个超长且始终没有安全边界的组件仍可能超过视口；为了保持 Markdown 结构
  正确性，不在组件内部强制截断。
- 一次回答在 TUI state 中可能包含多个相邻 text block，但其内容直接拼接后
  必须与权威模型响应完全一致。

## Verification

- reducer 测试验证完整段落冻结、尾部组件保持 streaming、所有分段直接拼接
  后等于累计原文。
- reducer 测试验证 fenced code 内部空行不触发冻结。
- legacy final、`model.responded` 和 `run.completed` 测试验证终态不重复尾部。
- TUI layout 与 PTY streaming 场景验证 Markdown 最终结构和消息顺序。
