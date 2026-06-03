# TUI 消息列表 Turn 模型重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 `Turn` 类型替代 flat `OutputBlock[]`，将 Static/Dynamic 分割退化为简单的 `slice(0, -1)` 切片。

**Architecture:** 在 `TuiState` 中从 `blocks: OutputBlock[]` 切换为 `turns: Turn[]`，每个 Turn 对应一次「用户提问 → Agent 回复」的往返。`USER_MESSAGE` action 创建新 turn，其余所有 agent 事件往最后一个 turn 追加。新增 `helpers.ts` 统一 7 个 block 操作函数，消除 `replaceBlock` 在 `handleEvent.ts` 和 `agentReducer.ts` 中的重复。

**Tech Stack:** Bun, TypeScript, React/Ink, LangGraph

**Design doc:** `docs/space/understanding/2026-06-03-tui-block-turn-model-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/tui/types.ts` | Modify | 新增 `Turn` 接口；`TuiState.blocks` → `turns`; `SessionSnapshot.blocks` → `turns` |
| `src/app/tui/reducers/helpers.ts` | **Create** | `appendBlock`, `findBlockById`, `updateLastBlock`, `replaceBlockById`, `finalizeLastTurnStreaming`, `reconstructTurns`, `lastTurn` |
| `src/app/tui/reducers/handleEvent.ts` | Modify | 所有 EVENT handler 适配 turn；移除 `replaceBlock` |
| `src/app/tui/reducers/agentReducer.ts` | Modify | 所有生命周期 action 适配 turn；移除 `replaceBlock` |
| `src/app/tui/reducers/sessionReducer.ts` | Modify | `USER_MESSAGE` 创建 turn；`LOAD_SESSION` 调用 `reconstructTurns` |
| `src/app/tui/reducers/uiReducer.ts` | Modify | Toggle 类操作改用 `findBlockById` + `replaceBlockById` |
| `src/app/tui/OutputArea.tsx` | Modify | Props 换成 `turns: Turn[]`；简化 split 逻辑 |
| `src/app/tui/App.tsx` | Modify | 传 `state.turns`；更新 `interruptBlock` 查找逻辑 |
| `src/app/tui/session-manager.ts` | Modify | `getSnapshot` 中 `blocks: []` → `turns: []` |
| `tests/tui-reducer.test.ts` | Modify | 适配 `blocks` → `turns`；新增 `reconstructTurns` 测试 |
| `tests/tui-layout.test.tsx` | Modify | Props 适配 |

---

### Task 1: 新增 `Turn` 类型和更新 `TuiState` / `SessionSnapshot`

**Files:**
- Modify: `src/app/tui/types.ts`
- Modify: `src/app/tui/reducers/actions.ts`

- [ ] **Step 1: 在 types.ts 顶部新增 `Turn` 接口**

在 `OutputBlock` 联合类型定义之后（文件末尾 `SessionSnapshot` 之前）添加：

```typescript
/** 一次完整的「用户提问 → Agent 回复」往返 */
export interface Turn {
  blocks: OutputBlock[];
}
```

- [ ] **Step 2: 将 `TuiState.blocks` 改为 `turns`**

```typescript
// 之前
blocks: OutputBlock[];

// 之后
turns: Turn[];
```

同时更新 `createInitialState` 中的 `initialState` 将 `blocks: []` 改为 `turns: []`（在 `App.tsx` 第 31 行）。

- [ ] **Step 3: 将 `SessionSnapshot.blocks` 改为 `turns`**

```typescript
// 之前 (types.ts:90)
blocks: OutputBlock[];

// 之后
turns: Turn[];
```

- [ ] **Step 4: 在 actions.ts 更新 `SWITCH_SESSION` 类型引用（无需改 action shape）**

`SESSION_INTERRUPT_PENDING` 和 `SET_SESSIONS` 不需要改。`LOAD_SESSION` 仍接收 `blocks: OutputBlock[]`（从 DB 加载的扁平数组），在 reducer 中转换。

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

此时预期大量错误（所有引用 `state.blocks` 的地方），正常——后续 tasks 逐一修复。

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/types.ts
git commit -m "refactor: 新增 Turn 接口，TuiState.blocks → turns"
```

---

### Task 2: 创建 `helpers.ts`

**Files:**
- Create: `src/app/tui/reducers/helpers.ts`

- [ ] **Step 1: 创建 helpers.ts**

```typescript
import type { TuiState, OutputBlock, Turn } from "../types";

