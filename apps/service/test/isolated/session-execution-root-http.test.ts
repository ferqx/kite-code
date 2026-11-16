import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { semanticDigest } from '../../../../packages/agent/src/json';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';

async function fixture() {
  const directory = temporaryDirectory('kite-root-http-');
  const source = join(directory, 'source'),
    target = join(directory, 'target');
  mkdirSync(source);
  mkdirSync(target);
  const physical = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    return {
      rootUri: pathToFileURL(path).href,
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  };
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: physical(source).rootUri,
    name: 'source',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
    });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
  const owned = { expectedStoreId: storeId, owner };
  await store.acceptCommand({
    ...base,
    commandId: 'start',
    request: { kind: 'run.start', content: 'switch execution root' },
  });
  const run = await store.startRun({
    ...owned,
    commandId: 'start',
    configuration: {
      tools: [{ id: 'git.worktree', version: '1', extensionId: 'builtin.shell' }],
      extensions: [{ id: 'builtin.shell', version: '1' }],
    },
  });
  async function switchRoot(action: 'use' | 'exit') {
    const current = await store.getSessionExecutionRoot({ sessionId: 's' });
    const next =
      action === 'use' ? { ...physical(target), requestedPath: target } : physical(source);
    const input: Json = action === 'use' ? { action, path: target } : { action };
    const modelId = `model-${current.epoch}`,
      toolId = `tool-${current.epoch}`;
    const calls = [{ id: toolId, name: 'git.worktree', arguments: JSON.stringify(input) }];
    for (const kind of ['model', 'tool'] as const) {
      const id = kind === 'model' ? modelId : toolId;
      const execution = await store.planExecution({
        ...owned,
        executionId: id,
        sessionId: 's',
        runId: run.id,
        originCommandId: 'start',
        stepId: current.epoch,
        callId: id,
        kind,
        definitionId: kind === 'model' ? 'fixture' : 'git.worktree',
        definitionVersion: '1',
        input: kind === 'model' ? {} : input,
        decisionSource:
          kind === 'model'
            ? {}
            : { kind: 'model_decision', modelExecutionId: modelId, toolBatchSize: 1 },
      });
      await store.markDispatching({
        ...owned,
        executionId: id,
        authorization: {
          allowed: true,
          revision: 'test',
          definitionVersion: '1',
          inputDigest: await semanticDigest(execution.input),
          controlReads: [
            { kind: 'session.execution_root', scope: 'session:s', revision: current.epoch },
          ],
        },
        requirements: [],
        freshness: { checked: true, source: execution.decisionSource },
      });
      if (kind === 'model')
        await store.finishExecution({
          ...owned,
          executionId: id,
          status: 'succeeded',
          result: { content: '', toolCalls: calls },
        });
    }
    const binding = await store.prepareSessionExecutionRoot({
      ...owned,
      sessionId: 's',
      executionId: toolId,
      expectedEpoch: current.epoch,
      action,
      source:
        current.epoch === '0'
          ? physical(source)
          : {
              rootUri: current.effectiveRootUri,
              identity: current.identity!,
            },
      target: next,
    });
    await store.finishExecution({
      ...owned,
      executionId: toolId,
      status: 'succeeded',
      result: {
        outcome: 'succeeded',
        content: `execution root ${binding.epoch}`,
        details: { action, cwdChanged: true, executionRoot: binding },
      } as unknown as Json,
    });
  }
  const runtime = createRuntime({
    store,
    permissions: {
      async authorize() {
        throw Error('readonly_fixture_must_not_authorize');
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: join(directory, 'data'), name: 'test', accessKey: 'fixture' },
    buildId: 'root-http',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      requiredCapabilities: ['sessions'],
    },
  });
  await client.connect();
  const read = (sessionId = 's') =>
    client.getSessionExecutionRoot(sessionId, { storeId, workspaceId: 'w' });
  const request = (query: string, headers: Record<string, string> = {}) =>
    fetch(`${service.endpoint}/v1/sessions/s/execution-root?${query}`, {
      headers: { authorization: `Bearer ${service.bootstrap.token}`, ...headers },
    });
  return {
    source,
    target,
    store,
    storeId,
    read,
    request,
    switchRoot,
    service,
    async close() {
      client.disposeNetwork();
      await service.close();
      removeTemporaryDirectory(directory);
    },
  };
}

test('native HTTP reads the committed Session root through use and exit without changing membership or facts', async () => {
  const f = await fixture();
  try {
    const original = await f.read();
    expect(original).toMatchObject({
      storeId: f.storeId,
      sessionId: 's',
      workspaceId: 'w',
      rootUri: pathToFileURL(f.source).href,
    });
    const before = await f.store.getSession('s');
    await f.switchRoot('use');
    const used = await f.read();
    expect(used.rootUri).toBe(pathToFileURL(f.target).href);
    expect(used.revision).not.toBe(original.revision);
    expect((await f.read('other')).rootUri).toBe(original.rootUri);
    expect((await f.store.getWorkspace('w'))?.rootUri).toBe(original.rootUri);
    expect(await f.store.getSession('s')).toMatchObject({
      id: before!.id,
      workspaceId: before!.workspaceId,
      parentSessionId: before!.parentSessionId,
      rootSessionId: before!.rootSessionId,
    });
    await f.switchRoot('exit');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const restored = await f.read();
    expect(restored.rootUri).toBe(original.rootUri);
    expect(restored.revision).not.toBe(original.revision);
    expect(restored.revision).not.toBe(used.revision);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const response = await f.request(`storeId=${f.storeId}&workspaceId=w`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  } finally {
    await f.close();
  }
});

test('native root read rejects wrong scope, browser origins and replaced physical roots without falling back', async () => {
  const f = await fixture();
  try {
    expect((await f.request('storeId=wrong&workspaceId=w')).status).toBe(409);
    expect((await f.request(`storeId=${f.storeId}&workspaceId=wrong`)).status).toBe(409);
    expect((await f.request(`storeId=${f.storeId}&workspaceId=w&workspaceId=w`)).status).toBe(400);
    expect(
      (await f.request(`storeId=${f.storeId}&workspaceId=w&rootUri=file:///other`)).status,
    ).toBe(400);
    expect(
      (await f.request(`storeId=${f.storeId}&workspaceId=w`, { origin: f.service.endpoint }))
        .status,
    ).toBe(403);
    await f.switchRoot('use');
    renameSync(f.target, `${f.target}-old`);
    mkdirSync(f.target);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const response = await f.request(`storeId=${f.storeId}&workspaceId=w`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'execution_root_changed' });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getWorkspace('w'))?.rootUri).toBe(pathToFileURL(f.source).href);
  } finally {
    await f.close();
  }
});
