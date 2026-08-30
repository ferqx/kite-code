import {
  WEB_MAX_MESSAGE_BLOCKS,
  WEB_STREAM_EVENT_SCHEMA_,
  type WebPresentationBlock,
  type WebPresentationMessage,
  type WebSessionStatus,
} from '@kite-ai/kite-app-contract';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';

/**
 * The only state used by the Web Observer presentation path.  It is a pure
 * display fold: it contains no Runtime authority, Store handle, transport,
 * or interaction capability.
 */
export interface WebPresentationState {
  readonly messages: readonly WebPresentationMessage[];
  readonly lastSequence: number | null;
  /** Internal presentation-only binding; never crosses the Browser contract. */
  readonly toolMessageIds: Readonly<Record<string, string>>;
  readonly presentationGroupMessageIds: Readonly<Record<string, string>>;
}

export interface WebPresentationEventInput {
  readonly sequence: number;
  readonly event: RuntimeClientEvent;
  readonly presentationMessageId?: string;
}

export type WebPresentationReduceResult =
  | {
      readonly status: 'applied';
      readonly state: WebPresentationState;
      readonly message?: WebPresentationMessage;
    }
  | { readonly status: 'ignored'; readonly state: WebPresentationState }
  | {
      readonly status: 'resync_required';
      readonly state: WebPresentationState;
      readonly reason: 'sequence_gap';
      readonly afterSequence?: number;
    };

/** A fresh fold state. `lastSequence` seeds a live stream's exclusive cursor. */
export function createWebPresentationReducerState(
  lastSequence: number | null = null,
): WebPresentationState {
  return { messages: [], lastSequence, toolMessageIds: {}, presentationGroupMessageIds: {} };
}

/**
 * Project one already-safe RuntimeClientEvent into one browser presentation
 * message.  Runtime events not useful to a read-only transcript are omitted;
 * no unknown event/object is forwarded to the browser.
 */
