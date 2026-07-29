import type { Pointer } from 'bun:ffi';
import { dlopen } from 'bun:ffi';

type KillableProcess = Pick<Bun.Subprocess, 'kill' | 'pid'>;

export interface ProcessTreeGuard {
  terminate(): Promise<void>;
  dispose(): void;
}

/**
 * POSIX commands run in their own process group so a timeout can terminate
 * the shell wrapper and every descendant without touching the parent runtime.
 */
export function processTreeSpawnOptions(): { detached?: boolean } {
  return process.platform === 'win32' ? {} : { detached: true };
}

/**
 * Attach a platform process-tree guard immediately after spawning the command.
 *
 * Windows Job Objects track descendants even when MSYS2 reports parent PIDs in
 * a shape that taskkill cannot traverse. POSIX uses the isolated process group
 * created by processTreeSpawnOptions().
 */
export function guardProcessTree(proc: KillableProcess): ProcessTreeGuard {
  if (process.platform === 'win32') {
    const jobGuard = createWindowsJobGuard(proc);
    if (jobGuard) return jobGuard;
  }

  return {
    async terminate() {
      if (process.platform !== 'win32') {
        try {
          process.kill(-proc.pid, 'SIGKILL');
          await waitForProcessGroupExit(proc.pid);
          return;
        } catch {
          // The process group may already be gone. Fall back to its root.
        }
      }

      if (process.platform === 'win32' && (await terminateWindowsProcessTree(proc.pid))) {
        return;
      }

      try {
        proc.kill('SIGKILL');
      } catch {
        // The root process may already have exited.
      }
    },
    dispose() {},
  };
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
}

type WindowsJobApi = {
  CreateJobObjectW(attributes: Pointer | null, name: Pointer | null): Pointer | null;
  CreateToolhelp32Snapshot(flags: number, processId: number): Pointer | null;
  Process32FirstW(snapshot: Pointer, entry: Uint8Array): boolean;
  Process32NextW(snapshot: Pointer, entry: Uint8Array): boolean;
  OpenProcess(access: number, inheritHandle: boolean, processId: number): Pointer | null;
  AssignProcessToJobObject(job: Pointer, processHandle: Pointer): boolean;
  TerminateJobObject(job: Pointer, exitCode: number): boolean;
  TerminateProcess(processHandle: Pointer, exitCode: number): boolean;
  WaitForSingleObject(handle: Pointer, milliseconds: number): number;
  CloseHandle(handle: Pointer): boolean;
};

let windowsJobLibrary:
  | {
      symbols: WindowsJobApi;
    }
  | undefined;

function getWindowsJobApi(): WindowsJobApi {
  if (!windowsJobLibrary) {
    windowsJobLibrary = dlopen('kernel32.dll', {
      CreateJobObjectW: {
        args: ['ptr', 'ptr'],
        returns: 'ptr',
      },
      CreateToolhelp32Snapshot: {
        args: ['u32', 'u32'],
        returns: 'ptr',
      },
      Process32FirstW: {
        args: ['ptr', 'ptr'],
        returns: 'bool',
      },
      Process32NextW: {
        args: ['ptr', 'ptr'],
        returns: 'bool',
      },
      OpenProcess: {
        args: ['u32', 'bool', 'u32'],
        returns: 'ptr',
      },
      AssignProcessToJobObject: {
        args: ['ptr', 'ptr'],
        returns: 'bool',
      },
      TerminateJobObject: {
        args: ['ptr', 'u32'],
        returns: 'bool',
      },
      TerminateProcess: {
        args: ['ptr', 'u32'],
        returns: 'bool',
      },
      WaitForSingleObject: {
        args: ['ptr', 'u32'],
        returns: 'u32',
      },
      CloseHandle: {
        args: ['ptr'],
        returns: 'bool',
      },
    });
  }
  return windowsJobLibrary.symbols;
}

function createWindowsJobGuard(proc: KillableProcess): ProcessTreeGuard | null {
  try {
    const api = getWindowsJobApi();
    const job = api.CreateJobObjectW(null, null);
    if (!job) return null;

    const processAccess = 0x0001 | 0x0100;
    const processHandle = api.OpenProcess(processAccess, false, proc.pid);
    if (!processHandle) {
      api.CloseHandle(job);
      return null;
    }

    const assigned = api.AssignProcessToJobObject(job, processHandle);
    api.CloseHandle(processHandle);
    if (!assigned) {
      api.CloseHandle(job);
      return null;
    }

    let active = true;
    const close = () => {
      if (!active) return;
      active = false;
      api.CloseHandle(job);
    };

    return {
      async terminate() {
        if (!active) return;
        const knownTree = new Set([proc.pid]);
        extendWindowsProcessTree(api, knownTree);
        const terminated = api.TerminateJobObject(job, 124);
        close();
        const rootTerminated = terminated || (await terminateWindowsProcess(api, proc.pid));
        await terminateKnownWindowsDescendants(api, knownTree, proc.pid);
        if (!rootTerminated) await terminateWindowsProcessTree(proc.pid);
      },
      dispose: close,
    };
  } catch {
    return null;
  }
}

