import {
  type AutomaticTitleAttempt,
  automaticTitleRecord,
} from '../../business/session-title/state';
import { readableSessionTitle } from '../../business/session-title/title';
import { canonicalJson } from '../../json';
import type { OwnedWrite, Store } from '../port';
import { AgentError, type ExtensionRecord, type Json } from '../types';
import { internalModelCompletedResult, internalModelSourceTarget } from './internal-model';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';
import { writeAutomaticTitleMetadata } from './session-title-operations';
import { readTitleJob, type TitleRow, titleHash, titleObject } from './session-title-proof';

type Claim = ReturnType<typeof readTitleJob>;
function ownedJob(db: SqliteOperations, claim: Claim, input: OwnedWrite, live = true) {
  db.owner(input.owner, String(claim.job.session_id));
  if (
    String(claim.job.owner_generation) !== input.owner.generation ||
    !claim.job.dispatched ||
    (live &&
      (!['running', 'dispatching'].includes(String(claim.job.state)) ||
        claim.job.cancel_requested ||
        claim.operation.cancelled ||
        claim.session.delete_requested))
  )
    throw new AgentError('session_title_job_inactive');
}
function revision(claim: Claim, expectedRevision: string) {
  if (claim.record.revision !== expectedRevision) throw new AgentError('record_revision_conflict');
}
function write(db: SqliteOperations, claim: Claim, value: AutomaticTitleAttempt): ExtensionRecord {
  if (BigInt(claim.record.revision) >= 9223372036854775807n)
    throw new AgentError('sequence_exhausted');
  db.run(
    "UPDATE extension_record SET revision=revision+1,json=? WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=? AND revision=?",
    canonicalJson(value as unknown as Json),
    automaticTitleRecord.extensionId,
    claim.record.sessionId,
    automaticTitleRecord.key,
    claim.record.revision,
  );
  db.event(
    claim.record.sessionId,
    `${automaticTitleRecord.extensionId}/${automaticTitleRecord.key}`,
    'extension.record_updated',
  );
  return {
    ...claim.record,
    revision: String(BigInt(claim.record.revision) + 1n),
    value: value as unknown as Json,
  };
}
function boundRun(db: SqliteOperations, claim: Claim, runId: string): TitleRow {
  const run = db.row('SELECT * FROM run WHERE id=?', runId);
  const configuration = run ? titleObject(JSON.parse(String(run.config_json))) : {};
  if (
    !run ||
    run.session_id !== claim.session.id ||
    run.origin_store_id !== claim.source.origin_store_id ||
    run.origin_command_id !== claim.business.id ||
    typeof configuration.modelId !== 'string' ||
    db.row('SELECT id FROM run WHERE session_id=? ORDER BY rowid ASC LIMIT 1', claim.session.id!)
      ?.id !== run.id
  )
    throw new AgentError('session_title_run_invalid');
  return run;
}
function closed(db: SqliteOperations, claim: Claim, reason: string): ExtensionRecord {
  return write(db, claim, {
    ...claim.attempt,
    jobExecutionId: String(claim.job.id),
    publication: 'closed',
    publicationCommandId: null,
    closedReason: reason,
  });
}
/** The host's terminal pre-dispatch receipt proves that no naming adapter was entered. */
export function closeUndispatchedAutomaticTitle(db: SqliteOperations, claim: Claim): void {
  if (
    claim.attempt.publication !== 'pending' ||
    claim.job.dispatched ||
    !['failed', 'cancelled'].includes(String(claim.job.state))
  )
    return;
  const result = titleObject(JSON.parse(String(claim.job.result_json)));
  if (titleObject(result.details).adapterAttempted !== false) return;
  closed(db, claim, 'title_not_dispatched');
}
/** Called only during cold owner acquisition or explicit resume adoption with the physical root lock.
 * Closing publication does not invent an execution outcome or replay a provider call. */
