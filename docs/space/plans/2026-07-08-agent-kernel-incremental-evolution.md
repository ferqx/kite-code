# Agent Runtime Kernel 重构方案

状态：**实施中（~80% 完成）**
优先级：P0
依赖：无
替代：无（全新方案）
最后更新：2026-07-09

> 原始提案：资深 Agent 架构师提供的完整重构方案，经代码库验证后整理为正式实施计划。

---

## 0. 一句话总结

**建立 Agent Runtime Kernel 作为唯一状态权威，将 LangGraph 降级为执行引擎；plan / ask_user / approval / auto-review 全部事件化，mode 策略化，UI 状态投影化。**

---

## 1. 动机：当前架构的五个根本问题

### 1.1 状态职责混杂

当前 `AgentState`（`src/core/harness/state.ts`）在单个 `Annotation.Root` 中承载 20+ 个 channel，所有 channel 使用相同的 `reducer: (_left, right) => right`（最后写入者胜出），但它们的业务生命周期截然不同：

| 类别 | Channel | 真实生命周期 |
| --- | --- | --- |
| 业务状态 | `plan`, `planReviewed`, `phase` | 跨 turn / 跨 session |
| 交互状态 | `approvedToolRequest`, `approvedToolGrant` | 单次审批周期 |
| 授权状态 | `authorization`, `interactionMode` | 跨 turn，可按需变更 |
| 工具执行 | `approvedBatch`, `pendingSubagentApproval` | 单次工具批次 |
| 持久化状态 | `messages`, `executionJournal`, `exhaustedFingerprints` | 跨 turn / 跨 session |
| 防御状态 | `autoReviewState`, `doomLoopTracker` | 跨 turn |

所有状态都通过 LangGraph checkpoint 持久化，但 checkpoint 对所有 channel 一视同仁——它不理解「plan 应该在 session 间保留但 approvedBatch 不应该」。

### 1.2 路由逻辑承担业务调度

`resolveToolRoute()`（`src/core/harness/routes.ts:17-81`）实现了 4 层优先级调度（`ask_user` → `plan_review` → `approval` → `tools`），但它嵌在 LangGraph 路由函数中，依赖扫描 `state.messages` 中的 `tool_calls` 来决策。业务调度规则和 LangGraph 路由机制耦合在一起，无法独立测试、无法独立演进。

### 1.3 UI 状态三路来源

TUI 工具状态从三个独立来源获取：

1. **LangGraph stream** → `parseToolResultEvents()` 解析 `ToolMessage`（`runner.ts:824-896`）
2. **手动 `toolResultSink` 调用** — `userInput` 节点（`graph.ts:913`）、`planReview` 节点（`graph.ts:982`）、`executeOneTool`（`graph.ts:1114`）
3. **graph state 推断** — `tool_call`/`tool_done` 事件的 TUI reducer 匹配

`toolResultSink` 的注释说明了原因：「ToolMessage 在 checkpoint 反序列化后会丢失 `_getType`，仅靠 stream 路径不够可靠。」这正是三路状态没有统一来源的症状。

### 1.4 runAgent 手动补偿 checkpoint 语义

`runAgent` 中的 `injectUserMessage` 函数（`runner.ts:329-358`）使用**白名单**方案手动控制哪些 channel 在新 turn 中更新、哪些从 checkpoint 保留。注释明确说明：

> 「仅更新'每轮配置'类 channel；plan / planReviewed / executionJournal / autoReviewState 等执行态 channel 从 checkpoint 保留，不被覆盖。」

这段代码本质上是在 LangGraph checkpoint 之上手动管理业务状态生命周期——这是架构边界错误的信号。

### 1.5 auto-mode 污染核心执行流

`approval` 节点（`graph.ts:258-890`）现在约 **630 行**，在单个函数中混合了：

- 子 agent 审批处理
- full_access 快速路径
- doom-loop 检测
- `_safety` 快速路径（safe/dangerous 覆盖）
- 断路器检查
- 正常 auto-review 路径（模型调用 + 超时 + JSON 解析）
- fail-open / fail-closed 处理
- 断路器跳闸处理
- 人工 interrupt 回退
- replacement 命令验证
- permit issue + full_access 批量传播
- 授权状态更新

这让 auto-mode 不再是独立策略，而是污染了核心审批节点。加 future `loop-mode` 会继续恶化这一问题。

---

## 2. 目标架构

### 2.1 分层模型

```
App Layer
  CLI / TUI / API
     │
Runtime Layer              ← 新建
  AgentRuntime
  AgentKernel
  EventStore
  StateReducer
  EffectScheduler
     │
Policy Layer               ← 新建
  PlanPolicy
  ApprovalPolicy
  AuthorizationPolicy
  AutoReviewPolicy
  LoopPolicy
  ModePolicy
     │
Controller Layer           ← 新建（从现有逻辑抽取）
  ModelController
  ToolController
  ApprovalController
  UserInputController
  PlanReviewController
  AutoReviewController
  TranscriptController
     │
Engine Layer               ← LangGraph 适配器化
  AgentLoopEngine (interface)
  LangGraphEngine (adapter)
     │
Capability Layer            ← 现有，逐步重整
  Built-in tools / MCP / Skills / Subagents
  Web fetch / Shell executor / Sandbox / Model providers
```

### 2.2 核心关系

