import { closeSync, constants, openSync, readdirSync, readFileSync } from 'node:fs';

/** Diagnostic native observation only; callers supply their already-owned process IDs. */
export interface NativeProcessObservation {
  collector: 'darwin-libproc' | 'linux-procfs' | 'unavailable';
  pid: number;
  parentPid: number | null;
  startIdentity: { kind: 'darwin-start-time' | 'linux-boot-start-ticks'; value: string } | null;
  fileDescriptors: number | null;
  unavailable: string[];
}

function validPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    throw Error('native_process_pid_invalid');
}

/** comm is parenthesized and can itself contain spaces and closing parentheses. */
export function parseLinuxProcessStat(text: string, pid: number) {
  validPid(pid);
  if (text.length > 16384) throw Error('native_process_stat_invalid');
  const start = text.indexOf(' ('),
    end = text.lastIndexOf(') ');
  if (start < 1 || end <= start || text.slice(0, start) !== String(pid))
    throw Error('native_process_stat_invalid');
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  // Field 3 is state; field 4 is ppid; field 22 is start time after boot in ticks.
  if (
    fields.length < 22 ||
    !/^[A-Za-z]$/.test(fields[0]!) ||
    !/^(0|[1-9][0-9]*)$/.test(fields[1]!) ||
    !/^[1-9][0-9]*$/.test(fields[19]!)
  )
    throw Error('native_process_stat_invalid');
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid > 2147483647)
    throw Error('native_process_stat_invalid');
  return { parentPid, startTicks: fields[19]! };
}

function unavailable(pid: number, reason: string): NativeProcessObservation {
  return {
    collector: 'unavailable',
    pid,
    parentPid: null,
    startIdentity: null,
    fileDescriptors: null,
    unavailable: [reason],
  };
}

function linux(pid: number): NativeProcessObservation {
  // Retain the original proc directory. A reused numeric PID cannot replace this directory FD.
  const directory = openSync(
    `/proc/${pid}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const original = `/proc/self/fd/${directory}`;
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
      throw Error('native_process_boot_invalid');
    const before = parseLinuxProcessStat(readFileSync(`${original}/stat`, 'utf8'), pid);
    const files = readdirSync(`${original}/fd`);
    if (!files.every((entry) => /^(0|[1-9][0-9]*)$/.test(entry)))
      throw Error('native_process_fds_invalid');
    const after = parseLinuxProcessStat(readFileSync(`${original}/stat`, 'utf8'), pid);
    if (before.startTicks !== after.startTicks || before.parentPid !== after.parentPid)
      throw Error('native_process_identity_changed');
    return {
      collector: 'linux-procfs',
      pid,
      parentPid: before.parentPid,
      startIdentity: { kind: 'linux-boot-start-ticks', value: `${bootId}:${before.startTicks}` },
      // Enumeration includes any observer FD actually open in the target, never subtracts a guessed count.
      fileDescriptors: files.length,
      unavailable: [],
    };
  } finally {
    closeSync(directory);
  }
}

let darwinCollector: ((pid: number) => NativeProcessObservation) | undefined;
function createDarwinCollector() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw Error('native_process_platform_unsupported');
  // Fixed public libproc ABI. Import of this module itself does not load a native library.
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const api = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
  });
  const files = new Uint8Array(1024 * 1024);
  const identity = (pid: number) => {
    // Public proc_bsdinfo arm64/x64: pid@12, ppid@16, start sec@120 and microsec@128, sizeof=136.
    const bytes = new Uint8Array(136);
    if (api.symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), bytes.length) !== bytes.length)
      throw Error('native_process_identity_unavailable');
    const view = new DataView(bytes.buffer);
    const seconds = view.getBigUint64(120, true),
      microseconds = view.getBigUint64(128, true);
    if (view.getUint32(12, true) !== pid || seconds === 0n || microseconds >= 1000000n)
      throw Error('native_process_identity_invalid');
    return { value: `${seconds}:${microseconds}`, parentPid: view.getUint32(16, true) };
  };
  return (pid: number): NativeProcessObservation => {
    const before = identity(pid);
    const count = api.symbols.proc_pidinfo(pid, 1, 0, ptr(files), files.length);
    // proc_fdinfo is two 32-bit fields. A full buffer cannot prove that the list was complete.
    if (count <= 0 || count % 8 !== 0 || count >= files.length)
      throw Error('native_process_fds_unavailable');
    const descriptors = new Set<number>(),
      view = new DataView(files.buffer);
    for (let offset = 0; offset < count; offset += 8) {
      const fd = view.getInt32(offset, true);
      if (fd < 0 || descriptors.has(fd)) throw Error('native_process_fds_invalid');
      descriptors.add(fd);
    }
    const after = identity(pid);
    if (before.value !== after.value || before.parentPid !== after.parentPid)
      throw Error('native_process_identity_changed');
    return {
      collector: 'darwin-libproc',
      pid,
      parentPid: before.parentPid,
      startIdentity: { kind: 'darwin-start-time', value: before.value },
      fileDescriptors: descriptors.size,
      unavailable: [],
    };
  };
}

/** Failure is unavailable, never a supported zero or proof that a previously owned process exited. */
export function observeNativeProcess(pid = process.pid): NativeProcessObservation {
  validPid(pid);
  try {
    if (process.platform === 'linux') return linux(pid);
    if (process.platform === 'darwin') {
      darwinCollector ??= createDarwinCollector();
      return darwinCollector(pid);
    }
    return unavailable(pid, 'native_process_platform_unsupported');
  } catch {
    return unavailable(pid, 'native_process_observation_unavailable');
  }
}

export function sameNativeProcess(
  a: NativeProcessObservation,
  b: NativeProcessObservation,
): boolean {
  return (
    a.pid === b.pid &&
    a.startIdentity !== null &&
    b.startIdentity !== null &&
    a.startIdentity.kind === b.startIdentity.kind &&
    a.startIdentity.value === b.startIdentity.value
  );
}

/** Process EventEmitter listeners are introspectable; this is not Bun's stub handle/resource API. */
export function observeProcessListeners(): { listeners: number | null; unavailable: string[] } {
  try {
    const names = process.eventNames();
    if (!Array.isArray(names) || new Set(names).size !== names.length)
      throw Error('process_listener_observation_invalid');
    let total = 0;
    for (const name of names) {
      if (typeof name !== 'string' && typeof name !== 'symbol')
        throw Error('process_listener_observation_invalid');
      const count = process.listenerCount(name);
      if (!Number.isSafeInteger(count) || count < 0 || process.rawListeners(name).length !== count)
        throw Error('process_listener_observation_invalid');
      total += count;
    }
    if (!Number.isSafeInteger(total)) throw Error('process_listener_observation_invalid');
    return { listeners: total, unavailable: [] };
  } catch {
    return { listeners: null, unavailable: ['process_listener_observation_unavailable'] };
  }
}
