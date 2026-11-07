import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { openSqliteStore, preflightSqliteStore } from '../../../src/sqlite';
import { auditFixture, trackedAudit } from './run-resume-audit-fixture';

test('current-format cold readonly recovery consumes saved certificates without scanning or rewriting completed history', async () => {
  const f = await auditFixture(1000);
  try {
    const before = readFileSync(f.path);
    expect(await preflightSqliteStore(f.profile)).toEqual({
      status: 'compatible',
      storeId: f.input.expectedStoreId,
      formatMajor: 1,
    });
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const cursor = (await readonly.getMetadata()).lastChangeCursor;
      const first = await readonly.verifyRunResume(f.input);
      const second = await readonly.verifyRunResume(f.input);
      expect(first.executions.map((row) => row.id)).toEqual(['next']);
      expect(second).toEqual(first);
      expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await readonly.close();
    }
    const cold = trackedAudit(f.path);
    try {
      expect(cold.verify(f.input).executions.map((row) => row.id)).toEqual(['next']);
      expect(cold.queries).not.toContain(
        'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
      );
      expect(cold.rows()).toBeLessThan(50);
    } finally {
      cold.close();
    }
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    f.close();
  }
}, 15000);

for (const fault of ['unsupported-format', 'checksum', 'unknown-migration'])
  test(`${fault} refuses before writer admission without rewriting the original Store`, async () => {
    const f = await auditFixture();
    try {
      const db = new Database(f.path);
      if (fault === 'unsupported-format') db.run('UPDATE storage_meta SET format_major=2');
      else if (fault === 'checksum')
        db.run("UPDATE schema_migration SET checksum='invalid' WHERE id='0001-baseline'");
      else db.run("INSERT INTO schema_migration VALUES('unknown','invalid','original')");
      db.close(true);
      const before = readFileSync(f.path);
      await expect(preflightSqliteStore(f.profile)).rejects.toMatchObject({
        code: 'store_incompatible',
      });
      for (const mode of ['readonly', 'readwrite'] as const)
        await expect(openSqliteStore({ ...f.profile, mode })).rejects.toMatchObject({
          code: 'store_incompatible',
        });
      expect(readFileSync(f.path)).toEqual(before);
    } finally {
      f.close();
    }
  });
