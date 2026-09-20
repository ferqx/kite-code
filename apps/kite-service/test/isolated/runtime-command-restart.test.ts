import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeState } from '@kite-ai/agent-kernel';
import { classifyBuiltinShellIntent } from '@kite-ai/builtin-runtime';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeClientInteraction,
  type RuntimeCommand,
} from '@kite-ai/runtime-contract';
import { createRuntimeCommandCommitEvidence } from '@kite-ai/runtime-host';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteCliRuntimeAccess,
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';
import { APP_PREPARED_SHELL_EXECUTION_ } from '../../src/sandbox/prepared-tool-pipeline';

type RestartCommand =
  | Extract<RuntimeCommand, { type: 'create_session' }>
  | Extract<RuntimeCommand, { type: 'start_turn' }>;

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');

test('Store 6 reopens committed create/start receipts after a provider connection loss without redispatching', async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-command-restart-'));
  const checkpointPath = join(workspace, 'runtime.sqlite');
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createConnectionLossModelGate();
  const sessionId = 'restart-session';
  const create = createSessionCommand(sessionId);
  const start = startTurnCommand(sessionId, 'Run exactly one gated model attempt.');
  const first = createAccess({ workspace, checkpointPath, sessionId, baseURL: model.baseURL });
  let second: ReturnType<typeof createKiteCliRuntimeAccess> | undefined;

  try {
    const created = await first.command(create);
    if (created.status !== 'applied') throw new Error('Create command was not applied.');
    const createRevision = created.revision;
    expect(created).toEqual({
      status: 'applied',
      commandId: create.commandId,
      sessionId,
      revision: 0,
    });

    const started = await first.command(start);
    if (started.status !== 'applied') throw new Error('Start command was not applied.');
    const startRevision = started.revision;
    expect(startRevision).toBeNumber();
    expect(started).toMatchObject({
      status: 'applied',
      commandId: start.commandId,
      sessionId,
      revision: expect.any(Number),
      resource: {
        kind: 'run',
        run: { sessionId, status: 'queued' },
        messageId: expect.any(String),
      },
    });

    // This barrier proves the committed command has crossed into the provider
    // attempt before the connection is lost. It avoids timing-based sleeps.
    await model.waitForRequest();
    expect(model.requestCount()).toBe(1);
    model.releaseConnectionLoss();
    await first[Symbol.asyncDispose]();

    // Read through a newly opened Store owner, not the closed first Host. The
    // receipt's original applied revision remains the command decision,
    // while shutdown/recovery may have advanced State to a terminal revision.
    const reopenedStore = await createKiteSessionAppServerStorageComposition({
      databasePath: join(workspace, 'kite-session.sqlite'),
      hostInstanceId: 'restart-receipt-observer',
    });
    try {
      const storedStart = reopenedStore.storage.commandReceipts.lookup(receiptLookup(start));
      expect(storedStart).toMatchObject({
        status: 'replay',
        receipt: {
          scopeSessionId: sessionId,
          commandId: start.commandId,
          targetSessionId: sessionId,
          committedRevision: startRevision,
        },
      });
      expect(
        reopenedStore.storage.sessions
          .loadEventsStrict(sessionId)
          .some((entry) => entry.event.type === 'turn.aborted'),
      ).toBe(true);
    } finally {
      reopenedStore.disposeStorage();
    }

    second = createAccess({ workspace, checkpointPath, sessionId, baseURL: model.baseURL });
    const replayedCreate = await second.command(create);
    expect(replayedCreate).toEqual({
      status: 'idempotent_replay',
      commandId: create.commandId,
      sessionId,
      originalRevision: createRevision,
    });

    const replayedStart = await second.command(start);
    expect(replayedStart).toMatchObject({
      status: 'idempotent_replay',
      commandId: start.commandId,
      sessionId,
      originalRevision: startRevision,
      resource: {
        kind: 'run',
        run: { sessionId, status: 'queued' },
        messageId: expect.any(String),
      },
    });
    // A replay is an acknowledgement of the original commit, never a fake
    // terminal result; terminal State is only observed through State/query.
    expect(replayedStart.status).not.toBe('applied');
    expect(replayedStart).not.toHaveProperty('revision');
    expect(model.requestCount()).toBe(1);

    const changedBody = await second.command({
      ...start,
      input: 'The same command ID with a different body must fail closed.',
    });
    expect(changedBody).toEqual({
      status: 'rejected',
      commandId: start.commandId,
      code: 'invalid_command',
    });
    expect(model.requestCount()).toBe(1);

    const projection = await second.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(projection).toMatchObject({
      status: 'ok',
      session: { sessionId },
    });
    if (projection.status !== 'ok' || !projection.session) {
      throw new Error('Restarted session projection is unavailable.');
    }
    expect(projection.session.revision).toBeNumber();
    expect(projection.session.revision).toBeGreaterThan(startRevision);

    // Retrying after the persisted terminal State remains a receipt replay and
    // must neither prepare nor dispatch another provider attempt.
    await expect(second.command(start)).resolves.toEqual(replayedStart);
    expect(model.requestCount()).toBe(1);
  } finally {
    await second?.[Symbol.asyncDispose]();
    await first[Symbol.asyncDispose]();
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
});

