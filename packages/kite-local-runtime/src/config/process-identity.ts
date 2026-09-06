import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

type WindowsProcessIdentityApi = {
  OpenProcess(access: number, inheritHandle: boolean, processId: number): number | bigint;
  GetProcessTimes(
    process: number | bigint,
    creationTime: Pointer,
    exitTime: Pointer,
    kernelTime: Pointer,
    userTime: Pointer,
  ): boolean;
  CloseHandle(handle: number | bigint): boolean;
};

let windowsApi: WindowsProcessIdentityApi | undefined;

/** Stable process-start identity used only to prove whether a config lock owner is still alive. */
export function readLocalProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).split(' ');
      const startTicks = fields[19];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    if (pid === process.pid && Number.isFinite(performance.timeOrigin)) {
      return `darwin:fallback:${pid}:${Math.floor(performance.timeOrigin)}`;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const startedAt = result.status === 0 ? Date.parse(result.stdout.trim()) : Number.NaN;
    return Number.isFinite(startedAt) ? `darwin:ps:${Math.floor(startedAt / 1000)}` : undefined;
  }
  if (process.platform === 'win32') return readWindowsProcessStartIdentity(pid);
  return undefined;
}

function readWindowsProcessStartIdentity(pid: number): string | undefined {
  try {
    const api = windowsProcessIdentityApi();
    const handle = api.OpenProcess(0x1000, false, pid);
    if (!handle) return undefined;
    try {
      const creation = new Uint8Array(8);
      const ignored = new Uint8Array(8);
      if (!api.GetProcessTimes(handle, ptr(creation), ptr(ignored), ptr(ignored), ptr(ignored))) {
        return undefined;
      }
      return `win32:${new DataView(creation.buffer).getBigUint64(0, true)}`;
    } finally {
      api.CloseHandle(handle);
    }
  } catch {
    return undefined;
  }
}

function windowsProcessIdentityApi(): WindowsProcessIdentityApi {
  if (!windowsApi) {
    windowsApi = dlopen('kernel32.dll', {
      OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
      GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
      CloseHandle: { args: ['u64'], returns: 'bool' },
    }).symbols;
  }
  return windowsApi;
}
