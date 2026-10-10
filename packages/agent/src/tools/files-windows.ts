import { win32 } from 'node:path';
import { AgentError } from '../storage/types';
import type { WorkspaceFileIo, WorkspaceFileStat } from './files-io';

// Original native resources remain reachable after an ambiguous close. An ID is
// never a native HANDLE and is never reopened/retried after close is unknown.
const retained = new Set<object>();
function fail(code = 'file_io_failed'): never {
  throw new AgentError(code);
}
function component(value: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/:*?"<>|]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value) ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    Buffer.from(value, 'utf16le').toString('utf16le') !== value ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    fail('file_path_invalid');
}
function absolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]:\\/i.test(value) ||
    value.length > 32760 ||
    win32.resolve(value) !== value
  )
    fail('file_path_invalid');
  for (const part of value.slice(3).split('\\')) if (part) component(part);
  return value;
}
const key = (value: string) => value.toUpperCase();
type Entry = {
  handle: bigint;
  path: string;
  identity: string;
  directory: boolean;
  temporary: boolean;
  uncertain: boolean;
};

// Fixed system libraries are a lazy process-lifetime API cache, not per-file
// owner resources. Importing this module never loads FFI on Node or POSIX.
const systemLibraries = new Set<object>();
let systemApi: ReturnType<typeof loadSystemApi> | undefined;
function loadSystemApi() {
  const { dlopen, ptr, CString } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    GetFileType: { args: ['u64'], returns: 'u32' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    GetFinalPathNameByHandleW: { args: ['u64', 'ptr', 'u32', 'u32'], returns: 'u32' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    SetFileInformationByHandle: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['ptr'], returns: 'ptr' },
  });
  systemLibraries.add(kernel);
  const system = new Uint16Array(32768);
  const systemLength = kernel.symbols.GetSystemDirectoryW(ptr(system), system.length);
  if (!systemLength || systemLength >= system.length) fail();
  const systemEnd = system.indexOf(0);
  if (systemEnd < 1) fail();
  const systemPath = absolute(Buffer.from(system.buffer, 0, systemEnd * 2).toString('utf16le'));
  const nt = dlopen(`${systemPath}\\ntdll.dll`, {
    NtCreateFile: {
      args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
      returns: 'i32',
    },
    RtlNtStatusToDosError: { args: ['i32'], returns: 'u32' },
  });
  systemLibraries.add(nt);
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
  });
  systemLibraries.add(adv);
  return { kernel, nt, adv, ptr, CString };
}

