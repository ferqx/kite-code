# TUI 生产就绪路线图

日期：2026-05-20
状态：archived（2026-06-08 归档）
来源：TUI 生产就绪度深度审查
实施日期：2026-05-21

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

## 第二步：感知闭环 ✅

**目标**：用户能清晰感知 agent 的实时状态

### ✅ 2.1 流式输出指示器

- **实现**：`OutputArea.tsx:101` — streaming text block 行首显示 `❯` 前缀（`{(isFocused || block.streaming) ? …}`）
- **测试**：`tui-layout.test.tsx` 新增 2 个渲染测试（streaming=true 显示 `❯`，false 不显示）

### ✅ 2.2 Plan 进度接入

- **结论**：数据链路完整（graph → runner `chunkToEvents()` → `state_change` event → reducer → Header/StatusBar `planLabel()`），无需代码修改

### ✅ 2.3 Phase 切换确认

- **实现**：`tui-reducer.test.ts` 新增 2 个测试 — `SET_PHASE` 双向切换、`SWITCH_AUTH` 显式模式

---

## 第三步：防御纵深 ✅

**目标**：异常场景不丢数据、不崩进程

### ✅ 3.1 React Error Boundary

- **实现**：新建 `src/app/tui/components/ErrorBoundary.tsx`（类组件 + ErrorFallback 函数组件），包裹 `index.tsx` 中的 `<TuiBootstrap />`
- **测试**：`tui-layout.test.tsx` 新增 2 个测试 — 正常渲染、render 错误捕获 + 按任意键退出

### ✅ 3.2 Checkpoint 句柄泄漏

- **实现**：`runner.ts` 3 处移除 `!signal?.aborted` 守卫（`runAgent`、`streamCodeAgent`、`resumeCodeAgent`），始终调用 `checkpointer.close()`；`isClosed` 防御已存在
- **测试**：`runner.test.ts` 新增 close 安全性测试（多次调用不崩溃）

### ✅ 3.3 编辑器 Temp 文件泄漏

- **实现**：`index.tsx` editor effect cleanup 中动态 `import("node:fs").unlinkSync(tmpFile)` 套 try/catch
- **验证**：手动测试（Ctrl+E → 快速取消）

---

## 第四步：功能补齐（部分完成）

**目标**：对标 Claude Code CLI 核心体验

### 🔜 4.1 Undo/Redo（checkpoint 回溯）

- **状态**：讨论后决定后续单独设计。需要 checkpoint 层深度改造（`getCheckpointChain`、fork 机制），风险较高。当前 checkpoint `parent_checkpoint_id` 链已存在，基础可复用。
- **难度**：高
- **依赖**：saver 层改造

### ✅ 4.2 手动 Compaction

- **实现**：
  - `state.ts` — 新增 `forceCompact` 字段
  - `graph.ts` — agent 节点读取 `forceCompact`，在模型调用前执行 `forceContextCompaction()`
  - `runner.ts` — 读取 provider 的 `compactRequested` 标志，通过 `Command.update` 传入 graph
  - `provider.ts` — 新增 `compactRequested` 属性
  - `useSlashCommand.ts` + `useGlobalKeys.ts` — `/compact` 和 `Ctrl+X c` 触发 `onCompactRequest` 回调
  - `App.tsx` + `index.tsx` — 接线
- **测试**：`graph.test.ts` 新增 2 个 forceCompact 测试；e2e 新增 compaction-while-running 场景

### 📋 4.3 自定义斜杠命令

- **状态**：暂不排期。已讨论配置混合方案（shell 命令 + action 链），待插件架构成熟后再实施。
- **依赖**：插件架构设计

---

## ✅ 额外完成

- `tools.test.ts` — 修复 macOS 上 `msys2ToWindowsPath` + `/var` symlink 导致的路径比对失败
- 测试缺口补全 — `tui-layout.test.tsx`（+2 streaming 渲染测试）、`graph.test.ts`（+2 forceCompact 测试）、`runner.test.ts`（+1 close 安全测试）
- e2e 清理 — 删除 3 个冗余文件、移动 `freeze.test.ts`、清理死代码、补 compaction-while-running 场景

## 实施汇总

| 步骤 | 任务 | 状态 |
|------|------|:--:|
| 第二步 | 2.1 流式输出指示器 | ✅ |
| | 2.2 Plan 进度接入 | ✅ |
| | 2.3 Phase 切换确认 | ✅ |
| 第三步 | 3.1 React Error Boundary | ✅ |
| | 3.2 Checkpoint 句柄泄漏 | ✅ |
| | 3.3 编辑器 Temp 文件泄漏 | ✅ |
| 第四步 | 4.1 Undo/Redo | 🔜 |
| | 4.2 手动 Compaction | ✅ |
| | 4.3 自定义斜杠命令 | 📋 |
| 额外 | tools.test 路径修复 | ✅ |
| | 测试缺口补全 | ✅ |
| | e2e 清理 | ✅ |
