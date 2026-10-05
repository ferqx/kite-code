import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { startService } from '../../src';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const toolResponse: ModelEvent[] = [
  { type: 'tool_call', id: 'count', name: 'fixture.count', arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];

async function pair(gate: 'model' | 'permission' = 'model') {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-pair-'));
  const dataRoot = join(root, 'data');
  // Effects deliberately live outside the recoverable profile.
  const ledger = join(root, 'external-effects.jsonl');
  const entered = barrier();
  const proceed = barrier();
  const observedAbort = barrier();
  const waitAtGate = async (signal: AbortSignal) => {
    entered.release();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        observedAbort.release();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void proceed.waiting.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
      if (signal.aborted) abort();
    });
  };
  const first = createFixedModel([toolResponse, [finish], toolResponse, [finish]]);
  const second = createFixedModel([toolResponse, [finish], toolResponse, [finish]]);
  let firstRequest = true;
  const gated: ModelAdapter = {
    async *stream(request, options) {
      if (firstRequest && gate === 'model') {
        firstRequest = false;
        await waitAtGate(options.signal);
      }
      yield* first.stream(request, options);
    },
  };
  const extension = defineExtension({
    id: 'fixture.pair',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.count',
        version: '1',
        description: 'External effect counter',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          appendFileSync(ledger, `${JSON.stringify({ executionId: context.executionId })}\n`);
          return { outcome: 'succeeded', content: 'counted' };
        },
      },
    ],
  });
  const storeA = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const storeB = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const runtimeA = createRuntime({
    store: storeA,
    model: gated,
    modelId: 'fixed',
    instanceId: 'service-a',
    extensions: [extension],
    permissions: {
      async authorize(request) {
        if (firstRequest && gate === 'permission' && request.definitionId === 'fixture.count') {
          firstRequest = false;
          await waitAtGate(request.signal);
        }
        return { allowed: true, revision: '1' };
      },
    },
  });
  const runtimeB = createRuntime({
    store: storeB,
    model: second,
    modelId: 'fixed',
    instanceId: 'service-b',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'disposable',
    accessKey: resolveProfile({ dataRoot, profile: 'disposable' }).profileAccessKey,
  };
  const serviceA = await startService({
    runtime: runtimeA,
    profile,
    buildId: 'pair',
    subjectId: 'owner',
  });
  const serviceB = await startService({
    runtime: runtimeB,
    profile,
    buildId: 'pair',
    subjectId: 'owner',
  });
  const metadata = await storeA.getMetadata();
  const request = (service: typeof serviceA, path: string, init?: RequestInit) =>
    fetch(service.endpoint + path, {
      ...init,
      headers: { authorization: `Bearer ${service.bootstrap.token}`, ...init?.headers },
    });
  const post = (service: typeof serviceA, path: string, body: unknown) =>
    request(service, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post(serviceA, '/v1/workspaces', {
        expectedStoreId: metadata.storeId,
        id: 'workspace',
        rootUri: `file://${root}`,
        name: 'Disposable',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await post(serviceA, '/v1/sessions', {
        expectedStoreId: metadata.storeId,
        commandId: 'create',
        sessionId: 'session',
        workspaceId: 'workspace',
        title: 'Pair',
      })
    ).status,
  ).toBe(201);
  return {
    storeA,
    storeB,
    runtimeA,
    runtimeB,
    serviceA,
    serviceB,
    metadata,
    entered,
    proceed,
    observedAbort,
    first,
    second,
    request,
    post,
    ledger,
    async close() {
      proceed.release();
      await Promise.all([serviceA.close(), serviceB.close()]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function ready(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = '';
  const timer = setTimeout(() => {
    void reader.cancel('test deadline');
  }, 5000);
  try {
    while (!text.includes('event: ready')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Stream closed before ready');
      text += new TextDecoder().decode(chunk.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

test('two real Services retain the waiting owner and consume another host accepted command exactly once', async () => {
  const data = await pair();
  const timings: Record<string, number> = {};
  const command = (id: string) => ({
    expectedStoreId: data.metadata.storeId,
    commandId: id,
    kind: 'run.start',
    content: id,
  });
  try {
    let start = performance.now();
    expect(
      (await data.post(data.serviceA, '/v1/sessions/session/commands', command('first'))).status,
    ).toBe(202);
    timings.firstHttpAcceptanceMs = performance.now() - start;
    await data.entered.waiting;
    const owner = (await data.storeA.getView('session')).session;
    expect(owner.ownerInstanceId).toBe('service-a');
    start = performance.now();
    expect(
      (await data.post(data.serviceB, '/v1/sessions/session/commands', command('second'))).status,
    ).toBe(202);
    timings.secondHttpAcceptanceMs = performance.now() - start;
    // Repeated real HTTP and Worker roundtrips provide an explicit waiting phase,
    // without using elapsed sleeps as proof that ownership cannot be stolen.
    start = performance.now();
    for (let index = 0; index < 12; index++) {
      const current = (await data.storeB.getView('session')).session;
      expect(current.ownerInstanceId).toBe(owner.ownerInstanceId);
      expect(current.ownerGeneration).toBe(owner.ownerGeneration);
      expect((await data.request(data.serviceB, '/v1/commands/second')).status).toBe(200);
    }
    timings.ownerWaitingReadRoundtripsMs = performance.now() - start;
    expect(data.second.requests).toHaveLength(0);
    expect((await data.storeB.getCommand('second'))!.status).toBe('accepted');
    start = performance.now();
    await data.storeB.getChanges({ after: '0', limit: 100 });
    timings.workerAndSqlChangeReadMs = performance.now() - start;
    start = performance.now();
    data.proceed.release();
    await data.runtimeA.waitForCommand('first');
    await data.runtimeB.waitForCommand('second', { timeoutMs: 3000 });
    timings.gateReleaseToBothTerminalMs = performance.now() - start;
    const view = await data.storeB.getView('session');
    expect(view.runs).toHaveLength(2);
    expect(view.runs.every((run) => run.status === 'completed')).toBe(true);
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(2);
    const effects = readFileSync(data.ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(effects).toHaveLength(2);
    expect(new Set(effects.map((effect) => effect.executionId)).size).toBe(2);
    console.info('W14-A pair measurements', JSON.stringify(timings));
  } finally {
    await data.close();
  }
}, 15_000);

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled event deadline exceeded')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each([
  'model',
  'permission',
] as const)('a different Service cancels the live owner at the %s barrier without stealing ownership', async (gate) => {
  const data = await pair(gate);
  try {
    expect(
      (
        await data.post(data.serviceA, '/v1/sessions/session/commands', {
          expectedStoreId: data.metadata.storeId,
          commandId: 'cancel-work',
          kind: 'run.start',
          content: 'gated',
        })
      ).status,
    ).toBe(202);
    await data.entered.waiting;
    const owner = (await data.storeA.getView('session')).session;
    const cancel = {
      expectedStoreId: data.metadata.storeId,
      commandId: 'cancel-from-b',
      kind: 'command.cancel',
      targetCommandId: 'cancel-work',
    };
    const started = performance.now();
    expect(
      (await within(data.post(data.serviceB, '/v1/sessions/session/commands', cancel), 1000))
        .status,
    ).toBe(202);
    const acceptanceMs = performance.now() - started;
    expect((await data.storeB.getCommand('cancel-work'))!.cancelRequestedAt).not.toBeNull();
    const current = (await data.storeB.getView('session')).session;
    expect(current.ownerGeneration).toBe(owner.ownerGeneration);
    expect(data.second.requests).toHaveLength(0);
    await within(data.observedAbort.waiting, 1000);
    await data.runtimeB.waitForCommand('cancel-work', { timeoutMs: 1000 });
    expect((await data.storeB.getView('session')).runs[0]!.status).toBe('cancelled');
    const acceptanceToObservedAbortAndTerminalMs = performance.now() - started - acceptanceMs;
    expect(
      (
        await data.post(data.serviceB, '/v1/sessions/session/commands', {
          expectedStoreId: data.metadata.storeId,
          commandId: 'after-cancel',
          kind: 'run.start',
          content: 'later',
        })
      ).status,
    ).toBe(202);
    expect((await data.post(data.serviceB, '/v1/sessions/session/commands', cancel)).status).toBe(
      202,
    );
    await data.runtimeB.waitForCommand('after-cancel', { timeoutMs: 1000 });
    expect(
      (await data.storeB.getView('session')).runs.find(
        (run) => run.originCommandId === 'after-cancel',
      )!.status,
    ).toBe('completed');
    expect(readFileSync(data.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    console.info(
      'W14-A cross-host cancellation measurements',
      JSON.stringify({ acceptanceMs, acceptanceToObservedAbortAndTerminalMs, gate }),
    );
  } finally {
    await data.close();
  }
}, 15_000);

test('an already accepted command advances on the surviving Service after its owner host closes', async () => {
  const data = await pair();
  try {
    expect(
      (
        await data.post(data.serviceA, '/v1/sessions/session/commands', {
          expectedStoreId: data.metadata.storeId,
          commandId: 'closing-owner',
          kind: 'run.start',
          content: 'gated',
        })
      ).status,
    ).toBe(202);
    await data.entered.waiting;
    expect(
      (
        await data.post(data.serviceB, '/v1/sessions/session/commands', {
          expectedStoreId: data.metadata.storeId,
          commandId: 'surviving-work',
          kind: 'run.start',
          content: 'pending',
        })
      ).status,
    ).toBe(202);
    expect((await data.storeB.getCommand('surviving-work'))!.status).toBe('accepted');
    expect(data.second.requests).toHaveLength(0);
    await data.serviceA.close();
    await data.runtimeB.waitForCommand('surviving-work', { timeoutMs: 1000 });
    expect(
      (await data.storeB.getView('session')).runs.find(
        (run) => run.originCommandId === 'surviving-work',
      )!.status,
    ).toBe('completed');
    expect(readFileSync(data.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    await data.close();
  }
}, 15_000);

test('subscription switching and an unread replay remain local while the owner is gated', async () => {
  const data = await pair();
  const timings: Record<string, number> = {};
  let slowReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(
      (
        await data.post(data.serviceA, '/v1/sessions/session/commands', {
          expectedStoreId: data.metadata.storeId,
          commandId: 'stream-work',
          kind: 'run.start',
          content: 'stream work',
        })
      ).status,
    ).toBe(202);
    await data.entered.waiting;
    const cursor = (await data.storeB.getMetadata()).lastChangeCursor;
    const base = `/v1/events?storeId=${data.metadata.storeId}`;
    const slow = await data.request(data.serviceB, `${base}&after=0`);
    // Intentionally consume nothing until the execution has completed.
    slowReader = slow.body!.getReader();
    const start = performance.now();
    for (let index = 0; index < 16; index++) {
      const response = await data.request(
        index % 2 ? data.serviceA : data.serviceB,
        `${base}&after=${cursor}&sessionId=${index % 2 ? 'session' : 'unrelated'}`,
      );
      const reader = response.body!.getReader();
      await ready(reader);
      await reader.cancel();
      expect((await data.storeB.getView('session')).session.ownerInstanceId).toBe('service-a');
    }
    timings.subscriptionReadyConsumeAndDisconnectMs = performance.now() - start;
    expect(data.second.requests).toHaveLength(0);
    const release = performance.now();
    data.proceed.release();
    await data.runtimeA.waitForCommand('stream-work');
    timings.gateReleaseToTerminalMs = performance.now() - release;
    expect((await data.storeB.getView('session')).runs[0]!.status).toBe('completed');
    expect(readFileSync(data.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    const consume = performance.now();
    await ready(slowReader);
    timings.delayedReplayFirstReadyConsumeMs = performance.now() - consume;
    console.info('W14-A subscription measurements', JSON.stringify(timings));
  } finally {
    await slowReader?.cancel();
    await data.close();
  }
}, 15_000);
