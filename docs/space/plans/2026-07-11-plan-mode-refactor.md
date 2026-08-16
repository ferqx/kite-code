# Plan Mode 重构：三工具职责分离

状态：archived（Plan Artifact 生命周期已实施；当前规则见 `docs/active/plan-mode-implementation.md`）
优先级：P0
依赖：`2026-07-08-agent-kernel-incremental-evolution.md`（Runtime Kernel 已切到主循环，Kernel + Store + Reducer + Scheduler 已就位）
替代：[Plan Mode 原始方案](plan-mode-design.md)、[当前 Plan Mode 实现](../../active/plan-mode-implementation.md) — 本方案替换其中 `update_plan` 单工具设计
关联：[Plan Review 中断计划](2026-06-16-plan-review-interrupt.md)（已归档）

---

## 目标

将 Plan 能力从当前 `update_plan` 单工具「万能槽」重构为三个边界明确的工具，让 Runtime Kernel 强制状态转换，消除模型「猜测当前语义」的控制流反模式。

**核心变更**：一个 `update_plan` 同时承担方案编写、提交审核、修订、进度更新和完成标记 → 拆为 `write_plan`（保存草稿，不触发审核）、`exit_plan_mode`（唯一 plan-review 中断点）、`update_plan`（批准后仅更新执行进度）。

对齐 Claude Code 当前公开的 Plan 模式交互行为：Plan 模式下只允许研究和提出方案；审批时可选择 Auto / Accept Edits / Manual，也可携带反馈继续规划；支持 `Ctrl+G` 编辑方案；可选审批前清理规划上下文。

---

## 范围

涉及文件（按提交批次分组）：

**第一组 — 协议和状态**：`src/protocol/events.ts`、`src/protocol/actions.ts`、`src/core/runtime/state.ts`

**第二组 — 事件和 Reducer**：`src/core/runtime/events.ts`、`src/core/runtime/reducer.ts`

**第三组 — 工具定义与控制器**：`src/core/tools/definitions.ts`、`src/core/tools/tool-contracts.ts`、`src/core/controllers/tool-controller.ts`

**第四组 — 调度和原子持久化**：`src/core/runtime/scheduler.ts`、`src/core/runtime/actions.ts`、`src/core/runtime/kernel.ts`、`src/core/runtime/store.ts`

**第五组 — 权限策略**：`src/core/policies/mode-policy.ts`、`src/core/policies/approval-policy.ts`

**第六组 — TUI 和 CLI**：`src/app/tui/components/PlanReviewBlock.tsx`、`src/app/tui/components/TaskProgressBlock.tsx`、`src/app/tui/App.tsx`、`src/app/tui/provider.ts`、`src/app/tui/run-agent.ts`、`src/app/tui/replay-blocks.ts`、`src/app/tui/hooks/usePlanEditor.ts`（新增）、`src/app/cli/index.ts`

**第七组 — 模型上下文和 Prompt**：`src/core/model/runtime-context.ts`、`src/core/model/context.ts`、`src/core/tools/tool-contracts.ts`

**第八组 — 旧 harness 清理**：`src/core/harness/tool-runner.ts`、`src/core/harness/tool-requests.ts`、`src/core/harness/tool-result.ts`、`src/core/harness/routes.ts` — 这些文件中 `update_plan` 相关的旧分支，在 Runtime Kernel 全面接管后成为死代码，直接删除

**测试**：`tests/runtime/plan-state.test.ts`（新增）、`tests/runtime/plan-tools.test.ts`（新增）、`tests/runtime/plan-actions.test.ts`（新增）、`tests/runtime/tool-barrier.test.ts`（新增）、`tests/runtime/plan-persistence.test.ts`（新增）、`tests/runtime/plan-transcript.test.ts`（新增）、`tests/tui-system/scenarios/plan-review.test.ts`（扩展现有）

---

## 步骤

### Commit 1：Plan 领域模型

**目标**：建立新数据结构和纯状态转换，不接 UI。

#### 1.1 `src/protocol/events.ts` — PlanDocument + PlanningState

替换 `AgentPlan`：

```ts
export interface PlanDocument {
  planId: string;
  version: number;
  title: string;                           // 一行标题，最多 120 字符
  bodyMarkdown: string;                    // 用户审核的主内容
  steps: PlanStep[];                       // 结构稳定的执行步骤
  structuralDigest: string;                // SHA-256，仅对 title/body/step id+title 计算
  createdAtTurnId: string;
  updatedAtTurnId: string;
}

export interface PlanStep {
  id: string;                              // 稳定 ID，如 "inspect-runtime"
  title: string;                           // 一行描述，最多 160 字符
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  note?: string;
}
```

