import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import {
  AgentError,
  type JobReconciliationInput,
  type JobRecoveryLease,
  type Json,
} from '../types';
import { verifyHostControlDispatch } from './host-control-dispatch';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined): Json =>
  value == null ? null : (JSON.parse(String(value)) as Json);
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function admitted(db: SqliteOperations, input: JobReconciliationInput) {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (session.parent_id !== null || session.root_id !== session.id)
    throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
  if (
    execution?.kind !== 'job' ||
    execution.root_session_id !== input.sessionId ||
    execution.origin_store_id !== input.expectedStoreId
  )
    throw new AgentError('job_reconciliation_unavailable');
  if (String(execution.result_revision) !== input.expectedResultRevision)
    throw new AgentError('result_revision_conflict');
  if (!execution.recovery_manifest_json || execution.reference_json === null)
    throw new AgentError('job_reconciliation_unavailable');
  const origin = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
  if (
    !origin ||
    origin.subject_id !== input.subjectId ||
    origin.origin_store_id !== execution.origin_store_id
  )
    throw new AgentError('permission_denied');
  const request: Json = {
    kind: 'job.reconcile',
    executionId: input.executionId,
    expectedResultRevision: input.expectedResultRevision,
    original: {
      originStoreId: String(execution.origin_store_id),
      sessionId: String(execution.session_id),
      rootSessionId: String(execution.root_session_id),
      originCommandId: String(execution.origin_command_id),
      rootWorkCommandId: String(execution.root_work_command_id),
      rootWorkSeq: String(execution.root_work_seq),
      definitionId: String(execution.adapter_id),
      definitionVersion: String(execution.definition_version),
      inputDigest: hash(parse(execution.intent_json)),
      referenceDigest: hash(parse(execution.reference_json)),
      recoveryManifestDigest: hash(parse(execution.recovery_manifest_json)),
    },
  };
  const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (
    prior &&
    (prior.kind !== 'job.reconcile' ||
      prior.session_id !== input.sessionId ||
      prior.subject_id !== input.subjectId ||
      prior.origin_store_id !== input.expectedStoreId ||
      prior.request_digest !== hash(request))
  )
    throw new AgentError('command_conflict');
  if (execution.state !== 'outcome_unknown') throw new AgentError('job_reconciliation_unavailable');
  return { session, execution, request, prior };
}
function activeLease(db: SqliteOperations, expectedStoreId: string, lease: JobRecoveryLease) {
  db.identity(expectedStoreId);
  const command = db.row('SELECT * FROM command WHERE id=?', lease.commandId),
    session = db.row('SELECT * FROM session WHERE id=?', lease.sessionId);
  const storedLease = parse(command?.job_recovery_lease_json) as Record<string, Json> | null;
  const { phase: _phase, ...leaseIdentity } = storedLease ?? {};
  if (
    lease.kind !== 'job_reconciliation' ||
    !command ||
    command.kind !== 'job.reconcile' ||
    command.origin_store_id !== expectedStoreId ||
    command.session_id !== lease.sessionId ||
    canonicalJson(leaseIdentity) !== canonicalJson(lease as unknown as Json) ||
    !session ||
    String(session.owner_generation) !== lease.generation ||
    session.owner_instance !== lease.instanceId
  )
    throw new AgentError('recovery_lease_changed');
  if (command.cancelled || command.cancel_requested_at !== null)
    throw new AgentError('reconciliation_cancelled');
  const input: JobReconciliationInput = {
    expectedStoreId,
    commandId: lease.commandId,
    subjectId: String(command.subject_id),
    sessionId: lease.sessionId,
    executionId: lease.executionId,
    expectedResultRevision: lease.resultRevision,
  };
  const scope = admitted(db, input);
  if (scope.execution.state !== 'outcome_unknown')
    throw new AgentError('job_reconciliation_unavailable');
  return { ...scope, command };
}
export function verifiedJobProofPredicate(alias: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new AgentError('invalid_query_alias');
  return `NOT (${alias}.kind='job' AND ${alias}.state='outcome_unknown' AND EXISTS(SELECT 1 FROM command proof WHERE proof.kind='job.reconcile' AND proof.status='applied' AND proof.origin_store_id=${alias}.origin_store_id AND proof.session_id=${alias}.root_session_id AND json_extract(proof.request_json,'$.executionId')=${alias}.id AND json_extract(proof.request_json,'$.expectedResultRevision')=CAST(${alias}.result_revision AS TEXT) AND json_extract(proof.request_json,'$.original.rootSessionId')=${alias}.root_session_id AND json_extract(proof.request_json,'$.original.sessionId')=${alias}.session_id AND json_extract(proof.receipt_json,'$.executionId')=${alias}.id AND json_extract(proof.receipt_json,'$.resultRevision')=CAST(${alias}.result_revision AS TEXT) AND json_extract(proof.receipt_json,'$.outcome')='verified' AND json_extract(proof.receipt_json,'$.supervision')='ended' AND json_extract(proof.receipt_json,'$.result.outcome') IN('succeeded','failed','cancelled') AND json_extract(proof.receipt_json,'$.evidenceSource')='adapter_reconcile'))`;
}
export function callJobReconciliation(
  db: SqliteOperations,
  method: string,
  value: unknown,
): unknown {
  if (method === 'getJobReconciliationReceipt') {
    db.db.run('BEGIN');
    try {
      const scope = admitted(db, value as JobReconciliationInput);
      const result = scope.prior ? db.command(scope.prior) : null;
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  return db.tx(() => {
    if (method === 'sealJobRecoveryManifest') {
      const input = value as Parameters<Store['sealJobRecoveryManifest']>[0];
      db.identity(input.expectedStoreId);
      db.owner(input.owner);
      const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
      if (
        execution?.kind !== 'job' ||
        execution.origin_store_id !== input.expectedStoreId ||
        String(execution.owner_generation) !== input.owner.generation
      )
        throw new AgentError('operation_unverifiable');
      db.owner(input.owner, String(execution.session_id));
      if (input.manifest === null) throw new AgentError('invalid_recovery_manifest');
      if (execution.recovery_manifest_json !== null) {
        if (
          canonicalJson(parse(execution.recovery_manifest_json)) !== canonicalJson(input.manifest)
        )
          throw new AgentError('recovery_manifest_changed');
        return db.execution(execution);
      }
      if (execution.state !== 'planned' || execution.dispatched !== 0n)
        throw new AgentError('execution_already_dispatched');
      db.run(
        'UPDATE execution SET recovery_manifest_json=? WHERE id=?',
        canonicalJson(input.manifest),
        execution.id!,
      );
      db.event(
        String(execution.session_id),
        String(execution.id),
        'execution.recovery_manifest_sealed',
      );
      return db.execution(db.row('SELECT * FROM execution WHERE id=?', execution.id!)!);
    }
    if (method === 'beginJobReconciliation') {
      const input = value as Parameters<Store['beginJobReconciliation']>[0],
        scope = admitted(db, input);
      if (scope.prior)
        return {
          command: db.command(scope.prior),
          lease: null,
          execution: db.execution(scope.execution),
        };
      if (scope.execution.state !== 'outcome_unknown')
        throw new AgentError('job_reconciliation_unavailable');
      if (
        db.row(
          'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1 LIMIT 1',
          input.sessionId,
        ) ||
        db.row(
          "SELECT id FROM execution WHERE root_session_id=? AND state IN('planned','dispatching','running') LIMIT 1",
          input.sessionId,
        )
      )
        throw new AgentError('recovery_required');
      const verified = db.row(
        `SELECT * FROM command WHERE kind='job.reconcile' AND status='applied' AND origin_store_id=? AND session_id=? AND json_extract(request_json,'$.executionId')=? AND json_extract(request_json,'$.expectedResultRevision')=? AND request_digest=? AND json_extract(receipt_json,'$.outcome')='verified' AND json_extract(receipt_json,'$.supervision')='ended' ORDER BY seq DESC LIMIT 1`,
        input.expectedStoreId,
        input.sessionId,
        input.executionId,
        input.expectedResultRevision,
        hash(scope.request),
      );
      if (verified) {
        db.insertCommand(
          input as Parameters<SqliteOperations['insertCommand']>[0],
          scope.request,
          hash(scope.request),
          'applied',
          parse(verified.receipt_json),
        );
        db.event(input.sessionId, input.commandId, 'job.reconciliation_reused');
        return {
          command: db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!),
          lease: null,
          execution: db.execution(scope.execution),
        };
      }
      if (BigInt(scope.session.owner_generation!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
      const lease: JobRecoveryLease = {
        kind: 'job_reconciliation',
        id: randomUUID(),
        sessionId: input.sessionId,
        instanceId: input.instanceId,
        generation: String(BigInt(scope.session.owner_generation!) + 1n),
        commandId: input.commandId,
        executionId: input.executionId,
        resultRevision: input.expectedResultRevision,
      };
      db.run(
        'UPDATE session SET owner_generation=?,owner_instance=? WHERE id=?',
        BigInt(lease.generation),
        lease.instanceId,
        lease.sessionId,
      );
      db.insertCommand(
        input as Parameters<SqliteOperations['insertCommand']>[0],
        scope.request,
        hash(scope.request),
        'accepted',
        null,
      );
      db.run(
        'UPDATE command SET job_recovery_lease_json=? WHERE id=?',
        canonicalJson({ ...lease, phase: 'prepared' } as unknown as Json),
        input.commandId,
      );
      db.event(input.sessionId, input.commandId, 'job.reconciliation_prepared');
      return {
        command: db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!),
        lease,
        execution: db.execution(scope.execution),
      };
    }
    if (method === 'releaseJobRecoveryLease') {
      const lease = value as JobRecoveryLease,
        session = db.row('SELECT * FROM session WHERE id=?', lease.sessionId);
      if (
        session &&
        String(session.owner_generation) === lease.generation &&
        session.owner_instance === lease.instanceId
      )
        db.run('UPDATE session SET owner_instance=NULL WHERE id=?', lease.sessionId);
      return;
    }
    const input = value as Parameters<Store['markJobReconciliationDispatch']>[0] &
      Parameters<Store['finishJobReconciliation']>[0];
    const scope = activeLease(db, input.expectedStoreId, input.lease);
    if (scope.command.status !== 'accepted')
      throw new AgentError('reconciliation_already_finished');
    const original = (parse(scope.command.request_json) as Record<string, Json>).original as Record<
      string,
      Json
    >;
    if (original.recoveryManifestDigest !== hash(parse(scope.execution.recovery_manifest_json)))
      throw new AgentError('recovery_manifest_changed');
    if (!input.authorization?.revision)
      throw new AgentError('reconciliation_authorization_required');
    verifyHostControlDispatch(db, scope.execution, {
      expectedStoreId: input.expectedStoreId,
      authorization: { allowed: true, ...input.authorization },
    } as Parameters<Store['markDispatching']>[0]);
    if (method === 'markJobReconciliationDispatch') {
      if (
        canonicalJson(input.expectedRecoveryManifest) !==
        canonicalJson(parse(scope.execution.recovery_manifest_json))
      )
        throw new AgentError('recovery_manifest_changed');
      const stored = parse(scope.command.job_recovery_lease_json) as Record<string, Json>;
      if (stored.phase !== 'prepared') throw new AgentError('reconciliation_already_dispatched');
      db.run(
        'UPDATE command SET job_recovery_lease_json=? WHERE id=?',
        canonicalJson({ ...stored, phase: 'query_dispatched' }),
        input.lease.commandId,
      );
      db.event(input.lease.sessionId, input.lease.commandId, 'job.reconciliation_dispatched');
      return db.command(db.row('SELECT * FROM command WHERE id=?', input.lease.commandId)!);
    }
    if (method === 'finishJobReconciliation') {
      const receipt = input.receipt;
      if (
        !receipt ||
        Object.keys(receipt).some(
          (key) =>
            ![
              'executionId',
              'resultRevision',
              'outcome',
              'supervision',
              'result',
              'evidence',
              'reason',
              'evidenceSource',
            ].includes(key),
        ) ||
        receipt.executionId !== input.lease.executionId ||
        receipt.resultRevision !== input.lease.resultRevision ||
        receipt.evidenceSource !== 'adapter_reconcile' ||
        !['ended', 'running', 'unknown'].includes(receipt.supervision) ||
        !Object.hasOwn(receipt, 'result') ||
        !Object.hasOwn(receipt, 'evidence') ||
        (receipt.reason !== null &&
          (typeof receipt.reason !== 'string' || !receipt.reason || receipt.reason.length > 4096))
      )
        throw new AgentError('invalid_reconciliation_receipt');
      const priorLease = parse(scope.command.job_recovery_lease_json) as Record<string, Json>;
      if (priorLease.phase !== 'query_dispatched')
        throw new AgentError('reconciliation_not_dispatched');
      const result = receipt.result as Record<string, Json> | null;
      const verified =
        receipt.supervision === 'ended' &&
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        ['succeeded', 'failed', 'cancelled'].includes(String(result.outcome));
      if (verified && typeof result!.content !== 'string')
        throw new AgentError('invalid_reconciliation_receipt');
      if (receipt.outcome !== (verified ? 'verified' : 'unresolved'))
        throw new AgentError('invalid_reconciliation_receipt');
      db.run(
        "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
        canonicalJson(receipt as unknown as Json),
        input.lease.commandId,
      );
      db.run(
        "UPDATE execution SET delivery='suppressed',delivery_reason='explicit_reconciliation' WHERE id=? AND delivery='pending'",
        input.lease.executionId,
      );
      db.event(input.lease.sessionId, input.lease.commandId, 'job.reconciliation_finished');
      return db.command(db.row('SELECT * FROM command WHERE id=?', input.lease.commandId)!);
    }
    throw new AgentError('unsupported_store_operation');
  });
}
