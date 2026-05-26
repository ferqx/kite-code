# TUI Claude Code Parity Implementation Plan

> Status: completed (2026-05-26)
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Bring OpenPX TUI to Claude Code parity across 5 dimensions — layout restructure (Header/Body/Footer/Overlay), shortcut simplification (3 keys), feature completion (markdown links, .gitignore-aware file search, /export), dynamic model list, and theme support.

**Architecture:** Restructure the TUI into a 4-layer vertical flow: Header (branding + hints), Body (message stream, flexGrow), Footer (3-row: top status + interaction row + bottom stats), Overlay (panels below Footer). Simplify global shortcuts from 10+leader-keys to just Ctrl+C/T/E. Replace hardcoded model list with config-driven loading; add light theme support.

**Tech Stack:** Bun, TypeScript ESM, Ink (React for terminal), existing test suites (ink-testing-library e2e + vitest unit)

**Additional fixes (not in original plan):** Removed startup auto-resume (always start fresh session). Fixed DeepSeek 400 error via sanitizeToolCallPairs + forceContextCompaction pair integrity + ensureNoLeadingOrphans.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/tui/Header.tsx` | MODIFY | Strip to cat ASCII + product name + usage hints |
| `src/app/tui/StatusBar.tsx` | REWRITE | Footer top row: spinner + phase + plan progress |
| `src/app/tui/StatsLine.tsx` | CREATE | Footer bottom row: model \| think \| cache \| tokens \| timer \| auth \| rw |
| `src/app/tui/Footer.tsx` | REWRITE | 3-row container: StatusBar + children(interaction) + StatsLine |
| `src/app/tui/ActivityBar.tsx` | DELETE | Spinner + timer merged into StatusBar/StatsLine |
| `src/app/tui/App.tsx` | MODIFY | New layout tree, new actions, remove deprecated components |
| `src/app/tui/OutputArea.tsx` | MODIFY | Remove approval block rendering; question → static `? text` |
| `src/app/tui/hooks/useGlobalKeys.ts` | MODIFY | Only Ctrl+C, Ctrl+T, Ctrl+E (→ EXPAND_INPUT) |
| `src/app/tui/hooks/useLeaderKeys.ts` | DELETE | Ctrl+X leader key system removed |
| `src/app/tui/components/CtrlSafeTextInput.tsx` | MODIFY | Whitelist-only block (C/T/E) instead of block-all Ctrl |
| `src/app/tui/components/MarkdownBlock.tsx` | MODIFY | Add `[text](url)` link rendering |
| `src/app/tui/hooks/useFileSearch.ts` | MODIFY | Parse .gitignore, merge with hardcoded skip list |
| `src/app/tui/hooks/useSlashCommand.ts` | MODIFY | Add `/export` case |
| `src/app/tui/theme.ts` | MODIFY | Add `lightTheme` export |
| `src/app/tui/types.ts` | MODIFY | Add `EXPAND_INPUT` action type to Action union |
| `src/app/tui/index.tsx` | MODIFY | Pass theme, pass model list from config |
| `src/app/tui/components/ModelSelector.tsx` | MODIFY | Accept model list via props instead of hardcoded |
| `src/core/config/index.ts` | MODIFY | Extend schema: `models[]`, `theme` fields |
| `tests/e2e/startup.test.tsx` | MODIFY | Update for new layout + shortcut changes |
| `tests/e2e/interaction.test.tsx` | MODIFY | Update approval/help/model shortcut tests |

---

### Task 1: Simplify Header

**Files:**
- Modify: `src/app/tui/Header.tsx`
- Modify: `src/app/tui/Footer.tsx` → delete old content (file will be rewritten in Task 3)

- [ ] **Step 1: Rewrite Header — strip to cat + product name + hints**

Edit `src/app/tui/Header.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "./theme";

type CatMood = "working" | "error" | "idle";

function catMood(running: boolean, error: boolean): CatMood {
  if (running) return "working";
  if (error) return "error";
  return "idle";
}

const CAT_LINES: Record<CatMood, [string, string, string]> = {
  working: ["  /\\_/\\  ", " ( ^ ^ ) ", "  > w <  "],
  error:   ["  /\\_/\\  ", " ( T T ) ", "  > . <  "],
  idle:    ["  /\\_/\\  ", " ( = = ) ", "  > ~ <  "],
};

interface HeaderProps {
  running: boolean;
  error?: boolean;
}