`structuralDigest` 计算规则：

```ts
sha256(JSON.stringify({
  title: normalize(title),
  bodyMarkdown: normalize(bodyMarkdown),
  steps: steps.map(({ id, title }) => ({ id, title: normalize(title) })),
}))
```

执行状态不进入 digest，避免状态更新被误判为结构变化。

新增 `PlanningState` 联合类型，替代独立的 `phase` + `plan`：

```ts
export type PlanningState =
  | { kind: 'building_without_plan' }
  | { kind: 'planning_empty' }
  | { kind: 'planning_draft'; document: PlanDocument; revisionFeedback?: string }
  | { kind: 'awaiting_review'; document: PlanDocument; interactionId: string; exitToolCallId: string }
  | { kind: 'executing'; document: PlanDocument; executionMode: 'manual' | 'accept_edits' | 'auto'; approvedAtTurnId: string }
  | { kind: 'completed'; document: PlanDocument; completedAtTurnId: string }
  | { kind: 'cancelled'; document?: PlanDocument; reason: string; cancelledAtTurnId: string };
```

Phase 通过 selector 推导：

```ts
export function getAgentPhase(state: RuntimeState): AgentPhase {
  switch (state.planning.kind) {
    case 'planning_empty':
    case 'planning_draft':
    case 'awaiting_review':
      return 'planning';
    default:
      return 'building';
  }
}
```

扩展 InteractionMode：

```ts
export const InteractionMode = {
  Ask: 'ask',
  AcceptEdits: 'accept_edits',
  Auto: 'auto',
  Full: 'full',
} as const;
```

映射关系：Plan 审批 Auto → `auto`，Accept Edits → `accept_edits`，Manual → `ask`。**任何 Plan 审批都不能把 authorization.mode 提升成 `full_access`**。

#### 1.2 `src/protocol/actions.ts` — 统一 plan_review_decision

删除 `approve_plan_auto`、`approve_plan_manual`、`supplement_plan`、`reject_plan`，替换为：

```ts
export type RuntimeUserAction =
  | {
      type: 'plan_review_decision';
      interactionId: string;
      planId: string;
      version: number;
      structuralDigest: string;
      decision:
        | { kind: 'approve'; nextMode: 'ask' | 'accept_edits' | 'auto'; clearPlanningContext: boolean }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    }
  | /* 现有非 Plan Action */;
```

`interactionId` 防止回复错中断；`planId + version + digest` 防止批准已被编辑器或其他模型调用替换的旧方案。

#### 1.3 `src/core/runtime/state.ts` — 状态类型落地

- `PlanningState` 替换 `PlanLifecycleState`
- 移除持久化的独立 `phase`
- 增加 `getAgentPhase()` selector
- 增加 `computePlanStructuralDigest()` 纯函数（重命名自 `computePlanStructuralHash`）
- 增加 `runtimeStateSchemaVersion: 2`
- `InteractionState` 中 `awaiting_plan_review` → `awaiting_review`，携带 `planId` + `version` 用于 action 校验

#### 1.4 事件命名统一迁移

| 旧名称 | 新名称 | 说明 |
|--------|--------|------|
| `plan.drafted` | `plan.draft_saved` | 消除与 `plan.review_requested` 的双重版本递增 |
| `plan.rejected` | `plan.cancelled` | 与 `tool.cancelled` 命名对齐 |
| `structuralHash` | `structuralDigest` | 全链路统一：events、state、reducer、工具返回 |
| `awaiting_plan_review`（interaction kind） | `awaiting_review` | 简洁命名，与 `awaiting_user_input`、`awaiting_tool_approval` 对齐 |
| `phase.changed` 事件 | 删除 | phase 由 `PlanningState` 派生，`mode.changed` 接管 mode 切换职责 |

**涉及文件**：`src/protocol/events.ts`、`src/protocol/actions.ts`、`src/core/runtime/state.ts`

**验证**：`bun run typecheck` 零错误

---

### Commit 2：Plan 工具定义与控制器

**目标**：实现 `write_plan`、`exit_plan_mode`、进度版 `update_plan`。

#### 2.1 `src/core/tools/definitions.ts` — 三工具 schema