type WindowsProcessEntry = {
  pid: number;
  parentPid: number;
};

function isInvalidWindowsHandle(handle: Pointer | null): boolean {
  if (!handle) return true;
  const value = Number(handle);
  return value === -1 || value === 0xffff_ffff;
}

function snapshotWindowsProcesses(api: WindowsJobApi): WindowsProcessEntry[] {
  const snapshot = api.CreateToolhelp32Snapshot(0x00000002, 0);
  if (isInvalidWindowsHandle(snapshot)) return [];
  const snapshotHandle = snapshot as Pointer;

  const is32Bit = process.arch === 'ia32';
  const entrySize = is32Bit ? 556 : 568;
  const parentPidOffset = is32Bit ? 24 : 32;
  const entry = new Uint8Array(entrySize);
  const view = new DataView(entry.buffer);
  view.setUint32(0, entrySize, true);

  try {
    if (!api.Process32FirstW(snapshotHandle, entry)) return [];
    const processes: WindowsProcessEntry[] = [];
    do {
      processes.push({
        pid: view.getUint32(8, true),
        parentPid: view.getUint32(parentPidOffset, true),
      });
    } while (api.Process32NextW(snapshotHandle, entry));
    return processes;
  } finally {
    api.CloseHandle(snapshotHandle);
  }
}

function extendWindowsProcessTree(
  api: WindowsJobApi,
  knownTree: Set<number>,
): WindowsProcessEntry[] {
  const processes = snapshotWindowsProcesses(api);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const processEntry of processes) {
      if (!knownTree.has(processEntry.parentPid) || knownTree.has(processEntry.pid)) continue;
      knownTree.add(processEntry.pid);
      expanded = true;
    }
  }
  return processes;
}

async function waitForWindowsProcessExit(
  api: WindowsJobApi,
  processHandle: Pointer,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waitResult = api.WaitForSingleObject(processHandle, 0);
    if (waitResult === 0) return true;
    if (waitResult === 0xffff_ffff) return false;
    await Bun.sleep(10);
  }
  return api.WaitForSingleObject(processHandle, 0) === 0;
}

async function terminateWindowsProcess(api: WindowsJobApi, pid: number): Promise<boolean> {
  const processHandle = api.OpenProcess(0x0001 | 0x0010_0000, false, pid);
  if (!processHandle) return false;
  try {
    const terminationRequested = api.TerminateProcess(processHandle, 124);
    const exited = await waitForWindowsProcessExit(api, processHandle);
    return terminationRequested || exited;
  } finally {
    api.CloseHandle(processHandle);
  }
}

async function terminateKnownWindowsDescendants(
  api: WindowsJobApi,
  knownTree: Set<number>,
  rootPid: number,
): Promise<boolean> {
  let terminatedAny = false;
  for (let round = 0; round < 8; round += 1) {
    const processes = extendWindowsProcessTree(api, knownTree);
    const liveDescendants = processes.filter(
      (processEntry) => processEntry.pid !== rootPid && knownTree.has(processEntry.pid),
    );
    if (liveDescendants.length === 0) break;
    for (const processEntry of liveDescendants.reverse()) {
      terminatedAny = (await terminateWindowsProcess(api, processEntry.pid)) || terminatedAny;
    }
  }
  return terminatedAny;
}

async function terminateWindowsProcessTreeNative(pid: number): Promise<boolean> {
  try {
    const api = getWindowsJobApi();
    const knownTree = new Set([pid]);
    extendWindowsProcessTree(api, knownTree);
    const rootTerminated = await terminateWindowsProcess(api, pid);
    const descendantTerminated = await terminateKnownWindowsDescendants(api, knownTree, pid);
    return rootTerminated || descendantTerminated;
  } catch {
    return false;
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  if (await terminateWindowsProcessTreeNative(pid)) return true;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try {
    const killer = Bun.spawn(
      [`${systemRoot}\\System32\\taskkill.exe`, '/pid', String(pid), '/t', '/f'],
      {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    return (await killer.exited) === 0;
  } catch {
    return false;
  }
}
