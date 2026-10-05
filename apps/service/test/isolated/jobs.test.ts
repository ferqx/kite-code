import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import type { createJobWork } from '../../../../tests/fixtures/extensions/job-work/src';
import { startService } from '../../src';

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture_barrier_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function setup(
  options: { model?: boolean; serial?: boolean; locks?: boolean; slots?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-jobs-'));
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../tests/fixtures/extensions/job-work/src/index.ts'),
    ],
    outdir: join(root, 'extension'),
    target: 'bun',
  });
  expect(built.success).toBe(true);
  const factory = (await import(built.outputs[0]!.path)) as { createJobWork: typeof createJobWork };
  const work = factory.createJobWork(join(root, 'ledger'), options.serial);
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const peerStore = await openSqliteStore({ dataRoot, profile: 'test' });
  const profile = resolveProfile({ dataRoot, profile: 'test' });
  const locks = options.locks
    ? createWorkspaceSerialLocks({ dataRoot, profile: 'test' })
    : undefined;
  const peerLocks = options.locks
    ? createWorkspaceSerialLocks({ dataRoot, profile: 'test' })
    : undefined;
  const model = createFixedModel(
    options.model
      ? [
          [
            {
              type: 'tool_call',
              id: 'call',
              name: 'fixture.job-work.launch',
              arguments: JSON.stringify({ jobs: [{ key: 'run-child', cancellation: 'detached' }] }),
            },
            { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
        ]
      : [],
  );
  const runtime = createRuntime({
    store,
    model,
    extensions: [work.extension],
    instanceId: 'owner-a',
    processConcurrency: options.slots,
    workspaceSerialLocks: locks,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const peerModel = createFixedModel([]);
  const peer = createRuntime({
    store: peerStore,
    model: peerModel,
    extensions: [work.extension],
    instanceId: 'owner-b',
    workspaceSerialLocks: peerLocks,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const host = { dataRoot: profile.dataRoot, name: 'test', accessKey: profile.profileAccessKey };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'jobs',
    subjectId: 'owner',
  });
  const serviceB = await startService({
    runtime: peer,
    profile: host,
    buildId: 'jobs',
    subjectId: 'owner',
  });
  const metadata = await store.getMetadata();
  const request = (path: string, body?: unknown, second = false) => {
    const s = second ? serviceB : service;
    return fetch(s.endpoint + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${s.bootstrap.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const invoke = async (commandId: string, input: unknown, second = false, session = 'session') => {
    const response = await request(
      `/v1/sessions/${session}/commands`,
      {
        commandId,
        expectedStoreId: metadata.storeId,
        kind: 'extension.invoke',
        extensionId: 'fixture.job-work',
        actionId: 'fixture.job-work.launch',
        definitionVersion: '1',
        input,
      },
      second,
    );
    expect(response.status).toBe(202);
    return response.json();
  };
  await request('/v1/workspaces', {
    expectedStoreId: metadata.storeId,
    id: 'workspace',
    rootUri: `file://${root}`,
    name: 'Test',
  });
  for (const sessionId of ['session', 'other'])
    await request('/v1/sessions', {
      expectedStoreId: metadata.storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'workspace',
      title: 'Test',
    });
  return {
    root,
    work,
    store,
    peerStore,
    runtime,
    peer,
    model,
    peerModel,
    service,
    serviceB,
    request,
    invoke,
    metadata,
    async close() {
      await service.close();
      await serviceB.close();
      await locks?.close();
      await peerLocks?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const job = (key: string, cancellation = 'detached') => ({ key, cancellation });

test('HTTP direct Action admits a durable running Job, retains owner, and a peer continues after terminal delivery', async () => {
  const f = await setup();
  try {
    await f.invoke('launch', { jobs: [job('first')] });
    await bounded(f.work.started('first'));
    await f.runtime.waitForCommand('launch');
    const ref = f.work.ref('first');
    expect(await f.store.getExecution(ref.executionId!)).toMatchObject({
      kind: 'job',
      runId: null,
      status: 'running',
    });
    expect((await f.store.getView('session')).runs).toHaveLength(0);
    expect(await f.peerStore.acquireSessionOwner('session', 'intruder')).toBeNull();
    await f.invoke('peer-work', { jobs: [] }, true);
    expect(await f.peer.getCommand('peer-work')).toMatchObject({ status: 'accepted' });
    expect(f.work.stats('first').starts).toBe(1);
    f.work.finish('first');
    await bounded(f.work.disposed('first'));
    await f.peer.waitForCommand('peer-work', { timeoutMs: 5000 });
    expect(await f.store.getExecution(ref.executionId!)).toMatchObject({ status: 'succeeded' });
    expect(f.model.requests).toHaveLength(0);
    expect(f.peerModel.requests).toHaveLength(0);
    expect(readFileSync(join(f.root, 'ledger'), 'utf8')).toBe('start:first\nend:first:succeeded\n');
  } finally {
    await f.close();
  }
}, 15000);

test('normal Model Tool uses public operations and a detached Job survives completed Run without extra Model calls', async () => {
  const f = await setup({ model: true });
  try {
    expect(
      (
        await f.request('/v1/sessions/session/commands', {
          expectedStoreId: f.metadata.storeId,
          commandId: 'run',
          kind: 'run.start',
          content: 'launch',
        })
      ).status,
    ).toBe(202);
    await bounded(f.work.started('run-child'));
    await f.runtime.waitForCommand('run');
    expect((await f.store.getView('session')).runs[0]).toMatchObject({ status: 'completed' });
    expect(await f.store.getExecution(f.work.ref('run-child').executionId!)).toMatchObject({
      status: 'running',
    });
    expect(f.model.requests).toHaveLength(2);
    f.work.finish('run-child');
    await bounded(f.work.disposed('run-child'));
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);

test('HTTP cancel targets attached children only; detached exact operation cancellation is durable and close stays local', async () => {
  const f = await setup();
  try {
    await f.invoke('parent', { jobs: [job('attached', 'attached'), job('detached')], hold: true });
    await bounded(Promise.all([f.work.started('attached'), f.work.started('detached')]));
    expect(
      (
        await f.request(
          '/v1/sessions/session/commands',
          {
            expectedStoreId: f.metadata.storeId,
            commandId: 'cancel-parent',
            kind: 'command.cancel',
            targetCommandId: 'parent',
          },
          true,
        )
      ).status,
    ).toBe(202);
    await f.runtime.waitForCommand('parent');
    await bounded(f.work.disposed('attached'));
    expect(f.work.stats('attached').cancels).toBe(1);
    expect(f.work.stats('detached').cancels).toBe(0);
    expect(await f.store.getExecution(f.work.ref('detached').executionId!)).toMatchObject({
      status: 'running',
    });
    expect(
      (
        await f.request(
          '/v1/sessions/session/commands',
          {
            expectedStoreId: f.metadata.storeId,
            commandId: 'cancel-operation',
            kind: 'command.cancel',
            targetCommandId: f.work.ref('detached').commandId,
          },
          true,
        )
      ).status,
    ).toBe(202);
    await bounded(f.work.disposed('detached'));
    await f.invoke('ref-control', { jobs: [job('ref-controlled')], cancelKey: 'ref-controlled' });
    await bounded(f.work.started('ref-controlled'));
    f.work.cancel('ref-controlled');
    await bounded(f.work.disposed('ref-controlled'));
    await f.runtime.waitForCommand('ref-control');
    expect(f.work.stats('ref-controlled').cancels).toBe(1);
    await f.invoke('close-owned', { jobs: [job('close-owned')] });
    await bounded(f.work.started('close-owned'));
    await f.invoke('peer-owned', { jobs: [job('peer')] }, true, 'other');
    await bounded(f.work.started('peer'));
    await f.service.close();
    expect(f.work.stats('close-owned').cancels).toBe(1);
    expect(f.work.stats('peer').cancels).toBe(0);
    f.work.finish('peer');
    await bounded(f.work.disposed('peer'));
  } finally {
    await f.close();
  }
}, 15000);

test('HTTP output is a read-only bounded keyset with strict 64-bit cursors and explicit clipped gaps', async () => {
  const f = await setup();
  try {
    await f.invoke('output', { jobs: [{ ...job('output'), output: true }] });
    await bounded(f.work.started('output'));
    f.work.finish('output');
    await bounded(f.work.disposed('output'));
    const id = f.work.ref('output').executionId!;
    const path = `/v1/executions/${id}/output`;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const response = await f.request(path);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: {
        seq: string;
        throughSeq: string;
        stream: string;
        droppedBytes: string | null;
        content: string;
      }[];
      highWaterSeq: string;
    };
    expect(page.highWaterSeq).toBe('5');
    expect(page.items.slice(0, 3).map((item) => item.content)).toEqual([
      'first',
      'second',
      '{"phase":"waiting"}',
    ]);
    expect(
      page.items.filter((item) => item.droppedBytes !== '0').map((item) => item.droppedBytes),
    ).toEqual(['9']);
    expect(page.items.find((item) => item.seq === '5')).toMatchObject({
      seq: '5',
      throughSeq: '5',
      stream: 'stderr',
      content: 'discarded',
      droppedBytes: '0',
    });
    const first = await (await f.request(`${path}?limit=2`)).json();
    expect(first.items.map((item: { seq: string }) => item.seq)).toEqual(['1', '2']);
    const next = await (await f.request(`${path}?afterSeq=2&upperSeq=4`)).json();
    expect(next.items.map((item: { seq: string }) => item.seq)).toEqual(['3', '4']);
    for (const query of [
      'afterSeq=01',
      'afterSeq=-1',
      'afterSeq=9223372036854775808',
      'upperSeq=',
      'limit=201',
      'limit=1.0',
      'afterSeq=4&upperSeq=3',
    ])
      expect((await f.request(`${path}?${query}`)).status).toBe(400);
    expect((await f.request(`${path}?afterSeq=6`)).status).toBe(409);
    expect((await f.request('/v1/executions/missing/output')).status).toBe(404);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.work.stats('output')).toEqual({ starts: 1, cancels: 0 });
    expect(f.model.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('process slot one queues actual Job start until the first adapter confirms terminal and releases', async () => {
  const f = await setup({ slots: 1 });
  try {
    await f.invoke('slots', { jobs: [job('slot-a'), job('slot-b')] });
    await bounded(f.work.started('slot-a'));
    await bounded(f.work.admitted('slot-b'));
    expect(f.work.stats('slot-b').starts).toBe(0);
    expect(await f.store.getExecution(f.work.ref('slot-b').executionId!)).toMatchObject({
      status: 'planned',
    });
    f.work.finish('slot-a');
    await bounded(f.work.started('slot-b'));
    expect(f.work.stats('slot-b').starts).toBe(1);
    f.work.finish('slot-b');
    await bounded(f.work.disposed('slot-b'));
  } finally {
    await f.close();
  }
}, 15000);

test('missing workspace resource backend fails before Job adapter start without a fake successful execution', async () => {
  const f = await setup({ serial: true });
  try {
    await f.invoke('unavailable', { jobs: [job('blocked')] });
    await bounded(f.work.admitted('blocked'));
    const execution = await f.runtime.waitForCommand(f.work.ref('blocked').commandId);
    expect(execution.status).toBe('applied');
    expect(await f.store.getExecution(f.work.ref('blocked').executionId!)).toMatchObject({
      status: 'failed',
    });
    expect(f.work.stats('blocked').starts).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);

test('real Workspace OS serial locks coordinate Jobs across Services and release only on confirmed terminal', async () => {
  const f = await setup({ serial: true, locks: true });
  try {
    await f.invoke('serial-a', { jobs: [job('serial-a')] });
    await bounded(f.work.started('serial-a'));
    await f.invoke('serial-b', { jobs: [job('serial-b')] }, true, 'other');
    await bounded(f.work.admitted('serial-b'));
    expect(f.work.stats('serial-b').starts).toBe(0);
    expect(await f.peer.getExecution(f.work.ref('serial-b').executionId!)).toMatchObject({
      status: 'planned',
    });
    f.work.finish('serial-a');
    await bounded(f.work.started('serial-b'));
    expect(f.work.stats('serial-b').starts).toBe(1);
    f.work.finish('serial-b');
    await bounded(f.work.disposed('serial-b'));
    expect(f.model.requests).toHaveLength(0);
    expect(f.peerModel.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('real Job output prefix budget coalesces later output into an explicit clipped gap', async () => {
  const f = await setup();
  try {
    await f.invoke('bulk', { jobs: [{ ...job('bulk'), bulk: true }] });
    await bounded(f.work.started('bulk'));
    f.work.finish('bulk');
    await bounded(f.work.disposed('bulk'));
    const path = `/v1/executions/${f.work.ref('bulk').executionId}/output`;
    const page = await (await f.request(path)).json();
    expect(page.highWaterSeq).toBe('40');
    expect(page.items).toHaveLength(32);
    const gap = page.items[31];
    expect(gap).toMatchObject({
      seq: '32',
      throughSeq: '40',
      content: '',
      droppedBytes: String(32768 * 9),
    });
    const clipped = await (await f.request(`${path}?afterSeq=35&upperSeq=38`)).json();
    expect(clipped.items).toHaveLength(1);
    expect(clipped.items[0]).toMatchObject({ seq: '36', throughSeq: '38', droppedBytes: null });
    expect(f.work.stats('bulk')).toEqual({ starts: 1, cancels: 0 });
  } finally {
    await f.close();
  }
}, 15000);
