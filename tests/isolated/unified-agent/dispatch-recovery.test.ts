import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { startService } from '@kite-ai/service';

test('an orphaned Run produces a local dispatch failure without repeated owner acquisition or implicit recovery', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'kite-dispatch-recovery-'));
  let store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${dataRoot}`,
    name: 'fixture',
  });
  for (const sessionId of ['orphaned', 'healthy'])
    await store.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: sessionId,
      subjectId: 'owner',
    });
  await store.acceptCommand({
    expectedStoreId,
    commandId: 'original',
    sessionId: 'orphaned',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'original work' },
  });
  const oldOwner = (await store.acquireSessionOwner('orphaned', 'prior-instance'))!;
  const originalRun = await store.startRun({
    expectedStoreId,
    owner: oldOwner,
    commandId: 'original',
    configuration: {},
  });
  await store.close();
  store = await openSqliteStore({ dataRoot, profile: 'test' });
  let acquisitions = 0;
  const counted = new Proxy(store, {
    get(target, key) {
      if (key === 'acquireSessionOwner')
        return async (...args: Parameters<Store['acquireSessionOwner']>) => {
          if (args[0] === 'orphaned') acquisitions++;
          return target.acquireSessionOwner(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'healthy answer' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store: counted,
    model,
    instanceId: 'current-instance',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot, name: 'test', accessKey: 'fixture-key' },
    buildId: 'fixture',
    subjectId: 'owner',
  });
  const request = (path: string, body?: unknown) =>
    fetch(`${service.endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    expect(
      (
        await request('/v1/sessions/orphaned/commands', {
          expectedStoreId,
          commandId: 'new-work',
          kind: 'run.start',
          content: 'new work after orphaned Run',
        })
      ).status,
    ).toBe(202);
    const error = await runtime.waitForCommand('new-work', { timeoutMs: 1000 }).then(
      () => null,
      (caught) => caught,
    );
    expect(error).toMatchObject({ code: 'recovery_required' });
    const response = await request('/v1/commands/new-work');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'accepted',
      dispatchFailure: { code: 'recovery_required', instanceId: 'current-instance' },
    });
    expect(model.requests).toHaveLength(0);
    expect(await store.getRun(originalRun.id)).toEqual(originalRun);
    expect(acquisitions).toBe(1);
    // Past the owner handoff polling interval, a known failure is still quiescent.
    await Bun.sleep(320);
    expect(acquisitions).toBe(1);
    expect(await store.getCommand('new-work')).not.toHaveProperty('dispatchFailure');
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'healthy-work',
      sessionId: 'healthy',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'independent work' },
    });
    await runtime.waitForCommand('healthy-work');
    expect(model.requests).toHaveLength(1);
    expect((await runtime.getView('healthy')).runs[0]!.status).toBe('completed');
    expect(await store.getRun(originalRun.id)).toEqual(originalRun);
    await runtime.cancelCommand({
      expectedStoreId,
      commandId: 'cancel-new-work',
      sessionId: 'orphaned',
      targetCommandId: 'new-work',
      subjectId: 'owner',
    });
    expect((await store.getCommand('new-work'))!.cancelRequestedAt).not.toBeNull();
    expect(model.requests).toHaveLength(1);
  } finally {
    await service.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 15000);
