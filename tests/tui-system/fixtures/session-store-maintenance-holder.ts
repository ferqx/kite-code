/** Separate test owner holds the current Profile exclusion until stdin releases it. */
import { writeFileSync } from 'node:fs';
import { acquireProfileMaintenanceAccess } from '../../../packages/agent/src/platform/profile';

const [dataRoot, profile, readyPath] = process.argv.slice(2);
if (!dataRoot || !profile || !readyPath) process.exit(3);

const access = acquireProfileMaintenanceAccess({ dataRoot, profile });
try {
  writeFileSync(readyPath, 'ready', { flag: 'wx', mode: 0o600 });
  for await (const chunk of process.stdin) {
    if (String(chunk).includes('release')) break;
  }
} finally {
  access.lock.release();
}
