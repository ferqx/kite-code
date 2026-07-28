# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
读取时机：修改 `consolidateTools.ts`、`handleEvent.ts`（tool_call/tool_done/text/model_requested）、`ToolSummaryBlock.tsx`、`useStaticContent.ts`（tool_summary）、`types.ts`（ConsolidatedToolEntry/tool_summary）、`agentReducer.ts`（cancelRunningBlocks/settleActiveThought）、`compaction.ts`（折叠引擎）时必读。
验证：`bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/runtime/agent.integration.test.ts tests/model-invoke.test.ts tests/session-manager.test.ts tests/runtime/kernel.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle`
最后更新：2026-07-28

## 约束

1. **Thought 边界（阶段模型，ADR-0030）**：Thought 块 = 一段**只读探索阶段**：从首个 `reason` / 探索工具建块起，跨越任意多次模型调用保持活跃（圆点持续闪烁、时长累加、工具并入），直到阶段边界关闭。`reason/thinking` 不打断 Thought，只更新活动预览并累加调用时长；**可见文本也不关闭 Thought**——阶段块活跃时吸收为块顶字幕（确认制，见规则 24）。**阶段边界（关闭 Thought）**：`final` / 流式文本的脱离路径、非探索工具、`need_approval` / `need_input` / `need_plan_review`、生命周期边界（重试 / 错误 / 取消 / 中断 / 轮次结束）。`model.requested` **不是边界**——kernel 收齐工具结果后重新调用模型是实现细节（ADR-0030 取代 ADR-0025 的 settle 条款，见规则 21）。纯空白文本整体忽略。纯思考块（整轮无工具）被文本关闭时并入该文本块题头（ADR-0026，见规则 19）；被非探索工具 / 人机等待关闭时保留裸线。

2. **探索工具不经 tool_card**：`read_file`、`search_content`、`search_files`、`read_mcp_resource` 在 `tool_call` 时直接进入 `tool_summary`，永远不创建独立 `tool_card`。`shell_execute` 仅在 `intent=inspect` 且满足以下一种情况时纳入 Thought 聚合：(a) 命令以搜索前缀（`rg`/`grep`/`ag`/`ack`/`git grep`/`find`）开头；(b) 命令是单一 `ls` 调用（含参数和目标路径）。`ls` 一旦包含管道、重定向、命令串联、换行或命令替换，就按通用 Bash 处理并渲染为独立 tool_card。其他 `shell_execute` 同样不纳入。

3. **非探索工具 = 阶段边界**：所有未满足规则 2 的 `shell_execute`、写入工具、审批、`ask_user`、`update_plan`、`task` 等非探索工具关闭当前阶段块（关闭原因 `tool` / `human_wait`），按原有独立块渲染，其后开启新阶段。一个 reasoning 段的 `Thought for Xs` 标签由关闭前的块消费，边界后的探索聚合不得复制该标签；它以纯工具统计标题开始，直到新的真实 `reason` 事件到达（ADR-0047）。`list_mcp_resources` 也使用独立 tool card，以 `Provider · URI` 树展示资源目录；真正读取内容的 `read_mcp_resource` 仍属于探索工具。

4. **跨 thinking 合并**：同一 Thought 内，探索工具之间可以夹着 `reason/thinking`。这些 thinking 不创建新的工具聚合，只更新 `tool_summary.latestActivity`。

5. **运行态活动与块顶字幕**：Thought 运行期间展示已完整提交的 reasoning 段落；最新活动为工具时改为展示工具步骤。Thought settle 后 reasoning 正文、工具步骤和 footer 都折叠，只保留摘要。**旁白文本**（可见 assistant 文本）在阶段块活跃时吸收为字幕：待确认 `pendingCaption` 实时渲染于块顶（标题行下、步骤树上），被随后只读工具确认后转入 `captions` 永久保留（多段按时间顺序累积）；阶段结束仍未确认则脱离为独立文本块（规则 24、ADR-0030）。