```
AgentRuntime
  → AgentKernel 决定下一步
  → Controller 执行 effect
  → 产生 RuntimeEvent
  → Reducer 更新 RuntimeState
  → EventStore 持久化
  → UI Projection 更新 TUI
```

**硬规则**：没有事件就没有状态变化；没有 reducer 就不能直接改状态；没有 correlationId 就不能恢复 UI 状态。

---

## 3. 核心设计

### 3.1 RuntimeState

用判别联合类型替代分散的 channel + boolean 组合：

```ts
// src/core/runtime/state.ts

interface RuntimeState {
  session: SessionState;
  turn: TurnState;
  transcript: TranscriptState;
  plan: PlanLifecycleState;
  tools: ToolRuntimeState;
  interactions: InteractionState;
  approvals: ApprovalRuntimeState;
  authorization: AuthorizationState;
  mode: ModeState;
  phase: RuntimePhase;
  autoReview: AutoReviewRuntimeState;
  loop?: LoopRuntimeState;
}
```

#### PlanLifecycleState（替代 `plan: AgentPlan | null` + `planReviewed: boolean`）

```ts
type PlanLifecycleState =
  | { kind: 'none' }
  | {
      kind: 'drafted';
      planId: string;
      version: number;
      draft: AgentPlan;
      structuralHash: string;
    }
  | {
      kind: 'awaiting_review';
      planId: string;
      version: number;
      draft: AgentPlan;
      structuralHash: string;
      interactionId: string;
      toolCallId: string;
    }
  | {
      kind: 'approved';
      planId: string;
      version: number;
      plan: AgentPlan;
      structuralHash: string;
      approvedAtTurnId: string;
      executionMode: 'manual' | 'auto';
    }
  | {
      kind: 'building';
      planId: string;
      version: number;
      plan: AgentPlan;
      structuralHash: string;
    }
  | {
      kind: 'needs_revision';
      planId: string;
      version: number;
      draft: AgentPlan;
      reason: string;
    }
  | {
      kind: 'completed';
      planId: string;
      version: number;
      plan: AgentPlan;
      completedAtTurnId: string;
    };
```

关键行为：

- **structural plan change**（名称/步骤数变化）→ 生成新 `version`，进入 `awaiting_review`
- **progress-only update**（仅 status 变化）→ 保持 `building`，不触发 review
- **re-entrant tracking update**（同名称同步数、文本微调）→ 不触发 review（`isSamePlanTrackingUpdate` 的逻辑保留但移入 PlanController）
- **completed plan + new plan** → 视为新计划，必须走 review

#### InteractionState

三种 interrupt 统一为判别联合类型，每种有独立生命周期：

```ts
type InteractionState =
  | { kind: 'idle' }
  | {
      kind: 'awaiting_user_input';
      interactionId: string;
      toolCallId: string;
      request: UserInputPayload;
    }
  | {
      kind: 'awaiting_plan_review';
      interactionId: string;
      toolCallId: string;
      plan: AgentPlan;
      planSummary: string;
    }
  | {
      kind: 'awaiting_tool_approval';
      interactionId: string;
      toolCallId: string;
      approval: ToolApprovalPayload;
    };
```

原则：`ask_user` 不是 approval，`plan_review` 不是 approval，`tool_approval` 不是 ask_user。三者走统一的 interaction infrastructure，但生命周期分开。

#### ToolRuntimeState

每个 tool call 有稳定生命周期：

```ts
type ToolCallStatus =
  | 'queued'
  | 'awaiting_user_input'
  | 'awaiting_plan_review'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'exhausted';

interface ToolRuntimeState {
  calls: Record<string, ToolCallRecord>;
  queue: string[];
  active: string[];
}

interface ToolCallRecord {
  toolCallId: string;
  modelMessageId: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  createdAtTurnId: string;
  approvalHash?: string;
  result?: ToolResult;
  error?: string;
}
```

#### TranscriptState

模型消息和工具消息从 LangChain `BaseMessage[]` 中解耦：

```ts
interface TranscriptState {
  modelMessages: ModelMessage[];
  pendingToolMessages: ToolMessage[];
  compactedSummary?: string;
}
```

`prepareModelContext` 继续存在，但输入来自 `TranscriptState` 而非直接读 `state.messages`。

### 3.2 RuntimeEvent：唯一事实来源

所有状态变化必须事件化。核心事件集：

