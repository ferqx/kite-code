import { canonicalJson } from '../../json';
import { AgentError, type Json, type RequirementEvaluation } from '../types';
import type { SqliteOperations } from './operations';
import { readRunExecutionSafety } from './run-execution-safety';

/** A finite CAS read set. Evidence text is never a substitute for these current record facts. */
export function assertRequirementReadSet(
  db: SqliteOperations,
  evaluation: RequirementEvaluation,
  phase: 'dispatch' | 'completion',
  boundaryExecutionId?: string,
): void {
  const safety = evaluation.executionSafetyReads;
  if (safety !== undefined) {
    if (!Array.isArray(safety) || safety.length > 1)
      throw new AgentError('requirement_read_set_invalid');
    for (const read of safety) {
      const ref = evaluation.requirement;
      if (
        !read ||
        Object.keys(read).some(
          (key) => !['runId', 'excludedExecutionId', 'revision', 'unconfirmed'].includes(key),
        ) ||
        read.runId !== ref.runId ||
        typeof read.unconfirmed !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(read.revision) ||
        (read.excludedExecutionId !== null && read.excludedExecutionId !== boundaryExecutionId)
      )
        throw new AgentError('requirement_read_set_invalid');
      if (read.unconfirmed) {
        const boundary =
          boundaryExecutionId && db.row('SELECT * FROM execution WHERE id=?', boundaryExecutionId);
        // A Job's dispatch condition may observe its own planned execution and parent work.
        // Completion, waiver and informational acceptance still require a clear closure.
        if (
          phase !== 'dispatch' ||
          evaluation.outcome !== 'satisfied' ||
          read.excludedExecutionId !== null ||
          !boundary ||
          boundary.kind !== 'job' ||
          boundary.state !== 'planned'
        )
          throw new AgentError('requirement_read_set_invalid');
      }
      const run = db.row('SELECT origin_command_id FROM run WHERE id=?', ref.runId);
      const command =
        run && db.row('SELECT subject_id FROM command WHERE id=?', run.origin_command_id!);
      if (!command) throw new AgentError('requirement_not_satisfied');
      const actual = readRunExecutionSafety(db, {
        expectedStoreId: ref.originStoreId!,
        sessionId: ref.sessionId,
        subjectId: String(command.subject_id),
        runId: ref.runId,
        ...(read.excludedExecutionId ? { excludeExecutionId: read.excludedExecutionId } : {}),
      });
      if (
        actual.revision !== read.revision ||
        actual.unconfirmed !== read.unconfirmed ||
        (read.unconfirmed && !actual.unconfirmedExecutionIds.includes(boundaryExecutionId!))
      )
        throw new AgentError('requirement_not_satisfied');
    }
  }
  const reads = evaluation.recordReads;
  if (reads === undefined) return;
  if (
    !Array.isArray(reads) ||
    reads.length > 64 ||
    Buffer.byteLength(canonicalJson(reads as unknown as Json)) > 32 * 1024
  )
    throw new AgentError('requirement_read_set_invalid');
  const keys = new Set<string>();
  const ref = evaluation.requirement;
  const storeId = db.metadata().storeId;
  for (const read of reads) {
    if (
      !read ||
      typeof read !== 'object' ||
      Array.isArray(read) ||
      Object.keys(read).some((key) => !['key', 'revision', 'originStoreId'].includes(key)) ||
      typeof read.key !== 'string' ||
      read.key.length < 1 ||
      read.key.length > 256 ||
      keys.has(read.key) ||
      (read.revision !== null &&
        (typeof read.revision !== 'string' ||
          !/^[1-9][0-9]*$/.test(read.revision) ||
          BigInt(read.revision) > 9223372036854775807n)) ||
      (read.revision === null
        ? read.originStoreId !== null
        : typeof read.originStoreId !== 'string' ||
          read.originStoreId !== storeId ||
          (ref.originStoreId !== undefined && read.originStoreId !== ref.originStoreId))
    )
      throw new AgentError('requirement_read_set_invalid');
    keys.add(read.key);
    const current = db.row(
      "SELECT revision,origin_store_id,fork_provenance_json FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      ref.extensionId,
      ref.sessionId,
      read.key,
    );
    if (
      read.revision === null
        ? current !== null
        : !current ||
          String(current.revision) !== read.revision ||
          current.origin_store_id !== read.originStoreId ||
          current.fork_provenance_json !== null
    )
      throw new AgentError('requirement_not_satisfied');
  }
}
