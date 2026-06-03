# TUI Overhaul Design

> Status: draft
> Created: 2026-05-12
> Last code refactor: 2026-06-03

**2026-06-03 渲染管线重构（恢复 Static）**：
- 恢复 Ink `<Static>` 组件：已完成消息渲染一次写入终端 scrollback 后移出 React 树
- `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，消除布局空白
- App 布局移除底部 spacer，Footer 紧跟最后一条消息
- 原因：React.memo 方案在 Windows 上因 Ink `renderNodeToOutput` 全树遍历导致输入卡顿

**2026-05-30 架构重构同步**：
- Reducer 已从单一 `eventReducer`（42 Actions）拆分为 6 子 reducer：`handleEvent` / `ui` / `session` / `checkpoint` / `skill` / `agent`，位于 `src/app/tui/reducers/`
- `chunkToEvents` 已拆分为 7 子解析函数（`parseAIMessageEvents` / `parseToolResultEvents` / `parseStateChangeEvents` / `parseRetryEvents` / `parseCompactionEvents`），位于 `src/core/runner.ts`
- TuiBootstrap 副作用已提取为 4 个 custom hook：`useMcpConnection` / `useSkillsLoader` / `useRewindHandler` / `useExternalEditor`
- E2E 状态检测已从 `<Static>` 猫脸切换为 StatusBar spinner 字符
- 快捷键已精简：Leader Keys 移除，统一使用斜杠命令

## 1. 目标

将 TUI 从"单次运行 → 退出"的 fire-and-forget 模式重构为交互式对话循环（Interactive Chat Loop），对齐 Claude Code、Codex CLI、OpenCode 等主流 CLI Agent TUI 的用户体验。

覆盖 9 个维度：输入流、输出流、交互模式、工具可视化、审批流程、状态栏、文件变更、快捷键体系、生命周期。

## 2. 交互式对话循环

### 当前

```
启动 → process.argv 读 task → runAgent → 流式输出 → 退出
```

### 目标

```
启动 → 启动画面 → 对话循环 {
    await 用户输入
    → slash 命令: 执行并回到循环
    → 普通文本: runAgent(历史消息) → 流式输出 → 处理 interrupts → 回到循环
}
```

**关键变化**:
- TUI 不再通过 `process.argv` 获取 task，启动后显示交互式 prompt (`> _`)
- 每次用户输入触发一次 `runAgent`，完成后回到等待输入状态
- 支持 slash 命令控制会话
- `runAgent` 改为接收历史消息列表而非单次 task

## 3. 整体布局

```
┌──────────────────────────────────────────────────────┐
│                       输出区域                         │
│  (流式 markdown + 工具卡片 + 文件变更内联混排,        │
│   flexGrow 占据主空间, 包含多轮对话历史)                │
│                                                       │
│  You  帮我创建一个 React 组件                          │
│                                                       │
│  · 文本段落                                          │
│  · ▶ Thinking... (可折叠)                            │
│  · ```tsx 语法高亮代码块                              │
│  · ✓ shell_execute — npm install (2.3s)              │
│  · ─ File Changes ─                                  │
│  ·   + src/new.tsx (45 lines)                        │
│  ·   │ 1  import React from ...                      │
│  ·   │ ...                                           │
│  ·   ~ src/App.tsx (+12 -3)                          │
│  ·   │  import { ...                                 │
│  ·   │ +import { New } from ...                      │
│  ·   │ ...                                           │
│  ·                                                    │
│  · ┌─ ⚠ Approval ────────────────────────────────┐  │
│  · │ rm -rf node_modules && npm install             │  │
│  · │ [A]pprove once  [S]ame cmd "npm install"       │  │
│  · │ [F]ull access   [D]eny                        │  │
│  · └───────────────────────────────────────────────┘  │
│  ·                                                    │
│  · ┌─ ? Question ────────────────────────────────┐  │
│  · │ 你想如何处理冲突的文件？                       │  │
│  · │ ❯ 保留本地版本                                │  │
│  · │   使用远程版本                                │  │
│  · │   跳过                                        │  │
│  · └───────────────────────────────────────────────┘  │
│                                                       │
├──────────────────────────────────────────────────────┤
│  ● Building  │  Step 2/4: 创建组件文件                 │
│  > _                                                  │
│  deepseek-v4  │  max  │  Cache: 52%  │  Tokens: 2.4k  │
└──────────────────────────────────────────────────────┘
```

