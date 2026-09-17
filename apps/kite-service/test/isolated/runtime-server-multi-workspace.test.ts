import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
} from '@kite-ai/runtime-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
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

test('runs a real Host on the KASD Session Store and cleanly hands off its generation', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-app-server-storage-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'app-server-terminal' } }]);
  const databasePath = join(root, 'kite-session.sqlite');
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'app-server-host-1',
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner,
    workspaces: [runtimeInput(workspace, model.baseURL, 'app-server-model')],
  });
  const runtime = client(owner, admission(workspace), 'app-server-client');
  const sessionId = 'app-server-session';
  try {
    await createSession(runtime, sessionId, '/untrusted-wire-workspace');
    const stream = runtime.subscribe({ spec: { scope: 'session', sessionId } });
    const iterator = stream[Symbol.asyncIterator]();
    await next(iterator);
    await runtime.command(start('app-server-turn', sessionId, 'run app server'));
    await waitForTerminal(iterator, sessionId);
    expect(model.getRequestCount()).toBe(1);
  } finally {
    await runtime.close();
    await owner[Symbol.asyncDispose]();
  }

  const successor = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'app-server-host-2',
  });
  try {
    successor.runWithSessionExecution(sessionId, () => {
      successor.storage.sessions.setSessionName(sessionId, 'Handed off');
    });
    expect(successor.storage.sessions.listSessions()).toEqual([
      expect.objectContaining({ threadId: sessionId, name: 'Handed off' }),
    ]);
    successor.releaseExecutions(true);
  } finally {
    successor.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

test('a completed historical Session starts a new turn after an old recovery fence', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-completed-recovery-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = createMockModelServer();
  model.setResponses([
    { message: { content: 'historical answer' } },
    { message: { content: 'continued answer' } },
  ]);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'completed-recovery-session';
  let seed: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let first: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let firstClient: RuntimeClient | undefined;
  let successor:
    | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
    | undefined;
  let second: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let secondClient: RuntimeClient | undefined;
  try {
    seed = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'completed-seed',
    });
    first = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: seed,
      workspaces: [runtimeInput(workspace, model.baseURL, 'completed-model')],
    });
    firstClient = client(first, admission(workspace), 'completed-first-client');
    await createSession(firstClient, sessionId, workspace);
    const firstNotifications = firstClient
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await next(firstNotifications);
    expect(await firstClient.command(start('historical-turn', sessionId, 'first'))).toMatchObject({
      status: 'applied',
    });
    await waitForTerminal(firstNotifications, sessionId);
    const historical = seed.loadCurrentSnapshot(sessionId)!;
    expect(historical.turn.status).toBe('completed');
    const historicalRun = seed.storage.runs?.list({ sessionId, limit: 10 }).entries.at(-1);
    if (historicalRun?.status !== 'completed') throw new Error('Historical Run did not complete.');

    // Reproduce an old active authority which survived after the historical
    // turn had finished, then fence that generation without inventing cleanup.
    seed.runWithSessionExecution(sessionId, () => undefined);
    seed.releaseExecutions(false);
    expect(seed.recovery.inspect(sessionId)).toMatchObject({
      authority: { status: 'recovery_required', cleanupConfirmed: false },
      pendingEffects: [],
      unknownEffects: [],
    });
    await firstClient.close();
    await first[Symbol.asyncDispose]();
    firstClient = undefined;
    first = undefined;
    seed = undefined;

    successor = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'completed-successor',
    });
    second = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: successor,
      workspaces: [runtimeInput(workspace, model.baseURL, 'completed-model')],
    });
    secondClient = client(second, admission(workspace), 'completed-second-client');
    const secondNotifications = secondClient
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await next(secondNotifications);
    const receipt = await secondClient.command(
      start('continued-turn', sessionId, 'second', historical.revision),
    );
    expect(receipt).toMatchObject({ status: 'applied', sessionId });
    if (receipt.status !== 'applied' || !receipt.resource)
      throw new Error('Continuation Run was not accepted.');
    const successorRuns = successor.storage.runs;
    if (!successorRuns) throw new Error('Continuation Run storage is unavailable.');
    for (
      let attempt = 0;
      attempt < 200 &&
      successorRuns.get(sessionId, receipt.resource.run.runId)?.status !== 'completed';
      attempt++
    ) {
      await Bun.sleep(10);
    }
    expect(successorRuns.get(sessionId, receipt.resource.run.runId)?.status).toBe('completed');
    expect(model.getRequestCount()).toBe(2);
    expect(successorRuns.get(sessionId, historicalRun.runId)).toEqual(historicalRun);
    expect(successor.loadCurrentSnapshot(sessionId)?.session.threadId).toBe(sessionId);

    // A settled turn does not excuse an actual external effect whose outcome
    // became unknown when its owner was fenced.
    successor.runWithSessionExecution(sessionId, () => {
      expect(
        successor!.storage.effects.tryAcquireEffectLease(
          sessionId,
          'uncertain-effect',
          'uncertain-owner',
          Date.now() + 30_000,
        ),
      ).toBe(true);
    });
    successor.releaseExecutions(false);
    expect(successor.recovery.inspect(sessionId).unknownEffects).toHaveLength(1);
    expect(() => successor!.runWithSessionExecution(sessionId, () => undefined)).toThrow(
      'Session requires explicit effect reconciliation',
    );
  } finally {
    await secondClient?.close();
    await second?.[Symbol.asyncDispose]();
    successor?.disposeStorage();
    await firstClient?.close();
    await first?.[Symbol.asyncDispose]();
    seed?.disposeStorage();
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('edits policy without recovery or Workspace initialization and observes other settings writers', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-policy-without-runtime-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'policy-recovery-session';
  const seedStorage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'policy-seed',
  });
  const seed = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: seedStorage,
    workspaces: [runtimeInput(workspace, 'http://127.0.0.1:1', 'removed-model')],
  });
  const seedClient = client(seed, admission(workspace), 'policy-seed-client');
  const opened: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>[] = [];
  const clients: RuntimeClient[] = [];
  try {
    await createSession(seedClient, sessionId, workspace);
    await seedClient.close();
    await seed[Symbol.asyncDispose]();
    const repair = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'policy-interrupted',
    });
    repair.runWithSessionExecution(sessionId, () => undefined);
    repair.releaseExecutions(false);
    const before = repair.recovery.inspect(sessionId);
    expect(before.authority.status).toBe('recovery_required');
    repair.disposeStorage();
    let templateLoads = 0;
    const open = async (hostInstanceId: string, beforePolicyCommit?: () => void) => {
      const storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId,
      });
      const owner = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: databasePath,
        storageOwner: beforePolicyCommit
          ? {
              ...storage,
              commitUnownedInteractionMode(transaction, expectedRevision) {
                beforePolicyCommit();
                storage.commitUnownedInteractionMode(transaction, expectedRevision);
              },
            }
          : storage,
        workspaces: [],
        workspaceTemplateFor: async () => {
          templateLoads++;
          throw new Error('Workspace configuration unavailable');
        },
      });
      const runtime = client(owner, admission(workspace), hostInstanceId);
      opened.push(owner);
      clients.push(runtime);
      return { owner, storage, runtime };
    };
    const first = await open('policy-first');
    const second = await open('policy-second');
    const command = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'set_interaction_mode' as const,
      sessionId,
      commandId: 'policy-full',
      expectedRevision: 0,
      mode: 'full' as const,
    };
    const stream = first.runtime.subscribe({ spec: { scope: 'session', sessionId } });
    const iterator = stream[Symbol.asyncIterator]();
    await next(iterator);
    expect(await first.runtime.command(command)).toMatchObject({ status: 'applied', revision: 1 });
    expect(await next(iterator)).toMatchObject({
      revision: 1,
      projection: { event: { type: 'interaction_mode.changed', mode: 'full' } },
    });
    expect(first.storage.recovery.inspect(sessionId)).toEqual(before);
    expect(first.storage.ownedSessionIds()).toEqual([]);
    expect(await first.runtime.command(command)).toMatchObject({
      status: 'idempotent_replay',
      originalRevision: 1,
    });
    expect(
      await second.runtime.command({
        ...command,
        commandId: 'policy-auto',
        expectedRevision: 1,
        mode: 'auto',
      }),
    ).toMatchObject({ status: 'applied', revision: 2 });
    expect(
      await first.runtime.command({ ...command, commandId: 'policy-stale', expectedRevision: 1 }),
    ).toMatchObject({ status: 'conflict', currentRevision: 2 });
    expect(
      await first.runtime.command({ ...command, commandId: 'policy-current', expectedRevision: 2 }),
    ).toMatchObject({ status: 'applied', revision: 3 });
    expect(first.storage.recovery.inspect(sessionId)).toEqual(before);
    const restarted = await open('policy-restarted');
    expect(await restarted.runtime.command(command)).toMatchObject({
      status: 'idempotent_replay',
      originalRevision: 1,
    });
    expect(restarted.storage.loadCurrentSnapshot(sessionId)).toMatchObject({
      mode: 'full',
      revision: 3,
    });
    expect(
      restarted.storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event.type),
    ).toEqual(['interaction_mode.changed', 'interaction_mode.changed', 'interaction_mode.changed']);
    // Reading and changing policy must remain independent of Workspace setup.
    // Starting a new turn now reconciles a stale empty authority automatically;
    // it is covered by reentry tests rather than an obsolete recovery gate here.
    expect(templateLoads).toBe(0);
    expect(restarted.storage.recovery.inspect(sessionId)).toEqual(before);
    const raced = {
      ...command,
      commandId: 'policy-raced',
      expectedRevision: 3,
      mode: 'auto' as const,
    };
    const receipts = await Promise.all([
      first.runtime.command(raced),
      second.runtime.command(raced),
    ]);
    expect(receipts.map((receipt) => receipt.status).sort()).toEqual([
      'applied',
      'idempotent_replay',
    ]);
    expect(first.storage.loadCurrentSnapshot(sessionId)?.revision).toBe(4);
    const contenders = await Promise.all([
      first.runtime.command({ ...command, commandId: 'contender-first', expectedRevision: 4 }),
      second.runtime.command({ ...command, commandId: 'contender-second', expectedRevision: 4 }),
    ]);
    expect(contenders.map((receipt) => receipt.status).sort()).toEqual(['applied', 'conflict']);
    expect(first.storage.loadCurrentSnapshot(sessionId)?.revision).toBe(5);
    first.storage.recovery.reconcile({
      sessionId,
      expectedAuthorityRevision: before.authority.revision,
    });
    const deleter = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'policy-deleter',
    });
    const deletionRace = await open('policy-deletion-race', () => {
      try {
        deleter.runWithSessionExecution(sessionId, () =>
          deleter.storage.sessions.deleteSession(sessionId),
        );
      } finally {
        deleter.releaseExecutions(true);
        deleter.disposeStorage();
      }
    });
    expect(
      await deletionRace.runtime.command({
        ...command,
        commandId: 'policy-after-delete',
        expectedRevision: 5,
        mode: 'auto',
      }),
    ).toMatchObject({ status: 'not_found', code: 'session_not_found' });
    expect(first.storage.loadCurrentSnapshot(sessionId)).toBeNull();
  } finally {
    await seedClient.close();
    await seed[Symbol.asyncDispose]();
    for (const runtime of clients) await runtime.close();
    for (const owner of opened) await owner[Symbol.asyncDispose]();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('freezes the active Run model and applies a selected model to the next Run', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-next-run-model-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const modelA = createMockModelServer();
  const modelB = createMockModelServer();
  modelA.setResponses([{ delay: 300, message: { content: 'active-model-answer' } }]);
  modelB.setResponses([{ message: { content: 'next-model-answer' } }]);
  const inputA = runtimeInput(workspace, modelA.baseURL, 'model-a');
  const inputB = runtimeInput(workspace, modelB.baseURL, 'model-b');
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'kite-session.sqlite'),
    workspaces: [inputA],
  });
  const runtime = client(owner, admission(workspace), 'next-run-model-client');
  const sessionId = 'next-run-model-session';
  try {
    await createSession(runtime, sessionId, workspace);
    const stream = runtime.subscribe({ spec: { scope: 'session', sessionId } });
    const iterator = stream[Symbol.asyncIterator]();
    await next(iterator);

    const firstReceipt = await runtime.command(start('run-with-model-a', sessionId, 'first run'));
    if (firstReceipt.status !== 'applied' || firstReceipt.resource?.kind !== 'run') {
      throw new Error('Expected the first Run to be admitted.');
    }
    owner.applySelectedConfig(admissionIdentity(workspace), inputB.config);
    await waitForTerminal(iterator, sessionId, firstReceipt.resource.run.runId);

    expect(modelA.getRequestCount()).toBe(1);
    expect(modelB.getRequestCount()).toBe(0);
    await owner.host.waitForSessionIdle(sessionId);
    const projection = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (projection.status !== 'ok' || !projection.session) {
      throw new Error('Expected current Session projection before the successor Run.');
    }
    const secondReceipt = await runtime.command(
      start('run-with-model-b', sessionId, 'second run', projection.session.revision),
    );
    if (secondReceipt.status !== 'applied' || secondReceipt.resource?.kind !== 'run') {
      throw new Error('Expected the successor Run to be admitted.');
    }
    for (let attempt = 0; attempt < 100 && modelB.getRequestCount() === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(modelB.getRequestCount()).toBe(1);
    await waitForTerminal(iterator, sessionId, secondReceipt.resource.run.runId);
    expect(modelA.getRequestCount()).toBe(1);
  } finally {
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    modelA.stop();
    modelB.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

test('binds independent model routes to Sessions in the same Workspace', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-session-models-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const modelA = createMockModelServer();
  const modelB = createMockModelServer();
  const inputA = runtimeInput(workspace, modelA.baseURL, 'model-a');
  const inputB = runtimeInput(workspace, modelB.baseURL, 'model-b');
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'kite-session.sqlite'),
    workspaces: [
      {
        ...inputA,
        resolveModelConfig: (route: { readonly provider: string; readonly name: string }) => {
          if (route.provider === inputA.config.providerName && route.name === 'model-a')
            return inputA.config;
          if (route.provider === inputB.config.providerName && route.name === 'model-b')
            return inputB.config;
          throw new Error('unknown model route');
        },
      },
    ],
  });
  const runtime = client(owner, admission(workspace), 'session-model-client');
  try {
    for (const [sessionId, model] of [
      ['session-model-a', { provider: inputA.config.providerName, name: 'model-a' }],
      ['session-model-b', { provider: inputB.config.providerName, name: 'model-b' }],
    ] as const) {
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: `create-${sessionId}`,
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
        model,
      });
      await expect(
        runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        }),
      ).resolves.toMatchObject({ status: 'ok', session: { sessionId, model } });
      expect(owner.storage.sessions.getSessionModelRoute(sessionId)).toEqual(model);
    }
  } finally {
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    modelA.stop();
    modelB.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
});

