import { createHash, randomUUID } from 'node:crypto';
import type { PermissionDecision } from '../../extensions';
import { canonicalJson } from '../../json';
import { dispatchScopeLeaves } from '../../permissions/dispatch-scope';
import { isAutoWorktreeDecision } from '../../permissions/worktree-authorization';
import type { AutoAuthorizationEvidence, DispatchInput, Store } from '../port';
import { AgentError, type ExecutionAuthorizationObservation, type Json } from '../types';
import {
  authorizationCheckFact,
  verifyAuthorizationBehaviorBinding,
  verifyAuthorizationCheckDispatch,
} from './authorization-check';
import { assertCurrentChildPurpose } from './child-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { verifyInteractionDispatch } from './interaction-operations';
import type { SqliteOperations } from './operations';
import { verifyPermissionGrantDispatch } from './permission-grants';
import { worktreeAuthorizationBoundary } from './worktree-authorization';

type Row = Record<string, string | number | bigint | null>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const obj = (value: unknown): Record<string, Json> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('authorization_policy_unverifiable');
  return value as Record<string, Json>;
};
const parsed = (value: unknown) => obj(JSON.parse(String(value)));
const reviewFingerprint = (payload: Record<string, Json>): Json =>
  payload.review ? (obj(payload.review).fingerprint ?? null) : null;
/** The selected owner computed this proof from both exact inputs; SQL checks identities only. */
function trustedParentBridge(
  db: SqliteOperations,
  job: Row,
  tool: Row,
  preparation: Json | undefined,
): boolean {
  if (
    !preparation ||
    job.parent_execution_id !== tool.id ||
    job.kind !== 'job' ||
    tool.kind !== 'tool'
  )
    return false;
  const proof = obj(preparation);
  const origin = db.row('SELECT * FROM command WHERE id=?', job.origin_command_id!);
  return (
    proof.parentExecutionId === tool.id &&
    proof.parentInputDigest === hash(JSON.parse(String(tool.intent_json))) &&
    typeof proof.operationDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(proof.operationDigest) &&
    Array.isArray(proof.parentBindings) &&
    proof.parentBindings.some((value) => {
      const binding = obj(value);
      return (
        binding.kind === tool.kind &&
        binding.definitionId === tool.adapter_id &&
        binding.definitionVersion === tool.definition_version
      );
    }) &&
    origin?.kind === 'operation.job' &&
    proof.cancelWithParent === Boolean(job.cancel_with_parent)
  );
}

function sameReviewFamily(a: Json | undefined, b: Json | undefined): boolean {
  if (!a || !b) return false;
  const left = obj(a),
    right = obj(b);
  return (
    left.contractRef === right.contractRef && left.configurationDigest === right.configurationDigest
  );
}
function autoScope(snapshot: Json): boolean {
  const leaves = [
    ...dispatchScopeLeaves(
      snapshot as unknown as NonNullable<DispatchInput['authorization']['snapshot']>,
      'authorization_policy_unverifiable',
    ),
  ];
  return (
    leaves.length > 0 &&
    leaves.every(
      ({ namespace, data }) => namespace === 'builtin.permissions' && data.mode === 'auto',
    )
  );
}

/** A currently valid human scope grant approves this Tool, not previously inspected code bytes. */
function parentGrant(db: SqliteOperations, parent: Row, accepted: Record<string, Json>) {
  const grant = obj(accepted.grant);
  const offer = grant.offer ? obj(grant.offer) : null;
  const binding = grant.binding ? obj(grant.binding) : null;
  const permission =
    offer && binding && Array.isArray(offer.policyBindings)
      ? offer.policyBindings.find((value) => {
          const candidate = obj(value);
          return canonicalJson(candidate.capability!) === canonicalJson(binding);
        })
      : null;
  if (
    !parent.dispatched ||
    accepted.allowed !== true ||
    !permission ||
    obj(permission).satisfiesCheck !== true ||
    obj(permission).requireApproval === true ||
    !autoScope(accepted.snapshot!)
  )
    throw new AgentError('authorization_policy_changed');
  verifyPermissionGrantDispatch(db, {
    expectedStoreId: String(parent.origin_store_id),
    executionId: String(parent.id),
    authorization: accepted,
  } as unknown as DispatchInput);
  return grant;
}

/** Stable authority changes only; reviewer/model telemetry never revokes its own evidence. */
export function autoAuthorizationContext(db: SqliteOperations, target: Row): string {
  const commands = db.rows(
    "SELECT id,request_digest,cancelled FROM command WHERE origin_store_id=? AND root_work_command_id=? AND (id=? OR (kind='child.start' AND session_id=?) OR (kind='input.steer' AND status='applied')) ORDER BY session_id,seq",
    target.origin_store_id!,
    target.root_work_command_id!,
    target.root_work_command_id!,
    target.session_id!,
  );
  const refusals = db.rows(
    "SELECT id,result_revision FROM execution WHERE origin_store_id=? AND session_id=? AND root_work_command_id=? AND state='failed' AND COALESCE(json_extract(result_json,'$.code'),json_extract(result_json,'$.details.code')) IN ('approval_denied','permission_denied') ORDER BY id",
    target.origin_store_id!,
    target.session_id!,
    target.root_work_command_id!,
  );
  return hash({
    origin: commands.map((r) => [String(r.id), String(r.request_digest), Boolean(r.cancelled)]),
    refusals: refusals.map((r) => [String(r.id), String(r.result_revision)]),
  });
}

function currentTarget(
  db: SqliteOperations,
  input: Pick<
    Parameters<Store['resolveAutoAuthorization']>[0],
    'expectedStoreId' | 'owner' | 'targetExecutionId'
  >,
) {
  db.identity(input.expectedStoreId);
  const target = db.row('SELECT * FROM execution WHERE id=?', input.targetExecutionId);
  if (
    !target ||
    target.origin_store_id !== input.expectedStoreId ||
    !['tool', 'job'].includes(String(target.kind)) ||
    target.state !== 'planned' ||
    target.dispatched ||
    target.cancel_requested ||
    String(target.owner_generation) !== input.owner.generation
  )
    throw new AgentError('authorization_policy_target_unavailable');
  db.owner(input.owner, String(target.session_id));
  assertCurrentChildPurpose(db, String(target.session_id));
  db.active(
    input.owner,
    String(target.origin_command_id),
    target.run_id === null ? null : String(target.run_id),
  );
  db.ancestors(input.owner, String(target.id));
  assertNoExecutionGroupFence(db, String(target.session_id));
  return target;
}

