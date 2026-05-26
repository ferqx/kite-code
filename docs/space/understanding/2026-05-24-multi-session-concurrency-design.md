# 多会话并发设计

日期：2026-05-24
状态：design
参考：backlog B12 — 多会话并发

---

## 目标

支持 TUI 中多个会话同时运行（真正并行），用户在不同会话间切换，后台会话继续异步执行，事件缓冲回放。对标 Claude Code 多标签页体验。

## 非目标

- 工作区冲突检测（交由后续 `git-worktree` 技能处理）
- 会话销毁/删除（会话只区分活跃/非活跃，数据持久保留）
- 快捷键新建会话（通过 `/new` slash command 触发）

---

## 一、架构

### 1.1 方案：Session Runtime 独立实例

新增 `src/app/tui/session-manager.ts` 和 `SessionRuntime` 类。每个会话持有独立的运行时对象，实例间零共享状态。

```
src/app/tui/
├── session-manager.ts        ← 新增：SessionManager + SessionRuntime
├── index.tsx                  ← 修改：委托给 SessionManager
├── App.tsx                    ← 修改：reducer 新增 6 个 action
├── types.ts                   ← 修改：TuiState / SessionSnapshot
├── components/
│   ├── Sidebar.tsx            ← 新增：右侧边栏
│   └── InputLine.tsx          ← 修改：焦点切换时置灰
└── hooks/
    └── useGlobalKeys.ts       ← 修改：Tab 键在 sidebar/input 间轮转
```

```
SessionManager
├── runtimes: Map<threadId, SessionRuntime>
├── activeId: string
├── createSession(workspace?) → threadId
├── switchSession(fromId, toId)
├── deactivateSession(threadId)
├── getSnapshot() → SessionSnapshot[]
│
├── SessionRuntime              ← 从 index.tsx 现有逻辑抽离
│   ├── threadId, workspace
│   ├── AbortController (独立)
│   ├── agentLoopActive: bool
│   ├── generator: AsyncGenerator | null
│   ├── eventBuffer: AgentEvent[] (后台会话使用)
│   ├── pendingInterrupt: bool
│   ├── conversationHistory: string[]
│   ├── pendingSkills: string[]
│   ├── skillManifests, skillOptions, mcpManager (外部依赖，构造时注入)
│   ├── runTask(task: string)  ← 委托给 runAgent
│   ├── runRewind(type, checkpointId)
│   ├── runShell(command: string)
│   └── abort()
│
└── 工厂依赖（从 TuiBootstrap 构造时注入）
    ├── config: AgentConfig
    ├── shellExecutorFactory: () => ShellExecutor
    ├── provider: TuiUserInputProvider
    ├── skillManifests: SkillManifest[]
    ├── skillOptions: SkillScanOptions | null
    └── mcpManager: McpManager | null
```

### 1.2 实例隔离

```
runtime[threadId-A]              ← active
  ├── AbortController (独立)
  ├── generator → provider.onEvent (实时)
  ├── eventBuffer: [] (不使用)
  └── conversationHistory: [...]

runtime[threadId-B]              ← background, running
  ├── AbortController (独立)
  ├── generator → eventBuffer.push (缓冲)
  ├── eventBuffer: [text, tool_card, ...]
  └── conversationHistory: [...]

runtime[threadId-C]              ← inactive
  ├── AbortController: null
  ├── generator: null
  ├── eventBuffer: []
  └── checkpoint 持久保留在 SQLite
```

### 1.3 资源隔离

| 资源 | 隔离方式 |
|------|---------|
| AbortController | 每 SessionRuntime 独立持有 |
| Checkpoint | 独立 thread_id + 独立 BunSqliteSaver 实例 |
| MCP Manager | 通过引用共享同一个 McpManager（MCP 连接是全局的） |
| Skills | 通过引用共享 skillManifests/skillOptions |
| ShellExecutor | 通过工厂函数每次创建新实例 |

---

## 二、数据流

### 2.1 事件路径（前台 vs 后台）

```
前台会话 (active && running):
  runAgent(provider, ...) → AsyncGenerator<AgentEvent>
    → for await (event of generator)
      → provider.onEvent(event)      // 实时推入 reducer
      → 无缓冲

后台会话 (!active && running):
  runAgent(provider, ...) → AsyncGenerator<AgentEvent>
    → for await (event of generator)
      → runtime.eventBuffer.push(event)   // 写入缓冲
      → 如果 event.type === "need_approval" || "need_input":
          → runtime.pendingInterrupt = true
          → 回调 sessionManager.onInterruptPending(threadId)
            → dispatch(SESSION_INTERRUPT_PENDING) → sidebar ⚠
      → 继续等待（不推送 UI）
```

