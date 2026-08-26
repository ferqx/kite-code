import type * as Protocol from '@kite-ai/runtime-contract';
import { getToolDetail, getToolPreview } from '../components/render-utils';
import type { OutputBlock, TuiState } from '../types';
import {
  appendBlock,
  finalizeLastTurnStreaming,
  findBlock,
  replaceBlockById,
  updateLastBlock,
} from './helpers';

/** Local, non-Runtime rendering commands. Runtime updates use RuntimeClientEvent. */
export type RenderEvent =
  | { type: 'text' | 'reason'; data: { text: string; streamingDelta?: boolean } }
  | { type: 'final'; data: string }
  | { type: 'tool_call'; data: Protocol.ToolCallPayload }
  | { type: 'tool_started'; data: Protocol.ToolStartedPayload }
  | { type: 'tool_done'; data: Protocol.ToolResultPayload }
  | { type: 'tool_progress'; data: Protocol.ToolProgressPayload }
  | { type: 'need_approval'; data: Protocol.ToolApprovalPayload }
  | { type: 'need_input'; data: Protocol.UserInputPayload; toolCallId?: string }
  | { type: 'need_plan_review'; data: Protocol.NeedPlanReviewPayload }
  | { type: 'error'; data: { message: string; recoverable: boolean } }
  | { type: 'state_change'; data: Protocol.StateChangePayload }
  | { type: 'step_begin'; data: { readonly node: string; readonly spanId: string } }
  | { type: 'step_end' | 'interrupt' | 'update'; data: unknown };

/** Pure UI reducer. It has no Runtime/Kernel type or import. */
export function handleEventAction(state: TuiState, event: RenderEvent): TuiState {
  switch (event.type) {
    case 'text':
      return appendText(state, event.data.text, event.data.streamingDelta !== false);
    case 'reason':
      return appendBlock(state, {
        id: state.nextBlockId,
        kind: 'reason',
        content: event.data.text,
        folded: true,
      });
    case 'final':
      return finalizeLastTurnStreaming(appendText(state, event.data, false));
    case 'tool_call':
      return upsertTool(state, event.data.call_id, event.data.name, event.data.status, '');
    case 'tool_started':
      return updateTool(state, event.data.call_id, 'running', 'Running tool.');
    case 'tool_done':
      return updateTool(
        state,
        event.data.call_id,
        event.data.ok ? 'done' : event.data.status === 'cancelled' ? 'cancelled' : 'error',
        event.data.summary,
      );
    case 'tool_progress':
      return updateToolProgress(state, event.data);
    case 'need_approval':
      return {
        ...finalizeLastTurnStreaming(state),
        interrupt: { kind: 'approval', approval: event.data },
      };
    case 'need_input': {
      const block: OutputBlock = {
        id: state.nextBlockId,
        kind: 'question',
        question: event.data,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      };
      return {
        ...appendBlock(finalizeLastTurnStreaming(state), block),
        interrupt: {
          kind: 'input',
          blockId: block.id,
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        },
      };
    }
    case 'need_plan_review':
      return {
        ...state,
        status: { ...state.status, pendingPlan: event.data.plan },
        interrupt: {
          kind: 'plan_review',
          plan: event.data.plan,
          ...(event.data.artifact ? { artifact: event.data.artifact } : {}),
        },
      };
    case 'state_change':
      return {
        ...state,
        status: {
          ...state.status,
          ...(event.data.phase === undefined ? {} : { phase: event.data.phase }),
          ...(event.data.plan === undefined ? {} : { plan: event.data.plan }),
        },
      };
    case 'error':
      return appendBlock(state, {
        id: state.nextBlockId,
        kind: 'text',
        content: event.data.message,
        isError: true,
      });
    case 'step_begin':
      return { ...state, status: { ...state.status, currentNode: event.data.node } };
    case 'step_end':
      return { ...state, status: { ...state.status, currentNode: null } };
    case 'interrupt':
    case 'update':
      return state;
  }
}

function appendText(state: TuiState, text: string, streaming: boolean): TuiState {
  const last = state.turns.at(-1)?.blocks.at(-1);
  if (streaming && last?.kind === 'text' && last.streaming) {
    const content = text.startsWith(last.content) ? text : `${last.content}${text}`;
    return updateLastBlock(state, { ...last, content });
  }
  return appendBlock(state, { id: state.nextBlockId, kind: 'text', content: text, streaming });
}

function upsertTool(
  state: TuiState,
  callId: string,
  name: string,
  status: 'queued' | 'running',
  summary: string,
): TuiState {
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === callId,
  );
  if (existing?.kind === 'tool_card')
    return replaceBlockById(state, existing.id, { ...existing, status, summary });
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'tool_card',
    callId,
    name,
    args: {},
    status,
    summary,
    preview: getToolPreview(name, {}),
    detail: getToolDetail(name, {}),
  });
}

function updateTool(
  state: TuiState,
  callId: string,
  status: Extract<OutputBlock, { kind: 'tool_card' }>['status'],
  summary: string,
): TuiState {
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === callId,
  );
  return existing?.kind === 'tool_card'
    ? replaceBlockById(state, existing.id, { ...existing, status, summary })
    : upsertTool(state, callId, 'tool', status === 'queued' ? 'queued' : 'running', summary);
}

function updateToolProgress(state: TuiState, progress: Protocol.ToolProgressPayload): TuiState {
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === progress.call_id,
  );
  if (existing?.kind !== 'tool_card' || existing.status !== 'running') return state;
  const combined =
    existing.liveOutput === undefined
      ? progress.chunk
      : `${existing.liveOutput}\n${progress.chunk}`;
  const lines = combined.split('\n');
  return replaceBlockById(state, existing.id, {
    ...existing,
    liveOutput: lines.length > 5 ? lines.slice(-5).join('\n') : combined,
    liveTotalLines:
      (existing.liveTotalLines ?? 0) + (progress.line_count ?? progress.chunk.split('\n').length),
  });
}
