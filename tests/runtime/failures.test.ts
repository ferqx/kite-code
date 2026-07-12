import { describe, expect, test } from 'bun:test';
import { classifyFailure, type FailureKind } from '@/core/runtime/failures';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';

const kinds: FailureKind[] = [
  'model_invalid_tool_args',
  'model_refused',
  'model_timeout',
  'model_rate_limited',
  'model_server_error',
  'policy_denied',
  'approval_rejected',
  'auto_review_rejected',
  'plan_revision_requested',
  'tool_runtime_error',
  'tool_timeout',
  'tool_invalid_args',
  'tool_not_found',
  'user_input_cancelled',
  'user_input_timeout',
  'sandbox_error',
  'checkpoint_restore_error',
  'transcript_invariant_error',
  'loop_exhausted',
  'budget_exceeded',
  'unknown',
];

describe('failure classification', () => {
  test('assigns a complete strategy to every registered kind', () => {
    for (const kind of kinds) {
      const failure = classifyFailure(kind, 'test');
      expect(failure.kind).toBe(kind);
      expect(typeof failure.retryable).toBe('boolean');
      expect(typeof failure.terminatesTurn).toBe('boolean');
    }
  });

  test('keeps repairable tool errors retryable and model-fixable', () => {
    expect(classifyFailure('tool_runtime_error', 'broken')).toMatchObject({
      retryable: true,
      modelFixable: true,
      journal: true,
    });
  });

  test('persists structured metadata on the failed tool record', () => {
    const queued = reduceRuntimeState(
      createInitialRuntimeState({ threadId: 'failure', userId: 'u', workspace: '/' }),
      { type: 'tool.queued', toolCallId: 'call', name: 'read_file', args: {} },
    );
    const failure = classifyFailure('tool_runtime_error', 'disk unavailable');
    const state = reduceRuntimeState(queued, { type: 'tool.failed', toolCallId: 'call', failure });
    expect(state.tools.calls.call?.failure).toEqual(failure);
  });
});