export function projectWebPresentationMessage(
  input: WebPresentationEventInput,
): WebPresentationMessage | undefined {
  const { event, sequence } = input;
  const boundMessageId = input.presentationMessageId;
  if (!isSafeSequence(sequence)) return undefined;

  switch (event.type) {
    case 'user.message':
      return event.text.length === 0
        ? undefined
        : message(event.messageId, sequence, 'user', [
            {
              kind: 'text',
              text: displayText(event.text),
            },
          ]);
    case 'model.requested':
      return statusMessage(
        boundMessageId ?? messageId('model', event.requestId, sequence),
        sequence,
        'running',
      );
    case 'reasoning.activity':
      return event.text.length === 0
        ? undefined
        : message(
            boundMessageId ?? messageId('model', event.requestId, sequence),
            sequence,
            'assistant',
            [
              {
                kind: 'thinking',
                text: displayText(event.text),
                complete: event.state === 'completed',
              },
            ],
          );
    case 'model.text_delta':
      return event.text.length === 0
        ? undefined
        : message(
            boundMessageId ?? messageId('model', event.requestId, sequence),
            sequence,
            'assistant',
            [{ kind: 'text', text: displayText(event.text) }],
          );
    case 'model.responded':
      return event.summary && event.summary.length > 0
        ? message(
            boundMessageId ?? messageId('model', event.requestId, sequence),
            sequence,
            'assistant',
            [{ kind: 'text', text: displayText(event.summary) }],
          )
        : statusMessage(
            boundMessageId ?? messageId('model', event.requestId, sequence),
            sequence,
            'completed',
          );
    case 'model.retry':
      return statusMessage(
        boundMessageId ?? messageId('model', event.requestId, sequence),
        sequence,
        'running',
      );
    case 'model.cache':
      return undefined;
    case 'tool.queued':
      return toolActivityMessage(
        event.toolId,
        sequence,
        toolLabel(event.displayLabel, event.toolName),
        'queued',
        event.summary,
        boundMessageId,
      );
    case 'tool.started':
      return toolActivityMessage(
        event.toolId,
        sequence,
        'Tool',
        'running',
        event.summary,
        boundMessageId,
      );
    case 'tool.progress':
      return toolActivityMessage(
        event.toolId,
        sequence,
        'Tool',
        'running',
        event.summary,
        boundMessageId,
      );
    case 'tool.finished':
      return message(
        boundMessageId ?? messageId('tool', event.toolId, sequence),
        sequence,
        'assistant',
        [toolResultBlock(event)],
      );
    case 'tool.failed':
      return toolErrorMessage(event.toolId, sequence, 'tool_failed', boundMessageId);
    case 'tool.rejected':
      return toolErrorMessage(event.toolId, sequence, 'tool_rejected', boundMessageId);
    case 'tool.cancelled':
      return toolErrorMessage(event.toolId, sequence, 'tool_cancelled', boundMessageId);
    case 'tool.file_changed':
      return statusMessage(messageId('tool', event.toolId, sequence), sequence, 'running');
    case 'interaction.available':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'waiting');
    case 'interaction.settled':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'completed');
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      // The Web surface may show that a session is waiting, but it carries no
      // approval/input/plan payload and exposes no reply capability.
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'waiting');
    case 'approval.granted':
    case 'approval.rejected':
    case 'input.answered':
    case 'input.cancelled':
    case 'plan.approved':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'completed');
    case 'plan.progress':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.status === 'in_progress' || event.status === 'pending' ? 'running' : 'completed',
      );
    case 'plan.completed':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'completed');
    case 'planning.entered':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'running');
    case 'planning.exited':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'idle');
    case 'interaction_mode.changed':
      return undefined;
    case 'provider.action':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.status === 'required' || event.status === 'started'
          ? 'waiting'
          : event.status === 'failed'
            ? 'failed'
            : 'completed',
      );
    case 'verification.status':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.status === 'pending'
          ? 'waiting'
          : event.status === 'running'
            ? 'running'
            : event.status === 'failed'
              ? 'failed'
              : 'completed',
      );
    case 'subagent.started':
      return statusMessage(messageId('subagent', event.subagentId, sequence), sequence, 'running');
    case 'subagent.step':
      return statusMessage(messageId('subagent', event.subagentId, sequence), sequence, 'running');
    case 'subagent.completed':
      return statusMessage(
        messageId('subagent', event.subagentId, sequence),
        sequence,
        'completed',
      );
    case 'subagent.failed':
      return statusMessage(messageId('subagent', event.subagentId, sequence), sequence, 'failed');
    case 'context.compaction':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.status === 'failed'
          ? 'failed'
          : event.status === 'completed' || event.status === 'reset'
            ? 'completed'
            : 'running',
      );
    case 'task.terminal':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        terminalStatus(event.status),
      );
    case 'turn.terminal':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        terminalStatus(event.status),
      );
    case 'run.terminal':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        terminalStatus(event.status),
      );
    case 'run.failure':
      return statusMessage(genericMessageId(event.type, sequence), sequence, 'failed');
    case 'rewind.terminal':
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.status === 'completed' ? 'completed' : 'failed',
      );
    case 'session.notice':
      if (event.code === 'history_gap')
        return errorMessage(genericMessageId(event.type, sequence), sequence, 'history_gap');
      return statusMessage(
        genericMessageId(event.type, sequence),
        sequence,
        event.code === 'session_closed' ? 'completed' : 'running',
      );
    case 'unavailable':
      return errorMessage(genericMessageId(event.type, sequence), sequence, 'runtime_unavailable');
    default:
      return undefined;
  }
}

/**
 * The single fold used by both current-format History replay and live
 * subscription delivery.  A duplicate is idempotently ignored; a forward
 * sequence gap is rejected so callers can perform a fresh History resync.
 */
export function reduceWebPresentationEvent(
  state: WebPresentationState,
  input: WebPresentationEventInput,
): WebPresentationReduceResult {
  return reduceWebPresentationSequence(state, input.sequence, [input.event]);
}

