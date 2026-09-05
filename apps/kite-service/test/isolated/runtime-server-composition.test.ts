import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { openRuntimeServerInProcessPair } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeServer } from '../../src/bootstrap';

test('CLI Runtime Server owner composes one trusted session through an InProcess client', async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-server-composition-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'Composition terminal response.' } }]);
  const sessionId = 'composition-session';
  const owner = createKiteCliRuntimeServer({
    sessionId,
    userId: 'composition-user',
    workspace,
    checkpointPath: join(workspace, 'runtime.sqlite'),
    config: {
      providerName: 'composition-model',
      providerType: 'openai-compatible',
      apiKey: 'test-key',
      baseURL: model.baseURL,
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
    skillOptions: skillOptions(workspace),
    initialSkillActivations: [],
  });
  const pair = openRuntimeServerInProcessPair(owner.server);
  const receivedProtocolMessages: unknown[] = [];
  const client = new RuntimeClient({
    transport: inProcessTransport(pair, (message) => receivedProtocolMessages.push(message)),
    clientInfo: {
      name: 'kite-runtime-server-composition-test',
      version: '1',
      instanceId: 'composition-client',
    },
  });

  try {
    // The protocol request cannot replace the Workspace that App composition
    // already admitted for this one Server instance.
    await expect(
      client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'create-composition-session',
        type: 'create_session',
        workspace: '/untrusted-wire-workspace',
        bootstrapSessionId: sessionId,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId, revision: 0 });

    const queried = await client.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(queried).toMatchObject({
      status: 'ok',
      queryType: 'get_session_projection',
      session: { sessionId, revision: 0 },
    });
    expect(JSON.stringify(queried)).not.toContain('/untrusted-wire-workspace');

    await expect(
      client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: 'unadmitted-session',
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });

    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    const initial = await nextNotification(iterator);
    expect(initial).toMatchObject({ durability: 'durable', sessionId, revision: 0 });

    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'start-composition-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Respond once without calling a tool.',
    });
    expect(started).toMatchObject({ status: 'applied', sessionId });

    const terminal = await terminalNotification(iterator, sessionId);
    expect(terminal.projection.session.currentRun?.status).toBe('completed');
    expect(JSON.stringify(terminal)).not.toContain(workspace);
    expect(JSON.stringify(terminal)).not.toContain('/untrusted-wire-workspace');
    expect(model.getRequestCount()).toBe(1);

    // This is the App owner lifecycle, rather than a client wrapper or a
    // nested Server. It drains and closes the exact logical pair it owns.
    await owner[Symbol.asyncDispose]();
    expect(receivedProtocolMessages).toContainEqual(
      expect.objectContaining({ method: 'server/draining' }),
    );
    expect(pair.connection.state).toBe('closed');
    expect(owner.server.connectionCount).toBe(0);
    await waitFor(() => client.snapshotStore.getSnapshot().status === 'disconnected');
  } finally {
    await client.close();
    await owner[Symbol.asyncDispose]();
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
}, 30_000);

function inProcessTransport(
  pair: ReturnType<typeof openRuntimeServerInProcessPair>,
  onMessage: (message: unknown) => void,
): RuntimeClientTransport {
  return Object.freeze({
    connect: async () => ({
      send: (message: RuntimeProtocolMessage) => pair.client.send(message),
      messages: async function* () {
        for await (const message of pair.client.messages()) {
          onMessage(message);
          yield message;
        }
      },
      close: (reason?: string) => pair.client.close(reason),
    }),
  });
}

async function nextNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<RuntimeAccessNotification> {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(3_000).then(() => {
      throw new Error('Timed out waiting for a Runtime subscription notification.');
    }),
  ]);
  if (item.done) throw new Error('Runtime subscription closed before its initial projection.');
  return item.value;
}

async function terminalNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  const observed: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const notification = await nextNotification(iterator);
    if ('durability' in notification && notification.durability === 'durable') {
      observed.push(
        `${notification.revision}:${notification.projection.event?.type ?? notification.projection.kind}`,
      );
      if (
        notification.sessionId === sessionId &&
        notification.projection.session.currentRun?.status === 'completed'
      ) {
        return notification;
      }
    }
  }
  throw new Error(
    `Runtime subscription did not publish a terminal projection: ${observed.join(', ')}`,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the InProcess connection to close.');
}

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}
