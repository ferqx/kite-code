import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDeferred, extensionId, waitFile } from './index';

const [root, mode, nodePath, workerPath] = process.argv.slice(2);
if (!root || !mode || !nodePath || !workerPath) throw Error('host_arguments_invalid');
const external = join(root, 'external');
mkdirSync(external, { recursive: true });
const cold = mode === 'cold';
const original = await openSqliteStore({
  dataRoot: join(root, 'data'),
  profile: 'new',
  ...(cold ? { mode: 'readonly' as const } : {}),
});
const storeId = (await original.getMetadata()).storeId;
const sample = createDeferred({ root: external, nodePath, workerPath, mode });
// Transparent public Store decorator: the underlying real SQL transaction has
// committed, but this producer has not received its completion/settlement response.
const store: Store =
  mode === 'terminal'
    ? new Proxy(original, {
        get(target, key) {
          if (key === 'finishExecution')
            return async (...args: Parameters<Store['finishExecution']>) => {
              const result = await target.finishExecution(...args);
              if (result.definitionId === `${extensionId}.work`) {
                writeFileSync(
                  join(external, 'barrier.json'),
                  JSON.stringify({ window: 'terminal', executionId: result.id }),
                );
                await waitFile(join(external, 'continue'));
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : original;
const artifacts = createArtifactStore({
  profile: { dataRoot: join(root, 'data'), profile: 'new' },
  store,
});
const runtime = createRuntime({
  store,
  artifacts,
  extensions: [sample.extension],
  authorizeJobReconcile: async () => ({ allowed: true, revision: 'explicit-fixture-reconcile' }),
  permissions: {
    authorize: async (request) => ({
      allowed: false,
      revision: 'independent-original-ask',
      approval: { request: { title: `Approve ${request.definitionId}`, input: request.input } },
    }),
  },
});
const paths = resolveProfile({ dataRoot: join(root, 'data'), profile: 'new' });
const service = await startService({
  runtime,
  profile: { dataRoot: join(root, 'data'), name: 'new', accessKey: paths.profileAccessKey },
  subjectId: 'owner',
  buildId: 'deferred-built',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    apiMajor: 1,
    profile: service.bootstrap.profile,
    requiredCapabilities: [
      'commands',
      'extension_queries',
      'extensions_actions',
      'interactions',
      'job_reconcile',
      'session_recovery',
    ],
  },
});
const approvals: string[] = [];
await client.connect();
const ledger = () =>
  existsSync(join(external, 'ledger')) ? readFileSync(join(external, 'ledger'), 'utf8') : '';
const snapshot = async () => ({
  storeId,
  session: await original.getSession('s'),
  views: await client.queryExtension('s', extensionId, 'result', {}),
  executions: (await original.getView('s')).executions,
  metadata: await original.getMetadata(),
  ledger: ledger(),
  stats: sample.stats(),
  producerDisposals: sample.disposals(),
  approvals,
});
if (mode === 'cold') {
  const before = await snapshot(),
    after = await snapshot();
  console.log(JSON.stringify({ before, after }));
  client.disposeNetwork();
  await service.close();
  await artifacts.close();
  await original.close();
} else if (mode === 'recover' || mode === 'recover-fresh') {
  const prior = JSON.parse(readFileSync(join(root, 'killed.json'), 'utf8'));
  const recovery = await client.recoverSession('s', {
    expectedStoreId: storeId,
    commandId: 'recover',
    kind: 'session.recover',
    decision: 'interrupt',
  });
  const executionId = prior.views[0].payload.execution.id;
  const sdkBefore = await client.getExecution(executionId);
  const before = (await original.getExecution(executionId))!;
  const attempt = async () => {
    try {
      return await client.reconcileJob('s', {
        expectedStoreId: storeId,
        commandId: mode === 'recover-fresh' ? 'reconcile-fresh' : 'reconcile',
        kind: 'job.reconcile',
        executionId,
        expectedResultRevision: sdkBefore.resultRevision,
      });
    } catch (error) {
      return { rejected: (error as { code?: string }).code };
    }
  };
  const reconcile = await attempt(),
    duplicate = await attempt();
  console.log(
    JSON.stringify({ recovery, before, sdkBefore, reconcile, duplicate, after: await snapshot() }),
  );
  client.disposeNetwork();
  await service.close();
  await artifacts.close();
  await original.close();
} else {
  await original.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'Owned deferred',
  });
  await original.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Deferred',
  });
  await client.invokeExtension('s', {
    expectedStoreId: storeId,
    commandId: 'launch',
    kind: 'extension.invoke',
    extensionId,
    actionId: 'launch',
    definitionVersion: '1',
    input: { payload: 'deferred完整正文\r\n'.repeat(5000) },
  });
  const deadline = Date.now() + 10000;
  let cancelled = false;
  for (;;) {
    for (const card of (
      await client.listInteractions('s', { storeId, state: 'pending', limit: 100 })
    ).interactions) {
      approvals.push(card.definitionId);
      await client.answerInteraction('s', card.id, {
        expectedStoreId: storeId,
        commandId: `approve-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
    }
    const snap = await snapshot();
    const views = snap.views;
    const execution = views[0]?.payload as
      | { execution?: { id: string; status: string; reference?: unknown; originCommandId: string } }
      | undefined;
    if (
      mode === 'terminal' &&
      existsSync(join(external, 'started.json')) &&
      !existsSync(join(external, 'release'))
    )
      writeFileSync(join(external, 'release'), 'complete');
    if (
      (mode === 'confirmed' || mode === 'requested') &&
      execution?.execution?.status === 'running' &&
      !cancelled
    ) {
      cancelled = true;
      await client.cancelCommand('s', {
        expectedStoreId: storeId,
        commandId: 'cancel-original',
        kind: 'command.cancel',
        targetCommandId: execution.execution.originCommandId,
      });
    }
    if (
      mode === 'running' &&
      execution?.execution?.status === 'running' &&
      !existsSync(join(external, 'barrier.json'))
    )
      writeFileSync(
        join(external, 'barrier.json'),
        JSON.stringify({ window: 'running', executionId: execution.execution.id }),
      );
    const barrier = existsSync(join(external, 'barrier.json'));
    if (
      (barrier && views.length > 0) ||
      (cancelled && ['cancelled', 'outcome_unknown'].includes(execution?.execution?.status ?? ''))
    ) {
      writeFileSync(
        join(root, 'ready.json'),
        JSON.stringify({
          ...(barrier ? await snapshot() : snap),
          window: barrier
            ? JSON.parse(readFileSync(join(external, 'barrier.json'), 'utf8'))
            : { window: mode },
        }),
      );
      await waitFile(join(external, 'finish-host'));
      break;
    }
    if (Date.now() > deadline) throw Error('host_window_deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  client.disposeNetwork();
  await service.close();
  await artifacts.close();
  await original.close();
}
