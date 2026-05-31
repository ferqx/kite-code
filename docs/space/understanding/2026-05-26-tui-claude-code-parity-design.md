# TUI Claude Code 对标设计

> Status: done
> Created: 2026-05-26
> Updated: 2026-05-26 (实施完成)

## 1. 整体布局重构

### 目标结构

```
┌─ Header (4行) ────────────────────────────────────────────┐
│   /\_/\    OpenPX                                          │
│  ( = = )   ? shortcuts · Ctrl+C exit · / commands · ! shell│
│   > ~ <                                                    │
├─ Body (flexGrow) ──────────────────────────────────────────┤
│  [OutputArea — 纯消息流]                                    │
│  [Approval/Input 结果记录 — 仅上下文相关的记录块]             │
├─ Footer (3行) ─────────────────────────────────────────────┤
│  ⠋ ● Building · Step 2/4: 创建组件文件                      │  Top 状态行
│  > _                           ← 或 Approval/Input 交互UI  │  交互行（互斥切换）
│  model │ think │ cache │ tokens │ 00:42 │ [安全] │ rw       │  Bottom 状态行
├─ Overlay ──────────────────────────────────────────────────┤
│  [HelpPanel / ModelSelector / SessionSelector /            │
│   McpPanel / CheckpointSelector]                           │
└────────────────────────────────────────────────────────────┘
```

### 关键规则

1. **Header**: 仅 cat ASCII + 产品名 + 使用提示行。原 model/auth/workspace 信息移除。
2. **Body**: 仅上下文相关内容——消息、工具结果、文件变更、问题记录、答案记录。Approval 在 Body 完全不出现（Footer 交互后无痕，后续 tool_done 即为上下文）。Question/Answer 以 `question` + `user` 块保留在 Body。
3. **Footer**: 统一人机交互区。Top 状态行 + 交互行 + Bottom 状态行。交互行在 InputLine / ApprovalBlock / InputBlock 之间互斥切换。Step 进度与人机交互可同时出现（独立行）。
4. **Overlay**: Footer 之下独立区域，类 DOM 流式布局。HelpPanel / ModelSelector / SessionSelector / McpPanel / CheckpointSelector。

### 组件变更

| 文件 | 操作 |
|------|------|
| `Header.tsx` | 简化：cat + "OpenPX" + 使用提示行（原 Footer 内容移入） |
| `StatusBar.tsx` | 重写为 Footer Top 状态行：spinner + phase + plan 进度。移除 @deprecated |
| `ActivityBar.tsx` | **删除**，spinner 和计时器融入 Footer |
| `StatsLine.tsx` | **新建** Bottom 状态行：model \| think \| cache \| tokens \| timer \| [安全] \| rw |
| `Footer.tsx` | **新建** 统合 Footer 布局组件，包装 Top 状态行 + children(交互行) + Bottom 状态行 |
| `App.tsx` | 更新布局树，移除 ActivityBar/旧 StatusBar/旧 Footer，调整 Approval/Input 渲染位置 |
| `OutputArea.tsx` | approval 块完全移除（Body 不出现）；question 块仅渲染一行 `? text`（muted），不包含交互 UI |
| `ApprovalBlock.tsx` | 改为在 Footer 区域渲染（作为交互行切换目标） |
| `InputBlock.tsx` | 改为在 Footer 区域渲染（作为交互行切换目标），Option 模式 + 自由文本模式不变 |
| `useGlobalKeys.ts` | 仅保留 Ctrl+C、Ctrl+T；Ctrl+E 改为 dispatch `EXPAND_INPUT` |
| `useLeaderKeys.ts` | **删除**，Ctrl+X 体系移除 |
| `Footer.tsx` (旧) | **删除**，原使用提示行内容移至 Header |

### 中文转义

- `[safe]` → `[安全]`
- `[full]` → `[完全]`

---

## 2. 快捷键精简

### 保留全局快捷键（仅 3 个）

