import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import type { AssertionReceipt } from '../../../../scripts/runtime/unified-soak-cases';
export function check(
  receipts: AssertionReceipt[],
  id: string,
  actual: string | number | boolean,
  expected: string | number | boolean,
) {
  const passed = actual === expected;
  receipts.push({ id, actual, expected, passed });
  if (!passed) throw Error(`assertion_failed:${id}`);
}
export async function until<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const end = performance.now() + 180000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (performance.now() > end) throw Error('operation_deadline');
    await Bun.sleep(10);
  }
}
export async function fixture(
  root: string,
  options: Omit<RuntimeOptions, 'store' | 'permissions'> &
    Pick<Partial<RuntimeOptions>, 'permissions'>,
) {
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'soak' });
  const storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({
    profile: { dataRoot: join(root, 'data'), profile: 'soak' },
    store,
  });
  const runtime = createRuntime({
    artifacts,
    ...options,
    store,
    permissions: options.permissions ?? {
      async authorize() {
        return { allowed: true, revision: 'owned-soak' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: join(root, 'data'), name: 'soak', accessKey: 'owned-soak' },
    subjectId: 'soak',
    buildId: 'unified-soak',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      buildId: service.bootstrap.buildId,
      instanceId: service.bootstrap.instanceId,
      requiredCapabilities: ['sessions', 'commands'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: new URL(`file://${root}/`).href,
    name: 'owned',
  });
  const session = async (id: string = randomUUID()) => {
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      title: 'owned',
    });
    return id;
  };
  const start = async (sessionId: string, content: string) => {
    const commandId = randomUUID();
    await client.startRun(sessionId, {
      expectedStoreId: storeId,
      kind: 'run.start',
      commandId,
      content,
    });
    const cmd = await until(
      () => client.getCommand(commandId),
      (v) => v?.status === 'applied',
    );
    const runId = (cmd!.receipt as { runId: string }).runId;
    return { commandId, runId };
  };
  return {
    store,
    runtime,
    service,
    client,
    storeId,
    session,
    start,
    async finish(runId: string) {
      return until(
        () => client.getRun(runId),
        (v) => !!v && !v.isActive,
      );
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await artifacts.close();
      await store.close();
    },
  };
}
