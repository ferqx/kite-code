# Remove `<Static>` with Reference-Stable Reducer + React.memo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate blank space between content and footer by removing `<Static>`; compensate for the lost performance optimization by making the reducer maintain reference stability on unchanged blocks + wrapping block renderers in `React.memo`.

**Architecture:** Instead of the `<Static>` component (which renders completed blocks to terminal scrollback and never touches them again), all blocks render in the regular React tree. The reducer is changed to avoid `.map()` for single-block updates — only the changed block gets a new object reference. `React.memo` on each block component skips re-render for blocks whose reference hasn't changed. Result: same rendering cost as `<Static>` but without the scrollback/layout gap.

**Tech Stack:** React 19, Ink 7, TypeScript

---

### Task 1: Add reference-stable block update helpers to handleEvent.ts

**Files:**
- Modify: `src/app/tui/reducers/handleEvent.ts:1-5` (add helpers)

Two helper functions to replace `.map()` patterns:

- [ ] **Step 1: Add helpers after the imports**

Before line 6 (`function getToolPreview`), insert:

```ts
/** Replace a single block by id — keeps references for all other blocks */
function replaceBlock(blocks: OutputBlock[], blockId: number, next: OutputBlock): OutputBlock[] {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return blocks;
  const copy = blocks.slice();
  copy[idx] = next;
  return copy;
}

/** Replace the last block matching a predicate — keeps references for all other blocks */
function replaceLastMatching(blocks: OutputBlock[], predicate: (b: OutputBlock) => boolean, next: OutputBlock): OutputBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (predicate(blocks[i])) {
      const copy = blocks.slice();
      copy[i] = next;
      return copy;
    }
  }
  return blocks;
}
```

- [ ] **Step 2: Run typecheck to verify helpers compile**

```bash
bun run typecheck 2>&1 | grep -v 'sessionReducer\|session-manager'
```

