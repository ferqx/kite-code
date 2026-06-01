# 第八章 应用层：TUI 交互全景

本章逐一描述 TUI 中的每种交互方式，配以 TUI 快照，说明触发路径和键盘行为。

---

## 8.1 启动

### 触发路径

`bun run tui` → `TuiBootstrap` → 80ms 后 `initialized = true` → 主界面

### TUI 快照：启动画面

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ⚡ openpx                                             │  │
│  │  Interactive coding agent TUI                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Model     deepseek-v4     Project   my-project              │
│  Workspace /home/user/my-project                              │
│                                                              │
│    Type your task and press Enter to start                   │
│    Type /help for commands · Ctrl+C to exit                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 8.2 正常对话

### 触发路径

`Enter` → `handleInput()` → `runTask()` → `SessionRuntime.runTask()` → `runner.runAgent()` → 事件流 → reducer 更新 UI

### TUI 快照：对话中

```
┌──────────────────────────────────────────────────────────────┐
│   /\_/\    OpenPX                                            │
│  ( > w < ) /help shortcuts · Ctrl+C exit                     │
│   > w <    / commands                                         │
├──────────────────────────────────────────────────────────────┤
│  ❯ 帮我创建一个 React 组件                                    │
│                                                              │
│  ▼ Thinking                                                  │
│    好的，我来创建一个 React 组件。首先看看项目结构...          │
│                                                              │
│  ❯ 让我看看项目结构...                                        │
│                                                              │
│  ✓ read_file  src/App.tsx (45 lines, 0.3s)                   │
│                                                              │
│  ─ File Changes ─                                            │
│  + src/components/NewComponent.tsx (12 lines)                 │
│  │ 1  import React from 'react';                             │
│  │ 2                                                          │
│  │ 3  export function NewComponent() {                        │
│  │ 4    return <div>Hello</div>;                              │
│  │ 5  }                                                       │
│                                                              │
│  ~ src/App.tsx (+3 -1)                                       │
│  │  +import { NewComponent } from './components/NewComponent';│
│  │  -  return <Header />;                                     │
│  │  +  return <><Header /><NewComponent /></>;                │
│                                                              │
│  ✅ 组件已创建完成！                                          │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  ● Building                                                  │
│  > _                                                         │
│  deepseek-v4 │ max │ cache: 52% │ tokens: 2.4k │ 00:42       │
└──────────────────────────────────────────────────────────────┘
```

---

## 8.3 工具审批

### 触发路径

Agent 调用受保护工具 → `tool-policy` 评估 → `approval` 节点 → interrupt → `need_approval` 事件 → Footer 切换为 ApprovalBlock

### TUI 快照：审批等待中

```
│  ● Building                                                  │
│  ┌─ ⚠ Approval ────────────────────────────────────────────┐ │
│  │  rm -rf node_modules && npm install                      │ │
│  │  Risk: destructive · 清理并重装依赖                       │ │
│  │                                                          │ │
│  │  [A]pprove once       仅批准本次执行                     │ │
│  │  [S]ame command       放行 "npm install"                 │ │
│  │  [F]ull access        授予完整 shell 权限                │ │
│  │  [D]eny               拒绝                               │ │
│  └──────────────────────────────────────────────────────────┘ │
│  deepseek-v4 │ max │ cache: 52% │ tokens: 2.4k │ 00:15       │
```

### TUI 快照：审批已完成

审批块消失，Footer 恢复为 InputLine，输出流中保留结果：

```
│  ✓ Approved (once) — rm -rf node_modules && npm install      │
```

### 键盘行为

| 按键 | 行为 |
|------|------|
| `A` | Approve once |
| `S` | Same command |
| `F` | Full access |
| `D` | Deny |
| `E` | 进入编辑模式（修改命令后再批准） |
| `↑`/`↓` | 导航选项 |
| `Enter` | 确认当前高亮选项 |
| `Esc` | 退出编辑模式 / 取消 |

---

## 8.4 用户输入（ask_user）

### 触发路径

Agent 调用 `ask_user` → `user_input` 节点 → interrupt → `need_input` 事件 → Footer 切换为 InputBlock

### TUI 快照：选项模式

```
│  ┌─ ? Question ─────────────────────────────────────────────┐ │
│  │  你想如何处理冲突的文件？                                 │ │
│  │                                                          │ │
│  │  ❯ 保留本地版本                                          │ │
│  │    使用远程版本                                           │ │
│  │    跳过                                                   │ │
│  │                                                          │ │
│  │  [Tab] free text  [Enter] confirm                        │ │
│  └──────────────────────────────────────────────────────────┘ │
```

