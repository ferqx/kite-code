# TUI Layout & Aesthetic Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10+ layout/aesthetic issues identified by E2E fixture audit across Header (alignment), Footer (spacing), dialogs (separators, Unicode, labels), and OutputArea (reason dedup, answered markers, denied symbol).

**Architecture:** Three sequential layers — each layer modifies 1-4 source files, regenerates fixtures, and verifies via `bun run test:e2e`. No new files created; all changes are surgical edits to existing components.

**Tech Stack:** Ink (React TUI), Bun test runner, existing E2E framework

---

### Task 1: Layer 1 — Header Logo Alignment + Footer Spacing

**Files:**
- Modify: `src/app/tui/Header.tsx:62` — add 1 trailing space to row 2 logo
- Modify: `src/app/tui/Footer.tsx:8` — add space after `?`

- [ ] **Step 1: Fix Header row 2 alignment**

In `src/app/tui/Header.tsx`, line 62, the row 2 logo string is `"▝▜█████▛▘  "` (10 chars). Row 1 logo `" ▐▛███▜▌   "` is 11 chars. Add 1 trailing space:

Change line 62 from:
```tsx
          {"▝▜█████▛▘  "}
```
to:
```tsx
          {"▝▜█████▛▘   "}
```

- [ ] **Step 2: Fix Footer spacing**

In `src/app/tui/Footer.tsx`, line 8, change `"? shortcuts"` to `"?  shortcuts"` (add space after `?`):

Change line 8 from:
```tsx
      <Text color={t.dim}>? shortcuts</Text>
```
to:
```tsx
      <Text color={t.dim}>?  shortcuts</Text>
```

- [ ] **Step 3: Regenerate all fixtures**

```bash
$env:UPDATE_SNAPSHOTS="true"; bun run test:e2e
```

Expected: ALL PASS (40 tests, fixtures regenerated)

- [ ] **Step 4: Verify fixtures stable**

```bash
bun run test:e2e
```

Expected: ALL PASS (40 tests, fixtures match)

- [ ] **Step 5: Verify existing TUI tests still pass**

```bash
bun test ./tests/tui-layout.test.tsx ./tests/tui-interaction.test.tsx ./tests/tui-mock-render.test.tsx
```

Expected: ALL PASS (129 tests)

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/Header.tsx src/app/tui/Footer.tsx tests/e2e/fixtures/
git commit -m "fix(tui): align header logo column + add footer space after ?"
```

---

### Task 2: Layer 2 — Dialog improvements (separators, Unicode, labels, questions)

**Files:**
- Modify: `src/app/tui/components/ApprovalBlock.tsx:113-117` — add separator before instruction, replace `↑↓` with `up/down`
- Modify: `src/app/tui/components/InputBlock.tsx:65` — replace `↑↓` with `up/down`
- Modify: `src/app/tui/components/InputBlock.tsx:69-72` — add placeholder for free-text mode
- Modify: `src/app/tui/components/ModelSelector.tsx:57` — replace `↑↓` with `up/down`
- Modify: `src/app/tui/OutputArea.tsx:44-50` — unify approval label format
- Modify: `src/app/tui/OutputArea.tsx:165-175` — simplify question block display

- [ ] **Step 1: ApprovalBlock — add separator + fix Unicode arrows**

In `src/app/tui/components/ApprovalBlock.tsx`, change the instruction line (113-117):

Old:
```tsx
      <Text color={t.dim} marginTop={1}>
        {editMode
          ? "Editing command — Enter to confirm, Esc to cancel"
          : "Press key to select, E to edit command, ↑↓ + Enter"}
      </Text>
```

New:
```tsx
      <Box height={1} />
      <Text color={t.dim}>
        {editMode
          ? "Editing command — Enter to confirm, Esc to cancel"
          : "Press key to select, E to edit command, up/down + Enter"}
      </Text>