export default function Header({ running, error }: HeaderProps) {
  const mood = catMood(running, !!error);
  const [catTop, catMid, catBot] = CAT_LINES[mood];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>{catTop}  </Text>
        <Text bold color={t.primary}>OpenPX</Text>
      </Box>
      <Box>
        <Text color={t.primary}>{catMid}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={t.primary}>{catBot}</Text>
      </Box>
      <Box>
        <Text color={t.dim}>? shortcuts</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>Ctrl+C exit</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>/ commands</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>! shell</Text>
      </Box>
    </Box>
  );
}
```

Key changes:
- Remove `StatusState` import (no longer needed)
- Props change from `{ status, running, error }` to `{ running, error }`
- Remove modelName, auth, rw, think, cwd, plan progress from header
- Add line 4: usage hints (moved from old Footer)

- [ ] **Step 2: Update App.tsx Header usage**

In `src/app/tui/App.tsx`, find the `MemoHeader` usage and update props:

```typescript
// Before:
<MemoHeader status={state.status} running={state.running} error={state.sessionError} />

// After:
<MemoHeader running={state.running} error={state.sessionError} />
```

- [ ] **Step 3: Delete old Footer.tsx content**

Read `src/app/tui/Footer.tsx` — its hint content has moved to Header. The file will be fully replaced in Task 3. For now, replace with a no-op:

```typescript
// Placeholder — will be replaced in Task 3
import React from "react";
import { Box } from "ink";

