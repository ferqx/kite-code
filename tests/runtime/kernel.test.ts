import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import {
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';

describe('AgentKernel durability', () => {
  test('migrates schema 11 snapshots with an empty required-provider admission state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-provider-admission-migration-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'provider-admission-migration',
        userId: 'user',
        workspace: '/workspace',
      });
      const { providerAdmission: _admission, ...schema11 } = state;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(state.session.threadId, { ...schema11, schemaVersion: 11 });
      store.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().providerAdmission).toEqual({ pending: [], waivers: {} });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates and resumes a persisted provider action interaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-provider-action-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'provider-action-restart',
        userId: 'user',
        workspace: '/workspace',
      });
      state.schemaVersion = 10;
      state.tools.calls.mcp = {
        toolCallId: 'mcp',
        modelMessageId: 'model',
        name: 'mcp__github__publish',
        args: {},
        status: 'failed',
        createdAtTurnId: state.turn.turnId,
      };
      state.interactions = {
        kind: 'awaiting_provider_action',
        interactionId: 'provider-action',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'mcp',
        status: 'started',
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(state.session.threadId, state);
      store.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().interactions).toMatchObject({
        kind: 'awaiting_provider_action',
        interactionId: 'provider-action',
        status: 'started',
      });
      expect(decideNextEffect(restored.getState()).type).toBe('request_provider_action');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists a snapshot with each processed event', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'kernel-durability',
        userId: 'user',
        workspace: '/workspace',
      }),
      interactionMode: 'accept_edits',
    });

    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });

    const snapshot =
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('kernel-durability');
    expect(snapshot?.tools.queue).toEqual(['call-1']);
    kernel.close();
  });

  test('marks a persisted invocation without a terminal result as unknown after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-invocation-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = createAgentKernel({
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-1',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const restored = createAgentKernel({
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().capabilities.invocations['invocation-1']).toMatchObject({
        status: 'unknown',
        error: expect.stringContaining('without a terminal result'),
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists reconciliation across a second restart without replaying the invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-reconcile-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-reconcile',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const recovered = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      const action = recovered.applyAction({
        type: 'reconcile_invocation',
        invocationId: 'invocation-reconcile',
        decision: 'confirmed_success',
      });
      expect(action.status).toBe('applied');
      recovered.close();

      const restored = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().capabilities.invocations['invocation-reconcile']).toMatchObject({
        status: 'succeeded',
        reconciliation: 'confirmed_success',
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('runRuntimeLoop resumes a matching input action and persists its facts', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({ threadId: 'loop', userId: 'u', workspace: '/' }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    { type: 'tool.queued', toolCallId: 'accept_edits', name: 'ask_user', args: {} },
    {
      type: 'user_input.requested',
      interactionId: 'input-1',
      toolCallId: 'accept_edits',
      request: { question: 'q', options: [], allow_free_text: true },
    },
  ]);
  const events = [] as string[];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'input', interactionId: 'input-1', text: 'answer' }),
  }))
    events.push(event.type);
  expect(events).toEqual(['user_input.answered', 'tool.finished']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runRuntimeLoop completes provider recovery on a fresh turn without replaying the tool', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'provider-recovery-loop',
    userId: 'u',
    workspace: '/',
  });
  const previousTurnId = initial.turn.turnId;
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    {
      type: 'tool.queued',
      toolCallId: 'mcp-call',
      name: 'mcp__github__publish',
      args: { private: 'not-copied-to-provider-events' },
    },
    {
      type: 'tool.failed',
      toolCallId: 'mcp-call',
      failure: {
        kind: 'provider_auth_required',
        message: 'MCP provider authentication is required.',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: true,
        terminatesTurn: false,
        journal: true,
      },
    },
    {
      type: 'provider.action_required',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp-call',
    },
  ]);

  const events: RuntimeEvent[] = [];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({
      type: 'provider_action_result',
      interactionId: 'provider-action',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-r2',
    }),
  })) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual([
    'provider.action_started',
    'provider.action_completed',
    'turn.started',
  ]);
  expect(kernel.getState().turn.turnId).not.toBe(previousTurnId);
  expect(kernel.getState().tools.calls['mcp-call']?.status).toBe('failed');
  expect(kernel.getState().tools.queue).toEqual([]);
  expect(kernel.getState().tools.active).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('not-copied-to-provider-events');
  kernel.close();
});

