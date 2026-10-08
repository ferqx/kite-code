import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { getLoadedSqliteEngine } from '@kite-ai/agent/sqlite-engine';

// Compiled outside the checkout; every bare import resolves in the selected installed inner.
const [operation, dataRoot, workspace, sessionId] = process.argv.slice(2);
if (!['seed', 'snapshot'].includes(operation!) || !dataRoot || !workspace || !sessionId)
  throw Error('native_version_store_arguments');
const profile = selectProfile({ dataRoot, profile: 'default' });
const store = await openSqliteStore({
  dataRoot: profile.dataRoot,
  profile: profile.profile,
  ...(operation === 'snapshot' ? { mode: 'readonly' as const } : {}),
});
try {
  const before = await store.getMetadata();
  if (operation === 'seed') {
    await store.createWorkspace({
      expectedStoreId: before.storeId,
      id: 'native-version-workspace',
      name: 'Native versions',
      rootUri: pathToFileURL(workspace).href,
    });
    await store.createSession({
      expectedStoreId: before.storeId,
      subjectId: 'local-user',
      commandId: 'native-version-create',
      sessionId,
      workspaceId: 'native-version-workspace',
      title: 'Native real versions',
    });
    if (process.platform === 'darwin')
      await store.createWorkspace({
        expectedStoreId: before.storeId,
        id: 'db8-removal-workspace',
        name: 'DB8 rollback witness',
        rootUri: pathToFileURL(`${workspace}-db8`).href,
      });
    console.log(JSON.stringify({ storeId: before.storeId, engine: getLoadedSqliteEngine() }));
  } else {
    const view = await store.getView(sessionId),
      messages = await store.listMessages(sessionId),
      executions = await store.listExecutions(sessionId),
      commands = await Promise.all(view.runs.map((run) => store.getCommand(run.originCommandId))),
      outputs = await Promise.all(
        executions
          .filter((item) => item.kind === 'model')
          .map((execution) =>
            store.getModelOutputSnapshot({
              expectedStoreId: before.storeId,
              sessionId,
              subjectId: 'local-user',
              executionId: execution.id,
            }),
          ),
      ),
      after = await store.getMetadata();
    if (before.storeId !== after.storeId || before.lastChangeCursor !== after.lastChangeCursor)
      throw Error('native_version_read_changed_store');
    console.log(
      JSON.stringify({
        storeId: before.storeId,
        cursor: before.lastChangeCursor,
        engine: getLoadedSqliteEngine(),
        session: view.session,
        runs: view.runs,
        messages,
        executions,
        commands,
        outputs,
      }),
    );
  }
} finally {
  await store.close();
}
