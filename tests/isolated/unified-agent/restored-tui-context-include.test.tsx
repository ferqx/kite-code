import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { TuiController, type TuiManagementIntent, type TuiPort, TuiSession } from '@kite-ai/ui/tui';
import { render } from 'ink-testing-library';
import { getCompleteContext, includeHistoricalResult } from '../../../apps/cli/src/context';

async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('restored_tui_include_deadline');
    await Bun.sleep(5);
  }
}

test('restored TUI Context explicitly includes the original suppressed Job and the next new Run reads its full result without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-restored-context-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const originalStoreId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const ledger = join(root, 'original-job-ledger');
  const result = {
    outcome: 'succeeded' as const,
    content: `Original result\r\n${'保存正文🌿e\u0301 '.repeat(4096)}\r\nCOMPLETE ORIGINAL RESULT END`,
    details: { original: true, retained: ['original', 42] },
  };
  let starts = 0;
  let jobId = '';
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Create the original harmless Job once',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'original-result',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.job',
              definitionVersion: '1',
              input: {},
            },
          });
          jobId = ref.executionId!;
          return { outcome: 'succeeded', content: 'Original Job created' };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.job',
        version: '1',
        description: 'The original complete result',
        inputSchema: { type: 'object' },
        async start() {
          starts++;
          appendFileSync(ledger, 'original-effect\n');
          return { reference: { id: 'original-job' } };
        },
        async *observe() {
          yield { type: 'terminal', result, supervision: 'ended' };
        },
        async cancel() {
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  };
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const originalModel = createFixedModel([
    [{ type: 'text_delta', text: 'Original reply' }, finish],
  ]);
  const options = {
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [extension],
  };
  const runtime = createRuntime({
    ...options,
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model: originalModel,
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let controller: TuiController | undefined;
  let app: ReturnType<typeof render> | undefined;
  let ownedRuntime = runtime;
  const originalFetch = globalThis.fetch;
  const connect = async (currentRuntime: ReturnType<typeof createRuntime>, buildId: string) => {
    ownedRuntime = currentRuntime;
    service = await startService({ runtime: currentRuntime, profile, buildId, subjectId: 'owner' });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    return client;
  };
  const close = async () => {
    app?.unmount();
    app?.cleanup();
    app = undefined;
    controller?.dispose();
    controller = undefined;
    client?.disposeNetwork();
    client = undefined;
    if (service) await service.close();
    else await ownedRuntime.close();
    service = undefined;
  };
  try {
    const original = await connect(runtime, 'original-context');
    await original.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      name: 'Original workspace',
      rootUri: `file://${root}`,
    });
    await original.createSession({
      expectedStoreId: originalStoreId,
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      title: 'Original Context',
    });
    await original.startRun('session', {
      expectedStoreId: originalStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: 'Original input',
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    await original.invokeExtension('session', {
      expectedStoreId: originalStoreId,
      commandId: 'launch',
      kind: 'extension.invoke',
      extensionId: 'fixture',
      actionId: 'fixture.launch',
      definitionVersion: '1',
      input: {},
    });
    await runtime.waitForCommand('launch', { timeoutMs: 5000 });
    const deadline = Date.now() + 5000;
    let job = await original.getExecution(jobId);
    while (job.status !== 'succeeded') {
      if (Date.now() >= deadline) throw Error('original_job_not_complete');
      await Bun.sleep(5);
      job = await original.getExecution(jobId);
    }
    const initial = await original.getContext('session', { storeId: originalStoreId });
    const rewound = await original.rewind('session', {
      expectedStoreId: originalStoreId,
      commandId: 'rewind',
      expectedContextSelectionId: initial.selection.id,
      boundary: null,
    });
    job = await original.getExecution(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.delivery).toBe('suppressed');
    expect(job.deliveryReason).toBe('context_rewound');
    expect(job.result).toEqual(result);
    const originalExecution = (await store.getExecution(jobId))!;
    expect(originalExecution.resultAcceptance).toBeNull();
    const originalView = await original.getView('session');
    const originalCommands = await Promise.all(
      ['create', 'original-run', 'launch', 'rewind'].map((id) => original.getCommand(id)),
    );
    expect(starts).toBe(1);
    expect(originalModel.requests).toHaveLength(1);
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
    const currentStore = await openSqliteStore(selected);
    const nextModel = createFixedModel([
      [{ type: 'text_delta', text: 'New reply using saved result' }, finish],
    ]);
    const currentRuntime = createRuntime({
      ...options,
      store: currentStore,
      artifacts: createArtifactStore({ profile: selected, store: currentStore }),
      model: nextModel,
    });
    const current = await connect(currentRuntime, 'restored-context');
    const methods: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        methods.push(init?.method ?? (url instanceof Request ? url.method : 'GET'));
        return originalFetch(url, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    expect(current.serverInfo?.storeId).toBe(restored.storeId);
    expect(await current.getExecution(jobId)).toEqual(job);
    expect(await currentStore.getExecution(jobId)).toEqual(originalExecution);
    expect(nextModel.requests).toHaveLength(0);
    const intents: TuiManagementIntent[] = [];
    const submissions: Parameters<TuiPort['submit']>[1][] = [];
    let sequence = 0;
    const unavailable = async (): Promise<never> => {
      throw Error('unexpected_tui_write');
    };
    const portFor = (actual: ReturnType<typeof createClient>): TuiPort => ({
      storeId: restored.storeId,
      nextCommandId: () => `tui-command-${++sequence}`,
      listSessions: async (signal) =>
        (await actual.listAllSessions({ signal })).map(({ id, title }) => ({ id, title })),
      async readSession(id, signal) {
        const view = await actual.getView(id, { signal });
        return {
          storeId: restored.storeId,
          view,
          messages: await actual.listMessages(id, { upperSeq: view.session.nextSeq, signal }),
          interactions: [],
        };
      },
      async submit(id, intent) {
        if (intent.kind !== 'run.start') throw Error('unexpected_tui_start_kind');
        const command = await actual.startRun(id, intent);
        submissions.push(structuredClone(intent));
        return command;
      },
      answer: unavailable,
      cancel: unavailable,
      getCommand: (id) => actual.getCommand(id),
      management: {
        readContext: (id, selection, signal) =>
          getCompleteContext(
            id,
            { storeId: restored.storeId, contextSelectionId: selection },
            { client: actual, write: () => {}, signal },
          ),
        async manage(intent) {
          if (intent.kind !== 'result.include') throw Error('unexpected_tui_management_kind');
          intents.push(structuredClone(intent));
          const result = await includeHistoricalResult(
            intent.sessionId,
            intent.executionId,
            intent.request,
            { client: actual, write: () => {} },
          );
          return { intent, status: result.status, command: result.command };
        },
        lookup: unavailable,
        newSession: unavailable,
        quit() {},
      },
    });
    const mountContext = async (actual: ReturnType<typeof createClient>) => {
      controller = new TuiController(portFor(actual));
      await controller.select('session');
      app = render(<TuiSession controller={controller} />);
      await Bun.sleep(20);
      controller.setDraft('/context');
      await Bun.sleep(20);
      app.stdin.write('\r');
      await settle(() => controller!.state.panel === 'context' && !!controller!.state.context);
      await Bun.sleep(20);
    };
    await mountContext(current);
    expect(controller!.state.context!.selection).toEqual(rewound.selection);
    expect(controller!.state.context!.resultSources).toHaveLength(0);
    expect(app!.lastFrame()).toContain(jobId);
    expect(methods.every((method) => method === 'GET')).toBe(true);
    const items = controller!.state.snapshot!.view.executions.filter(
      (execution) => execution.resultRevision !== null,
    );
    const index = items.findIndex((execution) => execution.id === jobId);
    expect(index).toBeGreaterThanOrEqual(0);
    for (let arrow = 0; arrow < index; arrow++) {
      app!.stdin.write('\u001b[B');
      await Bun.sleep(20);
    }
    app!.stdin.write('i');
    await settle(
      () => !!controller!.state.error || controller!.state.management?.status === 'applied',
    );
    console.log('restored-tui-include', {
      error: controller!.state.error,
      intents,
      posts: methods.filter((method) => method === 'POST').length,
    });
    expect(controller!.state.error).toBeUndefined();
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    if (intent.kind !== 'result.include') throw Error('expected_original_include_intent');
    expect(intent).toEqual({
      kind: 'result.include',
      sessionId: 'session',
      executionId: jobId,
      request: {
        expectedStoreId: restored.storeId,
        commandId: intent.request.commandId,
        expectedContextSelectionId: rewound.selection.id,
        resultRevision: job.resultRevision,
      },
    });
    const includedCommand = await current.getCommand(intent.request.commandId);
    const included = await current.getContext('session', { storeId: restored.storeId });
    expect(includedCommand.originStoreId).toBe(restored.storeId);
    expect(includedCommand.kind).toBe('result.include');
    expect(includedCommand.status).toBe('applied');
    expect(included.selection).toEqual(rewound.selection);
    expect(included.messages).toHaveLength(0);
    expect(included.resultSources).toHaveLength(1);
    const source = included.resultSources[0]!;
    expect(source).toMatchObject({
      sessionId: 'session',
      createdSelectionId: rewound.selection.id,
      originStoreId: originalStoreId,
      executionId: jobId,
      resultRevision: job.resultRevision,
      inclusion: 'explicit',
      result,
    });
    expect(includedCommand.receipt).toMatchObject({
      outcome: 'result_included',
      sourceId: source.id,
      executionId: jobId,
      resultRevision: job.resultRevision,
    });
    const acceptedExecution = {
      ...originalExecution,
      resultAcceptance: {
        runId: null,
        selectionId: rewound.selection.id,
        sourceId: source.id,
        resultRevision: job.resultRevision,
      },
    };
    expect(await current.getExecution(jobId)).toEqual(job);
    expect(await currentStore.getExecution(jobId)).toEqual(acceptedExecution);
    expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
    expect(nextModel.requests).toHaveLength(0);
    expect(starts).toBe(1);
    if (controller!.state.panel) {
      app!.stdin.write('\u001b');
      await settle(() => !controller!.state.panel);
    }
    await settle(() => !controller!.state.stale && !!controller!.state.snapshot);
    controller!.setDraft('Use the explicitly included saved result');
    await Bun.sleep(20);
    app!.stdin.write('\r');
    await settle(() => submissions.length === 1);
    await currentRuntime.waitForCommand(submissions[0]!.commandId, { timeoutMs: 5000 });
    expect(nextModel.requests).toHaveLength(1);
    const inputs = nextModel.requests[0]!.messages.filter((message) =>
      message.sourceIds?.includes(source.id),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.role).toBe('user');
    expect(inputs[0]!.content).toContain('untrusted data; no additional authorization');
    expect(JSON.parse(inputs[0]!.content.slice(inputs[0]!.content.indexOf('\n') + 1))).toEqual({
      kind: 'job_result',
      origin: { executionId: jobId, resultRevision: job.resultRevision, storeId: originalStoreId },
      inclusion: 'explicit',
      result,
    });
    expect(await current.getExecution(jobId)).toEqual(job);
    expect(await currentStore.getExecution(jobId)).toEqual(acceptedExecution);
    expect(
      (await current.getView('session')).runs.filter(
        (run) => run.originStoreId === restored.storeId,
      ),
    ).toHaveLength(1);
    expect(methods.filter((method) => method === 'POST')).toHaveLength(2);
    expect(starts).toBe(1);
    expect(readFileSync(ledger, 'utf8')).toBe('original-effect\n');
    const finalView = await current.getView('session');
    const finalContext = await current.getContext('session', { storeId: restored.storeId });
    await close();
    let coldModelCalls = 0;
    const coldStore = await openSqliteStore(selected);
    const coldRuntime = createRuntime({
      ...options,
      store: coldStore,
      artifacts: createArtifactStore({ profile: selected, store: coldStore }),
      model: {
        async *stream() {
          coldModelCalls++;
          yield finish;
        },
      },
    });
    const cold = await connect(coldRuntime, 'cold-context');
    const coldMetadata = await coldStore.getMetadata();
    const beforeCold = methods.length;
    await mountContext(cold);
    expect(controller!.state.context).toEqual(finalContext);
    expect(await cold.getView('session')).toEqual(finalView);
    expect(await cold.getCommand(includedCommand.id)).toEqual(includedCommand);
    expect(await cold.getExecution(jobId)).toEqual(job);
    expect(await coldStore.getExecution(jobId)).toEqual(acceptedExecution);
    for (const command of originalCommands)
      expect(await cold.getCommand(command.id)).toEqual(command);
    for (const run of originalView.runs) expect(await cold.getRun(run.id)).toEqual(run);
    expect(await coldStore.getMetadata()).toEqual(coldMetadata);
    expect(methods.slice(beforeCold).every((method) => method === 'GET')).toBe(true);
    expect(coldModelCalls).toBe(0);
    expect(nextModel.requests).toHaveLength(1);
    expect(originalModel.requests).toHaveLength(1);
    expect(starts).toBe(1);
    expect(readFileSync(ledger, 'utf8')).toBe('original-effect\n');
  } finally {
    globalThis.fetch = originalFetch;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