function scopeSnapshot(
  snapshot: Json,
  filesystem: 'workspace_write' | 'full_access',
  network: 'none' | 'internet',
): Json {
  const tree = obj(snapshot);
  if (tree.namespace === 'builtin.business.permissions') {
    const data = obj(tree.data);
    return {
      ...tree,
      data: {
        ...data,
        current: scopeSnapshot(data.current!, filesystem, network),
        gate: data.gate!,
      },
    };
  }
  if (tree.namespace === 'agent.permission-intersection') {
    const data = obj(tree.data);
    if (!Array.isArray(data.policies) || !data.policies.length)
      throw new AgentError('authorization_policy_scope_unavailable');
    return {
      ...tree,
      data: {
        ...data,
        policies: data.policies.map((p) => {
          const leaf = obj(p);
          return { ...leaf, snapshot: scopeSnapshot(leaf.snapshot!, filesystem, network) };
        }),
      },
    };
  }
  if (tree.namespace !== 'builtin.permissions')
    throw new AgentError('authorization_policy_scope_unavailable');
  const data = obj(tree.data),
    capability = obj(data.capability);
  if (
    !['auto', 'full', 'accept_edits'].includes(String(data.mode)) ||
    data.workspaceTrust !== true ||
    capability.hardAllowed !== true
  )
    throw new AgentError('authorization_policy_scope_unavailable');
  // Timeout passes the semantic review gate; the original requested scope and
  // every independent tool/parent ceiling still determine execution authority.
  const ceiling = capability.executionScope
    ? obj(capability.executionScope)
    : {
        filesystem: data.mode === 'full' ? 'full_access' : 'workspace_write',
        network: data.mode === 'full' ? 'internet' : 'none',
      };
  if (
    !['workspace_write', 'full_access'].includes(String(ceiling.filesystem)) ||
    !['none', 'internet'].includes(String(ceiling.network))
  )
    throw new AgentError('authorization_policy_scope_unavailable');
  return {
    ...tree,
    data: {
      ...data,
      capability: {
        ...capability,
        executionScope: {
          filesystem:
            filesystem === 'workspace_write' || ceiling.filesystem === 'workspace_write'
              ? 'workspace_write'
              : 'full_access',
          network: network === 'none' || ceiling.network === 'none' ? 'none' : 'internet',
        },
      },
    },
  };
}

/** Tool/Job IDs differ, but this bridge may not change any policy or effect dimension. */
function bridgePolicy(snapshot: Json): Json {
  const tree = obj(snapshot);
  if (tree.namespace === 'builtin.business.permissions') {
    const data = obj(tree.data);
    return {
      ...tree,
      data: {
        ...data,
        current: bridgePolicy(data.current!),
        gate: data.gate!,
      },
    };
  }
  if (tree.namespace === 'agent.permission-intersection') {
    const data = obj(tree.data);
    if (!Array.isArray(data.policies)) throw new AgentError('authorization_policy_unverifiable');
    return {
      namespace: tree.namespace,
      version: tree.version!,
      policies: data.policies.map((p) => {
        const leaf = obj(p);
        return { scope: leaf.scope!, snapshot: bridgePolicy(leaf.snapshot!) };
      }),
    };
  }
  const data = obj(tree.data),
    capability = obj(data.capability);
  if (tree.namespace !== 'builtin.permissions' || capability.hardAllowed !== true)
    throw new AgentError('authorization_policy_unverifiable');
  return {
    namespace: tree.namespace,
    version: tree.version!,
    mode: data.mode!,
    workspaceTrust: data.workspaceTrust!,
    policyRevision: data.policyRevision!,
    effects:
      capability.kind === 'tool' && Array.isArray(capability.effects)
        ? capability.effects.filter((e) => e !== 'record_write').sort()
        : capability.effects!,
    executionScope: capability.executionScope ?? null,
  };
}

function sameScope(a: Row, b: Row) {
  return (
    a.origin_store_id === b.origin_store_id &&
    a.session_id === b.session_id &&
    a.root_work_command_id === b.root_work_command_id &&
    a.root_work_seq === b.root_work_seq &&
    a.owner_generation === b.owner_generation
  );
}

/** An observed intervening effect invalidates inference about mutable command inputs. */
function interveningEffect(db: SqliteOperations, original: Row, check: Row, target: Row): boolean {
  if (check.completed_cursor === null || check.completed_cursor === undefined) return true;
  const rows = db.rows(
    "SELECT * FROM execution WHERE origin_store_id=? AND root_work_command_id=? AND kind IN ('tool','job') AND dispatched=1 AND id<>? AND id<>? AND (completed_cursor>? OR state IN ('dispatching','running','outcome_unknown'))",
    original.origin_store_id!,
    original.root_work_command_id!,
    original.id!,
    target.id!,
    check.completed_cursor,
  );
  return rows.some((row) => {
    try {
      if (sameApprovedEffect(db, row, original, check)) return false;
      const accepted = parsed(row.dispatch_authorization_json);
      const leaves = [
        ...dispatchScopeLeaves(
          accepted.snapshot as unknown as NonNullable<DispatchInput['authorization']['snapshot']>,
          'authorization_policy_unverifiable',
        ),
      ];
      return (
        !leaves.length ||
        leaves.some(({ data }) => {
          const effects = obj(data.capability).effects;
          return (
            !Array.isArray(effects) || effects.some((e) => e !== 'read' && e !== 'record_write')
          );
        })
      );
    } catch {
      return true;
    }
  });
}

function checkSource(db: SqliteOperations, target: Row, checkId: string) {
  const check = db.row('SELECT * FROM execution WHERE id=?', checkId);
  const command = check && db.row('SELECT * FROM command WHERE id=?', check.origin_command_id!);
  if (
    !check ||
    !command ||
    check.parent_execution_id !== target.id ||
    command.kind !== 'authorization.check'
  )
    throw new AgentError('authorization_policy_unverifiable');
  const payload = obj(parsed(command.request_json).input);
  const fact = authorizationCheckFact(
    db,
    String(target.id),
    checkId,
    String(payload.policyRevision),
  );
  if (
    db.row(
      "SELECT id FROM command WHERE kind='authorization.invalidate' AND status='applied' AND cancelled=0 AND json_extract(receipt_json,'$.checkExecutionId')=?",
      checkId,
    )
  )
    throw new AgentError('authorization_policy_changed');
  return { ...fact, check };
}