/** A Workspace owner, independent of Shell authority or application-private ACLs. */
export function createWindowsWorkspaceFileIo(
  root: string,
  protectedPaths: readonly string[],
  protectReads: boolean,
): WorkspaceFileIo {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('file_platform_unsupported');
  root = absolute(root);
  const denied = protectedPaths.map((path) => {
    if (typeof path !== 'string' || path.includes('\\')) fail('file_path_invalid');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) fail('file_path_invalid');
    for (const part of parts) component(part);
    return key(win32.join(root, ...parts));
  });
  systemApi ??= loadSystemApi();
  const { kernel, nt, adv, ptr, CString } = systemApi;
  const owner = {
    entries: new Map<number, Entry>(),
    memory: new Set<unknown>(),
  };
  retained.add(owner);
  let unknown = false,
    closed = false,
    closing = false,
    serial = 0;
  const ancestors: number[] = [];
  let rootId = 0;
  const error = (code: number): never => {
    throw Object.assign(
      new AgentError(
        code === 2 || code === 3
          ? 'ENOENT'
          : code === 80 || code === 183
            ? 'EEXIST'
            : code === 267
              ? 'ENOTDIR'
              : 'file_io_failed',
      ),
      { errno: code },
    );
  };
  const check = (success: boolean | number) => {
    if (!success) error(kernel.symbols.GetLastError());
  };
  const address = (value: bigint): import('bun:ffi').Pointer => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) fail();
    return number as import('bun:ffi').Pointer;
  };
  const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
  const releaseMemory = (value: bigint) => {
    if (!value) return;
    if (kernel.symbols.LocalFree(address(value))) {
      unknown = true;
      owner.memory.add(value);
      fail('file_close_unknown');
    }
    owner.memory.delete(value);
  };
  const closeNative = (handle: bigint) => {
    if (!kernel.symbols.CloseHandle(handle)) {
      unknown = true;
      owner.memory.add({ unclosedHandle: handle });
      fail('file_close_unknown');
    }
  };
  const sidText = (sid: bigint) => {
    const result = new BigUint64Array(1);
    check(adv.symbols.ConvertSidToStringSidA(address(sid), ptr(result)));
    owner.memory.add(result[0]!);
    try {
      const text = new CString(address(result[0]!)).toString();
      if (!/^S-1-(?:[0-9]+-)*[0-9]+$/.test(text)) fail('file_owner_invalid');
      return text;
    } finally {
      releaseMemory(result[0]!);
    }
  };
  let currentSid = '';
  const getOwner = (handle: bigint) => {
    const sid = new BigUint64Array(1),
      descriptor = new BigUint64Array(1);
    const status = adv.symbols.GetSecurityInfo(
      handle,
      1,
      1,
      ptr(sid),
      null,
      null,
      null,
      ptr(descriptor),
    );
    if (descriptor[0]) owner.memory.add(descriptor[0]);
    try {
      if (status !== 0) error(status);
      return sidText(sid[0]!);
    } finally {
      releaseMemory(descriptor[0]!);
    }
  };
  const finalPath = (handle: bigint) => {
    const path = new Uint16Array(32768);
    const length = kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(path), path.length, 0);
    if (!length || length >= path.length) error(kernel.symbols.GetLastError());
    const value = Buffer.from(path.buffer, 0, length * 2).toString('utf16le');
    if (!value.startsWith('\\\\?\\') || value.startsWith('\\\\?\\UNC\\')) fail('file_path_invalid');
    return absolute(value.slice(4));
  };
  const facts = (handle: bigint): WorkspaceFileStat => {
    if (kernel.symbols.GetFileType(handle) !== 1) fail('file_not_regular');
    const id = Buffer.alloc(24),
      basic = Buffer.alloc(40),
      standard = Buffer.alloc(24);
    check(kernel.symbols.GetFileInformationByHandleEx(handle, 18, ptr(id), id.length));
    check(kernel.symbols.GetFileInformationByHandleEx(handle, 0, ptr(basic), basic.length));
    check(kernel.symbols.GetFileInformationByHandleEx(handle, 1, ptr(standard), standard.length));
    const attributes = basic.readUInt32LE(32);
    if (attributes & 0x400) fail('file_path_invalid');
    const directory = standard[21] !== 0;
    if (!!(attributes & 0x10) !== directory || standard[20]) fail('file_changed');
    const size = standard.readBigInt64LE(8);
    if (size < 0n) fail('file_changed');
    return {
      dev: id.readBigUInt64LE(0),
      ino: id.readBigUInt64LE(8) | (id.readBigUInt64LE(16) << 64n),
      size,
      // FILE_BASIC_INFO timestamps are 100ns ticks; retain exact units as ns.
      mtimeNs: basic.readBigInt64LE(16) * 100n,
      ctimeNs: basic.readBigInt64LE(24) * 100n,
      nlink: BigInt(standard.readUInt32LE(16)),
      owner: getOwner(handle),
      isFile: () => !directory,
      isDirectory: () => directory,
    };
  };
  const identity = (stat: WorkspaceFileStat) => `${stat.dev}:${stat.ino}`;
  const entry = (id: number) => {
    if (closed || unknown || (!closing && !Number.isSafeInteger(id)))
      fail(unknown ? 'file_close_unknown' : 'file_closed');
    const value = owner.entries.get(id);
    if (!value || value.uncertain) fail('file_closed');
    return value;
  };
  const protectedFile = (path: string) => {
    const normalized = key(path);
    return denied.some((item) => normalized === item || normalized.startsWith(`${item}\\`));
  };
  const verify = (id: number) => {
    const value = entry(id);
    if (
      identity(facts(value.handle)) !== value.identity ||
      key(finalPath(value.handle)) !== key(value.path)
    )
      fail('file_root_changed');
    return value;
  };
  const add = (handle: bigint, path: string, directory: boolean, temporary: boolean) => {
    const id = ++serial;
    const value: Entry = { handle, path, directory, temporary, identity: '', uncertain: false };
    owner.entries.set(id, value);
    const stat = facts(handle);
    if (stat.isDirectory() !== directory) fail(directory ? 'ENOTDIR' : 'file_not_regular');
    const actual = finalPath(handle);
    // Canonical long-name comparison rejects 8.3 aliases before any content read,
    // including aliases of a protected path. Reparse traversal is never allowed.
    if (key(actual) !== key(path)) fail('file_path_invalid');
    value.path = actual;
    value.identity = identity(stat);
    return id;
  };
  const open = (
    parent: bigint,
    name: string,
    access: number,
    directory: boolean | null,
    create = false,
    descriptor = 0n,
  ) => {
    const encoded = wide(name),
      unicode = Buffer.alloc(16),
      attributes = Buffer.alloc(48),
      iosb = Buffer.alloc(16),
      result = new BigUint64Array(1);
    // OBJECT_ATTRIBUTES points to UNICODE_STRING, which points to encoded.
    // Keep the entire borrowed graph reachable through the owner until native
    // synchronous consumption ends, including any GC triggered inside FFI.
    const borrowed = { encoded, unicode, attributes, iosb, result };
    owner.memory.add(borrowed);
    try {
      unicode.writeUInt16LE(encoded.length - 2, 0);
      unicode.writeUInt16LE(encoded.length, 2);
      unicode.writeBigUInt64LE(BigInt(ptr(encoded)), 8);
      attributes.writeUInt32LE(48, 0);
      attributes.writeBigUInt64LE(parent, 8);
      attributes.writeBigUInt64LE(BigInt(ptr(unicode)), 16);
      attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE, never inheritable.
      attributes.writeBigUInt64LE(descriptor, 32);
      const status = nt.symbols.NtCreateFile(
        result,
        access,
        attributes,
        iosb,
        null,
        0x80,
        directory !== false || create ? 3 : 7,
        create ? 2 : 1,
        0x200020 | (directory === null ? 0 : directory ? 1 : 0x40),
        null,
        0,
      );
      if (status < 0) error(nt.symbols.RtlNtStatusToDosError(status));
      if (!result[0] || result[0] === 0xffffffffffffffffn) fail();
      return result[0]!;
    } finally {
      owner.memory.delete(borrowed);
    }
  };
  const closeId = (id: number) => {
    const value = owner.entries.get(id);
    if (!value) fail('file_closed');
    if (value.uncertain) fail('file_close_unknown');
    try {
      closeNative(value.handle);
      owner.entries.delete(id);
    } catch (error) {
      value.uncertain = true;
      throw error;
    }
  };
  const close = () => {
    if (closed) return;
    closing = true;
    const errors: unknown[] = [];
    // A failed child closure preserves root/ancestor pins and native library.
    for (const id of [...owner.entries.keys()].reverse()) {
      if (id === rootId || ancestors.includes(id)) continue;
      try {
        closeId(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (unknown || errors.length) throw new AggregateError(errors, 'file_close_unknown');
    for (const id of [rootId, ...ancestors.slice().reverse()]) {
      if (!id || !owner.entries.has(id)) continue;
      try {
        closeId(id);
      } catch (error) {
        throw new AggregateError([error], 'file_close_unknown');
      }
    }
    closed = true;
    retained.delete(owner);
  };
  try {
    const token = new BigUint64Array(1);
    check(adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(token)));
    const tokenOwner = { token: token[0] };
    owner.memory.add(tokenOwner);
    try {
      const length = new Uint32Array(1);
      adv.symbols.GetTokenInformation(token[0]!, 1, null, 0, ptr(length));
      if (!length[0] || length[0] > 65536) fail('file_owner_invalid');
      const bytes = Buffer.alloc(length[0]!);
      check(adv.symbols.GetTokenInformation(token[0]!, 1, ptr(bytes), bytes.length, ptr(length)));
      currentSid = sidText(bytes.readBigUInt64LE(0));
    } finally {
      closeNative(token[0]!);
      owner.memory.delete(tokenOwner);
    }
    const drive = root.slice(0, 3);
    let parent = add(open(0n, `\\??\\${drive}`, 0x1200a1, true), drive, true, false);
    ancestors.push(parent);
    let path = drive;
    for (const name of root.slice(3).split('\\').filter(Boolean)) {
      path = win32.join(path, name);
      parent = add(open(entry(parent).handle, name, 0x1200a1, true), path, true, false);
      ancestors.push(parent);
    }
    rootId = parent;
    ancestors.pop();
    // Trusted deny scopes must themselves use canonical long components. A
    // configured 8.3 alias must not leave its real long-name subtree readable.
    // Nonexistent suffixes remain denied; no content is read during this check.
    for (const protectedPath of protectedPaths) {
      const probes: number[] = [];
      let current = rootId;
      let path = root;
      let firstError: unknown;
      try {
        for (const name of protectedPath.split('/').filter(Boolean)) {
          path = win32.join(path, name);
          let handle: bigint;
          try {
            handle = open(entry(current).handle, name, 0x120080, null);
          } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') break;
            throw error;
          }
          // Register before querying any metadata; failed validation must keep
          // the actual opened resource owned until its close is confirmed.
          const id = ++serial;
          const probe: Entry = {
            handle,
            path,
            directory: false,
            temporary: false,
            identity: '',
            uncertain: false,
          };
          owner.entries.set(id, probe);
          probes.push(id);
          const stat = facts(handle);
          probe.directory = stat.isDirectory();
          probe.identity = identity(stat);
          if (key(finalPath(handle)) !== key(path)) fail('file_path_invalid');
          current = id;
        }
      } catch (error) {
        firstError = error;
      }
      const errors: unknown[] = [];
      for (const id of probes.reverse()) {
        try {
          closeId(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          firstError === undefined ? errors : [firstError, ...errors],
          'file_close_unknown',
        );
      if (firstError !== undefined) throw firstError;
    }
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'file_acquire_close_unknown');
    }
    throw error;
  }
  const verifyRoot = () => {
    if (closing) fail('file_closed');
    for (const id of [...ancestors, rootId]) verify(id);
  };
  const io: WorkspaceFileIo = {
    root: rootId,
    createOnlyLeavesTemporary: false,
    verifyRoot,
    stat(id) {
      return facts(verify(id).handle);
    },
    verifyOwner(id) {
      const value = facts(verify(id).handle);
      if (value.owner !== currentSid || (value.isFile() && value.nlink !== 1n))
        fail('file_owner_invalid');
    },
    openAt(parent, name, kind, strict = false) {
      verifyRoot();
      if (name === '.' && kind === 'directory') {
        const value = verify(parent);
        return add(open(value.handle, '.', 0x1200a1, true), value.path, true, false);
      }
      component(name);
      const value = verify(parent);
      if (!value.directory) fail('ENOTDIR');
      const path = win32.join(value.path, name);
      if ((protectReads || strict) && protectedFile(path)) fail('file_path_protected');
      if (kind !== 'temporary')
        return add(
          open(
            value.handle,
            name,
            kind === 'directory' ? 0x1200a1 : 0x120089,
            kind === 'directory',
          ),
          path,
          kind === 'directory',
          false,
        );
      const descriptor = new BigUint64Array(1);
      check(
        adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          wide(`O:${currentSid}D:P(A;;FA;;;${currentSid})`),
          1,
          ptr(descriptor),
          null,
        ),
      );
      owner.memory.add(descriptor[0]!);
      try {
        return add(
          open(value.handle, name, 0x13019f, false, true, descriptor[0]!),
          path,
          false,
          true,
        );
      } finally {
        releaseMemory(descriptor[0]!);
      }
    },
    read(id, bytes) {
      const value = entry(id);
      if (
        value.directory ||
        !(bytes instanceof Uint8Array) ||
        bytes.length < 1 ||
        bytes.length > 65536
      )
        fail('file_io_invalid');
      const count = new Uint32Array(1);
      check(kernel.symbols.ReadFile(value.handle, ptr(bytes), bytes.length, ptr(count), null));
      if (count[0]! > bytes.length) fail();
      return count[0]!;
    },
    write(id, bytes) {
      const value = entry(id);
      if (!value.temporary || !(bytes instanceof Uint8Array)) fail('file_io_invalid');
      for (let offset = 0; offset < bytes.length; ) {
        const part = bytes.subarray(offset, offset + 65536),
          count = new Uint32Array(1);
        check(kernel.symbols.WriteFile(value.handle, ptr(part), part.length, ptr(count), null));
        if (!count[0] || count[0] > part.length) fail();
        offset += count[0];
      }
    },
    sync(id) {
      const value = verify(id);
      // Windows file flush + original publication confirmation is supported.
      // Directory identity verification is NOT POSIX directory fsync and does
      // not grant a power-loss durability claim for directory metadata.
      if (!value.directory) check(kernel.symbols.FlushFileBuffers(value.handle));
    },
    publishAt(parent, temp, target, createOnly) {
      verifyRoot();
      component(temp);
      component(target);
      const directory = verify(parent),
        from = win32.join(directory.path, temp),
        to = win32.join(directory.path, target);
      if (protectedFile(to) && protectReads) fail('file_path_protected');
      const original = [...owner.entries.values()].find(
        (value) => value.temporary && key(value.path) === key(from),
      );
      if (!directory.directory || !original || original.uncertain) fail('file_io_invalid');
      if (
        identity(facts(original.handle)) !== original.identity ||
        key(finalPath(original.handle)) !== key(from)
      )
        fail('file_changed');
      const name = Buffer.from(target, 'utf16le'),
        rename = Buffer.alloc(20 + name.length + 2);
      rename[0] = createOnly ? 0 : 1;
      rename.writeBigUInt64LE(directory.handle, 8);
      rename.writeUInt32LE(name.length, 16);
      name.copy(rename, 20);
      check(kernel.symbols.SetFileInformationByHandle(original.handle, 3, rename, rename.length));
      // Publication has happened. Any subsequent failure belongs to the caller's
      // existing file_publish_outcome_unknown boundary, not a zero-effect failure.
      original.path = to;
      try {
        if (
          key(finalPath(original.handle)) !== key(to) ||
          identity(facts(original.handle)) !== original.identity
        )
          fail('file_publication_changed');
        verifyRoot();
        verify(parent);
      } catch (error) {
        throw new AgentError(
          'file_publish_outcome_unknown',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    unlinkAt(parent, name, strict = false) {
      verifyRoot();
      component(name);
      const directory = verify(parent),
        path = win32.join(directory.path, name);
      if ((protectReads || strict) && protectedFile(path)) fail('file_path_protected');
      const id = add(open(directory.handle, name, 0x130089, false), path, false, false);
      let marked = false;
      try {
        const original = verify(id);
        check(
          kernel.symbols.SetFileInformationByHandle(original.handle, 4, new Uint8Array([1]), 1),
        );
        marked = true;
      } catch (error) {
        try {
          closeId(id);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'file_close_unknown');
        }
        throw error;
      }
      try {
        closeId(id);
        if (marked) {
          let probe: bigint;
          try {
            probe = open(directory.handle, name, 0x120089, false);
          } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') {
              verifyRoot();
              return;
            }
            throw error;
          }
          closeNative(probe);
          fail('file_publication_changed');
        }
      } catch (error) {
        throw new AgentError(
          'file_publish_outcome_unknown',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    listAt(parent) {
      verifyRoot();
      const value = verify(parent);
      if (!value.directory) fail('ENOTDIR');
      const result: { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[] = [];
      const bytes = Buffer.alloc(65536);
      let restart = true;
      for (;;) {
        const success = kernel.symbols.GetFileInformationByHandleEx(
          value.handle,
          restart ? 11 : 10,
          ptr(bytes),
          bytes.length,
        );
        restart = false;
        if (!success) {
          const errorCode = kernel.symbols.GetLastError();
          if (errorCode === 18) break;
          error(errorCode);
        }
        let offset = 0;
        for (;;) {
          if (offset + 104 > bytes.length) fail('file_directory_invalid');
          const next = bytes.readUInt32LE(offset),
            length = bytes.readUInt32LE(offset + 60),
            attributes = bytes.readUInt32LE(offset + 56);
          if (
            length < 2 ||
            length % 2 ||
            offset + 104 + length > bytes.length ||
            (next && (next < 104 + length || next % 8 || offset + next >= bytes.length))
          )
            fail('file_directory_invalid');
          const encoded = bytes.subarray(offset + 104, offset + 104 + length),
            name = encoded.toString('utf16le');
          if (!Buffer.from(name, 'utf16le').equals(encoded))
            fail('file_directory_encoding_invalid');
          if (name !== '.' && name !== '..') {
            component(name);
            if (!protectReads || !protectedFile(win32.join(value.path, name)))
              result.push({
                name,
                kind: attributes & 0x400 ? 'symlink' : attributes & 0x10 ? 'directory' : 'file',
              });
          }
          if (!next) break;
          offset += next;
        }
      }
      verifyRoot();
      verify(parent);
      return result;
    },
    closeHandle(id) {
      if (id === rootId || ancestors.includes(id)) fail('file_io_invalid');
      closeId(id);
    },
    close,
  };
  return Object.freeze(io);
}