**`write_plan`** — 保存或替换草稿，不触发用户审核：

```ts
const WRITE_PLAN_SCHEMA = z.object({
  title: z.string().trim().min(1).max(120),
  body_markdown: z.string().trim().min(20).max(30_000),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    title: z.string().trim().min(1).max(160),
  })).min(1).max(12),
  expected_version: z.number().int().positive().optional(),
});
```

返回：`{ ok, plan_id, version, structural_digest, review_required: false }`

**`exit_plan_mode`** — 提交当前已保存草稿，唯一触发 Plan Review：

```ts
const EXIT_PLAN_MODE_SCHEMA = z.object({
  plan_id: z.string().min(1),
  expected_version: z.number().int().positive(),
  expected_digest: z.string().min(1),
});
```

返回值在用户决定前挂起。批准后：`{ decision: "approved", plan_id, version, next_mode, clear_planning_context }`；修订后：`{ decision: "revise", plan_id, version, feedback }`；取消后：`{ decision: "cancelled", plan_id, version, reason }`。

**`update_plan`** — 批准后的进度更新工具：

```ts
const UPDATE_PLAN_SCHEMA = z.object({
  plan_id: z.string().min(1),
  updates: z.array(z.object({
    step_id: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
    note: z.string().trim().max(500).optional(),
  })).min(1).max(12),
  complete_plan: z.boolean().optional(),
});
```

返回：`{ ok, plan_id, updated_steps, plan_completed }`

三个工具始终保持在静态工具列表中，权限由执行层按生命周期强制，不通过动态增删工具实现。

#### 2.2 `src/core/tools/tool-contracts.ts` — 新契约

新增 `WRITE_PLAN_CONTRACT`、`EXIT_PLAN_MODE_CONTRACT`，重写 `UPDATE_PLAN_CONTRACT`。每个契约明确工具的 phase 约束和失败恢复方式。

#### 2.3 `src/core/controllers/tool-controller.ts` — 按工具拆分 handler

不再在一个 `if (request.name === 'update_plan')` 内处理所有语义。拆成：

```ts
handleWritePlan(...): ToolControlResult
handleExitPlanMode(...): ToolControlResult
handlePlanProgressUpdate(...): ToolControlResult
handleAskUser(...): ToolControlResult
handleExecutableTool(...): ToolControlResult
```

每个 handler 返回：

```ts
type ToolControlResult =
  | { kind: 'events'; events: RuntimeEvent[] }
  | { kind: 'interaction'; events: RuntimeEvent[] }
  | { kind: 'rejected'; events: RuntimeEvent[] };
```

**涉及文件**：`src/core/tools/definitions.ts`、`src/core/tools/tool-contracts.ts`、`src/core/controllers/tool-controller.ts`

**验证**：`bun test tests/tool-definitions.test.ts` + `bun run typecheck`

---

### Commit 3：调度和原子持久化

**目标**：完成 interaction barrier、版本校验和事务提交。

#### 3.1 `src/core/runtime/scheduler.ts` — 单工具调度 + interaction barrier

默认一次只调度一个 queued tool：

```ts
const nextToolCallId = state.tools.queue.find(isRunnable);
if (nextToolCallId) {
  return { type: 'run_tools', toolCallIds: [nextToolCallId] };
}
```

给 `ToolQueuedEvent` 增加 `modelMessageId` 和 `ordinal`。

interaction barrier 规则：
1. 严格按模型 tool-call 顺序执行
2. `write_plan` 是普通控制工具，可以继续到下一个调用
3. `exit_plan_mode`、`ask_user`、`approval.requested` 是 interaction barrier
4. 到达 barrier 后，取消同一 model message 后续所有 sibling calls：`tool.cancelled`，reason = `"Cancelled because an earlier tool call opened an interaction."`

不能在用户批准 Plan 后自动执行模型之前已经生成的 `write_file`。

#### 3.2 `src/core/runtime/actions.ts` — 统一校验 + 补齐 tool.finished

- 批准 → 产生 `plan.approved` + `mode.changed` + `tool.finished(exit_plan_mode)`
- 修订 → 产生 `plan.revision_requested` + `tool.finished(exit_plan_mode)`，返回结构化 ToolMessage `{ decision: "revise", feedback: "..." }`
- 取消 → 产生 `plan.cancelled` + `tool.cancelled(exit_plan_mode)`
- 所有决策均校验 `interactionId + planId + version + digest`

