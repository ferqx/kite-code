import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { invokeExtension, queryExtension, run } from '../../../apps/cli/src';
import { createDesktopController } from '../../../apps/desktop/src';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function fixture(options: { model?: ModelAdapter; extensions?: readonly Extension[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kite-thin-clients-'));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'disposable',
    accessKey: resolveProfile({ dataRoot, profile: 'disposable' }).profileAccessKey,
  };
  const model = createFixedModel([[{ type: 'text_delta', text: 'source' }, finish]]);
  const runtime = createRuntime({
    store,
    model: options.model ?? model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: options.extensions ?? [],
  });
  const service = await startService({
    runtime,
    profile,
    buildId: 'thin-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile,
      apiMajor: 1,
      buildId: 'thin-fixture',
      requiredCapabilities: ['sessions', 'commands', 'events'],
    },
    bootstrap: service.bootstrap,
  });
  const metadata = await client.connect();
  const expectedStoreId = metadata.storeId!;
  await client.createWorkspace({
    id: 'w',
    rootUri: `file://${root}`,
    name: 'fixture',
    expectedStoreId,
  });
  for (const sessionId of ['s', 'other'])
    await client.createSession({
      sessionId,
      workspaceId: 'w',
      title: sessionId,
      commandId: `create-${sessionId}`,
      expectedStoreId,
    });
  return {
    client,
    runtime,
    model,
    service,
    expectedStoreId,
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('CLI acceptance stays pending until real Run terminal; Ctrl+C targets original command before run ID read', async () => {
  const held = barrier();
  const started = barrier();
  const f = await fixture({
    model: {
      async *stream(_request, { signal }) {
        started.release();
        await held.wait;
        signal.throwIfAborted();
        yield finish;
      },
    },
  });
  try {
    let completed = false;
    const lines: string[] = [];
    const running = run(
      's',
      {
        expectedStoreId: f.expectedStoreId,
        commandId: 'accepted-not-completed',
        kind: 'run.start',
        content: 'Hold',
      },
      {
        client: f.client,
        pollIntervalMs: 1,
        write(line) {
          lines.push(line);
        },
      },
    ).then((value) => {
      completed = true;
      return value;
    });
    await started.wait;
    expect(lines).toEqual(['accepted accepted-not-completed']);
    expect(completed).toBe(false);
    held.release();
    expect((await running).exitCode).toBe(0);
    const interrupt = new AbortController();
    const cancellations: string[] = [];
    const cancel = f.client.cancelCommand.bind(f.client);
    f.client.cancelCommand = (sessionId, input, options) => {
      cancellations.push(input.targetCommandId);
      expect(input.expectedStoreId).toBe(f.expectedStoreId);
      return cancel(sessionId, input, options);
    };
    const cancelled = await run(
      's',
      {
        expectedStoreId: f.expectedStoreId,
        commandId: 'exact-original-command',
        kind: 'run.start',
        content: 'Cancel queued',
      },
      {
        client: f.client,
        signal: interrupt.signal,
        pollIntervalMs: 1,
        write(line) {
          if (line === 'accepted exact-original-command') interrupt.abort();
        },
      },
    );
    expect(cancellations).toEqual(['exact-original-command']);
    expect(cancelled.exitCode).toBe(130);
  } finally {
    held.release();
    await f.close();
  }
});

test('Desktop selection generations reject old response; switching/network disposal preserve actual execution', async () => {
  const held = barrier();
  const started = barrier();
  let modelAborted = false;
  const f = await fixture({
    model: {
      async *stream(_request, { signal }) {
        started.release();
        await held.wait;
        modelAborted = signal.aborted;
        yield finish;
      },
    },
  });
  try {
    await f.client.startRun('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'desktop-active',
      kind: 'run.start',
      content: 'Hold',
    });
    await started.wait;
    const delay = barrier();
    const actualGetView = f.client.getView.bind(f.client);
    f.client.getView = async (id, options) => {
      const value = await actualGetView(id, options);
      if (id === 's') await delay.wait;
      return value;
    };
    let stopped = 0;
    const visible: string[] = [];
    const desktop = createDesktopController({
      admittedClient: f.client,
      onSnapshot(snapshot) {
        visible.push(snapshot.sessionId);
      },
      async stopPairedService() {
        stopped++;
      },
      maxCachedObjects: 1,
      maxCacheBytes: 8192,
    });
    const old = desktop.selectSession('s');
    await desktop.selectSession('other');
    delay.release();
    await old;
    expect(desktop.snapshot?.sessionId).toBe('other');
    expect(visible).toEqual(['other']);
    expect(desktop.cachedObjectCount).toBeLessThanOrEqual(1);
    const stream = desktop.observe();
    expect(desktop.observe()).toBe(stream);
    const drained = stream.catch(() => {});
    expect((await actualGetView('s')).runs[0]?.isActive).toBe(true);
    desktop.disposeNetwork();
    await drained;
    expect(stopped).toBe(0);
    held.release();
    await f.runtime.waitForCommand('desktop-active', { timeoutMs: 5000 });
    await f.client.connect();
    expect((await f.client.getView('s')).runs[0]?.status).toBe('completed');
    expect(modelAborted).toBe(false);
  } finally {
    held.release();
    await f.close();
  }
});

test('thin CLI and Desktop use generic external analyze, view, mark/query and explicit rerun', async () => {
  const buildRoot = mkdtempSync(join(tmpdir(), 'kite-thin-review-'));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../fixtures/extensions/mini-review/src/index.ts')],
    outdir: buildRoot,
    target: 'bun',
  });
  expect(built.success).toBe(true);
  const module = (await import(built.outputs[0]!.path)) as {
    createMiniReview(): { extension: Extension; readonly analyses: number };
  };
  const review = module.createMiniReview();
  const f = await fixture({ extensions: [review.extension] });
  try {
    const lines: string[] = [];
    const cli = {
      client: f.client,
      write(line: string) {
        lines.push(line);
      },
      pollIntervalMs: 1,
    };
    expect(
      (
        await run(
          's',
          {
            expectedStoreId: f.expectedStoreId,
            commandId: 'source',
            kind: 'run.start',
            content: 'Source',
          },
          cli,
        )
      ).exitCode,
    ).toBe(0);
    const source = await f.client.getView('s');
    const sourceExecution = source.executions.find((value) => value.kind === 'model')!;
    const extension = (await f.client.listExtensions())[0]!;
    const analyze = extension.actions.find((value) => value.id.endsWith('.analyze'))!;
    const query = extension.queries[0]!;
    expect(
      (
        await invokeExtension(
          's',
          {
            expectedStoreId: f.expectedStoreId,
            commandId: 'analyze',
            kind: 'extension.invoke',
            extensionId: extension.extensionId,
            actionId: analyze.id,
            definitionVersion: analyze.version,
            input: {
              businessKey: 'first',
              sourceRunId: source.runs[0]!.id,
              sourceExecutionId: sourceExecution.id,
            },
          },
          cli,
        )
      ).exitCode,
    ).toBe(0);
    const views = await queryExtension('s', extension.extensionId, query.id, {}, cli);
    expect(views[0]?.summary).toContain('unmarked');
    const desktop = createDesktopController({ admittedClient: f.client, onSnapshot() {} });
    await desktop.selectSession('s', [
      { extensionId: extension.extensionId, queryId: query.id, input: {} },
    ]);
    const mark = desktop.snapshot!.publicViews[0]!.actions[0]!;
    const markedCommand = await desktop.invokeAction(mark);
    await f.runtime.waitForCommand(markedCommand.id, { timeoutMs: 5000 });
    await desktop.selectSession('s', [
      { extensionId: extension.extensionId, queryId: query.id, input: {} },
    ]);
    expect(desktop.snapshot!.publicViews[0]!.summary).toContain('marked');
    expect(review.analyses).toBe(1);
    const rerun = desktop.snapshot!.publicViews[0]!.actions[1]!;
    const rerunCommand = await desktop.invokeAction(rerun, {
      ...(rerun.input as Record<string, string>),
      businessKey: 'second',
    });
    await f.runtime.waitForCommand(rerunCommand.id, { timeoutMs: 5000 });
    expect(review.analyses).toBe(2);
    expect(f.model.requests).toHaveLength(1);
    expect((await f.client.getView('s')).runs).toHaveLength(1);
    expect(lines.some((value) => value.startsWith('accepted analyze'))).toBe(true);
    desktop.disposeNetwork();
  } finally {
    await f.close();
    rmSync(buildRoot, { recursive: true, force: true });
  }
});
