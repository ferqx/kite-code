# Three-Layer Architecture Design

> Status: completed
> Created: 2026-05-11

## 1. 目标

将 openpx 重构为 Codex 风格的三层分离架构，使 Agent 核心成为纯逻辑库（零 I/O），支持 TUI、Desktop、CLI 等多前端接入。

本次迭代范围：**纯架构重构** — 建立协议层 + Runner 解耦 + 输入抽象。TUI 和 Desktop 后续接入。

## 2. 架构总览

```
┌──────────────────────────────────────────────────────┐
│  src/app/        UI 渲染层                             │
│  ├─ cli/          CLI headless (NDJSON 输出)           │
│  ├─ tui/          React Ink TUI (后续)                  │
│  └─ desktop/      Electron/Tauri (后续)                 │
├──────────────────────────────────────────────────────┤
│  src/protocol/    事件协议层                            │
│  ├─ events.ts     AgentEvent 类型定义                   │
│  ├─ actions.ts    UserAction 类型定义                   │
│  └─ provider.ts   UserInputProvider 接口                │
├──────────────────────────────────────────────────────┤
│  src/core/        Agent 核心库 (纯逻辑，零 I/O)          │
│  ├─ harness/      Agent loop + graph (原 src/harness/)  │
│  ├─ model/        LLM 适配 + context (原 src/model/)    │
│  ├─ tools/        工具实现 (原 src/tools/)              │
│  ├─ sandbox/      沙箱 (原 src/sandbox/)               │
│  ├─ config/       配置 (原 src/config/)                 │
│  ├─ persistence/  检查点 (原 src/persistence/)          │
│  └─ runner.ts     runAgent() 单一入口                    │
└──────────────────────────────────────────────────────┘
```

**约束**:
- `src/core/` 不允许 `console.log`、`process.stdin`、`process.stdout`、任何终端 I/O
- `src/protocol/` 零依赖，不引用 core 或 app
- `src/app/` 只依赖 protocol 和 core，只做渲染 + 输入采集

## 3. 协议层

### 3.1 事件类型（Core → UI）

```typescript
type AgentEvent =
  // ── 步骤边界 ──
  | { type: "step_begin" }
  | { type: "step_end" }

  // ── 模型产出 ──
  | { type: "reason"; data: { text: string } }
  | { type: "text"; data: { text: string } }

  // ── 工具调用与执行 ──
  | { type: "tool_call"; data: ToolCallPayload }
  | { type: "tool_done"; data: ToolResultPayload }

  // ── 人机交互中断 ──
  | { type: "need_approval"; data: ToolApprovalPayload }
  | { type: "need_input"; data: UserInputPayload }

  // ── 状态变更 ──
  | { type: "state_change"; data: StateChangePayload }
  | { type: "file_change"; data: { path: string; kind: "add" | "edit" | "delete" } }

  // ── 上下文管理 ──
  | { type: "compact_begin"; data: { reason: string } }
  | { type: "compact_end"; data: { summary: string } }

  // ── 观测 ──
  | { type: "cache_metrics"; data: CacheMetricsPayload }
  | { type: "retry"; data: { attempt: number; reason: string } }

  // ── 异常 ──
  | { type: "error"; data: { message: string; recoverable: boolean } }
```

事件序列示例：

```
// 简单问答
step_begin → reason → text("2+2=4") → step_end

// 连续调工具
step_begin → reason → text("让我看看") → tool_call(read_file) → tool_done → step_end
step_begin → reason → tool_call(edit_file) → tool_done → file_change → step_end
step_begin → reason → text("改好了") → step_end

// 需要审批
step_begin → reason → tool_call(shell_execute) → need_approval → [UI 等用户] → tool_done → step_end
```

### 3.2 动作类型（UI → Core）

```typescript
type UserAction =
  | { type: "approve"; grant: ShellGrantUsed }
  | { type: "reject" }
  | { type: "input"; text: string }
  | { type: "cancel" }
  | { type: "switch_auth"; mode: AuthorizationMode }
```

### 3.3 输入提供者接口

