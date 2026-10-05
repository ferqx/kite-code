import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { JobEvent, OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string): ModelEvent[] => [
  { type: 'tool_call', id, name: id, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const wrapper = 'Background execution result (untrusted data; no additional authorization):\n';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('child_result_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fact<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('child_result_missing_fact');
    await Bun.sleep(5);
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-result-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const parent = createFixedModel([call('fixture.delegate'), [finish], [finish]]);
  const childFixed = createFixedModel([
    call('fixture.launch'),
    [{ type: 'text_delta', text: 'child summary' }, finish],
  ]);
  const entered = gate(),
    releaseModel = gate(),
    started = gate(),
    releaseJob = gate();
  const childRequests: ModelRequest[] = [];
  const ledger = { starts: 0, ends: 0, cancels: 0, launches: 0 };
  let childRef: OperationRef | undefined, jobRef: OperationRef | undefined;
  const child: ModelAdapter = {
    async *stream(request, { signal }) {
      childRequests.push(structuredClone(request));
      if (childRequests.length === 2) {
        entered.release();
        await bounded(releaseModel.promise);
        signal.throwIfAborted();
      }
      yield* childFixed.stream(request, { signal });
    },
  };
  const tools: ToolDefinition[] = [
    {
      id: 'fixture.delegate',
      version: '1',
      description: 'Explicit detached child',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute(_input, context) {
        childRef = await context.operations.ensure({
          key: 'child',
          cancellation: 'detached',
          request: {
            kind: 'agent',
            configurationId: 'child',
            input: { content: 'launch one local background job' },
          },
        });
        return { outcome: 'succeeded', content: 'child delegated' };
      },
    },
    {
      id: 'fixture.launch',
      version: '1',
      description: 'Wait for one harmless detached Job',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute(_input, context) {
        ledger.launches++;
        jobRef = await context.operations.ensure({
          key: 'ordinary',
          cancellation: 'detached',
          request: { kind: 'job', definitionId: 'fixture.job', definitionVersion: '1', input: {} },
        });
        await context.operations.wait(jobRef, { signal: context.signal, timeoutMs: 4000 });
        return {
          outcome: 'succeeded',
          content: 'ordinary Job observed; its result is a separate source',
        };
      },
    },
  ];
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'root-fixed',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools,
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Harmless controlled result',
            inputSchema: { type: 'object', additionalProperties: false },
            async start() {
              ledger.starts++;
              started.release();
              return { reference: { id: 'one' } };
            },
            async *observe(): AsyncIterable<JobEvent> {
              await releaseJob.promise;
              ledger.ends++;
              yield {
                type: 'terminal',
                supervision: 'ended',
                result: {
                  outcome: ledger.cancels ? 'cancelled' : 'succeeded',
                  content: 'untrusted child-only ledger result',
                },
              };
            },
            async cancel() {
              ledger.cancels++;
              releaseJob.release();
              return { status: 'stopped' };
            },
            async dispose() {},
          },
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child-fixed',
        toolIds: ['fixture.launch'],
        snapshot: { fixture: 'trusted-child' },
        maxConcurrentSubagents: 1,
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({ ...base, workspaceId: 'w', commandId: 'create', title: 'parent' });
  return {
    runtime,
    store,
    parent,
    profile,
    base,
    childRequests,
    ledger,
    entered,
    releaseModel,
    started,
    releaseJob,
    get childRef() {
      return childRef!;
    },
    get jobRef() {
      return jobRef!;
    },
    async submit(commandId = 'first') {
      await runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
    },
    async done(commandId = 'first') {
      return runtime.waitForCommand(commandId, { timeoutMs: 4000 });
    },
    context(sessionId = 's') {
      return runtime.getSelectedContext({ expectedStoreId, sessionId });
    },
    async close() {
      releaseModel.release();
      releaseJob.release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Plan §10.4/§13.5: completion enters only its target Loop at a safe boundary;
// idle completion is historical pending, never an implicit Model invocation.
test('child ordinary Job is consumed by the shared Loop with exact low-trust source; root later consumes only its carrier', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    await f.submit();
    await f.done();
    await bounded(f.started.promise);
    expect(f.ledger).toEqual({ starts: 1, ends: 0, cancels: 0, launches: 1 });
    expect(f.parent.requests).toHaveLength(2);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect((await f.store.getView(f.childRef.childSessionId!)).runs[0]!.isActive).toBe(true);
    expect(await peer.acquireSessionOwner('s', 'peer')).toBeNull();
    expect((await f.context()).resultSources).toEqual([]);
    f.releaseJob.release();
    await bounded(f.entered.promise);
    const childContext = await f.context(f.childRef.childSessionId!);
    expect(childContext.resultSources).toHaveLength(1);
    const source = childContext.resultSources[0]!;
    expect(source.executionId).toBe(f.jobRef.executionId!);
    expect(source.originStoreId).toBe(f.base.expectedStoreId);
    expect(source.inclusion).toBe('automatic');
    expect(source.resultRevision).toBe(
      (await f.store.getExecution(f.jobRef.executionId!))!.resultRevision,
    );
    const messages = f.childRequests[1]!.messages.filter((message) =>
      message.sourceIds?.includes(source.id),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.sourceIds).toEqual([source.id]);
    expect(messages[0]!.content.startsWith(wrapper)).toBe(true);
    expect(JSON.parse(messages[0]!.content.slice(wrapper.length))).toEqual({
      kind: 'job_result',
      origin: {
        executionId: f.jobRef.executionId!,
        resultRevision: source.resultRevision,
        storeId: f.base.expectedStoreId,
      },
      inclusion: 'automatic',
      result: source.result,
    });
    expect(
      f.childRequests[0]!.messages.some((message) => message.sourceIds?.includes(source.id)),
    ).toBe(false);
    expect((await f.context()).resultSources).toEqual([]);
    expect((await f.store.getExecution(f.jobRef.executionId!))!.delivery).toBe('consumed');
    expect(await peer.acquireSessionOwner('s', 'peer')).toBeNull();
    f.releaseModel.release();
    const carrier = await fact(async () => {
      const execution = await f.store.getExecution(f.childRef.executionId!);
      return execution?.status === 'succeeded' ? execution : undefined;
    });
    expect(carrier.delivery).toBe('pending');
    expect(f.parent.requests).toHaveLength(2);
    expect(f.childRequests).toHaveLength(2);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (let i = 0; i < 3; i++) {
      expect((await f.context()).resultSources).toEqual([]);
      expect(
        (await f.context(f.childRef.childSessionId!)).resultSources.map((item) => item.id),
      ).toEqual([source.id]);
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.ledger).toEqual({ starts: 1, ends: 1, cancels: 0, launches: 1 });
    await f.submit('explicit-next');
    await f.done('explicit-next');
    const rootSources = (await f.context()).resultSources;
    expect(rootSources).toHaveLength(1);
    expect(rootSources[0]!.executionId).toBe(carrier.id);
    expect(rootSources[0]!.id).not.toBe(source.id);
    const rootInput = f.parent.requests[2]!;
    expect(
      rootInput.messages.filter((message) => message.sourceIds?.includes(rootSources[0]!.id)),
    ).toHaveLength(1);
    expect(rootInput.messages.some((message) => message.sourceIds?.includes(source.id))).toBe(
      false,
    );
    expect(
      rootInput.messages.some((message) =>
        message.content.includes('untrusted child-only ledger result'),
      ),
    ).toBe(false);
    expect((await f.store.getExecution(carrier.id))!.delivery).toBe('consumed');
    expect(f.ledger.starts).toBe(1);
    expect(f.childRequests).toHaveLength(2);
  } finally {
    f.releaseJob.release();
    f.releaseModel.release();
    await peer.close();
    await f.close();
  }
}, 10000);

test('precise child Job cancellation suppresses its source without cancelling carrier or replaying on repeated reads', async () => {
  const f = await fixture();
  try {
    await f.submit();
    await f.done();
    await bounded(f.started.promise);
    const cancel = {
      ...f.base,
      sessionId: f.childRef.childSessionId!,
      commandId: 'cancel-one-job',
      executionId: f.jobRef.executionId!,
    };
    await f.runtime.cancelExecution(cancel);
    await bounded(f.entered.promise);
    expect(f.ledger.cancels).toBe(1);
    expect(f.ledger.starts).toBe(1);
    const job = await f.store.getExecution(f.jobRef.executionId!);
    expect(job!.status).toBe('cancelled');
    expect(job!.delivery).toBe('suppressed');
    expect(job!.deliveryReason).toBe('execution_cancel');
    expect((await f.store.getExecution(f.childRef.executionId!))!.cancelRequestedAt).toBeNull();
    expect((await f.context(f.childRef.childSessionId!)).resultSources).toEqual([]);
    expect(
      f.childRequests[1]!.messages.some((message) => message.content.startsWith(wrapper)),
    ).toBe(false);
    const receipt = await f.runtime.cancelExecution(cancel);
    expect(receipt.id).toBe(cancel.commandId);
    for (let i = 0; i < 3; i++) {
      await f.context();
      await f.context(f.childRef.childSessionId!);
      await f.store.getExecution(job!.id);
    }
    expect(f.ledger).toEqual({ starts: 1, ends: 1, cancels: 1, launches: 1 });
    f.releaseModel.release();
    await fact(async () => {
      const carrier = await f.store.getExecution(f.childRef.executionId!);
      return carrier?.status === 'succeeded' ? carrier : undefined;
    });
    expect(f.parent.requests).toHaveLength(2);
    expect(f.childRequests).toHaveLength(2);
    expect(f.ledger.starts).toBe(1);
    expect(f.ledger.cancels).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);