/** 追加 block 到最后 turn，自增 nextBlockId。
 *  前置条件：state.turns.length > 0（USER_MESSAGE 已创建首个 turn）。 */
export function appendBlock(state: TuiState, block: OutputBlock): TuiState {
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  turns[turns.length - 1] = { blocks: [...last.blocks, block] };
  return { ...state, turns, nextBlockId: state.nextBlockId + 1 };
}

/** 按 id 查找 block（跨所有 turns） */
export function findBlockById(
  state: TuiState,
  blockId: number,
): OutputBlock | undefined {
  for (const turn of state.turns) {
    const found = turn.blocks.find((b) => b.id === blockId);
    if (found) return found;
  }
  return undefined;
}

/** 替换最后 turn 的最后 block（流式更新 text content）。
 *  前置条件：最后 turn 至少有一个 block。 */
export function updateLastBlock(
  state: TuiState,
  block: OutputBlock,
): TuiState {
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  const blocks = last.blocks.slice();
  blocks[blocks.length - 1] = block;
  turns[turns.length - 1] = { blocks };
  return { ...state, turns };
}

/** 全局按 id 替换 block（toggle 展开/折叠、resolve interrupt 用） */
export function replaceBlockById(
  state: TuiState,
  blockId: number,
  next: OutputBlock,
): TuiState {
  const turns = state.turns.map((turn) => {
    const idx = turn.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return turn;
    const blocks = turn.blocks.slice();
    blocks[idx] = next;
    return { blocks };
  });
  return { ...state, turns };
}

/** Finalize 最后 turn 中所有 streaming 的 text block（设为 false）。
 *  need_approval、need_input、SET_IDLE、CTRL_C 时调用。 */
export function finalizeLastTurnStreaming(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;
  let changed = false;
  const blocks = last.blocks.map((b) => {
    if (b.kind === "text" && b.streaming) {
      changed = true;
      const { streaming: _, ...rest } = b;
      return { ...rest, streaming: false } as OutputBlock;
    }
    return b;
  });
  if (!changed) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks };
  return { ...state, turns };
}

/** 从扁平的 OutputBlock[] 按 kind === "user" 切分 turns */
export function reconstructTurns(blocks: OutputBlock[]): Turn[] {
  const turns: Turn[] = [];
  let current: OutputBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "user" && current.length > 0) {
      turns.push({ blocks: current });
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) turns.push({ blocks: current });
  return turns;
}

/** 获取最后 turn */
export function lastTurn(state: TuiState): Turn | undefined {
  return state.turns.at(-1);
}
```

- [ ] **Step 2: Typecheck（确认 helpers 自身无类型错误）**

```bash
bun run typecheck
```

预期：helpers.ts 无新增错误（其他文件仍大量报错）。

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/reducers/helpers.ts
git commit -m "feat: 新增 TUI block 操作 helpers（Turn 模型辅助函数）"
```

---

### Task 3: 适配 `handleEvent.ts`

**Files:**
- Modify: `src/app/tui/reducers/handleEvent.ts`

- [ ] **Step 1: 替换 imports**

```typescript
// 新增 import
import { appendBlock, findBlockById, updateLastBlock, finalizeLastTurnStreaming } from "./helpers";

// 删除本地的 replaceBlock 函数定义（第 7-17 行）
```

- [ ] **Step 2: 删除 `replaceBlock` 函数定义**

删除 handleEvent.ts 第 7-17 行的 `replaceBlock` 函数。

- [ ] **Step 3: 所有 `state.blocks` → 操作最后一个 turn**

逐一替换每个 event handler：

**text**（第 79-101 行）:

```typescript
case "text": {
  const last = lastTurn(state);
  const lastBlock = last?.blocks.at(-1);
  // 流式追加
  if (state.running && lastBlock?.kind === "text") {
    return updateLastBlock(state, { ...lastBlock, content: event.data.text });
  }
  // Dedup（不变逻辑，但查找范围限定）
  if (lastBlock?.kind === "text" && lastBlock.content === event.data.text) return state;
  const id = state.nextBlockId;
  const block: OutputBlock = { id, kind: "text", content: event.data.text, streaming: state.running };
  return appendBlock(state, block);
}
```

