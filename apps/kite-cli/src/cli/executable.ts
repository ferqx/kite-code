import type { KiteServiceManager } from '@kite-ai/kite-local-runtime/manager';
import packageJson from '../../package.json' with { type: 'json' };
import type { KiteServiceModeConnector } from '../service-mode';
import { main } from './index';

export interface KiteCliExecutableOptions {
  /** Explicit managed Service connector supplied by release composition. */
  readonly serviceConnector?: KiteServiceModeConnector;
  /** Explicit lifecycle manager supplied by release composition; no ambient discovery is allowed. */
  readonly serviceManager?: KiteServiceManager;
}

export async function runCli(options: KiteCliExecutableOptions = {}): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    return;
  }
  await main({
    serviceConnector: options.serviceConnector,
    serviceManager: options.serviceManager,
  });
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
