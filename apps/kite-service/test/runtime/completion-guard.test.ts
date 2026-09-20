import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  decideCompletion,
  decidePlannedCompletion,
  decideUnplannedCompletion,
} from '@kite-ai/agent-kernel';
import { computePlanStructuralDigest } from '@kite-ai/builtin-runtime/planning';
import { createDeterministicRuntimeIdSource } from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  type RuntimeState,
  setActivePlanning,
} from '@kite-ai/runtime-host/kernel-adapter';
import { runStateRuntimeLoop } from '#kite-service/bootstrap/runtime/state-runner';
import { hasTerminalRequiredManagedShell } from '#kite-service/bootstrap/runtime/turn-coordinator';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  StateHostSessionHarness as AgentKernel,
  restoreStateHostSessionHarness as restoreStateKernelCoordinator,
} from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { decideNextEffect } from '../../../../tests/helpers/agent-kernel-scheduler';
import { currentPlanDocument } from '../../../../tests/helpers/current-plan';

function activePlanningState() {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'guard',
    userId: 'u',
    workspace: '/tmp',
    projectId: 'project_completion_guard',
    canonicalWorkspaceDigest: `sha256:${'c'.repeat(64)}`,
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task-1',
    userGoal: 'Make a plan before implementation.',
    turnId: state.turn.turnId,
  });
  return reduceRuntimeState(state, {
    type: 'planning.entered',
    taskId: 'task-1',
    source: 'user_command',
  });
}

function v2ExecutingState(options: {
  requiredVerification?: 'pending' | 'passed';
  sideEffectsStarted?: boolean;
  executionEvidence?: boolean;
}) {
  let state = activePlanningState();
  const structuralDigest = computePlanStructuralDigest({
    title: 'Completion Guard V2 plan',
    bodyMarkdown: 'Verify that completion requires canonical metadata-only evidence.',
    steps: [{ id: 'implement', title: 'Implement the change', status: 'completed' }],
  });
  const identity = {
    planId: 'plan-v2',
    version: 2,
    structuralDigest,
  };
  const completionEvidence = {
    schemaVersion: 1 as const,
    verification:
      options.requiredVerification === 'passed'
        ? [{ verificationId: 'verification-v2', outcome: 'passed' as const }]
        : [],
    execution: options.executionEvidence
      ? [{ toolCallId: 'effect-v2', outcome: 'succeeded' as const }]
      : [],
    skipped: [],
    unresolved: [],
  };
  const document = {
    planSchemaVersion: 2 as const,
    ...identity,
    title: 'Completion Guard V2 plan',
    bodyMarkdown: 'Verify that completion requires canonical metadata-only evidence.',
    steps: [{ id: 'implement', title: 'Implement the change', status: 'completed' as const }],
    createdAtTurnId: state.turn.turnId,
    updatedAtTurnId: state.turn.turnId,
    completionEvidence,
  };
  state = setActivePlanning(state, {
    kind: 'executing',
    document,
    executionMode: 'auto',
    approvedAtTurnId: state.turn.turnId,
  });
  if (state.activeTaskId) {
    state = {
      ...state,
      tasks: {
        ...state.tasks,
        [state.activeTaskId]: {
          ...state.tasks[state.activeTaskId]!,
          sideEffectsStarted: options.sideEffectsStarted ?? false,
          planning: getActivePlanning(state),
        },
      },
    };
  }
  if (options.executionEvidence) {
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          ...state.tools.calls,
          'effect-v2': {
            toolCallId: 'effect-v2',
            modelMessageId: 'model-effect',
            ordinal: 0,
            name: 'write_file',
            args: {},
            status: 'succeeded',
            createdAtTurnId: state.turn.turnId,
            taskId: state.activeTaskId ?? undefined,
            sideEffect: true,
            result: { ok: true, summary: 'effect succeeded', exitCode: 0 },
          },
        },
      },
    };
  }
  if (options.requiredVerification) {
    state = {
      ...state,
      verification: {
        records: {
          'verification-v2': {
            verificationId: 'verification-v2',
            taskId: state.activeTaskId ?? undefined,
            mode: 'required',
            status: options.requiredVerification,
            spec: {
              schemaVersion: 1,
              verificationId: 'verification-v2',
              taskId: state.activeTaskId ?? undefined,
              subject: 'Completion evidence',
              checks: [],
              repair: { maxAttempts: 0 },
            },
            requestedAt: '2026-08-10T00:00:00.000Z',
            attempts: 1,
            repairAttempts: 0,
            checkResults: {},
          },
        },
      },
    };
  }
  return { state, identity, document };
}

