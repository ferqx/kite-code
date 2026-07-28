# ADR-0045：流式渲染采用完整块提交

状态：accepted
日期：2026-07-28
取代：ADR-0035 的实时 Thought 展示、ADR-0037 至 ADR-0040 的可见尾部增量展示
关联：`docs/active/thought-pre-consolidation.md`

## 背景

累计 `reasoning_delta` 和 `text_delta` 直接更新可见块时，Thought 会在生成期间持续改写；普通段落逐 token 扩张，表格、列表、引用与围栏代码则会在 Markdown 语法尚未闭合时改变组件类型或整体重排。这些更新虽然保留了组件身份，但用户仍会看到不完整内容和结构抖动。

## 决策

1. `model.reasoning_delta` 立即建立运行态 Thought，但正文只进入缓存；`model.reasoning_completed` 到达后才一次性提交该完整 reasoning 段。终态 `model.responded` 结束运行态预览，最终对话只保留 `Thought for Xs` 摘要，不保留 `reasoningText` 正文。
2. `model.text_delta` 只提交已经闭合的顶层 Markdown 前缀。普通段落与结构块以块为单位进入渲染树；未闭合尾部保持隐藏。
3. 空行是围栏代码之外的顶层提交边界；只有边界之后已经出现新内容时才提交此前前缀。围栏代码内部的空行不构成边界。
4. 终态 `model.responded.text` 提交剩余尾部，并继续作为权威全文处理重试分歧与去重。
5. 已提交块不可变；旧的 `MarkdownBlock` 增量缓存与稳定子行能力保留给兼容路径，但不再承担 Runtime delta 的可见尾部更新。
6. 若终态 reasoning 到达前同一 request 已提交文本前缀，Thought 的逻辑锚点仍是该 request 的第一个文本块之前；终态处理必须临时移出这些前缀、建立 Thought，再按原顺序放回，不能把 Thought 插入回答前缀和尾段之间。
7. Thought 生命周期显式区分 `running` 与 `awaiting_terminal`。文本前缀出现时视觉状态立即从 running 结算，但阶段进入 awaiting_terminal，继续拥有当前 request 的终态耗时；此状态下 reasoning delta 不得创建新块，后续 text delta 也不得清除归属。`model.responded.durationMs` 归入原块后才关闭归属。若已提交文本之后出现工具事件，则该工具事件证明文本是阶段边界，此时关闭旧归属并在文本之后建立新工具阶段。
8. 每段连续 reasoning 流作为一个带稳定 `segmentId` 的原子临时组件：`model.reasoning_delta` 期间仅缓存，`model.reasoning_completed` 后一次性展示完整内容。一次请求或执行允许重复出现 reasoning 段；工具活动与后续 completed reasoning 按时序互相替换活动窗口，但共享同一个探索 Thought。Provider 不提供显式边界时由模型适配层在 reasoning→text/tool/流结束时合成 completed。
9. 第一条回答 delta 使 Thought 进入无圆点的 `awaiting_terminal`；第一段完整回答组件可见时立即隐藏 reasoning/工具活动明细，并把 Thought 与该组件按当时已知状态提交到 Static。内部归属保留到终态以屏蔽迟到事件，但不得因此把所有已完成回答组件留在 Dynamic 树。
10. 有序、无序和任务列表使用 item 级提交边界：下一个同级 marker 证明前一个 item 完整；缩进子项和续行不独立提交。当前最后一个 item 仍等待下一 marker 或模型终态。

## 备选方案

- 继续逐 token 展示：拒绝，无法消除不完整段落和结构重排。
- 终态后展示完整 reasoning：拒绝，模型内部推理正文不属于用户可见回答。
- 等完整回答后一次性展示全部文本：拒绝，会丢失长回答按完整段落渐进可见的体验。

## 后果

- 首段在出现下一个顶层边界前不可见；最终段在模型终态到达时可见。
- 表格、代码、列表和引用不再以半成品形态展示。
- StatusBar 不再依赖 Runtime delta 创建 streaming text block；已提交正常文本出现后按现有可见性规则隐藏。
- delta 与 completed reasoning 边界都是瞬态事件，不持久化或参与 RuntimeState 归约；durable 终态契约不变。

## 回滚

恢复 `model.reasoning_delta` 的 Thought 更新，并恢复单一 streaming tail block 的累计更新路径；持久化事件和会话 schema 无需迁移。
