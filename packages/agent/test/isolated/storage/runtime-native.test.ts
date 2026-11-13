import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { CString, dlopen, ptr, toArrayBuffer } from '../../../src/runtime-ffi';
import { constants, Database } from '../../../src/runtime-sqlite';

test('native FFI keeps borrowed views live and reads bounded C strings', () => {
  const bytes = Buffer.from('before\0');
  const address = ptr(bytes);
  const borrowed = new Uint8Array(toArrayBuffer(address, 0, bytes.length));
  borrowed[0] = 65;
  expect(bytes[0]).toBe(65);
  expect(new CString(address).toString()).toBe('Aefore');
  expect(() => new CString(address, 0, 2)).toThrow('native_runtime_cstring_unterminated');
  if (process.platform === 'win32') {
    const kernel = dlopen('kernel32.dll', {
      GetCurrentProcess: { returns: 'u64' },
      GetCurrentProcessId: { returns: 'u32' },
      GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
      GetLastError: { returns: 'u32' },
    });
    try {
      expect(kernel.symbols.GetCurrentProcess()).toBe(0xffff_ffff_ffff_ffffn);
      expect(kernel.symbols.GetCurrentProcessId()).toBe(process.pid);
      const absent = Buffer.from('\\?\\\0', 'utf16le');
      expect(kernel.symbols.GetFileAttributesW(ptr(absent))).toBe(0xffff_ffff);
      expect(kernel.symbols.GetLastError()).not.toBe(0);
      expect(() => dlopen('kernel32.dll', { GetCurrentProcessId: { returns: 'ptr' } })).toThrow(
        'native_runtime_signature_unsupported',
      );
    } finally {
      kernel.close();
    }
    expect(() => kernel.symbols.GetCurrentProcessId()).toThrow('native_runtime_library_closed');
  } else {
    const libc = dlopen(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      { getpid: { returns: 'i32' } },
    );
    expect(libc.symbols.getpid()).toBe(process.pid);
    libc.close();
    expect(() => libc.symbols.getpid()).toThrow('native_runtime_library_closed');
  }
});

test('native SQLite binds real bytes, retains exact filenames and rolls back nested writes', () => {
  const root = temporaryDirectory('kite-runtime-native-');
  const filename = join(root, 'évidence.db');
  const database = new Database(filename, { strict: true });
  try {
    expect(database.filename).toBe(filename);
    database.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, bytes BLOB)');
    const write = database.prepare('INSERT INTO sample VALUES ($id, $bytes)');
    const nested = database.transaction(() => {
      write.run({ id: 2n, bytes: new SharedArrayBuffer(0) });
      throw Error('nested rollback');
    });
    database
      .transaction(() => {
        expect(database.inTransaction).toBe(true);
        write.run({ $id: 1n, id: 9007199254740993n, bytes: new Uint16Array([0x0201]) });
        expect(() => nested()).toThrow('nested rollback');
        expect(database.inTransaction).toBe(true);
      })
      .immediate();
    expect(database.inTransaction).toBe(false);
    expect(() => write.run({ id: 3n })).toThrow();
    write.finalize();

    const read = database.prepare('SELECT id, hex(bytes) AS hex FROM sample WHERE id >= ?');
    expect(read.safeIntegers(true).get(1n)).toEqual({ id: 9007199254740993n, hex: '0102' });
    expect(read.values()).toEqual([[9007199254740993n, '0102']]);
    expect(read.get(9007199254740994n)).toBeNull();
    database.close(true);

    const uri = pathToFileURL(filename);
    uri.search = 'mode=ro&immutable=1';
    const reopened = new Database(
      uri.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
    try {
      expect(reopened.filename).toBe(uri.href);
      expect(reopened.query('SELECT count(*) AS count FROM sample').get()).toEqual({ count: 1 });
    } finally {
      reopened.close(true);
    }

    if (process.platform !== 'win32') {
      const link = join(root, 'linked.db');
      symlinkSync(filename, link);
      expect(() => new Database(link, { readonly: true })).toThrow();
    }
  } finally {
    database.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('native SQLite reports extended trigger failures and releases failed statements', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE sample(id INTEGER PRIMARY KEY);
      CREATE TRIGGER deny_odd BEFORE INSERT ON sample WHEN NEW.id % 2 != 0
      BEGIN SELECT RAISE(ABORT, 'odd id denied'); END;
    `);
    const statement = database.prepare('INSERT INTO sample VALUES (?)');
    expect(() => database.exec('INSERT INTO sample VALUES (1)')).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'odd id denied' }),
    );
    expect(() => statement.run(1)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'odd id denied' }),
    );
    statement.run(2);
    statement.finalize();
    expect(database.query('SELECT id FROM sample').get()).toEqual({ id: 2 });
  } finally {
    database.close(true);
  }
});