#### 3.3 `src/core/runtime/kernel.ts` — processEventBatch

新增批量事件处理：

```ts
processEventBatch(events: RuntimeEvent[]): void {
  const nextState = events.reduce(reduceRuntimeState, this.state);
  this.store.appendEventsAndSnapshot(this.state.session.threadId, events, nextState);
  this.state = nextState;
}
```

Policy 改为每次基于 `state.mode` 纯函数求值，不再仅在 constructor 创建一次。

#### 3.4 `src/core/runtime/store.ts` — 原子写入

新增：

```ts
interface RuntimeStore {
  appendEventsAndSnapshot(threadId: string, events: RuntimeEvent[], nextState: RuntimeState): void;
}
```

实现为一个 SQLite transaction：

```sql
BEGIN;
INSERT INTO runtime_events ...;
INSERT OR REPLACE INTO runtime_snapshots ...;
UPDATE runtime_sessions ...;
COMMIT;
```

增加状态 schema version，加载时执行 snapshot migration。

**涉及文件**：`src/core/runtime/scheduler.ts`、`src/core/runtime/actions.ts`、`src/core/runtime/kernel.ts`、`src/core/runtime/store.ts`

**验证**：`bun test tests/runtime/plan-state.test.ts tests/runtime/plan-tools.test.ts tests/runtime/tool-barrier.test.ts`

---

### Commit 4：Mode 策略

**目标**：加入 `accept_edits`，确保 Plan 审批不提升授权。

#### 4.1 `src/core/policies/mode-policy.ts` — accept_edits 策略

新增 `createAcceptEditsModePolicy()`：

| 操作类型 | 决策 |
|---------|------|
| read | allow |
| plan control | allow |
| workspace file edit | allow |
| safe fs command | allow |
| test/build/execute | approval |
| network | approval |
| vcs mutation | approval |
| destructive | deny |

#### 4.2 `src/core/policies/approval-policy.ts` — 统一决策入口 + 三工具路径

输入增加 `interactionMode: InteractionMode`，最终只保留一个决策入口：

```ts
evaluateToolDecision({ tool, phase, planningState, interactionMode, authorization, sandbox })
```

不允许 Tool Controller 自己重复实现 mode 逻辑。

当前 `approval-policy.ts` 对 `update_plan` 统一返回 `allow`（line 213）。改造后拆为三条路径：

| 工具 | 决策 | 说明 |
|------|------|------|
| `write_plan` | `allow` | 纯控制工具，不触发中断 |
| `exit_plan_mode` | `allow` | approval-policy 放行，由 tool-controller 触发 plan_review interaction |
| `update_plan` | `allow` | 进度更新，不触发中断 |

**涉及文件**：`src/core/policies/mode-policy.ts`、`src/core/policies/approval-policy.ts`、`src/protocol/events.ts`

**验证**：`bun test tests/tool-policy.test.ts`

---

### Commit 5：模型上下文和 Prompt

**目标**：清理 Graph 遗留描述，统一 Plan 工具职责。

#### 5.1 `src/core/model/runtime-context.ts` — 动态状态块

不再出现 `source="graph.mode"`、`source="graph.state.plan"` 等旧标识。

改为单一动态状态块：

```xml
<runtime-state source="runtime.kernel">
phase: planning
interaction_mode: ask
authorization_mode: default

plan:
  lifecycle: planning_draft
  plan_id: plan_01J...
  version: 3
  structural_digest: sha256:...
  revision_feedback: "增加回滚步骤"

policy:
  workspace_mutation_allowed: false
  code_execution_allowed: false
  write_plan_allowed: true
  exit_plan_mode_allowed: true
  update_plan_allowed: false
</runtime-state>
```

执行态：

```xml
<runtime-state source="runtime.kernel">
phase: building
interaction_mode: accept_edits

plan:
  lifecycle: executing
  plan_id: plan_01J...
  version: 3
  steps:
    - inspect-runtime: completed
    - refactor-events: in_progress
    - add-tests: pending
</runtime-state>
```

不要在每轮同时注入完整 Plan Markdown、Approved Plan Summary、完整 steps 和原始 tool result。完整方案已存在于 tool messages 中，动态提醒只保留身份、版本、生命周期和进度。

#### 5.2 `formatPlanStateReminder` 迁移

当前 `runtime-context.ts` 中 `formatPlanStateReminder` 使用 `source="graph.state.plan"` 并直接读取旧 `AgentPlan.name/description/status/steps`（line 168-177）。改为：

