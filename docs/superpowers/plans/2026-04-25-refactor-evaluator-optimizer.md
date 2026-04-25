# Add Evaluator-Optimizer Reflect Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reflect` node between `tools` and `agent` to make the evaluator-optimizer pattern explicit, move watchdog message injection out of the `tools` node, and improve separation of concerns (execution vs evaluation).

**Architecture:** Insert `reflect` node: `tools → reflect → agent`. The reflect node is deterministic (no LLM call)—it reads `state.progress` from the tools node and decides whether to inject watchdog or failure guidance messages. Move `addWatchdogResult` logic out of `tools` node into `reflect` node.

**Tech Stack:** Bun + TypeScript + LangGraph.js

---

## File Changes Summary

| File | Action | Responsibility |
|------|--------|---------------|
| `src/graph.ts` | Modify | Add `reflect` node, `routeAfterReflect`, update topology, remove `addWatchdogResult` from tools node |
| `tests/graph.test.ts` | Modify | Add reflect node tests, update existing test expectations |

---

### Task 1: Add `routeAfterReflect` and `reflect` node to the graph

**Files:**
- Modify: `src/graph.ts:273-293` (graph builder section)
- Modify: `src/graph.ts:321-327` (routeAfterTools)

- [ ] **Step 1: Add `routeAfterReflect` routing function**

Add after `routeAfterTools` (line 327):

```typescript
/** reflect 节点后的路由逻辑 / Routing after reflect node:
 *  - 有 final -> stop_check / Has final -> stop_check
 *  - 否则 -> agent / Otherwise -> agent
 */
export function routeAfterReflect(state: CodeAgentState): "stop_check" | "agent" {
  return state.final ? "stop_check" : "agent";
}
```

- [ ] **Step 2: Add `reflect` node implementation**

Add inside `buildCodeAgentGraph` function, after the `tools` node (before line 275):

```typescript
/** 反思节点：评估工具执行结果，注入看门狗或失败指导 / Reflect node: evaluate tool results, inject watchdog or failure guidance */
const reflect = async (state: CodeAgentState) => {
  const progress = state.progress;
  if (!progress) return {};

  const watchdogTriggered = progress.stagnantStepCount >= WATCHDOG_STAGNANT_LIMIT;

  if (watchdogTriggered) {
    return {
      messages: [new HumanMessage(
        `No progress detected across ${progress.stagnantStepCount} consecutive tool step(s). Change strategy, inspect a different signal, update the plan, or report a blocker.`
      )],
    };
  }

  const lastMessage = state.messages.at(-1);
  if (lastMessage instanceof ToolMessage && lastMessage.status === "error") {
    let stderr = "unknown error";
    try {
      const parsed = JSON.parse(
        typeof lastMessage.content === "string" ? lastMessage.content : "{}"
      );
      if (parsed.stderr) stderr = String(parsed.stderr).slice(0, 200);
    } catch {}
    return {
      messages: [new HumanMessage(
        `Tool execution failed: ${stderr}. Inspect the failure and choose a different approach.`
      )],
    };
  }

  return {};
};
```

- [ ] **Step 3: Update graph topology**

Replace lines 278-290 (graph building section) with:

```typescript
  // 图拓扑 / Graph topology:
  // START -> agent -> (approval | tools | stop_check)
  // tools -> reflect -> agent
  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("tools", tools)
    .addNode("reflect", reflect)
    .addNode("stop_check", stopCheck)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("tools", routeAfterTools)
    .addConditionalEdges("reflect", routeAfterReflect)
    .addConditionalEdges("stop_check", routeAfterStopCheck)
    .compile({ checkpointer });
```

- [ ] **Step 4: Change `routeAfterTools` to always go to `reflect`**

Modify `routeAfterTools` (lines 325-327):

```typescript
export function routeAfterTools(state: CodeAgentState): "reflect" {
  return "reflect";
}
```

**Note:** Formerly returned `"stop_check" | "agent"` based on `state.final`. Now tools always goes to reflect, and reflect handles the stop_check routing.

- [ ] **Step 5: Remove `addWatchdogResult` call from `tools` node**

In the `tools` node, remove line 239:
```typescript
const toolResult = addWatchdogResult(result, progress);
```

And change the two `JSON.stringify(toolResult)` usages (lines 254, 267) to `JSON.stringify(result)`.

This means the ToolMessage now contains the clean result without embedded watchdog. The watchdog guidance is injected as a separate HumanMessage by the `reflect` node.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```
Expected: no errors

---

### Task 2: Add reflect node unit tests

**Files:**
- Modify: `tests/graph.test.ts`

- [ ] **Step 1: Add import for `routeAfterReflect`**

In `tests/graph.test.ts`, add `routeAfterReflect` to the import from `../src/graph` at line 4-12.

- [ ] **Step 2: Add test for `routeAfterReflect` — routes to agent when no final**

Add at end of `describe("graph local tool routing", () => {` block:

```typescript
  test("reflect routes to agent when no final is set", () => {
    expect(
      routeAfterReflect({
        mode: "builder",
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("agent");
  });
```

- [ ] **Step 3: Add test for `routeAfterReflect` — routes to stop_check when final is set**

```typescript
  test("reflect routes to stop_check when final is set", () => {
    expect(
      routeAfterReflect({
        mode: "builder",
        workspace: "/tmp/workspace",
        messages: [],
        final: "All tasks completed.",
      } as unknown as CodeAgentState),
    ).toBe("stop_check");
  });
```

- [ ] **Step 4: Update existing `routeAfterTools` test expectation**

The test "routes completed plan tool updates through stop check" currently expects `routeAfterTools` to return `"stop_check"`. Update it to expect `"reflect"`:

```typescript
  test("routes completed plan tool updates through reflect", () => {
    expect(
      routeAfterTools({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("reflect");
  });
```

- [ ] **Step 5: Run graph tests**

```bash
bun test tests/graph.test.ts
```
Expected: all tests pass

---

### Task 3: Run full test suite and typecheck

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```
Expected: no errors

- [ ] **Step 2: Run all tests**

```bash
bun test
```
Expected: all tests pass

---

### Task 4: Commit

- [ ] **Step 1: Commit changes**

```bash
git add src/graph.ts tests/graph.test.ts docs/superpowers/plans/2026-04-25-refactor-evaluator-optimizer.md
git commit -m "refactor: add reflect node for evaluator-optimizer pattern

- Insert reflect node between tools and agent
- Move watchdog guidance injection from tools node to reflect node
- Add routeAfterReflect for stop_check/agent routing
- Clean tool result messages (no embedded watchdog)
- Update tests for new topology"
```
