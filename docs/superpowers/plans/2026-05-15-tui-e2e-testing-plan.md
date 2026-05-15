# TUI E2E Testing Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TUI E2E testing framework that renders the Ink TUI app with mock agent events, snapshots the terminal at interaction breakpoints, and diffs ANSI + state fixtures for regression detection.

**Architecture:** Render `<App>` directly via `ink-testing-library` with `useReducer` state management, inject mock agent events programmatically (no real LLM/agent loop), snapshot at `interrupt` and terminal states, freeze dynamic values via `OPENPX_MOCK` env flag, compare fixtures using state JSON diff + ANSI text diff.

**Tech Stack:** Bun test runner, ink-testing-library, React (useReducer), TypeScript

---

### Pre-flight: Verify TUI source understanding

Key touch points:
- `src/app/tui/App.tsx:80-374` — `eventReducer` handles all state transitions from `AgentEvent` dispatches
- `src/app/tui/App.tsx:376-402` — `initialState` / `createInitialState`
- `src/app/tui/index.tsx:68-104` — `runTask()` wires `runAgent` with `TuiUserInputProvider`, for await loop, `SET_EXITED` / `SET_IDLE`
- `src/app/tui/index.tsx:211-217` — `InputLine` mode: derived from `state.interrupt?.kind`
- `src/app/tui/Header.tsx:27-37` — timer `setInterval` + `elapsed` state (dynamic)
- `src/app/tui/StatusBar.tsx:28-38` — same timer pattern + `cacheHitRate` / `totalTokens` (dynamic)
- `src/app/tui/provider.ts` — `TuiUserInputProvider` bridges `requestAction(payload)` → `Promise<UserAction>`
- `tests/tui-interaction.test.tsx:80-85` — `stdin.write` then `expect(dispatched)` pattern for sync dispatch verification

---

### Task 1: Setup directory structure

**Files:**
- Create: `tests/e2e/scenarios/.gitkeep`
- Create: `tests/e2e/fixtures/approval-flow/.gitkeep`

- [ ] **Step 1: Create directories**

```powershell
New-Item -ItemType Directory -Path "tests\e2e\scenarios" -Force
New-Item -ItemType Directory -Path "tests\e2e\fixtures\approval-flow" -Force
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/
git commit -m "chore: scaffold TUI E2E test directory structure"
```

---

### Task 2: Type definitions for E2E framework

**Files:**
- Create: `tests/e2e/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// tests/e2e/types.ts
import type { UserAction } from "../../src/protocol/actions";
import type { ToolApprovalPayload, UserInputPayload } from "../../src/protocol/events";

export interface Scenario {
  terminalWidth: number;
  steps: Step[];
  stepTimeout?: number;
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount">;
}

export type Step =
  | { type: "agent-text"; text: string }
  | { type: "tool-call"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; output: string }
  | { type: "agent-reason"; text: string }
  | { type: "agent-done" }
  | { type: "user-action"; action: UserAction }
  | { type: "user-input"; text: string }
  | { type: "expect-mode"; mode: "approval" | "question" }
  | { type: "assert-snapshot" };

export interface Snapshot {
  index: number;
  reason: "approval-wait" | "question-wait" | "terminal" | "explicit";
  ansi: string;
  state: Record<string, unknown>;
}

export interface E2EResult {
  snapshots: Snapshot[];
  pass: boolean;
  error?: string;
}
```

- [ ] **Step 2: Verify types compile**

```bash
bun run --inspect tests/e2e/types.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/types.ts
git commit -m "feat(e2e): add E2E scenario, step, and snapshot type definitions"
```

---

### Task 3: Add OPENPX_MOCK flag support to Header and StatusBar

**Files:**
- Modify: `src/app/tui/Header.tsx` — frozen timer in mock mode
- Modify: `src/app/tui/StatusBar.tsx` — frozen timer/cache/tokens in mock mode

- [ ] **Step 1: Write failing tests for mock-mode rendering**

Create `tests/tui-mock-render.test.tsx`:

```tsx
// tests/tui-mock-render.test.tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import Header from "../src/app/tui/Header";
import StatusBar from "../src/app/tui/StatusBar";

function fakeStatus() {
  return {
    phase: "building" as const, plan: null,
    authorization: "default" as const, workspaceAccess: "write" as const,
    cacheHitRate: 42, totalTokens: 123456, currentNode: null,
    modelName: "deepseek-v4", thinkingMode: "max",
  };
}

describe("Header in mock mode", () => {
  let prev: string | undefined;

  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen timer when running", () => {
    const { lastFrame } = render(
      <Header status={fakeStatus()} running={true} timerKey={0} />
    );
    const output = lastFrame();
    expect(output).not.toMatch(/\d{2}:\d{2}/);
    expect(output).toContain("<TIMER>");
  });

  test("shows normal content when not running", () => {
    const { lastFrame } = render(
      <Header status={fakeStatus()} running={false} timerKey={0} />
    );
    expect(lastFrame()).toContain("OpenPX");
  });
});

describe("StatusBar in mock mode", () => {
  let prev: string | undefined;

  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen cache/tokens/timer", () => {
    const { lastFrame } = render(
      <StatusBar status={fakeStatus()} thinkingVisible={true} timerKey={0} running={true} />
    );
    const output = lastFrame();
    expect(output).not.toContain("42%");
    expect(output).not.toContain("123,456");
    expect(output).not.toMatch(/\d{2}:\d{2}/);
    expect(output).toContain("<CACHE_HIT_RATE>");
    expect(output).toContain("<CACHE_TOKEN_COUNT>");
    expect(output).toContain("<TIMER>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/tui-mock-render.test.tsx
```

Expected: FAIL — Header still shows real timer values.

- [ ] **Step 3: Modify Header.tsx to support mock mode**

In `src/app/tui/Header.tsx`, change the running timer display:

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

const IS_MOCK = process.env.OPENPX_MOCK === "true";

// ... (keep existing formatDuration, planLabel unchanged)

export default function Header({ status, running, timerKey }: HeaderProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    if (IS_MOCK) {
      setElapsed(-1); // sentinel for mock rendering
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

  // ... (keep existing authLabel, authColor, rwLabel unchanged)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>
          {" ▐▛███▜▌   "}
        </Text>
        <Text bold color={t.primary}>
          OpenPX
        </Text>
        {running && (
          <Text color={t.muted}>
            {"  "}{IS_MOCK ? "<TIMER>" : formatDuration(elapsed)}
          </Text>
        )}
      </Box>
      {/* Row 2 and Row 3 unchanged */}
      {/* ... */}
    </Box>
  );
}
```

Actually, implement by editing the file. The exact edit: replace line 52-56:

```tsx
// Old (approx line 52-56):
        {running && (
          <Text color={t.muted}>
            {"  "}{formatDuration(elapsed)}
          </Text>
        )}