Expected: no new errors (pre-existing `cacheHitTokens` errors in unrelated files are OK).

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/reducers/handleEvent.ts
git commit -m "refactor: add reference-stable block update helpers"
```

---

### Task 2: Replace .map() with targeted updates in handleEvent.ts

**Files:**
- Modify: `src/app/tui/reducers/handleEvent.ts:90-100` (reason append)
- Modify: `src/app/tui/reducers/handleEvent.ts:120-139` (tool_done)
- Modify: `src/app/tui/reducers/handleEvent.ts:190-205` (need_approval finalize)
- Modify: `src/app/tui/reducers/handleEvent.ts:206-221` (need_input finalize)
- Modify: `src/app/tui/reducers/handleEvent.ts:273-326` (subagent_step, subagent_tool_result, subagent_done, subagent_error)

Each `.map()` call that updates a single block is replaced with `replaceBlock` or `replaceLastMatching`. The `.map()` in `need_approval`/`need_input` (which sets `streaming=false` on all text blocks) stays as-is because it's a bulk update — but still needs reference stability for non-text blocks.

- [ ] **Step 1: Replace reason append (line 93-99)**

The `reason` append currently uses `.map()` to find the currentRunReasonId block. Since `currentRunReasonId` is always the last `reason` block in the current run, we can use `replaceLastMatching`:

```ts
case "reason": {
  if (state.currentRunReasonId != null) {
    const lastBlock = state.blocks.at(-1);
    if (lastBlock?.kind === "reason" && lastBlock.id === state.currentRunReasonId) {
      const updated = replaceBlock(state.blocks, state.currentRunReasonId, {
        ...lastBlock,
        content: lastBlock.content + "\n\n" + event.data.text,
      });
      return { ...state, blocks: updated };
    }
  }
  const id = state.nextBlockId;
  const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
  return { ...state, blocks: [...state.blocks, block], currentRunReasonId: id, nextBlockId: id + 1 };
}
```

- [ ] **Step 2: Replace tool_done (line 126-137)**

`tool_done` matches by `callId` + `kind === "tool_card"`. Use `replaceLastMatching`:

```ts
case "tool_done": {
  if (event.data.name === "task") return state;
  const startedAt = state.toolStartTimes?.get(event.data.call_id);
  const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
  const nextTimes = new Map(state.toolStartTimes);
  nextTimes.delete(event.data.call_id);
  const predicate = (b: OutputBlock) => b.kind === "tool_card" && b.callId === event.data.call_id;
  const matched = state.blocks.findLast(predicate);
  let blocks = state.blocks;
  if (matched) {
    blocks = replaceLastMatching(state.blocks, predicate, {
      ...matched,
      status: event.data.ok ? "done" as const : "error" as const,
      summary: event.data.summary,
      elapsedMs,
      detail: computeToolDetail(matched.name, matched.args),
    });
  }
  return { ...state, blocks, toolStartTimes: nextTimes };
}
```

- [ ] **Step 3: Replace need_approval finalize (line 194-200)**

The `.map()` here finalizes ALL streaming text blocks. Keep the map but only it creates new refs for streaming text blocks — all other blocks keep their references. Current `.map()` already handles this correctly (returns `b` unchanged for non-text blocks, same reference). Actually, `.map()` returns NEW elements for all entries — even unchanged ones. Need to use a different approach:

```ts
case "need_approval": {
  // Finalize streaming text blocks
  let finalized = state.blocks;
  for (let i = 0; i < finalized.length; i++) {
    const b = finalized[i];
    if (b.kind === "text" && b.streaming) {
      const { streaming: _, ...rest } = b;
      finalized = replaceBlock(finalized, b.id, { ...rest, streaming: false } as OutputBlock);
    }
  }
  const blockId = state.nextBlockId;
  const block: OutputBlock = { id: blockId, kind: "approval", approval: event.data };
  const interrupt: InterruptState = { kind: "approval", blockId };
  return { ...state, blocks: [...finalized, block], interrupt, nextBlockId: blockId + 1 };
}
```

- [ ] **Step 4: Replace need_input finalize (line 210-216)**

Same pattern as need_approval:

```ts
case "need_input": {
  // Finalize streaming text blocks
  let finalized = state.blocks;
  for (let i = 0; i < finalized.length; i++) {
    const b = finalized[i];
    if (b.kind === "text" && b.streaming) {
      const { streaming: _, ...rest } = b;
      finalized = replaceBlock(finalized, b.id, { ...rest, streaming: false } as OutputBlock);
    }
  }
  const blockId = state.nextBlockId;
  const block: OutputBlock = { id: blockId, kind: "question", question: event.data };
  const interrupt: InterruptState = { kind: "input", blockId };
  return { ...state, blocks: [...finalized, block], interrupt, nextBlockId: blockId + 1 };
}
```

- [ ] **Step 5: Replace subagent_step (line 274-285)**

```ts
case "subagent_step": {
  const idx = state.blocks.findIndex(b => b.kind === "subagent" && b.subagentId === event.data.id);
  if (idx === -1) return state;
  const b = state.blocks[idx] as OutputBlock & { kind: "subagent" };
  const blocks = replaceBlock(state.blocks, b.id, {
    ...b,
    steps: [...b.steps, { toolName: event.data.toolName, toolArgs: event.data.toolArgs }],
  });
  return { ...state, blocks };
}
```

- [ ] **Step 6: Replace subagent_tool_result (line 289-300)**

```ts
case "subagent_tool_result": {
  const idx = state.blocks.findIndex(b => b.kind === "subagent" && b.subagentId === event.data.id);
  if (idx === -1) return state;
  const b = state.blocks[idx] as OutputBlock & { kind: "subagent" };
  const steps = b.steps.map((s, i) =>
    i === b.steps.length - 1 && s.toolName === event.data.toolName
      ? { ...s, ok: event.data.ok }
      : s
  );
  // Only update if steps actually changed
  const sameLength = steps.length === b.steps.length;
  if (sameLength && steps.every((s, i) => s === b.steps[i])) return state;
  const blocks = replaceBlock(state.blocks, b.id, { ...b, steps });
  return { ...state, blocks };
}
```

- [ ] **Step 7: Replace subagent_done (line 303-315)**

```ts
case "subagent_done": {
  const idx = state.blocks.findIndex(b => b.kind === "subagent" && b.subagentId === event.data.id);
  if (idx === -1) return state;
  const b = state.blocks[idx] as OutputBlock & { kind: "subagent" };
  const blocks = replaceBlock(state.blocks, b.id, {
    ...b,
    status: "done" as const,
    summary: event.data.summary,
    toolCallCount: event.data.toolCallCount,
    durationMs: event.data.durationMs,
  });
  return { ...state, blocks };
}
```

- [ ] **Step 8: Replace subagent_error (line 318-325)**

```ts
case "subagent_error": {
  const idx = state.blocks.findIndex(b => b.kind === "subagent" && b.subagentId === event.data.id);
  if (idx === -1) return state;
  const b = state.blocks[idx] as OutputBlock & { kind: "subagent" };
  const blocks = replaceBlock(state.blocks, b.id, { ...b, status: "error" as const, error: event.data.error });
  return { ...state, blocks };
}
```

- [ ] **Step 9: Run typecheck**

```bash
bun run typecheck 2>&1 | grep -v 'sessionReducer\|session-manager'
```

- [ ] **Step 10: Run reducer tests**

```bash
bun test tests/tui-reducer.test.ts
```

Expected: all 111 tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/app/tui/reducers/handleEvent.ts
git commit -m "refactor: targeted block updates maintain reference stability in handleEvent"
```

