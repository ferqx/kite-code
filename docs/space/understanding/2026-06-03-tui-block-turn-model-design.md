# TUI 消息列表 Turn 模型重构

日期：2026-06-03
状态：draft

## 背景

TUI 消息列表是修改最频繁的模块之一。每次新增 block 类型或扩展交互功能，渲染层都会出现问题。近期补丁链：

| Commit | 主题 | 根因 |
|--------|------|------|
| `c517c64` | 修复 Static 渲染导致子 Agent 工具消息重复 | monotonic guard 逻辑脆弱 |
| `54e2431` | 恢复 Static 渲染架构 | 替代方案（React.memo）有性能问题 |
| `9639e63` | Plan 面板 + 工具输出可见 + 子Agent 步骤展开 | 三类新功能在 split 逻辑中各加判断 |

诊断结论：根本矛盾是 **flat `OutputBlock[]` 数组在建模层级结构（Turn → Block）**，导致所有渲染判定都靠运行时扫描去推断结构信息。

## 目标

1. 引入 `Turn` 作为一等公民，消除运行时扫描推断 Turn 边界
2. Static/Dynamic 分割退化为「最后一个 turn vs 其余 turns」的简单切片
3. 新 block 类型不再需要在 split 逻辑中追加判断条件
4. 消除 `replaceBlock` 重复实现，统一 block 更新模式

## 数据模型

### 当前

```typescript
// TuiState
blocks: OutputBlock[];
```

Turn 边界靠反向扫描 `kind === "user"` 推断，Static/Dynamic 分割靠扫描 block 内部属性（`streaming`、`running` 状态）。

### 目标

```typescript
interface Turn {
  blocks: OutputBlock[];
}

// TuiState
turns: Turn[];
```

每个 Turn 对应一次「用户提问 → Agent 回复」的完整往返。用户 `kind: "user"` 的 block 始终是每个 turn 的第一个 block。空 Turn（0 blocks）不会出现——`USER_MESSAGE` 同时创建 turn 和 user block。

### OutputBlock 不变

9 种 discriminated union 保持不变：

```typescript
type OutputBlock =
  | { id: number; kind: "user"; content: string }
  | { id: number; kind: "text"; content: string; streaming?: boolean; isError?: boolean }
  // 其余类型字段完全不变
```

`streaming?: boolean` 保留为可选字段。仅在 `text` 事件创建 block 时设为 `state.running`；`final`、`error`、`model_retry`、`compact_*` 等其他 8 种创建 text block 的路径不设此字段（等价于 `streaming: false`）。

`streaming` 的语义：表达「block 内容可能继续增长」而非「正在运行中」。渲染时 `renderBlock` 用 `streaming` 展示 `❯` 光标；`running` 用于决定 Dynamic 区是否激活。两者语义不同。

## Static/Dynamic 分割

### 当前逻辑（50+ 行）

```typescript
// OutputArea.tsx
const rawSplitIdx = useMemo(() => {
  // 1. 找最后一个 user block（推断 turn 边界）
  let turnStart = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user") { turnStart = i; break; }
  }
  // 2. 在当前 turn 内找需要 dynamic 渲染的 block
  let firstDynamic = -1;
  if (turnStart >= 0) {
    for (let i = turnStart; i < blocks.length; i++) {
      const b = blocks[i];
      if (
        (b.kind === "text" && b.streaming) ||
        (b.kind === "tool_card" && b.status === "running") ||
        (b.kind === "subagent" && b.status === "running") ||
        (b.kind === "approval" && !b.resolved) ||
        (b.kind === "question" && !b.resolved)
      ) { firstDynamic = i; break; }
    }
  }
  // 3. idle 边界情况
  if (!running) return blocks.length;
  if (turnStart >= 0) return turnStart;
  return -1;
}, [blocks, running]);

// 4. Monotonic guard（防止 Static items 缩小）
const maxSplitRef = useRef(-1);
if (!running) maxSplitRef.current = -1;
const splitIdx = rawSplitIdx >= 0 ? Math.max(rawSplitIdx, maxSplitRef.current) : rawSplitIdx;
maxSplitRef.current = splitIdx;
```

问题：
- 步骤 2 手动枚举需要 dynamic 的 block 类型（新类型易遗漏）
- 步骤 4 monotonic guard 本质是创可贴——数据结构不保证「已完成即不变」
- `HEADER_SENTINEL` hack 确保 `<Static>` 有 ≥1 个 item

### 目标逻辑（5 行）

