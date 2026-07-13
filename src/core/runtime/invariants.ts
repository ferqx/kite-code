// ── Runtime 状态不变量 / Runtime state invariants ──

import type { RuntimeState, ToolCallStatus } from './state';

const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

export class RuntimeInvariantError extends Error {
  readonly code = 'RUNTIME_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeInvariantError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuntimeInvariantError(message);
}

function assertUnique(values: string[], label: string): void {
  assert(new Set(values).size === values.length, `${label} contains duplicate tool ids.`);
}

function interactionToolId(state: RuntimeState): string | undefined {
  const interaction = state.interactions;
  return interaction.kind === 'idle' ? undefined : interaction.toolCallId;
}

/**
 * Validate the complete persisted RuntimeState before it is committed.
 * This is intentionally strict at the Kernel boundary and reusable by fuzz tests.
 */
export function assertRuntimeStateInvariants(state: RuntimeState): void {
  assert(
    state.revision >= 0 && Number.isInteger(state.revision),
    'revision must be a non-negative integer.',
  );
  assertUnique(state.appliedEventIds, 'applied event ids');
  if (state.lastAppliedEventId) {
    assert(
      state.appliedEventIds.includes(state.lastAppliedEventId),
      'lastAppliedEventId must be present in appliedEventIds.',
    );
  }
  assert(state.recoveryState.kind === 'normal', 'recovery state must be normal before execution.');
  assertUnique(state.tools.queue, 'tool queue');
  assertUnique(state.tools.active, 'active tools');

  const activeIds = new Set(state.tools.active);
  for (const toolCallId of state.tools.queue) {
    assert(!activeIds.has(toolCallId), `tool ${toolCallId} cannot be queued and active.`);
  }

  for (const toolCallId of [...state.tools.queue, ...state.tools.active]) {
    const call = state.tools.calls[toolCallId];
    assert(call != null, `tool ${toolCallId} is referenced but has no call record.`);
    assert(
      !TERMINAL_TOOL_STATUSES.has(call.status),
      `terminal tool ${toolCallId} remains scheduled.`,
    );
  }

  const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
  const activeTaskIds = Object.values(state.tasks)
    .filter((task) => task.status === 'active')
    .map((task) => task.taskId);
  assert(activeTaskIds.length <= 1, 'runtime may contain only one active task.');
  assert(
    state.activeTaskId == null
      ? activeTaskIds.length === 0
      : activeTaskIds[0] === state.activeTaskId,
    'activeTaskId must identify the unique active task.',
  );
  if (state.activeTaskId) {
    assert(activeTask != null, `active task ${state.activeTaskId} does not exist.`);
    assert(activeTask.status === 'active', `active task ${state.activeTaskId} is not active.`);
    assert(
      JSON.stringify(activeTask.planning) === JSON.stringify(state.planning),
      `planning mirror is out of sync for task ${state.activeTaskId}.`,
    );
  }

  const interactionTool = interactionToolId(state);
  if (interactionTool) {
    const call = state.tools.calls[interactionTool];
    assert(call != null, `interaction references missing tool ${interactionTool}.`);
    assert(
      !TERMINAL_TOOL_STATUSES.has(call.status),
      `interaction references terminal tool ${interactionTool}.`,
    );
  }

  if (state.interactions.kind === 'awaiting_user_input') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_user_input',
      'user input interaction must reference an awaiting_user_input tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_review') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_review',
      'plan review interaction must reference an awaiting_review tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_tool_approval') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_approval',
      'tool approval interaction must reference an awaiting_approval tool.',
    );
  }
  if (state.interactions.kind === 'awaiting_auto_review') {
    assert(
      state.tools.calls[state.interactions.toolCallId]?.status === 'awaiting_auto_review',
      'auto review interaction must reference an awaiting_auto_review tool.',
    );
  }
}
