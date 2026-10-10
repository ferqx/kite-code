import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { retainWindowsArtifactScope } from './windows-artifact-scope';
import { defaultWindowsPathSecurity } from './windows-path-security';

const pending = new Set<object>();
export interface WindowsPrivateFileRemoval {
  verify(): void;
  remove(): void;
  release(): void;
}
/** Unknown factory closure remains a dependency of the caller's original EX region. */
export class WindowsPrivateFileRemovalAcquireUnknownError extends AggregateError {
  readonly owner: WindowsPrivateFileRemoval;
  constructor(error: unknown, cleanup: unknown, owner: WindowsPrivateFileRemoval) {
    super([error, cleanup], 'windows_private_file_removal_acquire_unknown');
    this.owner = owner;
  }
}
/** A single private record, never recursive deletion. The registration owner retains selection EX. */
export function retainWindowsPrivateFileRemoval(path: string): WindowsPrivateFileRemoval {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_private_file_removal_unsupported');
  if (resolve(path) !== path || realpathSync(path) !== path || dirname(path) === path)
    throw Error('windows_private_file_removal_unknown');
  const security = defaultWindowsPathSecurity()!;
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    SetFileInformationByHandle: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  let scope: ReturnType<typeof retainWindowsArtifactScope> | undefined;
  let handle: bigint | undefined;
  let original: string | undefined;
  let marked = false,
    removed = false,
    released = false,
    kernelClosed = false;
  const denied = (): never => {
    throw Error('windows_private_file_removal_unknown');
  };
  const wide = Buffer.from(`${path}\0`, 'utf16le');
  const stamp = () => {
    if (!handle) return denied();
    const bytes = new Uint8Array(52);
    if (!kernel.symbols.GetFileInformationByHandle(handle, ptr(bytes))) denied();
    const value = new DataView(bytes.buffer);
    if (value.getUint32(0, true) & 0x410 || value.getUint32(40, true) !== 1) denied();
    return [0, 20, 24, 28, 32, 36, 40, 44, 48]
      .map((offset) => value.getUint32(offset, true))
      .join(':');
  };
  const absent = () => {
    if (
      kernel.symbols.GetFileAttributesW(ptr(wide)) !== 0xffffffff ||
      kernel.symbols.GetLastError() !== 2
    )
      denied();
    if (lstatSync(path, { throwIfNoEntry: false })) denied();
  };
  const owner: WindowsPrivateFileRemoval = Object.freeze({
    verify() {
      if (released || marked || !scope || !handle || stamp() !== original) denied();
      scope!.verify();
      security.verifyHandle(handle!, path, false);
      if (stamp() !== original) denied();
    },
    remove() {
      if (removed) return;
      if (released || !scope) denied();
      if (!marked) {
        owner.verify();
        if (!kernel.symbols.SetFileInformationByHandle(handle!, 4, ptr(new Uint8Array([1])), 1))
          denied();
        marked = true;
      }
      if (handle) {
        if (!kernel.symbols.CloseHandle(handle)) denied();
        handle = undefined;
      }
      absent();
      removed = true;
    },
    release() {
      if (released) return;
      // A pending disposition must be confirmed absent before selection can be handed back.
      if (marked) owner.remove();
      if (handle) {
        if (!kernel.symbols.CloseHandle(handle)) denied();
        handle = undefined;
      }
      scope?.release();
      scope = undefined;
      if (!kernelClosed) {
        kernel.close();
        kernelClosed = true;
      }
      released = true;
      pending.delete(owner);
    },
  });
  pending.add(owner);
  try {
    scope = retainWindowsArtifactScope(dirname(path));
    security.verifyDirectory(dirname(path));
    const opened = kernel.symbols.CreateFileW(ptr(wide), 0x30080, 1, null, 3, 0x02200000, 0n);
    if (!opened || opened === 0xffffffffffffffffn) denied();
    handle = opened;
    original = stamp();
    owner.verify();
    return owner;
  } catch (error) {
    try {
      owner.release();
    } catch (cleanup) {
      throw new WindowsPrivateFileRemovalAcquireUnknownError(error, cleanup, owner);
    }
    throw error;
  }
}
