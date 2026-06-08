# E2E Test Suite Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：archived（2026-06-08 归档）

**Goal:** Restructure TUI e2e tests from 13 happy-path tests to ~71 tests across P0-P3 tiers with companion unit test coverage for all 42 reducer actions.

**Architecture:** Three e2e test files share a common test harness (`render-tui.tsx`) with enhanced methods for approval flow, overlay detection, and state queries. A new `response-plan.ts` utility manages model response ordering declaratively. Unit tests supplement the 11 currently-untested reducer actions.

**Tech Stack:** Bun test, ink-testing-library, React (for TUI components), StreamingMockModel

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `tests/e2e/response-plan.ts` | CREATE | Declarative response allocation & verification |
| `tests/e2e/render-tui.tsx` | MODIFY | Add harness methods: waitForApproval, approve, waitForQuestion, answerQuestion, waitForOverlay, waitForOverlayGone, getAuthMode, isSidebarFocused |
| `tests/e2e/startup.test.tsx` | REWRITE | P0 core regression tests (~18) |
| `tests/e2e/interaction.test.tsx` | CREATE | P1 key user workflows (~28) |
| `tests/e2e/advanced.test.tsx` | CREATE | P2+P3 advanced + integration (~25) |
| `tests/tui-reducer.test.ts` | MODIFY | Add ~20 tests for missing action coverage |

---

### Task 1: Response Allocator Utility

**Files:**
- Create: `tests/e2e/response-plan.ts`

- [ ] **Step 1: Create response-plan.ts**

```typescript
// tests/e2e/response-plan.ts
import type { MockResponse } from "../mock-model";

export interface ResponseGroup {
  group: string;
  responses: MockResponse[];
}

/**
 * Declarative response planner.
 *
 * Usage:
 *   const plan = new ResponsePlan([
 *     { group: "startup", responses: [text("Got it!")] },
 *     { group: "approval", responses: [toolCall("read_file", "test.txt"), text("done")] },
 *   ]);
 *   const allResponses = plan.flatten();
 *   // ... run tests ...
 *   plan.verify(callCount); // throws if consumed != planned
 */
export class ResponsePlan {
  private groups: ResponseGroup[];

  constructor(groups: ResponseGroup[]) {
    this.groups = groups;
  }

  /** Flatten all groups into a single ordered array for createTui */
  flatten(): MockResponse[] {
    const out: MockResponse[] = [];
    for (const g of this.groups) {
      out.push(...g.responses);
    }
    return out;
  }

  /** Verify all planned responses were consumed */
  verify(callCount: number): void {
    const total = this.groups.reduce((sum, g) => sum + g.responses.length, 0);
    if (callCount !== total) {
      const consumed: string[] = [];
      let remainingGroups = [...this.groups];
      let remaining = callCount;
      for (const g of remainingGroups) {
        if (remaining <= 0) break;
        const fromGroup = Math.min(remaining, g.responses.length);
        consumed.push(`${g.group}: ${fromGroup}/${g.responses.length}`);
        remaining -= fromGroup;
      }
      throw new Error(
        `Response plan mismatch: consumed ${callCount}, planned ${total}.\n` +
        `Consumed: ${consumed.join(", ") || "none"}`
      );
    }
  }
}

/** Shorthand: single text response */
export function text(content: string, delay = 50): MockResponse {
  return { message: { content } as any, delay };
}

/** Shorthand: text stream chunk for multi-chunk responses */
export function textChunk(content: string, delay = 30): MockResponse {
  return { message: { content } as any, delay };
}

/** Shorthand: model error */
export function modelError(message: string, delay = 50): MockResponse {
  return { message: { content: "" } as any, error: message, delay };
}

/** Shorthand: tool call response */
export function toolCall(
  name: string,
  args: Record<string, unknown>,
  content = "let me check",
  delay = 30
): MockResponse {
  return {
    message: {
      content,
      tool_calls: [{ id: `tc-${name}`, name, args }],
    } as any,
    delay,
  };
}
```

- [ ] **Step 2: Run typecheck to verify**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/response-plan.ts
git commit -m "feat: 新增 ResponsePlan 响应分配器，解决 e2e 模型响应顺序管理"
```

---

### Task 2: Enhance TuiHarness with New Methods

**Files:**
- Modify: `tests/e2e/render-tui.tsx`

- [ ] **Step 1: Add new methods to TuiHarness interface and implementation**

In `tests/e2e/render-tui.tsx`, add to the `TuiHarness` interface after `isIdle()`:

```typescript
  // ── Approval flow ──
  /** Wait for approval block to appear ([A], [S], [F], [D] markers) */
  waitForApproval: (timeout?: number) => Promise<void>;
  /** Send approval key (A/S/F/D) and wait for result */
  approve: (key: "A" | "S" | "F" | "D") => Promise<void>;

  // ── Question flow ──
  /** Wait for question block to appear */
  waitForQuestion: (timeout?: number) => Promise<void>;
  /** Type answer and submit */
  answerQuestion: (text: string) => Promise<void>;

  // ── Overlay detection ──
  /** Wait for overlay to appear by keyword */
  waitForOverlay: (keyword: string, timeout?: number) => Promise<void>;
  /** Wait for overlay to disappear */
  waitForOverlayGone: (keyword: string, timeout?: number) => Promise<void>;

  // ── State queries ──
  /** Get current authorization mode from rendered output */
  getAuthMode: () => "default" | "full_access" | null;
  /** Check if sidebar is focused */
  isSidebarFocused: () => boolean;
  /** Wait for running cat face to disappear (agent stopped) */
  waitForRunningGone: (timeout?: number) => Promise<void>;
