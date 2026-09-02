import { runTui } from '@kite-ai/kite-cli/tui';
import { kiteAppServerVersion } from '@kite-ai/kite-local-runtime/client';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalAppServerComposition } from '../app-server-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const appServer = createManagedLocalAppServerComposition({
    argv: process.argv,
    executableMode,
  });
  runTui({
    connectRuntime: appServer.connector,
    clientVersion: packageJson.version,
    appServerRuntime: {
      transport: 'stdio',
      mode: appServer.mode,
      buildId: appServer.buildId,
      serverVersion: kiteAppServerVersion(appServer.buildId),
      clientVersion: packageJson.version,
    },
  });
}
