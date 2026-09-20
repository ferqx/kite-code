import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  decideCompletion,
  decidePlannedCompletion,
  decideUnplannedCompletion,
} from '../src/completion';
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

test('completion keeps an old-turn unknown outcome without blocking a new turn of the same Task', () => {
  const state = initialState();
  const unknown = {
    invocationId: 'old-invocation',
    toolCallId: 'old-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    taskId: 'continued-task',
    status: 'unknown' as const,
    recordedAt: '2026-08-20T00:00:00.000Z',
  };
  const oldCall = {
    toolCallId: 'old-tool',
    taskId: 'continued-task',
    name: 'shell_execute',
    modelMessageId: 'old-message',
    args: {},
    status: 'failed' as const,
    createdAtTurnId: 'old-turn',
  };
  const withHistory = {
    ...state,
    activeTaskId: 'continued-task',
    tools: { ...state.tools, calls: { [oldCall.toolCallId]: oldCall } },
    capabilities: { ...state.capabilities, invocations: { [unknown.invocationId]: unknown } },
  };
  expect(decideUnplannedCompletion(withHistory)).not.toMatchObject({
    code: 'unknown_external_invocation',
  });
  expect(
    decideUnplannedCompletion({
      ...withHistory,
      tools: {
        ...withHistory.tools,
        calls: { [oldCall.toolCallId]: { ...oldCall, createdAtTurnId: state.turn.turnId } },
      },
    }),
  ).toMatchObject({ code: 'unknown_external_invocation' });
});

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
    bodyMarkdown: 'A sufficiently long plan body for the State completion guard.',
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