---

### Task 3: Replace .map() with targeted updates in agentReducer.ts

**Files:**
- Modify: `src/app/tui/reducers/agentReducer.ts:20-22` (SET_IDLE)
- Modify: `src/app/tui/reducers/agentReducer.ts:41-49` (RESOLVE_INTERRUPT)
- Modify: `src/app/tui/reducers/agentReducer.ts:111-112` (CTRL_C)
- Modify: `src/app/tui/reducers/agentReducer.ts:127-128` (ESCAPE)

- [ ] **Step 1: Import replaceBlock helper**

At top of agentReducer.ts, add:

```ts
import { replaceBlock } from "./handleEvent";
```

Wait, `replaceBlock` is a module-local function in handleEvent.ts. Better to extract it to a shared util. Instead, duplicate the helper in agentReducer.ts to keep things simple and avoid creating a new file:

```ts
/** Replace a single block by id — keeps references for all other blocks */
function replaceBlock(blocks: TuiState["blocks"], blockId: number, next: TuiState["blocks"][number]): TuiState["blocks"] {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return blocks;
  const copy = blocks.slice();
  copy[idx] = next;
  return copy;
}
```

Add this before the `resolveInterruptBlock` function (line 6).

- [ ] **Step 2: Replace SET_IDLE (line 20-22)**

```ts
case "SET_IDLE": {
  let blocks = state.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "text" && b.streaming) {
      const { streaming: _, ...rest } = b;
      blocks = replaceBlock(blocks, b.id, { ...rest, streaming: false } as OutputBlock);
    }
  }
  return { ...state, running: false, exited: false, interrupt: null, blocks, currentRunReasonId: undefined };
}
```

- [ ] **Step 3: Replace RESOLVE_INTERRUPT (line 41-49)**

```ts
case "RESOLVE_INTERRUPT": {
  const idx = state.blocks.findIndex(b => b.id === action.blockId);
  if (idx === -1) return state;
  const b = state.blocks[idx];
  let updated: OutputBlock;
  if (b.kind === "approval") {
    const r = typeof action.resolution === "string"
      ? { action: action.resolution }
      : action.resolution;
    updated = { ...b, resolved: r };
  } else if (b.kind === "question") {
    updated = { ...b, resolved: typeof action.resolution === "string" ? action.resolution : String(action.resolution) };
  } else {
    return state;
  }
  return { ...state, blocks: replaceBlock(state.blocks, action.blockId, updated), interrupt: null };
}
```

- [ ] **Step 4: Replace CTRL_C (line 111-112)**

```ts
case "CTRL_C": {
  if (state.running) {
    let blocks = state.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === "text" && b.streaming) {
        const { streaming: _, ...rest } = b;
        blocks = replaceBlock(blocks, b.id, { ...rest, streaming: false } as OutputBlock);
      }
    }
    let next = { ...state, running: false, ctrlCPressed: true, blocks };
    if (state.interrupt) {
      next.interrupt = null;
      const interruptIdx = blocks.findIndex(b => b.id === state.interrupt!.blockId);
      if (interruptIdx >= 0) {
        const b = blocks[interruptIdx];
        if (b.kind === "approval") {
          next.blocks = replaceBlock(next.blocks, b.id, { ...b, resolved: { action: "cancelled" } });
        } else if (b.kind === "question") {
          next.blocks = replaceBlock(next.blocks, b.id, { ...b, resolved: "cancelled" });
        }
      }
    }
    return next;
  }
  if (state.ctrlCPressed) return { ...state, exitRequested: true };
  return { ...state, ctrlCPressed: true };
}
```

- [ ] **Step 5: Replace ESCAPE (line 127-128)**