```typescript
type InterruptPayload =
  | { kind: "approval"; approval: ToolApprovalPayload }
  | { kind: "input"; question: UserInputPayload }

interface UserInputProvider {
  /** 核心推送事件给 UI */
  onEvent(event: AgentEvent): void;

  /** 请求用户动作，携带完整上下文。返回 Promise，resolve 前 runner 暂停 */
  requestAction(payload: InterruptPayload): Promise<UserAction>;

  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}
```

`requestAction` 入参携带 `InterruptPayload`，不依赖 `onEvent` 的事件顺序。UI 实现时通过 Promise 自然衔接。

### 3.4 附带类型

协议层自包含，不依赖 core。以下类型直接定义在 `src/protocol/events.ts`：

```typescript
// 工具调用
interface ToolCallPayload {
  call_id: string;
  name: "read_file" | "edit_file" | "write_file" | "shell_execute"
      | "update_plan" | "ask_user" | "set_authorization_mode";
  args: Record<string, unknown>;
}

// 工具结果
interface ToolResultPayload {
  call_id: string;
  name: string;
  ok: boolean;
  summary: string;
}

// ask_user 中断负载
interface UserInputPayload {
  question: string;
  options: { id: string; label: string; description?: string }[];
  allow_free_text: boolean;
  context?: string;
}

// 状态变更（plan / workspaceAccess / authorization）
interface StateChangePayload {
  workspaceAccess?: "read-only" | "write";
  phase?: "planning" | "building";
  plan?: AgentPlan | null;
  authorization?: { mode: "default" | "full_access" };
}

// 缓存指标
interface CacheMetricsPayload {
  workspaceAccess: string;
  cachedTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  standard: { label: string; value: number };
}

// 审批负载（字段均为简单类型，cut 掉对 PendingToolRequest 的依赖）
interface ToolApprovalPayload {
  scope: "once";
  cwd: string;
  threadId: string;
  tool: ToolCallPayload["name"];
  command: string;
  risk: "read" | "plan" | "write_file" | "execute_code" | "destructive" | "network" | "vcs_mutation" | "unknown";
  approvalHash: string;
  summary: string;
  reason: string;
  expectedEffects: string[];
  grantOptions: ("approve_once" | "same_command" | "full_access")[];
  recommendedGrant: "approve_once" | "same_command" | "full_access";
}
```

## 4. 核心层 / Runner

### 4.1 单一入口

```typescript
// src/core/runner.ts

interface RunAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride;
}

/** 运行 agent。interrupt 在内部通过 provider 闭环，调用方只做 for await */
async function* runAgent(
  provider: UserInputProvider,
  input: RunAgentInput,
): AsyncGenerator<AgentEvent>
```

### 4.2 Interrupt 闭环

```
runner 内部：

  graph.stream(state)
    │
    ├─ chunk → 映射为 AgentEvent → provider.onEvent(event) → yield event
    │
    └─ interrupt →
         event = need_approval / need_input
         provider.onEvent(event)
         yield event
         action = await provider.requestAction(payload)   // 生成器暂停
         graph.stream(Command({ resume: mapAction(action) }))
         ↓ 继续循环
```

AsyncGenerator 内部 `await` 天然暂停。调用方只做 `for await`，interrupt 时生成器阻塞，UI resolve Promise 后自动恢复。

### 4.3 事件映射：旧 → 新

| 旧 event.type | 映射为 |
|--------------|--------|
| `"interrupt"` (tool_approval) | `"need_approval"` |
| `"interrupt"` (user_input) | `"need_input"` |
| `"update"` 中的 AIMessage 文本 | `"text"` |
| `"update"` 中的 reasoning_content | `"reason"` |
| `"update"` 中的 tool_call | `"tool_call"` |
| `"update"` 中的 ToolMessage | `"tool_done"` |
| `"update"` 中的 plan/workspace 变更 | `"state_change"` |
| `"final"` | 删除（由 `step_end` + 文本内容替代） |
| `"cache_metrics"` | `"cache_metrics"`（保持不变） |
| `"model_retry"` | `"retry"` |

### 4.4 性能注意事项