**reason**（第 103-116 行）:

```typescript
case "reason": {
  if (state.currentRunReasonId != null) {
    const last = lastTurn(state);
    const lastBlock = last?.blocks.at(-1);
    if (lastBlock?.kind === "reason" && lastBlock.id === state.currentRunReasonId) {
      const next = { ...lastBlock, content: lastBlock.content + "\n\n" + event.data.text };
      return { ...state, turns: state.turns.slice(0, -1).concat([{ blocks: [...last.blocks.slice(0, -1), next] }]) };
    }
  }
  const id = state.nextBlockId;
  const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
  return { ...state, turns: [...state.turns.slice(0, -1), { blocks: [...lastTurn(state)!.blocks, block] }], currentRunReasonId: id, nextBlockId: id + 1 };
}
```

**tool_call**（第 118-146 行）: 改用 `appendBlock` → 最后 turn 追加。

**tool_done**（第 148-176 行）: 先从最后 turn 反向查找，未找到则跨 turn 用 `findBlockById` + `replaceBlockById`。

**need_approval**（第 243-256 行）: 用 `finalizeLastTurnStreaming` 替代当前 `finalizeStreaming` 循环；`appendBlock` 追加 approval block。

**need_input**（第 258-271 行）: 同 need_approval。

**file_change**（第 280-296 行）: 检查最后 turn 的最后 block：

```typescript
case "file_change": {
  const change: FileChangeRecord = { ... };
  const last = lastTurn(state);
  const lastBlock = last?.blocks.at(-1);
  if (lastBlock?.kind === "file_change") {
    // 聚合到现有 file_change block（更新最后 block）
    return updateLastBlock(state, { ...lastBlock, changes: [...lastBlock.changes, change] });
  }
  const id = state.nextBlockId;
  const block: OutputBlock = { id, kind: "file_change", changes: [change] };
  return appendBlock(state, block);
}
```

**compact_begin / compact_end / model_retry / error / final**: 所有只需追加的，统一改为 `appendBlock(state, block)`。

**subagent_start**（第 308-326 行）: 去重逻辑改为 `findBlockById`；创建用 `appendBlock`。

**subagent_step / subagent_tool_result / subagent_done / subagent_error**: 先从最后 turn 反向查找，未找到则跨 turn 用 `findBlockById` + 手动替换（这些需要构造新 block 再调 `replaceBlockById`）。

**state_change**: 跨 turn 查找 plan_card 的逻辑改为用 `findBlockById` + `replaceBlockById`。

- [ ] **Step 4: 类型检查**

```bash
bun run typecheck
```

预期：handleEvent.ts 零错误。

- [ ] **Step 5: Commit**

```bash
git add src/app/tui/reducers/handleEvent.ts
git commit -m "refactor: handleEvent 适配 Turn 模型"
```

---

### Task 4: 适配 `agentReducer.ts`

**Files:**
- Modify: `src/app/tui/reducers/agentReducer.ts`

- [ ] **Step 1: 替换 imports，删除重复的 replaceBlock**

```typescript
import { appendBlock, replaceBlockById, finalizeLastTurnStreaming } from "./helpers";
// 删除本地 replaceBlock 函数定义（第 7-17 行）
// 删除 finalizeStreaming 函数定义（第 20-30 行）
```

- [ ] **Step 2: 更新各 action handler**

**SET_RUNNING**: 不变。

**SET_IDLE**:

```typescript
case "SET_IDLE": {
  const finalized = finalizeLastTurnStreaming(state);
  return { ...finalized, running: false, exited: false, interrupt: null, currentRunReasonId: undefined };
}
```

**SET_EXITED**: `blocks: [...state.blocks, block]` → `appendBlock(state, block)`。

**RESOLVE_INTERRUPT**:

```typescript
case "RESOLVE_INTERRUPT": {
  const block = findBlockById(state, action.blockId);
  if (!block || (block.kind !== "approval" && block.kind !== "question")) {
    return { ...state, interrupt: null };
  }
  let resolved: OutputBlock;
  if (block.kind === "approval") {
    const r = typeof action.resolution === "string" ? { action: action.resolution } : action.resolution;
    resolved = { ...block, resolved: r };
  } else {
    resolved = { ...block, resolved: typeof action.resolution === "string" ? action.resolution : String(action.resolution) };
  }
  return { ...state, turns: replaceBlockById(state, action.blockId, resolved).turns, interrupt: null };
}
```