```ts
// src/core/runtime/events.ts

type RuntimeEvent =
  // Turn lifecycle
  | { type: 'turn.started'; turnId: string }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.aborted'; turnId: string; reason: string }

  // User input
  | { type: 'user.message_appended'; messageId: string; content: string }

  // Model interaction
  | { type: 'model.requested'; requestId: string }
  | { type: 'model.responded'; messageId: string; toolCalls: ToolCall[]; text?: string }

  // Tool lifecycle
  | { type: 'tool.queued'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool.started'; toolCallId: string }
  | { type: 'tool.progress'; toolCallId: string; chunk: string }
  | { type: 'tool.finished'; toolCallId: string; result: ToolResult }
  | { type: 'tool.failed'; toolCallId: string; error: string }
  | { type: 'tool.rejected'; toolCallId: string; reason: string }

  // Plan lifecycle
  | { type: 'plan.drafted'; toolCallId: string; plan: AgentPlan; structuralHash: string }
  | { type: 'plan.review_requested'; interactionId: string; toolCallId: string; plan: AgentPlan }
  | { type: 'plan.approved'; interactionId: string; executionMode: 'manual' | 'auto' }
  | { type: 'plan.revision_requested'; interactionId: string; feedback: string }
  | { type: 'plan.rejected'; interactionId: string; reason: string }
  | { type: 'plan.progress_updated'; toolCallId: string; plan: AgentPlan }
  | { type: 'plan.completed'; toolCallId: string; plan: AgentPlan }

  // Interactions
  | { type: 'user_input.requested'; interactionId: string; toolCallId: string; request: UserInputPayload }
  | { type: 'user_input.answered'; interactionId: string; answer: UserInputAnswer }

  // Approval
  | { type: 'approval.requested'; interactionId: string; toolCallId: string; approval: ToolApprovalPayload }
  | { type: 'approval.granted'; interactionId: string; grant: ApprovalGrant }
  | { type: 'approval.rejected'; interactionId: string; reason: string }
  | { type: 'approval.command_replaced'; interactionId: string; command: string }

  // Auto-review
  | { type: 'auto_review.requested'; reviewId: string; toolCallId: string }
  | { type: 'auto_review.completed'; reviewId: string; result: AutoReviewResult }

  // State changes
  | { type: 'authorization.changed'; mode: AuthorizationMode }
  | { type: 'phase.changed'; phase: 'planning' | 'building' };
```

### 3.3 Reducer：唯一状态修改入口

```ts
// src/core/runtime/reducer.ts

function reduceRuntimeState(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  switch (event.type) {
    case 'plan.review_requested':
      return {
        ...state,
        plan: {
          kind: 'awaiting_review',
          planId: getPlanId(event.plan),
          version: nextPlanVersion(state),
          draft: event.plan,
          structuralHash: computePlanStructuralHash(event.plan),
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
        },
        interactions: {
          kind: 'awaiting_plan_review',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          plan: event.plan,
          planSummary: formatPlanSummary(event.plan),
        },
      };

    case 'plan.approved':
      return approvePlan(state, event);

    case 'user_input.answered':
      return applyUserInputAnswer(state, event);

    case 'tool.finished':
      return finishToolCall(state, event);

    // ... 所有事件都有对应的 reducer case
  }
}
```

所有 bug 都可以通过 `initial state + events → expected state` 复现。

### 3.4 EffectScheduler：从 route 到纯函数

将 `resolveToolRoute()` 从 LangGraph route 提取为纯函数：

```ts
// src/core/runtime/scheduler.ts

type RuntimeEffect =
  | { type: 'call_model' }
  | { type: 'run_tools'; toolCallIds: string[] }
  | { type: 'request_user_input'; interactionId: string }
  | { type: 'request_plan_review'; interactionId: string }
  | { type: 'request_tool_approval'; interactionId: string }
  | { type: 'run_auto_review'; reviewId: string }
  | { type: 'emit_final' }
  | { type: 'stop' };

function decideNextEffect(state: RuntimeState): RuntimeEffect {
  // 保持当前优先级：
  // ask_user → plan_review → approval → tools → model → final/stop
  if (state.interactions.kind === 'awaiting_user_input') {
    return { type: 'request_user_input', interactionId: state.interactions.interactionId };
  }
  if (state.interactions.kind === 'awaiting_plan_review') {
    return { type: 'request_plan_review', interactionId: state.interactions.interactionId };
  }
  if (state.interactions.kind === 'awaiting_tool_approval') {
    return { type: 'request_tool_approval', interactionId: state.interactions.interactionId };
  }
  // … policy evaluation, runnable tools, model call, stop
}
```

### 3.5 RuntimePolicy：Mode 统一抽象

`plan-mode`、`auto-mode`、未来的 `loop-mode` 都实现同一接口：

```ts
// src/core/policies/runtime-policy.ts

interface RuntimePolicy {
  name: string;

  shouldRequirePlan(input: PolicyInput): PolicyDecision;
  shouldReviewPlan(input: PolicyInput): PolicyDecision;
  shouldAskUser(input: PolicyInput): PolicyDecision;
  shouldApproveTool(input: PolicyInput): PolicyDecision;
  shouldAutoReview(input: PolicyInput): PolicyDecision;
  shouldContinueLoop(input: PolicyInput): PolicyDecision;
}

type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'need_user_input'; request: UserInputPayload }
  | { kind: 'need_plan_review'; plan: AgentPlan }
  | { kind: 'need_tool_approval'; approval: ToolApprovalPayload }
  | { kind: 'need_auto_review'; reviewRequest: AutoReviewRequest }
  | { kind: 'continue_loop' }
  | { kind: 'stop' };
```

- **ask mode**: plan 需人工 review，protected tool 需人工 approval，ask_user 正常打断
- **auto mode**: plan 可选 auto execution，protected tool 先走 auto-review，不能绕过 destructive deny，authorization 不自动变 full_access
- **full mode**: 必须 sandbox 可用，不允许 ask_user，不允许 destructive shell，失败事件化返回
- **loop mode**（未来）: 仅增加 `shouldContinueLoop`，不绕过其他 policy

### 3.6 Controller 职责划分