/** Original sealed binding only; callers separately check current authority and source eligibility. */
function sealedPolicy(
  db: SqliteOperations,
  id: string,
): { payload: Record<string, Json>; target: Row } {
  const command = db.row('SELECT * FROM command WHERE id=?', id);
  if (command?.kind !== 'authorization.policy' || command.status !== 'applied' || command.cancelled)
    throw new AgentError('authorization_policy_unverifiable');
  const request = parsed(command.request_json),
    payload = obj(request.input);
  const target = db.row('SELECT * FROM execution WHERE id=?', String(payload.targetExecutionId));
  if (
    !target ||
    request.kind !== 'authorization.policy' ||
    request.parentExecutionId !== target.id ||
    command.origin_store_id !== target.origin_store_id ||
    command.session_id !== target.session_id ||
    command.root_work_command_id !== target.root_work_command_id ||
    command.root_work_seq !== target.root_work_seq ||
    command.request_digest !== hash(request) ||
    command.operation_key !== `policy/${hash(payload)}` ||
    parsed(command.receipt_json).policyEvidenceId !== command.id ||
    payload.inputDigest !== hash(JSON.parse(String(target.intent_json))) ||
    payload.sourceDigest !== hash(JSON.parse(String(target.decision_source_json))) ||
    payload.ownerGeneration !== String(target.owner_generation)
  )
    throw new AgentError('authorization_policy_changed');
  const origin = db.row('SELECT * FROM command WHERE id=?', target.origin_command_id!);
  if (!origin || origin.subject_id !== command.subject_id || origin.cancelled)
    throw new AgentError('authorization_policy_changed');
  return { payload, target };
}

/**
 * Only completed executions sealed to this exact original approval may be excluded.
 * This deliberately avoids evidence(), whose live effect scan would recurse here.
 */
function sameApprovedEffect(db: SqliteOperations, row: Row, original: Row, check: Row): boolean {
  if (row.state !== 'succeeded' || row.cancel_requested || !sameScope(row, original)) return false;
  const accepted = parsed(row.dispatch_authorization_json);
  if (accepted.allowed !== true || typeof accepted.policyEvidenceId !== 'string') return false;
  const proof = sealedPolicy(db, accepted.policyEvidenceId);
  if (
    proof.target.id !== row.id ||
    proof.payload.policyRevision !== accepted.revision ||
    canonicalJson(proof.payload.snapshot!) !== canonicalJson(accepted.snapshot!) ||
    canonicalJson(proof.payload.controlReads!) !== canonicalJson(accepted.controlReads ?? null)
  )
    return false;
  const checked = checkSource(db, original, String(check.id));
  const originalAccepted = parsed(original.dispatch_authorization_json);
  if (
    checked.result.decision !== 'approve_once' ||
    checked.payload.requireApproval ||
    originalAccepted.allowed !== true ||
    originalAccepted.checkExecutionId !== check.id
  )
    return false;
  let tool = row,
    toolProof = proof;
  if (row.kind === 'job') {
    const source = obj(proof.payload.source);
    if (source.kind === 'check') {
      return (
        row.parent_execution_id === original.id &&
        original.kind === 'tool' &&
        proof.payload.reason === 'parent_review' &&
        source.id === check.id &&
        source.targetExecutionId === original.id &&
        proof.payload.operationKey === checked.payload.operationKey &&
        proof.payload.autoContext === checked.payload.autoContext &&
        canonicalJson(proof.payload.checker!) === canonicalJson(checked.payload.checker!) &&
        canonicalJson(proof.payload.controlReads!) ===
          canonicalJson(originalAccepted.controlReads ?? null) &&
        canonicalJson(bridgePolicy(proof.payload.snapshot!)) ===
          canonicalJson(bridgePolicy(originalAccepted.snapshot!))
      );
    }
    if (
      row.definition_version !== '1' ||
      proof.payload.reason !== 'parent_review' ||
      source.kind !== 'policy' ||
      typeof source.id !== 'string'
    )
      return false;
    toolProof = sealedPolicy(db, source.id);
    tool = toolProof.target;
    const parentAccepted = parsed(tool.dispatch_authorization_json);
    if (
      row.parent_execution_id !== tool.id ||
      tool.kind !== 'tool' ||
      tool.definition_version !== '1' ||
      tool.state !== 'succeeded' ||
      tool.cancel_requested ||
      !sameScope(tool, row) ||
      parentAccepted.allowed !== true ||
      parentAccepted.policyEvidenceId !== source.id ||
      toolProof.payload.policyRevision !== parentAccepted.revision ||
      canonicalJson(toolProof.payload.snapshot!) !== canonicalJson(parentAccepted.snapshot!) ||
      canonicalJson(toolProof.payload.controlReads!) !==
        canonicalJson(parentAccepted.controlReads ?? null) ||
      canonicalJson(bridgePolicy(proof.payload.snapshot!)) !==
        canonicalJson(bridgePolicy(toolProof.payload.snapshot!)) ||
      proof.payload.operationKey !== toolProof.payload.operationKey ||
      proof.payload.autoContext !== toolProof.payload.autoContext ||
      canonicalJson(proof.payload.checker!) !== canonicalJson(toolProof.payload.checker!) ||
      canonicalJson(proof.payload.controlReads!) !== canonicalJson(toolProof.payload.controlReads!)
    )
      return false;
  }
  const source = obj(toolProof.payload.source);
  if (
    tool.kind !== original.kind ||
    tool.adapter_id !== original.adapter_id ||
    tool.definition_version !== original.definition_version ||
    toolProof.payload.reason !== 'reused_approval' ||
    source.kind !== 'check' ||
    source.id !== check.id ||
    source.targetExecutionId !== original.id
  )
    return false;
  return (
    toolProof.payload.policyRevision === checked.payload.policyRevision &&
    toolProof.payload.operationKey === checked.payload.operationKey &&
    toolProof.payload.autoContext === checked.payload.autoContext &&
    canonicalJson(toolProof.payload.checker!) === canonicalJson(checked.payload.checker!) &&
    canonicalJson(toolProof.payload.controlReads!) ===
      canonicalJson(originalAccepted.controlReads ?? null) &&
    canonicalJson(toolProof.payload.snapshot!) === canonicalJson(originalAccepted.snapshot!) &&
    canonicalJson(toolProof.payload.requestedSnapshot!) ===
      canonicalJson(originalAccepted.snapshot!)
  );
}

