# ADR-0026: 纯思考块并入文本题头（拒绝跨文本吸收）

**Status**: accepted  
**Date**: 2026-07-25  
**Decision makers**: @chenchao  

## Context

模型一次响应可能同时包含 `reason`（思考）、可见 `text` 与 `tool_calls`。由于非流式 `generateText` 的响应事件在同一突发内按 reason → text → tool_calls 顺序到达，现行规则（`docs/active/thought-pre-consolidation.md` 规则 1/19/20）将其切分为三个独立块：

```
  Thought for 2s        ← 纯思考裸线：无圆点、无步骤树、settle 后不保留思考预览

  Let me read the core files systematically.

● read 6 files          ← 无 Thought 前缀的非思考聚合
```

纯思考裸线没有任何可视内容（思考预览按规则 5 不保留），只剩一个时长数字，且与其实际产物（紧随的旁白/回答）被空行隔开。真实会话（`tui-ms0cuzee-0`，2026-07-25，7 次模型调用 / 32 次工具调用）确认该形态在多轮探索中反复出现：每次 reason+text+tools 响应产生一条裸线，最终回答前的 `Thought for 24s` 同样孤悬于答案之上。

## Decision

1. **文本关闭即并入题头**：`text`/`final` 事件关闭纯思考块（`tools.length === 0`）时，删除该独立块，其冻结后的 `totalElapsedMs` 转移为首个文本块的 `thoughtElapsedMs`；渲染为文本块顶部的暗色题头行 `Thought for Xs`（两空格缩进对齐规则 19 列位、无圆点、与正文零间隔）。
2. **非文本边界保持裸线**：纯思考块由非探索工具、审批等待或取消关闭时，沿用规则 19 持久化为单行裸 `Thought for Xs`——这些块与后续内容之间隔着 tool_card / approval 块，不构成"思考→产物"的连续单元。
3. **拒绝跨文本吸收**：reason → text → tools 同一响应中，工具聚合块**不得**继承先行纯思考块的 `hasThinking` / `modelMs`。文本已打断思考链：该段思考时长归属于它产出的旁白，不能计入文本之后的工具。该场景的工具聚合保持非思考标签（`read N files`，规则 20）。
4. **纯空白文本不触发并入**：空白文本不创建文本块（无并入对象），纯思考块按规则 19 保留裸线，后续探索工具形成非思考聚合。
5. **跨调用累积不变**：`model.requested` 不关闭纯思考块（规则 21）、多轮 reason 的 `modelMs` 按调用累加（规则 19）的行为保持不变；累积时长在块最终关闭时按本 ADR 规则 1/2 统一处理。

## Alternatives

- **工具块跨文本吸收纯思考块**（预览形态：`文本` + `● Thought for 2s · read 6 files`）：视觉上合并为一处，但把产出旁白的思考时长错配给文本之后的工具——标题时长与块内任何工具都不对应；且需要 reducer 在建块时回溯扫描并越过文本块删块，复杂度与误吸收风险（相邻性守卫）不成比例。被决策者明确否决。
- **文本不关闭 Thought**（惰性关闭，工具续接原块）：规则 1 大改，牵动非探索工具截断、审批冻结等全部边界；旁白文本还会落到工具树之后，时序颠倒。否决。
- **纯渲染层贴近**（不删块，仅消除块间空行）：纯思考块先于文本块进入 Static，Static/Dynamic 提交边界使"零间隔"在流式渲染中不可靠（分隔符在纯思考块提交时即写死）。否决，改用 reducer 层并入（文本块诞生即带题头字段，单一 Static 项，无中间态）。
- **保持现状**：裸线无内容、不可交互，碎片化在真实会话中每轮复现。否决。

## Consequences

- 数据模型：`text` 块新增可选字段 `thoughtElapsedMs`；并入发生在文本块创建之前（同一事件突发内），块诞生即带字段，无状态过渡；`useStaticContent` 指纹包含该字段。
- 渲染层：`Thought for 24s` 题头与答案成为同一视觉单元；带工具的 `Thought for Xs · <统计>` 标题（ADR-0025 后引入的统计后缀）仅限"思考直接接工具"的响应，逻辑不变。
- 规则 20 的非思考聚合标签 `read N files` 现有两个来源：无推理响应、reason+text 隔断后的工具聚合。
- 信息无损失：并入只删除独立块，时长全量转移；新旧日志均经同一 reducer 回放，结果确定。
- 同步更新 `docs/active/thought-pre-consolidation.md` 规则 1/19/20/22 措辞（同一改动，CLAUDE.md 规则 2）。

## Rollback

移除 `text`/`final` 路径的并入逻辑（`closeCurrentThought` 回到仅 settle），删除文本块 `thoughtElapsedMs` 字段与题头行渲染，行为回到规则 19 裸线形态。字段可选，旧数据天然兼容。
