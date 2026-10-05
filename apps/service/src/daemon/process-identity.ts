import { dlopen, ptr } from 'bun:ffi';
import { readFileSync } from 'node:fs';

let darwin: ReturnType<typeof openDarwin> | undefined;
function openDarwin() {
  return dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
  });
}
/** Kernel start identity only; no ps/timeOrigin fallback. SDK proc_bsdinfo: size136, pid12, start120/128. */
export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return;
  try {
    if (process.platform === 'darwin') {
      darwin ??= openDarwin();
      const bytes = new Uint8Array(136);
      if (darwin.symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), bytes.length) !== bytes.length) return;
      const view = new DataView(bytes.buffer);
      const seconds = view.getBigUint64(120, true),
        microseconds = view.getBigUint64(128, true);
      if (view.getUint32(12, true) !== pid || seconds === 0n || microseconds >= 1000000n) return;
      return `darwin:proc_bsdinfo:${seconds}:${microseconds}`;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end < 0) return;
      const start = stat
        .slice(end + 2)
        .trim()
        .split(/\s+/)[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!start || !/^\d+$/.test(start) || !/^[a-f0-9-]{36}$/.test(boot)) return;
      return `linux:${boot}:${start}`;
    }
  } catch {
    return;
  }
  return undefined;
}
export function inspectProcess(pid: number, expectedStart: string): 'alive' | 'dead' | 'uncertain' {
  const actual = readProcessStartIdentity(pid);
  if (actual !== undefined) return actual === expectedStart ? 'alive' : 'dead';
  try {
    process.kill(pid, 0);
    return 'uncertain';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'uncertain';
  }
}
