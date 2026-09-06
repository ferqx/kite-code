import type { OutputBlock, OutputBlockVariant, TuiState, Turn } from '../types';
import { deriveToolSummaryResult } from './tool-summary-result';

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
  const normalized: OutputBlock =
    block.presentationState === undefined
      ? {
          ...block,
          presentationState:
            block.kind === 'reason' || block.kind === 'file_change' ? 'sealed' : 'live',
        }
      : block;
  if (state.turns.length === 0) {
    return trimTurns({
      ...state,
      turns: [{ blocks: [normalized] }],
      nextBlockId: state.nextBlockId + 1,
    });
  }
  const turns = state.turns.slice();
  const last = turns.at(-1)!;
  turns[turns.length - 1] = { blocks: [...last.blocks, normalized] };
  return trimTurns({ ...state, turns, nextBlockId: state.nextBlockId + 1 });
}

/**
 * Append a local diagnostic/text result without entering the Runtime event
 * projector. Local presentation actions have no lifecycle authority and are
 * sealed immediately so they cannot be mistaken for a streamed model answer.
 */
export function appendLocalText(state: TuiState, text: string, isError = false): TuiState {
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: text,
    streaming: false,
    presentationState: 'sealed',
    ...(isError ? { isError: true } : {}),
  });
}

/**
 * Give every block loaded through a session boundary an explicit lifecycle
 * marker. Loaded blocks are snapshots rather than live Runtime facts, so a
 * missing marker is conservatively sealed and can never become a second
 * mutable authority in Static.
 */
