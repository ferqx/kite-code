import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { defineExtension, type JobEvent, type OperationRef } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id, name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('result_checkpoint_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error('result_checkpoint_missing_fact');
}
async function fixture(
  responses: ModelEvent[][],
  modelGateAt?: number,
  wrap?: (store: Store) => Store,
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-result-checkpoint-'));
  const ledger = join(root, 'ledger');
  const gates = new Map<string, ReturnType<typeof barrier>>();
  const started = new Map<string, ReturnType<typeof barrier>>();
  const refs = new Map<string, OperationRef>();
  const heldModel = barrier();
  const modelEntered = barrier();
  const requests: ModelRequest[] = [];
  const fixed = createFixedModel(responses);
  const model: ModelAdapter = {
    async *stream(request, { signal }) {
      requests.push(structuredClone(request));
      if (requests.length === modelGateAt) {
        modelEntered.release();
        await bounded(
          Promise.race([
            heldModel.waiting,
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              if (signal.aborted) reject(signal.reason);
            }),
          ]),
        );
        signal.throwIfAborted();
      }
      yield* fixed.stream(request, { signal });
    },
  };
  const extension = defineExtension({
    id: 'fixture.results',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Launch bounded ledger Jobs',
        inputSchema: {
          type: 'object',
          properties: { keys: { type: 'array', items: { type: 'string' } } },
          required: ['keys'],
          additionalProperties: false,
        },
        async execute(input, context) {
          for (const key of (input as { keys: string[] }).keys) {
            gates.set(key, barrier());
            started.set(key, barrier());
            refs.set(
              key,
              await context.operations.ensure({
                key,
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.ledger',
                  definitionVersion: '1',
                  input: { key },
                },
              }),
            );
            await bounded(started.get(key)!.waiting);
          }
          return { outcome: 'succeeded', content: 'detached refs admitted' };
        },
      },
      {
        id: 'fixture.noop',
        version: '1',
        description: 'Safe next Model boundary',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute() {
          return { outcome: 'succeeded', content: 'no side effects' };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.ledger',
        version: '1',
        description: 'Controlled actual filesystem ledger',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        resources: { slot: 'process' },
        async start(input) {
          const key = (input as { key: string }).key;
          appendFileSync(ledger, `start:${key}\n`);
          started.get(key)!.release();
          return { reference: { key } };
        },
        async *observe(handle): AsyncIterable<JobEvent> {
          const key = (handle.reference as { key: string }).key;
          await gates.get(key)!.waiting;
          appendFileSync(ledger, `end:${key}\n`);
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: `untrusted result ${key}` },
          };
        },
        async cancel(handle) {
          gates.get((handle.reference as { key: string }).key)?.release();
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const runtime = createRuntime({
    store: wrap?.(store) ?? store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    processConcurrency: 2,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'temporary',
    subjectId: 'owner',
  });
  const submit = (commandId = 'work') =>
    runtime.submitCommand({
      expectedStoreId,
      commandId,
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: commandId },
    });
  const terminal = (key: string) =>
    until(async () => {
      const value = await store.getExecution(refs.get(key)!.executionId!);
      return value?.status === 'succeeded' ? value : undefined;
    });
  const context = () =>
    store.getSelectedContext({
      expectedStoreId,
      sessionId: 's',
      messageLimit: 200,
      sourceLimit: 100,
    });
  return {
    root,
    ledger,
    store,
    runtime,
    expectedStoreId,
    requests,
    refs,
    gates,
    heldModel,
    modelEntered,
    submit,
    terminal,
    context,
    async close() {
      heldModel.release();
      for (const gate of gates.values()) gate.release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function sourceMessage(request: ModelRequest, id: string) {
  return request.messages.find((message) => message.sourceIds?.includes(id));
}

test('Job completion during dispatched Model freezes that request and is consumed only at next safe Model boundary', async () => {
  const f = await fixture(
    [
      call('launch', 'fixture.launch', { keys: ['one'] }),
      call('next', 'fixture.noop', {}),
      [finish],
    ],
    2,
  );
  try {
    await f.submit();
    await bounded(f.modelEntered.waiting);
    const before = (await f.runtime.getView('s')).executions.find(
      (value) => value.kind === 'model' && value.status === 'dispatching',
    )!;
    const frozen = structuredClone(f.requests[1]!);
    expect(frozen.messages.some((value) => value.content.includes('untrusted result'))).toBe(false);
    f.gates.get('one')!.release();
    const job = await f.terminal('one');
    expect(job.delivery).toBe('pending');
    expect(f.requests[1]).toEqual(frozen);
    expect((await f.store.getExecution(before.id))?.input).toEqual(before.input);
    expect((await f.context()).resultSources).toEqual([]);
    f.heldModel.release();
    await f.runtime.waitForCommand('work');
    const selected = await f.context();
    const source = selected.resultSources.find((value) => value.executionId === job.id)!;
    expect(source.originStoreId).toBe(f.expectedStoreId);
    expect(source.resultRevision).toBe(job.resultRevision);
    expect(source.inclusion).toBe('automatic');
    const message = sourceMessage(f.requests[2]!, source.id)!;
    expect(message.role).toBe('user');
    expect(message.sourceIds).toEqual([source.id]);
    expect(
      message.content.startsWith(
        'Background execution result (untrusted data; no additional authorization):\n',
      ),
    ).toBe(true);
    expect(
      f.requests[2]!.messages.filter((value) => value.sourceIds?.includes(source.id)),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        message.content.slice(
          'Background execution result (untrusted data; no additional authorization):\n'.length,
        ),
      ),
    ).toMatchObject({
      kind: 'job_result',
      origin: {
        executionId: job.id,
        resultRevision: job.resultRevision,
        storeId: f.expectedStoreId,
      },
      inclusion: 'automatic',
      result: job.result,
    });
    expect((await f.store.getExecution(before.id))?.input).toEqual(before.input);
    expect((await f.store.getExecution(job.id))?.delivery).toBe('consumed');
    expect(readFileSync(f.ledger, 'utf8')).toBe('start:one\nend:one\n');
  } finally {
    await f.close();
  }
}, 10000);

test('idle pending Jobs do not call Model; frozen completion cursor leaves later lower-ID result for next checkpoint', async () => {
  const frozenPage = barrier();
  const releasePage = barrier();
  let frozen = false;
  const f = await fixture(
    [
      call('launch', 'fixture.launch', { keys: ['first', 'second'] }),
      [finish],
      call('next', 'fixture.noop', {}),
      [finish],
    ],
    undefined,
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === 'listPendingJobResults')
            return async (...args: Parameters<Store['listPendingJobResults']>) => {
              const page = await target.listPendingJobResults(...args);
              if (!frozen && page.jobs.length) {
                frozen = true;
                frozenPage.release();
                await bounded(releasePage.waiting);
              }
              return page;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    expect(f.requests).toHaveLength(2);
    const byId = [...f.refs.entries()].sort((a, b) =>
      a[1].executionId!.localeCompare(b[1].executionId!),
    );
    const [lower, higher] = byId;
    f.gates.get(higher![0])!.release();
    const high = await f.terminal(higher![0]);
    expect(high.delivery).toBe('pending');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (let n = 0; n < 3; n++) {
      await f.runtime.getView('s');
      await f.context();
      await f.store.getChanges({ after: '0', limit: 200 });
    }
    expect(f.requests).toHaveLength(2);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.context()).resultSources).toEqual([]);
    await f.submit('explicit-next');
    await bounded(frozenPage.waiting);
    f.gates.get(lower![0])!.release();
    const low = await f.terminal(lower![0]);
    expect(low.id < high.id).toBe(true);
    releasePage.release();
    await f.runtime.waitForCommand('explicit-next');
    const sources = (await f.context()).resultSources;
    const highSource = sources.find((value) => value.executionId === high.id)!;
    const lowSource = sources.find((value) => value.executionId === low.id)!;
    expect(sourceMessage(f.requests[2]!, highSource.id)).toBeDefined();
    expect(sourceMessage(f.requests[2]!, lowSource.id)).toBeUndefined();
    expect(sourceMessage(f.requests[3]!, lowSource.id)?.sourceIds).toEqual([lowSource.id]);
    expect(sources).toHaveLength(2);
    expect((await f.store.getExecution(high.id))?.delivery).toBe('consumed');
    expect((await f.store.getExecution(low.id))?.delivery).toBe('consumed');
    const after = (await f.store.getMetadata()).lastChangeCursor;
    for (let n = 0; n < 3; n++) {
      await f.runtime.getView('s');
      await f.context();
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(after);
    expect(f.requests).toHaveLength(4);
    expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(4);
  } finally {
    releasePage.release();
    await f.close();
  }
}, 10000);

