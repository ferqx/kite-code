# Plan-Review-Approve：为 update_plan 增加用户审查中断

创建日期：2026-06-16
状态：draft
优先级：P1
依赖：无
替代/分叉：无

## 目标

复刻 EnterPlanMode 的核心行为：agent 调用 `update_plan` 提出计划 → 暂停 → 用户审查 → 批准/拒绝 → agent 继续或修改计划。

### 现状

`update_plan` 只是数据持久化工具（`{ ok: true, plan: {...} }`），agent 调用后继续执行，无中断。路由 `agent → tools → agent`，工具策略中标记为 `requiresApproval: false`。

### 期望

`update_plan` 调用后触发中断，用户审查计划后才继续。agent 被拒绝后收到失败信号，可修改计划重新提交。

### 不可复刻的 EnterPlanMode 能力

- 系统提示词动态注入（需 host process）
- 权限模式切换（只读/读写）

### 可复刻

- plan → review → approve → execute 工作流
- 用户审批权
- plan 在 UI 中可视化展示

## 架构：复用中断基础设施

OpenPX 已有 `tool_approval` 和 `user_input` 两种中断，贯穿三层：

```
graph.ts: interrupt()
  → runner.ts: 检测中断 → 创建 AgentEvent → provider.requestAction() 阻塞
  → TUI reducer: 创建 OutputBlock → 设置 interrupt state
  → App.tsx: 渲染 Block 组件 → 用户操作
  → provider.submitAction() → runner 恢复 → graph 继续
```

本方案新增第三种中断 `plan_review`，完全复用此模式。

关键设计决策：**`update_plan` 走独立 `plan_review` 节点，不复用 approval**。
- `approval`：安全层判断（策略合规），涉及 command 替换、grant 策略、批量审批
- `plan_review`：语义层判断（用户期望对齐），只检查和交付 plan 数据
- 分开后各自独立演进，互不干扰

## 步骤

### Step 1：Protocol 层

**文件**：`src/protocol/events.ts`

新增事件类型和 payload（在 `need_input` 之后）：

```typescript
| { type: "need_plan_review"; data: NeedPlanReviewPayload }
```

```typescript
export interface NeedPlanReviewPayload {
  plan: AgentPlan;
}
```

**文件**：`src/protocol/actions.ts`

`InterruptPayload` 联合体增加：

```typescript
| { kind: "plan_review"; plan: AgentPlan }
```

`UserAction` 联合体增加：

```typescript
| { type: "approve_plan" }
```

**验证**：`bun run typecheck`

### Step 2：Core 层

**文件**：`src/core/harness/routes.ts`

1. `resolveToolRoute()` 返回类型增加 `"plan_review"`
2. 在 `ask_user` 检查前插入 `update_plan` 检查：
   ```typescript
   if (request.name === "update_plan") return "plan_review";
   ```
3. `routeEntry()` 和 `routeAfterAgent()` 返回类型增加 `"plan_review"`
4. 新增 `routeAfterPlanReview()`：
   ```typescript
   export function routeAfterPlanReview(_state: CodeAgentState): "agent" {
     return "agent";
   }
   ```

**文件**：`src/core/harness/graph.ts`

1. 新增 `planReview` 节点：
   ```typescript
   const planReview = async (state: CodeAgentState) => {
     const request = getPendingToolRequest(state.messages, state.workspace);
     if (!request || request.name !== "update_plan") return {};

     const planArgs = request.args as {
       name: string; description: string; status: string;
       steps: { step: string; status: string }[];
     };
     const plan: AgentPlan = {
       name: planArgs.name,
       description: planArgs.description,
       status: (planArgs.status as PlanStatus) ?? "pending",
       steps: (planArgs.steps ?? []).map(s => ({
         step: s.step, status: (s.status as PlanStatus) ?? "pending",
       })),
     };

     const resume = interrupt({
       kind: "plan_review",
       plan,
     }) as AgentResumeValue;

     const approved =
       resume === true ||
       (typeof resume === "object" && resume !== null &&
        "planApproved" in resume && (resume as { planApproved?: boolean }).planApproved === true);

     if (approved) {
       return {
         messages: [
           new ToolMessage({
             content: JSON.stringify({ ok: true, plan }),
             tool_call_id: request.id ?? "missing-tool-call-id",
             name: "update_plan", status: "success",
           }),
         ],
         plan,
       };
     }
     return rejectedToolMessage(request, "plan rejected by user");
   };
   ```

   新增导入：`AgentPlan`、`PlanStatus`（从 `@/protocol/events`）

