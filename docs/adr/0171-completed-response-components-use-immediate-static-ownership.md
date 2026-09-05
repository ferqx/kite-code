# ADR-0171：最终回复的已完成组件立即取得 Static owner

**Status**: accepted
**Date**: 2026-09-04
**Decision makers**: @chenchao
**Partially supersedes**: ADR-0167 第 2/7/8 条中“已完成最终文本仍等待后继 Turn 或重挂载才进入 Static”的结论
**Restores**: ADR-0045 第 9 条与 ADR-0046 第 4/5 条的文本组件物理提交边界

## Context

ADR-0045/0046 将模型正文按 Markdown 组件提交，是长回复的性能与稳定性边界：普通段落、列表项和已经闭合的结构组件一旦完整就
不再变化，应立即进入 Ink `<Static>`；只有仍在增长的表格、围栏代码等结构容器留在 dynamic tree。ADR-0167 为解决其他
live-tail block 的重复 scrollback，把“保持 dynamic owner”扩大到了已经完成的最终文本，实际覆盖了这条边界。

结果是工具探索后的长回复虽然仍可被拆成多个 text block，却全部滞留在 dynamic tree。Footer、焦点或状态刷新会反复 diff 整篇
回答；动态帧达到终端高度时 Ink 可能清除并重画主屏，既造成性能退化，也会重置用户完成后向上滚动的原生视口。

## Decision

1. 没有待判定Thought归属时，普通段落、引用、完整列表项以及已经闭合的结构组件一旦由 Markdown splitter 提交，就是不可变
   text block；位于active turn连续settled前缀时立即进入`<Static>`，不等待Task/Turn/Run terminal、后继user turn或重挂载。
2. 活动表格和围栏代码是例外：识别外壳后可按完整内部行渐进渲染，但组件仍带 `streamingComponent/streamingSource` 并留在
   dynamic tree；关闭围栏、下一个顶层边界或模型终态冻结整个容器后，才进入 `<Static>`。
3. 当前已有探索Thought时，完整正文组件仍按Markdown边界拆成text blocks，但使用`responsePending=true`作为隐藏ownership
   buffer：OutputArea不得渲染它们，Static分界也不得提升它们，因此不会产生可见dynamic重绘成本。
4. `model.responded.toolCallCount`是该隐藏buffer的归属边界：`toolCallCount>0`删除这些从未绘制的text、恢复同一个Thought owner，
   并把累计正文保留为不渲染的`pendingCaption/captions`；`toolCallCount=0`补齐尾段、清除pending，并把已经拆好的全部组件直接
   释放到`<Static>`。不得先把Thought提交Static后再建立第二个相邻聚合卡。
5. `awaiting_terminal`继续保留当前model request的终态耗时、隐藏尾段与迟到事件归属。它只在存在探索归属歧义时阻止text
   提前Static；无此歧义的普通完成组件仍遵守第1条，不把整篇回答留在可见dynamic tree。
6. 首个完整回答组件可见后，普通 animated run status 停止；retry 状态仍可见。PTY evidence 必须证明首个组件早于末组件进入真实
   VT/scrollback、活动结构容器仍为唯一可变回答块、最终回答只出现一次，并且连续两个完成Turn后向上滚动都不会被空闲重绘重置。
7. DEC FocusOut/FocusIn由共享focus store消费，但不得成为全局Escape/普通按键，也不得切换InputLine的合成光标帧。拖动原生
   滚动条产生焦点报告时，完成态主界面必须保持零stdout，不能让终端重新跟随底部live cursor。

## Consequences

- 长回复的渲染成本随新完成组件增长，而不是每次刷新重新处理整篇动态回答。
- Thought 聚合仍以已证明的工具响应归属为准；隐藏ownership buffer从未绘制，因此工具终态删除它不构成Static回滚，也不会拆出
  第二张Thinking卡。
- InputLine仍复用现有focus store与单一Ink输入通道；本决定只删除焦点报告触发的业务action和可见帧变化，不新增输入owner。
- `tool_summary` 继续按 ADR-0168 的 `active + responsePending + result`条件提升；standalone tool、interaction 和其他 live-tail block
  继续遵守 ADR-0167。
- 模型终态前尚未闭合的普通尾段保持隐藏；用户不会看到逐 token 扩张的半成品段落。

## Alternatives

- 所有正文都等`model.responded`后再Static：拒绝；只有活动Thought下存在真实工具归属歧义时才等待。
- ownership-pending组件先可见dynamic、终态再迁入Static：拒绝；会保留整篇动态重绘成本并在工具终态留下临时旁白。
- 未分类文本先写 Static、工具终态再擦除：拒绝；原生 scrollback 没有可靠、可移植的局部回滚协议。

## Rollback

恢复 ADR-0167 的最终文本 live-tail owner；回滚必须明确接受长回复组件不再即时 Static、完成后滚动可能受整屏动态重绘影响，或先
提供具有真实跨终端 PTY 证据的等价物理 owner。
