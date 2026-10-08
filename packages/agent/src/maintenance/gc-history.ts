import type { Database } from 'bun:sqlite';
import { canonicalJson } from '../json';
import {
  sessionHistoryCollections,
  workspaceHistoryCollectedAt,
  workspaceRemoval,
} from '../storage/sqlite/workspace-removal';
import { maximumInteger } from './files';
import { MaintenanceError } from './types';

interface WorkspaceHistory {
  id: string;
  metadata: string;
  sessions: number;
}
interface SessionGroupHistory extends WorkspaceHistory {
  workspaceId: string;
}
export interface HistoryCollectionPlan {
  workspaces: WorkspaceHistory[];
  sessionGroups: SessionGroupHistory[];
  retainedRecentWorkspaces: number;
  retainedUnsettledWorkspaces: number;
  retainedRecentSessionGroups: number;
  retainedUnsettledSessionGroups: number;
  retainedReferencedSessionGroups: number;
  previouslyCollected: boolean;
}
const members = 'SELECT id FROM session WHERE workspace_id=?';

function hasOutsideReferences(db: Database, members: string, outside: string, id: string) {
  // Closed relational references, including Fork origins. Never guess authorization from JSON.
  const executions = `SELECT id FROM execution WHERE session_id IN (${members})`;
  const messages = `SELECT id FROM message WHERE session_id IN (${members})`;
  const runs = `SELECT id FROM run WHERE session_id IN (${members})`;
  const get = (sql: string) =>
    db.query(sql).get(...Array.from({ length: sql.split('?').length - 1 }, () => id));
  const checks = [
    ['session', `parent_id IN (${members}) OR root_id IN (${members})`],
    ['message', `fork_source_message_id IN (${messages})`],
    ['context_snapshot', `execution_id IN (${executions})`],
    ['permission_grant', `execution_id IN (${executions})`],
    ['interaction', `presentation_session_id IN (${members})`],
    [
      'command',
      `mail_received_message_id IN (${messages}) OR agent_source_execution_id IN (${executions})
       OR agent_carrier_execution_id IN (${executions}) OR input_target_run_id IN (${runs})
       OR after_run_id IN (${runs}) OR mail_target_run_id IN (${runs})
       OR mail_received_run_id IN (${runs}) OR mail_target_session_id IN (${members})
       OR (kind='session.create' AND json_extract(request_json,'$.fork.sourceSessionId') IN (${members}))`,
    ],
    [
      'execution',
      `parent_execution_id IN (${executions}) OR predecessor_execution_id IN (${executions})
       OR child_session_id IN (${members}) OR delivery_target_session_id IN (${members})`,
    ],
    [
      'blob_ref',
      `(owner_kind='execution' AND owner_id IN (${executions}))
       OR (owner_kind='message' AND owner_id IN (${messages}))`,
    ],
  ] as const;
  for (const [table, predicate] of checks) {
    const sessionColumn = table === 'session' ? 'id' : 'session_id';
    const sql = `SELECT 1 FROM ${table} WHERE ${sessionColumn} NOT IN (${outside}) AND (${predicate}) LIMIT 1`;
    if (get(sql)) return true;
  }
  if (
    get(
      `SELECT 1 FROM execution_output o WHERE o.execution_id NOT IN
         (SELECT id FROM execution WHERE session_id IN (${outside}))
         AND o.blob_hash IN(SELECT blob_hash FROM blob_ref WHERE session_id IN (${members}))
         AND NOT EXISTS(SELECT 1 FROM blob_ref r WHERE r.blob_hash=o.blob_hash
         AND r.session_id NOT IN (${outside})) LIMIT 1`,
    )
  )
    return true;
  if (
    get(
      `SELECT 1 FROM permission_grant WHERE session_id NOT IN (${outside})
         AND (seq IN(SELECT seq FROM permission_grant_change WHERE session_id IN (${members}))
         OR revoked_seq IN(SELECT seq FROM permission_grant_change WHERE session_id IN (${members}))) LIMIT 1`,
    )
  )
    return true;
  return false;
}
const candidateMembers =
  'SELECT id FROM session WHERE root_id IN(SELECT id FROM temp.gc_history_roots)';
