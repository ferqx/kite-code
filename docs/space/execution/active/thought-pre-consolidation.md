# Thought 预整合规则

状态：active
范围：TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界
最后更新：2026-06-29

## 约束

1. **探索工具不经 tool_card**：`read_file`、`search_content`、`search_files`、`read_mcp_resource`、`shell_execute (intent=inspect + search cmd)` 在 `tool_call` 时直接进入 `tool_summary`，永远不创建独立 `tool_card`。

2. **连续合并**：同一轮 agent 内，连续出现的探索工具追加到同一个 `tool_summary`。遇到非探索工具或已 settle 时创建新块。

3. **explorationSummaryIds 映射**：`tool_call` 时建立 `callId → blockId` 映射存储在 `TuiState.explorationSummaryIds`。`tool_done` 时通过此映射精确定位 summary 块，不依赖 `findLastIndex(blocks, b => b.tools.some(...))` 搜索。

4. **tool_done 状态更新必须使用 `.map()` 创建全新引用**：直接修改 `turns` 数组和 `blocks` 数组的引用链，确保 reducer 返回全新 state，React 能检测到变化。

5. **计时器对齐**：`totalElapsedMs = Date.now() - createdAt`（wall-clock），非 `Math.max(elapsedMs)`。

6. **最小显示 1s**：`formatDuration` 和 `buildToolSummaryLine` 中的耗时格式化，秒数最小为 1。

7. **Static 边界**：`tool_summary` 在 `tools.every(t => t.status !== 'running')` 时进入 Static。

8. **层边界**：`consolidateTools.ts` 中的合并逻辑属于 app 层，不允许导入 core 层模块。

9. **工具名映射**：所有 TUI 展示使用 `ACTION_NAMES` 映射的友好名称，不允许硬编码英文工具名。

10. **审批无关**：探索工具永远不需要审批，`ToolSummaryBlock` 不接受 `awaitingApproval` prop。

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