### TUI 快照：自由文本模式

```
│  ┌─ ? Question ─────────────────────────────────────────────┐ │
│  │  请描述你的需求：                                         │ │
│  │                                                          │ │
│  │  > _                                                     │ │
│  │                                                          │ │
│  │  [Tab] options  [Enter] submit                           │ │
│  └──────────────────────────────────────────────────────────┘ │
```

### 键盘行为

| 按键 | 行为 |
|------|------|
| `↑`/`↓` | 选项模式下导航 |
| `Enter` | 确认选择 / 提交文本 |
| `Tab` | 切换选项/自由文本模式 |
| `Esc` | 取消 |

---

## 8.5 斜杠命令

### 触发路径

输入以 `/` 开头 → `handleSlashCommand()` → `parseSlashCommand()` → dispatch 对应 Action

### TUI 快照：命令补全

```
│  > /he_                                                      │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 命令匹配 /he                                             │ │
│  │ ❯ /help (h) — Show help                                  │ │
│  │                                                          │ │
│  │ ↑↓ 导航  Tab/→ 补全  Enter 提交  Esc 关闭                │ │
│  └──────────────────────────────────────────────────────────┘ │
```

### TUI 快照：模型补全

```
│  > /model deep_                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 模型匹配 "deep"                                          │ │
│  │ ❯ /model deepseek-chat                                   │ │
│  │   /model deepseek-reasoner                               │ │
│  │                                                          │ │
│  │ ↑↓ 导航  Tab/→ 补全  Enter 提交  Esc 关闭                │ │
│  └──────────────────────────────────────────────────────────┘ │
```

### 完整命令列表

| 命令 | 别名 | 功能 |
|------|------|------|
| `/thinking` | `/t` | 切换推理显示/隐藏 |
| `/model` | — | 切换模型 / 弹出选择面板 |
| `/sessions` | — | 列出历史会话 |
| `/new` | — | 新建会话 |
| `/plan` | — | 切换为 plan 模式 |
| `/auth` | — | 切换授权模式 |
| `/setting` | `/config` | 显示设置 |
| `/clear` | `/c` | 清屏 |
| `/compact` | — | 手动压缩上下文 |
| `/help` | `/h` | 显示帮助 |
| `/mcp` | — | MCP 管理面板 |
| `/rewind` | — | 会话回溯面板 |
| `/export` | — | 导出对话为 Markdown |
| `/exit` | `/quit`, `/q` | 退出程序 |

> **注意**：外部编辑器（$EDITOR）通过 `Ctrl+E` 快捷键触发，不是斜杠命令。

---

## 8.6 模型选择

### 触发路径

`/model`（无参数）→ `SHOW_MODEL_SELECTOR` → ModelSelector overlay

### TUI 快照

```
│  ┌─ Select Model ──────────────────────────────────────────┐ │
│  │                                                          │ │
│  │  ❯ deepseek-chat         DeepSeek V4 (default)          │ │
│  │    deepseek-reasoner     DeepSeek Reasoner               │ │
│  │    gpt-4o                OpenAI GPT-4o                   │ │
│  │    claude-sonnet-4       Claude Sonnet 4                 │ │
│  │                                                          │ │
│  │  ↑↓ navigate  Enter select  Esc cancel                  │ │
│  └──────────────────────────────────────────────────────────┘ │
```

---

## 8.7 会话管理

### 触发路径

`/sessions` → `SHOW_SESSIONS` → SessionSelector overlay

### TUI 快照

```
│  ┌─ Sessions ───────────────────────────────────────────────┐│
│  │                                                          ││
│  │  ❯ my-feature-branch       2026-05-30 14:30  (active)    ││
│  │    fix-login-bug           2026-05-29 10:15               ││
│  │    refactor-auth           2026-05-28 16:42               ││
│  │                                                          ││
│  │  ↑↓ navigate  Enter switch  d delete  n new  Esc close   ││
│  └──────────────────────────────────────────────────────────┘│
```

### 键盘行为

| 按键 | 行为 |
|------|------|
| `↑`/`↓` | 导航会话列表 |
| `Enter` | 切换到选中会话 |
| `d` | 删除选中会话 |
| `n` | 新建会话 |
| `Esc` | 关闭面板 |

