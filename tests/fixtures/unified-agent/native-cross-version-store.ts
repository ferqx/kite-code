import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, openSqliteStore } from '@kite-ai/agent/sqlite';
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
    const access = acquireProfileAccess({ dataRoot: profile.dataRoot, profile: profile.profile });
    let database: Database | undefined;
    let persistedExecutions: { id: string; rowJson: string; rowBytes: number; rowSha256: string }[];
    let persistedMessages: {
      id: string;
      sourceJson: string;
      sourceBytes: number;
      sourceSha256: string;
    }[];
    try {
      database = new Database(
        access.databasePath,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
      );
      database.run('PRAGMA query_only=ON');
      persistedExecutions = (
        database
          .query('SELECT * FROM execution WHERE session_id=? ORDER BY id')
          .all(sessionId) as Record<string, unknown>[]
      ).map((row) => {
        const rowJson = JSON.stringify(row);
        return {
          id: String(row.id),
          rowJson,
          rowBytes: Buffer.byteLength(rowJson),
          rowSha256: createHash('sha256').update(rowJson).digest('hex'),
        };
      });
      persistedMessages = (
        database
          .query('SELECT id, source_json FROM message WHERE session_id=? ORDER BY seq')
          .all(sessionId) as { id: string; source_json: string }[]
      ).map((row) => ({
        id: row.id,
        sourceJson: row.source_json,
        sourceBytes: Buffer.byteLength(row.source_json),
        sourceSha256: createHash('sha256').update(row.source_json).digest('hex'),
      }));
    } finally {
      try {
        database?.close();
      } finally {
        access.lock.release();
      }
    }
    const view = await store.getView(sessionId),
      messages = await store.listMessages(sessionId),
      executions = await store.listExecutions(sessionId),
      commands = await Promise.all(view.runs.map((run) => store.getCommand(run.originCommandId))),
      humanInputs = await Promise.all(
        view.runs.map(async (run) => {
          const publicCommand = await store.getCommand(run.rootWorkCommandId);
          const receipt = publicCommand?.receipt as {
            humanInputCommandId?: string;
            decisionCommandId?: string;
            businessCommandId?: string;
          } | null;
          return {
            publicCommand,
            input: receipt?.humanInputCommandId
              ? await store.getCommand(receipt.humanInputCommandId)
              : null,
            decision: receipt?.decisionCommandId
              ? await store.getCommand(receipt.decisionCommandId)
              : null,
            business: receipt?.businessCommandId
              ? await store.getCommand(receipt.businessCommandId)
              : null,
          };
        }),
      ),
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
      extensionCommands = await Promise.all(
        [
          ...new Set(
            executions
              .filter(
                (item) =>
                  item.kind === 'job' &&
                  item.definitionId === 'fixture.mini-review/fixture.mini-review.analyze',
              )
              .map((item) => item.originCommandId),
          ),
        ].map((id) => store.getCommand(id)),
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
        // An older decoder omits later optional fields. Restore only actual raw
        // persisted fields; retain the entire original JSON separately as proof.
        messages: messages.map((message) => {
          const persisted = persistedMessages.find((row) => row.id === message.id);
          if (!persisted) throw Error('native_version_message_source_missing');
          const source = JSON.parse(persisted.sourceJson) as Record<string, unknown>;
          for (const [key, value] of Object.entries(source)) {
            if (
              Object.hasOwn(message, key) &&
              !isDeepStrictEqual(value, (message as unknown as Record<string, unknown>)[key])
            )
              throw Error('native_version_message_source_mismatch');
          }
          return { ...source, ...message };
        }),
        persistedMessages,
        executions: executions.map((execution) => {
          const persisted = persistedExecutions.find((row) => row.id === execution.id);
          if (!persisted) throw Error('native_version_execution_source_missing');
          const row = JSON.parse(persisted.rowJson) as Record<string, unknown>;
          if (!['tool', 'job'].includes(execution.kind)) return execution;
          if (row.dispatched !== 0 && row.dispatched !== 1)
            throw Error('native_version_dispatch_source_invalid');
          const dispatched = row.dispatched === 1;
          if (execution.authorization && execution.authorization.dispatched !== dispatched)
            throw Error('native_version_dispatch_source_mismatch');
          // This is an observed durable flag, not an approval or reviewer claim.
          return execution.authorization
            ? execution
            : { ...execution, authorization: { dispatched } };
        }),
        persistedExecutions,
        commands,
        humanInputs,
        outputs,
        extensionCommands,
      }),
    );
  }
} finally {
  await store.close();
}
