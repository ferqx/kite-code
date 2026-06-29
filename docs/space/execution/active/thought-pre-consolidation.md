# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
最后更新：2026-06-29

## 约束

1. **Thought 边界**：Thought 表示一段未被可见 assistant 文本、非探索工具或人机交互等待打断的模型思考链。`reason/thinking` 不打断 Thought，只更新当前 Thought 的活动预览；可见 `text/final`、非探索工具、`need_approval`、`need_input`、`need_plan_review` 都会关闭当前 Thought。

2. **探索工具不经 tool_card**：`read_file`、`search_content`、`search_files`、`read_mcp_resource` 在 `tool_call` 时直接进入 `tool_summary`，永远不创建独立 `tool_card`。`shell_execute` 即使是 `intent=inspect` 或只读搜索命令，也不进入 Thought；上游应优先使用 `search_files/search_content` 表达探索搜索。

3. **非探索工具截断**：所有 `shell_execute`、写入工具、审批、`ask_user`、`update_plan`、`task` 等非探索工具与可见文本一样关闭当前 Thought，并继续按原有独立块渲染。后续探索工具会开启新的 Thought。

4. **跨 thinking 合并**：同一 Thought 内，探索工具之间可以夹着 `reason/thinking`。这些 thinking 不创建新的工具聚合，只更新 `tool_summary.latestActivity`。

5. **运行态思考预览**：`tool_summary.active=true` 时，`latestActivity` 优先保存最新 thinking。探索工具调用只在当前 Thought 没有 thinking 预览时作为活动占位；已经展示在工具列表中的工具不应覆盖 thinking 预览。新的 thinking 覆盖旧 thinking；Thought 关闭后清空 `latestActivity`，历史中不保留 thinking 预览。

6. **人机交互停止计时**：进入审批、提问或方案评审等待时，当前 Thought 必须置为 `active=false` 并冻结 `totalElapsedMs`。用户阅读、审批或输入答案的耗时不计入 Thought 时间。

7. **审批焦点优先**：当 Shell 等工具等待用户审批时，OutputArea 只显示到待审批工具卡为止；同一并发批次中后续到达的探索工具或结果块暂时不显示，避免把审批目标挤出视窗。隐藏只发生在渲染层，审批结束后这些块按当前状态重新显示。

8. **保守调度策略**：TUI 只负责按边界截断 Thought，不重排、拆批、取消或强制 settle executor 已发出的 pending 工具。若同一批事件中出现探索工具和 Bash，Bash 关闭 Thought；pending 探索工具继续保留 `running` 状态并等待后续 `tool_done` 更新。

9. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

10. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

11. **计时器对齐**：`totalElapsedMs = Date.now() - createdAt`（wall-clock），非 `Math.max(elapsedMs)`。

12. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

13. **Static 边界**：`tool_summary` 仅在 `active=false` 且 `tools.every(t => t.status !== 'running')` 时进入 Static。

14. **层边界**：`consolidateTools.ts` 中的合并逻辑属于 app 层，不允许导入 core 层模块。

15. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。

16. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

## 设计文档

- `docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md` — Thought 预整合设计详情
- `docs/space/plans/2026-06-28-context-compaction.md` — M0/M1/M2 三层压缩方案

## 修改时必读

修改以下文件时，必须先阅读上述设计文档：
- `src/app/tui/reducers/consolidateTools.ts` — 工具判断 + 合并逻辑
- `src/app/tui/reducers/handleEvent.ts` — tool_call/tool_done 事件处理
- `src/app/tui/components/ToolSummaryBlock.tsx` — Thought 块渲染
- `src/app/tui/components/BlockRenderer.tsx` — tool_summary case
- `src/app/tui/components/render-utils.ts` — actionName/getToolPreview/getToolDetail
- `src/app/tui/types.ts` — ConsolidatedToolEntry / tool_summary 类型
- `src/app/tui/render/useStaticContent.tsx` — isSettled / blockFingerprint for tool_summary
- `src/app/tui/App.tsx` — explorationSummaryIds 初始状态
- `src/app/tui/reducers/agentReducer.ts` — cancelRunningBlocks 处理 tool_summary
- `src/core/model/compaction.ts` — M1 折叠引擎
- `tests/tui-reducer.test.ts` — 预整合测试
- `tests/context.test.ts` — 折叠测试
