import { dlopen, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync } from 'node:fs';

const AT_REMOVEDIR = process.platform === 'darwin' ? 0x80 : 0x200;
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x20 : 0x100;

interface NativeDirectoryApiV1 {
  openat(dirfd: number, name: Pointer, flags: number, mode: number): number;
  unlinkat(dirfd: number, name: Pointer, flags: number): number;
  fchmodat(dirfd: number, name: Pointer, mode: number, flags: number): number;
  fchflags?(fd: number, flags: number): number;
  fdopendir(fd: number): Pointer | null;
  readdir(directory: Pointer): Pointer | null;
  closedir(directory: Pointer): number;
}

/**
 * Remove one named tree below a pinned parent. No descendant pathname is ever
 * resolved from the process root; symlinks and special files are unlinked at
 * their pinned parent and are never traversed.
 */
export function removeDirectoryTreeAtV1(parentFd: number, name: string): boolean {
  if (!validName(name)) return false;
  const api = nativeApi();
  const names = listDirectoryNames(parentFd);
  if (!names?.includes(name)) return names !== null;
  // Restore hostile modes descriptor-relatively without following symlinks.
  api.fchmodat(parentFd, namePointer(name), 0o700, AT_SYMLINK_NOFOLLOW);
  const rootFd = openDirectoryAt(api, parentFd, name);
  if (rootFd < 0) return false;
  try {
    if (!removeDirectoryContents(api, rootFd)) return false;
  } finally {
    closeSync(rootFd);
  }
  return api.unlinkat(parentFd, namePointer(name), AT_REMOVEDIR) === 0;
}

export function openDirectoryAtV1(parentFd: number, name: string): number {
  if (!validName(name)) return -1;
  return openDirectoryAt(nativeApi(), parentFd, name);
}

export function directoryNamesAtV1(fd: number): readonly string[] | null {
  return listDirectoryNames(fd);
}

export function removeEmptyDirectoryAtV1(parentFd: number, name: string): boolean {
  return validName(name) && nativeApi().unlinkat(parentFd, namePointer(name), AT_REMOVEDIR) === 0;
}

function removeDirectoryContents(api: NativeDirectoryApiV1, directoryFd: number): boolean {
  const names = listDirectoryNames(directoryFd);
  if (!names) return false;
  for (const name of names) {
    api.fchmodat(directoryFd, namePointer(name), 0o700, AT_SYMLINK_NOFOLLOW);
    const childDirectory = openDirectoryAt(api, directoryFd, name);
    if (childDirectory >= 0) {
      try {
        if (!removeDirectoryContents(api, childDirectory)) return false;
      } finally {
        closeSync(childDirectory);
      }
      if (api.unlinkat(directoryFd, namePointer(name), AT_REMOVEDIR) !== 0) return false;
      continue;
    }
    const childFd = api.openat(
      directoryFd,
      namePointer(name),
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      0,
    );
    if (childFd >= 0) {
      try {
        const metadata = fstatSync(childFd);
        if (!metadata.isFile() || metadata.nlink !== 1) return false;
        api.fchflags?.(childFd, 0);
        fchmodSync(childFd, 0o600);
        fsyncSync(childFd);
      } finally {
        closeSync(childFd);
      }
    }
    // A failed open is admissible only as a no-follow unlink of a symlink or
    // special entry. unlinkat itself remains descriptor-relative.
    if (api.unlinkat(directoryFd, namePointer(name), 0) !== 0) return false;
  }
  return listDirectoryNames(directoryFd)?.length === 0;
}

function listDirectoryNames(fd: number): string[] | null {
  const api = nativeApi();
  // openat(".") creates an independent directory file description. dup()
  // would share the directory offset and make a second emptiness check see
  // stale EOF rather than the actual entries.
  const duplicate = api.openat(
    fd,
    namePointer('.'),
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    0,
  );
  if (duplicate < 0) return null;
  const directory = api.fdopendir(duplicate);
  if (!directory) {
    closeSync(duplicate);
    return null;
  }
  const names: string[] = [];
  try {
    while (true) {
      const entry = api.readdir(directory);
      if (!entry) break;
      const offset = process.platform === 'darwin' ? 21 : 19;
      // Darwin exposes d_name[1024]; Linux dirent64 exposes d_name[256]. Do
      // not read past the native entry returned by libc.
      const nameCapacity = process.platform === 'darwin' ? 1024 : 256;
      const bytes = new Uint8Array(toArrayBuffer(entry, offset, nameCapacity));
      const end = bytes.indexOf(0);
      if (end < 0) return null;
      const name = Buffer.from(bytes.subarray(0, end)).toString('utf8');
      if (name === '.' || name === '..') continue;
      if (!validName(name)) return null;
      names.push(name);
    }
    return names;
  } finally {
    api.closedir(directory);
  }
}

function openDirectoryAt(api: NativeDirectoryApiV1, parentFd: number, name: string): number {
  const fd = api.openat(
    parentFd,
    namePointer(name),
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    0,
  );
  if (fd < 0) return fd;
  try {
    api.fchflags?.(fd, 0);
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
    const metadata = fstatSync(fd);
    if (
      !metadata.isDirectory() ||
      (typeof metadata.uid === 'number' && metadata.uid !== process.getuid?.())
    ) {
      closeSync(fd);
      return -1;
    }
    return fd;
  } catch {
    closeSync(fd);
    return -1;
  }
}

function validName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

function namePointer(name: string): Pointer {
  return ptr(Buffer.from(`${name}\0`));
}

let loaded: { symbols: NativeDirectoryApiV1 } | undefined;

function nativeApi(): NativeDirectoryApiV1 {
  if (process.platform === 'win32') throw new Error('Descriptor-relative cleanup is unavailable.');
  if (loaded) return loaded.symbols;
  const symbols = {
    unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    fchmodat: { args: ['i32', 'ptr', 'u32', 'i32'], returns: 'i32' },
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
  } as const;
  if (process.platform === 'darwin') {
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      __openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
      fchflags: { args: ['i32', 'u32'], returns: 'i32' },
      ...symbols,
    });
    loaded = {
      symbols: {
        ...native.symbols,
        openat: native.symbols.__openat,
      } as unknown as NativeDirectoryApiV1,
    };
  } else {
    loaded = dlopen('libc.so.6', {
      openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
      ...symbols,
    }) as unknown as { symbols: NativeDirectoryApiV1 };
  }
  return loaded.symbols;
}