test('a pending approval stays durable while a crashed execution owner remains fenced', async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-approval-restart-'));
  const checkpointPath = join(workspace, 'runtime.sqlite');
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createApprovalRestartModel();
  const sessionId = 'restart-approval-session';
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'fixtures', 'runtime-pending-approval-child.ts'),
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        KITE_CODE_HOME: workspace,
        KITE_RESTART_TEST_WORKSPACE: workspace,
        KITE_RESTART_TEST_CHECKPOINT: checkpointPath,
        KITE_RESTART_TEST_SESSION: sessionId,
        KITE_RESTART_TEST_MODEL_URL: model.baseURL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  try {
    const interaction = JSON.parse(
      await readFirstLine(child.stdout, child.stderr),
    ) as RuntimeClientInteraction;
    expect(interaction).toMatchObject({ kind: 'approval', sessionRevision: expect.any(Number) });
    if (interaction.kind !== 'approval') throw new Error('Child did not persist an approval.');

    await waitForPersistedInteraction(checkpointPath, sessionId, interaction.interactionId);

    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);

    const store = await createKiteSessionAppServerStorageComposition({
      databasePath: join(resolve(checkpointPath, '..'), 'kite-session.sqlite'),
      hostInstanceId: 'restart-interaction-observer',
    });
    try {
      const snapshot = store.storage.sessions.loadSnapshotRecord<RuntimeState>(sessionId);
      expect(snapshot?.state.pendingApprovals.has(interaction.interactionId)).toBe(true);
      expect(store.recovery.inspect(sessionId).authority.status).toBe('active');
      expect(model.requestCount()).toBe(1);
    } finally {
      store.disposeStorage();
    }
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
}, 30_000);

test('restart recovery interrupts an unfinished required child without replaying its parent Run', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-required-background-restart-'));
  const workspace = join(root, 'workspace');
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = 'required-background-restart-session';
  const model = createMockModelServer();
  const childRequestStarted = deferred<void>();
  const childResponseGate = deferred<void>();
  mkdirSync(workspace, { recursive: true });
  model.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'required-background-crash-child',
            name: 'task',
            args: {
              name: 'Crash-bound required child',
              subagent_type: 'explore',
              task: 'REQUIRED_BACKGROUND_CRASH_CHILD',
              background: true,
              result_disposition: 'required',
            },
          },
        ],
      },
      toolContinuation: 'required',
    },
    {
      message: { content: 'The parent must wait for the required child.' },
      expectedRequest: { toolResults: [{ toolCallId: 'required-background-crash-child' }] },
    },
    {
      response: async () => {
        childRequestStarted.resolve();
        await childResponseGate.promise;
        return { message: { content: 'This child result must never be admitted.' } };
      },
    },
  ]);
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'fixtures', 'runtime-required-background-wait-child.ts'),
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        KITE_CODE_HOME: root,
        KITE_RESTART_TEST_WORKSPACE: workspace,
        KITE_RESTART_TEST_DATABASE: databasePath,
        KITE_RESTART_TEST_SESSION: sessionId,
        KITE_RESTART_TEST_MODEL_URL: model.baseURL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let restarted: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let runtime: RuntimeClient | undefined;
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  try {
    const ready = JSON.parse(await readFirstLine(child.stdout, child.stderr)) as { runId: string };
    expect(ready.runId).toBeString();
    await bounded(childRequestStarted.promise, 'child Provider request');
    expect(model.getRequestCount()).toBe(3);
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);

    // The dead owner used a 200 ms lease. Waiting beyond that boundary lets the
    // restarted owner fence it through the production recovery path.
    await Bun.sleep(250);
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'required-background-restart-owner',
      executionLeaseMs: 200,
      renewIntervalMs: 50,
    });
    restarted = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [restartRuntimeInput(workspace, model.baseURL)],
    });
    runtime = restartClient(restarted, workspace);

    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session',
        commandId: 'resume-required-background-after-crash',
        sessionId,
      }),
    ).toMatchObject({ status: 'applied' });
    await waitForRestartCondition(
      () => storage!.storage.runs?.get(sessionId, ready.runId)?.status !== 'running',
    );

    const snapshot = storage.loadCurrentSnapshot(sessionId);
    const run = storage.storage.runs?.get(sessionId, ready.runId);
    const events = storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    expect(run).toMatchObject({
      runId: ready.runId,
      status: 'failed',
      terminal: { reasonCode: 'runtime_failed', safeRetry: false },
    });
    expect(snapshot?.turn.status).toBe('aborted');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.failed',
        subagent: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
    expect(model.getRequestCount()).toBe(3);

    await expect(
      runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'required-background-crash-start',
        sessionId,
        expectedRevision: 0,
        input: 'REQUIRED_BACKGROUND_CRASH_PARENT',
      }),
    ).resolves.toMatchObject({ status: 'idempotent_replay' });
    expect(model.getRequestCount()).toBe(3);
  } finally {
    childResponseGate.resolve();
    child.kill('SIGKILL');
    await child.exited;
    await runtime?.close();
    await restarted?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop(true);
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

function createAccess(input: {
  readonly workspace: string;
  readonly checkpointPath: string;
  readonly sessionId: string;
  readonly baseURL: string;
  readonly sandboxBackend?: 'none' | 'seatbelt';
  readonly shellExecutor?: (command: string) => Promise<void>;
}) {
  const shellExecutor = async ({ command }: { readonly command: string }) => {
    await input.shellExecutor?.(command);
    return {
      ok: true,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  };
  Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
    enumerable: false,
    value: Object.freeze({
      execute: async (prepared: { readonly command: string }) => {
        await input.shellExecutor?.(prepared.command);
        return Object.freeze({
          ok: true,
          command: prepared.command,
          exitCode: 0,
          stdout: '',
          stderr: '',
          intent: classifyBuiltinShellIntent(prepared.command),
          executionPhase: 'go_started' as const,
        });
      },
    }),
  });
  return createKiteCliRuntimeAccess({
    sessionId: input.sessionId,
    userId: 'restart-user',
    workspace: input.workspace,
    checkpointPath: input.checkpointPath,
    config: {
      providerName: 'restart-model',
      providerType: 'openai-compatible',
      apiKey: 'restart-test-key',
      baseURL: input.baseURL,
      modelName: 'mock-model',
      sandbox: { enabled: false },
    },
    shellExecutor,
    interactionMode: 'accept_edits',
    sandboxBackend: input.sandboxBackend ?? 'none',
    skillOptions: {
      userKiteCodeSkillsDir: join(input.workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(input.workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(input.workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(input.workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  });
}

async function readFirstLine(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => {
        throw new Error('Approval child stdout timed out.');
      }),
    ]);
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const newline = buffered.indexOf('\n');
    if (newline >= 0) return buffered.slice(0, newline);
  }
  const diagnostic = await new Response(stderr).text();
  throw new Error(`Approval child did not become ready: ${diagnostic}`);
}

async function waitForPersistedInteraction(
  checkpointPath: string,
  sessionId: string,
  interactionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const store = await createKiteSessionAppServerStorageComposition({
      databasePath: join(resolve(checkpointPath, '..'), 'kite-session.sqlite'),
      hostInstanceId: `restart-interaction-observer-${attempt}`,
    });
    try {
      const snapshot = store.storage.sessions.loadSnapshotRecord<RuntimeState>(sessionId);
      if (snapshot?.state.pendingApprovals.has(interactionId)) return;
    } finally {
      store.disposeStorage();
    }
    await Bun.sleep(10);
  }
  throw new Error('Approval child did not make its interaction durable before process death.');
}

