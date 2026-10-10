export type WindowsProcessState = 'alive' | 'dead' | 'uncertain';
export interface WindowsProcessObservation {
  readonly identity: string | undefined;
  inspect(): WindowsProcessState;
  close(): void;
}

let implementation: ReturnType<typeof native> | undefined;
// Failed CloseHandle retains the original object until a successful retry or host exit.
const unclosedHandles = new Set<bigint>();
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const validIdentity = (identity: string) =>
  /^windows:filetime:[1-9][0-9]{0,19}$/.test(identity) &&
  BigInt(identity.slice('windows:filetime:'.length)) <= 0xffffffffffffffffn;

/** Read-only original process HANDLE. No signal, supplied HANDLE or configurable DLL. */
export function retainWindowsProcess(
  pid: number,
  expectedStart?: string,
): WindowsProcessObservation {
  if (
    !validPid(pid) ||
    (expectedStart !== undefined && !validIdentity(expectedStart)) ||
    process.platform !== 'win32' ||
    process.arch !== 'x64'
  )
    return Object.freeze({ identity: undefined, inspect: () => 'uncertain' as const, close() {} });
  implementation ??= native();
  return implementation.retain(pid, expectedStart);
}
export function readWindowsProcessStartIdentity(pid: number): string | undefined {
  const observation = retainWindowsProcess(pid);
  try {
    return observation.identity;
  } finally {
    observation.close();
  }
}
export function inspectWindowsProcess(pid: number, expectedStart: string): WindowsProcessState {
  const observation = retainWindowsProcess(pid, expectedStart);
  try {
    return observation.inspect();
  } finally {
    observation.close();
  }
}

function native() {
  // kernel32 is a fixed Windows KnownDLL; loading remains lazy on Node/POSIX imports.
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    GetProcessId: { args: ['u64'], returns: 'u32' },
    GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
    WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'u64' },
    Process32FirstW: { args: ['u64', 'ptr'], returns: 'bool' },
    Process32NextW: { args: ['u64', 'ptr'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
  });
  const close = (handle: bigint) => {
    unclosedHandles.add(handle);
    if (!kernel.symbols.CloseHandle(handle))
      throw Object.assign(new Error('windows_process_close_unknown'), {
        code: 'windows_process_close_unknown',
      });
    unclosedHandles.delete(handle);
  };
  const identity = (handle: bigint, pid: number): string | undefined => {
    const creation = new BigUint64Array(1),
      exit = new BigUint64Array(1),
      system = new BigUint64Array(1),
      user = new BigUint64Array(1);
    if (
      kernel.symbols.GetProcessId(handle) !== pid ||
      !kernel.symbols.GetProcessTimes(handle, ptr(creation), ptr(exit), ptr(system), ptr(user)) ||
      creation[0] === 0n
    )
      return;
    return `windows:filetime:${creation[0]}`;
  };
  const absent = (pid: number, snapshots: Set<bigint>): boolean => {
    // PROCESSENTRY32W x64: sizeof=568, th32ProcessID=8. Only complete censuses count.
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = kernel.symbols.CreateToolhelp32Snapshot(2, 0);
      if (snapshot === 0n || snapshot === 0xffffffffffffffffn) return false;
      snapshots.add(snapshot);
      let complete = false,
        found = false,
        populated = false;
      try {
        const bytes = new Uint8Array(568),
          view = new DataView(bytes.buffer);
        view.setUint32(0, bytes.length, true);
        let next = kernel.symbols.Process32FirstW(snapshot, ptr(bytes));
        for (let count = 0; count < 65536; count++) {
          if (!next) {
            complete = kernel.symbols.GetLastError() === 18;
            break;
          }
          if (view.getUint32(0, true) !== bytes.length) break;
          populated = true;
          if (view.getUint32(8, true) === pid) found = true;
          next = kernel.symbols.Process32NextW(snapshot, ptr(bytes));
        }
      } finally {
        close(snapshot);
        snapshots.delete(snapshot);
      }
      if (!complete || !populated || found) return false;
    }
    return true;
  };
  return {
    retain(pid: number, expected?: string): WindowsProcessObservation {
      const handle = kernel.symbols.OpenProcess(0x101000, false, pid);
      if (handle === 0n) {
        let closed = false;
        const snapshots = new Set<bigint>();
        return Object.freeze({
          identity: undefined,
          inspect(): WindowsProcessState {
            if (closed || snapshots.size) return 'uncertain';
            try {
              return absent(pid, snapshots) ? 'dead' : 'uncertain';
            } catch {
              return 'uncertain';
            }
          },
          close() {
            const errors: unknown[] = [];
            for (const snapshot of snapshots) {
              try {
                close(snapshot);
                snapshots.delete(snapshot);
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length) throw new AggregateError(errors, 'windows_process_close_unknown');
            closed = true;
          },
        });
      }
      unclosedHandles.add(handle);
      const original = identity(handle, pid);
      let closed = false,
        closeFailed = false;
      return Object.freeze({
        identity: original,
        inspect(): WindowsProcessState {
          if (closed || closeFailed) return 'uncertain';
          if (original !== undefined && expected !== undefined && original !== expected)
            return 'dead';
          const wait = kernel.symbols.WaitForSingleObject(handle, 0);
          if (wait === 0) return 'dead';
          if (wait !== 258 || original === undefined || identity(handle, pid) !== original)
            return 'uncertain';
          return 'alive';
        },
        close() {
          if (closed) return;
          try {
            close(handle);
            closed = true;
            closeFailed = false;
          } catch (error) {
            closeFailed = true;
            throw error;
          }
        },
      });
    },
  };
}