| Controller | 职责 | 对应现有代码 |
|-----------|------|------------|
| `ModelController` | 调用模型，产生 `model.requested` / `model.responded` | `graph.ts` agent 节点 |
| `ToolController` | 找 runnable tool → preflight guard → 执行 → `tool.*` 事件 | `tool-runner.ts` `runApprovedTool` |
| `ApprovalController` | 创建 approval request → 等 user/auto-review → issue permit → `approval.*` 事件 | `graph.ts` approval 节点后段 + `tool-policy.ts` `buildToolApproval` |
| `UserInputController` | ask_user → `user_input.requested` → 等 answer → `user_input.answered` + `tool.finished` | `graph.ts` userInput 节点 |
| `PlanReviewController` | update_plan → 判断 structural/progress → `plan.*` 事件 → 等 review → `plan.approved/revision_requested` | `graph.ts` planReview 节点 + `routes.ts` `isPlanProgressOnlyUpdate` |
| `AutoReviewController` | 接收 `auto_review.requested` → 调 reviewer 模型 → 产生 `auto_review.completed` → 不直接改任何状态 | `execution/reviewer.ts` + `graph.ts` approval 节点 auto-review 分支 |
| `TranscriptController` | 管理 `TranscriptState`，将 tool 结果转 `ToolMessage`，生成模型上下文 | `model/context.ts` |

### 3.7 UI Projection：TUI 不再解析 LangGraph 状态

```ts
// src/core/runtime/projection.ts

function projectRuntimeEventToAgentEvent(event: RuntimeEvent): AgentEvent[] {
  switch (event.type) {
    case 'tool.queued':
      return [{ type: 'tool_call', data: { call_id: event.toolCallId, name: event.name, args: event.args } }];
    case 'tool.progress':
      return [{ type: 'tool_progress', data: { call_id: event.toolCallId, name: '', chunk: event.chunk, stream: 'stdout' } }];
    case 'tool.finished':
      return [{ type: 'tool_done', data: { call_id: event.toolCallId, name: '', ok: event.result.ok, summary: '' } }];
    case 'user_input.requested':
      return [{ type: 'need_input', data: event.request }];
    case 'plan.review_requested':
      return [{ type: 'need_plan_review', data: { plan: event.plan } }];
    case 'approval.requested':
      return [{ type: 'need_approval', data: event.approval }];
    default:
      return [];
  }
}
```

目标：**ask_user 确认后，由 `user_input.answered → tool.finished → tool_done` 投影链路完成，不再需要 graph 节点里手动补 `toolResultSink`。**

### 3.8 Persistence：事件日志 + 快照

```ts
// src/core/runtime/store.ts

interface RuntimeStore {
  appendEvents(threadId: string, events: RuntimeEvent[]): Promise<void>;
  loadEvents(threadId: string): Promise<RuntimeEvent[]>;
  saveSnapshot(threadId: string, state: RuntimeState): Promise<void>;
  loadSnapshot(threadId: string): Promise<RuntimeState | null>;
}
```

- 短期复用 SQLite（现有 `BunSqliteSaver`），但存储的是 `RuntimeEvent[]` 而非 LangGraph checkpoint
- LangGraph checkpoint 降级为 LangGraphEngine 内部执行缓存，不再是业务状态权威

---

## 4. 推荐目录结构

```
src/core/runtime/           ← 新建：Runtime Kernel
  kernel.ts                 — AgentKernel 主循环
  state.ts                  — RuntimeState 类型定义
  events.ts                 — RuntimeEvent 类型定义
  reducer.ts                — reduceRuntimeState 纯函数
  effects.ts                — RuntimeEffect 类型定义
  scheduler.ts              — decideNextEffect 纯函数
  store.ts                  — RuntimeStore 持久化接口 + SQLite 实现
  projection.ts             — RuntimeEvent → AgentEvent 投影
  ids.ts                    — interactionId / planId / turnId 生成
  hashes.ts                 — plan structuralHash / approvalHash

src/core/controllers/       ← 新建：从现有 graph.ts 逻辑抽取
  model-controller.ts       — 对应 graph.ts agent 节点
  tool-controller.ts        — 对应 tool-runner.ts（重构为事件驱动）
  approval-controller.ts    — 对应 graph.ts approval 节点后段
  user-input-controller.ts  — 对应 graph.ts userInput 节点
  plan-review-controller.ts — 对应 graph.ts planReview 节点 + routes.ts 结构判断
  auto-review-controller.ts — 对应 execution/reviewer.ts（事件化包装）
  transcript-controller.ts  — 对应 model/context.ts（重构输入源）

src/core/policies/          ← 新建：Mode → Policy 抽象
  runtime-policy.ts         — RuntimePolicy 接口 + PolicyDecision 类型
  mode-policy.ts            — ask / auto / full policy 实现
  plan-policy.ts            — plan 生命周期策略
  approval-policy.ts        — 审批策略（含 tool-policy.ts 的 allow/ask/deny 逻辑）
  authorization-policy.ts   — 授权策略（full_access / same_command / destructive deny）
  auto-review-policy.ts     — auto-review 决策策略
  loop-policy.ts            — 未来 loop-mode 策略（桩实现）

src/core/engines/           ← LangGraph 适配器化
  engine.ts                 — AgentLoopEngine 接口
  langgraph-engine.ts       — 现有 graph.stream 包装为 EngineEvent 流

src/core/harness/           ← 逐步退役
  graph.ts                  — → langgraph-engine.ts
  routes.ts                 — → scheduler.ts + controllers
  state.ts                  — → runtime/state.ts
  tool-policy.ts            — → policies/approval-policy.ts（allow/ask/deny 保留，移出 LangGraph 依赖）
  tool-runner.ts            — → controllers/tool-controller.ts
  user-input.ts             — → controllers/user-input-controller.ts

src/core/execution/         ← 保留核心算法，包装为 controller
  reviewer.ts               — → controllers/auto-review-controller.ts（事件化包装）
  circuit-breaker.ts        — 保留，被 auto-review-controller 调用
  doom-loop.ts              — 保留，被 approval-controller 调用
  journal.ts                — 保留，被 tool-controller 调用
  permit.ts                 — 保留，被 approval-controller 调用
```

