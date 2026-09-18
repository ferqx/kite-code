import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeState } from '@kite-ai/agent-kernel';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeClientInteraction,
} from '@kite-ai/runtime-contract';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';
import { createRuntimeOperationGate } from '../../src/runtime-application/operation-gate';

test('projection reads stay read-only during quiesce and command recovery publishes a failed cleanup revision', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-reentry-watermark-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'reentry-watermark-session';
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'reentry-watermark-host',
  });
  let appendOnReentry = false;
  let appended = false;
  let reconciliationCalls = 0;
  const gate = createRuntimeOperationGate();
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    operationGate: gate,
    storageOwner: {
      ...storage,
      loadCurrentSnapshot(id) {
        const state = storage.loadCurrentSnapshot(id);
        return state && appendOnReentry
          ? { ...state, turn: { ...state.turn, turnIndex: Math.max(1, state.turn.turnIndex) } }
          : state;
      },
      async reconcileInterruptedSession(id) {
        reconciliationCalls += 1;
        if (!appendOnReentry || appended) return;
        const state = storage.loadCurrentSnapshot(id);
        if (!state) throw new Error('Expected an existing Session.');
        const revision = state.revision + 1;
        const changedAt = new Date().toISOString();
        storage.commitUnownedInteractionMode(
          {
            sessionId: id,
            events: [{ type: 'interaction_mode.changed', mode: 'full', source: 'user', changedAt }],
            snapshot: { ...state, revision, mode: 'full' },
            commandReceipt: createRuntimeStoredCommandReceipt(
              {
                scopeSessionId: id,
                targetSessionId: id,
                commandId: 'reentry-reconciliation-fact',
                requestDigest: 'a'.repeat(64),
                committedAt: Date.now(),
              },
              revision,
            ),
          },
          state.revision,
        );
        appended = true;
        throw new Error('Resource cleanup failed after persisting a fact.');
      },
    },
    workspaces: [runtimeInput(workspace, 'http://127.0.0.1:1')],
  });
  const runtime = client(server, workspace);
  try {
    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'reentry-watermark-create',
        workspace,
        bootstrapSessionId: sessionId,
      }),
    ).toMatchObject({ status: 'applied' });
    const iterator = runtime
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    try {
      const initial = await Promise.race([
        iterator.next(),
        Bun.sleep(3_000).then(() => {
          throw new Error('Initial subscription timed out.');
        }),
      ]);
      expect(initial.value).toMatchObject({ revision: 0 });
      appendOnReentry = true;
      const lease = await gate.quiesce();
      expect(
        await runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        }),
      ).toMatchObject({ status: 'ok', revision: 0 });
      expect(reconciliationCalls).toBe(0);
      expect(storage.loadCurrentSnapshot(sessionId)?.revision).toBe(0);
      expect(lease.activeOperations).toBe(false);
      lease.resume();
      await expect(
        runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'reentry-watermark-start',
          sessionId,
          expectedRevision: 0,
          input: 'Resume this Session.',
        }),
      ).rejects.toMatchObject({ code: 'protocol_error' });
      expect(reconciliationCalls).toBe(1);
      expect(storage.loadCurrentSnapshot(sessionId)?.revision).toBe(1);
      expect(
        await runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        }),
      ).toMatchObject({ status: 'ok', revision: 1 });
      const latest = await Promise.race([
        iterator.next(),
        Bun.sleep(3_000).then(() => {
          throw new Error('Reentry watermark timed out.');
        }),
      ]);
      expect(latest.value).toMatchObject({ durability: 'durable', revision: 1 });
    } finally {
      await iterator.return?.();
    }
  } finally {
    await runtime.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['explicit cancellation', 'cancelled'],
  ['Session close', 'cancelled'],
  ['Service shutdown', 'interrupted'],
] as const)(
  '%s durably settles every active child once',
  async (stopMode, expectedStatus) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-cancel-children-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const databasePath = join(root, 'kite-session.sqlite');
    const sessionId = 'cancel-active-children';
    const model = createMockModelServer();
    model.setResponses([
      {
        message: {
          tool_calls: [
            {
              id: 'child-one',
              name: 'task',
              args: { name: 'One', subagent_type: 'explore', task: 'Inspect one.' },
            },
            {
              id: 'child-two',
              name: 'task',
              args: { name: 'Two', subagent_type: 'explore', task: 'Inspect two.' },
            },
          ],
        },
        toolContinuation: 'aborted',
      },
      { delay: 5_000, message: { content: 'Child one should be cancelled.' } },
      { delay: 5_000, message: { content: 'Child two should be cancelled.' } },
    ]);
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'cancel-children-host',
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    const runtime = client(server, workspace);
    let disposed = false;
    let reopened:
      | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
      | undefined;
    try {
      expect(
        await runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'create_session',
          commandId: 'cancel-children-create',
          workspace,
          bootstrapSessionId: sessionId,
        }),
      ).toMatchObject({ status: 'applied' });
      expect(
        await runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'cancel-children-start',
          sessionId,
          expectedRevision: 0,
          input: 'Start two child agents and wait.',
        }),
      ).toMatchObject({ status: 'applied' });
      const deadline = Date.now() + 5_000;
      while (model.getRequestCount() < 3 && Date.now() < deadline) await Bun.sleep(10);
      expect(model.getRequestCount()).toBe(3);
      const before = storage.loadCurrentSnapshot(sessionId);
      const run = storage.storage.runs?.getActive(sessionId);
      if (!before || !run) throw new Error('Expected an active Run with two children.');
      if (stopMode === 'Service shutdown') {
        await server[Symbol.asyncDispose]();
        disposed = true;
        reopened = await createKiteSessionAppServerStorageComposition({
          databasePath,
          hostInstanceId: 'cancel-children-verifier',
        });
      } else if (stopMode === 'Session close') {
        expect(
          await runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'close_session',
            commandId: 'cancel-children-close',
            sessionId,
            expectedRevision: before.revision,
          }),
        ).toMatchObject({ status: 'applied' });
      } else {
        expect(
          await runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'cancel_turn',
            commandId: 'cancel-children-stop',
            sessionId,
            runId: run.runId,
            turnId: before.turn.turnId,
            expectedRevision: before.revision,
          }),
        ).toMatchObject({ status: 'applied' });
      }
      const terminalDeadline = Date.now() + 5_000;
      const verifier = reopened ?? storage;
      let events = verifier.storage.sessions
        .loadEventsStrict(sessionId)
        .map((entry) => entry.event);
      while (
        events.filter(
          (event) =>
            event.type === 'subagent.failed' &&
            'subagent' in event &&
            event.subagent.status === expectedStatus,
        ).length < 2 &&
        Date.now() < terminalDeadline
      ) {
        await Bun.sleep(10);
        events = verifier.storage.sessions.loadEventsStrict(sessionId).map((entry) => entry.event);
      }
      const ids = events.flatMap((event) =>
        event.type === 'subagent.started' &&
        'subagent' in event &&
        event.subagent.status === 'creating'
          ? [event.subagent.id]
          : [],
      );
      const terminals = events.filter(
        (event) => event.type === 'subagent.completed' || event.type === 'subagent.failed',
      );
      expect(ids).toHaveLength(2);
      expect(terminals).toHaveLength(2);
      expect(terminals).toEqual(
        ids.map((id) =>
          expect.objectContaining({
            type: 'subagent.failed',
            subagent: expect.objectContaining({ id, status: expectedStatus }),
          }),
        ),
      );
      if (stopMode === 'Session close') {
        await Bun.sleep(20);
        expect(
          await runtime.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'get_session_projection',
            sessionId,
          }),
        ).toMatchObject({ status: 'ok', session: { lifecycle: 'closed' } });
      }
    } finally {
      await runtime.close();
      if (!disposed) await server[Symbol.asyncDispose]();
      reopened?.disposeStorage();
      storage.disposeStorage();
      model.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test('a closed idle Session remains readable without an execution owner', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-idle-close-read-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'idle-close-read';
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'idle-close-host',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [runtimeInput(workspace, 'http://127.0.0.1:1')],
  });
  const runtime = client(server, workspace);
  try {
    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'idle-close-create',
        workspace,
        bootstrapSessionId: sessionId,
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'close_session',
        commandId: 'idle-close-close',
        sessionId,
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await runtime.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      }),
    ).toMatchObject({ status: 'ok' });
  } finally {
    await runtime.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reentering a killed active Session settles its old Run once and permits a new turn', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-session-reentry-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'reentry-interrupted-session';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  model.setResponses([
    {
      message: {
        tool_calls: [
          { id: 'old-shell-call', name: 'shell_execute', args: { command: 'bun test' } },
        ],
      },
      toolContinuation: 'aborted',
    },
    { message: { content: 'new turn completed' } },
  ]);
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'fixtures', 'runtime-pending-approval-child.ts'),
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        KITE_RESTART_TEST_WORKSPACE: workspace,
        KITE_RESTART_TEST_CHECKPOINT: databasePath,
        KITE_RESTART_TEST_SESSION: sessionId,
        KITE_RESTART_TEST_MODEL_URL: model.baseURL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let runtime: RuntimeClient | undefined;
  try {
    const interaction = JSON.parse(await firstLine(child.stdout)) as RuntimeClientInteraction;
    expect(interaction.kind).toBe('approval');
    expect(model.getRequestCount()).toBe(1);
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);

    // The old process is dead. An advanced clock makes its persisted lease
    // expired without a timing-dependent test wait.
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'reentry-successor',
      now: () => Date.now() + 120_000,
    });
    const before = storage.loadCurrentSnapshot(sessionId);
    expect(before?.turn.status).toBe('active');
    const oldRun = storage.storage.runs?.list({ sessionId, limit: 10 }).entries.at(-1);
    if (!oldRun) throw new Error('The killed child did not persist a Run.');
    expect(oldRun.status).not.toBe('completed');

    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    runtime = client(server, workspace);
    const first = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (first.status !== 'ok' || !first.session) throw new Error('Session projection unavailable');
    expect(storage.loadCurrentSnapshot(sessionId)?.turn.status).toBe('active');
    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'reentry-trigger-recovery',
        type: 'start_turn',
        sessionId,
        expectedRevision: first.session.revision,
        input: 'Continue after recovery.',
      }),
    ).toMatchObject({ status: 'conflict' });
    const settled = storage.loadCurrentSnapshot(sessionId);
    expect(settled?.turn.status).not.toBe('active');
    expect(settled?.pendingApprovals.size).toBe(0);
    expect(Object.keys(settled?.suspendedSubagents ?? {})).toHaveLength(0);
    expect(storage.storage.runs?.get(sessionId, oldRun.runId)?.status).not.toBe('running');
    expect(model.getRequestCount()).toBe(1);
    const settledRevision = settled!.revision;
    const eventCount = storage.storage.sessions.loadEventsStrict(sessionId).length;

    const again = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(again).toMatchObject({ status: 'ok', session: { revision: settledRevision } });
    expect(storage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(eventCount);

    const receipt = await runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'reentry-new-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: settledRevision,
      input: 'Start a new turn in the original Session.',
    });
    expect(receipt).toMatchObject({ status: 'applied', sessionId });
    if (receipt.status !== 'applied' || !receipt.resource) throw new Error('New Run not accepted');
    const newRunId = receipt.resource.run.runId;
    for (
      let i = 0;
      i < 400 && storage.storage.runs?.get(sessionId, newRunId)?.status !== 'completed';
      i++
    ) {
      await Bun.sleep(10);
    }
    expect(storage.storage.runs?.get(sessionId, newRunId)?.status).toBe('completed');
    expect(storage.loadCurrentSnapshot(sessionId)?.session.threadId).toBe(sessionId);
    expect(model.getRequestCount()).toBe(2);
    expect(storage.storage.runs?.get(sessionId, oldRun.runId)?.status).not.toBe('running');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await runtime?.close();
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('visiting a Session owned by a live Service does not cancel its active turn', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-live-session-reentry-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'reentry-live-session';
  const model = gatedModel();
  let firstStorage:
    | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
    | undefined;
  let secondStorage:
    | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
    | undefined;
  let firstServer: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let secondServer: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let firstClient: RuntimeClient | undefined;
  let secondClient: RuntimeClient | undefined;
  try {
    firstStorage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'live-first',
    });
    firstServer = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: firstStorage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    firstClient = client(firstServer, workspace);
    expect(
      await firstClient.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'live-create',
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await firstClient.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'live-start',
        type: 'start_turn',
        sessionId,
        expectedRevision: 0,
        input: 'Keep this turn active while another Service reads it.',
      }),
    ).toMatchObject({ status: 'applied' });
    await model.waitForRequest();
    const before = firstStorage.loadCurrentSnapshot(sessionId);
    expect(before?.turn.status).toBe('active');

    secondStorage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'live-second',
    });
    secondServer = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: secondStorage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    secondClient = client(secondServer, workspace);
    const projection = await secondClient.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(projection).toMatchObject({ status: 'ok', session: { revision: before!.revision } });
    expect(secondStorage.loadCurrentSnapshot(sessionId)?.turn.status).toBe('active');
    expect(secondStorage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(
      firstStorage.storage.sessions.loadEventsStrict(sessionId).length,
    );
    expect(model.requestCount()).toBe(1);
  } finally {
    model.release();
    await secondClient?.close();
    await secondServer?.[Symbol.asyncDispose]();
    secondStorage?.disposeStorage();
    await firstClient?.close();
    await firstServer?.[Symbol.asyncDispose]();
    firstStorage?.disposeStorage();
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a model attempt interrupted by process death is terminal on reentry without replay', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-model-reentry-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'reentry-model-interrupted';
  const model = createMockModelServer();
  model.setResponses([
    { message: { content: 'stale response from killed process' }, delay: 3_000 },
    { message: { content: 'new turn after interrupted model' } },
  ]);
  const bootstrapModule = join(import.meta.dir, '..', '..', 'src', 'bootstrap.ts');
  const childCode = `
    import { createKiteCliRuntimeAccess } from ${JSON.stringify(bootstrapModule)};
    import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
    const workspace = ${JSON.stringify(workspace)};
    const sessionId = ${JSON.stringify(sessionId)};
    const access = createKiteCliRuntimeAccess({
      sessionId, userId: 'crash-model-user', workspace,
      checkpointPath: ${JSON.stringify(databasePath)},
      config: {
        providerName: 'crash-model', providerType: 'openai-compatible',
        apiKey: 'fixture-key', baseURL: ${JSON.stringify(model.baseURL)},
        modelName: 'mock-model', sandbox: { enabled: false },
      },
      shellExecutor: async ({ command }) => ({
        ok: true, command, exitCode: 0, stdout: '', stderr: '',
      }),
      interactionMode: 'accept_edits', sandboxBackend: 'none',
      skillOptions: {
        userKiteCodeSkillsDir: workspace + '/user-kite-skills',
        userAgentsSkillsDir: workspace + '/user-agent-skills',
        projectKiteCodeSkillsDir: workspace + '/.kite-code/skills',
        projectAgentsSkillsDir: workspace + '/.agents/skills',
      },
      initialSkillActivations: [],
    });
    await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_, commandId: 'crash-model-create',
      type: 'create_session', workspace, bootstrapSessionId: sessionId,
    });
    await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_, commandId: 'crash-model-start',
      type: 'start_turn', sessionId, expectedRevision: 0, input: 'Start model work.',
    });
    process.stdout.write('ready\\n');
    await new Promise(() => {});
  `;
  const child = Bun.spawn([process.execPath, '-e', childCode], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    env: { ...process.env, KITE_CODE_HOME: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let runtime: RuntimeClient | undefined;
  try {
    expect(await firstLine(child.stdout)).toBe('ready');
    for (let i = 0; i < 200 && model.getRequestCount() === 0; i++) await Bun.sleep(5);
    expect(model.getRequestCount()).toBe(1);
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);

    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'crash-model-successor',
      now: () => Date.now() + 120_000,
    });
    expect(storage.loadCurrentSnapshot(sessionId)?.turn.status).toBe('active');
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    runtime = client(server, workspace);
    const projection = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (projection.status !== 'ok' || !projection.session) throw new Error('No reentry projection');
    expect(storage.loadCurrentSnapshot(sessionId)?.turn.status).toBe('active');
    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'crash-model-trigger-recovery',
        type: 'start_turn',
        sessionId,
        expectedRevision: projection.session.revision,
        input: 'Continue after recovery.',
      }),
    ).toMatchObject({ status: 'conflict' });
    expect(storage.loadCurrentSnapshot(sessionId)?.turn.status).not.toBe('active');
    expect(model.getRequestCount()).toBe(1);
    const revision = storage.loadCurrentSnapshot(sessionId)!.revision;
    const newCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'crash-model-new-turn',
      type: 'start_turn' as const,
      sessionId,
      expectedRevision: revision,
      input: 'Continue this existing Session.',
    };
    const receipt = await runtime.command(newCommand);
    expect(receipt).toMatchObject({ status: 'applied', sessionId });
    if (receipt.status !== 'applied' || !receipt.resource) throw new Error('New turn rejected');
    for (
      let i = 0;
      i < 400 &&
      storage.storage.runs?.get(sessionId, receipt.resource.run.runId)?.status !== 'completed';
      i++
    )
      await Bun.sleep(10);
    expect(storage.storage.runs?.get(sessionId, receipt.resource.run.runId)?.status).toBe(
      'completed',
    );
    expect(model.getRequestCount()).toBe(2);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await runtime?.close();
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('an idle terminal Session closes one stale historical Subagent card on reentry', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-idle-subagent-reentry-'));
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'idle-historical-subagent';
  const toolCallId = 'old-task-tool';
  const childInvocationId = 'old-child-invocation';
  const model = createMockModelServer();
  model.setResponses([
    { message: { content: 'old parent task completed' } },
    { message: { content: 'later task completed' } },
  ]);
  let seedStorage:
    | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
    | undefined;
  let seedServer: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let seedClient: RuntimeClient | undefined;
  let reopenedStorage:
    | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
    | undefined;
  let reopenedServer: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let reopenedClient: RuntimeClient | undefined;
  try {
    seedStorage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'stale-subagent-seed',
    });
    seedServer = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: seedStorage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    seedClient = client(seedServer, workspace);
    expect(
      await seedClient.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'stale-subagent-create',
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
      }),
    ).toMatchObject({ status: 'applied' });
    const firstReceipt = await seedClient.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'stale-subagent-first',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Complete the old parent task.',
    });
    if (firstReceipt.status !== 'applied' || !firstReceipt.resource)
      throw new Error('Old parent Run was not accepted.');
    await waitForRun(seedStorage, sessionId, firstReceipt.resource.run.runId);
    const firstState = seedStorage.loadCurrentSnapshot(sessionId)!;
    const oldTurnId = firstState.turn.turnId;
    const oldTaskId = Object.keys(firstState.tasks)[0];
    const modelMessageId = firstState.transcript.messages.find(
      (message) => message.kind === 'assistant' && message.turnId === oldTurnId,
    )?.messageId;
    if (!oldTaskId || !modelMessageId) throw new Error('Old task facts are unavailable.');
    for (
      let i = 0;
      i < 100 && seedStorage.recovery.inspect(sessionId).authority.status !== 'idle';
      i++
    ) {
      await Bun.sleep(5);
    }

    const secondReceipt = await seedClient.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'stale-subagent-second',
      type: 'start_turn',
      sessionId,
      expectedRevision: firstState.revision,
      input: 'Complete a later independent task.',
    });
    if (secondReceipt.status !== 'applied' || !secondReceipt.resource)
      throw new Error(`Later Run was not accepted: ${JSON.stringify(secondReceipt)}`);
    await waitForRun(seedStorage, sessionId, secondReceipt.resource.run.runId);
    const latest = seedStorage.loadCurrentSnapshot(sessionId)!;
    expect(latest.turn.status).toBe('completed');
    expect(latest.turn.turnId).not.toBe(oldTurnId);
    expect(Object.keys(latest.tasks).some((taskId) => taskId !== oldTaskId)).toBe(true);
    expect(latest.activeTaskId).not.toBe(oldTaskId);
    for (
      let i = 0;
      i < 100 && seedStorage.recovery.inspect(sessionId).authority.status !== 'idle';
      i++
    ) {
      await Bun.sleep(5);
    }
    expect(seedStorage.recovery.inspect(sessionId).authority).toMatchObject({
      status: 'idle',
      cleanupConfirmed: true,
    });

    // A legacy history card can outlive its already-failed parent Tool. This
    // fixture changes only the isolated Store and keeps both real Runs terminal.
    const legacy = {
      ...structuredClone(latest),
      revision: latest.revision + 1,
    } as RuntimeState;
    (legacy.tools.calls as Record<string, RuntimeState['tools']['calls'][string]>)[toolCallId] = {
      toolCallId,
      modelMessageId,
      name: 'task',
      args: { subagent_type: 'explore', task: 'Inspect old work' },
      status: 'failed',
      createdAtTurnId: oldTurnId,
      taskId: oldTaskId,
    };
    (
      legacy.capabilities.invocations as Record<
        string,
        RuntimeState['capabilities']['invocations'][string]
      >
    )['old-capability-invocation'] = {
      invocationId: 'old-capability-invocation',
      toolCallId,
      capabilityId: 'builtin:task',
      capabilityRevision: '2'.repeat(64),
      argumentsDigest: '3'.repeat(64),
      authorizationDigest: '4'.repeat(64),
      admissionDigest: '9'.repeat(64),
      effectiveEffectsDigest: '5'.repeat(64),
      status: 'failed',
      receiptRequirement: 'control_receipt',
      recordedAt: '2026-08-25T00:00:00.000Z',
      startedAt: '2026-08-25T00:00:01.000Z',
      finishedAt: '2026-08-25T00:00:02.000Z',
      attemptsStarted: 1,
      taskId: oldTaskId,
      reconciliation: 'confirmed_failure',
      reconciledAt: '2026-08-25T00:00:02.000Z',
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId,
        taskArtifact: {
          artifactId: `pa_${'6'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'7'.repeat(64)}`,
          byteLength: 64,
        },
        dispatchIntentDigest: `sha256:${'8'.repeat(64)}`,
        status: 'cleanup_completed',
        recordedAt: '2026-08-25T00:00:00.000Z',
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        cleanupStartedAt: '2026-08-25T00:00:01.000Z',
        cleanupConfirmed: true,
        cleanupCompletedAt: '2026-08-25T00:00:02.000Z',
      },
    };
    seedStorage.runWithSessionExecution(sessionId, () => {
      seedStorage!.storage.sessions.appendEvents(sessionId, [
        {
          type: 'subagent.started',
          subagent: {
            id: childInvocationId,
            role: 'explore',
            name: 'Inspect old work',
            parentToolCallId: toolCallId,
          },
        },
      ]);
      seedStorage!.storage.sessions.saveSnapshot(sessionId, legacy);
    });
    seedStorage.releaseExecutions(true);
    expect(seedStorage.recovery.inspect(sessionId).authority).toMatchObject({
      status: 'idle',
      cleanupConfirmed: true,
    });
    const beforeCount = seedStorage.storage.sessions.loadEventsStrict(sessionId).length;
    const firstRun = seedStorage.storage.runs?.get(sessionId, firstReceipt.resource.run.runId);
    const secondRun = seedStorage.storage.runs?.get(sessionId, secondReceipt.resource.run.runId);
    await seedClient.close();
    await seedServer[Symbol.asyncDispose]();
    seedClient = undefined;
    seedServer = undefined;
    seedStorage = undefined;

    reopenedStorage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'stale-subagent-reopened',
    });
    reopenedServer = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: reopenedStorage,
      workspaces: [runtimeInput(workspace, model.baseURL)],
    });
    reopenedClient = client(reopenedServer, workspace);
    const query = {
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    } as const;
    const firstProjection = await reopenedClient.query(query);
    expect(firstProjection).toMatchObject({ status: 'ok' });
    expect(reopenedStorage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(beforeCount);
    if (firstProjection.status !== 'ok' || !firstProjection.session)
      throw new Error('Expected historical projection.');
    expect(
      await reopenedClient.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'stale-subagent-trigger-recovery',
        type: 'start_turn',
        sessionId,
        expectedRevision: firstProjection.session.revision,
        input: 'Continue after stale child cleanup.',
      }),
    ).toMatchObject({ status: 'conflict' });
    const after = reopenedStorage.storage.sessions.loadEventsStrict(sessionId);
    expect(after.length).toBe(beforeCount + 1);
    expect(after.filter(({ event }) => event.type === 'subagent.failed')).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          subagent: expect.objectContaining({ id: childInvocationId }),
        }),
      }),
    ]);
    expect(reopenedStorage.loadCurrentSnapshot(sessionId)?.turn).toEqual(latest.turn);
    expect(reopenedStorage.storage.runs?.get(sessionId, firstReceipt.resource.run.runId)).toEqual(
      firstRun,
    );
    expect(reopenedStorage.storage.runs?.get(sessionId, secondReceipt.resource.run.runId)).toEqual(
      secondRun,
    );
    expect(await reopenedClient.query(query)).toMatchObject({ status: 'ok' });
    expect(reopenedStorage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(after.length);
    expect(model.getRequestCount()).toBe(2);
  } finally {
    await reopenedClient?.close();
    await reopenedServer?.[Symbol.asyncDispose]();
    reopenedStorage?.disposeStorage();
    await seedClient?.close();
    await seedServer?.[Symbol.asyncDispose]();
    seedStorage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

async function waitForRun(
  storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>,
  sessionId: string,
  runId: string,
): Promise<void> {
  for (
    let i = 0;
    i < 400 && storage.storage.runs?.get(sessionId, runId)?.status !== 'completed';
    i++
  ) {
    await Bun.sleep(10);
  }
  expect(storage.storage.runs?.get(sessionId, runId)?.status).toBe('completed');
}

function gatedModel() {
  let requestCount = 0;
  let notifyRequest!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        requestCount += 1;
        notifyRequest();
        await gate;
        return Response.json({ error: { message: 'released gated fixture' } }, { status: 503 });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    waitForRequest: () => requested,
    requestCount: () => requestCount,
    release: () => release(),
    stop: () => server.stop(true),
  };
}

async function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  let result = '';
  const decoder = new TextDecoder();
  while (result.indexOf('\n') < 0) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error('Child never reached its persisted interaction.');
      }),
    ]);
    if (chunk.done) throw new Error('Child exited before persisting an interaction.');
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result.slice(0, result.indexOf('\n'));
}

function runtimeInput(workspace: string, baseURL: string) {
  return {
    userId: 'reentry-user',
    workspace,
    config: {
      providerName: 'reentry-model',
      providerType: 'openai-compatible' as const,
      apiKey: 'fixture-key',
      baseURL,
      modelName: 'mock-model',
      sandbox: { enabled: false },
    },
    shellExecutor: async ({ command }: { command: string }) => ({
      ok: true as const,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    interactionMode: 'accept_edits' as const,
    sandboxBackend: 'none' as const,
    skillOptions: {
      userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  };
}

function client(
  server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  workspace: string,
) {
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = server.open({ admission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'reentry-test', version: '1', instanceId: 'reentry-client' },
  });
}