function evidence(
  db: SqliteOperations,
  id: string,
  depth = 0,
): { payload: Record<string, Json>; target: Row; materialReviewed?: true } {
  if (depth > 4) throw new AgentError('authorization_policy_unverifiable');
  const { payload, target } = sealedPolicy(db, id);
  if (target.cancel_requested || payload.autoContext !== autoAuthorizationContext(db, target))
    throw new AgentError('authorization_policy_changed');
  const source = obj(payload.source);
  let materialReviewed = false;
  if (source.kind === 'worktree') {
    const decision = obj(payload.worktreeDecision) as unknown as PermissionDecision;
    const boundary = worktreeAuthorizationBoundary(db, target, decision);
    if (
      payload.reason !== 'parent_review' ||
      source.targetExecutionId !== boundary.parent.id ||
      source.recordKey !== boundary.recordKey ||
      source.stepKind !== boundary.stepKind ||
      source.stepDigest !== boundary.stepDigest ||
      source.planDigest !== boundary.planDigest ||
      payload.policyRevision !== decision.revision ||
      !sameWorktreeJson(payload.snapshot, decision.snapshot) ||
      !sameWorktreeJson(payload.controlReads, decision.controlReads)
    )
      throw new AgentError('authorization_policy_changed');
    verifyWorktreeSource(db, boundary.parent, boundary.accepted, boundary.original);
  } else if (source.kind === 'check') {
    const sourceTarget = db.row(
      'SELECT * FROM execution WHERE id=?',
      String(source.targetExecutionId),
    );
    if (!sourceTarget || !sameScope(target, sourceTarget))
      throw new AgentError('authorization_policy_changed');
    const checked = checkSource(db, sourceTarget, String(source.id));
    if (
      checked.payload.operationKey !== payload.operationKey ||
      checked.payload.autoContext !== payload.autoContext ||
      canonicalJson(checked.payload.checker!) !== canonicalJson(payload.checker!) ||
      (payload.reason === 'parent_review'
        ? !sameReviewFamily(checked.payload.behavior, payload.behavior)
        : canonicalJson(checked.payload.behavior ?? null) !==
          canonicalJson(payload.behavior ?? null)) ||
      reviewFingerprint(checked.payload) !== reviewFingerprint(payload)
    )
      throw new AgentError('authorization_policy_changed');
    if (payload.reason === 'timeout_continue') {
      const result = parsed(checked.check.result_json),
        timeout = obj(checked.payload.timeout);
      if (
        sourceTarget.id !== target.id ||
        checked.check.state !== 'failed' ||
        result.code !== 'authorization_check_timeout' ||
        result.deadlineAt !== timeout.deadlineAt ||
        typeof timeout.deadlineAt !== 'number' ||
        Date.now() < timeout.deadlineAt
      )
        throw new AgentError('authorization_policy_changed');
    } else if (
      checked.result.decision !== 'approve_once' ||
      checked.payload.requireApproval === true
    )
      throw new AgentError('authorization_policy_changed');
    else materialReviewed = checked.result.materialReviewed === true;
    if (payload.reason === 'parent_review') {
      if (
        target.parent_execution_id !== sourceTarget.id ||
        target.kind !== 'job' ||
        sourceTarget.kind !== 'tool' ||
        !trustedParentBridge(db, target, sourceTarget, payload.parentProof) ||
        !sourceTarget.dispatch_authorization_json
      )
        throw new AgentError('authorization_policy_changed');
      const accepted = parsed(sourceTarget.dispatch_authorization_json);
      if (
        accepted.checkExecutionId !== source.id ||
        canonicalJson(bridgePolicy(accepted.snapshot!)) !==
          canonicalJson(bridgePolicy(payload.snapshot!))
      )
        throw new AgentError('authorization_policy_changed');
    }
    if (
      payload.reason !== 'parent_review' &&
      checked.payload.policyRevision !== payload.policyRevision
    )
      throw new AgentError('authorization_policy_changed');
    if (
      payload.reason === 'reused_approval' &&
      interveningEffect(db, sourceTarget, checked.check, target)
    )
      throw new AgentError('authorization_policy_changed');
  } else if (source.kind === 'policy') {
    const prior = evidence(db, String(source.id), depth + 1);
    if (
      payload.reason !== 'parent_review' ||
      target.parent_execution_id !== prior.target.id ||
      !sameScope(target, prior.target) ||
      prior.payload.operationKey !== payload.operationKey ||
      canonicalJson(prior.payload.checker!) !== canonicalJson(payload.checker!) ||
      sameReviewFamily(prior.payload.behavior, payload.behavior) === false ||
      reviewFingerprint(prior.payload) !== reviewFingerprint(payload) ||
      canonicalJson(prior.payload.controlReads ?? null) !==
        canonicalJson(payload.controlReads ?? null)
    )
      throw new AgentError('authorization_policy_changed');
    materialReviewed = prior.materialReviewed === true;
    if (
      target.kind !== 'job' ||
      prior.target.kind !== 'tool' ||
      !trustedParentBridge(db, target, prior.target, payload.parentProof) ||
      canonicalJson(bridgePolicy(prior.payload.snapshot!)) !==
        canonicalJson(bridgePolicy(payload.snapshot!))
    )
      throw new AgentError('authorization_policy_changed');
    const accepted = prior.target.dispatch_authorization_json
      ? parsed(prior.target.dispatch_authorization_json)
      : undefined;
    if (accepted?.allowed !== true || accepted.policyEvidenceId !== source.id)
      throw new AgentError('authorization_policy_changed');
  } else if (source.kind === 'grant') {
    const parent = db.row('SELECT * FROM execution WHERE id=?', String(source.targetExecutionId));
    if (
      payload.reason !== 'parent_review' ||
      !parent ||
      parent.cancel_requested ||
      !sameScope(target, parent) ||
      target.parent_execution_id !== parent.id ||
      target.kind !== 'job' ||
      parent.kind !== 'tool' ||
      !trustedParentBridge(db, target, parent, payload.parentProof) ||
      !parent.dispatch_authorization_json ||
      !autoScope(payload.snapshot!)
    )
      throw new AgentError('authorization_policy_changed');
    const accepted = parsed(parent.dispatch_authorization_json);
    const grant = parentGrant(db, parent, accepted);
    if (
      grant.grantId !== source.id ||
      grant.revision !== source.revision ||
      canonicalJson(grant.offer!) !== canonicalJson(source.offer!) ||
      canonicalJson(accepted.controlReads ?? null) !== canonicalJson(payload.controlReads!) ||
      canonicalJson(bridgePolicy(accepted.snapshot!)) !==
        canonicalJson(bridgePolicy(payload.snapshot!))
    )
      throw new AgentError('authorization_policy_changed');
    // The grant is current human authority, not a fresh model review of this material.
  } else if (source.kind === 'interaction') {
    const parent = db.row('SELECT * FROM execution WHERE id=?', String(source.targetExecutionId));
    if (
      !parent ||
      !sameScope(target, parent) ||
      target.parent_execution_id !== parent.id ||
      !trustedParentBridge(db, target, parent, payload.parentProof) ||
      target.kind !== 'job' ||
      parent.kind !== 'tool' ||
      !parent.dispatch_authorization_json ||
      payload.reason !== 'parent_review'
    )
      throw new AgentError('authorization_policy_changed');
    const accepted = parsed(parent.dispatch_authorization_json);
    const checked = checkSource(db, parent, String(source.checkExecutionId));
    if (
      accepted.allowed !== true ||
      accepted.interactionId !== source.id ||
      accepted.decisionRevision !== source.decisionRevision ||
      checked.result.decision !== 'ask_user' ||
      checked.result.materialReviewed !== true ||
      checked.payload.requireApproval ||
      checked.payload.operationKey !== payload.operationKey ||
      checked.payload.autoContext !== payload.autoContext ||
      (payload.reason === 'parent_review'
        ? !sameReviewFamily(checked.payload.behavior, payload.behavior)
        : canonicalJson(checked.payload.behavior ?? null) !==
          canonicalJson(payload.behavior ?? null)) ||
      reviewFingerprint(checked.payload) !== reviewFingerprint(payload) ||
      canonicalJson(checked.payload.checker!) !== canonicalJson(payload.checker!) ||
      canonicalJson(bridgePolicy(accepted.snapshot!)) !==
        canonicalJson(bridgePolicy(payload.snapshot!))
    )
      throw new AgentError('authorization_policy_changed');
    verifyInteractionDispatch(db, parent, { authorization: accepted } as unknown as DispatchInput);
    materialReviewed = true;
  } else throw new AgentError('authorization_policy_unverifiable');
  return { payload, target, ...(materialReviewed ? { materialReviewed: true as const } : {}) };
}