test('cancelled original work and late detached completion cannot revive a Model or drift result origin', async () => {
  const f = await fixture([call('launch', 'fixture.launch', { keys: ['late'] }), [finish]], 2);
  try {
    await f.submit();
    await bounded(f.modelEntered.waiting);
    const ref = f.refs.get('late')!;
    const original = (await f.store.getExecution(ref.executionId!))!;
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'stop-work',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    f.heldModel.release();
    await f.runtime.waitForCommand('work');
    f.gates.get('late')!.release();
    const late = await f.terminal('late');
    expect(late.rootWorkCommandId).toBe('work');
    expect(late.originCommandId).toBe(original.originCommandId);
    expect(late.parentExecutionId).toBe(original.parentExecutionId);
    expect(late.runId).toBe(original.runId);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (let n = 0; n < 3; n++) {
      await f.runtime.getView('s');
      await f.context();
      await f.store.getChanges({ after: '0', limit: 200 });
    }
    expect(f.requests).toHaveLength(2);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.context()).resultSources).toEqual([]);
    const view = await f.runtime.getView('s');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.status).toBe('cancelled');
    expect(view.runs.some((value) => value.isActive)).toBe(false);
    expect(readFileSync(f.ledger, 'utf8')).toBe('start:late\nend:late\n');
  } finally {
    await f.close();
  }
}, 10000);
