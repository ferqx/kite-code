# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
读取时机：修改 `consolidateTools.ts`、`handleEvent.ts`（tool_call/tool_done）、`ToolSummaryBlock.tsx`、`useStaticContent.ts`（tool_summary）、`types.ts`（ConsolidatedToolEntry/tool_summary）、`agentReducer.ts`（cancelRunningBlocks）、`compaction.ts`（折叠引擎）时必读。
验证：`bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/runtime/agent.integration.test.ts`
最后更新：2026-07-03

## 约束

1. **Thought 边界**：Thought 表示一段未被可见 assistant 文本、非探索工具或人机交互等待打断的模型思考链。`reason/thinking` 不打断 Thought，只更新当前 Thought 的活动预览；可见 `text/final`、非探索工具、`need_approval`、`need_input`、`need_plan_review` 都会关闭当前 Thought。

2. **探索工具不经 tool_card**：`read_file`、`search_content`、`search_files`、`read_mcp_resource` 在 `tool_call` 时直接进入 `tool_summary`，永远不创建独立 `tool_card`。`shell_execute` 即使被命令分类器判定为只读，也不进入 Thought；上游应优先使用 `search_files/search_content` 表达探索搜索。

3. **非探索工具截断**：所有 `shell_execute`、写入工具、审批、`ask_user`、`update_plan`、`task` 等非探索工具与可见文本一样关闭当前 Thought，并继续按原有独立块渲染。`list_mcp_resources` 也使用独立 tool card，以 `Provider · URI` 树展示资源目录；真正读取内容的 `read_mcp_resource` 仍属于探索工具。后续探索工具会开启新的 Thought。

4. **跨 thinking 合并**：同一 Thought 内，探索工具之间可以夹着 `reason/thinking`。这些 thinking 不创建新的工具聚合，只更新 `tool_summary.latestActivity`。

5. **运行态思考预览**：`tool_summary.active=true` 时，`latestActivity` 优先保存最新 thinking。探索工具调用只在当前 Thought 没有 thinking 预览时作为活动占位；已经展示在工具列表中的工具不应覆盖 thinking 预览。新的 thinking 覆盖旧 thinking；Thought 关闭后清空 `latestActivity`，历史中不保留 thinking 预览。

6. **人机交互停止计时**：进入审批、提问或方案评审等待时，当前 Thought 必须置为 `active=false` 并冻结 `totalElapsedMs`。用户阅读、审批或输入答案的耗时不计入 Thought 时间。

7. **审批焦点优先**：当 Shell 等工具等待用户审批时，OutputArea 只显示到待审批工具卡为止；同一并发批次中后续到达的探索工具或结果块暂时不显示，避免把审批目标挤出视窗。隐藏只发生在渲染层，审批结束后这些块按当前状态重新显示。

8. **保守调度策略**：TUI 只负责按边界截断 Thought，不重排、拆批、取消或强制 settle executor 已发出的 pending 工具。若同一批事件中出现探索工具和 Bash，Bash 关闭 Thought；pending 探索工具继续保留 `running` 状态并等待后续 `tool_done` 更新。

9. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

10. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

11. **事件驱动计时**：`totalElapsedMs` 由 reducer 在每次相关事件中更新（`Date.now() - createdAt`），不再依赖前端 `setInterval` 主动轮询。更新点：(a) `tool_done` 探索工具完成时；(b) `closeCurrentThought` 关闭 Thought 时；(c) `updateCurrentThoughtActivity` 收到 reason / tool_call 时。`ToolSummaryBlock` 直接读取 `block.totalElapsedMs`，无 live timer。

12. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

13. **工具完成即 ●**：`ToolSummaryBlock` 在 running 状态下，若 `tools.length > 0 && tools.every(t => t.status !== 'running')`，将 spinner 替换为 ●（绿色），footer 从「运行中 (Xs)」切换为「完成」。此判断仅取决于工具状态，不与 `latestActivity.kind` 耦合 —— 后续 reason 事件到来时 ● 不回退为 spinner，避免「完成→运行中→完成」的视觉抖动。thinking 预览与 ● 解耦，可独立展示。

14. **Static 边界**：`tool_summary` 仅在 `active=false` 且 `tools.every(t => t.status !== 'running')` 时进入 Static。

15. **settledStatus 从实际状态推导**：settled 状态下 `ToolSummaryBlock` 的结算状态直接从工具状态推导（`hasError ? 'error' : hasPendingTools ? 'cancelled' : 'done'`），不使用 `block.result`。`block.result` 由 `closeCurrentThought` 在工具仍 running 时设为 `'cancelled'`，之后 `tool_done` 到达时只更新单条工具状态而不重新计算 `result`，因此可能过时。

16. **层边界**：`consolidateTools.ts` 中的合并逻辑属于 app 层，不允许导入 core 层模块。

17. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。`write_file` 例外：其卡片动词由 `writeFileActionName(summary, args)` 从结果动态推导——覆写已有文件（diff 统计摘要）显示 Write，新建显示 Create，运行/排队态无 summary 时用中性 Write；append 已由 ADR-0025 §2 移除，历史会话残留的 "Appended …" summary 归入中性 Write。

18. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

19. **文件工具渲染**：`renderFileSummary` 自动区分 diff 格式（删除行红底 `diffRemovedBg`、新增行绿底 `diffAddedBg`、上下文行无背景）和纯内容格式。write_file 新建/追加时所有内容行视为新增全绿底，内容未变覆写保持 dim。文件内容行自动语法高亮：行号前缀（`LINE_RE`）走普通 `<Text>`，代码正文走 `<SyntaxHighlight code=... language=.../>`，语言由 `detectLanguage(path)` 从扩展名推断。`...` 分隔符不做高亮。

## 设计文档

- `docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md` — Thought 预整合设计详情
- `docs/space/plans/2026-06-28-context-compaction.md` — M0/M1/M2 三层压缩方案

## 修改时必读

修改以下文件时，必须先阅读上述设计文档：
- `src/app/tui/components/ToolCardBlock.tsx` — 文件工具卡片渲染（diff 染色、语法高亮）
- `src/app/tui/reducers/consolidateTools.ts` — 工具判断 + 合并逻辑
- `src/app/tui/reducers/handleEvent.ts` — tool_call/tool_done 事件处理
- `src/app/tui/components/ToolSummaryBlock.tsx` — Thought 块渲染
- `src/app/tui/components/BlockRenderer.tsx` — tool_summary case
- `src/app/tui/components/render-utils.ts` — actionName/getToolPreview/getToolDetail
- `src/app/tui/types.ts` — ConsolidatedToolEntry / tool_summary 类型
- `src/app/tui/render/useStaticContent.tsx` — isSettled / blockFingerprint for tool_summary
- `src/app/tui/App.tsx` — explorationSummaryIds 初始状态
- `src/app/tui/reducers/agentReducer.ts` — cancelRunningBlocks 处理 tool_summary
- `tests/tui-reducer.test.ts` — 预整合测试
- `tests/context.test.ts` — 折叠测试