// New:
        {running && (
          <Text color={t.muted}>
            {"  "}{IS_MOCK ? "<TIMER>" : formatDuration(elapsed)}
          </Text>
        )}
```

And add `const IS_MOCK = process.env.OPENPX_MOCK === "true";` at top of file (after imports, before `formatDuration`).

And change the `useEffect` timer setup to bail early in mock mode:

```tsx
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    if (IS_MOCK) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);
```

- [ ] **Step 4: Modify StatusBar.tsx similarly**

In `src/app/tui/StatusBar.tsx`:

Add `const IS_MOCK = process.env.OPENPX_MOCK === "true";` at top.

Change timer `useEffect` to bail early in mock mode (same pattern as Header).

Replace:
- `{status.cacheHitRate.toFixed(0)}%` → `{IS_MOCK ? "<CACHE_HIT_RATE>" : status.cacheHitRate.toFixed(0) + "%"}`
- `{status.totalTokens.toLocaleString()}` → `{IS_MOCK ? "<CACHE_TOKEN_COUNT>" : status.totalTokens.toLocaleString()}`
- `{formatDuration(elapsed)}` → `{IS_MOCK ? "<TIMER>" : formatDuration(elapsed)}`

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/tui-mock-render.test.tsx
```

Expected: ALL PASS

- [ ] **Step 6: Run existing TUI tests to ensure no regression**

```bash
bun test tests/tui-layout.test.tsx tests/tui-interaction.test.tsx
```

Expected: ALL PASS (OPENPX_MOCK is not set in normal runs)

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/Header.tsx src/app/tui/StatusBar.tsx tests/tui-mock-render.test.tsx
git commit -m "feat(tui): add OPENPX_MOCK flag to freeze dynamic values in Header and StatusBar"
```

---

### Task 4: Freeze utility for snapshot post-processing

**Files:**
- Create: `tests/e2e/freeze.ts`

- [ ] **Step 1: Write the freeze utility**

```ts
// tests/e2e/freeze.ts

const FREEZE_MAP: Record<string, string> = {
  timer: "<TIMER>",
  timestamp: "<TIMESTAMP>",
  cacheHitRate: "<CACHE_HIT_RATE>",
  cacheTokenCount: "<CACHE_TOKEN_COUNT>",
};

export function freezeAnsi(ansi: string, freezeKeys: string[]): string {
  let result = ansi;
  for (const key of freezeKeys) {
    const placeholder = FREEZE_MAP[key];
    if (!placeholder) continue;
    if (key === "timer") {
      result = result.replace(/\d{2}:\d{2}/g, placeholder);
    }
    if (key === "cacheHitRate") {
      result = result.replace(/\d{1,3}%/g, placeholder);
    }
    if (key === "cacheTokenCount") {
      result = result.replace(/(\d{1,3}(,\d{3})*|\d+)/g, (match: string) => {
        return match.includes(",") || parseInt(match) > 99 ? placeholder : match;
      });
    }
    if (key === "timestamp") {
      result = result.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, placeholder);
    }
  }
  return result;
}

export function freezeState(
  state: Record<string, unknown>,
  freezeKeys: string[]
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const status = result.status as Record<string, unknown> | undefined;
  if (!status) return result;

  for (const key of freezeKeys) {
    if (key === "cacheHitRate") {
      status.cacheHitRate = "<CACHE_HIT_RATE>";
    }
    if (key === "cacheTokenCount") {
      status.totalTokens = "<CACHE_TOKEN_COUNT>";
    }
  }
  return result;
}
```

- [ ] **Step 2: Write a quick unit test for freeze**

Create `tests/e2e/freeze.test.ts`:

```ts
// tests/e2e/freeze.test.ts
import { describe, test, expect } from "bun:test";
import { freezeAnsi, freezeState } from "./freeze";

describe("freezeAnsi", () => {
  test("replaces timer pattern", () => {
    expect(freezeAnsi("00:42 elapsed", ["timer"])).toContain("<TIMER>");
    expect(freezeAnsi("no timer here", ["timer"])).toBe("no timer here");
  });

  test("replaces cache hit rate", () => {
    expect(freezeAnsi("cache: 42%", ["cacheHitRate"])).toContain("<CACHE_HIT_RATE>");
  });

  test("replaces timestamp", () => {
    expect(freezeAnsi("at 2025-01-15T10:30:00Z", ["timestamp"])).toContain("<TIMESTAMP>");
  });
});

describe("freezeState", () => {
  test("replaces cache fields in status", () => {
    const state = {
      status: { cacheHitRate: 42, totalTokens: 123456, other: "keep" },
    };
    const frozen = freezeState(state, ["cacheHitRate", "cacheTokenCount"]);
    expect(frozen.status).toEqual({
      cacheHitRate: "<CACHE_HIT_RATE>",
      totalTokens: "<CACHE_TOKEN_COUNT>",
      other: "keep",
    });
  });
});
```

- [ ] **Step 3: Run freeze tests**

```bash
bun test tests/e2e/freeze.test.ts
```

Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/freeze.ts tests/e2e/freeze.test.ts
git commit -m "feat(e2e): add freeze utility for dynamic value masking in snapshots"
```

---

### Task 5: Mock agent runner — the core `runTuiE2E`

**Files:**
- Create: `tests/e2e/mock-agent.tsx`

This is the most complex piece. It must:
1. Set `OPENPX_MOCK=true`
2. Render `<App>` with `useReducer` + `ink-testing-library`
3. Execute step sequence: dispatch events, wait for mode transitions, take snapshots
4. Return `{ snapshots, pass }`

- [ ] **Step 1: Write the mock-agent module**