test.each([
  'awaiting_user_input',
  'awaiting_tool_approval',
  'awaiting_review',
] as const)('runRuntimeLoop consumes generic cancel for %s without throwing', async (interactionKind) => {
  const store = createRuntimeStore(':memory:');
  const toolCallId =
    interactionKind === 'awaiting_user_input'
      ? 'ask-1'
      : interactionKind === 'awaiting_tool_approval'
        ? 'approval-1'
        : 'plan-1';
  const initial = createInitialRuntimeState({
    threadId: `cancel-${interactionKind}`,
    userId: 'u',
    workspace: '/',
    phase: interactionKind === 'awaiting_review' ? 'planning' : 'building',
  });
  initial.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'model-1',
    name:
      interactionKind === 'awaiting_user_input'
        ? 'ask_user'
        : interactionKind === 'awaiting_tool_approval'
          ? 'shell_execute'
          : 'write_plan',
    args: {},
    status:
      interactionKind === 'awaiting_user_input'
        ? 'awaiting_user_input'
        : interactionKind === 'awaiting_tool_approval'
          ? 'awaiting_approval'
          : 'awaiting_review',
    createdAtTurnId: initial.turn.turnId,
  };
  if (interactionKind === 'awaiting_user_input') {
    initial.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'interaction-1',
      toolCallId,
      request: { question: 'q', options: [], allow_free_text: true },
    };
  } else if (interactionKind === 'awaiting_tool_approval') {
    initial.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'interaction-1',
      toolCallId,
      approval: {
        scope: 'once',
        cwd: '/',
        threadId: initial.session.threadId,
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'approval-hash',
        summary: 'Run pwd',
        reason: 'Test approval cancellation.',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };
  } else {
    const document = {
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A plan to verify cancellation behavior.',
      steps: [{ id: 'step-1', title: 'Verify cancellation', status: 'pending' as const }],
      structuralDigest: 'digest-1',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    };
    initial.planning = {
      kind: 'awaiting_review',
      document,
      interactionId: 'interaction-1',
      exitToolCallId: toolCallId,
    };
    initial.interactions = {
      kind: 'awaiting_review',
      interactionId: 'interaction-1',
      toolCallId,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: {
        name: document.title,
        description: document.bodyMarkdown,
        status: 'pending',
        steps: [],
      },
      planSummary: document.title,
    };
  }

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'cancel', interactionId: 'interaction-1' }),
  })) {
    events.push(event.type);
  }

  expect(events).toContain(
    interactionKind === 'awaiting_tool_approval' ? 'approval.rejected' : 'tool.finished',
  );
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runRuntimeLoop closes a suspended subagent when its approval is cancelled', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'cancel-subagent-approval',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.calls['task-1'] = {
    toolCallId: 'task-1',
    modelMessageId: 'model-1',
    name: 'task',
    args: { task: 'Run a nested command.' },
    status: 'awaiting_approval',
    createdAtTurnId: initial.turn.turnId,
  };
  initial.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'task-1',
    approval: {
      scope: 'once',
      cwd: '/',
      threadId: initial.session.threadId,
      tool: 'shell_execute',
      command: 'pwd',
      risk: 'execute_code',
      approvalHash: 'approval-hash',
      summary: 'Run pwd',
      reason: 'Nested command needs approval.',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      subagentId: 'subagent-1',
    },
  };
  initial.suspendedSubagents['task-1'] = {
    subagentId: 'subagent-1',
    role: 'code',
    task: 'Run a nested command.',
    messages: [],
    toolCallCount: 1,
    steps: [],
    blockedTool: {
      toolCallId: 'nested-1',
      toolName: 'shell_execute',
      args: { command: 'pwd' },
      command: 'pwd',
    },
  };

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'cancel', interactionId: 'approval-1' }),
  })) {
    events.push(event.type);
  }

  expect(events).toEqual(['approval.rejected', 'subagent.failed', 'tool.finished']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  expect(kernel.getState().suspendedSubagents).toEqual({});
  kernel.close();
});