/** Fold every projection emitted by one durable source record atomically. */
export function reduceWebPresentationSequence(
  state: WebPresentationState,
  sequence: number,
  events: readonly RuntimeClientEvent[],
): WebPresentationReduceResult {
  if (!isSafeSequence(sequence)) {
    return {
      status: 'resync_required',
      state,
      reason: 'sequence_gap',
      ...(state.lastSequence === null ? {} : { afterSequence: state.lastSequence }),
    };
  }
  if (state.lastSequence !== null && sequence <= state.lastSequence) {
    return { status: 'ignored', state };
  }
  if (state.lastSequence !== null && sequence - state.lastSequence > 1) {
    return {
      status: 'resync_required',
      state,
      reason: 'sequence_gap',
      afterSequence: state.lastSequence,
    };
  }

  let messages = state.messages;
  const toolMessageIds = { ...state.toolMessageIds };
  const presentationGroupMessageIds = { ...state.presentationGroupMessageIds };
  let projected: WebPresentationMessage | undefined;
  for (const event of events) {
    let presentationMessageId: string | undefined;
    if (event.type === 'tool.queued') {
      presentationMessageId = event.presentationGroupId
        ? (presentationGroupMessageIds[event.presentationGroupId] ??
          messageId('model', event.presentationGroupId, sequence))
        : messageId('tool', event.toolId, sequence);
      toolMessageIds[event.toolId] = presentationMessageId;
    } else if (event.type.startsWith('tool.') && 'toolId' in event) {
      presentationMessageId = toolMessageIds[event.toolId];
    } else if (event.type === 'model.responded') {
      presentationMessageId = messageId('model', event.requestId, sequence);
      presentationGroupMessageIds[event.messageId] = presentationMessageId;
    }
    const next = projectWebPresentationMessage({
      sequence,
      event,
      ...(presentationMessageId === undefined ? {} : { presentationMessageId }),
    });
    if (next === undefined) continue;
    messages = upsertMessage(messages, next);
    projected = findMessage(messages, next.messageId);
    if (
      event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled'
    ) {
      delete toolMessageIds[event.toolId];
    }
  }
  const nextState: WebPresentationState = {
    messages,
    lastSequence: sequence,
    toolMessageIds,
    presentationGroupMessageIds,
  };
  return {
    status: 'applied',
    state: nextState,
    ...(projected === undefined
      ? {}
      : { message: findMessage(nextState.messages, projected.messageId) }),
  };
}

/** Fold a known-contiguous History transcript through the same pure reducer. */
export function reduceWebPresentationEvents(
  state: WebPresentationState,
  inputs: readonly WebPresentationEventInput[],
): WebPresentationState {
  let current = state;
  for (const input of inputs) {
    const result = reduceWebPresentationEvent(current, input);
    if (result.status === 'resync_required') break;
    current = result.state;
  }
  return current;
}

function message(
  messageIdValue: string,
  sequence: number,
  role: WebPresentationMessage['role'],
  blocks: readonly WebPresentationBlock[],
): WebPresentationMessage {
  return {
    messageId: messageIdValue,
    sequence,
    role,
    blocks: blocks.slice(0, WEB_MAX_MESSAGE_BLOCKS),
  };
}

function statusMessage(
  messageIdValue: string,
  sequence: number,
  status: WebSessionStatus,
): WebPresentationMessage {
  return message(messageIdValue, sequence, 'system', [{ kind: 'status', status }]);
}

function errorMessage(
  messageIdValue: string,
  sequence: number,
  code: string,
): WebPresentationMessage {
  return message(messageIdValue, sequence, 'system', [
    { kind: 'error', code: identifier(code, 'error'), text: 'Session content is unavailable.' },
  ]);
}

function toolErrorMessage(
  toolId: string,
  sequence: number,
  code: string,
  boundMessageId?: string,
): WebPresentationMessage {
  return errorMessage(boundMessageId ?? messageId('tool', toolId, sequence), sequence, code);
}

function toolActivityMessage(
  toolId: string,
  sequence: number,
  label: string,
  activityStatus: 'queued' | 'running',
  summary?: string,
  boundMessageId?: string,
): WebPresentationMessage {
  return message(boundMessageId ?? messageId('tool', toolId, sequence), sequence, 'assistant', [
    {
      kind: 'tool_activity',
      toolId: identifier(toolId, 'tool'),
      label,
      status: activityStatus,
      ...(summary && summary.length > 0 ? { summary: displayText(summary, 8_192) } : {}),
    },
  ]);
}

function toolResultBlock(
  event: Extract<RuntimeClientEvent, { readonly type: 'tool.finished' }>,
): WebPresentationBlock {
  const result = event.result as typeof event.result & { readonly exitCode?: number };
  return {
    kind: 'tool_result',
    toolId: identifier(event.toolId, 'tool'),
    label: toolLabel(event.displayLabel, event.toolName),
    ok: result.ok,
    stdout: outputText(result.stdout),
    stderr: outputText(result.stderr),
    ...(typeof result.exitCode === 'number' && Number.isSafeInteger(result.exitCode)
      ? { exitCode: result.exitCode }
      : {}),
  };
}

