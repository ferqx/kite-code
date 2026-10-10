import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { WindowsPathSecurity } from './locks';
import { retainWindowsCandidateFiles } from './windows-candidate-files';

/** Fixed OS policy; no caller supplied SID, descriptor, DLL or privilege escalation. */
let cached: NativeWindowsPathSecurity | undefined;
export interface WindowsPrivateRead {
  verify(): void;
  close(): void;
}
export interface NativeWindowsPathSecurity extends WindowsPathSecurity {
  verifyScopeDirectory(path: string): void;
  readScopeFile(path: string, maxBytes: number, privateFile?: boolean): Uint8Array | null;
  writePrivateFile(path: string, bytes: Uint8Array): void;
  writePrivateArtifactFile(path: string, bytes: Uint8Array): void;
  copyPrivateFile(source: string, target: string): void;
  createDirectory(path: string): void;
  createFile(path: string): void;
  verifyPath(path: string): void;
  verifyHandle(handle: bigint | number, path: string, directory: boolean): void;
  retainPrivateFile(path: string): WindowsPrivateRead;
  retainReadOnlyFile(path: string): WindowsPrivateRead;
  syncPrivateFile(path: string): void;
  movePrivateEntry(source: string, target: string, replace?: boolean): void;
}
export function defaultWindowsPathSecurity(): NativeWindowsPathSecurity | undefined {
  if (process.platform !== 'win32') return undefined;
  cached ??= createNativeWindowsPathSecurity();
  return cached;
}
export function privateDirectory(path: string, security?: WindowsPathSecurity): void {
  if (process.platform !== 'win32') {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  const native = defaultWindowsPathSecurity()!;
  const requested = resolve(path);
  const missing: string[] = [];
  let current = requested;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) throw Error('windows_path_security_denied');
    current = parent;
  }
  // Existing system ancestors need not have our application DACL, but no reparse path is accepted.
  native.verifyPath(current);
  for (const entry of missing) native.createDirectory(entry);
  native.verifyDirectory(requested);
  if (security && security !== native) security.verifyDirectory(requested);
}