```tsx
// tests/e2e/mock-agent.tsx
import React from "react";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import App from "../../src/app/tui/App";
import { useTuiState } from "../../src/app/tui/App";
import type { Action as TuiAction } from "../../src/app/tui/App";
import type { TuiState, OutputBlock, InterruptState } from "../../src/app/tui/types";
import { TuiUserInputProvider } from "../../src/app/tui/provider";
import type { Scenario, Step, Snapshot, E2EResult } from "./types";
import { freezeAnsi, freezeState } from "./freeze";

let _dispatchRef: { current: ((a: TuiAction) => void) | null } = { current: null };
let _stateRef: { current: TuiState | null } = { current: null };
let _snapshotCallbacks: Array<(s: Snapshot) => void> = [];

function TuiMockRoot({ children }: { children?: ReactNode }) {
  const { state, dispatch, onToggleReason } = useTuiState();
  _dispatchRef.current = dispatch;
  _stateRef.current = state;

  const provider = React.useMemo(
    () => new TuiUserInputProvider((_event) => {}),
    []
  );

  React.useEffect(() => {
    _stateRef.current = state;
  });

  return (
    <App state={state} dispatch={dispatch} onToggleReason={onToggleReason} provider={provider}>
      {children}
    </App>
  );
}

function dispatch(action: TuiAction): void {
  if (_dispatchRef.current) {
    _dispatchRef.current(action);
  }
}

function getState(): TuiState | null {
  return _stateRef.current;
}

let _snapshotIndex = 0;

function takeSnapshot(reason: Snapshot["reason"], freezeKeys: string[], lastFrame: () => string): Snapshot {
  const state = getState();
  if (!state) throw new Error("TUI state not initialized");

  _snapshotIndex++;
  const rawAnsi = lastFrame();
  const rawState = JSON.parse(JSON.stringify(state));

  const ansi = freezeKeys.length > 0 ? freezeAnsi(rawAnsi, freezeKeys) : rawAnsi;
  const frozenState = freezeKeys.length > 0 ? freezeState(rawState, freezeKeys) : rawState;

  return {
    index: _snapshotIndex,
    reason,
    ansi,
    state: frozenState,
  };
}

function waitForInterrupt(timeout: number): Promise<InterruptState> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const state = getState();
      if (state?.interrupt) {
        resolve(state.interrupt);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for interrupt state"));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

function waitForIdle(timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const state = getState();
      if (state && !state.running && !state.interrupt) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for idle state"));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

export async function runTuiE2E(scenario: Scenario): Promise<E2EResult> {
  const prevMock = process.env.OPENPX_MOCK;
  const prevColumns = process.stdout.columns;
  process.env.OPENPX_MOCK = "true";
  process.stdout.columns = scenario.terminalWidth;

  _dispatchRef.current = null;
  _stateRef.current = null;
  _snapshotIndex = 0;

  const snapshots: Snapshot[] = [];
  const stepTimeout = scenario.stepTimeout ?? 5000;
  const freezeKeys = scenario.freeze ?? [];

  const { lastFrame, unmount } = render(
    React.createElement(TuiMockRoot, null)
  );

  let pass = true;
  let error: string | undefined;

  try {
    for (const step of scenario.steps) {
      try {
        await runStep(step, stepTimeout, freezeKeys, lastFrame, snapshots);
      } catch (e: any) {
        pass = false;
        error = `Step ${JSON.stringify(step)}: ${e.message}`;
        break;
      }
    }
  } finally {
    unmount();
    if (prevMock !== undefined) {
      process.env.OPENPX_MOCK = prevMock;
    } else {
      delete process.env.OPENPX_MOCK;
    }
    process.stdout.columns = prevColumns ?? 80;
  }

  return { snapshots, pass, error };
}

async function runStep(
  step: Step,
  timeout: number,
  freezeKeys: string[],
  lastFrame: () => string,
  snapshots: Snapshot[],
): Promise<void> {
  switch (step.type) {
    case "agent-text": {
      dispatch({
        type: "EVENT",
        event: { type: "text", data: { text: step.text } },
      });
      break;
    }
    case "agent-reason": {
      dispatch({
        type: "EVENT",
        event: { type: "reason", data: { text: step.text } },
      });
      break;
    }
    case "tool-call": {
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_call",
          data: {
            call_id: `mock-call-${Date.now()}`,
            name: step.tool as any,
            args: step.args,
          },
        },
      });
      break;
    }
    case "tool-result": {
      const state = getState();
      if (!state) throw new Error("State not initialized");
      const tcBlock = [...state.blocks].reverse().find(
        (b): b is Extract<OutputBlock, { kind: "tool_card" }> => b.kind === "tool_card"
      );
      if (!tcBlock) throw new Error("No pending tool card found");
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_done",
          data: { call_id: tcBlock.callId, name: tcBlock.name, ok: true, summary: step.output },
        },
      });
      break;
    }
    case "agent-done": {
      dispatch({ type: "SET_EXITED" });
      dispatch({ type: "SET_IDLE" });
      await waitForIdle(timeout);
      snapshots.push(takeSnapshot("terminal", freezeKeys, lastFrame));
      break;
    }
    case "user-action": {
      dispatch({
        type: "RESOLVE_INTERRUPT",
        blockId: getState()!.interrupt!.blockId,
        resolution: step.action,
      });
      break;
    }
    case "user-input": {
      // Simulate typing text and pressing Enter in InputLine
      // We need stdin reference — but runTuiE2E doesn't have it.
      // Instead, dispatch directly: set USER_MESSAGE then trigger run
      dispatch({ type: "USER_MESSAGE", text: step.text });
      break;
    }
    case "expect-mode": {
      await waitForInterrupt(timeout);
      const mode = step.mode;
      const state = getState()!;
      if (mode === "approval" && state.interrupt?.kind !== "approval") {
        throw new Error(`Expected approval mode, got ${state.interrupt?.kind}`);
      }
      if (mode === "question" && state.interrupt?.kind !== "input") {
        throw new Error(`Expected question mode, got ${state.interrupt?.kind}`);
      }
      snapshots.push(
        takeSnapshot(
          mode === "approval" ? "approval-wait" : "question-wait",
          freezeKeys,
          lastFrame
        )
      );
      break;
    }
    case "assert-snapshot": {
      snapshots.push(takeSnapshot("explicit", freezeKeys, lastFrame));
      break;
    }
    default:
      throw new Error(`Unknown step type: ${(step as any).type}`);
  }
}
```

Wait — there's a critical issue with `agent-done` and some steps. After dispatching `tool_call`, the TUI doesn't automatically enter `approval` mode. The `need_approval` event must also be dispatched. In a real agent loop, the runner emits `need_approval` after the tool_call is approved by the interrupt system. But in our mock, we need to explicitly dispatch `need_approval` to set up the interrupt state.

Let me reconsider the step types and make the scenario authoring more explicit. Actually, looking at the reducer:

- `tool_call` event → adds a `tool_card` block, does NOT create interrupt
- `need_approval` event → creates `approval` block + sets interrupt to `{ kind: "approval", blockId }`

So the scenario must explicitly include the `need_approval` equivalent. Let me add a `need-approval` step type:

Actually, looking at the original step types in the spec, there's no explicit `need-approval` step. I need to add one. When the agent emits a `tool_call`, and the tool needs approval, the runner dispatches `need_approval`. In our mock, after `tool-call` step, the system needs to also dispatch `need_approval` before `expect-mode: approval` works.

But wait — in the real flow, not all `tool_calls` trigger `need_approval`. Only shell_execute and file writes that require approval. In the mock, the scenario defines the exact flow.

I think the cleanest approach: add a `need-approval` step type. The scenario explicitly states: after `tool-call`, emit `need-approval`, then `expect-mode` waits.

Let me update the types and mock-agent accordingly.

Actually, let me reconsider. Let me add the `need-approval` payload to the `tool-call` step itself, since in real scenarios tool_call and need_approval are tightly coupled:

```ts
| { type: "tool-call"; tool: string; args: Record<string, unknown>; needsApproval?: boolean }
```