export default function Footer({ children }: { children?: React.ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}
```

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS (Header no longer references StatusState, no downstream breakage from Footer stub)

- [ ] **Step 5: Run TUI layout test to verify no regression**

Run: `bun test tests/tui-layout.test.tsx`
Expected: May fail — Header props changed. Fix test expectations in next step.

- [ ] **Step 6: Update layout test for new Header props**

In `tests/tui-layout.test.tsx`, update any `Header` render tests to use `{ running, error }` props instead of `{ status, running, error }`.

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/Header.tsx src/app/tui/Footer.tsx src/app/tui/App.tsx tests/tui-layout.test.tsx
git commit -m "refactor: 精简 Header 为 cat + 产品名 + 使用提示，信息下移至 Footer"
```

---

### Task 2: Create StatsLine (Bottom Status Row)

**Files:**
- Create: `src/app/tui/StatsLine.tsx`

- [ ] **Step 1: Create StatsLine component**

Create `src/app/tui/StatsLine.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

interface StatsLineProps {
  status: StatusState;
  thinkingVisible: boolean;
  running: boolean;
  elapsed: number; // seconds, 0 when not running
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function StatsLine({ status, thinkingVisible, running, elapsed }: StatsLineProps) {
  const cacheColor = status.cacheHitRate > 50 ? t.success : status.cacheHitRate > 20 ? t.warning : t.muted;
  const authLabel = status.authorization === "full_access" ? "完全" : "安全";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;
  const thinkColor = thinkingVisible ? t.success : t.muted;

  return (
    <Box>
      <Text color={t.primary}>{status.modelName}</Text>
      <Text color={t.dim}> │ </Text>
      <Text color={thinkColor}>think: {status.thinkingMode}</Text>
      <Text color={t.dim}> │ </Text>
      <Text>
        <Text color={t.muted}>cache: </Text>
        <Text color={cacheColor}>{status.cacheHitRate.toFixed(0)}%</Text>
      </Text>
      <Text color={t.dim}> │ </Text>
      <Text>
        <Text color={t.muted}>tokens: </Text>
        <Text>{formatTokens(status.totalTokens)}</Text>
      </Text>
      {running && (
        <>
          <Text color={t.dim}> │ </Text>
          <Text color={t.primary}>{formatDuration(elapsed)}</Text>
        </>
      )}
      <Text color={t.dim}> │ </Text>
      <Text color={authColor}>[{authLabel}]</Text>
      <Text color={t.dim}> {status.workspaceAccess === "read-only" ? "ro" : "rw"}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet, just verifying no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/StatsLine.tsx
git commit -m "feat: 新增 StatsLine 组件 — Footer Bottom 状态行"
```

---

### Task 3: Rewrite StatusBar as Footer Top Row + Rewrite Footer

**Files:**
- Rewrite: `src/app/tui/StatusBar.tsx`
- Rewrite: `src/app/tui/Footer.tsx`

- [ ] **Step 1: Rewrite StatusBar — Footer Top status line**

Rewrite `src/app/tui/StatusBar.tsx`:

```typescript
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

interface StatusBarProps {
  status: StatusState;
  running: boolean;
  compacting: boolean;
  timerKey: number;
  onTick: (elapsed: number) => void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function StatusBar({ status, running, compacting, timerKey, onTick }: StatusBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  // Reset on new run
  useEffect(() => {
    setElapsed(0);
    setSpinnerIdx(0);
  }, [timerKey]);

  // Spinner rotation (80ms interval, only when running)
  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      return;
    }
    const timer = setInterval(() => setSpinnerIdx((prev) => (prev + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [running]);

  // Elapsed counter (1s interval, only when running)
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

  // Bubble elapsed up to parent for StatsLine
  useEffect(() => {
    onTick(elapsed);
  }, [elapsed, onTick]);

  const phaseIcon = status.phase === "planning" ? "○" : "●";
  const phaseColor = status.phase === "planning" ? t.warning : t.success;
  const phaseLabel = status.phase === "planning" ? "Planning" : "Building";

  function planLabel(): string {
    if (compacting) return "⟳ Compacting...";
    if (!status.plan) return status.currentNode ?? "";
    const done = status.plan.steps.filter((s) => s.status === "completed").length;
    const total = status.plan.steps.length;
    const active = status.plan.steps.find((s) => s.status === "in_progress");
    return `Step ${done}/${total}${active ? `: ${active.step}` : ""}`;
  }

  return (
    <Box>
      {running && (
        <Text color={t.primary}>{SPINNER[spinnerIdx]} </Text>
      )}
      <Text color={phaseColor}>{phaseIcon} </Text>
      <Text bold color={t.primary}>{phaseLabel}</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>{planLabel()}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Rewrite Footer — 3-row container**

Rewrite `src/app/tui/Footer.tsx`:

```typescript
import React, { type ReactNode } from "react";
import { Box } from "ink";
import StatusBar from "./StatusBar";
import StatsLine from "./StatsLine";
import type { StatusState } from "./types";

interface FooterProps {
  status: StatusState;
  running: boolean;
  compacting: boolean;
  thinkingVisible: boolean;
  timerKey: number;
  elapsedRef: React.MutableRefObject<number>;
  children?: ReactNode;
}

export default function Footer({
  status, running, compacting, thinkingVisible, timerKey, elapsedRef, children,
}: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar status={status} running={running} compacting={compacting} timerKey={timerKey} onTick={(e) => { elapsedRef.current = e; }} />
      {children}
      <StatsLine status={status} thinkingVisible={thinkingVisible} running={running} elapsed={elapsedRef.current} />
    </Box>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/StatusBar.tsx src/app/tui/Footer.tsx
git commit -m "feat: StatusBar 重写为 Top 状态行 + Footer 重构为 3 行布局容器"
```

---

### Task 4: Delete ActivityBar

**Files:**
- Delete: `src/app/tui/ActivityBar.tsx`
- Modify: `src/app/tui/App.tsx` (remove import + render)

- [ ] **Step 1: Remove ActivityBar import and render from App.tsx**

In `src/app/tui/App.tsx`:

Remove this line from imports:
```typescript
import ActivityBar from "./ActivityBar";
```

Remove this render line:
```typescript
<ActivityBar running={state.running} timerKey={state.runCount} />
```

- [ ] **Step 2: Remove ActivityBar file**

Delete `src/app/tui/ActivityBar.tsx`.

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Run TUI tests**

Run: `bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts`
Expected: May need updates if tests reference ActivityBar

- [ ] **Step 5: Commit**

```bash
git rm src/app/tui/ActivityBar.tsx
git add src/app/tui/App.tsx
git commit -m "refactor: 移除 ActivityBar，spinner+计时器已融入 Footer"
```

---

### Task 5: Restructure App Layout + OutputArea Changes

**Files:**
- Modify: `src/app/tui/App.tsx`
- Modify: `src/app/tui/OutputArea.tsx`

- [ ] **Step 1: Update App.tsx layout tree**

In `src/app/tui/App.tsx`, replace the render block with the new 4-layer structure:

```typescript
// Remove imports: ActivityBar, old StatusBar (will be imported through Footer)
import Footer from "./Footer";

// Inside App component, add a ref for elapsed time handoff:
import { useRef, useState } from "react";
// ... in component body:
const elapsedRef = useRef(0);
const [footerTick, setFooterTick] = useState(0);

// Replace the entire return block:
return (
  <Box flexDirection="column">
    {/* ── Header ── */}
    <MemoHeader running={state.running} error={state.sessionError} />

    {/* ── Body: OutputArea (flexGrow) ── */}
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea
        blocks={state.blocks}
        onToggleReason={onToggleReason}
        thinkingVisible={state.thinkingVisible}
      />
    </Box>

    {/* ── Footer: 3-row interaction zone ── */}
    <Footer
      status={state.status}
      running={state.running}
      compacting={state.compacting}
      thinkingVisible={state.thinkingVisible}
      timerKey={state.runCount}
      elapsedRef={elapsedRef}
    >
      {/* Interaction row: input line or approval/input UI, mutually exclusive */}
      {!state.interrupt && children}
      {state.interrupt && interruptBlock?.kind === "approval" && !interruptBlock.resolved && (
        <ApprovalBlock
          approval={interruptBlock.approval}
          provider={provider}
          onResolved={resolveApproval}
        />
      )}
      {state.interrupt && interruptBlock?.kind === "question" && !interruptBlock.resolved && (
        <InputBlock
          question={interruptBlock.question}
          provider={provider}
          onResolved={resolveInput}
        />
      )}
    </Footer>

    {/* ── Overlay: panels below Footer ── */}
    {state.showHelp && <HelpPanel onClose={hideHelp} />}
    {state.showSessions && (
      <SessionSelector onSelect={selectSession} onClose={hideSessions} />
    )}
    {state.showModelSelector && (
      <ModelSelector
        currentModel={state.status.modelName}
        onSelect={selectModel}
        onClose={hideModelSelector}
      />
    )}
    {state.showMcp && mcpManager && (
      <McpPanel manager={mcpManager} onClose={hideMcp} />
    )}
    {state.showRewind && (
      <CheckpointSelector
        checkpoints={state.checkpoints}
        onRevert={handleRevert}
        onFork={handleFork}
        onClose={hideRewind}
      />
    )}
  </Box>
);
```

Also remove `overlayActive` variable and the `Footer` import of old one. Remove `StatusBar` import.

- [ ] **Step 2: Remove approval block rendering from OutputArea**

In `src/app/tui/OutputArea.tsx`, remove the `case "approval"` block (lines 182-193) from `renderBlock`. Approval interaction is now 100% in Footer.

- [ ] **Step 3: Simplify question block rendering in OutputArea**

Replace the `case "question"` block (lines 194-211) with a static one-liner:

```typescript
case "question": {
  return (
    <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
      <Text color={t.muted}>? {block.question.question}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/tui/App.tsx src/app/tui/OutputArea.tsx
git commit -m "refactor: 重组布局为 Header/Body/Footer/Overlay 四层，Approval/Input 交互移至 Footer"
```

---

### Task 6: Simplify Global Shortcuts

**Files:**
- Modify: `src/app/tui/hooks/useGlobalKeys.ts`
- Delete: `src/app/tui/hooks/useLeaderKeys.ts`
- Modify: `src/app/tui/App.tsx` (remove leader hook usage + actions)

- [ ] **Step 1: Rewrite useGlobalKeys — only Ctrl+C, Ctrl+T, Ctrl+E**

Rewrite `src/app/tui/hooks/useGlobalKeys.ts`:

```typescript
import { useInput } from "ink";
import type { Dispatch } from "react";
import type { Action } from "../App";

export function useGlobalKeys(dispatch: Dispatch<Action>, running: boolean, overlayActive: boolean) {
  useInput((input: string, key: { ctrl?: boolean; escape?: boolean }) => {
    if (key.ctrl && input === "c") {
      dispatch({ type: "CTRL_C" });
      return;
    }
    if (key.ctrl && input === "t") {
      dispatch({ type: "TOGGLE_THINKING" });
      return;
    }
    if (key.ctrl && input === "e") {
      dispatch({ type: "EXPAND_INPUT" });
      return;
    }
    if (key.escape) {
      dispatch({ type: "ESCAPE" });
    }
  });
}
```

Remove the old complex logic (leader key, Ctrl+L/N/R/H/O detection). Also remove the `overlayActive` parameter usage since it only affected leader key behavior.

- [ ] **Step 2: Delete useLeaderKeys**

Delete `src/app/tui/hooks/useLeaderKeys.ts`.

- [ ] **Step 3: Remove leader key + dead actions from App.tsx**

In `src/app/tui/App.tsx`:

Remove import:
```typescript
import { useGlobalKeys, useLeaderKeys } from "./hooks/useGlobalKeys";
// becomes:
import { useGlobalKeys } from "./hooks/useGlobalKeys";
```

Remove the `useLeaderKeys` call:
```typescript
useLeaderKeys(dispatch, state.leaderPending, onCompactRequest);
```

Remove dead actions from `Action` union: `OPEN_EDITOR`, `EDITOR_DONE`, `LEADER_PENDING`, `LEADER_CANCEL`, `COMPACT_CONTEXT`.

Remove dead reducer cases: `OPEN_EDITOR`, `EDITOR_DONE`, `LEADER_PENDING`, `LEADER_CANCEL`, `COMPACT_CONTEXT`.

Remove `leaderPending` from `TuiState` type in `types.ts`.

Remove `leaderPending` from initial state object.

Add `EXPAND_INPUT` action to `Action` union:
```typescript
| { type: "EXPAND_INPUT" }
```

Add `EXPAND_INPUT` reducer case (delegates to TuiBootstrap middleware — see Task 7):
```typescript
case "EXPAND_INPUT":
  return { ...state, editorRequested: true }; // reuse editorRequested flag, or add expandRequested
```

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git rm src/app/tui/hooks/useLeaderKeys.ts
git add src/app/tui/hooks/useGlobalKeys.ts src/app/tui/App.tsx src/app/tui/types.ts
git commit -m "refactor: 快捷键精简为 Ctrl+C/T/E，移除 Leader 键体系，移除 Ctrl+L/N/R/H/O"
```

---

### Task 7: CtrlSafeTextInput Whitelist + EXPAND_INPUT Handling

**Files:**
- Modify: `src/app/tui/components/CtrlSafeTextInput.tsx`
- Modify: `src/app/tui/index.tsx` (handle EXPAND_INPUT)

- [ ] **Step 1: Change Ctrl block to whitelist**

In `src/app/tui/components/CtrlSafeTextInput.tsx`, find lines 138-143 and replace:

```typescript
// Before:
if (
  (key.ctrl && /^[a-zA-Z]$/.test(input)) ||
  key.tab ||
  (key.shift && key.tab)
) {
  return;
}

// After:
// Only block the 3 global Ctrl shortcuts; let all other Ctrl+key no-op
if (key.ctrl && /^[cCtTeE]$/.test(input)) {
  return;
}
```

Also remove the `// Enter / Shift+Enter handling is in InputLine...` early return for `key.return` if present — or keep it, it's fine.

- [ ] **Step 2: Handle EXPAND_INPUT in index.tsx**

In `src/app/tui/index.tsx`, add a `useEffect` or extend the existing action dispatch handling to watch for `EXPAND_INPUT`:

When `EXPAND_INPUT` is dispatched, the InputLine should expand its paste placeholder. This is done via a ref-based callback pattern. Add to the middleware:

```typescript
// In TuiBootstrap, pass expandRef to InputLine:
const expandInputRef = useRef<() => void>(() => {});

// Watch for EXPAND_INPUT and call it:
// Add to the reducer middleware: when action.type === "EXPAND_INPUT", call expandInputRef.current()
```

In InputLine, expose the expand function via `useImperativeHandle` or a ref callback passed from parent. When called, replace the paste placeholder text with the original full content:

```typescript
// Inside InputLine component, accept expandRef:
const handleExpand = useCallback(() => {
  if (pasteContentRef.current) {
    setValue(pasteContentRef.current);
    pasteContentRef.current = null;
  }
}, []);
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/components/CtrlSafeTextInput.tsx src/app/tui/index.tsx
git commit -m "fix: CtrlSafeTextInput 改为白名单拦截(C/T/E)，新增 EXPAND_INPUT 展开折叠内容"
```

---

### Task 8: Markdown Link Rendering

**Files:**
- Modify: `src/app/tui/components/MarkdownBlock.tsx`

- [ ] **Step 1: Add link pattern to parseInline**

In `src/app/tui/components/MarkdownBlock.tsx`, update the `parseInline` function. Find line 22 (`const allPatterns = ...`) and add link matching:

```typescript
// Before:
const allPatterns = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;

// After:
const allPatterns = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
```

Update the match logic to handle the new capture groups:

```typescript
while ((match = allPatterns.exec(text)) !== null) {
  if (match.index > lastIndex) {
    segments.push({ text: text.slice(lastIndex, match.index) });
  }
  if (match[1].startsWith("**") && match[2] !== undefined) {
    segments.push({ text: match[2], bold: true });
  } else if (match[1].startsWith("*") && !match[1].startsWith("**") && match[3] !== undefined) {
    segments.push({ text: match[3], italic: true });
  } else if (match[4] !== undefined) {
    segments.push({ text: match[4], code: true });
  } else if (match[5] !== undefined) {
    // Link: [text](url) → "text (url)"
    segments.push({ text: match[5], bold: true });
    segments.push({ text: ` (${match[6]})` });
  }
  lastIndex = match.index + match[1].length;
}
```

Add `(url)` as a dimmed suffix: update the `InlineSegment` type to include an optional `dim` field, or simply add the url as a separate segment with muted style.

Actually simpler — add a `link` field to `InlineSegment`:

```typescript
export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string; // URL if this is a link
}
```

Then in `MarkdownLine`, when rendering segments with `link`:

```typescript
{segments.map((seg, j) => {
  if (seg.link) {
    return (
      <React.Fragment key={j}>
        <Text bold color={t.primary}>{seg.text}</Text>
        <Text color={t.dim}> ({seg.link})</Text>
      </React.Fragment>
    );
  }
  return (
    <Text key={j} bold={seg.bold} italic={seg.italic} color={seg.code ? t.warning : (color ?? undefined)}>
      {seg.text}
    </Text>
  );
})}
```

- [ ] **Step 2: Verify with existing markdown tests**

Run: `bun test tests/tui-layout.test.tsx`
Expected: PASS (existing tests should still pass)

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/components/MarkdownBlock.tsx
git commit -m "feat: Markdown 渲染新增链接 [text](url) 支持"
```

---

### Task 9: .gitignore-Aware File Search

**Files:**
- Modify: `src/app/tui/hooks/useFileSearch.ts`

- [ ] **Step 1: Add .gitignore parsing utility**

In `src/app/tui/hooks/useFileSearch.ts`, add functions to read and parse `.gitignore`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative as pathRelative } from "node:path";

function parseGitignore(dir: string): string[] {
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) return [];
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function matchesGitignore(filePath: string, patterns: string[], base: string): boolean {
  const rel = pathRelative(base, filePath).replace(/\\/g, "/");
  for (const pattern of patterns) {
    // Simple glob: * matches anything, ** matches across dirs
    const regex = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "___DOUBLESTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*");
    if (new RegExp(`^${regex}$`).test(rel)) return true;
  }
  return false;
}
```

- [ ] **Step 2: Integrate .gitignore rules into file walk**

Replace the `listFiles` function in `src/app/tui/hooks/useFileSearch.ts` with the version below that accumulates and respects `.gitignore` patterns:

```typescript
function listFiles(dir: string, base: string, maxFiles: number = 500): string[] {
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", ".openpx", "dist", "build", "__pycache__", ".DS_Store", "coverage"]);
  const accumulatedGitignore: string[] = [];

  function gitignorePatternToRegex(pattern: string): RegExp {
    let p = pattern.replace(/\./g, "\\.");
    p = p.replace(/\*\*/g, "__DOUBLESTAR__");
    p = p.replace(/\*/g, "[^/]*");
    p = p.replace(/__DOUBLESTAR__/g, ".*");
    // trailing /** → match directory contents
    if (p.endsWith("/.*")) p = p.slice(0, -3) + "(/.*)?";
    return new RegExp(`^${p}$`);
  }

  function isIgnored(relPath: string): boolean {
    for (const pattern of accumulatedGitignore) {
      if (gitignorePatternToRegex(pattern).test(relPath)) return true;
    }
    return false;
  }

  function walk(current: string) {
    if (files.length >= maxFiles) return;
    try {
      // Accumulate .gitignore from this directory
      accumulatedGitignore.push(...parseGitignore(current));

      const entries = readdirSync(current);
      for (const entry of entries) {
        if (skip.has(entry)) continue;
        if (entry.startsWith(".") && entry !== ".gitignore") continue;
        const full = join(current, entry);
        const rel = relative(base, full).replace(/\\/g, "/");

        try {
          const s = statSync(full);
          if (s.isDirectory()) {
            if (!isIgnored(rel + "/")) walk(full);
          } else if (s.isFile()) {
            if (!isIgnored(rel)) files.push(relative(base, full));
          }
        } catch {
          // permission errors
        }
      }
    } catch {
      // directory not readable
    }
  }

  walk(dir);
  return files.slice(0, maxFiles);
}
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/hooks/useFileSearch.ts
git commit -m "feat: @file 搜索遵循 .gitignore 规则"
```

---

### Task 10: Wire /export Slash Command

**Files:**
- Modify: `src/app/tui/hooks/useSlashCommand.ts`

- [ ] **Step 1: Add "export" case to slash command parser**

In `src/app/tui/hooks/useSlashCommand.ts`, add to the case switch array (around line 43):

```typescript
case "export": return { type: "export" };
```

Then in the `/export` execution handler (in the same file's `handleSlashResult` or in `index.tsx`'s `handleInput` where slash commands are dispatched), add:

```typescript
case "export":
  dispatch({ type: "EXPORT_SESSION" });
  break;
```

The `EXPORT_SESSION` reducer case already exists in App.tsx (line 462). Only the dispatch wiring is missing.

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/hooks/useSlashCommand.ts src/app/tui/index.tsx
git commit -m "feat: /export 命令注册，dispatch EXPORT_SESSION"
```

---

### Task 11: Dynamic Model List from Config

**Files:**
- Modify: `src/core/config/index.ts`
- Modify: `src/app/tui/App.tsx`
- Modify: `src/app/tui/components/ModelSelector.tsx`
- Modify: `src/app/tui/index.tsx`

- [ ] **Step 1: Extend config schema with models**

In `src/core/config/index.ts`, add to the config schema:

```typescript
const modelEntrySchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  default: z.boolean().optional(),
});

const configSchema = z.object({
  provider: z.record(z.string(), providerSchema),
  model: z.object({
    default: z.object({
      provider: z.string().min(1),
      name: z.string().min(1),
    }),
  }),
  models: z.array(modelEntrySchema).optional(),
  theme: z.enum(["dark", "light"]).optional(),
});
```

Add a `listAvailableModels` function:

```typescript
export interface AvailableModel {
  provider: string;
  name: string;
  label: string;
  isDefault: boolean;
}

export function listAvailableModels(configPath?: string): AvailableModel[] {
  const path = configPath ?? defaultConfigPath();
  if (!existsSync(path)) return fallbackModels();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    const models = parsed.models as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(models) || models.length === 0) return fallbackModels();
    return models.map((m) => ({
      provider: String(m.provider ?? ""),
      name: String(m.name ?? ""),
      label: String(m.label ?? m.name ?? ""),
      isDefault: Boolean(m.default),
    }));
  } catch {
    return fallbackModels();
  }
}

