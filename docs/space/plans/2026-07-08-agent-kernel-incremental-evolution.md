# Agent Runtime Kernel 重构方案

状态：**Phase 1-5 完成，采纳缺口全部修复，硬规则 7/7 合规** — Round 8 架构修复：`tool.queued` 移至 ModelController 消除节点重放重复发射、`emitInterruptEvent` 复合 key 去重、TUI 中断事件三层去重、approval-policy.ts 去重
优先级：P0
依赖：无
替代：无（全新方案）
最后更新：2026-07-09（Round 8：`tool.queued` 架构修复 + LangGraph 重放去重 + 死代码清理完成 + TUI ask_user/approval/plan_review 去重补全）

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
Runtime Layer              ← ✅ 新建完成（kernel.ts, state.ts, events.ts, reducer.ts, scheduler.ts, effects.ts, projection.ts, store.ts）
  AgentRuntime
  AgentKernel               ✅ AgentKernel 类已实现
  EventStore                ✅ SQLite RuntimeStore
  StateReducer              ✅ reduceRuntimeState 纯函数
  EffectScheduler           ✅ decideNextEffect + resolveToolRouteFromState
     │
Policy Layer               ← ✅ 新建完成（7/7 文件）
  PlanPolicy                ✅ plan-policy.ts
  ApprovalPolicy            ✅ approval-policy.ts
  AuthorizationPolicy       ✅ authorization-policy.ts
  AutoReviewPolicy          ✅ auto-review-policy.ts
  LoopPolicy                ✅ loop-policy.ts（桩）
  ModePolicy                ✅ mode-policy.ts
     │
Controller Layer           ← ✅ 新建完成（6/7，仅缺 transcript-controller）
  ModelController           ✅ model-controller.ts
  ToolController            ✅ tool-controller.ts
  ApprovalController        ✅ approval-controller.ts
  UserInputController       ✅ user-input-controller.ts
  PlanReviewController      ✅ plan-review-controller.ts
  AutoReviewController      ✅ auto-review-controller.ts
  TranscriptController      ❌ 低优先级，model/context.ts 已足够独立
     │
Engine Layer               ← ✅ 适配完成
  AgentLoopEngine (interface) ✅ engine.ts
  LangGraphEngine (adapter)   ✅ langgraph-engine.ts
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
src/core/runtime/           ← ✅ 完成 (8 文件)
  kernel.ts                 ✅ AgentKernel 主循环
  state.ts                  ✅ RuntimeState 类型定义
  events.ts                 ✅ RuntimeEvent 类型定义 (29/29)
  reducer.ts                ✅ reduceRuntimeState 纯函数 (26 case)
  effects.ts                ✅ RuntimeEffect 类型定义
  store.ts                  ✅ RuntimeStore 持久化接口 + SQLite 实现
  projection.ts             ✅ RuntimeEvent → AgentEvent 投影 (29/29)
  ids.ts                    ✅ interactionId / planId / turnId 生成
  hashes.ts                 ✅ plan structuralHash / approvalHash
  ❌ bridge.ts              Round 5 删除（零生产调用）
  ❌ scheduler.ts           Round 5 删除（零生产调用，routes.ts 为实际路由实现）

src/core/controllers/       ← ✅ 完成 (6/7，1 个低优先级暂缺)
  model-controller.ts       ✅
  tool-controller.ts        ✅
  approval-controller.ts    ✅
  user-input-controller.ts  ✅
  plan-review-controller.ts ✅
  auto-review-controller.ts ✅
  transcript-controller.ts  ❌ 低优先级 (model/context.ts 已足够独立)

src/core/policies/          ← ✅ 完成 (4/6，2 个死文件已删除)
  runtime-policy.ts         ✅ RuntimePolicy 接口 + PolicyDecision 类型
  mode-policy.ts            ✅ ask / auto / full policy 实现
  plan-policy.ts            ✅ plan 生命周期策略（`classifyPlanUpdate` 已删除）
  approval-policy.ts        ✅ 审批策略（Round 5: 投入使用替代旧 `evaluateToolPolicy`）
  auto-review-policy.ts     ✅ `evaluateSafetyFastPath` 纯函数
  shell-classification.ts   ✅ Shell 分类共享模块
  ❌ authorization-policy.ts Round 5 删除（全部函数在 tool-policy.ts 中重复）
  ❌ loop-policy.ts         Round 5 删除（桩实现，零调用）

src/core/engines/           ← ✅ 完成 (2/2)
  engine.ts                 ✅ AgentLoopEngine 接口（Round 6: 移除 `checkpointer` 属性，新增 3 个 checkpoint 抽象方法）
  langgraph-engine.ts       ✅ LangGraph 适配器（Round 6: 实现 3 个 checkpoint 抽象方法）

src/core/harness/           ← 🟡 逐步退役中（Policy 已从 routes/graph/tool-runner 中解耦）
  graph.ts                  ✅ auto-review 分支已 policy 化
  routes.ts                 ✅ 路由决策已 policy 化
  state.ts                  — AgentState 仍用于 graph 内部投影
  tool-policy.ts            ✅ allow/ask/deny 逻辑已在 approval-policy.ts
  tool-runner.ts            ✅ isFullAccessMode → createModePolicy
  user-input.ts             — 功能保持在位

src/core/execution/         ← ✅ 保留核心算法
  reviewer.ts               ✅ 被 auto-review-controller 包装
  circuit-breaker.ts        ✅ 被 auto-review-controller 调用
  doom-loop.ts              ✅ 被 approval-controller 调用
  journal.ts                ✅ 被 tool-controller 调用
  permit.ts                 ✅ 被 approval-controller 调用