6. **人机交互停止计时**：进入审批、提问或方案评审等待时，承载该交互前置过程的当前 Thought 必须置为 `active=false` 并冻结 `totalElapsedMs`。例外：Runtime 同批预排队且位于审批目标工具之后、工具仍全部为 `queued` 的探索聚合属于未来执行阶段，不是正在等待审批的 Thought；它在渲染层保持隐藏、reducer 中保持活跃，以便执行到达后接收后续真实 reasoning。用户阅读、审批或输入答案的耗时不计入任何 Thought 模型时长。

7. **执行前沿与审批焦点优先**：Runtime 会先为同一模型响应中的全部工具发出排队事件，再按调度顺序执行。当前面存在运行中的独立工具卡时，OutputArea 不渲染其后仍完全处于 `queued` 的工具卡或 Thought 聚合块；后续块中任一工具收到 `tool.started` 后才进入渲染树。Shell 等工具等待用户审批时仍只显示到待审批工具卡为止，避免把审批目标挤出视窗。隐藏不改变调度顺序；审批目标之后的全 queued 探索聚合也不得被审批事件提前 settle（规则 6），否则后续 reasoning 无法并入。

8. **保守调度策略**：TUI 只负责按边界截断 Thought，不重排、拆批、取消或强制 settle executor 已发出的 pending 工具。若同一批事件中出现探索工具和 Bash，Bash 关闭 Thought；pending 探索工具继续保留 `running` 状态并等待后续 `tool_done` 更新。

9. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

10. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

11. **事件驱动计时**：`totalElapsedMs` 由 reducer 在每次相关事件中更新，不再依赖前端 `setInterval` 主动轮询。有 `modelMs` 时以其为准（规则 22，elapsed = 阶段内 Σ 模型调用时长，不随工具执行增长）；无 `modelMs`（旧事件日志）时回退 `Date.now() - createdAt`。更新点：(a) `tool_done` 探索工具完成时；(b) `closeCurrentThought` 关闭 Thought 时；(c) `updateCurrentThoughtActivity` 收到 reason / tool_call 时（`modelMs += durationMs`，跨调用累加）；(d) 无 reasoning 的 `model.responded` 经 `addThoughtDuration` 补计该次调用时长。`ToolSummaryBlock` 直接读取 `block.totalElapsedMs`，无 live timer。

12. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

13. **聚合块圆点 = 阶段存活**（ADR-0030 修订）：`active=true`（阶段进行中）→ 暗色闪烁圆点；标题中的 `Thought for Xs` 已表达进行状态与耗时，运行态不再重复渲染 footer「运行中 (Xs)」。即使所有工具已完成，模型调用间隙仍属于阶段内部，圆点持续动画。`active=false`（阶段结束）→ Thought 与非 Thought 工具聚合摘要都移除圆点并保留两个空格列位，折叠为单行摘要，不渲染 footer 或活动明细。独立工具卡仍使用自身的运行及结果状态语义。

14. **Static 边界**：`tool_summary` 仅在 `active=false` 且 `tools.every(t => t.status !== 'running')` 时进入 Static。

15. **settledStatus 从实际状态推导**：settled 状态下 `ToolSummaryBlock` 的结算状态仍从工具状态推导（`hasError ? 'error' : hasPendingTools ? 'cancelled' : 'done'`），不使用 `block.result`，供状态数据与兼容逻辑使用；聚合摘要完成态不再用它渲染圆点或 footer。工具仍 running 时 `closeCurrentThought` 留空 `block.result`（undefined）；所有工具 settled 后由 `tool_done` 路径重新计算为 `'error'` 或 `'done'`。

16. **层边界**：`consolidateTools.ts` 中的合并逻辑属于 app 层，不允许导入 core 层模块。

17. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。`write_file` 例外：其卡片动词由 `writeFileActionName(summary, args)` 从结果动态推导——覆写已有文件（diff 统计摘要）显示 Write，新建显示 Create，运行/排队态无 summary 时用中性 Write；append 已由 ADR-0025 §2 移除，历史会话残留的 "Appended …" summary 归入中性 Write。

18. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

