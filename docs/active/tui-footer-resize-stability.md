# TUI 终端缩放刷新方案

状态：active

读取时机：修改 Footer、高度测量、窗口 resize、InputLine 或 overlay 布局时。

验证：`bun test tests/tui-layout.test.tsx tests/tui-extra-space.test.tsx tests/tui-system/scenarios/resize.test.ts`。
范围：`src/app/tui/index.tsx`、`src/app/tui/components/InputLine.tsx`、`src/app/tui/hooks/useOverlayHeight.ts`、`src/app/tui/render/useStaticContent.tsx`
读取时机：修改 TUI resize 逻辑、怀疑缩放行为异常时必读。

## 最终方案（2026-06-15）

### 原理

终端缩放时 Ink 产生重复输出的根因：拖拽过程中终端发送 N 次 `SIGWINCH`，Ink 内部 `resized` handler 每次都触发 `onRender()`，但只在宽度变窄时调用 `this.log.clear()`。宽度变宽时旧帧叠加，且 `log-update` 的坐标跟踪在终端 resize 后错位。

**当前方案不跟 Ink 内部打，而是在每次 resize 事件上做全量 rebuild：**

1. 监听 `process.stdout.on("resize")`，仅当 `process.stdout.columns` 变化时才触发
2. 仅高度变化（tmux 分屏调整、窗口高度拖拽等）不触发，`<Flex>` 布局自动适应高度
3. `setResizeKey(n+1)` 触发 `<App key={resizeKey}>` 强制 React 卸载重建整个 App 组件树
4. React 自动将同一帧内的多次 `setResizeKey` 合并为一次渲染 — 快速拖拽时只在最终宽度刷新一次布局
5. 输入文字通过 `initialValue` prop + `onValueChange` 回调保留在 `inputValueRef` 中，remount 时恢复
6. 清屏 + 缓冲渲染由 `useStaticContent` 内的 DEC 同步输出（`\x1B[?2026h/l`）处理，详见 `tui-dec-synchronized-output.md`

### 执行流程

```
resize 事件
  → process.stdout.columns !== prevCols?  // 仅宽度变化才执行
  → setResizeKey(n+1)                       // 入队 React state 更新
  → TuiBootstrap 重渲染                      // React 合并同一帧内多次 setState
    → 读 inputValueRef.current（最新输入文字）
    → <App key={resizeKey}> remount
      → useStaticContent needsClear:
        → \x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J  // 置底 + 开启缓冲 + 清屏
        → 全量渲染 Static + dynamic tree              // 全部被缓冲
        → useEffect → \x1B[?2026l                    // 关闭缓冲，原子显示
      → InputLine: useState(initialValue) 恢复文字
```

### 关键决策

| 决策 | 理由 |
|------|------|
| 仅宽度变化时触发 | 高度变化（tmux 分屏、窗口高度拖拽）由 `<Flex>` 自动处理，无需 remount |
| 每次事件都触发（不 debounce） | 快速拖拽时 debounce 永远不触发，导致中间帧累积 |
| `\x1b[3J` 清 scrollback | `<Static>` 在 remount 时重新渲染，不清会导致双份 |
| key 在 TuiBootstrap 层（不是 App 内） | TuiBootstrap 重渲染才能读到最新的 `inputValueRef.current` |
| `process.stdout.on("resize")` 而非 polling | resize 事件在 macOS/Bun 下正常发射，polling 浪费 CPU |
| 依赖 React 自动批处理合并 render | 同一帧多次 setState 只触发一次渲染，避免 layout 震荡 |
| 清屏 + 缓冲委托给 useStaticContent | resize handler 不再自行操作终端，由 useStaticContent 统一管理 DEC 同步输出缓冲（见 `tui-dec-synchronized-output.md`） |

### 变更文件

| 文件 | 变更 |
|------|------|
| `src/app/tui/index.tsx` | `inputValueRef` + `resizeKey` state + resize 事件监听 + `<App key={resizeKey} resizeGeneration={resizeKey}>` |
| `src/app/tui/render/useStaticContent.tsx` | `resizeGeneration` prop → `\x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J` 清屏 + 缓冲；`useEffect` → `\x1B[?2026l` 关闭缓冲；移除两阶段 showContent 状态机 |
| `src/app/tui/App.tsx` | 新增 `resizeGeneration?: number` prop，透传到 `useStaticContent` |
| `src/app/tui/components/InputLine.tsx` | `initialValue`/`onValueChange` props，`useEffect` 同步值到父组件 |
| `src/app/tui/hooks/useOverlayHeight.ts` | 移除手动 resize 监听，直接读 `stdout.rows` |
| `src/app/tui/hooks/useResizeCleanup.ts` | 删除（dead code） |
| `src/app/tui/App.tsx` | 移除 `useResizeCleanup` 导入和调用 |

### 验证

```bash
bun run typecheck
bun test ./tests/tui-soft-wrap.test.tsx ./tests/tui-cursor-nav.test.tsx ./tests/tui-edge-cases.test.tsx
```

### 关联文档

- [[tui-reference-stability]] — useStaticContent 引用稳定性重构，解决高频渲染下的重复行问题

## 验证：

```bash
bun test tests/tui-soft-wrap.test.tsx tests/tui-cursor-nav.test.tsx tests/tui-edge-cases.test.tsx
```