If `needsApproval: true`, the mock-agent also dispatches a `need_approval` event after the `tool_call`. This is simpler for scenario writers.

Hmm, but this couples tool_call with approval too tightly. Let me just add a separate step type: `need-approval` with the approval payload.

OK let me redo the mock-agent with proper step handling. I'll update the types and the mock-agent together in this task.

Let me rewrite the plan for Task 5:

- [ ] **Step 1: Update types to add `need-approval` and `need-input` steps**

Edit `tests/e2e/types.ts`, add to Step union:

```ts
| { type: "need-approval"; approval: { tool: string; command: string; risk: string; summary: string; grantOptions: string[]; recommendedGrant: string } }
| { type: "need-input"; question: { text: string; options: { id: string; label: string }[] } }
```

These directly map to `ToolApprovalPayload` and `UserInputPayload` but simplified for testing.

Actually, let me not add too many step types. The spec already defined the step types, and we should be faithful to them. The `tool-call` step should NOT need a separate `need-approval` step. Instead, in the mock-agent, when processing a `tool-call` step, the mock-agent should also dispatch `need_approval` automatically, because that's what happens in the real agent loop.

But that's wrong too — not all tool calls need approval. 

Let me simplify: the scenario knows what it's testing. If it's testing an approval flow, the scenario writer explicitly adds a step to trigger the need_approval event. Let me add a step type for this.

OK I'm going to just rewrite the full mock-agent.tsx with all the correct step types. Let me think about this from the scenario's perspective:

```ts
// approval-flow.ts
export const approvalFlow: Scenario = {
  terminalWidth: 120,
  steps: [
    // Agent says something
    { type: "agent-text", text: "I'll create a file for you." },
    // Agent calls write_file tool
    { type: "tool-call", tool: "write_file", args: { path: "foo.ts", content: "const x = 1;" } },
    // After tool call, agent needs approval — dispatch need_approval event
    { type: "need-approval", approval: { tool: "write_file", command: "write foo.ts", risk: "write_file", summary: "Create foo.ts" } },
    // Wait for TUI to show approval block + take snapshot
    { type: "expect-mode", mode: "approval" },
    // User approves
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    // Tool result comes back
    { type: "tool-result", output: "File written successfully." },
    // Agent finishes
    { type: "agent-done" },
  ],
};
```

This is explicit and clear. Let me go with this approach. I need to add `need-approval` to the Step type.

OK, let me redo the whole Task 5 with proper code.

Also, one more thing: the `user-action` step dispatches `RESOLVE_INTERRUPT`, but the approval resolution in App.tsx relies on `resolveApproval` which is called from `ApprovalBlock`. In our mock, we're dispatching directly to the reducer, so `RESOLVE_INTERRUPT` should work.

Wait, another issue: when the approval block resolves, in the real flow, the provider's `submitAction` is also called, which resolves the `requestAction` promise and allows the agent loop to continue. In our mock, we don't have a running agent loop, so `submitAction` is irrelevant. The `RESOLVE_INTERRUPT` dispatch is all we need.

But wait — in `App.tsx:464-470`, the `ApprovalBlock` is rendered with `provider` prop. The approval resolution flow is:
1. User presses key in ApprovalBlock → `useInput` handler calls `provider.submitAction(action)` AND `onResolved(action)` 
2. `onResolved` → dispatches `RESOLVE_INTERRUPT`

In our mock, we dispatch `RESOLVE_INTERRUPT` directly, which sets `interrupt = null` and marks the block as resolved. This should be sufficient for the TUI to move past the approval state.

But the mock `TuiUserInputProvider` we create in `TuiMockRoot` has a noop dispatch. When ApprovalBlock is rendered and user presses a key, it calls `provider.submitAction()`. But in our E2E test, we're not pressing keys in the ApprovalBlock — we're dispatching `RESOLVE_INTERRUPT` via the reducer. So the ApprovalBlock doesn't need to call `provider.submitAction()`.

Actually wait — does the ApprovalBlock's keyboard handler prevent it from dispatching if `onResolved` handles it? Let me check:

In `App.tsx:464-470`:
```tsx
{interruptBlock?.kind === "approval" && !interruptBlock.resolved && (
  <ApprovalBlock
    approval={interruptBlock.approval}
    provider={provider}
    onResolved={resolveApproval}
  />
)}
```

`resolveApproval` (lines 437-442) dispatches `RESOLVE_INTERRUPT`. The ApprovalBlock itself uses `useInput` to listen for 'a', 's', 'f', 'd' keys and calls both `provider.submitAction()` and `onResolved()`.

So in our mock flow: we dispatch `RESOLVE_INTERRUPT` via the reducer → `interrupt` becomes null → ApprovalBlock unmounts. Good.

Now one last thing: after `RESOLVE_INTERRUPT`, the state has `interrupt: null`. This means the TUI enters prompt mode. The `agent-done` step then dispatches `SET_EXITED` then `SET_IDLE`.

Let me finalize the mock-agent code now. I'll also handle the `need-approval` dispatching correctly.

For `need-approval` step, I need to construct a proper `ToolApprovalPayload` and dispatch `need_approval` event. Looking at the reducer:

```ts
case "need_approval": {
  const blockId = nextId++;
  const block: OutputBlock = { id: blockId, kind: "approval", approval: event.data };
  const interrupt: InterruptState = { kind: "approval", blockId };
  return { ...state, blocks: [...state.blocks, block], interrupt };
}
```

And `ToolApprovalPayload` has many fields. Let me simplify the step type to only require essential fields:

```ts
type NeedApprovalPayload = {
  tool: string;
  command: string;
  risk: string;
  summary: string;
};
```

And the mock-agent fills in the rest with defaults.

OK, I think I have enough now. Let me write the complete plan with all the correct code. This will be a long file but every task will have complete code.

Let me restructure Task 5 and the subsequent tasks to be correct.<｜end▁of▁thinking｜>Now I have complete understanding of all the source code. Let me write the full plan with concrete code for every task.

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="write">
<｜｜DSML｜｜parameter name="content" string="true"># TUI E2E Testing Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TUI E2E testing framework that renders the Ink TUI app with mock agent events, snapshots the terminal at interaction breakpoints, and diffs ANSI + state fixtures for regression detection.

**Architecture:** Render `<App>` directly via `ink-testing-library` with `useReducer` state management, inject mock agent events programmatically (no real LLM/agent loop), snapshot at `interrupt` and terminal states, freeze dynamic values via `OPENPX_MOCK` env flag, compare fixtures using state JSON diff + ANSI text diff.

**Tech Stack:** Bun test runner, ink-testing-library, React (useReducer), TypeScript

