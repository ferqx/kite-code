# TUI Footer 尺寸与终端缩放稳定性

状态：active
范围：`src/app/tui/Footer.tsx`、`src/app/tui/StatusBar.tsx`、`src/app/tui/StatsLine.tsx`、`src/app/tui/components/InputLine.tsx`、`src/app/tui/components/CtrlSafeTextInput.tsx`、`src/app/tui/hooks/useOverlayHeight.ts`
读取时机：讨论或尝试修复 TUI 缩放时输入行重复/幽灵行问题时必读，避免重复踩坑。

## 目的

记录对“终端缩放时输入行重复/幽灵行”问题的修复尝试与结论，防止后续开发者重复尝试已被证明不可行的方案。

## 核心结论

在 **保留 `<Static>` 避免长会话输入卡顿** 且 **保留主屏幕 scrollback** 这两个约束下，**缩放时输入行完全不重复在 Ink 中做不到**。根本原因是：

1. Ink 底层使用 `log-update`，按上一帧的逻辑坐标覆盖输出。
2. 终端缩放时，`<Static>` 里的历史消息会被终端模拟器重排，导致 Footer 的物理坐标变化。
3. Ink 不知道终端重排后的物理坐标，因此旧 Footer 帧会残留。

## 已尝试并回退的方案

以下方案都已在 `dev-tui-new` 分支上实现并测试，最终均因不可接受的 trade-off 被回退到 `6ea4860`。

### 1. 固定 Footer 高度 + 内容截断

- `StatusBar` / `StatsLine` 固定 `height={1}` + `width={columns} overflow="hidden"`。
- `InputLine` 固定 `maxLines={3}`，底部对齐，未使用行显示淡色 `│`。

**结果**：缩放确实不再因 Footer 自身高度变化而重复，但空闲时输入区上方总有 2 行空白/占位，视觉上无法接受。

### 2. 备用屏幕缓冲区（alternate screen buffer）

- 启动时写入 `\x1b[?1049h` 进入备用屏幕。
- 退出/SIGINT/SIGTERM 时写入 `\x1b[?1049l` 恢复主屏幕。
- 缩放时清屏强制 Ink 全量重绘。
- 退出前通过 `dumpSessionToStdout` 把会话以纯文本写回主屏幕以保留 scrollback。

**结果**：彻底解决缩放重复，但用户不接受退出时 scrollback 隔离/恢复带来的复杂度和格式损失。

### 3. Footer 绝对定位

- 根容器 `height={stdout.rows}`。
- Footer 使用 `position="absolute" bottom={0} left={0} right={0}` 钉在终端底部。

**结果**：未能解决幽灵行问题，Ink 的 `log-update` 仍然按逻辑坐标覆盖，物理坐标错位依旧。

## 可行的彻底方案（需突破当前约束）

若未来可以接受以下任一条件，问题可解：

1. **备用屏幕 + 富文本恢复**：运行时隔离，退出前把会话完整写回主屏幕。
2. **移除 `<Static>`，全部动态渲染**：让 Ink 管理所有行，缩放时全量重绘。代价是长会话输入可能重新出现卡顿。

## 当前状态

相关代码已回退到 `6ea4860`。本记录仅作为知识归档，提醒后续开发者不要在该问题上重复尝试上述已失败的方案。

## 验证：

```bash
bun run typecheck
bun test tests/tui-footer-resize.test.tsx tests/tui-input-maxlines.test.tsx
```

> 注：上述命令验证的是历史实现，当前代码已回退到 `6ea4860`，相关修复不再生效。
