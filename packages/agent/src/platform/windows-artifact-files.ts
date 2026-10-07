import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentError } from '../storage/types';
import { defaultWindowsPathSecurity, privateDirectory } from './windows-path-security';

/** Fixed native media policy. Import is inert on Node/POSIX; no supplied HANDLE, SID or DLL. */
export interface WindowsArtifactTemporary {
  write(bytes: Uint8Array): void;
  publish(hash: string, size: string): void;
  close(): void;
}
let implementation: ReturnType<typeof native> | undefined;
const api = () => (implementation ??= native());
const chunkBytes = 64 * 1024;
const fail = (): never => {
  throw new AgentError('artifact_content_mismatch');
};
function valid(hash: string, size?: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new AgentError('artifact_hash_invalid');
  if (
    size !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(size) || BigInt(size) > 9223372036854775807n)
  )
    throw new AgentError('artifact_size_invalid');
}
export function createWindowsArtifactTemporary(profilePath: string): WindowsArtifactTemporary {
  return api().temporary(profilePath);
}
/** Full EOF is mandatory; early return releases both file and retained directories. */
export function* readWindowsArtifactChunks(
  profilePath: string,
  hash: string,
  size: string,
): Generator<Uint8Array> {
  valid(hash, size);
  yield* api().read(profilePath, hash, size);
}
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new AgentError('artifact_platform_unsupported');
  const { dlopen, ptr, toArrayBuffer, CString } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    SetFileInformationByHandle: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['ptr'], returns: 'ptr' },
  });
  const system = new Uint16Array(32768);
  const length = kernel.symbols.GetSystemDirectoryW(ptr(system), system.length);
  if (!length || length >= system.length) fail();
  const adv = dlopen(
    `${Buffer.from(system.buffer, 0, length * 2).toString('utf16le')}\\advapi32.dll`,
    {
      OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
      GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
      ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'bool' },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: {
        args: ['ptr', 'u32', 'ptr', 'ptr'],
        returns: 'bool',
      },
      GetSecurityDescriptorDacl: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
      GetSecurityDescriptorControl: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
      GetSecurityInfo: {
        args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
        returns: 'u32',
      },
      SetSecurityInfo: { args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'u32' },
      EqualSid: { args: ['ptr', 'ptr'], returns: 'bool' },
      GetAce: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
    },
  );
  const pointer = (value: bigint): import('bun:ffi').Pointer => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) return fail();
    return number as import('bun:ffi').Pointer;
  };
  const out = () => new BigUint64Array(1);
  const wide = (path: string) => {
    if (!path || path.includes('\0') || path.length > 32760) return fail();
    return Buffer.from(`${path}\0`, 'utf16le');
  };
  const close = (handle: bigint | number) => {
    if (!kernel.symbols.CloseHandle(handle)) fail();
  };
  const closeAll = (handles: (bigint | number)[]) => {
    let error: unknown;
    for (const handle of handles.splice(0).reverse()) {
      try {
        close(handle);
      } catch (caught) {
        error ??= caught;
      }
    }
    if (error !== undefined) throw error;
  };
  const token = out();
  if (!adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(token))) fail();
  // Keep the original TOKEN_USER bytes alive for the SID pointer's complete lifetime.
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
    close(token[0]!);
  }
  const descriptor = (readOnly: boolean) => {
    const value = out();
    if (
      !adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        ptr(wide(`O:${sidText}D:P(A;;${readOnly ? 'FR' : 'FA'};;;${sidText})`)),
        1,
        ptr(value),
        null,
      )
    )
      fail();
    return pointer(value[0]!);
  };
  const info = (handle: bigint | number) => {
    const bytes = new Uint8Array(52);
    if (!kernel.symbols.GetFileInformationByHandle(handle, ptr(bytes))) fail();
    return new DataView(bytes.buffer);
  };
  const identity = (value: DataView) =>
    `${value.getUint32(28, true)}:${value.getUint32(44, true)}:${value.getUint32(48, true)}`;
  const fileSize = (value: DataView) =>
    (BigInt(value.getUint32(32, true)) << 32n) | BigInt(value.getUint32(36, true));
  const change = (handle: bigint | number) => {
    const bytes = new Uint8Array(40);
    if (!kernel.symbols.GetFileInformationByHandleEx(handle, 0, ptr(bytes), bytes.length)) fail();
    return new DataView(bytes.buffer).getBigInt64(24, true);
  };
  const open = (
    path: string,
    access: number,
    share: number,
    create = false,
    sd?: import('bun:ffi').Pointer,
  ) => {
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
      0x02200000 | (create ? 0x80000000 : 0),
      0,
    );
    if (!handle || BigInt(handle) === 18446744073709551615n) fail();
    return handle;
  };
  const readonlyAcl = (handle: bigint | number) => {
    // Referencing user here keeps its native SID storage live, not only the numeric pointer.
    if (!user.byteLength) fail();
    const owner = out(),
      dacl = out(),
      sd = out();
    if (adv.symbols.GetSecurityInfo(handle, 1, 5, ptr(owner), null, ptr(dacl), null, ptr(sd)) !== 0)
      fail();
    try {
      if (!owner[0] || !dacl[0] || !adv.symbols.EqualSid(pointer(owner[0]), sid)) fail();
      const control = new Uint16Array(1),
        revision = new Uint32Array(1);
      if (
        !adv.symbols.GetSecurityDescriptorControl(pointer(sd[0]!), ptr(control), ptr(revision)) ||
        (control[0]! & 0x1004) !== 0x1004
      )
        fail();
      const acl = new DataView(toArrayBuffer(pointer(dacl[0]!), 0, 8));
      if (acl.getUint16(4, true) !== 1) fail();
      const ace = out();
      if (!adv.symbols.GetAce(pointer(dacl[0]!), 0, ptr(ace))) fail();
      const address = pointer(ace[0]!);
      const header = new DataView(toArrayBuffer(address, 0, 8));
      if (
        header.getUint8(0) !== 0 ||
        header.getUint8(1) !== 0 ||
        header.getUint16(2, true) < 12 ||
        header.getUint32(4, true) !== 0x120089 ||
        !adv.symbols.EqualSid(pointer(BigInt(address) + 8n), sid)
      )
        fail();
    } finally {
      if (sd[0]) kernel.symbols.LocalFree(pointer(sd[0]));
    }
  };
  const verifyFile = (handle: bigint | number, path: string, readOnly: boolean, size?: string) => {
    defaultWindowsPathSecurity()!.verifyPath(path);
    const before = info(handle);
    if (
      (before.getUint32(0, true) & 0x410) !== 0 ||
      before.getUint32(40, true) !== 1 ||
      (size !== undefined && fileSize(before) !== BigInt(size))
    )
      fail();
    if (readOnly) readonlyAcl(handle);
    else defaultWindowsPathSecurity()!.verifyHandle(handle, path, false);
    const current = open(path, 0x20080, 7);
    try {
      const after = info(current);
      if (
        identity(before) !== identity(after) ||
        (after.getUint32(0, true) & 0x410) !== 0 ||
        after.getUint32(40, true) !== 1
      )
        fail();
      if (readOnly) readonlyAcl(current);
    } finally {
      close(current);
    }
    return before;
  };
  const directories = (profile: string, prefix?: string, create = false) => {
    const paths = [
      profile,
      join(profile, 'blobs'),
      ...(prefix ? [join(profile, 'blobs', prefix)] : []),
    ];
    const handles: (bigint | number)[] = [];
    try {
      for (const path of paths) {
        if (create) privateDirectory(path);
        defaultWindowsPathSecurity()!.verifyDirectory(path);
        // Deny DELETE sharing while held: retained target ancestry cannot be moved away.
        const handle = open(path, 0x200a0, 3);
        handles.push(handle);
        defaultWindowsPathSecurity()!.verifyHandle(handle, path, true);
      }
      return {
        paths,
        handles,
        verify() {
          for (let i = 0; i < paths.length; i++)
            defaultWindowsPathSecurity()!.verifyHandle(handles[i]!, paths[i]!, true);
        },
        close() {
          closeAll(handles);
        },
      };
    } catch (error) {
      closeAll(handles);
      throw error;
    }
  };
  const read = function* (profile: string, hash: string, size: string): Generator<Uint8Array> {
    const dirs = directories(profile, hash.slice(0, 2));
    let handle: bigint | number | undefined;
    try {
      const path = join(profile, 'blobs', hash.slice(0, 2), hash);
      // Allow a concurrent trusted publisher's original WRITE/DELETE handle to finish flushing.
      // New write opens are denied by FR; identity/change-time/full EOF catch replacement or edit.
      handle = open(path, 0x80020000, 7);
      const before = verifyFile(handle, path, true, size),
        originalChange = change(handle);
      const digest = createHash('sha256');
      let count = 0n;
      for (;;) {
        const bytes = new Uint8Array(chunkBytes),
          length = new Uint32Array(1);
        if (!kernel.symbols.ReadFile(handle, ptr(bytes), bytes.length, ptr(length), null)) fail();
        if (!length[0]) break;
        if (length[0] > bytes.length) fail();
        count += BigInt(length[0]);
        if (count > BigInt(size)) fail();
        const part = bytes.subarray(0, length[0]);
        digest.update(part);
        yield part;
      }
      const after = verifyFile(handle, path, true, size);
      dirs.verify();
      if (
        count !== BigInt(size) ||
        identity(before) !== identity(after) ||
        originalChange !== change(handle) ||
        digest.digest('hex') !== hash
      )
        fail();
    } finally {
      try {
        if (handle !== undefined) close(handle);
      } finally {
        dirs.close();
      }
    }
  };
  const temporary = (profile: string): WindowsArtifactTemporary => {
    const dirs = directories(profile, undefined, true);
    const path = join(profile, 'blobs', `.publish-${randomUUID()}`);
    const sd = descriptor(false);
    let handle: bigint | number;
    try {
      handle = open(path, 0xc0070000, 7, true, sd);
    } catch (error) {
      dirs.close();
      throw error;
    } finally {
      kernel.symbols.LocalFree(sd);
    }
    let closed = false,
      published = false,
      count = 0n;
    const live = () => {
      if (closed || published) throw new AgentError('artifact_closed');
    };
    return {
      write(bytes) {
        live();
        if (!(bytes instanceof Uint8Array) || bytes.length > chunkBytes)
          throw new AgentError('artifact_chunk_invalid');
        verifyFile(handle, path, false);
        dirs.verify();
        count += BigInt(bytes.length);
        if (count > 9223372036854775807n) throw new AgentError('artifact_size_invalid');
        for (let offset = 0; offset < bytes.length; ) {
          const written = new Uint32Array(1),
            part = bytes.subarray(offset);
          if (
            !kernel.symbols.WriteFile(handle, ptr(part), part.length, ptr(written), null) ||
            !written[0] ||
            written[0] > part.length
          )
            fail();
          offset += written[0]!;
        }
      },
      publish(hash, size) {
        live();
        valid(hash, size);
        if (count !== BigInt(size)) fail();
        verifyFile(handle, path, false, size);
        dirs.verify();
        const targetDirs = directories(profile, hash.slice(0, 2), true);
        try {
          const ro = descriptor(true);
          try {
            const present = new Int32Array(1),
              dacl = out(),
              defaulted = new Int32Array(1);
            if (
              !adv.symbols.GetSecurityDescriptorDacl(ro, ptr(present), ptr(dacl), ptr(defaulted)) ||
              !present[0] ||
              !dacl[0] ||
              adv.symbols.SetSecurityInfo(
                handle,
                1,
                0x80000004,
                null,
                null,
                pointer(dacl[0]),
                null,
              ) !== 0
            )
              fail();
          } finally {
            kernel.symbols.LocalFree(ro);
          }
          readonlyAcl(handle);
          if (!kernel.symbols.FlushFileBuffers(handle)) fail();
          targetDirs.verify();
          dirs.verify();
          verifyFile(handle, path, true, size);
          const name = Buffer.from(hash, 'utf16le'),
            rename = new Uint8Array(20 + name.length + 2);
          const view = new DataView(rename.buffer);
          // FILE_RENAME_INFO x64: FALSE at 0, retained directory HANDLE at 8, UTF16 byte count at 16.
          view.setBigUint64(8, BigInt(targetDirs.handles[2]!), true);
          view.setUint32(16, name.length, true);
          rename.set(name, 20);
          if (!kernel.symbols.SetFileInformationByHandle(handle, 3, ptr(rename), rename.length)) {
            const error = kernel.symbols.GetLastError();
            if (error !== 80 && error !== 183) fail();
            // Only the official FILE_EXISTS/ALREADY_EXISTS collision adopts an existing object.
            for (const _part of read(profile, hash, size)) {
              /* Complete EOF before reuse. */
            }
            return;
          }
          // From this point cleanup must never delete the published blob, including SQL failure.
          published = true;
          const target = join(profile, 'blobs', hash.slice(0, 2), hash);
          verifyFile(handle, target, true, size);
          targetDirs.verify();
          dirs.verify();
          if (!kernel.symbols.FlushFileBuffers(handle)) fail();
        } finally {
          targetDirs.close();
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          if (!published) {
            // Original DELETE right survives the FR DACL reduction. Never repair an existing blob.
            const disposition = new Uint8Array([1]);
            if (!kernel.symbols.SetFileInformationByHandle(handle, 4, ptr(disposition), 1)) fail();
          }
        } finally {
          try {
            close(handle);
          } finally {
            dirs.close();
          }
        }
      },
    };
  };
  return { temporary, read };
}