const sameWorktreeJson = (a: unknown, b: unknown) =>
  canonicalJson((a ?? null) as Json) === canonicalJson((b ?? null) as Json);

function verifyWorktreeSource(
  db: SqliteOperations,
  parent: Row,
  accepted: Record<string, Json>,
  original: PermissionDecision,
): void {
  if (
    accepted.worktreeAuthorizationContext !== autoAuthorizationContext(db, parent) ||
    (!accepted.interactionId &&
      !accepted.checkExecutionId &&
      !accepted.policyEvidenceId &&
      !accepted.grant &&
      !isAutoWorktreeDecision({
        ...original,
        worktreeDecisionSeal:
          accepted.worktreeDecisionSeal as unknown as PermissionDecision['worktreeDecisionSeal'],
      }))
  )
    throw new AgentError('authorization_policy_changed');
  const input = {
    expectedStoreId: String(parent.origin_store_id),
    executionId: String(parent.id),
    authorization: accepted,
  } as unknown as DispatchInput;
  verifyInteractionDispatch(db, parent, input);
  verifyPermissionGrantDispatch(db, input);
  verifyAuthorizationCheckDispatch(db, input);
}

/** This business intent has already been approved; the frozen internal stages get no new authority. */
export function resolveWorktreeAuthorization(
  db: SqliteOperations,
  input: Parameters<Store['resolveWorktreeAuthorization']>[0],
): AutoAuthorizationEvidence | null {
  return db.tx(() => {
    const target = currentTarget(db, input);
    let boundary: ReturnType<typeof worktreeAuthorizationBoundary>;
    try {
      boundary = worktreeAuthorizationBoundary(db, target, input.decision);
      verifyWorktreeSource(db, boundary.parent, boundary.accepted, boundary.original);
    } catch (error) {
      if (error instanceof AgentError && error.code === 'worktree_scope_changed') throw error;
      return null;
    }
    const payload: Json = {
      targetExecutionId: String(target.id),
      inputDigest: hash(JSON.parse(String(target.intent_json))),
      sourceDigest: hash(JSON.parse(String(target.decision_source_json))),
      ownerGeneration: String(target.owner_generation),
      policyRevision: input.decision.revision,
      operationKey: hash({ parent: String(boundary.parent.id), step: boundary.stepDigest }),
      autoContext: autoAuthorizationContext(db, target),
      worktreeDecision: input.decision as unknown as Json,
      controlReads: (input.decision.controlReads as unknown as Json) ?? null,
      snapshot: input.decision.snapshot as unknown as Json,
      requestedSnapshot: input.decision.snapshot as unknown as Json,
      reason: 'parent_review',
      source: {
        kind: 'worktree',
        targetExecutionId: String(boundary.parent.id),
        recordKey: boundary.recordKey,
        stepKind: boundary.stepKind,
        stepDigest: boundary.stepDigest,
        planDigest: boundary.planDigest,
      },
    };
    const key = `policy/${hash(payload)}`;
    let command = db.row(
      "SELECT * FROM command WHERE kind='authorization.policy' AND session_id=? AND operation_key=?",
      target.session_id!,
      key,
    );
    if (!command) {
      const id = randomUUID(),
        request: Json = {
          kind: 'authorization.policy',
          parentExecutionId: String(target.id),
          input: payload,
        };
      const origin = db.row('SELECT * FROM command WHERE id=?', target.origin_command_id!)!;
      db.allocateSessionSequence(String(target.session_id));
      const seq = db.row('SELECT next_seq FROM session WHERE id=?', target.session_id!)!.next_seq!;
      db.run(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,'authorization.policy',?,?,?,'applied',?,?,?,?,?,'execution',?,?)",
        id,
        target.session_id!,
        seq,
        origin.subject_id!,
        hash(request),
        canonicalJson(request),
        canonicalJson({ policyEvidenceId: id }),
        target.origin_store_id!,
        target.root_work_command_id!,
        target.root_work_seq!,
        '__authorization_policy__',
        target.id!,
        key,
      );
      db.event(String(target.session_id), String(target.id), 'authorization.policy', {
        targetExecutionId: String(target.id),
        policyEvidenceId: id,
        reason: 'parent_review',
        source: obj(payload).source!,
        requestedScope:
          (publicScope(input.decision.snapshot as unknown as Json) as unknown as Json) ?? null,
        effectiveScope:
          (publicScope(input.decision.snapshot as unknown as Json) as unknown as Json) ?? null,
      });
      command = db.row('SELECT * FROM command WHERE id=?', id)!;
    }
    evidence(db, String(command.id));
    return {
      policyEvidenceId: String(command.id),
      reason: 'parent_review',
      snapshot: input.decision.snapshot,
    };
  });
}