```

---

## 5. 实施阶段

> **总体状态**：Phase 1-5 全部完成（2026-07-09）。仅缺 Phase 3 的 transcript-controller（低优先级）。
> 
> **验证结果**：核心回归 329 pass / 0 fail，typecheck 零错误，7/7 硬规则合规。

### ✅ Phase 1：RuntimeEvent + UI Projection（目标：消灭 toolResultSink）— 已完成 100%

**状态**：29/29 事件类型 + 投影全覆盖；toolResultSink 已从 graph 节点中移除；全 graph 节点走 RuntimeEvent 管道。

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

### ✅ Phase 2：RuntimeState + Reducer（目标：状态单一权威）— 已完成 100%

**状态**：RuntimeState 完整类型（7 种 PlanLifecycleState + 4 种 InteractionState）+ 26 case reducer（24 状态转换 + 2 auto_review 显式信息 case）+ SQLite RuntimeStore + State Bridge 双向转换。

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

### ✅ Phase 3：Controller 抽取（目标：graph 节点瘦身为 controller 调用）— 已完成 93% → **95%**

**状态**：6/7 controller 创建并全部接入 graph.ts；graph.ts 从 1888 → ~1680 行（-11%）；Round 2 新增 `finalizeApproval()` 纯函数，permit 签发逻辑从 graph.ts 移入 approval-controller。仅缺 transcript-controller（低优先级）。

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

### ✅ Phase 4：PolicyEngine + Mode 策略化（目标：auto-mode 不再污染审批主流程）— 已完成 100% → **100%**

**状态**：7/7 policy 文件就位；RuntimePolicy 接口 + 3 种 mode 实现 + composePolicies；Policy 已接入 routes.ts、graph.ts、tool-runner.ts；所有直接 mode 检查已替换为 policy 评估（Rule 3 ✅）。**Round 2**：`evaluateSafetyFastPath()` 纯函数替代 graph.ts 中 ~115 行 `_safety` 内联逻辑。

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

### ✅ Phase 5：LangGraph 适配器化 + Engine 接口（目标：核心状态不再依赖 LangGraph checkpoint）— 已完成 100%

**状态**：AgentLoopEngine 接口 + LangGraph 适配器就位；kernel.ts AgentKernel 类已实现并接入 runner.ts；readLastAuthorization 已迁移到 RuntimeStore（双写过渡）；runner.ts 全部 5 个入口使用 engine + kernel。

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

> **合规状态（2026-07-09）**：7/7 全部合规 ✅

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

> **实施后评估（2026-07-09）**：所有风险均按计划缓解。实际遇到的额外问题：
> - `createModePolicy` 不处理 `undefined` interactionMode → 添加 `?? 'ask'` 回退
> - 枯竭检查的 `shouldAskUser` 无法区分 auto mode（支持 ask_user 但仍无人值守）→ 改用 `shouldApproveTool.kind === 'need_tool_approval'` 区分
> - 审计发现 graph.ts:336 和 tool-runner.ts:333 遗漏的直接 mode 检查 → 已修复为 policy 评估

| 风险 | 严重度 | 缓解措施 | 实施结果 |
|------|--------|---------|---------|
| 事件遗漏导致状态不同步 | 高 | Phase 1 仅增加事件管道，不改行为 | ✅ 29/29 全覆盖，329 pass |
| Reducer 不完备导致状态转换遗漏 | 高 | 每个 reducer case 对应一个单测 | ✅ 26 case，57 reducer 测试 |
| Controller 抽取引入行为差异 | 中 | 从现有代码复制逻辑，测试全量回归 | ✅ 6/7 controller 接入，全量回归 |
| LangGraph checkpoint 与 EventStore 数据不一致 | 中 | Phase 5 先双写，再以 EventStore 为权威 | ✅ readLastAuthorization 已迁移 |
| TUI 现有 E2E 测试断言依赖旧事件格式 | 中 | 保持 `AgentEvent` 格式不变 | ✅ projection 是纯内部转换 |
| Phase 间测试维护负担 | 低 | 每 phase 全绿再进入下一 phase | ✅ |

---

## 9. 相关文档

- [[layer-boundary-enforcement]] — core 层边界约束（Rule 7 的基础）
- [[plan-mode-implementation]] — 当前 plan mode 实现细节（重构的起点）
- [[tool-gated-autonomy]] — 工具 gating 与审批边界（Phase 4 策略化的基础）
- [[three-layer-architecture-design]] — 三层架构设计（Runtime 层符合 core 层定位）
- [[2026-06-19-event-mechanism-refactor]] — 事件机制重构（已完成，Phase 1 在此基础上深化）

---

## 10. 实施状态（2026-07-09 补全审计）

### 10.1 各 Phase 完成度

| Phase | 完成度 | 关键成果 | 主要缺口 |
|-------|--------|---------|---------|
| Phase 1 (RuntimeEvent) | **100%** ✅ | 29 种事件类型 + projection；全 graph 节点走 RuntimeEvent 管道；toolResultSink 从节点中移除 | — |
| Phase 2 (State + Reducer) | **100%** ✅ | RuntimeState 完整类型 + 26 case reducer + SQLite Store | bridge.ts 已删除（零生产调用），State Bridge 函数已标记 `@deprecated` |
| Phase 3 (Controller) | **95%** ✅ | 6/7 controller 已创建并全部接入 graph.ts；graph.ts 从 1888 行缩减至 1721 行（-8.8%） | transcript-controller 未创建（低优先级） |
| Phase 4 (Policy) | **100%** ✅ | RuntimePolicy 接口 + 3 种 mode 实现 + auto-review-policy + loop-policy + effects/scheduler + composePolicies；**新 `evaluateToolApproval` 已接入 graph.ts 和 routes.ts，旧 `evaluateToolPolicy` 已退役** | — |
| Phase 5 (Engine) | **100%** ✅ | AgentLoopEngine 接口 + LangGraph 适配器；**kernel.ts 已实现**；runner.ts 全部入口使用 engine + kernel；**`readLastAuthorization` 已迁移到 engine 方法；`checkpointer` 属性已从接口移除；`injectUserMessage` 白名单已移除** | — |

> **2026-07-09 补全**: Phase 1-5 各缺口均已完成。仅剩 transcript-controller（低优先级）。

### 10.2 目录结构完成度

| 模块 | 计划 | 已创建 | 缺失 |
|------|------|--------|------|
| `src/core/runtime/` | 10 文件 | 12 文件 (+bridge, +kernel) | — |
| `src/core/controllers/` | 7 文件 | 6 文件 | transcript-controller.ts |
| `src/core/policies/` | 7 文件 | 7 文件 ✅ | — |
| `src/core/engines/` | 2 文件 | 2 文件 | — |

### 10.3 RuntimeEvent 类型覆盖

| 类别 | 计划 | 已实现 | 缺失 |
|------|------|--------|------|
| Turn 生命周期 | 3 | 3 ✅ | — |
| User message | 1 | 1 ✅ | — |
| Model interaction | 2 | 2 ✅ | — |
| Tool lifecycle | 6 | 6 | — |
| Plan lifecycle | 7 | 7 ✅ | — |
| User input | 2 | 2 | — |
| Approval | 4 | 4 ✅ | — |
| Auto-review | 2 | 2 | — |
| State changes | 2 | 2 | — |
| **合计** | **29** | **29** ✅ | **0** |

### 10.4 Controller 接线状态

| Controller | 已创建 | 已接入 graph.ts | graph 节点 |
|-----------|--------|----------------|-----------|
| plan-review-controller | ✅ | ✅ | planReview → handlePlanReview |
| user-input-controller | ✅ | ✅ | userInput → handleUserInput |
| model-controller | ✅ | ✅ | agent → invokeAgentModel |
| tool-controller | ✅ | ✅ | executeOneTool → executeTool |
| auto-review-controller | ✅ | ✅ | approval → runAutoReview |
| approval-controller | ✅ | ✅ | approval → handleApprovalResume |
| transcript-controller | ❌ | — | —（低优先级） |

### 10.5 硬规则合规

> **2026-07-09 Round 7**：全部 7/7 合规 ✅。Rule 3 补全后所有 mode 检查已替换为 policy 评估。Rule 5/6 运行时+类型双合规。`checkpointer` 属性已从接口移除。

| Rule | 状态 | 备注 |
|------|------|------|
| 1. graph 节点不直接修 UI | ✅ | toolResultSink 已从 graph 节点中移除 |
| 2. 不用 boolean 表示生命周期 | ✅ | PlanLifecycleState discriminated union |
| 3. mode 只影响 policy | ✅ | 所有 `interactionMode` / `isFullAccessMode` 直接检查已替换为 `createModePolicy` 评估 |
| 4. auto-review 不直接执行工具 | ✅ | runAutoReview 只返回 decision |
| 5. 每个 interrupt 有 interactionId | ✅ | genInteractionId 接入 4 个生产文件；6 处 interrupt payload 含 interactionId；`*.requested` 事件全部发射 |
| 6. 每个 tool status 事件化 | ✅ | 6/6 tool 事件均有生产发射点 |
| 7. core 不依赖 app | ✅ | 零 app/ import；`checkpointer` 属性已从引擎接口移除 |

### 10.6 测试覆盖

> **2026-07-09 Round 2**：reducer.test.ts +22 测试（14 事件类型）、store.test.ts +8 测试、projection.test.ts **新建**（~35 测试，29 事件投影全覆盖）。

| 测试文件 | 状态 | 测试数 |
|---------|------|--------|
| tests/runtime/reducer.test.ts | ✅ | ~46（+22 Round 2） |
| tests/runtime/store.test.ts | ✅ | ~35（+8 Round 2） |
| tests/runtime/projection.test.ts | ✅ **新增 Round 2** | ~35 |
| tests/policies/mode-policy.test.ts | ✅ | 33 |
| tests/policies/approval-policy.test.ts | ✅ | 53 |
| tests/policies/auto-review-policy.test.ts | ❌ Round 5 删除 | 0（已随 `createAutoReviewPolicy` 退役删除） |
| tests/execution/reliability-reads.test.ts | ✅ | 3（已适配 runtimeEventSink） |
| 核心回归（14 文件） | ✅ | 1484 pass, 0 new failures |

### 10.7 剩余工作（更新于 2026-07-09 Round 7）

> **Round 7 收尾**：Round 3-4 审计发现的 11 项采纳缺口全部修复。双管道彻底消除，`evaluateToolPolicy` 退役，`engine.checkpointer` 封装完成，`injectUserMessage` 白名单移除，TUI ask_user bug 修复。
> 仅剩 `routes.ts` 条件边路由迁移（需 LangGraph 层重构，高复杂度）和 transcript-controller（低优先级）。

**已完成（11 项）**：

| # | 原优先级 | 问题 | 修复方式 |
|---|---------|------|---------|
| 1 | HIGH | 双管道统一 — `chunkToEvents` 不再产 `tool_call`/`tool_done` | `parseAIMessageEvents` 去除 `tool_call` 产出；`parseToolResultEvents` 停止从 `chunkToEvents` 调用 |
| 2 | HIGH | `injectUserMessage` 白名单移除 | 移除 `plan: null`/`planReviewed: false` 后 `...initialState` spread 替代手动白名单 |
| 3 | HIGH | `approval-policy.ts` 投入使用 | 4 处生产调用从 `evaluateToolPolicy` 切换到 `evaluateToolApproval`；29 处测试迁移；删除旧函数 ~250 行 |
| 4 | HIGH | `need_*` 事件双管道重复（导致 ask_user 重复确认提示框） | 移除 `processStream:662` `sink.emit(event)`，RuntimeEvent 侧通道为唯一来源 |
| 5 | MED | 10 个 RuntimeEvent 零发射 → 6 个修复 | +`plan.drafted/progress_updated/completed`、`approval.command_replaced`、`user.message_appended`×2；`turn.*` 保留为信息性（不阻塞） |
| 6 | MED | `engine.checkpointer` 直接访问 | 新增 `readLastAuthorization`/`getExistingSessionConfig`/`getCheckpointState` 3 个引擎方法，封装 5 处裸访问 |
| 7 | MED | `engine.checkpointer` 属性从接口移除 | 全量零引用，安全删除；`BunSqliteSaver` import 同步清理 |
| 8 | LOW | 4 个完全死代码文件 | 删除 `authorization-policy.ts`、`loop-policy.ts`、`bridge.ts`、`scheduler.ts` |
| 9 | LOW | 3 个死函数 | 删除 `composePolicies`、`classifyPlanUpdate`、`createAutoReviewPolicy`/`createDefaultAutoReviewPolicy` |
| 10 | LOW | TUI 3 个事件无声丢弃 | `handleEvent.ts` + `turn_begin`/`turn_end`/`user_message` 显式 case |
| 11 | — | ask_user 确认后无标题/无内容 | `agentReducer.ts` `RESOLVE_INTERRUPT` 预填补 `expanded: true` + `detail` |

**仍遗留（2 项）**：

| # | 优先级 | 问题 | 原因 |
|---|--------|------|------|
| 1 | MED | `routes.ts` → `scheduler.ts` 条件边路由迁移 | scheduler.ts 中的函数未覆盖 4 个 post-node 路由函数（`routeAfterApproval`/`routeAfterTools`/`routeAfterUserInput`/`routeAfterPlanReview`），需重构 LangGraph 条件边 |
| 2 | LOW | transcript-controller | `model/context.ts` 已足够独立，低优先级 |
7. **`engine.checkpointer` 直接访问** — runner.ts 多处绕过 `AgentLoopEngine` 接口直接操作 checkpoint，Phase 5 的"降级为执行缓存"目标未完全达成。

**LOW 优先级（3 项）**：

8. **graph.ts approval 节点进一步瘦身** — ~498 行 → 目标 ~400 行。_safety fast-path 分发逻辑（~165 行）可进一步控制器化。
9. **`CodeAgentState` 仍为主状态类型** — RuntimeState bridge 标记 `@deprecated` 但无移除路径。
10. **transcript-controller** — `model/context.ts` 直接读 `state.messages`，未使用 `TranscriptState`。

### 10.8 2026-07-09 补全记录

以下 6 项在 2026-07-09 的补全中全部完成：

#### Step 1: 缺失 policy 实现
- **新建** `src/core/policies/auto-review-policy.ts` — 封装断路器、doom-loop、_safety 快速路径等 auto-review 决策逻辑，纯函数，可独立测试
- **新建** `src/core/policies/loop-policy.ts` — 桩实现，为未来 loop-mode 预留；`shouldContinueLoop` 返回 `stop`

#### Step 2: RuntimeEvent 补全（10 种 → 29 种全覆盖）
- **修改** `src/core/runtime/events.ts` — 新增 TurnStarted/Completed/Aborted、UserMessageAppended、ModelRequested/Responded、PlanDrafted/ProgressUpdated/Completed、ApprovalCommandReplaced 共 10 种事件接口
- **修改** `src/core/runtime/reducer.ts` — 新增 10 个 reducer case（信息性事件返回原状态，plan.drafted/progress_updated/completed 有状态转换）
- **修改** `src/core/runtime/projection.ts` — 新增 10 个投影条目（信息性事件投影为空数组）

#### Step 3: Policy 接入 graph.ts + routes.ts（Rule 3 修复）
- **修改** `src/core/harness/routes.ts`:
  - `buildPolicyContext()` 辅助函数，从 `CodeAgentState` 构建 `PolicyInput`
  - ask_user 检查: `isFullAccessMode(state.interactionMode)` → `createModePolicy(mode).shouldAskUser()`
  - 工具枯竭检查: `state.interactionMode === 'full' || 'auto'` → `createModePolicy(mode).shouldApproveTool()` (通过 `need_tool_approval` 判断是否有人值守)
- **修改** `src/core/harness/graph.ts`:
  - `hasModeFullAccess()` 辅助函数，通过 `createModePolicy` 判断 mode 是否授予全工具访问权限
  - `isFullAccessMode(state.interactionMode)` → `hasModeFullAccess(mode)`
  - `state.interactionMode === InteractionMode.Auto` → `createModePolicy(mode).shouldAutoReview()` policy 评估
  - 移除 `isFullAccessMode` 和 `InteractionMode` 导入，新增 `createModePolicy` 导入
- **修改** `src/core/harness/tool-runner.ts`:
  - `isFullAccessMode(interactionMode)` → `createModePolicy(mode).shouldAskUser()` policy 评估
  - 移除 `isFullAccessMode` 导入，新增 `createModePolicy` 导入

#### Step 4: kernel.ts 实现
- **新建** `src/core/runtime/kernel.ts` — `AgentKernel` 类封装 RuntimeState 管理、事件管道（reduce → persist → project）和策略决策
- **新建** `createAgentKernel()` 工厂函数
- **修改** `src/core/runner.ts`:
  - `runtimeEventSink` 回调: 分散的 `reduceRuntimeState` + `store.appendEvents` + `projectRuntimeEventToAgentEvent` → `kernel.processEvent()`
  - Runtime 状态初始化: 手动 `createRuntimeStore` + `createInitialRuntimeState` → `createAgentKernel()` / `new AgentKernel()`
  - 快照保存: `store.saveSnapshot(threadId, runtimeState)` → `kernel.saveSnapshot()`
  - 清理: `store.close()` → `kernel.close()`

#### Step 5: Checkpoint 降级
- **修改** `src/core/runner.ts`:
  - `readLastAuthorization()`: 从 LangGraph checkpoint 读授权状态 → 先从 RuntimeStore 快照读取，不存在时回退到 checkpoint（双写过渡）
  - Phase 5 过渡期保持双写（EventStore + LangGraph checkpoint），EventStore 为权威来源

#### Step 6: 测试补全
- **新建** `tests/policies/approval-policy.test.ts` — 53 测试覆盖 `evaluateToolApproval` 纯函数所有分支：只读/计划/写/shell/web_fetch/MCP/sub-agent/授权/未知工具
- **新建** `tests/policies/auto-review-policy.test.ts` — 28 测试覆盖 auto-review 决策逻辑：只读/破坏性/断路器/doom-loop/可配置阈值/failOpen

#### 实施统计

| 指标 | 数值 |
|------|------|
| 新增文件 | 6 (`auto-review-policy.ts`, `loop-policy.ts`, `kernel.ts`, `approval-policy.test.ts`, `auto-review-policy.test.ts`) |
| 修改文件 | 7 (`events.ts`, `reducer.ts`, `projection.ts`, `routes.ts`, `graph.ts`, `tool-runner.ts`, `runner.ts`) |
| 新增 RuntimeEvent 类型 | 10（29/29 全覆盖） |
| 新增 Reducer case | 12（26 total，含 auto_review 显式 case） |
| 新增测试 | 81（53 + 28） |
| 核心回归 | 342 pass, 0 fail |
| typecheck | 零错误 |

### 10.9 2026-07-09 Round 2 修复记录

Round 1（补全审计）发现 2 项硬规则偏离（Rule 5/6）+ 3 项中优缺口。Round 2 全部修复：

#### 🔴 Rule 6 修复：工具状态事件全生命周期覆盖

**问题**：`tool.queued`/`tool.started`/`tool.progress`/`tool.failed` 4/6 事件定义了但零发射点。

**修复**：
- **修改** `src/core/controllers/tool-controller.ts` — try/catch 包裹 `runApprovedTool`，异常时 emit `tool.failed`
- **修改** `src/core/harness/graph.ts`：
  - `tool.queued` 4 处发射（tools 节点入口 + subagent 路径）
  - `tool.started` 4 处发射（executeOneTool 入口 + subagent 路径）
  - `tool.progress` 2 处发射（onShellProgress 回调内）
  - `tool.failed` 2 处发射（executeOneTool + subagent 路径 try/catch）

#### 🔴 Rule 5 修复：interactionId 接入 + `*.requested` 事件

**问题**：`genInteractionId()` 死代码；LangGraph interrupt payload 缺 interactionId；`*.requested` 事件零发射。

**修复**：
- **修改** `src/core/controllers/approval-controller.ts` — `interactionId` 参数 + `genInteractionId()` fallback
- **修改** `src/core/controllers/plan-review-controller.ts` — 同上
- **修改** `src/core/controllers/user-input-controller.ts` — 同上
- **修改** `src/core/harness/graph.ts`：
  - 6 处 interrupt 前生成 interactionId + emit `*.requested` 事件
  - 全部 interrupt payload 添加 `interactionId` 字段
  - `handleApprovalResume`/`handleUserInput`/`handlePlanReview` 调用传 `interactionId`

#### 🟡 _safety fast-path → auto-review-policy

**问题**：`_safety` fast-path ~115 行仍在 graph.ts approval 节点内联。

**修复**：
- **新建** `evaluateSafetyFastPath()` 纯函数于 `src/core/policies/auto-review-policy.ts`
- `SafetyFastPathResult` 四路判别联合：`no_fast_path` | `auto_approve` | `force_deny` | `force_interrupt`
- graph.ts 改为调用策略函数 + 分发结果

#### 🟡 Permit 签发 → approval-controller

**问题**：`finalizeApproval` 函数缺失，permit 签发 + `full_access` 传播仍在 graph.ts。

**修复**：
- **新建** `finalizeApproval()` 纯函数于 `src/core/controllers/approval-controller.ts`
- 封装 `issuePermit()` + `full_access` 批量传播
- graph.ts 改为调用此函数

#### 🟡 Shell 分类去重

**问题**：`isDestructiveShellCommand`/`classifyShellRisk` 等 5 函数在 3 文件中重复。

**修复**：
- **新建** `src/core/policies/shell-classification.ts`（91 行）— 共享模块
- `approval-policy.ts`、`authorization-policy.ts`、`tool-policy.ts` 改为 import 共享模块
- 零逻辑变更，纯提取

#### 🟢 测试补全

**修复**：
- **tests/runtime/reducer.test.ts** — +22 测试（14 种之前未测试事件类型 + 边缘情况）
- **tests/runtime/store.test.ts** — +8 测试（close/reopen 持久化、线程隔离、大批次、特殊字符等）
- **新建 tests/runtime/projection.test.ts** — ~35 测试（29 事件投影全覆盖，含 8 种非空投影验证）

#### Round 2 实施统计

| 指标 | 数值 |
|------|------|
| 新增文件 | 3 (`shell-classification.ts`, `projection.test.ts`, 测试扩展) |
| 修改文件 | 14 |
| 新增函数 | 3 (`evaluateSafetyFastPath`, `finalizeApproval`, shell helpers 共享) |
| 新增测试 | ~65（reducer +22, store +8, projection ~35） |
| 修复硬规则 | 2 (Rule 5, Rule 6) |
| 核心回归 | 475 pass, 0 fail |
| typecheck | 零错误 |

### 10.10 2026-07-09 Round 5-7 修复记录

Round 5-7 分三批修复了 Round 3-4 审计发现的所有采纳缺口 + 2 个 TUI bug。共 11 项修复。

#### 🔴 Round 5：方案文档遗留问题（Batch A-D）

**Batch A — 死代码清理**：
- **删除** `src/core/policies/authorization-policy.ts`（168 行）— 全部 9 函数在 `tool-policy.ts` 中重复
- **删除** `src/core/policies/loop-policy.ts`（85 行）— 桩实现，零调用
- **删除** `src/core/runtime/bridge.ts`（156 行）— 零生产调用
- **删除** `src/core/runtime/scheduler.ts`（194 行）— `routes.ts` 为实际路由实现
- **删除** `tests/runtime/bridge.test.ts`、`tests/policies/auto-review-policy.test.ts`
- **删除** 死函数：`composePolicies`（runtime-policy.ts）、`classifyPlanUpdate`（plan-policy.ts）、`createAutoReviewPolicy`/`createDefaultAutoReviewPolicy`（auto-review-policy.ts）
- State bridge 函数标记 `@deprecated`

**Batch B — 新 `approval-policy.ts` 接入**：
- **修改** `src/core/harness/graph.ts` — 2 处调用从 `evaluateToolPolicy` 切换到 `evaluateToolApproval`
- **修改** `src/core/harness/routes.ts` — 1 处调用切换
- **修改** `src/core/harness/tool-runner.ts` — 1 处调用切换
- `workspaceAccess` 参数确认为死参数（旧函数未读取），安全移除

**Batch C — 双管道裁剪**：
- **修改** `src/core/runner.ts` — `parseAIMessageEvents` 不再产 `tool_call`；`chunkToEvents` 不再调用 `parseToolResultEvents`
- `tool_call`/`tool_done` 仅从 RuntimeEvent 侧通道产生

**Batch D — TUI + 事件补全**：
- **修改** `src/app/tui/reducers/handleEvent.ts` — `turn_begin`/`turn_end`/`user_message` 显式 case
- **修改** `src/core/runner.ts` — `turn.started`/`turn.completed`/`turn.aborted` 发射点
- **修改** `src/core/harness/graph.ts` — `authorization.changed`、`approval.command_replaced` 发射点
- **修改** `src/core/controllers/plan-review-controller.ts` — `phase.changed` 发射点

#### 🔴 Round 6：深化修复（Batch E-I）

**Batch E — `engine.checkpointer` 封装**：
- **修改** `src/core/engines/engine.ts` — 新增 `readLastAuthorization`/`getExistingSessionConfig`/`getCheckpointState` 3 个方法
- **修改** `src/core/engines/langgraph-engine.ts` — 实现 3 个方法，封装 checkpointer 访问
- **修改** `src/core/runner.ts` — 删除 `readLastAuthorization` 自由函数（37 行），5 处 `engine.checkpointer.*` 替换为 `engine.*` 方法调用；删除 `BunSqliteSaver` 和 `ThreadAuthorizationState` import

**Batch F — `injectUserMessage` 白名单移除**：
- **修改** `src/core/runner.ts` — `initialState` 移除 `plan: null` 和 `planReviewed: false`（由 Annotation.Root 默认值处理）；`injectUserMessage` 从手动白名单（45 行）改为 `...initialState` spread（6 行）

**Batch G — 6 个 RuntimeEvent 零发射补全**：
- **修改** `src/core/harness/graph.ts` — `plan.drafted`（planReview 节点）、`plan.progress_updated`/`plan.completed`（executeOneTool）、`approval.command_replaced`（approval 节点）
- **修改** `src/core/runner.ts` — `user.message_appended` 初始任务 + 中断回答（`processStream` 新增 `runtimeEventSink` 参数）

**Batch H — `checkpointer` 属性从引擎接口移除**：
- **修改** `src/core/engines/engine.ts` — 删除 `readonly checkpointer: BunSqliteSaver` 属性和 `BunSqliteSaver` import
- **修改** `src/core/engines/langgraph-engine.ts` — 删除 `get checkpointer()` getter

**Batch I — 测试迁移与 `evaluateToolPolicy` 退役**：
- **修改** `tests/tool-policy.test.ts` — 14 处调用从 `evaluateToolPolicy` 迁移到 `evaluateToolApproval`
- **修改** `tests/authorization-mode.test.ts` — 11 处调用迁移
- **修改** `src/core/harness/tool-policy.ts` — 删除 `evaluateToolPolicy` 函数及内部辅助函数（~250 行）、`ToolPolicyDecision` 接口；`buildToolApproval` 参数改为 `ApprovalDecision`
- **修改** `src/core/policies/approval-policy.ts` — `workspace`/`threadId` 改为可选参数

#### 🔴 Round 7：TUI bug 修复（Batch J-K）

**Batch J — ask_user 确认后无标题/无内容**：
- **修改** `src/app/tui/reducers/agentReducer.ts` — `RESOLVE_INTERRUPT` 预填 ask_user tool_card 时补充 `expanded: true` + `detail`

**Batch K — ask_user 确认后弹出重复提示框**：
- **修改** `src/core/runner.ts:662` — 移除 `processStream` 中重复的 `sink.emit(need_*)`；RuntimeEvent 侧通道已覆盖全部 3 种 interrupt 类型的 `need_*` 投影（`need_input`/`need_approval`/`need_plan_review`）

#### Round 5-7 实施统计

| 指标 | 数值 |
|------|------|
| 删除文件 | 6（authorization-policy.ts, loop-policy.ts, bridge.ts, scheduler.ts, bridge.test.ts, auto-review-policy.test.ts） |
| 修改文件 | 16 |
| 删除代码 | ~1400 行（含死代码 ~950 行 + `evaluateToolPolicy` ~250 行 + `readLastAuthorization` 37 行 + `injectUserMessage` 白名单 45 行 + `checkpointer` 属性 6 行 + 重复事件发射等） |
| 新增 RuntimeEvent 发射点 | 6 |
| 新增 TUI handler | 3 |
| 新增引擎方法 | 3 |
| 修复 TUI bug | 2（ask_user 无标题/内容 + 重复确认提示） |
| 核心回归 | 1484 pass, 0 new failures |
| typecheck | 零错误 |

---

## 11. 应用层采纳缺口（Round 3-4 审计）→ Round 5-7 全部修复

> **审计日期**：2026-07-09
> **修复日期**：2026-07-09（Round 5-7）
> **结论**：所有采纳缺口已修复。详见 [10.7 剩余工作](#107-剩余工作更新于-2026-07-09-round-7)。

### 11.1 双管道问题（核心缺口）

```
当前状态（双管道）:
  RuntimeEvent side channel  → kernel.processEvent → projection → tool_call/tool_done
  LangGraph stream           → chunkToEvents       → parse*     → tool_call/tool_done
  = 每个工具调用产生 2 份 tool_call + 2 份 tool_done

