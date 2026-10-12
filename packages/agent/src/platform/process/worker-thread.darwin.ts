export interface DarwinWorkerThreadRecord {
  readonly platform: 'darwin';
  readonly pid: number;
  readonly threadId: string;
  readonly port: number;
}

const THREAD_IDENTIFIER_INFO = 4;
const THREAD_IDENTIFIER_INFO_COUNT = 6;
const SEND = 0x10000;
const DEAD_NAME = 0x100000;
const maximumThreadId = 0xffffffffffffffffn;

function load() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw Error('worker_thread_platform_unsupported');
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    mach_thread_self: { args: [], returns: 'u32' },
    pthread_threadid_np: { args: ['ptr', 'ptr'], returns: 'i32' },
    task_self_trap: { args: [], returns: 'u32' },
    mach_port_type: { args: ['u32', 'u32', 'ptr'], returns: 'i32' },
    thread_info: { args: ['u32', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    mach_port_deallocate: { args: ['u32', 'u32'], returns: 'i32' },
  });
  return { library, api: library.symbols, ptr };
}
let loaded: ReturnType<typeof load> | undefined;
function native() {
  loaded ??= load();
  return loaded;
}
const validPort = (port: unknown): port is number =>
  Number.isSafeInteger(port) && Number(port) > 0 && Number(port) < 0xffffffff;
function failure(operation: string, result?: number) {
  return Object.assign(Error(`worker_thread_${operation}`), {
    code: `worker_thread_${operation}`,
    ...(result === undefined ? {} : { nativeResult: result }),
  });
}
function identifier(port: number): bigint {
  const { api, ptr } = native();
  // Apple arm64/x64: three uint64 fields; MIG count is in 32-bit natural_t units.
  const info = new BigUint64Array(3);
  const count = new Uint32Array([THREAD_IDENTIFIER_INFO_COUNT]);
  const result = api.thread_info(port, THREAD_IDENTIFIER_INFO, ptr(info), ptr(count));
  if (result !== 0 || count[0] !== THREAD_IDENTIFIER_INFO_COUNT || info[0] === 0n)
    throw failure('identity_unavailable', result);
  return info[0]!;
}

/** Trusted synchronous Worker preload only. The original send right transfers with this record. */
export function captureCurrentWorkerThread(): DarwinWorkerThreadRecord {
  const { api, ptr } = native();
  const port = api.mach_thread_self();
  if (!validPort(port)) throw failure('capture_unavailable');
  try {
    const id = new BigUint64Array(1);
    const result = api.pthread_threadid_np(null, ptr(id));
    if (result !== 0 || id[0] === 0n || identifier(port) !== id[0])
      throw failure('capture_identity_conflict', result);
    return Object.freeze({ platform: 'darwin', pid: process.pid, threadId: String(id[0]), port });
  } catch (error) {
    let task: number | undefined;
    let threadReleased = false;
    try {
      task = api.task_self_trap();
      if (!validPort(task)) throw failure('capture_task_unavailable');
      const threadResult = api.mach_port_deallocate(task, port);
      if (threadResult !== 0) throw failure('capture_thread_release_unknown', threadResult);
      threadReleased = true;
      const taskResult = api.mach_port_deallocate(task, task);
      if (taskResult !== 0) throw failure('capture_task_release_unknown', taskResult);
    } catch (cleanup) {
      // Keep the actual unreleased rights in the error; no numeric reopen or ambiguous retry.
      throw Object.assign(
        new AggregateError([error, cleanup], 'worker_thread_capture_cleanup_unknown'),
        {
          retainedResources: {
            thread: threadReleased ? null : port,
            task: validPort(task) ? task : null,
          },
        },
      );
    }
    throw error;
  }
}

/** Only a record from the actual trusted preload; finite metadata validation is not authority. */
export function retainWorkerThread(record: DarwinWorkerThreadRecord): {
  inspect(): 'alive' | 'terminated';
  release(): void;
} {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(',') !== 'pid,platform,port,threadId' ||
    record.platform !== 'darwin' ||
    record.pid !== process.pid ||
    !validPort(record.port) ||
    typeof record.threadId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(record.threadId) ||
    BigInt(record.threadId) > maximumThreadId
  )
    throw failure('record_invalid');
  const original = Object.freeze({ ...record });
  const { api, ptr } = native();
  const task = api.task_self_trap();
  if (!validPort(task)) throw failure('task_unavailable');
  let terminated = false;
  let threadReleased = false;
  let released = false;
  let releaseFailure: Error | undefined;
  const inspect = (): 'alive' | 'terminated' => {
    if (releaseFailure) throw releaseFailure;
    if (released) throw failure('closed');
    if (terminated) return 'terminated';
    const type = new Uint32Array(1);
    const result = api.mach_port_type(task, original.port, ptr(type));
    if (result !== 0) throw failure('right_unavailable', result);
    // Query failure or HALTED cannot establish death. Only this retained original dead name does.
    if (type[0] === DEAD_NAME) {
      terminated = true;
      return 'terminated';
    }
    if (type[0] !== SEND) throw failure('right_invalid');
    // The retained send right prevents numeric name reuse. SEND is pending even
    // when thread IPC has already been disabled; only its dead name proves termination.
    return 'alive';
  };
  try {
    if (inspect() === 'alive') {
      try {
        if (String(identifier(original.port)) !== original.threadId)
          throw failure('identity_conflict');
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'worker_thread_identity_unavailable' ||
          !('nativeResult' in error) ||
          typeof error.nativeResult !== 'number' ||
          error.nativeResult === 0
        )
          throw error;
        // Trusted self-capture already matched pthread and Mach identity. A native
        // query failure during exit cannot discard that original right or grant death.
      }
    }
  } catch (error) {
    const result = api.mach_port_deallocate(task, task);
    if (result !== 0)
      throw Object.assign(
        new AggregateError(
          [error, failure('retain_task_release_unknown', result)],
          'worker_thread_retain_cleanup_unknown',
        ),
        {
          retainedResources: { original, task },
        },
      );
    // The caller still owns the original record's send right; an invalid binding grants no release.
    throw error;
  }
  return {
    inspect,
    release() {
      if (releaseFailure) throw releaseFailure;
      if (released) return;
      if (inspect() !== 'terminated') throw failure('still_alive');
      try {
        const threadResult = api.mach_port_deallocate(task, original.port);
        if (threadResult !== 0) throw failure('thread_release_unknown', threadResult);
        threadReleased = true;
        const taskResult = api.mach_port_deallocate(task, task);
        if (taskResult !== 0) throw failure('task_release_unknown', taskResult);
        released = true;
      } catch (error) {
        releaseFailure = Object.assign(
          error instanceof Error ? error : failure('release_unknown'),
          {
            retainedResources: { thread: threadReleased ? null : original.port, task, original },
          },
        );
        throw releaseFailure;
      }
    },
  };
}
