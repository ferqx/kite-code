import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { getLoadedSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { createClient } from '@kite-ai/client';
import { requestDaemonBootstrap, selectDaemonEndpoint } from '@kite-ai/service/daemon';

// Compiled outside the checkout, with bare imports resolved only in the active candidate.
const [dataRoot, socket, sessionId, commandJSON, expectedBuildId] = process.argv.slice(2);
if (!dataRoot || !socket || !sessionId || !commandJSON || !expectedBuildId)
  throw Error('terminal_version_reader_arguments');
const commands: string[] = JSON.parse(commandJSON);
const profile = selectProfile({ dataRoot, profile: 'default' });
const selected = {
  dataRoot: profile.dataRoot,
  name: profile.profile,
  accessKey: profile.profileAccessKey,
};
const endpoint = selectDaemonEndpoint({
  profileAccessKey: profile.profileAccessKey,
  explicitSocket: socket,
});
const bootstrap = await requestDaemonBootstrap(endpoint, selected);
const client = createClient({
  endpoint: bootstrap.httpEndpoint,
  token: bootstrap.token,
  expected: {
    profile: selected,
    apiMajor: 1,
    instanceId: bootstrap.instanceId,
    buildId: expectedBuildId,
    requiredCapabilities: ['sessions', 'history', 'model_outputs'],
  },
});
const reader = await openSqliteStore({ dataRoot, profile: 'default', mode: 'readonly' });
try {
  const before = await reader.getMetadata();
  const server = await client.connect();
  const view = await client.getView(sessionId);
  const messages = await client.listMessages(sessionId);
  const receipts = await Promise.all(commands.map((id) => client.getCommand(id)));
  const outputs = [];
  for (const execution of view.executions.filter((value) => value.kind === 'model'))
    outputs.push(await client.getModelOutput(sessionId, execution.id));
  const after = await reader.getMetadata();
  if (before.storeId !== after.storeId || before.lastChangeCursor !== after.lastChangeCursor)
    throw Error('terminal_version_read_changed_store');
  if (server.storeId !== before.storeId || view.storeId !== before.storeId)
    throw Error('terminal_version_reader_store_mismatch');
  console.log(
    JSON.stringify({
      server,
      process: {
        pid: bootstrap.pid,
        startIdentity: bootstrap.processStartIdentity,
        instanceId: bootstrap.instanceId,
        buildId: bootstrap.buildId,
      },
      store: { storeId: before.storeId, cursor: before.lastChangeCursor },
      engine: getLoadedSqliteEngine(),
      view,
      messages,
      receipts,
      outputs,
    }),
  );
} finally {
  client.disposeNetwork();
  await reader.close();
}