```typescript
const settledTurns = running ? turns.slice(0, -1) : turns;
const activeTurn   = running ? turns.at(-1) : undefined;

const staticBlocks  = settledTurns.flatMap(t => t.blocks);
const activeBlocks  = activeTurn ? activeTurn.blocks : [];
const staticItems   = [HEADER_SENTINEL, ...staticBlocks];
```

- `running = false` → 全部 turns 进 Static，Dynamic 区为空
- `running = true` → 最后一个 turn 在 Dynamic，前面所有 turns 在 Static

不需要 monotonic guard：settled turns 在 running 状态变化时可能增多（回 idle 时最后一个 turn 变 settled），但不会减少。最后一个 turn 变 settled 时 `running` 变为 false，此时 `turns.slice(0, -1)` 变成 `turns`（全部 settled）——Static 项目数单调增加。

不需要枚举 dynamic block 类型：active turn 的所有 block 都在 Dynamic 区。如果一个 block 不需要实时更新（如 user 消息），渲染器会根据 `block.kind` 正确处理，不会产生副作用。

### prevBlock 跨 Turn 传递

`renderBlock` 用 `prevBlock` 判断连续 reason 合并等场景。active turn 第一个 block 的 prevBlock 应为最后一个 settled block：

```typescript
const lastSettledBlock = staticBlocks.at(-1);

activeBlocks.map((block, i) => {
  const prevBlock = i > 0
    ? activeBlocks[i - 1]
    : lastSettledBlock;
  return renderBlock(block, isFocused, thinkingVisible, i, prevBlock);
});
```

## Block 操作 Helpers

新增 `src/app/tui/reducers/helpers.ts`，统一 `replaceBlock`（当前在 `handleEvent.ts` 和 `agentReducer.ts` 中重复）：

```typescript
import type { TuiState, OutputBlock } from "../types";

/** 追加 block 到最后 turn，自增 nextBlockId。
 *  前置条件：state.turns.length > 0（USER_MESSAGE 已创建首个 turn）。 */
export function appendBlock(state: TuiState, block: OutputBlock): TuiState {
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  turns[turns.length - 1] = { blocks: [...last.blocks, block] };
  return { ...state, turns, nextBlockId: state.nextBlockId + 1 };
}

/** 按 id 查找 block（跨所有 turns） */
export function findBlockById(state: TuiState, blockId: number): OutputBlock | undefined {
  for (const turn of state.turns) {
    const found = turn.blocks.find(b => b.id === blockId);
    if (found) return found;
  }
  return undefined;
}

/** 替换最后 turn 的最后 block（流式更新 text content）。
 *  前置条件：最后 turn 至少有一个 block。 */
export function updateLastBlock(state: TuiState, block: OutputBlock): TuiState {
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
  const turns = state.turns.map(turn => {
    const idx = turn.blocks.findIndex(b => b.id === blockId);
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
  const blocks = last.blocks.map(b => {
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

## Reducer 层改动

### 新增 Turn

`USER_MESSAGE` 是唯一创建新 Turn 的 action。其余所有 agent 事件都往最后一个 turn 追加 block，不再判断是否需要新建 turn。

### handleEvent.ts — 各事件适配

**text**：改为检查最后一个 turn 的最后一个 block。`streaming` 创建时仍设为 `state.running`。

```
之前：blocks.slice(0, -1) + push 到 state.blocks
之后：updateLastBlock(state, ...) 更新最后 turn 的最后 block
```

**reason**：`currentRunReasonId` 机制不变，追加到最后一个 turn。

**tool_call / tool_done**：优先在最后一个 turn 中查找匹配 block（性能优化），未找到则回退到全局查找。

**subagent_\***：同上。

**need_approval / need_input**：finalize streaming 逻辑保留（将所有 `streaming: true` 的 text block 改为 `false`），但范围限制在最后一个 turn 内。

**file_change**：检查最后一个 turn 的最后 block 是否为 file_change，是则聚合，否则新建。

**compact_begin / compact_end / model_retry / error / final**：统一用 `appendBlock`。

**无变化的事件**：`state_change`、`step_begin`、`step_end`、`cache_metrics` 不操作 blocks。

### agentReducer.ts

| Action | 变化 |
|--------|------|
| `SET_RUNNING` | 不变 |
| `SET_IDLE` | 调用 `finalizeLastTurnStreaming`（仅最后 turn，非全量） |
| `SET_EXITED` | 改用 `appendBlock` |
| `RESOLVE_INTERRUPT` | 改用 `replaceBlockById` |
| `CTRL_C` / `ESCAPE` | finalize 改为只处理最后一个 turn；`resolveInterruptBlock` 改用 `replaceBlockById` |
| 其余 | 改用 `appendBlock` / `replaceBlockById` |

### sessionReducer.ts

| Action | 变化 |
|--------|------|
| `USER_MESSAGE` | 创建新 turn：`turns: [...state.turns, { blocks: [userBlock] }]` |
| `LOAD_SESSION` | 调用 `reconstructTurns(action.blocks)` 获得新 turns |
| `NEW_SESSION` | turns 持久化为空：`blocks: []` → `turns: []` |
| `SWITCH_SESSION` | `target` 中取出 turns；`SessionSnapshot.blocks` → `SessionSnapshot.turns` |
| `SET_SESSIONS` | `existing.blocks` → `existing.turns` |

### uiReducer.ts

toggle 类操作（`TOGGLE_REASON`、`TOGGLE_PLAN`、`TOGGLE_TOOL_EXPAND`、`TOGGLE_SUBAGENT_EXPAND`）— 先用 `findBlockById` 查找再替换：

```typescript
case "TOGGLE_REASON": {
  const block = findBlockById(state, action.id);
  if (!block || block.kind !== "reason") return state;
  return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
}
```

`CLEAR_OUTPUT`：`blocks: []` → `turns: []`。

## 渲染层改动

### OutputArea.tsx Props

```typescript
interface OutputAreaProps {
  turns: Turn[];         // 替代 blocks: OutputBlock[]
  running: boolean;
  thinkingVisible: boolean;
  overlayActive?: boolean;
  header?: React.ReactNode;
  onToggleReason: (id: number) => void;
  onTogglePlan?: (id: number) => void;
  onToggleToolExpand?: (id: number) => void;
  onToggleSubagentExpand?: (id: number) => void;
}
```

### App.tsx

```tsx
<OutputArea
  turns={state.turns}     // 替代 blocks={state.blocks}
  running={state.running}
  ...