test('a second App Server reads another Host Session without acquiring or cancelling it', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-app-server-read-only-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'writer-still-active' } }]);
  const databasePath = join(root, 'kite-session.sqlite');
  const writerStorage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'read-only-writer-host',
  });
  const writer = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: writerStorage,
    workspaces: [runtimeInput(workspace, model.baseURL, 'read-only-model')],
  });
  const writerClient = client(writer, admission(workspace), 'read-only-writer-client');
  const sessionId = 'read-only-shared-session';
  try {
    await createSession(writerClient, sessionId, '/writer-wire');
    // Explicitly retain a writer for this concurrent-reader ownership scenario.
    writerStorage.runWithSessionExecution(sessionId, () => undefined);
    expect(writerStorage.recovery.inspect(sessionId).authority).toMatchObject({
      status: 'active',
      hostInstanceId: 'read-only-writer-host',
    });

    const readerStorage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'read-only-reader-host',
    });
    const reader = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: readerStorage,
      workspaces: [runtimeInput(workspace, model.baseURL, 'read-only-model')],
    });
    const readerClient = client(reader, admission(workspace), 'read-only-reader-client');
    try {
      await expect(
        readerClient.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
      ).resolves.toMatchObject({
        status: 'ok',
        sessions: [expect.objectContaining({ sessionId })],
      });
      await expect(
        readerClient.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        }),
      ).resolves.toMatchObject({ status: 'ok', session: { sessionId } });
      await expect(
        readerClient.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'list_checkpoints',
          sessionId,
        }),
      ).resolves.toMatchObject({ status: 'ok', revision: 0, checkpoints: [] });
      await expect(
        readerClient.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'read-only-reader-resume',
          type: 'resume_session',
          sessionId,
        }),
      ).resolves.toEqual({
        status: 'rejected',
        commandId: 'read-only-reader-resume',
        code: 'runtime_busy',
      });
      expect(readerStorage.ownedSessionIds()).toEqual([]);
    } finally {
      await readerClient.close();
      await reader[Symbol.asyncDispose]();
    }

    expect(writerStorage.recovery.inspect(sessionId).authority).toMatchObject({
      status: 'active',
      hostInstanceId: 'read-only-writer-host',
    });
    const stream = writerClient.subscribe({ spec: { scope: 'session', sessionId } });
    const iterator = stream[Symbol.asyncIterator]();
    await next(iterator);
    await writerClient.command(start('writer-after-reader-exit', sessionId, 'continue'));
    await waitForTerminal(iterator, sessionId);
    expect(model.getRequestCount()).toBe(1);
  } finally {
    await writerClient.close();
    await writer[Symbol.asyncDispose]();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

test('two canonical Workspaces execute through one real Host and SQLite Store without cross-wiring', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-multi-workspace-'));
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const modelA = createMockModelServer();
  const modelB = createMockModelServer();
  modelA.setResponses([
    { message: { content: 'workspace-a-terminal' } },
    { message: { content: 'workspace-a-second-session-terminal' } },
  ]);
  modelB.setResponses([{ message: { content: 'workspace-b-terminal' } }]);
  const sessionA = 'real-workspace-a-session';
  const sessionB = 'real-workspace-b-session';
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(root, 'kite-session.sqlite'),
    hostInstanceId: 'multi-workspace-host',
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'shared-runtime.sqlite'),
    storageOwner,
    workspaces: [
      runtimeInput(workspaceA, modelA.baseURL, 'model-a'),
      runtimeInput(workspaceB, modelB.baseURL, 'model-b'),
    ],
  });
  const clientA = client(owner, admission(workspaceA), 'workspace-a-client');
  const clientB = client(owner, admission(workspaceB), 'workspace-b-client');

  try {
    await Promise.all([
      createSession(clientA, sessionA, '/wire-a'),
      createSession(clientB, sessionB, '/wire-b'),
    ]);

    await expect(createSession(clientB, sessionA, '/attempted-cross-wire')).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
    await expect(
      clientB.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'cross-workspace-resume',
        type: 'resume_session',
        sessionId: sessionA,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
    await expect(
      clientB.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: sessionA,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
    await expect(
      clientB.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'cross-workspace-fork',
        type: 'fork_session',
        sourceSessionId: sessionA,
        sourceRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
    await expect(
      clientB.subscribeHandle({ scope: 'session', sessionId: sessionA }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });

    const streamA = clientA.subscribe({ spec: { scope: 'session', sessionId: sessionA } });
    const streamB = clientB.subscribe({ spec: { scope: 'session', sessionId: sessionB } });
    const iteratorA = streamA[Symbol.asyncIterator]();
    const iteratorB = streamB[Symbol.asyncIterator]();
    await Promise.all([next(iteratorA), next(iteratorB)]);
    await Promise.all([
      clientA.command(start('start-workspace-a', sessionA, 'run in a')),
      clientB.command(start('start-workspace-b', sessionB, 'run in b')),
    ]);
    await Promise.all([waitForTerminal(iteratorA, sessionA), waitForTerminal(iteratorB, sessionB)]);

    expect(modelA.getRequestCount()).toBe(1);
    expect(modelB.getRequestCount()).toBe(1);
    expect(
      await clientA.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: sessionA,
      }),
    ).toMatchObject({ status: 'ok', session: { sessionId: sessionA } });
    expect(
      await clientB.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: sessionB,
      }),
    ).toMatchObject({ status: 'ok', session: { sessionId: sessionB } });

    await owner.host.waitForSessionIdle(sessionA);
    const rewindSnapshot = owner.storage.sessions.loadSnapshot(sessionA);
    if (!rewindSnapshot) throw new Error('Rewind source snapshot is unavailable.');
    storageOwner.runWithSessionExecution(sessionA, () =>
      owner.storage.checkpoints.saveNamedSnapshot(
        sessionA,
        'service-rewind-checkpoint',
        rewindSnapshot,
        owner.storage.sessions.getLastEventPosition(sessionA),
      ),
    );
    const rewindStream = await clientA.subscribeReady({
      spec: { scope: 'session', sessionId: sessionA, includeEphemeral: true },
    });
    const rewindIterator = rewindStream[Symbol.asyncIterator]();
    const beforeRewind = await clientA.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId: sessionA,
    });
    if (beforeRewind.status !== 'ok' || !beforeRewind.session) {
      throw new Error('Rewind source projection is unavailable.');
    }
    await expect(
      clientA.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'service-rewind-command',
        type: 'rewind_session',
        sessionId: sessionA,
        expectedRevision: beforeRewind.session.revision,
        checkpointId: 'service-rewind-checkpoint',
        scope: 'conversation_only',
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId: sessionA });
    const rewindTerminal = await waitForRewindTerminal(rewindIterator);
    expect(rewindTerminal).toMatchObject({
      type: 'rewind.terminal',
      status: 'completed',
      sourceSessionId: sessionA,
    });
    if (rewindTerminal.type !== 'rewind.terminal') {
      throw new Error('Rewind terminal projection is unavailable.');
    }
    expect(rewindTerminal.targetSessionId).not.toBe(sessionA);
    expect(owner.storage.sessions.loadSnapshot(rewindTerminal.targetSessionId)).not.toBeNull();
    await rewindIterator.return?.();

    const sourceProjection = await clientA.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId: sessionA,
    });
    if (sourceProjection.status !== 'ok' || !sourceProjection.session) {
      throw new Error('Fork source projection is unavailable.');
    }
    const forked = await clientA.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'same-workspace-fork',
      type: 'fork_session',
      sourceSessionId: sessionA,
      sourceRevision: sourceProjection.session.revision,
    });
    expect(forked).toMatchObject({ status: 'applied' });
    if (forked.status !== 'applied') throw new Error('Same-Workspace fork was not applied.');
    expect(forked.sessionId).not.toBe(sessionA);
    await expect(
      clientA.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: forked.sessionId,
      }),
    ).resolves.toMatchObject({ status: 'ok', session: { sessionId: forked.sessionId } });

    const secondSessionA = 'real-workspace-a-second-session';
    await createSession(clientA, secondSessionA, '/wire-a-second');
    const secondStream = clientA.subscribe({
      spec: { scope: 'session', sessionId: secondSessionA },
    });
    const secondIterator = secondStream[Symbol.asyncIterator]();
    await next(secondIterator);
    await clientA.command(start('start-workspace-a-second', secondSessionA, 'run second in a'));
    await waitForTerminal(secondIterator, secondSessionA);
    expect(modelA.getRequestCount()).toBe(2);

    const projectionB = await clientB.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId: sessionB,
    });
    if (projectionB.status !== 'ok' || !projectionB.session) {
      throw new Error('Workspace B projection is unavailable before deletion.');
    }
    await expect(
      clientB.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'delete-workspace-b-session',
        type: 'delete_session',
        sessionId: sessionB,
        expectedRevision: projectionB.session.revision,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId: sessionB });
    await expect(
      clientB.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: sessionB,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
    await secondIterator.return?.();
    await iteratorA.return?.();
    await iteratorB.return?.();
  } finally {
    await clientA.close();
    await clientB.close();
    await owner[Symbol.asyncDispose]();
    modelA.stop();
    modelB.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

test('hydrates an unregistered persisted Session from the shared Store after owner restart', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-workspace-restart-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const checkpointPath = join(root, 'shared-runtime.sqlite');
  const sessionId = 'persisted-workspace-session';
  const compositionInput = {
    checkpointPath,
    workspaces: [runtimeInput(workspace, model.baseURL, 'restart-model')],
  };
  const firstOwner = createKiteMultiWorkspaceRuntimeServer(compositionInput);
  const firstClient = client(firstOwner, admission(workspace), 'restart-first-client');
  try {
    await createSession(firstClient, sessionId, '/first-wire-value');
  } finally {
    await firstClient.close();
    await firstOwner[Symbol.asyncDispose]();
  }

  const restartedOwner = createKiteMultiWorkspaceRuntimeServer(compositionInput);
  const restartedClient = client(restartedOwner, admission(workspace), 'restart-second-client');
  try {
    await expect(
      restartedClient.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      }),
    ).resolves.toMatchObject({ status: 'ok', session: { sessionId } });
    await expect(
      restartedClient.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'resume-persisted-after-restart',
        type: 'resume_session',
        sessionId,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });
    await expect(
      restartedClient.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).resolves.toMatchObject({
      status: 'ok',
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId })]),
    });
  } finally {
    await restartedClient.close();
    await restartedOwner[Symbol.asyncDispose]();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

test('lists persisted Sessions from the shared Store without composing their Workspace', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-store-index-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const checkpointPath = join(root, 'shared-runtime.sqlite');
  const sessionId = 'store-index-session';
  const firstOwner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath,
    workspaces: [runtimeInput(workspace, model.baseURL, 'store-index-model')],
  });
  const firstClient = client(firstOwner, admission(workspace), 'store-index-writer');
  try {
    await createSession(firstClient, sessionId, '/wire-value');
  } finally {
    await firstClient.close();
    await firstOwner[Symbol.asyncDispose]();
  }

  let workspaceCompositions = 0;
  const restartedOwner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath,
    workspaceTemplateFor: () => {
      workspaceCompositions += 1;
      return runtimeInput(workspace, model.baseURL, 'store-index-model');
    },
  });
  const restartedClient = client(restartedOwner, admission(workspace), 'store-index-reader');
  try {
    await expect(
      restartedClient.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).resolves.toMatchObject({
      status: 'ok',
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId })]),
    });
    expect(workspaceCompositions).toBe(0);
  } finally {
    await restartedClient.close();
    await restartedOwner[Symbol.asyncDispose]();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

function runtimeInput(workspace: string, baseURL: string, modelName: string) {
  return {
    userId: `user-${modelName}`,
    workspace,
    config: {
      providerName: `provider-${modelName}`,
      providerType: 'openai-compatible' as const,
      apiKey: `key-${modelName}`,
      baseURL,
      modelName,
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

function admission(workspace: string): RuntimeServerAdmissionPort {
  return Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
}

function admissionIdentity(workspace: string) {
  const canonicalPath = realpathSync.native(workspace);
  const project = resolveProjectIdentity(canonicalPath);
  return {
    canonicalPath,
    projectId: project.projectId,
    workspaceDigest: project.workspaceDigest,
  };
}

function client(
  owner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  workspaceAdmission: RuntimeServerAdmissionPort,
  instanceId: string,
): RuntimeClient {
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = owner.open({ admission: workspaceAdmission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'runtime-multi-workspace', version: '1', instanceId },
  });
}

async function createSession(
  runtime: RuntimeClient,
  sessionId: string,
  wireWorkspace: string,
): Promise<void> {
  await runtime.command({
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: `create-${sessionId}-${wireWorkspace}`,
    type: 'create_session',
    workspace: wireWorkspace,
    bootstrapSessionId: sessionId,
  });
}

async function waitForRewindTerminal(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<
  NonNullable<Extract<RuntimeAccessNotification, { durability: 'durable' }>['projection']['event']>
> {
  for (let count = 0; count < 100; count += 1) {
    const item = await iterator.next();
    if (item.done) throw new Error('Rewind subscription closed before terminal.');
    if (
      'durability' in item.value &&
      item.value.durability === 'durable' &&
      item.value.projection.event?.type === 'rewind.terminal'
    ) {
      return item.value.projection.event;
    }
  }
  throw new Error('Rewind terminal was not observed.');
}

function start(commandId: string, sessionId: string, input: string, expectedRevision = 0) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'start_turn' as const,
    sessionId,
    expectedRevision,
    input,
  };
}

async function next(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<RuntimeAccessNotification> {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(3_000).then(() => {
      throw new Error('Timed out waiting for Runtime notification.');
    }),
  ]);
  if (item.done) throw new Error('Runtime subscription closed unexpectedly.');
  return item.value;
}

async function waitForTerminal(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  runId?: string,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    const notification = await next(iterator);
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'completed' &&
      (runId === undefined || notification.projection.session.currentRun.runId === runId)
    ) {
      return;
    }
  }
  throw new Error(`Runtime Session did not reach terminal state: ${sessionId}`);
}

