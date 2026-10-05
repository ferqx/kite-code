import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type SessionRecord } from '../types';
import type { SqliteOperations } from './operations';

export function manageSession(
  db: SqliteOperations,
  kind: 'renameSession' | 'deleteSession',
  input: Parameters<Store['renameSession']>[0] | Parameters<Store['deleteSession']>[0],
) {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (
      !/^(0|[1-9][0-9]*)$/.test(input.ifRevision) ||
      input.ifRevision.length > 19 ||
      BigInt(input.ifRevision) > 9223372036854775807n
    )
      throw new AgentError('invalid_session_revision');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId)) throw new AgentError('invalid_command');
    const title = 'title' in input ? input.title : undefined;
    if (
      kind === 'renameSession' &&
      (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 4096)
    )
      throw new AgentError('invalid_session_title');
    const request: Json = {
      kind: kind === 'renameSession' ? 'session.rename' : 'session.delete',
      ifRevision: input.ifRevision,
      ...(kind === 'renameSession' ? { title: title! } : {}),
    };
    const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.origin_store_id !== input.expectedStoreId ||
        prior.subject_id !== input.subjectId ||
        prior.session_id !== input.sessionId ||
        prior.request_digest !== digest
      )
        throw new AgentError('command_conflict');
      const receipt = JSON.parse(String(prior.receipt_json)) as { session: SessionRecord };
      if (!receipt.session) throw new AgentError('session_receipt_invalid');
      return { command: db.command(prior), session: receipt.session };
    }
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    if (session.parent_id !== null) throw new AgentError('group_root_required');
    const creator = db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      session.id!,
    );
    if (!creator || creator.subject_id !== input.subjectId)
      throw new AgentError('permission_denied');
    if (session.delete_requested) throw new AgentError('session_deleted');
    if (String(session.control_revision) !== input.ifRevision)
      throw new AgentError('session_revision_changed');
    if (BigInt(session.control_revision!) >= 9223372036854775807n)
      throw new AgentError('sequence_exhausted');
    const now = Date.now();
    if (kind === 'renameSession')
      db.run(
        'UPDATE session SET title=?,control_revision=control_revision+1 WHERE id=?',
        title!,
        input.sessionId,
      );
    else {
      // The durable group tombstone is the final creation/dispatch gate; bulk flags
      // only notify already registered work. No terminal effect is fabricated.
      db.run(
        'UPDATE session SET delete_requested=1,deleted_at=?,stop_boundary=MAX(stop_boundary,?) WHERE root_id=?',
        now,
        session.next_seq!,
        input.sessionId,
      );
      db.run('UPDATE session SET control_revision=control_revision+1 WHERE id=?', input.sessionId);
      db.run(
        "UPDATE command SET cancelled=1,cancel_requested_at=COALESCE(cancel_requested_at,?),status=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN 'rejected' WHEN json_extract(receipt_json,'$.preparingNextAttempt')=1 THEN 'needs_review' ELSE status END,receipt_json=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN ? WHEN json_extract(receipt_json,'$.preparingNextAttempt')=1 THEN json_set(receipt_json,'$.preparingNextAttempt',json('false')) ELSE receipt_json END WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND (status='accepted' OR kind IN ('run.start','input.follow_up','child.start','extension.invoke','operation.tool','operation.job','operation.agent','job.report','input.steer','result.include','agent.message'))",
        now,
        canonicalJson({ outcome: 'cancelled_before_apply', reason: 'session_deleted' }),
        input.sessionId,
      );
      db.run(
        "UPDATE execution SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?),delivery=CASE WHEN delivery='pending' THEN 'suppressed' ELSE delivery END,delivery_reason=CASE WHEN delivery='pending' THEN 'session_deleted' ELSE delivery_reason END WHERE root_session_id=?",
        now,
        input.sessionId,
      );
      db.run(
        'UPDATE run SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1',
        now,
        input.sessionId,
      );
      db.run(
        "UPDATE interaction SET state='cancelled' WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND state IN('pending','answered') AND accepted_decision_revision IS NULL",
        input.sessionId,
      );
    }
    // Admission allocates the management command sequence after the stop boundary.
    db.allocateSessionSequence(input.sessionId);
    const current = db.session(db.row('SELECT * FROM session WHERE id=?', input.sessionId)!);
    const receipt: Json = {
      outcome: kind === 'renameSession' ? 'renamed' : 'delete_requested',
      session: current as unknown as Json,
      ...(kind === 'deleteSession' ? { stopConfirmed: false } : {}),
    };
    db.run(
      "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,?,?,?,?,?,?,'applied',?,?,?,?)",
      input.commandId,
      input.sessionId,
      current.nextSeq,
      (request as { kind: string }).kind,
      input.subjectId,
      digest,
      canonicalJson(request),
      canonicalJson(receipt),
      input.expectedStoreId,
      input.commandId,
      current.nextSeq,
    );
    db.event(
      input.sessionId,
      input.sessionId,
      kind === 'renameSession' ? 'session.renamed' : 'session.delete_requested',
      { controlRevision: current.controlRevision },
    );
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!),
      session: current,
    };
  });
}