function candidates(db: Database, plan: HistoryCollectionPlan) {
  // Connection-local memory only; no new persistent schema or maintenance writer.
  db.exec('PRAGMA temp_store=MEMORY; CREATE TEMP TABLE gc_history_roots(id TEXT PRIMARY KEY)');
  for (const workspace of plan.workspaces)
    db.run(
      'INSERT INTO temp.gc_history_roots SELECT id FROM session WHERE workspace_id=? AND parent_id IS NULL',
      [workspace.id],
    );
  for (const group of plan.sessionGroups)
    db.run('INSERT INTO temp.gc_history_roots VALUES(?)', [group.id]);
}

export function planHistoryCollection(db: Database, cutoff: number): HistoryCollectionPlan {
  const plan: HistoryCollectionPlan = {
    workspaces: [],
    sessionGroups: [],
    retainedRecentWorkspaces: 0,
    retainedUnsettledWorkspaces: 0,
    retainedRecentSessionGroups: 0,
    retainedUnsettledSessionGroups: 0,
    retainedReferencedSessionGroups: 0,
    previouslyCollected: false,
  };
  for (const row of db
    .query<{ id: string; metadata: string }, []>(
      'SELECT id,metadata_json AS metadata FROM workspace ORDER BY id',
    )
    .iterate()) {
    const removal = workspaceRemoval(row.metadata);
    const collectedAt = workspaceHistoryCollectedAt(row.metadata);
    const roots = sessionHistoryCollections(row.metadata);
    for (const id of Object.keys(roots)) {
      if (
        !db
          .query(
            'SELECT 1 FROM session WHERE id=? AND root_id=id AND parent_id IS NULL AND workspace_id=? AND delete_requested=1',
          )
          .get(id, row.id) ||
        db
          .query(
            'SELECT 1 FROM session WHERE root_id=? AND (workspace_id<>? OR delete_requested<>1 OR deleted_at IS NULL) LIMIT 1',
          )
          .get(id, row.id)
      )
        throw new MaintenanceError('gc_history_invalid');
      plan.previouslyCollected = true;
    }
    if (!removal) {
      for (const root of db
        .query<{ id: string }, [string]>(
          'SELECT id FROM session WHERE workspace_id=? AND parent_id IS NULL AND delete_requested=1 ORDER BY id',
        )
        .all(row.id)) {
        if (Object.hasOwn(roots, root.id)) continue;
        const group = 'SELECT id FROM session WHERE root_id=?';
        if (
          db
            .query(
              'SELECT 1 FROM session WHERE root_id=? AND (workspace_id<>? OR delete_requested<>1 OR deleted_at IS NULL) LIMIT 1',
            )
            .get(root.id, row.id)
        )
          throw new MaintenanceError('gc_history_invalid');
        if (
          db
            .query('SELECT 1 FROM session WHERE root_id=? AND deleted_at>? LIMIT 1')
            .get(root.id, cutoff)
        ) {
          plan.retainedRecentSessionGroups++;
          continue;
        }
        if (
          db
            .query(`SELECT 1 FROM run WHERE session_id IN (${group}) AND is_active=1 LIMIT 1`)
            .get(root.id) ||
          db
            .query(
              `SELECT 1 FROM execution WHERE session_id IN (${group}) AND state IN ('planned','dispatching','running','outcome_unknown') LIMIT 1`,
            )
            .get(root.id) ||
          db
            .query(
              `SELECT 1 FROM command WHERE session_id IN (${group}) AND status IN ('accepted','needs_review') LIMIT 1`,
            )
            .get(root.id)
        ) {
          plan.retainedUnsettledSessionGroups++;
          continue;
        }
        const count = db
          .query<{ count: number }, [string]>(
            'SELECT COUNT(*) AS count FROM session WHERE root_id=?',
          )
          .get(root.id)!.count;
        plan.sessionGroups.push({
          id: root.id,
          workspaceId: row.id,
          metadata: row.metadata,
          sessions: count,
        });
      }
      continue;
    }
    if (removal.workspaceId !== row.id) throw new MaintenanceError('gc_history_invalid');
    const count = db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM session WHERE workspace_id=?`,
      )
      .get(row.id)!.count;
    if (
      count !== removal.deletedSessions ||
      db
        .query(
          `SELECT 1 FROM session WHERE workspace_id=? AND (delete_requested<>1 OR deleted_at IS NULL) LIMIT 1`,
        )
        .get(row.id)
    )
      throw new MaintenanceError('gc_history_invalid');
    if (collectedAt !== null) {
      plan.previouslyCollected = true;
      continue;
    }
    if (
      removal.removedAt > cutoff ||
      db
        .query('SELECT 1 FROM session WHERE workspace_id=? AND deleted_at>? LIMIT 1')
        .get(row.id, cutoff)
    ) {
      plan.retainedRecentWorkspaces++;
      continue;
    }
    if (
      db
        .query(`SELECT 1 FROM run WHERE session_id IN (${members}) AND is_active=1 LIMIT 1`)
        .get(row.id) ||
      db
        .query(
          `SELECT 1 FROM execution WHERE session_id IN (${members})
           AND state IN ('planned','dispatching','running','outcome_unknown') LIMIT 1`,
        )
        .get(row.id) ||
      db
        .query(
          `SELECT 1 FROM command WHERE session_id IN (${members}) AND status IN ('accepted','needs_review') LIMIT 1`,
        )
        .get(row.id)
    ) {
      plan.retainedUnsettledWorkspaces++;
      continue;
    }
    if (hasOutsideReferences(db, members, members, row.id))
      throw new MaintenanceError('gc_external_history_reference');
    plan.workspaces.push({ ...row, sessions: count });
  }
  if (plan.workspaces.length || plan.sessionGroups.length) {
    if (db.query("SELECT 1 FROM extension_record WHERE scope_kind<>'session' LIMIT 1").get())
      throw new MaintenanceError('gc_unsupported_record_scope');
    candidates(db, plan);
    try {
      // A surviving Fork keeps every ancestor, even if it selected no Messages. Deleted
      // chains can be collected together; removing a retained node propagates retention.
      for (;;) {
        const blocked = plan.sessionGroups.filter((group) =>
          hasOutsideReferences(
            db,
            'SELECT id FROM session WHERE root_id=?',
            candidateMembers,
            group.id,
          ),
        );
        if (!blocked.length) break;
        const ids = new Set(blocked.map((group) => group.id));
        for (const id of ids) db.run('DELETE FROM temp.gc_history_roots WHERE id=?', [id]);
        plan.retainedReferencedSessionGroups += ids.size;
        plan.sessionGroups = plan.sessionGroups.filter((group) => !ids.has(group.id));
      }
    } finally {
      db.exec('DROP TABLE temp.gc_history_roots');
    }
  }
  return plan;
}

/** One SQL transaction removes bodies; tombstones and original de-duplication facts survive. */
export function collectHistory(db: Database, plan: HistoryCollectionPlan, now: number) {
  if (plan.workspaces.length || plan.sessionGroups.length) {
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON',
    );
    try {
      const cursor = db
        .query<{ cursor: string }, []>(
          'SELECT CAST(last_change_cursor AS TEXT) AS cursor FROM storage_meta WHERE singleton=1',
        )
        .get()!.cursor;
      if (BigInt(cursor) >= maximumInteger) throw new MaintenanceError('sequence_exhausted');
      for (const history of [...plan.workspaces, ...plan.sessionGroups]) {
        const id = history.id;
        const group = 'workspaceId' in history;
        const members = `SELECT id FROM session WHERE ${group ? 'root_id' : 'workspace_id'}=?`;
        const executions = `SELECT id FROM execution WHERE session_id IN (${members})`;
        const messages = `SELECT id FROM message WHERE session_id IN (${members})`;
        for (const table of [
          'permission_grant',
          'permission_grant_change',
          'interaction',
          'context_snapshot',
        ])
          db.run(`DELETE FROM ${table} WHERE session_id IN (${members})`, [id]);
        db.run(`DELETE FROM execution_output WHERE execution_id IN (${executions})`, [id]);
        db.run(`DELETE FROM blob_ref WHERE session_id IN (${members})`, [id]);
        db.run(
          `DELETE FROM extension_record WHERE scope_kind='session' AND scope_id IN (${members})`,
          [id],
        );
        db.run(
          `UPDATE command SET request_json='null',run_resume_lease_json=NULL,job_recovery_lease_json=NULL,
                mail_received_message_id=NULL WHERE session_id IN (${members})`,
          [id],
        );
        db.run(`DELETE FROM message_part WHERE message_id IN (${messages})`, [id]);
        db.run(`DELETE FROM message WHERE session_id IN (${members})`, [id]);
        db.run(
          `UPDATE run SET config_json='null',requirements_json='[]',waiting_results_json='[]'
                WHERE session_id IN (${members})`,
          [id],
        );
        db.run(
          `UPDATE execution SET intent_json='null',decision_source_json='null',model_snapshot_json=NULL,
                dispatch_authorization_json=NULL,result_json=NULL,reference_json=NULL,
                recovery_manifest_json=NULL,child_configuration_json=NULL,after_turn_json=NULL,
                interaction_binding_json=NULL,requirements_json='[]' WHERE session_id IN (${members})`,
          [id],
        );
        db.run(`DELETE FROM change_event WHERE scope_session_id IN (${members})`, [id]);
        const workspaceId = group ? String(history.workspaceId) : id;
        const current = db
          .query<{ metadata: string }, [string]>(
            'SELECT metadata_json AS metadata FROM workspace WHERE id=?',
          )
          .get(workspaceId)!.metadata;
        const metadata = JSON.parse(current);
        if (group)
          metadata.sessionHistoryCollection = {
            version: 1,
            roots: { ...sessionHistoryCollections(current), [id]: now },
          };
        else metadata.historyCollection = { version: 1, collectedAt: now };
        db.run('UPDATE workspace SET metadata_json=? WHERE id=?', [
          canonicalJson(metadata),
          workspaceId,
        ]);
      }
      // Removing notification bodies expires old replay cursors, never the retained business facts.
      db.run(
        'UPDATE storage_meta SET replay_floor=last_change_cursor,last_change_cursor=last_change_cursor+1 WHERE singleton=1',
      );
      db.run(
        `INSERT INTO change_event SELECT last_change_cursor,NULL,'maintenance',0,?,?
              FROM storage_meta WHERE singleton=1`,
        [
          plan.workspaces.length ? 'workspace.history_collected' : 'session.history_collected',
          canonicalJson({
            purgedWorkspaces: plan.workspaces.length,
            purgedSessionGroups: plan.sessionGroups.length,
            purgedSessions: [...plan.workspaces, ...plan.sessionGroups].reduce(
              (n, w) => n + w.sessions,
              0,
            ),
          }),
        ],
      );
      if (db.query('SELECT * FROM pragma_foreign_key_check LIMIT 1').get())
        throw new MaintenanceError('backup_database_invalid');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (plan.workspaces.length || plan.sessionGroups.length || plan.previouslyCollected) {
    // Retrying after interruption also clears any old WAL/free pages. No new service is started.
    const checkpoint = () => {
      const row = db
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          'PRAGMA wal_checkpoint(TRUNCATE)',
        )
        .get();
      if (row && (row.busy !== 0 || row.log !== row.checkpointed))
        throw new MaintenanceError('gc_checkpoint_incomplete');
    };
    checkpoint();
    db.exec('VACUUM');
    checkpoint();
  }
}
