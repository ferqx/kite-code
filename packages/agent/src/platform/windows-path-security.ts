import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { WindowsPathSecurity } from './locks';

/** Fixed OS policy; no caller supplied SID, descriptor, DLL or privilege escalation. */
let cached: NativeWindowsPathSecurity | undefined;
export interface NativeWindowsPathSecurity extends WindowsPathSecurity {
  verifyScopeDirectory(path: string): void;
  readScopeFile(path: string, maxBytes: number, privateFile?: boolean): Uint8Array | null;
  writePrivateFile(path: string, bytes: Uint8Array): void;
  createDirectory(path: string): void;
  createFile(path: string): void;
  verifyPath(path: string): void;
  verifyHandle(handle: bigint | number, path: string, directory: boolean): void;
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
      7,
      sd ? ptr(sa) : null,
      create ? 1 : 3,
      0x02200000,
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
  const verifyAcl = (handle: bigint | number, directory: boolean) => {
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
      if (!(control[0]! & 4) || (directory && !(control[0]! & 0x1000))) fail();
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
        (flags & ~0x13) !== 0 ||
        header.getUint32(4, true) !== 0x1f01ff ||
        (directory && (flags & 3) !== 3) ||
        !adv.symbols.EqualSid(pointer(BigInt(address) + 8n), sid)
      )
        fail();
    } finally {
      if (sd[0]) kernel.symbols.LocalFree(pointer(sd[0]));
    }
  };
  const verifyHandle = (
    handle: bigint | number,
    path: string,
    directory: boolean,
    privateObject = true,
  ) => {
    const original = info(handle);
    if (
      original.getUint32(0, true) & 0x400 ||
      !!(original.getUint32(0, true) & 0x10) !== directory ||
      (!directory && original.getUint32(40, true) !== 1)
    )
      fail();
    if (privateObject) verifyAcl(handle, directory);
    const current = open(path, false);
    try {
      if (identity(info(current)) !== identity(original)) fail();
      if (privateObject) verifyAcl(current, directory);
    } finally {
      if (!kernel.symbols.CloseHandle(current)) fail();
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
      api.verifyPath(path);
      const sd = descriptor(false);
      try {
        const handle = open(path, true, sd, 0x40020000, false);
        try {
          const count = new Uint32Array(1);
          let total = 0;
          while (total < bytes.length) {
            if (
              !kernel.symbols.WriteFile(
                handle,
                ptr(bytes.subarray(total)),
                bytes.length - total,
                ptr(count),
                null,
              ) ||
              !count[0] ||
              count[0] > bytes.length - total
            )
              fail();
            total += count[0]!;
          }
          if (!kernel.symbols.FlushFileBuffers(handle)) fail();
          verifyHandle(handle, path, false);
        } finally {
          if (!kernel.symbols.CloseHandle(handle)) fail();
        }
      } finally {
        kernel.symbols.LocalFree(sd);
      }
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
