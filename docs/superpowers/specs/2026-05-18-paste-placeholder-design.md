# TUI 大段粘贴占位符

**日期**: 2026-05-18  
**状态**: 设计中  
**参考**: Claude Code interactive mode, `docs/terminal-config.md`

## 概述

TUI 输入框（`InputLine` → `CtrlSafeTextInput`）当前使用 `ink-text-input` 单行组件，大段粘贴会导致输入框溢出终端边界且无法完整查看。参照 Claude Code 的做法，当粘贴内容超过阈值时折叠为占位符。

## 核心设计

### 阈值

**10,000 字符**。与 Claude Code 一致。

### 占位符原子块

当检测到一次性粘贴 ≥ 10,000 字符时，输入框不直接展示完整内容，而是插入一个**原子块**：

```
> [已粘贴 12,847 字符]|
```

- 占位符形似 bash 的 chip/token，不可拆分
- 内部持有完整的 `pastedContent`
- 用户可以继续在占位符前后输入文本，两者并存互不干扰

### 光标与占位符交互

| 操作 | 行为 |
|---|---|
| **输入普通字符** | 正常插入到光标位置（占位符前或后），占位符不受影响 |
| **左/右方向键** | 跳过占位符整块（类似 vim 的 `w`/`b` word 边界），不能进入占位符内部 |
| **退格 (Backspace)** | 光标在占位符右侧紧邻 → 整块删除；否则正常删除前一个字符 |
| **删除 (Delete)** | 光标在占位符左侧紧邻 → 整块删除；否则正常删除后一个字符 |
| **Enter 提交** | 完整内容 = `pastedContent + 用户其他输入`，拼接后提交 |
| **Esc (在占位模式下)** | 清空整个输入（放弃粘贴） |

### 提示信息

占位模式下，输入框下方显示提示：

```
Ctrl+E 在编辑器中查看完整内容
```

### 外置编辑器集成

`Ctrl+E` 打开 `$EDITOR` 时，编辑器内显示完整内容（包含用户追加的文本），可整体编辑。

## 实现位置

涉及的文件：

| 文件 | 改动 |
|---|---|
| `src/app/tui/components/InputLine.tsx` | 新增粘贴检测、占位模式状态、光标原子块行为 |
| `src/app/tui/components/CtrlSafeTextInput.tsx` | 可能需要支持占位符渲染或改为受控模式 |
| `src/app/tui/hooks/` | 可能需要新增 `usePastePlaceholder` hook |

## 数据流

```
用户粘贴大段内容
    │
    ▼
InputLine onChange 触发
    │
    ▼
检测 value 增长 ≥ 10,000 字符
    │ 是
    ▼
设置 pasteState = { pastedContent, placeholder: "[已粘贴 N 字符]", userText: "" }
    │
    ▼
CtrlSafeTextInput 显示 "placeholder + userText"，光标位于 userText 末尾
    │
    ├── 用户输入字符 → 追加到 userText
    ├── 用户方向键   → 跳过 placeholder block
    ├── 退格/Delete  → 碰触 placeholder 边界时整块删除
    └── Enter        → onSubmit(pastedContent + userText)
```

## pasteState 结构

```ts
interface PasteState {
  /** 原始粘贴的完整内容 */
  pastedContent: string;
  /** 显示的占位文本，如 "[已粘贴 12,847 字符]" */
  placeholder: string;
  /** 用户在占位符前后输入的内容 */
  userText: string;
  /** 占位符在 userText 中的位置，便于光标跳过 */
  placeholderPosition: number;
}
```

## 边缘情况

- **多次粘贴**: 如果已有占位符，再次大段粘贴 → 替换现有占位符（合并为新 pasteState）
- **小段粘贴（< 阈值）**: 正常追加，不触发占位模式
- **历史记录**: 历史记录中存储的是完整拼接内容（`pastedContent + userText`），不是占位符显示文本
- **Shift+Enter 多行**: 与占位模式兼容，换行符插入到 userText 中
- **斜杠命令 (@file)**: 占位模式期间 slash suggestion file search 继续正常工作，补全结果插入到 userText
