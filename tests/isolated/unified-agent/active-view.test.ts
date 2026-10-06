import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension, type JobEvent } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createDesktopController } from '../../../apps/desktop/src';
import { startService } from '../../../apps/service/src';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('active_view_fixture_deadline')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('public view keeps the current Run and an old live Job after 205 real completed turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-active-view-')),
    dataRoot = join(root, 'data'),
    profileOptions = { dataRoot, profile: 'disposable' },
    store = await openSqliteStore(profileOptions),
    modelEntered = barrier(),
    modelRelease = barrier(),
    jobEntered = barrier(),
    jobRelease = barrier();
  let calls = 0,
    jobStarts = 0,
    oldJob = '',
    currentSignal: AbortSignal | undefined;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      calls++;
      if (calls === 206) {
        currentSignal = signal;
        modelEntered.release();
        await modelRelease.promise;
      }
      signal.throwIfAborted();
      yield { type: 'text_delta', text: `completed turn ${calls}` };
      yield finish;
    },
  };
  const extension = defineExtension({
    id: 'fixture.active-view',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'fixture.active-view-job',
        version: '1',
        description: 'one independently held local Job',
        inputSchema: {},
        async start(_input, context) {
          jobStarts++;
          oldJob = context.executionId;
          return { reference: {} };
        },
        async *observe(): AsyncIterable<JobEvent> {
          jobEntered.release();
          await jobRelease.promise;
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'held Job ended' },
          };
        },
        async cancel() {
          jobRelease.release();
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
    actions: [
      {
        id: 'fixture.active-view-launch',
        version: '1',
        description: 'start the original detached Job',
        inputSchema: {},
        async prepare(input) {
          return input;
        },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'old-job',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.active-view-job',
              definitionVersion: '1',
              input: {},
            },
          });
          return { outcome: 'succeeded', content: ref.executionId! };
        },
      },
    ],
  });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
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
    accessKey: resolveProfile(profileOptions).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'active-view-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile,
      buildId: 'active-view-fixture',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands'],
    },
  });
  let controller: ReturnType<typeof createDesktopController> | undefined;
  try {
    const storeId = (await client.connect()).storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'long-lived conversation',
    });
    await client.invokeExtension('s', {
      expectedStoreId: storeId,
      commandId: 'launch-old-job',
      kind: 'extension.invoke',
      extensionId: extension.id,
      actionId: 'fixture.active-view-launch',
      definitionVersion: '1',
      input: {},
    });
    await bounded(jobEntered.promise);
    await runtime.waitForCommand('launch-old-job', { timeoutMs: 5000 });
    let firstRun = '';
    for (let i = 0; i < 205; i++) {
      const commandId = `history-${i}`;
      await client.startRun('s', {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content: `complete real turn ${i}`,
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const runId = (command.receipt as { runId: string }).runId;
      expect((await client.getRun(runId)).status).toBe('completed');
      if (i === 0) firstRun = runId;
    }
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'active-late',
      kind: 'run.start',
      content: 'hold the current real model request',
    });
    await bounded(modelEntered.promise);
    const original = await client.getCommand('active-late'),
      runId = (original.receipt as { runId: string }).runId,
      before = await store.getMetadata(),
      view = await client.getView('s');
    expect(view.runs.find((run) => run.isActive)?.id).toBe(runId);
    expect(view.runs).toHaveLength(200);
    expect(view.runs[0]?.originCommandId).toBe('history-6');
    expect(view.runs.at(-1)?.originCommandId).toBe('active-late');
    expect(view.runs.some((run) => run.id === firstRun)).toBe(false);
    expect((await client.getRun(firstRun)).status).toBe('completed');
    expect(view.executions).toHaveLength(201);
    expect(view.executions[0]).toMatchObject({ id: oldJob, kind: 'job', status: 'running' });
    expect(view.executions.filter((item) => item.id === oldJob)).toHaveLength(1);
    expect(view.executions.at(-1)).toMatchObject({ kind: 'model', runId, status: 'dispatching' });
    controller = createDesktopController({ admittedClient: client, onSnapshot() {} });
    await controller.selectSession('s');
    expect(controller.snapshot?.view.runs.find((run) => run.isActive)?.id).toBe(runId);
    expect(controller.snapshot?.view.executions.some((item) => item.id === oldJob)).toBe(true);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    expect(client.lastAppliedCursor).toBeUndefined();
    expect(calls).toBe(206);
    expect(jobStarts).toBe(1);
    await client.cancelRun('s', {
      expectedStoreId: storeId,
      commandId: 'stop-current',
      kind: 'run.cancel',
      runId,
    });
    expect(currentSignal?.aborted).toBe(true);
    modelRelease.release();
    await runtime.waitForCommand('active-late', { timeoutMs: 5000 });
    expect((await client.getRun(runId)).status).toBe('cancelled');
    expect((await client.getExecution(oldJob)).status).toBe('running');
    expect(calls).toBe(206);
    expect(jobStarts).toBe(1);
  } finally {
    modelRelease.release();
    jobRelease.release();
    controller?.disposeNetwork();
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