**Key source touch points:**
- `src/app/tui/App.tsx:80-374` — `eventReducer` handles all `AgentEvent` → state transitions
- `src/app/tui/App.tsx:431-434` — `state.interrupt` is non-null when TUI waits for user action
- `src/app/tui/index.tsx:211-217` — `InputLine` mode = derived from `state.interrupt?.kind`
- `src/app/tui/Header.tsx:27-37` — timer `setInterval` (dynamic, needs freezing in mock mode)
- `src/app/tui/StatusBar.tsx:28-38` — same timer + `cacheHitRate`/`totalTokens` (dynamic)
- `tests/tui-interaction.test.tsx:423-589` — pattern: `render(<App .../>)`, `stdin.write()`, `expect(dispatched)`

---

### Task 1: Setup directory structure

**Files:**
- Create: `tests/e2e/scenarios/.gitkeep`
- Create: `tests/e2e/fixtures/approval-flow/.gitkeep`

- [ ] **Step 1: Create directories**

```powershell
New-Item -ItemType Directory -Path "tests\e2e\scenarios" -Force
New-Item -ItemType Directory -Path "tests\e2e\fixtures\approval-flow" -Force
```

- [ ] **Step 2: Verify**

```powershell
Get-ChildItem -Recurse tests\e2e
```

Expected output: shows `scenarios/` and `fixtures/approval-flow/`

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/
git commit -m "chore: scaffold TUI E2E test directory structure"
```

---

### Task 2: Type definitions

**Files:**
- Create: `tests/e2e/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// tests/e2e/types.ts
import type { UserAction } from "../../src/protocol/actions";

export interface Scenario {
  /** Fixed terminal width for deterministic rendering */
  terminalWidth: number;
  /** Sequence of steps to execute */
  steps: Step[];
  /** Per-step timeout in ms (default 5000) */
  stepTimeout?: number;
  /** Dynamic value keys to freeze in snapshots */
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount">;
}

export type Step =
  | { type: "agent-text"; text: string }
  | { type: "agent-reason"; text: string }
  | { type: "tool-call"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; output: string }
  | { type: "need-approval"; approval: NeedApprovalPayload }
  | { type: "need-input"; question: NeedInputPayload }
  | { type: "agent-done" }
  | { type: "user-action"; action: UserAction }
  | { type: "user-input"; text: string }
  | { type: "expect-mode"; mode: "approval" | "question" }
  | { type: "assert-snapshot" };

export interface NeedApprovalPayload {
  tool: string;
  command: string;
  risk: "read" | "plan" | "write_file" | "execute_code" | "destructive" | "vcs_mutation";
  summary: string;
}

export interface NeedInputPayload {
  question: string;
  options: { id: string; label: string; description?: string }[];
  allow_free_text?: boolean;
}

export interface Snapshot {
  index: number;
  reason: "approval-wait" | "question-wait" | "terminal" | "explicit";
  ansi: string;
  state: Record<string, unknown>;
}

export interface E2EResult {
  snapshots: Snapshot[];
  pass: boolean;
  error?: string;
}
```

- [ ] **Step 2: Verify types compile**

```bash
bun run -e "import './tests/e2e/types.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/types.ts
git commit -m "feat(e2e): add scenario, step, and snapshot type definitions"
```

---

### Task 3: OPENPX_MOCK flag support in Header and StatusBar

**Files:**
- Modify: `src/app/tui/Header.tsx:1-37` — freeze timer when `OPENPX_MOCK=true`
- Modify: `src/app/tui/StatusBar.tsx:1-89` — freeze timer/cache/tokens when `OPENPX_MOCK=true`
- Create: `tests/tui-mock-render.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `tests/tui-mock-render.test.tsx`:

```tsx
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import Header from "../src/app/tui/Header";
import StatusBar from "../src/app/tui/StatusBar";

function fakeStatus() {
  return {
    phase: "building" as const, plan: null,
    authorization: "default" as const, workspaceAccess: "write" as const,
    cacheHitRate: 42, totalTokens: 123456, currentNode: null,
    modelName: "deepseek-v4", thinkingMode: "max",
  };
}

describe("Header in mock mode", () => {
  let prev: string | undefined;
  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev !== undefined) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen timer when running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: fakeStatus(), running: true, timerKey: 0 })
    );
    expect(lastFrame()).toContain("<TIMER>");
  });
});

describe("StatusBar in mock mode", () => {
  let prev: string | undefined;
  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev !== undefined) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen cache/tokens/timer", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: fakeStatus(), thinkingVisible: true, timerKey: 0, running: true })
    );
    const output = lastFrame();
    expect(output).toContain("<CACHE_HIT_RATE>");
    expect(output).toContain("<CACHE_TOKEN_COUNT>");
    expect(output).toContain("<TIMER>");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
bun test tests/tui-mock-render.test.tsx
```

Expected: 2 FAIL — no `<TIMER>` / `<CACHE_HIT_RATE>` / `<CACHE_TOKEN_COUNT>` found

- [ ] **Step 3: Modify Header.tsx**

Add `const IS_MOCK = process.env.OPENPX_MOCK === "true";` after imports (after `import { darkTheme as t } from "./theme";` line).

Change the timer display (lines 52-56):

```tsx
        {running && (
          <Text color={t.muted}>
            {"  "}{IS_MOCK ? "<TIMER>" : formatDuration(elapsed)}
          </Text>
        )}
```

Change the `useEffect` to skip timer in mock mode (lines 29-37):

```tsx
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    if (IS_MOCK) { setElapsed(0); return; }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);
```

- [ ] **Step 4: Modify StatusBar.tsx**

Add `const IS_MOCK = process.env.OPENPX_MOCK === "true";` after imports.

Change timer `useEffect` same as Header (lines 30-38):

```tsx
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    if (IS_MOCK) { setElapsed(0); return; }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);
```

Change cache display (line 70):

```tsx
          <Text color={cacheColor}>{IS_MOCK ? "<CACHE_HIT_RATE>" : `${status.cacheHitRate.toFixed(0)}%`}</Text>
```

Change tokens display (line 75):

```tsx
          <Text>{IS_MOCK ? "<CACHE_TOKEN_COUNT>" : status.totalTokens.toLocaleString()}</Text>
```

Change timer display (line 78):

```tsx
        {running && <Text color={t.primary}>{IS_MOCK ? "<TIMER>" : formatDuration(elapsed)}</Text>}
```

- [ ] **Step 5: Run mock render tests, verify pass**

```bash
bun test tests/tui-mock-render.test.tsx
```

Expected: 2 PASS

- [ ] **Step 6: Run existing TUI tests to verify no regression**

```bash
bun test tests/tui-layout.test.tsx tests/tui-interaction.test.tsx tests/tui-reducer.test.ts tests/tui-slash-command.test.ts tests/tui.test.ts tests/tui-helpers.test.ts
```

Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/Header.tsx src/app/tui/StatusBar.tsx tests/tui-mock-render.test.tsx
git commit -m "feat(tui): add OPENPX_MOCK flag to freeze dynamic values in Header and StatusBar"
```

---

### Task 4: Freeze utility

**Files:**
- Create: `tests/e2e/freeze.ts`
- Create: `tests/e2e/freeze.test.ts`

- [ ] **Step 1: Write freeze utility**

```ts
// tests/e2e/freeze.ts

