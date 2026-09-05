import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { assertAgentStateInvariants } from '@kite-ai/agent-kernel';
import type { RuntimeState } from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createMockModel } from '../../helpers/mock-model';
import { createTestRuntimeEffectExecutor } from '../../helpers/runtime-model';

const OCCURRED_AT = '2026-08-25T00:00:00.000Z';
const RECOVERY_KEY = '0'.repeat(64);

function initial(): RuntimeState {
  return createRuntimeHostStateInitialState({
    threadId: 'auto-review-parent-lifecycle',
    userId: 'test-user',
    workspace: '/tmp/auto-review-parent-lifecycle',
    recoveryIdentityKey: RECOVERY_KEY,
    interactionMode: 'auto',
  });
}

function approvalEvent(result: 'approve' | 'escalate' | 'reject') {
  return {
    type: 'auto_review.completed' as const,
    reviewId: 'review-parent-1',
    toolCallId: 'task-parent-1',
    owner: {
      kind: 'subagent_tool' as const,
      toolCallId: 'child-tool-1',
      subagentId: 'child-1',
      parentToolCallId: 'task-parent-1',
    },
    result:
      result === 'approve'
        ? {
            ok: true as const,
            approved: true as const,
            grant: 'approve_once' as const,
            reason: 'safe',
            reviewerModelName: 'fixture',
            durationMs: 1,
          }
        : result === 'escalate'
          ? {
              ok: false as const,
              approved: false as const,
              escalatedToUser: true as const,
              failureType: 'invalid_response' as const,
              reason: 'reviewer response is not canonical',
              reviewerModelName: 'fixture',
              durationMs: 1,
            }
          : {
              ok: true as const,
              approved: false as const,
              reason: 'reviewer rejected the child operation',
              reviewerModelName: 'fixture',
              durationMs: 1,
            },
  } satisfies RuntimeEvent;
}

function suspendedParentState(): RuntimeState {
  let state = initial();
  const events: RuntimeEvent[] = [
    {
      type: 'tool.queued',
      toolCallId: 'task-parent-1',
      name: 'task',
      args: { taskArtifact: { kind: 'subagent_task_request' } },
    },
    {
      type: 'capability.invocation_recorded',
      invocationId: 'parent-invocation-1',
      toolCallId: 'task-parent-1',
      capabilityId: 'builtin:task',
      capabilityRevision: 'task-v1',
      argumentsDigest: 'args',
      authorizationDigest: 'auth',
      admissionDigest: 'admission',
      effectiveEffectsDigest: 'effects',
      effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'write' },
      receiptRequirement: 'control_receipt',
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.execution_started',
      invocationId: 'parent-invocation-1',
      startedAt: OCCURRED_AT,
      attempt: 1,
    },
    { type: 'tool.started', toolCallId: 'task-parent-1', createdAt: OCCURRED_AT },
    {
      type: 'auto_review.requested',
      reviewId: 'review-parent-1',
      toolCallId: 'task-parent-1',
      owner: {
        kind: 'subagent_tool',
        toolCallId: 'child-tool-1',
        subagentId: 'child-1',
        parentToolCallId: 'task-parent-1',
      },
      toolName: 'shell_execute',
      reason: 'child requires review',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      parentToolCallId: 'task-parent-1',
      childSubagentId: 'child-1',
      runtimeToolCallId: 'child-tool-1',
      queueGeneration: 0,
      queueSequence: 0,
      approval: {
        scope: 'once',
        cwd: '/tmp/auto-review-parent-lifecycle',
        threadId: 'auto-review-parent-lifecycle',
        tool: 'shell_execute',
        command: 'write outside workspace',
        risk: 'write_file',
        approvalHash: 'approval-hash',
        summary: 'child write',
        reason: 'child requires review',
        expectedEffects: ['filesystem:write'],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
        subagentId: 'child-1',
      },
    },
  ];
  for (const event of events) {
    state = reduceRuntimeState(state, event);
    assertAgentStateInvariants(state);
  }
  return state;
}

describe('auto-review parent lifecycle', () => {
  test('review completion never terminalizes a suspended parent before child receipt', () => {
    const state = suspendedParentState();
    expect(state.tools.calls['task-parent-1']?.status).toBe('awaiting_auto_review');
    expect(state.capabilities.invocations['parent-invocation-1']?.status).toBe('running');

    const approved = reduceRuntimeState(state, approvalEvent('approve'));
    assertAgentStateInvariants(approved);
    expect(approved.tools.calls['task-parent-1']?.status).toBe('authorized_queued');
    expect(approved.capabilities.invocations['parent-invocation-1']?.status).toBe('running');

    const resumed = reduceRuntimeState(approved, {
      type: 'tool.started',
      toolCallId: 'task-parent-1',
      createdAt: OCCURRED_AT,
    });
    assertAgentStateInvariants(resumed);
    expect(resumed.tools.calls['task-parent-1']?.status).toBe('running');
    expect(resumed.capabilities.invocations['parent-invocation-1']?.status).toBe('running');
  });

  test('a failed reviewer result escalates without terminalizing a parent with a running capability', () => {
    const state = suspendedParentState();
    const rejected = runtimeHostStateNormalizeToolOutcomeEvent(
      approvalEvent('escalate'),
      state,
      OCCURRED_AT,
    );
    const after = reduceRuntimeState(state, rejected);
    assertAgentStateInvariants(after);
    expect(after.tools.calls['task-parent-1']?.status).not.toBe('rejected');
    expect(after.capabilities.invocations['parent-invocation-1']?.status).toBe('running');
    expect(after.pendingApprovals.get('review-parent-1')?.status).toBe('awaiting_user');
  });

  test('a stale reviewer completion is a no-op after the queue generation changes', () => {
    const state = suspendedParentState();
    const next = reduceRuntimeState(state, {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason: 'cancelled',
      cause: 'user',
    });
    expect(next.approvalGeneration).toBeGreaterThan(state.approvalGeneration);
    expect(next.pendingApprovals.has('review-parent-1')).toBe(false);
    const late = reduceRuntimeState(next, approvalEvent('approve'));
    expect(late).toEqual(next);
  });

  test('a reviewer rejection settles the suspended parent capability before its Tool terminal', async () => {
    const state = suspendedParentState();
    const executor = createTestRuntimeEffectExecutor({
      config: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        modelName: 'fixture',
        sandbox: { enabled: false },
      },
      model: createMockModel([]),
    });

    const events = await executor(
      { type: 'run_auto_review', reviewId: 'review-parent-1', toolCallId: 'task-parent-1' },
      state,
    );
    expect(events.map((event) => event.type)).toEqual([
      'capability.reconciliation_resolved',
      'auto_review.completed',
    ]);

    let after = state;
    for (const event of events) {
      after = reduceRuntimeState(
        after,
        runtimeHostStateNormalizeToolOutcomeEvent(event, after, OCCURRED_AT),
      );
    }
    assertAgentStateInvariants(after);
    expect(after.capabilities.invocations['parent-invocation-1']?.status).toBe('failed');
    expect(after.tools.calls['task-parent-1']?.status).toBe('rejected');
  });
});