```

(Replace `marginTop={1}` on `<Text>` with a `<Box height={1} />` before it for a clear visual separator; replace `↑↓` with `up/down`.)

- [ ] **Step 2: InputBlock — fix Unicode arrows + add placeholder**

In `src/app/tui/components/InputBlock.tsx`:

a) Line 64-66 — replace `↑↓` with `up/down`:
Old:
```tsx
            <Text color={t.dim} marginTop={1}>[Tab] type freely  [Enter] confirm</Text>
```
New:
```tsx
            <Box height={1} />
            <Text color={t.dim}>[Tab] type freely  [Enter] confirm</Text>
```

b) Line 69-72 — add placeholder for free-text mode when options are absent:

Old:
```tsx
      ) : (
        <Box>
          <Text color={t.primary}>{"> "}</Text>
          <TextInput value={freeText} onChange={setFreeText} onSubmit={handleSubmit} />
        </Box>
      )}
```

New:
```tsx
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text color={t.primary}>{"> "}</Text>
            <TextInput value={freeText} onChange={setFreeText} onSubmit={handleSubmit} placeholder="type your answer..." />
          </Box>
        </Box>
      )}
```

- [ ] **Step 3: ModelSelector — fix Unicode arrows**

In `src/app/tui/components/ModelSelector.tsx`, line 57:

Old:
```tsx
      <Text color={t.dim} marginTop={1}>↑↓ navigate  Enter select  Esc cancel</Text>
```

New:
```tsx
      <Box height={1} />
      <Text color={t.dim}>up/down navigate  Enter select  Esc cancel</Text>
```

- [ ] **Step 4: OutputArea — unify approval label format**

In `src/app/tui/OutputArea.tsx`, lines 44-50, change the `resolveApprovalLabel` function:

Old:
```tsx
function resolveApprovalLabel(resolved?: { action: string; grant?: string; pattern?: string }): string {
  if (!resolved) return "";
  if (resolved.action === "denied") return "✗ Denied";
  if (resolved.action === "approve_once") {
    if (resolved.grant === "full_access") return "✓ Approved (full access)";
    if (resolved.grant === "same_command") return `✓ Approved same command${resolved.pattern ? ` ("${resolved.pattern}")` : ""}`;
    return "✓ Approved once";
  }
  return `? ${resolved.action}`;
}
```

New:
```tsx
function resolveApprovalLabel(resolved?: { action: string; grant?: string; pattern?: string }): string {
  if (!resolved) return "";
  if (resolved.action === "denied") return "× Denied";
  if (resolved.action === "approve_once") {
    if (resolved.grant === "full_access") return "✓ Approved (full access)";
    if (resolved.grant === "same_command") return `✓ Approved (same command)${resolved.pattern ? ` "${resolved.pattern}"` : ""}`;
    return "✓ Approved (once)";
  }
  return `? ${resolved.action}`;
}
```

Changes:
- `✗` → `×` (U+00D7, ASCII-friendly)
- `✓ Approved once` → `✓ Approved (once)` (consistent parenthetical)
- `✓ Approved same command` → `✓ Approved (same command)` (consistent parenthetical)
- `("pattern")` → `"pattern"` (cleaner quoting without double parens)

- [ ] **Step 5: OutputArea — simplify question block inline display**

In `src/app/tui/OutputArea.tsx`, lines 165-175, simplify the question block rendering:

Old:
```tsx
    case "question": {
      return (
        <Box key={block.id} flexDirection="column">
          {block.resolved ? (
            <Text color={t.primary}>? {block.resolved}</Text>
          ) : (
            <Text color={t.primary}>? {block.question.question} (awaiting response...)</Text>
          )}
        </Box>
      );
    }
```

New:
```tsx
    case "question": {
      return (
        <Box key={block.id} flexDirection="column">
          {block.resolved ? (
            <Text>
              <Text color={t.success}>✓ Answered: </Text>
              <Text color={t.muted}>{block.resolved}</Text>
            </Text>
          ) : (
            <Text color={t.primary}>? Question</Text>
          )}
        </Box>
      );
    }
