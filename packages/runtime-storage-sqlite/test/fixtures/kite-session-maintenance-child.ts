import { writeFileSync } from 'node:fs';
import {
  acquireKiteSessionStoreMaintenance,
  type KiteSessionMaintenanceMode,
} from '../../src/kite-session-maintenance';

const [databasePath, mode, action, readyPath] = process.argv.slice(2);
if (!databasePath || (mode !== 'shared' && mode !== 'exclusive')) process.exit(3);

try {
  const lock = acquireKiteSessionStoreMaintenance(databasePath, mode as KiteSessionMaintenanceMode);
  if (action === 'hold' && readyPath) {
    writeFileSync(readyPath, 'ready', { flag: 'wx', mode: 0o600 });
    await Bun.sleep(30_000);
  }
  lock.release();
  process.exit(0);
} catch {
  process.exit(2);
}