- `source` → `"runtime.kernel"`
- 输入类型从 `AgentPlan` → `PlanningState`
- 根据 `planning.kind` 输出不同块：`planning_draft` 输出 lifecycle + plan_id + version + digest；`executing` 输出 lifecycle + plan_id + version + step status 列表

#### 5.3 工具职责描述统一

统一为：

1. 在 planning phase 中先做必要的只读探索
2. 不确定事项由 `ask_user` 一次性询问
3. 使用 `write_plan` 保存草稿
4. 方案尚不成熟时可继续探索并再次 `write_plan`
5. 只有方案完整且准备让用户审核时调用 `exit_plan_mode`
6. 批准后使用 `update_plan` 更新步骤状态
7. `update_plan` 不得用于修改方案结构

工具描述中不使用"first call""before any other tools"等绝对表述。

**涉及文件**：`src/core/model/runtime-context.ts`、`src/core/model/context.ts`、`src/core/tools/tool-contracts.ts`

**验证**：`bun test tests/context.test.ts tests/runtime-context.test.ts`

---

### Commit 6：TUI / CLI

**目标**：加入四选项审批、外部编辑和 clear context。

#### 6.1 `src/app/tui/components/PlanReviewBlock.tsx` — 四选项审批

```
╭─────────────────────────────────────────────────╮
│ Review the plan above and choose:               │
│ ▶ 1. Approve and start in Auto                  │
│   2. Approve and accept edits                    │
│   3. Approve and review manually                 │
│   4. Keep planning with feedback                │
│ ↑↓ select Enter confirm a/e/m/f quick key       │
│ Ctrl+G edit  Esc cancel                         │
╰─────────────────────────────────────────────────╯
```

操作键：`1/a` Auto、`2/e` Accept Edits、`3/m` Manual、`4/f` Feedback、`Ctrl+G` 编辑方案、`Esc` 取消当前审核。

#### 6.2 `src/app/tui/hooks/usePlanEditor.ts`（新增）— 外部编辑

流程：
1. 将当前 Plan Markdown 导出到 RuntimeStore 旁的临时目录（不写入 workspace）
2. 打开 `$VISUAL` 或 `$EDITOR`
3. 编辑器退出后解析文件
4. 使用 `expectedVersion` 保存
5. 若版本冲突，显示冲突提示，不覆盖
6. 保存成功后刷新 Plan Review 卡片

#### 6.3 `src/app/tui/App.tsx` + interaction-mode — Shift+Tab 循环

Shift+Tab 默认循环：`ask → accept_edits → planning → ask`。`auto`、`full` 继续作为显式启用模式，不强制放入默认循环。

#### 6.4 CLI 支持

`a/auto`、`e/accept-edits`、`m/manual`、`f/feedback`、`g/edit`、`c/cancel`。

#### 6.5 规划上下文清理

Plan Review Approval 增加 `clearPlanningContext` 选项。清理时保留 System prompt、原始用户任务、最后一次 `ask_user` 的决定性答案、批准后的 PlanDocument、`exit_plan_mode` 审批结果。清除规划阶段的大量 `read_file` 输出、搜索输出、临时推理文本、被替换的旧 Plan 草稿、旧版本 Plan tool results。

新增 `TranscriptMessage` 类型 `planning_context_boundary`，Compaction 根据该 boundary 生成一次规划摘要，不物理删除所有历史。

#### 6.6 `src/app/tui/provider.ts` — 新 action 转发

`TuiUserInputProvider.requestAction` 当前接收 `approve_plan` / `revise_plan` / `reject_plan` 等 action。改为转发统一 `plan_review_decision`：

```ts
// PlanReviewBlock → provider.requestAction →
// Kernel 接收 { type: 'plan_review_decision', interactionId, planId, version, structuralDigest, decision }
```

#### 6.7 `src/app/tui/replay-blocks.ts` — 会话恢复

当前从 `interrupt.kind === 'plan_review'` 恢复 plan 中断（line 26-27）。`interrupt` 字段需要适配新的 interaction shape：`awaiting_review` 替代 `awaiting_plan_review`，且恢复时需携带 `planId` + `version` + `structuralDigest` 用于重放校验。

同时更新 `src/core/persistence/sessions.ts` 中 `ReplayInterrupt` 类型和 `interaction.kind === 'awaiting_plan_review'` 分支（line 85-86）。

