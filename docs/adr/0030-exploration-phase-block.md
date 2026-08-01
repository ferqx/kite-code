# ADR-0030: 只读探索阶段 = 单一存活块（模型调用不切分、文本吸收为块顶字幕）

**Status**: accepted（取代 ADR-0025 的 model.requested settle 条款、ADR-0026 的"文本关闭 Thought"条款；两者其余机制保留）  
**Date**: 2026-07-26  
**Decision makers**: @chenchao  

## Context

ADR-0025 让 `model.requested` 关闭带工具的活跃 Thought（非流式调用期间防止"工具全完成却持续运行中"），ADR-0026 让可见文本关闭 Thought 并并入题头。真实会话反复暴露这两个边界与用户感知的冲突：

1. **连续探索被切成碎片**：三轮 `reason + reads` 响应（`tui-ms0kaon5-0`）渲染为三个相邻的 `Thought for 3s · read 5 files` / `3s · read 3 files` / `2s · read 2 files` 块——但 `model.requested` 是 kernel 分批喂工具结果的实现细节，用户感知的是一段连续探索。
2. **旁白文本制造孤立题头**：模型常把"叙述"与"干活"分成两次调用（`reason+text` 调用 + `reason+tools` 调用，如 `tui-ms0kaon5-0` 的多个 2s 叙述调用），ADR-0026 把叙述渲染为独立的 `Thought for 2s` 题头块，夹在工具块之间。
3. 此前的修补方向（渲染层视觉分组、文本边界标签继承、文本逐对并入块顶）都在保留"按调用切块"的前提下裱糊，无法消除碎片，且互相叠加出多套特例。

用户给出的统一心智模型："思考 → 只读工具调用 → 思考 也要合并；左侧的小圆点要一直处于动画中。"

## Decision

1. **阶段块（phase block）**：一段只读探索阶段 = 一个 `tool_summary` 块。从首个 `reason` / 探索 `tool_call` 建块开始，块保持 `active=true`（圆点持续闪烁），跨任意多次模型调用累积：
   - `reason` 事件：`modelMs += durationMs`（时长 = Σ 各次模型调用时长，规则 19 的累加语义推广到工具块），更新思考预览；无 reasoning 的调用通过 `model.responded.durationMs` 同样计入；
   - 探索 `tool_call`：并入同一块，统计标签实时刷新（`Thought for Xs · read N files, searched M patterns`）。
2. **`model.requested` 不再关闭 Thought**（取代 ADR-0025 的 settle 条款；`model.requested` 即时发出本身保留）。非流式调用期间块显示"工具全完成 + 圆点闪烁 + 运行中"——这正是用户要的"阶段仍在进行"信号；`active=true` 的块天然留在 Dynamic 区，无 Static 召回问题。
3. **文本吸收为块顶字幕**（取代 ADR-0026 的"文本关闭 Thought"条款）。阶段块活跃时，可见文本不关闭 Thought、不建独立文本块，而是吸收为 `pendingCaption`（渲染于标题行之下、步骤树之上，Markdown 原样渲染）：
   - **确认制**：随后到来只读工具 → `pendingCaption` 转为正式 `captions`（多段旁白按时间顺序累积，永久留在块内）；
   - **脱离**：阶段结束时仍未确认的 `pendingCaption`（最终回答 / 写入前旁白）由关闭路径脱离为块后的独立文本块；
   - **纯思考块的题头并入保留**（ADR-0026）：无工具的纯思考块被文本关闭时（最终回答路径），`pendingCaption` 即回答本身——删除思考块、冻结时长写为文本块 `thoughtElapsedMs` 题头。纯问答轮（整轮无工具）渲染形态不变。
   - 流式增量文本（旧提供商逐段重发全文）以 `startsWith` 识别为替换，避免重复累积。
4. **阶段终结者**（关闭并 settle 阶段块）：可见文本的脱离路径（`final` / 流式文本）、非探索工具（写入 / 通用 Bash / `task` …，原因 `tool`）、人机等待（审批 / 提问 / 方案评审，`human_wait`）、生命周期边界（重试 / 错误 / 取消 / 中断 / 轮次结束）。非探索工具 / 人机等待关闭 `hasThinking` 块时延续思考归属（ADR-0027 carryover 不变），边界后新建的探索聚合继承思考标签。
5. **纯空白文本整体忽略**：不关闭 Thought、不建块（阶段模型里累积由阶段边界约束，不再需要空白文本兜底关闭）。
6. `SET_IDLE` / `cancelRunningBlocks` / `settleActiveThought` 的 settle 路径同步脱离未确认字幕，并按工具状态重算 `result`（规则 15）。

## Alternatives

- **渲染层视觉分组**（reducer 保持按调用切块，渲染层合并相邻块 + 尾部链留存）：视觉相近，但"圆点持续动画"无法在已 settle 的静态块上实现（Ink `<Static>` 只追加、不可回写）；文本吸收仍需 reducer 参与，两套机制叠加。否决（实现更复杂且达不到"圆点一直闪烁"）。
- **维持按调用切分 + 逐对文本并入**：碎片只是从 N 块变 N/2 块，"思考→工具→思考"仍被切断（用户明确否决："这个过程，为何被拆分？"）。否决。
- **最终回答也吸收进工具块**：回答是交付物，不是旁白——确认制天然把它留在块外（无只读工具跟随 → 脱离）。不采纳。

## Consequences

- 数据模型：`tool_summary` 新增 `captions?: string[]`（已确认块顶字幕）与 `pendingCaption?: string`（待确认）；渲染由 `ToolSummaryBlock` 在标题行下以 `MarkdownBlock` 输出。
- 行为变化（记录于 thought-pre-consolidation.md 规则 1/3/5/13/19/20/21/22/23 修订 + 新规则 24）：整段只读探索渲染为单块（`Thought for Σs · <合并统计>`，圆点全程闪烁）；旁白为块顶字幕；最终回答独立、不出题头（思考时长已计入阶段块）；纯问答轮题头不变（ADR-0026）。
- 时长语义：阶段块 `Thought for Xs` = Σ 阶段内各次模型调用时长（含无 reasoning 的调用），工具执行时间不计（规则 22 推广）。
- 回放一致性：新旧日志经同一 reducer 回放，旧日志同样聚合为阶段块。
- 与 ADR-0025/0026/0027 的关系：取代 0025 的 settle 条款与 0026 的文本关闭条款；0026 的纯思考题头并入、0027 的阶段边界延续均保留。

## Rollback

恢复 `model_requested` 的关闭分支与 text case 的 `closeCurrentThought('text')` 前置，删除 caption 字段与吸收/脱离逻辑。字段可选，旧数据兼容。
