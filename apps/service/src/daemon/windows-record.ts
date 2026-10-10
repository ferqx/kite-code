import { dirname, isAbsolute, resolve } from 'node:path';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import { windowsDaemonSecurity } from './windows-security';

export type WindowsRecordIdentity = { dev: string; ino: string };
// Acquisition failures cannot drop an unconfirmed native HANDLE.
const pending = new Set<() => void>();
const fail = (code = 'daemon_reservation_unsafe'): never => {
  throw Object.assign(Error(code), { code });
};
let implementation: ReturnType<typeof native> | undefined;
const api = () => (implementation ??= native());
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('daemon_platform_unsupported');
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    SetFilePointerEx: { args: ['u64', 'i64', 'ptr', 'u32'], returns: 'bool' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    SetEndOfFile: { args: ['u64'], returns: 'bool' },
    FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    SetFileInformationByHandle: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
    GetLastError: { args: [], returns: 'u32' },
    LockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    UnlockFileEx: { args: ['u64', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  const security = defaultWindowsPathSecurity()!;
  const verifyAcl = windowsDaemonSecurity().verifyPrivateObject;
  const wide = (path: string) => Buffer.from(`${path}\0`, 'utf16le');
  type Held = {
    path: string;
    handle: bigint | number;
    directory: boolean;
    closed: boolean;
    id: WindowsRecordIdentity;
  };
  function metadata(handle: bigint | number, directory: boolean) {
    const bytes = new Uint8Array(52),
      basic = new Uint8Array(40);
    if (
      !kernel.symbols.GetFileInformationByHandle(handle, ptr(bytes)) ||
      !kernel.symbols.GetFileInformationByHandleEx(handle, 0, ptr(basic), basic.length)
    )
      fail();
    const v = new DataView(bytes.buffer);
    if (
      v.getUint32(0, true) & 0x400 ||
      Boolean(v.getUint32(0, true) & 0x10) !== directory ||
      (!directory && v.getUint32(40, true) !== 1)
    )
      fail();
    return {
      id: {
        dev: String(v.getUint32(28, true)),
        ino: String((BigInt(v.getUint32(44, true)) << 32n) | BigInt(v.getUint32(48, true))),
      },
      size: (BigInt(v.getUint32(32, true)) << 32n) | BigInt(v.getUint32(36, true)),
      stamp:
        [0, 4, 8, 20, 24, 32, 36, 40].map((o) => v.getUint32(o, true)).join(':') +
        ':' +
        new DataView(basic.buffer).getBigInt64(24, true),
    };
  }
  const equalId = (a: WindowsRecordIdentity, b: WindowsRecordIdentity) =>
    a.dev === b.dev && a.ino === b.ino;
  const open = (
    path: string,
    access: number,
    share: number,
    creation: number,
    attributes?: Uint8Array,
  ) => {
    const handle = kernel.symbols.CreateFileW(
      ptr(wide(path)),
      access,
      share,
      attributes ? ptr(attributes) : null,
      creation,
      0x02200000,
      0,
    );
    if (!handle || BigInt(handle) === 18446744073709551615n) {
      const error = kernel.symbols.GetLastError();
      if (error === 2 || error === 3) fail('daemon_absent');
      if (error === 80 || error === 183 || error === 32) fail('daemon_endpoint_busy');
      fail();
    }
    return handle;
  };
  function acquire(path: string, kind: 'create' | 'read' | 'remove') {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /\p{Cc}/u.test(path) ||
      path.length > 32760 ||
      dirname(path) === path
    )
      fail('daemon_invalid_endpoint');
    if (kind === 'create') privateDirectory(dirname(path));
    const held: Held[] = [];
    let marked = false,
      removed = false;
    const close = () => {
      const errors: unknown[] = [];
      for (const entry of [...held].reverse())
        if (!entry.closed) {
          if (kernel.symbols.CloseHandle(entry.handle)) entry.closed = true;
          else errors.push(Error('daemon_record_close_unknown'));
        }
      if (errors.length) throw new AggregateError(errors, 'daemon_record_close_unknown');
      locked = undefined;
      pending.delete(close);
    };
    pending.add(close);
    const add = (
      entryPath: string,
      directory: boolean,
      access: number,
      share: number,
      creation = 3,
      attributes?: Uint8Array,
    ) => {
      const handle = open(entryPath, access, share, creation, attributes);
      // Register before any identity or ACL operation can fail.
      const entry: Held = {
        path: entryPath,
        handle,
        directory,
        closed: false,
        id: { dev: '', ino: '' },
      };
      held.push(entry);
      entry.id = metadata(handle, directory).id;
      return entry;
    };
    let file: Held;
    // Synchronous lock requests retain their original OVERLAPPED until confirmed unlock/close.
    let locked: Uint8Array | undefined;
    const lock = (exclusive: boolean) => {
      if (locked || file.closed) fail('daemon_record_lock_unknown');
      const overlap = new Uint8Array(32);
      if (!kernel.symbols.LockFileEx(file.handle, exclusive ? 3 : 1, 0, 16385, 0, ptr(overlap)))
        fail('daemon_endpoint_busy');
      locked = overlap;
    };
    const unlock = () => {
      if (!locked) return;
      if (!kernel.symbols.UnlockFileEx(file.handle, 0, 16385, 0, ptr(locked)))
        fail('daemon_record_unlock_unknown');
      locked = undefined;
    };
    const serialized = <T>(exclusive: boolean, operation: () => T): T => {
      lock(exclusive);
      let value: T, failure: unknown;
      try {
        value = operation();
      } catch (error) {
        failure = error;
      }
      try {
        unlock();
      } catch (cleanup) {
        throw new AggregateError(
          failure ? [failure, cleanup] : [cleanup],
          'daemon_record_unlock_unknown',
        );
      }
      if (failure) throw failure;
      return value!;
    };
    const verify = () => {
      if (marked || removed) fail();
      for (const entry of held) {
        if (entry.closed || !equalId(metadata(entry.handle, entry.directory).id, entry.id)) fail();
        if (!entry.directory || entry.path === dirname(path))
          verifyAcl(entry.handle, entry.directory);
        security.verifyPath(entry.path);
        const probe = add(entry.path, entry.directory, 0x20080, 7);
        if (!equalId(probe.id, entry.id)) fail();
        if (!entry.directory || entry.path === dirname(path))
          verifyAcl(probe.handle, probe.directory);
        if (!kernel.symbols.CloseHandle(probe.handle)) fail('daemon_record_close_unknown');
        probe.closed = true;
        held.pop();
      }
    };
    const seek = () => {
      if (!kernel.symbols.SetFilePointerEx(file.handle, 0, null, 0)) fail();
    };
    const readOriginal = () => {
      verify();
      const before = metadata(file.handle, false);
      if (before.size < 1n || before.size > 16384n) fail('daemon_reservation_oversized');
      seek();
      const result = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < result.length) {
        const count = new Uint32Array(1),
          part = result.subarray(offset);
        if (
          !kernel.symbols.ReadFile(file.handle, ptr(part), part.length, ptr(count), null) ||
          !count[0] ||
          count[0]! > part.length
        )
          fail();
        offset += count[0]!;
      }
      const eof = new Uint8Array(1),
        count = new Uint32Array(1);
      if (!kernel.symbols.ReadFile(file.handle, ptr(eof), 1, ptr(count), null) || count[0] !== 0)
        fail();
      verify();
      if (metadata(file.handle, false).stamp !== before.stamp) fail('daemon_endpoint_drift');
      return result;
    };
    const read = () => serialized(false, readOriginal);
    const publish = (bytes: Uint8Array) =>
      serialized(true, () => {
        if (kind !== 'create' || !bytes.length || bytes.length > 16384) fail();
        verify();
        seek();
        let offset = 0;
        while (offset < bytes.length) {
          const count = new Uint32Array(1),
            part = bytes.subarray(offset);
          if (
            !kernel.symbols.WriteFile(file.handle, ptr(part), part.length, ptr(count), null) ||
            !count[0] ||
            count[0]! > part.length
          )
            fail('daemon_reservation_write_failed');
          offset += count[0]!;
        }
        if (
          !kernel.symbols.SetEndOfFile(file.handle) ||
          !kernel.symbols.FlushFileBuffers(file.handle)
        )
          fail('daemon_reservation_write_failed');
        verify();
        if (!Buffer.from(readOriginal()).equals(Buffer.from(bytes))) fail('daemon_endpoint_drift');
      });
    try {
      const paths: string[] = [];
      for (let current = dirname(path); ; current = dirname(current)) {
        if (paths.length >= 256) fail();
        paths.unshift(current);
        if (dirname(current) === current) break;
      }
      for (const parent of paths)
        add(parent, true, parent === dirname(path) && kind !== 'read' ? 0x200a0 : 0x20080, 3);
      if (kind === 'create') {
        const descriptor = windowsDaemonSecurity().descriptor(false);
        try {
          file = add(path, false, 0xc0030080, 1, 1, descriptor.attributes);
        } finally {
          descriptor.close();
        }
      } else
        file = add(path, false, kind === 'read' ? 0x80020080 : 0x80030080, kind === 'read' ? 7 : 1);
      verify();
    } catch (error) {
      try {
        close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'daemon_record_close_unknown');
      }
      throw error;
    }
    return {
      identity: Object.freeze({ ...file.id }),
      read,
      publish,
      close,
      remove(expectedBytes: Uint8Array) {
        if (removed) return;
        if (kind === 'read') fail();
        if (!marked) {
          lock(true);
          try {
            if (!Buffer.from(readOriginal()).equals(Buffer.from(expectedBytes)))
              fail('daemon_endpoint_drift');
            if (
              !kernel.symbols.SetFileInformationByHandle(
                file.handle,
                4,
                ptr(new Uint8Array([1])),
                1,
              )
            )
              fail();
            marked = true;
          } catch (error) {
            try {
              unlock();
            } catch (cleanup) {
              throw new AggregateError([error, cleanup], 'daemon_record_unlock_unknown');
            }
            throw error;
          }
        }
        if (!file.closed) {
          if (!kernel.symbols.CloseHandle(file.handle)) fail('daemon_record_close_unknown');
          file.closed = true;
        }
        if (
          kernel.symbols.GetFileAttributesW(ptr(wide(path))) !== 0xffffffff ||
          ![2, 3].includes(kernel.symbols.GetLastError())
        )
          fail('daemon_endpoint_drift');
        removed = true;
      },
    };
  }
  return { acquire };
}
export function reserveWindowsDaemonRecord(path: string, initial: Uint8Array) {
  if (!initial.length || initial.length > 16384) fail('daemon_reservation_oversized');
  const owner = api().acquire(path, 'create');
  try {
    owner.publish(initial);
    return owner;
  } catch (error) {
    try {
      owner.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'daemon_record_close_unknown');
    }
    throw error;
  }
}
export function readWindowsDaemonRecord(
  path: string,
): { bytes: Uint8Array; identity: WindowsRecordIdentity } | undefined {
  let owner: ReturnType<ReturnType<typeof native>['acquire']>;
  try {
    owner = api().acquire(path, 'read');
  } catch (error) {
    if ((error as { code?: string }).code === 'daemon_absent') return;
    throw error;
  }
  let failure: unknown;
  let result: { bytes: Uint8Array; identity: WindowsRecordIdentity } | undefined;
  try {
    result = { bytes: owner.read(), identity: owner.identity };
  } catch (error) {
    failure = error;
  }
  try {
    owner.close();
  } catch (cleanup) {
    throw new AggregateError(
      failure ? [failure, cleanup] : [cleanup],
      'daemon_record_close_unknown',
    );
  }
  if (failure) throw failure;
  return result!;
}

export function removeWindowsDaemonRecord(
  path: string,
  expectedBytes: Uint8Array,
  expectedIdentity: WindowsRecordIdentity,
): void {
  const owner = api().acquire(path, 'remove');
  let failure: unknown;
  try {
    if (owner.identity.dev !== expectedIdentity.dev || owner.identity.ino !== expectedIdentity.ino)
      fail('daemon_endpoint_drift');
    owner.remove(expectedBytes);
  } catch (error) {
    failure = error;
  }
  try {
    owner.close();
  } catch (cleanup) {
    throw new AggregateError(
      failure ? [failure, cleanup] : [cleanup],
      'daemon_record_close_unknown',
    );
  }
  if (failure) throw failure;
}