19. **纯思考块持久化与题头并入**：`tools.length === 0` 的 Thought 块（纯问答轮的 `reason → text`，或 `reason → 非探索工具` 产生）。**非流式模型下文本不直接关闭它**——文本先吸收为 `pendingCaption`（规则 24）；`final` 关闭时 pendingCaption 即回答本身 → **并入该文本块题头**（ADR-0026：独立块删除，冻结 elapsed 写为文本块 `thoughtElapsedMs`，只显示暗色 `Thought for Xs`，随后显示回答正文；reasoning 正文不渲染）。流式模型路径由终态 `model.responded` 和 `mergePureThoughtHeader` 完成同样的并入。纯空白文本整体忽略、不触发并入。被非探索工具或人机交互边界关闭时**保留**独立 Thought：无圆点，不显示 reasoning 正文、工具步骤与 footer。

20. **非思考链聚合（纯统计标签的唯一来源）**：阶段内尚未出现 reasoning 时，探索聚合使用纯工具统计标签（如 `read 2 files`，`hasThought=false`），不带 `Thought for` 前缀、无 thinking 条目。阶段内任一次真实 `reason` 到达后，该活动聚合原位升级为 `Thought for Xs · <统计>`（规则 23/24、ADR-0047/0030）。注意：无 reasoning 的调用其 `durationMs` 仍计入阶段 Σ 时长（规则 11），只不影响标签前缀。

21. **model.requested 不关闭 Thought**（ADR-0030 取代 ADR-0025 的 settle 条款）：模型调用为非流式 `generateText`，调用期间不产生任何事件。`model.requested` 在 `await` 模型之前即时发出（ADR-0025 的即时发出机制保留），但 TUI **不再据此关闭 Thought**——模型调用是 kernel 分批喂工具结果的实现细节，不是用户感知的阶段边界：阶段块跨调用保持 `active=true`（圆点持续闪烁、时长累加、后续思考/工具/旁白继续流入，规则 24）。调用间隙块显示"工具全完成 + 圆点闪烁 + 运行中 (Σs)"——这正是"阶段仍在进行"的正确信号（旧版 settle 是为防止"运行中"残留，阶段模型下该残留即语义本身）。回放兼容：旧日志经同一 reducer 回放，同样聚合为阶段块。

22. **标签与计时语义**：思考阶段块（`hasThinking=true`，由本阶段真实 `reason` 设置）标题行为 `Thought for Xs · <工具统计>`——有工具时以 ` · ` 分隔附加 `buildToolSummaryLine` 统计（如 `Thought for 2s · read 3 files`），统计随工具事件实时刷新；无工具的纯思考块保持裸 `Thought for Xs`。统计后缀由渲染层按终端宽度截断（`truncateToFit`），放不下时整体省略后缀、不留孤悬分隔符；工具明细仍在步骤树展示。非思考聚合块（规则 20）标题保持纯工具统计（如 `read 2 files`，对应 CC 的 `⏺ Read N files` 聚合行）。`Thought for Xs` 的时长 = **阶段内 Σ 各次模型调用时长**（`model.responded.durationMs`，含思考+响应生成，不含工具执行；无 reasoning 的调用同样计入，规则 11）：每次 `reason` 事件 / 无思考调用累加 `modelMs`，工具执行期间 elapsed 不增长，settle 时以 `modelMs` 冻结。回退：无 `durationMs` 的旧事件日志（ADR-0025 之前）用创建→settle 墙钟。纯思考块被文本关闭时不产生独立标题行，其时长以文本块题头形式展示（ADR-0026，见规则 19）。最终回答脱离为独立文本块时**不重复出题头**——回答前的思考时长已计入阶段块（ADR-0030）。

23. **思考标签单次消费（ADR-0047，覆盖 ADR-0027）**：Thought 块被非探索工具、人机交互等待或文本边界关闭后，其 reasoning 内容与 `Thought for Xs` 标签均已完成展示，不向后续块延续。边界后的探索工具仍按执行顺序聚合并展示步骤，初始使用纯工具统计标题（如 `read 2 files`）；若该聚合仍活跃时收到新的真实 `reason`，reasoning 内容、`hasThought` 和本次模型时长必须并入该块，标题原位升级为 `Thought for Xs · read 2 files`，不得另建独立 Thought。物理约束不变：非探索工具继续使用独立富渲染块，Thought 树不跨越它们。

