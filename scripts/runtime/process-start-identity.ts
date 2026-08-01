import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Read a comparable OS process-start identity for safe PID reuse detection. */
export function readOsProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const startTicks = stat.slice(closeParen + 2).split(' ')[19];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    return started ? `darwin:ps:${started}` : undefined;
  }
  return undefined;
}
