import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension, Json, PublicView } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { startService } from '../../src';

test('real HTTP mini-review Actions and Queries use generic records and controlled operations without additional model Runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-review-'));
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../tests/fixtures/extensions/mini-review/src/index.ts'),
    ],
    outdir: join(root, 'extension'),
    target: 'bun',
  });
  expect(built.success).toBe(true);
  // Load the independently built fixture artifact, with no application source alias.
  const fixture = (await import(built.outputs[0]!.path)) as {
    createMiniReview(): { extension: Extension; readonly analyses: number };
  };
  const review = fixture.createMiniReview();
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'A durable source result.' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [review.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const service = await startService({
    runtime,
    buildId: 'review',
    subjectId: 'owner',
    profile: {
      dataRoot: realpathSync(dataRoot),
      name: 'disposable',
      accessKey: resolveProfile({ dataRoot, profile: 'disposable' }).profileAccessKey,
    },
  });
  const metadata = await store.getMetadata();
  const request = (path: string, init?: RequestInit) =>
    fetch(service.endpoint + path, {
      ...init,
      headers: { authorization: `Bearer ${service.bootstrap.token}`, ...init?.headers },
    });
  const post = (path: string, body: unknown) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const invoke = async (commandId: string, actionId: string, input: Json, session = 'session') => {
    const response = await post(`/v1/sessions/${session}/commands`, {
      expectedStoreId: metadata.storeId,
      commandId,
      kind: 'extension.invoke',
      extensionId: review.extension.id,
      actionId,
      definitionVersion: '1',
      input,
    });
    expect(response.status).toBe(202);
    return runtime.waitForCommand(commandId);
  };
  const queryPath = `/v1/sessions/session/extensions/${review.extension.id}/queries/${review.extension.id}.results`;
  const query = async () => {
    const before = (await store.getMetadata()).lastChangeCursor;
    const response = await request(queryPath);
    expect(response.status).toBe(200);
    const views = (await response.json()) as PublicView[];
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    return views;
  };
  try {
    expect(
      (
        await post('/v1/workspaces', {
          expectedStoreId: metadata.storeId,
          id: 'workspace',
          rootUri: `file://${root}`,
          name: 'Disposable',
        })
      ).status,
    ).toBe(201);
    for (const sessionId of ['session', 'foreign'])
      expect(
        (
          await post('/v1/sessions', {
            expectedStoreId: metadata.storeId,
            commandId: `create-${sessionId}`,
            sessionId,
            workspaceId: 'workspace',
            title: sessionId,
          })
        ).status,
      ).toBe(201);
    const catalogueCursor = (await store.getMetadata()).lastChangeCursor;
    const catalogue = await request('/v1/extensions');
    expect(catalogue.status).toBe(200);
    expect(await catalogue.json()).toMatchObject([
      {
        extensionId: review.extension.id,
        actions: [{ id: `${review.extension.id}.analyze` }, { id: `${review.extension.id}.mark` }],
      },
    ]);
    expect((await store.getMetadata()).lastChangeCursor).toBe(catalogueCursor);
    expect(await query()).toHaveLength(0);
    expect(
      (
        await post('/v1/sessions/session/commands', {
          expectedStoreId: metadata.storeId,
          commandId: 'source',
          kind: 'run.start',
          content: 'Source',
        })
      ).status,
    ).toBe(202);
    await runtime.waitForCommand('source');
    const source = await store.getView('session');
    const sourceRun = source.runs[0]!;
    const sourceExecution = source.executions.find((execution) => execution.kind === 'model')!;
    const analysisInput = {
      businessKey: 'first',
      sourceRunId: sourceRun.id,
      sourceExecutionId: sourceExecution.id,
    };
    const analysis = await invoke('analyze', `${review.extension.id}.analyze`, analysisInput);
    expect(analysis.status).toBe('applied');
    expect(analysis.receipt).toHaveProperty('executionId');
    const executionId = (analysis.receipt as { executionId: string }).executionId;
    const execution = await store.getExecution(executionId);
    expect(execution).toMatchObject({ kind: 'job', runId: null, status: 'succeeded' });
    expect(review.analyses).toBe(1);
    const views = await query();
    expect(views).toHaveLength(1);
    expect(views[0]!.payload).toMatchObject({
      marked: false,
      source: {
        runId: sourceRun.id,
        executionId: sourceExecution.id,
        resultRevision: sourceExecution.resultRevision,
      },
    });
    const mark = views[0]!.actions.find((action) => action.actionId.endsWith('.mark'))!;
    await invoke('mark', mark.actionId, mark.input);
    expect((await query())[0]!.payload).toMatchObject({ marked: true });
    expect(review.analyses).toBe(1);
    await invoke('reanalyze', `${review.extension.id}.analyze`, {
      ...analysisInput,
      businessKey: 'second',
    });
    expect(review.analyses).toBe(2);
    expect(await query()).toHaveLength(2);
    // Same stable command is a lookup, not a third analysis.
    await invoke('reanalyze', `${review.extension.id}.analyze`, {
      ...analysisInput,
      businessKey: 'second',
    });
    expect(review.analyses).toBe(2);
    const foreign = await invoke(
      'foreign-analysis',
      `${review.extension.id}.analyze`,
      analysisInput,
      'foreign',
    );
    expect(foreign.status).toBe('rejected');
    expect(review.analyses).toBe(2);
    const foreignQuery = await request(queryPath.replace('/session/', '/foreign/'));
    expect(foreignQuery.status).toBe(200);
    expect(await foreignQuery.json()).toEqual([]);
    expect((await store.getView('foreign')).executions).toHaveLength(0);
    const invalidCursor = (await store.getMetadata()).lastChangeCursor;
    for (const input of [
      '{',
      'null',
      '{"private":true}',
      JSON.stringify({ padding: 'x'.repeat(8192) }),
    ])
      expect((await request(`${queryPath}?input=${encodeURIComponent(input)}`)).status).toBe(400);
    expect((await request(`${queryPath}?input=%7B%7D&input=%7B%7D`)).status).toBe(400);
    expect((await request(`${queryPath}?%69nput=${'x'.repeat(8193)}`)).status).toBe(400);
    const staleAction = await post('/v1/sessions/session/commands', {
      expectedStoreId: 'stale',
      commandId: 'stale-action',
      kind: 'extension.invoke',
      extensionId: review.extension.id,
      actionId: `${review.extension.id}.analyze`,
      definitionVersion: '1',
      input: analysisInput,
    });
    expect(staleAction.status).toBe(409);
    expect(await runtime.getCommand('stale-action')).toBeNull();
    expect((await request(queryPath.replace('.results', '.missing'))).status).toBe(404);
    expect((await request(queryPath.replace('/session/', '/missing/'))).status).toBe(404);
    expect((await store.getMetadata()).lastChangeCursor).toBe(invalidCursor);
    const view = await store.getView('session');
    expect(view.runs).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    expect(view.executions.filter((item) => item.kind === 'tool')).toHaveLength(2);
    const serverInfo = await (await request('/v1/server')).json();
    for (const capability of ['extensions_actions', 'extension_queries', 'public_views'])
      expect(serverInfo.capabilities).toContain(capability);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
