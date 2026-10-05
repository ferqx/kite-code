import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { createLedgerExtension } from './job-reconcile-fixture';

const directory = process.argv[2]!;
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile, store }),
  extensions: [createLedgerExtension(join(directory, 'external-ledger.json'), { hold: true })],
  permissions: {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  },
  modelId: 'fixed',
  model: createFixedModel([
    [
      { type: 'tool_call', id: 'launch', name: 'ledger.launch', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  rootUri: `file://${directory}`,
  name: 'crash ledger',
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'create',
  workspaceId: 'w',
  title: 'crash ledger',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'work',
  request: { kind: 'run.start', content: 'one external effect' },
});
await runtime.waitForCommand('work');
const deadline = Date.now() + 4000;
for (;;) {
  const execution = (await store.getView('s')).executions.find((e) => e.kind === 'job');
  if (execution?.status === 'running' && execution.reference && execution.recoveryManifest) {
    writeFileSync(
      join(directory, 'ready.tmp'),
      JSON.stringify({ expectedStoreId, executionId: execution.id }),
    );
    renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
    break;
  }
  if (Date.now() > deadline) throw Error('crash_job_not_running');
  await Bun.sleep(5);
}
// The parent kills this actual Runtime while it owns the dispatched Job and profile.
await new Promise<void>(() => {});
