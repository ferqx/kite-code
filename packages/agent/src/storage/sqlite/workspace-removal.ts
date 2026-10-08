import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type WorkspaceRemoval } from '../types';
import type { SqliteOperations } from './operations';

type Input = Parameters<Store['removeWorkspace']>[0];
/** Root groups collected independently of a later Workspace removal. */
export function sessionHistoryCollections(metadata: unknown): Readonly<Record<string, number>> {
  const value = JSON.parse(String(metadata)) as { sessionHistoryCollection?: unknown };
  if (!Object.hasOwn(value, 'sessionHistoryCollection')) return {};
  const marker = value.sessionHistoryCollection as {
    version?: unknown;
    roots?: Record<string, unknown>;
  };
  if (
    !marker ||
    Object.keys(marker).sort().join(',') !== 'roots,version' ||
    marker.version !== 1 ||
    !marker.roots ||
    typeof marker.roots !== 'object' ||
    Array.isArray(marker.roots) ||
    !Object.keys(marker.roots).length ||
    Object.entries(marker.roots).some(
      ([id, at]) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        typeof at !== 'number' ||
        !Number.isSafeInteger(at) ||
        at < 0,
    )
  )
    throw new AgentError('session_history_invalid');
  return marker.roots as Record<string, number>;
}
export function sessionHistoryCollectedAt(metadata: unknown, rootId: string): number | null {
  const roots = sessionHistoryCollections(metadata);
  return Object.hasOwn(roots, rootId) ? roots[rootId]! : workspaceHistoryCollectedAt(metadata);
}
/** Collection never changes the original removal receipt or its cancellation evidence. */
export function workspaceHistoryCollectedAt(metadata: unknown): number | null {
  const value = JSON.parse(String(metadata)) as { historyCollection?: unknown };
  if (!Object.hasOwn(value, 'historyCollection')) return null;
  const marker = value.historyCollection as { version?: unknown; collectedAt?: unknown };
  if (
    !marker ||
    Object.keys(marker).sort().join(',') !== 'collectedAt,version' ||
    marker.version !== 1 ||
    typeof marker.collectedAt !== 'number' ||
    !Number.isSafeInteger(marker.collectedAt) ||
    marker.collectedAt < 0 ||
    !workspaceRemoval(metadata)
  )
    throw new AgentError('workspace_history_invalid');
  return marker.collectedAt;
}
/** Reserved metadata is an immutable Store receipt, independent of any deleted Session. */
export function workspaceRemoval(metadata: unknown): WorkspaceRemoval | null {
  const value = JSON.parse(String(metadata)) as { removal?: unknown };
  if (!Object.hasOwn(value, 'removal')) return null;
  const marker = value.removal as { version?: unknown; receipt?: WorkspaceRemoval };
  const r = marker?.receipt;
  if (
    !marker ||
    Object.keys(marker).sort().join(',') !== 'receipt,version' ||
    marker.version !== 1 ||
    !r ||
    Object.keys(r).sort().join(',') !==
      'commandId,deletedRoots,deletedSessions,originStoreId,outcome,removedAt,requestDigest,stopConfirmed,subjectId,workspaceId' ||
    ![r.commandId, r.originStoreId, r.workspaceId].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    ) ||
    typeof r.subjectId !== 'string' ||
    !r.subjectId ||
    r.subjectId.length > 256 ||
    !/^[a-f0-9]{64}$/.test(r.requestDigest) ||
    !Number.isSafeInteger(r.removedAt) ||
    r.removedAt < 0 ||
    !Number.isSafeInteger(r.deletedRoots) ||
    r.deletedRoots < 0 ||
    !Number.isSafeInteger(r.deletedSessions) ||
    r.deletedSessions < r.deletedRoots ||
    r.outcome !== 'workspace_removed' ||
    r.stopConfirmed !== false
  )
    throw new AgentError('workspace_receipt_invalid');
  return r;
}
function digest(input: Input) {
  return createHash('sha256')
    .update(canonicalJson({ kind: 'workspace.remove', workspaceId: input.workspaceId }))
    .digest('hex');
}
export function readWorkspaceRemoval(db: SqliteOperations, input: Input) {
  db.identity(input.expectedStoreId);
  const row = db.row('SELECT metadata_json FROM workspace WHERE id=?', input.workspaceId);
  const prior = row ? workspaceRemoval(row.metadata_json) : null;
  if (!prior) return null;
  if (prior.subjectId !== input.subjectId) throw new AgentError('permission_denied');
  if (prior.originStoreId !== input.expectedStoreId)
    throw new AgentError('store_identity_mismatch');
  if (prior.commandId !== input.commandId) return null;
  if (prior.workspaceId !== input.workspaceId || prior.requestDigest !== digest(input))
    throw new AgentError('command_conflict');
  return prior;
}
export function removeWorkspace(db: SqliteOperations, input: Input): WorkspaceRemoval {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (
      ![input.commandId, input.workspaceId].every(
        (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
      ) ||
      typeof input.subjectId !== 'string' ||
      !input.subjectId ||
      input.subjectId.length > 256
    )
      throw new AgentError('invalid_command');
    const row = db.row('SELECT * FROM workspace WHERE id=?', input.workspaceId);
    if (!row) throw new AgentError('workspace_not_found');
    const prior = readWorkspaceRemoval(db, input);
    if (prior) return prior;
    if (workspaceRemoval(row.metadata_json)) throw new AgentError('workspace_removed');
    if (
      db.row(
        'SELECT id FROM command WHERE id=? UNION ALL SELECT id FROM host_mutation WHERE id=?',
        input.commandId,
        input.commandId,
      ) ||
      db.row(
        "SELECT id FROM workspace WHERE json_extract(metadata_json,'$.removal.receipt.commandId')=?",
        input.commandId,
      )
    )
      throw new AgentError('command_conflict');
    // One foreign root prevents the entire batch; no partial deletion precedes authority checking.
    if (
      db.row(
        `SELECT s.id FROM session s WHERE s.workspace_id=? AND s.parent_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.kind='session.create' AND c.subject_id=?) LIMIT 1`,
        input.workspaceId,
        input.subjectId,
      )
    )
      throw new AgentError('permission_denied');
    const counts = db.row(
      'SELECT COUNT(*) AS sessions,COALESCE(SUM(parent_id IS NULL),0) AS roots FROM session WHERE workspace_id=?',
      input.workspaceId,
    )!;
    const now = Date.now();
    const receipt: WorkspaceRemoval = {
      commandId: input.commandId,
      originStoreId: input.expectedStoreId,
      subjectId: input.subjectId,
      workspaceId: input.workspaceId,
      requestDigest: digest(input),
      removedAt: now,
      deletedRoots: Number(counts.roots),
      deletedSessions: Number(counts.sessions),
      outcome: 'workspace_removed',
      stopConfirmed: false,
    };
    const metadata = JSON.parse(String(row.metadata_json));
    metadata.removal = { version: 1, receipt };
    db.run(
      'UPDATE workspace SET metadata_json=? WHERE id=?',
      canonicalJson(metadata),
      input.workspaceId,
    );
    db.run(
      `UPDATE session SET delete_requested=1,deleted_at=COALESCE(deleted_at,?),
      stop_boundary=MAX(stop_boundary,(SELECT r.next_seq FROM session r WHERE r.id=session.root_id)),
      control_revision=CASE WHEN parent_id IS NULL AND control_revision<9223372036854775807 THEN control_revision+1 ELSE control_revision END
      WHERE workspace_id=?`,
      now,
      input.workspaceId,
    );
    db.run(
      `UPDATE command SET cancelled=1,cancel_requested_at=COALESCE(cancel_requested_at,?),
      status=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN 'rejected' WHEN json_extract(receipt_json,'$.preparingNextAttempt')=1 THEN 'needs_review' ELSE status END,
      receipt_json=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN ? WHEN json_extract(receipt_json,'$.preparingNextAttempt')=1 THEN json_set(receipt_json,'$.preparingNextAttempt',json('false')) ELSE receipt_json END
      WHERE session_id IN(SELECT id FROM session WHERE workspace_id=?) AND (status='accepted' OR kind IN('run.start','input.follow_up','child.start','extension.invoke','operation.tool','operation.job','operation.agent','job.report','input.steer','result.include','agent.message'))`,
      now,
      canonicalJson({ outcome: 'cancelled_before_apply', reason: 'session_deleted' }),
      input.workspaceId,
    );
    db.run(
      `UPDATE execution SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?),
      delivery=CASE WHEN delivery='pending' THEN 'suppressed' ELSE delivery END,delivery_reason=CASE WHEN delivery='pending' THEN 'session_deleted' ELSE delivery_reason END
      WHERE session_id IN(SELECT id FROM session WHERE workspace_id=?)`,
      now,
      input.workspaceId,
    );
    db.run(
      'UPDATE run SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE is_active=1 AND session_id IN(SELECT id FROM session WHERE workspace_id=?)',
      now,
      input.workspaceId,
    );
    db.run(
      "UPDATE interaction SET state='cancelled' WHERE state IN('pending','answered') AND accepted_decision_revision IS NULL AND session_id IN(SELECT id FROM session WHERE workspace_id=?)",
      input.workspaceId,
    );
    db.event(null, input.workspaceId, 'workspace.removed', receipt as unknown as Json);
    return receipt;
  });
}