```

Changes:
- Awaiting state: show `? Question` (simple, no duplicate text — full question is in the InputBlock overlay)
- Answered state: show `✓ Answered: <answer>` with success color + muted answer text

- [ ] **Step 6: Regenerate fixtures**

```bash
$env:UPDATE_SNAPSHOTS="true"; bun run test:e2e
```

Expected: 40 tests PASS, fixtures regenerated

- [ ] **Step 7: Verify fixtures stable**

```bash
bun run test:e2e
```

Expected: 40 tests PASS, fixtures match

- [ ] **Step 8: Verify existing TUI tests**

```bash
bun test ./tests/tui-layout.test.tsx ./tests/tui-interaction.test.tsx
```

Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/app/tui/components/ApprovalBlock.tsx src/app/tui/components/InputBlock.tsx src/app/tui/components/ModelSelector.tsx src/app/tui/OutputArea.tsx tests/e2e/fixtures/
git commit -m "fix(tui): dialog layout improvements — separators, ASCII arrows, unified labels, question display"
```

---

### Task 3: Layer 3 — OutputArea reason dedup + tool error styling + spacing

**Files:**
- Modify: `src/app/tui/OutputArea.tsx:87-99` — skip repeated `▶ Thinking...` header for consecutive reason blocks
- Modify: `src/app/tui/OutputArea.tsx:117-122` — distinct error color/prefix for tool error summary
- Modify: `src/app/tui/OutputArea.tsx:101-123` — add spacing between consecutive tool_card blocks

- [ ] **Step 1: Dedup consecutive reason block headers**

In `src/app/tui/OutputArea.tsx`, inside the `renderBlock` function, modify the reason block rendering. The `renderBlock` function signature needs access to the previous block's kind. Add a `prevBlock` parameter.

Change `renderBlock` signature (approx line 69) from:
```tsx
function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, _i: number) {
```
to:
```tsx
function renderBlock(block: OutputBlock, isFocused: boolean, thinkingVisible: boolean, _i: number, prevBlock?: OutputBlock) {
```

Then modify the reason block case (lines 87-99):

Old:
```tsx
    case "reason":
      return (
        <Box key={block.id} flexDirection="column">
          <Text color={isFocused ? t.primary : t.dim}>
            {!thinkingVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
          </Text>
          {thinkingVisible && !block.folded && (
            <Box paddingLeft={2}>
              <Text color={t.muted}>{block.content}</Text>
            </Box>
          )}
        </Box>
      );
```

New:
```tsx
    case "reason": {
      const isConsecutive = prevBlock?.kind === "reason";
      return (
        <Box key={block.id} flexDirection="column">
          {!isConsecutive && (
            <Text color={isFocused ? t.primary : t.dim}>
              {!thinkingVisible || block.folded ? "▶ Thinking..." : "▼ Thinking"}
            </Text>
          )}
          {thinkingVisible && !block.folded && (
            <Box paddingLeft={2}>
              <Text color={t.muted}>{block.content}</Text>
            </Box>
          )}
          {isConsecutive && (block.folded || !thinkingVisible) && (
            <Text color={t.dim}>  ...</Text>
          )}
        </Box>
      );
    }
```

Changes:
- If previous block is also a reason block, skip the `▶ Thinking...` header
- For folded consecutive reasons, show a minimal `  ...` continuation indicator
- For unfolded consecutive reasons, just show the content with padding

Now update all `renderBlock` call sites to pass `prevBlock`. Find the call sites in the file (there are 2: one in the auto-scroll section and one in the manual-scroll section). Change each from `renderBlock(block, isFocused, thinkingVisible, i)` to `renderBlock(block, isFocused, thinkingVisible, i, blocks[i - 1])`.

- [ ] **Step 2: Distinct error styling for tool error summary**

