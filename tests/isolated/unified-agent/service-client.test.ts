import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';
import { projectPublicView } from '../../../packages/ui/src';

async function fixture(model?: ModelAdapter, extensions: readonly Extension[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'kite-service-client-'));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const paths = resolveProfile({ dataRoot, profile: 'disposable' });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'disposable',
    accessKey: paths.profileAccessKey,
  };
  const fixed = createFixedModel([
    [
      { type: 'text_delta', text: 'local completion' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    model: model ?? fixed,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions,
  });
  const service = await startService({
    runtime,
    profile,
    buildId: 'client-fixture',
    subjectId: 'owner',
  });
  // Expected target is chosen from fixture startup configuration, before HTTP admission.
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile,
      apiMajor: 1,
      buildId: 'client-fixture',
      requiredCapabilities: ['sessions', 'commands', 'events', 'history'],
    },
    bootstrap: service.bootstrap,
  });
  return {
    service,
    client,
    runtime,
    fixed,
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const info = await f.client.connect();
  const expectedStoreId = info.storeId!;
  await f.client.createWorkspace({
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'fixture',
    expectedStoreId,
  });
  await f.client.createSession({
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create-s',
    title: 'fixture',
    expectedStoreId,
  });
  return expectedStoreId;
}

test('real Service admission, stable write intent, snapshot/history and one observer', async () => {
  const f = await fixture();
  try {
    const expectedStoreId = await create(f);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const snapshot = await f.client.getView('s');
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const watch = new AbortController();
    let seen!: () => void;
    const observed = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const stream = f.client.observe({
      cursor: { storeId: expectedStoreId, sequence: snapshot.snapshotCursor },
      signal: watch.signal,
      onChange() {
        seen();
      },
    });
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'observation_already_active',
    });
    const intent = {
      expectedStoreId,
      commandId: 'intent-one',
      kind: 'run.start' as const,
      content: 'local fixture',
    };
    const receipt = await f.client.startRun('s', intent);
    await f.runtime.waitForCommand(receipt.id, { timeoutMs: 5000 });
    await Promise.race([
      observed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('event deadline')), 5000),
      ),
    ]);
    watch.abort(new Error('observation done'));
    await expect(stream).rejects.toBeDefined();
    const before = f.client.lastAppliedCursor;
    const view = await f.client.getView('s');
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.messages.at(-1)?.content).toBe('local completion');
    expect(f.client.lastAppliedCursor).toEqual(before);
    expect(await f.client.listMessages('s', { upperSeq: view.session.nextSeq })).toEqual(
      view.messages,
    );
    await f.client.startRun('s', intent);
    expect(f.fixed.requests).toHaveLength(1);
    await expect(
      f.client.startRun('s', {
        ...intent,
        expectedStoreId: 'previous-store',
        commandId: 'old-intent',
      }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    await expect(f.client.getCommand('old-intent')).rejects.toMatchObject({
      code: 'command_not_found',
    });
    expect(f.fixed.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('network disposal during model I/O does not cancel execution; reconnect reads committed outcome', async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = new Promise<void>((resolve) => {
    started = resolve;
  });
  let sawAbort = false;
  const f = await fixture({
    async *stream(_request, { signal }) {
      started();
      await blocked;
      sawAbort = signal.aborted;
      yield { type: 'text_delta', text: 'after disconnect' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  try {
    const expectedStoreId = await create(f);
    await f.client.startRun('s', {
      expectedStoreId,
      commandId: 'detached-intent',
      kind: 'run.start',
      content: 'hold',
    });
    await dispatch;
    f.client.disposeNetwork();
    release();
    await f.runtime.waitForCommand('detached-intent', { timeoutMs: 5000 });
    await f.client.connect();
    const view = await f.client.getView('s');
    expect(sawAbort).toBe(false);
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.messages.at(-1)?.content).toBe('after disconnect');
    expect((await f.client.getCommand('detached-intent')).cancelRequestedAt).toBeNull();
  } finally {
    release();
    await f.close();
  }
});

test('fresh profile startup writes are distinct from rejected Client zero business writes and model calls', async () => {
  const f = await fixture();
  const denied = createClient({
    endpoint: f.service.endpoint,
    token: f.service.bootstrap.token,
    expected: {
      profile: f.service.bootstrap.profile,
      apiMajor: 2,
      requiredCapabilities: ['sessions'],
    },
    bootstrap: f.service.bootstrap,
  });
  try {
    const startup = await f.runtime.getMetadata();
    expect(startup.storeId.length).toBeGreaterThan(0);
    await expect(denied.connect()).rejects.toMatchObject({ code: 'api_major_incompatible' });
    expect(() => denied.listSessions()).toThrow('connection_not_admitted');
    expect(() =>
      denied.startRun('s', {
        expectedStoreId: startup.storeId,
        commandId: 'denied',
        kind: 'run.start',
        content: 'not dispatched',
      }),
    ).toThrow('connection_not_admitted');
    await expect(denied.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'connection_not_admitted',
    });
    const after = await f.runtime.getMetadata();
    expect(after).toEqual(startup);
    expect(await f.runtime.listSessions()).toEqual([]);
    expect(f.fixed.requests).toHaveLength(0);
  } finally {
    denied.disposeNetwork();
    await f.close();
  }
});

test('built external extension crosses real Service, Client, generic UI, mark/query and explicit rerun', async () => {
  const buildRoot = mkdtempSync(join(tmpdir(), 'kite-built-review-'));
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
  const f = await fixture(undefined, [review.extension]);
  try {
    const expectedStoreId = await create(f);
    const catalogue = await f.client.listExtensions();
    expect(catalogue.map((value) => value.extensionId)).toEqual([review.extension.id]);
    const queryId = catalogue[0]!.queries[0]!.id;
    expect(await f.client.queryExtension('s', review.extension.id, queryId, {})).toEqual([]);
    await f.client.startRun('s', {
      expectedStoreId,
      commandId: 'review-source',
      kind: 'run.start',
      content: 'Source',
    });
    await f.runtime.waitForCommand('review-source', { timeoutMs: 5000 });
    const source = await f.client.getView('s');
    const run = source.runs[0]!;
    const execution = source.executions.find((value) => value.kind === 'model')!;
    const analyze = catalogue[0]!.actions.find((value) => value.id.endsWith('.analyze'))!;
    const input = { businessKey: 'first', sourceRunId: run.id, sourceExecutionId: execution.id };
    const invoke = async (
      commandId: string,
      actionId: string,
      definitionVersion: string,
      values: Parameters<typeof f.client.queryExtension>[3],
    ) => {
      const command = await f.client.invokeExtension('s', {
        expectedStoreId,
        commandId,
        kind: 'extension.invoke',
        extensionId: review.extension.id,
        actionId,
        definitionVersion,
        input: values,
      });
      return f.runtime.waitForCommand(command.id, { timeoutMs: 5000 });
    };
    await invoke('analyze-first', analyze.id, analyze.version, input);
    const beforeQuery = (await f.runtime.getMetadata()).lastChangeCursor;
    const [view] = await f.client.queryExtension('s', review.extension.id, queryId, {});
    expect((await f.runtime.getMetadata()).lastChangeCursor).toBe(beforeQuery);
    const rendered = projectPublicView(view!);
    expect(rendered.title).toContain('unmarked');
    expect(JSON.parse(rendered.payloadText)).toMatchObject({
      source: { runId: run.id, executionId: execution.id },
    });
    const mark = rendered.actions[0]!;
    await invoke('mark-first', mark.actionId, mark.definitionVersion, mark.input);
    const [marked] = await f.client.queryExtension('s', review.extension.id, queryId, {});
    expect(projectPublicView(marked!).title).toContain('marked');
    expect(review.analyses).toBe(1);
    expect(f.fixed.requests).toHaveLength(1);
    await invoke('repeat-saved-new-parent', analyze.id, analyze.version, input);
    expect(review.analyses).toBe(1);
    const rerun = marked!.actions[1]!;
    const rerunInput = { ...(rerun.input as Record<string, string>), businessKey: 'second' };
    await invoke('rerun-explicit', rerun.actionId, rerun.definitionVersion, rerunInput);
    expect(review.analyses).toBe(2);
    expect(await f.client.queryExtension('s', review.extension.id, queryId, {})).toHaveLength(2);
    const final = await f.client.getView('s');
    expect(final.runs).toHaveLength(1);
    expect(f.fixed.requests).toHaveLength(1);
    expect(
      final.executions.filter(
        (value) => value.kind === 'tool' && value.definitionId.endsWith('.fixed-analysis'),
      ),
    ).toHaveLength(2);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    await f.close();
    rmSync(buildRoot, { recursive: true, force: true });
  }
});