/>
```

### renderBlock 函数

完全不变。每个 block 的渲染逻辑不依赖 turn 结构，只依赖 block 自身字段和 `prevBlock`。

## 影响范围

### 直接改动

| 文件 | 改动类别 |
|------|---------|
| `src/app/tui/types.ts` | 新增 `Turn` 接口；`TuiState.blocks` → `turns: Turn[]` |
| `src/app/tui/reducers/helpers.ts` | **新文件** — `appendBlock`、`findBlockById`、`updateLastBlock`、`replaceBlockById`、`finalizeLastTurnStreaming`、`reconstructTurns`、`lastTurn` 共 7 个 helper |
| `src/app/tui/reducers/handleEvent.ts` | 所有事件 handler 适配 turn 操作；移除 `replaceBlock` |
| `src/app/tui/reducers/agentReducer.ts` | 适配 turn 操作；移除 `replaceBlock` |
| `src/app/tui/reducers/sessionReducer.ts` | `USER_MESSAGE` 创建新 turn；`LOAD_SESSION` 调用 `reconstructTurns` |
| `src/app/tui/reducers/uiReducer.ts` | Toggle 类操作跨 turn 查找更新 |
| `src/app/tui/OutputArea.tsx` | Props 改用 turns；简化为 settled/active 切片 |
| `src/app/tui/App.tsx` | 传递 `state.turns` |

### 间接影响

| 文件 | 变化原因 |
|------|---------|
| `src/app/tui/session-manager.ts` | `SessionSnapshot.blocks` → `turns` |
| `tests/tui-reducer.test.ts` | 测试适配新数据结构 |
| `tests/tui-layout.test.tsx` | 测试适配新 Props |
| `tests/e2e/*.test.tsx` | 可能需要适配 mock agent 输出格式 |

## 不变项

- `nextBlockId` 自增机制不变
- `toolStartTimes` Map 不变
- `currentRunReasonId` reason 合并逻辑不变
- `interrupt: InterruptState { kind, blockId }` 不变
- `SubAgentBlock`、`ToolCardBlock`、`PlanCardBlock`、`MarkdownBlock` 等组件完全不变
- `Header`、`Footer` 组件不变
- `ApproveBlock`、`InputBlock` 组件不变
- Ink `<Static>` 使用方式不变（只改变流入它的数据来源）
- Arrow key 导航逻辑不变

## 验证计划

1. `bun run typecheck` — 零错误
2. `bun test tests/tui-reducer.test.ts` — reducer 单元测试
3. `bun test tests/tui-layout.test.tsx` — TUI 布局测试
4. `bun test tests/graph.test.ts` — 图路由 + 审批流不受影响
5. `bun test tests/integration.test.ts` — 全图集成确认不退化
6. `bun test tests/e2e/` — TUI e2e 确认端到端正常
7. `bun run tui` — 手动验证 Static/Dynamic 渲染无重复、无闪烁