---

## 5. 实施阶段

### Phase 1：RuntimeEvent + UI Projection（目标：消灭 toolResultSink）

**目标**：先修复 TUI/tool 状态多来源问题——这是用户最直接感知的 bug（ask_user 确认后工具状态卡 pending、plan_review 后工具状态不一致）。

**具体改动**：

1. **新建 `src/core/runtime/events.ts`** — RuntimeEvent 类型定义（只包含 Phase 1 需要的 tool 和 interaction 事件）
2. **新建 `src/core/runtime/projection.ts`** — `projectRuntimeEventToAgentEvent()` 函数
3. **新建 `src/core/runtime/ids.ts`** — `genInteractionId()` / `genTurnId()`
4. **改造 `graph.ts`**：
   - `userInput` 节点：删除 `input.toolResultSink?.()` 调用，改为通过事件管道发出 `user_input.answered` + `tool.finished`
   - `planReview` 节点：删除 `input.toolResultSink?.()` 调用，改为通过事件管道发出 `plan.approved` + `tool.finished`
   - `executeOneTool`：保留 `toolResultSink` 但将其改为发出 `tool.finished` 事件
5. **改造 `runner.ts`**：
   - `processStream` 中增加 RuntimeEvent 收集
   - 所有 `AgentEvent` 输出前先经过 projection
6. **保留所有现有测试通过**——Phase 1 只改变事件来源，不改变行为语义

**涉及文件**：
- 新建：`src/core/runtime/events.ts`、`src/core/runtime/projection.ts`、`src/core/runtime/ids.ts`
- 修改：`src/core/harness/graph.ts`、`src/core/runner.ts`

**验证方法**：
- `bun test tests/graph.test.ts` — 图路由行为不变
- `bun test tests/runner.test.ts` — 事件流行为不变
- `bun test tests/integration.test.ts` — 全图集成不变
- `bun test tests/tui-reducer.test.ts` — TUI 状态机不变
- `bun test tests/tui-system/scenarios/ask-user.test.ts` — ask_user 工具状态不卡 pending
- `bun test tests/tui-system/scenarios/plan-review.test.ts` — plan_review 工具状态不卡 pending
- `bun run test:e2e` — 全链路 PTY 验证

---

### Phase 2：RuntimeState + Reducer（目标：状态单一权威）

**目标**：引入 RuntimeState 作为唯一状态容器，用 reducer 管理所有状态转换。

**具体改动**：

1. **新建 `src/core/runtime/state.ts`** — RuntimeState 完整类型定义
2. **新建 `src/core/runtime/reducer.ts`** — `reduceRuntimeState()` 纯函数，覆盖所有 Phase 1 事件
3. **新建 `src/core/runtime/store.ts`** — `RuntimeStore` 接口 + SQLite 实现
4. **改造 `AgentState` 为 bridge**：`graph.ts` 中的 `AgentState` channel 改为从 RuntimeState 投影生成，graph node return 改为写回 RuntimeState
5. **改造 `runner.ts`**：
   - `runAgent` 启动时创建 RuntimeState（从 store 加载或新建）
   - 每次 graph chunk 处理后更新 RuntimeState
   - interrupt 处理走 RuntimeState 的 interaction 状态
6. **事件日志写入**：每个 RuntimeEvent 同时写入 store 的事件日志

**涉及文件**：
- 新建：`src/core/runtime/state.ts`、`src/core/runtime/reducer.ts`、`src/core/runtime/store.ts`
- 修改：`src/core/harness/state.ts`、`src/core/runner.ts`、`src/core/persistence/checkpoint.ts`

**验证方法**：
- `bun test tests/runtime/reducer.test.ts`（新建）— 所有状态转换的单测
- `bun test tests/runtime/store.test.ts`（新建）— 持久化 + 恢复
- `bun test tests/graph.test.ts tests/integration.test.ts` — 行为回归

---

### Phase 3：Controller 抽取（目标：graph 节点瘦身为 controller 调用）

**目标**：将 graph.ts 中的 5 个节点函数抽取为独立 Controller。

**具体改动**：

1. **新建 `src/core/controllers/`**：
   - `plan-review-controller.ts` — 从 `graph.ts` planReview 节点 + `routes.ts` `isPlanProgressOnlyUpdate` / `isSamePlanTrackingUpdate` 抽取
   - `user-input-controller.ts` — 从 `graph.ts` userInput 节点 + `harness/user-input.ts` 抽取
   - `approval-controller.ts` — 从 `graph.ts` approval 节点后段（interrupt → permit issue）抽取
   - `tool-controller.ts` — 从 `tool-runner.ts` 抽取，增加 preflight guard 作为独立步骤
   - `model-controller.ts` — 从 `graph.ts` agent 节点抽取
2. **新建 `src/core/controllers/auto-review-controller.ts`**：
   - 包装 `execution/reviewer.ts`
   - 只产生 `auto_review.requested` / `auto_review.completed` / `approval.granted` / `approval.rejected` 事件
   - 不直接修改 plan / ToolMessage / graph route / TUI 状态 / authorization
