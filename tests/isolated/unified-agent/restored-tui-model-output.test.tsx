import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  type AgentClient,
  createClient,
  type Message,
  type ModelOutputSnapshot,
} from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import {
  serializeLoadedText,
  TuiController,
  type TuiLoadedTextExport,
  type TuiPort,
  TuiSession,
} from '@kite-ai/ui/tui';
import { render } from 'ink-testing-library';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const unavailable = async (): Promise<never> => {
  throw Error('restored_reader_must_not_write');
};
async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('restored_tui_model_deadline');
    await Bun.sleep(5);
  }
}
async function messages(client: AgentClient, id: string, upperSeq: string, signal?: AbortSignal) {
  const result: Message[] = [];
  let afterSeq = '0';
  for (;;) {
    const page = await client.listMessages(id, { afterSeq, upperSeq, limit: 200, signal });
    for (const message of page) {
      if (
        message.sessionId !== id ||
        BigInt(message.seq) <= BigInt(afterSeq) ||
        BigInt(message.seq) > BigInt(upperSeq)
      )
        throw Error('history_identity_mismatch');
      result.push(message);
      afterSeq = message.seq;
    }
    if (page.length < 200) return result;
  }
}

test('restored shared TUI reads plain and sealed original Model bodies with real keys, loaded export and late-scope cancellation through two cold HTTP runtimes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-restored-tui-model-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const originalStoreId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const content = `Original recorded answer\n${'Original text 原🌿e\u0301 '.repeat(4096).trimEnd()}\nTUI_RESTORED_EXACT_TAIL`;
  const reasoning = 'Original private reasoning 雪🙂\nTUI_ORIGINAL_REASONING_TAIL';
  const call = { id: 'original-check', name: 'fixture.check', arguments: '{}' };
  const model = createFixedModel([
    [
      { type: 'text_delta', text: content },
      { type: 'reasoning_delta', text: reasoning },
      { type: 'tool_call', ...call },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Original small final answer' }, finish],
  ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.check',
            version: '1',
            description: 'Original Tool once',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'Original Tool checked' };
            },
          },
        ],
      },
    ],
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let controller: TuiController | undefined;
  let app: ReturnType<typeof render> | undefined;
  let release: (() => void) | undefined;
  let coldStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let coldRuntime: ReturnType<typeof createRuntime> | undefined;
  let businessFailed = false;
  let cleanupFailed = false;
  let businessError: unknown;
  const cleanupErrors: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const closePage = () => {
    const errors: unknown[] = [];
    if (app) {
      let closed = true;
      try {
        app.unmount();
      } catch (error) {
        errors.push(error);
        closed = false;
      }
      try {
        app.cleanup();
      } catch (error) {
        errors.push(error);
        closed = false;
      }
      if (closed) app = undefined;
    }
    try {
      controller?.dispose();
      controller = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      cleanupFailed = true;
      throw new AggregateError(errors, 'restored_tui_page_cleanup_failed');
    }
  };
  const close = async () => {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => {
      release?.();
      release = undefined;
    });
    await attempt(closePage);
    await attempt(() => {
      client?.disposeNetwork();
      client = undefined;
    });
    await attempt(async () => {
      await service?.close();
      service = undefined;
    });
    await attempt(async () => {
      await coldRuntime?.close();
      coldRuntime = undefined;
    });
    // A failed Runtime close remains an owner; do not close its Store underneath it.
    if (!coldRuntime)
      await attempt(async () => {
        await coldStore?.close();
        coldStore = undefined;
      });
    if (errors.length) {
      cleanupFailed = true;
      throw new AggregateError(errors, 'restored_tui_cleanup_failed');
    }
  };
  const connect = async (currentRuntime: ReturnType<typeof createRuntime>) => {
    service = await startService({
      runtime: currentRuntime,
      profile,
      buildId: 'restored-tui-model',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['model_outputs'] },
    });
    await client.connect();
    return client;
  };
  try {
    const original = await connect(runtime);
    await original.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      name: 'Original workspace',
      rootUri: pathToFileURL(root).href,
    });
    for (const [sessionId, title] of [
      ['source', 'Original source'],
      ['other', 'Other session'],
    ] as const)
      await original.createSession({
        expectedStoreId: originalStoreId,
        sessionId,
        workspaceId: 'workspace',
        commandId: `create-${sessionId}`,
        title,
      });
    await original.startRun('source', {
      expectedStoreId: originalStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: 'Original selected work',
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    const source = await original.getView('source');
    const originalMessages = await messages(original, 'source', source.session.nextSeq);
    const bodyMessage = originalMessages.find((message) => message.outputBody)!;
    expect(bodyMessage).toBeDefined();
    expect(bodyMessage.content).not.toContain('TUI_RESTORED_EXACT_TAIL');
    const saved = await original.getModelOutput('source', bodyMessage.outputBody!.executionId);
    expect(saved.output).toEqual({ content, reasoning, toolCalls: [call], complete: true });
    expect(bodyMessage.outputBody).toMatchObject({
      contentBytes: saved.contentBytes,
      reasoningBytes: saved.reasoningBytes,
      toolCallCount: saved.output.toolCalls.length,
      complete: saved.output.complete,
    });
    const originalExecutions = await Promise.all(
      source.executions.map((execution) => original.getExecution(execution.id)),
    );
    const originalRuns = await Promise.all(source.runs.map((run) => original.getRun(run.id)));
    expect(originalExecutions).toHaveLength(3);
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    const fork = await original.forkSession('source', {
      expectedStoreId: originalStoreId,
      commandId: 'fork',
      expectedContextSelectionId: source.session.contextSelectionId,
      newSessionId: 'sealed',
      title: 'Original sealed branch',
    });
    expect(fork.command.status).toBe('applied');
    const sealedView = await original.getView('sealed');
    const sealedMessages = await messages(original, 'sealed', sealedView.session.nextSeq);
    expect(sealedMessages).toHaveLength(originalMessages.length);
    expect(
      sealedMessages.every((message) => message.originMessage?.storeId === originalStoreId),
    ).toBe(true);
    const commands = await Promise.all(
      ['create-source', 'create-other', 'original-run', 'fork'].map((id) =>
        original.getCommand(id),
      ),
    );
    await close();
    const backup = await createProfileBackup({
      profile: selected,
      destinationRoot: join(root, 'backups'),
    });
    const restored = await restoreProfileBackup({
      profile: selected,
      expectedStoreId: originalStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.outcome).toBe('restored');
    expect(restored.storeId).not.toBe(originalStoreId);
    for (let cold = 0; cold < 2; cold++) {
      const currentStore = await openSqliteStore(selected);
      coldStore = currentStore;
      const readonlyModel = createFixedModel([]);
      const currentRuntime = createRuntime({
        store: currentStore,
        artifacts: createArtifactStore({ profile: selected, store: currentStore }),
        model: readonlyModel,
        modelId: 'readonly',
        permissions: {
          async authorize() {
            return { allowed: false, revision: 'readonly' };
          },
        },
      });
      coldRuntime = currentRuntime;
      const methods: string[] = [];
      globalThis.fetch = Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          methods.push(init?.method ?? (url instanceof Request ? url.method : 'GET'));
          return originalFetch(url, init);
        },
        { preconnect: originalFetch.preconnect },
      );
      const admitted = await connect(currentRuntime);
      expect(admitted.serverInfo?.storeId).toBe(restored.storeId);
      const metadata = await currentStore.getMetadata();
      const exports: { snapshot: TuiLoadedTextExport; text: string }[] = [];
      const reads: {
        sessionId: string;
        executionId: string;
        signal: AbortSignal;
        snapshot: ModelOutputSnapshot;
      }[] = [];
      let hold = false;
      let held = false;
      let finished = false;
      const port: TuiPort = {
        storeId: restored.storeId,
        nextCommandId: () => {
          throw Error('restored_reader_must_not_create_intent');
        },
        listSessions: async (signal) =>
          (await admitted.listAllSessions({ signal })).map(({ id, title }) => ({ id, title })),
        async readSession(id, signal) {
          const view = await admitted.getView(id, { signal });
          return {
            storeId: restored.storeId,
            view,
            messages: await messages(admitted, id, view.session.nextSeq, signal),
            interactions: [],
          };
        },
        async readModelOutput(sessionId, executionId, signal) {
          const snapshot = await admitted.getModelOutput(sessionId, executionId, {
            expectedStoreId: restored.storeId,
            signal,
          });
          reads.push({ sessionId, executionId, signal, snapshot });
          if (hold) {
            hold = false;
            held = true;
            finished = false;
            // Delay only the verified public Core reply. The original body and identities are untouched.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            finished = true;
          }
          return snapshot;
        },
        exportLoadedText: {
          async write(snapshot, signal) {
            signal.throwIfAborted();
            exports.push({ snapshot, text: serializeLoadedText(snapshot) });
            return { path: 'trusted-test-loaded-export.md' };
          },
        },
        submit: unavailable,
        answer: unavailable,
        cancel: unavailable,
        getCommand: (id) => admitted.getCommand(id),
      };
      const mount = async (id: string) => {
        controller = new TuiController(port);
        await controller.select(id);
        app = render(<TuiSession controller={controller} />);
        await Bun.sleep(20);
      };
      const key = async (input: string) => {
        app!.stdin.write(input);
        await Bun.sleep(20);
      };
      for (const id of ['source', 'sealed']) {
        await mount(id);
        const message = controller!.state.snapshot!.messages.find((item) => item.outputBody)!;
        expect(controller!.state.snapshot!.storeId).toBe(restored.storeId);
        expect(controller!.state.snapshot!.messages).toEqual(
          id === 'source' ? originalMessages : sealedMessages,
        );
        expect(controller!.state.loadedOutputBodies.size).toBe(0);
        expect(app!.lastFrame()).not.toContain('TUI_ORIGINAL_REASONING_TAIL');
        const before = reads.length;
        await key('/export\r');
        await settle(() => exports.length === (id === 'source' ? 1 : 3));
        expect(exports.at(-1)!.text).toContain('Loaded preview only');
        expect(exports.at(-1)!.text).not.toContain('TUI_RESTORED_EXACT_TAIL');
        expect(reads).toHaveLength(before);
        await key(id === 'source' ? '\x0f' : '\x14');
        await settle(
          () => controller!.state.loadedOutputBodies.has(message.id) || !!controller!.state.error,
        );
        expect(controller!.state.error).toBeUndefined();
        expect(reads).toHaveLength(before + 1);
        expect(reads.at(-1)!.sessionId).toBe('source');
        expect(reads.at(-1)!.executionId).toBe(saved.executionId);
        expect(reads.at(-1)!.snapshot).toEqual({
          ...saved,
          storeId: restored.storeId,
          snapshotCursor: metadata.lastChangeCursor,
        });
        expect(controller!.state.fullOutputs.get(message.id)).toBe(content);
        expect(controller!.state.loadedOutputBodies.get(message.id)).toEqual(saved.output);
        await settle(() => app!.lastFrame()!.includes('TUI_RESTORED_EXACT_TAIL'));
        if (id === 'source') {
          expect(app!.lastFrame()).not.toContain('TUI_ORIGINAL_REASONING_TAIL');
          await key('\x14');
        }
        await settle(() => app!.lastFrame()!.includes('TUI_ORIGINAL_REASONING_TAIL'));
        await key('\x14');
        await settle(() => !app!.lastFrame()!.includes('TUI_ORIGINAL_REASONING_TAIL'));
        await key('\x14');
        await settle(() => app!.lastFrame()!.includes('TUI_ORIGINAL_REASONING_TAIL'));
        expect(reads).toHaveLength(before + 1);
        await key('/export\r');
        await settle(() => exports.length === (id === 'source' ? 2 : 4));
        const exported = exports.at(-1)!;
        expect(exported.snapshot.storeId).toBe(restored.storeId);
        expect(exported.snapshot.sessionId).toBe(id);
        expect(exported.snapshot.messages.find((item) => item.id === message.id)).toMatchObject({
          content,
          reasoning,
          previewOnly: false,
          complete: true,
        });
        expect(exported.text).toContain(content);
        expect(exported.text).toContain(
          '> Original private reasoning 雪🙂\n> TUI_ORIGINAL_REASONING_TAIL',
        );
        expect(exported.text).not.toContain('Loaded preview only');
        expect(reads).toHaveLength(before + 1);
        closePage();
      }
      // Both selected-Session invalidation and observer disposal retain the real read's abort boundary.
      for (const dispose of [false, true]) {
        await mount('sealed');
        hold = true;
        held = false;
        const before = reads.length;
        await key('\x0f');
        await settle(() => held);
        expect(reads).toHaveLength(before + 1);
        expect(reads.at(-1)!.snapshot.output).toEqual(saved.output);
        expect(controller!.state.loadedOutputBodies.size).toBe(0);
        const previous = controller!;
        if (dispose) closePage();
        else await previous.select('other');
        expect(reads.at(-1)!.signal.aborted).toBe(true);
        release!();
        release = undefined;
        await settle(() => finished);
        await Bun.sleep(5);
        expect(previous.state.loadedOutputBodies.size).toBe(0);
        expect(previous.state.fullOutputs.size).toBe(0);
        if (!dispose) {
          expect(previous.state.sessionId).toBe('other');
          expect(app!.lastFrame()).not.toContain('TUI_RESTORED_EXACT_TAIL');
          expect(app!.lastFrame()).not.toContain('TUI_ORIGINAL_REASONING_TAIL');
          closePage();
        }
      }
      expect(await currentStore.getMetadata()).toEqual(metadata);
      for (const execution of originalExecutions)
        expect(await admitted.getExecution(execution.id)).toEqual(execution);
      for (const run of originalRuns) expect(await admitted.getRun(run.id)).toEqual(run);
      for (const command of commands)
        expect(await admitted.getCommand(command.id)).toEqual(command);
      expect(readonlyModel.requests).toHaveLength(0);
      expect(model.requests).toHaveLength(2);
      expect(effects).toBe(1);
      expect(methods.length).toBeGreaterThan(0);
      expect(methods.every((method) => method === 'GET')).toBe(true);
      await close();
      globalThis.fetch = originalFetch;
    }
  } catch (error) {
    businessFailed = true;
    businessError = error;
  } finally {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    globalThis.fetch = originalFetch;
    try {
      await runtime.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (
      !cleanupFailed &&
      !cleanupErrors.length &&
      !service &&
      !coldRuntime &&
      !coldStore &&
      !app &&
      !controller
    )
      rmSync(root, { recursive: true, force: true });
    else if (!cleanupErrors.length)
      cleanupErrors.push(Error(`restored_tui_cleanup_unconfirmed:${root}`));
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(businessFailed ? [businessError] : []), ...cleanupErrors],
      `restored_tui_cleanup_failed_root_retained:${root}`,
    );
  if (businessFailed) throw businessError;
}, 20000);