**布局规则**:
1. 输出区全部 block 渲染后，Footer 紧跟其后，底部 spacer 吸收剩余终端空间
2. 工具卡片、文件变更、审批/输入提示均内联在输出流中（按发生时间顺序插入）
3. 审批/输入不弹出覆盖层——作为特殊块内联在对话流中，键盘直接选择
4. StatusBar 3 行固定在底部
5. 输入行始终可见在底部倒数第 2 行，审批/输入进行中时输入行暂停

## 4. 输出流

### 三种渲染模式

| 模式 | 适用场景 | 行为 |
|------|---------|------|
| streaming | 模型正在输出 | 逐 token 追加，类型指示器闪烁 |
| buffered | 流结束后 | 完整渲染 markdown + 语法高亮 |
| inline-prompt | 审批/输入 | 输出流中内联渲染提示块，键盘选择，不阻断输出流 |

### Markdown 渲染支持

- 代码块：语言检测 + 语法高亮
- 标题、粗体、斜体、列表、引用
- 行内代码高亮
- 链接渲染

### 渲染策略（2026-06-03 更新）

- OutputArea 使用 `<Static>` / dynamic 分割渲染
- 已完成的消息通过 `<Static>` 渲染一次写入终端 scrollback，从 React 树移除
- 活跃消息（streaming/running/interrupt）保留在 dynamic 树实时更新
- `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，避免布局空白
- 内容超出终端可视区域后由终端原生 scrollback 处理滚动
- ↑ ↓ 键仅移动 focusedIndex（控制 ❯ 视觉指示器），不改变可见范围
- Enter 键用于展开/折叠 reason/tool/subagent block
- 不做视口居中计算，不做 autoScrollRef 切换

> **历史**：2026-05-16 首次移除视口剔除。2026-05-28 引入 Ink `<Static>`。2026-06-02 移除 `<Static>` 改用 React.memo（因空白区域问题）。2026-06-03 恢复 `<Static>`（因 Windows 上 React.memo 方案输入卡顿），用 `<Box height={0}>` 解决空白问题。

详见 `docs/space/execution/active/tui-no-viewport-culling.md`

### 推理折叠

参考 OpenCode 的 `/thinking` 命令，采用**全局切换**为主 + 逐条折叠为辅的模式：

- `/thinking` — 全局切换所有 reasoning block 的显示/隐藏，切换后持久生效
- 逐条 Enter 折叠作为辅助交互（保留当前机制），适用于只想查看某一条的场景
- 多轮对话中所有 reasoning block 统一受全局 toggle 影响
- 状态栏第 3 行 `max` 字段反映当前思考模式（`max` / `off`），`Ctrl+T` 或 `/thinking` 切换

## 5. 输入流

### 交互式 prompt

```
> _   (下划线闪烁)
```

### Slash 命令

输入以 `/` 开头时触发命令模式，不发送给 agent：

| 命令 | 功能 | 可选参数 |
|------|------|---------|
| `/setting` | 打开配置面板 | |
| `/model` | 切换模型 / 弹出选择面板 | `/model deepseek-v4` |
| `/model list` | 列出可用模型 | |
| `/sessions` | 列出历史会话 | |
| `/sessions <id>` | 切换到指定会话 | `/sessions run-abc123` |
| `/plan` | 切换为 plan 模式 (read-only) | |
| `/code` | 切换为 code 模式 (write) | |
| `/auth` | 切换授权模式 | `/auth full_access` |
| `/clear` | 清屏 (Ctrl+L 等效) | |
| `/thinking` | 切换 reasoning block 显示/隐藏 | |
| `/compact` | 手动压缩上下文 (同 Ctrl+X C) | |
| `/undo` | 撤销上一条消息及其文件变更 (同 Ctrl+Z) | |
| `/redo` | 重做撤销的消息 (同 Ctrl+Y) | |
| `/export` | 导出当前对话为 Markdown | |
| `/editor` | 打开外部编辑器编写输入 (同 Ctrl+E) | |
| `/help` | 显示帮助 | |
| `/exit` | 退出程序 | |

### 模型选择面板 (`/model` 无参数)

```
┌─ Select Model ───────────────────────────────────────┐
│                                                        │
│  ❯ deepseek-v4         DeepSeek V4 (default)          │
│    deepseek-v3         DeepSeek V3                     │
│    gpt-4o              OpenAI GPT-4o                   │
│    claude-sonnet-4     Anthropic Claude Sonnet 4       │
│                                                        │
│  ↑↓ navigate  Enter select  Esc cancel                │
└────────────────────────────────────────────────────────┘
```

### 补全

- Tab 补全 slash 命令名和模型名
- 可选择支持路径补全

### @file 文件引用

在输入中键入 `@` 触发模糊文件搜索（参考 OpenCode / Claude Code）：

```
> 帮我检查 @App.tsx 和 @src/
      ┌─ Fuzzy File Search ───────────────────────┐
      │   App.tsx          src/App.tsx             │
      │   App.test.tsx     tests/App.test.tsx      │
      │   app.config.ts    src/config/app.config.ts│
      └────────────────────────────────────────────┘
