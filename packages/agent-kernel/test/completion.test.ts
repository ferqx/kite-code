import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { decideCompletion, decideCompletionV1, decideCompletionV2 } from '../src/completion';
import { type AgentState, createInitialAgentState, type PlanDocument } from '../src/state';

const RECOVERY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function initialState(): AgentState {
  return createInitialAgentState({
    threadId: 'completion-test',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

function structuralDigest(
  document: Pick<PlanDocument, 'title' | 'bodyMarkdown' | 'steps'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: document.title.replace(/\r\n/g, '\n').trim(),
        bodyMarkdown: document.bodyMarkdown.replace(/\r\n/g, '\n').trim(),
        steps: document.steps.map(({ id, title }) => ({
          id,
          title: title.replace(/\r\n/g, '\n').trim(),
        })),
      }),
    )
    .digest('hex');
}

function completedPlan(evidence: PlanDocument['completionEvidence']): PlanDocument {
  const base = {
    planSchemaVersion: 2 as const,
    planId: 'plan-1',
    version: 1,
    title: 'Completion test plan',
    bodyMarkdown: 'A sufficiently long plan body for the State26 completion guard.',
    steps: [{ id: 'implement', title: 'Implement', status: 'completed' as const }],
    createdAtTurnId: 'turn-1',
    updatedAtTurnId: 'turn-1',
    completionEvidence: evidence,
  };
  return { ...base, structuralDigest: structuralDigest(base) };
}

function withCompletedPlan(state: AgentState, document: PlanDocument): AgentState {
  const taskId = 'task-1';
  return {
    ...state,
    activeTaskId: taskId,
    tasks: {
      [taskId]: {
        taskId,
        userGoal: 'complete the test',
        status: 'active',
        startedAtTurnId: 'turn-1',
        sideEffectsStarted: false,
        planning: { kind: 'completed', document, completedAtTurnId: 'turn-1' },
        planHistory: [document],
      },
    },
  };
}

describe('State26 CompletionGuard parity', () => {
  test('does not let provider readiness or admission facts decide an unplanned completion', () => {
    const state = initialState();
    const withProviderFacts = {
      ...state,
      providerReadiness: { provider: {} as never },
      providerAdmission: { pending: [{} as never], waivers: {} },
    } as AgentState;

    expect(decideCompletionV1(withProviderFacts)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
  });

  test('blocks a completed PlanDocument with an unresolved effect as plan evidence', () => {
    const evidence = {
      schemaVersion: 1 as const,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [{ kind: 'failure' as const, referenceId: 'write-1' }],
    };
    const document = completedPlan(evidence);
    const state = withCompletedPlan(initialState(), document);
    const failedCall = {
      toolCallId: 'write-1',
      name: 'write_file',
      modelMessageId: 'model-1',
      args: {},
      createdAtTurnId: 'turn-1',
      taskId: 'task-1',
      status: 'failed' as const,
      sideEffect: true,
      result: { ok: false, summary: 'failed' },
    };
    const withFailure = {
      ...state,
      tools: { ...state.tools, calls: { 'write-1': failedCall }, queue: [], active: [] },
    } as AgentState;

    expect(decideCompletionV2(withFailure)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v2',
      code: 'plan_evidence_unresolved',
      nextAction: 'resolve_plan_evidence',
    });
    expect(decideCompletion(withFailure)).toMatchObject({
      status: 'blocked',
      code: 'plan_evidence_unresolved',
    });
  });

  test('uses a fresh V2 correction budget for a changed plan identity', () => {
    const evidence = {
      schemaVersion: 1 as const,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    };
    const document = completedPlan(evidence);
    const state = withCompletedPlan(initialState(), document);
    const withPreviousGuard = {
      ...state,
      completionGuard: {
        correctionAttempts: 4,
        guardVersion: 'completion_guard_v2' as const,
        planIdentity: { planId: 'older-plan', version: 1, structuralDigest: 'a'.repeat(64) },
      },
    };

    expect(decideCompletionV2(withPreviousGuard)).toMatchObject({
      status: 'accepted',
      version: 'completion_guard_v2',
    });
  });
});