### 2.2 会话切换流程

```
用户 Tab 聚焦 sidebar → ↑↓ 选择 → Enter
  → dispatch(SWITCH_SESSION, threadId)
  → reducer:
      1. 保存当前 active 的 blocks + status 到 sessions[activeId]
      2. sessionManager.switchSession(activeId, newId)
         - runtime[activeId].generator 回调切换为 buffer 模式（如仍在运行）
         - runtime[newId].generator 回调切换为 provider.onEvent（实时）
      3. 设置 activeSessionId = newId
      4. 设置 activeSessionId = newId, blocks = target.blocks
      5. 如果目标会话 eventBuffer 非空:
         - 循环 eventBuffer，逐条调用现有 EVENT reducer 映射逻辑追加到 blocks
         - 清空 eventBuffer
      6. sessionManager 将 target runtime 的 generator 回调切为 provider.onEvent（实时）
```

### 2.3 新建会话

```
用户 /new
  → dispatch(NEW_SESSION)
  → reducer:
      1. sessionManager.createSession(process.cwd())
      2. sessions 追加新 SessionSnapshot
      3. activeSessionId = newId
      4. blocks 清空
      5. focus 回到 input
```

### 2.4 后台中断标记

```
后台会话的 agent 触发 need_approval / need_input
  → runtime.pendingInterrupt = true
  → sessionManager 回调 → dispatch(SESSION_INTERRUPT_PENDING, threadId)
  → reducer: sessions[threadId].pendingInterrupt = true
  → 侧边栏显示 ⚠
  → 用户切过去后，provider.onEvent 实时消费未处理的中断事件
```

### 2.5 事件缓冲限制

每个后台 SessionRuntime 的 eventBuffer 上限：1000 个事件。超出后丢弃最早的非关键事件（text/reason 可丢弃，保留 tool_card/approval/file_change/error）。

### 2.6 后台状态通知

```
SessionRuntime.runTask 开始:
  → runtime.agentLoopActive = true
  → sessionManager.onStatusChange(threadId)
    → dispatch(SET_SESSIONS, sessionManager.getSnapshot())
    → 侧边栏刷新: session 显示 ⏳ running

SessionRuntime.runTask 结束:
  → runtime.agentLoopActive = false
  → sessionManager.onStatusChange(threadId)
    → dispatch(SET_SESSIONS, sessionManager.getSnapshot())
    → 侧边栏刷新: session 显示 ○ idle
```

### 2.7 活跃 → 非活跃

```
用户切换离开某会话后，如果该会话 agent 已结束 (running === false):
  → sessionManager.deactivateSession(threadId)
  → runtime 释放 AbortController、generator 引用
  → Snapshot.running = false, Snapshot.active = false
  → checkpoint 数据保留
```

---

## 三、UI 布局

### 3.1 左右分栏

```
┌──────────────────────────────────────┬──────────────┐
│  OutputArea (瀑布流，现有逻辑不变)      │  Sidebar     │
│                                       │  (固定 20 列) │
│  [1] you: 帮我重构 user-service.ts     │              │
│  [2] ⚙ read_file user-service.ts       │  Sessions    │
│  [3] > 这个文件有 847 行...             │  ─────────   │
│  [4] ⚙ write_file user-service-v2.ts    │  ● 重构服务   │
│  ...                                   │    ⏳ running │
│                                       │  ○ API 联调  │
│  ───────────────────────────────────  │  ○ 写单测    │
│  StatusBar                             │    ⚠ pending │
│  ⏳ Building | Plan 2/5 | 12.3K tokens │              │
│  deepseek-v4 | thinking:max           │  Plan        │
│                                       │  ─────────   │
│  InputLine                             │  ✓ 分析接口  │
│  > _                                  │  ✓ 提取接口  │
│                                       │  ◌ 重构实现  │
│                                       │  ○ 补单测    │
│                                       │  ○ 回归验证  │
│                                       │              │
│                                       │  Tab 切换焦点 │
│                                       │  ↑↓ 浏览    │
│                                       │  Enter 切换  │
│                                       │  /new 新建   │
└──────────────────────────────────────┴──────────────┘
```

### 3.2 侧边栏分区