3. **`graph.ts` 节点函数瘦身**：每个节点变成「调 controller → 收集事件 → 更新 RuntimeState → 返回 graph state」的薄层

**涉及文件**：
- 新建：`src/core/controllers/*.ts`（7 个文件）
- 修改：`src/core/harness/graph.ts`（节点函数精简）、`src/core/harness/tool-runner.ts`（逻辑迁移到 tool-controller）

**验证方法**：
- `bun test tests/graph.test.ts tests/integration.test.ts tests/runner.test.ts` — 全量回归
- `bun test tests/tools.test.ts tests/tool-policy.test.ts` — 工具执行 + 策略不变
- `bun run test:e2e` — PTY 全链路验证

---

### Phase 4：PolicyEngine + Mode 策略化（目标：auto-mode 不再污染审批主流程）

**目标**：引入 RuntimePolicy 接口，让 mode 通过策略影响决策，而非在 graph 节点中写 if-else。

**具体改动**：

1. **新建 `src/core/policies/`**：
   - `runtime-policy.ts` — `RuntimePolicy` 接口 + `PolicyInput` / `PolicyDecision` 类型
   - `mode-policy.ts` — 三个 mode 的策略实现
   - `approval-policy.ts` — 审批策略（从 `tool-policy.ts` 迁入 allow/ask/deny 逻辑，去除 LangGraph 依赖）
   - `authorization-policy.ts` — 授权策略
   - `auto-review-policy.ts` — auto-review 决策策略
   - `plan-policy.ts` — plan 生命周期策略
2. **改造 `EffectScheduler`**：`decideNextEffect` 调用 `PolicyEngine.evaluate(state)` 获取决策
3. **改造 `approval-controller.ts`**：auto-review 路径改为「调 auto-review-controller → 根据结果调 approval-controller」，不再在 approval 节点内部展开
4. **改造 `graph.ts` approval 节点**：auto-mode 分支（doom-loop / _safety / circuit-breaker / fail-open-closed）全部移入 auto-review-controller

**涉及文件**：
- 新建：`src/core/policies/*.ts`（6 个文件）
- 修改：`src/core/runtime/scheduler.ts`、`src/core/controllers/approval-controller.ts`、`src/core/controllers/auto-review-controller.ts`、`src/core/harness/graph.ts`、`src/core/harness/tool-policy.ts`

**验证方法**：
- `bun test tests/tool-policy.test.ts` — 审批策略回归
- `bun test tests/graph.test.ts` — 路由行为回归
- `bun test tests/tui-system/scenarios/approval.test.ts tests/tui-system/scenarios/tool-approve.test.ts` — 审批交互回归
- `bun test tests/tui-system/scenarios/plan-mode-policy.test.ts` — plan mode 策略回归
- 新建：`tests/policies/approval-policy.test.ts` — 策略纯函数单测
- 新建：`tests/policies/auto-review-policy.test.ts` — auto-review 决策单测

---

### Phase 5：LangGraph 适配器化 + Engine 接口（目标：核心状态不再依赖 LangGraph checkpoint）

**目标**：LangGraph 变成 `AgentLoopEngine` 的一个实现，不再拥有业务状态最终解释权。

**具体改动**：

1. **新建 `src/core/engines/engine.ts`** — `AgentLoopEngine` 接口：
   ```ts
   interface AgentLoopEngine {
     run(input: EngineRunInput): AsyncIterable<EngineEvent>;
     resume(input: EngineResumeInput): AsyncIterable<EngineEvent>;
   }
   ```
2. **新建 `src/core/engines/langgraph-engine.ts`** — 包装现有 `graph.stream`：
   - 内部继续使用 `buildCodeAgentGraph()` + `graph.stream()`
   - 输出映射为 `EngineEvent`
   - checkpoint 仅作为执行缓存
3. **改造 `runner.ts`**：
   - `runAgent` 改为启动 AgentRuntime
   - AgentRuntime 调用 `LangGraphEngine`
   - 业务状态全部从 RuntimeState 恢复，不从 checkpoint 恢复
4. **废弃 LangGraph checkpoint 作为业务状态存储**：
   - EventStore 成为唯一持久化来源
   - `injectUserMessage` 的白名单逻辑移除（RuntimeState 自身管理 per-turn vs per-session 状态）
5. **`AgentState` / `Annotation.Root` 精简**：仅保留 engine 内部需要的 channel，其余由 RuntimeState 管理

**涉及文件**：
- 新建：`src/core/engines/engine.ts`、`src/core/engines/langgraph-engine.ts`
- 修改：`src/core/runner.ts`、`src/core/harness/graph.ts`、`src/core/harness/state.ts`
- 可能删除/大幅精简：`src/core/harness/routes.ts`（逻辑已迁入 scheduler + controllers）

**验证方法**：
- `bun test tests/graph.test.ts tests/integration.test.ts tests/runner.test.ts` — 全量行为回归
- `bun test tests/checkpoint.test.ts` — checkpoint 仅作为执行缓存验证
- `bun test tests/runtime/store.test.ts` — EventStore 恢复验证
- `bun run test:e2e` — PTY 全链路验证
- **手动验证**：`bun run tui` — 多轮会话恢复、中断恢复、plan 状态保留

---

## 6. 必须建立的测试矩阵

### 6.1 Plan lifecycle tests

