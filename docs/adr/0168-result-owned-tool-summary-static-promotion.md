# ADR-0168：由聚合封口与结果共同控制 Tool Summary 的 Static 提升

**Status**: accepted
**Date**: 2026-09-03
**Decision makers**: @chenchao
**Partially supersedes**: ADR-0167 关于当前 live tail 中 `tool_summary` 不立即进入 Static 的结论

## Context

探索工具在 TUI 中按同一 Thought 聚合为 `tool_summary`。Reducer 已经通过共享结果投影发布整体
`result = done | error | cancelled`：只有阶段关闭、至少一个工具已经物化且全部进入终态时才产生该字段；阶段仍在运行、
尚无工具的纯Thinking，或仅软关闭但仍有工具未终态时，`result`保持未定义。

`active`和`result`表达不同事实：`active=true`表示同一只读探索阶段仍可跨模型调用继续接收工具；`result`表示已经物化的
工具集合在封口后的整体结果。尚未started的exploration sibling只存在于`pendingToolCalls`，不会出现在`tools[]`，所以当前
entries全部terminal也不能替代封口事实。现有Static分流曾完全忽略result，随后又被错误收窄成只看result。前者使完成聚合
长期停留在dynamic tail；后者会让携带旧result但重新active的块，或尚在awaiting-terminal的块，过早成为不可更新Static快照。

## Decision

1. `active`是聚合成员资格的唯一封口事实；`result`是封口后工具整体结果的唯一权威。两者不能互相替代。
2. `tool_summary`仅在`active=false`、`responsePending!==true`且`result`为`done`、`error`或`cancelled`时完成。
3. 完成的`tool_summary`若位于active turn的连续settled前缀，立即进入Ink `<Static>`；run是否已切换为idle不改变判断。
4. 空工具集合不产生`done`。工具响应到达前被暂时软关闭的纯Thinking仍可恢复为active，且active聚合不得携带result。
5. Static 仍只接收连续前缀。前方存在未完成 block 时，已完成 summary 不得越过它改变消息顺序。
6. ADR-0167 对 text、standalone tool、subagent 和交互 block 的物理 owner 规则保持不变。

## Alternatives

- 只使用`active=false`判断：拒绝；软关闭时工具或model terminal可能仍未结束，聚合结果尚未确定。
- 只使用`result`判断：拒绝；result不拥有聚合封口，active块仍可能继续加入后续探索工具。
- 遍历`tools[].status`判断：拒绝；重复 reducer 的整体结果投影，形成两个完成权威。
- 等待后继 user turn：拒绝；这会忽略已经发布的聚合终态，并使完成的工具卡片长期停留在 dynamic tree。

## Consequences

- `Thinking 3s · read 6 files, searched 3 file patterns`这类聚合在封口并产生整体结果前持续动态更新，之后进入Static。
- 错误和取消与成功使用同一完成协议，不依赖 run terminal 的到达顺序。
- 测试必须同时覆盖软关闭无`result`不提升、三种 terminal result 都提升，以及 answer 继续留在 dynamic suffix 的顺序。

## Rollback

恢复 ADR-0167 对 `tool_summary` 的 live-tail 物理 owner 规则，并删除基于整体`result`的 Static 分流；回滚前必须同步修改
Thought 当前规则，避免文档继续声明一套不存在的完成协议。
