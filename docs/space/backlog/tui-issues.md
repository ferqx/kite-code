# TUI 待修复项

日期：2026-05-20
来源：TUI 生产就绪度深度审查

---

## 可即时修复（低成本）

### B01 — `/sessions <id>` 直接加载是空分支

- 位置：`src/app/tui/hooks/useSlashCommand.ts:59-62`
- 状态：✅ 已修复（2026-05-20）

### B02 — `error.recoverable` 上游未利用

- 位置：`src/app/tui/App.tsx:228`（reducer 已接入），`src/app/tui/index.tsx:183-187`（emit 点始终 `recoverable: false`）
- 问题：TUI 端已支持可恢复/不可恢复差异化渲染，但 runner 从不发出 recoverable=true
- 修复方向：在 `runner.ts` 或 `graph.ts` 中区分可恢复错误（网络/超时）和不可恢复错误（配置/权限）

### B03 — UNDO/REDO 已移除，需重新实现

- 位置：`src/app/tui/App.tsx`（Action 和 reducer 已于 2026-05-20 移除）
- 问题：`BunSqliteSaver` 仅 append-only，无 fork/rollback 方法
- 实现方向：
  1. saver 层新增 `getCheckpointChain()` 遍历 `parent_checkpoint_id`
  2. runner 层新增 `runAgentFromCheckpoint(checkpointId)` 
  3. TUI 层新增 `Ctrl+Z` / `Ctrl+Y` 绑定

### B04 — 手动 Compaction 是空壳

- 位置：`src/app/tui/App.tsx:369-372`（reducer），`src/core/harness/graph.ts`（forceContextCompaction 未暴露）
- 问题：`Ctrl+X C` / `/compact` 只输出文本提示，无实际 graph 触发
- 实现方向：graph 暴露可通过信号触发的 compaction 入口，TUI 通过 provider 事件转发

---

## 需 e2e 同步清理（中等成本）

### B05 — `retry` 事件生产路径未发射

- 位置：`src/protocol/events.ts:16`（类型），`src/app/tui/App.tsx:186-188`（reducer），`tests/e2e/mock-agent.tsx:274-278`（测试使用）
- 问题：只有 `model_retry` 被 runner 发出，`retry` 从未触发
- 清理方向：同步更新 mock-agent 和 failure-scenarios，移除 `retry` 分支，或让 runner 发出此事件

### B06 — `compact_begin`/`compact_end` 事件生产路径未发射

- 位置：`src/protocol/events.ts:13-14`（类型），`src/app/tui/App.tsx:249-255`（reducer），`tests/e2e/mock-agent.tsx:343-350`（测试使用）
- 问题：graph 的 forceContextCompaction 未转化为事件
- 清理方向：同步更新 mock-agent，移除分支，或让 graph 发出此事件

### B07 — `compacting` 字段无人消费

- 位置：`src/app/tui/types.ts:27`（TuiState.compacting），仅被 B06 的事件分支写入，无组件读取
- 修复方向：在 Header/StatusBar 中消费 `compacting` 展示压缩中状态，或移除字段

---

## 待评估修复

### B08 — React Error Boundary 缺失

- 位置：`src/app/tui/index.tsx:348`
- 问题：任何 React render 错误直接导致 Ink 进程崩溃，无兜底
- 方向：在 `<TuiBootstrap />` 外包一层 `<ErrorBoundary>`，捕获后显示错误并允许退出

### B09 — Checkpoint 句柄在 abort 时泄漏

- 位置：`src/core/runner.ts:161-165`
- 问题：`if (!signal?.aborted) checkpointer.close()` — 每次 Ctrl+C 取消都泄漏 SQLite fd，依赖 GC 回收
- 方向：无论如何在 finally 中 close，或确保 Bun GC 能及时回收

### B10 — 外部编辑器 temp 文件在取消/unmount 时泄漏

- 位置：`src/app/tui/index.tsx:269-300`
- 问题：editor 进程的 `.catch()` 已添加（2026-05-20），但 unmount 取消时 temp file 未 unlink

### B11 — Session 命名 API key 缺失时静默失败

- 位置：`src/core/persistence/sessions.ts:371-407`
- 问题：`generateSessionName` 无 API key 时返回空字符串，外层 catch 忽略 — session 名为空

---

## 依赖外部能力

### B12 — 多会话并发

- 依赖：checkpoint 线程安全、多 AbortController 管理
- 暂不排期

### B13 — 自定义斜杠命令 / Hook 系统

- 依赖：插件架构设计
- 暂不排期
