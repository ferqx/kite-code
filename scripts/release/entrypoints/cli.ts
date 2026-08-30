import { parseArgs, main as runCliMain } from '../../../apps/kite-cli/src/cli/index';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalSingleServiceComposition } from '../single-service-native-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  const command = process.argv.includes('--help')
    ? 'help'
    : parseArgs(process.argv.slice(2)).command;
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const run =
    command === 'help'
      ? runCliMain({})
      : command.startsWith('service-')
        ? (() => {
            const localService = createManagedLocalSingleServiceComposition({
              argv: process.argv,
              executableMode,
            });
            return runCliMain({ serviceManager: localService.manager });
          })()
        : command.startsWith('web-')
          ? (() => {
              const localService = createManagedLocalSingleServiceComposition({
                argv: process.argv,
                executableMode,
              });
              return runCliMain({ singleServiceWeb: localService.web });
            })()
          : (() => {
              const localService = createManagedLocalSingleServiceComposition({
                argv: process.argv,
                executableMode,
              });
              return runCliMain({
                serviceConnector: localService.connector,
              });
            })();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
