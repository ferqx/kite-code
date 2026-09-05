# ADR-0172：终态展示 Block 立即取得 Static Owner

**Status**: accepted
**Date**: 2026-09-04
**Decision makers**: @chenchao
**Partially supersedes**: ADR-0167 第 2/6/7/8 条中 standalone tool、Subagent、resolved interaction 与 presentation-only block 在当前 live turn 继续保持 dynamic owner 的结论
**Complements**: ADR-0168 的 Tool Summary 完成协议与 ADR-0171 的最终文本组件 Static 协议

## Context

ADR-0167 为避免 dynamic→Static 交接在真实终端留下重复帧，将已绘制 live-tail block 统一保留到后继 Turn 或清屏重挂载。
ADR-0168 与 ADR-0171 已分别证明完成的 Tool Summary 和最终文本组件可以在 reducer 发布不可变事实后安全取得 Static owner。

当前 `isBlockSettledInRun` 若只承认 user、text 与 tool_summary，已经终态的 standalone tool、Subagent、resolved interaction
和不可见 presentation-only block 会成为连续 Static 前缀的永久阻塞点。其后的长最终回答虽然已经按 Markdown 组件拆分，仍全部
留在 dynamic tree；这重新引入整篇 diff、完成后滚动不稳定，以及下一 Turn 才整体交接的重复风险。并发 Subagent 还会违反
“全组终态后以一张 `Delegated` 摘要进入历史”的当前展示规范。

现有 zero-height Static owner、稳定 block identity 与连续前缀分流已经允许按 exact terminal fact 原子交接。真实 PTY 进一步证明：
standalone write tool 与两 child 并发 Subagent 分别结束后，终态卡片和长最终回答在 scrollback 中只出现一次；回答完成后向上滚动，
DEC FocusOut/FocusIn 前后保持原偏移且没有新 stdout。

## Decision

1. `isBlockSettledInRun`继续只提升active turn中的连续不可变前缀，不允许越过任一未完成block重排消息。
2. standalone `tool_card`在`done|error|rejected|cancelled|timeout|exhausted`终态立即完成并可进入`<Static>`；
   `queued|running`继续留在dynamic tree。
3. 单个Subagent在`done|error|cancelled`终态完成。携带`concurrencyGroupId`的siblings必须等同组全部终态后一起完成，
   使OutputArea只向Static提交一个聚合`Delegated`展示项。
4. `approval`与`question`仅在`resolved`后完成；隐藏的legacy `reason`和不单独渲染的`file_change`是不可变
   presentation-only block，不得阻塞后续可见组件。
5. `tool_summary`不使用上述通用终态推导，继续严格服从ADR-0168的
   `active=false + responsePending!==true + result!==undefined`单一完成权威。text继续服从ADR-0171的组件边界与
   ownership-pending规则；活动表格和围栏代码仍是dynamic例外。
6. Subagent启动时TUI记录本地`startedAt`驱动活动计时；closed terminal event保留Runtime实测
   `toolCallCount/durationMs`。失败诊断只允许`code/stage`，不得携带model invocation correlation。
7. PTY必须分别覆盖standalone tool和并发Subagent后的长最终回答，断言终态卡片、聚合摘要与正文组件各出现一次，
   并在完成后滚动与焦点报告期间保持零stdout。

## Consequences

- 任何已终态的展示组件都不会继续钉住后续最终正文；长回答的dynamic成本只来自真正仍在增长的结构容器。
- 并发Subagent仍以Runtime签发的group identity为唯一聚合依据，Static判定不根据相邻关系、名称或时间窗口猜测。
- 终态工具卡不再保留当前live-turn的交互式展开状态；其最终可见内容必须在terminal projection中一次性确定。
- 新增的Client Event字段只是已有Runtime终态事实的closed低敏感度投影，不增加调度、授权、持久状态或第二完成权威。

## Alternatives

- 保持ADR-0167的live-tail owner：拒绝；终态block会阻塞后续最终文本组件，恢复长dynamic tree与滚动问题。
- 只在Run terminal后整体提升：拒绝；Run不是各block完成权威，且会把整篇回答保留到最后一帧。
- 让TUI从子步骤、名称或时间推断终态/并发：拒绝；会与Runtime terminal和`concurrencyGroupId`形成重复权威。

## Rollback

恢复ADR-0167的terminal live-tail owner，并删除standalone/Subagent长回答的即时Static PTY；回滚必须明确接受后续正文被终态
block钉在dynamic tree，或先提供另一种不会扩大dynamic尾且保留原生scrollback的物理owner。
