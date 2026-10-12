import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { CandidateDirectory, CandidateIgnoreFile } from './file-candidate-filesystem';

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
let native: ReturnType<typeof load> | undefined;
function load() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    ...(process.platform === 'darwin'
      ? { __openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }
      : { openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }),
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
    ...(process.platform === 'darwin'
      ? { __error: { args: [], returns: 'ptr' } as const }
      : { __errno_location: { args: [], returns: 'ptr' } as const }),
  });
}
function api() {
  native ??= load();
  return native.symbols;
}
function openAt(fd: number, name: string, mode: number) {
  const bytes = Buffer.from(`${name}\0`),
    a = api();
  const next = ('__openat' in a ? a.__openat : a.openat)(
    fd,
    ptr(bytes),
    mode | (process.platform === 'darwin' ? 0x1000000 : 0x80000),
    0,
  );
  if (next < 0) throw new Error('file_candidate_open_unavailable');
  return next;
}
function canonicalDirectory(path: string) {
  let fd = openSync('/', flags);
  try {
    for (const segment of path.split('/').filter(Boolean)) {
      const next = openAt(fd, segment, flags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function sameDirectory(fd: number, path: string) {
  const proof = canonicalDirectory(path);
  try {
    const a = fstatSync(fd, { bigint: true }),
      b = fstatSync(proof, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino) throw new Error('file_candidate_directory_changed');
  } finally {
    closeSync(proof);
  }
}
function names(fd: number) {
  const a = api(),
    dup = openAt(fd, '.', flags),
    dir = a.fdopendir(dup);
  if (!dir) {
    closeSync(dup);
    throw new Error('file_candidate_directory_unavailable');
  }
  const error = new DataView(
    toArrayBuffer(('__error' in a ? a.__error : a.__errno_location)()!, 0, 4),
  );
  const result: { name: string; type: number }[] = [];
  try {
    for (;;) {
      error.setInt32(0, 0, true);
      const entry = a.readdir(dir);
      if (!entry) {
        if (error.getInt32(0, true)) throw new Error('file_candidate_directory_unavailable');
        break;
      }
      const offset = process.platform === 'darwin' ? 20 : 18;
      const length = new DataView(toArrayBuffer(entry, 16, 2)).getUint16(0, true) - offset - 1;
      if (length < 1 || length > 2048) throw new Error('file_candidate_name_invalid');
      const raw = new Uint8Array(toArrayBuffer(entry, offset + 1, length)),
        end = raw.indexOf(0);
      if (end < 0) throw new Error('file_candidate_name_invalid');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end));
      if (name === '.' || name === '..') continue;
      if (!name || name.includes('/') || name.includes('\0'))
        throw new Error('file_candidate_name_invalid');
      result.push({ name, type: new Uint8Array(toArrayBuffer(entry, offset, 1))[0]! });
    }
  } finally {
    a.closedir(dir);
  }
  return result;
}
function stamp(fd: number) {
  const s = fstatSync(fd, { bigint: true });
  return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
}

function ownedDirectory(fd: number, ancestor?: number): CandidateDirectory {
  return {
    verifyCanonicalPath(path) {
      sameDirectory(fd, path);
    },
    stamp: () => stamp(fd),
    entries: () => names(fd),
    openDirectory: (name) => ownedDirectory(openAt(fd, name, flags)),
    openIgnoreFile() {
      const file = openAt(
        fd,
        '.gitignore',
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      return ownedIgnoreFile(file);
    },
    close() {
      if (fd !== ancestor) closeSync(fd);
      if (ancestor !== undefined) closeSync(ancestor);
    },
  };
}
function ownedIgnoreFile(fd: number): CandidateIgnoreFile {
  return {
    facts() {
      const before = stamp(fd),
        stat = fstatSync(fd);
      return { regular: stat.isFile(), links: stat.nlink, stamp: before };
    },
    read: (buffer) => readSync(fd, buffer, 0, buffer.length, null),
    close: () => closeSync(fd),
  };
}
export function openPosixCandidateDirectory(canonicalPath: string): CandidateDirectory {
  const root = openSync('/', flags);
  let fd = root;
  try {
    for (const segment of canonicalPath.split('/').filter(Boolean)) {
      const next = openAt(fd, segment, flags);
      if (fd !== root) closeSync(fd);
      fd = next;
    }
    return ownedDirectory(fd, root);
  } catch (error) {
    if (fd !== root) closeSync(fd);
    closeSync(root);
    throw error;
  }
}
