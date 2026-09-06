import type { AcceptedPresentationEnvelope, RuntimeClientEvent } from '@kite-ai/runtime-contract';
import type { TuiState } from '../../src/tui/types';

type AcceptedEnvelopeOverrides = Omit<Partial<AcceptedPresentationEnvelope>, 'event'>;

/**
 * Test-only adapter for exercising the same boundary used by the live TUI.
 * Production reducers intentionally accept envelopes only; tests that model a
 * Runtime event directly must make its Session and connection identity
 * explicit here instead of teaching the reducer a second naked-event path.
 */
export function acceptedEnvelope(
  event: RuntimeClientEvent,
  overrides: AcceptedEnvelopeOverrides = {},
): AcceptedPresentationEnvelope {
  const identity =
    event.type === 'run.terminal'
      ? { runId: event.runId }
      : event.type === 'task.terminal'
        ? { taskId: event.taskId }
        : event.type === 'turn.terminal'
          ? { turnId: event.turnId }
          : { runId: 'run-1', taskId: 'task-1', turnId: 'turn-1' };
  return {
    sessionId: 'session-1',
    connectionGeneration: 1,
    durability: 'durable',
    revision: 1,
    ...identity,
    ...overrides,
    event,
  };
}

/** Bind non-terminal fixtures to the reducer authority they are exercising. */
export function acceptedEnvelopeForState(
  event: RuntimeClientEvent,
  state: Pick<TuiState, 'runtimeAuthority'>,
): AcceptedPresentationEnvelope {
  const run = state.runtimeAuthority?.currentRun;
  const taskId = state.runtimeAuthority?.activeTask?.taskId ?? run?.taskId;
  const turnId = run?.activeTurnId ?? run?.initialTurnId;
  return acceptedEnvelope(event, {
    ...(event.type === 'run.terminal' || run?.runId === undefined ? {} : { runId: run.runId }),
    ...(event.type === 'task.terminal' || taskId === undefined ? {} : { taskId }),
    ...(event.type === 'turn.terminal' || turnId === undefined ? {} : { turnId }),
  });
}