describe('CompletionGuard V1', () => {
  test('blocks every incomplete Plan lifecycle before it can become task completion', () => {
    const state = activePlanningState();
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'planning_empty',
      nextAction: 'save_plan',
    });

    const draft = setActivePlanning(state, {
      kind: 'planning_draft',
      document: currentPlanDocument({
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'a'.repeat(64),
        title: 'Plan',
        bodyMarkdown: 'Describe the implementation and validation work.',
        steps: [{ id: 'inspect', title: 'Inspect', status: 'pending' }],
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      }),
    });
    expect(decideUnplannedCompletion(draft)).toMatchObject({
      status: 'blocked',
      code: 'plan_draft_pending',
      nextAction: 'submit_plan',
    });

    const draftPlanning = getActivePlanning(draft);
    const executing = setActivePlanning(draft, {
      kind: 'executing',
      document: currentPlanDocument({
        ...(draftPlanning.kind === 'planning_draft'
          ? draftPlanning.document
          : (() => {
              throw new Error('expected planning draft');
            })()),
        steps: [{ id: 'inspect', title: 'Inspect', status: 'in_progress' }],
      }),
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    });
    expect(decideUnplannedCompletion(executing)).toMatchObject({
      status: 'blocked',
      code: 'plan_execution_incomplete',
      nextAction: 'complete_plan',
    });
  });

  test('reducer rejects a bypassed run.completed event while a plan is incomplete', () => {
    const state = activePlanningState();
    const next = reduceRuntimeState(state, {
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'I am done.',
    });
    expect(next.activeTaskId).toBe(state.activeTaskId);
    expect(next.tasks[state.activeTaskId!]?.status).toBe('active');
  });

  test('allows an unplanned building task to complete with a bound guard decision', () => {
    const store = openStateStoreForTest(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'building',
        userId: 'u',
        workspace: '/tmp',
        projectId: 'project_completion_guard',
        canonicalWorkspaceDigest: `sha256:${'c'.repeat(64)}`,
      }),
      interactionMode: 'accept_edits',
      runtimeIdSource: createDeterministicRuntimeIdSource({
        seed: 'completion-guard-unplanned-task',
        epochMs: Date.parse('2026-08-21T00:00:00.000Z'),
      }),
    });
    try {
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'user-1',
        content: 'Answer the question.',
      });
      const active = kernel.getState();
      expect(decideUnplannedCompletion(active)).toEqual({
        status: 'accepted',
        version: 'completion_guard_v1',
      });
      kernel.processEvent({
        type: 'run.completed',
        turnId: active.turn.turnId,
        output: 'Done.',
        completionGuardVersion: 'completion_guard_v1',
      });
      const completed = kernel.getState();
      expect(completed.activeTaskId).toBeNull();
      expect(Object.values(completed.tasks).at(0)?.status).toBe('completed');
    } finally {
      kernel.close();
    }
  });

  test('ignores a non-terminal tool owned by an older task but keeps current tools blocking', () => {
    const state = activePlanningState();
    state.tools.calls.historical = {
      toolCallId: 'historical',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'write_plan',
      args: {},
      status: 'awaiting_review',
      createdAtTurnId: 'older-turn',
    };

    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'planning_empty',
    });

    state.tools.calls.current = {
      toolCallId: 'current',
      taskId: state.activeTaskId ?? undefined,
      modelMessageId: 'current-model',
      name: 'write_plan',
      args: {},
      status: 'awaiting_review',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
      nextAction: 'wait_for_tool',
      backgroundTaskIds: [],
    });
  });

  test('scopes legacy tools without task identity to the current turn', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'legacy-tool-scope',
      userId: 'u',
      workspace: '/tmp',
    });
    state.tools.calls.historical = {
      toolCallId: 'historical',
      modelMessageId: 'older-model',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: 'older-turn',
    };
    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });

    state.tools.calls.current = {
      toolCallId: 'current',
      modelMessageId: 'current-model',
      name: 'read_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
    });
  });

  test('keeps a required finite managed Shell blocking until its terminal read is processed', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'managed-shell-completion',
      userId: 'u',
      workspace: '/tmp',
    });
    state.tools.calls.start = {
      toolCallId: 'start',
      modelMessageId: 'model-start',
      name: 'shell_execute',
      args: { command: 'bun test', yield_ms: 1 },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
      result: {
        ok: true,
        summary: 'running',
        resultMeta: { shellId: 'sh_1', shellStatus: 'running' },
      },
    };
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
      nextAction: 'wait_for_tool',
      backgroundTaskIds: [],
    });

    state.tools.calls.read = {
      toolCallId: 'read',
      modelMessageId: 'model-read',
      name: 'shell_read',
      args: { shell_id: 'sh_1', wait_until: 'terminal' },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
      result: {
        ok: true,
        summary: 'exited',
        resultMeta: { shellId: 'sh_1', shellStatus: 'exited' },
      },
    };
    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });

    delete state.tools.calls.read;
    state.tools.calls.start = {
      ...state.tools.calls.start,
      args: { command: 'bun run dev', mode: 'service', yield_ms: 1 },
    };
    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
  });

  test('settles a required background child from its admitted durable result', () => {
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '1'.repeat(64),
      threadId: 'required-background-child',
      userId: 'u',
      workspace: '/tmp',
    });
    state.tools.calls.start = {
      toolCallId: 'start',
      modelMessageId: 'model-start',
      name: 'task',
      args: {
        name: 'inspect',
        subagent_type: 'explore',
        task: 'inspect runtime',
        background: true,
        result_disposition: 'required',
      },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
      result: {
        ok: true,
        summary: 'accepted',
        resultMeta: {
          taskId: 'child-required-1',
          taskStatus: 'running',
          taskDisposition: 'required',
        },
      },
    };
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'tool_pending',
      nextAction: 'wait_for_background',
      backgroundTaskIds: ['child-required-1'],
    });

    state = {
      ...state,
      capabilities: {
        ...state.capabilities,
        invocations: {
          background: {
            invocationId: 'background',
            toolCallId: 'start',
            capabilityId: 'subagent',
            capabilityRevision: 'v1',
            argumentsDigest: 'arguments',
            authorizationDigest: 'authorization',
            effectiveEffectsDigest: 'effects',
            status: 'succeeded',
            recordedAt: '2026-09-20T00:00:00.000Z',
            subagentProviderLifecycle: {
              attempt: 1,
              purpose: 'start',
              childInvocationId: 'child-required-1',
              taskArtifact: {
                artifactId: 'task-artifact',
                kind: 'subagent_task',
                integrityIdentifier: `sha256:${'a'.repeat(64)}`,
                byteLength: 1,
              },
              dispatchIntentDigest: `sha256:${'b'.repeat(64)}`,
              status: 'cleanup_completed',
              recordedAt: '2026-09-20T00:00:00.000Z',
              cleanupConfirmed: true,
              backgroundResult: {
                taskId: 'child-required-1',
                notificationId: `subagent:child-required-1:sha256:${'c'.repeat(64)}`,
                artifactIntegrityIdentifier: `sha256:${'c'.repeat(64)}`,
                originRunId: 'run-1',
                originTurnId: state.turn.turnId,
                originToolCallId: 'start',
                attempt: 1,
              },
            },
          },
        },
      },
    };
    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
  });

  for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
    test(`waits for a required background ${terminalStatus} wake without polling the model`, async () => {
      const state = activePlanningState();
      state.transcript.final = 'Premature final.';
      state.tools.calls.background = {
        toolCallId: 'background',
        modelMessageId: 'model-background',
        name: 'task',
        args: {
          name: 'inspect',
          subagent_type: 'explore',
          task: 'inspect runtime',
          background: true,
          result_disposition: 'required',
        },
        status: 'succeeded',
        createdAtTurnId: state.turn.turnId,
        result: {
          ok: true,
          summary: 'accepted',
          resultMeta: {
            taskId: 'child-wait-1',
            taskStatus: 'running',
            taskDisposition: 'required',
          },
        },
      };
      const hasSecondRequiredChild = terminalStatus !== 'completed';
      if (hasSecondRequiredChild) {
        state.tools.calls['background-second'] = {
          ...state.tools.calls.background,
          toolCallId: 'background-second',
          result: {
            ok: true,
            summary: 'accepted',
            resultMeta: {
              taskId: 'child-wait-2',
              taskStatus: 'running',
              taskDisposition: 'required',
            },
          },
        };
      }
      const kernel = new AgentKernel({
        store: openStateStoreForTest(':memory:'),
        initialState: state,
        interactionMode: 'accept_edits',
      });
      const wakes: Array<
        (
          reason:
            | 'state_changed'
            | 'background_changed'
            | 'managed_shell_changed'
            | 'managed_shell_terminal',
        ) => void
      > = [];
      let modelCalls = 0;
      const stream = runStateRuntimeLoop(
        kernel,
        async () => {
          modelCalls += 1;
          return [{ type: 'model.responded' as const, messageId: 'after-wake', text: 'Done.' }];
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
        10_000,
        undefined,
        undefined,
        undefined,
        undefined,
        async () =>
          new Promise<
            | 'state_changed'
            | 'background_changed'
            | 'managed_shell_changed'
            | 'managed_shell_terminal'
          >((resolve) => {
            wakes.push(resolve);
          }),
      );

      expect((await stream.next()).value).toMatchObject({
        type: 'completion.blocked',
        code: 'tool_pending',
        nextAction: 'wait_for_background',
        backgroundTaskIds: hasSecondRequiredChild
          ? ['child-wait-1', 'child-wait-2']
          : ['child-wait-1'],
      });
      expect(kernel.getState().completionGuard.waitingReason).toEqual({
        kind: 'required_background',
        taskIds: hasSecondRequiredChild ? ['child-wait-1', 'child-wait-2'] : ['child-wait-1'],
      });
      expect(kernel.getState().completionGuard.correctionAttempts).toBe(0);
      const resumed = stream.next();
      await Promise.resolve();
      expect(modelCalls).toBe(0);
      wakes.shift()!('managed_shell_changed');
      await Bun.sleep(0);
      expect(modelCalls).toBe(0);
      expect(wakes).toHaveLength(1);
      wakes.shift()!('state_changed');
      await Bun.sleep(0);
      expect(modelCalls).toBe(0);
      expect(wakes).toHaveLength(1);
      (kernel.getState().tools.calls as Record<string, (typeof state.tools.calls)[string]>).read = {
        toolCallId: 'read',
        modelMessageId: 'model-read',
        name: 'task_read',
        args: { task_id: 'child-wait-1' },
        status: 'succeeded',
        createdAtTurnId: state.turn.turnId,
        result: {
          ok: true,
          summary: terminalStatus,
          resultMeta: { taskId: 'child-wait-1', taskStatus: terminalStatus },
        },
      };
      wakes.shift()!('state_changed');
      if (hasSecondRequiredChild) {
        await Promise.resolve();
        await Promise.resolve();
        expect(modelCalls).toBe(0);
        expect(kernel.getState().completionGuard.waitingReason).toEqual({
          kind: 'required_background',
          taskIds: ['child-wait-1', 'child-wait-2'],
        });
        expect(wakes).toHaveLength(1);
        (kernel.getState().tools.calls as Record<string, (typeof state.tools.calls)[string]>)[
          'read-second'
        ] = {
          toolCallId: 'read-second',
          modelMessageId: 'model-read-second',
          name: 'task_read',
          args: { task_id: 'child-wait-2' },
          status: 'succeeded',
          createdAtTurnId: state.turn.turnId,
          result: {
            ok: true,
            summary: 'completed',
            resultMeta: { taskId: 'child-wait-2', taskStatus: 'completed' },
          },
        };
        wakes.shift()!('background_changed');
      }
      expect((await resumed).value).toMatchObject({
        type: 'model.responded',
        messageId: 'after-wake',
      });
      expect(modelCalls).toBe(1);
      await stream.return(undefined);
      kernel.close();
    });
  }

  for (const ordering of ['steer_before_terminal', 'terminal_before_steer_same_wake'] as const) {
    test(`consumes one steer and wakes the model once when required background races ${ordering}`, async () => {
      const state = activePlanningState();
      const originTurnId = state.turn.turnId;
      state.transcript.final = 'Premature final.';
      state.tools.calls.background = {
        toolCallId: 'background',
        modelMessageId: 'model-background',
        name: 'task',
        args: {
          name: 'inspect',
          subagent_type: 'explore',
          task: 'inspect runtime',
          background: true,
          result_disposition: 'required',
        },
        status: 'succeeded',
        createdAtTurnId: originTurnId,
        result: {
          ok: true,
          summary: 'accepted',
          resultMeta: {
            taskId: 'child-race-1',
            taskStatus: 'running',
            taskDisposition: 'required',
          },
        },
      };
      state.capabilities.invocations.background = {
        invocationId: 'background',
        toolCallId: 'background',
        capabilityId: 'builtin:task',
        capabilityRevision: 'v1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        admissionDigest: 'admission',
        effectiveEffectsDigest: 'effects',
        receiptRequirement: 'observation_receipt',
        attemptsStarted: 1,
        status: 'succeeded',
        reconciliation: 'confirmed_success',
        recordedAt: '2026-09-20T00:00:00.000Z',
        subagentProviderLifecycle: {
          attempt: 1,
          purpose: 'start',
          childInvocationId: 'child-race-1',
          taskArtifact: {
            artifactId: `pa_${'d'.repeat(64)}`,
            kind: 'subagent_task',
            integrityIdentifier: `sha256:${'a'.repeat(64)}`,
            byteLength: 1,
          },
          dispatchIntentDigest: `sha256:${'b'.repeat(64)}`,
          status: 'cleanup_completed',
          recordedAt: '2026-09-20T00:00:00.000Z',
          cleanupAttempt: 1,
          cleanupKind: 'undispatched',
          cleanupStartedAt: '2026-09-20T00:00:00.000Z',
          cleanupConfirmed: true,
          cleanupCompletedAt: '2026-09-20T00:00:00.000Z',
        },
      };
      const kernel = new AgentKernel({
        store: openStateStoreForTest(':memory:'),
        initialState: state,
        interactionMode: 'accept_edits',
      });
      const wakes: Array<
        (
          reason:
            | 'state_changed'
            | 'background_changed'
            | 'managed_shell_changed'
            | 'managed_shell_terminal',
        ) => void
      > = [];
      let modelCalls = 0;
      let modelTurnId: string | undefined;
      let steerCopiesSeenByModel = 0;
      const stream = runStateRuntimeLoop(
        kernel,
        async () => {
          modelCalls += 1;
          const current = kernel.getState();
          modelTurnId = current.turn.turnId;
          steerCopiesSeenByModel = current.transcript.messages.filter(
            (message) => message.kind === 'user' && message.content === 'Use the new constraint.',
          ).length;
          return [
            { type: 'model.responded' as const, messageId: 'after-race', text: 'Done once.' },
          ];
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
        10_000,
        undefined,
        undefined,
        undefined,
        undefined,
        async () =>
          new Promise<
            | 'state_changed'
            | 'background_changed'
            | 'managed_shell_changed'
            | 'managed_shell_terminal'
          >((resolve) => {
            wakes.push(resolve);
          }),
      );

      expect((await stream.next()).value).toMatchObject({
        type: 'completion.blocked',
        nextAction: 'wait_for_background',
        backgroundTaskIds: ['child-race-1'],
      });
      const resumed = stream.next();
      await Promise.resolve();

      const appendSteer = () =>
        kernel.processEvent({
          type: 'user.message_appended',
          messageId: 'steer-race-1',
          content: 'Use the new constraint.',
        });
      const persistTerminal = () =>
        kernel.processEvent({
          type: 'subagent.background_result_persisted',
          taskId: 'child-race-1',
          notificationId: `subagent:child-race-1:sha256:${'c'.repeat(64)}`,
          artifactIntegrityIdentifier: `sha256:${'c'.repeat(64)}`,
          shortReport: 'Child completed.',
          source: 'subagent',
          modelRole: 'user',
          originRunId: originTurnId,
          originTurnId,
          originToolCallId: 'background',
          attempt: 1,
        });

      if (ordering === 'steer_before_terminal') {
        appendSteer();
        wakes.shift()!('state_changed');
        await Bun.sleep(0);
        expect(modelCalls).toBe(0);
        expect(wakes).toHaveLength(1);
        persistTerminal();
        wakes.shift()!('background_changed');
      } else {
        persistTerminal();
        appendSteer();
        wakes.shift()!('background_changed');
      }

      expect((await resumed).value).toMatchObject({
        type: 'model.responded',
        messageId: 'after-race',
      });
      expect(modelCalls).toBe(1);
      expect(modelTurnId).toBe(originTurnId);
      expect(steerCopiesSeenByModel).toBe(1);
      expect(
        kernel
          .getState()
          .transcript.messages.filter(
            (message) => message.kind === 'user' && message.content === 'Use the new constraint.',
          ),
      ).toHaveLength(1);
      await Bun.sleep(0);
      expect(modelCalls).toBe(1);
      await stream.return(undefined);
      kernel.close();
    });
  }

  test('classifies only the current required finite Shell terminal as a model wake', () => {
    const state = activePlanningState();
    state.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'model-shell',
      name: 'shell_execute',
      args: { command: 'sleep 5' },
      status: 'succeeded',
      createdAtTurnId: state.turn.turnId,
      result: {
        ok: true,
        summary: 'running',
        resultMeta: { shellId: 'shell-required', shellStatus: 'running' },
      },
    };
    const execution = {
      executionId: 'shell-required',
      sessionId: state.session.threadId,
      kind: 'shell' as const,
      status: 'completed' as const,
      ownerGeneration: 'owner-1',
      revision: 2,
      cleanupConfirmed: true,
      cursor: 0,
    };
    expect(hasTerminalRequiredManagedShell(state, [execution])).toBe(true);
    expect(
      hasTerminalRequiredManagedShell(state, [
        { ...execution, status: 'running', cleanupConfirmed: false },
      ]),
    ).toBe(false);
    expect(
      hasTerminalRequiredManagedShell(state, [
        { ...execution, executionId: 'other-shell', kind: 'service' },
      ]),
    ).toBe(false);
  });

  test('admits an exact auto-review start after unrelated background progress', () => {
    let state = activePlanningState();
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'reviewed-shell',
      name: 'shell_execute',
      args: { command: 'sleep 5' },
    });
    state = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'review-concurrent',
      toolCallId: 'reviewed-shell',
      toolName: 'shell_execute',
      reason: 'Shell requires review.',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      owner: { kind: 'root_tool', toolCallId: 'reviewed-shell' },
      approval: {
        scope: 'once',
        cwd: '/tmp',
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'sleep 5',
        risk: 'unknown',
        approvalHash: 'review-concurrent-hash',
        summary: 'Run a shell command.',
        reason: 'Shell requires review.',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    });
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const lease = kernel.beginEffect({
      type: 'run_auto_review',
      reviewId: 'review-concurrent',
      toolCallId: 'reviewed-shell',
    });
    kernel.processEvent({
      type: 'model.cache_metrics',
      inputTokens: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 1,
      hitRate: 0,
    });
    expect(
      kernel.applyEffectEvent(lease, {
        type: 'auto_review.started',
        reviewId: 'review-concurrent',
        toolCallId: 'reviewed-shell',
        owner: { kind: 'root_tool', toolCallId: 'reviewed-shell' },
      }),
    ).toBe(true);
    kernel.close();
  });

  test('ignores Task-owned Skill and suspended child blockers from an older Task', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'completion-old-control-state',
      userId: 'u',
      workspace: '/tmp',
    });
    state.activeTaskId = 'current-task';
    state.tasks = {
      'current-task': {
        taskId: 'current-task',
        userGoal: 'finish',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    };
    state.tools.calls.old = {
      toolCallId: 'old',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'task',
      args: {},
      status: 'awaiting_approval',
      createdAtTurnId: 'older-turn',
    };
    state.suspendedSubagents.old = {} as never;
    state.skills.frames.old = {
      activationId: 'old',
      skillId: 'old-skill',
      skillRevision: '1',
      taskId: 'older-task',
      input: {},
      contextMode: 'inline',
      agent: 'main',
      capabilityCeiling: [],
      verificationMode: 'not_required',
      requestedBy: 'user',
      activatedAt: '2026-08-14T00:00:00.000Z',
      status: 'active',
    };

    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
  });

  test('ignores a suspended snapshot whose current parent Tool is already terminal', () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'completion-terminal-suspension',
      userId: 'u',
      workspace: '/tmp',
    });
    state.tools.calls.terminal = {
      toolCallId: 'terminal',
      modelMessageId: 'model-terminal',
      name: 'task',
      args: {},
      status: 'cancelled',
      createdAtTurnId: state.turn.turnId,
    };
    state.suspendedSubagents.terminal = {} as never;

    expect(decideUnplannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
  });

  test('uses exactly one correction, then ends as blocked instead of completed', async () => {
    const store = openStateStoreForTest(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: activePlanningState(),
      interactionMode: 'accept_edits',
    });
    let modelCalls = 0;
    const events: string[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async () => {
        modelCalls++;
        return [
          { type: 'model.responded' as const, messageId: `final-${modelCalls}`, text: 'Done.' },
        ];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(modelCalls).toBe(2);
    expect(events).toEqual([
      'model.responded',
      'completion.blocked',
      'model.responded',
      'completion.blocked',
      'turn.aborted',
      'run.error',
    ]);
    expect(events).not.toContain('run.completed');
    expect(kernel.getState().tasks[kernel.getState().activeTaskId!]?.status).toBe('active');
    kernel.close();
  });

  test('closes only the turn when a reviewed draft intentionally remains pending', async () => {
    const pausedPlanDigest = computePlanStructuralDigest({
      title: 'Paused plan',
      bodyMarkdown: 'Keep the complete reviewed plan available for a later user turn.',
      steps: [{ id: 'later', title: 'Implement later', status: 'pending' }],
    });
    const initial = setActivePlanning(activePlanningState(), {
      kind: 'planning_draft',
      document: currentPlanDocument({
        planId: 'paused-plan',
        version: 1,
        structuralDigest: pausedPlanDigest,
        title: 'Paused plan',
        bodyMarkdown: 'Keep the complete reviewed plan available for a later user turn.',
        steps: [{ id: 'later', title: 'Implement later', status: 'pending' }],
        createdAtTurnId: 'turn-1',
        updatedAtTurnId: 'turn-1',
      }),
      revisionFeedback: 'Do not implement yet.',
    });
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    let modelCalls = 0;
    const events: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async () => {
        modelCalls += 1;
        return [
          {
            type: 'model.responded' as const,
            messageId: `paused-final-${modelCalls}`,
            text: 'Understood. The plan remains paused.',
          },
        ];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      'model.responded',
      'completion.blocked',
      'turn.completed',
    ]);
    expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    expect(events.some((event) => event.type === 'run.error')).toBe(false);
    expect(kernel.getState().turn.status).toBe('completed');
    expect(kernel.getState().activeTaskId).toBe(initial.activeTaskId);
    expect(getActivePlanning(kernel.getState() as RuntimeState)).toMatchObject({
      kind: 'planning_draft',
      revisionFeedback: 'Do not implement yet.',
    });
    kernel.close();
  });
});