export function closeAbandonedAutomaticTitle(db: SqliteOperations, claim: Claim): void {
  if (claim.attempt.publication !== 'pending') return;
  if (claim.attempt.jobExecutionId !== null && claim.attempt.jobExecutionId !== claim.job.id)
    throw new AgentError('session_title_job_invalid');
  if (BigInt(claim.job.owner_generation!) > BigInt(claim.session.owner_generation!))
    throw new AgentError('owner_changed');
  closed(db, claim, 'title_supervisor_lost');
}
export function bindAutomaticSessionTitle(
  db: SqliteOperations,
  input: Parameters<Store['bindAutomaticSessionTitle']>[0],
) {
  return db.tx(() => {
    const claim = readTitleJob(db, input);
    ownedJob(db, claim, input);
    if (
      claim.attempt.jobExecutionId !== null &&
      claim.attempt.jobExecutionId !== input.jobExecutionId
    )
      throw new AgentError('session_title_job_invalid');
    if (claim.attempt.publication !== 'pending') return claim.record;
    if (input.sourceRunId) boundRun(db, claim, input.sourceRunId);
    if (
      claim.attempt.sourceRunId !== null &&
      input.sourceRunId !== undefined &&
      claim.attempt.sourceRunId !== input.sourceRunId
    )
      throw new AgentError('session_title_run_invalid');
    const next = {
      ...claim.attempt,
      jobExecutionId: input.jobExecutionId,
      sourceRunId: input.sourceRunId ?? claim.attempt.sourceRunId,
    };
    if (
      next.jobExecutionId === claim.attempt.jobExecutionId &&
      next.sourceRunId === claim.attempt.sourceRunId
    )
      return claim.record;
    revision(claim, input.expectedRevision);
    return write(db, claim, next);
  });
}
export function closeAutomaticSessionTitle(
  db: SqliteOperations,
  input: Parameters<Store['closeAutomaticSessionTitle']>[0],
) {
  return db.tx(() => {
    const claim = readTitleJob(db, input);
    if (
      claim.attempt.jobExecutionId !== null &&
      claim.attempt.jobExecutionId !== input.jobExecutionId
    )
      throw new AgentError('session_title_job_invalid');
    ownedJob(db, claim, input, false);
    if (claim.attempt.publication !== 'pending') return claim.record;
    if (!/^[a-z][a-z0-9_]{0,80}$/.test(input.reason))
      throw new AgentError('session_title_close_reason_invalid');
    revision(claim, input.expectedRevision);
    return closed(db, claim, input.reason);
  });
}
type PublicationInput = Parameters<Store['readAutomaticSessionTitlePublication']>[0];
function publicationClaim(db: SqliteOperations, input: PublicationInput) {
  const claim = readTitleJob(db, input);
  if (claim.attempt.jobExecutionId !== input.jobExecutionId || !claim.attempt.sourceRunId)
    throw new AgentError('session_title_job_invalid');
  boundRun(db, claim, claim.attempt.sourceRunId);
  const model = db.row('SELECT * FROM execution WHERE id=?', input.modelExecutionId);
  if (
    !model ||
    internalModelSourceTarget(db, model)?.id !== claim.job.id ||
    !internalModelCompletedResult(db, model)
  )
    throw new AgentError('session_title_model_invalid');
  const result = titleObject(JSON.parse(String(model.result_json)));
  if (
    typeof result.content !== 'string' ||
    Buffer.byteLength(result.content) > 32768 ||
    (result.modelOutput &&
      verifyModelOutput(db, result.modelOutput, model).contentBytes !==
        String(Buffer.byteLength(result.content)))
  )
    throw new AgentError('session_title_model_invalid');
  if (!input.title || readableSessionTitle(result.content) !== input.title)
    throw new AgentError('session_title_candidate_invalid');
  return claim;
}
function publicationReceipt(db: SqliteOperations, claim: Claim, input: PublicationInput) {
  if (claim.attempt.publication === 'published') {
    const run = boundRun(db, claim, claim.attempt.sourceRunId!);
    if (run.is_active || run.status !== 'completed')
      throw new AgentError('session_title_publication_invalid');
    const saved = db.row('SELECT * FROM command WHERE id=?', claim.identity.publicationCommandId);
    const request = saved ? titleObject(JSON.parse(String(saved.request_json))) : {};
    const receipt = saved ? titleObject(JSON.parse(String(saved.receipt_json))) : {};
    const snapshot = titleObject(receipt.session);
    if (
      !saved ||
      claim.attempt.publicationCommandId !== saved.id ||
      claim.attempt.modelExecutionId !== input.modelExecutionId ||
      saved.kind !== 'session.rename' ||
      saved.extension_id !== automaticTitleRecord.extensionId ||
      saved.scope_kind !== 'session' ||
      saved.scope_id !== input.sessionId ||
      saved.operation_key !== `published/${claim.identity.operationKey.slice(9)}` ||
      saved.subject_id !== claim.source.subject_id ||
      saved.origin_store_id !== input.expectedStoreId ||
      saved.status !== 'applied' ||
      saved.session_id !== input.sessionId ||
      saved.root_work_command_id !== saved.id ||
      saved.root_work_seq !== saved.seq ||
      request.kind !== 'session.rename' ||
      request.title !== input.title ||
      saved.request_digest !== titleHash(request) ||
      receipt.outcome !== 'renamed' ||
      snapshot.id !== input.sessionId ||
      snapshot.title !== input.title ||
      snapshot.controlRevision !== request.ifRevision
    )
      throw new AgentError('session_title_publication_invalid');
    return {
      record: claim.record,
      command: db.command(saved),
      session: db.session(claim.session),
    };
  }
  return null;
}
/** One consistent, read-only proof of the exact original metadata effect. */
export function readAutomaticSessionTitlePublication(
  db: SqliteOperations,
  input: PublicationInput,
) {
  db.db.run('BEGIN');
  try {
    const claim = publicationClaim(db, input);
    const result = publicationReceipt(db, claim, input) ?? {
      record: claim.record,
      command: null,
      session: db.session(claim.session),
    };
    if (
      !result.command &&
      db.row('SELECT id FROM command WHERE id=?', claim.identity.publicationCommandId)
    )
      throw new AgentError('session_title_publication_invalid');
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
export function publishAutomaticSessionTitle(
  db: SqliteOperations,
  input: Parameters<Store['publishAutomaticSessionTitle']>[0],
) {
  return db.tx(() => {
    const claim = publicationClaim(db, input);
    const saved = publicationReceipt(db, claim, input);
    if (saved) return saved;
    if (claim.attempt.publication === 'closed')
      return { record: claim.record, command: null, session: db.session(claim.session) };
    // Even a shared Store/owner failure must remain a real failure, never a title-only exemption.
    ownedJob(db, claim, input, false);
    revision(claim, input.expectedRevision);
    const run = boundRun(db, claim, claim.attempt.sourceRunId!);
    if (run.is_active) throw new AgentError('session_title_run_not_complete');
    const override = db.row(
      "SELECT id FROM command WHERE session_id=? AND kind='session.rename' AND id<>? LIMIT 1",
      input.sessionId,
      claim.identity.fallbackCommandId,
    );
    const reason =
      run.status !== 'completed'
        ? 'source_run_not_successful'
        : claim.session.delete_requested
          ? 'session_deleted'
          : override
            ? 'manual_title_changed'
            : claim.job.cancel_requested ||
                claim.operation.cancelled ||
                run.cancel_requested ||
                claim.business.cancelled
              ? 'cancelled'
              : null;
    if (reason)
      return {
        record: closed(db, claim, reason),
        command: null,
        session: db.session(claim.session),
      };
    ownedJob(db, claim, input);
    if (db.row('SELECT id FROM command WHERE id=?', claim.identity.publicationCommandId))
      throw new AgentError('command_conflict');
    const session = writeAutomaticTitleMetadata(db, {
      ...input,
      subjectId: String(claim.source.subject_id),
      commandId: claim.identity.publicationCommandId,
      operationKey: `published/${claim.identity.operationKey.slice(9)}`,
    });
    const record = write(db, claim, {
      ...claim.attempt,
      publication: 'published',
      closedReason: null,
      modelExecutionId: input.modelExecutionId,
      publicationCommandId: claim.identity.publicationCommandId,
    });
    db.event(input.sessionId, input.sessionId, 'session.renamed', {
      controlRevision: session.controlRevision,
    });
    return {
      record,
      command: db.command(
        db.row('SELECT * FROM command WHERE id=?', claim.identity.publicationCommandId)!,
      ),
      session,
    };
  });
}
