import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { closeSync, constants } from 'node:fs';
import { AgentError } from '../storage/types';

let library: ReturnType<typeof load> | undefined;
function load() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    ...(process.platform === 'darwin'
      ? { __openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }
      : { openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }),
    renameat: { args: ['i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
    linkat: { args: ['i32', 'ptr', 'i32', 'ptr', 'i32'], returns: 'i32' },
    unlinkat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
    ...(process.platform === 'darwin'
      ? { __error: { args: [], returns: 'ptr' } as const }
      : { __errno_location: { args: [], returns: 'ptr' } as const }),
  });
}
function api() {
  library ??= load();
  return library.symbols;
}
function errnoView(): DataView {
  const symbols = api();
  const p = '__error' in symbols ? symbols.__error() : symbols.__errno_location();
  return new DataView(toArrayBuffer(p!, 0, 4));
}
function error(): never {
  const errno = errnoView().getInt32(0, true);
  throw Object.assign(
    new AgentError(
      errno === 2
        ? 'ENOENT'
        : errno === 17
          ? 'EEXIST'
          : errno === 20
            ? 'ENOTDIR'
            : 'file_io_failed',
    ),
    { errno },
  );
}
const name = (value: string) => ptr(Buffer.from(`${value}\0`));
export function openAt(parent: number, value: string, flags: number, mode = 0): number {
  const symbols = api();
  const operation = '__openat' in symbols ? symbols.__openat : symbols.openat;
  const fd = operation(
    parent,
    name(value),
    flags | (process.platform === 'darwin' ? 0x1000000 : 0x80000),
    mode,
  );
  if (fd < 0) error();
  return fd;
}
export function publishAt(parent: number, temp: string, target: string, createOnly: boolean): void {
  const result = createOnly
    ? api().linkat(parent, name(temp), parent, name(target), 0)
    : api().renameat(parent, name(temp), parent, name(target));
  if (result < 0) error();
}
export function unlinkAt(parent: number, value: string): void {
  if (api().unlinkat(parent, name(value), 0) < 0) error();
}
export function listAt(
  parent: number,
): { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[] {
  const fd = openAt(parent, '.', directoryFlags);
  if (fd < 0) error();
  const directory = api().fdopendir(fd);
  if (!directory) {
    closeSync(fd);
    error();
  }
  const result: { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }[] = [];
  try {
    while (true) {
      errnoView().setInt32(0, 0, true);
      const entry = api().readdir(directory);
      if (!entry) {
        if (errnoView().getInt32(0, true) !== 0) error();
        break;
      }
      const typeOffset = process.platform === 'darwin' ? 20 : 18;
      const type = new Uint8Array(toArrayBuffer(entry, typeOffset, 1))[0];
      const length = new DataView(toArrayBuffer(entry, 16, 2)).getUint16(0, true) - typeOffset - 1;
      if (length < 1 || length > 2048) throw new AgentError('file_directory_invalid');
      const encoded = new Uint8Array(toArrayBuffer(entry, typeOffset + 1, length));
      const end = encoded.indexOf(0);
      if (end < 0) throw new AgentError('file_directory_invalid');
      let value: string;
      try {
        value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          encoded.subarray(0, end),
        );
      } catch {
        throw new AgentError('file_directory_encoding_invalid');
      }
      if (value !== '.' && value !== '..') {
        if (type === 0) throw new AgentError('file_directory_type_unavailable');
        result.push({
          name: value,
          kind: type === 8 ? 'file' : type === 4 ? 'directory' : type === 10 ? 'symlink' : 'other',
        });
      }
    }
  } finally {
    api().closedir(directory);
  }
  return result;
}
export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
