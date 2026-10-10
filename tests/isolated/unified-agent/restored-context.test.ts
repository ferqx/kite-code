import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import { getCompleteContext } from '../../../apps/cli/src/context';
import { readContext } from '../../../apps/web/src/diagnostics';

test('restored TUI and Cookie Context readers preserve original result provenance through cold reads without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-restored-context-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const originalStoreId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'Original selected reply' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  let starts = 0;
  let jobId = '';
  const result = {
    outcome: 'succeeded' as const,
    content: `Original result α\n${'保存正文🌿'.repeat(4096)}\nCOMPLETE RESULT END`,
    details: { original: true, future: ['retained', 42] },
  };
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
        actions: [
          {
            id: 'fixture.launch',
            version: '1',
            description: 'Create the original result once',
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
            description: 'The original full result',
            inputSchema: { type: 'object' },
            async start() {
              starts++;
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
      },
    ],
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let browser: ReturnType<typeof createBrowserClient> | undefined;
  const originalFetch = globalThis.fetch;
  try {
    service = await startService({
      runtime,
      profile,
      buildId: 'context-original',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'workspace',
      name: 'Original workspace',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId: originalStoreId,
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      title: 'Original selected Context',
    });
    await client.startRun('session', {
      expectedStoreId: originalStoreId,
      commandId: 'original-run',
      kind: 'run.start',
      content: 'Original selected input',
    });
    await runtime.waitForCommand('original-run', { timeoutMs: 5000 });
    await client.invokeExtension('session', {
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
    let job = await client.getExecution(jobId);
    while (job.status !== 'succeeded') {
      if (Date.now() >= deadline) throw Error('original_job_not_complete');
      await Bun.sleep(5);
      job = await client.getExecution(jobId);
    }
    const context = await client.getContext('session', { storeId: originalStoreId });
    const included = await client.includeResult('session', jobId, {
      expectedStoreId: originalStoreId,
      commandId: 'include-original-result',
      expectedContextSelectionId: context.selection.id,
      resultRevision: job.resultRevision,
    });
    const original = await getCompleteContext(
      'session',
      { storeId: originalStoreId, contextSelectionId: context.selection.id },
      { client, write: () => {} },
    );
    expect(original.resultSources).toEqual([included.source]);
    expect(included.source.result).toEqual(result);
    expect(included.source.originStoreId).toBe(originalStoreId);
    expect(starts).toBe(1);
    expect(model.requests).toHaveLength(1);
    client.disposeNetwork();
    client = undefined;
    await service.close();
    service = undefined;
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
    let coldModelCalls = 0;
    for (let cold = 0; cold < 2; cold++) {
      const currentStore = await openSqliteStore(selected);
      const currentRuntime = createRuntime({
        store: currentStore,
        artifacts: createArtifactStore({ profile: selected, store: currentStore }),
        model: {
          async *stream() {
            coldModelCalls++;
            yield {
              type: 'finish',
              reason: 'stop',
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        },
        modelId: 'fixed',
        permissions: {
          async authorize() {
            return { allowed: false, revision: 'readonly-fixture' };
          },
        },
      });
      service = await startService({
        runtime: currentRuntime,
        profile,
        buildId: 'context-restored',
        subjectId: 'owner',
      });
      const methods: string[] = [];
      globalThis.fetch = Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          methods.push(init?.method ?? (url instanceof Request ? url.method : 'GET'));
          return originalFetch(url, init);
        },
        { preconnect: originalFetch.preconnect },
      );
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
        bootstrap: service.bootstrap,
      });
      await client.connect();
      expect(client.serverInfo?.storeId).toBe(restored.storeId);
      gateway = startDevelopmentWeb({ admittedClient: client });
      const document = await fetch(gateway.endpoint);
      await document.body?.cancel();
      const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
      const gatewayEndpoint = gateway.endpoint;
      browser = createBrowserClient({
        origin: gatewayEndpoint,
        pageIdentity: gateway.pageIdentity,
        fetch: Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers);
            headers.set('cookie', cookie);
            headers.set('origin', gatewayEndpoint);
            return fetch(url, { ...init, headers });
          },
          { preconnect: fetch.preconnect },
        ),
      });
      await browser.connect();
      const view = await browser.getView('session');
      const metadata = await currentStore.getMetadata();
      const current = await client.getContext('session', { storeId: restored.storeId });
      expect(current.selection).toEqual(original.selection);
      expect(current.messages).toEqual(original.messages);
      expect(current.resultSources).toEqual(original.resultSources);
      const reads = await Promise.allSettled([
        getCompleteContext(
          'session',
          { storeId: restored.storeId, contextSelectionId: original.selection.id },
          { client, write: () => {} },
        ),
        readContext(browser, view, new AbortController().signal),
      ]);
      // Preserve both actual failures in the red run, rather than stopping after the first reader.
      console.log(
        'restored-context-readers',
        reads.map((read) =>
          read.status === 'fulfilled' ? 'fulfilled' : (read.reason as { code?: string }).code,
        ),
      );
      expect(reads.map((read) => read.status)).toEqual(['fulfilled', 'fulfilled']);
      for (const read of reads) {
        if (read.status !== 'fulfilled') throw read.reason;
        expect(read.value).toEqual(current);
        expect(read.value.nextAfterSeq).toBeNull();
        expect(read.value.nextAfterSourceId).toBeNull();
      }
      await expect(client.getContext('session', { storeId: originalStoreId })).rejects.toThrow(
        'store_identity_mismatch',
      );
      const requestsBefore = methods.length;
      await expect(
        readContext(browser, { ...view, storeId: originalStoreId }, new AbortController().signal),
      ).rejects.toThrow('browser_identity_mismatch');
      expect(methods).toHaveLength(requestsBefore);
      expect(await currentStore.getMetadata()).toEqual(metadata);
      expect(await browser.getView('session')).toEqual(view);
      expect(await client.getExecution(jobId)).toEqual(job);
      expect(await client.getCommand('include-original-result')).toEqual(included.command);
      expect(methods.every((method) => method === 'GET')).toBe(true);
      expect(client.lastAppliedCursor).toBeUndefined();
      expect(coldModelCalls).toBe(0);
      expect(starts).toBe(1);
      expect(model.requests).toHaveLength(1);
      browser.disposeNetwork();
      browser = undefined;
      gateway.close();
      gateway = undefined;
      client.disposeNetwork();
      client = undefined;
      await service.close();
      service = undefined;
      globalThis.fetch = originalFetch;
    }
  } finally {
    browser?.disposeNetwork();
    gateway?.close();
    client?.disposeNetwork();
    globalThis.fetch = originalFetch;
    if (service) await service.close();
    else await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