function fallbackModels(): AvailableModel[] {
  return [
    { provider: "deepseek", name: "deepseek-chat", label: "DeepSeek V4", isDefault: true },
    { provider: "deepseek", name: "deepseek-reasoner", label: "DeepSeek R1", isDefault: false },
    { provider: "openai", name: "gpt-4o", label: "GPT-4o", isDefault: false },
    { provider: "anthropic", name: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", isDefault: false },
  ];
}
```

- [ ] **Step 2: Pass model list from TuiBootstrap to App**

In `src/app/tui/index.tsx`, load models on startup:

```typescript
import { listAvailableModels, type AvailableModel } from "@/core/config";

// In TuiBootstrap:
const [availableModels] = useState<AvailableModel[]>(() => listAvailableModels());
```

Pass `availableModels` to App as a prop. App passes it to ModelSelector and uses it in `/model list`.

- [ ] **Step 3: Update ModelSelector to accept model list prop**

In `src/app/tui/components/ModelSelector.tsx`, add `models` prop:

```typescript
import type { AvailableModel } from "@/core/config";

interface ModelSelectorProps {
  currentModel: string;
  models: AvailableModel[];
  onSelect: (modelId: string) => void;
  onClose: () => void;
}
```

Render from `models` array instead of hardcoded list.

- [ ] **Step 4: Replace modelListText in App.tsx**

Remove the hardcoded `modelListText()` function. The `LIST_MODELS` reducer case should use the models passed as prop or push a text block built from the model list.

- [ ] **Step 5: Verify typecheck + model switch test**

Run: `bun run typecheck`
Run: `bun test tests/e2e/interaction.test.tsx` (ModelSelector tests)
Expected: PASS or fix test expectations for dynamic model list

- [ ] **Step 6: Commit**

```bash
git add src/core/config/index.ts src/app/tui/App.tsx src/app/tui/components/ModelSelector.tsx src/app/tui/index.tsx
git commit -m "feat: 模型列表从 openpx.jsonc 动态加载，替换硬编码"
```

---

### Task 12: Theme Support (Dark/Light)

**Files:**
- Modify: `src/app/tui/theme.ts`
- Modify: `src/core/config/index.ts` (theme field already added in Task 11)
- Modify: `src/app/tui/index.tsx` (pass theme context)

- [ ] **Step 1: Add lightTheme to theme.ts**

In `src/app/tui/theme.ts`, add `lightTheme`:

```typescript
export const lightTheme: Theme = {
  primary: "#3B5CCC",
  success: "#16A34A",
  error: "#DC2626",
  warning: "#CA8A04",
  muted: "#6B7280",
  dim: "#9CA3AF",
  bg: "#FFFFFF",
  risk: {
    read: "#3B82F6",
    plan: "#6366F1",
    write_file: "#CA8A04",
    execute_code: "#D97706",
    destructive: "#DC2626",
    network: "#EA580C",
    vcs_mutation: "#DB2777",
    unknown: "#9CA3AF",
  },
};
```

- [ ] **Step 2: Load theme from config in index.tsx**

In `src/app/tui/index.tsx`, read the `theme` field from config:

```typescript
import { loadConfigForTheme } from "@/core/config"; // or reuse parse approach

function readTheme(): "dark" | "light" {
  const configPath = defaultConfigPath();
  if (!existsSync(configPath)) return "dark";
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    const theme = parsed.theme;
    if (theme === "light") return "light";
    return "dark";
  } catch {
    return "dark";
  }
}
```

Pass the theme value to App and from App down to all components that consume theme. Use React context or simply pass as a prop through the tree.

Simplest approach: since all components import `{ darkTheme as t }` directly, create a `themeContext` or a theme provider. But to keep changes minimal, we can just pass `theme` as a prop and let components import the right theme object.

Actually, even simpler: change the theme module to export a function that returns the current theme. But Ink doesn't support module-level reactivity well.

The pragmatic approach: create a simple React context in `theme.ts`:

```typescript
import { createContext, useContext } from "react";