#### 6.8 `src/app/tui/run-agent.ts` — TUI ↔ Kernel 桥接

TUI 侧通过 `run-agent.ts` 桥接 Kernel。plan_review 中断的 resume value 需适配新的 `plan_review_decision` action 格式。`src/core/types.ts` 中 `PlanReviewResumeValue` 也需同步更新。

**涉及文件**：`src/app/tui/components/PlanReviewBlock.tsx`、`src/app/tui/components/TaskProgressBlock.tsx`、`src/app/tui/App.tsx`、`src/app/tui/provider.ts`、`src/app/tui/run-agent.ts`、`src/app/tui/replay-blocks.ts`、`src/app/tui/hooks/usePlanEditor.ts`（新增）、`src/app/cli/index.ts`、`src/core/persistence/sessions.ts`、`src/core/types.ts`、`src/core/runtime/plan-editor.ts`（新增）

**验证**：`bun test tests/tui-system/scenarios/plan-review.test.ts` + `bun run tui` 手动验证

---

### Commit 7：迁移、测试和文档

**目标**：补齐全套测试、存量会话迁移、更新设计文档。

#### 7.1 存量会话迁移

`RUNTIME_STATE_SCHEMA_VERSION = 2`，旧状态迁移规则：

| 旧状态 | 新状态 |
|--------|--------|
| `plan.kind=none + phase=building` | `building_without_plan` |
| `plan.kind=none + phase=planning` | `planning_empty` |
| `drafted` | `planning_draft` |
| `awaiting_review` | `awaiting_review` |
| `approved` | `executing` |
| `building` | `executing` |
| `needs_revision` | `planning_draft + revisionFeedback` |
| `completed` | `completed` |

旧 `AgentPlan` → 新 `PlanDocument` 转换，重复 step ID 追加数字后缀（如 `inspect`、`inspect-2`）。迁移后重新计算 digest，不信任旧 structural hash。

#### 7.2 测试清单

**`tests/runtime/plan-state.test.ts`**（新增）— 状态转换：
- `planning_empty → planning_draft → awaiting_review → executing`
- `awaiting_review → planning_draft(revise)`
- `awaiting_review → cancelled`
- `executing → progress update → completed`
- 验证：一次 `write_plan` 只增加一个 version；`review_requested` 不增加 version；stale version/digest 被拒绝

**`tests/runtime/plan-tools.test.ts`**（新增）— 工具行为：
- `write_plan` 不触发 interrupt；`exit_plan_mode` 触发 interrupt；`update_plan` 不触发 interrupt
- `building` 中 `write_plan` 被拒绝；`planning` 中 `update_plan` 被拒绝
- 结构变更不能伪装成进度更新

**`tests/runtime/plan-actions.test.ts`**（新增）— 审批行为：
- approve auto → mode auto；approve accept edits → mode accept_edits；approve manual → mode ask
- 所有 approve 均不改变 `full_access`
- revise 返回匹配 ToolMessage；cancel 关闭原始 tool call
- 错误 interactionId / plan version / digest 无效果

**`tests/runtime/tool-barrier.test.ts`**（新增）— Interaction barrier：
- 模型一次返回 `[write_plan, exit_plan_mode, write_file]`：`write_plan` 成功 → `exit_plan_mode` 等待审核 → `write_file` 被取消
- 模型一次返回 `[ask_user, exit_plan_mode]`：只出现一个 interaction

**`tests/runtime/plan-persistence.test.ts`**（新增）— 持久化：
- 等待审核时退出进程 → 重新启动后恢复相同 interactionId
- 批准后事件与 snapshot 原子一致
- 外部编辑后旧审批 action 被 version 校验拒绝
- 旧 schema snapshot 能迁移

**`tests/runtime/plan-transcript.test.ts`**（新增）— Transcript 完整性：
- 每个 Plan 决策后验证所有 assistant tool_call 都有且只有一个 tool result
- `sanitizeToolCallPairs` 不删除 Plan 反馈
- 模型能读取 revise feedback

**`tests/tui-system/scenarios/plan-review.test.ts`**（扩展现有）— PTY：
- 四个审核选项、快捷键 a/e/m/f、Ctrl+G 编辑、反馈输入 Esc 返回
- Shift+Tab 无审批退出、重启恢复 review、clear context 选择、窄终端布局

#### 7.4 文档更新