> 注：此处需要 import `findBlockById`。

**COMPACT_CONTEXT / EXPORT_SESSION_DONE / LIST_MODELS / SHOW_SETTING / INJECT_MCP_PROMPT**: 全改用 `appendBlock(state, block)`。

**CTRL_C / ESCAPE**:

```typescript
case "CTRL_C": {
  if (state.running) {
    let next = finalizeLastTurnStreaming(state);
    if (state.interrupt) {
      const block = findBlockById(next, state.interrupt.blockId);
      if (block && block.kind === "approval") {
        next = { ...next, turns: replaceBlockById(next, state.interrupt.blockId, { ...block, resolved: { action: "cancelled" } }).turns };
      } else if (block && block.kind === "question") {
        next = { ...next, turns: replaceBlockById(next, state.interrupt.blockId, { ...block, resolved: "cancelled" }).turns };
      }
    }
    return { ...next, running: false, ctrlCPressed: true, interrupt: null };
  }
  if (state.ctrlCPressed) return { ...state, exitRequested: true };
  return { ...state, ctrlCPressed: true };
}
```

**SET_PHASE**: 不变。

**其余无 changes 的 action**: 不变。

- [ ] **Step 3: 类型检查**

```bash
bun run typecheck
```

确认 agentReducer.ts 无误。

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/reducers/agentReducer.ts
git commit -m "refactor: agentReducer 适配 Turn 模型"
```

---

### Task 5: 适配 `sessionReducer.ts`

**Files:**
- Modify: `src/app/tui/reducers/sessionReducer.ts`

- [ ] **Step 1: 新增 import**

```typescript
import { reconstructTurns } from "./helpers";
```

- [ ] **Step 2: USER_MESSAGE — 创建新 turn**

```typescript
case "USER_MESSAGE": {
  const id = state.nextBlockId;
  const userBlock: OutputBlock = { id, kind: "user", content: action.text };
  const newTurn: Turn = { blocks: [userBlock] };
  return {
    ...state,
    turns: [...state.turns, newTurn],
    nextBlockId: id + 1,
  };
}
```

- [ ] **Step 3: LOAD_SESSION — 调用 reconstructTurns**

```typescript
case "LOAD_SESSION": {
  // ... sessions 更新逻辑不变 ...
  return {
    ...state,
    sessions,
    turns: reconstructTurns(action.blocks),  // 替代 state.blocks = action.blocks
    // ...其余字段不变...
  };
}
```

- [ ] **Step 4: NEW_SESSION — 清空 turns**

```typescript
// 之前: blocks: [],
// 之后: turns: [],
// newSnapshot 中: blocks: [] → turns: []
```

- [ ] **Step 5: SWITCH_SESSION — 取 turns 替代 blocks**

```typescript
case "SWITCH_SESSION": {
  const sessions = state.sessions.map(s =>
    s.threadId === state.activeSessionId
      ? { ...s, turns: state.turns, status: state.status, active: false }  // blocks → turns
      : s.threadId === action.threadId
        ? { ...s, active: true }
        : s
  );
  const target = sessions.find(s => s.threadId === action.threadId);
  return {
    ...state,
    sessions,
    activeSessionId: action.threadId,
    turns: target?.turns ?? [],  // blocks → turns
    // ...其余字段不变...
  };
}
```

- [ ] **Step 6: SET_SESSIONS — 适配**

```typescript
// existing.blocks → existing.turns
const mergedSessions = action.sessions.map((incoming) => {
  const existing = state.sessions.find((s) => s.threadId === incoming.threadId);
  if (existing) {
    return { ...incoming, turns: existing.turns, status: existing.status };
  }
  return incoming;
});
```

- [ ] **Step 7: 类型检查**

```bash
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/app/tui/reducers/sessionReducer.ts
git commit -m "refactor: sessionReducer 适配 Turn 模型"
```

---

### Task 6: 适配 `uiReducer.ts`

**Files:**
- Modify: `src/app/tui/reducers/uiReducer.ts`

- [ ] **Step 1: 新增 import**

```typescript
import { findBlockById, replaceBlockById } from "./helpers";
```

- [ ] **Step 2: 删除 `resolveInterruptBlock` 函数定义**

该函数不再需要——`agentReducer.ts` 中的 `ESCAPE` 和 `CTRL_C` 已直接处理。

- [ ] **Step 3: 重写 toggle 类 action**

```typescript
case "TOGGLE_REASON": {
  const block = findBlockById(state, action.id);
  if (!block || block.kind !== "reason") return state;
  return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
}

