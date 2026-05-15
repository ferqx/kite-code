# TUI Layout & Aesthetic Redesign

## 动机

通过对全部 32 个 E2E ANSI fixture 的系统审查，识别出约 30 个布局/美观问题。按影响范围分为三层改造。

## Layer 1: 全局布局

### 1.1 Header 标签列对齐

**问题：** 第 2 行标签 `deepseek-v4 · [safe]...` 比第 1 行 `OpenPX` 和第 3 行 `D:\app\...` 偏左 1 列。

**根因：** 三段 ASCII Logo 宽度不同——行1=11字符、行2=11字符、行3=11字符。但行2末尾多 1 个空格导致实际占用不同。

**修复：** 将三段 logo 统一为相同字符宽度（padding 补齐），使标签起始列一致。

**文件：** `src/app/tui/Header.tsx:45-83`

### 1.2 Footer 缺空格

**问题：** `? shortcuts` 显示为 `?shortcuts`（阅读误判）。

**修复：** `?` 后加空格 → `?  shortcuts`。

**文件：** `src/app/tui/Footer.tsx`

### 1.3 对话框边框 → 无边框 header 行

**问题：** ApprovalBlock/InputBlock/HelpPanel/ModelSelector/StartupScreen 使用 `borderStyle="round"`，但 Ink 中 bordered Box 强制填满父容器宽度（~100列），内容仅占 ~40 列，右侧大面积空白且视觉效果松散。

**修复：** 移除 `borderStyle="round"` + `paddingX`，改用单行 header（类似 `── Approval ──` 格式）。对话框内容仍然用缩进展示，但不再被一个 100 列宽的框架包裹。

**文件：** `src/app/tui/components/ApprovalBlock.tsx`、`InputBlock.tsx`、`HelpPanel.tsx`、`ModelSelector.tsx`、`StartupScreen.tsx`

---

## Layer 2: 对话框内部

### 2.1 操作提示文本与选项分离

**问题：** `│ Press key to select...` 在 ApprovalBlock 和 InputBlock 中作为普通行出现在选项列表下方，无视觉分隔。

**修复：** 在操作提示前加空行（`<Box height={1} />`），且颜色改为 `t.dim` 而非默认。

**文件：** `src/app/tui/components/ApprovalBlock.tsx`、`InputBlock.tsx`

### 2.2 Unicode 箭头 ASCII 化

**问题：** `↑↓` 在某些终端不可渲染。

**修复：** 替换为 `up/down` 文本。

**文件：** `src/app/tui/components/ApprovalBlock.tsx`、`InputBlock.tsx`、`ModelSelector.tsx`

### 2.3 提问文本去重

**问题：** 提问场景中，OutputArea 内联显示 `? question (awaiting response...)`，对话框标题又显示 `│ ? question`，文本重复。

**修复：** OutputArea 中的 question block 简化为 `? Question`（无需重复正文），依赖 InputBlock 的标题行展示完整问题。

**文件：** `src/app/tui/OutputArea.tsx:165-175`

### 2.4 自由输入框占位提示

**问题：** 纯自由文本 InputBlock（无 options）没有输入提示。

**修复：** 无 options 时显示 `> [type your answer...]` 占位文本。

**文件：** `src/app/tui/components/InputBlock.tsx`

### 2.5 审批结果标签格式统一

**问题：** `Approved once` / `Approved same command` / `Approved (full access)` 括号风格不一致。

**修复：** 统一为 `Approved (once)` / `Approved (same command)` / `Approved (full access)`。Denied 保持 `✗ Denied`。

**文件：** `src/app/tui/OutputArea.tsx:44-50`

---

## Layer 3: 输出区域

### 3.1 Reason 块去重显示

**问题：** 连续多个 reason 块显示为：
```
▶ Thinking...
▶ Thinking...
```
看起来像渲染 bug（重复输出）。

**修复：** 相邻 reason 块之间如果内容无缝衔接（无 text/tool_card 间隔），只显示第一个 `▶ Thinking...`，后续 reason 内容追加到同一 block 或直接展开。

**更简单的修复：** 不合并内容，仅在连续 reason 之间不重复显示 `▶ Thinking...` 头。连续的第 N 个 reason 只显示内容（缩进展示），不显示折叠头。

**文件：** `src/app/tui/OutputArea.tsx:87-99`

### 3.2 已回答问题加标记

**问题：** 提问被回答后，显示 `? answer` 与普通未回答的 `? question (awaiting...)` 区分度不足。

**修复：** 已回答问题前面加 `✓` 前缀（绿色），或后缀 `(answered)`。

**文件：** `src/app/tui/OutputArea.tsx:165-175`

### 3.3 Denied 符号 ASCII 化

**问题：** `✗ Denied` 的 `✗` (U+2717) 终端兼容性。

**修复：** 改用 `×` (U+00D7, 乘号) 或普通 `X`。`× Denied` 或 `✕ Denied`（U+2715 更常见）。

**文件：** `src/app/tui/OutputArea.tsx:46`

### 3.4 连续 tool_card 间距

**问题：** Multi-tool 场景中连续 tool-result 紧贴无间距。

**当前已是可用状态，不需要修改。** 只影响密集 tool call 的扫描性，不视为 defect。

---

## 影响范围

| Layer | 源文件 | E2E fixture 影响 |
|-------|--------|-----------------|
| 1 | Header.tsx, Footer.tsx | 全部 32 个 |
| 2 | ApprovalBlock.tsx, InputBlock.tsx, OutputArea.tsx, ModelSelector.tsx | ~15 个 |
| 3 | OutputArea.tsx | ~8 个 |

## 实施约束

1. 每层修改后用 `bun run test:e2e:update` 重生成 fixture，再用 `bun run test:e2e` 验证
2. 修改后 `bun test` 全部回归必须通过
3. 不改动 theme.ts 颜色定义
4. 不改动 MarkdownBlock 渲染逻辑