24. **探索阶段块与旁白字幕（ADR-0030）**：一段只读探索阶段 = 单个 `tool_summary` 块，跨模型调用存活：`model.requested` 不关闭（规则 21），`reason` 累加时长并更新预览（规则 4/11），探索 `tool_call` 并入同块（统计标签实时刷新）。圆点整个阶段持续闪烁，运行态不显示 footer（规则 13）；阶段边界（规则 1/3）关闭后 Thought 移除圆点、折叠工具步骤、保留已确认旁白字幕（`captions`），仅移除 reasoning 预览和运行态指示器。**旁白文本吸收**：阶段块活跃时，可见文本（非流式一次完整到达）不建独立块，写入 `pendingCaption`，渲染于标题行下、步骤树之上（Markdown 原样，缩进与标题文字列对齐）；随后到来只读工具将其确认为 `captions`（永久留在块内，多段按 `\n\n` 时序累积）；阶段结束时仍未确认的 `pendingCaption` 脱离为块后独立文本块（最终回答 / 写入前旁白）；纯思考块的 pendingCaption 被文本路径关闭时并入题头（规则 19）。流式增量文本（事件携带累积全文）以 `startsWith` 识别替换，避免重复。**纯空白文本整体忽略**（不关闭、不建块）。折叠阈值（`MAX_VISIBLE_STEPS=5`）作用于阶段块的合并步骤总数。

25. **模型流式增量与重复思考段（ADR-0045）**：Runtime 为每段连续 reasoning 分配稳定 `segmentId`，依次发出累计语义的 `model.reasoning_delta` 和一次 `model.reasoning_completed`；一次模型请求或 Agent 执行可包含任意多个 `reasoning → tool → reasoning` 段。Provider 缺少显式 start/end 时，模型适配层在 reasoning→text/tool/流结束边界合成 completed。Thought 阶段使用显式 `running | awaiting_terminal` 生命周期：delta 期间只缓存、不渲染；completed 把该段完整 reasoning 一次性放入活动窗口，后续工具活动可替换它，下一段 completed 又可替换工具活动，整个探索过程仍聚合为同一个 Thought。第一条 `model.text_delta` 使 Thought 停止圆点并转为 `awaiting_terminal`；第一段完整回答组件真正进入渲染树时，reasoning 与工具活动明细立即隐藏，Thought 以当时已知耗时冻结并进入 Static，同时仅在 reducer 状态中保留 `awaiting_terminal` 归属以阻止迟到事件创建第二个 Thought。之后每个完整回答组件也立即进入 Static/终端 scrollback，不等待 `model.responded`，因此流式期间向上滚动始终能看到全部已提交内容。`model.responded` 只结束内部归属并补齐未提交尾部，不回写已经输出到 Static 的视觉块。事件派发固定 delta 先于对应 completed；这些瞬态事件不进入 Runtime store、events.jsonl 或回放。

26. **流式断线重连（ADR-0032 / ADR-0033）**：`model.retry` 冻结断线前已经提交的完整 Markdown 块；尚未闭合的文本尾部和 reasoning delta 从未进入渲染树，因此断线时仍保持隐藏。重连后的累计文本按新的提交边界继续处理；终态 `model.responded` 以权威全文补齐或在分歧时替换当前请求的文本块，并清除 retry 状态。partial tool call 不创建卡片或 summary，只有完整成功流的终态工具调用进入 Runtime。

27. **流式 Markdown 组件层级（ADR-0037 / ADR-0038 / ADR-0046）**：空行是普通段落和引用的顶层提交边界；列表采用 item 级边界，下一个同级有序、无序或任务列表 marker 出现时提交前一个完整 item，缩进子列表与续行仍归属父 item。相邻 text block 按“前一块最后一个可见组件”和“当前块第一个可见组件”判断连续列表；两端同缩进且同为有序或无序 item 时使用零块间距，即使前一块还包含列表前的普通段落。列表与前后普通段落、结构组件或工具消息仍保留标准块间距。围栏代码在完整起始围栏到达后立即建立带完整上下边框的 Dynamic 组件，表格在完整表头与分隔行到达后立即建立 Dynamic 组件；两者随后只追加已经换行完成的内部行，当前未完成行保持隐藏。关闭围栏、下一个顶层边界或模型终态会冻结当前组件并使其进入 `<Static>`；此前完整组件始终保持 Static，不使用 `responsePending` 滞留整篇回答，也不显示独立的生成进度文字。断线后的新段仍是独立 Markdown 文档。

