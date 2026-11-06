import { resolve } from 'node:path';
import type { PermissionDecision } from '../../extensions';
import { canonicalJson } from '../../json';
import {
  validWorktreeDecision,
  worktreeConfigurationIdentity,
} from '../../permissions/worktree-authorization';
import {
  decodeWorkerRequest,
  digest,
  limits,
  parseGitWorktreeInput,
  resolveDefaultWorktreeTarget,
  validateFrame,
  validatePlan,
  validateRequest,
  validateResolvedWorktreeTarget,
} from '../../tools/git-worktree/protocol';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const obj = (value: unknown): Record<string, Json> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('worktree_authorization_changed');
  return value as Record<string, Json>;
};
const parsed = (value: unknown) => obj(JSON.parse(String(value)));
const same = (a: unknown, b: unknown) =>
  canonicalJson((a ?? null) as Json) === canonicalJson((b ?? null) as Json);
function preparationFrame(
  db: SqliteOperations,
  execution: Row,
  request: { operationToken: string; phase: string },
) {
  const facts = db.row(
    "SELECT COUNT(*) AS count,COUNT(DISTINCT seq) AS distinct_count,MIN(seq) AS first,MAX(seq) AS last,SUM(CASE WHEN through_seq<>seq OR dropped_bytes<>0 OR is_gap<>0 OR stream NOT IN ('stdout','stderr') THEN 1 ELSE 0 END) AS invalid,SUM(CASE WHEN stream='stdout' THEN length(CAST(content AS BLOB)) ELSE 0 END) AS stdout_bytes,SUM(CASE WHEN stream='stderr' THEN length(CAST(content AS BLOB)) ELSE 0 END) AS stderr_bytes FROM execution_output WHERE execution_id=?",
    execution.id!,
  );
  if (
    !facts ||
    Number(facts.first) !== 1 ||
    facts.count !== facts.distinct_count ||
    facts.last !== execution.output_seq ||
    facts.count !== execution.output_seq ||
    Number(facts.invalid) !== 0 ||
    Number(facts.stdout_bytes) > limits.frameBytes ||
    Number(facts.stderr_bytes) > limits.gitStderrBytes
  )
    throw new AgentError('worktree_authorization_changed');
  const stdout = db.row(
    "SELECT group_concat(content,'') AS content FROM (SELECT content FROM execution_output WHERE execution_id=? AND stream='stdout' ORDER BY seq)",
    execution.id!,
  );
  const frame = stdout && JSON.parse(String(stdout.content));
  if (
    !validateFrame(frame, request as Parameters<typeof validateFrame>[1]) ||
    frame.businessOutcome !== 'prepared'
  )
    throw new AgentError('worktree_authorization_changed');
  return frame;
}

/** Compare every policy dimension while mapping only this registered Tool to its own Job. */
function policy(snapshot: Json, planCeiling = false): Json {
  const tree = obj(snapshot),
    data = obj(tree.data);
  if (tree.version !== '1') throw new AgentError('worktree_authorization_changed');
  if (tree.namespace === 'agent.permission-intersection') {
    if (!Array.isArray(data.policies)) throw new AgentError('worktree_authorization_changed');
    return {
      namespace: tree.namespace,
      policies: data.policies.map((p) => {
        const leaf = obj(p);
        return { scope: leaf.scope!, snapshot: policy(leaf.snapshot!, planCeiling) };
      }),
    };
  }
  if (tree.namespace === 'builtin.planning.permissions')
    return {
      namespace: tree.namespace,
      planning: data.planning!,
      originalRun: data.originalRun!,
      current: policy(data.current!, planCeiling),
      ceiling: data.ceiling === null ? null : policy(data.ceiling!, true),
    };
  const capability = obj(data.capability);
  if (
    tree.namespace !== 'builtin.permissions' ||
    data.workspaceTrust !== true ||
    capability.hardAllowed !== true ||
    capability.safeRead !== false ||
    capability.autoReview !== undefined ||
    !['auto', 'accept_edits', 'full'].includes(String(data.mode)) ||
    !['git.worktree', 'shell.command'].includes(String(capability.definitionId)) ||
    capability.definitionVersion !== '1'
  )
    throw new AgentError('worktree_authorization_changed');
  return {
    mode: data.mode!,
    workspaceTrust: data.workspaceTrust,
    policyRevision: data.policyRevision!,
    allowed: planCeiling ? null : data.worktreeAllowedDigest!,
    effects: [...(capability.effects as Json[])].sort(),
    executionScope: capability.executionScope ?? null,
    worktreeAuthorization: capability.worktreeAuthorization!,
  };
}

