import { describe, expect, test } from 'bun:test';

import {
  type AgentApprovalCommandIdentity,
  type AgentState,
  approvalCommandGrantKey,
  createInitialAgentState,
  type KernelEvent,
  reduceAgentState,
  selectPendingEffects,
} from '../src/index';

/**
 * These tests intentionally describe the durable approval projection rather
 * than the current single-interaction implementation.  Keeping the fixture
 * events on the public KernelEvent boundary makes the missing event/state
 * contract visible without coupling the test to reducer internals.
 */

type JsonRecord = Record<string, any>;

function record(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function approvalProjection(state: AgentState): JsonRecord {
  const root = record(state);
  return {
    pendingApprovals: root.pendingApprovals,
    activeApprovalId: root.activeApprovalId,
    sessionCommandGrants: root.sessionCommandGrants,
  };
}

function initialState(): AgentState {
  return createInitialAgentState({
    threadId: 'session-approval-queue',
    userId: 'user-1',
    workspace: '/workspace/project',
    turnId: 'turn-1',
    recoveryIdentityKey: 'a'.repeat(64),
  });
}

function commandIdentity(
  overrides: Partial<AgentApprovalCommandIdentity> = {},
): AgentApprovalCommandIdentity {
  return {
    sessionId: 'session-approval-queue',
    threadId: 'session-approval-queue',
    workspace: '/workspace/project',
    canonicalWorkspaceIdentity: 'sha256:' + 'a'.repeat(64),
    cwd: '/workspace/project',
    executor: 'shell',
    environment: 'env-digest-1',
    scope: 'workspace',
    effects: 'read-only',
    parserRevision: 'shell-parser-v1',
    commandDigest: 'command-digest-printf-hello',
    ...overrides,
  };
}

function approvalPayload(overrides: JsonRecord = {}): JsonRecord {
  return {
    toolName: 'shell_execute',
    command: 'printf hello',
    summary: 'Print hello',
    reason: 'The shell command needs approval',
    cwd: '/workspace/project',
    scope: 'workspace',
    effects: 'read-only',
    risk: 'read-only',
    grantOptions: ['approve_once', 'same_command'],
    recommendedGrant: 'approve_once',
    commandIdentity: commandIdentity(),
    ...overrides,
  };
}

function toolQueued(toolCallId: string, command = 'printf hello'): KernelEvent {
  return {
    type: 'tool.queued',
    toolCallId,
    name: 'shell_execute',
    args: { command },
    modelMessageId: `message-${toolCallId}`,
    ordinal: 0,
    invocationFingerprint: `fingerprint-${toolCallId}`,
  } as KernelEvent;
}

function approvalRequested(
  interactionId: string,
  toolCallId: string,
  overrides: JsonRecord = {},
): KernelEvent {
  return {
    type: 'approval.requested',
    interactionId,
    toolCallId,
    approval: approvalPayload(overrides),
    commandIdentity: commandIdentity(overrides.commandIdentity ?? {}),
    fullModeBypassEligible: overrides.fullModeBypassEligible === true,
    fullModePolicyBypassAllowed: overrides.fullModePolicyBypassAllowed === true,
    createdAt: '2026-08-25T00:00:00.000Z',
  } as KernelEvent;
}

function reduce(state: AgentState, ...events: KernelEvent[]): AgentState {
  return events.reduce((current, event) => reduceAgentState(current, event), state);
}

function sameCommandBatchEvent(overrides: JsonRecord = {}): KernelEvent {
  const identity = commandIdentity();
  return {
    type: 'approval.batch_released',
    interactionId: 'approval-a',
    toolCallId: 'call-a',
    grant: 'same_command',
    grantKey: approvalCommandGrantKey(identity),
    sessionRevision: 0,
    generation: 0,
    commandIdentity: identity,
    matches: [
      { interactionId: 'approval-a', toolCallId: 'call-a', receiptId: 'receipt-a', generation: 0 },
      { interactionId: 'approval-b', toolCallId: 'call-b', receiptId: 'receipt-b', generation: 0 },
    ],
    cancelledReviewIds: [],
    createdAt: '2026-08-25T00:00:01.000Z',
    ...overrides,
  } as KernelEvent;
}

describe('durable approval queue', () => {
  test('keeps multiple pending approvals FIFO and exposes one explicit focus', () => {
    const state = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b', 'printf world'),
      approvalRequested('approval-b', 'call-b', {
        command: 'printf world',
        commandIdentity: commandIdentity({ commandDigest: 'command-digest-printf-world' }),
      }),
      toolQueued('call-c', 'pwd'),
      approvalRequested('approval-c', 'call-c', {
        command: 'pwd',
        commandIdentity: commandIdentity({ commandDigest: 'command-digest-pwd' }),
      }),
    );

    const projection = approvalProjection(state);
    expect(Array.from(projection.pendingApprovals.keys())).toEqual([
      'approval-a',
      'approval-b',
      'approval-c',
    ]);
    expect(projection.activeApprovalId).toBe('approval-a');
  });

  test('approve_once authorizes exactly one invocation and leaves the next item pending', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b'),
      approvalRequested('approval-b', 'call-b'),
    );

    const state = reduce(queued, {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'call-a',
      grant: 'approve_once',
      receiptId: 'receipt-approve-once-a',
      generation: 0,
      createdAt: '2026-08-25T00:00:02.000Z',
    } as KernelEvent);

    const projection = approvalProjection(state);
    expect(projection.pendingApprovals.get('approval-a').status).toBe('authorized_queued');
    expect(projection.pendingApprovals.get('approval-b').status).toBe('awaiting_user');
    expect(record(state).tools.calls['call-a'].status).toBe('authorized_queued');
    expect(record(state).tools.calls['call-b'].status).toBe('awaiting_approval');
    expect(selectPendingEffects(state)).toContainEqual({
      type: 'run_tools',
      toolCallIds: ['call-a'],
    });
  });

  test('same_command releases one atomic batch and records independent receipts', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b'),
      approvalRequested('approval-b', 'call-b'),
    );

    const state = reduce(queued, sameCommandBatchEvent());
    const projection = approvalProjection(state);
    const grantKey = approvalCommandGrantKey(commandIdentity() as any);

    expect(projection.sessionCommandGrants.get(grantKey)).toMatchObject({
      grant: 'same_command',
      sessionId: 'session-approval-queue',
    });
    expect(projection.pendingApprovals.get('approval-a').status).toBe('authorized_queued');
    expect(projection.pendingApprovals.get('approval-b').status).toBe('authorized_queued');
    expect(projection.pendingApprovals.get('approval-a').receiptId).toBe('receipt-a');
    expect(projection.pendingApprovals.get('approval-b').receiptId).toBe('receipt-b');
  });

  test('same_command matching includes every grant subject and rejects a single-field mismatch', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b'),
      approvalRequested('approval-b', 'call-b', {
        commandIdentity: commandIdentity({ environment: 'env-digest-different' }),
      }),
    );

    const state = reduce(
      queued,
      sameCommandBatchEvent({
        matches: [
          {
            interactionId: 'approval-a',
            toolCallId: 'call-a',
            receiptId: 'receipt-a',
            generation: 0,
          },
        ],
      }),
    );
    const projection = approvalProjection(state);

    expect(projection.pendingApprovals.get('approval-a').status).toBe('authorized_queued');
    expect(projection.pendingApprovals.get('approval-b').status).toBe('awaiting_user');
  });

  test('authorized_queued is schedulable without reopening the approval interaction', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
    );
    const state = reduce(queued, {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'call-a',
      grant: 'approve_once',
      receiptId: 'receipt-a',
      generation: 0,
      createdAt: '2026-08-25T00:00:03.000Z',
    } as KernelEvent);

    expect(record(state).interactions).toMatchObject({ kind: 'idle' });
    expect(record(state).tools.calls['call-a'].status).toBe('authorized_queued');
    expect(selectPendingEffects(state).some((effect: any) => effect.type === 'run_tools')).toBe(
      true,
    );
  });

  test('auto review escalation moves the same queued item to human review', () => {
    const requested = reduce(initialState(), toolQueued('call-auto'), {
      type: 'auto_review.requested',
      reviewId: 'review-auto',
      toolCallId: 'call-auto',
      toolName: 'shell_execute',
      reason: 'auto-review for shell command',
      approval: approvalPayload(),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: true,
      commandIdentity: commandIdentity(),
      createdAt: '2026-08-25T00:00:04.000Z',
    } as KernelEvent);

    const escalated = reduce(requested, {
      type: 'auto_review.completed',
      reviewId: 'review-auto',
      toolCallId: 'call-auto',
      result: {
        ok: true,
        approved: false,
        escalatedToUser: true,
        reviewerModelName: 'reviewer-v1',
        durationMs: 1,
      },
    } as KernelEvent);

    const projection = approvalProjection(escalated);
    expect(projection.pendingApprovals.get('review-auto').route).toBe('user');
    expect(projection.pendingApprovals.get('review-auto').status).toBe('awaiting_user');
  });

  test('technical auto-review failure can explicitly escalate without creating a second pending item', () => {
    const requested = reduce(initialState(), toolQueued('call-auto'), {
      type: 'auto_review.requested',
      reviewId: 'review-failed',
      toolCallId: 'call-auto',
      toolName: 'shell_execute',
      reason: 'technical reviewer failure',
      approval: approvalPayload(),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: true,
      commandIdentity: commandIdentity(),
      createdAt: '2026-08-25T00:00:05.000Z',
    } as KernelEvent);
    const escalated = reduce(requested, {
      type: 'auto_review.completed',
      reviewId: 'review-failed',
      toolCallId: 'call-auto',
      result: {
        ok: false,
        approved: false,
        escalatedToUser: true,
        failureType: 'technical',
        reviewerModelName: 'reviewer-v1',
        durationMs: 1,
      },
    } as KernelEvent);
    const pending = escalated.pendingApprovals.get('review-failed');
    expect(escalated.pendingApprovals.size).toBe(1);
    expect(pending).toMatchObject({ route: 'user', status: 'awaiting_user' });
    expect(pending?.commandIdentity).toEqual(commandIdentity());
  });

  test('late auto-review results are no-ops after a human batch release', () => {
    const requested = reduce(initialState(), toolQueued('call-auto'), {
      type: 'auto_review.requested',
      reviewId: 'review-auto',
      toolCallId: 'call-auto',
      toolName: 'shell_execute',
      reason: 'auto-review for shell command',
      approval: approvalPayload(),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: true,
      commandIdentity: commandIdentity(),
      createdAt: '2026-08-25T00:00:06.000Z',
    } as KernelEvent);
    const released = reduce(
      requested,
      sameCommandBatchEvent({
        interactionId: 'review-auto',
        toolCallId: 'call-auto',
        matches: [
          {
            interactionId: 'review-auto',
            toolCallId: 'call-auto',
            receiptId: 'receipt-auto',
            generation: 0,
          },
        ],
      }),
    );
    const beforeLateResult = JSON.stringify(released);
    const afterLateResult = reduce(released, {
      type: 'auto_review.completed',
      reviewId: 'review-auto',
      toolCallId: 'call-auto',
      result: {
        ok: true,
        approved: true,
        reviewerModelName: 'reviewer-v1',
        durationMs: 1,
      },
    } as KernelEvent);

    expect(JSON.stringify(afterLateResult)).toBe(beforeLateResult);
  });

  test('generation and receipt identifiers make a batch release idempotent', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b'),
      approvalRequested('approval-b', 'call-b'),
    );
    const event = sameCommandBatchEvent();
    const once = reduce(queued, event);
    const twice = reduce(once, event);

    expect(twice).toEqual(once);
    expect(approvalProjection(twice).pendingApprovals.get('approval-a').receiptId).toBe(
      'receipt-a',
    );
    expect(approvalProjection(twice).pendingApprovals.get('approval-b').receiptId).toBe(
      'receipt-b',
    );
  });

  test('revision and generation races cannot persist a same-command grant', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
    );
    const before = JSON.stringify(queued);
    const raced = reduce(
      queued,
      sameCommandBatchEvent({
        sessionRevision: queued.revision + 1,
        generation: queued.approvalGeneration + 1,
        matches: [
          {
            interactionId: 'approval-a',
            toolCallId: 'call-a',
            receiptId: 'receipt-raced',
            generation: queued.approvalGeneration + 1,
          },
        ],
      }),
    );
    expect(JSON.stringify(raced)).toBe(before);
    expect(raced.sessionCommandGrants.size).toBe(0);
  });

  test('turn abort clears live approvals and seals receipts against late grants', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      {
        type: 'approval.granted',
        interactionId: 'approval-a',
        toolCallId: 'call-a',
        grant: 'approve_once',
        receiptId: 'receipt-aborted',
        generation: 0,
      } as KernelEvent,
    );
    const aborted = reduce(queued, {
      type: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'user_cancelled',
      cause: 'user',
    } as KernelEvent);
    expect(aborted.pendingApprovals.size).toBe(0);
    expect(aborted.sessionCommandGrants.size).toBe(0);
    expect(aborted.activeApprovalId).toBeNull();
    expect(aborted.approvalGeneration).toBe(1);
    expect(aborted.approvalReceipts.get('receipt-aborted')).toMatchObject({ status: 'terminal' });
    expect(
      reduce(aborted, {
        type: 'approval.granted',
        interactionId: 'approval-a',
        toolCallId: 'call-a',
        grant: 'approve_once',
        receiptId: 'late-receipt',
        generation: 0,
      } as KernelEvent),
    ).toEqual(aborted);
  });

  test('full mode releases only requests sealed as bypass-eligible', () => {
    const queued = reduce(
      initialState(),
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a', { fullModePolicyBypassAllowed: true }),
      toolQueued('call-manual'),
      approvalRequested('approval-manual', 'call-manual'),
    );
    const full = reduce(queued, {
      type: 'interaction_mode.changed',
      mode: 'full',
      source: 'user',
      changedAt: '2026-08-25T00:00:07.000Z',
    } as KernelEvent);
    const pending = full.pendingApprovals.get('approval-a');
    expect(pending).toBeDefined();
    if (!pending) throw new Error('approval queue lost the pending interaction');
    expect(pending.status).toBe('authorized_queued');
    expect(pending.authorizationSource).toBe('mode_full');
    expect(pending.receiptId).toBeUndefined();
    expect(full.tools.calls['call-a']?.status).toBe('authorized_queued');
    expect(full.pendingApprovals.get('approval-manual')?.status).toBe('awaiting_user');
    expect(full.activeApprovalId).toBe('approval-manual');
    expect(record(full.interactions)).toMatchObject({
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-manual',
    });
  });
});
