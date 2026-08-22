import packageJson from '../../package.json' with { type: 'json' };
import {
  assertKiteRuntimeAuthorizationElevationV1,
  createKiteCliRuntimeAccess,
} from '../bootstrap';
import { main } from './index';

export async function runCli(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    return;
  }
  await main({
    createRuntimeAccess: createKiteCliRuntimeAccess,
    assertAuthorizationElevation: assertKiteRuntimeAuthorizationElevationV1,
  });
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
