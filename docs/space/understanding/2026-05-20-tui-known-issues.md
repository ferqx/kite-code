# TUI 已知问题与待清理项

日期：2026-05-20
来源：TUI 生产就绪度深度审查

> 具体待办项已移至 [`backlog/tui-issues.md`](../backlog/tui-issues.md)。本文档保留设计层面的分析与解释。

## 死事件类型（生产路径不发射，仅 e2e 测试使用）

以下事件类型定义在 `src/protocol/events.ts`，reducer 有对应处理分支，但生产 runner（`src/core/runner.ts` 的 `chunkToEvents()`）从不发出：

| 事件 | 用途 | 现状 |
|------|------|------|
| `retry` | 操作级重试通知 | 只有 `model_retry` 被发出，`retry` 从未触发 |
| `compact_begin` | 上下文压缩开始通知 | Graph 的 `forceContextCompaction()` 有压缩逻辑，但未转化为事件 |
| `compact_end` | 上下文压缩完成通知 | 同上 |

**影响**：`compacting` 状态字段在生产中永远不会为 `true`。这三个 reducer 分支在当前生产路径中是死代码，但 e2e mock agent 使用它们模拟失败/压缩场景。清理需要同步更新 `tests/e2e/mock-agent.tsx` 和 `tests/e2e/scenarios/failure-scenarios.ts`。

**相关文件**：
- `src/protocol/events.ts` — 类型定义（保留）
- `src/app/tui/App.tsx` — reducer 分支（保留，e2e 使用）
- `src/core/runner.ts` — 应在压缩/重试时发出这些事件

## compacting 字段无人读取

`TuiState.compacting` 仅由 `compact_begin`/`compact_end` 事件写入，但 **没有任何组件读取此字段**：
- Header 用的是 `paused` prop（映射自 `state.interrupt` 是否存在）
- StatusBar 用的是 `running` prop
- OutputArea 不读取 `compacting`

**影响**：该字段为纯摆设。如果需要展示"压缩中"状态，需要在 Header 或 StatusBar 中消费它。

## recoverable 标志上游未利用

`error.recoverable` 字段已在 TUI 端接入（可恢复错误用 `⟳ Recoverable error` 前缀，不置 `sessionError`），但唯一的 signal 发射点（`index.tsx:183-187`）始终传递 `recoverable: false`。

**影响**：当前无任何路径会触发可恢复错误的差异化渲染。需要在 runner/graph 层区分可恢复/不可恢复错误后才有意义。

## Undo/Redo 已移除

UNDO/REDO Action 类型和 reducer 分支已在 2026-05-20 移除（无键盘绑定、无实现）。若将来要实现：
- 需要 `BunSqliteSaver` 支持 fork/rollback（当前仅 append-only）
- 需要利用 `parent_checkpoint_id` 回溯 checkpoint 链
- 需要在 `useGlobalKeys` 中添加 Ctrl+Z / Ctrl+Y 绑定

## 手动 Compaction 是空壳

`Ctrl+X C` / `/compact` 仅在 reducer 中插入一条文本提示，无实际 graph 触发机制。Graph 的自动压缩（context overflow 触发）正常工作，但手动触发无后端支持。

**相关文件**：
- `src/app/tui/App.tsx:369-372` — COMPACT_CONTEXT reducer
- `src/core/harness/graph.ts` — forceContextCompaction() 需要暴露为可通过事件触发的入口

## 剩余未修复的低风险项

详见 [`backlog/tui-issues.md`](../backlog/tui-issues.md) 的 B08–B11。