```
1. no plan → update_plan → awaiting_review
2. awaiting_review → approve → building
3. awaiting_review → revision feedback → needs_revision → model
4. approved plan → progress update → building（不重新 review）
5. approved plan → structural update → awaiting_review
6. completed plan → new plan → awaiting_review
7. multi-turn resume 后 plan state 恢复正确
```

### 6.2 User input tests

```
1. ask_user tool queued → awaiting_user_input
2. answer option → tool.finished + model resume
3. answer free text → tool.finished + model resume
4. full mode 下 ask_user 被拒绝并要求 replan
```

### 6.3 Approval tests

```
1. read tool → allow（直通，不触发 interrupt）
2. write tool → need approval
3. shell read-only → allow（直通）
4. shell mutation → need approval
5. destructive shell → deny（不可绕过）
6. approval hash mismatch → reject
7. replacement command → 重新 policy check
8. same_command grant → 同命令自动通过
9. full_access → 不放行 destructive
```

### 6.4 Auto mode tests

```
1. auto-review approve → tool run
2. auto-review reject → tool rejected
3. auto-review technical failure fail-closed → tool rejected + circuit breaker
4. auto-review technical failure fail-open → tool run + warning
5. auto-review 不改变 plan state
6. auto-review 不改变 authorization（不自动变 full_access）
7. _safety=safe + low risk → auto-approve
8. _safety=safe + destructive → deny（belt-and-suspenders）
9. _safety=dangerous → 强制 interrupt
10. circuit breaker tripped → 跳过 auto-review，直接 interrupt
11. doom-loop detected → block
```

### 6.5 TUI projection tests

```
1. tool.queued → pending 状态
2. tool.started → running 状态
3. tool.progress → 追加 progress
4. tool.finished → success 状态
5. tool.failed → error 状态
6. tool.rejected → rejected 状态
7. user_input.requested → input block 显示
8. user_input.answered → input block completed + tool card success
9. plan.review_requested → plan review block 显示
10. plan.approved → plan block approved + tool card success
```

### 6.6 Persistence tests

```
1. event log replay 得到同样 RuntimeState
2. snapshot + events replay 得到同样 RuntimeState
3. interrupt 后重启仍可 resume
4. ask_user 后重启仍可 answer
5. plan_review 后重启仍可 approve/reject
6. approval 后重启仍可 approve/reject
```

---

## 7. 重构期间的硬规则

以下规则在重构期间**严格执行**，违反即阻塞合并：

### Rule 1：禁止新 graph 节点直接修 UI 状态
不再新增 `toolResultSink(...)` 作为业务补偿。所有 UI 更新必须来自 RuntimeEvent projection。

### Rule 2：禁止新增 `boolean` 表示复杂 lifecycle
避免 `planReviewed: boolean`、`autoReviewed: boolean`。改用判别联合类型 `{ kind: 'awaiting_review' } | { kind: 'approved' }`。

### Rule 3：mode 只能影响 policy，不能直接改状态机
不要写 `if (autoMode) { route = tools; }`。应该写 `const decision = policy.evaluate(state)`。

### Rule 4：auto-review 不能直接执行工具
auto-review 只产生 decision。工具能否执行，必须经过 PolicyEngine → ApprovalController → ToolController preflight guard。

### Rule 5：每个 interrupt 必须有 interactionId
不能只靠 toolCallId 或 LangGraph resume payload 追踪中断生命周期。

### Rule 6：每个 tool status transition 必须事件化
不能只靠 ToolMessage 存在与否判断工具状态。

### Rule 7：core 不依赖 app
继续遵守 `layer-boundary-enforcement.md`：core 层不 import app/tui 层。projection 在 core 层完成，TUI 只消费标准 `AgentEvent`。

---

## 8. 风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| 事件遗漏导致状态不同步 | 高 | Phase 1 仅增加事件管道，不改行为；测试矩阵覆盖所有事件转换 |
| Reducer 不完备导致状态转换遗漏 | 高 | 每个 reducer case 对应一个单测；持久化测试用 event log replay 验证一致性 |
| Controller 抽取引入行为差异 | 中 | 每个 controller 从现有代码复制逻辑（非重写），测试全量回归 |
| LangGraph checkpoint 与 EventStore 数据不一致 | 中 | Phase 5 先双写，再逐步以 EventStore 为权威来源 |
| TUI 现有 E2E 测试断言依赖旧事件格式 | 中 | Phase 1 保持 `AgentEvent` 格式不变，projection 是纯内部转换 |
| Phase 间测试维护负担 | 低 | 每 phase 完成后 `bun test` + `bun run test:e2e` 全绿再进入下一 phase |

---

## 9. 相关文档

- [[layer-boundary-enforcement]] — core 层边界约束（Rule 7 的基础）
- [[plan-mode-implementation]] — 当前 plan mode 实现细节（重构的起点）
- [[tool-gated-autonomy]] — 工具 gating 与审批边界（Phase 4 策略化的基础）
- [[three-layer-architecture-design]] — 三层架构设计（Runtime 层符合 core 层定位）
- [[2026-06-19-event-mechanism-refactor]] — 事件机制重构（已完成，Phase 1 在此基础上深化）

---

## 10. 实施状态（2026-07-09 审计）

### 10.1 各 Phase 完成度