```

- `@` 后跟随部分文件名，实时过滤匹配结果
- `@dirname/` 列出目录下文件
- 选中后文件内容自动注入上下文

### !shell 命令执行

输入以 `!` 开头时直接执行 shell 命令，输出作为上下文注入对话：

```
> !git diff --stat
```

- 命令在 workspace 下执行
- 输出作为 tool result 注入当前对话
- 受沙箱限制（如果启用）

### 外部编辑器

`/editor` 命令或 `Ctrl+E` 打开 `$EDITOR` 环境变量指定的编辑器，用于编写长文本输入：

## 6. 审批与输入交互

参考 OpenCode / Codex CLI 的做法，审批和用户输入**不弹出覆盖式 dialog**，而是作为特殊块**内联在输出流中**。

### 审批块（内联）

当工具需要审批时，在输出流底部插入审批块：

```
  ┌─ ⚠ Approval ───────────────────────────────────────┐
  │  rm -rf node_modules && npm install                 │
  │  Risk: destructive  ·  清理并重装依赖               │
  │                                                     │
  │  [A]pprove once       仅批准本次执行                │
  │  [S]ame command       放行 "npm install"            │
  │  [F]ull access        授予完整 shell 权限           │
  │  [D]eny               拒绝                          │
  └─────────────────────────────────────────────────────┘
```

- 审批块内联在输出流中，不遮挡上下文
- 单键选择：A / S / F / D（无需 Enter 确认）
- 也支持 ↑↓ + Enter 导航选择
- **Same command 显示放行的模式**：agent 提供 `suggestedPrefixRule` 列表，审批块中预览将要放行的命令模式（如 `npm install`、`git *`）
- 审批完成后，审批块转为结果行：`✓ Approved once — rm -rf node_modules` 或 `✓ Approved same command ("npm install")` 或 `✗ Denied`
- 结果行保留在输出流中作为历史记录

### 用户输入块（内联）

当 agent 需要用户输入（ask_user 工具触发）时，在输出流底部插入输入块：

```
  ┌─ ? Question ───────────────────────────────────────┐
  │  你想如何处理冲突的文件？                           │
  │                                                     │
  │  ❯ 保留本地版本                                    │
  │    使用远程版本                                     │
  │    跳过                                             │
  │                                                     │
  │  [Tab] free text  [Enter] confirm                   │
  └─────────────────────────────────────────────────────┘
