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
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeContext } from '../../electron/context';
import { decodeNativeRequest } from '../../electron/native-ipc';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { NativeContextView } from '../../src/native-context';

async function settle(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('restored_native_context_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

test('restored Native Context explicitly includes the original suppressed Job and the next new Run reads its full result without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-restored-context-')));
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
  let host: NativeContext | undefined;
  let dom: JSDOM | undefined;
  let rendered: ReturnType<typeof createRoot> | undefined;
  const originalFetch = globalThis.fetch;
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  const connect = async (currentRuntime: ReturnType<typeof createRuntime>, buildId: string) => {
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
    host?.release();
    client?.disposeNetwork();
    client = undefined;
    await service?.close();
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
    const scope = {
      generation: 1,
      selection: 1,
      storeId: restored.storeId,
      sessionId: 'session',
      workspaceId: 'workspace',
    };
    host = new NativeContext(
      current,
      () => scope,
      () => {},
    );
    const contextHost = host;
    const calls: NativeRequest[] = [];
    const bridge: NativeBridge = {
      watch: () => () => {},
      async request(input) {
        const request = decodeNativeRequest(input);
        calls.push(request);
        switch (request.method) {
          case 'context.read':
            return contextHost.read(request.sessionId, false, request.readId);
          case 'context.close':
            contextHost.close(request.readId);
            return null;
          case 'context.include':
            return contextHost.include(
              request.observationId,
              request.executionId,
              request.resultRevision,
              request.scope,
            );
          default:
            throw Error('unexpected_context_request');
        }
      },
    };
    dom = new JSDOM('<div id="root"></div>');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const element = dom.window.document.getElementById('root')!;
    rendered = createRoot(element);
    const view = await current.getView('session');
    const interactionPage = await current.listInteractions('session', {
      storeId: restored.storeId,
      state: 'pending',
    });
    const selection: NativeSelection = {
      viewGeneration: 1,
      viewSelection: 1,
      storeId: view.storeId,
      canReadContext: true,
      canReadModelOutput: false,
      session: view.session,
      runs: view.runs,
      executions: view.executions,
      interactions: interactionPage.interactions,
      interactionsAfterId: interactionPage.nextAfterId,
    };
    let refreshed = 0;
    await act(async () => {
      rendered!.render(
        <NativeContextView
          bridge={bridge}
          generation={1}
          selection={selection}
          onRefresh={async () => {
            await current.getView('session');
            refreshed++;
          }}
        />,
      );
    });
    const button = (text: string) =>
      [...element.querySelectorAll('button')].find((value) => value.textContent === text)!;
    await act(async () => button('读取当前所选上下文').click());
    await settle(() => !!button('Include this exact historical result'));
    expect(element.textContent).toContain(originalStoreId);
    expect(element.textContent).toContain(job.id);
    expect(element.textContent).toContain('Excluded by Rewind');
    expect(methods.every((method) => method === 'GET')).toBe(true);
    await act(async () => button('Include this exact historical result').click());
    await settle(() => refreshed === 1);
    console.log(
      'restored-native-include',
      contextHost.submissions.map((entry) => ({ phase: entry.phase, error: entry.error })),
      'posts',
      methods.filter((method) => method === 'POST').length,
    );
    expect(contextHost.submissions[0]?.phase).toBe('applied');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    const includeCall = calls.find((call) => call.method === 'context.include');
    expect(includeCall).toMatchObject({
      executionId: jobId,
      resultRevision: job.resultRevision,
      scope: {
        storeId: restored.storeId,
        sessionId: 'session',
        contextSelectionId: rewound.selection.id,
      },
    });
    const submission = contextHost.submissions[0]!;
    const includedCommand = await current.getCommand(submission.intent.commandId);
    const included = await current.getContext('session', { storeId: restored.storeId });
    expect(includedCommand.originStoreId).toBe(restored.storeId);
    expect(includedCommand.kind).toBe('result.include');
    expect(includedCommand.status).toBe('applied');
    expect(includedCommand.receipt).toMatchObject({
      outcome: 'result_included',
      executionId: jobId,
      resultRevision: job.resultRevision,
    });
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
    expect(includedCommand.receipt).toMatchObject({ sourceId: source.id });
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
    const metadata = await currentStore.getMetadata();
    expect(await contextHost.lookup(includedCommand.id)).toEqual(includedCommand);
    expect(await currentStore.getMetadata()).toEqual(metadata);
    expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
    await current.startRun('session', {
      expectedStoreId: restored.storeId,
      commandId: 'new-run',
      kind: 'run.start',
      content: 'Use the explicitly included saved result',
    });
    await currentRuntime.waitForCommand('new-run', { timeoutMs: 5000 });
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
    await act(async () => rendered!.unmount());
    rendered = undefined;
    dom.window.close();
    dom = undefined;
    Object.assign(globalThis, prior);
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
    expect(await cold.getContext('session', { storeId: restored.storeId })).toEqual(finalContext);
    expect(await cold.getView('session')).toEqual(finalView);
    expect(await cold.getCommand(includedCommand.id)).toEqual(includedCommand);
    expect(await cold.getExecution(jobId)).toEqual(job);
    expect(await coldStore.getExecution(jobId)).toEqual(acceptedExecution);
    for (const command of originalCommands)
      expect(await cold.getCommand(command.id)).toEqual(command);
    for (const run of originalView.runs) expect(await cold.getRun(run.id)).toEqual(run);
    await expect(cold.getContext('session', { storeId: originalStoreId })).rejects.toThrow(
      'store_identity_mismatch',
    );
    expect(await coldStore.getMetadata()).toEqual(coldMetadata);
    expect(methods.slice(beforeCold).every((method) => method === 'GET')).toBe(true);
    expect(coldModelCalls).toBe(0);
    expect(nextModel.requests).toHaveLength(1);
    expect(originalModel.requests).toHaveLength(1);
    expect(starts).toBe(1);
    expect(readFileSync(ledger, 'utf8')).toBe('original-effect\n');
  } finally {
    if (rendered) await act(async () => rendered!.unmount());
    dom?.window.close();
    Object.assign(globalThis, prior);
    globalThis.fetch = originalFetch;
    if (service) await close();
    else await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
