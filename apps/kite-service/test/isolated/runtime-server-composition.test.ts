import { Database } from 'bun:sqlite';
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
import { createPreparedAppShellExecutor } from '../../src/sandbox/composition';

test('one Runtime Run waits for required background work, accepts steering, and resumes with exact reads', async () => {
  const workspace = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-runtime-server-background-')),
  );
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  const shellTerminal = deferred<void>();
  const childTerminal = deferred<void>();
  const childRequestStarted = deferred<void>();
  const namedRequestSeen = deferred<void>();
  const allowExactReads = deferred<void>();
  const exactReadResultsSeen = deferred<void>();
  let parentRequest = 0;
  let shellId: string | undefined;
  let taskId: string | undefined;
  const requestSnapshots: string[] = [];
  const resolveResponse = async (request: {
    messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  }) => {
    const snapshot = JSON.stringify(request.messages);
    requestSnapshots.push(snapshot);
    if (
      !request.messages.some(
        (message) => message.role === 'user' && message.content === 'VERTICAL_PARENT_START',
      )
    ) {
      childRequestStarted.resolve();
      await childTerminal.promise;
      return { message: { content: 'VERTICAL_CHILD_RESULT' } };
    }
    parentRequest += 1;
    if (parentRequest === 1) {
      return {
        message: {
          tool_calls: [
            {
              id: 'vertical-child-start',
              name: 'task',
              args: {
                name: 'Vertical child',
                subagent_type: 'review',
                task: 'VERTICAL_CHILD_TASK',
                background: true,
                result_disposition: 'required',
              },
            },
          ],
        },
        toolContinuation: 'required' as const,
      };
    }
    if (parentRequest === 2) {
      taskId = extractStableId(snapshot, /subagent-[a-f0-9]+/u, 'background task');
      return {
        message: {
          tool_calls: [
            {
              id: 'vertical-shell-start',
              name: 'shell_execute',
              args: { command: 'pwd', yield_ms: 0 },
            },
          ],
        },
        expectedRequest: {
          toolResults: [{ toolCallId: 'vertical-child-start' }],
        },
        toolContinuation: 'required' as const,
      };
    }
    if (parentRequest === 3) {
      shellId = extractStableId(snapshot, /sh_[A-Za-z0-9._:-]+/u, 'managed shell');
      return {
        message: { content: 'This response must remain blocked while work is running.' },
        expectedRequest: { toolResults: [{ toolCallId: 'vertical-shell-start' }] },
      };
    }
    if (parentRequest === 4) {
      expect(snapshot).toContain('VERTICAL_STEER_INPUT');
      return { message: { content: 'Steering was incorporated; required work is still pending.' } };
    }
    const returnedToolCallIds = new Set(
      request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id),
    );
    if (
      returnedToolCallIds.has('vertical-shell-read') &&
      returnedToolCallIds.has('vertical-task-read')
    ) {
      expect(snapshot).toContain('vertical-shell-output');
      expect(snapshot).toContain('VERTICAL_CHILD_RESULT');
      exactReadResultsSeen.resolve();
      return {
        message: { content: 'Vertical run completed after both exact reads.' },
        expectedRequest: {
          toolResults: [
            { toolCallId: 'vertical-shell-read' },
            { toolCallId: 'vertical-task-read' },
          ],
        },
      };
    }
    expect(snapshot).toContain('VERTICAL_STEER_INPUT');
    if (snapshot.includes('VERTICAL_CHILD_RESULT')) {
      namedRequestSeen.resolve();
      await allowExactReads.promise;
      return {
        message: {
          tool_calls: [
            {
              id: 'vertical-shell-read',
              name: 'shell_read',
              args: { shell_id: shellId, wait_until: 'terminal' },
            },
            {
              id: 'vertical-task-read',
              name: 'task_read',
              args: { task_id: taskId },
            },
          ],
        },
        toolContinuation: 'required' as const,
      };
    }
    return { message: { content: 'A required background result is still pending.' } };
  };
  model.setResponses(Array.from({ length: 8 }, () => ({ response: resolveResponse })));
  const sessionId = 'background-composition-session';
  const shellExecutor = createPreparedAppShellExecutor({
    workspace,
    sandboxEnabled: false,
    resolveBackend: () => 'none',
    createNativeExecutor: () => async () => {
      throw new Error('The host-shell test seam must be selected.');
    },
    createHostExecutor:
      () =>
      async ({ command }) => {
        if (command === 'pwd') await shellTerminal.promise;
        return {
          ok: true,
          command,
          exitCode: 0,
          stdout: command === 'pwd' ? 'vertical-shell-output' : '',
          stderr: '',
        };
      },
  });
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
      modelKwargs: { maxOutputTokens: 64 },
      modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
      features: { resourceBudget: true },
      sandbox: { enabled: true },
    },
    shellExecutor,
    interactionMode: 'accept_edits',
    sandboxBackend: 'seatbelt',
    skillOptions: skillOptions(workspace),
    initialSkillActivations: [],
  });
  const pair = openRuntimeServerInProcessPair(owner.server);
  const protocolMessages: unknown[] = [];
  const client = new RuntimeClient({
    transport: inProcessTransport(pair, (message) => protocolMessages.push(message)),
    clientInfo: { name: 'background-composition-test', version: '1', instanceId: 'client' },
  });

  try {
    await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-background-session',
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await nextNotification(iterator);
    await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'start-background-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'VERTICAL_PARENT_START',
    });

    const waiting = await runStatusNotification(iterator, sessionId, 'waiting');
    const run = waiting.projection.session.currentRun;
    expect(run?.runId).toBeDefined();
    expect(run?.activeTurnId).toBeDefined();
    await bounded(childRequestStarted.promise, 'child model request start');
    expect(parentRequest).toBe(3);
    expect(model.getRequestCount()).toBe(4);

    await expect(
      client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'steer-background-turn',
        type: 'steer_turn',
        sessionId,
        expectedRunId: run!.runId,
        expectedTurnId: run!.activeTurnId!,
        input: 'VERTICAL_STEER_INPUT',
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });

    shellTerminal.resolve();
    childTerminal.resolve();
    childRequestStarted.resolve();
    try {
      await bounded(namedRequestSeen.promise, 'named child notification model request');
    } catch (error) {
      const background = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'list_background_executions',
        sessionId,
      });
      const database = new Database(join(workspace, 'kite-session.sqlite'), { readonly: true });
      const events = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId)
        .map((row) => JSON.parse(row.event_json) as { type?: string; [key: string]: unknown })
        .slice(-40);
      database.close();
      const presentation = protocolMessages.filter((message) =>
        JSON.stringify(message).includes('subagent'),
      );
      throw new Error(
        `${String(error)} requests=${model.getRequestCount()} parent=${parentRequest} background=${JSON.stringify(background)} subagentEvents=${JSON.stringify(events)} presentation=${JSON.stringify(presentation)}`,
      );
    }
    allowExactReads.resolve();
    await bounded(exactReadResultsSeen.promise, 'exact background read results');
    let terminal: Awaited<ReturnType<typeof terminalNotification>>;
    try {
      terminal = await terminalNotification(iterator, sessionId);
    } catch (error) {
      let projection: unknown;
      try {
        projection = await client.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        });
      } catch (queryError) {
        projection = { queryError: String(queryError) };
      }
      const protocolEvents = protocolMessages.flatMap((message) => {
        if (!message || typeof message !== 'object') return [];
        const params = (message as { params?: { message?: unknown } }).params;
        const notification = params?.message;
        if (!notification || typeof notification !== 'object') return [];
        const projectionValue = (notification as { projection?: { event?: { type?: string } } })
          .projection;
        return projectionValue?.event?.type ? [projectionValue.event.type] : [];
      });
      throw new Error(
        `Terminal notification failed; connection=${pair.connection.state}; requests=${model.getRequestCount()}; parent=${parentRequest}; projection=${JSON.stringify(projection)}; events=${protocolEvents.join(',')}; protocol=${JSON.stringify(protocolMessages.slice(-4))}; cause=${String(error)}`,
      );
    }
    expect(terminal.projection.session.currentRun).toMatchObject({
      runId: run!.runId,
      status: 'completed',
    });
    expect(parentRequest).toBeGreaterThanOrEqual(5);
    expect(model.getRequestCount()).toBe(parentRequest + 1);
    expect(
      requestSnapshots.filter((snapshot) => !snapshot.includes('VERTICAL_PARENT_START')),
    ).toHaveLength(1);
  } finally {
    shellTerminal.resolve();
    childTerminal.resolve();
    namedRequestSeen.resolve();
    allowExactReads.resolve();
    exactReadResultsSeen.resolve();
    await client.close();
    await owner[Symbol.asyncDispose]();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
}, 30_000);

test('CLI Runtime Server owner composes one trusted session through an InProcess client', async () => {
  const workspace = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-runtime-server-composition-')),
  );
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
  for (let index = 0; index < 120; index += 1) {
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

async function runStatusNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  status: 'waiting' | 'running',
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  const observed: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    let notification: RuntimeAccessNotification;
    try {
      notification = await nextNotification(iterator);
    } catch (error) {
      throw new Error(
        `Runtime did not publish ${status}; observed=${observed.join(', ')}; cause=${String(error)}`,
      );
    }
    if ('durability' in notification && notification.durability === 'durable') {
      observed.push(
        `${notification.revision}:${notification.projection.event?.type ?? notification.projection.kind}`,
      );
      if (
        notification.sessionId === sessionId &&
        notification.projection.session.currentRun?.status === status
      ) {
        return notification;
      }
    }
  }
  throw new Error(`Runtime did not publish ${status}: ${observed.join(', ')}`);
}

function extractStableId(snapshot: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(snapshot)?.[0];
  if (!match) throw new Error(`Model request did not include the ${label} identity: ${snapshot}`);
  return match;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(3_000).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
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
