import { runTui } from '@kite-ai/kite-cli/tui';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalSingleServiceComposition } from '../single-service-native-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const localService = createManagedLocalSingleServiceComposition({
    argv: process.argv,
    executableMode: process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source',
  });
  if (process.argv.includes('--fresh-service')) {
    const restarted = await localService.manager.restart();
    if (restarted.outcome !== 'applied' || restarted.state !== 'ready') {
      throw new Error(
        `Fresh TUI Service restart failed: ${restarted.diagnostic ?? restarted.outcome}.`,
      );
    }
  }
  runTui({
    connectService: localService.connector,
    discoverWeb: localService.discoverWeb,
    expectedServiceBuildId: localService.expectedBuildId,
  });
}
