import type { Pointer } from 'bun:ffi';
import { dlopen } from 'bun:ffi';
import { spawnRuntimeHostProcess } from './spawn';

type KillableProcess = Pick<Bun.Subprocess, 'kill' | 'pid'>;

export interface ProcessTreeGuard {
  terminate(): Promise<ProcessTreeTerminationResult>;
  dispose(): void;
}

export interface ProcessTreeTerminationResult {
  rootPid: number;
  gracefulRequested: boolean;
  forced: boolean;
  confirmedExited: boolean;
  unconfirmedPids: number[];
}

const GRACEFUL_TERMINATION_MS = 500;
const FORCED_TERMINATION_MS = 2_000;

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
        let gracefulRequested = false;
        try {
          process.kill(-proc.pid, 'SIGTERM');
          gracefulRequested = true;
        } catch {
          return {
            rootPid: proc.pid,
            gracefulRequested: false,
            forced: false,
            confirmedExited: true,
            unconfirmedPids: [],
          };
        }
        if (await waitForProcessGroupExit(proc.pid, GRACEFUL_TERMINATION_MS)) {
          return {
            rootPid: proc.pid,
            gracefulRequested,
            forced: false,
            confirmedExited: true,
            unconfirmedPids: [],
          };
        }
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // The process group exited between the bounded checks.
        }
        const confirmedExited = await waitForProcessGroupExit(proc.pid, FORCED_TERMINATION_MS);
        return {
          rootPid: proc.pid,
          gracefulRequested,
          forced: true,
          confirmedExited,
          unconfirmedPids: confirmedExited ? [] : [proc.pid],
        };
      }

      if (process.platform === 'win32') {
        try {
          proc.kill();
        } catch {
          // Root may already be gone; the descendant sweep still runs.
        }
        if (await waitForPidExit(proc.pid, GRACEFUL_TERMINATION_MS)) {
          return {
            rootPid: proc.pid,
            gracefulRequested: true,
            forced: false,
            confirmedExited: true,
            unconfirmedPids: [],
          };
        }
        await terminateWindowsProcessTree(proc.pid);
        const confirmedExited = !isProcessAlive(proc.pid);
        return {
          rootPid: proc.pid,
          gracefulRequested: true,
          forced: true,
          confirmedExited,
          unconfirmedPids: confirmedExited ? [] : [proc.pid],
        };
      }

      try {
        proc.kill('SIGTERM');
      } catch {
        // The root process may already have exited.
      }
      if (await waitForPidExit(proc.pid, GRACEFUL_TERMINATION_MS)) {
        return {
          rootPid: proc.pid,
          gracefulRequested: true,
          forced: false,
          confirmedExited: true,
          unconfirmedPids: [],
        };
      }
      try {
        proc.kill('SIGKILL');
      } catch {
        // The root process may already have exited.
      }
      const confirmedExited = await waitForPidExit(proc.pid, FORCED_TERMINATION_MS);
      return {
        rootPid: proc.pid,
        gracefulRequested: true,
        forced: true,
        confirmedExited,
        unconfirmedPids: confirmedExited ? [] : [proc.pid],
      };
    },
    dispose() {},
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(10);
  }
  return !isProcessAlive(pid);
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs = FORCED_TERMINATION_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch {
    return true;
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

    // Capture descendants that may have started before the root was assigned
    // to this Job. Job assignment is not retroactive, and once the root exits
    // those processes can be reparented before a later Toolhelp snapshot.
    const knownTree = new Set([proc.pid]);
    extendWindowsProcessTree(api, knownTree);
    const preAssignmentTree = new Set(knownTree);

    const assigned = api.AssignProcessToJobObject(job, processHandle);
    api.CloseHandle(processHandle);
    if (!assigned) {
      api.CloseHandle(job);
      return null;
    }
    // Keep the full tree for the fallback path. Processes created after this
    // point are inside the Job and do not belong to preAssignmentTree.
    extendWindowsProcessTree(api, knownTree);

    let active = true;
    const close = () => {
      if (!active) return;
      active = false;
      api.CloseHandle(job);
    };

    return {
      async terminate() {
        if (!active) {
          return {
            rootPid: proc.pid,
            gracefulRequested: false,
            forced: false,
            confirmedExited: !isProcessAlive(proc.pid),
            unconfirmedPids: isProcessAlive(proc.pid) ? [proc.pid] : [],
          };
        }
        extendWindowsProcessTree(api, knownTree);
        try {
          proc.kill();
        } catch {
          // Root may already be gone.
        }
        const rootExitedGracefully = await waitForPidExit(proc.pid, GRACEFUL_TERMINATION_MS);
        let jobTerminated = false;
        if (!rootExitedGracefully) {
          jobTerminated = api.TerminateJobObject(job, 124);
        }
        close();
        const rootTerminated =
          rootExitedGracefully || jobTerminated || (await terminateWindowsProcess(api, proc.pid));
        // TerminateJobObject already stops every process created after the Job
        // was attached. Sweeping those descendants again is both redundant and
        // potentially slow because a just-terminated Windows process may take
        // the per-process confirmation timeout to become observable. Only
        // descendants captured before assignment can have escaped the Job.
        const descendantsToSweep = jobTerminated ? preAssignmentTree : knownTree;
        const descendantTerminated = await terminateKnownWindowsDescendants(
          api,
          descendantsToSweep,
          proc.pid,
        );
        if (!rootTerminated) await terminateWindowsProcessTree(proc.pid);
        const unconfirmedPids = [...knownTree].filter((pid) => isProcessAlive(pid));
        if (unconfirmedPids.length === 0) {
          return {
            rootPid: proc.pid,
            gracefulRequested: true,
            forced: !rootExitedGracefully || descendantTerminated,
            confirmedExited: true,
            unconfirmedPids: [],
          };
        }
        return {
          rootPid: proc.pid,
          gracefulRequested: true,
          forced: !rootExitedGracefully || descendantTerminated,
          confirmedExited: false,
          unconfirmedPids,
        };
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
    const killer = spawnRuntimeHostProcess(
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
