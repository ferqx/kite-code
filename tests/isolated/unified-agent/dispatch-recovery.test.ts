import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { startService } from '@kite-ai/service';
import { temporaryDirectory } from '../../fixtures/test-filesystem';

test('new work reconciles a proven orphaned Run once without replaying its original work', async () => {
  const dataRoot = temporaryDirectory('kite-dispatch-recovery-');
  let store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(dataRoot).href,
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
    [
      { type: 'text_delta', text: 'independent healthy answer' },
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
    const applied = await runtime.waitForCommand('new-work', { timeoutMs: 5000 });
    const response = await request('/v1/commands/new-work');
    expect(response.status).toBe(200);
    const publicCommand = await response.json();
    expect(publicCommand).toMatchObject({
      status: 'applied',
      receipt: { runId: (applied.receipt as { runId: string }).runId },
    });
    expect(publicCommand).not.toHaveProperty('dispatchFailure');
    const reconciled = (await store.getRun(originalRun.id))!;
    expect(reconciled).toMatchObject({
      id: originalRun.id,
      originCommandId: 'original',
      status: 'interrupted',
      isActive: false,
    });
    expect(model.requests).toHaveLength(1);
    expect(
      model.requests[0]!.messages.filter((message) => message.role === 'user').at(-1)?.content,
    ).toBe('new work after orphaned Run');
    expect(
      (await store.getRun((applied.receipt as { runId: string }).runId))?.originCommandId,
    ).toBe('new-work');
    expect(acquisitions).toBe(1);
    // Past the owner handoff polling interval, the settled original work stays quiescent.
    await Bun.sleep(320);
    expect(acquisitions).toBe(1);
    expect(model.requests).toHaveLength(1);
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'healthy-work',
      sessionId: 'healthy',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'independent work' },
    });
    await runtime.waitForCommand('healthy-work');
    expect(model.requests).toHaveLength(2);
    expect((await runtime.getView('healthy')).runs[0]!.status).toBe('completed');
    expect(await store.getRun(originalRun.id)).toEqual(reconciled);
    await runtime.cancelCommand({
      expectedStoreId,
      commandId: 'cancel-new-work',
      sessionId: 'orphaned',
      targetCommandId: 'new-work',
      subjectId: 'owner',
    });
    expect((await store.getCommand('new-work'))!.cancelRequestedAt).not.toBeNull();
    expect(model.requests).toHaveLength(2);
    expect(await store.getRun(originalRun.id)).toEqual(reconciled);
  } finally {
    await service.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 15000);