| 键 | 行为 |
|----|------|
| `Ctrl+C` | 运行中：中断；空闲时：二次按退出 |
| `Ctrl+T` | 切换所有 thinking 块展开/折叠 |
| `Ctrl+E` | 展开输入框中所有被折叠内容（paste placeholder 等） |

**Ctrl+E 实现**：`useGlobalKeys` 中 Ctrl+E 不再 dispatch `OPEN_EDITOR`，改为 dispatch 新 action `EXPAND_INPUT`。InputLine 组件响应 `EXPAND_INPUT`，将 paste placeholder 还原为完整文本并展开多行。

- `Ctrl+E` 原功能（打开 `$EDITOR` 外部编辑器）移至 `/editor` slash 命令
- `/editor` slash 命令原本已注册，保持不变

### 移除（改用 slash 命令）

| 移除 | 替代 |
|------|------|
| `Ctrl+L` | `/clear` |
| `Ctrl+N` | `/new` |
| `Ctrl+R` | `/auth` |
| `Ctrl+H` / `F1` | `/help` |
| `Ctrl+O` | `Esc` |
| `Ctrl+X` + leader keys | `/model`, `/sessions`, `/compact`, `/exit` |

### CtrlSafeTextInput 变更

从"拦截所有 Ctrl+字母"改为"仅拦截 C/T/E，其他 Ctrl+字母 no-op（不插入字符）"。

---

## 3. Lead 区域 (Footer) 详细设计

### Top 状态行

```
[⠋] ● Building · Step 2/4: 创建组件文件
```

- `⠋` braille spinner，80ms 间隔，仅 `running` 时显示
- `●` / `○` phase 图标：building=green, planning=yellow
- `Building` / `Planning` phase 名（bold primary）
- `· Step N/M: description` 仅 `status.plan != null` 时显示
- 无 plan 时显示 `currentNode`（step_begin/step_end 驱动）

### 交互行

| 状态 | 渲染 |
|------|------|
| 无 interrupt | `<InputLine />`：`> _` |
| interrupt.kind === "approval" | `<ApprovalBlock />`：A/S/F/D 选择 |
| interrupt.kind === "input" | `<InputBlock />`：选项列表或自由文本输入 |

互斥，同时只渲染一个。切换由 `TuiState.interrupt` 驱动。

### Bottom 状态行

```
deepseek-v4 │ think: max │ cache: 52% │ tokens: 2.4k │ 00:42 │ [安全] │ rw
```

- `modelName` — primary 色
- `│` — dim 分隔符
- `think: max|off` — success/muted
- `cache: NN%` — >50% green, >20% yellow, ≤20% muted
- `tokens: N.Nk` — ≥1000 时用 k 格式化
- `MM:SS` — 仅 running 时显示计时器
- `[安全]/[完全]` — green/yellow
- `rw/ro` — muted

---

## 4. 事件协议

事件 emit + reducer 处理已全部完整。唯一补全项：

- `currentNode` 在 Footer Top 状态行中渲染（无 plan 时替代 `—`）
- `compacting` 标记在 Top 状态行显示 `⟳ Compacting...`

### 事件→reducer 完整性检查（本次验证）

| 事件 | emit | reducer | 状态 |
|------|------|---------|------|
| `step_begin/end` | runner.ts:488/601 | App.tsx:220-224 | ✅ |
| `model_retry` | runner.ts:573 | App.tsx:216 | ✅ |
| `compact_begin/end` | runner.ts:589 | App.tsx:277 | ✅ |
| `final` | runner.ts:605 | App.tsx:237 | ✅ |
| `SET_EXITED` | index.tsx:459/514/520, session-manager:173/186 | App.tsx:289 | ✅ |

---

## 5. 功能补全

