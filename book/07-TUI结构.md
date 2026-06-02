# 第七章 应用层：TUI 结构

## 7.1 四层布局

TUI 采用四层布局，对齐 Claude Code 的终端体验：

```
┌─ Header (4行) ────────────────────────────────────────────┐
│   /\_/\    OpenPX                                          │
│  ( = = )   /help shortcuts · Ctrl+C exit                   │
│   > ~ <    / commands                                       │
├─ Body ─────────────────────────────────────────────────────┤
│  [OutputArea — 纯消息流]                                    │
│  Header + user / text / reason / tool_card / file_change / │
│  question / subagent block，按时间顺序混排                   │
├─ Footer (3行) ─────────────────────────────────────────────┤
│  ⠋ ● Building · Step 2/4: 创建组件文件                      │  ← Top 状态行
│  > _                           ← 或 Approval/Input 交互UI  │  ← 交互行（互斥）
│  model │ think │ cache │ tokens │ 00:42 │ [安全] │ rw       │  ← Bottom 状态行
├─ Overlay ──────────────────────────────────────────────────┤
│  HelpPanel / ModelSelector / SessionSelector /             │
│  McpPanel / CheckpointSelector / SlashSuggestion           │
└────────────────────────────────────────────────────────────┘
```

### 各层职责

| 层 | 组件 | 职责 |
|----|------|------|
| Header | `Header.tsx` | cat ASCII + 产品名 + 使用提示 |
| Body | `OutputArea.tsx` | 消息流渲染，Header + 全部 block 按时间顺序混排 |
| Footer | `Footer.tsx` | Top 状态行 + 交互行 + Bottom 状态行，紧跟 Body 之后 |
| Overlay | 各 Selector/Panel | 浮动面板，覆盖在 Footer 下方 |

## 7.2 组件树

```
TuiBootstrap
├── ThemeContext.Provider
└── App
    ├── Box (column)
    │   ├── Box (Body, compact)
    │   │   └── OutputArea
    │   │       ├── Header
    │   │       └── React.memo block components（user/text/reason/tool_card/file_change/approval/question/subagent）
    │   │           性能：reducer 引用稳定性 + memo 跳过未变化 block 的 re-render
    │   ├── Footer
    │   │   ├── StatusBar (Top: spinner + phase + plan)
    │   │   ├── children: InputLine | ApprovalBlock | InputBlock (互斥)
    │   │   └── StatsLine (Bottom: model/think/cache/tokens/timer/auth/rw)
    │   ├── HelpPanel (overlay)
    │   ├── SessionSelector (overlay)
    │   ├── ModelSelector (overlay)
    │   ├── McpPanel (overlay)
    │   ├── CheckpointSelector (overlay)
    │   └── SlashSuggestion (overlay)
    └── InputLine (children of App, rendered in Footer)
```

## 7.3 Reducer 架构

Reducer 从单一 `eventReducer`（47 Actions）拆分为 6 个子 reducer：

```
eventReducer (入口)
├── EVENT action → handleEventAction (23 种 AgentEvent 分发)
└── 其他 action → 按领域顺序尝试
    ├── uiReducer        (UI 状态：help/model/session/mcp 面板开关)
    ├── sessionReducer   (会话管理：new/load/switch/delete/export)
    ├── checkpointReducer (Rewind：set_checkpoints/revert/fork)
    ├── skillReducer     (Skills：activate/deactivate/set_manifests)
    └── agentReducer     (Agent 状态：running/idle/exit/compact/ctrlC)
```

### Action 总览（47 种）

