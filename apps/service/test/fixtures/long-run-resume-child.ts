import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { ledgerLines, longRunRuntime, toolCount } from './long-run-resume-binding';

const [root] = process.argv.slice(2) as [string];
const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
const ledger = join(root, 'ledger');
const store = await openSqliteStore(profile);
const storeId = (await store.getMetadata()).storeId;
const plannedModels = new Set<string>();
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'planExecution')
      return async (input: Parameters<Store['planExecution']>[0]) => {
        const execution = await store.planExecution(input);
        if (execution.kind === 'model') plannedModels.add(execution.id);
        return execution;
      };
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        if (!plannedModels.has(input.executionId)) return store.markDispatching(input);
        const execution = await store.getExecution(input.executionId);
        if (
          execution?.kind === 'model' &&
          ledgerLines(ledger).filter((v) => v.startsWith('tool:')).length === toolCount
        ) {
          writeFileSync(
            join(root, 'ready.tmp'),
            JSON.stringify({ storeId, runId: execution.runId, execution }),
          );
          renameSync(join(root, 'ready.tmp'), join(root, 'ready.json'));
          await new Promise<void>(() => {});
        }
        if (execution?.kind === 'model') appendFileSync(ledger, `dispatch:${execution.id}\n`);
        return store.markDispatching(input);
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = longRunRuntime({
  store: wrapped,
  profile,
  ledger,
  workspace: join(root, 'workspace'),
});
let service: Awaited<ReturnType<typeof startService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let first: unknown;
try {
  service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
    subjectId: 'owner',
    buildId: 'long-resume',
  });
  client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      instanceId: service.bootstrap.instanceId,
      buildId: service.bootstrap.buildId,
      requiredCapabilities: ['commands', 'run_resume'],
    },
  });
  await client.connect();
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${join(root, 'workspace')}`,
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Long original',
  });
  await client.startRun('s', {
    expectedStoreId: storeId,
    commandId: 'work',
    kind: 'run.start',
    content: 'Continue the original long task and preserve all original effects.',
  });
  await new Promise<void>(() => {});
} catch (error) {
  first = error;
}
const failures: unknown[] = first ? [first] : [];
client?.disposeNetwork();
for (const close of [() => service?.close(), () => runtime.close()])
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
if (!failures.length)
  try {
    await store.close();
  } catch (error) {
    failures.push(error);
  }
if (failures.length) throw new AggregateError(failures, 'long_run_hot_failed');
