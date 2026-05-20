# TUI 生产就绪路线图

日期：2026-05-20
状态：draft
来源：TUI 生产就绪度深度审查

---

## 目标

将 TUI 从当前"可用终端聊天 Agent"提升到"生产级开发者工具"，对标 Claude Code CLI 模式的核心体验。

## 已完成基线

✅ **第一步：稳定性基线**（2026-05-20 提交 `3e4799a`）
- 错误文本红色渲染
- 中断取消标记 ⊘ Cancelled
- provider 5 分钟超时
- 编辑器 .catch() 容错
- HelpPanel 文档修正
- StatusBar 接入布局
- /sessions `<id>` 直接加载
- recoverable 标志接入
- UNDO/REDO 移除
- 防御性 interrupt 清理

---

## 第二步：感知闭环

**目标**：用户能清晰感知 agent 的实时状态

### 2.1 流式输出指示器

- **问题**：模型输出期间无任何视觉信号，用户不知道 agent 是否在工作
- **涉及文件**：
  - `src/app/tui/components/MarkdownBlock.tsx` — 已有 `streaming` prop，当前仅显示末尾 `▌` 光标
  - `src/app/tui/OutputArea.tsx` — text block 渲染逻辑
- **方案**：在正在流式输出的 text block 行首显示闪烁的 `❯` 或旋转指示器
- **验证**：`bun test tests/tui-layout.test.tsx`
- **依赖**：无

### 2.2 Plan 进度接入

- **问题**：`state_change.plan` 事件 runner 已发出（`runner.ts:394`），StatusBar 的 `planLabel()` 已实现，但需确认数据链
- **涉及文件**：
  - `src/app/tui/StatusBar.tsx` — `planLabel()` 已实现
  - `src/core/runner.ts` — `chunkToEvents()` 中 `state_change` 事件包含 `plan`
  - `src/core/harness/graph.ts` — agent 节点的 plan 更新逻辑
- **方案**：验证 runner → TUI 的 plan 数据链路，确保 `status.plan` 正确更新
- **验证**：`bun test tests/tui-layout.test.tsx`，`bun test tests/integration.test.ts`
- **依赖**：无

### 2.3 Phase 切换确认

- **问题**：StatusBar 显示 Building/Planning，需确认 `/plan` 命令后 `state_change.phase` 正确传导
- **涉及文件**：
  - `src/app/tui/hooks/useSlashCommand.ts` — `/plan` 命令
  - `src/app/tui/App.tsx` — `SET_PHASE` action
  - `src/core/runner.ts` — phase 事件发射
- **方案**：添加 phase 切换的 e2e 场景验证
- **验证**：`bun test tests/tui-reducer.test.ts`
- **依赖**：无

---

## 第三步：防御纵深

**目标**：异常场景不丢数据、不崩进程

### 3.1 React Error Boundary

- **问题**：任何 render 错误直接导致 Ink 进程崩溃，无兜底
- **涉及文件**：
  - `src/app/tui/index.tsx` — `<TuiBootstrap />` 渲染入口
  - 新建 `src/app/tui/components/ErrorBoundary.tsx`
- **方案**：
  1. 创建 `ErrorBoundary` 组件，捕获子组件 render 错误
  2. 显示错误信息和"按任意键退出"提示
  3. 包裹 `<TuiBootstrap />`
- **风险**：Error Boundary 只能捕获 render 阶段的错误，不能捕获事件处理器或异步错误
- **验证**：`bun test tests/tui-layout.test.tsx`（新增错误边界测试）

### 3.2 Checkpoint 句柄泄漏

- **问题**：`runner.ts:161-165` — `checkpointer.close()` 在 abort 时被跳过
- **涉及文件**：
  - `src/core/runner.ts` — `runAgent` 的 finally 块
  - `src/core/persistence/checkpoint.ts` — `BunSqliteSaver.close()`
- **方案**：
  1. 检查 `BunSqliteSaver` 是否自身有 GC 安全网
  2. 若无，移除 `if (!signal?.aborted)` 守卫，始终 close
  3. 验证 close 在 abort 后调用不会 crash（`isClosed` 防御已存在）
- **风险**：abort 后 close 可能与写入操作竞态
- **验证**：`bun test tests/checkpoint.test.ts`

### 3.3 编辑器 Temp 文件泄漏

- **问题**：编辑器进程 unmount 取消时 temp file 未 unlink
- **涉及文件**：
  - `src/app/tui/index.tsx:269-300` — editor 效果
- **方案**：在 effect 的 cleanup 函数中 `try { unlinkSync(tmpFile) } catch {}`
- **验证**：手动测试 Ctrl+E → 快速 Ctrl+C 取消 → 确认 temp 文件被清理

---

## 第四步：功能补齐

**目标**：对标 Claude Code CLI 核心体验

### 4.1 Undo/Redo（checkpoint 回溯）

- **问题**：当前无撤销能力，依赖方需要 checkpoint 链 fork
- **涉及文件**：
  - `src/core/persistence/checkpoint.ts` — `BunSqliteSaver`，需新增 fork/回溯方法
  - `src/core/runner.ts` — 新增从指定 checkpoint 启动的入口
  - `src/app/tui/App.tsx` — 还原 UNDO/REDO action（已移除）
  - `src/app/tui/hooks/useGlobalKeys.ts` — 添加 Ctrl+Z / Ctrl+Y
- **方案**：
  1. `BunSqliteSaver` 新增 `getCheckpointChain(threadId)` 利用 `parent_checkpoint_id` 遍历
  2. `runAgent` 支持 `resumeFromCheckpointId` 参数
  3. TUI 接入
- **难度**：高，涉及 checkpoint 层设计
- **依赖**：需要 saver 层改造，影响所有 runner 调用方

### 4.2 手动 Compaction

- **问题**：`/compact` 仅输出文本提示，无实际触发
- **涉及文件**：
  - `src/core/harness/graph.ts` — `forceContextCompaction()` 需暴露
  - `src/app/tui/App.tsx` — `COMPACT_CONTEXT` reducer
  - `src/app/tui/index.tsx` — 通过 provider 信号触发
- **方案**：
  1. graph 层提供可通过事件触发的 compaction 入口
  2. runner 接受 compaction 信号并转发给 graph
  3. TUI 接入

### 4.3 自定义斜杠命令

- **问题**：仅内置 13 个命令，用户无法扩展
- **方案**：后续设计，暂不排期
- **依赖**：插件架构设计

---

## 步骤依赖关系

```
第二步（无依赖）
  ├── 2.1 流式指示器
  ├── 2.2 Plan 进度       ← 可并行
  └── 2.3 Phase 确认      ← 可并行
       ↓
第三步（部分依赖 step2 中的 Error Boundary）
  ├── 3.1 Error Boundary  ← 可立即开始
  ├── 3.2 Checkpoint 泄漏 ← 可立即开始
  └── 3.3 Temp 文件泄漏    ← 可立即开始
       ↓
第四步（依赖 checkpoint 层改造）
  ├── 4.1 Undo/Redo       ← 依赖 saver 改造
  ├── 4.2 Compaction      ← 依赖 graph 改造
  └── 4.3 自定义命令      ← 暂不排期
```

## 建议执行顺序

1. **本周**：第二步全部（感知闭环，改动最小，感知最强）
2. **下周**：第三步全部（防御纵深，独立不依赖其他步）
3. **后续**：根据 saver/graph 改造进度启动第四步
