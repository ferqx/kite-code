import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { openSqliteStore, preflightSqliteStore } from '../../../src/sqlite';
import { schemaQuery, supportedSchemas } from '../../../src/storage/sqlite/migrations';
import { restoreLegacyExecutionSchema } from '../storage/legacy-execution-schema-fixture';
import { auditFixture, trackedAudit } from './run-resume-audit-fixture';

function legacy(path: string) {
  const db = new Database(path);
  try {
    restoreLegacyExecutionSchema(db, 0);
    const baseline = JSON.parse(supportedSchemas()[0]!.schema) as { type: string; name: string }[];
    const names = new Set(baseline.map((row) => row.name));
    const extra = db
      .query<{ type: string; name: string }, []>(schemaQuery)
      .all()
      .filter((row) => !names.has(row.name));
    db.run('BEGIN IMMEDIATE');
    for (const type of ['trigger', 'index', 'table'])
      for (const row of extra.filter((row) => row.type === type))
        db.run(`DROP ${type.toUpperCase()} "${row.name}"`);
    db.run(
      "DELETE FROM schema_migration WHERE id IN('0002-recovery-audit','0003-session-reconciliation','0004-pending-input-order')",
    );
    db.run('ALTER TABLE command DROP COLUMN pending_order');
    db.run('COMMIT');
    expect(JSON.stringify(db.query(schemaQuery).all())).toBe(supportedSchemas()[0]!.schema);
  } finally {
    db.close(true);
  }
}

test('legacy readonly is unchanged; one writer upgrade certifies all history then cold reads only the frontier', async () => {
  const f = await auditFixture(1000);
  try {
    legacy(f.path);
    const before = readFileSync(f.path);
    expect(await preflightSqliteStore(f.profile)).toEqual({
      status: 'compatible',
      storeId: f.input.expectedStoreId,
      formatMajor: 1,
    });
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    let metadata: Awaited<ReturnType<typeof readonly.getMetadata>>;
    try {
      metadata = await readonly.getMetadata();
      const state = await readonly.verifyRunResume(f.input);
      expect(state.executions.map((row) => row.id)).toEqual(['next']);
    } finally {
      await readonly.close();
    }
    expect(readFileSync(f.path)).toEqual(before);
    const old = new Database(f.path, { readonly: true });
    expect(old.query('SELECT id FROM schema_migration ORDER BY id').all()).toEqual([
      { id: '0001-baseline' },
    ]);
    old.close(true);
    const upgraded = await openSqliteStore(f.profile);
    try {
      expect(await upgraded.getMetadata()).toEqual(metadata!);
      const db = new Database(f.path, { readonly: true });
      try {
        expect(db.query('SELECT id FROM schema_migration ORDER BY id').all()).toEqual([
          { id: '0001-baseline' },
          { id: '0002-recovery-audit' },
          { id: '0003-session-reconciliation' },
          { id: '0004-pending-input-order' },
          { id: '0005-authorization-check' },
          { id: '0006-input-file-imports' },
        ]);
        expect(
          db
            .query('SELECT COUNT(*) AS count FROM recovery_audit_record WHERE run_id=?')
            .get(f.input.runId),
        ).toEqual({ count: 1001 });
        expect(db.query('SELECT COUNT(*) AS count FROM recovery_audit_change').get()).toEqual({
          count: 0,
        });
      } finally {
        db.close(true);
      }
    } finally {
      await upgraded.close();
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
  } finally {
    f.close();
  }
}, 15000);

for (const fault of ['checksum', 'unknown-migration'])
  test(`new ${fault} refuses without rewriting the original Store`, async () => {
    const f = await auditFixture();
    try {
      const db = new Database(f.path);
      if (fault === 'checksum')
        db.run("UPDATE schema_migration SET checksum='invalid' WHERE id='0002-recovery-audit'");
      else db.run("INSERT INTO schema_migration VALUES('0003-unknown','invalid','original')");
      db.close(true);
      const before = readFileSync(f.path);
      const error = await preflightSqliteStore(f.profile).catch((error) => error);
      expect(error).toMatchObject({ code: 'store_incompatible' });
      expect(readFileSync(f.path)).toEqual(before);
      const opening = await openSqliteStore(f.profile).catch((error) => error);
      expect(opening).toMatchObject({ code: 'store_incompatible' });
      expect(readFileSync(f.path)).toEqual(before);
    } finally {
      f.close();
    }
  });