2. 图中注册节点 + 条件边：
   ```typescript
   .addNode("plan_review", planReview)
   .addConditionalEdges("plan_review", routeAfterPlanReview)
   ```
   从 `./routes` 导入 `routeAfterPlanReview`

3. 图拓扑更新为：
   ```
   START → cleanup → [routeEntry] → agent / approval / tools / user_input / plan_review
   agent → [routeAfterAgent] → END / approval / tools / user_input / plan_review
   plan_review → [routeAfterPlanReview] → agent
   ```

**文件**：`src/core/runner.ts`

1. `interruptToEvent()` — 新增分支：
   ```typescript
   if (v.kind === "plan_review") {
     const plan = v.plan as Record<string, unknown> | undefined;
     if (plan && typeof plan === "object") {
       return {
         type: "need_plan_review",
         data: {
           plan: {
             name: plan.name as string,
             description: plan.description as string,
             status: plan.status as string,
             steps: (plan.steps as Array<Record<string, unknown>> | undefined)?.map(s => ({
               step: s.step as string, status: s.status as string,
             })) ?? [],
           } as AgentPlan,
         },
       };
     }
   }
   ```

2. `eventToInterruptPayload()` — 返回类型增加 `plan_review`，新增映射：
   ```typescript
   if (event.type === "need_plan_review") return { kind: "plan_review", plan: event.data.plan };
   ```

3. `mapActionToResumeValue()` — 新增 case：
   ```typescript
   case "approve_plan": return { planApproved: true };
   ```
   现有 `"reject"` → `{ approved: false }` 和 `"cancel"` → `{ approved: false }` 可复用（不通过 planReview 的批准检查）

**验证**：`bun test tests/graph.test.ts` `bun test tests/runner.test.ts`

### Step 3：TUI 层

**文件**：`src/app/tui/types.ts`

1. `InterruptState.kind` 增加 `"plan_review"`
2. `OutputBlock` 联合体增加：
   ```typescript
   | { id: number; kind: "plan_review"; plan: AgentPlan; resolved?: { action: string } }
   ```
   新增 `AgentPlan` 导入（from `@/protocol/events`）

**文件**：`src/app/tui/reducers/handleEvent.ts`

在 `need_input` case 之后新增：
```typescript
case "need_plan_review": {
  const finalized = finalizeLastTurnStreaming(state);
  const block: OutputBlock = { id: finalized.nextBlockId, kind: "plan_review", plan: event.data.plan };
  return { ...appendBlock(finalized, block), interrupt: { kind: "plan_review", blockId: block.id } };
}
```

**文件**：`src/app/tui/reducers/agentReducer.ts`

1. `cancelInterrupt()` — 新增分支：
   ```typescript
   } else if (b.kind === "plan_review") {
     next = replaceBlockById(next, b.id, { ...b, resolved: { action: "cancelled" } });
   }
   ```

2. `RESOLVE_INTERRUPT` — guard 条件增加 `"plan_review"`，新增分支：
   ```typescript
   } else if (b.kind === "plan_review") {
     if (typeof action.resolution !== "string") return state;
     resolved = { ...b, resolved: { action: action.resolution } };
   }
   ```

3. `ESCAPE` — 新增分支：
   ```typescript
   } else if (b.kind === "plan_review") {
     return { ...replaceBlockById(state, b.id, { ...b, resolved: { action: "cancelled" } }), interrupt: null };
   }
   ```

**新文件**：`src/app/tui/components/PlanReviewBlock.tsx`

参照 `ApprovalBlock` 模式：
- Props：`plan: AgentPlan`、`provider: TuiUserInputProvider`、`onResolved: (action: string) => void`
- 渲染：plan 名称（bold）、状态（color-coded）、描述（muted）、步骤列表（带图标：✓ ▶ ○）
- 键盘：`Enter` → `provider.submitAction({ type: "approve_plan" })` + `onResolved("approved")`；`Esc` → `provider.submitAction({ type: "cancel" })` + `onResolved("cancelled")`
- 底部提示：`[Enter] Approve  [Esc] Reject`

**文件**：`src/app/tui/App.tsx`

1. 新增导入 `PlanReviewBlock`
2. 新增 callback：
   ```typescript
   const resolvePlanReview = useCallback(
     (action: string) => {
       if (!interruptBlock) return;
       dispatch({ type: "RESOLVE_INTERRUPT", blockId: interruptBlock.id, resolution: action });
     },
     [dispatch, interruptBlock],
   );
   ```
