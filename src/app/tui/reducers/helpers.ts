import type { TuiState, OutputBlock, Turn } from "../types";

/** Soft cap on turns to prevent unbounded memory growth in long sessions */
const MAX_TURNS = 500;

function trimTurns(state: TuiState): TuiState {
  if (state.turns.length <= MAX_TURNS) return state;
  return { ...state, turns: state.turns.slice(state.turns.length - MAX_TURNS) };
}

/** 追加 block 到最后 turn，自增 nextBlockId。
 *  若 turns 为空，自动创建首个 turn。 */
export function appendBlock(state: TuiState, block: OutputBlock): TuiState {
  if (state.turns.length === 0) {
    return trimTurns({ ...state, turns: [{ blocks: [block] }], nextBlockId: state.nextBlockId + 1 });
  }
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  turns[turns.length - 1] = { blocks: [...last.blocks, block] };
  return trimTurns({ ...state, turns, nextBlockId: state.nextBlockId + 1 });
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
