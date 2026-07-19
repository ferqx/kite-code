# OSC 4 高亮调色槽：bold 文本颜色适配

日期：2026-06-27

## 发现

终端在渲染 **bold（粗体）** 文本时，并非简单叠加 `\e[1m` 到基础颜色码上，而是使用 **高亮 ANSI 调色槽**（slot 8-15）替代基础槽（0-7）。

| `<Text>` | Ink 输出的 ANSI 码 | 终端使用的调色槽 | `osc4Apply` 是否重编程 |
|----------|-------------------|-----------------|----------------------|
| `color={t.primary}` | `\e[36m` | slot 6 (cyan) | ✅ 是 |
| `bold color={t.primary}` | `\e[1;36m` | slot 14 (bright cyan) | ❌ 否（修复前） |

基础槽 0-7 和高亮槽 8-15 是完全独立的调色板，OSC 4 需要**分别重编程**。

## 影响范围

所有使用 `bold` + 主题色（`t.primary`/`t.muted`/`t.success`/`t.error`/`t.warning`）的文本，包括：

- **Header 标题**（`<Text bold color={t.primary}>Kite Code</Text>`）
- **Markdown 标题**（`<Text bold color={t.primary}>`）
- **Markdown 粗体**（`**text**`）
- 其他 bold + 主题色的 UI 元素

切换主题预设时，这些元素在修复前颜色不变，因为 OSC 4 只重编程了基础槽 0-7。

## 修复

`src/app/tui/theme.ts` 的 `osc4Apply()` 函数，对每个基础槽（idx < 8）同时重编程其高亮对应槽（idx + 8）：

```typescript
seq += `]4;${idx};rgb:${r}/${g}/${b}`;       // 基础槽
if (idx < 8) {
  seq += `]4;${idx + 8};rgb:${r}/${g}/${b}`;  // 高亮槽
}
```

## 映射关系

| 主题角色 | 基础槽 | 高亮槽 | 用途 |
|---------|--------|--------|------|
| `primary` | 6 (cyan) | 14 (bright cyan) | 强调色，标题，代码 |
| `success` | 2 (green) | 10 (bright green) | 成功状态 |
| `error` | 1 (red) | 9 (bright red) | 错误状态 |
| `warning` | 3 (yellow) | 11 (bright yellow) | 警告状态 |
| `muted` | 7 (white) | 15 (bright white) | 正文/默认色 |
| `userMsgBg` | 8 (bright black) | — | 用户消息背景（已是高亮槽） |
| `diffAddedBg` | 4 (blue) | 12 (bright blue) | diff 新增行背景 |
| `diffRemovedBg` | 5 (magenta) | 13 (bright magenta) | diff 删除行背景 |

## 教训

OSC 4 调色板重编程必须覆盖两个调色板（0-7 和 8-15），否则 bold 文本的颜色不会跟随主题切换。这是终端 ANSI 渲染的基础行为，不依赖于 Ink/chalk 或具体终端模拟器。
