import { dirname, join, resolve } from 'node:path';

export interface WindowsArtifactScope {
  verify(): void;
  release(): void;
}

/** Public candidate directories are readable assets, not private Profile objects. */
let backend:
  | ((root: string, relativeFiles?: readonly string[]) => WindowsArtifactScope)
  | undefined;
export function retainWindowsArtifactScope(root: string): WindowsArtifactScope {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('artifact_scope_platform_unsupported');
  backend ??= createBackend();
  return backend(root);
}
/** Internal shared native policy; callers must supply canonical manifest-relative paths. */
export function retainWindowsArtifactObjects(
  root: string,
  relativeFiles: readonly string[],
): WindowsArtifactScope {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('artifact_scope_platform_unsupported');
  backend ??= createBackend();
  return backend(root, relativeFiles);
}
function createBackend(): (
  root: string,
  relativeFiles?: readonly string[],
) => WindowsArtifactScope {
  const { dlopen, ptr, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    GetFinalPathNameByHandleW: { args: ['u64', 'ptr', 'u32', 'u32'], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['ptr'], returns: 'ptr' },
  });
  const fail = (): never => {
    throw Error('artifact_scope_denied');
  };
  const pointer = (value: bigint): import('bun:ffi').Pointer => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) return fail();
    return number as import('bun:ffi').Pointer;
  };
  const wide = (path: string) => {
    if (!path || path.includes('\0') || path.length > 32760) return fail();
    return Buffer.from(`${path}\0`, 'utf16le');
  };
  const out = () => new BigUint64Array(1);
  let closeAdv = () => {};
  try {
    const system = new Uint16Array(32768);
    const size = kernel.symbols.GetSystemDirectoryW(ptr(system), system.length);
    if (!size || size >= system.length) fail();
    const systemPath = Buffer.from(system.buffer, 0, size * 2).toString('utf16le');
    const adv = dlopen(`${systemPath}\\advapi32.dll`, {
      OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
      GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
      GetSecurityInfo: {
        args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
        returns: 'u32',
      },
      GetSecurityDescriptorControl: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
      GetAce: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
      EqualSid: { args: ['ptr', 'ptr'], returns: 'bool' },
      IsWellKnownSid: { args: ['ptr', 'u32'], returns: 'bool' },
      IsValidSid: { args: ['ptr'], returns: 'bool' },
      GetLengthSid: { args: ['ptr'], returns: 'u32' },
    });
    closeAdv = () => adv.close();
    const token = out();
    if (!adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(token))) fail();
    let user: Uint8Array;
    let sid: import('bun:ffi').Pointer;
    try {
      const bytes = new Uint32Array(1);
      adv.symbols.GetTokenInformation(token[0]!, 1, null, 0, ptr(bytes));
      if (!bytes[0] || bytes[0] > 65536) fail();
      user = new Uint8Array(bytes[0]!);
      if (!adv.symbols.GetTokenInformation(token[0]!, 1, ptr(user), user.length, ptr(bytes)))
        fail();
      sid = pointer(new DataView(user.buffer).getBigUint64(0, true));
      if (!adv.symbols.IsValidSid(sid)) fail();
    } finally {
      if (!kernel.symbols.CloseHandle(token[0]!)) fail();
    }
    const open = (path: string, strict = false): bigint | number => {
      // READ_CONTROL | FILE_READ_ATTRIBUTES; deny delete sharing through the whole ancestry.
      const handle = kernel.symbols.CreateFileW(
        ptr(wide(path)),
        0x20080,
        strict ? 1 : 3,
        null,
        3,
        0x02200000,
        0,
      );
      if (!handle || BigInt(handle) === 18446744073709551615n) fail();
      return handle;
    };
    const info = (handle: bigint | number, file = false, full = false) => {
      const bytes = new Uint8Array(52);
      if (!kernel.symbols.GetFileInformationByHandle(handle, ptr(bytes))) fail();
      const value = new DataView(bytes.buffer);
      const attributes = value.getUint32(0, true);
      if (attributes & 0x400 || !!(attributes & 0x10) === file) fail();
      if (file && value.getUint32(40, true) !== 1) fail();
      // LastAccessTime (12..19) may change during legitimate code reads.
      // Attributes, creation/write times, volume, size, link count and FileID remain pinned.
      if (full) return Buffer.concat([bytes.subarray(0, 12), bytes.subarray(20)]).toString('hex');
      return `${value.getUint32(28, true)}:${value.getUint32(44, true)}:${value.getUint32(48, true)}`;
    };
    const acl = (handle: bigint | number) => {
      const owner = out(),
        dacl = out(),
        descriptor = out();
      if (
        adv.symbols.GetSecurityInfo(
          handle,
          1,
          5,
          ptr(owner),
          null,
          ptr(dacl),
          null,
          ptr(descriptor),
        ) !== 0
      )
        fail();
      try {
        if (!owner[0] || !dacl[0] || !adv.symbols.EqualSid(pointer(owner[0]), sid)) fail();
        const control = new Uint16Array(1),
          revision = new Uint32Array(1);
        if (
          !adv.symbols.GetSecurityDescriptorControl(
            pointer(descriptor[0]!),
            ptr(control),
            ptr(revision),
          ) ||
          !(control[0]! & 4)
        )
          fail();
        const header = new DataView(toArrayBuffer(pointer(dacl[0]!), 0, 8));
        const aclSize = header.getUint16(2, true),
          count = header.getUint16(4, true);
        if (aclSize < 8 || count > 4096) fail();
        for (let index = 0; index < count; index++) {
          const entry = out();
          if (!adv.symbols.GetAce(pointer(dacl[0]!), index, ptr(entry))) fail();
          const address = pointer(entry[0]!);
          const offset = address - pointer(dacl[0]!);
          if (offset < 8 || offset + 8 > aclSize) fail();
          const ace = new DataView(toArrayBuffer(address, 0, 8));
          const type = ace.getUint8(0),
            flags = ace.getUint8(1),
            length = ace.getUint16(2, true);
          if (
            (type !== 0 && type !== 1) ||
            flags & ~0x1f ||
            length < 16 ||
            offset + length > aclSize
          )
            fail();
          const principal = pointer(BigInt(address) + 8n);
          if (
            !adv.symbols.IsValidSid(principal) ||
            adv.symbols.GetLengthSid(principal) > length - 8
          )
            fail();
          if (type === 1) continue; // Denials never compensate an unsafe allow grant.
          const mask = ace.getUint32(4, true);
          const privileged =
            adv.symbols.EqualSid(principal, sid) ||
            adv.symbols.IsWellKnownSid(principal, 22) ||
            adv.symbols.IsWellKnownSid(principal, 26);
          // FR/FX plus GENERIC_READ/GENERIC_EXECUTE only for every other principal.
          // Also inspect inherit-only grants: they must not create unsafe descendants.
          if (!privileged && (mask & ~0xa01200a9) !== 0) fail();
        }
      } finally {
        if (descriptor[0]) kernel.symbols.LocalFree(pointer(descriptor[0]));
      }
    };
    // Failed CloseHandle retains the owned collection for retry/diagnosis; DLLs remain live.
    const owned = new Set<object>();
    return (root, relativeFiles) => {
      const entries: {
        path: string;
        handle: bigint | number;
        identity: string;
        closed: boolean;
        file?: boolean;
        strict?: boolean;
        checked?: boolean;
      }[] = [];
      if (relativeFiles) owned.add(entries);
      const close = () => {
        let failure = false;
        for (const entry of [...entries].reverse()) {
          if (entry.closed) continue;
          if (kernel.symbols.CloseHandle(entry.handle)) entry.closed = true;
          else failure = true;
        }
        if (failure) throw Error('artifact_scope_release_failed');
        owned.delete(entries);
      };
      try {
        let path = resolve(root);
        for (;;) {
          if (entries.length >= 256) fail();
          const handle = open(path);
          const entry = { path, handle, identity: '', closed: false };
          entries.push(entry);
          entry.identity = info(handle);
          if (entries.length <= 2) acl(handle);
          const parent = dirname(path);
          if (parent === path) break;
          path = parent;
        }
        if (relativeFiles) {
          const paths = new Map<string, boolean>([[root, false]]);
          for (const relativeFile of relativeFiles) {
            const file = join(root, ...relativeFile.split('/'));
            const parents: string[] = [];
            for (
              let directory = dirname(file);
              directory !== root;
              directory = dirname(directory)
            ) {
              if (directory === dirname(directory)) fail();
              parents.push(directory);
            }
            for (const directory of parents.reverse()) paths.set(directory, false);
            if (paths.has(file)) fail();
            paths.set(file, true);
          }
          // Root and all descendants deny WRITE and DELETE sharing. Original ancestry
          // handles keep the existing directory policy and prevent rename/reparse races.
          for (const [path, file] of paths) {
            const handle = open(path, true);
            const entry = {
              path,
              handle,
              identity: '',
              closed: false,
              file,
              strict: true,
              checked: true,
            };
            entries.push(entry);
            entry.identity = info(handle, file, true);
            acl(handle);
            const mapped = new Uint16Array(32768);
            const length = kernel.symbols.GetFinalPathNameByHandleW(
              handle,
              ptr(mapped),
              mapped.length,
              0,
            );
            if (!length || length >= mapped.length) fail();
            const actual = Buffer.from(mapped.buffer, 0, length * 2).toString('utf16le');
            const normalized = actual.startsWith('\\\\?\\UNC\\')
              ? `\\\\${actual.slice(8)}`
              : actual.startsWith('\\\\?\\')
                ? actual.slice(4)
                : actual;
            if (normalized !== path) fail();
          }
        }
        let released = false;
        const scope: WindowsArtifactScope = {
          verify() {
            if (released) throw Error('artifact_scope_released');
            // Keep TOKEN_USER backing storage alive while EqualSid uses its pointer.
            if (!user.byteLength) fail();
            for (const [index, entry] of entries.entries()) {
              if (entry.closed || info(entry.handle, entry.file, entry.strict) !== entry.identity)
                fail();
              const current = open(entry.path, entry.strict);
              try {
                if (info(current, entry.file, entry.strict) !== entry.identity) fail();
                if (index < 2 || entry.checked) {
                  acl(entry.handle);
                  acl(current);
                }
              } finally {
                if (!kernel.symbols.CloseHandle(current)) {
                  // The verification probe is still ours; release must retry its real HANDLE.
                  entries.push({ ...entry, handle: current, closed: false });
                  fail();
                }
              }
            }
          },
          release() {
            if (released) return;
            close();
            released = true;
          },
        };
        scope.verify();
        return Object.freeze(scope);
      } catch (error) {
        if (relativeFiles) {
          try {
            close();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'artifact_scope_release_failed');
          }
        } else close();
        throw error;
      }
    };
  } catch (error) {
    closeAdv();
    kernel.close();
    throw error;
  }
}
