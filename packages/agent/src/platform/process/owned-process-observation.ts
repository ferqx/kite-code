/** Explicit read-only identity observation. Import opens no resources and grants no process authority. */
export interface OwnedProcessIdentity {
  pid: number;
  parentPid: number | null;
  birth: { seconds: string; microseconds: number } | null;
  unavailable: string[];
}
export interface OwnedProcessRecord extends OwnedProcessIdentity {
  exit: { code: number | null; signal: string | null; reaped: true } | null;
  kernelState: 'absent' | 'reused' | 'alive' | 'unavailable';
}
let native: ((pid: number) => OwnedProcessIdentity) | undefined;
export function observeOwnedProcessIdentity(pid: number): OwnedProcessIdentity {
  try {
    if (!Number.isSafeInteger(pid) || pid < 2 || process.platform !== 'darwin')
      throw Error('unsupported');
    if (!native) {
      const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
      const api = dlopen('/usr/lib/libproc.dylib', {
        proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
      });
      native = (current) => {
        // Darwin SDK proc_bsdinfo: size 136, pid@12, ppid@16, sec@120, usec@128.
        const bytes = new Uint8Array(136);
        if (api.symbols.proc_pidinfo(current, 3, 0, ptr(bytes), bytes.length) !== bytes.length)
          throw Error('unavailable');
        const view = new DataView(bytes.buffer),
          seconds = view.getBigUint64(120, true),
          microseconds = view.getBigUint64(128, true);
        if (view.getUint32(12, true) !== current || seconds === 0n || microseconds >= 1000000n)
          throw Error('invalid');
        return {
          pid: current,
          parentPid: view.getUint32(16, true),
          birth: { seconds: String(seconds), microseconds: Number(microseconds) },
          unavailable: [],
        };
      };
    }
    return native(pid);
  } catch {
    return { pid, parentPid: null, birth: null, unavailable: ['native_birth_unavailable'] };
  }
}
export function ownedProcessKernelState(
  original: OwnedProcessIdentity,
): OwnedProcessRecord['kernelState'] {
  if (!Number.isSafeInteger(original.pid) || original.pid < 2) return 'unavailable';
  const current = observeOwnedProcessIdentity(original.pid);
  if (original.birth && current.birth)
    return original.birth.seconds === current.birth.seconds &&
      original.birth.microseconds === current.birth.microseconds
      ? 'alive'
      : 'reused';
  try {
    process.kill(original.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent';
  }
  return 'unavailable';
}
/** Exact finite identity metadata; callers must separately bind it to their owned execution. */
export function isOwnedProcessIdentity(
  value: unknown,
  pid: number,
  parentPid: number,
): value is OwnedProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const row = value as OwnedProcessIdentity;
  return (
    Object.keys(row).sort().join(',') === 'birth,parentPid,pid,unavailable' &&
    row.pid === pid &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    Array.isArray(row.unavailable) &&
    ((row.birth === null &&
      row.parentPid === null &&
      row.unavailable.length === 1 &&
      row.unavailable[0] === 'native_birth_unavailable') ||
      (row.parentPid === parentPid &&
        row.unavailable.length === 0 &&
        !!row.birth &&
        Object.keys(row.birth).sort().join(',') === 'microseconds,seconds' &&
        typeof row.birth.seconds === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(row.birth.seconds) &&
        Number.isSafeInteger(row.birth.microseconds) &&
        row.birth.microseconds >= 0 &&
        row.birth.microseconds < 1000000))
  );
}
