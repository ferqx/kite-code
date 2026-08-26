import { runTui } from '@kite-ai/kite-cli/tui';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalServiceClientComposition } from '../local-service-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const localService = createManagedLocalServiceClientComposition({
    executableMode: process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source',
  });
  runTui({ connectService: localService.connector });
}