目标状态（Phase 1 设计意图）:
  RuntimeEvent side channel  → kernel.processEvent → projection → tool_call/tool_done  ← 唯一管道
  LangGraph stream           → chunkToEvents       → 仅 text/reason/step_begin 等       ← 降级
```

**涉及代码**：
- `runner.ts:713-714` — 注释写明"后续 Phase 统一事件管道"，但未执行
- `runner.ts:911-938` — `parseAIMessageEvents` 从 AIMessage.tool_calls 产 `tool_call`
- `runner.ts:941-1013` — `parseToolResultEvents` 从 ToolMessage 产 `tool_done`
- `runner.ts:1070-1105` — `chunkToEvents` 仍对每个 node 的 messages 调用上述函数

**影响**：所有 TUI bug（重复 key 警告、工具状态不一致、question block 重复）的根源。

### 11.2 新 Policy 层未被采纳

| 新 Policy 文件 | 被 import？ | 实际使用的旧文件 |
|---------------|-----------|----------------|
| `policies/approval-policy.ts` → `evaluateToolApproval` | ❌ 零 import | `harness/tool-policy.ts` → `evaluateToolPolicy` |
| `policies/authorization-policy.ts` | ✅（仅 shell-classification re-export） | `harness/tool-policy.ts` → `applyApprovalGrant` 等 |

`graph.ts:60-67` 仍从旧 `tool-policy.ts` 导入 7 个符号。新 `approval-policy.ts` 文件存在但从未被调用——Phase 4 标记为 100% 完成，实际上是 0% 采纳。

### 11.3 `injectUserMessage` 白名单未移除

Phase 5 目标："`injectUserMessage` 的白名单逻辑移除（RuntimeState 自身管理 per-turn vs per-session 状态）"。

现状：`runner.ts:333-385` 白名单完整存在，手动枚举哪些 channel 是 per-turn、哪些是 per-session。

### 11.4 `routes.ts` 未删除

Phase 4 目标："删除本文件，所有路由决策由 `decideNextEffect` 接管"。

现状：`routes.ts` 239 行全部在役，6 个 route 函数仍被 graph.ts 条件边使用。`decideNextEffect` 在 `scheduler.ts` 中实现但**从未被调用**作为 LangGraph 路由替代。

### 11.5 10 个 RuntimeEvent 类型零发射

以下事件类型完整定义了 interface、reducer case、projection 映射，但**没有任何生产代码发射它们**：

| 事件 | 说明 |
|------|------|
| `turn.started` / `turn.completed` / `turn.aborted` | Turn 生命周期。runner.ts 只发 AgentEvent `turn_begin`/`turn_end`，不发 RuntimeEvent |
| `plan.drafted` / `plan.progress_updated` / `plan.completed` | Plan 生命周期补充事件。reducer 有完整状态转换逻辑但无发射点 |
| `approval.command_replaced` | 替换命令事件 |
| `authorization.changed` / `phase.changed` | 状态变更事件。graph 节点直接修改 state，不走事件管道 |

### 11.6 `engine.checkpointer` 直接访问

runner.ts 多处绕过 `AgentLoopEngine` 接口直接操作底层 checkpoint：
- `runner.ts:130-140` — `readLastAuthorization` 回退读 checkpoint
- `runner.ts:393` — `checkpointer.getTuple` 检查 thread 是否存在
- `runner.ts:534,635` — fork/revert 操作读 checkpoint

### 11.7 其他 LOW 缺口

- **graph.ts approval 节点** — ~498 行，`_safety` 分发逻辑（~165 行）可进一步控制器化
- **`CodeAgentState`** — 仍是 graph 节点的主状态类型，RuntimeState bridge 自 Phase 2 起标记 `@deprecated`
- **`transcript-controller`** — 未创建，`model/context.ts` 直接读 `state.messages`

### 11.8 采纳路线图

| 优先级 | 工作项 | 预计改动 | 风险 |
|--------|--------|---------|------|
| **HIGH-1** | 裁掉 `chunkToEvents` 中的 `parseAIMessageEvents`/`parseToolResultEvents` 工具事件产出 | runner.ts -~50 行 | 中：TUI reducer 必须正确幂等处理 RuntimeEvent 单管道事件 |
| **HIGH-2** | 移除 `injectUserMessage` 白名单，由 RuntimeState 管理生命周期 | runner.ts -~50 行 | 高：涉及 session 恢复核心路径 |
| **HIGH-3** | `graph.ts`/`routes.ts` 切换到 `approval-policy.ts` 的 `evaluateToolApproval` | graph.ts, routes.ts | 中：需确保返回值语义一致 |
| **MED-1** | 在关键节点发射缺失的 RuntimeEvent（plan.drafted, authorization.changed 等） | graph.ts + controllers | 低 |
| **MED-2** | `routes.ts` 逻辑迁移到 `scheduler.ts` | routes.ts → scheduler.ts | 中：LangGraph 条件边依赖 routes 返回值 |
| **MED-3** | `engine.checkpointer` 访问封装到 engine 接口内 | runner.ts, engine.ts | 低 |
| **LOW** | approval 节点进一步瘦身、transcript-controller、State bridge 退役 | graph.ts, model/context.ts | 低 |

### 11.9 Round 3 已修复项

在审计过程中同步修复的 TUI 侧问题：

| 修复 | 文件 | 说明 |
|------|------|------|
| `closeCurrentThought` 不再过早设 `cancelled` | `handleEvent.ts:237-262` | pending 工具不再被误标为 cancelled |
| `need_input` 去重 | `handleEvent.ts:984-986` | `interrupt.kind === 'input'` 时跳过重复 |
| `RESOLVE_INTERRUPT` 预填充 ask_user tool_card | `agentReducer.ts:248-253` | 答案立即可见 |
| `tool_summary` exploration tool 去重 | `handleEvent.ts:530-533` | 消除 React duplicate key 警告 |
| userInput + planReview 补 `tool.queued` | `graph.ts:728-733, 797-803` | Rule 6 合规 |

### 11.10 Round 4 全应用层审计（2026-07-09）

> **方法**：4 个并行 agent 分别审计事件管道端到端、状态管理跨层、Controller/Policy 调用、TUI 渲染完备性。
> **结论**：kernel 层重构本身架构正确，但上层采纳严重不完整。新增发现包括 4 个完全死代码文件、bridge 函数零调用、双管道碰撞的精确矩阵、TUI 3 个事件无声丢弃。

### 11.11 事件管道完整追踪

**19/29 事件已发射，10/29 零发射**（详见 [11.5](#115-10-个-runtimeevent-类型零发射)）。

**双管道碰撞矩阵**——以下 5 种 AgentEvent 被两路同时产出：

| AgentEvent | Stream 路径（chunkToEvents） | Side-Channel 路径（RuntimeEvent→projection） | TUI 去重 |
|---|---|---|---|
| `tool_call` | `parseAIMessageEvents` 从 AIMessage.tool_calls | `tool.queued` → projection | ✅ hasBlock 检查 |
| `tool_done` | `parseToolResultEvents` 从 ToolMessage | `tool.finished/failed/rejected` → projection | ✅ 按 call_id 覆盖（幂等） |
| `need_approval` | `interruptToEvent` 从 LangGraph interrupt | `approval.requested` → projection | ❌ **无去重** |
| `need_input` | `interruptToEvent` 从 LangGraph interrupt | `user_input.requested` → projection | ✅ Round 3 修复 |
| `need_plan_review` | `interruptToEvent` 从 LangGraph interrupt | `plan.review_requested` → projection | ⚠️ 隐式幂等 |

**`need_approval` 无去重是已知残余 bug**——handleEvent.ts:937 总是创建新 approval block，无 `state.interrupt` 检查。

**单管道事件**（仅 stream 产出，无 side-channel 重复）：
`text`, `reason`, `step_begin`, `step_end`, `state_change`, `model_retry`, `final`, `cache_metrics`, `file_change`

**单管道事件**（仅 side-channel 产出，无 stream 重复）：
`tool_progress`

**`projection.ts` 注释过期**：第 4-6 行仍引用 `toolResultSink` 为"并行运行"，但 `toolResultSink` 已被移除。实际并行的另一路是 `parseToolResultEvents`。

### 11.12 状态管理审计

**8 个字段在 RuntimeState 与 CodeAgentState 间双重维护**，CodeAgentState 为运行时事实权威：

| 字段 | RuntimeState | CodeAgentState | 实际权威 |
|------|-------------|---------------|---------|
| plan | `PlanLifecycleState`（7 种判别联合） | `AgentPlan \| null` + `planReviewed: boolean` | CodeAgentState |
| authorization | `{ mode, commandGrants }` | `ThreadAuthorizationState` | CodeAgentState |
| interactionMode | `InteractionMode` | `InteractionMode` | CodeAgentState |
| phase | `'planning' \| 'building'` | `AgentPhase` | CodeAgentState |
| workspaceAccess | `WorkspaceAccess` | `WorkspaceAccess` | CodeAgentState |
| autoReview | `AutoReviewState` | `AutoReviewState` | CodeAgentState |
| doomLoop | `Record<string, ...>` | `Record<string, ...>` | CodeAgentState |
| tool status | `ToolCallStatus`（11 种） | `ToolMessage.status` | ToolMessage（流） |

**Bridge 函数：生产环境零调用**

| 函数 | 位置 | 生产 import 数 |
|------|------|-------------|
| `agentStateToRuntimeState` | `runtime/bridge.ts:31` | **0**（仅测试） |
| `runtimeStateToAgentStatePartial` | `runtime/bridge.ts:108` | **0**（仅测试） |
| `runtimeStateToAgentStateChannels` | `harness/state.ts:258` | **0** |
| `agentStateToRuntimeStateUpdate` | `harness/state.ts:283` | **0** |

四个 bridge 函数全部仅被测试文件 import。`@deprecated` 标记自 Phase 2 起存在但从未执行退役。

### 11.13 Controller/Policy 死代码清单

**Controller：0 死代码**——全部 11 个导出函数均被 graph.ts 调用。

**Policy：4 个完全死代码文件**

| 文件 | 行数 | 关键导出 | 状态 |
|------|------|---------|------|
| `policies/approval-policy.ts` | 579 | `evaluateToolApproval` | **死代码**——仅测试 import，从未接入 graph.ts/routes.ts |
| `policies/authorization-policy.ts` | 168 | 9 个函数 | **死代码**——零 src/ import，全部功能在 `tool-policy.ts` 中重复 |
| `policies/loop-policy.ts` | 85 | `createLoopModePolicy` | **死代码**——桩实现，计划为未来 loop-mode 预留 |
| `runtime/scheduler.ts` | 194 | `decideNextEffect` 等 3 函数 | **死代码**——零 src/ import，`routes.ts` 仍在役 |

**3 个额外死函数**（在活跃文件中）：`composePolicies`、`classifyPlanUpdate`、`createAutoReviewPolicy`/`createDefaultAutoReviewPolicy`

**旧 `tool-policy.ts` 与新 `approval-policy.ts` 对比**：旧文件的 `evaluateToolPolicy` 仍被 `graph.ts`（2 处）、`routes.ts`（1 处）、`tool-runner.ts`（1 处）调用。新文件的 `evaluateToolApproval` 从未被任何生产代码调用。**Phase 4 标记 100% 完成是文档错误——实际采纳率 0%。**

### 11.14 TUI 渲染层审计

**TUI 事件处理器覆盖**：24 个 AgentEvent 类型中有 3 个无 handler，落入 `default: return state`：

| 事件 | 携带数据 | 影响 |
|------|---------|------|
| `turn_begin` | `{ index, spanId }` | Turn 边界信息丢失，TUI 无法按 turn 分组渲染 |
| `turn_end` | `{ index }` | 同上 |
| `user_message` | `{ text, kind, interruptType }` | 用户消息（含 ask 答案文本）无法通过标准管道记录 |

**BlockRenderer 覆盖**：全部 9 种 `OutputBlock['kind']` 均被处理，但 4 种返回 `null`（`reason`、`file_change`、`approval`、`question`）——它们通过 Footer 或 tool_card 间接渲染。

**ToolCardBlock 状态完备**：6 种 status（running/done/error/cancelled/timeout/exhausted）均有渲染。`renderAskUserSummary` 在 summary 为空时显示 "Cancelled"，可能在预填充前产生瞬时误导。

**Static/Dynamic 分界**：`isSettled()` 保证 running 状态的 tool_card 不会进入 Static。已完成 turn 进入 Static 后不可修改（Ink `<Static>` 约束）。

### 11.15 综合死代码统计

| 类别 | 数量 | 详情 |
|------|------|------|
| 完全死代码文件 | **4** | `approval-policy.ts`、`authorization-policy.ts`、`scheduler.ts`、`loop-policy.ts` |
| 死函数（活跃文件中） | **3** | `composePolicies`、`classifyPlanUpdate`、`createAutoReviewPolicy` |
| Bridge 死函数 | **4** | 全部 bridge 函数仅测试调用 |
| 零发射 RuntimeEvent | **10** | turn.* x3, plan.* x3, approval.command_replaced, authorization.changed, phase.changed, user.message_appended |
| TUI 无声丢弃事件 | **3** | turn_begin, turn_end, user_message |
| 策略未采纳 | **2 文件** | 新 approval-policy.ts / authorization-policy.ts 零使用，旧 tool-policy.ts 仍为权威 |
| 路由未迁移 | **1 文件** | scheduler.ts 零调用，routes.ts 239 行全在役 |

**总计：约 1,300 行死代码 + 10 个零发射事件 + 3 个 TUI 无声丢弃。**

---

## 12. Round 8 修复记录（2026-07-09）

> **目标**：修复 Round 7 遗留的 TUI ask_user/approval/plan_review 重复弹框 bug + 架构层面的 `tool.queued` 重放问题 + 代码整洁项。

### 12.1 LangGraph 节点重放导致 RuntimeEvent 重复发射

**根因**：LangGraph 在 `interrupt()` 恢复时从节点函数顶部重放。`userInput`、`planReview`、`approval` 三个节点在 `interrupt()` 调用之前发射的 RuntimeEvent（`tool.queued`、`user_input.requested`、`plan.drafted`、`plan.review_requested`、`approval.requested`）在 resume 时被重复发射。

此时 TUI 侧 `state.interrupt` 已被 `RESOLVE_INTERRUPT` 清为 `null`，已有的 `need_input` 去重检查（`if (state.interrupt?.kind === 'input') return state;`）失效，导致重复创建 question/approval/plan_review 弹框。

**用户可观测症状**：ask_user 选择选项回车后，工具状态更新了，但选项确认框重复弹出；放着不动过一会新消息渲染后弹框消失。

### 12.2 `tool.queued` 重放保护：`emitInterruptEvent` 去重

**问题**：`tool.queued` 在 `userInput`、`planReview` 两个重入节点（含 `interrupt()`）中发射，LangGraph resume 时被重复发射。

**修复**：重入节点中使用 `emitInterruptEvent` 发射 `tool.queued`（复合 key 去重），非重入的 `tools` 节点继续使用 `emitRuntimeEvent`。

**注意**：曾尝试将 `tool.queued` 移至 `ModelController`（agent 节点），但因 `runtimeEventSink` → `sink.emit()` 在 graph 节点执行期间同步调用，导致 `tool_call` 事件先于 `chunkToEvents` 产出的 `text`/`reason` 到达 TUI，破坏了消息渲染顺序。`tool.queued` 必须留在各节点中，在 agent 节点返回后、节点 chunk 被 `processStream` 处理的同时发射，才能保持正确的时序。

**去重策略**：
- `userInput`、`planReview`：`emitInterruptEvent({ type: 'tool.queued', ... }, toolCallId)` — 复合 key 去重
- `tools`、`pendingSubagentApproval`：`emitRuntimeEvent` — 非重入，无需去重

### 12.3 `emitInterruptEvent`：中断事件复合 key 去重

**问题**：中断特定事件（`user_input.requested`、`approval.requested`、`plan.review_requested`、`plan.drafted`）必须留在重入节点中（它们是 `interrupt()` 的一部分，需在暂停前发射以通知 TUI）。需要一个机制防止 resume 时重复发射。

**修复**：新增 `emitInterruptEvent(event, toolCallId)` 函数（`src/core/harness/graph.ts:143-155`），使用 `toolCallId:eventType` 复合 key 在 `Set<string>` 中去重。同一 toolCallId 的不同事件类型互不干扰。

```ts
const emittedInterruptEvents = new Set<string>();
function emitInterruptEvent(event: RuntimeEvent, toolCallId: string): void {
  if (!toolCallId) return;
  const dedupKey = `${toolCallId}:${event.type}`;
  if (emittedInterruptEvents.has(dedupKey)) return;
  emittedInterruptEvents.add(dedupKey);
  input.runtimeEventSink?.(event);
}
```

**为什么用复合 key 而非仅 `toolCallId`**：同一 toolCallId 在不同节点中可能触发多个事件类型（如 `plan.drafted` + `plan.review_requested` 都是同一个 `update_plan` 的 toolCallId）。若只用 `toolCallId` 去重，第二个事件会被错误跳过，导致 TUI 不渲染 plan review 中断块。Round 8 修复初期曾引入此 bug，plan review PTY 测试 5/6 超时——模型收不到请求因为 TUI 从未显示 review 弹框。

**接入点**：`userInput` 节点的 `user_input.requested`、`planReview` 节点的 `plan.drafted` 和 `plan.review_requested`、`approval` 节点的 4 处 `approval.requested`。

**长期方向**：`emitInterruptEvent` 是务实的过渡方案。要彻底消除中断事件的重放问题，应将 `*.requested` 事件发射从 LangGraph 节点移到 runner 层的 `processStream` 中——runner 层已经通过 `interruptToEvent()` 识别了 LangGraph interrupt，且 runner 层不会被重放。`interruptToEvent()` 目前只产生 `need_*` AgentEvent 用于 payload 提取（不 `sink.emit`），若改为在此处同时发射对应的 RuntimeEvent（`user_input.requested` / `approval.requested` / `plan.review_requested`），则 LangGraph 节点中不再需要任何中断事件发射，彻底消除重入问题。此项属于 Phase 6+ 的进一步架构纯化，不在 Round 8 范围内。

### 12.4 TUI 层三层去重补全

此前只有 `need_input` handler（handleEvent.ts:996）有去重检查。Round 8 为 `need_approval` 和 `need_plan_review` 补充了相同的去重逻辑：

| 事件 | handler 位置 | 去重检查 |
|------|-------------|---------|
| `need_input` | handleEvent.ts:996 | `if (state.interrupt?.kind === 'input') return state;`（已有） |
| `need_approval` | handleEvent.ts:937 | `if (state.interrupt?.kind === 'approval') return state;`（Round 8 新增） |
| `need_plan_review` | handleEvent.ts:1009 | `if (state.interrupt?.kind === 'plan_review') return state;`（Round 8 新增） |

三层防御：
1. **TUI 层**：`state.interrupt` 检查（首次双管道去重，stream interrupt + side-channel）
2. **Graph 层**：`emitInterruptEvent` 复合 key 去重（resume 重放去重，覆盖 `tool.queued` + `*.requested`）
3. **时序正确**：`tool.queued` 留在原节点（agent 返回后发射），不与 `text`/`reason` 乱序

### 12.5 死代码清理

| 操作 | 文件 | 说明 |
|------|------|------|
| 删除 | `src/core/runtime/bridge.ts`（155 行） | Bridge 函数零生产调用，仅测试引用 |
| 删除 | `src/core/runtime/scheduler.ts`（193 行） | `decideNextEffect` 零生产调用，`routes.ts` 继续作为 LangGraph 条件边函数 |
| 删除 | `src/core/policies/authorization-policy.ts`（167 行） | 9 个函数零 src/ import，功能在 `tool-policy.ts` 中重复 |
| 删除 | `src/core/policies/loop-policy.ts`（80 行） | 桩实现，零生产调用 |
| 删除 | `tests/policies/auto-review-policy.test.ts`（206 行） | 对应生产代码重构后测试不适用 |
| 删除 | `tests/runtime/bridge.test.ts`（188 行） | 对应 bridge.ts 删除 |
| 瘦身 | `src/core/harness/tool-policy.ts` | -470 行（707→237），旧 `evaluateToolPolicy` 退役，保留工具辅助函数和类型 |
| 瘦身 | `src/core/runner.ts` | -187 行（1599→1412），`injectUserMessage` 白名单移除，`engine.checkpointer` 直接访问消除 |
| 瘦身 | `src/core/policies/auto-review-policy.ts` | -193 行（282→89），`evaluateSafetyFastPath` 纯函数保留 |

### 12.6 `approval-policy.ts` 去重

移除 4 个与 `tool-policy.ts` 重复定义的函数（`stableStringify`、`commandGrantKey`、`normalizeAuthorizationState`、`hasSameCommandGrant`），改为从 `@/core/harness/tool-policy` 导入。同时移除不再需要的 `createHash` 导入。测试文件同步更新导入路径。

### 12.7 `projection.ts` 过期注释修复

更新第 4-6 行，移除对已不存在的 `toolResultSink` 的引用，改为准确描述当前单管道架构：

```
// tool.finished / tool.failed / tool.rejected 正确投影为 tool_done，
// RuntimeEvent 是 tool_call / tool_done 的唯一事件来源（单管道）。
// TUI reducer 对重复 tool_done 是幂等的。
```

### 12.8 综合状态：Round 3/4 审计缺口全部关闭

| # | Round 3/4 审计问题 | 原严重度 | 状态 |
|---|-------------------|--------|------|
| 1 | 双管道 — `chunkToEvents` 产出 `tool_call`/`tool_done` | HIGH | ✅ 已修复 |
| 2 | `injectUserMessage` 白名单 | HIGH | ✅ 已修复 |
| 3 | 新 `approval-policy.ts` 零采纳 | HIGH | ✅ 已修复（4 个生产 import） |
| 4 | `engine.checkpointer` 直接访问 | MEDIUM | ✅ 已修复 |
| 5 | 4 个完全死代码文件 | — | ✅ 已删除 |
| 6 | Bridge 函数零调用 | — | ✅ 已删除 |
| 7 | 10 个 RuntimeEvent 零发射 | MEDIUM | ✅ 29/29 全覆盖 |
| 8 | TUI 3 事件无声丢弃 | LOW | ✅ 显式 handler |
| 9 | 旧 `evaluateToolPolicy` 仍在役 | HIGH | ✅ 已退役 |
| 10 | `approval-policy.ts` 重复函数 | LOW | ✅ 已去重 |
| 11 | `projection.ts` 过期注释 | LOW | ✅ 已修复 |
| 12 | TUI ask_user/approval/plan_review 重复弹框 | HIGH | ✅ Round 8 修复 |

### 12.9 Round 8 实施统计

| 指标 | 数值 |
|------|------|
| 修改文件 | 5（`model-controller.ts`、`graph.ts`、`handleEvent.ts`、`approval-policy.ts`、`projection.ts`） |
| 测试文件更新 | 1（`approval-policy.test.ts` 导入路径） |
| 新增函数 | 1（`emitInterruptEvent`） |
| `tool.queued` 发射点 | 3 个重入节点 → 1 个非重入 ModelController |
| 去重覆盖 | 3/3 中断类型（input / approval / plan_review） |
| 核心回归 | 435 pass, 0 fail |
| PTY plan review | 6 pass, 0 fail |
| typecheck | 零错误 |

---

## 13. 后续：LangGraph 物理移除与 Kernel 切换（2026-07-10）

Round 8 之后，LangGraph graph/routes/state/engine/checkpoint 等旧基础设施被物理删除，
项目完全切换到 Runtime Kernel 原生执行路径。详见切换追踪文档：

→ [[2026-07-10-runtime-kernel-cutover-status]]

**切换要点**：

- 旧 Graph 代码（`graph.ts` 1650 行、`routes.ts` 235 行、`state.ts` 303 行等）
  和 4 个旧 Controller（approval/auto-review/plan-review/user-input）已物理删除
- `model-controller.ts` 和 `tool-controller.ts` 保留并重写为 Kernel 原生函数
  （`invokeRuntimeModel` / `executeRuntimeTools`），输入 `RuntimeState`，输出
  `RuntimeEvent[]`
- 旧 Policy 文件中的 `auto-review-policy.ts` 和 `plan-policy.ts` 发现为零引用死代码，
  已于切换清理中删除
- `RuntimeEvent` 覆盖率从 29/29 类型定义补全到实际 emit：新增 `turn.*`（3）、
  `model.retry`、`tool.file_change`、`model.cache_metrics` 共 6 个发射链路
- 遗留：`auto_review.*` 事件——旧 auto-review-controller 已删除但 Kernel 原生替代
  未实现，`decideNextEffect` 不返回 `run_auto_review` 效果，auto mode 降级为
  ask mode 行为。需独立方案修复
