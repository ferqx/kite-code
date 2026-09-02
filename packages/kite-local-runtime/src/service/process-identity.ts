import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { KiteLocalRuntimeProcessIdentityProbe } from './lifecycle-reservation';

const execFileAsync = promisify(execFile);

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

let windowsProcessIdentityApi: WindowsProcessIdentityApi | undefined;

/** Exact OS process-start token used by owner-only local endpoint lifecycle. */
export async function readLocalProcessStartIdentity(
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') return readLinuxProcessStartIdentity(pid);
  if (platform === 'darwin') return readDarwinProcessStartIdentity(pid);
  if (platform === 'win32') return readWindowsProcessStartIdentity(pid);
  return undefined;
}

/** Exact PID plus OS start-token probe used by owner-only local endpoint cleanup. */
export function createKiteLocalRuntimeProcessIdentityProbe(
  platform: NodeJS.Platform = process.platform,
): KiteLocalRuntimeProcessIdentityProbe {
  return Object.freeze({
    async inspect(pid: number, expectedStartIdentity: string) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !expectedStartIdentity) return 'uncertain';
      const actual = await readLocalProcessStartIdentity(pid, platform);
      if (actual !== undefined) return actual === expectedStartIdentity ? 'alive' : 'dead';
      try {
        process.kill(pid, 0);
        return 'uncertain';
      } catch (error) {
        return errorCodeIs(error, 'ESRCH') ? 'dead' : 'uncertain';
      }
    },
  });
}

function errorCodeIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function readLinuxProcessStartIdentity(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closing = value.lastIndexOf(')');
    if (closing < 0) return undefined;
    const fields = value
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return startTime === undefined ||
      !/^\d+$/u.test(startTime) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bootId)
      ? undefined
      : `linux:${bootId}:${startTime}`;
  } catch {
    return undefined;
  }
}

async function readDarwinProcessStartIdentity(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 1_000,
      maxBuffer: 4_096,
      windowsHide: true,
      env: { LC_ALL: 'C', LANG: 'C' },
    });
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : `darwin:${value}`;
  } catch {
    return undefined;
  }
}

function readWindowsProcessStartIdentity(pid: number): string | undefined {
  try {
    const api = getWindowsProcessIdentityApi();
    const processHandle = api.OpenProcess(0x1000, false, pid);
    if (!processHandle) return undefined;
    try {
      const creationTime = new Uint8Array(8);
      const ignored = new Uint8Array(8);
      if (
        !api.GetProcessTimes(
          processHandle,
          ptr(creationTime),
          ptr(ignored),
          ptr(ignored),
          ptr(ignored),
        )
      ) {
        return undefined;
      }
      return `win32:${new DataView(creationTime.buffer).getBigUint64(0, true)}`;
    } finally {
      api.CloseHandle(processHandle);
    }
  } catch {
    return undefined;
  }
}

function getWindowsProcessIdentityApi(): WindowsProcessIdentityApi {
  if (!windowsProcessIdentityApi) {
    windowsProcessIdentityApi = dlopen('kernel32.dll', {
      OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
      GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
      CloseHandle: { args: ['u64'], returns: 'bool' },
    }).symbols;
  }
  return windowsProcessIdentityApi;
}