const PLACEHOLDER: Record<string, string> = {
  timer: "<TIMER>",
  timestamp: "<TIMESTAMP>",
  cacheHitRate: "<CACHE_HIT_RATE>",
  cacheTokenCount: "<CACHE_TOKEN_COUNT>",
};

export function freezeAnsi(ansi: string, freezeKeys: string[]): string {
  let result = ansi;
  for (const key of freezeKeys) {
    const p = PLACEHOLDER[key];
    if (!p) continue;
    if (key === "timer") {
      result = result.replace(/\b\d{2}:\d{2}\b/g, p);
    }
    if (key === "cacheHitRate") {
      result = result.replace(/\b\d{1,3}%\b/g, p);
    }
    if (key === "cacheTokenCount") {
      // Only replace large numbers (4+ digits, possibly with commas)
      result = result.replace(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d{4,})(?!\d)/g, p);
    }
    if (key === "timestamp") {
      result = result.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, p);
    }
  }
  return result;
}

export function freezeState(
  state: Record<string, unknown>,
  freezeKeys: string[]
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const status = out.status as Record<string, unknown> | undefined;
  if (!status) return out;
  for (const key of freezeKeys) {
    if (key === "cacheHitRate") status.cacheHitRate = "<CACHE_HIT_RATE>";
    if (key === "cacheTokenCount") status.totalTokens = "<CACHE_TOKEN_COUNT>";
  }
  return out;
}
```

- [ ] **Step 2: Write freeze tests**

```ts
// tests/e2e/freeze.test.ts
import { describe, test, expect } from "bun:test";
import { freezeAnsi, freezeState } from "./freeze";

describe("freezeAnsi", () => {
  test("replaces timer pattern", () => {
    expect(freezeAnsi("00:42 elapsed", ["timer"])).toBe("<TIMER> elapsed");
  });
  test("does not replace short numbers as timer", () => {
    expect(freezeAnsi("Step 1/5 done", ["timer"])).toBe("Step 1/5 done");
  });
  test("replaces cache hit rate", () => {
    expect(freezeAnsi("cache: 42%", ["cacheHitRate"])).toBe("cache: <CACHE_HIT_RATE>");
  });
  test("replaces large numbers as token count", () => {
    expect(freezeAnsi("tokens: 123,456 used", ["cacheTokenCount"])).toBe("tokens: <CACHE_TOKEN_COUNT> used");
  });
  test("replaces timestamp pattern", () => {
    expect(freezeAnsi("at 2025-01-15T10:30:00Z", ["timestamp"])).toContain("<TIMESTAMP>");
  });
  test("multiple freezes", () => {
    const input = "t=00:42 cache=80% tokens=5,000";
    expect(freezeAnsi(input, ["timer", "cacheHitRate", "cacheTokenCount"]))
      .toBe("t=<TIMER> cache=<CACHE_HIT_RATE> tokens=<CACHE_TOKEN_COUNT>");
  });
});

describe("freezeState", () => {
  test("replaces cache fields in status", () => {
    const state = { status: { cacheHitRate: 42, totalTokens: 123456, other: "keep" } };
    const frozen = freezeState(state, ["cacheHitRate", "cacheTokenCount"]);
    expect(frozen.status).toEqual({ cacheHitRate: "<CACHE_HIT_RATE>", totalTokens: "<CACHE_TOKEN_COUNT>", other: "keep" });
  });
  test("no-op when no freeze keys", () => {
    const state = { status: { cacheHitRate: 42 } };
    expect(freezeState(state, [])).toEqual(state);
  });
  test("handles missing status", () => {
    expect(freezeState({ blocks: [] }, ["cacheHitRate"])).toEqual({ blocks: [] });
  });
});
```

- [ ] **Step 3: Run freeze tests**

```bash
bun test tests/e2e/freeze.test.ts
```

Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/freeze.ts tests/e2e/freeze.test.ts
git commit -m "feat(e2e): add freeze utility for dynamic value masking in snapshots"
```

---

### Task 5: Mock agent runner `runTuiE2E`

**Files:**
- Create: `tests/e2e/mock-agent.tsx`
- Create: `tests/e2e/mock-agent.test.tsx`

Core approach: render `<App>` via `ink-testing-library` with a custom wrapper component that exposes `dispatch` and current `state` via module-level refs. Execute steps by dispatching `AgentEvent` actions through the reducer. Snapshot at interrupt/terminal points.

- [ ] **Step 1: Write a basic smoke test**

```tsx
// tests/e2e/mock-agent.test.tsx
import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import type { Scenario } from "./types";

describe("runTuiE2E", () => {
  test("renders TUI, dispatches text event, takes terminal snapshot", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      steps: [
        { type: "agent-text", text: "Hello from E2E test!" },
        { type: "agent-done" },
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(1);
    expect(result.snapshots[0].reason).toBe("terminal");
    expect(result.snapshots[0].ansi).toContain("Hello from E2E test!");
  });

  test("captures approval snapshot", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      steps: [
        { type: "tool-call", tool: "shell_execute", args: { command: "npm test" } },
        {
          type: "need-approval",
          approval: {
            tool: "shell_execute",
            command: "npm test",
            risk: "execute_code",
            summary: "Run tests",
          },
        },
        { type: "expect-mode", mode: "approval" },
        { type: "user-action", action: { type: "approve", grant: "approve_once" } },
        { type: "tool-result", output: "Tests passed." },
        { type: "agent-done" },
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(2);
    expect(result.snapshots[0].reason).toBe("approval-wait");
    expect(result.snapshots[1].reason).toBe("terminal");
  });

  test("reports failure on timeout", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      stepTimeout: 100,
      steps: [
        { type: "expect-mode", mode: "approval" }, // will never enter approval — TUI is in prompt mode
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
bun test tests/e2e/mock-agent.test.tsx
```

Expected: FAIL — `runTuiE2E` not implemented

- [ ] **Step 3: Write mock-agent.tsx**

