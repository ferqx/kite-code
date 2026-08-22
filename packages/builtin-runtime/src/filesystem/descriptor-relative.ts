import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { closeSync, constants } from 'node:fs';
import { join } from 'node:path';

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

interface WindowsFilesystemApiV1 {
  CreateFileW(
    path: Pointer,
    desiredAccess: number,
    shareMode: number,
    securityAttributes: Pointer | null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: number | bigint,
  ): number | bigint;
  GetFileInformationByHandle(handle: number | bigint, information: Pointer): boolean;
  CreateDirectoryW(path: Pointer, securityAttributes: Pointer | null): boolean;
  WriteFile(
    handle: number | bigint,
    buffer: Pointer,
    bytesToWrite: number,
    bytesWritten: Pointer,
    overlapped: Pointer | null,
  ): boolean;
  FlushFileBuffers(handle: number | bigint): boolean;
  MoveFileExW(existingPath: Pointer, newPath: Pointer, flags: number): boolean;
  DeleteFileW(path: Pointer): boolean;
  CloseHandle(handle: number | bigint): boolean;
  GetLastError(): number;
}

let windowsLibrary: WindowsFilesystemApiV1 | undefined;

const WINDOWS_GENERIC_READ = 0x8000_0000;
const WINDOWS_GENERIC_WRITE = 0x4000_0000;
const WINDOWS_FILE_SHARE_READ = 0x1;
const WINDOWS_FILE_SHARE_WRITE = 0x2;
const WINDOWS_CREATE_NEW = 1;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x10;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x80;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const WINDOWS_FILE_FLAG_WRITE_THROUGH = 0x8000_0000;
const WINDOWS_MOVEFILE_REPLACE_EXISTING = 0x1;
const WINDOWS_MOVEFILE_WRITE_THROUGH = 0x8;

/**
 * Windows equivalent of descriptor-relative publication. Every directory from
 * the prepared ancestor through the target parent remains open without
 * FILE_SHARE_DELETE, so it cannot be renamed or removed while a unique
 * temporary sibling is written and atomically replaced.
 */
export function atomicReplaceInLockedWindowsDirectoryV1(input: {
  readonly ancestorDirectory: string;
  readonly directorySegments: readonly string[];
  readonly targetName: string;
  readonly temporaryName: string;
  readonly content: string;
  readonly beforePublish: () => void;
}): void {
  if (process.platform !== 'win32') {
    throw new Error('Windows locked-directory publication is unavailable on this platform.');
  }
  assertBasename(input.targetName);
  assertBasename(input.temporaryName);
  for (const segment of input.directorySegments) assertBasename(segment);

  const api = windowsFilesystemApiV1();
  const directories: Array<number | bigint> = [];
  let directoryPath = input.ancestorDirectory;
  let temporaryPath = '';
  let temporaryHandle: number | bigint | undefined;
  let published = false;
  try {
    directories.push(openLockedWindowsDirectory(api, directoryPath));
    for (const segment of input.directorySegments) {
      directoryPath = join(directoryPath, segment);
      directories.push(openOrCreateLockedWindowsDirectory(api, directoryPath));
    }
    temporaryPath = join(directoryPath, input.temporaryName);
    const targetPath = join(directoryPath, input.targetName);
    temporaryHandle = createWindowsTemporaryFile(api, temporaryPath);
    writeWindowsFile(api, temporaryHandle, input.content);
    if (!api.FlushFileBuffers(temporaryHandle))
      throw windowsFilesystemError(api, 'flush temporary file');
    closeWindowsHandle(api, temporaryHandle);
    temporaryHandle = undefined;
    input.beforePublish();
    if (
      !api.MoveFileExW(
        widePointer(temporaryPath),
        widePointer(targetPath),
        WINDOWS_MOVEFILE_REPLACE_EXISTING | WINDOWS_MOVEFILE_WRITE_THROUGH,
      )
    ) {
      throw windowsFilesystemError(api, 'publish temporary file');
    }
    published = true;
  } finally {
    if (temporaryHandle !== undefined) closeWindowsHandle(api, temporaryHandle);
    if (!published && temporaryPath) api.DeleteFileW(widePointer(temporaryPath));
    for (let index = directories.length - 1; index >= 0; index--) {
      closeWindowsHandle(api, directories[index]!);
    }
  }
}

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

