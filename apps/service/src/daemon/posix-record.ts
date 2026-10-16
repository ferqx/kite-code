import { closeSync } from 'node:fs';

// A failed unlock/close must not discard the original descriptor or permit inode cleanup.
const retained = new Map<number, Error>();
const held = new Set<number>();
const waiting = new Int32Array(new SharedArrayBuffer(4));
const fail = (code: string) => Object.assign(Error(code), { code });
let implementation: ReturnType<typeof native> | undefined;
function native() {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw fail('daemon_platform_unsupported');
  // This leaf is also imported by trusted Node hosts; load FFI only for an actual POSIX operation.
  const { dlopen, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  const library = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      flock: { args: ['i32', 'i32'], returns: 'i32' },
      ...(process.platform === 'darwin'
        ? { __error: { args: [], returns: 'ptr' } as const }
        : { __errno_location: { args: [], returns: 'ptr' } as const }),
    },
  );
  return {
    flock: library.symbols.flock,
    errno() {
      const functions = library.symbols;
      const address = '__error' in functions ? functions.__error() : functions.__errno_location();
      if (address === null) throw fail('daemon_reservation_unsafe');
      return new DataView(toArrayBuffer(address, 0, 4)).getInt32(0, true);
    },
  };
}
function retain(fd: number, code: string, error: unknown) {
  const failure = Object.assign(new Error(code, { cause: { fd, error } }), { code });
  retained.set(fd, failure);
  return failure;
}
export function assertPosixRecordUnlocked(fd: number): void {
  const failure = retained.get(fd);
  if (failure) throw failure;
  if (held.has(fd)) throw fail('daemon_endpoint_state');
}
/** Cooperating readers/writers use the original open description; JSON failures are never retried. */
export function withPosixRecordLock<T>(
  fd: number,
  mode: 'shared' | 'exclusive',
  operation: () => T,
  deadline = performance.now() + 5000,
): T {
  assertPosixRecordUnlocked(fd);
  implementation ??= native();
  const api = implementation;
  for (;;) {
    if (performance.now() >= deadline) throw fail('daemon_bootstrap_timeout');
    if (api.flock(fd, (mode === 'shared' ? 1 : 2) | 4) === 0) break;
    if (api.errno() !== (process.platform === 'darwin' ? 35 : 11))
      throw fail('daemon_reservation_unsafe');
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw fail('daemon_bootstrap_timeout');
    Atomics.wait(waiting, 0, 0, Math.min(5, remaining));
  }
  held.add(fd);
  let value: T | undefined,
    failure: unknown,
    failed = false;
  try {
    value = operation();
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    if (api.flock(fd, 8) !== 0) throw fail('daemon_record_unlock_unknown');
    held.delete(fd);
  } catch (error) {
    throw retain(
      fd,
      'daemon_record_unlock_unknown',
      failed ? new AggregateError([failure, error]) : error,
    );
  }
  if (failed) throw failure;
  return value!;
}
export function closePosixRecord(fd: number): void {
  assertPosixRecordUnlocked(fd);
  try {
    closeSync(fd);
  } catch (error) {
    throw retain(fd, 'daemon_record_close_unknown', error);
  }
}