test('runRuntimeLoop persists and yields a durable terminal output event', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({ threadId: 'final', userId: 'u', workspace: '/' }),
    interactionMode: 'accept_edits',
  });
  const events = [] as string[];
  for await (const event of runRuntimeLoop(
    kernel,
    async () => [
      {
        type: 'model.responded' as const,
        messageId: 'answer',
        text: 'finished answer',
      },
    ],
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event.type);
  }

  expect(events).toEqual(['model.responded', 'run.completed', 'turn.completed']);
  expect(store.loadEvents('final').at(-1)?.event).toEqual({
    type: 'turn.completed',
    turnId: kernel.getState().turn.turnId,
  });
  kernel.close();
});

test('runRuntimeLoop applies streamed tool events before the effect completes', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({
      threadId: 'streamed-tool',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvent({
    type: 'tool.queued',
    toolCallId: 'shell-1',
    name: 'shell_execute',
    args: { command: 'printf live' },
  });

  const events: string[] = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'run_tools') return [];
      emit?.({ type: 'tool.started', toolCallId: 'shell-1' });
      emit?.({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'live',
        stream: 'stdout',
      });
      return [
        {
          type: 'tool.finished',
          toolCallId: 'shell-1',
          name: 'shell_execute',
          result: {
            ok: true,
            command: 'printf live',
            exitCode: 0,
            stdout: 'live',
            stderr: '',
          },
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event.type);
    if (event.type === 'tool.progress') {
      expect(kernel.getState().tools.calls['shell-1']?.status).toBe('running');
    }
  }

  expect(events.slice(0, 3)).toEqual(['tool.started', 'tool.progress', 'tool.finished']);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  expect(kernel.getState().tools.queue).not.toContain('shell-1');
  expect(kernel.getState().tools.active).not.toContain('shell-1');
  kernel.close();
});

function legacySubagentApprovalState(threadId: string): RuntimeState {
  const state = createInitialRuntimeState({ threadId, userId: 'u', workspace: '/workspace' });
  state.tools.calls['task-call'] = {
    toolCallId: 'task-call',
    modelMessageId: 'message-1',
    name: 'task',
    args: { task: 'legacy task' },
    status: 'awaiting_approval',
    createdAtTurnId: state.turn.turnId,
  };
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'task-call',
    approval: {
      scope: 'once',
      cwd: '/workspace',
      threadId,
      tool: 'shell_execute',
      command: 'rm -rf generated',
      risk: 'destructive',
      approvalHash: 'legacy-approval',
      summary: 'Run legacy task command',
      reason: 'Approval required',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      subagentId: 'subagent-legacy',
    },
  };
  state.transcript.final = 'resume complete';
  return state;
}

function createRecoveryExecutor() {
  return createRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
  });
}

function recoveryUnavailableState(threadId: string): RuntimeState {
  return {
    ...legacySubagentApprovalState(threadId),
    legacyUnrecoverableSubagentApproval: {
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
      reason: 'A legacy sub-agent approval cannot be resumed after recovery.',
    },
  };
}

function createBatchTrackingStore() {
  const store = createRuntimeStore(':memory:');
  const batches: RuntimeEvent[][] = [];
  const appendEventsAndSnapshot = store.appendEventsAndSnapshot.bind(store);
  store.appendEventsAndSnapshot = (threadId, events, state) => {
    batches.push(events);
    appendEventsAndSnapshot(threadId, events, state);
  };
  return { store, batches };
}

