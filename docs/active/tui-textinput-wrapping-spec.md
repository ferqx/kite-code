# TUI CtrlSafeTextInput 软换行与光标行为规范

状态：active

读取时机：修改 TextInput、多行输入框的软换行、光标跨行移动、粘贴、宽字符、IME 空格清理或 `maxWidth` 传播逻辑时。

验证：`bun test tests/tui-soft-wrap.test.tsx tests/tui-mixed-script-wrap.test.tsx tests/tui-cursor-nav.test.tsx tests/tui-paste-placeholder.test.tsx`。
范围：`apps/kite/src/tui/components/CtrlSafeTextInput.tsx`、`apps/kite/src/tui/components/InputLine.tsx`、相关 `tests/tui-*.test.tsx`

## 目的

`CtrlSafeTextInput` 是 Kite Code TUI 的底层输入组件，负责在终端宽度变化时稳定地折行、定位光标，并处理 CJK/ASCII 混合输入。本规范固定其行为，避免后续改动反复破坏已收敛的交互边界。

## 1. 显示宽度计算

- 使用 `string-width` 计算每个字符的显示列数。
- ASCII、数字、半角符号 = 1 列。
- CJK 统一表意文字（U+4E00–U+9FFF）、平假名、片假名、韩文音节、全角字符、CJK 标点 = 2 列。
- 其他宽字符（如 emoji）按 `string-width` 返回值处理。

## 2. 光标列预留

- 只要光标显示（`focus && showCursor && !trailingText`），软换行有效宽度为 `maxWidth - 1`。
- 目的：为行尾 inverse 空格光标预留一列，避免光标把行撑出边界，同时保证光标移动时 wrapped layout 不变。
- `trailingText`（slash ghost text）存在时不额外预留，因为光标覆盖在 ghost 首字符上。

## 3. 软换行断点优先级

当一行即将溢出有效宽度时，按以下顺序选择断点：

1. **显式 `\n`**：始终保留，不参与软换行。
2. **空格/制表符**：仅当空格两侧都是 ASCII 字母（`a-zA-Z`）时作为断点（判定需跳过连续空白）。其它情况——数字、CJK、符号——把空格视为普通字符并优先填充行宽。空格本身不保留在行尾。
   - 例：`hello world` 在空格处断开。
   - 例：`222 啊...`、`222 2是啊...` 和 `按时打算打 德拾...` 不在空格处断开，优先填充行宽。
3. **脚本边界（CJK ↔ ASCII）**：仅当剩余空间放不下下一个脚本字符时断开；否则填充。
4. **硬断**：断在最后一个能 fit 的字符处。

## 4. 光标在换行边界

- 处于两行交界处的光标偏移统一归属**下一行开头**。
- 第一行末尾按 `→` / `End`：光标跳到第二行第一个字符。
- 第二行开头按 `←` / `Home`：光标停在第二行第一个字符。

## 5. 光标移动

- `← / →`：逐字符移动。
- `↑ / ↓`：按视觉行移动，保持目标列；目标行更短时 clamp 到目标行长度。
- `Home / Ctrl+A`：当前视觉行开头。
- `End / Ctrl+E`：当前视觉行末尾（按第 4 条规则，实际渲染在下一行开头）。

## 6. IME 自动空格清理

- 单次输入事件以空格开头、后面紧跟非空格字符、且光标前一字符不是空格时，自动去掉这个前导空格。
- 覆盖 ASCII → CJK 和 CJK → ASCII 两个方向。
- 用户主动按空格再输入字符时，空格保留。

## 7. 边界兜底

- `maxWidth <= 0` 或空字符串：不做 wrap，返回原行。
- `mask`：按原值长度重复 mask 字符后参与 wrap。

## 相关测试

- `tests/tui-soft-wrap.test.tsx`
- `tests/tui-mixed-script-wrap.test.tsx`
- `tests/tui-cursor-nav.test.tsx`
- `tests/tui-cursor-line2-start.test.tsx`
- `tests/tui-extra-space.test.tsx`
- `tests/tui-user-scenario.test.tsx`
- `tests/tui-space-wrap.test.tsx`
- `tests/tui-edge-cases.test.tsx`
- `tests/tui-end-key.test.tsx`

## 验证：

```bash
bun run typecheck
bun test tests/tui-soft-wrap.test.tsx tests/tui-mixed-script-wrap.test.tsx tests/tui-cursor-nav.test.tsx tests/tui-cursor-line2-start.test.tsx tests/tui-extra-space.test.tsx tests/tui-user-scenario.test.tsx tests/tui-space-wrap.test.tsx tests/tui-edge-cases.test.tsx tests/tui-end-key.test.tsx
```
