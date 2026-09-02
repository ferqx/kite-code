import { runKiteAppServerMain } from '#kite-service/app-server';
import { createKiteSessionAppServerStorageComposition } from '#kite-service/bootstrap';

await runKiteAppServerMain(['app-server', 'run-stdio'], {
  createStorage: ({ databasePath, hostInstanceId }) =>
    createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId,
      executionLeaseMs: 600,
      renewIntervalMs: 200,
    }),
});