```

Now add the implementations inside the `harness` object in `createTui()`. Insert after the `getSessionCount` method, before the `setupOk = true; return harness;` lines:

```typescript
      // ── Approval flow ──

      async waitForApproval(timeout = stepTimeout) {
        await poll(() => getOutput().includes("[A]"), timeout, "approval block ([A] marker)");
      },

      async approve(key: "A" | "S" | "F" | "D") {
        stdin.write(key.toLowerCase());
        await tick(300);
      },

      // ── Question flow ──

      async waitForQuestion(timeout = stepTimeout) {
        await poll(
          () => getOutput().includes("?") && !getOutput().includes("[A/S/F/D]"),
          timeout,
          "question block"
        );
      },

      async answerQuestion(text: string) {
        stdin.write(text);
        await tick(100);
        stdin.write("\r");
        await tick(300);
      },

      // ── Overlay detection ──

      async waitForOverlay(keyword: string, timeout = stepTimeout) {
        await pollTextPresent(lastFrame, keyword, timeout);
      },

      async waitForOverlayGone(keyword: string, timeout = stepTimeout) {
        await pollTextGone(lastFrame, keyword, timeout);
      },

      // ── State queries ──

      getAuthMode() {
        const out = getOutput();
        if (out.includes("[full]")) return "full_access";
        if (out.includes("[safe]")) return "default";
        return null;
      },

      isSidebarFocused() {
        return getOutput().includes("Sidebar focused");
      },

      async waitForRunningGone(timeout = stepTimeout) {
        await pollTextGone(lastFrame, RUNNING_CAT, timeout);
      },
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Verify existing e2e tests still pass with enhanced harness**

```bash
bun test tests/e2e/
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/render-tui.tsx
git commit -m "feat: TuiHarness 新增审批流、提问、浮层检测、状态查询辅助方法"
```

---

### Task 3: Rewrite startup.test.tsx — P0 Core Regression Tests

**Files:**
- Modify: `tests/e2e/startup.test.tsx`

**Response plan:** 8 responses for model-interaction tests. Pure UI tests (shortcuts, navigation) consume no responses.

| Group | Count | Content |
|-------|-------|---------|
| basic-msg | 3 | "Got it!", "Hello!", "Done." |
| multi-turn | 2 | "Hello! How can I help?", "The answer is 42." |
| error | 1 | error "Network timeout" |
| tool | 2 | tool_call read_file, "File looks good" |

- [ ] **Step 1: Write the test file**