export function normalizeLoadedPresentationBlock(block: OutputBlock): OutputBlock {
  return block.presentationState === undefined
    ? { ...block, presentationState: 'sealed' as const }
    : block;
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
    turns: [
      ...state.turns,
      {
        blocks: [
          block.presentationState === undefined ? { ...block, presentationState: 'live' } : block,
        ],
      },
    ],
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

/** Mark one presentation entity terminal without deriving terminality in the
 * renderer.  This marker is reducer-owned and intentionally orthogonal to
 * interactive expansion/focus fields. */
export function sealBlockById(state: TuiState, blockId: number): TuiState {
  let changed = false;
  const turns = state.turns.map((turn) => {
    let turnChanged = false;
    const blocks = turn.blocks.map((block) => {
      if (block.id !== blockId || block.presentationState === 'sealed') return block;
      changed = true;
      turnChanged = true;
      return { ...block, presentationState: 'sealed' as const };
    });
    return turnChanged ? { blocks } : turn;
  });
  return changed ? { ...state, turns } : state;
}

export type PresentationTerminalOutcome = 'completed' | 'failed' | 'cancelled';

function terminalToolStatus(
  outcome: PresentationTerminalOutcome,
): Extract<OutputBlock, { kind: 'tool_card' }>['status'] {
  return outcome === 'failed' ? 'error' : 'cancelled';
}

function terminalSummary(outcome: PresentationTerminalOutcome): string {
  return outcome === 'failed' ? 'Run ended before tool completion.' : 'Cancelled';
}

/**
 * Freeze one render model at an authoritative lifecycle terminal.  A Run can
 * terminalize while a best-effort tool/subagent cleanup event is still in
 * flight; leaving its variant-specific status as `running` would let the
 * renderer paint a spinner inside an already sealed Static item.
 */
export function freezePresentationBlock(
  block: OutputBlock,
  outcome: PresentationTerminalOutcome = 'cancelled',
): OutputBlock {
  const pendingToolStatus = terminalToolStatus(outcome);
  const fallbackSummary = terminalSummary(outcome);
  switch (block.kind) {
    case 'tool_card':
      return {
        ...block,
        ...(block.status === 'queued' || block.status === 'running'
          ? {
              status: pendingToolStatus,
              summary: block.summary || fallbackSummary,
              expanded: true,
            }
          : {}),
        presentationState: 'sealed',
      };
    case 'tool_summary': {
      const tools = block.tools.map((tool) =>
        tool.status === 'queued' || tool.status === 'running'
          ? {
              ...tool,
              status: pendingToolStatus,
              ok: false,
              summary: tool.summary || fallbackSummary,
            }
          : tool,
      );
      const result = deriveToolSummaryResult(tools);
      return {
        ...block,
        tools,
        active: false,
        latestActivity: undefined,
        pendingCaption: undefined,
        presentationState: 'sealed',
        ...(result === undefined ? {} : { result }),
      };
    }
    case 'subagent':
      return {
        ...block,
        ...(block.status === 'running' || block.status === 'suspended'
          ? {
              status: pendingToolStatus === 'error' ? ('error' as const) : ('cancelled' as const),
              summary: block.summary || fallbackSummary,
              error: pendingToolStatus === 'error' ? fallbackSummary : 'Cancelled',
              expanded: false,
            }
          : {}),
        presentationState: 'sealed',
      };
    case 'question':
      return {
        ...block,
        ...(block.resolved === undefined
          ? { resolved: outcome === 'failed' ? 'failed' : 'cancelled' }
          : {}),
        presentationState: 'sealed',
      };
    case 'approval':
      return {
        ...block,
        ...(block.resolved === undefined
          ? { resolved: { action: outcome === 'failed' ? 'failed' : 'cancelled' } }
          : {}),
        presentationState: 'sealed',
      };
    case 'text':
      return { ...block, streaming: false, presentationState: 'sealed' };
    default:
      return { ...block, presentationState: 'sealed' };
  }
}

function presentationNeedsFreeze(block: OutputBlock): boolean {
  if (block.presentationState !== 'sealed') return true;
  if (block.kind === 'tool_card') return block.status === 'queued' || block.status === 'running';
  if (block.kind === 'tool_summary') {
    return (
      block.active ||
      block.tools.some((tool) => tool.status === 'queued' || tool.status === 'running')
    );
  }
  return block.kind === 'subagent' && (block.status === 'running' || block.status === 'suspended');
}

/** Seal every currently visible presentation entity at a Run terminal. */
export function sealAllPresentationBlocks(
  state: TuiState,
  outcome: PresentationTerminalOutcome = 'cancelled',
): TuiState {
  let changed = false;
  const turns = state.turns.map((turn) => {
    let turnChanged = false;
    const blocks = turn.blocks.map((block) => {
      if (!presentationNeedsFreeze(block)) return block;
      changed = true;
      turnChanged = true;
      return freezePresentationBlock(block, outcome);
    });
    return turnChanged ? { blocks } : turn;
  });
  return changed ? { ...state, turns } : state;
}

/** Seal only the current turn at a Turn/Task terminal; a queued successor may
 * already own a separate, still-live turn. */
export function sealLastTurnPresentationBlocks(
  state: TuiState,
  outcome: PresentationTerminalOutcome = 'cancelled',
): TuiState {
  const index = state.turns.length - 1;
  if (index < 0) return state;
  const turn = state.turns[index]!;
  let changed = false;
  const blocks = turn.blocks.map((block) => {
    if (!presentationNeedsFreeze(block)) return block;
    changed = true;
    return freezePresentationBlock(block, outcome);
  });
  if (!changed) return state;
  const turns = state.turns.slice();
  turns[index] = { blocks };
  return { ...state, turns };
}

/** Finalize 最后 turn 中所有 mutable text block.
 *  need_approval、need_input、terminal 与 session 切换时调用。 */
export function finalizeLastTurnStreaming(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;
  let changed = false;
  const blocks = last.blocks.flatMap((b) => {
    if (b.kind === 'text' && b.streaming) {
      changed = true;
      return [{ ...b, streaming: false } as typeof b];
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
  let textBuffer:
    | (Extract<OutputBlockVariant, { kind: 'text' }> & {
        presentationState?: 'live' | 'sealed';
      })
    | undefined;

  for (const b of last.blocks) {
    if (b.kind === 'text') {
      if (textBuffer !== undefined) {
        // Append to existing text buffer with \n separator
        textBuffer = {
          ...textBuffer,
          content: `${textBuffer.content}\n${b.content}`,
          streaming: false,
        };
        changed = true;
      } else {
        textBuffer = b;
      }
    } else {
      if (textBuffer !== undefined) {
        merged.push({ ...textBuffer, streaming: false });
        textBuffer = undefined;
      }
      merged.push(b);
    }
  }
  // Flush remaining text buffer
  if (textBuffer !== undefined) {
    merged.push({ ...textBuffer, streaming: false });
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
