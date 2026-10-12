import { win32 } from 'node:path';
import type { CandidateDirectory, CandidateIgnoreFile } from './file-candidate-filesystem';

type Entry = { name: string; type: number };
const fail = (code = 'file_candidate_directory_unavailable'): never => {
  throw Error(code);
};
function component(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/:*?"<>|]/u.test(name) ||
    [...name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /[. ]$/u.test(name) ||
    /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)
  )
    fail('file_candidate_name_invalid');
  const bytes = Buffer.from(name, 'utf16le');
  if (
    bytes.length > 65534 ||
    new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes) !== name
  )
    fail('file_candidate_name_invalid');
  return bytes;
}

/** FILE_ID_BOTH_DIR_INFO records, bounded by the caller's actual native buffer. */
export function decodeWindowsCandidateRecords(bytes: Uint8Array): readonly Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    entries: Entry[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (;;) {
    if (bytes.length - offset < 104) fail('file_candidate_name_invalid');
    const next = view.getUint32(offset, true),
      length = view.getUint32(offset + 60, true);
    if (
      !length ||
      length % 2 ||
      length > bytes.length - offset - 104 ||
      (next && (next % 8 || next < 104 + length || next > bytes.length - offset - 104))
    )
      fail('file_candidate_name_invalid');
    const name = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(offset + 104, offset + 104 + length),
    );
    if (name !== '.' && name !== '..') {
      component(name);
      if (seen.has(name)) fail('file_candidate_name_invalid');
      seen.add(name);
      const attributes = view.getUint32(offset + 56, true);
      if (attributes & 0x40) fail('file_candidate_type_unavailable');
      entries.push({
        name,
        type: attributes & 0x400 ? 10 : attributes & 0x10 ? 4 : 8,
      });
    }
    if (!next) return entries;
    offset += next;
  }
}