| Phase | 完成度 | 关键成果 | 主要缺口 |
|-------|--------|---------|---------|
| Phase 1 (RuntimeEvent) | **95%** | 17 种事件类型 + projection；全 graph 节点走 RuntimeEvent 管道；toolResultSink 从节点中移除 | turn/model/user/plan 生命周期事件（10 种）未实现 |
| Phase 2 (State + Reducer) | **85%** | RuntimeState 完整类型 + 14 case reducer + SQLite Store + State Bridge 双向转换 | auto_review 事件在 reducer 中无显式 case（走 default）；transcript/approvals 子状态未独立 |
| Phase 3 (Controller) | **86%** | 6/7 controller 已创建并全部接入 graph.ts；graph.ts 从 1888 行缩减至 1693 行（-10.3%） | transcript-controller 未创建（model/context.ts 已足够独立，低优先级） |
| Phase 4 (Policy) | **70%** | RuntimePolicy 接口 + 3 种 mode 实现 + effects/scheduler + composePolicies | Policy 系统未接入 graph.ts（routes.ts 仍直接检查 InteractionMode）；auto-review-policy/loop-policy 缺失 |
| Phase 5 (Engine) | **95%** | AgentLoopEngine 接口 + LangGraph 适配器；runner.ts 全部 5 个入口使用 engine，0 处直接 buildCodeAgentGraph 调用 | kernel.ts 未实现（AgentKernel 主循环）；checkpoint 未降级为执行缓存 |

### 10.2 目录结构完成度

| 模块 | 计划 | 已创建 | 缺失 |
|------|------|--------|------|
| `src/core/runtime/` | 10 文件 | 11 文件 (+bridge) | kernel.ts |
| `src/core/controllers/` | 7 文件 | 6 文件 | transcript-controller.ts |
| `src/core/policies/` | 7 文件 | 5 文件 | auto-review-policy.ts, loop-policy.ts |
| `src/core/engines/` | 2 文件 | 2 文件 | — |

### 10.3 RuntimeEvent 类型覆盖

| 类别 | 计划 | 已实现 | 缺失 |
|------|------|--------|------|
| Turn 生命周期 | 3 | 0 | started, completed, aborted |
| User message | 1 | 0 | message_appended |
| Model interaction | 2 | 0 | requested, responded |
| Tool lifecycle | 6 | 6 | — |
| Plan lifecycle | 7 | 4 | drafted, progress_updated, completed |
| User input | 2 | 2 | — |
| Approval | 4 | 3 | command_replaced |
| Auto-review | 2 | 2 | — |
| State changes | 2 | 2 | — |
| **合计** | **29** | **19** | **10** |

### 10.4 Controller 接线状态

| Controller | 已创建 | 已接入 graph.ts | graph 节点 |
|-----------|--------|----------------|-----------|
| plan-review-controller | ✅ | ✅ | planReview → handlePlanReview |
| user-input-controller | ✅ | ✅ | userInput → handleUserInput |
| model-controller | ✅ | ✅ | agent → invokeAgentModel |
| tool-controller | ✅ | ✅ | executeOneTool → executeTool |
| auto-review-controller | ✅ | ✅ | approval → runAutoReview |
| approval-controller | ✅ | ✅ | approval → handleApprovalResume |
| transcript-controller | ❌ | — | — |

### 10.5 硬规则合规

| Rule | 状态 | 备注 |
|------|------|------|
| 1. graph 节点不直接修 UI | ✅ | toolResultSink 已从 graph 节点中移除 |
| 2. 不用 boolean 表示生命周期 | ✅ | PlanLifecycleState discriminated union |
| 3. mode 只影响 policy | ⚠️ | Policy 已实现但未接入；routes.ts 仍直接检查 InteractionMode |
| 4. auto-review 不直接执行工具 | ✅ | runAutoReview 只返回 decision |
| 5. 每个 interrupt 有 interactionId | ✅ | 所有 interrupt 值包含 interaction id |
| 6. 每个 tool status 事件化 | ✅ | tool.finished/rejected/failed 全部 emit |
| 7. core 不依赖 app | ✅ | 零 app/ import |

### 10.6 测试覆盖

| 测试文件 | 状态 | 测试数 |
|---------|------|--------|
| tests/runtime/reducer.test.ts | ✅ | 51 |
| tests/runtime/store.test.ts | ✅ | 39 |
| tests/runtime/bridge.test.ts | ✅ | 15 |
| tests/policies/mode-policy.test.ts | ✅ | 33 |
| tests/policies/approval-policy.test.ts | ❌ | — |
| tests/policies/auto-review-policy.test.ts | ❌ | — |
| tests/execution/reliability-reads.test.ts | ✅ | 3（已适配 runtimeEventSink） |
| 全量回归（9 文件） | ✅ | 383 pass, 0 fail |

### 10.7 剩余工作（按优先级）

1. **Policy 接入 graph.ts**（Rule 3 修复）— 替换 routes.ts 中直接的 InteractionMode 检查
2. **kernel.ts 实现**— AgentKernel 主循环，连接 RuntimeState + Scheduler + Controllers + Engine
3. **Checkpoint 降级**— RuntimeStore 成为唯一状态权威，LangGraph checkpoint 降为执行缓存
4. **RuntimeEvent 补全**— turn/model/user/plan 生命周期事件
5. **缺失 policy 实现**— auto-review-policy.ts, loop-policy.ts
6. **缺失测试**— approval-policy.test.ts, auto-review-policy.test.ts
7. **transcript-controller**— 低优先级，model/context.ts 已足够独立
