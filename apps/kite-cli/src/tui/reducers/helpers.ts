import type { OutputBlock, TuiState, Turn } from '../types';

/** Soft cap on turns to prevent unbounded memory growth in long sessions */
const MAX_TURNS = 500;

function trimTurns(state: TuiState): TuiState {
  if (state.turns.length <= MAX_TURNS) return state;
  const trimmed = state.turns.slice(state.turns.length - MAX_TURNS);
  return { ...state, turns: trimmed };
}

/** Find the first block matching the predicate across all turns (backward scan). */
export function findBlock(
  state: TuiState,
  match: (b: OutputBlock) => boolean,
): OutputBlock | undefined {
  for (let t = state.turns.length - 1; t >= 0; t--) {
    for (let i = state.turns[t]!.blocks.length - 1; i >= 0; i--) {
      if (match(state.turns[t]!.blocks[i]!)) return state.turns[t]!.blocks[i]!;
    }
  }
  return undefined;
}

/** Returns true if any block in any turn matches the predicate. */
export function hasBlock(state: TuiState, match: (b: OutputBlock) => boolean): boolean {
  for (const turn of state.turns) {
    if (turn.blocks.some(match)) return true;
  }
  return false;
}

/** 追加 block 到最后 turn，自增 nextBlockId。
 *  若 turns 为空，自动创建首个 turn。 */
export function appendBlock(state: TuiState, block: OutputBlock): TuiState {
  if (state.turns.length === 0) {
    return trimTurns({
      ...state,
      turns: [{ blocks: [block] }],
      nextBlockId: state.nextBlockId + 1,
    });
  }
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  turns[turns.length - 1] = { blocks: [...last.blocks, block] };
  return trimTurns({ ...state, turns, nextBlockId: state.nextBlockId + 1 });
}

/**
 * Append a user prompt as a new conversation turn.
 *
 * A live reducer used to append every prompt to the previous turn and only
 * recover the turn boundaries during session replay. That made a cancelled
 * turn and its successor share one active turn. When the visible run briefly
 * became idle, useStaticContent could commit the whole combined turn to Ink's
 * immutable <Static> tree; the successor's tool then appeared frozen or was
 * rendered twice when the next run became active.
 *
 * User prompts are the authoritative turn boundary in both live rendering and
 * replay, so preserve that boundary at insertion time as well.
 */
export function appendUserMessage(state: TuiState, block: OutputBlock): TuiState {
  if (state.turns.length === 0 || state.turns.at(-1)!.blocks.length === 0) {
    return appendBlock(state, block);
  }

  return trimTurns({
    ...state,
    turns: [...state.turns, { blocks: [block] }],
    nextBlockId: state.nextBlockId + 1,
  });
}

/** 按 id 查找 block（跨所有 turns） */
export function findBlockById(state: TuiState, blockId: number): OutputBlock | undefined {
  for (const turn of state.turns) {
    const found = turn.blocks.find((b) => b.id === blockId);
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
export function replaceBlockById(state: TuiState, blockId: number, next: OutputBlock): TuiState {
  const turns = state.turns.map((turn) => {
    const idx = turn.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return turn;
    const blocks = turn.blocks.slice();
    blocks[idx] = next;
    return { blocks };
  });
  return { ...state, turns };
}

/** Finalize 最后 turn 中所有 mutable text block.
 *  need_approval、need_input、SET_IDLE、CTRL_C 时调用。 */
export function finalizeLastTurnStreaming(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;
  let changed = false;
  const blocks = last.blocks.flatMap((b) => {
    if (b.kind === 'text' && (b.streaming || b.responsePending)) {
      changed = true;
      return [{ ...b, streaming: false, responsePending: undefined } as typeof b];
    }
    if (b.kind === 'tool_summary' && b.responsePending) {
      changed = true;
      return [{ ...b, responsePending: undefined } as typeof b];
    }
    return [b];
  });
  if (!changed) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks };
  return { ...state, turns };
}

/** 合并最后一个 turn 中连续的 text block（中间无其他类型块）。
 *  流式渲染期间 text 事件按行拆分为独立 OutputBlock，导致段落双倍间距和
 *  列表项意外间距。合并后 MarkdownBlock 通过 spacingBetween 正确处理。
 *  Merge consecutive text blocks in the last turn into a single block.
 *  During streaming, text events are split into per-line blocks, causing
 *  double paragraph spacing and unwanted list-item gaps. Merging lets
 *  MarkdownBlock handle spacing correctly via spacingBetween. */
export function mergeConsecutiveTextBlocksInLastTurn(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;

  const merged: OutputBlock[] = [];
  let changed = false;
  let textBuffer: { id: number; content: string } | null = null;

  for (const b of last.blocks) {
    if (b.kind === 'text') {
      if (textBuffer) {
        // Append to existing text buffer with \n separator
        textBuffer.content += `\n${b.content}`;
        changed = true;
      } else {
        textBuffer = { id: b.id, content: b.content };
      }
    } else {
      if (textBuffer) {
        merged.push({
          id: textBuffer.id,
          kind: 'text',
          content: textBuffer.content,
          streaming: false,
        });
        textBuffer = null;
      }
      merged.push(b);
    }
  }
  // Flush remaining text buffer
  if (textBuffer) {
    merged.push({
      id: textBuffer.id,
      kind: 'text',
      content: textBuffer.content,
      streaming: false,
    });
  }

  if (!changed) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks: merged };
  return { ...state, turns };
}

/** 从扁平的 OutputBlock[] 按 kind === "user" 切分 turns */
export function reconstructTurns(blocks: OutputBlock[]): Turn[] {
  const turns: Turn[] = [];
  let current: OutputBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'user' && current.length > 0) {
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

/** Compute next block ID from turns (max ID + 1, or 0 if empty) */
export function maxBlockIdInTurns(turns: Turn[]): number {
  let max = 0;
  for (const turn of turns) {
    for (const b of turn.blocks) {
      if (b.id >= max) max = b.id;
    }
  }
  return max;
}
