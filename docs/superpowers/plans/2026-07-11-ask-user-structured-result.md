# ask_user Structured Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve single and multi-question `ask_user` answers as typed runtime/TUI data so completed and replayed tool cards never derive answers from a truncated summary string.

**Architecture:** Add a narrowly scoped `userInput` result to `tool.finished` and the TUI `tool_done` payload. Persist it directly on `tool_card`, then render it as the primary source for `ask_user`; retain existing summary parsing only for legacy events. The runtime event log already serializes complete events, so replay needs only the same event-to-card projection as the live path.

**Tech Stack:** TypeScript, Bun test runner, React/Ink, runtime event store.

---

### Task 1: Define and emit the typed ask_user result

**Files:**
- Modify: `src/core/runtime/events.ts:52-63`
- Modify: `src/core/runtime/actions.ts:36-65`
- Test: `tests/runtime/actions.test.ts`

- [ ] **Step 1: Write the failing runtime-action test**

Add a test that puts a five-question `awaiting_user_input` interaction in runtime state, submits an input action with `answers`, and asserts the emitted `tool.finished` event contains the complete `{ answer, answers }` structured result even when its JSON stdout is longer than 200 characters.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test tests/runtime/actions.test.ts`

Expected: FAIL because `tool.finished.result` has no typed user-input result.

- [ ] **Step 3: Add the minimal runtime event contract**

Introduce an exported `UserInputResult` type containing `answer: string` and optional `answers: Record<string, string>`. Add optional `userInput?: UserInputResult` to `ToolFinishedEvent.result`. In `eventsForRuntimeAction`, set it only for `awaiting_user_input` input resolutions while retaining the existing JSON stdout for the model transcript.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test tests/runtime/actions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the runtime contract**

```bash
git add src/core/runtime/events.ts src/core/runtime/actions.ts tests/runtime/actions.test.ts
git commit -m "feat: preserve ask_user results in runtime events"
```

### Task 2: Carry typed answers through the TUI reducer

**Files:**
- Modify: `src/protocol/events.ts:210-238`
- Modify: `src/app/tui/types.ts:41-74`
- Modify: `src/app/tui/reducers/handleEvent.ts:703-920,1473-1484`
- Modify: `src/app/tui/reducers/agentReducer.ts:218-287`
- Test: `tests/tui-reducer.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Add tests that:

1. map a `tool.finished` event with a five-answer `userInput` result and oversized stdout into an `ask_user` tool card that retains the full answer map; and
2. resolve a multi-question interrupt and immediately populate the matching running `ask_user` card with the same structured result before `tool.finished` arrives.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `bun test tests/tui-reducer.test.ts`

Expected: FAIL because `ToolResultPayload` and `tool_card` have no structured answer field.

- [ ] **Step 3: Add TUI transport and state fields**

Add optional `userInput` data to `ToolResultPayload` and to `tool_card`. Map `event.result.userInput` in `handleRuntimeEventAction` without changing the generic summary truncation. Preserve that field in `handleEventAction` when finishing a tool card. In `RESOLVE_INTERRUPT`, extract the resolved `{ text, answers }` form and use it to prefill only the matching active `ask_user` card.

- [ ] **Step 4: Run focused reducer tests to verify they pass**

Run: `bun test tests/tui-reducer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the TUI event projection**

```bash
git add src/protocol/events.ts src/app/tui/types.ts src/app/tui/reducers/handleEvent.ts src/app/tui/reducers/agentReducer.ts tests/tui-reducer.test.ts
git commit -m "feat: retain structured ask_user answers in TUI state"
```

### Task 3: Render structured answers with a legacy fallback

**Files:**
- Modify: `src/app/tui/components/ToolCardBlock.tsx:74-207`
- Test: `tests/tui-layout.test.tsx`

- [ ] **Step 1: Write failing rendering tests**

Render a completed multi-question `tool_card` with five explicit ids and a structured answer map, then assert all five selected labels appear and none contain `(no answer)`. Add a second case without explicit ids, using keys `"0"` through `"4"`. Keep a legacy plain-text-summary case to prove older replay events still render.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test tests/tui-layout.test.tsx`

Expected: FAIL because rendering only receives and parses `summary`.

- [ ] **Step 3: Make the renderer use typed answers first**

Extend the ask-user answer parser/renderer input to accept `block.userInput`. When present, derive the single answer and multi-answer map directly from it. Fall back to the existing JSON/plain-text parser only when the typed data is absent. Preserve cancellation behavior and index fallback (`question.id ?? String(index)`).

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test tests/tui-layout.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the rendering change**

```bash
git add src/app/tui/components/ToolCardBlock.tsx tests/tui-layout.test.tsx
git commit -m "fix: render ask_user answers from structured results"
```

### Task 4: Verify session replay and whole-project compatibility

**Files:**
- Modify: `tests/session-manager.test.ts` or add a focused replay case beside existing session tests
- Verify: `src/app/tui/replay-blocks.ts`
- Verify: `src/core/persistence/sessions.ts`
- Verify: `src/core/runtime/store.ts`

- [ ] **Step 1: Write a failing replay test**

Create persisted runtime events containing `tool.queued` for a multi-question `ask_user` and `tool.finished` with a structured result plus deliberately truncated/invalid JSON stdout. Replay through `sessionDataToUI` and assert the resulting `tool_card.userInput.answers` contains all five values.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test tests/session-manager.test.ts`

Expected: FAIL until the TUI runtime-event mapping preserves `userInput`.

- [ ] **Step 3: Make only any necessary replay adjustment**

The expected implementation is no production change: runtime events are persisted as full JSON and replay already calls `handleRuntimeEventAction`. If the test reveals a boundary that drops `userInput`, apply the smallest compatible projection fix there.

- [ ] **Step 4: Run focused verification**

Run: `bun test tests/session-manager.test.ts tests/runtime/actions.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run full verification and commit any replay change**

Run: `bun test && bun run typecheck && bun run format:check`

Expected: all commands exit 0.

```bash
git add tests/session-manager.test.ts src/app/tui/replay-blocks.ts src/core/persistence/sessions.ts
git commit -m "test: cover ask_user answer replay"
```