/** Live immutable parent/Run/record bindings; called again in the final dispatch transaction. */
export function worktreeAuthorizationBoundary(
  db: SqliteOperations,
  target: Row,
  decision: PermissionDecision,
) {
  if (
    !validWorktreeDecision(decision) ||
    decision.allowed ||
    decision.check?.requireApproval ||
    (!decision.approval && !decision.check)
  )
    throw new AgentError('worktree_authorization_changed');
  const parent =
    target.parent_execution_id &&
    db.row('SELECT * FROM execution WHERE id=?', target.parent_execution_id);
  if (
    target.kind !== 'job' ||
    target.adapter_id !== 'shell.command' ||
    target.definition_version !== '1' ||
    target.cancel_requested ||
    Number(target.cancel_with_parent) !== 1 ||
    !parent ||
    parent.kind !== 'tool' ||
    parent.adapter_id !== 'git.worktree' ||
    parent.definition_version !== '1' ||
    !parent.dispatched ||
    parent.cancel_requested ||
    !['dispatching', 'running'].includes(String(parent.state)) ||
    !parent.run_id ||
    [
      'origin_store_id',
      'session_id',
      'root_work_command_id',
      'root_work_seq',
      'owner_generation',
    ].some((key) => target[key] !== parent[key])
  )
    throw new AgentError('worktree_authorization_changed');
  // Existing nested Jobs have run_id=NULL; their real Run is the actual parent Tool's sealed Run.
  if (target.run_id !== null && target.run_id !== parent.run_id)
    throw new AgentError('worktree_authorization_changed');
  const run = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    parent.run_id,
    parent.session_id!,
  );
  const config = run && parsed(run.config_json);
  if (
    !config ||
    !Array.isArray(config.tools) ||
    !config.tools.some((entry) => {
      const tool = obj(entry);
      return (
        tool.id === 'git.worktree' && tool.version === '1' && tool.extensionId === 'builtin.shell'
      );
    }) ||
    !Array.isArray(config.extensions) ||
    !config.extensions.some((entry) => {
      const extension = obj(entry);
      return extension.id === 'builtin.shell' && extension.version === '1';
    })
  )
    throw new AgentError('worktree_authorization_changed');
  const accepted = parsed(parent.dispatch_authorization_json);
  const seal =
    accepted.worktreeDecisionSeal as unknown as PermissionDecision['worktreeDecisionSeal'];
  const original = seal && (obj(seal.decision) as unknown as PermissionDecision);
  if (
    accepted.allowed !== true ||
    !original ||
    !validWorktreeDecision({ ...original, worktreeDecisionSeal: seal }) ||
    original.check?.requireApproval ||
    original.revision !== accepted.revision ||
    !same(original.snapshot, accepted.snapshot) ||
    !same(original.controlReads, accepted.controlReads) ||
    !same(original.controlReads, decision.controlReads) ||
    !same(policy(accepted.snapshot!), policy(decision.snapshot as unknown as Json))
  )
    throw new AgentError('worktree_authorization_changed');
  const input = parseGitWorktreeInput(JSON.parse(String(parent.intent_json)));
  if (!input || input.action === 'list') throw new AgentError('worktree_authorization_changed');
  const key = `git-worktree/${input.key}`;
  const record = db.row(
    "SELECT * FROM extension_record WHERE extension_id='builtin.shell' AND scope_kind='session' AND scope_id=? AND key=?",
    parent.session_id!,
    key,
  );
  if (
    !record ||
    record.origin_store_id !== parent.origin_store_id ||
    record.fork_provenance_json !== null ||
    record.content_type !== 'application/vnd.kite.git-worktree-operation+json' ||
    Number(record.content_version) !== 1
  )
    throw new AgentError('worktree_authorization_changed');
  const value = parsed(record.json),
    steps = obj(value.steps);
  const identity = worktreeConfigurationIdentity(decision.snapshot);
  const usesDefaultTarget = input.action === 'create' && input.path === undefined;
  if (usesDefaultTarget) {
    // The original Run seals the host configuration. A model or record cannot select a root.
    const snapshot = obj(config.snapshot);
    const shellSnapshot = snapshot.shell === undefined ? obj(snapshot.configuration) : snapshot;
    const captured = obj(obj(obj(shellSnapshot.shell).assets).gitWorktree);
    const configuration = obj(captured.configuration);
    if (
      typeof configuration.defaultRoot !== 'string' ||
      typeof configuration.sourceCwd !== 'string' ||
      digest(configuration) !== identity ||
      !validateResolvedWorktreeTarget(value.resolvedTarget) ||
      value.resolvedTarget.defaultRoot !== resolve(configuration.defaultRoot) ||
      value.resolvedTarget.path !==
        resolveDefaultWorktreeTarget({
          defaultRoot: configuration.defaultRoot,
          sourceCwd: configuration.sourceCwd,
          sessionId: String(parent.session_id),
          key: input.key,
        })
    )
      throw new AgentError('worktree_authorization_changed');
  } else if (value.resolvedTarget !== undefined)
    throw new AgentError('worktree_authorization_changed');
  if (
    value.schemaVersion !== 1 ||
    value.ownerExecutionId !== parent.id ||
    value.configurationIdentity !== identity ||
    !same(value.request, input) ||
    value.stableResult ||
    !Number.isFinite(Date.parse(String(value.acceptedAt))) ||
    Date.parse(String(value.deadlineAt)) !==
      Date.parse(String(value.acceptedAt)) + input.timeoutMs ||
    Date.now() >= Date.parse(String(value.deadlineAt))
  )
    throw new AgentError('worktree_authorization_changed');
  const origin = db.row('SELECT * FROM command WHERE id=?', target.origin_command_id!);
  const kind = ['prepare', 'mutation'].find(
    (name) => steps[name] && obj(steps[name]).operationKey === origin?.operation_key,
  );
  if (!kind || (kind === 'prepare' && steps.mutation))
    throw new AgentError('worktree_authorization_changed');
  const token = digest({
    sessionId: String(parent.session_id),
    executionId: String(parent.id),
    key,
    requestDigest: value.requestDigest!,
  });
  const frozenStep = (execution: Row, name: string) => {
    const step = obj(steps[name]),
      worker = obj(step.request),
      origin = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
    if (
      origin?.extension_id !== 'builtin.shell' ||
      origin.kind !== 'operation.job' ||
      [
        'origin_store_id',
        'session_id',
        'root_work_command_id',
        'root_work_seq',
        'owner_generation',
      ].some((key) => execution[key] !== parent[key]) ||
      execution.parent_execution_id !== parent.id ||
      execution.adapter_id !== 'shell.command' ||
      execution.definition_version !== '1' ||
      execution.kind !== 'job' ||
      Number(execution.cancel_with_parent) !== 1 ||
      execution.cancel_requested ||
      !Number.isInteger(step.timeoutMs) ||
      Number(step.timeoutMs) < 1 ||
      Number(step.timeoutMs) > input.timeoutMs
    )
      throw new AgentError('worktree_authorization_changed');
    const request = parsed(origin.request_json);
    if (
      !validateRequest(worker) ||
      worker.operationToken !== token ||
      worker.phase !== (name === 'prepare' ? `prepare_${input.action}` : input.action) ||
      value.requestDigest !== digest({ input, sourceCwd: worker.sourceCwd }) ||
      step.inputDigest !== digest(JSON.parse(String(execution.intent_json)) as Json) ||
      !same(step.input, JSON.parse(String(execution.intent_json))) ||
      !same(obj(step.input).permissions, input.permissions) ||
      step.operationKey !== `git-worktree-${digest({ token, kind: name })}` ||
      request.parentExecutionId !== parent.id ||
      request.extensionId !== 'builtin.shell' ||
      request.operationKey !== step.operationKey ||
      origin.operation_key !== step.operationKey ||
      request.cancellation !== 'attached' ||
      request.definitionId !== 'shell.command' ||
      request.definitionVersion !== '1' ||
      !same(request.input, step.input)
    )
      throw new AgentError('worktree_authorization_changed');
    const encoded = / '([A-Za-z0-9_-]+)'$/.exec(String(obj(step.input).command));
    if (!encoded || !same(decodeWorkerRequest(encoded[1]!), worker))
      throw new AgentError('worktree_authorization_changed');
    if (step.ref) {
      const ref = obj(step.ref);
      if (
        ref.executionId !== execution.id ||
        ref.commandId !== origin.id ||
        ref.originStoreId !== execution.origin_store_id ||
        ref.sessionId !== execution.session_id ||
        ref.key !== step.operationKey ||
        ref.extensionId !== 'builtin.shell'
      )
        throw new AgentError('worktree_authorization_changed');
    }
    if (
      name === 'prepare' &&
      (!same(worker.input, input) || !same(worker.resolvedTarget, value.resolvedTarget))
    )
      throw new AgentError('worktree_authorization_changed');
    return { step, worker };
  };
  const { step, worker } = frozenStep(target, kind);
  if (kind === 'prepare') {
    if (!same(worker.input, input)) throw new AgentError('worktree_authorization_changed');
  } else {
    if (
      !validatePlan(value.plan) ||
      value.planDigest !== digest(value.plan) ||
      !same(worker.plan, value.plan) ||
      worker.planDigest !== value.planDigest ||
      value.plan.action !== input.action ||
      value.plan.sourceCwd !== worker.sourceCwd ||
      (input.action === 'create' &&
        (value.plan.baseRef !== input.baseRef || value.plan.newBranch !== input.newBranch))
    )
      throw new AgentError('worktree_authorization_changed');
    const prepared = obj(steps.prepare),
      ref = obj(prepared.ref);
    const execution = db.row('SELECT * FROM execution WHERE id=?', String(ref.executionId));
    if (execution?.state !== 'succeeded' || !execution.dispatched)
      throw new AgentError('worktree_authorization_changed');
    const preparation = frozenStep(execution, 'prepare');
    const frame = preparationFrame(
      db,
      execution,
      preparation.worker as unknown as { operationToken: string; phase: string },
    );
    if (!same(frame.plan, value.plan) || frame.planDigest !== value.planDigest)
      throw new AgentError('worktree_authorization_changed');
  }
  const { ref: _ref, ...frozen } = step;
  return {
    parent,
    accepted,
    original,
    recordKey: key,
    stepKind: kind,
    stepDigest: digest(frozen),
    planDigest: kind === 'mutation' ? value.planDigest! : null,
  };
}