**区域 1：会话列表**
- 每行：`●/○ session-name 状态图标`
  - `●` = 活跃（当前显示）
  - `○` = 非活跃
  - `⏳` = 后台运行中
  - `⚠` = 后台有审批待处理
- 活跃会话高亮（反色）

**区域 2：当前 plan 进度**
- 仅显示活跃会话的 plan
- 每行：`✓/◌/○ step-name`
- 基于 `state.status.plan` 实时更新

**区域 3：底部提示**
- `Tab 聚焦  ↑↓ 浏览  Enter 切换  /new 新建`

### 3.3 焦点系统

```
focus: "input" | "sidebar"

Tab → 在 input 和 sidebar 之间轮转

focus === "sidebar":
  - 所有键盘事件（除 Tab 外）分发给 Sidebar 组件
  - ↑↓ 浏览会话列表
  - Enter 切换到高亮会话
  - / 开头的 slash command 仍然触发 slash 路由（包括 /new）
  - InputLine 置灰，显示 "Sidebar focused — Tab to input"

focus === "input":
  - 现有输入逻辑完全不变
  - 侧边栏仅展示，不响应键盘
```

---

## 四、数据结构

### 4.1 `SessionSnapshot`（持久化到 TuiState）

```typescript
interface SessionSnapshot {
  threadId: string;
  name: string;              // 会话名称（sidebar 显示）
  workspace: string;         // 工作目录
  active: boolean;           // 是否活跃
  running: boolean;          // agent 是否正在执行
  pendingInterrupt: boolean; // 后台有审批/问卷待处理（⚠）
  plan: AgentPlan | null;    // 最新 plan 快照
  status: StatusState;       // 最新 status 快照
  blocks: OutputBlock[];     // 最新 blocks 快照（切换时保存）
}
```

### 4.2 `TuiState` 扩展

```typescript
interface TuiState {
  // ── 新增 ──
  sessions: SessionSnapshot[];
  activeSessionId: string | null;
  focus: "input" | "sidebar";
  sidebarSelection: number;  // 侧边栏光标位置（下标）

  // ── 现有字段不变，但语义变为"反映 activeSessionId 的状态" ──
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
  status: StatusState;
  // ... 其他现有字段
}
```

### 4.3 `SessionRuntime`（内存，不在 TuiState 中）

```typescript
class SessionRuntime {
  readonly threadId: string;
  readonly workspace: string;

  // Agent 控制
  abortController: AbortController | null;
  agentLoopActive: boolean;
  pendingInterrupt: boolean;

  // 后台事件缓冲（仅当 !active && running 时使用）
  eventBuffer: AgentEvent[];
  static readonly MAX_BUFFER = 1000;

  // 会话上下文
  conversationHistory: string[];
  pendingSkills: string[];
  thinkingLevel: string | null;

  // 外部依赖引用（从 SessionManager 注入，共享）
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;

  // 当前正在运行的生成器
  generator: AsyncGenerator<AgentEvent> | null;

  // 方法
  runTask(task: string): Promise<void>;
  runRewind(type: "revert" | "fork", checkpointId: string): Promise<void>;
  runShell(command: string): void;
  abort(): void;
}
```

### 4.4 `SessionManager`

```typescript
class SessionManager {
  private runtimes: Map<string, SessionRuntime>;

  // 工厂依赖（构造时注入）
  private deps: {
    config: AgentConfig;
    provider: TuiUserInputProvider;
    skillManifests: SkillManifest[];
    skillOptions: SkillScanOptions | null;
    mcpManager: McpManager | null;
  };

  // 操作
  createSession(workspace: string): string;
  getRuntime(threadId: string): SessionRuntime | undefined;
  switchSession(fromId: string, toId: string): void;
  deactivateSession(threadId: string): void;
  getActiveId(): string;
  getSnapshot(): SessionSnapshot[];

  // 回调注册（SessionManager 状态变更推送到 UI）
  onInterruptPending(threadId: string): void;
  onStatusChange(threadId: string): void;           // running 启动/结束/错误
  setSnapshotCallback(fn: (threadId: string) => void): void;  // 统一回调
}
```

---

## 五、Reducer Action

### 5.1 新增 Action

