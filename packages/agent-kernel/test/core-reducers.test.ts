import { describe, expect, test } from 'bun:test';
import { decideCompletionV1 } from '../src/completion';
import { reduceAuthorizationState } from '../src/core/authorization/reducer';
import { reduceCompletionState } from '../src/core/completion/reducer';
import { reduceLifecycleState } from '../src/core/lifecycle/reducer';
import type { KernelEvent } from '../src/events';
import { sha256Hex } from '../src/hash';
import { createToolRecoveryJournalV1, recordRecoveryFailureV1 } from '../src/recovery';
import { reduceAgentState } from '../src/reducer';
import { type AgentState, createInitialAgentState } from '../src/state';

const RECOVERY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function initialState(): AgentState {
  return createInitialAgentState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

function taskStarted(state = initialState()): AgentState {
  return reduceLifecycleState(state, {
    type: 'task.started',
    taskId: 'task-1',
    userGoal: 'goal',
    turnId: 'turn-1',
  });
}

function planDigest(
  title: string,
  bodyMarkdown: string,
  steps: readonly { id: string; title: string }[],
) {
  return sha256Hex(
    JSON.stringify({
      title: title.trim(),
      bodyMarkdown: bodyMarkdown.trim(),
      steps: steps.map((step) => ({ id: step.id, title: step.title.trim() })),
    }),
  );
}

function planPayload(version = 1, supersedesPlanVersion?: number, replanReason?: string) {
  const title = 'Runtime plan';
  const bodyMarkdown = 'Execute the canonical runtime plan with evidence.';
  const steps = [{ id: 'step-one', title: 'Execute the first step', status: 'pending' as const }];
  const structuralHash = planDigest(title, bodyMarkdown, steps);
  return {
    planId: 'plan-1',
    version,
    structuralHash,
    plan: {
      name: title,
      description: bodyMarkdown,
      status: 'pending' as const,
      steps: steps.map((step) => ({ id: step.id, step: step.title, status: step.status })),
    },
    planSchemaVersion: 2,
    artifact: {
      artifactId: `plan-1:v${version}`,
      taskId: 'task-1',
      planId: 'plan-1',
      version,
      fileName: `v${version}.md`,
      relativePath: `plans/v${version}.md`,
      displayPath: `/workspace/plans/v${version}.md`,
      structuralDigest: structuralHash,
      byteLength: 64,
    },
    ...(supersedesPlanVersion === undefined ? {} : { supersedesPlanVersion }),
    ...(replanReason === undefined ? {} : { replanReason }),
  };
}

const rejectionOutcome = {
  schemaVersion: 1 as const,
  status: 'rejected' as const,
  failure: { kind: 'tool_runtime_error' as const, detailCode: 'unknown' as const },
  dispatchState: 'not_started' as const,
  externalEffects: 'none' as const,
  recovery: {
    disposition: 'user_action' as const,
    maximumAdditionalCalls: 0 as const,
    requiresNewModelResponse: false,
    safeAutomaticRetry: false,
  },
  timing: { source: 'legacy_unknown' as const },
};

const autoReviewApproval = {
  scope: 'once' as const,
  cwd: '/workspace',
  threadId: 'thread-1',
  tool: 'shell_execute',
  command: 'echo ok',
  risk: 'execute_code' as const,
  approvalHash: 'approval-hash',
  summary: 'Run the fixture command.',
  reason: 'Automatic review is required.',
  expectedEffects: [],
  grantOptions: ['approve_once' as const],
  recommendedGrant: 'approve_once' as const,
};

describe('State25 core reducers', () => {
  test('authorization.changed preserves the complete authorization payload', () => {
    const state = initialState();
    const next = reduceAuthorizationState(state, {
      type: 'authorization.changed',
      mode: 'full_access',
      commandGrants: {
        grant: {
          workspace: '/workspace',
          threadId: 'thread-1',
          command: 'bun test',
          source: 'test',
          grantedAt: '2026-08-20T00:00:00.000Z',
        },
      },
      modeSource: 'user',
      modeGrantedAt: '2026-08-20T00:00:00.000Z',
    } as unknown as KernelEvent);

    expect(next.authorization).toEqual({
      mode: 'full_access',
      commandGrants: {
        grant: {
          workspace: '/workspace',
          threadId: 'thread-1',
          command: 'bun test',
          source: 'test',
          grantedAt: '2026-08-20T00:00:00.000Z',
        },
      },
      modeSource: 'user',
      modeGrantedAt: '2026-08-20T00:00:00.000Z',
    });
  });

  test('interaction mode changes clear authorization and active-task execution overrides', () => {
    const started = taskStarted();
    const state = {
      ...started,
      mode: 'full' as const,
      authorization: {
        ...started.authorization,
        mode: 'full_access' as const,
        modeSource: 'user' as const,
        modeGrantedAt: '2026-08-20T00:00:00.000Z',
      },
      tasks: {
        ...started.tasks,
        'task-1': { ...started.tasks['task-1']!, executionMode: 'auto' as const },
      },
    };
    const next = reduceAuthorizationState(state, {
      type: 'interaction_mode.changed',
      mode: 'accept_edits',
      source: 'user',
      changedAt: '2026-08-20T00:00:01.000Z',
    } as KernelEvent);

    expect(next.mode).toBe('accept_edits');
    expect(next.authorization).toEqual({ mode: 'default', commandGrants: {} });
    expect(next.tasks['task-1']?.executionMode).toBeUndefined();
  });

  test('invalid authorization facts fail closed without changing state', () => {
    const state = initialState();
    expect(
      reduceAuthorizationState(state, {
        type: 'interaction_mode.changed',
        mode: 'full',
        source: 'forged',
        changedAt: '2026-08-20T00:00:00.000Z',
      } as unknown as KernelEvent),
    ).toBe(state);
    expect(
      reduceAuthorizationState(state, {
        type: 'authorization.changed',
        mode: 'forged',
      } as unknown as KernelEvent),
    ).toBe(state);
    expect(() =>
      reduceAgentState(state, { type: 'authorization.changed' } as KernelEvent),
    ).toThrow();
  });

  test('auto-review doom-loop tracking uses only supplied time or deterministic identity', () => {
    const state = {
      ...initialState(),
      tools: {
        calls: {
          'call-1': {
            toolCallId: 'call-1',
            name: 'shell_execute',
            modelMessageId: 'message-1',
            args: { command: 'echo ok', cwd: '/workspace' },
            createdAtTurnId: 'turn-1',
            status: 'queued' as const,
          },
        },
        queue: ['call-1'],
        active: [],
      },
    };
    const event = {
      type: 'auto_review.requested',
      reviewId: 'review-1',
      toolCallId: 'call-1',
      toolName: 'shell_execute',
      reason: 'review',
      approval: {},
      createdAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent;
    const first = reduceAuthorizationState(state, event);
    const second = reduceAuthorizationState(first, {
      ...event,
      reviewId: 'review-2',
      createdAt: '2026-08-20T00:00:00.001Z',
    } as unknown as KernelEvent);
    const entries = Object.values(second.doomLoop);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ count: 2, lastSeenAt: 1787184000001 });
  });

  test('auto-review completion closes the interaction and enforces both breaker thresholds', () => {
    const observedAt = Date.parse('2026-08-20T00:00:30.000Z');
    const state = {
      ...initialState(),
      tools: {
        calls: {
          'call-1': {
            toolCallId: 'call-1',
            name: 'shell_execute',
            modelMessageId: 'message-1',
            args: { command: 'echo ok' },
            createdAtTurnId: 'turn-1',
            status: 'awaiting_auto_review' as const,
          },
        },
        queue: ['call-1'],
        active: [],
      },
      interactions: {
        kind: 'awaiting_auto_review' as const,
        interactionId: 'review-1',
        toolCallId: 'call-1',
        toolName: 'shell_execute',
        reason: 'review',
        approval: autoReviewApproval,
      },
      autoReview: {
        ...initialState().autoReview,
        rejectionHistory: [
          { timestamp: observedAt - 30_001, toolName: 'old', reason: 'expired' },
          ...Array.from({ length: 19 }, (_, index) => ({
            timestamp: observedAt - index,
            toolName: 'shell_execute',
            reason: `recent-${index}`,
          })),
        ],
      },
    };
    const rejected = reduceAuthorizationState(state, {
      type: 'auto_review.completed',
      reviewId: 'review-1',
      toolCallId: 'call-1',
      createdAt: '2026-08-20T00:00:30.000Z',
      result: { ok: true, approved: false, escalatedToUser: false, reason: 'denied' },
    } as unknown as KernelEvent);

    expect(rejected.interactions).toEqual({ kind: 'idle' });
    expect(rejected.tools.calls['call-1']?.status).toBe('rejected');
    expect(rejected.autoReview.rejectionHistory).toHaveLength(20);
    expect(rejected.autoReview.rejectionHistory.some((entry) => entry.reason === 'expired')).toBe(
      false,
    );
    expect(rejected.autoReview.circuitBreakerTripped).toBe(true);

    const awaitingApproval = {
      ...rejected,
      interactions: state.interactions,
      tools: {
        ...rejected.tools,
        calls: {
          ...rejected.tools.calls,
          'call-1': { ...rejected.tools.calls['call-1']!, status: 'awaiting_auto_review' as const },
        },
      },
    };
    const approved = reduceAuthorizationState(awaitingApproval, {
      type: 'auto_review.completed',
      reviewId: 'review-1',
      toolCallId: 'call-1',
      createdAt: '2026-08-20T00:01:01.000Z',
      result: { ok: true, approved: true, durationMs: 2 },
    } as KernelEvent);
    expect(approved.autoReview).toMatchObject({
      consecutiveRejects: 0,
      rejectionHistory: [],
      circuitBreakerTripped: false,
    });
  });

  test('task completion and cancellation require the active known task and never alter the turn', () => {
    const state = taskStarted();
    const unknownCompleted = reduceLifecycleState(state, {
      type: 'task.completed',
      taskId: 'missing',
      turnId: 'turn-2',
    } as KernelEvent);
    expect(unknownCompleted).toBe(state);
    const unknownCancelled = reduceLifecycleState(state, {
      type: 'task.cancelled',
      taskId: 'missing',
      reason: 'stale',
    } as KernelEvent);
    expect(unknownCancelled).toBe(state);

    const journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(RECOVERY_KEY), {
      toolCallId: 'call-1',
      toolName: 'shell_execute',
      invocationFingerprint: 'fingerprint',
      modelMessageId: 'message-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      outcome: rejectionOutcome,
    });
    const withFailure = { ...state, toolRecovery: journal };
    const completed = reduceLifecycleState(withFailure, {
      type: 'task.completed',
      taskId: 'task-1',
      turnId: 'turn-2',
    } as KernelEvent);
    expect(completed.turn).toEqual(state.turn);
    expect(completed.activeTaskId).toBeNull();
    expect(completed.tasks['task-1']?.status).toBe('completed');
    expect(Object.values(completed.toolRecovery.failures)[0]?.resolution).toBe('task_closed');
  });

  test('task.started replays the root overwrite/activation semantics without changing the turn', () => {
    const state = taskStarted();
    const next = reduceLifecycleState(state, {
      type: 'task.started',
      taskId: 'task-1',
      userGoal: 'replacement goal',
      turnId: 'turn-2',
    } as KernelEvent);
    expect(next.turn).toEqual(state.turn);
    expect(next.activeTaskId).toBe('task-1');
    expect(next.tasks['task-1']?.userGoal).toBe('replacement goal');
    expect(next.tasks['task-1']?.startedAtTurnId).toBe('turn-2');
  });

  test('turn.started closes the old turn scope and preserves only a matching V2 plan correction', () => {
    const state = taskStarted();
    const withGuard = {
      ...state,
      completionGuard: {
        correctionAttempts: 2,
        guardVersion: 'completion_guard_v2' as const,
        planIdentity: { planId: 'plan-1', version: 1, structuralDigest: 'digest' },
      },
      terminalOutcome: {
        version: 1 as const,
        status: 'completed' as const,
        reasonCode: 'completed' as const,
        knownExternalEffects: 'none' as const,
        safeRetry: false,
        recoveryEntry: 'none' as const,
        pendingVerification: false,
      },
    };
    const next = reduceLifecycleState(withGuard, {
      type: 'turn.started',
      turnId: 'turn-2',
    } as KernelEvent);
    expect(next.turn).toEqual({ turnId: 'turn-2', turnIndex: 1, status: 'active' });
    expect(next.terminalOutcome).toBeUndefined();
    expect(next.completionGuard).toEqual({ correctionAttempts: 0 });
  });

  test('plan review/approval/revision/cancel and execution lifecycle enforce identity gates', () => {
    const started = taskStarted();
    const empty = reduceLifecycleState(started, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'model_request',
    } as KernelEvent);
    const drafted = reduceLifecycleState(empty, {
      type: 'plan.drafted',
      taskId: 'task-1',
      toolCallId: 'plan-tool',
      ...planPayload(),
    } as KernelEvent);
    expect(drafted.tasks['task-1']?.planning.kind).toBe('planning_draft');
    const document = drafted.tasks['task-1']?.planning;
    if (document?.kind !== 'planning_draft') throw new Error('draft fixture did not apply');
    const review = reduceLifecycleState(drafted, {
      type: 'plan.review_requested',
      taskId: 'task-1',
      toolCallId: 'plan-tool',
      interactionId: 'review-1',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      plan: {
        name: document.document.title,
        description: document.document.bodyMarkdown,
        status: 'pending',
        steps: document.document.steps.map((step) => ({
          id: step.id,
          step: step.title,
          status: step.status,
        })),
      },
      planSummary: 'summary',
      artifact: document.document.artifact,
    } as KernelEvent);
    expect(review.interactions.kind).toBe('awaiting_review');
    const approved = reduceLifecycleState(review, {
      type: 'plan.approved',
      interactionId: 'review-1',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      executionMode: 'auto',
    } as KernelEvent);
    expect(approved.tasks['task-1']?.planning.kind).toBe('executing');
    expect(approved.tasks['task-1']?.executionMode).toBe('auto');
    const progressed = reduceLifecycleState(approved, {
      type: 'plan.progress_updated',
      taskId: 'task-1',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      plan: {
        name: document.document.title,
        description: document.document.bodyMarkdown,
        status: 'pending',
        steps: [{ id: 'step-one', step: 'Execute the first step', status: 'in_progress' }],
      },
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    } as KernelEvent);
    const progressedPlanning = progressed.tasks['task-1']?.planning;
    if (progressedPlanning?.kind !== 'executing') throw new Error('progress fixture did not apply');
    expect(progressedPlanning.document.steps[0]?.status).toBe('in_progress');
    const completedPlan = reduceLifecycleState(progressed, {
      type: 'plan.completed',
      taskId: 'task-1',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      plan: {
        name: document.document.title,
        description: document.document.bodyMarkdown,
        status: 'completed',
        steps: [{ id: 'step-one', step: 'Execute the first step', status: 'completed' }],
      },
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    } as KernelEvent);
    expect(completedPlan.tasks['task-1']?.planning.kind).toBe('completed');
    expect(completedPlan.tasks['task-1']?.executionMode).toBeUndefined();
    const forged = reduceLifecycleState(approved, {
      type: 'plan.progress_updated',
      taskId: 'other-task',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      plan: {
        name: document.document.title,
        description: document.document.bodyMarkdown,
        status: 'pending',
        steps: [{ id: 'step-one', step: 'Execute the first step', status: 'in_progress' }],
      },
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    } as KernelEvent);
    expect(forged).toBe(approved);
    const replanned = reduceLifecycleState(approved, {
      type: 'plan.replan_requested',
      toolCallId: 'plan-tool',
      reason: 'needs a revised step',
      supersedesPlanVersion: 1,
    } as KernelEvent);
    expect(replanned.tasks['task-1']?.planning.kind).toBe('replanning_draft');
    const replanning = replanned.tasks['task-1']?.planning;
    if (replanning?.kind !== 'replanning_draft') throw new Error('replan fixture did not apply');
    const replannedDraft = reduceLifecycleState(replanned, {
      type: 'plan.drafted',
      taskId: 'task-1',
      toolCallId: 'plan-tool',
      ...planPayload(2, 1, 'needs a revised step'),
    } as KernelEvent);
    expect(replannedDraft.tasks['task-1']?.planning.kind).toBe('replanning_draft');
    if (replannedDraft.tasks['task-1']?.planning.kind === 'replanning_draft') {
      expect(replannedDraft.tasks['task-1'].planning.document.version).toBe(2);
      expect(replannedDraft.tasks['task-1'].planning.document.supersedesPlanVersion).toBe(1);
    }
    const cancelledReview = reduceLifecycleState(review, {
      type: 'plan.review_cancelled',
      interactionId: 'review-1',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      reason: 'user changed direction',
    } as KernelEvent);
    expect(cancelledReview.interactions.kind).toBe('idle');
    expect(cancelledReview.tasks['task-1']?.planning.kind).toBe('planning_draft');
    const revised = reduceLifecycleState(review, {
      type: 'plan.revision_requested',
      interactionId: 'review-1',
      toolCallId: 'plan-tool',
      planId: document.document.planId,
      version: document.document.version,
      structuralDigest: document.document.structuralDigest,
      feedback: 'revise one step',
    } as KernelEvent);
    expect(revised.interactions.kind).toBe('idle');
    expect(revised.tasks['task-1']?.planning.kind).toBe('planning_draft');
  });

  test('turn completion, terminal completion, and blocked completion reject stale or forged identity', () => {
    const state = taskStarted();
    expect(
      reduceCompletionState(state, { type: 'turn.completed', turnId: 'old-turn' } as KernelEvent),
    ).toBe(state);
    expect(
      reduceCompletionState(state, {
        type: 'run.completed',
        turnId: 'old-turn',
        output: {},
        outcome: { version: 1, status: 'completed' },
      } as KernelEvent),
    ).toBe(state);

    const decision = decideCompletionV1(
      reduceLifecycleState(state, {
        type: 'planning.entered',
        taskId: 'task-1',
        source: 'model_request',
      }),
    );
    expect(decision.status).toBe('blocked');
    if (decision.status !== 'blocked') return;
    const planned = reduceLifecycleState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'model_request',
    });
    const forged = reduceCompletionState(planned, {
      type: 'completion.blocked',
      turnId: 'turn-1',
      guardVersion: 'completion_guard_v1',
      code: decision.code,
      nextAction: decision.nextAction,
      planning: decision.planning,
      correctionAttempt: decision.correctionAttempt + 1,
    } as KernelEvent);
    expect(forged).toBe(planned);
  });
});