function openOrCreateLockedWindowsDirectory(
  api: WindowsFilesystemApiV1,
  path: string,
): number | bigint {
  try {
    return openLockedWindowsDirectory(api, path);
  } catch {
    // Creation is only attempted below an already delete-locked parent. A
    // concurrent creator is harmless: the second open validates the entry.
    api.CreateDirectoryW(widePointer(path), null);
    return openLockedWindowsDirectory(api, path);
  }
}

function openLockedWindowsDirectory(api: WindowsFilesystemApiV1, path: string): number | bigint {
  const handle = api.CreateFileW(
    widePointer(path),
    WINDOWS_GENERIC_READ,
    WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE,
    null,
    WINDOWS_OPEN_EXISTING,
    WINDOWS_FILE_FLAG_BACKUP_SEMANTICS | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
    0,
  );
  if (invalidWindowsHandle(handle))
    throw windowsFilesystemError(api, `open directory ${JSON.stringify(path)}`);
  try {
    const information = new Uint8Array(64);
    if (!api.GetFileInformationByHandle(handle, ptr(information))) {
      throw windowsFilesystemError(api, `inspect directory ${JSON.stringify(path)}`);
    }
    const attributes = new DataView(information.buffer).getUint32(0, true);
    if (
      (attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0 ||
      (attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0
    ) {
      throw new Error(
        `Windows publication directory is not a non-reparse directory: ${JSON.stringify(path)}.`,
      );
    }
    return handle;
  } catch (error) {
    closeWindowsHandle(api, handle);
    throw error;
  }
}

function createWindowsTemporaryFile(api: WindowsFilesystemApiV1, path: string): number | bigint {
  const handle = api.CreateFileW(
    widePointer(path),
    WINDOWS_GENERIC_WRITE,
    WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE,
    null,
    WINDOWS_CREATE_NEW,
    WINDOWS_FILE_ATTRIBUTE_NORMAL | WINDOWS_FILE_FLAG_WRITE_THROUGH,
    0,
  );
  if (invalidWindowsHandle(handle)) {
    throw windowsFilesystemError(api, `create private temporary file ${JSON.stringify(path)}`);
  }
  return handle;
}

function writeWindowsFile(
  api: WindowsFilesystemApiV1,
  handle: number | bigint,
  content: string,
): void {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.subarray(offset);
    const written = new Uint8Array(4);
    if (!api.WriteFile(handle, ptr(remaining), remaining.length, ptr(written), null)) {
      throw windowsFilesystemError(api, 'write temporary file');
    }
    const count = new DataView(written.buffer).getUint32(0, true);
    if (count === 0 || count > remaining.length) {
      throw new Error('Windows publication wrote an invalid temporary-file byte count.');
    }
    offset += count;
  }
}

function widePointer(value: string): Pointer {
  return ptr(Buffer.from(`${value}\0`, 'utf16le'));
}

function invalidWindowsHandle(handle: number | bigint): boolean {
  return handle === 0 || handle === -1 || handle === BigInt('18446744073709551615');
}

function closeWindowsHandle(api: WindowsFilesystemApiV1, handle: number | bigint): void {
  if (!invalidWindowsHandle(handle)) api.CloseHandle(handle);
}

function windowsFilesystemError(api: WindowsFilesystemApiV1, action: string): Error {
  return new Error(
    `Windows locked-directory publication could not ${action} (error ${api.GetLastError()}).`,
  );
}

function windowsFilesystemApiV1(): WindowsFilesystemApiV1 {
  if (windowsLibrary) return windowsLibrary;
  windowsLibrary = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    CreateDirectoryW: { args: ['ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    FlushFileBuffers: { args: ['u64'], returns: 'bool' },
    MoveFileExW: { args: ['ptr', 'ptr', 'u32'], returns: 'bool' },
    DeleteFileW: { args: ['ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
  }).symbols;
  return windowsLibrary;
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
