import type { KiteServiceManager } from '@kite-ai/kite-local-runtime/manager';
import packageJson from '../../package.json' with { type: 'json' };
import type { KiteRuntimeModeConnector } from '../service-mode';
import { main } from './index';

export interface KiteCliExecutableOptions {
  /** Explicit parent-owned Runtime connector supplied by release composition. */
  readonly runtimeConnector?: KiteRuntimeModeConnector;
  /** Explicit lifecycle manager supplied by release composition; no ambient discovery is allowed. */
  readonly serviceManager?: KiteServiceManager;
  readonly serviceExecutableMode?: 'source' | 'installed';
}

export async function runCli(options: KiteCliExecutableOptions = {}): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    return;
  }
  await main({
    runtimeConnector: options.runtimeConnector,
    serviceManager: options.serviceManager,
    serviceExecutableMode: options.serviceExecutableMode,
  });
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