```

- 选项模式：↑↓ 导航 + Enter 选择
- 自由文本模式：Tab 切换后直接输入
- 完成后，选择的结果行保留：`? 保留本地版本`
- 如果有 `allow_free_text`，Tab 切换选项/文本，键盘提示栏显示当前模式

## 7. 状态栏 (StatusBar)

### 布局

```
● Building  │  Step 2/4: 创建组件文件
> _
deepseek-v4  │  max  │  Cache: 52%  │  Tokens: 2.4k  │  00:42
```

- 第 1 行: Phase 指示器 + Plan 进度描述
- 第 2 行: 交互式输入 (prompt line)
- 第 3 行: 模型名 + 思考模式 + 缓存 + Token + 耗时

### 改进项

1. Plan 步骤: 从 `state_change.plan` 获取实际步骤名/进度（需先修复 runner 的 plan emit）
2. 模型名: 从 agent config 读取
3. 计时器: useEffect 每秒刷新 elapsed
4. Token 总数: `inputTokens + outputTokens`
5. 授权切换: `[R]` hotkey 调用 `switch_auth` action

## 8. 文件变更

### 布局

直接在输出流中展开 diff 内容（不做折叠）：

```
─ File Changes ─
  + src/components/New.tsx (45 lines)
  │ 1  import React from 'react';
  │ 2  
  │ 3  export function NewComponent() {
  │ 4    return <div>Hello</div>;
  │ 5  }
  │ ...

  ~ src/App.tsx (+12 -3)
  │   import { Header } from './Header';
  │  +import { NewComponent } from './NewComponent';
  │  
  │   function App() {
  │  -  return <Header />;
  │  +  return <><Header /><NewComponent /></>;
  │   }
  │ ...

  - src/old.tsx (deleted, 30 lines)
  │ 1  import React from ...
  │ ...
```

### 改进项

1. 行数统计
2. 直接展开 diff 内容（不再仅显示路径）
3. 新轮对话开始时清空旧记录

## 9. 快捷键体系

### 全局快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` (第1次) | 中断当前操作 (取消工具 / 停止生成)，不退出 |
| `Ctrl+C` (第2次) | 退出程序 |
| `Ctrl+L` | 清屏 |
| `Ctrl+R` | 切换 authorization mode (read-only / full_access) |
| `Ctrl+T` | 切换 reasoning 显示/隐藏 (同 `/thinking`) |
| `Ctrl+H` / `F1` | 显示帮助面板 |
| `Up` / `Down` | 浏览输出历史 |
| `PgUp` / `PgDn` | 翻页 |
| `End` | 跳到底部，恢复自动跟随 |
| `Esc` | 取消当前审批/输入交互，或关闭帮助面板 |

### Leader 键 (Ctrl+X)

参考 OpenCode 的 `ctrl+x` leader 键体系，部分操作采用两键组合：

| 组合键 | 功能 |
|--------|------|
| `Ctrl+X C` | 压缩上下文 (`/compact`) |
| `Ctrl+X M` | 列出/切换模型 (`/model`) |
| `Ctrl+X L` | 列出/切换会话 (`/sessions`) |
| `Ctrl+X E` | 打开外部编辑器 (`/editor`) |
| `Ctrl+X N` | 新建会话 (`/clear`) |
| `Ctrl+X Q` | 退出 (`/exit`) |

### 输入模式快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 提交输入 |
| `Shift+Enter` | 换行（多行输入） |
| `Up` | 上一条历史命令 |
| `Down` | 下一条历史命令 |
| `Tab` | 路径 / 命令补全 |

### 审批 / 输入内联提示快捷键

| 快捷键 | 功能 |
|--------|------|
| `A / S / F / D / E` | 单键选择审批选项 |
| `Enter` | 确认当前高亮选项 |
| `Tab` | 输入框 / 选项之间切换焦点 |
| `Esc` | 取消 / 返回 |