describe('CompletionGuard V2', () => {
  test('a reviewed V2 draft can pause on its first plain-text final', () => {
    const { state, document, identity } = v2ExecutingState({});
    const draft = setActivePlanning(state, {
      kind: 'planning_draft',
      document,
      revisionFeedback: '先不实施',
    });

    expect(decidePlannedCompletion(draft)).toMatchObject({
      status: 'blocked',
      code: 'plan_draft_pending',
      correctionAttempt: 1,
      canCorrect: false,
      planIdentity: identity,
    });
  });

  test('selects V2 only for V2 PlanDocuments and reports missing required verification', () => {
    const { state, identity } = v2ExecutingState({ requiredVerification: 'pending' });
    expect(decideCompletion(state)).toEqual(decidePlannedCompletion(state));
    expect(decidePlannedCompletion(state)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v2',
      code: 'verification_required',
      nextAction: 'complete_verification',
      planIdentity: identity,
      correctionAttempt: 1,
    });
    expect(decideUnplannedCompletion(state)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v1',
      code: 'plan_execution_incomplete',
    });
  });

  test('reports missing effect evidence after required verification passes', () => {
    const { state, identity } = v2ExecutingState({
      requiredVerification: 'passed',
      sideEffectsStarted: true,
    });
    expect(decidePlannedCompletion(state)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v2',
      code: 'effect_evidence_required',
      nextAction: 'record_effect_evidence',
      planIdentity: identity,
    });
  });

  test('reports verification_required when a passed required record lacks its evidence reference', () => {
    const fixture = v2ExecutingState({ requiredVerification: 'passed' });
    const document = {
      ...fixture.document,
      completionEvidence: {
        ...fixture.document.completionEvidence,
        verification: [],
      },
    };
    const state = setActivePlanning(fixture.state, {
      kind: 'executing',
      document,
      executionMode: 'auto',
      approvedAtTurnId: fixture.state.turn.turnId,
    });
    expect(decidePlannedCompletion(state)).toMatchObject({
      status: 'blocked',
      code: 'verification_required',
      nextAction: 'complete_verification',
      planIdentity: fixture.identity,
    });
  });

  test('fails closed when a claimed V2 document no longer matches its structural digest', () => {
    const fixture = v2ExecutingState({ sideEffectsStarted: true });
    const state = setActivePlanning(fixture.state, {
      kind: 'executing',
      document: { ...fixture.document, structuralDigest: 'f'.repeat(64) },
      executionMode: 'auto',
      approvedAtTurnId: fixture.state.turn.turnId,
    });
    expect(decideCompletion(state)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v2',
      code: 'plan_evidence_unresolved',
      nextAction: 'resolve_plan_evidence',
      planIdentity: { ...fixture.identity, structuralDigest: 'f'.repeat(64) },
    });
  });

  test('task-wide interaction blockers take priority over malformed V2 evidence', () => {
    const fixture = v2ExecutingState({ sideEffectsStarted: true });
    const malformed = setActivePlanning(fixture.state, {
      kind: 'executing',
      document: { ...fixture.document, structuralDigest: 'f'.repeat(64) },
      executionMode: 'auto',
      approvedAtTurnId: fixture.state.turn.turnId,
    });
    const state = {
      ...malformed,
      tools: {
        ...malformed.tools,
        calls: {
          ...malformed.tools.calls,
          'priority-tool': {
            toolCallId: 'priority-tool',
            taskId: malformed.activeTaskId ?? undefined,
            modelMessageId: 'priority-model',
            name: 'ask_user',
            args: {},
            status: 'awaiting_user_input' as const,
            createdAtTurnId: malformed.turn.turnId,
          },
        },
      },
      interactions: {
        kind: 'awaiting_user_input' as const,
        interactionId: 'priority-interaction',
        toolCallId: 'priority-tool',
        request: { question: 'Choose a correction.', options: [], allow_free_text: true },
      },
    };
    expect(decidePlannedCompletion(state)).toMatchObject({
      status: 'blocked',
      version: 'completion_guard_v2',
      code: 'interaction_pending',
      nextAction: 'wait_for_interaction',
      planIdentity: { ...fixture.identity, structuralDigest: 'f'.repeat(64) },
    });
  });

  test('accepts a completed V2 plan only when metadata evidence matches Runtime state', () => {
    const fixture = v2ExecutingState({
      sideEffectsStarted: true,
      executionEvidence: true,
    });
    const state = setActivePlanning(fixture.state, {
      kind: 'completed',
      document: fixture.document,
      completedAtTurnId: fixture.state.turn.turnId,
    });
    expect(decidePlannedCompletion(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v2',
      planIdentity: fixture.identity,
    });
  });

  test('does not let an older task tool mask the active V2 plan lifecycle', () => {
    const fixture = v2ExecutingState({ sideEffectsStarted: false });
    fixture.state.tools.calls.historical = {
      toolCallId: 'historical',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'write_plan',
      args: {},
      status: 'awaiting_review',
      createdAtTurnId: 'older-turn',
    };

    expect(decidePlannedCompletion(fixture.state)).toMatchObject({
      status: 'blocked',
      code: 'plan_execution_incomplete',
      nextAction: 'complete_plan',
    });
  });

  test('current V2 state rejects payloads that self-report a legacy V1 guard version', () => {
    const fixture = v2ExecutingState({
      sideEffectsStarted: true,
      executionEvidence: true,
    });
    const completed = setActivePlanning(fixture.state, {
      kind: 'completed',
      document: fixture.document,
      completedAtTurnId: fixture.state.turn.turnId,
    });
    const missingIdentity = reduceRuntimeState(completed, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'candidate',
      completionGuardVersion: 'completion_guard_v2',
    });
    expect(missingIdentity.activeTaskId).toBe(completed.activeTaskId);

    const missingVersion = reduceRuntimeState(completed, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'candidate',
    });
    expect(missingVersion.activeTaskId).toBe(completed.activeTaskId);

    const wrongIdentity = reduceRuntimeState(completed, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'candidate',
      completionGuardVersion: 'completion_guard_v2',
      planIdentity: { ...fixture.identity, structuralDigest: 'd'.repeat(64) },
    });
    expect(wrongIdentity.activeTaskId).toBe(completed.activeTaskId);

    const accepted = reduceRuntimeState(completed, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'candidate',
      completionGuardVersion: 'completion_guard_v2',
      planIdentity: fixture.identity,
    });
    expect(accepted.activeTaskId).toBeNull();

    const replayed = reduceRuntimeState(completed, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'legacy candidate',
      completionGuardVersion: 'completion_guard_v1',
    });
    expect(replayed.activeTaskId).toBe(completed.activeTaskId);
  });

  test('current completion rejects stale V1 and V2 turn identities after a successor turn starts', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'stale-v1-guard',
      userId: 'u',
      workspace: '/tmp',
    });
    const unplanned = reduceRuntimeState(initial, {
      type: 'task.started',
      taskId: 'stale-v1-task',
      userGoal: 'Complete without entering Plan Mode.',
      turnId: initial.turn.turnId,
    });
    expect(getActivePlanning(unplanned).kind).toBe('building_without_plan');
    expect(decideUnplannedCompletion(unplanned).status).toBe('accepted');
    const unplannedStale = reduceRuntimeState(unplanned, {
      type: 'run.completed',
      turnId: 'stale-turn',
      output: 'stale legacy candidate',
      completionGuardVersion: 'completion_guard_v1',
    });
    expect(unplannedStale.activeTaskId).toBe(unplanned.activeTaskId);

    const fixture = v2ExecutingState({ sideEffectsStarted: true, executionEvidence: true });
    const completed = setActivePlanning(fixture.state, {
      kind: 'completed',
      document: fixture.document,
      completedAtTurnId: fixture.state.turn.turnId,
    });
    const successor = reduceRuntimeState(completed, {
      type: 'turn.started',
      turnId: 'successor-turn',
    });
    const plannedStale = reduceRuntimeState(successor, {
      type: 'run.completed',
      turnId: completed.turn.turnId,
      output: 'stale V2 candidate',
      completionGuardVersion: 'completion_guard_v2',
      planIdentity: fixture.identity,
    });
    expect(plannedStale.activeTaskId).toBe(completed.activeTaskId);
    expect(plannedStale.turn.turnId).toBe('successor-turn');
  });

  test('resets the correction attempt when strict V2 Plan identity changes', () => {
    const fixture = v2ExecutingState({ sideEffectsStarted: true });
    const first = decidePlannedCompletion(fixture.state);
    if (first.status !== 'blocked') throw new Error('expected blocked V2 decision');
    const afterFirst = reduceRuntimeState(fixture.state, {
      type: 'completion.blocked',
      turnId: fixture.state.turn.turnId,
      guardVersion: first.version,
      code: first.code,
      nextAction: first.nextAction,
      planning: first.planning,
      correctionAttempt: first.correctionAttempt,
      planIdentity: first.planIdentity,
    });
    expect(afterFirst.completionGuard).toMatchObject({
      correctionAttempts: 1,
      guardVersion: 'completion_guard_v2',
      planIdentity: fixture.identity,
    });

    const nextDocument = {
      ...fixture.document,
      version: fixture.document.version + 1,
    };
    const replanned = setActivePlanning(afterFirst, {
      kind: 'executing',
      document: nextDocument,
      executionMode: 'auto',
      approvedAtTurnId: afterFirst.turn.turnId,
    });
    expect(decidePlannedCompletion(replanned)).toMatchObject({
      status: 'blocked',
      correctionAttempt: 1,
      planIdentity: {
        planId: fixture.identity.planId,
        version: fixture.identity.version + 1,
        structuralDigest: fixture.identity.structuralDigest,
      },
    });
  });

  test('preserves the same V2 identity correction ceiling across a new turn and restore', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-completion-v2-correction-'));
    const storePath = join(root, 'runtime.db');
    const fixture = v2ExecutingState({ sideEffectsStarted: true });
    const first = decidePlannedCompletion(fixture.state);
    if (first.status !== 'blocked') throw new Error('expected blocked V2 decision');
    const store = openStateStoreForTest(storePath);
    const kernel = new AgentKernel({
      store,
      initialState: fixture.state,
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'completion.blocked',
      turnId: fixture.state.turn.turnId,
      guardVersion: first.version,
      code: first.code,
      nextAction: first.nextAction,
      planning: first.planning,
      correctionAttempt: first.correctionAttempt,
      planIdentity: first.planIdentity,
    });
    kernel.processEvent({ type: 'turn.started', turnId: 'next-turn-same-plan' });
    expect(decidePlannedCompletion(kernel.getState())).toMatchObject({
      status: 'blocked',
      correctionAttempt: 2,
      planIdentity: fixture.identity,
    });
    kernel.close();

    const restored = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: fixture.state.session.threadId,
      userId: fixture.state.session.userId,
      workspace: fixture.state.session.workspace,
      store: openStateStoreForTest(storePath),
    });
    expect(decidePlannedCompletion(restored.getState())).toMatchObject({
      status: 'blocked',
      correctionAttempt: 2,
      planIdentity: fixture.identity,
    });
    restored.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a new user message opens a fresh bounded correction window for the same V2 Plan', () => {
    const fixture = v2ExecutingState({ sideEffectsStarted: true });
    const first = decidePlannedCompletion(fixture.state);
    if (first.status !== 'blocked') throw new Error('expected blocked V2 decision');
    const blocked = reduceRuntimeState(fixture.state, {
      type: 'completion.blocked',
      turnId: fixture.state.turn.turnId,
      guardVersion: first.version,
      code: first.code,
      nextAction: first.nextAction,
      planning: first.planning,
      correctionAttempt: first.correctionAttempt,
      planIdentity: first.planIdentity,
    });
    const withUserDirection = reduceRuntimeState(blocked, {
      type: 'user.message_appended',
      messageId: 'user-revision-direction',
      content: '请按新的要求修改方案。',
    });
    const nextTurn = reduceRuntimeState(withUserDirection, {
      type: 'turn.started',
      turnId: 'next-user-authored-turn',
    });

    expect(withUserDirection.completionGuard).toEqual({ correctionAttempts: 0 });
    expect(decidePlannedCompletion(nextTurn)).toMatchObject({
      status: 'blocked',
      correctionAttempt: 1,
      planIdentity: fixture.identity,
    });
  });

  test('aborts the second illegal final for the same V2 plan identity', async () => {
    const { state, identity } = v2ExecutingState({ sideEffectsStarted: true });
    const store = openStateStoreForTest(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const emitted = [];
    let modelCalls = 0;
    for await (const event of runStateRuntimeLoop(
      kernel,
      async () => {
        modelCalls++;
        return [{ type: 'model.responded' as const, messageId: `v2-${modelCalls}`, text: 'Done.' }];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }

    expect(modelCalls).toBe(2);
    expect(
      emitted
        .filter((event) => event.type === 'completion.blocked')
        .map((event) => ({
          guardVersion: event.guardVersion,
          code: event.code,
          correctionAttempt: event.correctionAttempt,
          planIdentity: event.planIdentity,
        })),
    ).toEqual([
      {
        guardVersion: 'completion_guard_v2',
        code: 'effect_evidence_required',
        correctionAttempt: 1,
        planIdentity: identity,
      },
      {
        guardVersion: 'completion_guard_v2',
        code: 'effect_evidence_required',
        correctionAttempt: 2,
        planIdentity: identity,
      },
    ]);
    expect(emitted.map((event) => event.type)).toEqual([
      'model.responded',
      'completion.blocked',
      'model.responded',
      'completion.blocked',
      'turn.aborted',
      'run.error',
    ]);
    expect(emitted.some((event) => event.type === 'run.completed')).toBe(false);
    kernel.close();
  });

  test('persists the non-correctable blocked terminal batch before yielding attempt two', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-completion-v2-terminal-batch-'));
    const storePath = join(root, 'runtime.db');
    const { state } = v2ExecutingState({ sideEffectsStarted: true });
    const kernel = new AgentKernel({
      store: openStateStoreForTest(storePath),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    let modelCalls = 0;
    const observed: string[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async () => {
        modelCalls++;
        return [
          { type: 'model.responded' as const, messageId: `atomic-${modelCalls}`, text: 'Done.' },
        ];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      observed.push(event.type);
      if (event.type === 'completion.blocked' && event.correctionAttempt === 2) {
        expect(kernel.getState().turn.status).toBe('aborted');
        expect(decideNextEffect(kernel.getState()).type).toBe('stop');
        break;
      }
    }
    expect(modelCalls).toBe(2);
    expect(observed).not.toContain('run.completed');
    expect(
      kernel.runtimeStore
        .loadEventsStrict(state.session.threadId)
        .slice(-3)
        .map((entry) => entry.event.type),
    ).toEqual(['completion.blocked', 'turn.aborted', 'run.error']);
    kernel.close();

    const restored = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: state.session.threadId,
      userId: state.session.userId,
      workspace: state.session.workspace,
      store: openStateStoreForTest(storePath),
    });
    let restartModelCalls = 0;
    const restartedEvents: string[] = [];
    for await (const event of runStateRuntimeLoop(
      restored,
      async () => {
        restartModelCalls++;
        return [{ type: 'model.responded' as const, messageId: 'unexpected-third', text: 'Done.' }];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      restartedEvents.push(event.type);
    }
    expect(restored.getState().turn.status).toBe('aborted');
    expect(decideNextEffect(restored.getState()).type).toBe('stop');
    expect(restartModelCalls).toBe(0);
    expect(restartedEvents).not.toContain('run.completed');
    restored.close();
    rmSync(root, { recursive: true, force: true });
  });
});
