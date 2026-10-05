import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension, type Extension, type JobEvent } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture_deadline')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(model?: ModelAdapter, extensions: readonly Extension[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'kite-client-cancel-'));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'fixture' });
  const selected = resolveProfile({ dataRoot, profile: 'fixture' });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'fixture',
    accessKey: selected.profileAccessKey,
  };
  const runtime = createRuntime({
    store,
    model,
    extensions,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile,
    buildId: 'cancellation-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile,
      apiMajor: 1,
      requiredCapabilities: ['commands'],
      buildId: 'cancellation-fixture',
    },
    bootstrap: service.bootstrap,
  });
  const info = await client.connect();
  const expectedStoreId = info.storeId!;
  await client.createWorkspace({
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'fixture',
    expectedStoreId,
  });
  await client.createSession({
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create-session',
    title: 'fixture',
    expectedStoreId,
  });
  return {
    client,
    runtime,
    expectedStoreId,
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const domain of ['run', 'execution', 'session'] as const)
  test(`real Service Client ${domain} cancel preserves intent and receipt precedes adapter stop`, async () => {
    const entered = gate();
    const release = gate();
    let calls = 0;
    let signal!: AbortSignal;
    const f = await fixture({
      async *stream(_request, options) {
        calls++;
        signal = options.signal;
        entered.resolve();
        await release.promise;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    });
    try {
      await f.client.startRun('s', {
        expectedStoreId: f.expectedStoreId,
        commandId: 'run-intent',
        kind: 'run.start',
        content: 'local fixture',
      });
      await bounded(entered.promise);
      const view = await f.client.getView('s');
      const run = view.runs[0]!;
      const execution = view.executions.find((item) => item.kind === 'model')!;
      expect(run.status).toBe('running');
      expect(execution.status).toBe('dispatching');
      const original = { expectedStoreId: f.expectedStoreId, commandId: `cancel-${domain}` };
      const invoke = (expectedStoreId: string, commandId: string) =>
        domain === 'run'
          ? f.client.cancelRun('s', {
              expectedStoreId,
              commandId,
              kind: 'run.cancel',
              runId: run.id,
            })
          : domain === 'execution'
            ? f.client.cancelExecution('s', {
                expectedStoreId,
                commandId,
                kind: 'execution.cancel',
                executionId: execution.id,
              })
            : f.client.cancelSession('s', {
                expectedStoreId,
                commandId,
                kind: 'session.cancel',
                includeBackground: false,
              });
      for (let i = 0; i < 2; i++)
        await expect(invoke('previous-store', 'stale-cancel')).rejects.toMatchObject({
          code: 'store_identity_mismatch',
        });
      expect(signal.aborted).toBe(false);
      await expect(f.client.getCommand('stale-cancel')).rejects.toMatchObject({
        code: 'command_not_found',
      });
      const receipt = await invoke(original.expectedStoreId, original.commandId);
      expect(receipt.id).toBe(original.commandId);
      expect(receipt.originStoreId).toBe(original.expectedStoreId);
      expect(receipt.kind).toBe(`${domain}.cancel`);
      expect(signal.aborted).toBe(true);
      // Adapter remains physically blocked: command receipt alone is not a stop proof.
      expect((await f.client.getExecution(execution.id)).status).toBe('dispatching');
      expect((await f.client.getExecution(execution.id)).cancelRequestedAt).not.toBeNull();
      expect(await invoke(original.expectedStoreId, original.commandId)).toEqual(receipt);
      expect(calls).toBe(1);
      release.resolve();
      await f.runtime.waitForCommand('run-intent', { timeoutMs: 5000 });
      expect((await f.client.getExecution(execution.id)).status).toBe('cancelled');
      expect((await f.client.getRun(run.id)).isActive).toBe(false);
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await f.close();
    }
  });

test('real Service Client reads explicit Job output gap without advancing SSE acknowledgement', async () => {
  const ended = gate();
  let executionId = '';
  const extension = defineExtension({
    id: 'fixture.output',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'fixture.output-job',
        version: '1',
        description: 'local output fixture',
        inputSchema: {},
        async start(_input, context) {
          executionId = context.executionId;
          return { reference: {} };
        },
        async *observe(): AsyncIterable<JobEvent> {
          yield { type: 'output', stream: 'stdout', content: 'first' };
          yield { type: 'output_dropped', stream: 'stderr', bytes: '9007199254740993' };
          yield { type: 'output', stream: 'stderr', content: 'last' };
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'done' },
          };
        },
        async cancel() {
          return { status: 'already_finished' };
        },
        async dispose() {
          ended.resolve();
        },
      },
    ],
    actions: [
      {
        id: 'fixture.output-launch',
        version: '1',
        description: 'start output fixture',
        inputSchema: {},
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'output',
            request: {
              kind: 'job',
              definitionId: 'fixture.output-job',
              definitionVersion: '1',
              input: {},
            },
          });
          return {
            outcome: 'succeeded',
            content: 'Output fixture started',
            details: { executionId: ref.executionId! },
          };
        },
      },
    ],
  });
  const f = await fixture(undefined, [extension]);
  try {
    await f.client.invokeExtension('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'output-launch',
      kind: 'extension.invoke',
      extensionId: extension.id,
      actionId: 'fixture.output-launch',
      definitionVersion: '1',
      input: {},
    });
    await bounded(ended.promise);
    const page = await f.client.listExecutionOutput(executionId, { limit: 200 });
    expect(page.highWaterSeq).toBe('3');
    expect(page.items.map((item) => item.content)).toEqual(['first', '']);
    expect(page.items[1]).toMatchObject({
      seq: '2',
      throughSeq: '3',
      stream: 'stderr',
      droppedBytes: '9007199254740997',
    });
    expect(
      (await f.client.listExecutionOutput(executionId, { afterSeq: '1', upperSeq: '2' })).items,
    ).toEqual([{ ...page.items[1]!, throughSeq: '2', droppedBytes: null }]);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    expect((await f.client.getExecution(executionId)).status).toBe('succeeded');
  } finally {
    await f.close();
  }
});