case "TOGGLE_ALL_REASON": {
  const reasonBlocks: OutputBlock[] = [];
  for (const turn of state.turns) {
    for (const b of turn.blocks) {
      if (b.kind === "reason") reasonBlocks.push(b);
    }
  }
  if (reasonBlocks.length === 0) return state;
  const anyExpanded = reasonBlocks.some((b) => b.kind === "reason" && !b.folded);
  let next = state;
  for (const b of reasonBlocks) {
    if (b.kind === "reason") {
      next = replaceBlockById(next, b.id, { ...b, folded: anyExpanded });
    }
  }
  return next;
}

case "TOGGLE_THINKING": {
  let reasonBlocks: OutputBlock[] = [];
  for (const turn of state.turns) {
    for (const b of turn.blocks) {
      if (b.kind === "reason") reasonBlocks.push(b);
    }
  }
  const anyExpanded = reasonBlocks.some((b) => b.kind === "reason" && !b.folded);
  const isVisible = state.thinkingVisible && anyExpanded;
  if (isVisible) {
    return { ...state, thinkingVisible: false };
  }
  let next = state;
  for (const b of reasonBlocks) {
    if (b.kind === "reason") {
      next = replaceBlockById(next, b.id, { ...b, folded: false });
    }
  }
  return { ...next, thinkingVisible: true };
}

case "TOGGLE_PLAN": {
  const block = findBlockById(state, action.id);
  if (!block || block.kind !== "plan_card") return state;
  return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
}

case "TOGGLE_TOOL_EXPAND": {
  const block = findBlockById(state, action.id);
  if (!block || block.kind !== "tool_card") return state;
  return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
}

case "TOGGLE_SUBAGENT_EXPAND": {
  const block = findBlockById(state, action.id);
  if (!block || block.kind !== "subagent") return state;
  return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
}
```

- [ ] **Step 4: CLEAR_OUTPUT**

```typescript
case "CLEAR_OUTPUT":
  return { ...state, turns: [], toolStartTimes: undefined, currentRunReasonId: undefined };
```

- [ ] **Step 5: ESCAPE 面板关闭（不变，但移除 `resolveInterruptBlock` 调用）**

当前 ESCAPE handler 中调用 `resolveInterruptBlock` 的逻辑应移除——已由 chain dispatch 中 `agentReducer` 的 `ESCAPE` 单独处理。

- [ ] **Step 6: 类型检查**

```bash
bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/reducers/uiReducer.ts
git commit -m "refactor: uiReducer 适配 Turn 模型，使用 helpers"
```

---

### Task 7: 适配 `OutputArea.tsx`

**Files:**
- Modify: `src/app/tui/OutputArea.tsx`

- [ ] **Step 1: 更新 Props**

```typescript
import type { Turn, OutputBlock } from "./types";

interface OutputAreaProps {
  turns: Turn[];  // 替代 blocks: OutputBlock[]
  running: boolean;
  // ...其余 props 不变...
}
```

- [ ] **Step 2: 替换 Static/Dynamic split 逻辑**

删除 `rawSplitIdx` useMemo（第 219-251 行）、`maxSplitRef`（第 258-263 行）、`completedBlocks`（第 265-268 行）、`activeBlocks`（第 269-272 行）。替换为：

```typescript
const settledTurns = running ? turns.slice(0, -1) : turns;
const activeTurn = running ? turns.at(-1) : undefined;

