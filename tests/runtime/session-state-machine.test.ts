import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRuntimeHostState26InitialStateV1,
  getActivePlanning,
  type RuntimeState,
  type ToolCallStatus,
} from '@kite/runtime-host';
import {
  eventsForSupersededTurnRecovery,
  type RuntimeUserAction,
} from '#app/bootstrap/runtime/state26-actions';
import { reduceRuntimeState } from '#runtime-support/runtime-state26-reducer';
import {
  State26HostSessionHarnessV1 as AgentKernel,
  restoreState26HostSessionHarnessV1 as restoreState26KernelCoordinatorV1,
} from '../../scripts/support/runtime-host-state26';
import { openState26Store5ForTestV1 } from '../../scripts/support/runtime-storage';
import { decideNextEffect } from '../helpers/agent-kernel-scheduler';
import { currentPlanDocument } from '../helpers/current-plan';

type InteractionCase = {
  name: string;
  initial(): RuntimeState;
  action: RuntimeUserAction;
  expectedToolStatus: ToolCallStatus;
};

function waitingToolState(kind: 'input' | 'approval' | 'plan', toolCallId: string): RuntimeState {
  const state = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `state-machine-${kind}`,
    userId: 'user',
    workspace: '/workspace',
    phase: kind === 'plan' ? 'planning' : 'building',
  });
  state.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: `${toolCallId}-model`,
    name: kind === 'input' ? 'ask_user' : kind === 'plan' ? 'write_plan' : 'shell_execute',
    args: {},
    status:
      kind === 'input'
        ? 'awaiting_user_input'
        : kind === 'plan'
          ? 'awaiting_review'
          : 'awaiting_approval',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, toolCallId];
  if (kind === 'input') {
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input-interaction',
      toolCallId,
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
  } else if (kind === 'approval') {
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-interaction',
      toolCallId,
      approval: {
        scope: 'once',
        cwd: '/workspace',
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'approval-hash',
        summary: 'Run pwd',
        reason: 'State-machine test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };
  } else {
    const document = currentPlanDocument({
      planId: 'plan-state-machine',
      version: 1,
      title: 'Stabilize the session state machine',
      bodyMarkdown: 'Exercise every durable plan review terminal transition.',
      steps: [{ id: 'verify', title: 'Verify transitions', status: 'pending' as const }],
      structuralDigest: 'plan-state-machine-digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    });
    state.activeTaskId = 'plan-task';
    state.tasks['plan-task'] = {
      taskId: 'plan-task',
      userGoal: 'Review the current Plan.',
      status: 'active',
      startedAtTurnId: state.turn.turnId,
      sideEffectsStarted: false,
      planning: {
        kind: 'awaiting_review',
        document,
        interactionId: 'plan-interaction',
        exitToolCallId: toolCallId,
      },
      planHistory: [],
    };
    state.interactions = {
      kind: 'awaiting_review',
      interactionId: 'plan-interaction',
      toolCallId,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: {
        name: document.title,
        description: document.bodyMarkdown,
        status: 'pending',
        steps: document.steps.map((step) => ({
          id: step.id,
          step: step.title,
          status: step.status,
        })),
      },
      planSummary: document.bodyMarkdown,
    };
  }
  return state;
}

function stableProjection(state: RuntimeState) {
  return {
    interaction: state.interactions.kind,
    turn: state.turn.status,
    toolStatuses: Object.fromEntries(
      Object.entries(state.tools.calls).map(([id, call]) => [id, call.status]),
    ),
    planning: getActivePlanning(state).kind,
    nextEffect: decideNextEffect(state).type,
  };
}

function crossTaskResidueState(): RuntimeState {
  const state = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'state-machine-cross-task',
    userId: 'user',
    workspace: '/workspace',
  });
  state.activeTaskId = 'current-task';
  state.tasks = {
    'older-task': {
      taskId: 'older-task',
      userGoal: 'old',
      status: 'cancelled',
      startedAtTurnId: 'older-turn',
      sideEffectsStarted: false,
      planning: { kind: 'building_without_plan' },
      planHistory: [],
    },
    'current-task': {
      taskId: 'current-task',
      userGoal: 'current',
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
  state.tools.queue = [...state.tools.queue, 'old'];
  state.transcript.messages = [
    ...state.transcript.messages,
    {
      kind: 'assistant',
      messageId: 'older-model',
      turnId: 'older-turn',
      ordinal: 0,
      createdAt: '2026-08-18T00:00:00.000Z',
      toolCalls: [{ id: 'old', name: 'task', args: {} }],
    },
  ];
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'old-interaction',
    toolCallId: 'old',
    approval: {} as never,
  };
  state.suspendedSubagents.old = {
    storage: 'private_artifact_v1',
    subagentId: 'old-subagent',
    role: 'review',
    continuationId: `continuation-${'a'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: 'old-parent-invocation',
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
      toolCallId: 'old-child-tool',
      toolName: 'shell_execute',
    },
  };
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
  return state;
}

function crossTaskProjection(state: RuntimeState) {
  return {
    stable: stableProjection(state),
    oldTool: state.tools.calls.old?.status,
    oldSuspensionPresent: state.suspendedSubagents.old != null,
    currentSkillIds: Object.values(state.skills.frames)
      .filter((frame) => frame.status === 'active' && frame.taskId === state.activeTaskId)
      .map((frame) => frame.activationId),
  };
}

const cases: InteractionCase[] = [
  {
    name: 'ask_user answered',
    initial: () => waitingToolState('input', 'ask-tool'),
    action: {
      type: 'input',
      interactionId: 'input-interaction',
      text: 'continue',
    },
    expectedToolStatus: 'succeeded',
  },
  {
    name: 'ask_user cancelled',
    initial: () => waitingToolState('input', 'ask-tool'),
    action: { type: 'cancel', interactionId: 'input-interaction' },
    expectedToolStatus: 'failed',
  },
  {
    name: 'tool approval granted',
    initial: () => waitingToolState('approval', 'approval-tool'),
    action: {
      type: 'approve',
      interactionId: 'approval-interaction',
      grant: 'approve_once',
    },
    expectedToolStatus: 'approved',
  },
  {
    name: 'tool approval rejected',
    initial: () => waitingToolState('approval', 'approval-tool'),
    action: { type: 'reject', interactionId: 'approval-interaction' },
    expectedToolStatus: 'rejected',
  },
  {
    name: 'plan approved',
    initial: () => waitingToolState('plan', 'plan-tool'),
    action: {
      type: 'plan_review_decision',
      interactionId: 'plan-interaction',
      planId: 'plan-state-machine',
      version: 1,
      structuralDigest: 'plan-state-machine-digest',
      decision: { kind: 'approve', nextMode: 'auto' },
    },
    expectedToolStatus: 'succeeded',
  },
  {
    name: 'plan revision requested',
    initial: () => waitingToolState('plan', 'plan-tool'),
    action: {
      type: 'plan_review_decision',
      interactionId: 'plan-interaction',
      planId: 'plan-state-machine',
      version: 1,
      structuralDigest: 'plan-state-machine-digest',
      decision: { kind: 'revise', feedback: 'Keep planning.' },
    },
    expectedToolStatus: 'succeeded',
  },
  {
    name: 'plan review cancelled',
    initial: () => waitingToolState('plan', 'plan-tool'),
    action: {
      type: 'plan_review_decision',
      interactionId: 'plan-interaction',
      planId: 'plan-state-machine',
      version: 1,
      structuralDigest: 'plan-state-machine-digest',
      decision: { kind: 'cancel', reason: 'Stop this turn.' },
    },
    expectedToolStatus: 'cancelled',
  },
];

describe('session state-machine terminal matrix', () => {
  for (const scenario of cases) {
    test(`${scenario.name} has identical live, replay, and restart projections`, () => {
      const directory = mkdtempSync(join(process.cwd(), '.kite-session-state-machine-'));
      const storePath = join(directory, 'runtime.sqlite');
      const initial = scenario.initial();
      const store = openState26Store5ForTestV1(storePath);
      store.saveSnapshot(initial.session.threadId, initial);
      const kernel = new AgentKernel({
        store,
        initialState: structuredClone(initial),
        interactionMode: 'accept_edits',
        sandboxAvailable: true,
      });

      try {
        const applied = kernel.applyAction(scenario.action);
        expect(applied.status).toBe('applied');
        if (applied.status !== 'applied') return;
        const live = kernel.getState();
        expect(Object.values(live.tools.calls).map((call) => call.status)).toContain(
          scenario.expectedToolStatus,
        );
        expect(live.interactions.kind).toBe('idle');

        let replay = structuredClone(initial);
        for (const event of applied.events) replay = reduceRuntimeState(replay, event);
        expect(stableProjection(replay)).toEqual(stableProjection(live));

        kernel.close();
        const restored = restoreState26KernelCoordinatorV1({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: initial.session.threadId,
          userId: initial.session.userId,
          workspace: initial.session.workspace,
          store: openState26Store5ForTestV1(storePath),
          interactionMode: 'accept_edits',
          sandboxAvailable: true,
        });
        try {
          expect(stableProjection(restored.getState())).toEqual(stableProjection(live));
        } finally {
          restored.close();
        }
      } finally {
        try {
          kernel.close();
        } catch {
          // The success path closes before restart.
        }
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test('cross-Task residue recovery is identical live, replayed, and after restart', () => {
    const directory = mkdtempSync(join(process.cwd(), '.kite-session-cross-task-'));
    const storePath = join(directory, 'runtime.sqlite');
    const initial = crossTaskResidueState();
    const store = openState26Store5ForTestV1(storePath);
    store.saveSnapshot(initial.session.threadId, initial);
    const kernel = new AgentKernel({
      store,
      initialState: structuredClone(initial),
      interactionMode: 'accept_edits',
      sandboxAvailable: true,
    });

    try {
      const events = kernel.processEventBatch(eventsForSupersededTurnRecovery(kernel.getState()));
      expect(events.some((event) => event.type === 'tool.cancelled')).toBe(true);
      const live = kernel.getState();
      expect(crossTaskProjection(live)).toMatchObject({
        stable: { interaction: 'idle', turn: 'aborted', nextEffect: 'stop' },
        oldTool: 'cancelled',
        oldSuspensionPresent: false,
        currentSkillIds: [],
      });

      let replay = structuredClone(initial);
      for (const event of events) replay = reduceRuntimeState(replay, event);
      expect(crossTaskProjection(replay)).toEqual(crossTaskProjection(live));

      kernel.close();
      const restored = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: initial.session.threadId,
        userId: initial.session.userId,
        workspace: initial.session.workspace,
        store: openState26Store5ForTestV1(storePath),
        interactionMode: 'accept_edits',
        sandboxAvailable: true,
      });
      try {
        expect(crossTaskProjection(restored.getState())).toEqual(crossTaskProjection(live));
      } finally {
        restored.close();
      }
    } finally {
      try {
        kernel.close();
      } catch {
        // The success path closes before restart.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
