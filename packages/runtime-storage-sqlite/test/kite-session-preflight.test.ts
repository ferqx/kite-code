import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openKiteSessionStoreDatabase,
  validateKiteSessionStoreDatabase,
} from '../src/kite-session-runtime-file';

describe('Session Store read-only upgrade preflight', () => {
  test('absent preflight creates no file, and incompatible data is unchanged on open failure', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-store-preflight-')));
    const path = join(root, 'kite-session.sqlite');
    try {
      validateKiteSessionStoreDatabase(path);
      expect(existsSync(path)).toBe(false);
      const database = new Database(path);
      database.run('CREATE TABLE unsupported_format (value TEXT)');
      database.run("INSERT INTO unsupported_format VALUES ('preserve')");
      database.close();
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      const before = readFileSync(path);
      expect(() => validateKiteSessionStoreDatabase(path)).toThrow('incompatible');
      expect(() => openKiteSessionStoreDatabase(path)).toThrow('incompatible');
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
