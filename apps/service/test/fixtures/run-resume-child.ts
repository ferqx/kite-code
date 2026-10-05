import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createResumeRuntime } from './run-resume-binding';

const [dataRoot, ledger] = process.argv.slice(2) as [string, string];
const profile = { dataRoot, profile: 'owned' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const runtime = createResumeRuntime({ store, profile, ledger });
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: `file://${dataRoot}`,
});
await runtime.createSession({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  title: 'Original',
});
await runtime.submitCommand({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'work',
  sessionId: 's',
  request: { kind: 'run.start', content: 'Approve an exact original effect' },
});
const deadline = Date.now() + 5000;
for (;;) {
  const view = await runtime.getView('s');
  const pending = await runtime.listInteractions({
    expectedStoreId,
    sessionId: 's',
    state: 'pending',
  });
  if (pending.interactions.length) {
    const run = view.runs.find((value) => value.isActive)!;
    const interaction = pending.interactions[0]!;
    console.log(
      JSON.stringify({
        storeId: expectedStoreId,
        runId: run.id,
        interaction,
      }),
    );
    break;
  }
  if (Date.now() > deadline) throw Error('run_resume_child_pending_timeout');
  await Bun.sleep(1);
}
setInterval(() => {}, 1000);