test('AgentKernel.run persists legacy recovery failure events as one atomic batch', async () => {
  const { store, batches } = createBatchTrackingStore();
  const kernel = new AgentKernel({
    store,
    initialState: recoveryUnavailableState('atomic-kernel'),
    interactionMode: 'accept_edits',
  });

  await kernel.run(createRecoveryExecutor());

  expect(batches.map((events) => events.map((event) => event.type))).toEqual([
    ['subagent.failed', 'tool.finished'],
  ]);
  kernel.close();
});

test('migrates a persisted v2 subagent approval and fails it without requesting approval again', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-v2-recovery-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'legacy-recovery';
  try {
    const store = createRuntimeStore(storePath);
    const legacy = legacySubagentApprovalState(threadId);
    const {
      suspendedSubagents: _suspended,
      legacyUnrecoverableSubagentApproval: _marker,
      ...v2
    } = legacy;
    store.saveSnapshot(threadId, { ...v2, schemaVersion: 2 });
    store.close();

    const kernel = createAgentKernel({ threadId, userId: 'u', workspace, storePath });
    expect(kernel.getState().suspendedSubagents).toEqual({});
    expect(kernel.getState().legacyUnrecoverableSubagentApproval).toMatchObject({
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
    });
    expect(decideNextEffect(kernel.getState())).toMatchObject({
      type: 'subagent.recovery_unavailable',
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
    });

    expect((await kernel.run(createRecoveryExecutor())).type).toBe('emit_final');
    const recoveryEvents = kernel.loadEvents(threadId).map(({ event }) => event);
    expect(recoveryEvents).toMatchObject([
      {
        type: 'subagent.failed',
        subagent: { id: 'subagent-legacy', error: expect.stringContaining('cannot be resumed') },
      },
      {
        type: 'tool.finished',
        toolCallId: 'task-call',
        name: 'task',
        result: { ok: false, status: 'error' },
      },
    ]);
    expect(kernel.getState().interactions).toEqual({ kind: 'idle' });
    expect(decideNextEffect(kernel.getState()).type).toBe('emit_final');
    kernel.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runRuntimeLoop executes legacy recovery without asking the action provider', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-v2-loop-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'legacy-loop';
  try {
    const store = createRuntimeStore(storePath);
    const legacy = legacySubagentApprovalState(threadId);
    const {
      suspendedSubagents: _suspended,
      legacyUnrecoverableSubagentApproval: _marker,
      ...v2
    } = legacy;
    store.saveSnapshot(threadId, { ...v2, schemaVersion: 2 });
    store.close();

    const kernel = createAgentKernel({ threadId, userId: 'u', workspace, storePath });
    const emitted: string[] = [];
    for await (const event of runRuntimeLoop(kernel, createRecoveryExecutor(), {
      requestAction: async () => {
        throw new Error('legacy recovery must not request user action');
      },
    })) {
      emitted.push(event.type);
    }

    expect(emitted).toEqual([
      'subagent.failed',
      'tool.finished',
      'run.completed',
      'turn.completed',
    ]);
    expect(kernel.getState().interactions).toEqual({ kind: 'idle' });
    kernel.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runRuntimeLoop persists legacy recovery failure events as one atomic batch', async () => {
  const { store, batches } = createBatchTrackingStore();
  const kernel = new AgentKernel({
    store,
    initialState: recoveryUnavailableState('atomic-runner'),
    interactionMode: 'accept_edits',
  });

  for await (const _event of runRuntimeLoop(kernel, createRecoveryExecutor(), {
    requestAction: async () => {
      throw new Error('legacy recovery must not request user action');
    },
  })) {
    // Consume the generated events so the loop reaches its terminal effect.
  }

  expect(batches.map((events) => events.map((event) => event.type))).toEqual([
    ['subagent.failed', 'tool.finished'],
    ['run.completed'],
    ['turn.completed'],
  ]);
  kernel.close();
});
