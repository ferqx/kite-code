import { runTui } from '@kite-ai/kite-cli/tui';
import {
  KITE_APP_SERVER_DAEMON_VERSION_,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalAppServerComposition } from '../app-server-client';
import { createManagedLocalAppServerDaemon } from '../app-server-daemon';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const serverIndex = process.argv.indexOf('--server');
  const serverEndpoint = serverIndex < 0 ? undefined : process.argv[serverIndex + 1];
  if (serverIndex >= 0 && !serverEndpoint) throw new Error('--server requires an endpoint.');
  const appServer = serverEndpoint
    ? createManagedLocalAppServerDaemon({
        argv: process.argv,
        executableMode,
        endpoint: serverEndpoint,
      })
    : createManagedLocalAppServerComposition({
        argv: process.argv,
        executableMode,
      });
  runTui({
    connectRuntime: appServer.connector,
    appServerRuntime: {
      transport:
        'endpoint' in appServer
          ? appServer.endpoint.kind === 'unix'
            ? 'unix'
            : 'named_pipe'
          : 'stdio',
      mode: 'target' in appServer ? appServer.target.mode : appServer.mode,
      buildId: 'target' in appServer ? appServer.target.buildId : appServer.buildId,
      serverVersion:
        'target' in appServer
          ? KITE_APP_SERVER_DAEMON_VERSION_
          : kiteAppServerVersion(appServer.buildId),
      clientVersion: packageJson.version,
      pairing: 'target' in appServer ? 'exact_protocol' : 'same_build',
    },
  });
}