- **事件映射**：从 LangGraph chunk 中直接属性访问提取 AIMessage/ToolMessage，不复用 `walkValues` 深度递归。仅对 `state_change` 做浅层遍历。
- **生成器开销**：`step_begin`/`step_end`/`reason`/`text`/`tool_call` 等高频事件每个 yield 一次。不做批量缓冲 — 延迟优先于吞吐。
- **内存**：AsyncGenerator 模式天然流式，不累积事件列表。
- **Checkpointer**：单次 `runAgent` 调用内保持 checkpointer 不关闭，interrupt → resume 复用同一实例。调用方 `for await` 结束后统一关闭。

## 5. 应用层

### 5.1 CLI headless 适配器

```typescript
// src/app/cli/index.ts
const cliProvider: UserInputProvider = {
  onEvent: (event) => console.log(JSON.stringify(event)),
  requestAction: async (payload) => {
    // stdin 读取用户动作，阻塞等待
    return readActionFromStdin(payload);
  },
};

for await (const event of runAgent(cliProvider, input)) {
  // 事件已在 onEvent 中输出，此处为空循环维持生成器
}
```

### 5.2 TUI 适配器（后续）

```typescript
// src/app/tui/index.tsx (React Ink)
function TuiProvider({ onRun }: { onRun: (provider: UserInputProvider) => void }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const actionResolvers = useRef<((action: UserAction) => void)[]>([]);

  const provider: UserInputProvider = {
    onEvent: (event) => setEvents(prev => [...prev, event]),
    requestAction: (payload) => new Promise((resolve) => {
      actionResolvers.current.push(resolve);
      // UI 渲染审批/输入界面，用户操作后 resolve
    }),
  };

  return <App events={events} pendingAction={...} />;
}
```

### 5.3 Desktop 适配器（后续）

进程内调用模型，与 TUI 共享 `UserInputProvider` 接口。未来如需跨进程（Electron main ↔ renderer），接口不变，只换 transport 实现。

## 6. 文件迁移计划

| 原路径 | 新路径 | 变更 |
|--------|--------|------|
| `src/app/runner.ts` | `src/core/runner.ts` | 重构为 `runAgent()`，集成 provider |
| `src/app/cli.ts` | `src/app/cli/index.ts` | 变为 CLI 适配器，实现 UserInputProvider |
| `src/shared/types.ts` | `src/protocol/events.ts` + `src/protocol/actions.ts` + `src/protocol/provider.ts` | 拆分为协议层 |
| `src/harness/` | `src/core/harness/` | 移动，不改内部逻辑 |
| `src/model/` | `src/core/model/` | 移动 |
| `src/tools/` | `src/core/tools/` | 移动 |
| `src/sandbox/` | `src/core/sandbox/` | 移动 |
| `src/config/` | `src/core/config/` | 移动 |
| `src/persistence/` | `src/core/persistence/` | 移动 |
| `src/shared/cache-metrics.ts` | `src/core/cache-metrics.ts` | 移入核心，core 专用 |
| `src/index.ts` | `src/index.ts` | 更新导出路径 |

`src/shared/` 目录删除。其类型按归属拆分：
- 事件/动作/提供者类型 → `src/protocol/`
- 核心内部类型（ShellResult, AgentPlan 等）→ 随模块迁入 `src/core/`
- 通用工具函数（如有）→ `src/core/utils.ts`

## 7. 不变项

- LangGraph StateGraph 结构不变（agent / approval / tools / user_input 四节点）
- 工具定义、工具策略、沙箱逻辑全部内部逻辑不变，只移动位置
- `AuthorizationOverride` 模式不变
- Checkpoint 格式不变，向后兼容

## 8. 注意事项

- `ToolApprovalPayload` 原先的 `tool` 字段依赖 `PendingToolRequest["name"]`（discriminated union）。协议层改为独立的 `ToolCallPayload["name"]` 字面量联合，切断对 `tool-requests.ts` 的依赖。
- 旧 `AgentEvent`（`src/shared/types.ts:204`）与新协议 `AgentEvent` 同名不同结构。迁移时需要全局替换引用。
