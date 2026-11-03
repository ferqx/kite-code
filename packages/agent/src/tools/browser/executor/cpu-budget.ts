import { dlopen, ptr } from 'bun:ffi';
import {
  type OwnedProcessIdentity,
  observeOwnedProcessIdentity,
} from '../../../platform/process/owned-process-observation';

/** Kernel budget and suspension for the exact sandbox root. Lifecycle stays with its guardian. */
export function createExecutorCpuBudget(original: OwnedProcessIdentity) {
  const library = dlopen('/usr/lib/libproc.dylib', {
    proc_pid_rusage: { args: ['i32', 'i32', 'ptr'], returns: 'i32' },
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    proc_signal_with_audittoken: { args: ['ptr', 'i32'], returns: 'i32' },
  });
  let closed = false;
  const clock = dlopen('/usr/lib/libSystem.B.dylib', {
    mach_timebase_info: { args: ['ptr'], returns: 'i32' },
  });
  const timebase = new Uint32Array(2);
  if (clock.symbols.mach_timebase_info(ptr(timebase)) !== 0 || !timebase[0] || !timebase[1]) {
    clock.close();
    library.close();
    throw Error('browser_executor_budget_unavailable');
  }
  const numerator = BigInt(timebase[0]),
    denominator = BigInt(timebase[1]);
  clock.close();
  const matches = () => {
    if (closed) return false;
    const current = observeOwnedProcessIdentity(original.pid);
    return (
      original.birth &&
      current.birth &&
      original.birth.seconds === current.birth.seconds &&
      original.birth.microseconds === current.birth.microseconds
    );
  };
  const status = () => {
    const bytes = Buffer.alloc(136);
    if (
      !matches() ||
      library.symbols.proc_pidinfo(original.pid, 3, 0, ptr(bytes), bytes.length) !== bytes.length ||
      !matches()
    )
      throw Error('browser_executor_budget_unavailable');
    return bytes.readUInt32LE(4);
  };
  const signal = (number: 17 | 19) => {
    const info = Buffer.alloc(56);
    if (
      !matches() ||
      library.symbols.proc_pidinfo(original.pid, 17, 0, ptr(info), info.length) !== info.length ||
      !matches()
    )
      throw Error('browser_executor_control_unavailable');
    const token = new Uint32Array(8);
    token[5] = original.pid;
    token[7] = info.readUInt32LE(32);
    if (
      library.symbols.proc_signal_with_audittoken(ptr(token), number) !== 0 ||
      token[5] !== original.pid ||
      token[7] !== info.readUInt32LE(32)
    )
      throw Error('browser_executor_control_unavailable');
  };
  return {
    isSuspended() {
      return status() === 4;
    },
    async suspend() {
      signal(17);
      const deadline = performance.now() + 1000;
      while (status() !== 4) {
        if (performance.now() >= deadline) throw Error('browser_executor_suspend_unconfirmed');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    resume() {
      signal(19);
    },
    read(): bigint {
      // Darwin SDK rusage_info_v0: uuid[16], then user/system absolute ticks.
      const bytes = Buffer.alloc(96);
      if (
        !matches() ||
        library.symbols.proc_pid_rusage(original.pid, 0, ptr(bytes)) !== 0 ||
        !matches()
      )
        throw Error('browser_executor_budget_unavailable');
      return ((bytes.readBigUInt64LE(16) + bytes.readBigUInt64LE(24)) * numerator) / denominator;
    },
    close() {
      if (!closed) {
        closed = true;
        library.close();
      }
    },
  };
}