| 域 | Action | 说明 |
|----|--------|------|
| 事件 | `EVENT` | AgentEvent 分发（23 种子类型） |
| UI | `SHOW_HELP`/`HIDE_HELP` | 帮助面板 |
| UI | `SHOW_MODEL_SELECTOR`/`HIDE_MODEL_SELECTOR`/`SELECT_MODEL`/`LIST_MODELS` | 模型选择 |
| UI | `SHOW_SESSIONS`/`HIDE_SESSIONS` | 会话面板 |
| UI | `SHOW_MCP`/`HIDE_MCP`/`INJECT_MCP_PROMPT` | MCP 面板 |
| UI | `SHOW_REWIND`/`HIDE_REWIND` | Rewind 面板 |
| UI | `SHOW_SETTING` | 设置面板 |
| UI | `TOGGLE_REASON`/`TOGGLE_THINKING`/`TOGGLE_ALL_REASON` | 推理显示切换 |
| UI | `EXPAND_INPUT`/`EDITOR_DONE` | 输入展开 / 编辑器完成 |
| UI | `ESCAPE`/`CTRL_C` | 全局按键 |
| UI | `CLEAR_OUTPUT` | 清屏 |
| 会话 | `USER_MESSAGE`/`NEW_SESSION`/`LOAD_SESSION`/`LOAD_SESSION_PENDING` | 会话操作 |
| 会话 | `SWITCH_SESSION`/`DELETE_SESSION`/`SET_SESSIONS`/`SESSION_INTERRUPT_PENDING` | 会话切换 |
| 会话 | `EXPORT_SESSION`/`EXPORT_SESSION_DONE` | 会话导出 |
| Checkpoint | `SET_CHECKPOINTS`/`REVERT_TO_CHECKPOINT`/`FORK_FROM_CHECKPOINT` | Rewind 操作 |
| Skill | `ACTIVATE_SKILL`/`DEACTIVATE_SKILL`/`LIST_SKILLS`/`SET_SKILL_MANIFESTS` | 技能管理 |
| Agent | `SET_RUNNING`/`SET_IDLE`/`SET_EXITED` | Agent 运行状态 |
| Agent | `COMPACT_CONTEXT`/`RESOLVE_INTERRUPT`/`SWITCH_AUTH`/`SET_PHASE` | Agent 控制 |

## 7.4 渲染管线

### React.memo Block 渲染

```
blocks 数组
  │
  └─ 全部 block 在 OutputArea 中按时间顺序渲染
      ├─ Header — 固定在最上方
      ├─ 每个 block 类型用 React.memo 包裹
      │   └─ reducer 通过 replaceBlock 保持未变化 block 引用稳定
      │       └─ memo 浅比较发现引用未变 → 跳过 re-render
      ├─ text (streaming=true) — 引用变化 → re-render，逐 token 追加
      ├─ tool_card (status=running) — 引用变化 → re-render
      ├─ subagent (status=running) — 引用变化 → re-render
      └─ approval/question — resolved 时引用变化一次
```

**性能原理**：reducer 中仅修改目标 block（`replaceBlock` 替换数组中单个元素），其余 block 保持原引用。`React.memo` 的浅比较在引用不变时跳过渲染，效果等价于 `<Static>` 的"渲染一次"行为。

> **历史**：曾使用 Ink `<Static>` 将已完成 block 移出交互渲染树（2026-05-28），因造成 scrollback/viewport 分割导致内容与 Footer 之间出现大量空白，2026-06-02 改为当前方案。

### Block 类型

| kind | 渲染内容 | 位置 |
|------|----------|------|
| `user` | `❯ 用户输入内容` | OutputArea |
| `text` | Markdown 渲染，streaming 时带 `❯` 光标 | OutputArea |
| `reason` | `▶ Thinking...` 折叠 / `▼ Thinking` 展开 | OutputArea |
| `tool_card` | 工具名 + 参数预览 + 状态 + 耗时 | OutputArea |
| `file_change` | 文件变更 diff（+/-/~） | OutputArea |
| `approval` | 审批结果记录（✓/×/⊘） | OutputArea |
| `question` | 问题 + 回答记录 | OutputArea |
| `subagent` | 子 Agent 运行/完成/错误 | OutputArea |

## 7.5 Hook 体系

| Hook | 职责 |
|------|------|
| `useTuiState` | 初始化 reducer，返回 state/dispatch |
| `useGlobalKeys` | 全局按键：Ctrl+C/T/E、Escape |
| `useSlashCommand` | 斜杠命令解析与执行 |
| `useSlashSuggestions` | 斜杠命令补全建议 |
| `useFileSearch` | @file 模糊文件搜索 |
| `useMcpConnection` | MCP 连接生命周期管理 |
| `useSkillsLoader` | Skills 扫描与加载 |
| `useRewindHandler` | Rewind checkpoint 列表 + revert/fork |
| `useExternalEditor` | 外部编辑器 ($EDITOR) 集成 |
| `useOverlayHeight` | Overlay 面板高度自适应 |
| `useSessionList` | 会话列表加载 |

## 7.6 主题系统

```typescript
interface Theme {
  primary: string;    // 主色调
  success: string;    // 成功/确认
  warning: string;    // 警告/运行中
  error: string;      // 错误
  muted: string;      // 次要文本
  dim: string;        // 更次要
}
```

支持 `dark`（默认）和 `light` 两套主题，通过 `openpx.jsonc` 的 `theme` 字段切换。
