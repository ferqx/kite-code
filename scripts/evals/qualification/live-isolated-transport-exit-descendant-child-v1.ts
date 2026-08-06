import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fixed test-only post-leader descendant. It writes no output and receives no
 * pipe or credential; the empty marker is only an internal lifecycle witness.
 */
setTimeout(() => {
  try {
    writeFileSync(join('..', 'isolated-transport-leader-exit-marker.v1'), '', {
      flag: 'wx',
      mode: 0o400,
    });
  } catch {
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 80);
}, 80);
