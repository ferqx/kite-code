# TUI 终端缩放刷新方案

状态：active
范围：`src/app/tui/App.tsx`、`src/app/tui/index.tsx`、`src/app/tui/components/InputLine.tsx`、`src/app/tui/OutputArea.tsx`、`src/app/tui/hooks/useOverlayHeight.ts`、`src/app/tui/hooks/useResizeCleanup.ts`
读取时机：修改 TUI resize 相关逻辑、怀疑缩放行为异常时必读。

## 最终方案（2026-06-14）

### 原理

终端缩放时 Ink 产生重复输出的根因是：拖拽过程中终端发送 N 次 `SIGWINCH`，Ink 内部 `resized` handler 每次都触发 `onRender()`，但只在宽度变窄时调用 `this.log.clear()`。宽度变宽时旧帧叠加，且 `log-update` 的坐标跟踪在终端 resize 后错位。

**当前方案不跟 Ink 内部打，而是在 resize 停止后做一次全量 rebuild：**

1. **Polling + Debounce**：每 150ms 轮询 `process.stdout.columns`，检测到变化后启动 300ms debounce + 3s maxWait
2. **清屏 + 清 scrollback**：`\x1b[2J\x1b[3J` 清除可见内容和 scrollback
3. **Key remount**：`setResizeKey(n+1)` → `<App key={resizeKey}>` 强制 React 卸载重建整个 App 组件树
4. **输入文字保留**：通过 `initialValue` prop 将 InputLine 的值提升到 TuiBootstrap 层，def 在 ref 中，remount 时恢复

### 执行流程

```
polling 150ms → 检测列宽变化
  ├─ 重置 300ms debounce（正常：停止 resize 即触发）
  └─ 首次变化启动 3s maxWait（兜底：极限抖动 3s 后强制执行）
     ↓ 触发
  \x1b[2J\x1b[3J（清屏 + 清 scrollback）
  setResizeKey(n+1) → TuiBootstrap 重渲染
    → 读 inputValueRef.current（最新输入文字）
    → <App key={resizeKey}> remount
      → InputLine: useState(initialValue) 恢复文字
      → <Static> 在空 scrollback 上重建 → 无重复
```

### 关键决策

| 决策 | 理由 |
|------|------|
| `\x1b[3J` 清 scrollback | `<Static>` 的内容在 remount 时会重新渲染，不清 scrollback 会导致双份 |
| key 在 TuiBootstrap 层（不是 App 内） | TuiBootstrap 重渲染才能读到最新的 `inputValueRef.current` |
| polling 而不是 `stdout.on("resize")` | macOS zsh + Bun 下 resize 事件行为不确定，polling 更可靠 |
| `initialValue` prop 而非 `useWindowSize` | remount 后 `useState(initialValue)` 恢复文字，比用 state 可控 |

### 失败的方案（已记录，避免重试）

1. **固定 Footer 高度 + 内容截断**：视觉无法接受
2. **备用屏幕缓冲区 (alternate screen)**：退出时 scrollback 隔离，复杂度高
3. **Footer 绝对定位**：未能解决幽灵行
4. **`useWindowSize()` + `emit("resize")` + `useStdout().write("\x1b[2J")`**：双重渲染叠加，log-update 冲突
5. **`prependListener` 清屏**：handler 在 Ink 之后执行，擦掉新内容
6. **monkey-patch `process.stdout.on` debounce**：与 `useWindowSize` 双重渲染叠加
7. **`process.stdout.columns` 实时读取**：单靠这个无法清除拖拽 resize 期间的多帧输出

### 变更文件

| 文件 | 变更 |
|------|------|
| `src/app/tui/index.tsx` | `inputValueRef` + `resizeKey` state + polling/debounce + `<App key={resizeKey}>` |
| `src/app/tui/App.tsx` | 移除 `useResizeCleanup()` |
| `src/app/tui/components/InputLine.tsx` | `useWindowSize()` → `process.stdout.columns` + `initialValue`/`onValueChange` props |
| `src/app/tui/hooks/useOverlayHeight.ts` | 移除手动 resize 监听，直接读 `stdout.rows` |
| `src/app/tui/hooks/useResizeCleanup.ts` | 删除（dead code） |

### 验证

```bash
bun run typecheck
bun test ./tests/tui-soft-wrap.test.tsx ./tests/tui-cursor-nav.test.tsx ./tests/tui-edge-cases.test.tsx
```
