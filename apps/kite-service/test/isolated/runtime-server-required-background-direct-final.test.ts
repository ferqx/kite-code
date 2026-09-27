import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { openRuntimeServerInProcessPair } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeServer } from '../../src/bootstrap';

test('required background completion resumes the same Run and permits a direct final without task_read', async () => {
  const workspace = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-required-background-direct-final-')),
  );
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  const childTerminal = deferred<void>();
  const childRequestStarted = deferred<void>();
  const resumedParentRequestSeen = deferred<void>();
  let parentRequestCount = 0;
  const emittedParentToolNames: string[] = [];

  const resolveResponse = async (request: {
    messages: Array<{
      role?: string;
      content?: unknown;
      tool_calls?: Array<{ name?: string }>;
    }>;
  }) => {
    const snapshot = JSON.stringify(request.messages);
    const isChildRequest = !request.messages.some(
      (message) => message.role === 'user' && message.content === 'DIRECT_FINAL_PARENT_START',
    );
    if (isChildRequest) {
      childRequestStarted.resolve();
      await childTerminal.promise;
      return { message: { content: 'DIRECT_FINAL_CHILD_RESULT' } };
    }

    parentRequestCount += 1;
    if (parentRequestCount === 1) {
      emittedParentToolNames.push('task');
      return {
        message: {
          tool_calls: [
            {
              id: 'required-background-direct-final-start',
              name: 'task',
              args: {
                name: 'Direct final child',
                subagent_type: 'review',
                task: 'DIRECT_FINAL_CHILD_TASK',
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
      return {
        message: {
          content: 'This provisional final must not complete while required work is pending.',
        },
        expectedRequest: {
          toolResults: [{ toolCallId: 'required-background-direct-final-start' }],
        },
      };
    }

    expect(snapshot).toContain('DIRECT_FINAL_CHILD_RESULT');
    resumedParentRequestSeen.resolve();
    return {
      message: { content: 'Required background result was consumed directly.' },
    };
  };
  model.setResponses(Array.from({ length: 5 }, () => ({ response: resolveResponse })));

  const sessionId = 'required-background-direct-final-session';
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
      name: 'required-background-direct-final-test',
      version: '1',
      instanceId: 'client',
    },
  });

  try {
    await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-required-background-direct-final-session',
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
      commandId: 'start-required-background-direct-final-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'DIRECT_FINAL_PARENT_START',
    });

    const waiting = await runStatusNotification(iterator, sessionId, 'waiting');
    const waitingRun = waiting.projection.session.currentRun;
    expect(waitingRun).toMatchObject({
      status: 'waiting',
      waitingReason: { kind: 'required_background' },
    });
    await bounded(childRequestStarted.promise, 'child model request start');
    expect(parentRequestCount).toBe(2);
    expect(model.getRequestCount()).toBe(3);

    // The required child remains blocked here. A short observation window proves
    // that waiting does not poll the parent model or accept its provisional final.
    await Bun.sleep(100);
    expect(parentRequestCount).toBe(2);
    expect(model.getRequestCount()).toBe(3);
    expect(waitingRun?.status).not.toBe('completed');

    childTerminal.resolve();
    await bounded(resumedParentRequestSeen.promise, 'direct parent final after child completion');
    const terminal = await terminalNotification(iterator, sessionId);

    expect(terminal.projection.session.currentRun).toMatchObject({
      runId: waitingRun!.runId,
      status: 'completed',
    });
    expect(parentRequestCount).toBe(3);
    expect(model.getRequestCount()).toBe(4);
    expect(emittedParentToolNames).toEqual(['task']);
    expect(emittedParentToolNames).not.toContain('task_read');
  } finally {
    childTerminal.resolve();
    resumedParentRequestSeen.resolve();
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
  for (let index = 0; index < 80; index += 1) {
    const notification = await nextNotification(iterator);
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
      notification.projection.session.currentRun?.status === 'completed'
    ) {
      return notification;
    }
  }
  throw new Error('Runtime did not publish a terminal projection.');
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