---

## 8.8 Rewind（会话回溯）

### 触发路径

`/rewind` 或 `Esc Esc` → `SHOW_REWIND` → CheckpointSelector overlay

### TUI 快照

```
│  ┌─ Rewind ─────────────────────────────────────────────────┐│
│  │                                                          ││
│  │  ❯ Step 3: 创建组件文件          2026-05-30 14:35        ││
│  │    Step 2: 安装依赖              2026-05-30 14:32        ││
│  │    Step 1: 分析需求              2026-05-30 14:30        ││
│  │    Initial                       2026-05-30 14:28        ││
│  │                                                          ││
│  │  ↑↓ navigate  r revert  f fork  Esc close               ││
│  └──────────────────────────────────────────────────────────┘│
```

### 键盘行为

| 按键 | 行为 |
|------|------|
| `↑`/`↓` | 导航 checkpoint 列表 |
| `r` | Revert：回到选中 checkpoint |
| `f` | Fork：从选中 checkpoint 分叉新会话 |
| `Esc` | 关闭面板 |

---

## 8.9 MCP 管理面板

### TUI 快照

```
│  ┌─ MCP Servers ────────────────────────────────────────────┐│
│  │                                                          ││
│  │  ● filesystem    stdio    tools: 3  risk: read           ││
│  │  ● github        http     tools: 8  risk: default        ││
│  │  ○ database      stdio    disconnected                   ││
│  │                                                          ││
│  │  Esc close                                               ││
│  └──────────────────────────────────────────────────────────┘│
```

---

## 8.10 帮助面板

### TUI 快照

```
│  ┌─ Keyboard Shortcuts ─────────────────────────────────────┐│
│  │                                                          ││
│  │  Ctrl+C      Cancel / Stop generation                    ││
│  │  Ctrl+C ×2   Exit                                        ││
│  │  Ctrl+T      Toggle thinking/reasoning display            ││
│  │  Ctrl+E      Expand input                                ││
│  │  ↑/↓         Navigate output history                     ││
│  │  Enter       Toggle reason block / Confirm                ││
│  │  Esc         Cancel interaction / close panel             ││
│  │                                                          ││
│  │  Commands                                                ││
│  │  /help  /model  /sessions  /new  /compact                ││
│  │  /rewind  /export  /mcp  /thinking  /auth  /clear  /exit ││
│  │                                                          ││
│  │  Esc close                                               ││
│  └──────────────────────────────────────────────────────────┘│
```

---

## 8.11 @file 文件搜索

### TUI 快照

```
│  > 帮我检查 @App_                                            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │   App.tsx          src/App.tsx                           │ │
│  │   App.test.tsx     tests/App.test.tsx                    │ │
│  │   app.config.ts    src/config/app.config.ts              │ │
│  └──────────────────────────────────────────────────────────┘ │
```

- `@` 后跟随部分文件名，实时模糊匹配
- 遵循 `.gitignore` 规则过滤
- 选中后文件路径替换 `@query` 部分

---

## 8.12 外部编辑器

### 触发路径

`Ctrl+E` → dispatch `EXPAND_INPUT` → InputLine 设置 `editorRequested` → `useExternalEditor` hook → `spawn($EDITOR, [tmpFile])` → 编辑器退出 → 读取内容 → 注入 InputLine

（外部编辑器接管终端，TUI 暂停渲染。编辑器退出后恢复。）

---

## 8.13 上下文压缩

### TUI 快照

```
│  ⠋ ● Building · ⟳ Compacting...                              │
```

自动触发：上下文 token 超限。手动触发：`/compact`。

---

## 8.14 中断与退出

### Ctrl+C 行为

| 场景 | 第 1 次 | 第 2 次 |
|------|---------|---------|
| Agent 运行中 | abort AbortController | — |
| 有 interrupt 等待 | 取消 interrupt | — |
| 空闲状态 | 设置 ctrlCPressed | 退出程序 |

---

## 8.15 全局键盘快捷键

| 快捷键 | 行为 |
|--------|------|
| `Ctrl+C` | 中断/退出 |
| `Ctrl+T` | 切换所有 thinking 块 |
| `Ctrl+E` | 展开输入框折叠内容 |
| `Esc` | 取消 interrupt / 关闭 Overlay |
| `↑`/`↓` | OutputArea 内导航 |
| `Enter` | 展开/折叠 reason block |