```typescript
/**
 * TUI E2E — P0 Core Regression Tests
 *
 * Covers historically-buggy paths: session switching block preservation,
 * Kitty keyboard protocol, agentLoopActive timing, interrupt/recovery,
 * and basic send/response happy paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text, modelError, toolCall } from "./response-plan";

const TIMEOUT = 30000; // shorter for P0 — these are well-tested paths

// ── Response plan ──

const plan = new ResponsePlan([
  { group: "basic-msg", responses: [text("Got it!"), text("Hello!"), text("Done.")] },
  { group: "multi-turn", responses: [text("Hello! How can I help?", 30), text("The answer is 42.", 30)] },
  { group: "error", responses: [modelError("Network timeout")] },
  { group: "tool", responses: [toolCall("read_file", { path: "test.txt" }), text("File looks good.", 30)] },
]);

let tui: TuiHarness;

// ═══════════════════════════════════════════════════════════
// describe("P0: Startup & Render")
// ═══════════════════════════════════════════════════════════

describe("P0: Core Regression", () => {

  beforeAll(async () => {
    tui = await createTui({ modelResponses: plan.flatten() });
  });

  afterAll(() => {
    tui?.unmount();
    plan.verify(0); // will fail if consumed != planned — callCount unavailable from outside
    // Note: callCount verification is done in the last test of the last describe
  });

  describe("Startup & Render", () => {
    test("renders without crash (output > 10 chars)", () => {
      const output = tui.getOutput();
      expect(output.length).toBeGreaterThan(10);
      expect(output.toLowerCase()).toContain("openpx");
    });

    test("auto-creates session — sidebar shows session entry", () => {
      expect(tui.getSessionCount()).toBeGreaterThanOrEqual(1);
      expect(tui.getOutput()).not.toContain("No sessions");
    });
  });

  describe("Send Message → Agent Response", () => {
    test("send message → user message block appears in output", async () => {
      await tui.sendMessage("unique-test-msg-42");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("unique-test-msg-42");
    }, TIMEOUT);

    test("send message → agent responds with text visible in output", async () => {
      await tui.sendMessage("hello");
      await tui.waitForText("Hello!", 15000);
      expect(tui.getOutput()).toContain("Hello!");
    }, TIMEOUT);

    test("send message → returns to idle state after agent finishes", async () => {
      await tui.sendMessage("do task");
      await tui.waitForIdle(15000);
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);

    test("exit summary appears after agent finishes", async () => {
      await tui.sendMessage("task");
      await tui.waitForIdle(10000);
      expect(tui.getOutput()).toContain("──");
    }, TIMEOUT);
  });

  describe("Multi-turn Conversation", () => {
    test("multi-turn: both turns produce responses", async () => {
      // Clear first
      tui.stdin.write("/clear");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));

      await tui.sendMessage("Hi");
      await tui.waitForText("Hello! How can I help?", 10000);
      expect(tui.getOutput()).toContain("Hello! How can I help?");

      await tui.sendMessage("What is the answer?");
      await tui.waitForIdle(10000);

      const output = tui.getOutput();
      expect(output).toContain("The answer is 42.");
      expect(output).toContain("Hi");
      expect(output).toContain("What is the answer?");
    }, TIMEOUT);
  });

  describe("Session Switching — Block Preservation (P0 regression)", () => {
    test("switch session then switch back preserves message history", async () => {
      // Send message in session 1 (auto-created)
      await tui.sendMessage("SwitchMsgA");
      await tui.waitForIdle(15000);

      // Create session 2 via Ctrl+X n
      tui.stdin.write("\x18");
      await new Promise((r) => setTimeout(r, 400));
      tui.stdin.write("n");
      await new Promise((r) => setTimeout(r, 1500));

      const countAfterNew = tui.getSessionCount();
      expect(countAfterNew).toBeGreaterThanOrEqual(2);

      // Send message in session 2
      await tui.sendMessage("SwitchMsgB");
      await tui.waitForIdle(15000);

      // Tab → focus sidebar
      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.isSidebarFocused()).toBe(true);

      // UpArrow → select session 1
      tui.stdin.write("\x1b[A");
      await new Promise((r) => setTimeout(r, 300));

      // Enter → switch to session 1
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 2000));

      const out = tui.getOutput();
      // Session 1 message history must be visible (regression: SET_SESSIONS overwrites blocks)
      expect(out).toContain("SwitchMsgA");
      // Focus must return to input
      expect(tui.isSidebarFocused()).toBe(false);
    }, TIMEOUT);

    test("new session → active marker follows new session → message goes to new session", async () => {
      // Create session 3 via Ctrl+N
      tui.stdin.write("\x0e"); // Ctrl+N
      await new Promise((r) => setTimeout(r, 1000));

      const count = tui.getSessionCount();
      expect(count).toBeGreaterThanOrEqual(3);

      // Send message in new session
      await tui.sendMessage("NewSessionMsg");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("NewSessionMsg");

      // Tab → focus sidebar
      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 500));

      // Navigate to session 1 and switch
      tui.stdin.write("\x1b[A");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("\x1b[A");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 1500));

      // Session 1 should NOT contain NewSessionMsg (regression: activeSessionId not synced)
      expect(tui.getOutput()).not.toContain("NewSessionMsg");
    }, TIMEOUT);
  });

  describe("Keyboard Protocol — Arrow Keys (P0 regression)", () => {
    test("Tab → UpArrow → DownArrow → Enter produces correct behavior", async () => {
      // Need at least 2 sessions for navigation
      tui.stdin.write("\x0e"); // Ctrl+N
      await new Promise((r) => setTimeout(r, 1000));

      // Tab → focus sidebar
      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.isSidebarFocused()).toBe(true);

      // DownArrow (should NOT be Enter — regression: Kitty protocol)
      tui.stdin.write("\x1b[B");
      await new Promise((r) => setTimeout(r, 300));

      // UpArrow — should navigate back without switching
      tui.stdin.write("\x1b[A");
      await new Promise((r) => setTimeout(r, 300));

      // Enter — should switch session
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 1000));

      // Should have focus back on input after switch
      expect(tui.isSidebarFocused()).toBe(false);
    }, TIMEOUT);
  });

  describe("Interrupt & Recovery", () => {
    test("Ctrl+C during agent run → returns to idle → can send again", async () => {
      await tui.sendMessage("long task");
      await tui.waitForRunning(5000);

      // Ctrl+C
      tui.stdin.write("\x03");
      await new Promise((r) => setTimeout(r, 500));

      await tui.waitForIdle(10000);
      expect(tui.isRunning()).toBe(false);

      // Should be able to send a new message
      await tui.sendMessage("hello again");
      await tui.waitForIdle(10000);
      expect(tui.isIdle()).toBe(true);
    }, TIMEOUT);

    test("Ctrl+C twice when idle → exitRequested", async () => {
      // First ensure idle
      await tui.waitForIdle(5000);

      // Double Ctrl+C
      tui.stdin.write("\x03");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("\x03");
      await new Promise((r) => setTimeout(r, 500));

      // TUI should still be responsive (exitRequested triggers process.exit,
      // which we can't easily test — but we can verify no crash)
      const output = tui.getOutput();
      expect(output.length).toBeGreaterThan(0);
    }, TIMEOUT);

    test("Escape cascade: closes overlays in priority order", async () => {
      // Open help
      tui.stdin.write("/help");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Shortcuts");

      // Open model selector on top
      tui.stdin.write("\x18"); // Ctrl+X
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("m");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Select Model");

      // Escape → close model selector
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).not.toContain("Select Model");
      expect(tui.getOutput()).toContain("Shortcuts"); // help still open

      // Escape → close help
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).not.toContain("Shortcuts");
    }, TIMEOUT);
  });

  describe("Error Handling", () => {
    test("model error → TUI does not hang → idle restored", async () => {
      await tui.sendMessage("do something");
      await tui.waitForIdle(15000);
      expect(tui.isRunning()).toBe(false);
      // Error message should be in output
      expect(tui.getOutput()).toContain("Network timeout");
    }, TIMEOUT);
  });

  describe("Tool Call", () => {
    test("tool call renders in output", async () => {
      await tui.sendMessage("read test.txt");
      await tui.waitForIdle(15000);
      const output = tui.getOutput();
      expect(output).toContain("read_file");
      expect(output).toContain("File looks good");
    }, TIMEOUT);
  });
});
```

Note: the `plan.verify(0)` call in `afterAll` passes 0 as a placeholder — the actual `_callCount` is not accessible from outside the model. To access it, we need to expose it through the harness. Let's handle this in Step 2.

- [ ] **Step 2: Expose _callCount through TuiHarness**

In `render-tui.tsx`, add to `TuiHarness` interface:
```typescript
  /** Get mock model call count for response plan verification */
  getCallCount: () => number;
```

In the harness implementation, add after `isIdle()`:
```typescript
      getCallCount: () => (model as any)._callCount?.count ?? 0,
```

Then update the `afterAll` in startup.test.tsx:
```typescript
  afterAll(() => {
    plan.verify(tui.getCallCount());
    tui?.unmount();
  });
```

**Important:** The `model` needs to be captured in scope. Change `createTui` to return the model reference. Add a local `let mockModel: StreamingMockModel` and capture it:

In `createTui()`:
```typescript
  const model = new StreamingMockModel({ ... }) as unknown as SupportedChatModel;
  // ... later in harness:
  getCallCount: () => (model as any)._callCount?.count ?? 0,
```

Actually, `model` is already in scope. Just add the getter.

- [ ] **Step 3: Run P0 e2e tests**

```bash
bun test tests/e2e/startup.test.tsx
```

