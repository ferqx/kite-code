import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import {
  RuntimeClient,
  type RuntimeClientTransport,
  type RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../../kite-service/src/bootstrap';
import { createNativeTuiRuntimeClient } from '../../src/service-mode';

test('Native TUI facade keeps one required Run waiting across three staggered child terminals', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-tui-background-partial-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'tui-background-partial-host',
  });
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started = [deferred<void>(), deferred<void>(), deferred<void>()];
  const finalCandidate = deferred<void>();
  let parentCalls = 0;
  model.setResponses(
    Array.from({ length: 8 }, () => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        const snapshot = JSON.stringify(messages);
        for (let index = 0; index < 3; index += 1) {
          if (snapshot.includes(`TUI_CHILD_${index}`) && !snapshot.includes('TUI_PARENT')) {
            started[index]!.resolve();
            await gates[index]!.promise;
            return { message: { content: `TUI_RESULT_${index}` } };
          }
        }
        parentCalls += 1;
        if (parentCalls === 1)
          return {
            message: {
              tool_calls: [0, 1, 2].map((index) => ({
                id: `tui-start-${index}`,
                name: 'task',
                args: {
                  name: `TUI child ${index}`,
                  subagent_type: 'review',
                  task: `TUI_CHILD_${index}`,
                  background: true,
                  result_disposition: 'required',
                },
              })),
            },
            toolContinuation: 'required' as const,
          };
        if (parentCalls === 2) {
          finalCandidate.resolve();
          return {
            message: { content: 'Provisional TUI final while children are running.' },
            expectedRequest: {
              toolResults: [0, 1, 2].map((index) => ({ toolCallId: `tui-start-${index}` })),
            },
          };
        }
        for (let index = 0; index < 3; index += 1)
          expect(snapshot).toContain(`TUI_RESULT_${index}`);
        return { message: { content: 'TUI parent completed with three child results.' } };
      },
    })),
  );
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'tui-background-user',
        workspace,
        config: {
          providerName: 'tui-background-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          features: { resourceBudget: true },
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
      },
    ],
  });
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
  const history = {
    listSessions: async () => ({ entries: [], hasMore: false }),
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    loadSession: async () => {
      throw new Error('History is not used by this fixture.');
    },
  } as RuntimeHistoryClient;
  const runtime = new RuntimeClient({
    transport,
    clientInfo: {
      name: 'tui-required-background-service-test',
      version: '1',
      instanceId: 'tui-client',
    },
    history,
  });
  const connection: KiteAppServerConnection = {
    runtime,
    history,
    app: {} as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('Not used.');
      },
    },
    get status() {
      return runtime.snapshotStore.getSnapshot().status === 'closed' ? 'closed' : 'active';
    },
    get generation() {
      return runtime.connectionGeneration;
    },
    snapshotStore: runtime.snapshotStore,
    subscribe: (listener) => runtime.snapshotStore.subscribe(listener),
    prepareAppControl: async () => undefined,
    connect: async () => undefined,
    reconnect: () => runtime.reconnect(),
    close: async () => runtime.close('tui-test-close'),
    [Symbol.asyncDispose]: async () => runtime.close('tui-test-dispose'),
  };
  const facade = createNativeTuiRuntimeClient({ connection, workspace });
  const presentationTypes: string[] = [];
  try {
    const sessionId = facade.createSession(workspace);
    await facade.waitForSessionReady(sessionId);
    const session = facade.getRuntime(sessionId);
    expect(session).toBeDefined();
    const run = session!.runTask('TUI_PARENT', {
      dispatch: (action) => {
        if (action.type === 'ACCEPT_PRESENTATION_ENVELOPE')
          presentationTypes.push(action.event.event.type);
      },
    });
    await bounded(Promise.all([started[0]!.promise, started[1]!.promise, finalCandidate.promise]));
    const initial = await waitForProjection(
      facade,
      sessionId,
      (projection) => projection.currentRun?.waitingReason?.kind === 'required_background',
    );
    const runId = initial.currentRun?.runId;
    const initialIds =
      initial.currentRun?.waitingReason?.kind === 'required_background'
        ? initial.currentRun.waitingReason.taskIds
        : [];
    expect(initialIds).toHaveLength(3);
    gates[0]!.resolve();
    await bounded(started[2]!.promise);
    const partialCards = await waitForCards(facade, sessionId, (executions) =>
      executions.some((item) => item.displayName === 'TUI child 0' && item.status === 'completed'),
    );
    expect(partialCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: 'TUI child 0', status: 'completed' }),
        expect.objectContaining({ displayName: 'TUI child 1', status: 'running' }),
        expect.objectContaining({ displayName: 'TUI child 2', status: 'running' }),
      ]),
    );
    const partial = await facade.getSessionProjection(sessionId);
    expect(partial?.currentRun).toMatchObject({ runId, status: 'waiting' });
    expect(partial?.currentRun?.waitingReason).toMatchObject({
      kind: 'required_background',
      taskIds: initialIds,
    });
    expect(parentCalls).toBe(2);
    expect(presentationTypes).not.toContain('run.terminal');
    gates[1]!.resolve();
    await waitForCards(facade, sessionId, (executions) =>
      executions.some((item) => item.displayName === 'TUI child 1' && item.status === 'completed'),
    );
    expect(parentCalls).toBe(2);
    gates[2]!.resolve();
    await bounded(run);
    const terminal = await facade.getSessionProjection(sessionId);
    expect(terminal?.currentRun).toMatchObject({ runId, status: 'completed' });
    expect(parentCalls).toBe(3);
    expect(presentationTypes).toContain('run.terminal');
    expect(
      storage.storage.sessions
        .loadEventsStrict(sessionId)
        .filter(({ event }) => event.type === 'run.error'),
    ).toHaveLength(0);
  } finally {
    for (const gate of gates) gate.resolve();
    await facade.dispose();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(10_000).then(() => {
      throw new Error('Timed out waiting for TUI fixture.');
    }),
  ]);
}

async function waitForProjection(
  facade: ReturnType<typeof createNativeTuiRuntimeClient>,
  sessionId: string,
  matches: (
    projection: NonNullable<Awaited<ReturnType<typeof facade.getSessionProjection>>>,
  ) => boolean,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const projection = await facade.getSessionProjection(sessionId);
    if (projection && matches(projection)) return projection;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for TUI session projection.');
}

async function waitForCards(
  facade: ReturnType<typeof createNativeTuiRuntimeClient>,
  sessionId: string,
  matches: (
    executions: Awaited<ReturnType<typeof facade.listBackgroundExecutions>>['executions'],
  ) => boolean,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const executions = (await facade.listBackgroundExecutions(sessionId)).executions;
    if (matches(executions)) return executions;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for TUI background cards.');
}
