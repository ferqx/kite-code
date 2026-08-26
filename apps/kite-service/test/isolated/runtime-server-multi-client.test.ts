import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeClientInteraction,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeServerInProcessHub,
  type RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeAccess } from '../../src/bootstrap';

test('same command receipt is replayed and a slow outer client cannot block terminal projection', async () => {
  const fixture = createFixture('multi-client-session', [{ message: { content: 'terminal' } }]);
  const first = fixture.first;
  const second = fixture.second;
  try {
    await createSession(first, fixture.sessionId);
    const fast = await first.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const fastIterator = fast[Symbol.asyncIterator]();
    await next(fastIterator);
    const slow = await second.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const slowIterator = slow[Symbol.asyncIterator]();

    const command = start(
      'same-command',
      fixture.sessionId,
      0,
      'Respond once without calling a tool.',
    );
    const results = await Promise.all([first.command(command), second.command(command)]);
    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'idempotent_replay']);
    await terminalProjection(fastIterator, fixture.sessionId);
    expect(fixture.model.getRequestCount()).toBe(1);
    await expect(
      second.command(start('same-command', fixture.sessionId, 0, 'different body')),
    ).resolves.toMatchObject({ status: 'rejected', code: 'invalid_command' });
    expect(fixture.model.getRequestCount()).toBe(1);
    await slowIterator.return?.();
    await fastIterator.return?.();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test('two outer clients settle one real CLI ask_user interaction only once', async () => {
  const fixture = createFixture(
    'interaction-race-session',
    [
      {
        message: {
          tool_calls: [
            {
              id: 'ask-name',
              name: 'ask_user',
              args: {
                questions: [
                  {
                    question: 'Which name should be used?',
                    options: [
                      { label: 'Ada', description: 'Use Ada.', recommended: true },
                      { label: 'Grace', description: 'Use Grace.', recommended: false },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'The selected name is recorded.' } },
    ],
    'full',
  );
  try {
    await createSession(fixture.first, fixture.sessionId);
    const stream = await fixture.first.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const iterator = stream[Symbol.asyncIterator]();
    await next(iterator);
    const second = await fixture.second.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const secondIterator = second[Symbol.asyncIterator]();
    await fixture.first.command(
      start('interaction-start', fixture.sessionId, 0, 'Ask for a name.'),
    );
    const interaction = await inputInteraction(iterator, fixture.second, fixture.sessionId);
    const response = respond('interaction-response', fixture.sessionId, interaction, 'Ada');
    const results = await Promise.all([
      fixture.first.command(response),
      fixture.second.command(response),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'idempotent_replay']);
    await waitFor(() => fixture.model.getRequestCount() === 2);
    await terminalProjection(iterator, fixture.sessionId, fixture.first);
    expect(fixture.model.getRequestCount()).toBe(2);
    await secondIterator.return?.();
    await iterator.return?.();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test('disconnecting the presenting client keeps the broker-backed interaction alive', async () => {
  const fixture = createFixture(
    'interaction-disconnect-session',
    [
      {
        message: {
          tool_calls: [
            {
              id: 'ask-after-disconnect',
              name: 'ask_user',
              args: {
                questions: [
                  {
                    question: 'Continue after disconnect?',
                    options: [
                      { label: 'Continue', description: 'Continue.', recommended: true },
                      { label: 'Stop', description: 'Stop.', recommended: false },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      { message: { content: 'Continued after the original client disconnected.' } },
    ],
    'full',
  );
  try {
    await createSession(fixture.first, fixture.sessionId);
    const firstStream = await fixture.first.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const firstIterator = firstStream[Symbol.asyncIterator]();
    await next(firstIterator);
    const survivingStream = await fixture.second.subscribeReady({
      spec: { scope: 'session', sessionId: fixture.sessionId },
    });
    const survivingIterator = survivingStream[Symbol.asyncIterator]();
    await next(survivingIterator);
    await fixture.first.command(
      start('interaction-disconnect-start', fixture.sessionId, 0, 'Ask before continuing.'),
    );
    const interaction = await inputInteraction(firstIterator, fixture.second, fixture.sessionId);

    await fixture.first.close();
    await expect(
      fixture.second.command(
        respond('interaction-disconnect-response', fixture.sessionId, interaction, 'Continue'),
      ),
    ).resolves.toMatchObject({ status: 'applied' });
    await terminalProjection(survivingIterator, fixture.sessionId, fixture.second);
    expect(fixture.model.getRequestCount()).toBe(2);
    await survivingIterator.return?.();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test('different start ids at one revision commit once and dispatch once', async () => {
  const fixture = createFixture('revision-race-session', [{ message: { content: 'winner' } }]);
  try {
    await createSession(fixture.first, fixture.sessionId);
    const results = await Promise.all([
      fixture.first.command(start('revision-first', fixture.sessionId, 0, 'first')),
      fixture.second.command(start('revision-second', fixture.sessionId, 0, 'second')),
    ]);
    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(
      results.some(
        (result) =>
          result.status === 'conflict' ||
          (result.status === 'rejected' && result.code === 'runtime_busy'),
      ),
    ).toBe(true);
    await waitFor(() => fixture.model.getRequestCount() === 1);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

function createFixture(
  sessionId: string,
  responses: Parameters<ReturnType<typeof createMockModelServer>['setResponses']>[0],
  interactionMode: 'accept_edits' | 'full' = 'accept_edits',
) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-multi-client-'));
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  model.setResponses(responses);
  const backend = createKiteCliRuntimeAccess({
    sessionId,
    userId: 'integration-user',
    workspace,
    checkpointPath: join(workspace, 'runtime.sqlite'),
    config: {
      providerName: 'integration-model',
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
    interactionMode,
    sandboxBackend: 'none',
    skillOptions: skillOptions(workspace),
    initialSkillActivations: [],
  });
  const admission: RuntimeServerAdmissionPort = {
    authorize: async () => ({ allowed: true, workspace }),
  };
  const hub = createRuntimeServerInProcessHub(
    { runtime: backend, admission },
    { serverInfo: { version: 'integration', instanceId: `outer-${sessionId}` } },
  );
  const first = client(hub.open.bind(hub), 'first');
  const second = client(hub.open.bind(hub), 'second');
  return {
    sessionId,
    model,
    first,
    second,
    dispose: async () => {
      await first.close();
      await second.close();
      await hub.server.beginDraining();
      await backend[Symbol.asyncDispose]();
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(resolve(workspace), { recursive: true, force: true });
    },
  };
}

function client(
  open: () => ReturnType<ReturnType<typeof createRuntimeServerInProcessHub>['open']>,
  instanceId: string,
) {
  const transport: RuntimeClientTransport = {
    connect: async () => {
      const pair = open();
      return {
        send: (message) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason) => pair.client.close(reason),
      };
    },
  };
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'runtime-server-multi-client', version: '1', instanceId },
  });
}

async function createSession(client: RuntimeClient, sessionId: string): Promise<void> {
  await client.command({
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'create-session',
    type: 'create_session',
    workspace: '/wire',
    bootstrapSessionId: sessionId,
  });
}

function start(commandId: string, sessionId: string, expectedRevision: number, input: string) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'start_turn' as const,
    sessionId,
    expectedRevision,
    input,
  };
}

function respond(
  commandId: string,
  sessionId: string,
  interaction: Extract<RuntimeClientInteraction, { kind: 'input' }>,
  value: string,
) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'respond_interaction' as const,
    sessionId,
    expectedRevision: interaction.sessionRevision,
    interaction,
    response: { kind: 'text' as const, value },
  };
}

async function inputInteraction(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  client: RuntimeClient,
  sessionId: string,
): Promise<Extract<RuntimeClientInteraction, { kind: 'input' }>> {
  const seen: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    let notification: RuntimeAccessNotification;
    try {
      notification = await next(iterator);
    } catch {
      break;
    }
    if ('durability' in notification && notification.durability === 'durable') {
      const event = notification.projection.event;
      seen.push(
        `${notification.revision}:${event?.type ?? notification.projection.session.activeWork?.status ?? 'snapshot'}`,
      );
      if (event?.type === 'interaction.available' && event.interaction.kind === 'input') {
        return event.interaction;
      }
      if (event?.type === 'input.requested') return event.interaction;
      const fromProjection = notification.projection.session.activeWork?.activeTurn?.interaction;
      if (fromProjection?.kind === 'input') return fromProjection;
    }
  }
  const projection = await client.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_session_projection',
    sessionId,
  });
  throw new Error(
    `CLI ask_user interaction was not projected; seen=${seen.join(',')}; query=${JSON.stringify(projection)}`,
  );
}

async function terminalProjection(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  client?: RuntimeClient,
): Promise<void> {
  const seen: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    let notification: RuntimeAccessNotification;
    try {
      notification = await next(iterator);
    } catch {
      break;
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      ['completed', 'cancelled', 'failed'].includes(
        notification.projection.session.activeWork?.status ?? '',
      )
    )
      return;
    if ('durability' in notification && notification.durability === 'durable') {
      seen.push(
        `${notification.revision}:${notification.projection.event?.type ?? notification.projection.session.activeWork?.status ?? 'snapshot'}`,
      );
    }
  }
  const projection = client
    ? await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      })
    : undefined;
  if (
    projection?.status === 'ok' &&
    projection.session &&
    ['completed', 'cancelled', 'failed'].includes(projection.session.activeWork?.status ?? '')
  ) {
    return;
  }
  throw new Error(
    `Runtime subscription did not publish a terminal projection; seen=${seen.join(',')}; query=${JSON.stringify(projection)}`,
  );
}

async function next(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<RuntimeAccessNotification> {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(3_000).then(() => {
      throw new Error('Timed out waiting for notification.');
    }),
  ]);
  if (item.done) throw new Error('Runtime subscription closed before terminal projection.');
  return item.value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for model dispatch.');
}

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}
