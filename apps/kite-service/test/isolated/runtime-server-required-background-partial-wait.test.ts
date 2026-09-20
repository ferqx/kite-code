import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeBackgroundExecutionProjection,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { openRuntimeServerInProcessPair } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeServer } from '../../src/bootstrap';

test('task_wait returns one completed required child while another remains running', async () => {
  const workspace = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-required-background-partial-wait-')),
  );
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  const childAGate = deferred<void>();
  const childBGate = deferred<void>();
  const childAStarted = deferred<void>();
  const childBStarted = deferred<void>();
  const taskWaitIssued = deferred<void>();
  const taskWaitReturnedToParent = deferred<void>();
  const finalParentRequestSeen = deferred<void>();
  let parentRequestCount = 0;
  let childATaskId: string | undefined;
  let childBTaskId: string | undefined;

  const resolveResponse = async (request: {
    messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  }) => {
    const snapshot = JSON.stringify(request.messages);
    if (snapshot.includes('PARTIAL_WAIT_CHILD_A') && !snapshot.includes('PARTIAL_WAIT_PARENT')) {
      childAStarted.resolve();
      await childAGate.promise;
      return { message: { content: 'PARTIAL_WAIT_RESULT_A' } };
    }
    if (snapshot.includes('PARTIAL_WAIT_CHILD_B') && !snapshot.includes('PARTIAL_WAIT_PARENT')) {
      childBStarted.resolve();
      await childBGate.promise;
      return { message: { content: 'PARTIAL_WAIT_RESULT_B' } };
    }

    parentRequestCount += 1;
    if (parentRequestCount === 1) {
      return {
        message: {
          tool_calls: [
            {
              id: 'partial-wait-start-a',
              name: 'task',
              args: {
                name: 'Partial wait child A',
                subagent_type: 'review',
                task: 'PARTIAL_WAIT_CHILD_A',
                background: true,
                result_disposition: 'required',
              },
            },
            {
              id: 'partial-wait-start-b',
              name: 'task',
              args: {
                name: 'Partial wait child B',
                subagent_type: 'review',
                task: 'PARTIAL_WAIT_CHILD_B',
                background: true,
                result_disposition: 'required',
              },
            },
          ],
        },
        toolContinuation: 'required' as const,
      };
    }
    if (parentRequestCount === 2) {
      const taskIds = [...new Set(snapshot.match(/subagent-[a-f0-9]+/gu) ?? [])];
      expect(taskIds).toHaveLength(2);
      [childATaskId, childBTaskId] = taskIds;
      taskWaitIssued.resolve();
      return {
        message: {
          tool_calls: [
            {
              id: 'partial-wait-for-either',
              name: 'task_wait',
              args: { task_ids: taskIds, timeout_ms: 60_000 },
            },
          ],
        },
        expectedRequest: {
          toolResults: [
            { toolCallId: 'partial-wait-start-a' },
            { toolCallId: 'partial-wait-start-b' },
          ],
        },
        toolContinuation: 'required' as const,
      };
    }
    if (parentRequestCount === 3) {
      expect(snapshot).toContain('partial-wait-for-either');
      expect(snapshot).toContain('PARTIAL_WAIT_RESULT_A');
      expect(snapshot).not.toContain('PARTIAL_WAIT_RESULT_B');
      taskWaitReturnedToParent.resolve();
      return {
        message: { content: 'Child A completed; continue waiting for required child B.' },
        expectedRequest: { toolResults: [{ toolCallId: 'partial-wait-for-either' }] },
      };
    }

    expect(snapshot).toContain('PARTIAL_WAIT_RESULT_B');
    finalParentRequestSeen.resolve();
    return { message: { content: 'Both required children completed.' } };
  };
  model.setResponses(Array.from({ length: 8 }, () => ({ response: resolveResponse })));

  const sessionId = 'required-background-partial-wait-session';
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
  const client = new RuntimeClient({
    transport: inProcessTransport(pair),
    clientInfo: {
      name: 'required-background-partial-wait-test',
      version: '1',
      instanceId: 'client',
    },
  });

  try {
    await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-required-background-partial-wait-session',
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
      commandId: 'start-required-background-partial-wait-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'PARTIAL_WAIT_PARENT',
    });

    await bounded(Promise.all([childAStarted.promise, childBStarted.promise]), 'both child starts');
    await bounded(taskWaitIssued.promise, 'task_wait issue');
    childAGate.resolve();
    await bounded(taskWaitReturnedToParent.promise, 'task_wait terminal result');

    const waiting = await runStatusNotification(iterator, sessionId, 'waiting');
    expect(waiting.projection.session.currentRun).toMatchObject({
      status: 'waiting',
      waitingReason: { kind: 'required_background' },
    });
    const background = await backgroundExecutions(client, sessionId);
    expect(background).toContainEqual(
      expect.objectContaining({ executionId: childATaskId, status: 'completed' }),
    );
    expect(background).toContainEqual(
      expect.objectContaining({ executionId: childBTaskId, status: 'running' }),
    );
    // Public background projections do not expose result disposition. The Run's
    // required_background wait combined with B's running execution proves that B
    // remains the outstanding required child after task_wait returns A.
    expect(waiting.projection.session.currentRun?.status).not.toBe('failed');

    childBGate.resolve();
    await bounded(finalParentRequestSeen.promise, 'parent resume after child B');
    const terminal = await terminalNotification(iterator, sessionId);
    expect(terminal.projection.session.currentRun).toMatchObject({
      runId: waiting.projection.session.currentRun?.runId,
      status: 'completed',
    });
    expect(parentRequestCount).toBe(4);
  } finally {
    childAGate.resolve();
    childBGate.resolve();
    taskWaitIssued.resolve();
    taskWaitReturnedToParent.resolve();
    finalParentRequestSeen.resolve();
    await client.close();
    await owner[Symbol.asyncDispose]();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
}, 30_000);

function inProcessTransport(
  pair: ReturnType<typeof openRuntimeServerInProcessPair>,
): RuntimeClientTransport {
  return Object.freeze({
    connect: async () => ({
      send: (message: RuntimeProtocolMessage) => pair.client.send(message),
      messages: async function* () {
        yield* pair.client.messages();
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

async function runStatusNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  status: 'waiting',
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  for (let index = 0; index < 120; index += 1) {
    const notification = await nextNotification(iterator);
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'failed'
    ) {
      throw new Error(`Run failed while waiting: ${JSON.stringify(notification)}`);
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === status
    ) {
      return notification;
    }
  }
  throw new Error(`Runtime did not publish ${status}.`);
}

async function terminalNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  for (let index = 0; index < 120; index += 1) {
    const notification = await nextNotification(iterator);
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'failed'
    ) {
      throw new Error(`Run failed before completion: ${JSON.stringify(notification)}`);
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'completed'
    ) {
      return notification;
    }
  }
  throw new Error('Runtime did not publish a terminal projection.');
}

async function backgroundExecutions(
  client: RuntimeClient,
  sessionId: string,
): Promise<readonly RuntimeBackgroundExecutionProjection[]> {
  const result = await client.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'list_background_executions',
    sessionId,
  });
  if (result.status !== 'ok' || !result.backgroundSnapshot) {
    throw new Error('Background execution snapshot is unavailable.');
  }
  return result.backgroundSnapshot.executions;
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

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}
