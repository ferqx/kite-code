# Ink 渲染机制导致的滚动和文本选择问题

日期：2026-06-02
状态：understanding（部分解决）
来源：用户反馈 + 源码分析
**更新 2026-06-03：恢复 `<Static>` 方案，用 `<Box height={0}>` 消除布局空白。React.memo 方案在 Windows 上因 Ink renderNodeToOutput 全树遍历导致输入卡顿，Static 将已完成消息移出 React 树是唯一有效优化。**

## 问题描述

### 问题 1：滚动条偶然置顶

当 agent 回复消息时，如果用户手动滚动到非底部位置，滚动条会偶然被拉回顶部。

### 问题 2：无法选择/复制文本

当 agent 回复消息时，用户选择的文本高亮会被清除，无法复制内容。

## 根本原因

Ink 的渲染机制（`log-update`）在每次更新时会：
1. 将光标移到之前输出的底部（`buildReturnToBottomPrefix`）
2. 清除之前的输出（`ansiEscapes.eraseLines`）
3. 写入新输出

当输出高度超过终端高度时，Ink 会调用 `ansiEscapes.clearTerminal` 清除整个终端，然后重新写入所有内容。

### 关键代码路径

```
Ink.onRender()
  → renderInteractiveFrame(output, outputHeight, staticOutput)
    → shouldClearTerminalForFrame(...)
    → if (shouldClearTerminal) {
        stdout.write(ansiEscapes.clearTerminal + fullStaticOutput + output)
      }
```

### 触发条件

`shouldClearTerminalForFrame` 返回 true 的条件：
- `wasOverflowing`: 之前的输出高度超过终端高度
- `(isOverflowing && hadPreviousFrame)`: 当前输出高度超过终端高度且之前有输出
- `isLeavingFullscreen`: 从全屏切换到非全屏
- `shouldClearOnUnmount`: 卸载时且之前是全屏

"偶然置顶"是因为输出高度在临界点附近波动，有时超过终端高度，有时不超过。

## 相关文件

- `node_modules/ink/build/ink.js` — `renderInteractiveFrame()` 和 `shouldClearTerminalForFrame()`
- `node_modules/ink/build/log-update.js` — `render()` 和 `render.clear()`
- `node_modules/ink/build/cursor-helpers.js` — `buildReturnToBottomPrefix()` 和 `eraseLines`
- `src/app/tui/index.tsx` — Ink render 配置
- `src/app/tui/OutputArea.tsx` — Static/dynamic 分割渲染（`<Static>` + `<Box height={0}>`）

## 已尝试的方案

| 方案 | 结果 | 原因 |
|------|------|------|
| `interactive: false` | 失败 | Ink 需要 raw mode 处理键盘输入 |
| `alternateScreen: true` | 拒绝 | 备用屏幕没有 scrollback，用户无法查看历史 |
| `incrementalRendering: true` | 无效 | 只减少重绘频率，不解决根本问题 |
| 限制输出高度 | 拒绝 | 截断历史内容，用户体验差 |
| 暂停渲染功能 | 拒绝 | 用户不接受 |

## 可能的解决方向

1. **Ink 层面修复**：修改 Ink 的渲染逻辑，当用户在滚动时不触发终端清除。需要 fork Ink 或等待上游修复。

2. **检测终端滚动状态**：通过 ANSI escape sequences 检测终端的滚动位置，当用户在滚动时暂停渲染。但这需要终端支持，且实现复杂。

3. **使用备用屏幕 + 自定义滚动**：启用 `alternateScreen`，实现自定义的滚动功能（比如 Page Up/Page Down 快捷键）。但这需要重新实现滚动逻辑，且失去了终端的原生滚动体验。

4. **等待 Ink v5 或替代方案**：关注 Ink 的更新或寻找替代的终端 UI 框架。

## 备注

这是 Ink 框架的根本设计限制，不是 Kite Code 的 bug。Ink 的设计目标是"全屏应用"，它假设自己完全控制终端输出。这与终端的原生滚动和选择功能冲突。

在找到更好的解决方案之前，用户需要接受这个限制：
- 查看历史内容时，等待 agent 完成回复后再滚动
- 复制文本时，等待 agent 完成回复后再选择
