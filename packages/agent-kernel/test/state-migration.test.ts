import { describe, expect, test } from 'bun:test';
import { assertCurrentRuntimeEventForWrite } from '../src/codec';
import {
  classifyStateFormat,
  convertLegacyRuntimeEvent,
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  migrateState26To27,
} from '../src/state-migration';

const IDENTITY = 'a'.repeat(64);

function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
    formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    revision: 3,
    appliedEventIds: ['event-1'],
    recoveryState: { kind: 'normal' },
    session: {
      threadId: 'thread-1',
      userId: 'user-1',
      workspace: '/workspace',
      projectId: 'project-1',
      canonicalWorkspaceDigest: 'workspace-digest',
    },
    turn: { turnId: 'turn-1', turnIndex: 2, status: 'active' },
    transcript: {
      messages: [
        {
          messageId: 'message-1',
          turnId: 'turn-1',
          ordinal: 0,
          createdAt: '2026-08-25T00:00:00.000Z',
          kind: 'user',
          content: 'continue this task',
        },
      ],
    },
    context: {
      history: [],
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    toolRecovery: {
      schemaVersion: 1,
      identityKey: IDENTITY,
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: false, observedFailures: 0 },
    },
    mode: 'full',
    workspaceAccess: 'write',
    authorization: {
      mode: 'full_access',
      commandGrants: { dangerous: { command: 'rm -rf', source: 'user' } },
    },
    interactions: {
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-1',
      toolCallId: 'call-1',
    },
    tasks: {},
    tools: { calls: {}, queue: ['call-1'], active: ['call-1'] },
    ...overrides,
  };
}

describe('State 26 compatibility migration', () => {
  test('classifies only the exact legacy schema and epoch as migratable', () => {
    expect(classifyStateFormat(legacyState())).toBe('state26');
    expect(classifyStateFormat({ ...legacyState(), formatEpoch: 'future' })).toBe('unsupported');
    expect(classifyStateFormat({ ...legacyState(), schemaVersion: 999 })).toBe('unsupported');
  });

  test('migrates history while dropping every legacy authority surface', () => {
    const result = migrateState26To27(legacyState());
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.state.schemaVersion).toBe(27);
    expect(result.state.mode).toBe('accept_edits');
    expect((result.state as unknown as Record<string, unknown>).authorization).toBeUndefined();
    expect(result.state.pendingApprovals.size).toBe(0);
    expect(result.state.sessionCommandGrants.size).toBe(0);
    expect(result.state.approvalReceipts.size).toBe(0);
    expect(result.state.interactions).toEqual({ kind: 'idle' });
    expect(result.state.tools.queue).toEqual([]);
    expect(result.state.tools.active).toEqual([]);
    expect(result.state.transcript.messages[0]).toMatchObject({ content: 'continue this task' });
  });

  test('does not preserve full_access authorization when the interaction mode was auto', () => {
    const result = migrateState26To27(
      legacyState({ mode: 'auto', authorization: { mode: 'full_access', commandGrants: {} } }),
    );
    expect(result.status).toBe('migrated');
    if (result.status === 'migrated') expect(result.state.mode).toBe('accept_edits');
  });

  test('converts legacy authorization and review facts to reducer no-ops', () => {
    for (const event of [
      { type: 'authorization.changed', mode: 'full_access' },
      { type: 'interaction_mode.changed', mode: 'full' },
      { type: 'approval.requested', interactionId: 'i', toolCallId: 't', approval: {} },
      { type: 'approval.granted', interactionId: 'i', toolCallId: 't', grant: 'full_access' },
      { type: 'approval.rejected', interactionId: 'i', toolCallId: 't', reason: 'no' },
      { type: 'auto_review.requested', reviewId: 'r', toolCallId: 't', approval: {} },
      {
        type: 'auto_review.completed',
        reviewId: 'r',
        toolCallId: 't',
        result: { ok: true, grant: 'full_access' },
      },
      {
        type: 'approval.batch_released',
        grant: 'same_command',
        matches: ['legacy-approval'],
      },
      {
        type: 'approval.session_grants_cleared',
        sessionId: 'thread-1',
        sessionRevision: 3,
        generation: 1,
        clearedAt: '2026-08-25T00:00:00.000Z',
      },
    ]) {
      const converted = convertLegacyRuntimeEvent(event);
      expect(converted.status).toBe('converted');
      if (converted.status === 'converted')
        expect(converted.event).toEqual({
          type: 'runtime.action_ignored',
          reason: 'legacy_authorization_compatibility',
        });
    }
  });

  test('retains compatible historical plan-review projections', () => {
    const converted = convertLegacyRuntimeEvent({
      type: 'plan.review_cancelled',
      interactionId: 'interaction-1',
      toolCallId: 'tool-1',
      planId: 'plan-1',
      version: 1,
      structuralDigest: 'digest-1',
      reason: 'legacy review completed',
    });
    expect(converted.status).toBe('converted');
    if (converted.status === 'converted')
      expect(converted.event.type).toBe('plan.review_cancelled');
  });

  test('preserves an empty historical task goal without restoring active task authority', () => {
    const result = migrateState26To27(
      legacyState({
        tasks: {
          'task-1': {
            taskId: 'task-1',
            userGoal: '',
            status: 'completed',
            startedAtTurnId: 'turn-1',
            sideEffectsStarted: false,
            planning: {},
            planHistory: [],
          },
        },
      }),
    );
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.state.tasks['task-1']?.userGoal).toBe('');
    expect(result.state.activeTaskId).toBeNull();
  });

  test('turns pre-invocation-id State 26 model retries into reducer no-ops', () => {
    const converted = convertLegacyRuntimeEvent({
      type: 'model.retry',
      attempt: 1,
      maxAttempts: 3,
      error: 'transient',
      delayMs: 250,
    });
    expect(converted).toEqual({
      status: 'converted',
      event: {
        type: 'runtime.action_ignored',
        reason: 'legacy_model_retry_compatibility',
      },
    });
  });

  test('unknown legacy event types become inert no-ops without allocating sequence metadata', () => {
    expect(convertLegacyRuntimeEvent({ type: 'future.event', sequence: 9 })).toEqual({
      status: 'converted',
      event: {
        type: 'runtime.action_ignored',
        reason: 'legacy_unknown_event_compatibility',
      },
    });
    expect(convertLegacyRuntimeEvent({ sequence: 9 })).toEqual({ status: 'ignored' });
    const converted = convertLegacyRuntimeEvent({
      type: 'user.message_appended',
      messageId: 'm',
      content: 'hello',
    });
    expect(converted.status).toBe('converted');
    if (converted.status === 'converted') expect(converted.event).not.toHaveProperty('sequence');
  });

  test('current writers reject legacy approval/review authority shapes', () => {
    expect(() =>
      assertCurrentRuntimeEventForWrite({
        type: 'auto_review.completed',
        reviewId: 'review-1',
        toolCallId: 'tool-1',
        result: { ok: true, approved: true, grant: 'full_access' },
      }),
    ).toThrow('read-only compatibility data');
    expect(() =>
      assertCurrentRuntimeEventForWrite({
        type: 'approval.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        approval: { recommendedGrant: 'full_access', grantOptions: ['full_access'] },
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
      }),
    ).toThrow('read-only compatibility data');
  });
});
