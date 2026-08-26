import { runCli } from '@kite-ai/kite-cli/cli';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalServiceClientComposition } from '../local-service-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  const run = process.argv.includes('--help')
    ? runCli()
    : (() => {
        const localService = createManagedLocalServiceClientComposition({
          executableMode: process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source',
        });
        return runCli({
          serviceConnector: localService.connector,
          serviceManager: localService.lifecycle,
        });
      })();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