```ts
case "ESCAPE": {
  // Interrupt handling (after panel closing tried by uiReducer)
  if (state.running) {
    let blocks = state.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === "text" && b.streaming) {
        const { streaming: _, ...rest } = b;
        blocks = replaceBlock(blocks, b.id, { ...rest, streaming: false } as OutputBlock);
      }
    }
    let next = { ...state, running: false, ctrlCPressed: true, blocks };
    if (state.interrupt) {
      next.interrupt = null;
      const interruptIdx = blocks.findIndex(b => b.id === state.interrupt!.blockId);
      if (interruptIdx >= 0) {
        const b = blocks[interruptIdx];
        if (b.kind === "approval") {
          next.blocks = replaceBlock(next.blocks, b.id, { ...b, resolved: { action: "cancelled" } });
        } else if (b.kind === "question") {
          next.blocks = replaceBlock(next.blocks, b.id, { ...b, resolved: "cancelled" });
        }
      }
    }
    return next;
  }
  if (state.interrupt) {
    const interruptIdx = state.blocks.findIndex(b => b.id === state.interrupt.blockId);
    if (interruptIdx >= 0) {
      const b = state.blocks[interruptIdx];
      if (b.kind === "approval") {
        return { ...state, interrupt: null, blocks: replaceBlock(state.blocks, b.id, { ...b, resolved: { action: "cancelled" } }) };
      } else if (b.kind === "question") {
        return { ...state, interrupt: null, blocks: replaceBlock(state.blocks, b.id, { ...b, resolved: "cancelled" }) };
      }
    }
    return { ...state, interrupt: null };
  }
  return state;
}
```

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck 2>&1 | grep -v 'sessionReducer\|session-manager'
```

- [ ] **Step 7: Run reducer tests**

```bash
bun test tests/tui-reducer.test.ts
```

Expected: all 111 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/app/tui/reducers/agentReducer.ts
git commit -m "refactor: targeted block updates maintain reference stability in agentReducer"
```

---

### Task 4: Remove `<Static>` from OutputArea, use React.memo

**Files:**
- Modify: `src/app/tui/OutputArea.tsx:1-328`

This is the core change. Remove the `<Static>` split, render all blocks in a single dynamic tree, and wrap each block type in `React.memo` so unchanged blocks (stable references from the reducer) don't re-render.

- [ ] **Step 1: Remove Static import, add memoized block components**

Complete rewrite of OutputArea.tsx:

