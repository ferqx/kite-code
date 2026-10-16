import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../../src/sqlite';
import type { AuditRow } from '../../../src/storage/sqlite/recovery-audit-validation';
import { auditFixture, trackedAudit } from './run-resume-audit-fixture';

for (const phase of ['before', 'after'])
  test(`SIGKILL ${phase} COMMIT keeps business and certificate atomic`, async () => {
    const f = await auditFixture();
    const marker = join(f.directory, 'at-commit');
    const beforeDb = new Database(f.path, { readonly: true });
    const before = beforeDb
      .query('SELECT covered_seq FROM recovery_audit WHERE run_id=?')
      .get(f.input.runId);
    beforeDb.close(true);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-audit-crash-child.ts', import.meta.url)),
        f.path,
        phase,
        marker,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const end = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() > end) throw Error('audit_crash_boundary_timeout');
        await Bun.sleep(5);
      }
      expect(readFileSync(marker, 'utf8')).toBe('audit-and-business-written');
      child.kill('SIGKILL');
      await child.exited;
      const reader = trackedAudit(f.path);
      try {
        expect(reader.verify(f.input).executions.map((row) => row.id)).toEqual(['next']);
        expect(
          reader.db.query("SELECT output_bytes FROM execution WHERE id='history-0'").get(),
        ).toEqual({ output_bytes: phase === 'after' ? 1 : 0 });
        const proof = reader.db
          .query('SELECT covered_seq FROM recovery_audit WHERE run_id=?')
          .get(f.input.runId);
        if (phase === 'after') expect(proof).not.toEqual(before);
        else expect(proof).toEqual(before);
        expect(
          reader.db.query('SELECT COUNT(*) AS count FROM recovery_audit_change').get(),
        ).toEqual({ count: 0 });
        expect(reader.db.query('SELECT writing FROM recovery_audit_writer').get()).toEqual({
          writing: 0,
        });
      } finally {
        reader.close();
      }
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      f.close();
    }
  }, 10000);

test('certificate SQL failure rolls back the original Run activation and its receipt', async () => {
  const f = await auditFixture();
  const store = await openSqliteStore(f.profile);
  const db = new Database(f.path);
  try {
    const expectedStoreId = f.input.expectedStoreId;
    await store.createSession({
      expectedStoreId,
      sessionId: 'other',
      workspaceId: 'w',
      commandId: 'create-other',
      subjectId: 'owner',
      title: 'other',
    });
    await store.acceptCommand({
      expectedStoreId,
      sessionId: 'other',
      commandId: 'audit-fault',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'audit rollback' },
    });
    const owner = (await store.acquireSessionOwner('other', 'writer'))!;
    const before = await store.getMetadata();
    const command = await store.getCommand('audit-fault');
    db.exec(
      "CREATE TRIGGER fail_certificate BEFORE INSERT ON recovery_audit BEGIN SELECT RAISE(ABORT,'fixture_certificate_failure'); END",
    );
    const error = await store
      .startRun({
        expectedStoreId,
        owner,
        commandId: 'audit-fault',
        configuration: f.configuration,
      })
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(db.query("SELECT id FROM run WHERE origin_command_id='audit-fault'").get()).toBeNull();
    expect(await store.getCommand('audit-fault')).toEqual(command);
    expect(await store.getMetadata()).toEqual(before);
    expect(db.query('SELECT writing FROM recovery_audit_writer').get()).toEqual({ writing: 0 });
    db.run('DROP TRIGGER fail_certificate');
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'audit-fault',
      configuration: f.configuration,
    });
    expect(db.query('SELECT version FROM recovery_audit WHERE run_id=?').get(run.id)).toEqual({
      version: 1,
    });
    await store.finishRun({
      expectedStoreId,
      owner,
      runId: run.id,
      status: 'cancelled',
      requirements: [],
    });
    expect(await store.releaseSessionOwner(owner)).toBe(true);
  } finally {
    db.close(true);
    await store.close();
    f.close();
  }
});