export const ThemeContext = createContext<Theme>(darkTheme);
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
```

In index.tsx, wrap App with `ThemeContext.Provider value={readTheme() === "light" ? lightTheme : darkTheme}`.

Then all components replace `import { darkTheme as t }` with `import { useTheme }` and `const t = useTheme()`.

This is a large change across ~15 files. To minimize risk, do it incrementally: add the context, wrap the provider, and change one component at a time.

- [ ] **Step 3: Wrap App with ThemeContext.Provider**

In `src/app/tui/index.tsx`:

```typescript
import { ThemeContext } from "./theme";
import { lightTheme, darkTheme } from "./theme";

// Inside TuiBootstrap:
const theme = readTheme();
// ...
<ThemeContext.Provider value={theme === "light" ? lightTheme : darkTheme}>
  <App ... />
</ThemeContext.Provider>
```

- [ ] **Step 4: Migrate components from direct import to useTheme**

In each component file that imports `{ darkTheme as t }`, change to:

```typescript
// Before:
import { darkTheme as t } from "./theme";

// After:
import { useTheme } from "./theme";
// Inside component:
const t = useTheme();
```

Files to migrate: `Header.tsx`, `StatusBar.tsx`, `StatsLine.tsx`, `Footer.tsx`, `OutputArea.tsx`, `MarkdownBlock.tsx`, `ApprovalBlock.tsx`, `InputBlock.tsx`, `HelpPanel.tsx`, `ModelSelector.tsx`, `SessionSelector.tsx`, `McpPanel.tsx`, `CheckpointSelector.tsx`, `ActivityBar.tsx` (already deleted), `InputLine.tsx`.

- [ ] **Step 5: Verify typecheck + existing tests**

Run: `bun run typecheck`
Run: `bun test tests/tui-layout.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/theme.ts src/app/tui/index.tsx src/app/tui/Header.tsx src/app/tui/StatusBar.tsx src/app/tui/StatsLine.tsx src/app/tui/Footer.tsx src/app/tui/OutputArea.tsx src/app/tui/components/MarkdownBlock.tsx src/app/tui/components/ApprovalBlock.tsx src/app/tui/components/InputBlock.tsx src/app/tui/components/HelpPanel.tsx src/app/tui/components/ModelSelector.tsx src/app/tui/components/SessionSelector.tsx src/app/tui/components/McpPanel.tsx src/app/tui/components/CheckpointSelector.tsx src/app/tui/components/InputLine.tsx
git commit -m "feat: 新增 light 主题支持，通过 openpx.jsonc theme 字段配置，默认 dark"
```

---

### Task 13: Update E2E Tests

**Files:**
- Modify: `tests/e2e/startup.test.tsx`
- Modify: `tests/e2e/interaction.test.tsx`
- Modify: `tests/e2e/advanced.test.tsx`

- [ ] **Step 1: Update shortcut-related tests**

Removed shortcuts that need test updates:
- `Ctrl+L` → `/clear`
- `Ctrl+N` → `/new`
- `Ctrl+R` → `/auth`
- `Ctrl+H`/`F1` → `/help`
- `Ctrl+X M/L` → `/model`/`/sessions`
- `Ctrl+E` no longer opens editor

Search for tests that use these key combinations and update them to use the slash command equivalents. Or remove the shortcut-specific tests if slash command equivalents already exist.

- [ ] **Step 2: Update layout assertion tests**

Search tests for assertions about old Header content (modelName, auth, workspace path displayed). Update assertions to match new simplified Header (only cat + "OpenPX" + hints).

Search for references to `ActivityBar` spinner text — remove or update.

- [ ] **Step 3: Run full e2e suite**

Run: `bun test tests/e2e/`
Expected: All tests pass after updates

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/
git commit -m "test: 更新 e2e 测试适配新 TUI 布局和快捷键体系"
```

---

### Task 14: Final Integration Test

**Files:**
- Modify: None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run e2e suite**

Run: `bun test tests/e2e/`
Expected: All tests PASS

---

## Self-Review Checklist

1. **Spec coverage**: [x] Layout restructure (Tasks 1-5), [x] Shortcut simplification (Tasks 6-7), [x] Markdown links (Task 8), [x] .gitignore search (Task 9), [x] /export (Task 10), [x] Dynamic models (Task 11), [x] Theme support (Task 12), [x] Test updates (Task 13), [x] Integration verification (Task 14)

2. **Placeholder scan**: No TBD/TODO. All code steps contain actual code. All command steps contain exact commands.

3. **Type consistency**: `EXPAND_INPUT` action defined in both types.ts and App.tsx. `AvailableModel` type defined in config/index.ts and consumed by ModelSelector. `useTheme()` hook exports from theme.ts and consumed by all components. `StatsLineProps` uses `StatusState` from types.ts — consistent.