export function resolveAutoAuthorization(
  db: SqliteOperations,
  input: Parameters<Store['resolveAutoAuthorization']>[0],
): AutoAuthorizationEvidence | null {
  return db.tx(() => {
    const target = currentTarget(db, input),
      decision = input.decision;
    if (
      !/^[a-f0-9]{64}$/.test(input.operationKey) ||
      !decision.check ||
      decision.allowed ||
      decision.check.requireApproval ||
      !decision.snapshot
    )
      return null;
    const autoContext = autoAuthorizationContext(db, target);
    verifyAuthorizationBehaviorBinding(
      db,
      target,
      input.behavior,
      input.checker as unknown as Json,
    );
    const usesBehavior = input.review !== undefined;
    const preparation = input.review;
    const fingerprint = preparation?.fingerprint ?? null;
    let source: Json | undefined, reason: AutoAuthorizationEvidence['reason'] | undefined;
    let inheritedTimeout: Record<string, Json> | undefined;
    let snapshot = decision.snapshot;
    const parent =
      target.parent_execution_id &&
      db.row('SELECT * FROM execution WHERE id=?', target.parent_execution_id);
    if (
      target.kind === 'job' &&
      parent &&
      parent.kind === 'tool' &&
      sameScope(target, parent) &&
      trustedParentBridge(db, target, parent, input.parentProof) &&
      !parent.cancel_requested &&
      parent.dispatch_authorization_json
    ) {
      try {
        const accepted = parsed(parent.dispatch_authorization_json);
        let candidateSnapshot = decision.snapshot;
        if (typeof accepted.policyEvidenceId === 'string') {
          const prior = evidence(db, accepted.policyEvidenceId);
          if (prior.payload.reason === 'timeout_continue') {
            const fallback = obj(prior.payload.timeoutScope);
            if (
              !['workspace_write', 'full_access'].includes(String(fallback.filesystem)) ||
              !['none', 'internet'].includes(String(fallback.network))
            )
              throw new AgentError('authorization_policy_scope_unavailable');
            candidateSnapshot = scopeSnapshot(
              decision.snapshot as unknown as Json,
              fallback.filesystem as 'workspace_write' | 'full_access',
              fallback.network as 'none' | 'internet',
            ) as unknown as typeof snapshot;
          }
        }
        if (
          accepted.allowed === true &&
          canonicalJson(accepted.controlReads ?? null) ===
            canonicalJson((decision.controlReads as unknown as Json) ?? null) &&
          canonicalJson(bridgePolicy(accepted.snapshot!)) ===
            canonicalJson(bridgePolicy(candidateSnapshot as unknown as Json))
        ) {
          if (typeof accepted.checkExecutionId === 'string') {
            const checked = checkSource(db, parent, accepted.checkExecutionId);
            if (
              checked.result.decision === 'approve_once' &&
              !checked.payload.requireApproval &&
              checked.payload.operationKey === input.operationKey &&
              checked.payload.autoContext === autoContext &&
              sameReviewFamily(checked.payload.behavior, input.behavior as unknown as Json) &&
              reviewFingerprint(checked.payload) === fingerprint &&
              canonicalJson(checked.payload.checker!) ===
                canonicalJson(input.checker as unknown as Json)
            )
              source = {
                kind: 'check',
                id: accepted.checkExecutionId,
                targetExecutionId: String(parent.id),
              };
          } else if (typeof accepted.policyEvidenceId === 'string') {
            const prior = evidence(db, accepted.policyEvidenceId);
            const timeoutParent =
              prior.payload.reason === 'timeout_continue' &&
              trustedParentBridge(db, target, parent, input.parentProof);
            if (
              (timeoutParent ||
                (prior.payload.operationKey === input.operationKey &&
                  reviewFingerprint(prior.payload) === fingerprint)) &&
              sameReviewFamily(prior.payload.behavior, input.behavior as unknown as Json) &&
              canonicalJson(prior.payload.checker!) ===
                canonicalJson(input.checker as unknown as Json)
            ) {
              source = { kind: 'policy', id: accepted.policyEvidenceId };
              if (timeoutParent) inheritedTimeout = prior.payload;
            }
          } else if (usesBehavior && typeof accepted.interactionId === 'string') {
            const rows = db.rows(
              "SELECT id FROM execution WHERE parent_execution_id=? AND kind='model'",
              parent.id!,
            );
            for (const row of rows) {
              const checked = checkSource(db, parent, String(row.id));
              if (
                checked.result.decision !== 'ask_user' ||
                checked.result.materialReviewed !== true ||
                checked.payload.requireApproval ||
                checked.payload.operationKey !== input.operationKey ||
                checked.payload.autoContext !== autoContext ||
                reviewFingerprint(checked.payload) !== fingerprint ||
                canonicalJson(checked.payload.checker!) !==
                  canonicalJson(input.checker as unknown as Json)
              )
                continue;
              verifyInteractionDispatch(db, parent, {
                authorization: accepted,
              } as unknown as DispatchInput);
              source = {
                kind: 'interaction',
                id: accepted.interactionId,
                decisionRevision: accepted.decisionRevision!,
                targetExecutionId: String(parent.id),
                checkExecutionId: String(row.id),
              };
              break;
            }
          }
          if (
            !source &&
            usesBehavior &&
            accepted.grant &&
            autoScope(candidateSnapshot as unknown as Json)
          ) {
            const grant = parentGrant(db, parent, accepted);
            source = {
              kind: 'grant',
              id: grant.grantId!,
              revision: grant.revision!,
              offer: grant.offer!,
              targetExecutionId: String(parent.id),
            };
          }
          if (source) {
            reason = 'parent_review';
            snapshot = candidateSnapshot;
          }
        }
      } catch {
        // An ineligible parent is not a denial: this Job still gets its own review.
        source = undefined;
        reason = undefined;
        snapshot = decision.snapshot;
      }
    }
    if (
      !source &&
      !input.timedOutCheckId &&
      input.reuseApproval !== false &&
      (!usesBehavior || preparation?.reusable === true)
    ) {
      const rows = db.rows(
        "SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE c.kind='authorization.check' AND e.session_id=? AND e.root_work_command_id=? AND e.state='succeeded' AND json_extract(c.request_json,'$.input.operationKey')=? ORDER BY c.seq DESC LIMIT 64",
        target.session_id!,
        target.root_work_command_id!,
        input.operationKey,
      );
      for (const row of rows) {
        const original =
          row.parent_execution_id &&
          db.row('SELECT * FROM execution WHERE id=?', row.parent_execution_id);
        if (
          !original ||
          !sameScope(target, original) ||
          original.kind !== target.kind ||
          original.adapter_id !== target.adapter_id ||
          original.definition_version !== target.definition_version ||
          original.cancel_requested
        )
          continue;
        try {
          const checked = checkSource(db, original, String(row.id));
          if (
            checked.result.decision === 'approve_once' &&
            !checked.payload.requireApproval &&
            checked.payload.policyRevision === decision.revision &&
            checked.payload.autoContext === autoContext &&
            sameReviewFamily(checked.payload.behavior, input.behavior as unknown as Json) &&
            reviewFingerprint(checked.payload) === fingerprint &&
            (!usesBehavior || obj(checked.payload.review).reusable === true) &&
            canonicalJson(checked.payload.checker!) ===
              canonicalJson(input.checker as unknown as Json) &&
            !interveningEffect(db, original, checked.check, target)
          ) {
            source = { kind: 'check', id: String(row.id), targetExecutionId: String(original.id) };
            reason = 'reused_approval';
            break;
          }
        } catch {
          /* Stale facts are history, never reusable authority. */
        }
      }
    }
    if (!source && input.timedOutCheckId) {
      const checked = checkSource(db, target, input.timedOutCheckId);
      const result = parsed(checked.check.result_json),
        timeout = obj(checked.payload.timeout);
      const fallback = decision.check.timeoutScope;
      if (
        checked.check.state !== 'failed' ||
        result.code !== 'authorization_check_timeout' ||
        result.deadlineAt !== timeout.deadlineAt ||
        typeof timeout.deadlineAt !== 'number' ||
        Date.now() < timeout.deadlineAt ||
        checked.payload.operationKey !== input.operationKey ||
        checked.payload.autoContext !== autoContext ||
        checked.payload.policyRevision !== decision.revision ||
        checked.payload.requireApproval ||
        canonicalJson(checked.payload.checker!) !==
          canonicalJson(input.checker as unknown as Json) ||
        !fallback ||
        (fallback !== 'governed' &&
          (!['workspace_write', 'full_access'].includes(fallback.filesystem) ||
            !['none', 'internet'].includes(fallback.network)))
      )
        return null;
      snapshot =
        fallback === 'governed'
          ? decision.snapshot
          : (scopeSnapshot(
              decision.snapshot as unknown as Json,
              fallback.filesystem,
              fallback.network,
            ) as unknown as typeof snapshot);
      source = { kind: 'check', id: input.timedOutCheckId, targetExecutionId: String(target.id) };
      reason = 'timeout_continue';
    }
    if (!source || !reason) return null;
    const payload: Json = {
      targetExecutionId: String(target.id),
      inputDigest: hash(JSON.parse(String(target.intent_json))),
      sourceDigest: hash(JSON.parse(String(target.decision_source_json))),
      ownerGeneration: String(target.owner_generation),
      policyRevision: decision.revision,
      operationKey: inheritedTimeout?.operationKey ?? input.operationKey,
      autoContext,
      checker: input.checker as unknown as Json,
      behavior: input.behavior as unknown as Json,
      ...(input.parentProof ? { parentProof: input.parentProof } : {}),
      ...(usesBehavior
        ? {
            review: (inheritedTimeout
              ? (inheritedTimeout.review ?? null)
              : (preparation ?? null)) as unknown as Json,
          }
        : {}),
      controlReads: (decision.controlReads as unknown as Json) ?? null,
      snapshot: snapshot as unknown as Json,
      requestedSnapshot: decision.snapshot as unknown as Json,
      timeoutScope: (decision.check.timeoutScope as unknown as Json) ?? null,
      reason,
      source,
    };
    const key = `policy/${hash(payload)}`;
    let command = db.row(
      "SELECT * FROM command WHERE kind='authorization.policy' AND session_id=? AND operation_key=?",
      target.session_id!,
      key,
    );
    if (!command) {
      const id = randomUUID(),
        request: Json = {
          kind: 'authorization.policy',
          parentExecutionId: String(target.id),
          input: payload,
        };
      const origin = db.row('SELECT * FROM command WHERE id=?', target.origin_command_id!)!;
      db.allocateSessionSequence(String(target.session_id));
      const seq = db.row('SELECT next_seq FROM session WHERE id=?', target.session_id!)!.next_seq!;
      db.run(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,'authorization.policy',?,?,?,'applied',?,?,?,?,?,'execution',?,?)",
        id,
        target.session_id!,
        seq,
        origin.subject_id!,
        hash(request),
        canonicalJson(request),
        canonicalJson({ policyEvidenceId: id }),
        target.origin_store_id!,
        target.root_work_command_id!,
        target.root_work_seq!,
        '__authorization_policy__',
        target.id!,
        key,
      );
      db.event(String(target.session_id), String(target.id), 'authorization.policy', {
        targetExecutionId: String(target.id),
        policyEvidenceId: id,
        reason,
        source,
        requestedScope:
          (publicScope(decision.snapshot as unknown as Json) as unknown as Json) ?? null,
        effectiveScope: (publicScope(snapshot as unknown as Json) as unknown as Json) ?? null,
      });
      command = db.row('SELECT * FROM command WHERE id=?', id)!;
    }
    const verified = evidence(db, String(command.id));
    return {
      policyEvidenceId: String(command.id),
      reason,
      snapshot,
      ...(verified.materialReviewed ? { materialReviewed: true as const } : {}),
    };
  });
}