- 更新 `docs/space/execution/active/plan-mode-implementation.md` — 反映新架构
- 更新 `docs/space/plans/plan-mode-design.md` — 标记为 superseded，指向本方案
- 删除文档中"Auto Approval 等于 full_access"的旧描述（旧设计文档曾保留这一过时语义）

**涉及文件**：`src/core/runtime/migrations.ts`（新增）、`tests/runtime/*`（新增）、`tests/tui-system/scenarios/plan-review.test.ts`、`docs/space/execution/active/plan-mode-implementation.md`、`docs/space/plans/plan-mode-design.md`

**验证**：
```bash
bun test tests/runtime/plan-state.test.ts
bun test tests/runtime/plan-tools.test.ts
bun test tests/runtime/plan-actions.test.ts
bun test tests/runtime/tool-barrier.test.ts
bun test tests/runtime/plan-persistence.test.ts
bun test tests/runtime/plan-transcript.test.ts
bun run test:e2e
bun run typecheck
```

---
### Commit 8：旧 harness 清理

**目标**：清理 Runtime Kernel 接管后不再需要的 `update_plan` 旧路径。

#### 8.1 死代码删除

`tool-controller.ts` 在 L78 提前拦截 `update_plan` 并直接 emit 事件，从不调用 `runApprovedTool`。因此 `tool-runner.ts` 中的 `update_plan` 分支是不可达死代码，直接删除：

| 文件 | 行号 | 处理方式 |
|------|------|---------|
| `src/core/harness/tool-runner.ts` | L150-159 | 删除 `if (request.name === 'update_plan')` 分支 — 不可达死代码 |
| `src/core/harness/tool-runner.ts` | L688-689 | 删除 `case 'update_plan'` — 不可达死代码 |

#### 8.2 活跃路径更新

`tool-requests.ts` 的 `toolRequestFromCall` 是所有工具调用的入口（`tool-controller.ts` L61 调用），仍在活跃路径中，需要更新而非删除：

| 文件 | 行号 | 处理方式 |
|------|------|---------|
| `src/core/harness/tool-requests.ts` | L72, L275 | `update_plan` 类型定义 → 扩展为 `write_plan \| exit_plan_mode \| update_plan`；工具识别逻辑更新 |
| `src/core/harness/tool-result.ts` | L30 | 注释 `update_plan 返回的持久化计划` → 更新为新工具名 |
| `src/core/harness/routes.ts` | — | `plan_review` 路由逻辑由 scheduler 替代，删除

#### 8.2 `src/core/model/context.ts` — 清除 Graph 遗留

当前 `context.ts` 仍直接读取 `state.phase`、`state.plan`、`state.planReviewed`（line 291-305），并注入 `formatPlanStateReminder`。改为从 `state.planning` 派生，且 `formatPlanStateReminder` 移至 `runtime-context.ts` 统一管理。

`context.ts` 只保留静态 System Prompt 拼接，动态状态注入全部走 `runtime-context.ts` 的 `<runtime-state source="runtime.kernel">` 块。

**涉及文件**：`src/core/harness/tool-runner.ts`、`src/core/harness/tool-requests.ts`、`src/core/harness/tool-result.ts`、`src/core/harness/routes.ts`、`src/core/model/context.ts`

**验证**：`bun run typecheck` + `bun test tests/context.test.ts`

---

## 风险

