import { describe, expect, test } from 'bun:test';
import { classifyToolOutcome } from '@kite/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import { classifyFailure, type FailureKind } from '#app/bootstrap/runtime/failures';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

const kinds: FailureKind[] = [
  'model_invalid_tool_args',
  'model_refused',
  'model_timeout',
  'model_rate_limited',
  'model_server_error',
  'policy_denied',
  'phase_deferred',
  'phase_denied',
  'approval_rejected',
  'auto_review_rejected',
  'plan_revision_requested',
  'tool_runtime_error',
  'tool_timeout',
  'tool_invalid_args',
  'tool_not_found',
  'provider_auth_required',
  'provider_approval_required',
  'provider_unavailable',
  'provider_capability_changed',
  'user_input_cancelled',
  'user_input_timeout',
  'sandbox_error',
  'checkpoint_restore_error',
  'transcript_invariant_error',
  'loop_exhausted',
  'budget_exceeded',
  'artifact_invalid',
  'profile_invalid',
  'digest_invalid',
  'workspace_untrusted',
  'network_unavailable',
  'worktree_unavailable',
  'model_retry_exhausted',
  'mcp_unavailable',
  'persistence_unavailable',
  'resource_saturated',
  'process_limit_exceeded',
  'cancel_incomplete',
  'compaction_unqualified',
  'compaction_failed',
  'verification_failed',
  'verification_inconclusive',
  'mandatory_policy_unavailable',
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

  test('treats a phase deferral as model-fixable without requiring user input', () => {
    expect(classifyFailure('phase_deferred', 'wait for building')).toMatchObject({
      retryable: false,
      modelFixable: true,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    });
  });

  test('treats a hard phase denial as model-fixable without offering approval', () => {
    expect(classifyFailure('phase_denied', 'planning is read-only')).toMatchObject({
      retryable: false,
      modelFixable: true,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    });
  });

  test('persists structured metadata on the failed tool record', () => {
    const queued = reduceRuntimeState(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'failure',
        userId: 'u',
        workspace: '/',
      }),
      { type: 'tool.queued', toolCallId: 'call', name: 'read_file', args: {} },
    );
    const failure = classifyFailure('tool_runtime_error', 'disk unavailable');
    const state = reduceRuntimeState(queued, {
      type: 'tool.failed',
      toolCallId: 'call',
      failure,
      outcome: classifyToolOutcome({
        status: 'failed',
        failure,
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        toolAdvice: { disposition: 'never', maximumAdditionalCalls: 0 },
      }),
    });
    expect(state.tools.calls.call?.failure).toEqual(failure);
    expect(state.transcript.messages.at(-1)).toMatchObject({
      kind: 'tool',
      toolCallId: 'call',
      name: 'read_file',
      ok: false,
    });
    expect(JSON.parse(String(state.transcript.messages.at(-1)?.content))).toMatchObject({
      ok: false,
      error: {
        kind: 'tool_runtime_error',
        message: 'disk unavailable',
        retryable: false,
        model_fixable: false,
        recovery_disposition: 'never',
        maximum_additional_calls: 0,
      },
    });
    const replayed = reduceRuntimeState(state, {
      type: 'tool.failed',
      toolCallId: 'call',
      failure,
      outcome: state.tools.calls.call!.outcome!,
    });
    expect(replayed.transcript.messages).toHaveLength(state.transcript.messages.length);
  });
});
