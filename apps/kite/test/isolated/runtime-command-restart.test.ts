import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeCommand,
} from '@kite-ai/runtime-contract';
import { createRuntimeCommandCommitEvidence } from '@kite-ai/runtime-host';
import { createKiteCliRuntimeAccess, createKiteRuntimeStorageOwner } from '../../src/bootstrap';

type RestartCommand =
  | Extract<RuntimeCommand, { type: 'create_session' }>
  | Extract<RuntimeCommand, { type: 'start_turn' }>;

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
    expect(started).toEqual({
      status: 'applied',
      commandId: start.commandId,
      sessionId,
      revision: expect.any(Number),
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
    const reopenedStore = createKiteRuntimeStorageOwner(checkpointPath);
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
      reopenedStore.storage.close();
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
    expect(replayedStart).toEqual({
      status: 'idempotent_replay',
      commandId: start.commandId,
      sessionId,
      originalRevision: startRevision,
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

function createAccess(input: {
  readonly workspace: string;
  readonly checkpointPath: string;
  readonly sessionId: string;
  readonly baseURL: string;
}) {
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
    shellExecutor: async ({ command }) => ({
      ok: true,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    interactionMode: 'accept_edits',
    sandboxBackend: 'none',
    skillOptions: {
      userKiteCodeSkillsDir: join(input.workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(input.workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(input.workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(input.workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  });
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