```tsx
import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import SubAgentBlock from "./components/SubAgentBlock";
import ToolCardBlock from "./components/ToolCardBlock";
import { darkTheme } from "./theme";
const dt = darkTheme;

// ── Memoized block components ──
// Each block type is wrapped in React.memo with its own equality check.
// Since the reducer now maintains reference stability for unchanged blocks,
// memo prevents terminal re-renders for blocks whose content hasn't changed.

const MemoUserBlock = React.memo(function UserBlock({ block }: { block: OutputBlock & { kind: "user" } }) {
  return (
    <Box marginBottom={1}>
      <MarkdownBlock content={"❯ " + block.content} />
    </Box>
  );
});

const MemoTextBlock = React.memo(function TextBlock({ block, isFocused }: { block: OutputBlock & { kind: "text" }; isFocused: boolean }) {
  return (
    <Box marginBottom={1}>
      {(isFocused || block.streaming) ? <Text color={dt.primary}>❯ </Text> : null}
      <MarkdownBlock content={block.content} streaming={block.streaming} color={block.isError ? dt.error : undefined} />
    </Box>
  );
});

const MemoReasonBlock = React.memo(function ReasonBlock({ block, isFocused, thinkVisible, isConsecutive }: {
  block: OutputBlock & { kind: "reason" };
  isFocused: boolean;
  thinkVisible: boolean;
  isConsecutive: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {!isConsecutive && (
        <Text color={isFocused ? dt.primary : dt.dim}>
          {!thinkVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
        </Text>
      )}
      {thinkVisible && !block.folded && (
        <Box paddingLeft={2}>
          <Text color={dt.muted}>{block.content}</Text>
        </Box>
      )}
      {isConsecutive && (block.folded || !thinkVisible) && (
        <Text color={dt.dim}>  ...</Text>
      )}
    </Box>
  );
});

const MemoToolCardBlock = React.memo(function MemoToolCardBlock({ block }: { block: OutputBlock & { kind: "tool_card" } }) {
  return (
    <Box marginBottom={1}>
      <ToolCardBlock block={block} />
    </Box>
  );
});

const MemoFileChangeBlock = React.memo(function FileChangeBlock({ block }: { block: OutputBlock & { kind: "file_change" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={dt.muted}>── File Changes ──</Text>
      {block.changes.map((change, ci) => {
        const prefixChar = change.kind === "add" ? "+" : change.kind === "edit" ? "~" : "-";
        const color = change.kind === "add" ? dt.success : change.kind === "edit" ? dt.warning : dt.error;
        const lineInfo = (change.linesAdded != null || change.linesRemoved != null)
          ? ` (${[change.linesAdded != null ? `+${change.linesAdded}` : "", change.linesRemoved != null ? `-${change.linesRemoved}` : ""].filter(Boolean).join(" ")})`
          : "";
        return (
          <Box key={`${block.id}-${ci}`} flexDirection="column">
            <Box>
              <Text color={color}>{prefixChar} {change.path}</Text>
              {lineInfo ? <Text color={dt.dim}>{lineInfo}</Text> : null}
            </Box>
            {change.preview && (
              <Box paddingLeft={3} flexDirection="column">
                {change.preview.split("\n").map((pl, pli) => (
                  <Text key={pli} color={dt.dim}>
                    │ {pl}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
});

const MemoApprovalBlock = React.memo(function ApprovalBlock({ block }: { block: OutputBlock & { kind: "approval" } }) {
  const label = (() => {
    if (!block.resolved) return null;
    if (block.resolved.action === "cancelled") return "⊘ Cancelled";
    if (block.resolved.action === "denied") return "× Denied";
    if (block.resolved.action === "approve_once") return "✓ Approved (once)";
    if (block.resolved.action === "same_command") return `✓ Approved (same command)${block.resolved.pattern ? ` "${block.resolved.pattern}"` : ""}`;
    if (block.resolved.action === "full_access") return "✓ Approved (full access)";
    return `? ${block.resolved.action}`;
  })();
  return (
    <Box flexDirection="column" marginBottom={1}>
      {label ? (
        <Text color={label.startsWith("✓") ? dt.success : dt.error}>{label}</Text>
      ) : (
        <Text color={dt.warning}>⚠ Awaiting approval — {block.approval.command}</Text>
      )}
    </Box>
  );
});

const MemoQuestionBlock = React.memo(function QuestionBlock({ block }: { block: OutputBlock & { kind: "question" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {block.resolved ? (
        block.resolved === "cancelled" ? (
          <Text color={dt.dim}>⊘ Question cancelled</Text>
        ) : (
          <Text>
            <Text color={dt.success}>✓ Answered: </Text>
            <Text color={dt.muted}>{block.resolved}</Text>
          </Text>
        )
      ) : (
        <Text color={dt.primary}>? Question</Text>
      )}
    </Box>
  );
});

const MemoSubAgentBlock = React.memo(function MemoSubAgentBlock({ block }: { block: OutputBlock & { kind: "subagent" } }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <SubAgentBlock block={block} />
    </Box>
  );
});

// ── Block renderer ──
function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, prevBlock?: OutputBlock) {
  switch (block.kind) {
    case "user":
      return <MemoUserBlock key={block.id} block={block} />;
    case "text":
      return <MemoTextBlock key={block.id} block={block} isFocused={isFocused} />;
    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      return <MemoReasonBlock key={block.id} block={block} isFocused={isFocused} thinkVisible={thinkingVisible} isConsecutive={isConsecutive} />;
    }
    case "tool_card":
      return <MemoToolCardBlock key={block.id} block={block} />;
    case "file_change":
      return <MemoFileChangeBlock key={block.id} block={block} />;
    case "approval":
      return <MemoApprovalBlock key={block.id} block={block} />;
    case "question":
      return <MemoQuestionBlock key={block.id} block={block} />;
    case "subagent":
      return <MemoSubAgentBlock key={block.id} block={block} />;
    default:
      return null;
  }
}

// ── Public utilities ──
export function toolColor(status: string): string {
  switch (status) {
    case "done": return dt.success;
    case "error": return dt.error;
    case "running": return dt.warning;
    default: return dt.muted;
  }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function changePrefix(kind: string): { prefix: string; color: string } {
  switch (kind) {
    case "add": return { prefix: "+", color: dt.success };
    case "edit": return { prefix: "~", color: dt.warning };
    case "delete": return { prefix: "-", color: dt.error };
    default: return { prefix: "?", color: dt.muted };
  }
}

// ── OutputArea component ──
interface OutputAreaProps {
  blocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  thinkingVisible: boolean;
  running: boolean;
  overlayActive?: boolean;
  sessionKey?: number;
  header?: React.ReactNode;
  interruptBlockId?: number;
}

const OutputArea = React.memo(function OutputArea({ blocks, onToggleReason, thinkingVisible, running, overlayActive, sessionKey, header, interruptBlockId }: OutputAreaProps) {
  // Arrow key navigation
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const focusedRef = useRef(focusedIdx);
  focusedRef.current = focusedIdx;

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (overlayActive) return;
    if (blocks.length === 0) return;
    if (key.upArrow) {
      setFocusedIdx((prev) => Math.max(0, (prev ?? blocks.length) - 1));
    }
    if (key.downArrow) {
      setFocusedIdx((prev) => Math.min(blocks.length - 1, (prev ?? -1) + 1));
    }
    if (key.return && focusedRef.current !== null && focusedRef.current < blocks.length) {
      const block = blocks[focusedRef.current];
      if (block && block.kind === "reason") {
        onToggleReason(block.id);
      }
    }
  });

  return (
    <Box flexDirection="column">
      {header}
      {blocks.map((block, i) => {
        const isFocused = i === focusedIdx;
        const prevBlock = i > 0 ? blocks[i - 1] : undefined;
        return renderBlock(block, isFocused, thinkingVisible, prevBlock);
      })}
    </Box>
  );
});

export default OutputArea;
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck 2>&1 | grep -v 'sessionReducer\|session-manager'
```

