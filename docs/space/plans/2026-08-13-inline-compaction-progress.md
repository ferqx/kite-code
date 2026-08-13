# Inline Compaction Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual and automatic context compaction non-modal, show both as inline message-area progress, and retain agent-run status only for automatic compaction.

**Architecture:** Replace the status/inline placement split with a manual/automatic source discriminator. Project the durable automatic request event as `/auto-compact`, keep compaction progress separate from `status.currentNode`, and exercise the final composition through independent real-PTY variants.

**Tech Stack:** TypeScript, React, Ink, Bun test runner, repository PTY harness.

## Global Constraints

- `/auto-compact` is display-only and must not be registered as a user slash command.
- Both compaction sources use `CompactionProgress` in `OutputArea` and never disable `InputLine`.
- Manual compaction hides agent-run status; automatic compaction preserves it.
- Existing unrelated worktree changes must remain untouched.

---

### Task 1: Lock the reducer and visibility contract

**Files:**
- Modify: `tests/run-status.test.ts`
- Modify: `tests/tui-reducer.test.ts`
- Modify: `src/app/tui/reducers/actions.ts`
- Modify: `src/app/tui/reducers/agentReducer.ts`
- Modify: `src/app/tui/reducers/handleEvent.ts`
- Modify: `src/app/tui/types.ts`

**Interfaces:**
- Produces: `compactionProgress?: { phase: ContextCompactionProgressPhase; source: 'manual' | 'automatic' }`
- Produces: `SET_COMPACTION_PROGRESS` with an active `phase` and `source`, or no phase to clear.
- Produces: automatic `context.compaction_requested` projection as a user-style `/auto-compact` block.

- [ ] **Step 1: Write failing reducer and visibility tests**

Add assertions equivalent to:

```ts
expect(shouldDisablePromptInput({ interrupt: null })).toBe(false);
expect(shouldShowRunStatus({ ...running, compactionProgress: { phase: 'summarizing', source: 'manual' } })).toBe(false);
expect(shouldShowRunStatus({ ...running, compactionProgress: { phase: 'summarizing', source: 'automatic' } })).toBe(true);
expect(dispatch(state, automaticRequest).turns.at(-1)?.blocks.at(-1)).toMatchObject({
  kind: 'user',
  content: '/auto-compact',
});
```

Also assert that a manual request does not synthesize a second command row and that session load clears the new source-bearing projection.

- [ ] **Step 2: Run focused tests and verify the old placement model fails**

Run: `bun test tests/run-status.test.ts tests/tui-reducer.test.ts`

Expected: FAIL on `source`, automatic command projection, and non-modal manual input assertions.

- [ ] **Step 3: Implement the minimal state and event changes**

Change the state/action discriminator from `placement` to `source`; stop mutating `status.currentNode`; add a `context.compaction_requested` handler that appends `/auto-compact` only for `reason === 'auto'`.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `bun test tests/run-status.test.ts tests/tui-reducer.test.ts`

Expected: PASS.

### Task 2: Unify inline rendering and keep input enabled

**Files:**
- Modify: `src/app/tui/App.tsx`
- Modify: `src/app/tui/OutputArea.tsx`
- Modify: `src/app/tui/index.tsx`
- Modify: `tests/tui-layout.test.tsx`
- Modify: `tests/tui-mock-render.test.tsx`
- Modify: `tests/run-status.test.ts`

**Interfaces:**
- Consumes: source-bearing `compactionProgress` from Task 1.
- Produces: `OutputArea` prop `compactionPhase?: ContextCompactionProgressPhase`.
- Produces: `shouldDisablePromptInput(state: Pick<TuiState, 'interrupt'>): boolean`.

- [ ] **Step 1: Add failing render assertions for both sources**

Render `OutputArea` with `compactionPhase: 'summarizing'` and assert `Summarizing context` is present. Assert input remains enabled for manual and automatic progress, manual status is hidden, and automatic status is shown.

- [ ] **Step 2: Run focused render tests and verify failure**

Run: `bun test tests/run-status.test.ts tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx`

Expected: FAIL while `OutputArea` still accepts only `inlineCompactionPhase` and manual progress disables input.

- [ ] **Step 3: Implement unified rendering**

Always pass `state.compactionProgress?.phase` into `OutputArea`, rename the prop to `compactionPhase`, make prompt disabling interrupt-only, and dispatch `source: 'manual' | 'automatic'` from the two production progress callbacks.

- [ ] **Step 4: Run focused render tests and verify pass**

Run: `bun test tests/run-status.test.ts tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx`

Expected: PASS.

### Task 3: Add deterministic PTY coverage for both flows

**Files:**
- Modify: `tests/tui-system/fixtures/compaction-status-input-tui.tsx`
- Modify: `tests/tui-system/scenarios/compaction-status-input.test.ts`
- Modify if required by discovery: `tests/test-discovery.test.ts`

**Interfaces:**
- Consumes: the production `App`, `OutputArea`, run-status predicate, and `InputLine` behavior.
- Produces: two isolated PTY cases selected by fixture environment, `manual` and `automatic`.

- [ ] **Step 1: Expand the PTY assertions before changing the fixture**

For manual, require `/compact`, `Summarizing context`, no `Thinking`, and typed draft echo. For automatic, require `/auto-compact`, `Summarizing context`, visible `Thinking`, and typed draft echo. Spawn a fresh PTY for each case.

- [ ] **Step 2: Run the scenario and verify the expanded assertions fail**

Run: `bun run scripts/run-tui-system-tests.ts compaction-status-input`

Expected: FAIL because the current fixture renders neither unified command/progress/status composition.

- [ ] **Step 3: Mount the real production composition in the fixture**

Build source-specific state with `createInitialState()` and reducer actions, render `App` with a real `InputLine`, and select the source through the fixture's isolated environment.

- [ ] **Step 4: Run the PTY scenario and verify both variants pass**

Run: `bun run scripts/run-tui-system-tests.ts compaction-status-input`

Expected: PASS for both independent variants.

### Task 4: Update current behavior documentation and verify regression boundaries

**Files:**
- Modify: `docs/active/tui-run-status-bar.md`
- Modify: `docs/active/tui-e2e-standards.md` only if the PTY contract itself changes.

**Interfaces:**
- Consumes: final behavior from Tasks 1-3.
- Produces: authoritative active documentation matching the implementation.

- [ ] **Step 1: Replace the obsolete placement/modal description**

Document source-based behavior, inline progress for both flows, `/auto-compact` event projection, interrupt-only prompt disabling, and session cleanup.

- [ ] **Step 2: Run all relevant verification**

Run:

```bash
bun test tests/run-status.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx tests/test-discovery.test.ts
bun run scripts/run-tui-system-tests.ts compaction-status-input compact-after-session-switch session-switch session-persistence
bun run typecheck
bun run check:docs-impact
bun run check:docs
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect the scoped diff**

Run: `git diff --check` and `git diff -- <all files listed above>`.

Expected: no whitespace errors and no unrelated edits introduced by this task.