### 帮助面板 (Ctrl+H / F1)

```
┌─ Keyboard Shortcuts ──────────────────────────────────┐
│                                                        │
│  Ctrl+C      Cancel / Stop generation                  │
│  Ctrl+C ×2   Exit                                      │
│  Ctrl+L      Clear output                              │
│  Ctrl+R      Toggle authorization mode                 │
│  Ctrl+T      Toggle thinking/reasoning display          │
│  Ctrl+O      Toggle output panel focus                 │
│  Ctrl+H      Show this help                           │
│  ↑/↓         Navigate output history                   │
│  PgUp/PgDn   Page scroll                               │
│  End         Jump to bottom                            │
│  Esc         Cancel interaction / close help             │
│                                                        │
│  Press any key to close                               │
└────────────────────────────────────────────────────────┘
```

## 10. 事件协议差距修复

### 当前问题

`runAgent` → `chunkToEvents` 实际 emit 的 12 种事件中，TUI reducer 静默丢弃了 `retry`；协议中另有 6 种事件 (step_begin/step_end/compact_begin/compact_end/model_retry/interrupt/update) 实际不被 emit。

### 修复计划

1. `retry`: 在 TUI reducer 中增加处理 — 输出 `⚠ Retry #3: timeout` 行
2. `step_begin/step_end`: 在 `chunkToEvents` 中按 graph node 边界 emit（每个 node chunk 开始时 emit step_begin，结束时 emit step_end）— TUI 可用其驱动 phase 指示器动画
3. `compact_begin/compact_end`: 在上下文压缩触发时 emit — TUI 显示 `⟳ Compacting context...` 提示
4. `final`: 当前 no-op，改为渲染 agent 最终回复到 output（作为 `text` 类型行）
5. `cache_metrics.token count`: 修复为 `inputTokens + (outputTokens ?? 0)` 而非仅 `inputTokens`
6. `state_change.plan`: 确保 runner 正确从 graph node 提取和 emit plan 对象

## 11. 工具可视化

### 当前

卡片独立区域，简陋 status icon + 名称 + 120 字符 summary。

### 目标

工具调用内联到输出流中：

```
⏳ read_file  src/App.tsx ...
✓  read_file  src/App.tsx (150 lines, 1.2s)
✗  shell_execute  npm test (failed, exit code 1)
```

**改进项**:
1. 工具调用内联混排在输出流中（不再独立区域）
2. 显示参数预览
3. 显示耗时
4. 错误工具显示 error summary

## 12. 生命周期

### 启动

- 显示启动 banner: 项目名、版本、当前模型、workspace 路径
- 初始化时显示加载状态

### 退出

- Agent 完成后显示退出摘要: 文件变更统计、token 使用量、耗时
- Ctrl+C 第1次中断当前操作，第2次退出
- 退出前如会话未保存提示确认（checkpoint 自动保存，提示为信息性质）

## 13. 实现优先级

| 优先级 | 范围 | 理由 |
|:---:|------|------|
| P0 | 交互式对话循环 + 输入 prompt | 核心交互模式，所有其他功能依赖此基础 |
| P0 | 事件协议 gap 修复 | 6 种事件 emit/处理链断裂，影响所有维度 |
| P1 | 输出流 markdown 渲染 | 用户体验的感知核心 |
| P1 | 自动滚动 + 键盘导航 | 可读性基础 |
| P2 | 状态栏增强 + 文件变更 diff | 信息密度 + 透明度 |
| P2 | 审批/输入内联增强 | 快捷键 + edit command |
| P2 | @file / !command / 外部编辑器 | 对标竞品的核心输入增强 |
| P3 | Slash 命令体系 (`/undo`, `/export`, `/compact` 等) | 用户体验增强 |
| P3 | 快捷键体系完善 + Leader 键 | 帮助面板、Ctrl+X 体系 |
| P3 | 生命周期 (启动/退出) | 体验 polish |