| # | 功能 | 改动 |
|---|------|------|
| 1 | Markdown 链接渲染 `[text](url)` | `parseInline` 新增 `\[([^\]]+)\]\(([^)]+)\)` 匹配，渲染为 `text (url)` |
| 2 | @file 搜索遵循 .gitignore | `useFileSearch.ts` 解析 `.gitignore` 规则，过滤文件列表。与硬编码 skip list 合并 |
| 3 | `/export` 命令 | `useSlashCommand.ts` 新增 `"export"` case → dispatch `EXPORT_SESSION` |

---

## 6. 自定义与配置

### 6.1 动态模型列表

从 `openpx.jsonc` 读取模型列表，替换硬编码。

配置 schema 扩展：

```jsonc
{
  "models": [
    { "provider": "deepseek", "name": "deepseek-chat", "label": "DeepSeek V4", "default": true },
    { "provider": "openai", "name": "gpt-4o", "label": "GPT-4o" }
  ]
}
```

- `label`: 显示名，缺省用 `name`
- `default: true`: 标记默认模型
- 改动文件：`config/index.ts` (schema+解析)、`App.tsx` (替换 modelListText)、`ModelSelector.tsx`

### 6.2 主题支持

新增 `lightTheme`，配置读取：

```jsonc
{ "theme": "dark" | "light" }
```

- 预定义 `darkTheme`（已有）和 `lightTheme`（新增）
- 无配置时默认 `dark`
- 启动时读取一次，不做运行时热切换

### 6.3 自定义斜杠命令（推迟到下版本）

### 6.4 快捷键自定义（推迟到下版本）

---

## 7. 实现顺序

| 顺序 | 范围 | 说明 |
|:---:|------|------|
| 1 | Footer 重构 + Header 简化 + 布局重组 | 骨架变更，所有其他改动依赖此结构 |
| 2 | 快捷键精简 + CtrlSafeTextInput 修改 | 依赖 Footer 新结构 |
| 3 | 功能补全（链接/.gitignore//export） | 独立改动 |
| 4 | 动态模型列表 + 主题支持 | config schema 变更 |

---

## 8. 实施记录

### 8.1 实际变更

| 维度 | 设计 | 实施 |
|------|------|------|
| 布局重构 | Header/Body/Footer/Overlay 四层 | ✅ 按设计实现 |
| 快捷键精简 | Ctrl+C/T/E 三个 | ✅ 已移除 Ctrl+L/N/R/H/O/X 及 Leader 键体系 |
| 功能补全 | markdown 链接、.gitignore、/export | ✅ 已实现 |
| 配置 | 动态模型列表、主题 | ✅ 已实现 |
| 自动恢复会话 | — | ❌ 预存功能，已移除（每次启动创建新会话） |

### 8.2 未在设计中的修复

| 修复 | 文件 | 原因 |
|------|------|------|
| `sanitizeToolCallPairs` | `context.ts` | checkpoint 中孤儿 tool_call/ToolMessage 导致 DeepSeek API 400 |
| `forceContextCompaction` 配对修复 | `context.ts` | 压缩消息时 AIMessage tool_calls 可能与其 ToolMessage 分离 |
| `ensureNoLeadingOrphans` | `graph.ts` | Layer 2 压缩的 slice(-8) 边界安全 |
| `messageWithSingleToolCall` fallback | `tool-requests.ts` | additional_kwargs.tool_calls 非数组时透传未过滤 |

### 8.3 新增测试

| 测试 | 文件 | 覆盖场景 |
|------|------|---------|
| `sanitizeToolCallPairs` 7 个用例 | `tests/context.test.ts` | 干净消息透传、孤儿 tool_calls 清洗、孤儿 ToolMessage 移除、混合配对、多 tool_call 单选、空数组 |
| StatusBar 单行化 + StatsLine 新增 | `tests/tui-layout.test.tsx` | 新布局适配 |
| reducer 死代码移除 | `tests/tui-reducer.test.ts` | LEADER_PENDING/LEADER_CANCEL 移除，OPEN_EDITOR→EXPAND_INPUT |