function upsertMessage(
  messages: readonly WebPresentationMessage[],
  incoming: WebPresentationMessage,
): readonly WebPresentationMessage[] {
  const index = messages.findIndex((entry) => entry.messageId === incoming.messageId);
  if (index < 0) return [...messages, incoming].sort(bySequence);
  const existing = messages[index];
  if (existing === undefined) return [...messages, incoming].sort(bySequence);
  const updated = {
    ...existing,
    sequence: incoming.sequence,
    role: incoming.role,
    blocks: mergeBlocks(existing.blocks, incoming.blocks),
  } satisfies WebPresentationMessage;
  const next = messages.slice();
  next[index] = updated;
  return next.sort(bySequence);
}

function mergeBlocks(
  existing: readonly WebPresentationBlock[],
  incoming: readonly WebPresentationBlock[],
): readonly WebPresentationBlock[] {
  const block = incoming[0];
  if (block === undefined) return existing;
  const next =
    block.kind === 'status'
      ? existing.slice()
      : existing.filter((entry) => entry.kind !== 'status' || entry.status !== 'running');
  if (block.kind === 'tool_result') {
    const index = next.findIndex(
      (entry) =>
        (entry.kind === 'tool_activity' || entry.kind === 'tool_result') &&
        entry.toolId === block.toolId,
    );
    if (index >= 0) next[index] = block;
    else next.push(block);
  } else if (block.kind === 'error') {
    next.push(block);
  } else if (block.kind === 'tool_activity') {
    const index = next.findIndex(
      (entry) => entry.kind === 'tool_activity' && entry.toolId === block.toolId,
    );
    if (index >= 0) {
      const previous = next[index];
      next[index] =
        previous?.kind === 'tool_activity' && block.label === 'Tool'
          ? { ...block, label: previous.label }
          : block;
    } else next.push(block);
  } else if (block.kind === 'thinking') {
    const index = findLastIndex(next, (entry) => entry.kind === 'thinking');
    if (index >= 0) next[index] = block;
    else next.push(block);
  } else if (block.kind === 'text') {
    const index = findLastIndex(next, (entry) => entry.kind === 'text');
    if (index >= 0) next[index] = block;
    else next.push(block);
  } else {
    const index = findLastIndex(next, (entry) => entry.kind === 'status');
    if (index >= 0) next[index] = block;
    else next.push(block);
  }
  return next
    .slice(-WEB_MAX_MESSAGE_BLOCKS)
    .sort((left, right) => blockOrder(left) - blockOrder(right));
}

function blockOrder(block: WebPresentationBlock): number {
  switch (block.kind) {
    case 'thinking':
      return 0;
    case 'tool_activity':
    case 'tool_result':
      return 1;
    case 'text':
      return 2;
    case 'error':
      return 3;
    case 'status':
      return 4;
  }
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}

function findMessage(
  messages: readonly WebPresentationMessage[],
  messageIdValue: string,
): WebPresentationMessage | undefined {
  return messages.find((entry) => entry.messageId === messageIdValue);
}

function bySequence(left: WebPresentationMessage, right: WebPresentationMessage): number {
  return left.sequence - right.sequence || left.messageId.localeCompare(right.messageId);
}

function terminalStatus(
  status: 'completed' | 'cancelled' | 'failed' | 'aborted',
): WebSessionStatus {
  return status === 'completed'
    ? 'completed'
    : status === 'cancelled' || status === 'aborted'
      ? 'cancelled'
      : 'failed';
}

function toolLabel(displayLabel?: string, toolName?: string): string {
  const candidate = displayLabel ?? toolName;
  if (candidate === undefined || candidate.length === 0) return 'Tool';
  const safe = displayText(candidate, 256);
  return safe.length === 0 ? 'Tool' : safe;
}

function messageId(prefix: string, value: string, sequence: number): string {
  return identifier(`${prefix}-${value}`, `${prefix}-${sequence}`);
}

function genericMessageId(type: string, sequence: number): string {
  return identifier(`web-${type}-${sequence}`, `web-status-${sequence}`);
}

function identifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 256);
  return normalized.length > 0 && /^[A-Za-z0-9]/u.test(normalized) ? normalized : fallback;
}

function displayText(value: string, maximum = 65_536): string {
  let output = '';
  for (const character of value.slice(0, maximum)) {
    if (/\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t')
      continue;
    output += character;
  }
  return output;
}

function outputText(value: string): string {
  return displayText(value, 65_536);
}

function isSafeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// Keep the imported schema referenced in this module so static inspection can
// see that projected stream events use the same closed contract schema.
export const WEB_OBSERVER_PRESENTATION_SCHEMA_ = WEB_STREAM_EVENT_SCHEMA_;
