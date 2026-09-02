import { parseArgs, main as runCliMain } from '../../../apps/kite-cli/src/cli/index';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalAppServerComposition } from '../app-server-client';
import { createManagedLocalAppServerDaemon } from '../app-server-daemon';
import { createManagedLocalSingleServiceComposition } from '../single-service-native-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  const parsed = process.argv.includes('--help') ? undefined : parseArgs(process.argv.slice(2));
  const command = parsed?.command ?? 'help';
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const run =
    command === 'help'
      ? runCliMain({})
      : command === 'server-start' || command === 'server-status' || command === 'server-stop'
        ? (() => {
            const daemon = createManagedLocalAppServerDaemon({
              argv: process.argv,
              executableMode,
              ...(parsed?.serverEndpoint ? { endpoint: parsed.serverEndpoint } : {}),
            });
            return runCliMain({ appServerDaemon: daemon });
          })()
        : command.startsWith('service-')
          ? (() => {
              const localService = createManagedLocalSingleServiceComposition({
                argv: process.argv,
                executableMode,
              });
              return runCliMain({
                serviceManager: localService.manager,
                serviceExecutableMode: executableMode,
              });
            })()
          : command.startsWith('web-')
            ? (() => {
                const daemon = createManagedLocalAppServerDaemon({
                  argv: process.argv,
                  executableMode,
                  ...(parsed?.serverEndpoint ? { endpoint: parsed.serverEndpoint } : {}),
                });
                return runCliMain({ appServerWeb: { discover: daemon.discoverWeb } });
              })()
            : (() => {
                const connector = parsed?.serverEndpoint
                  ? createManagedLocalAppServerDaemon({
                      argv: process.argv,
                      executableMode,
                      endpoint: parsed.serverEndpoint,
                    }).connector
                  : createManagedLocalAppServerComposition({
                      argv: process.argv,
                      executableMode,
                    }).connector;
                return runCliMain({
                  runtimeConnector: connector,
                });
              })();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
