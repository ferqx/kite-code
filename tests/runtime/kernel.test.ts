import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';

describe('AgentKernel durability', () => {
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
  ]);
  kernel.close();
});
