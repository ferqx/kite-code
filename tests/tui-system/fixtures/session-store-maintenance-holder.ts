/** Test-owned separate process: keep the canonical Store lock until stdin releases it. */
import { writeFileSync } from 'node:fs';
import { acquireKiteSessionStoreMaintenance } from '../../../packages/runtime-storage-sqlite/src/kite-session-maintenance';

const [databasePath, readyPath] = process.argv.slice(2);
if (!databasePath || !readyPath) process.exit(3);

const lock = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive');
try {
  writeFileSync(readyPath, 'ready', { flag: 'wx', mode: 0o600 });
  for await (const chunk of process.stdin) {
    if (String(chunk).includes('release')) break;
  }
} finally {
  lock.release();
}