test('Run deletion and derived-proof cleanup roll back together without deleting other ledger rows', async () => {
  const f = await auditFixture();
  try {
    const db = new Database(f.path);
    const proof = db.query('SELECT * FROM recovery_audit WHERE run_id=?').get(f.input.runId);
    const identities = db.query('SELECT id FROM execution ORDER BY id').all();
    db.run('BEGIN IMMEDIATE');
    db.run('DELETE FROM run WHERE id=?', [f.input.runId]);
    expect(db.query('SELECT * FROM recovery_audit WHERE run_id=?').get(f.input.runId)).toBeNull();
    expect(
      db
        .query('SELECT COUNT(*) AS count FROM recovery_audit_record WHERE run_id=?')
        .get(f.input.runId),
    ).toEqual({ count: 0 });
    db.run('ROLLBACK');
    expect(db.query('SELECT * FROM recovery_audit WHERE run_id=?').get(f.input.runId)).toEqual(
      proof,
    );
    db.run('DELETE FROM run WHERE id=?', [f.input.runId]);
    expect(
      db
        .query('SELECT COUNT(*) AS count FROM recovery_audit_change WHERE run_id=?')
        .get(f.input.runId),
    ).toEqual({ count: 0 });
    expect(db.query('SELECT id FROM execution ORDER BY id').all()).toEqual(identities);
    db.close(true);
    const reader = trackedAudit(f.path);
    try {
      expect(() => reader.verify(f.input)).toThrow('run_not_found');
    } finally {
      reader.close();
    }
  } finally {
    f.close();
  }
});