- [ ] **Step 3: Run TUI layout tests**

```bash
bun test tests/tui-layout.test.tsx
```

- [ ] **Step 4: Run TUI reducer tests**

```bash
bun test tests/tui-reducer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/tui/OutputArea.tsx
git commit -m "refactor: replace Static with React.memo block components in OutputArea"
```

---

### Task 5: Remove flexGrow from OutputArea wrapper in App.tsx

**Files:**
- Modify: `src/app/tui/App.tsx:145-146`

Since `<Static>` is gone and OutputArea handles all layout internally, remove the wrapping flexGrow Box.

- [ ] **Step 1: Remove flexGrow wrapper**

Change lines 144-147 from:

```tsx
<Box flexDirection="column">
  {/* ── Body: OutputArea (flexGrow) ── */}
  <Box flexDirection="column" flexGrow={1}>
```

To the simplified version (OutputArea handles flexGrow internally now):

```tsx
<Box flexDirection="column">
  {/* ── Body: OutputArea ── */}
```

And remove the corresponding closing `</Box>` that was the wrapper. The closing tag is on line 164 (after the `</OutputArea>` JSX).

Now the layout is:
```tsx
<Box flexDirection="column">
  {/* ── Body: OutputArea ── */}
  {state.loadingSession ? (
    <>
      <MemoHeader ... />
      ...
    </>
  ) : (
    <OutputArea ... flexGrow internal />  ← OutputArea has its own flexGrow
  )}

  {/* ── Footer ── */}
  <Footer ... />

  {/* ── Overlay panels ── */}
  ...
</Box>
```

- [ ] **Step 2: Verify layout and run tests**

The OutputArea (Task 4) has no `flexGrow` — it's compact. The spacer `{!slashSuggestion && <Box flexGrow={1} />}` below Footer absorbs remaining terminal space. Content flows: Header → Blocks → Footer → Spacer. No gap between last block and Footer.

With `<Static>` removed, all blocks are in the regular Yoga layout tree (not split between scrollback and viewport). Yoga sees the actual content height, so layout recalculations are consistent.

```bash
bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts tests/tui-session-switch.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/App.tsx
git commit -m "fix: compact output layout without Static wrapper"
```

---

### Verification Checklist

After all tasks complete:

- [ ] `bun run typecheck` — zero new errors (only pre-existing `cacheHitTokens` warnings)
- [ ] `bun test tests/tui-reducer.test.ts` — 111 tests pass
- [ ] `bun test tests/tui-layout.test.tsx` — 94 tests pass
- [ ] `bun test tests/tui-session-switch.test.tsx` — all pass
- [ ] `bun test tests/e2e/` — all e2e tests pass (mock agent)
- [ ] Manual: `bun run tui` — verify no blank space between last content line and Footer
- [ ] Manual: `bun run tui` — scroll up during agent output, verify no auto-jump to top
