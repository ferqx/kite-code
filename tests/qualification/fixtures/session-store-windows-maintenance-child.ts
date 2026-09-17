import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
import {
  acquireKiteSessionStoreMaintenance,
  type KiteSessionMaintenanceMode,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-maintenance';

const [databasePath, mode, action, readyPath] = process.argv.slice(2);
if (process.platform !== 'win32' || !databasePath || (mode !== 'shared' && mode !== 'exclusive')) {
  process.exit(3);
}

const windowsPathSecurity = {
  verifyDirectory: (path: string) => verifyWindowsStatePath(path, 'directory'),
  secureFile: (path: string) => secureWindowsStatePath(path, 'file'),
  verifyFile: (path: string) => verifyWindowsStatePath(path, 'file'),
};

try {
  windowsPathSecurity.verifyDirectory(dirname(databasePath));
  const lock = acquireKiteSessionStoreMaintenance(
    databasePath,
    mode as KiteSessionMaintenanceMode,
    { windowsPathSecurity },
  );
  if (action === 'hold' && readyPath) {
    writeFileSync(readyPath, 'ready', { flag: 'wx', mode: 0o600 });
    await Bun.sleep(30_000);
  }
  lock.release();
  process.exit(0);
} catch (error) {
  process.exit(
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'store_busy'
      ? 2
      : 3,
  );
}