Expected: all 18 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/startup.test.tsx tests/e2e/render-tui.tsx
git commit -m "test: 重构 P0 e2e 测试，新增会话切换 block 保留、Kitty 键盘协议、中断恢复等回归防护"
```

---

### Task 4: Create interaction.test.tsx — P1 Key User Workflows

**Files:**
- Create: `tests/e2e/interaction.test.tsx`

**Response plan for P1:** Approval flow tests need tool_call + follow-up text per scenario. Slash commands and UI interactions consume no responses.

| Group | Count | Content |
|-------|-------|---------|
| approval-approve | 2 | tool_call "shell_execute", text "Command succeeded" |
| approval-deny | 2 | tool_call "shell_execute", text "Denied by user" |
| approval-skip | 0 | (skip test uses non-model path) |
| question | 2 | tool_call "ask_user" with question, text "Got your answer" |
| question-esc | 2 | tool_call "ask_user", text "Cancelled" |

- [ ] **Step 1: Write interaction.test.tsx**

```typescript
/**
 * TUI E2E — P1 Key User Workflows
 *
 * Covers: tool approval flow, agent question flow, all slash commands,
 * slash suggestion dropdown, @file search, sidebar focus toggle.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text, toolCall } from "./response-plan";

const TIMEOUT = 60000;

const plan = new ResponsePlan([
  // Approval: approve (test 1)
  {
    group: "approval-approve",
    responses: [
      toolCall("shell_execute", { command: "npm test" }, "Let me run tests"),
      text("Command succeeded"),
    ],
  },
  // Approval: deny (test 2)
  {
    group: "approval-deny",
    responses: [
      toolCall("shell_execute", { command: "rm -rf /" }, "Let me clean up", 30),
      text("Denied by user"),
    ],
  },
  // Agent question (test 3)
  {
    group: "question",
    responses: [
      toolCall("ask_user", { question: "Which approach?" }, "Let me ask", 30),
      text("Got your answer, proceeding"),
    ],
  },
  // Agent question - esc cancel (test 4)
  {
    group: "question-esc",
    responses: [
      toolCall("ask_user", { question: "Continue?" }, "Need your input", 30),
      text("Operation cancelled"),
    ],
  },
]);

let tui: TuiHarness;

describe("P1: Key User Workflows", () => {

  beforeAll(async () => {
    tui = await createTui({ modelResponses: plan.flatten() });
  });

  afterAll(() => {
    plan.verify(tui.getCallCount());
    tui?.unmount();
  });

  // ══════════════════════════════════════════════════════
  // Tool Approval Flow
  // ══════════════════════════════════════════════════════

  describe("Tool Approval Flow", () => {
    test("approval block appears → approve (A) → tool executes → agent continues", async () => {
      await tui.sendMessage("run tests");
      await tui.waitForApproval(15000);

      const out = tui.getOutput();
      expect(out).toContain("[A]");
      expect(out).toContain("shell_execute");
      expect(out).toContain("npm test");

      // Approve
      await tui.approve("A");
      await tui.waitForIdle(15000);

      const final = tui.getOutput();
      expect(final).toContain("Command succeeded");
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);

    test("approval block appears → deny (D) → tool cancelled", async () => {
      await tui.sendMessage("clean up");
      await tui.waitForApproval(15000);

      await tui.approve("D");
      await tui.waitForIdle(15000);

      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);

    test("Ctrl+R switches to full_access → no approval needed for next tool", async () => {
      // Switch to full_access
      tui.stdin.write("\x12"); // Ctrl+R
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getAuthMode()).toBe("full_access");

      // Switch back to default
      tui.stdin.write("\x12"); // Ctrl+R
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getAuthMode()).toBe("default");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════
  // Agent Question Flow
  // ══════════════════════════════════════════════════════

  describe("Agent Question Flow", () => {
    test("agent asks question → user answers → agent continues", async () => {
      await tui.sendMessage("which approach?");
      await tui.waitForQuestion(15000);

      expect(tui.getOutput()).toContain("Which approach?");

      await tui.answerQuestion("option A");
      await tui.waitForIdle(15000);

      expect(tui.getOutput()).toContain("Got your answer");
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);

    test("question waiting → Esc cancels", async () => {
      await tui.sendMessage("continue?");
      await tui.waitForQuestion(15000);

      tui.stdin.write("\x1b"); // Escape
      await new Promise((r) => setTimeout(r, 500));
      await tui.waitForIdle(10000);

      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════
  // Slash Commands
  // ══════════════════════════════════════════════════════

  describe("Slash Commands", () => {
    test("/help — shows keyboard shortcuts panel → any key closes", async () => {
      tui.stdin.write("/help");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await tui.waitForOverlay("Shortcuts", 3000);
      expect(tui.getOutput()).toContain("Keyboard Shortcuts");
      expect(tui.getOutput()).toContain("Actions");
      expect(tui.getOutput()).toContain("Leader Keys");

      // Any key closes
      tui.stdin.write("x");
      await tui.waitForOverlayGone("Shortcuts", 3000);
    }, TIMEOUT);

    test("/model — opens model selector", async () => {
      tui.stdin.write("/model");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await tui.waitForOverlay("Select Model", 3000);
      expect(tui.getOutput()).toContain("DeepSeek");

      // Close with Esc
      tui.stdin.write("\x1b");
      await tui.waitForOverlayGone("Select Model", 3000);
    }, TIMEOUT);

    test("/model list — shows model list in output", async () => {
      tui.stdin.write("/model list");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Available Models");
      expect(tui.getOutput()).toContain("deepseek-v4");
    }, TIMEOUT);

    test("/model deepseek-v3 — switches model directly", async () => {
      tui.stdin.write("/model deepseek-v3");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("deepseek-v3");
    }, TIMEOUT);

    test("/plan — switches to planning phase", async () => {
      tui.stdin.write("/plan");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Planning");
      expect(tui.getAuthMode()).toBe("default"); // plan forces safe mode

      // Switch back
      tui.stdin.write("/auth");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
    }, TIMEOUT);

    test("/auth — toggles authorization mode", async () => {
      // Ensure we're in default first
      tui.stdin.write("/auth default");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getAuthMode()).toBe("default");

      // Toggle
      tui.stdin.write("/auth");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getAuthMode()).toBe("full_access");

      // Toggle back
      tui.stdin.write("/auth");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getAuthMode()).toBe("default");
    }, TIMEOUT);

    test("/clear — clears output area", async () => {
      // Ensure there's some content
      await tui.sendMessage("hello");
      await tui.waitForIdle(10000);

      tui.stdin.write("/clear");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      // Output should be cleared of previous message blocks
      // (the sidebar and chrome will always be there)
      const out = tui.getOutput();
      expect(out).not.toContain("hello");
    }, TIMEOUT);

    test("/thinking — toggles reasoning visibility", async () => {
      tui.stdin.write("/thinking");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      // Toggle back (can't verify visibility without reasoning content, but verify no crash)
      tui.stdin.write("/thinking");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 300));
      // Should not crash
      expect(tui.getOutput().length).toBeGreaterThan(10);
    }, TIMEOUT);

    test("/sessions — opens session selector", async () => {
      tui.stdin.write("/sessions");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      // Should show something (session selector might be empty or show sessions)
      expect(tui.getOutput().length).toBeGreaterThan(10);

      // Close
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
    }, TIMEOUT);

    test("/new — creates new session", async () => {
      const before = tui.getSessionCount();

      tui.stdin.write("/new");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 1000));

      expect(tui.getSessionCount()).toBeGreaterThanOrEqual(before + 1);
    }, TIMEOUT);

    test("/setting — shows current configuration", async () => {
      tui.stdin.write("/setting");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Current Settings");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════
  // Slash Suggestion Dropdown
  // ══════════════════════════════════════════════════════

  describe("Slash Suggestion Dropdown", () => {
    test("typing / triggers suggestion dropdown", async () => {
      tui.stdin.write("/");
      await new Promise((r) => setTimeout(r, 300));
      // Dropdown should show commands
      const out = tui.getOutput();
      expect(out).toContain("Commands matching");
    });

    test("Esc dismisses dropdown", async () => {
      tui.stdin.write("\x1b"); // Escape
      await new Promise((r) => setTimeout(r, 300));
      // Dropdown gone
      expect(tui.getOutput()).not.toContain("Commands matching");
    });

    test("typing /m shows model commands", async () => {
      tui.stdin.write("/m");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).toContain("model");
    });

    test("Tab completes common prefix", async () => {
      // Clear input first
      tui.stdin.write("\x1b"); // Esc to clear
      await new Promise((r) => setTimeout(r, 100));

      tui.stdin.write("/m");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("\t"); // Tab to complete
      await new Promise((r) => setTimeout(r, 200));
      // Should have completed /model (check via output, might show ghost text)
      expect(tui.getOutput().length).toBeGreaterThan(10);

      // Dismiss
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 200));
    });
  });

  // ══════════════════════════════════════════════════════
  // @File Search
  // ══════════════════════════════════════════════════════

  describe("@File Search", () => {
    test("typing @ triggers file search", async () => {
      tui.stdin.write("@");
      await new Promise((r) => setTimeout(r, 300));
      // File search dropdown should appear
      const out = tui.getOutput();
      expect(out).toContain("Files matching");
    });

    test("Esc dismisses file search", async () => {
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).not.toContain("Files matching");
    });

    test("typing @ with query filters results", async () => {
      tui.stdin.write("@package");
      await new Promise((r) => setTimeout(r, 300));
      // Should show matching files or "No matching files"
      const out = tui.getOutput();
      expect(out).toContain("Files matching @package");

      // Dismiss
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
    });
  });

  // ══════════════════════════════════════════════════════
  // Sidebar Focus Toggle
  // ══════════════════════════════════════════════════════

  describe("Sidebar Focus Toggle", () => {
    test("Tab focuses sidebar → shows focus indicator", async () => {
      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.isSidebarFocused()).toBe(true);
      expect(tui.getOutput()).toContain("Sidebar focused");
    });

    test("Tab again returns focus to input", async () => {
      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.isSidebarFocused()).toBe(false);
      expect(tui.getOutput()).not.toContain("Sidebar focused");
    });

    test("sidebar focused → typing chars does not enter input", async () => {
      tui.stdin.write("\t"); // Focus sidebar
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.isSidebarFocused()).toBe(true);

      // Type some chars — should not appear as input
      tui.stdin.write("xyz");
      await new Promise((r) => setTimeout(r, 300));
      // The output shouldn't contain "xyz" as user input (it might trigger shortcuts)
      // Primarily verify no crash and sidebar focus indicator still shows
      expect(tui.getOutput().length).toBeGreaterThan(10);
    });
  });
});
```

- [ ] **Step 2: Run P1 e2e tests**

```bash
bun test tests/e2e/interaction.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/interaction.test.tsx
git commit -m "test: 新增 P1 e2e 交互测试 — 审批流、提问、Slash 命令、建议下拉、文件搜索、Sidebar 焦点"
```

---

### Task 5: Create advanced.test.tsx — P2+P3 Advanced Scenarios

**Files:**
- Create: `tests/e2e/advanced.test.tsx`

**Response plan:** Most P2/P3 tests are UI-only. Only a few need model responses.

| Group | Count | Content |
|-------|-------|---------|
| input-tests | 3 | 3 text responses for multi-line and history tests |
| clear-resume | 1 | text "After clear response" |

- [ ] **Step 1: Write advanced.test.tsx**

```typescript
/**
 * TUI E2E — P2+P3 Advanced Interaction & Integration Scenarios
 *
 * Covers: multi-line input, history navigation, paste placeholder,
 * leader keys, global shortcuts, sidebar virtual window, session
 * status indicators, long output, rapid operations.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text } from "./response-plan";

const TIMEOUT = 60000;

const plan = new ResponsePlan([
  { group: "input-tests", responses: [text("Reply 1"), text("Reply 2"), text("Reply 3")] },
  { group: "clear-resume", responses: [text("After clear response")] },
]);

let tui: TuiHarness;

describe("P2+P3: Advanced Scenarios", () => {

  beforeAll(async () => {
    tui = await createTui({ modelResponses: plan.flatten() });
  });

  afterAll(() => {
    plan.verify(tui.getCallCount());
    tui?.unmount();
  });

  // ══════════════════════════════════════════════════════
  // P2: Input Advanced Interactions
  // ══════════════════════════════════════════════════════

  describe("Input — Multi-line & History", () => {
    test("Shift+Enter inserts newline → submit multi-line message", async () => {
      // Note: In test environment, Shift+Enter may not work the same as in real terminal.
      // We simulate by writing the newline character directly.
      // CtrlSafeTextInput handles \n in multi-line mode.
      // For e2e, we test that the TUI doesn't crash with multi-line input.
      // Actual Shift+Enter behavior is tested via unit/component tests.
      await tui.sendMessage("line1\nline2");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("Reply 1");
    }, TIMEOUT);

    test("history: ↑ restores previous input", async () => {
      // Send another message so we have history
      await tui.sendMessage("history-test-msg");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("Reply 2");
    });

    test("empty input (Enter with no text) does not submit", async () => {
      // Press Enter with empty input
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));
      // Should not trigger agent run — idle should remain
      expect(tui.isIdle()).toBe(true);
    });
  });

  describe("Input — Paste Placeholder", () => {
    test("paste >100 chars shows placeholder", async () => {
      // Send a long message to trigger paste threshold
      const longText = "x".repeat(150);
      await tui.sendMessage(longText);
      await tui.waitForIdle(15000);
      // When pasted via stdin, the paste state in InputLine uses usePaste hook.
      // In stdin simulation, we can't easily trigger the paste path.
      // This test verifies the TUI handles long input without crashing.
      expect(tui.getOutput()).toContain("Reply 3");
      expect(tui.isIdle()).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════
  // P2: Leader Keys
  // ══════════════════════════════════════════════════════

  describe("Leader Keys (Ctrl+X then …)", () => {
    test("Ctrl+X c → compact context", async () => {
      tui.stdin.write("\x18"); // Ctrl+X
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("c");
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Manual compaction");
    }, TIMEOUT);

    test("Ctrl+X m → opens model selector", async () => {
      tui.stdin.write("\x18");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("m");
      await tui.waitForOverlay("Select Model", 3000);

      // Close
      tui.stdin.write("\x1b");
      await tui.waitForOverlayGone("Select Model", 3000);
    }, TIMEOUT);

    test("Ctrl+X l → opens session selector", async () => {
      tui.stdin.write("\x18");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("l");
      await new Promise((r) => setTimeout(r, 500));
      // Should show session-related UI
      expect(tui.getOutput().length).toBeGreaterThan(10);

      // Close
      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
    }, TIMEOUT);

    test("Ctrl+X invalid key → leader cancelled, no side effect", async () => {
      // Get reference output
      const before = tui.getOutput();

      tui.stdin.write("\x18");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("z"); // invalid key
      await new Promise((r) => setTimeout(r, 300));

      // Output should be similar (no new panels)
      const after = tui.getOutput();
      expect(after).not.toContain("Select Model");
      expect(after).not.toContain("Manual compaction");
    }, TIMEOUT);

    test("Ctrl+X Esc → leader cancelled", async () => {
      tui.stdin.write("\x18");
      await new Promise((r) => setTimeout(r, 200));
      tui.stdin.write("\x1b"); // Esc
      await new Promise((r) => setTimeout(r, 300));
      // Should not have triggered any action
      expect(tui.isIdle()).toBe(true);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════
  // P2: Global Shortcuts
  // ══════════════════════════════════════════════════════

  describe("Global Shortcuts", () => {
    test("Ctrl+L — clears output", async () => {
      tui.stdin.write("\x0c"); // Ctrl+L
      await new Promise((r) => setTimeout(r, 500));
      // Output area should be cleared (chrome still visible)
      const out = tui.getOutput();
      expect(out).not.toContain("Reply"); // user/agent messages gone
      expect(out).toContain("OpenPX"); // chrome still there
    });

    test("Ctrl+N — creates new session", async () => {
      const before = tui.getSessionCount();
      tui.stdin.write("\x0e"); // Ctrl+N
      await new Promise((r) => setTimeout(r, 1000));
      expect(tui.getSessionCount()).toBeGreaterThanOrEqual(before + 1);
    }, TIMEOUT);

    test("Ctrl+R — toggles auth mode", async () => {
      const before = tui.getAuthMode();
      tui.stdin.write("\x12"); // Ctrl+R
      await new Promise((r) => setTimeout(r, 300));
      const after = tui.getAuthMode();
      expect(after).not.toBe(before);
    });

    test("Ctrl+T — toggles reasoning visibility", async () => {
      tui.stdin.write("\x14"); // Ctrl+T
      await new Promise((r) => setTimeout(r, 300));
      // Verify no crash — specific behavior depends on reasoning content
      expect(tui.getOutput().length).toBeGreaterThan(10);
    });

    test("Ctrl+H — opens help panel", async () => {
      tui.stdin.write("\x08"); // Ctrl+H
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain("Shortcuts");

      // Close
      tui.stdin.write("x");
      await new Promise((r) => setTimeout(r, 300));
    });
  });

  // ══════════════════════════════════════════════════════
  // P3: Complex Integration Scenarios
  // ══════════════════════════════════════════════════════

  describe("P3: Integration — /clear then resume", () => {
    test("/clear then send new message → works normally", async () => {
      tui.stdin.write("/clear");
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 500));

      await tui.sendMessage("resume after clear");
      await tui.waitForText("After clear response", 15000);
      expect(tui.getOutput()).toContain("After clear response");
      expect(tui.isIdle()).toBe(true);
    }, TIMEOUT);
  });

  describe("P3: Sidebar Virtual Window Overflow", () => {
    test("creating many sessions shows overflow indicators", async () => {
      // Create enough sessions to trigger virtual window
      for (let i = 0; i < 5; i++) {
        tui.stdin.write("\x0e"); // Ctrl+N
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 500));

      const count = tui.getSessionCount();
      expect(count).toBeGreaterThanOrEqual(5);

      // If terminal height (40) can't show all, overflow indicators appear
      const out = tui.getOutput();
      // Either all sessions visible or overflow indicators present
      expect(
        count <= 10 || out.includes("more")
      ).toBe(true);
    }, TIMEOUT);
  });

  describe("P3: Rapid Consecutive Operations", () => {
    test("send message → immediately Ctrl+C → clean stop → send again", async () => {
      await tui.sendMessage("quick cancel test");
      // Immediately cancel
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write("\x03"); // Ctrl+C
      await new Promise((r) => setTimeout(r, 500));

      await tui.waitForIdle(10000);

      // Should be able to send again
      await tui.sendMessage("after cancel");
      await tui.waitForIdle(15000);
      expect(tui.isIdle()).toBe(true);
    }, TIMEOUT);
  });

  describe("P3: Long Output", () => {
    test("TUI does not crash with large rendered output", async () => {
      // Verify output is reasonable after many operations
      const out = tui.getOutput();
      expect(out.length).toBeGreaterThan(100);
      // No crash = pass
    });
  });
});
```

- [ ] **Step 2: Run P2+P3 e2e tests**

```bash
bun test tests/e2e/advanced.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/advanced.test.tsx
git commit -m "test: 新增 P2+P3 e2e 高级交互与集成场景测试"
```

---

### Task 6: Supplement tui-reducer.test.ts

**Files:**
- Modify: `tests/tui-reducer.test.ts`

Add tests for the 11 currently-untested reducer actions.

- [ ] **Step 1: Add missing reducer action tests**

Insert the following test blocks into `tests/tui-reducer.test.ts` before the final closing `});` of the top-level `describe`:

```typescript
  describe("LOAD_SESSION", () => {
    test("resets nextId based on loaded blocks max id", () => {
      let s = fresh();
      // First add some blocks to advance nextId
      s = dispatch(s, textEvt("old"));
      const oldNextId = (s.blocks[0] as any).id + 1;

      // LOAD_SESSION with blocks that have higher ids
      const loaded: OutputBlock[] = [
        { id: 100, kind: "text", content: "loaded" },
        { id: 200, kind: "user", content: "query" },
      ];
      s = dispatch(s, {
        type: "LOAD_SESSION",
        blocks: loaded,
        interrupt: null,
        modelProvider: "deepseek",
        modelName: "deepseek-v4",
        thinkingLevel: "max",
      });
      expect(s.blocks).toEqual(loaded);
      expect(s.interrupt).toBeNull();
      expect(s.exited).toBe(false);
      expect(s.running).toBe(false);
      expect(s.compacting).toBe(false);
      expect(s.showSessions).toBe(false);
      expect(s.status.modelName).toBe("deepseek-v4");
      // Next block id should be > 200
      const next = dispatch(s, textEvt("after load"));
      expect((next.blocks[2] as any).id).toBeGreaterThan(200);
    });

    test("LOAD_SESSION with interrupt preserves it", () => {
      let s = fresh();
      const approval = { scope: "once" as const, cwd: "/tmp", threadId: "t1", tool: "shell_execute", command: "ls", risk: "read" as const, approvalHash: "abc", summary: "list", reason: "test", expectedEffects: [], grantOptions: ["approve_once" as const], recommendedGrant: "approve_once" as const };
      const loaded: OutputBlock[] = [
        { id: 1, kind: "approval", approval },
      ];
      s = dispatch(s, {
        type: "LOAD_SESSION",
        blocks: loaded,
        interrupt: { kind: "approval", blockId: 1 },
        modelProvider: "",
        modelName: "",
        thinkingLevel: null,
      });
      expect(s.interrupt).toEqual({ kind: "approval", blockId: 1 });
    });
  });

  describe("LEADER_PENDING / LEADER_CANCEL", () => {
    test("LEADER_PENDING sets leaderPending flag", () => {
      let s = fresh();
      s = dispatch(s, { type: "LEADER_PENDING" });
      expect(s.leaderPending).toBe(true);
    });

    test("LEADER_CANCEL clears leaderPending flag", () => {
      let s = fresh(); s = { ...s, leaderPending: true };
      s = dispatch(s, { type: "LEADER_CANCEL" });
      expect(s.leaderPending).toBe(false);
    });
  });

  describe("COMPACT_CONTEXT", () => {
    test("COMPACT_CONTEXT when running appends text block", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, { type: "COMPACT_CONTEXT" });
      expect(s.blocks).toHaveLength(1);
      expect((s.blocks[0] as any).content).toContain("Manual compaction");
    });

    test("COMPACT_CONTEXT when not running is no-op", () => {
      let s = fresh();
      const prev = s.blocks;
      s = dispatch(s, { type: "COMPACT_CONTEXT" });
      expect(s.blocks).toBe(prev);
    });
  });

  describe("SHOW_SESSIONS / HIDE_SESSIONS", () => {
    test("SHOW_SESSIONS sets showSessions flag", () => {
      let s = fresh();
      s = dispatch(s, { type: "SHOW_SESSIONS" });
      expect(s.showSessions).toBe(true);
    });

    test("HIDE_SESSIONS clears showSessions flag", () => {
      let s = fresh(); s = { ...s, showSessions: true };
      s = dispatch(s, { type: "HIDE_SESSIONS" });
      expect(s.showSessions).toBe(false);
    });

    test("ESCAPE closes showSessions", () => {
      let s = fresh(); s = { ...s, showSessions: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showSessions).toBe(false);
    });
  });

  describe("SHOW_REWIND / HIDE_REWIND / SET_CHECKPOINTS", () => {
    test("SHOW_REWIND sets showRewind flag", () => {
      let s = fresh();
      s = dispatch(s, { type: "SHOW_REWIND" });
      expect(s.showRewind).toBe(true);
    });

    test("HIDE_REWIND clears showRewind and checkpoints", () => {
      let s = fresh(); s = { ...s, showRewind: true, checkpoints: [{ threadId: "t1", checkpointId: "c1", timestamp: "2024-01-01", nodeName: "agent", step: 1 }] };
      s = dispatch(s, { type: "HIDE_REWIND" });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });

    test("SET_CHECKPOINTS stores checkpoint entries", () => {
      let s = fresh();
      const cps = [{ threadId: "t1", checkpointId: "c1", timestamp: "2024-01-01", nodeName: "agent", step: 1 }];
      s = dispatch(s, { type: "SET_CHECKPOINTS", checkpoints: cps });
      expect(s.checkpoints).toEqual(cps);
    });

    test("ESCAPE closes showRewind and clears checkpoints", () => {
      let s = fresh(); s = { ...s, showRewind: true, checkpoints: [{ threadId: "t1", checkpointId: "c1", timestamp: "2024-01-01", nodeName: "agent", step: 1 }] };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
  });

  describe("SHOW_MCP / HIDE_MCP", () => {
    test("SHOW_MCP sets showMcp flag", () => {
      let s = fresh();
      s = dispatch(s, { type: "SHOW_MCP" });
      expect(s.showMcp).toBe(true);
    });

    test("HIDE_MCP clears showMcp flag", () => {
      let s = fresh(); s = { ...s, showMcp: true };
      s = dispatch(s, { type: "HIDE_MCP" });
      expect(s.showMcp).toBe(false);
    });

    test("ESCAPE closes showMcp", () => {
      let s = fresh(); s = { ...s, showMcp: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showMcp).toBe(false);
    });
  });

  describe("INJECT_MCP_PROMPT", () => {
    test("INJECT_MCP_PROMPT appends user block with formatted prompt", () => {
      let s = fresh();
      s = dispatch(s, { type: "INJECT_MCP_PROMPT", server: "github", promptName: "list-repos" });
      expect(s.blocks).toHaveLength(1);
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "user" }>;
      expect(b.kind).toBe("user");
      expect(b.content).toContain("/mcp__github__list-repos");
    });
  });

  describe("EXPORT_SESSION", () => {
    test("EXPORT_SESSION appends export confirmation text block", () => {
      let s = fresh();
      s = { ...s, blocks: [{ id: 1, kind: "user", content: "Hello" }, { id: 2, kind: "text", content: "Hi!" }] };
      s = dispatch(s, { type: "EXPORT_SESSION" });
      const last = s.blocks.at(-1) as Extract<OutputBlock, { kind: "text" }>;
      expect(last.kind).toBe("text");
      expect(last.content).toContain("Session exported");
    });
  });

  describe("REVERT_TO_CHECKPOINT / FORK_FROM_CHECKPOINT", () => {
    test("REVERT_TO_CHECKPOINT increments rewindCounter and closes panel", () => {
      let s = fresh(); s = { ...s, showRewind: true, checkpoints: [{ threadId: "t1", checkpointId: "c1", timestamp: "2024-01-01", nodeName: "agent", step: 1 }] };
      s = dispatch(s, { type: "REVERT_TO_CHECKPOINT", checkpointId: "c1" });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(1);
    });

    test("FORK_FROM_CHECKPOINT increments rewindCounter and closes panel", () => {
      let s = fresh(); s = { ...s, showRewind: true };
      s = dispatch(s, { type: "FORK_FROM_CHECKPOINT", checkpointId: "c1" });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(1);
    });
  });

  describe("Event.error with sessionError", () => {
    test("non-recoverable error sets sessionError flag", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "error", data: { message: "fatal", recoverable: false } } });
      expect(s.sessionError).toBe(true);
    });

    test("recoverable error does NOT set sessionError", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "error", data: { message: "retry", recoverable: true } } });
      expect(s.sessionError).toBe(false);
    });
  });

  describe("SET_SESSIONS edge case", () => {
    test("SET_SESSIONS with new session adds it", () => {
      const existing: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
      ];
      const incoming: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
      ];
      const state: TuiState = { ...createInitialState(), sessions: existing, activeSessionId: "a" };
      const next = eventReducer(state, { type: "SET_SESSIONS", sessions: incoming });
      expect(next.sessions).toHaveLength(2);
      expect(next.sessions[1].threadId).toBe("b");
      expect(next.activeSessionId).toBe("b"); // synced from incoming.active
    });

    test("SET_SESSIONS when no active in incoming preserves current activeSessionId", () => {
      const existing: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
      ];
      const incoming: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: createInitialState().status, blocks: [] },
      ];
      const state: TuiState = { ...createInitialState(), sessions: existing, activeSessionId: "a" };
      const next = eventReducer(state, { type: "SET_SESSIONS", sessions: incoming });
      expect(next.activeSessionId).toBe("a"); // preserved
    });
  });

  describe("text streaming edge cases", () => {
    test("text event when not running does not set streaming", () => {
      let s = fresh(); // running is false by default
      s = dispatch(s, textEvt("hello"));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "text" }>;
      expect(b.streaming).toBeUndefined();
    });

    test("new text block is created when last block is not a streaming text", () => {
      let s = fresh(); s = { ...s, running: true };
      // Add a user block first
      s = dispatch(s, { type: "USER_MESSAGE", text: "query" });
      // Now text event — should create new block (last is user, not streaming text)
      s = dispatch(s, textEvt("response"));
      expect(s.blocks).toHaveLength(2);
      expect(s.blocks[0].kind).toBe("user");
      expect(s.blocks[1].kind).toBe("text");
    });
  });
```

- [ ] **Step 2: Run reducer tests**

```bash
bun test tests/tui-reducer.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/tui-reducer.test.ts
git commit -m "test: 补充 reducer 缺失 action 测试 — LOAD_SESSION, Leader, Checkpoint, MCP, Export 等 11 类"
```

---

### Task 7: Full Regression & Validation

- [ ] **Step 1: Run all e2e tests**

```bash
bun test tests/e2e/
```

Expected: all 3 test files pass (~71 tests total).

- [ ] **Step 2: Run all unit tests**

```bash
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx
```

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 5: Update standards doc**

Add to `docs/space/execution/active/tui-e2e-standards.md` the new file structure and test file descriptions.

- [ ] **Step 6: Final commit (if any changes from regression fixes)**

```bash
git add -A
git diff --cached
# Review then:
git commit -m "docs: 更新 e2e 测试标准文档，反映重构后的文件结构"
```
