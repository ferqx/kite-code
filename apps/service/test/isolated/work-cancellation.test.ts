import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension, type JobEvent } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { startService } from '../../src';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('barrier_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-cancelwork-'));
  const dataRoot = join(root, 'data');
  const ledger = join(root, 'ledger');
  const entered = gate<void>();
  const aborted = gate<void>();
  const jobStarted = gate<void>();
  const jobEnded = gate<'succeeded' | 'cancelled'>();
  const disposed = gate<void>();
  let toolId = '';
  let backgroundId = '';
  let jobCancels = 0;
  let futureFailure: unknown;
  const extension = defineExtension({
    id: 'fixture.work-cancel',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'fixture.background',
        version: '1',
        description: 'Known supervised background',
        inputSchema: {},
        async start() {
          appendFileSync(ledger, 'job-start\n');
          jobStarted.resolve();
          return { reference: { key: 'background' } };
        },
        async *observe(): AsyncIterable<JobEvent> {
          const outcome = await jobEnded.promise;
          appendFileSync(ledger, `job-end:${outcome}\n`);
          yield { type: 'terminal', supervision: 'ended', result: { outcome, content: outcome } };
        },
        async cancel() {
          jobCancels++;
          jobEnded.resolve('cancelled');
          return { status: 'stopped' as const };
        },
        async dispose() {
          disposed.resolve();
        },
      },
    ],
    tools: [
      {
        id: 'fixture.waiting-tool',
        version: '1',
        description: 'Launch detached work and wait for exact tool cancellation',
        inputSchema: {},
        async execute(_input, context) {
          toolId = context.executionId;
          const ref = await context.operations.ensure({
            key: 'background',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.background',
              definitionVersion: '1',
              input: {},
            },
          });
          backgroundId = ref.executionId!;
          await jobStarted.promise;
          entered.resolve();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          aborted.resolve();
          try {
            await context.operations.ensure({
              key: 'old-future',
              request: {
                kind: 'job',
                definitionId: 'fixture.background',
                definitionVersion: '1',
                input: {},
              },
            });
          } catch (error) {
            futureFailure = error;
          }
          return { outcome: 'cancelled', content: 'Exact tool stopped before any tool effect' };
        },
      },
    ],
  });
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'tool', name: 'fixture.waiting-tool', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
    [finish],
  ]);
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const peerStore = await openSqliteStore({ dataRoot, profile: 'test' });
  const permissions = {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    extensions: [extension],
    permissions,
    instanceId: 'owner',
  });
  const peer = createRuntime({
    store: peerStore,
    extensions: [extension],
    permissions,
    instanceId: 'peer',
  });
  const selected = resolveProfile({ dataRoot, profile: 'test' });
  const profile = {
    dataRoot: selected.dataRoot,
    name: 'test',
    accessKey: selected.profileAccessKey,
  };
  const service = await startService({ runtime, profile, subjectId: 'owner', buildId: 'cancel' });
  const serviceB = await startService({
    runtime: peer,
    profile,
    subjectId: 'owner',
    buildId: 'cancel',
  });
  const intruder = await startService({
    runtime: peer,
    profile,
    subjectId: 'intruder',
    buildId: 'cancel',
  });
  const metadata = await store.getMetadata();
  const post = (body: unknown, host = serviceB) =>
    fetch(`${host.endpoint}/v1/sessions/session/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${host.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  await runtime.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'workspace',
    name: 'Test',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId: metadata.storeId,
    commandId: 'create',
    sessionId: 'session',
    subjectId: 'owner',
    workspaceId: 'workspace',
    title: 'Test',
  });
  expect(
    (
      await post(
        {
          expectedStoreId: metadata.storeId,
          commandId: 'start',
          kind: 'run.start',
          content: 'Start',
        },
        service,
      )
    ).status,
  ).toBe(202);
  await bounded(entered.promise);
  const readinessDeadline = Date.now() + 4000;
  while ((await runtime.getExecution(backgroundId))?.status !== 'running') {
    if (Date.now() >= readinessDeadline) throw new Error('job_running_timeout');
  }
  const runId = (await store.getView('session')).runs[0]!.id;
  return {
    store,
    runtime,
    peer,
    model,
    post,
    service,
    intruder,
    metadata,
    runId,
    get toolId() {
      return toolId;
    },
    get backgroundId() {
      return backgroundId;
    },
    get jobCancels() {
      return jobCancels;
    },
    get futureFailure() {
      return futureFailure;
    },
    aborted,
    disposed,
    jobEnded,
    ledger,
    async close() {
      await service.close();
      await serviceB.close();
      await intruder.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('cross HTTP Execution cancel rejects wrong subject/store and stops only the exact normal Tool while Run and detached sibling continue', async () => {
  const f = await setup();
  try {
    const control = { kind: 'execution.cancel', executionId: f.toolId };
    const cursorBeforeRejectedControl = (await f.store.getMetadata()).lastChangeCursor;
    expect(
      (
        await f.post(
          { ...control, expectedStoreId: f.metadata.storeId, commandId: 'intruder' },
          f.intruder,
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.post({ ...control, expectedStoreId: 'wrong', commandId: 'wrong-store' })).status,
    ).toBe(409);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursorBeforeRejectedControl);
    expect(await f.runtime.getCommand('intruder')).toBeNull();
    expect(await f.runtime.getCommand('wrong-store')).toBeNull();
    expect(f.jobCancels).toBe(0);
    expect(await f.runtime.getExecution(f.toolId)).toMatchObject({
      status: 'dispatching',
      cancelRequestedAt: null,
    });
    expect(
      (await f.post({ ...control, expectedStoreId: f.metadata.storeId, commandId: 'exact-tool' }))
        .status,
    ).toBe(202);
    await bounded(f.aborted.promise);
    await f.runtime.waitForCommand('start');
    expect(await f.runtime.getExecution(f.toolId)).toMatchObject({ status: 'cancelled' });
    expect(await f.runtime.getRun(f.runId)).toMatchObject({ status: 'completed' });
    expect(await f.runtime.getExecution(f.backgroundId)).toMatchObject({ status: 'running' });
    expect(f.jobCancels).toBe(0);
    expect(f.model.requests).toHaveLength(2);
    expect(f.futureFailure).toBeDefined();
    f.jobEnded.resolve('succeeded');
    await bounded(f.disposed.promise);
    expect(readFileSync(f.ledger, 'utf8')).toBe('job-start\njob-end:succeeded\n');
  } finally {
    await f.close();
  }
}, 15000);

test('cross HTTP Run cancel uses the submitted exact Run and preserves detached background work and later user Run', async () => {
  const f = await setup();
  try {
    const control = {
      expectedStoreId: f.metadata.storeId,
      commandId: 'run-cancel',
      kind: 'run.cancel',
      runId: f.runId,
    };
    expect((await f.post(control)).status).toBe(202);
    await bounded(f.aborted.promise);
    await f.runtime.waitForCommand('start');
    expect(await f.runtime.getRun(f.runId)).toMatchObject({ status: 'cancelled' });
    expect(f.jobCancels).toBe(0);
    f.jobEnded.resolve('succeeded');
    await bounded(f.disposed.promise);
    expect(
      (
        await f.post(
          {
            expectedStoreId: f.metadata.storeId,
            commandId: 'new-run',
            kind: 'run.start',
            content: 'New explicit work',
          },
          f.service,
        )
      ).status,
    ).toBe(202);
    const next = await f.runtime.waitForCommand('new-run');
    const newId = (next.receipt as { runId: string }).runId;
    expect(await f.runtime.getRun(newId)).toMatchObject({ status: 'completed' });
    expect((await f.post(control)).status).toBe(202);
    expect(await f.runtime.getRun(newId)).toMatchObject({ status: 'completed' });
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);

test('cross HTTP Session stop with background closes its selected old causal work while a new user Run remains usable', async () => {
  const f = await setup();
  try {
    expect(
      (
        await f.post({
          expectedStoreId: f.metadata.storeId,
          commandId: 'stop-session',
          kind: 'session.cancel',
          includeBackground: true,
        })
      ).status,
    ).toBe(202);
    await bounded(f.aborted.promise);
    await bounded(f.disposed.promise);
    await f.runtime.waitForCommand('start');
    expect(await f.runtime.getRun(f.runId)).toMatchObject({ status: 'cancelled' });
    expect(await f.runtime.getExecution(f.backgroundId)).toMatchObject({ status: 'cancelled' });
    expect(f.jobCancels).toBe(1);
    expect(f.futureFailure).toBeDefined();
    expect(
      (await f.store.getView('session')).executions.filter((item) => item.id === f.backgroundId),
    ).toHaveLength(1);
    expect(
      (
        await f.post(
          {
            expectedStoreId: f.metadata.storeId,
            commandId: 'after-stop',
            kind: 'run.start',
            content: 'Fresh user intent',
          },
          f.service,
        )
      ).status,
    ).toBe(202);
    const next = await f.runtime.waitForCommand('after-stop');
    expect(await f.runtime.getRun((next.receipt as { runId: string }).runId)).toMatchObject({
      status: 'completed',
    });
    expect(f.model.requests).toHaveLength(2);
    expect(readFileSync(f.ledger, 'utf8')).toBe('job-start\njob-end:cancelled\n');
  } finally {
    await f.close();
  }
}, 15000);