interface Implementation extends NativeWindowsPathSecurity {
  verifyPath(path: string): void;
}
function createNativeWindowsPathSecurity(): Implementation {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_path_security_platform_unsupported');
  // Deliberately lazy: importing this module in Node/POSIX never imports bun:ffi or loads a DLL.
  const { dlopen, ptr, toArrayBuffer, CString } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CreateDirectoryW: { args: ['ptr', 'ptr'], returns: 'bool' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['ptr'], returns: 'ptr' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    MoveFileExW: { args: ['ptr', 'ptr', 'u32'], returns: 'bool' },
  });
  const system = new Uint16Array(32768);
  const systemLength = kernel.symbols.GetSystemDirectoryW(ptr(system), system.length);
  if (!systemLength || systemLength >= system.length) throw Error('windows_path_security_denied');
  const systemPath = Buffer.from(system.buffer, 0, systemLength * 2).toString('utf16le');
  const adv = dlopen(`${systemPath}\\advapi32.dll`, {
    OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
    GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
    ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'bool' },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ['ptr', 'u32', 'ptr', 'ptr'],
      returns: 'bool',
    },
    GetSecurityInfo: {
      args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'u32',
    },
    GetSecurityDescriptorControl: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
    EqualSid: { args: ['ptr', 'ptr'], returns: 'bool' },
    GetAce: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
  });
  const fail = (): never => {
    throw Error('windows_path_security_denied');
  };
  const out = () => new BigUint64Array(1);
  const pointer = (value: bigint): import('bun:ffi').Pointer => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) return fail();
    return number as import('bun:ffi').Pointer;
  };
  const wide = (path: string) => {
    if (!path || path.includes('\0') || path.length > 32760) return fail();
    return Buffer.from(`${path}\0`, 'utf16le');
  };
  const token = out();
  if (!adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(token))) fail();
  let user: Uint8Array;
  let sid: import('bun:ffi').Pointer;
  let sidText: string;
  try {
    const size = new Uint32Array(1);
    adv.symbols.GetTokenInformation(token[0]!, 1, null, 0, ptr(size));
    if (!size[0] || size[0] > 65536) fail();
    user = new Uint8Array(size[0]!);
    if (!adv.symbols.GetTokenInformation(token[0]!, 1, ptr(user), user.length, ptr(size))) fail();
    sid = pointer(new DataView(user.buffer).getBigUint64(0, true));
    const text = out();
    if (!adv.symbols.ConvertSidToStringSidA(sid, ptr(text))) fail();
    try {
      sidText = new CString(pointer(text[0]!)).toString();
    } finally {
      kernel.symbols.LocalFree(pointer(text[0]!));
    }
    if (!/^S-1-(?:\d+-)*\d+$/.test(sidText)) fail();
  } finally {
    if (!kernel.symbols.CloseHandle(token[0]!)) fail();
  }
  const descriptor = (directory: boolean) => {
    const value = out();
    const sddl = wide(`O:${sidText}D:P(A;${directory ? 'OICI' : ''};FA;;;${sidText})`);
    if (
      !adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        ptr(sddl),
        1,
        ptr(value),
        null,
      )
    )
      fail();
    return pointer(value[0]!);
  };
  const invalid = 18446744073709551615n;
  const open = (
    path: string,
    create: boolean,
    sd?: import('bun:ffi').Pointer,
    access = 0x20000,
    reuse = true,
    share = 7,
    flags = 0x02200000,
  ): bigint | number => {
    const sa = new Uint8Array(24);
    if (sd) {
      const view = new DataView(sa.buffer);
      view.setUint32(0, 24, true);
      view.setBigUint64(8, BigInt(sd), true);
    }
    const handle = kernel.symbols.CreateFileW(
      ptr(wide(path)),
      access,
      share,
      sd ? ptr(sa) : null,
      create ? 1 : 3,
      flags,
      0,
    );
    if (!handle || BigInt(handle) === invalid) {
      const error = kernel.symbols.GetLastError();
      if (create && reuse && (error === 80 || error === 183)) return open(path, false);
      fail();
    }
    return handle;
  };
  const info = (handle: bigint | number) => {
    const bytes = new Uint8Array(52);
    if (!kernel.symbols.GetFileInformationByHandle(handle, ptr(bytes))) fail();
    return new DataView(bytes.buffer);
  };
  const identity = (value: DataView) =>
    `${value.getUint32(28, true)}:${value.getUint32(44, true)}:${value.getUint32(48, true)}`;
  const verifyAcl = (handle: bigint | number, directory: boolean, readOnly = false) => {
    const owner = out(),
      dacl = out(),
      sd = out();
    if (adv.symbols.GetSecurityInfo(handle, 1, 5, ptr(owner), null, ptr(dacl), null, ptr(sd)) !== 0)
      fail();
    try {
      if (!owner[0] || !dacl[0] || !adv.symbols.EqualSid(pointer(owner[0]), sid)) fail();
      const control = new Uint16Array(1),
        revision = new Uint32Array(1);
      if (!adv.symbols.GetSecurityDescriptorControl(pointer(sd[0]!), ptr(control), ptr(revision)))
        fail();
      if (!(control[0]! & 4) || ((directory || readOnly) && !(control[0]! & 0x1000))) fail();
      const acl = new DataView(toArrayBuffer(pointer(dacl[0]!), 0, 8));
      if (acl.getUint16(4, true) !== 1) fail();
      const ace = out();
      if (!adv.symbols.GetAce(pointer(dacl[0]!), 0, ptr(ace))) fail();
      const address = pointer(ace[0]!);
      const header = new DataView(toArrayBuffer(address, 0, 8));
      const flags = header.getUint8(1);
      if (
        header.getUint8(0) !== 0 ||
        header.getUint16(2, true) < 12 ||
        (readOnly ? flags !== 0 : (flags & ~0x13) !== 0) ||
        header.getUint32(4, true) !== (readOnly ? 0x120089 : 0x1f01ff) ||
        (directory && (flags & 3) !== 3) ||
        !adv.symbols.EqualSid(pointer(BigInt(address) + 8n), sid)
      )
        fail();
    } finally {
      if (sd[0]) kernel.symbols.LocalFree(pointer(sd[0]));
    }
  };
  const unclosedVerificationHandles = new Set<bigint | number>();
  const verifyHandle = (
    handle: bigint | number,
    path: string,
    directory: boolean,
    privateObject = true,
    readOnly = false,
  ) => {
    const original = info(handle);
    if (
      original.getUint32(0, true) & 0x400 ||
      !!(original.getUint32(0, true) & 0x10) !== directory ||
      (!directory && original.getUint32(40, true) !== 1)
    )
      fail();
    if (privateObject) verifyAcl(handle, directory, readOnly);
    const current = open(path, false);
    try {
      if (identity(info(current)) !== identity(original)) fail();
      if (privateObject) verifyAcl(current, directory, readOnly);
    } finally {
      if (!kernel.symbols.CloseHandle(current)) {
        unclosedVerificationHandles.add(current);
        fail();
      }
      unclosedVerificationHandles.delete(current);
    }
  };
  const verify = (path: string, directory: boolean, privateObject = true) => {
    api.verifyPath(path);
    const handle = open(path, false);
    try {
      verifyHandle(handle, path, directory, privateObject);
    } finally {
      if (!kernel.symbols.CloseHandle(handle)) fail();
    }
  };
  type Held = { path: string; handle: bigint | number; directory: boolean };
  const ownedTransfers = new Set<Held[]>();
  const closeHeld = (held: Held[]) => {
    let error: unknown;
    for (let index = held.length - 1; index >= 0; index--) {
      if (kernel.symbols.CloseHandle(held[index]!.handle)) held.splice(index, 1);
      else error ??= Error('windows_path_security_close_failed');
    }
    if (error) throw error;
    ownedTransfers.delete(held);
  };
  const retainParents = (paths: string[], held: Held[]) => {
    const parents = new Set<string>();
    for (const path of paths) {
      const chain: string[] = [];
      for (let current = dirname(path); ; ) {
        chain.unshift(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const entry of chain) {
        if (parents.has(entry)) continue;
        const handle = open(entry, false, undefined, 0x20080, false, 3);
        held.push({ path: entry, handle, directory: true });
        parents.add(entry);
        verifyHandle(handle, entry, true, false);
      }
    }
  };
  const retain = (path: string, readOnly: boolean): WindowsPrivateRead => {
    path = resolve(path);
    api.verifyPath(path);
    api.verifyDirectory(dirname(path));
    const held: Held[] = [];
    ownedTransfers.add(held);
    const close = () => closeHeld(held);
    try {
      retainParents([path], held);
      // Deny new write and delete opens while a Node/Bun descriptor reads the pinned file.
      // Parent handles deny rename; no caller receives or supplies a native HANDLE.
      const handle = open(path, false, undefined, 0x80020000, false, 1);
      held.push({ path, handle, directory: false });
      verifyHandle(handle, path, false, true, readOnly);
      const original = info(handle);
      const stamp = (value: DataView) =>
        [0, 4, 8, 20, 24, 28, 32, 36, 40, 44, 48].map((offset) => value.getUint32(offset, true));
      const expected = stamp(original).join(':');
      return Object.freeze({
        verify() {
          if (!held.some((entry) => entry.handle === handle)) fail();
          for (const entry of held)
            verifyHandle(entry.handle, entry.path, entry.directory, !entry.directory, readOnly);
          api.verifyDirectory(dirname(path));
          if (stamp(info(handle)).join(':') !== expected) fail();
        },
        close,
      });
    } catch (error) {
      try {
        close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'windows_path_security_close_failed');
      }
      throw error;
    }
  };
  const writeChunks = (handle: bigint | number, bytes: Uint8Array) => {
    const count = new Uint32Array(1);
    let total = 0;
    while (total < bytes.length) {
      const chunk = bytes.subarray(total, Math.min(bytes.length, total + 65536));
      if (
        !kernel.symbols.WriteFile(handle, ptr(chunk), chunk.length, ptr(count), null) ||
        !count[0] ||
        count[0] > chunk.length
      )
        fail();
      total += count[0]!;
    }
  };
  const transfer = (target: string, provide: (handle: bigint | number, held: Held[]) => void) => {
    target = resolve(target);
    api.verifyPath(target);
    api.verifyDirectory(dirname(target));
    const held: Held[] = [];
    ownedTransfers.add(held);
    let failure: unknown;
    try {
      retainParents([target], held);
      const sd = descriptor(false);
      let handle: bigint | number;
      try {
        handle = open(target, true, sd, 0x40020080, false, 1);
      } finally {
        kernel.symbols.LocalFree(sd);
      }
      held.push({ path: target, handle, directory: false });
      verifyHandle(handle, target, false);
      const original = identity(info(handle));
      provide(handle, held);
      if (!kernel.symbols.FlushFileBuffers(handle)) fail();
      if (identity(info(handle)) !== original) fail();
      verifyHandle(handle, target, false);
      api.verifyDirectory(dirname(target));
      for (const parent of held.filter((entry) => entry.directory))
        verifyHandle(parent.handle, parent.path, true, false);
    } catch (error) {
      failure = error;
    }
    try {
      closeHeld(held);
    } catch (cleanupError) {
      throw new AggregateError(
        failure ? [failure, cleanupError] : [cleanupError],
        'windows_path_security_close_failed',
      );
    }
    if (failure) throw failure;
  };
  const api: Implementation = {
    verifyPath(path) {
      let current = resolve(path);
      for (;;) {
        if (existsSync(current)) {
          const handle = open(current, false);
          try {
            if (info(handle).getUint32(0, true) & 0x400) fail();
          } finally {
            if (!kernel.symbols.CloseHandle(handle)) fail();
          }
          if (lstatSync(current).isSymbolicLink()) fail();
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    },
    verifyScopeDirectory(path) {
      verify(path, true, false);
    },
    readScopeFile(path, maxBytes, privateFile = false) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8388608) fail();
      api.verifyPath(path);
      if (!existsSync(path)) {
        try {
          lstatSync(path);
          fail();
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        return null;
      }
      const handle = open(path, false, undefined, 0x80020000);
      try {
        verifyHandle(handle, path, false, privateFile);
        const size = info(handle);
        if (size.getUint32(32, true) || size.getUint32(36, true) > maxBytes)
          throw Error('windows_path_size_limit');
        const buffer = new Uint8Array(maxBytes + 1),
          count = new Uint32Array(1);
        let total = 0;
        while (total <= maxBytes) {
          if (
            !kernel.symbols.ReadFile(
              handle,
              ptr(buffer.subarray(total)),
              buffer.length - total,
              ptr(count),
              null,
            )
          )
            fail();
          if (!count[0]) break;
          if (count[0] > buffer.length - total) fail();
          total += count[0];
        }
        if (total > maxBytes) throw Error('windows_path_size_limit');
        api.verifyPath(path);
        verifyHandle(handle, path, false, privateFile);
        return buffer.slice(0, total);
      } finally {
        if (!kernel.symbols.CloseHandle(handle)) fail();
      }
    },
    writePrivateFile(path, bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length > 8388608) fail();
      transfer(path, (handle) => {
        writeChunks(handle, bytes);
        const actual = info(handle);
        if (actual.getUint32(32, true) || actual.getUint32(36, true) !== bytes.length) fail();
      });
    },
    writePrivateArtifactFile(path, bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length > 1024 * 1024 * 1024) fail();
      transfer(path, (handle) => {
        writeChunks(handle, bytes);
        const actual = info(handle);
        if (actual.getUint32(32, true) || actual.getUint32(36, true) !== bytes.length) fail();
      });
    },
    copyPrivateFile(source, target) {
      source = resolve(source);
      target = resolve(target);
      if (source === target) fail();
      const sourcePin = retainWindowsCandidateFiles(dirname(source), [basename(source)]);
      let failure: unknown;
      try {
        transfer(target, (output, held) => {
          retainParents([source], held);
          const input = open(source, false, undefined, 0x80020080, false, 1);
          held.push({ path: source, handle: input, directory: false });
          verifyHandle(input, source, false, false);
          const before = info(input);
          const stamp = (value: DataView) =>
            [0, 4, 8, 20, 24, 28, 32, 36, 40, 44, 48]
              .map((offset) => value.getUint32(offset, true))
              .join(':');
          const original = stamp(before);
          const expected =
            (BigInt(before.getUint32(32, true)) << 32n) | BigInt(before.getUint32(36, true));
          const bytes = new Uint8Array(65536),
            count = new Uint32Array(1);
          let total = 0n;
          for (;;) {
            if (
              !kernel.symbols.ReadFile(input, ptr(bytes), bytes.length, ptr(count), null) ||
              count[0]! > bytes.length
            )
              fail();
            if (!count[0]) break;
            writeChunks(output, bytes.subarray(0, count[0]));
            total += BigInt(count[0]);
          }
          if (total !== expected || stamp(info(input)) !== original) fail();
          const written = info(output);
          if (
            ((BigInt(written.getUint32(32, true)) << 32n) | BigInt(written.getUint32(36, true))) !==
            expected
          )
            fail();
          verifyHandle(input, source, false, false);
          sourcePin.verify();
        });
      } catch (error) {
        failure = error;
      }
      try {
        sourcePin.release();
      } catch (cleanupError) {
        throw new AggregateError(
          failure ? [failure, cleanupError] : [cleanupError],
          'windows_path_security_close_failed',
        );
      }
      if (failure) throw failure;
    },
    verifyDirectory(path) {
      verify(path, true);
    },
    verifyFile(path) {
      verify(path, false);
    },
    // Verification only: never repair an existing object's ACL into apparent safety.
    secureFile(path) {
      verify(path, false);
    },
    verifyHandle,
    retainPrivateFile(path) {
      return retain(path, false);
    },
    retainReadOnlyFile(path) {
      return retain(path, true);
    },
    syncPrivateFile(path) {
      api.verifyPath(path);
      const handle = open(path, false, undefined, 0xc0020000, false, 7, 0x82200000);
      try {
        verifyHandle(handle, path, false);
        if (!kernel.symbols.FlushFileBuffers(handle)) fail();
        verifyHandle(handle, path, false);
      } finally {
        if (!kernel.symbols.CloseHandle(handle)) fail();
      }
    },
    movePrivateEntry(source, target, replace = false) {
      source = resolve(source);
      target = resolve(target);
      api.verifyPath(source);
      api.verifyPath(target);
      const held: Held[] = [];
      ownedTransfers.add(held);
      try {
        retainParents([source, target], held);
        api.verifyDirectory(dirname(source));
        api.verifyDirectory(dirname(target));
        const directory = lstatSync(source).isDirectory();
        // This source handle allows our own rename; parent handles still deny ancestor
        // replacement. The published path must identify this original source object.
        const handle = open(source, false);
        held.push({ path: source, handle, directory });
        verifyHandle(handle, source, directory);
        if (existsSync(target)) {
          if (!replace || directory) fail();
          api.verifyFile(target);
        }
        const from = wide(source),
          to = wide(target);
        // No COPY_ALLOWED or delayed reboot: only a synchronous same-volume publication.
        if (!kernel.symbols.MoveFileExW(ptr(from), ptr(to), 8 | (replace ? 1 : 0))) fail();
        verifyHandle(handle, target, directory);
        for (const parent of held.slice(0, -1))
          verifyHandle(parent.handle, parent.path, true, false);
      } finally {
        closeHeld(held);
      }
    },
    createDirectory(path) {
      const sd = descriptor(true),
        sa = new Uint8Array(24);
      const view = new DataView(sa.buffer);
      view.setUint32(0, 24, true);
      view.setBigUint64(8, BigInt(sd), true);
      try {
        if (
          !kernel.symbols.CreateDirectoryW(ptr(wide(path)), ptr(sa)) &&
          kernel.symbols.GetLastError() !== 183
        )
          fail();
      } finally {
        kernel.symbols.LocalFree(sd);
      }
      verify(path, true);
    },
    createFile(path) {
      const sd = descriptor(false);
      try {
        const handle = open(path, true, sd);
        try {
          verifyHandle(handle, path, false);
        } finally {
          if (!kernel.symbols.CloseHandle(handle)) fail();
        }
      } finally {
        kernel.symbols.LocalFree(sd);
      }
    },
  };
  // Keep token SID storage alive for EqualSid throughout this fixed process policy.
  Object.defineProperty(api, 'tokenStorage', { value: user });
  return Object.freeze(api);
}
