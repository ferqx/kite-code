import { expect, test } from 'bun:test';
import { childThreadIdForToolAttempt, createInitialAgentState } from '@kite-ai/agent-kernel';
import type { SubagentResultArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import type { RuntimeState } from '../../src/bootstrap/runtime/state-runtime';
import { settleAcceptedChildCreationFailure } from '../../src/bootstrap/runtime/subagent/child-creation-failure';

const parentSessionId = 'parent';
const parentInvocationId = 'invocation';
const originToolCallId = 'tool';
const childInvocationId = 'child-task';
const childThreadId = childThreadIdForToolAttempt({
  parentSessionId,
  parentInvocationId,
  parentToolCallId: originToolCallId,
  attempt: 1,
});
const digest = `sha256:${'a'.repeat(64)}`;
const ref = {
  artifactId: 'result',
  kind: 'subagent_task' as const,
  integrityIdentifier: digest,
  byteLength: 100,
};

function fixture(created: boolean, activated = false, releasedAfterCancel = false) {
  const base = createInitialAgentState({
    threadId: parentSessionId,
    userId: 'user',
    workspace: '/workspace',
    turnId: 'parent-turn',
    recoveryIdentityKey: '1'.repeat(64),
  });
  const intent = {
    parentSessionId,
    parentInvocationId,
    originRunId: 'parent-run',
    originTurnId: 'parent-turn',
    originToolCallId,
    attempt: 1,
    childInvocationId,
    childThreadId,
    disposition: 'required',
    fundingRunId: 'parent-run',
    delegatedReservationId: 'delegated',
    childSessionCreated: created,
    failureReceiptDigest: null,
    parentClaimSettledEventId: null,
    childBudgetActivatedRunId: activated ? 'child-run' : null,
    childBudgetActivatedEventId: activated ? 'activation-event' : null,
    dispatchAckEventId: null,
  };
  const parentState = {
    ...base,
    capabilities: {
      ...base.capabilities,
      invocations: {
        [parentInvocationId]: {
          subagentProviderLifecycle: {
            attempt: 1,
            childInvocationId,
            childSession: {
              childThreadId,
              originRunId: 'parent-run',
              originTurnId: 'parent-turn',
              originToolCallId,
              delegatedReservationId: 'delegated',
            },
          },
        },
      },
    },
    tools: {
      ...base.tools,
      calls: {
        [originToolCallId]: {
          result: { resultMeta: { taskId: childInvocationId, taskStatus: 'running' } },
        },
      },
    },
    retainedResourceBudgets: {
      'parent-run': {
        reservations: { delegated: { state: releasedAfterCancel ? 'released' : 'reserved' } },
      },
    },
    ...(releasedAfterCancel
      ? { turn: { turnId: 'parent-run', turnIndex: 1, status: 'aborted', abortCause: 'user' } }
      : {}),
  } as unknown as RuntimeState;
  let written = 0;
  const result = {
    ok: false,
    terminalStatus: releasedAfterCancel ? 'cancelled' : 'failed',
    ...(releasedAfterCancel ? {} : { error: 'child_creation_failed' }),
    summary: releasedAfterCancel
      ? 'Child Session was cancelled before dispatch.'
      : 'Child Session could not be started.',
    toolCallCount: 0,
    durationMs: 0,
  };
  let stored = false;
  const artifacts: SubagentResultArtifactAccess = {
    write: ({ ownerKey, taskId, result: actual }) => {
      expect(ownerKey).toBe('owner');
      expect(taskId).toBe(childInvocationId);
      expect(actual).toEqual(result);
      written++;
      stored = true;
      return ref;
    },
    lookup: (ownerKey, taskId) =>
      ownerKey === 'owner' && taskId === childInvocationId && stored ? { ref, result } : undefined,
    read: (candidate, taskId) => {
      expect(candidate).toEqual(ref);
      expect(taskId).toBe(childInvocationId);
      return result;
    },
    list: () => [],
  };
  const proof = created
    ? { childRevision: activated ? 5 : 0, ownerStatus: 'idle' as const, cleanupConfirmed: true }
    : null;
  const call = (overrides: Record<string, unknown> = {}) =>
    settleAcceptedChildCreationFailure({
      parentState,
      childThreadId,
      parentOwnerKey: 'owner',
      readIntent: () => ({ ...intent, ...overrides }) as never,
      readPreDispatchChildProof: () => proof,
      artifacts,
      ...(releasedAfterCancel
        ? {
            cancelled: true,
            alreadyReleasedAfterParentCancel: true,
            hasCancelledParentRunProof: () => true,
          }
        : {}),
      commitFailure: (receipt) => {
        expect(receipt.readFailureArtifact(ref, childInvocationId)).toEqual(result);
        expect(receipt.failureEvent.type).toBe(
          releasedAfterCancel
            ? 'subagent.child_pre_dispatch_cancelled'
            : 'subagent.child_creation_failed',
        );
        expect(
          receipt.failureEvent.type === 'subagent.child_creation_failed'
            ? receipt.failureEvent.failureReceiptDigest
            : receipt.failureEvent.terminalReceiptDigest,
        ).toBe(digest);
        expect(receipt.resultEvent.notificationId).toBe(`subagent:${childInvocationId}:${digest}`);
        expect(receipt.resultEvent.originRunId).toBe('parent-run');
        if (releasedAfterCancel) {
          expect(receipt.releaseEvent).toBeUndefined();
          return [receipt.failureEvent, receipt.resultEvent];
        }
        if (!receipt.releaseEvent) throw new Error('Expected an unconsumed reservation.');
        expect(receipt.releaseEvent.reservationId).toBe('delegated');
        return [receipt.releaseEvent, receipt.failureEvent, receipt.resultEvent];
      },
    });
  return { call, parentState, getWritten: () => written };
}

test('user-cancelled, already released revision-zero child settles without a second release', () => {
  const f = fixture(true, false, true);
  Object.assign(f.parentState, { turn: { turnId: 'new-run', status: 'active' } });
  expect(f.call().map((event) => event.type)).toEqual([
    'subagent.child_pre_dispatch_cancelled',
    'subagent.background_result_persisted',
  ]);
  Object.assign(f.parentState.retainedResourceBudgets['parent-run']!.reservations.delegated!, {
    state: 'reserved',
  });
  expect(() => f.call()).toThrow('exact parent claim');
});

test.each([false, true])('failure receipt selects the Store CAS mode for created=%p', (created) => {
  const f = fixture(created);
  const events = f.call();
  expect(events.map((event) => event.type)).toEqual([
    'resource_budget.released',
    'subagent.child_creation_failed',
    'subagent.background_result_persisted',
  ]);
  expect(events[1]).toMatchObject({ mode: created ? 'created_unactivated' : 'absent_child' });
  expect(f.getWritten()).toBe(1);
});

test('activated child with no dispatch ACK uses the exact activation-abandonment mode', () => {
  const f = fixture(true, true);
  const events = f.call();
  expect(events[1]).toMatchObject({ mode: 'activated_no_ack' });
  expect(f.getWritten()).toBe(1);
});

test('inconsistent activation or acknowledged intent is rejected before writing a failure result', () => {
  const f = fixture(false);
  expect(() => f.call({ childBudgetActivatedRunId: 'child-run' })).toThrow(
    'safely absent or abandoned',
  );
  expect(() => f.call({ dispatchAckEventId: 'event-1' })).toThrow('pre-dispatch intent');
  expect(f.getWritten()).toBe(0);
});

test('uncertain presence conflicts with the accepted intent before writing', () => {
  const f = fixture(true);
  expect(() => f.call({ childSessionCreated: false })).toThrow('safely absent or abandoned');
  expect(f.getWritten()).toBe(0);
});