test('continuous Session writes renew a valid lease without waiting for the timer', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-progress-renew-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  let clock = Date.now();
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(root, 'kite-session.sqlite'),
    hostInstanceId: 'progress-owner',
    executionLeaseMs: 60,
    renewIntervalMs: 20,
    now: () => clock,
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'kite-session.sqlite'),
    storageOwner,
    workspaces: [runtimeInput(workspace, model.baseURL, 'model')],
  });
  const runtime = client(owner, admission(workspace), 'progress-client');
  const sessionId = 'progress-session';
  try {
    await createSession(runtime, sessionId, workspace);
    storageOwner.runWithSessionExecution(sessionId, () => undefined);
    const generation = storageOwner.recovery.inspect(sessionId).authority.controllerGeneration;
    // No awaits: model/tool continuations can perform several synchronous
    // commits before the event loop services a renewal timer.
    for (let index = 0; index < 12; index++) {
      clock += 10;
      storageOwner.runWithSessionExecution(sessionId, () =>
        storageOwner.storage.sessions.setSessionName(sessionId, `progress-${index}`),
      );
    }
    const authority = storageOwner.recovery.inspect(sessionId).authority;
    expect(authority.status).toBe('active');
    expect(authority.controllerGeneration).toBe(generation);
    expect(authority.leaseUntilMs!).toBeGreaterThan(clock);
    expect(storageOwner.storage.sessions.listSessions()).toContainEqual(
      expect.objectContaining({ name: 'progress-11' }),
    );
    clock += 61;
    expect(() =>
      storageOwner.runWithSessionExecution(sessionId, () =>
        storageOwner.storage.sessions.setSessionName(sessionId, 'must-not-write'),
      ),
    ).toThrow('expired');
    expect(storageOwner.storage.sessions.listSessions()).not.toContainEqual(
      expect.objectContaining({ name: 'must-not-write' }),
    );
  } finally {
    storageOwner.releaseExecutions(false);
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('execution lease loss aborts all three real subagent model connections and preserves recovery facts', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-lease-model-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  let requests = 0;
  let disconnected = 0;
  const responseStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const model = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
      };
      requests++;
      if (requests === 1) {
        const calls = Array.from({ length: 3 }, (_, index) => ({
          index,
          id: `lease-child-${index}`,
          type: 'function',
          function: {
            name: 'task',
            arguments: JSON.stringify({
              name: `Lease child ${index}`,
              subagent_type: 'explore',
              task: `Inspect independent area ${index}.`,
            }),
          },
        }));
        return body.stream
          ? new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : Response.json({
              choices: [
                {
                  message: { role: 'assistant', content: '', tool_calls: calls },
                  finish_reason: 'tool_calls',
                },
              ],
            });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            responseStreams.push(controller);
            controller.enqueue(
              new TextEncoder().encode(
                body.stream
                  ? 'data: {"choices":[{"index":0,"delta":{"content":"pending"}}]}\n\n'
                  : '{"choices":[',
              ),
            );
          },
          cancel() {
            disconnected++;
          },
        }),
        { headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' } },
      );
    },
  });
  let clock = Date.now();
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(root, 'kite-session.sqlite'),
    hostInstanceId: 'lease-model-owner',
    executionLeaseMs: 60,
    renewIntervalMs: 20,
    now: () => clock,
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'kite-session.sqlite'),
    storageOwner,
    workspaces: [runtimeInput(workspace, `http://127.0.0.1:${model.port}`, 'pending-model')],
  });
  const runtime = client(owner, admission(workspace), 'lease-model-client');
  const sessionId = 'lease-model-session';
  const waitUntil = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(10);
    expect(condition()).toBe(true);
  };
  try {
    await createSession(runtime, sessionId, workspace);
    await runtime.command(start('lease-model-run', sessionId, 'wait for model'));
    const runId = storageOwner.storage.runs!.getActive(sessionId)!.runId;
    await waitUntil(() => requests === 4);
    clock += 61;
    await waitUntil(
      () => storageOwner.recovery.inspect(sessionId).authority.status === 'recovery_required',
    );
    await waitUntil(() => disconnected === 3);
    const run = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_run',
      sessionId,
      runId,
    });
    expect(run).toMatchObject({ status: 'ok', run: { status: 'unknown' } });
    expect(storageOwner.recovery.inspect(sessionId).authority.cleanupConfirmed).toBe(false);
    const lost = storageOwner.loadCurrentSnapshot(sessionId)!;
    const recoveryBeforePolicy = storageOwner.recovery.inspect(sessionId);
    const policyCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'set_interaction_mode',
      sessionId,
      commandId: 'policy-after-lease-loss',
      expectedRevision: lost.revision,
      mode: 'full',
    } as const;
    let policyResult = await runtime.command(policyCommand);
    for (
      let attempt = 0;
      policyResult.status === 'rejected' &&
      policyResult.code === 'session_cleanup_pending' &&
      attempt < 100;
      attempt++
    ) {
      await Bun.sleep(10);
      policyResult = await runtime.command(policyCommand);
    }
    expect(policyResult).toMatchObject({ status: 'applied' });
    expect(storageOwner.loadCurrentSnapshot(sessionId)?.turn).toEqual(lost.turn);
    expect(storageOwner.recovery.inspect(sessionId)).toEqual(recoveryBeforePolicy);

    expect(
      storageOwner.storage.sessions
        .loadEventsStrict(sessionId)
        .some(({ event }) => event.type === 'run.completed' || event.type === 'turn.completed'),
    ).toBe(false);
    expect(requests).toBe(4);
    const childStarts = storageOwner.storage.sessions
      .loadEventsStrict(sessionId)
      .flatMap(({ event }) => (event.type === 'subagent.started' ? [event.subagent] : []));
    expect(childStarts.filter((child) => child.status === 'creating')).toHaveLength(3);
    expect(childStarts.filter((child) => child.status === 'running')).toHaveLength(3);
  } finally {
    for (const stream of responseStreams) {
      try {
        stream.close();
      } catch {}
    }
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    model.stop(true);
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed idle Sessions survive lease expiry and acquire a fresh generation on continuation', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-idle-authority-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'first' } }, { message: { content: 'second' } }]);
  let clock = Date.now();
  const databasePath = join(root, 'kite-session.sqlite');
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'idle-owner',
    executionLeaseMs: 60,
    renewIntervalMs: 20,
    now: () => clock,
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner,
    workspaces: [runtimeInput(workspace, model.baseURL, 'idle-model')],
  });
  const runtime = client(owner, admission(workspace), 'idle-client');
  const sessionId = 'idle-session';
  try {
    await createSession(runtime, sessionId, workspace);
    expect(storageOwner.recovery.inspect(sessionId).authority.status).toBe('idle');
    const iterator = runtime
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await next(iterator);
    await runtime.command(start('idle-first', sessionId, 'first'));
    await waitForTerminal(iterator, sessionId);
    for (let i = 0; i < 100 && storageOwner.ownedSessionIds().length; i++) await Bun.sleep(2);
    const before = storageOwner.recovery.inspect(sessionId).authority;
    expect(before.status).toBe('idle');
    clock += 120_000;
    await Bun.sleep(30);
    expect(storageOwner.recovery.inspect(sessionId).authority).toEqual(before);
    const projection = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (projection.status !== 'ok' || !projection.session) throw new Error('Missing projection');
    const receipt = await runtime.command({
      ...start('idle-second', sessionId, 'second'),
      expectedRevision: projection.session.revision,
    });
    if (receipt.status !== 'applied' || !receipt.resource)
      throw new Error('Second run was not accepted');
    for (
      let i = 0;
      i < 200 && storageOwner.loadCurrentSnapshot(sessionId)?.turn.status === 'active';
      i++
    )
      await Bun.sleep(5);
    expect(storageOwner.loadCurrentSnapshot(sessionId)?.turn.status).toBe('completed');
    expect(model.getRequestCount()).toBe(2);
  } finally {
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery query is read-only and recovery command requires confirmed cleanup and a fresh authority revision', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-explicit-recovery-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const storageOwner = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'recovery-owner',
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner,
    workspaces: [runtimeInput(workspace, 'http://127.0.0.1:1', 'unused-model')],
  });
  const runtime = client(owner, admission(workspace), 'recovery-client');
  const sessionId = 'recoverable-session';
  try {
    await createSession(runtime, sessionId, workspace);
    storageOwner.runWithSessionExecution(sessionId, () => undefined);
    storageOwner.releaseExecutions(false);
    const before = storageOwner.recovery.inspect(sessionId);
    const query = {
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_recovery',
      sessionId,
    } as const;
    expect(await runtime.query(query)).toMatchObject({
      status: 'ok',
      recovery: { action: 'inspect', cleanupConfirmed: false },
    });
    expect(storageOwner.recovery.inspect(sessionId)).toEqual(before);
    const command = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'recover_session',
      sessionId,
      commandId: 'explicit-recovery',
      expectedRevision: 0,
      expectedAuthorityRevision: before.authority.revision,
    } as const;
    expect(await runtime.command(command)).toMatchObject({
      status: 'rejected',
      code: 'session_cleanup_pending',
    });
    storageOwner.recovery.confirmCleanup({
      sessionId,
      expectedAuthorityRevision: before.authority.revision,
    });
    expect(await runtime.command(command)).toMatchObject({
      status: 'conflict',
      code: 'revision_conflict',
    });
    const confirmed = storageOwner.recovery.inspect(sessionId);
    const accepted = { ...command, expectedAuthorityRevision: confirmed.authority.revision };
    expect(await runtime.query(query)).toMatchObject({
      status: 'ok',
      recovery: { action: 'recover' },
    });
    expect(await runtime.command(accepted)).toMatchObject({ status: 'applied' });
    const after = storageOwner.recovery.inspect(sessionId);
    expect(after.authority.status).toBe('idle');
    expect(await runtime.command(accepted)).toMatchObject({ status: 'idempotent_replay' });
    expect(storageOwner.recovery.inspect(sessionId)).toEqual(after);
  } finally {
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    rmSync(root, { recursive: true, force: true });
  }
});