const staticBlocks = settledTurns.flatMap(t => t.blocks);
const activeBlocks = activeTurn ? activeTurn.blocks : [];
```

- [ ] **Step 3: 更新 staticItems**

```typescript
const staticItems = useMemo(() => [HEADER_SENTINEL, ...staticBlocks], [staticBlocks]);
```

- [ ] **Step 4: 更新 Static 渲染函数内部使用 `staticBlocks` 替代 `completedBlocks`**

```typescript
<Static items={staticItems}>
  {(item, index) => {
    if (index === 0) {
      return <React.Fragment key="header">{header}</React.Fragment>;
    }
    const blockIdx = index - 1;
    const block = staticBlocks[blockIdx];  // completedBlocks → staticBlocks
    if (!block) return null;
    return renderBlock(
      block, false, thinkingVisible, blockIdx,
      blockIdx > 0 ? staticBlocks[blockIdx - 1] : undefined,
    );
  }}
</Static>
```

- [ ] **Step 5: 更新 Dynamic 区域渲染**

```typescript
const lastSettledBlock = staticBlocks.at(-1);

activeBlocks.map((block, i) => {
  const isFocused = i === focusedActiveIdx;
  const prevBlock = i > 0
    ? activeBlocks[i - 1]
    : lastSettledBlock;
  return renderBlock(block, isFocused, thinkingVisible, 0, prevBlock);
});
```

- [ ] **Step 6: 类型检查**

```bash
bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/OutputArea.tsx
git commit -m "refactor: OutputArea 适配 Turn 模型，简化 Static/Dynamic 分割"
```

---

### Task 8: 适配 `App.tsx`

**Files:**
- Modify: `src/app/tui/App.tsx`

- [ ] **Step 1: 更新 `initialState` 和 `createInitialState`**

```typescript
const initialState: TuiState = {
  // ...
  turns: [],   // 替代 blocks: []
  // ...
};

export function createInitialState(): TuiState {
  return { ...initialState, turns: [], interrupt: null };
}
```

- [ ] **Step 2: 更新 `interruptBlock` 查找逻辑**

```typescript
const interruptBlock = useMemo(() => {
  if (!state.interrupt) return undefined;
  // 跨所有 turns 查找
  for (const turn of state.turns) {
    const found = turn.blocks.find((b) => b.id === state.interrupt!.blockId);
    if (found) return found;
  }
  return undefined;
}, [state.interrupt, state.turns]);
```

- [ ] **Step 3: 更新 OutputArea 传值**

```tsx
<OutputArea
  turns={state.turns}  // 替代 blocks={state.blocks}
  running={state.running}
  // ...其余 props 不变...
/>
```

- [ ] **Step 4: 类型检查**

```bash
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/app/tui/App.tsx
git commit -m "refactor: App.tsx 适配 Turn 模型"
```

---

### Task 9: 适配 `session-manager.ts`

**Files:**
- Modify: `src/app/tui/session-manager.ts`

- [ ] **Step 1: 在 `getSnapshot` 中将 `blocks: []` 改为 `turns: []`**

```typescript
// 之前（session-manager.ts:365）
blocks: [],

// 之后
turns: [],
```

- [ ] **Step 2: 检查其他引用 `blocks` 的地方**

搜索 `session-manager.ts` 中所有 `blocks` 引用——仅 `getSnapshot` 中的 `blocks: []`。确认无其他需改动点。

- [ ] **Step 3: 类型检查**

```bash
bun run typecheck
```

此时预期 src/ 目录零类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/session-manager.ts
git commit -m "refactor: session-manager 适配 Turn 模型"
```

---

### Task 10: 修复 `index.tsx` 中的类型错误

`index.tsx` 中 `LOAD_SESSION` dispatch 仍传 `blocks: OutputBlock[]`，`LOAD_SESSION` action type 未变，但 sessionReducer 接收后调用 `reconstructTurns`——不需要改 index.tsx。

**确认**: `action.blocks` 在 `LOAD_SESSION` 的 action type (`actions.ts:35`) 中仍为 `blocks: OutputBlock[]`，类型一致。

无需改动 index.tsx。

---

### Task 11: 适配现有测试

**Files:**
- Modify: `tests/tui-reducer.test.ts`
- Modify: `tests/tui-layout.test.tsx`

- [ ] **Step 1: 运行测试看失败**

```bash
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx
```

- [ ] **Step 2: 修复 `tui-reducer.test.ts` 中所有 `state.blocks` 引用**

所有 `s.blocks` 访问都需要改为 `s.turns.flatMap(t => t.blocks)` 或直接访问 `s.turns[0].blocks`。

