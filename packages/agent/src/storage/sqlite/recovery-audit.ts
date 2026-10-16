import { createHash } from 'node:crypto';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';
import {
  type AuditRow,
  assertHistoricalExecution,
  assertHistoricalInteraction,
  recoveryRecordDigest,
} from './recovery-audit-validation';

type Kind = 'execution' | 'interaction';
type Change = {
  kind: Kind;
  id: string;
  row: AuditRow | null;
  issue: string | null;
  frontier?: boolean;
};

/** Private transactional index, not a second ledger or a grant to replay effects. */
export class RecoveryAudit {
  readonly available: boolean;
  private readonly db: SqliteOperations;
  constructor(db: SqliteOperations) {
    this.db = db;
    this.available = !!db.row(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='recovery_audit'",
    );
  }
  private cookie(): bigint {
    return BigInt(this.db.row('PRAGMA schema_version')!.schema_version!);
  }
  private retire(runId: string, storeId: string, tip: AuditRow[string]): void {
    // A missing/invalid protocol has no certificate authority. Compact its
    // deltas without ever silently blessing the unobserved old history.
    this.db.run(
      'INSERT INTO recovery_audit(run_id,version,store_id,schema_cookie,covered_seq) VALUES(?,1,?,-1,?) ON CONFLICT(run_id) DO UPDATE SET schema_cookie=-1,covered_seq=excluded.covered_seq',
      runId,
      storeId,
      tip,
    );
    this.db.run('DELETE FROM recovery_audit_change WHERE run_id=? AND seq<=?', runId, tip);
  }
  private *changed(run: AuditRow, storeId: string): Iterable<Change> {
    const root = this.db.row('SELECT root_id FROM session WHERE id=?', run.session_id!);
    let afterKind = '',
      afterId = '';
    for (;;) {
      const batch = this.db.rows(
        "SELECT kind,record_id FROM recovery_audit_change WHERE run_id=? AND kind!='run' AND (kind,record_id)>(?,?) GROUP BY kind,record_id ORDER BY kind,record_id LIMIT 200",
        run.id!,
        afterKind,
        afterId,
      );
      if (!batch.length) return;
      for (const item of batch) {
        const kind = String(item.kind) as Kind;
        const id = String(item.record_id);
        if (kind === 'execution') {
          const live = this.db.row(
            'SELECT state FROM execution WHERE id=? AND run_id=? AND session_id=?',
            id,
            run.id!,
            run.session_id!,
          );
          // Active records are always reread and checked by the recovery scope.
          // Only settled history needs a durable qualification. The sequence
          // still binds every active mutation, including streamed model output.
          if (live && ['planned', 'dispatching', 'running'].includes(String(live.state))) {
            yield { kind, id, row: null, issue: null, frontier: true };
            continue;
          }
        }
        const row = this.db.row(
          `SELECT * FROM ${kind} WHERE id=? AND run_id=? AND session_id=?`,
          id,
          run.id!,
          run.session_id!,
        );
        let issue: string | null = null;
        try {
          if (!row) throw new AgentError('run_resume_checkpoint_unavailable');
          if (kind === 'execution')
            assertHistoricalExecution(this.db, row, storeId, String(root?.root_id));
          else assertHistoricalInteraction(this.db, row, run, storeId);
        } catch (error) {
          if (!(error instanceof AgentError) && !(error instanceof SyntaxError)) throw error;
          issue = error instanceof AgentError ? error.code : 'run_resume_checkpoint_unavailable';
        }
        yield { kind, id, row, issue };
      }
      afterKind = String(batch.at(-1)!.kind);
      afterId = String(batch.at(-1)!.record_id);
      // No iterator is held across pages. Legacy bootstrap and large external
      // deltas retain neither full row bodies nor unbounded native statements.
      this.db.releaseStatements();
      if (batch.length < 200) return;
    }
  }
  /** Called only inside the business writer transaction, immediately before its COMMIT. */
  flush(): void {
    if (!this.available) return;
    const runs = this.db.rows(
      'SELECT run_id,MAX(seq) AS tip FROM recovery_audit_change GROUP BY run_id',
    );
    if (!runs.length) return;
    if (this.db.row('SELECT writing FROM recovery_audit_writer WHERE singleton=1')?.writing !== 0n)
      throw new AgentError('recovery_audit_untrusted');
    const storeId = String(
      this.db.row('SELECT store_id FROM storage_meta WHERE singleton=1')!.store_id,
    );
    const cookie = this.cookie();
    this.db.run('UPDATE recovery_audit_writer SET writing=1 WHERE singleton=1');
    try {
      for (const item of runs) {
        const runId = String(item.run_id);
        const run = this.db.row('SELECT * FROM run WHERE id=?', runId);
        if (!run) {
          this.db.run('DELETE FROM recovery_audit_record WHERE run_id=?', runId);
          this.db.run('DELETE FROM recovery_audit_change WHERE run_id=?', runId);
          this.db.run('DELETE FROM recovery_audit WHERE run_id=?', runId);
          continue;
        }
        const prior = this.db.row('SELECT * FROM recovery_audit WHERE run_id=?', runId);
        // Schema changes invalidate the observation protocol. Never silently recertify
        // a history that might have changed while its triggers were absent.
        if (
          run.origin_store_id !== storeId ||
          (prior &&
            (prior.version !== 1n || prior.store_id !== storeId || prior.schema_cookie !== cookie))
        ) {
          this.retire(runId, String(run.origin_store_id), item.tip!);
          continue;
        }
        if (!prior) {
          // Only a new Run or explicit migration bootstrap can mint its first proof.
          // A lost proof never turns a later partial write into a complete certificate.
          if (
            !this.db.row(
              "SELECT seq FROM recovery_audit_change WHERE run_id=? AND kind='run' LIMIT 1",
              runId,
            )
          ) {
            this.retire(runId, storeId, item.tip!);
            continue;
          }
          this.db.run(
            "INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT run_id,'execution',id FROM execution WHERE run_id=?",
            runId,
          );
          this.db.run(
            "INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT run_id,'interaction',id FROM interaction WHERE run_id=?",
            runId,
          );
        }
        for (const change of this.changed(run, storeId)) {
          if (change.frontier) {
            this.db.run(
              'DELETE FROM recovery_audit_record WHERE run_id=? AND kind=? AND record_id=?',
              runId,
              change.kind,
              change.id,
            );
            continue;
          }
          const digest = createHash('sha256')
            .update(change.row ? recoveryRecordDigest(change.row) : 'missing')
            .digest('hex');
          this.db.run(
            'INSERT INTO recovery_audit_record(run_id,kind,record_id,row_digest,issue) VALUES(?,?,?,?,?) ON CONFLICT(run_id,kind,record_id) DO UPDATE SET row_digest=excluded.row_digest,issue=excluded.issue',
            runId,
            change.kind,
            change.id,
            digest,
            change.issue,
          );
        }
        const tip = this.db.row(
          'SELECT MAX(seq) AS tip FROM recovery_audit_change WHERE run_id=?',
          runId,
        )!.tip!;
        this.db.run(
          'INSERT INTO recovery_audit(run_id,version,store_id,schema_cookie,covered_seq) VALUES(?,1,?,?,?) ON CONFLICT(run_id) DO UPDATE SET covered_seq=excluded.covered_seq',
          runId,
          storeId,
          cookie,
          tip,
        );
        this.db.run('DELETE FROM recovery_audit_change WHERE run_id=? AND seq<=?', runId, tip);
      }
    } finally {
      this.db.run('UPDATE recovery_audit_writer SET writing=0 WHERE singleton=1');
    }
  }
  /** Same-snapshot read: only uncertified deltas and indexed prior failures are visited. */
  read(run: AuditRow, storeId: string): { version: 1; revision: string } | null {
    if (
      !this.available ||
      this.db.row('SELECT writing FROM recovery_audit_writer WHERE singleton=1')?.writing !== 0n
    )
      return null;
    const proof = this.db.row('SELECT * FROM recovery_audit WHERE run_id=?', run.id!);
    if (
      proof?.version !== 1n ||
      proof.store_id !== storeId ||
      proof.schema_cookie !== this.cookie()
    )
      return null;
    for (const change of this.changed(run, storeId))
      if (change.issue) throw new AgentError(change.issue);
    const oldIssue = this.db.row(
      `SELECT a.issue FROM recovery_audit_record a WHERE a.run_id=? AND a.issue IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM recovery_audit_change c WHERE c.run_id=a.run_id AND c.kind=a.kind AND c.record_id=a.record_id) LIMIT 1`,
      run.id!,
    );
    if (oldIssue) throw new AgentError(String(oldIssue.issue));
    const pending = this.db.row(
      'SELECT MAX(seq) AS tip FROM recovery_audit_change WHERE run_id=?',
      run.id!,
    );
    return { version: 1, revision: String(pending?.tip ?? proof.covered_seq) };
  }
}