function createSessionCommand(
  sessionId: string,
): Extract<RuntimeCommand, { type: 'create_session' }> {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'restart-create-command',
    type: 'create_session',
    workspace: '/untrusted-wire-workspace',
    bootstrapSessionId: sessionId,
  };
}

function startTurnCommand(
  sessionId: string,
  input: string,
): Extract<RuntimeCommand, { type: 'start_turn' }> {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'restart-start-command',
    type: 'start_turn',
    sessionId,
    expectedRevision: 0,
    input,
  };
}

function receiptLookup(command: RestartCommand) {
  const evidence = createRuntimeCommandCommitEvidence({
    command,
    targetSessionId:
      command.type === 'create_session' ? command.bootstrapSessionId! : command.sessionId,
    committedAt: 0,
  });
  return {
    scopeSessionId: evidence.scopeSessionId,
    commandId: evidence.commandId,
    requestDigest: evidence.requestDigest,
  };
}

function restartRuntimeInput(workspace: string, baseURL: string) {
  return {
    userId: 'required-background-restart-user',
    workspace,
    config: {
      providerName: 'required-background-restart-model',
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

function restartClient(
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
    clientInfo: { name: 'required-background-restart', version: '1', instanceId: 'client' },
  });
}

async function waitForRestartCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Timed out waiting for restart recovery.');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(10_000).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
}

/** A provider fixture whose request and response are independently gated. */
function createConnectionLossModelGate() {
  let requests = 0;
  let release!: () => void;
  let notifyRequest!: () => void;
  const requestObserved = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
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
        requests += 1;
        notifyRequest();
        await responseGate;
        return Response.json(
          { error: { message: 'socket ECONNRESET: gated provider connection loss' } },
          { status: 503 },
        );
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    waitForRequest: () => requestObserved,
    requestCount: () => requests,
    releaseConnectionLoss: () => release(),
    stop: () => server.stop(true),
  };
}

function createApprovalRestartModel() {
  const server = createMockModelServer();
  server.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'restart-shell',
            name: 'shell_execute',
            args: { command: 'bun test' },
          },
        ],
      },
    },
    { message: { content: 'Restarted approval completed.' } },
  ]);
  return {
    baseURL: server.baseURL,
    requestCount: () => server.getRequestCount(),
    stop: () => server.stop(),
  };
}