搜索替换模式：
- `s.blocks` → `s.turns[0]?.blocks ?? []`（单 turn 测试）
- `s.blocks.length` → 改查最后一个 turn
- `s.blocks[0]` → `s.turns[0].blocks[0]`

具体变更示例：

```typescript
// 之前
expect(s.blocks).toHaveLength(1);
expect(s.blocks[0].kind).toBe("text");

// 之后
const allBlocks = s.turns.flatMap(t => t.blocks);
expect(allBlocks).toHaveLength(1);
expect(allBlocks[0].kind).toBe("text");
```

- [ ] **Step 3: 新增 `reconstructTurns` 单元测试**

在 `tui-reducer.test.ts` 末尾新增 describe：

```typescript
import { reconstructTurns } from "../src/app/tui/reducers/helpers";

describe("reconstructTurns", () => {
  test("empty array returns empty turns", () => {
    expect(reconstructTurns([])).toEqual([]);
  });

  test("single user message creates one turn", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "user", content: "hi" },
    ];
    const turns = reconstructTurns(blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks).toHaveLength(1);
    expect(turns[0].blocks[0].kind).toBe("user");
  });

  test("user message followed by agent response in one turn", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "user", content: "hi" },
      { id: 2, kind: "text", content: "Hello!" },
      { id: 3, kind: "tool_card", callId: "c1", name: "read_file", args: {}, status: "done", summary: "" },
    ];
    const turns = reconstructTurns(blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks).toHaveLength(3);
  });

  test("two consecutive user messages create two turns", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "user", content: "hi" },
      { id: 2, kind: "text", content: "Hello!" },
      { id: 3, kind: "user", content: "bye" },
      { id: 4, kind: "text", content: "Goodbye!" },
    ];
    const turns = reconstructTurns(blocks);
    expect(turns).toHaveLength(2);
    expect(turns[0].blocks).toHaveLength(2);
    expect(turns[1].blocks).toHaveLength(2);
  });

  test("blocks before first user message are in first turn", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "text", content: "system message" },
      { id: 2, kind: "user", content: "hi" },
    ];
    const turns = reconstructTurns(blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks).toHaveLength(2);
  });
});
```

- [ ] **Step 4: 修复 `tui-layout.test.tsx`**

将 OutputArea render 测试中的 `blocks` prop 改为 `turns`：

```tsx
// 之前
<OutputArea blocks={[]} ... />

// 之后
<OutputArea turns={[]} ... />
```

所有测试 fixture 构造 `blocks: [...]` 改为 `turns: [{ blocks: [...] }]`。

- [ ] **Step 5: 运行测试，确认全绿**

```bash
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx
```

预期：全部通过。

- [ ] **Step 6: Commit**

```bash
git add tests/tui-reducer.test.ts tests/tui-layout.test.tsx
git commit -m "test: 适配 Turn 模型，新增 reconstructTurns 测试"
```

---

### Task 12: 全量类型检查 + 集成测试

- [ ] **Step 1: 全量类型检查**

```bash
bun run typecheck
```

预期：零错误。

- [ ] **Step 2: 运行全量测试**

```bash
bun test
```

- [ ] **Step 3: 运行 graph + integration + e2e 测试**

```bash
bun test tests/graph.test.ts
bun test tests/integration.test.ts
bun test tests/e2e/
```

- [ ] **Step 4: 手动验证 TUI**

```bash
bun run tui
```

验证：
- 正常对话：消息正常显示，无重复/闪烁
- 工具执行：tool_card running → done 切换正常
- 子 Agent：subagent running → done 切换正常
- 审批流程：approval block 正常显示和交互
- 会话切换：切换 session 后消息正确
- Static/Dynamic：完成后无重复消息，无光标残留

- [ ] **Step 5: Commit（如有修复）**

如有问题修复后提交。如一切正常：

```bash
git add -u
git commit -m "chore: 全量类型检查和集成测试通过"
```

---

## Appendix: E2E Test Notes

`tests/e2e/` 中的 mock agent 输出可能需要适配。如果 mock agent 直接构造 `OutputBlock[]` 传给 reducer，需改为构造 `Turn[]`。在 Task 11 Step 5 运行 e2e 测试后确认是否需要调整。
