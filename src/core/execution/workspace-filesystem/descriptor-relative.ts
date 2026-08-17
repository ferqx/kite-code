import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { closeSync, constants } from 'node:fs';

interface UnixDescriptorFilesystemApiV1 {
  openat(directoryDescriptor: number, name: Pointer, flags: number, mode: number): number;
  mkdirat(directoryDescriptor: number, name: Pointer, mode: number): number;
  unlinkat(directoryDescriptor: number, name: Pointer, flags: number): number;
  renameat(
    sourceDirectoryDescriptor: number,
    sourceName: Pointer,
    targetDirectoryDescriptor: number,
    targetName: Pointer,
  ): number;
}

interface OpenedDirectoryV1 {
  readonly descriptor: number;
  readonly parentDescriptor: number;
  readonly name: string;
  readonly created: boolean;
}

export interface DescriptorRelativeDirectoryChainV1 {
  readonly descriptor: number;
  readonly openedDirectories: readonly OpenedDirectoryV1[];
}

let unixLibrary:
  | {
      readonly symbols: UnixDescriptorFilesystemApiV1;
    }
  | undefined;

/**
 * Fail before mutation I/O when this process has no descriptor-relative
 * filesystem backend. Path-based publication is intentionally not a fallback.
 */
export function assertDescriptorRelativeMutationSupportedV1(): void {
  unixDescriptorFilesystemApiV1();
}

/** Open or create a no-follow directory chain below an already pinned ancestor. */
export function openOrCreateDirectoryChainAtV1(
  ancestorDescriptor: number,
  segments: readonly string[],
): DescriptorRelativeDirectoryChainV1 {
  const api = unixDescriptorFilesystemApiV1();
  const openedDirectories: OpenedDirectoryV1[] = [];
  let descriptor = ancestorDescriptor;
  try {
    for (const segment of segments) {
      assertBasename(segment);
      let created = false;
      let next = openDirectoryAt(api, descriptor, segment);
      if (next < 0) {
        if (api.mkdirat(descriptor, namePointer(segment), 0o777) !== 0) {
          // The entry may have appeared concurrently. openat below decides
          // whether it is the required no-follow directory object.
        } else {
          created = true;
        }
        next = openDirectoryAt(api, descriptor, segment);
      }
      if (next < 0) {
        throw new Error('Descriptor-relative mutation directory could not be opened.');
      }
      openedDirectories.push({
        descriptor: next,
        parentDescriptor: descriptor,
        name: segment,
        created,
      });
      descriptor = next;
    }
    return { descriptor, openedDirectories };
  } catch (error) {
    closeOpenedDirectoryChainV1(openedDirectories, true);
    throw error;
  }
}

/** Create one private regular file without re-resolving the pinned parent path. */
export function openExclusiveFileAtV1(
  directoryDescriptor: number,
  name: string,
  mode: number,
): number {
  assertBasename(name);
  const descriptor = unixDescriptorFilesystemApiV1().openat(
    directoryDescriptor,
    namePointer(name),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  if (descriptor < 0) {
    throw new Error('Descriptor-relative mutation temporary file could not be created.');
  }
  return descriptor;
}

/** Atomically replace a sibling entry using the pinned parent on both sides. */
export function renameAtV1(
  directoryDescriptor: number,
  sourceName: string,
  targetName: string,
): void {
  assertBasename(sourceName);
  assertBasename(targetName);
  if (
    unixDescriptorFilesystemApiV1().renameat(
      directoryDescriptor,
      namePointer(sourceName),
      directoryDescriptor,
      namePointer(targetName),
    ) !== 0
  ) {
    throw new Error('Descriptor-relative mutation publish failed.');
  }
}

/** Best-effort cleanup constrained to a pinned directory descriptor. */
export function unlinkAtV1(directoryDescriptor: number, name: string): void {
  assertBasename(name);
  unixDescriptorFilesystemApiV1().unlinkat(directoryDescriptor, namePointer(name), 0);
}

/**
 * Close child descriptors in reverse order and optionally remove only the
 * directories this invocation created, using their still-pinned parents.
 */
export function closeOpenedDirectoryChainV1(
  openedDirectories: readonly OpenedDirectoryV1[],
  removeCreated: boolean,
): void {
  const api = unixDescriptorFilesystemApiV1();
  for (let index = openedDirectories.length - 1; index >= 0; index--) {
    const opened = openedDirectories[index]!;
    try {
      closeSync(opened.descriptor);
    } catch {
      // Preserve cleanup best effort.
    }
    if (removeCreated && opened.created) {
      api.unlinkat(opened.parentDescriptor, namePointer(opened.name), 0x200);
    }
  }
}

function openDirectoryAt(
  api: UnixDescriptorFilesystemApiV1,
  directoryDescriptor: number,
  name: string,
): number {
  return api.openat(
    directoryDescriptor,
    namePointer(name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0,
  );
}

function namePointer(name: string): Pointer {
  return ptr(Buffer.from(`${name}\0`));
}

function assertBasename(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error('Descriptor-relative filesystem name is invalid.');
  }
}

function unixDescriptorFilesystemApiV1(): UnixDescriptorFilesystemApiV1 {
  if (process.platform === 'win32') {
    throw new Error('Descriptor-relative Workspace mutation is unavailable on Windows.');
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Descriptor-relative Workspace mutation is unavailable on this platform.');
  }
  if (unixLibrary) return unixLibrary.symbols;
  if (process.platform === 'darwin') {
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      __openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
      unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
      renameat: { args: ['i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
    });
    unixLibrary = {
      symbols: {
        openat: native.symbols.__openat,
        mkdirat: native.symbols.mkdirat,
        unlinkat: native.symbols.unlinkat,
        renameat: native.symbols.renameat,
      },
    };
  } else {
    unixLibrary = dlopen('libc.so.6', {
      openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
      unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
      renameat: { args: ['i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
    });
  }
  return unixLibrary.symbols;
}