28. **结构块子行渲染（ADR-0039 / ADR-0046）**：已识别的表格与围栏代码由 `MarkdownBlock` 使用稳定父级和子行增量渲染，只把完整内部行交给可见组件；表格保持单一父级 `Text` 以维持连续边框。尚未识别的结构、当前未完成行以及普通段落尾部保持隐藏。

29. **文件工具渲染**：`renderFileSummary` 自动区分 diff 格式（删除行红底 `diffRemovedBg`、新增行绿底 `diffAddedBg`、上下文行无背景）和纯内容格式。write_file 新建/追加时所有内容行视为新增全绿底，内容未变覆写保持 dim。文件内容行自动语法高亮：行号前缀（`LINE_RE`）走普通 `<Text>`，代码正文走 `<SyntaxHighlight code=... language=.../>`，语言由 `detectLanguage(path)` 从扩展名推断。`...` 分隔符不做高亮。


## 设计文档

- `docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md` — Thought 预整合设计详情
- `docs/adr/0025-model-requested-live-emission.md` — model.requested 即时发出（settle 条款已被 ADR-0030 取代，规则 21）
- `docs/adr/0026-thought-text-header-merge.md` — 纯思考块并入文本题头（文本关闭 Thought 条款已被 ADR-0030 取代，规则 19）
- `docs/adr/0027-thought-carryover-non-text-boundary.md` — 历史方案：跨边界继承 Thought 标签（已被 ADR-0047 覆盖）
- `docs/adr/0047-thought-label-single-consumption.md` — Thought 标签单次消费，边界后不重复继承（规则 3/23）
- `docs/adr/0030-exploration-phase-block.md` — 只读探索阶段 = 单一存活块、文本吸收为块顶字幕（规则 1/13/21/22/24）
- `docs/adr/0041-inspect-ls-thought-aggregation.md` — 单一只读 `ls` 纳入 Thought，复合 shell 语法保持独立工具卡（规则 2/3）
- `docs/adr/0045-streaming-render-complete-block-commit.md` — Thought 终态展示与完整 Markdown 块提交（规则 25/27/28）
- `docs/adr/0046-atomic-streaming-component-progress.md` — 结构组件闭合外壳后的内部完整行渐进渲染（规则 27）
- `docs/space/plans/2026-06-28-context-compaction.md` — M0/M1/M2 三层压缩方案

## 修改时必读

修改以下文件时，必须先阅读上述设计文档：
- `src/app/tui/components/ToolCardBlock.tsx` — 文件工具卡片渲染（diff 染色、语法高亮）
- `src/app/tui/reducers/consolidateTools.ts` — 工具判断 + 合并逻辑
- `src/app/tui/reducers/handleEvent.ts` — tool_call/tool_done 事件处理
- `src/app/tui/components/ToolSummaryBlock.tsx` — Thought 块渲染
- `src/app/tui/components/BlockRenderer.tsx` — tool_summary case
- `src/app/tui/components/render-utils.ts` — actionName/getToolPreview/getToolDetail
- `src/app/tui/types.ts` — ConsolidatedToolEntry / tool_summary / text 块 `thoughtElapsedMs` 类型
- `src/app/tui/render/useStaticContent.tsx` — isSettled / blockFingerprint for tool_summary
- `src/app/tui/App.tsx` — explorationSummaryIds 初始状态
- `src/app/tui/reducers/agentReducer.ts` — cancelRunningBlocks 处理 tool_summary
- `tests/tui-reducer.test.ts` — 预整合测试
- `tests/context.test.ts` — 折叠测试