export function verifyAutoAuthorizationDispatch(db: SqliteOperations, input: DispatchInput): void {
  const value = evidence(db, input.authorization.policyEvidenceId!);
  if (
    value.target.id !== input.executionId ||
    value.target.origin_store_id !== input.expectedStoreId ||
    value.payload.policyRevision !== input.authorization.revision ||
    value.payload.inputDigest !== input.authorization.inputDigest ||
    (value.materialReviewed === true) !== (input.authorization.materialReviewed === true) ||
    canonicalJson(value.payload.snapshot!) !==
      canonicalJson((input.authorization.snapshot as unknown as Json) ?? null) ||
    canonicalJson(value.payload.controlReads!) !==
      canonicalJson((input.authorization.controlReads as unknown as Json) ?? null)
  )
    throw new AgentError('authorization_policy_changed');
}

function publicScope(
  snapshot: Json,
): NonNullable<ExecutionAuthorizationObservation['policy']>['effectiveScope'] {
  try {
    let filesystem: 'workspace_write' | 'full_access' = 'full_access',
      network: 'none' | 'internet' = 'internet';
    let count = 0;
    for (const { namespace, data } of dispatchScopeLeaves(
      snapshot as unknown as NonNullable<DispatchInput['authorization']['snapshot']>,
      'authorization_policy_unverifiable',
    )) {
      if (namespace !== 'builtin.permissions') return undefined;
      const scope = obj(data.capability).executionScope;
      if (!scope) return undefined;
      const value = obj(scope);
      if (
        !['workspace_write', 'full_access'].includes(String(value.filesystem)) ||
        !['none', 'internet'].includes(String(value.network))
      )
        return undefined;
      if (value.filesystem === 'workspace_write') filesystem = 'workspace_write';
      if (value.network === 'none') network = 'none';
      count++;
    }
    return count ? { filesystem, network } : undefined;
  } catch {
    return undefined;
  }
}