describe('State CompletionGuard parity', () => {
  test('settles a required background task from either its durable result or task control', () => {
    const state = initialState();
    const background = {
      toolCallId: 'task-start',
      name: 'task',
      modelMessageId: 'model-1',
      args: { background: true },
      createdAtTurnId: state.turn.turnId,
      status: 'succeeded' as const,
      result: {
        ok: true,
        summary: 'background accepted',
        resultMeta: {
          taskId: 'child-1',
          taskStatus: 'running' as const,
          taskDisposition: 'required' as const,
        },
      },
    };
    const waiting = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          [background.toolCallId]: background,
          'child-shell': {
            toolCallId: 'child-shell',
            name: 'shell_execute',
            modelMessageId: 'child-model',
            args: { command: 'head -n 1 gate' },
            createdAtTurnId: state.turn.turnId,
            status: 'running' as const,
            presentation: 'hidden' as const,
            presentationOwner: {
              subagentId: 'child-1',
              parentToolCallId: background.toolCallId,
            },
          },
        },
      },
    } as AgentState;
    expect(decideUnplannedCompletion(waiting)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
      nextAction: 'wait_for_background',
      backgroundTaskIds: ['child-1'],
    });
    const forgedOwner = {
      ...waiting,
      tools: {
        ...waiting.tools,
        calls: {
          orphan: {
            ...waiting.tools.calls['child-shell']!,
            toolCallId: 'orphan',
            presentationOwner: {
              subagentId: 'different-child',
              parentToolCallId: background.toolCallId,
            },
          },
        },
      },
    } as AgentState;
    expect(decideUnplannedCompletion(forgedOwner)).toMatchObject({
      status: 'blocked',
      nextAction: 'wait_for_tool',
    });
    const plannedWaiting = withCompletedPlan(
      waiting,
      completedPlan({
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      }),
    );
    expect(decidePlannedCompletion(plannedWaiting)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
      nextAction: 'wait_for_background',
      backgroundTaskIds: ['child-1'],
    });

    const durableSettled = {
      ...waiting,
      capabilities: {
        ...waiting.capabilities,
        invocations: {
          background: {
            invocationId: 'background',
            toolCallId: 'task-start',
            capabilityId: 'subagent',
            capabilityRevision: 'v1',
            argumentsDigest: 'arguments',
            authorizationDigest: 'authorization',
            effectiveEffectsDigest: 'effects',
            status: 'succeeded' as const,
            recordedAt: '2026-09-20T00:00:00.000Z',
            subagentProviderLifecycle: {
              attempt: 1,
              purpose: 'start' as const,
              childInvocationId: 'child-1',
              taskArtifact: {
                artifactId: 'task-artifact',
                kind: 'subagent_task' as const,
                integrityIdentifier: `sha256:${'a'.repeat(64)}`,
                byteLength: 1,
              },
              dispatchIntentDigest: `sha256:${'b'.repeat(64)}`,
              status: 'cleanup_completed' as const,
              recordedAt: '2026-09-20T00:00:00.000Z',
              cleanupConfirmed: true,
              backgroundResult: {
                taskId: 'child-1',
                notificationId: `subagent:child-1:sha256:${'c'.repeat(64)}`,
                artifactIntegrityIdentifier: `sha256:${'c'.repeat(64)}`,
                originRunId: 'run-1',
                originTurnId: state.turn.turnId,
                originToolCallId: 'task-start',
                attempt: 1,
              },
            },
          },
        },
      },
    } as AgentState;
    expect(decideUnplannedCompletion(durableSettled)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });

    for (const [name, taskStatus] of [
      ['task_read', 'completed'],
      ['task_read', 'failed'],
      ['task_cancel', 'cancelled'],
    ] as const) {
      const terminal = {
        toolCallId: `${name}-terminal`,
        name,
        modelMessageId: 'model-2',
        args: { task_id: 'child-1' },
        createdAtTurnId: state.turn.turnId,
        status: 'succeeded' as const,
        result: {
          ok: true,
          summary: 'terminal observed',
          resultMeta: { taskId: 'child-1', taskStatus },
        },
      };
      const settled = {
        ...waiting,
        tools: {
          ...waiting.tools,
          calls: { ...waiting.tools.calls, [terminal.toolCallId]: terminal },
        },
      } as AgentState;
      expect(decideUnplannedCompletion(settled)).toEqual({
        status: 'accepted',
        version: 'completion_guard_v1',
      });
    }

    const secondBackground = {
      ...background,
      toolCallId: 'task-start-2',
      result: {
        ...background.result,
        resultMeta: { ...background.result.resultMeta, taskId: 'child-2' },
      },
    };
    const firstTerminal = {
      toolCallId: 'task-read-child-1',
      name: 'task_read',
      modelMessageId: 'model-2',
      args: { task_id: 'child-1' },
      createdAtTurnId: state.turn.turnId,
      status: 'succeeded' as const,
      result: {
        ok: true,
        summary: 'first child failed',
        resultMeta: { taskId: 'child-1', taskStatus: 'failed' as const },
      },
    };
    const mixed = {
      ...waiting,
      tools: {
        ...waiting.tools,
        calls: {
          [background.toolCallId]: background,
          [secondBackground.toolCallId]: secondBackground,
          [firstTerminal.toolCallId]: firstTerminal,
        },
      },
    } as AgentState;
    expect(decideUnplannedCompletion(mixed)).toMatchObject({
      status: 'blocked',
      nextAction: 'wait_for_background',
      backgroundTaskIds: ['child-2'],
    });
  });

  test('does not let provider readiness or admission facts decide an unplanned completion', () => {
    const state = initialState();
    const withProviderFacts = {
      ...state,
      providerReadiness: { provider: {} as never },
      providerAdmission: { pending: [{} as never], waivers: {} },
    } as AgentState;

    expect(decideUnplannedCompletion(withProviderFacts)).toEqual({
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

    expect(decidePlannedCompletion(withFailure)).toMatchObject({
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

    expect(decidePlannedCompletion(withPreviousGuard)).toMatchObject({
      status: 'accepted',
      version: 'completion_guard_v2',
    });
  });
});