3. Footer 中增加（在 `question` 块之后）：
   ```tsx
   {interruptBlock?.kind === "plan_review" && !interruptBlock.resolved && (
     <PlanReviewBlock plan={interruptBlock.plan} provider={provider} onResolved={resolvePlanReview} />
   )}
   ```

**验证**：`bun test tests/tui-reducer.test.ts` `bun test tests/tui-layout.test.tsx`

### Step 4：系统提示词 + 契约

**文件**：`src/core/prompts/system-prompt.txt`

更新第 3 步描述（Plan complex work...），改为：
```
3. For complex multi-step work, first call update_plan. Your plan will be
   shown to the user for review. If approved, proceed. If rejected, you'll
   see a rejection error — then revise the plan or continue with a simpler
   approach. For simple single-step tasks, execute directly without a plan.
```

**文件**：`src/core/tools/tool-contracts.ts`

`update_plan` 的 `whenToUse` 章节补充一行：
```
- The plan will be shown to the user for approval before execution begins.
```

### Step 5：测试

| 文件 | 新增测试 |
|------|---------|
| `tests/graph.test.ts` | `update_plan` 路由到 `plan_review`；中断返回 `plan_review`；批准恢复 → success ToolMessage；拒绝恢复 → error ToolMessage |
| `tests/runner.test.ts` | `interruptToEvent` 处理 `plan_review`；`eventToInterruptPayload` 映射；`mapActionToResumeValue` 映射 `approve_plan` |
| `tests/tui-reducer.test.ts` | `need_plan_review` 事件 → `plan_review` block + interrupt；`RESOLVE_INTERRUPT` + `ESCAPE` 处理 |
| `tests/tui-layout.test.tsx` | `PlanReviewBlock` 渲染 plan 名称/步骤/快捷键 |

### Step 6：验证

```bash
bun run typecheck
bun test tests/graph.test.ts
bun test tests/runner.test.ts
bun test tests/tui-reducer.test.ts
bun test tests/tui-layout.test.tsx
bun run tui  # 手动：agent 提 plan → PlanReviewBlock → 批准/拒绝 → agent 继续/修改
```

## 改动文件清单（12 个）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/protocol/events.ts` | 编辑 | 新增 `need_plan_review` 事件 + `NeedPlanReviewPayload` |
| `src/protocol/actions.ts` | 编辑 | 新增 `plan_review` 中断 + `approve_plan` action |
| `src/core/harness/routes.ts` | 编辑 | 新增 plan_review 路由 + 返回类型更新 |
| `src/core/harness/graph.ts` | 编辑 | 新增 `planReview` 节点 |
| `src/core/runner.ts` | 编辑 | 新增 plan_review 中断处理 + 事件/负载映射 |
| `src/app/tui/types.ts` | 编辑 | `InterruptState` + `OutputBlock` 增加 `plan_review` |
| `src/app/tui/reducers/handleEvent.ts` | 编辑 | 新增 `need_plan_review` 事件处理 |
| `src/app/tui/reducers/agentReducer.ts` | 编辑 | `cancelInterrupt`/`RESOLVE_INTERRUPT`/`ESCAPE` 增加 plan_review |
| `src/app/tui/components/PlanReviewBlock.tsx` | **新建** | plan review 交互组件 |
| `src/app/tui/App.tsx` | 编辑 | 渲染 `PlanReviewBlock` |
| `src/core/prompts/system-prompt.txt` | 编辑 | 更新 plan 工作流描述 |
| `src/core/tools/tool-contracts.ts` | 编辑 | 更新 `update_plan` 契约 |

## 流程示意

```
agent 调用 update_plan
  → routes.ts: resolveToolRoute() 返回 "plan_review"（request.name === "update_plan"）
  → graph.ts: planReview 节点 → interrupt({ kind: "plan_review", plan })
  → runner.ts: interruptToEvent() → need_plan_review → provider.requestAction() 阻塞
  → TUI: handleEvent → plan_review block + interrupt state
  → App.tsx: Footer 渲染 PlanReviewBlock

  ┌─ 用户 Enter → provider.submitAction({ type: "approve_plan" })
  │   runner: resume = { planApproved: true }
  │   planReview: 返回 success ToolMessage + { plan }
  │   routeAfterPlanReview → agent 继续执行
  │
  └─ 用户 Esc → provider.submitAction({ type: "cancel" })
      runner: resume = { approved: false }
      planReview: 返回 error ToolMessage（rejectedToolMessage）
      routeAfterPlanReview → agent 收到拒绝，可修改 plan
```
