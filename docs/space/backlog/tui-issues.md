# TUI 待修复项

日期：2026-05-20
来源：TUI 生产就绪度深度审查
最后更新：2026-05-24（B02–B11 全部已修复，B12–B13 延后）

---

## 可即时修复（低成本）

> B02–B04 对应 [`plans/2026-05-20-tui-production-roadmap.md`](../plans/2026-05-20-tui-production-roadmap.md) 第四步（功能补齐）。

### B01 — `/sessions <id>` 直接加载是空分支

- 位置：`src/app/tui/hooks/useSlashCommand.ts:59-62`
- 状态：✅ 已修复（2026-05-20）

### B02 — `error.recoverable` 上游未利用 ✅

- 位置：`src/core/runner.ts`（`isRecoverableError`），`src/app/tui/index.tsx`（调用）
- 状态：✅ 已修复（2026-05-22）。`isRecoverableError` 区分网络超时/速率限制（可恢复）和配置/权限（不可恢复），TUI 通过 `runTask` catch 调用。

### B03 — UNDO/REDO → Rewind ✅

- 位置：`src/app/tui/index.tsx`（`runRewind`），`src/app/tui/components/CheckpointSelector.tsx`
- 状态：✅ 已修复（2026-05-23）。实现 `/rewind` 命令 → checkpoint 列表 → Revert/Fork 操作，对齐 Claude Code Rewind 模型。

### B04 — 手动 Compaction ✅

- 位置：`src/app/tui/index.tsx`（`compactRequested` flag），`src/core/harness/graph.ts`（`forceCompact` 状态处理）
- 状态：✅ 已修复（2026-05-22）。`Ctrl+X C` / `/compact` 通过 provider 标志触发 graph 实际压缩，emit `compact_begin`/`compact_end` 事件。

---

## 需 e2e 同步清理（中等成本）

### B05 — `retry` 事件 → `model_retry` ✅

- 位置：`src/protocol/events.ts`，`src/core/runner.ts`（`chunkToEvents`）
- 状态：✅ 已修复（2026-05-22）。`model_retry` 事件由 runner `chunkToEvents` 从 graph 节点输出中提取并 emit，mock-agent 同步更新。

### B06 — `compact_begin`/`compact_end` 事件生产路径 ✅

- 位置：`src/core/runner.ts`（`chunkToEvents` L592-598），`src/app/tui/App.tsx`
- 状态：✅ 已修复（2026-05-22）。graph 压缩后通过 `compactionPerformed` 字段输出，runner 转为 `compact_begin`/`compact_end` 事件。

### B07 — `compacting` 字段 UI 消费 ✅

- 位置：`src/app/tui/StatusBar.tsx:48`，`src/app/tui/App.tsx:274-278`
- 状态：✅ 已修复（2026-05-22）。StatusBar 通过 `compacting` prop 展示 `⏳ Compacting...` 状态，reducer 在收到 compact 事件时切换此字段。

---

## 待评估修复

> 以下 B08–B10 已纳入 [`plans/2026-05-20-tui-production-roadmap.md`](../plans/2026-05-20-tui-production-roadmap.md) 第三步（防御纵深）。

### B08 — React Error Boundary ✅

- 位置：`src/app/tui/components/ErrorBoundary.tsx`，`src/app/tui/index.tsx:566`
- 状态：✅ 已修复（2026-05-23）。`<ErrorBoundary>` 包裹 `<TuiBootstrap />`，捕获 React render 错误后显示错误信息并允许退出。

### B09 — Checkpoint 句柄泄漏 ✅

- 位置：`src/core/runner.ts`（5 个函数的 try/finally）
- 状态：✅ 已修复（2026-05-22）。所有 runner 函数使用 `try { ... } finally { checkpointer.close(); }` 确保无论 abort 或异常都关闭。

### B10 — 编辑器 temp 文件清理 ✅

- 位置：`src/app/tui/index.tsx:513-516`
- 状态：✅ 已修复（2026-05-23）。editor `useEffect` 清理函数中 `unlinkSync(tmpFile)`，确保 unmount 时删除 temp 文件。

### B11 — Session 命名 fallback ✅

- 位置：`src/core/persistence/sessions.ts:376-406`
- 状态：✅ 已修复（2026-05-22）。API key 缺失时 fast-fail 返回空字符串；catch 异常时 fallback 为 `cleanMessage.slice(0, 30)` 而非空字符串。

---

## 依赖外部能力

### B12 — 多会话并发

- 依赖：checkpoint 线程安全、多 AbortController 管理
- 暂不排期

### B13 — 自定义斜杠命令 / Hook 系统

- 依赖：插件架构设计
- 暂不排期
