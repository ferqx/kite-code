import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { constants, fstatSync, openSync } from 'node:fs';

const retained = new Set<object>();
/** Darwin dirent/stat ABI; all names and metadata remain relative to retained directory FDs. */
export async function scanDarwinBrowserDirectory(input: {
  directory: string;
  identity: { dev: number; ino: number };
  closing(): boolean;
  closeUnknown(resource: object): void;
}) {
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    __openat: { args: ['i32', 'ptr', 'i32', 'u16'], returns: 'i32' },
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
    fstatat: { args: ['i32', 'ptr', 'ptr', 'i32'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
    __error: { args: [], returns: 'ptr' },
  });
  const api = library.symbols,
    started = performance.now();
  let entries = 0,
    bytes = 0,
    unknown = false;
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x1000000;
  const errno = () => new DataView(toArrayBuffer(api.__error()!, 0, 4));
  const keep = (resource: object) => {
    unknown = true;
    const owner = { resource, library };
    retained.add(owner);
    input.closeUnknown(owner);
  };
  const fail = (code: string) => Error('browser_native_storage_' + code);
  const deadline = () => {
    if (performance.now() - started > 500) throw fail('scan_limit');
  };
  async function visit(fd: number, depth: number, expected?: { dev: number; ino: number }) {
    const directory = api.fdopendir(fd);
    if (!directory) {
      if (api.close(fd) !== 0) keep({ fd });
      throw fail('open_failed');
    }
    try {
      const root = fstatSync(fd);
      if (expected && (root.dev !== expected.dev || root.ino !== expected.ino))
        throw fail('directory_changed');
      if (depth > 32) throw fail('scan_limit');
      for (;;) {
        if (input.closing()) return;
        deadline();
        errno().setInt32(0, 0, true);
        const entry = api.readdir(directory);
        if (!entry) {
          if (errno().getInt32(0, true) !== 0) throw fail('read_failed');
          break;
        }
        const head = new DataView(toArrayBuffer(entry, 0, 21));
        const length = head.getUint16(18, true);
        if (length < 1 || length > 1023 || head.getUint16(16, true) < 22 + length)
          throw fail('entry_invalid');
        const name = new TextDecoder('utf-8', { fatal: true }).decode(
          new Uint8Array(toArrayBuffer(entry, 21, length)),
        );
        if (name === '.' || name === '..') continue;
        if (name.includes('/') || name.includes('\0') || ++entries > 4096)
          throw fail('entry_limit');
        const cstring = Buffer.from(name + '\0'),
          stat = Buffer.alloc(144);
        if (api.fstatat(fd, ptr(cstring), ptr(stat), 0x20) !== 0) {
          if (errno().getInt32(0, true) === 2) continue;
          throw fail('stat_failed');
        }
        const size = stat.readBigInt64LE(96),
          allocated = stat.readBigInt64LE(104) * 512n;
        bytes += Number(size > allocated ? size : allocated);
        if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024 * 1024) throw fail('byte_limit');
        if ((stat.readUInt16LE(4) & 0xf000) === 0x4000) {
          const child = api.__openat(fd, ptr(cstring), flags, 0);
          if (child < 0) {
            if (errno().getInt32(0, true) === 2) continue;
            throw fail('open_failed');
          }
          await visit(child, depth + 1, {
            dev: stat.readInt32LE(0),
            ino: Number(stat.readBigUInt64LE(8)),
          });
        }
        if (entries % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      if (api.closedir(directory) !== 0) keep({ directory, fd });
    }
  }
  try {
    const fd = openSync(input.directory, flags);
    await visit(fd, 0, input.identity);
  } finally {
    // A failed close retains the native library and the exact original handle.
    if (!unknown) library.close();
  }
}
