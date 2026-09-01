import { runTui } from '@kite-ai/kite-cli/tui';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalSingleServiceComposition } from '../single-service-native-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const freshService = process.argv.includes('--fresh-service');
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const localService = createManagedLocalSingleServiceComposition({
    argv: process.argv,
    executableMode,
    freshService,
  });
  if (freshService) {
    let restarted = await localService.manager.restart({ executableMode });
    if (restarted.outcome !== 'applied' && restarted.diagnostic === 'identity_uncertain') {
      // An accepted stop can finish immediately after the manager's bounded stop window.
      // Never replay stop: observe only, and spawn the current build solely after exact absence.
      const settlementDeadline = Date.now() + 5_000;
      while (Date.now() < settlementDeadline) {
        const status = await localService.manager.status({ executableMode });
        if (status.outcome === 'applied' && status.state === 'absent') {
          restarted = await localService.manager.ensure({ executableMode });
          break;
        }
        if (status.outcome === 'applied' && status.state === 'ready') {
          const current = await localService.client.describe().catch(() => undefined);
          if (current?.service.buildId === localService.expectedBuildId) {
            restarted = status;
            break;
          }
        }
        await Bun.sleep(50);
      }
    }
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