In `src/app/tui/OutputArea.tsx`, modify the tool_card rendering (lines 117-122) to use different color/prefix for errors:

Old:
```tsx
          {block.status !== "running" && block.summary ? (
            <Box paddingLeft={3}>
              <Text color={t.dim}>⎿ {block.summary.slice(0, 200)}</Text>
            </Box>
          ) : null}
```

New:
```tsx
          {block.status !== "running" && block.summary ? (
            <Box paddingLeft={3}>
              <Text color={block.status === "error" ? t.error : t.dim}>
                {block.status === "error" ? "✕ " : "⎿ "}{block.summary.slice(0, 200)}
              </Text>
            </Box>
          ) : null}
```

- [ ] **Step 3: Add spacing between consecutive tool_card blocks**

In the same tool_card rendering (lines 101-123), wrap the entire return in a Box and add `marginBottom={1}` when followed by another tool_card. Change from returning the `<Box key={block.id} flexDirection="column">` directly to checking next block:

Actually, spacing should be applied between tool cards. The simplest approach: add `marginBottom={1}` to the outer `<Box>` of every tool_card block (it won't add visible extra space after the last one since it's just margin on the bottom):

Old:
```tsx
    case "tool_card":
      return (
        <Box key={block.id} flexDirection="column">
```

New:
```tsx
    case "tool_card":
      return (
        <Box key={block.id} flexDirection="column" marginBottom={1}>
```

- [ ] **Step 4: Regenerate fixtures**

```bash
$env:UPDATE_SNAPSHOTS="true"; bun run test:e2e
```

Expected: 40 tests PASS

- [ ] **Step 4: Verify fixtures stable**

```bash
bun run test:e2e
```

Expected: 40 tests PASS

- [ ] **Step 5: Verify existing TUI tests**

```bash
bun test ./tests/tui-layout.test.tsx
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/OutputArea.tsx tests/e2e/fixtures/
git commit -m "fix(tui): dedup reason headers + distinct tool error styling + inter-tool spacing"
```

---

### Task 4: Final full regression

- [ ] **Step 1: Run all TUI tests**

```bash
bun test ./tests/tui-layout.test.tsx ./tests/tui-interaction.test.tsx ./tests/tui-reducer.test.ts ./tests/tui-slash-command.test.ts ./tests/tui.test.ts ./tests/tui-helpers.test.ts ./tests/tui-mock-render.test.tsx; bun run test:e2e
```

Expected: ALL PASS (243 + 40 = 283 tests)

- [ ] **Step 2: Commit if clean**

```bash
git status
```
Expected: clean working tree (all changes committed in Tasks 1-3)

---

## Self-Review Checklist

1. **Spec coverage:**
   - Layer 1.1 Header alignment → Task 1 Step 1 ✓
   - Layer 1.2 Footer spacing → Task 1 Step 2 ✓
   - Layer 2.1 Separator before instruction → Task 2 Step 1 ✓
   - Layer 2.2 Unicode arrows → Task 2 Steps 1,2,3 ✓
   - Layer 2.3 Question text dedup → Task 2 Step 5 ✓
   - Layer 2.4 Free-text placeholder → Task 2 Step 2b ✓
   - Layer 2.5 Approval label format → Task 2 Step 4 ✓
   - Layer 3.1 Reason block dedup → Task 3 Step 1 ✓
   - Layer 3.2 Tool error distinct styling → Task 3 Step 2 ✓
   - Layer 3.3 Inter-tool spacing → Task 3 Step 3 ✓
   - Layer 3.4 Answered question marker → Task 2 Step 5 ✓
   - Layer 3.5 Denied symbol ASCII → Task 2 Step 4 ✓

2. **Placeholder scan:** No TBD/TODO. All steps have complete code. ✓

3. **Type consistency:** `renderBlock` signature change (adding `prevBlock?`) matches all call sites. `OutputBlock` discriminated union already defines the `kind` field used for comparison. ✓
