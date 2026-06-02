# 移除 `<Static>`，改用 React.memo + 引用稳定 reducer

状态：completed
日期：2026-06-02
范围：

- `src/app/tui/reducers/handleEvent.ts` — 8 处 `.map()` 替换为 `replaceBlock()`
- `src/app/tui/reducers/agentReducer.ts` — 4 处 `.map()` 替换，新增 `finalizeStreaming()` helper
- `src/app/tui/OutputArea.tsx` — 移除 `<Static>`，全部 block 通过 React.memo 组件渲染
- `src/app/tui/App.tsx` — 去掉 flexGrow wrapper，Footer 紧跟内容，底部 spacer
- `tests/e2e/render-tui.tsx` — idle 检测改为匹配 `"▼ Thinking"`
- `tests/e2e/startup.test.tsx` — recovery 测试增加 agent loop 清理等待

关联：

- `execution/completed/2026-05-28-static-header-ordering-fix.md`（superseded）
- `execution/active/tui-no-viewport-culling.md`
- `understanding/2026-05-12-tui-overhaul-design.md`
- `docs/superpowers/plans/2025-06-02-remove-static-perf.md`（实施计划）

验证：

- `bun test tests/tui-reducer.test.ts` — 111 pass
- `bun test tests/tui-layout.test.tsx` — 94 pass
- `bun test tests/e2e/startup.test.tsx` — 17 pass
- `bun run typecheck` — 零新增错误

## 问题

Ink `<Static>` 组件将已完成 block 渲染到终端 scrollback，动态树通过 flexGrow 填充 viewport。这导致 scrollback 最后一行与 Footer 之间出现大量空白区域（flexGrow 填充的空白）。用户反馈"agent 通过子 agent 回复完成后空白太多"。

尝试去掉 flexGrow 会使 Ink viewport 高度不稳定，导致终端滚动条自动跳到顶部。

## 解决方案

**核心思路**：去掉 `<Static>`，所有 block 在普通 React 树中渲染。性能优化改用两个机制：

1. **Reduer 引用稳定性**：所有 `.map()` 替换为 `replaceBlock()`（`slice` + 单元素替换），追加 block 用 `[...blocks, block]`（元素引用不变）。只有变化的 block 获得新引用。

2. **React.memo 组件**：每个 block 类型包裹在 `React.memo` 中（`UserBlock`、`TextBlock`、`ReasonBlock`、`ToolCard`、`FileChange`、`Approval`、`Question`、`SubAgent`）。reducer 保持引用不变 → memo 浅比较通过 → 跳过 re-render。

**效果**：未变化 block 不重新渲染，等价于 `<Static>` 的"渲染一次"行为，但无 scrollback/viewport 分割。

**布局调整**：
- App 根 Box 去掉 flexGrow wrapper，Footer 紧跟 OutputArea
- 底部放 `<Box flexGrow={1} />` spacer 保持 viewport 高度稳定，避免滚动问题
- block 间 `marginBottom={1}` 保持原有间距

## 关键设计决策

1. **不使用 `React.memo` 自定义比较函数**：直接依赖引用比较。reducer 保证同一 block 在同一运行周期内引用不变即可。

2. **`replaceBlock` 而非 `replaceLastMatching`**：改为 `findIndex` + `slice` + 替换，更通用且避免 predicate 误匹配。

3. **`finalizeStreaming` helper**：`SET_IDLE`、`CTRL_C`、`ESCAPE` 都需要将 streaming text block 设为 false。统一为辅助函数，遍历 blocks 仅更新 `streaming === true` 的 text block。

4. **e2e idle 检测修正**：从 `!out.includes("Thinking")` 改为 `!out.includes("▼ Thinking")`。原因：去掉 `<Static>` 后，折叠的 reason block 的 `▶ Thinking...` 文字现在出现在 `lastFrame()` 中，但折叠状态不表示模型正在思考。

## 测试适配

- `tests/e2e/render-tui.tsx`：idle 检测修正
- `tests/e2e/startup.test.tsx`：Ctrl+C recovery 测试增加 1200ms 等待，确保 agent loop 完全清理后再发新消息（CTRL_C 立即设置 running=false，但 abort 信号和 mock 模型 800ms 延迟之间有竞态）
