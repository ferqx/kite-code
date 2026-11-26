import { canonicalJson } from '../json';
import { grantDigest } from '../permission-grants';
import { AgentError, type ExecutionRecord, type Json } from './types';

export interface FileEditBatchSeal {
  readonly kind: 'file_edit_batch@1';
  readonly modelExecutionId: string;
  readonly leaderExecutionId: string;
  readonly digest: string;
  readonly members: readonly { readonly callId: string; readonly inputDigest: string }[];
}

const rec = (value: Json | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const hash = (value: Json | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: Json | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function fileEditBatchSeal(source: Json): FileEditBatchSeal | undefined {
  const value = rec(source);
  if (!value || !Object.hasOwn(value, 'fileEditBatch')) return;
  const seal = rec(value.fileEditBatch);
  if (
    value.kind !== 'model_decision' ||
    !seal ||
    seal.kind !== 'file_edit_batch@1' ||
    !text(seal.modelExecutionId) ||
    seal.modelExecutionId !== value.modelExecutionId ||
    !text(seal.leaderExecutionId) ||
    !hash(seal.digest) ||
    !Array.isArray(seal.members) ||
    seal.members.length < 2 ||
    seal.members.length > 32
  )
    throw new AgentError('file_edit_batch_binding_changed');
  const seen = new Set<string>();
  const members = seal.members.map((entry) => {
    const member = rec(entry);
    if (!member || !text(member.callId) || !hash(member.inputDigest) || seen.has(member.callId))
      throw new AgentError('file_edit_batch_binding_changed');
    seen.add(member.callId);
    return { callId: member.callId, inputDigest: member.inputDigest };
  });
  return {
    kind: 'file_edit_batch@1',
    modelExecutionId: seal.modelExecutionId,
    leaderExecutionId: seal.leaderExecutionId,
    digest: seal.digest,
    members,
  };
}

/** Co-settlement is evidence of one shared effect, never another dispatch or approval. */
export function assertFileEditBatchMember(
  leader: ExecutionRecord,
  member: ExecutionRecord,
  model: ExecutionRecord,
  phase: 'dispatch' | 'settlement',
) {
  const invalid = () => new AgentError('file_edit_batch_binding_changed');
  const seal = fileEditBatchSeal(leader.decisionSource);
  const siblingSeal = fileEditBatchSeal(member.decisionSource);
  if (
    !seal ||
    !siblingSeal ||
    canonicalJson(seal as unknown as Json) !== canonicalJson(siblingSeal as unknown as Json) ||
    leader.id !== seal.leaderExecutionId ||
    leader.callId !== seal.members[0]!.callId ||
    leader.id === member.id ||
    leader.callId === member.callId ||
    model.id !== seal.modelExecutionId ||
    model.kind !== 'model' ||
    model.status !== 'succeeded' ||
    model.modelDispatched !== true ||
    member.status !== 'planned' ||
    member.interactionBinding ||
    member.authorization?.dispatched ||
    (phase === 'dispatch' && member.cancelRequestedAt !== null) ||
    !leader.runId ||
    ![leader, member].every(
      (execution) =>
        execution.kind === 'tool' &&
        execution.definitionId === 'files.edit' &&
        execution.definitionVersion === '2' &&
        execution.parentExecutionId === model.parentExecutionId &&
        seal.members.some(
          ({ callId, inputDigest }) =>
            callId === execution.callId && inputDigest === grantDigest(execution.input),
        ),
    ) ||
    ![member, model].every(
      (execution) =>
        execution.originStoreId === leader.originStoreId &&
        execution.sessionId === leader.sessionId &&
        execution.runId === leader.runId &&
        execution.originCommandId === leader.originCommandId &&
        execution.rootWorkCommandId === leader.rootWorkCommandId &&
        execution.rootWorkSeq === leader.rootWorkSeq &&
        execution.stepId === leader.stepId,
    ) ||
    member.ownerGeneration !== leader.ownerGeneration ||
    canonicalJson(rec(leader.decisionSource)?.executionRoot ?? null) !==
      canonicalJson(rec(member.decisionSource)?.executionRoot ?? null)
  )
    throw invalid();
  return seal;
}

export function coveredFileEdit(
  leader: ExecutionRecord,
  member: ExecutionRecord,
  model: ExecutionRecord,
  final: { status: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'; result: Json },
) {
  const seal = assertFileEditBatchMember(leader, member, model, 'settlement');
  const invalid = () => new AgentError('file_edit_batch_binding_changed');
  const leaderResult = rec(final.result);
  if (!leaderResult || leaderResult.outcome !== final.status) throw invalid();
  const code = rec(leaderResult.details)?.code;
  let content: string;
  if (final.status === 'succeeded') {
    if (
      leader.authorization?.dispatched !== true ||
      rec(leaderResult.details)?.fileEditBatchDigest !== seal.digest
    )
      throw invalid();
    content = 'This edit was applied as part of the single atomic edit for this file.';
  } else if (final.status === 'outcome_unknown') {
    if (leader.authorization?.dispatched !== true) throw invalid();
    content = 'The shared file edit outcome could not be confirmed. Do not repeat this edit.';
  } else if (code === 'approval_denied') {
    content = 'Approval for the file edit batch was denied. This edit was not applied.';
  } else {
    content = 'The file edit batch did not publish. This edit was not applied.';
  }
  return {
    outcome: final.status,
    content,
    details: {
      kind: 'file_edit_batch@1',
      leaderExecutionId: leader.id,
      digest: seal.digest,
      ...(typeof code === 'string' ? { code } : {}),
    },
  };
}