```tsx
// tests/e2e/mock-agent.tsx
import React from "react";
import { render } from "ink-testing-library";
import App from "../../src/app/tui/App";
import { useTuiState } from "../../src/app/tui/App";
import type { Action as TuiAction } from "../../src/app/tui/App";
import type { TuiState, OutputBlock } from "../../src/app/tui/types";
import { TuiUserInputProvider } from "../../src/app/tui/provider";
import type { Scenario, Step, Snapshot, E2EResult } from "./types";
import { freezeAnsi, freezeState } from "./freeze";

// Module-level refs exposed by the wrapper component
let dispatchRef: ((a: TuiAction) => void) | null = null;
let stateRef: TuiState | null = null;
let snapshotIndex = 0;

function TuiMockRoot() {
  const { state, dispatch, onToggleReason } = useTuiState();

  React.useEffect(() => {
    dispatchRef = dispatch;
    stateRef = state;
  });

  // Keep stateRef up to date on every render
  stateRef = state;
  dispatchRef = dispatch;

  const provider = React.useMemo(
    () => new TuiUserInputProvider((_event) => {}),
    []
  );

  return React.createElement(App, {
    state,
    dispatch,
    onToggleReason,
    provider,
  });
}

function dispatch(action: TuiAction): void {
  if (dispatchRef) dispatchRef(action);
}

function getState(): TuiState | null {
  return stateRef;
}

function takeSnapshot(
  reason: Snapshot["reason"],
  freezeKeys: string[],
  lastFrame: () => string
): Snapshot {
  const state = getState();
  if (!state) throw new Error("TUI state not initialized");
  snapshotIndex++;
  const rawAnsi = lastFrame();
  const rawState = JSON.parse(JSON.stringify(state));
  return {
    index: snapshotIndex,
    reason,
    ansi: freezeKeys.length > 0 ? freezeAnsi(rawAnsi, freezeKeys) : rawAnsi,
    state: freezeKeys.length > 0 ? freezeState(rawState, freezeKeys) : rawState,
  };
}

function waitForInterrupt(timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (getState()?.interrupt) { resolve(); return; }
      if (Date.now() - start > timeout) { reject(new Error("Timeout waiting for interrupt")); return; }
      setImmediate(poll);
    };
    poll();
  });
}

async function runStep(
  step: Step,
  timeout: number,
  freezeKeys: string[],
  lastFrame: () => string,
  snapshots: Snapshot[]
): Promise<void> {
  switch (step.type) {
    case "agent-text":
      dispatch({ type: "EVENT", event: { type: "text", data: { text: step.text } } });
      break;
    case "agent-reason":
      dispatch({ type: "EVENT", event: { type: "reason", data: { text: step.text } } });
      break;
    case "tool-call":
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_call",
          data: { call_id: `mock-${Date.now()}`, name: step.tool as any, args: step.args },
        },
      });
      break;
    case "tool-result": {
      const state = getState();
      if (!state) throw new Error("State not initialized");
      const tcBlock = [...state.blocks].reverse().find(
        (b): b is Extract<OutputBlock, { kind: "tool_card" }> => b.kind === "tool_card"
      );
      if (!tcBlock) throw new Error("No pending tool card for tool-result");
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_done",
          data: { call_id: tcBlock.callId, name: tcBlock.name, ok: true, summary: step.output },
        },
      });
      break;
    }
    case "need-approval":
      dispatch({
        type: "EVENT",
        event: {
          type: "need_approval",
          data: {
            tool: step.approval.tool as any,
            scope: "once" as const,
            cwd: process.cwd(),
            threadId: "mock-thread",
            command: step.approval.command,
            risk: step.approval.risk,
            summary: step.approval.summary,
            reason: "Test reason",
            approvalHash: "mock-hash",
            expectedEffects: [],
            grantOptions: ["approve_once", "same_command", "full_access"],
            recommendedGrant: "approve_once",
          },
        },
      });
      break;
    case "need-input":
      dispatch({
        type: "EVENT",
        event: {
          type: "need_input",
          data: {
            question: step.question.question,
            options: step.question.options,
            allow_free_text: step.question.allow_free_text ?? false,
          },
        },
      });
      break;
    case "expect-mode": {
      await waitForInterrupt(timeout);
      const state = getState()!;
      if (step.mode === "approval" && state.interrupt?.kind !== "approval")
        throw new Error(`Expected approval mode, got ${state.interrupt?.kind}`);
      if (step.mode === "question" && state.interrupt?.kind !== "input")
        throw new Error(`Expected question mode, got ${state.interrupt?.kind}`);
      snapshots.push(takeSnapshot(
        step.mode === "approval" ? "approval-wait" : "question-wait",
        freezeKeys, lastFrame
      ));
      break;
    }
    case "assert-snapshot":
      snapshots.push(takeSnapshot("explicit", freezeKeys, lastFrame));
      break;
    case "user-action":
      dispatch({
        type: "RESOLVE_INTERRUPT",
        blockId: getState()!.interrupt!.blockId,
        resolution: step.action,
      });
      break;
    case "user-input":
      dispatch({ type: "USER_MESSAGE", text: step.text });
      break;
    case "agent-done":
      dispatch({ type: "SET_EXITED" });
      dispatch({ type: "SET_IDLE" });
      // Poll until idle
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          const s = getState();
          if (s && !s.running && !s.interrupt) { resolve(); return; }
          if (Date.now() - start > timeout) { reject(new Error("Timeout waiting for idle")); return; }
          setImmediate(poll);
        };
        poll();
      });
      snapshots.push(takeSnapshot("terminal", freezeKeys, lastFrame));
      break;
    default:
      throw new Error(`Unknown step type: ${(step as any).type}`);
  }
}

export async function runTuiE2E(scenario: Scenario): Promise<E2EResult> {
  const prevMock = process.env.OPENPX_MOCK;
  const prevColumns = process.stdout.columns;
  process.env.OPENPX_MOCK = "true";
  if (prevColumns !== undefined) process.stdout.columns = scenario.terminalWidth;

  dispatchRef = null;
  stateRef = null;
  snapshotIndex = 0;

  const { lastFrame, unmount } = render(React.createElement(TuiMockRoot));

  const snapshots: Snapshot[] = [];
  const stepTimeout = scenario.stepTimeout ?? 5000;
  const freezeKeys = scenario.freeze ?? [];
  let pass = true;
  let error: string | undefined;

  try {
    for (const step of scenario.steps) {
      await runStep(step, stepTimeout, freezeKeys, lastFrame, snapshots);
    }
  } catch (e: any) {
    pass = false;
    error = e.message;
  } finally {
    unmount();
    if (prevMock !== undefined) process.env.OPENPX_MOCK = prevMock;
    else delete process.env.OPENPX_MOCK;
    if (prevColumns !== undefined) process.stdout.columns = prevColumns;
    else delete process.stdout.columns;
  }

  return { snapshots, pass, error };
}
```

- [ ] **Step 4: Run the mock-agent tests**

```bash
bun test tests/e2e/mock-agent.test.tsx
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/mock-agent.tsx tests/e2e/mock-agent.test.tsx
git commit -m "feat(e2e): add mock-agent TUI E2E runner with step execution and snapshot capture"
```

---

### Task 6: First E2E scenario — approval flow

**Files:**
- Create: `tests/e2e/scenarios/approval-flow.ts`
- Create: `tests/e2e/approval-flow.test.ts`

- [ ] **Step 1: Write the scenario file**