type Handle = bigint | number;
type Held = { handle: Handle; refs: number; uncertain: boolean };
const uncertainHandles = new Set<Held>();
const borrowedMemory = new Set<object>();
const systemLibraries = new Set<object>();
function borrowed<T>(memory: object, perform: () => T): T {
  borrowedMemory.add(memory);
  try {
    return perform();
  } finally {
    borrowedMemory.delete(memory);
  }
}
let native: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    fail('file_candidate_platform_unavailable');
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
    GetFileType: { args: ['u64'], returns: 'u32' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  systemLibraries.add(kernel);
  const system = new Uint16Array(32768);
  const size = borrowed({ system }, () =>
    kernel.symbols.GetSystemDirectoryW(ptr(system), system.length),
  );
  if (!size || size >= system.length) fail();
  const ntdll = dlopen(
    `${Buffer.from(system.buffer, 0, size * 2).toString('utf16le')}\\ntdll.dll`,
    {
      NtCreateFile: {
        args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
        returns: 'i32',
      },
    },
  );
  systemLibraries.add(ntdll);
  const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');
  const release = (held: readonly Held[]) => {
    const errors: unknown[] = [];
    for (const entry of [...held].reverse()) {
      if (entry.uncertain) {
        errors.push(Error('file_candidate_close_unconfirmed'));
        continue;
      }
      entry.refs--;
      if (entry.refs === 0 && !kernel.symbols.CloseHandle(entry.handle)) {
        entry.uncertain = true;
        uncertainHandles.add(entry);
        errors.push(Error('file_candidate_close_unconfirmed'));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'file_candidate_close_unconfirmed');
  };
  const facts = (handle: Handle) => {
    const id = new Uint8Array(24),
      basic = new Uint8Array(40),
      standard = new Uint8Array(24);
    return borrowed({ id, basic, standard }, () => {
      if (
        kernel.symbols.GetFileType(handle) !== 1 ||
        !kernel.symbols.GetFileInformationByHandleEx(handle, 18, ptr(id), id.length) ||
        !kernel.symbols.GetFileInformationByHandleEx(handle, 0, ptr(basic), basic.length) ||
        !kernel.symbols.GetFileInformationByHandleEx(handle, 1, ptr(standard), standard.length)
      )
        fail();
      const i = new DataView(id.buffer),
        b = new DataView(basic.buffer),
        v = new DataView(standard.buffer);
      const attributes = b.getUint32(32, true),
        directory = standard[21] !== 0;
      if (attributes & (0x400 | 0x40) || !!(attributes & 0x10) !== directory || standard[20])
        fail('file_candidate_type_unavailable');
      const fileId = i.getBigUint64(8, true) | (i.getBigUint64(16, true) << 64n),
        volume = i.getBigUint64(0, true),
        size = v.getBigInt64(8, true);
      if (size < 0n) fail('file_candidate_type_unavailable');
      return {
        directory,
        identity: `${volume}:${fileId}`,
        links: v.getUint32(16, true),
        size,
        stamp: `${attributes}:${volume}:${fileId}:${b.getBigInt64(0, true)}:${b.getBigInt64(16, true)}:${b.getBigInt64(24, true)}:${size}:${v.getUint32(16, true)}`,
      };
    });
  };
  const checked = (handle: Handle, directory: boolean) => {
    const held: Held = { handle, refs: 1, uncertain: false };
    try {
      if (facts(handle).directory !== directory) fail('file_candidate_type_unavailable');
      return held;
    } catch (error) {
      try {
        release([held]);
      } catch (close) {
        throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
      }
      throw error;
    }
  };
  const relative = (parent: Handle, name: string, directory: boolean) => {
    const text = component(name),
      unicode = new Uint8Array(16),
      objects = new Uint8Array(48),
      io = new Uint8Array(16),
      result = new BigUint64Array(1);
    const u = new DataView(unicode.buffer),
      o = new DataView(objects.buffer);
    u.setUint16(0, text.length, true);
    u.setUint16(2, text.length, true);
    u.setBigUint64(8, BigInt(ptr(text)), true);
    o.setUint32(0, 48, true);
    o.setBigUint64(8, BigInt(parent), true);
    o.setBigUint64(16, BigInt(ptr(unicode)), true);
    o.setUint32(24, 0, true);
    const status = borrowed({ text, unicode, objects, io, result }, () =>
      ntdll.symbols.NtCreateFile(
        ptr(result),
        0x100081,
        ptr(objects),
        ptr(io),
        null,
        0,
        directory ? 3 : 1,
        1,
        0x200000 | 0x20 | (directory ? 1 : 0x40),
        null,
        0,
      ),
    );
    const validHandle = result[0] && result[0] !== 0xffffffffffffffffn;
    const completion = new DataView(io.buffer);
    if (
      status !== 0 ||
      !validHandle ||
      completion.getInt32(0, true) !== 0 ||
      completion.getBigUint64(8, true) !== 1n
    ) {
      const error = Error('file_candidate_open_unavailable');
      if (validHandle) {
        const held: Held = { handle: result[0]!, refs: 1, uncertain: false };
        try {
          release([held]);
        } catch (close) {
          throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
        }
      }
      throw error;
    }
    return checked(result[0]!, directory);
  };
  const chain = (path: string) => {
    path = win32.normalize(path);
    const root = win32.parse(path).root;
    if (
      !win32.isAbsolute(path) ||
      !root ||
      path.includes('\0') ||
      path.length > 32760 ||
      !/^[a-z]:\\$/iu.test(root)
    )
      fail('file_candidate_name_invalid');
    const parts = path.slice(root.length).split('\\').filter(Boolean),
      held: Held[] = [];
    try {
      const rootName = wide(root);
      const handle = borrowed({ rootName }, () =>
        kernel.symbols.CreateFileW(ptr(rootName), 0x100081, 3, null, 3, 0x02200000, 0),
      );
      if (!handle || BigInt(handle) === 0xffffffffffffffffn)
        fail('file_candidate_open_unavailable');
      held.push(checked(handle, true));
      for (const part of parts) held.push(relative(held.at(-1)!.handle, part, true));
      return held;
    } catch (error) {
      try {
        release(held);
      } catch (close) {
        throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
      }
      throw error;
    }
  };
  const owned = (held: Held[]): CandidateDirectory => {
    const entry = held.at(-1)!,
      original = facts(entry.handle).identity;
    let closed = false,
      closeError: unknown;
    let listed: ReadonlySet<string> | undefined;
    const verify = () => {
      if (closed || held.some((h) => h.uncertain) || facts(entry.handle).identity !== original)
        fail('file_candidate_directory_changed');
    };
    return {
      verifyCanonicalPath(path) {
        verify();
        const proof = chain(path);
        try {
          if (facts(proof.at(-1)!.handle).identity !== original)
            fail('file_candidate_directory_changed');
        } finally {
          release(proof);
        }
      },
      stamp() {
        verify();
        return facts(entry.handle).stamp;
      },
      entries() {
        verify();
        const before = facts(entry.handle).stamp,
          entries: Entry[] = [],
          seen = new Set<string>();
        const bytes = new Uint8Array(65536);
        let restart = true;
        for (;;) {
          bytes.fill(0);
          const result = borrowed({ bytes }, () => {
            const success = kernel.symbols.GetFileInformationByHandleEx(
              entry.handle,
              restart ? 11 : 10,
              ptr(bytes),
              bytes.length,
            );
            return { success, error: success ? 0 : kernel.symbols.GetLastError() };
          });
          if (!result.success) {
            if (result.error === 18) break;
            fail();
          }
          restart = false;
          for (const record of decodeWindowsCandidateRecords(bytes)) {
            if (seen.has(record.name)) fail('file_candidate_name_invalid');
            seen.add(record.name);
            entries.push(record);
          }
        }
        if (before !== facts(entry.handle).stamp) fail('file_candidate_directory_changed');
        listed = new Set(entries.map((record) => record.name));
        return entries.map(({ name, type }) => ({ name, type }));
      },
      openDirectory(name) {
        verify();
        const child = relative(entry.handle, name, true);
        const members = [child];
        try {
          if (!listed?.has(name)) fail('file_candidate_directory_changed');
          for (const parent of held) parent.refs++;
          members.unshift(...held);
          return owned(members);
        } catch (error) {
          try {
            release(members);
          } catch (close) {
            throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
          }
          throw error;
        }
      },
      openIgnoreFile() {
        verify();
        const file = relative(entry.handle, '.gitignore', false);
        const members = [file];
        try {
          const initial = facts(file.handle);
          if (!listed?.has('.gitignore') || initial.links !== 1)
            fail('file_candidate_ignore_invalid');
          for (const parent of held) parent.refs++;
          members.unshift(...held);
          let consumed = 0n;
          let ended = false,
            errorOnClose: unknown;
          return {
            facts() {
              if (ended) fail('file_candidate_ignore_invalid');
              const current = facts(file.handle);
              return { regular: !current.directory, links: current.links, stamp: current.stamp };
            },
            read(buffer) {
              if (ended) fail('file_candidate_ignore_invalid');
              const count = new Uint32Array(1);
              if (
                !buffer.length ||
                !borrowed({ buffer, count }, () =>
                  kernel.symbols.ReadFile(
                    file.handle,
                    ptr(buffer),
                    buffer.length,
                    ptr(count),
                    null,
                  ),
                ) ||
                count[0]! > buffer.length
              )
                fail('file_candidate_ignore_invalid');
              consumed += BigInt(count[0]!);
              if (consumed > initial.size || (!count[0] && consumed !== initial.size))
                fail('file_candidate_ignore_invalid');
              if (!count[0] && facts(file.handle).stamp !== initial.stamp)
                fail('file_candidate_ignore_invalid');
              return count[0]!;
            },
            close() {
              if (ended) {
                if (errorOnClose) throw errorOnClose;
                return;
              }
              ended = true;
              try {
                release(members);
              } catch (error) {
                errorOnClose = error;
                throw error;
              }
            },
          } satisfies CandidateIgnoreFile;
        } catch (error) {
          try {
            release(members);
          } catch (close) {
            throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
          }
          throw error;
        }
      },
      close() {
        if (closed) {
          if (closeError) throw closeError;
          return;
        }
        closed = true;
        try {
          release(held);
        } catch (error) {
          closeError = error;
          throw error;
        }
      },
    };
  };
  return (path: string) => {
    const held = chain(path);
    try {
      return owned(held);
    } catch (error) {
      try {
        release(held);
      } catch (close) {
        throw new AggregateError([error, close], 'file_candidate_close_unconfirmed');
      }
      throw error;
    }
  };
}
/** Native libraries are loaded only for an actual Windows Workspace read. */
export function openWindowsCandidateDirectory(path: string): CandidateDirectory {
  native ??= load();
  return native(path);
}
