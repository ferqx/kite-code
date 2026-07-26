# ADR-0037：流式 Markdown 按稳定组件层级更新

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

模型的 `text_delta` 携带累计全文。若 reducer 把全文拆成逐行 text block，或 Markdown 渲染每次使用数组下标重新建立整棵节点树，段落、列表、代码块和表格会随着后续行到达而改变归属，Ink 因此反复卸载、重建和重排已有内容，终端中表现为抖动。

## Decision

1. 一次模型连接产生的一段累计 Markdown 始终保存在一个 streaming text block 中；换行不再拆成消息级 block。
2. 断线重连仍遵守 ADR-0033：旧 Markdown 文档冻结，恢复后的输出新建另一个 Markdown 文档。
3. `MarkdownBlock` 在文档内部按块级结构分组，包括单行块、围栏代码块和表格；列表、标题、引用和段落由单行块继续解析。
4. 每个块级组件使用其 Markdown 源起始行作为稳定身份。代码块或表格增长时保留身份；普通行提升为同起始位置的表格时也复用该位置。
5. 块级组件按内容签名 memoize。累计全文变化时，已经完成且内容未变的前缀组件不重新渲染，只更新发生变化的尾部组件。

## Consequences

- 长回答的既有段落、列表、代码块和表格不会因尾部新增 token 被整体重建。
- Markdown 结构拥有完整上下文，表格和围栏代码无需 reducer 的跨消息行合并。
- 单个尚未闭合的尾部结构仍可能随着新 token 重新解析，这是正确且局部的变化。

## Verification

Reducer 测试断言包含段落、列表、表格和代码块的累计 Markdown 始终只有一个 live text block。布局测试通过 rerender 覆盖尾部组件增长及管道文本提升为表格；流式与 Thought PTY 场景继续验证整体消息顺序。
