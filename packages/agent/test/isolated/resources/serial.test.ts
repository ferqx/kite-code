import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { ExecutionResources } from '../../../src/execution/resources';
import type { ResourceRequest } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call: ModelEvent[] = [
  { type: 'tool_call', id: 'serial-call', name: 'fixture.serial', arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];

test('ordinary serial Tool completion and cancellation preserve original cold results and release idle keys without breaking handoff', async () => {
  const root = mkdtempSync('/private/tmp/kite-serial-resource-');
  let ownedStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let ownedRuntime: ReturnType<typeof createRuntime> | undefined;
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  const manual = new AbortController();
  const permits: (() => void)[] = [];
  const pending: Promise<() => void>[] = [];
  const failures: unknown[] = [];
  try {
    const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
    ownedStore = store;
    const model = createFixedModel([call, [finish], call]);
    const entered = gate();
    const body = '原完整结果🙂'.repeat(2048);
    let toolCalls = 0;
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'serial' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.serial',
              version: '1',
              description: 'original serial tool',
              inputSchema: { type: 'object', additionalProperties: false },
              resources: { serial: { scope: 'session', key: 'ordinary' }, slot: 'process' },
              async execute(_input, context) {
                toolCalls++;
                if (toolCalls === 2) {
                  entered.release();
                  await new Promise<void>((_resolve, reject) => {
                    if (context.signal.aborted) reject(context.signal.reason);
                    else
                      context.signal.addEventListener(
                        'abort',
                        () => reject(context.signal.reason),
                        {
                          once: true,
                        },
                      );
                  });
                }
                return { outcome: 'succeeded', content: body };
              },
            },
          ],
        },
      ],
    });
    ownedRuntime = runtime;
    const resources = Reflect.get(
      Reflect.get(Reflect.get(runtime, 'execution'), 'options'),
      'resources',
    ) as ExecutionResources;
    const serial = Reflect.get(resources, 'serial') as Map<string, unknown>;
    const storeId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'original',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'original',
    });
    const submit = (commandId: string) =>
      runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 's',
        commandId,
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      });
    await submit('complete');
    await runtime.waitForCommand('complete');
    const completed = (await store.getView('s')).executions.find((row) => row.kind === 'tool')!;
    expect(completed.status).toBe('succeeded');
    expect(completed.result).toMatchObject({ content: body });
    await submit('cancelled');
    await entered.promise;
    await runtime.cancelCommand({
      expectedStoreId: storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel',
      targetCommandId: 'cancelled',
    });
    await runtime.waitForCommand('cancelled');
    expect(
      (await store.getView('s')).executions
        .filter((row) => row.kind === 'tool')
        .map((row) => row.status),
    ).toContain('outcome_unknown');

    // Exercise the same Runtime owner, including a queued cancellation and reserved handoff.
    const scope = { sessionId: 's', workspaceId: 'w' };
    const request = {
      serial: { scope: 'runtime' as const, key: 'handoff' },
      slot: 'process' as const,
    };
    const signal = manual.signal;
    const acquire = (request: ResourceRequest, selectedSignal = signal) => {
      const task = resources
        .acquire(request, scope, AbortSignal.any([signal, selectedSignal]))
        .then((release) => {
          permits.push(release);
          return release;
        });
      pending.push(task);
      void task.catch(() => {});
      return task;
    };
    const held = await acquire(request);
    const cancelled = new AbortController();
    const waiting = acquire(request, cancelled.signal).catch((error: unknown) => error);
    const reason = Error('original queued cancellation');
    cancelled.abort(reason);
    expect(await waiting).toBe(reason);
    let admitted = false;
    const next = acquire(request).then((release) => {
      admitted = true;
      return release;
    });
    void next.catch(() => {});
    const other = await acquire({ serial: { scope: 'runtime', key: 'independent' } });
    expect(admitted).toBe(false);
    other();
    held();
    const handoff = await next;
    let thirdAdmitted = false;
    const third = acquire(request).then((release) => {
      thirdAdmitted = true;
      return release;
    });
    void third.catch(() => {});
    held();
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    handoff();
    (await third)();
    const fresh = await acquire(request);
    held();
    expect(serial.has('runtime::handoff')).toBe(true);
    fresh();
    const aborted = new AbortController();
    aborted.abort(reason);
    expect(
      await acquire({ serial: { scope: 'session', key: 'aborted' } }, aborted.signal).catch(
        (error: unknown) => error,
      ),
    ).toBe(reason);
    const original = await store.getView('s');
    const metadata = await store.getMetadata();
    expect(toolCalls).toBe(2);
    expect(model.requests).toHaveLength(3);
    expect(serial.size).toBe(0);
    await runtime.close();
    cold = await openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' });
    expect(await cold.getMetadata()).toEqual(metadata);
    expect(await cold.getView('s')).toEqual(original);
    expect(model.requests).toHaveLength(3);
  } catch (error) {
    failures.push(error);
  } finally {
    manual.abort(Error('manual fixture cleanup'));
    await Promise.allSettled(pending);
    for (const release of permits.reverse()) release();
    for (const close of [
      () => ownedRuntime?.close(),
      () => ownedStore?.close(),
      () => cold?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'serial fixture cleanup failed');
});