for (const phase of ['planned', 'running'])
  test(`first cold ${phase} audit stays bounded across 100/10000 historical rows and ended children`, async () => {
    const counts: number[] = [];
    for (const history of [100, 10000]) {
      const f = await auditFixture(history, false, history);
      try {
        if (phase === 'running') {
          const db = new Database(f.path);
          db.run(
            "UPDATE execution SET state='running',dispatched=1,decision_source_json=? WHERE id='next'",
            [JSON.stringify({ kind: 'model_request', requestId: 'next' })],
          );
          db.close(true);
        }
        const reader = trackedAudit(f.path);
        try {
          const before = reader.db.query('SELECT total_changes() AS changes').get();
          const started = performance.now();
          const state = reader.verify(f.input);
          const elapsed = performance.now() - started;
          counts.push(reader.rows());
          expect(state.executions.map((row) => row.id)).toEqual(['next']);
          expect(state.checkpoint?.boundary).toBe('before_model_dispatch');
          expect(reader.queries).not.toContain(
            'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
          );
          expect(reader.db.query('SELECT total_changes() AS changes').get()).toEqual(before);
          const plan = reader.db
            .query(
              "EXPLAIN QUERY PLAN SELECT * FROM execution WHERE run_id=? AND kind='model' ORDER BY rowid DESC LIMIT 1",
            )
            .all(f.input.runId);
          expect(JSON.stringify(plan)).toContain('execution_recovery_model');
          const effect = reader.db
            .query(
              "EXPLAIN QUERY PLAN SELECT id FROM execution WHERE session_id=? AND kind IN('tool','job') AND json_extract(CASE WHEN json_valid(decision_source_json) THEN decision_source_json ELSE '{}' END,'$.modelExecutionId')=?",
            )
            .all('s', 'next');
          expect(JSON.stringify(effect)).toContain('execution_effect_model');
          const live = reader.db
            .query(
              "EXPLAIN QUERY PLAN SELECT e.id FROM execution e LEFT JOIN session s ON s.id=e.session_id WHERE (s.root_id=? OR e.root_session_id=?) AND e.state IN('planned','dispatching','running','outcome_unknown')",
            )
            .all('s', 's');
          expect(JSON.stringify(live)).toContain('execution_recovery_state');
          console.info(
            `cold recovery certificate: phase=${phase}, history=${history}, ended children=${history}, SQL result rows=${reader.rows()}, ${elapsed.toFixed(2)}ms`,
          );
        } finally {
          reader.close();
        }
      } finally {
        f.close();
      }
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThan(60);
  }, 60000);

for (const mutation of [
  'invalid-result',
  'malformed-source',
  'foreign-origin',
  'delete',
  'move-run',
  'replace-run',
  'replace-identity',
  'unknown',
] as const)
  test(`cold certificate rejects historical ${mutation} without a change_event`, async () => {
    const f = await auditFixture();
    try {
      const db = new Database(f.path);
      const before = db.query('SELECT last_change_cursor FROM storage_meta').get();
      if (mutation === 'invalid-result')
        db.run("UPDATE execution SET result_json='{}' WHERE id='history-0'");
      if (mutation === 'malformed-source')
        db.run("UPDATE execution SET decision_source_json='{broken' WHERE id='history-0'");
      if (mutation === 'foreign-origin')
        db.run("UPDATE execution SET origin_store_id='foreign' WHERE id='history-0'");
      if (mutation === 'delete') db.run("DELETE FROM execution WHERE id='history-0'");
      if (mutation === 'move-run')
        db.run("UPDATE execution SET run_id='unrelated' WHERE id='history-0'");
      if (mutation === 'replace-run' || mutation === 'replace-identity') {
        db.run('PRAGMA recursive_triggers=OFF');
        const prior = db.query<AuditRow, []>("SELECT * FROM execution WHERE id='history-0'").get()!;
        const replacement: AuditRow = {
          ...prior,
          ...(mutation === 'replace-run' ? { run_id: 'unrelated' } : { id: 'replacement-id' }),
        };
        const columns = Object.keys(replacement);
        db.run(
          `INSERT OR REPLACE INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          columns.map((column) => replacement[column]!),
        );
      }
      if (mutation === 'unknown')
        db.run("UPDATE execution SET kind='tool',state='outcome_unknown' WHERE id='history-0'");
      expect(db.query('SELECT last_change_cursor FROM storage_meta').get()).toEqual(before);
      db.close(true);
      const reader = trackedAudit(f.path);
      try {
        expect(() => reader.verify(f.input)).toThrow();
      } finally {
        reader.close();
      }
      const writer = await openSqliteStore(f.profile);
      try {
        const error = await writer.verifyRunResume(f.input).catch((error) => error);
        expect(error).toMatchObject({
          code:
            mutation === 'foreign-origin'
              ? 'operation_unverifiable'
              : 'run_resume_checkpoint_unavailable',
        });
      } finally {
        await writer.close();
      }
    } finally {
      f.close();
    }
  });

for (const mutation of ['foreign-origin', 'wrong-root', 'malformed-source'] as const)
  test(`live frontier rejects ${mutation} before and after its delta is consumed`, async () => {
    const f = await auditFixture();
    try {
      const db = new Database(f.path);
      if (mutation === 'foreign-origin')
        db.run("UPDATE execution SET origin_store_id='foreign' WHERE id='next'");
      if (mutation === 'wrong-root')
        db.run("UPDATE execution SET root_session_id='foreign' WHERE id='next'");
      if (mutation === 'malformed-source')
        db.run("UPDATE execution SET decision_source_json='{broken' WHERE id='next'");
      db.close(true);
      const reader = trackedAudit(f.path);
      try {
        expect(() => reader.verify(f.input)).toThrow();
      } finally {
        reader.close();
      }
      const writer = await openSqliteStore(f.profile);
      try {
        const error = await writer.verifyRunResume(f.input).catch((error) => error);
        expect(error).toMatchObject({
          code:
            mutation === 'malformed-source'
              ? 'run_resume_checkpoint_unavailable'
              : 'operation_unverifiable',
        });
      } finally {
        await writer.close();
      }
    } finally {
      f.close();
    }
  });

test('a new terminal effect invalidates its old failed Model certificate across exact provenance dependencies', async () => {
  const f = await auditFixture(4, true);
  try {
    const db = new Database(f.path);
    const base = db.query<AuditRow, []>("SELECT * FROM execution WHERE id='base'").get()!;
    const row: AuditRow = {
      ...base,
      id: 'late-effect',
      kind: 'tool',
      step_id: 'old-failed',
      call_id: 'late-effect',
      adapter_id: 'fixture.effect',
      parent_execution_id: 'old-failed',
      decision_source_json: JSON.stringify({
        kind: 'model_decision',
        modelExecutionId: 'old-failed',
      }),
      result_json: JSON.stringify({ outcome: 'succeeded', content: 'known terminal effect' }),
    };
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      columns.map((column) => row[column]!),
    );
    expect(
      db.query("SELECT 1 FROM recovery_audit_change WHERE record_id='old-failed'").get(),
    ).not.toBeNull();
    db.close(true);
    const reader = trackedAudit(f.path);
    try {
      expect(() => reader.verify(f.input)).toThrow('run_resume_checkpoint_unavailable');
    } finally {
      reader.close();
    }
  } finally {
    f.close();
  }
});

for (const relation of ['claimed-root', 'actual-root', 'claimed-orphan'])
  test(`certified history still rejects a runless unknown linked through ${relation}`, async () => {
    const f = await auditFixture();
    try {
      const db = new Database(f.path);
      db.run(
        "INSERT INTO session(id,workspace_id,root_id,title,context_selection_id) VALUES('foreign','w','foreign','foreign','foreign-selection')",
      );
      const base = db.query<AuditRow, []>("SELECT * FROM execution WHERE id='base'").get()!;
      const row: AuditRow = {
        ...base,
        id: 'unknown-outside-run',
        kind: 'job',
        run_id: null,
        session_id:
          relation === 'claimed-root' ? 'foreign' : relation === 'claimed-orphan' ? 'missing' : 's',
        root_session_id: relation === 'actual-root' ? 'foreign' : 's',
        state: 'outcome_unknown',
      };
      const columns = Object.keys(row);
      db.run(
        `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        columns.map((column) => row[column]!),
      );
      db.close(true);
      const reader = trackedAudit(f.path);
      try {
        expect(() => reader.verify(f.input)).toThrow('run_resume_checkpoint_unavailable');
      } finally {
        reader.close();
      }
    } finally {
      f.close();
    }
  });

test('a valid old source change after lease acquisition rejects final CAS without adopting any attempt', async () => {
  const f = await auditFixture();
  const store = await openSqliteStore(f.profile);
  const db = new Database(f.path);
  try {
    const state = await store.verifyRunResume(f.input);
    const original = await store.getExecution('next');
    const begun = await store.beginRunResume({
      ...f.input,
      checkpoint: state.checkpoint!,
      instanceId: 'new',
    });
    db.run("UPDATE execution SET decision_source_json=? WHERE id='history-0'", [
      JSON.stringify({ kind: 'model_request', requestId: 'history-0', changed: true }),
    ]);
    const error = await store
      .commitRunResume({
        expectedStoreId: f.input.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: state.checkpoint!,
      })
      .catch((error) => error);
    expect(error).toMatchObject({ code: 'run_resume_checkpoint_changed' });
    expect(await store.getExecution('next')).toEqual(original);
    expect((await store.getCommand('resume'))!.receipt).toBeNull();
    await store.releaseRunResumeLease(begun.lease!);
  } finally {
    db.close(true);
    await store.close();
    f.close();
  }
});

test('direct certificate edits are guarded and dropped/restored triggers force the original full audit', async () => {
  const f = await auditFixture();
  try {
    const db = new Database(f.path);
    expect(() => db.run('DELETE FROM recovery_audit')).toThrow('recovery_audit_write_denied');
    // Populate a delta so deletion actually reaches the row guard.
    db.run("UPDATE execution SET output_bytes=output_bytes WHERE id='history-0'");
    expect(() => db.run('DELETE FROM recovery_audit_change')).toThrow(
      'recovery_audit_write_denied',
    );
    const trigger = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_schema WHERE name='execution_recovery_update'",
      )
      .get()!.sql;
    db.run('DROP TRIGGER execution_recovery_update');
    db.run("UPDATE execution SET result_json='{}' WHERE id='history-1'");
    db.exec(trigger);
    db.close(true);
    const reader = trackedAudit(f.path);
    try {
      expect(() => reader.verify(f.input)).toThrow('run_resume_checkpoint_unavailable');
      expect(reader.queries).toContain(
        'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
      );
    } finally {
      reader.close();
    }
  } finally {
    f.close();
  }
});
