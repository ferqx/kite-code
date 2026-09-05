/**
 * Canonical cancellation projection helpers. This module is intentionally
 * imported only by handleClientEvent.ts; local Agent/UI reducers must never
 * derive tool terminality from child fields or seal blocks themselves.
 */
import { getToolDetail } from '../components/render-utils';
import type { ConsolidatedToolEntry, OutputBlock, TuiState } from '../types';
import { buildToolSummaryLine } from './consolidateTools';
import { deriveToolSummaryResult } from './tool-summary-result';

type ToolCardBlock = Extract<OutputBlock, { kind: 'tool_card' }>;
type ToolSummaryBlock = Extract<OutputBlock, { kind: 'tool_summary' }>;

type CancellationClock = {
  now?: number;
  startedAt?: number;
};

/**
 * Project one active tool card to its user-cancelled terminal form.
 *
 * Terminal states are monotonic: a late cancellation fact must never overwrite
 * done/error/timeout/exhausted. The function is intentionally idempotent so the
 * per-tool and whole-turn durable cancellation projections can share it safely.
 */
export function settleCancelledToolCard(
  block: ToolCardBlock,
  options: CancellationClock = {},
): ToolCardBlock {
  if (block.status === 'cancelled') return block;
  if (block.status !== 'queued' && block.status !== 'running') return block;

  const now = options.now ?? Date.now();
  const startedAt = options.startedAt ?? block.startedAt;
  const elapsedMs =
    block.elapsedMs ?? (startedAt != null ? Math.max(0, now - startedAt) : undefined);

  return {
    ...block,
    status: 'cancelled',
    presentationState: 'sealed',
    summary: 'Cancelled',
    detail: block.detail ?? getToolDetail(block.name, block.args),
    expanded: true,
    ...(elapsedMs != null ? { elapsedMs } : {}),
  };
}

function cancelledEntry(entry: ConsolidatedToolEntry): ConsolidatedToolEntry | null {
  if (entry.status === 'queued') return null;
  if (entry.status !== 'running') return entry;
  return {
    ...entry,
    ok: false,
    status: 'cancelled',
    summary: 'Cancelled',
  };
}

function narrationBlocks(
  block: ToolSummaryBlock,
  nextBlockId: number,
): { blocks: OutputBlock[]; nextBlockId: number } {
  const narration = [
    ...(block.captions ?? []),
    ...(block.pendingCaption ? [block.pendingCaption] : []),
  ].join('\n');
  if (!narration) return { blocks: [], nextBlockId };
  return {
    blocks: [{ id: block.id, kind: 'text', content: narration, presentationState: 'sealed' }],
    nextBlockId,
  };
}

function settleCancelledSummaryForTurn(
  block: ToolSummaryBlock,
  now: number,
  nextBlockId: number,
): { blocks: OutputBlock[]; nextBlockId: number; changed: boolean } {
  const tools = block.tools.flatMap((tool) => {
    const next = cancelledEntry(tool);
    return next ? [next] : [];
  });
  const toolsChanged =
    tools.length !== block.tools.length || tools.some((tool, index) => tool !== block.tools[index]);
  const changed = toolsChanged || block.active || block.pendingCaption != null;
  if (!changed) return { blocks: [block], nextBlockId, changed: false };

  if (tools.length === 0 && block.hasThinking !== true) {
    const narration = narrationBlocks(block, nextBlockId);
    return { ...narration, changed: true };
  }

  const settled: ToolSummaryBlock = {
    ...block,
    tools,
    summaryLine: buildToolSummaryLine(tools),
    active: false,
    presentationState: 'sealed',
    latestActivity: undefined,
    totalElapsedMs: block.modelMs ?? now - block.createdAt,
    pendingCaption: undefined,
    result: deriveToolSummaryResult(tools),
  };
  if (block.pendingCaption == null) {
    return { blocks: [settled], nextBlockId, changed: true };
  }
  return {
    blocks: [
      settled,
      {
        id: nextBlockId,
        kind: 'text',
        content: block.pendingCaption,
        presentationState: 'sealed',
      },
    ],
    nextBlockId: nextBlockId + 1,
    changed: true,
  };
}

function projectCancelledSummaryEntry(
  block: ToolSummaryBlock,
  toolCallId: string,
): { blocks: OutputBlock[]; changed: boolean } {
  const index = block.tools.findIndex((tool) => tool.callId === toolCallId);
  if (index < 0) return { blocks: [block], changed: false };

  const current = block.tools[index]!;
  const nextEntry = cancelledEntry(current);
  if (nextEntry === current) return { blocks: [block], changed: false };

  const tools = nextEntry
    ? block.tools.map((tool, toolIndex) => (toolIndex === index ? nextEntry : tool))
    : block.tools.filter((_, toolIndex) => toolIndex !== index);
  if (tools.length === 0 && block.hasThinking !== true) {
    return { blocks: narrationBlocks(block, 0).blocks, changed: true };
  }

  const allSettled = tools.every((tool) => tool.status !== 'queued' && tool.status !== 'running');
  return {
    blocks: [
      {
        ...block,
        tools,
        summaryLine: buildToolSummaryLine(tools),
        presentationState: allSettled && !block.active ? 'sealed' : 'live',
        ...(allSettled ? { result: deriveToolSummaryResult(tools) } : {}),
      },
    ],
    changed: true,
  };
}

