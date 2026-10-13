/** Private Darwin task accounting, independent of process birth/exec observations. */
export const DARWIN_COALITION_TASK_ABI = 'resource-usage-prefix-16' as const;
const U64 = (1n << 64n) - 1n;
export interface OwnedDarwinCoalitionIdentity {
  pid: number;
  uniqueId: string;
  pidVersion: number;
  coalitionId: string;
}
export interface DarwinCoalitionTaskObservation {
  version: 1;
  abi: typeof DARWIN_COALITION_TASK_ABI;
  identity: OwnedDarwinCoalitionIdentity;
  tasksStarted: string | null;
  tasksExited: string | null;
  unavailable: string[];
  /** Task counts alone never identify or qualify all process births. */
  completeProcessBirths: false;
}
function decimal(value: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value))
    throw Error('coalition_task_identity_invalid');
  const result = BigInt(value);
  if (result > U64) throw Error('coalition_task_identity_invalid');
  return result;
}
export function decodeCoalitionTaskCounters(bytes: Uint8Array, result: number) {
  if (result !== 0) throw Error('coalition_task_counters_unavailable');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16)
    throw Error('coalition_task_counters_invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const started = view.getBigUint64(0, true);
  const exited = view.getBigUint64(8, true);
  // The exactly identified original guardian is still alive on both sides.
  // An untouched sentinel is unknown, not a supported zero or an overflow.
  if (started === 0n || started === U64 || exited === U64 || exited >= started)
    throw Error('coalition_task_counters_invalid');
  return { tasksStarted: String(started), tasksExited: String(exited) };
}
function createCollector() {
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const proc = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
  });
  let system: ReturnType<typeof loadSystem>;
  const loadSystem = () =>
    dlopen('/usr/lib/libSystem.B.dylib', {
      // The fixed libSystem wrapper takes the prefix length by value, not a size pointer.
      coalition_info_resource_usage: { args: ['u64', 'ptr', 'u64'], returns: 'i32' },
    });
  try {
    system = loadSystem();
  } catch (error) {
    proc.close();
    throw error;
  }
  const identify = (expected: OwnedDarwinCoalitionIdentity) => {
    const before = Buffer.alloc(56);
    const coalition = Buffer.alloc(40);
    const after = Buffer.alloc(56);
    if (
      proc.symbols.proc_pidinfo(expected.pid, 17, 0, ptr(before), before.length) !==
        before.length ||
      proc.symbols.proc_pidinfo(expected.pid, 20, 0, ptr(coalition), coalition.length) !==
        coalition.length ||
      proc.symbols.proc_pidinfo(expected.pid, 17, 0, ptr(after), after.length) !== after.length ||
      before.readBigUInt64LE(16) !== after.readBigUInt64LE(16) ||
      before.readInt32LE(32) !== after.readInt32LE(32) ||
      String(before.readBigUInt64LE(16)) !== expected.uniqueId ||
      before.readInt32LE(32) !== expected.pidVersion ||
      String(coalition.readBigUInt64LE(0)) !== expected.coalitionId
    )
      throw Error('coalition_task_identity_changed');
  };
  return (expected: OwnedDarwinCoalitionIdentity) => {
    identify(expected);
    const bytes = new Uint8Array(16).fill(255);
    const result = system.symbols.coalition_info_resource_usage(
      BigInt(expected.coalitionId),
      ptr(bytes),
      bytes.byteLength,
    );
    identify(expected);
    return decodeCoalitionTaskCounters(bytes, result);
  };
}
let collector: ReturnType<typeof createCollector> | undefined;
/** Caller supplies the original live guardian identity; no discovery or numeric PID fallback. */
export function observeOwnedDarwinCoalitionTasks(
  expected: OwnedDarwinCoalitionIdentity,
): DarwinCoalitionTaskObservation {
  if (
    !Number.isSafeInteger(expected.pid) ||
    expected.pid <= 1 ||
    expected.pid > 2147483647 ||
    !Number.isSafeInteger(expected.pidVersion) ||
    expected.pidVersion < 0 ||
    expected.pidVersion > 2147483647
  )
    throw Error('coalition_task_identity_invalid');
  decimal(expected.uniqueId);
  decimal(expected.coalitionId);
  const observation: DarwinCoalitionTaskObservation = {
    version: 1,
    abi: DARWIN_COALITION_TASK_ABI,
    identity: { ...expected },
    tasksStarted: null,
    tasksExited: null,
    unavailable: [],
    completeProcessBirths: false,
  };
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    observation.unavailable.push('coalition_task_platform_unsupported');
    return observation;
  }
  try {
    collector ??= createCollector();
    Object.assign(observation, collector(expected));
  } catch (error) {
    observation.unavailable.push(
      error instanceof Error &&
        ['coalition_task_identity_changed', 'coalition_task_counters_invalid'].includes(
          error.message,
        )
        ? error.message
        : 'coalition_task_counters_unavailable',
    );
  }
  return observation;
}