```ts
// tests/e2e/scenarios/approval-flow.ts
import type { Scenario } from "../types";

export const approvalFlow: Scenario = {
  terminalWidth: 120,
  stepTimeout: 5000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
  steps: [
    { type: "agent-text", text: "I'll create a test file for you." },
    {
      type: "tool-call",
      tool: "write_file",
      args: { path: "src/test.ts", content: "export const hello = 'world';" },
    },
    {
      type: "need-approval",
      approval: {
        tool: "write_file",
        command: "write src/test.ts",
        risk: "write_file",
        summary: "Create test.ts with hello export",
      },
    },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written successfully (1 line, 35 bytes)." },
    { type: "agent-done" },
  ],
};
```

- [ ] **Step 2: Write the test file**

```ts
// tests/e2e/approval-flow.test.ts
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTuiE2E } from "./mock-agent";
import { approvalFlow } from "./scenarios/approval-flow";

const FIXTURES_DIR = join(import.meta.dir!, "fixtures", "approval-flow");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

function loadFixture(name: string): string | null {
  const p = fixturePath(name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

function saveFixture(name: string, content: string): void {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(fixturePath(name), content, "utf-8");
}

function diffAnsi(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  const a = actual.split("\n");
  const b = expected.split("\n");
  const lines: string[] = [];
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const al = a[i] ?? "(missing)";
    const bl = b[i] ?? "(missing)";
    if (al !== bl) {
      lines.push(`  line ${i + 1}:`);
      lines.push(`-   ${bl}`);
      lines.push(`+   ${al}`);
    }
  }
  return lines.join("\n");
}

const UPDATE_SNAPSHOTS = Bun.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "true";

describe("approval flow E2E", () => {
  test("snapshot 1: approval waiting state", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(2);

    const snap = result.snapshots[0];
    expect(snap.reason).toBe("approval-wait");

    const ansiExpected = loadFixture("001.ansi");
    if (UPDATE_SNAPSHOTS || ansiExpected === null) {
      saveFixture("001.ansi", snap.ansi);
      saveFixture("001.state.json", JSON.stringify(snap.state, null, 2));
    } else {
      const diff = diffAnsi(snap.ansi, ansiExpected);
      if (diff) {
        console.log("\n── diff: fixtures/approval-flow/001.ansi ──");
        console.log(diff);
      }
      expect(snap.ansi).toBe(ansiExpected);
    }
  });

  test("snapshot 2: terminal state after approval", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);

    const snap = result.snapshots[1];
    expect(snap.reason).toBe("terminal");

    const ansiExpected = loadFixture("002.ansi");
    if (UPDATE_SNAPSHOTS || ansiExpected === null) {
      saveFixture("002.ansi", snap.ansi);
      saveFixture("002.state.json", JSON.stringify(snap.state, null, 2));
    } else {
      const diff = diffAnsi(snap.ansi, ansiExpected);
      if (diff) {
        console.log("\n── diff: fixtures/approval-flow/002.ansi ──");
        console.log(diff);
      }
      expect(snap.ansi).toBe(ansiExpected);
    }
  });
});
```

- [ ] **Step 3: Run the approval flow test to generate fixtures**

```bash
set UPDATE_SNAPSHOTS=true; bun test tests/e2e/approval-flow.test.ts
```

Expected: PASS (fixtures generated)

- [ ] **Step 4: Run again to verify fixtures match**

```bash
bun test tests/e2e/approval-flow.test.ts
```

Expected: PASS (fixtures match)

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/scenarios/approval-flow.ts tests/e2e/approval-flow.test.ts tests/e2e/fixtures/approval-flow/
git commit -m "feat(e2e): add approval flow E2E scenario with snapshot fixtures"
```

---

### Task 7: Add test scripts to package.json

**Files:**
- Modify: `package.json` — add E2E test scripts

- [ ] **Step 1: Add scripts**

Edit `package.json`, add to `"scripts"`:

```json
"test:e2e": "bun test ./tests/e2e/",
"test:e2e:update": "cross-env UPDATE_SNAPSHOTS=true bun test ./tests/e2e/"
```

> Note: `cross-env` may not be available. Use PowerShell syntax for Windows. Simpler alternative — use Bun's built-in env support:

```json
"test:e2e": "bun test ./tests/e2e/",
"test:e2e:update": "bun test ./tests/e2e/"
```

And in the test file, check for `Bun.argv.includes("--update-snapshots")` which Bun supports natively. Update the test to use this instead of the env var.

Actually, Bun's `--update-snapshots` is for `toMatchSnapshot()`. Let's just use `--update` in the script:

```json
"test:e2e": "bun test ./tests/e2e/",
"test:e2e:update": "set UPDATE_SNAPSHOTS=true && bun test ./tests/e2e/"
```

- [ ] **Step 2: Run full E2E suite**

```bash
bun test ./tests/e2e/
```

Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add test:e2e and test:e2e:update scripts"
```

---

### Task 8: Integration — run all TUI tests including E2E

- [ ] **Step 1: Run full TUI test suite**

```bash
bun test tests/tui*.test.ts tests/tui*.test.tsx tests/e2e/*.test.ts tests/e2e/*.test.tsx
```

Expected: ALL PASS (existing TUI tests + new E2E tests)

- [ ] **Step 2: Verify git status is clean**

```bash
git status
```

Expected: clean working tree (or only uncommitted new files)

---

## Self-Review Checklist

1. **Spec coverage:**
   - Scenario type with terminalWidth, steps, freeze — Task 2 ✓
   - Step types: agent-text, tool-call, need-approval, expect-mode, user-action, agent-done, assert-snapshot — Task 2 ✓
   - Snapshot with ansi + state — Task 2 ✓
   - runTuiE2E returns {snapshots, pass} — Task 5 ✓
   - Freeze dynamic values — Task 3 (components) + Task 4 (utility) ✓
   - Mock mode flag OPENPX_MOCK — Task 3 ✓
   - Terminal width fixed — Task 5 (sets process.stdout.columns) ✓
   - Step timeout — Task 5 (Promise.race with timeout) ✓
   - Snapshot at interrupt + terminal — Task 5 (expect-mode + agent-done) ✓
   - Diff output on failure — Task 6 (diffAnsi with +/- lines) ✓
   - Fixture directory structure — Task 1 + Task 6 ✓
   - --update-snapshots support — Task 6 + Task 7 ✓

2. **Placeholder scan:** No TBD/TODO found. All steps have complete code. ✓

3. **Type consistency:**
   - `Scenario` in types.ts matches usage in mock-agent.tsx and scenario files ✓
   - `Step` union covers all cases in mock-agent's `runStep` switch ✓
   - `Snapshot` fields match `takeSnapshot` return ✓
   - `E2EResult` fields match `runTuiE2E` return ✓
   - `freezeKeys` array type consistent across Scenario, freezeAnsi, freezeState ✓