/** Project one durable tool.cancelled fact without turning it into a generic error. */
export function projectToolCancelled(
  state: TuiState,
  toolCallId: string,
  options: { now?: number } = {},
): TuiState {
  const now = options.now ?? Date.now();
  let changed = false;
  const turns = state.turns.map((turn) => ({
    blocks: turn.blocks.flatMap((block): OutputBlock[] => {
      if (block.kind === 'tool_card' && block.callId === toolCallId) {
        const next = settleCancelledToolCard(block, {
          now,
          startedAt: state.toolStartTimes?.[toolCallId],
        });
        if (next !== block) changed = true;
        return [next];
      }
      if (block.kind === 'tool_summary') {
        const projected = projectCancelledSummaryEntry(block, toolCallId);
        if (projected.changed) changed = true;
        return projected.blocks;
      }
      return [block];
    }),
  }));

  const hadPending = state.pendingToolCalls[toolCallId] != null;
  const hadStartTime = state.toolStartTimes?.[toolCallId] != null;
  if (!changed && !hadPending && !hadStartTime) return state;

  const { [toolCallId]: _pending, ...pendingToolCalls } = state.pendingToolCalls;
  const { [toolCallId]: _started, ...toolStartTimes } = state.toolStartTimes ?? {};
  return {
    ...state,
    turns,
    pendingToolCalls,
    toolStartTimes: Object.keys(toolStartTimes).length > 0 ? toolStartTimes : undefined,
  };
}

/**
 * Project one durable whole-turn user cancellation into visual terminal state.
 * Keyboard input must not call this before Runtime confirms the cancellation.
 */
export function projectDurableUserCancelledTurn(
  state: TuiState,
  options: { now?: number; clearPendingToolCalls?: boolean } = {},
): TuiState {
  const lastTurnIndex = state.turns.length - 1;
  if (lastTurnIndex < 0) {
    return options.clearPendingToolCalls === false ||
      Object.keys(state.pendingToolCalls).length === 0
      ? state
      : { ...state, pendingToolCalls: {} };
  }

  const now = options.now ?? Date.now();
  let changed = false;
  let nextBlockId = state.nextBlockId;
  const cancelledCallIds = new Set<string>();
  const turns = state.turns.slice();
  const last = state.turns[lastTurnIndex]!;
  const blocks = last.blocks.flatMap((block): OutputBlock[] => {
    if (block.kind === 'subagent' && (block.status === 'running' || block.status === 'suspended')) {
      changed = true;
      return [
        {
          ...block,
          status: 'cancelled',
          presentationState: 'sealed',
          summary: 'Cancelled',
          error: 'Cancelled',
          toolCallCount: block.steps.length,
          durationMs: state.runStartTime ? now - state.runStartTime : 0,
          expanded: false,
        },
      ];
    }
    if (block.kind === 'tool_card' && (block.status === 'queued' || block.status === 'running')) {
      cancelledCallIds.add(block.callId);
      const next = settleCancelledToolCard(block, {
        now,
        startedAt: state.toolStartTimes?.[block.callId],
      });
      if (next !== block) changed = true;
      return [next];
    }
    if (block.kind === 'tool_summary') {
      for (const tool of block.tools) {
        if (tool.status === 'queued' || tool.status === 'running') {
          cancelledCallIds.add(tool.callId);
        }
      }
      const projected = settleCancelledSummaryForTurn(block, now, nextBlockId);
      nextBlockId = projected.nextBlockId;
      if (projected.changed) changed = true;
      return projected.blocks;
    }
    return [block];
  });

  if (changed) turns[lastTurnIndex] = { blocks };

  let toolStartTimes = state.toolStartTimes;
  if (toolStartTimes && cancelledCallIds.size > 0) {
    const remaining = Object.fromEntries(
      Object.entries(toolStartTimes).filter(([callId]) => !cancelledCallIds.has(callId)),
    );
    toolStartTimes = Object.keys(remaining).length > 0 ? remaining : undefined;
  }
  const pendingToolCalls =
    options.clearPendingToolCalls === false || Object.keys(state.pendingToolCalls).length === 0
      ? state.pendingToolCalls
      : {};
  const globalChanged =
    changed ||
    nextBlockId !== state.nextBlockId ||
    toolStartTimes !== state.toolStartTimes ||
    pendingToolCalls !== state.pendingToolCalls ||
    state.currentThoughtSummaryId != null;
  if (!globalChanged) return state;

  return {
    ...state,
    turns,
    nextBlockId,
    toolStartTimes,
    pendingToolCalls,
    currentThoughtSummaryId: undefined,
  };
}
