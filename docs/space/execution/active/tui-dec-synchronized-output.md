# TUI DEC 同步输出缓冲

状态：active
范围：`src/app/tui/render/useStaticContent.tsx`、`src/app/tui/App.tsx`、`src/app/tui/index.tsx`
读取时机：修改 `useStaticContent` 渲染逻辑、TUI 屏切换（resize/会话切换）行为异常时必读。
验证：`bun run test:e2e`（验证 resize/debounce/缓冲行为）

## 原理

DEC 同步输出（`\x1B[?2026h` / `\x1B[?2026l`）是终端协议，告诉终端将后续所有输出缓冲，收到关闭指令后一次性帧刷新。支持 iTerm2、Kitty、WezTerm、Windows Terminal、Alacritty 等主流终端。macOS 自带 Terminal.app 不支持（忽略序列，退化为普通渲染）。

## 核心设计

所有需要"清屏 + 重渲染"的 TUI 过渡（resize、会话切换）统一使用此机制：

```
React render phase（同步）                     React commit phase        Microtask
─────────────────────────────────────         ──────────────────        ──────────
useStaticContent needsClear:                   Ink 写入 Static +         useEffect:
  \x1B[9999H  ← 光标滚到底（实时执行）            dynamic tree 到 stdout    \x1B[?2026l
  \x1B[?2026h ← 开启缓冲（视口冻结在底部）          ↓                        ↓
  \x1B[H\x1B[2J\x1B[3J ← 清屏（缓冲内）           全部被缓冲捕获              帧刷新 → 原子显示
syncOutputRef.current = true
```

关键时序：
1. `\x1B[9999H` 在 `\x1B[?2026h` **之前**，确保视口在缓冲开始前已滚到底部
2. `\x1B[?2026h` 在 React render phase 中写入 stdout，**早于** Ink commit phase（Ink 在 commit 时输出渲染结果），因此 `Static`、dynamic tree、header、footer **全部渲染输出**被缓冲捕获
3. `\x1B[?2026l` 在 `useEffect` 中执行（commit 后），触发终端帧刷新

## 触发场景

| 场景 | 检测条件 | 额外处理 |
|------|----------|----------|
| resize | `resizeGeneration > 0` | 无（需完整重渲染） |
| 会话切换 | `!isInitialMount && needsClear` | 无（需完整重渲染） |
| 首挂 | `isInitialMount && needsClear` | 不启用缓冲（仅清屏，内容自然显示） |

## 缓冲覆盖范围验证

缓冲启用时机在 React render phase（hook 函数体内同步执行），早于：
- Ink `<Static>` 输出（commit phase）
- Ink `<Box>` / `<Text>` 等 dynamic tree 输出（commit phase）
- 任何通过 `process.stdout.write` 在 render phase 中的写入（同 phase，先到 stdout）

因此 **所有 TUI 渲染输出** 均被缓冲捕获。

## 清理与边界情况

```typescript
useEffect(() => {
  if (syncOutputRef.current) {
    syncOutputRef.current = false;
    process.stdout.write("\x1B[?2026l");  // 正常关闭
  }
  return () => {
    if (syncOutputRef.current) {
      syncOutputRef.current = false;
      process.stdout.write("\x1B[?2026l");  // unmount 前强制关闭
    }
  };
});
```

- **正常流程**：render → commit → effect body 关闭缓冲 → 原子显示
- **快速连续触发**（如连续 resize）：前一个组件 unmount 时 effect cleanup 强制关闭缓冲，防止终端卡在缓冲模式
- **agent streaming 中 resize**：sync 期间 agent 产生的新事件也在缓冲内，flush 后一起显示；后续事件恢复正常实时渲染

## 为什么移除两阶段 Header/Content 渲染

之前 `useStaticContent` 使用 `showContentRef` + `forceUpdate` + `setTimeout` 实现两阶段渲染：
- Phase 1：清屏 → `<Static>` 只渲染 header
- Phase 2：`useEffect` → `forceUpdate` → `<Static>` 追加全部 block

此方案解决「长时间空白」问题，但 header→content 的跳变产生可见抖动。DEC 同步输出天然实现「缓冲全部渲染 → 原子显示」，无需两阶段，代码更简洁（去掉 `useState`、`showContentRef`、`forceUpdate`、两阶段 effect，净减约 30 行）。

## 禁用同步输出的终端

macOS 自带 Terminal.app 不支持 `\x1B[?2026h/l`。该序列被忽略，退化为普通增量渲染，效果等同于原来的两阶段方案（先 header 后 content）。不影响功能，仅无缓冲优化。

## 验证

```bash
bun run typecheck
bun test tests/tui-layout.test.tsx tests/tui-helpers.test.ts tests/tui-reducer.test.ts
# 手动验证 resize 和会话切换无抖动
bun run tui
```

## 关联文档

- [[tui-reference-stability]] — useStaticContent 引用稳定性重构，解决高频渲染下的重复行问题