| 风险 | 缓解 |
|------|------|
| 存量 checkpoint 中 `state.plan` 结构与新 `PlanningState` 不兼容 | 提供 schema migration（Commit 7），加载旧快照时自动转换；项目未发布生产版本，无外部用户存量，旧 `update_plan` tool call 可直接丢弃不兼容 |
| `PlanningState` 联合类型替换独立 `phase + plan` 后，消费端 `state.phase` 引用需要全量更新 | Commit 1 提供 `getAgentPhase()` selector，各消费端渐进迁移；类型系统会在编译期捕获遗漏 |
| Interaction barrier 取消 sibling tool calls 可能让模型困惑（模型预期所有调用都执行） | 每个被取消的调用注入 `tool.cancelled` 事件 + ToolMessage 说明原因，模型可从 transcript 中看到取消原因并调整后续行为 |
| `accept_edits` 新模式需要在 tool-policy 全链路中正确传播 | Commit 4 统一决策入口 `evaluateToolDecision()`，所有工具审批走同一路径；PTY 测试覆盖 accept_edits 下各类工具行为 |
| 旧 `update_plan` schema 的 prompt cache 残留可能导致模型误调用 | Commit 5 更新 tool description，旧 schema 直接从工具列表中移除，模型不会再看到旧定义 |
| Runtime Kernel 的 `processEventBatch` 需要 SQLite transaction 支持，当前 `appendEvents` 为逐条写入 | Commit 3 新增 `appendEventsAndSnapshot` API，实现为单事务批量写入；保留旧 `appendEvents` 给非 Plan 场景使用 |
| 会话恢复路径（`replay-blocks.ts`、`sessions.ts`）依赖旧 `interrupt.kind === 'plan_review'` 和旧 `interaction.kind === 'awaiting_plan_review'`，改造后旧 checkpoint 无法恢复 plan_review 中断 | Commit 6 端口恢复逻辑，同时 Commit 7 的 migration 转换旧 interaction shape；中断恢复失败时降级为清除中断、保持当前状态继续 |
| `context.ts` 直接读取 `state.phase`、`state.plan`、`state.planReviewed`，与新的 `state.planning` 联合类型不兼容 | Commit 8 将动态状态注入全部收敛到 `runtime-context.ts`，`context.ts` 不再直接访问这些字段 |
| 旧 harness 中 `tool-runner.ts`、`tool-requests.ts` 仍有 `update_plan` 相关代码，需确认是否与新工具控制器冲突 | `tool-runner.ts` 的 `update_plan` 分支（L150、L688）已被 `tool-controller.ts` 在 L78 提前拦截，实际不可达，是死代码直接删除；`tool-requests.ts` 在活跃路径中（`toolRequestFromCall` 处理所有工具调用），需要更新以识别新工具名称 `write_plan`/`exit_plan_mode`；`tool-result.ts` 注释需同步更新 |

---

## 验收标准

改造完成后必须同时满足：

1. Planning 状态下任何 workspace mutation 都由执行层硬拒绝
2. `write_plan` 永不触发用户中断
3. 只有 `exit_plan_mode` 能触发 Plan Review
4. 一个内容版本只递增一次
5. 审批 action 必须校验 interaction、plan ID、version 和 digest
6. Approve Auto 切换到 `auto`，但不授予 `full_access`
7. Approve Accept Edits 仅自动批准工作区文件修改
8. Approve Manual 切换到 `ask`
9. Revision Feedback 必须通过匹配的 ToolMessage 返回模型
10. `update_plan` 只更新稳定 step ID，不触发审核
11. 每个模型 tool call 最终恰好对应一个 tool result
12. 一次只能存在一个用户 interaction
13. Plan 审批事件和 snapshot 必须原子持久化
14. 进程重启后能恢复待审核的相同 Plan 版本
15. `Ctrl+G` 修改后，旧审核页面不能批准旧版本
16. 动态 runtime context 不再出现 `graph.mode` 等旧标识
17. 静态工具列表保持稳定，不因 phase 改变而破坏 provider prompt cache
18. 旧 checkpoint 中 `AgentPlan` 结构能迁移到 `PlanningState`，旧 `update_plan` 工具定义直接移除

---

## 附录：每种审批决定的事件序列

### Approve Auto

```
plan.approved(nextMode=auto)
mode.changed(ask|accept_edits → auto)
tool.finished(exit_plan_mode, decision=approved)
```

Reducer 最终状态：`planning.kind = 'executing'`，`executionMode = 'auto'`，`mode = 'auto'`，`interactions.kind = 'idle'`。不修改 `authorization.mode`、`authorization.commandGrants`。

### Approve Accept Edits

```
plan.approved(nextMode=accept_edits)
mode.changed(previous → accept_edits)
tool.finished(exit_plan_mode, decision=approved)
```

### Approve Manual

```
plan.approved(nextMode=ask)
mode.changed(previous → ask)
tool.finished(exit_plan_mode, decision=approved)
```

### Keep Planning (feedback)

```
plan.revision_requested(feedback)
tool.finished(exit_plan_mode, content={ decision: "revise", feedback: "..." })
```

Reducer：`awaiting_review → planning_draft`，`interaction → idle`，phase 仍为 planning，document version 不变，revisionFeedback 被记录。下一次 `write_plan` 成功后才增加版本。

### Cancel

区分两个动作：
- **Esc**：取消当前 turn，保留 `planning_draft`，保持 Plan 模式
- **Shift+Tab**：显式离开 Plan 模式，将当前 draft 标记 cancelled/abandoned，取消同一 model message 中未执行的 sibling tool calls，进入 `building_without_plan`
