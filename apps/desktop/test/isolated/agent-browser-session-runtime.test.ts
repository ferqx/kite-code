import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import {
  createBrowserController,
  createBrowserExtension,
  type NativeBrowserTransport,
} from '@kite-ai/agent/browser';
import type { Json } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { AgentClient } from '@kite-ai/client';
import { NativeExtensions } from '../../electron/extensions';
import { decodeNativeRequest } from '../../electron/native-ipc';
import {
  type AgentBrowserObservation,
  AgentBrowserObserver,
} from '../../src/agent-browser-observer';
import type { NativeExtensionScope } from '../../src/extensions-bridge';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';

const until = async (check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('browser_session_runtime_timeout');
    await Bun.sleep(5);
  }
};

test('switching A to B and back only releases observers while the original Runtime browser action completes in A', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-browser-session-runtime-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'browser' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const destination = 'https://example.test/completed-in-a';
  let releaseNavigation!: () => void, finishOwner!: (value: { confirmed: boolean }) => void;
  const navigation = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    finishOwner = resolve;
  });
  let navigationSignal: AbortSignal | undefined,
    ownerSignal: AbortSignal | undefined,
    starts = 0,
    closes = 0,
    disposals = 0,
    modelTurns = 0,
    bindings = 0,
    page = 'https://example.test/';
  const commands: Record<string, Json>[] = [];
  const transport: NativeBrowserTransport = {
    ready: Promise.resolve(),
    completion,
    async request(command, signal) {
      commands.push(command);
      if (command.action === 'navigate') {
        if (command.url === destination) {
          navigationSignal = signal;
          await navigation;
          signal.throwIfAborted();
        }
        page = String(command.url);
      }
      return {
        success: true,
        data: { url: page, title: page === destination ? 'Completed in A' : 'A is working' },
      };
    },
    async capture() {
      return {
        frame: { mimeType: 'image/jpeg', data: '/9j/2Q==', width: 800, height: 600 },
        annotations: [],
        url: page,
        title: page === destination ? 'Completed in A' : 'A is working',
      };
    },
    async close() {
      closes++;
      finishOwner({ confirmed: true });
      return { confirmed: true };
    },
    async dispose() {
      disposals++;
    },
  };
  const controller = createBrowserController({
    createTransport(context) {
      starts++;
      ownerSignal = context.signal;
      return transport;
    },
    captureIntervalMs: 60000,
  });
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      const turn = ++modelTurns;
      if (turn === 1) {
        yield {
          type: 'tool_call',
          id: 'open-a',
          name: 'browser_open',
          arguments: JSON.stringify({ key: 'original-a', url: page }),
        };
      } else if (turn === 2) {
        await until(() => controller.view('a')?.state === 'agent');
        signal.throwIfAborted();
        const view = controller.view('a')!;
        yield {
          type: 'tool_call',
          id: 'navigate-a',
          name: 'browser_navigate',
          arguments: JSON.stringify({
            key: 'navigate-original',
            browser_id: view.browserId,
            generation: view.generation,
            url: destination,
          }),
        };
      } else if (turn !== 3) throw Error('unexpected_model_redispatch');
      yield { ...finish, reason: turn < 3 ? 'tool_calls' : 'stop' };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'controlled-browser-fixture',
    extensions: [createBrowserExtension({ controller })],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-browser-fixture' };
      },
    },
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'controlled-browser-fixture',
        snapshot: {},
        async dispose() {
          bindings++;
        },
      };
    },
  });
  let scope: NativeExtensionScope = {
    generation: 1,
    viewSelection: 1,
    historyEpoch: 0,
    storeId: expectedStoreId,
    sessionId: 'a',
    workspaceId: 'workspace',
    contextSelectionId: 'unselected',
  };
  // Only the client transport is substituted; queries enter the real Runtime/SQLite owner.
  const client = {
    serverInfo: { storeId: expectedStoreId, subjectId: 'owner' },
    async listExtensions() {
      return runtime.getExtensionCatalogue();
    },
    async queryExtension(
      sessionId: string,
      extensionId: string,
      queryId: string,
      input: Json,
      options: { signal?: AbortSignal },
    ) {
      options.signal?.throwIfAborted();
      const views = await runtime.queryExtension({
        expectedStoreId,
        subjectId: 'owner',
        sessionId,
        extensionId,
        queryId,
        input,
      });
      options.signal?.throwIfAborted();
      return views;
    },
  } as unknown as AgentClient;
  const unexpectedWrite = async (): Promise<never> => {
    throw Error('observation_must_not_submit');
  };
  const main = new NativeExtensions(client, () => scope, {
    prepare: unexpectedWrite,
    submit: unexpectedWrite,
    lookup: unexpectedWrite,
    records: () => [],
    releaseFirst() {
      throw Error('observation_must_not_release_command');
    },
  });
  const calls: NativeRequest[] = [];
  const bridge = {
    async request(raw: NativeRequest) {
      calls.push(raw);
      const request = decodeNativeRequest(raw);
      switch (request.method) {
        case 'extensions.open':
          return main.open(request);
        case 'extensions.query':
          return main.query(request);
        case 'extensions.read':
          return main.read(request);
        case 'extensions.close':
          main.close(request.readId);
          return undefined;
        case 'extensions.release':
          main.release();
          return undefined;
        default:
          throw Error(`unexpected_observer_write:${request.method}`);
      }
    },
  } as NativeBridge;
  let observer: AgentBrowserObserver | undefined;
  let observed: AgentBrowserObservation = {
    fresh: false,
    loading: true,
    available: false,
    pending: false,
  };
  const select = async (sessionId: string) => {
    // NativeDesktop selection unmounts its panel, whose cleanup calls this exact stop path.
    observer?.stop();
    const selected = await runtime.getView(sessionId);
    scope = {
      ...scope,
      viewSelection: scope.viewSelection + 1,
      sessionId,
      contextSelectionId: selected.session.contextSelectionId,
    };
    observer = new AgentBrowserObserver(
      bridge,
      scope,
      (state) => {
        observed = state;
      },
      true,
    );
    observer.start(true);
    await until(() => observed.fresh);
  };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'browser',
    });
    for (const sessionId of ['a', 'b']) {
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'workspace',
        commandId: `create-${sessionId}`,
        subjectId: 'owner',
        title: `Session ${sessionId}`,
      });
    }
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'a',
      commandId: 'work-in-a',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Open and test a page' },
    });
    await until(async () => {
      const failed = (await store.listExecutions('a')).find(
        (execution) => execution.status === 'failed',
      );
      if (failed) throw Error(JSON.stringify({ modelTurns, failed }));
      return !!navigationSignal;
    });
    const before = await store.listExecutions('a');
    const job = before.find((execution) => execution.definitionId === 'browser.session')!;
    const action = before.find((execution) => execution.definitionId === 'browser.navigate')!;
    expect(job.status).toBe('running');
    expect(action.status).toBe('dispatching');
    await select('a');
    const original = observed.view!;
    expect(original.browserId).toBe('original-a');
    expect(original.title).toBe('A is working');
    await select('b');
    expect(observed.view).toBeUndefined();
    expect(calls.filter((call) => call.method === 'extensions.release')).toHaveLength(1);
    expect(navigationSignal!.aborted).toBe(false);
    expect(ownerSignal!.aborted).toBe(false);
    expect(closes).toBe(0);
    expect(disposals).toBe(0);
    expect((await store.getExecution(action.id))?.status).toBe('dispatching');
    releaseNavigation();
    await runtime.waitForCommand('work-in-a', { timeoutMs: 4000 });
    expect(modelTurns).toBe(3);
    expect(scope.sessionId).toBe('b');
    expect(observed.view).toBeUndefined();
    const completed = await store.getExecution(action.id);
    expect(completed?.status).toBe('succeeded');
    expect(completed?.result).toMatchObject({
      details: { url: destination, browserId: original.browserId },
    });
    expect((await store.getExecution(job.id))?.status).toBe('running');
    expect(bindings).toBe(0);
    await select('a');
    expect(observed.view).toMatchObject({
      browserId: original.browserId,
      generation: original.generation,
      url: destination,
      title: 'Completed in A',
      state: 'agent',
    });
    expect(observed.view!.seq).not.toBe(original.seq);
    expect(starts).toBe(1);
    expect(
      commands.filter((command) => command.action === 'navigate' && command.url === destination),
    ).toHaveLength(1);
    expect(calls.some((call) => call.method === 'extensions.invoke')).toBe(false);
    expect(await store.listExecutions('b')).toHaveLength(0);
    expect(closes).toBe(0);
    expect(disposals).toBe(0);
  } finally {
    releaseNavigation();
    observer?.stop();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
  expect(closes).toBe(1);
  expect(disposals).toBe(1);
}, 15000);