/** Historical display checks the sealed original binding, never today's revocation epoch. */
export function authorizationPolicyObservation(
  db: SqliteOperations,
  target: Row,
): ExecutionAuthorizationObservation['policy'] {
  try {
    const accepted = target.dispatch_authorization_json
      ? parsed(target.dispatch_authorization_json)
      : null;
    if (typeof accepted?.policyEvidenceId !== 'string') return undefined;
    const row = db.row('SELECT * FROM command WHERE id=?', accepted.policyEvidenceId);
    if (
      row?.kind !== 'authorization.policy' ||
      row.status !== 'applied' ||
      row.session_id !== target.session_id ||
      row.origin_store_id !== target.origin_store_id
    )
      return undefined;
    const request = parsed(row.request_json),
      payload = obj(request.input);
    if (
      row.request_digest !== hash(request) ||
      row.operation_key !== `policy/${hash(payload)}` ||
      request.parentExecutionId !== target.id ||
      payload.targetExecutionId !== target.id ||
      payload.ownerGeneration !== String(target.owner_generation) ||
      payload.inputDigest !== hash(JSON.parse(String(target.intent_json))) ||
      payload.sourceDigest !== hash(JSON.parse(String(target.decision_source_json))) ||
      parsed(row.receipt_json).policyEvidenceId !== row.id ||
      payload.policyRevision !== accepted.revision ||
      canonicalJson(payload.snapshot!) !== canonicalJson(accepted.snapshot!) ||
      !['reused_approval', 'parent_review', 'timeout_continue'].includes(String(payload.reason))
    )
      return undefined;
    let source = obj(payload.source),
      sourceExecutionId: string | undefined,
      checkExecutionId: string | undefined;
    for (let depth = 0; depth < 5; depth++) {
      if (source.kind === 'worktree') {
        sourceExecutionId = String(source.targetExecutionId);
        const parent = db.row(
          'SELECT dispatch_authorization_json FROM execution WHERE id=?',
          sourceExecutionId,
        );
        const accepted =
          parent?.dispatch_authorization_json && parsed(parent.dispatch_authorization_json);
        if (accepted && typeof accepted.checkExecutionId === 'string')
          checkExecutionId = accepted.checkExecutionId;
        else if (accepted && typeof accepted.policyEvidenceId === 'string') {
          const inherited = db.row(
            "SELECT request_json FROM command WHERE id=? AND kind='authorization.policy'",
            accepted.policyEvidenceId,
          );
          if (inherited) {
            const previous = obj(parsed(inherited.request_json).input),
              origin = obj(previous.source);
            if (origin.kind === 'check' && typeof origin.id === 'string')
              checkExecutionId = origin.id;
          }
        }
        break;
      }
      if (source.kind === 'grant') {
        sourceExecutionId = String(source.targetExecutionId);
        break;
      }
      if (source.kind === 'interaction') {
        sourceExecutionId = String(source.targetExecutionId);
        checkExecutionId = String(source.checkExecutionId);
        break;
      }
      if (source.kind === 'check') {
        checkExecutionId = String(source.id);
        sourceExecutionId = String(source.targetExecutionId);
        break;
      }
      if (source.kind !== 'policy') break;
      const prior = db.row(
        "SELECT * FROM command WHERE id=? AND kind='authorization.policy'",
        String(source.id),
      );
      if (!prior) break;
      const priorRequest = parsed(prior.request_json);
      if (prior.request_digest !== hash(priorRequest)) break;
      const previous = obj(priorRequest.input);
      sourceExecutionId = String(previous.targetExecutionId);
      source = obj(previous.source);
    }
    const requestedScope = publicScope(payload.requestedSnapshot!),
      effectiveScope = publicScope(payload.snapshot!);
    return {
      evidenceId: String(row.id),
      reason: payload.reason as NonNullable<ExecutionAuthorizationObservation['policy']>['reason'],
      ...(sourceExecutionId ? { sourceExecutionId } : {}),
      ...(checkExecutionId ? { checkExecutionId } : {}),
      ...(requestedScope ? { requestedScope } : {}),
      ...(effectiveScope ? { effectiveScope } : {}),
    };
  } catch {
    return undefined;
  }
}
