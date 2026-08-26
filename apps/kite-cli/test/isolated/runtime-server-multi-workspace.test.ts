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
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteMultiWorkspaceRuntimeServer } from '../../src/bootstrap';

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
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'shared-runtime.sqlite'),
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

function start(commandId: string, sessionId: string, input: string) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'start_turn' as const,
    sessionId,
    expectedRevision: 0,
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
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    const notification = await next(iterator);
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.activeWork?.status === 'completed'
    ) {
      return;
    }
  }
  throw new Error(`Runtime Session did not reach terminal state: ${sessionId}`);
}
