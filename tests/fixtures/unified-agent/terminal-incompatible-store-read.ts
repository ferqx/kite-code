import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { requestDaemonBootstrap, selectDaemonEndpoint } from '@kite-ai/service/daemon';

// Compiled outside the checkout; imports resolve only in the actual legacy candidate.
const [dataRoot, socket, sessionId, buildId] = process.argv.slice(2);
if (!dataRoot || !socket || !sessionId || !buildId)
  throw Error('terminal_incompatible_reader_arguments');
const profile = selectProfile({ dataRoot, profile: 'default' });
let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
let rejected = false;
try {
  store = await openSqliteStore({ dataRoot, profile: 'default', mode: 'readonly' });
} catch (error) {
  if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'store_incompatible') throw error;
  rejected = true;
} finally {
  await store?.close();
}
if (!rejected) throw Error('terminal_legacy_store_was_not_rejected');
const selected = {
  dataRoot: profile.dataRoot,
  name: profile.profile,
  accessKey: profile.profileAccessKey,
};
const bootstrap = await requestDaemonBootstrap(
  selectDaemonEndpoint({ profileAccessKey: profile.profileAccessKey, explicitSocket: socket }),
  selected,
);
const client = createClient({
  endpoint: bootstrap.httpEndpoint,
  token: bootstrap.token,
  expected: {
    profile: selected,
    apiMajor: 1,
    instanceId: bootstrap.instanceId,
    buildId,
    requiredCapabilities: [],
  },
});
try {
  const server = await client.connect();
  if (server.dataAvailability !== 'unavailable')
    throw Error('terminal_legacy_data_was_not_unavailable');
  let historyError: unknown;
  try {
    await client.getView(sessionId);
  } catch (error) {
    historyError = error;
  }
  if (!(historyError instanceof Error) || Reflect.get(historyError, 'code') !== 'data_unavailable')
    throw Error('terminal_legacy_history_was_not_rejected');
  console.log(
    JSON.stringify({
      code: 'store_incompatible',
      historyCode: 'data_unavailable',
      dataAvailability: server.dataAvailability,
      pid: bootstrap.pid,
      startIdentity: bootstrap.processStartIdentity,
      instanceId: bootstrap.instanceId,
      buildId: bootstrap.buildId,
    }),
  );
} finally {
  client.disposeNetwork();
}