```typescript
type Action =
  // ── 现有 42 种 action 保留不变 ──
  | { type: "EVENT"; event: AgentEvent }
  | { type: "USER_MESSAGE"; text: string }
  // ...

  // ── 新增 6 种 ──
  | { type: "NEW_SESSION" }
  | { type: "SWITCH_SESSION"; threadId: string }
  | { type: "SET_SESSIONS"; sessions: SessionSnapshot[] }
  | { type: "SET_FOCUS"; focus: "input" | "sidebar" }
  | { type: "SIDEBAR_NAV"; direction: "up" | "down" }
  | { type: "SESSION_INTERRUPT_PENDING"; threadId: string }
```

### 5.2 关键 Reducer 逻辑

```typescript
// NEW_SESSION
case "NEW_SESSION": {
  const newId = sessionManager.createSession(workspace);
  return {
    ...state,
    sessions: [...state.sessions, initialSnapshot(newId, workspace)],
    activeSessionId: newId,
    blocks: [],
    interrupt: null,
    focus: "input",
  };
}

// SWITCH_SESSION
case "SWITCH_SESSION": {
  // 保存当前前台 blocks 到快照
  const sessions = state.sessions.map(s =>
    s.threadId === state.activeSessionId
      ? { ...s, blocks: state.blocks, status: state.status }
      : s
  );
  // 切换 runtime 模式
  sessionManager.switchSession(state.activeSessionId, action.threadId);
  const target = sessions.find(s => s.threadId === action.threadId);
  return {
    ...state,
    sessions,
    activeSessionId: action.threadId,
    blocks: target?.blocks ?? [],
    status: target?.status ?? initialStatus(),
    interrupt: null,
    focus: "input",
  };
}

// SESSION_INTERRUPT_PENDING
case "SESSION_INTERRUPT_PENDING": {
  return {
    ...state,
    sessions: state.sessions.map(s =>
      s.threadId === action.threadId
        ? { ...s, pendingInterrupt: true }
        : s
    ),
  };
}

// SET_FOCUS
case "SET_FOCUS": {
  return { ...state, focus: action.focus };
}

// SET_SESSIONS — SessionManager 推送实时快照更新（running 状态、plan、token 等）
case "SET_SESSIONS": {
  return { ...state, sessions: action.sessions };
}

// SIDEBAR_NAV
case "SIDEBAR_NAV": {
  const len = state.sessions.length;
  if (len === 0) return state;
  const next = action.direction === "up"
    ? Math.max(0, state.sidebarSelection - 1)
    : Math.min(len - 1, state.sidebarSelection + 1);
  return { ...state, sidebarSelection: next };
}
```

---

## 六、全局键位

### 6.1 Tab 键（现有 Ctrl+T 不变）

在 `useGlobalKeys` 中，捕获 Tab 键（无 Ctrl 修饰符）：

```
Tab (无修饰符) → dispatch(SET_FOCUS, nextFocus)
  - input → sidebar
  - sidebar → input
```

现有 `Ctrl+T` 快捷键（展开思考内容）不受影响。

### 6.2 侧边栏聚焦时

```
↑/↓ → SIDEBAR_NAV
Enter → SWITCH_SESSION
/xxx → 走 slash command 路由（包括 /new）
```

---

## 七、错误处理

| 场景 | 处理 |
|------|------|
| 后台会话 context overflow | 与前台相同，走 Layer 1/2 自动压缩 |
| 后台会话模型调用失败 | 错误写入 eventBuffer，切回时显示为 error block，recoverable 标记 |
| 后台会话生成器异常 | catch 后 runtime.running = false，不传播到前台 |
| 同 workspace 多会话文件冲突 | 本次不处理，后续由 `git-worktree` 技能解决 |
| 最大会话数 | 无硬限制，受系统资源约束 |
| SQLite 连接数 | WAL 模式 + 非活跃会话释放连接，实际并发连接数 ≤ 活跃会话数 × 2 |

---

## 八、测试策略

| 层 | 验证内容 | 测试类型 |
|----|---------|---------|
| `SessionRuntime` | `runTask`/`runRewind`/`abort` 方法行为 | 单元测试 |
| `SessionManager` | 创建/切换/活跃标记/快照生成 | 单元测试 |
| Reducer | 6 个新 action 的状态变更正确性 | `tui-reducer.test.ts` |
| 侧边栏渲染 | SessionSnapshot → UI 行映射、高亮、状态图标 | `tui-layout.test.tsx` |
| 焦点系统 | Tab 轮转、↑↓ 导航、Enter 切换 | `tui-e2e-all.test.ts` |
| 后台并行 | 两个真实 agent 并行执行 + 切换回放 | 真实模型 e2e |
