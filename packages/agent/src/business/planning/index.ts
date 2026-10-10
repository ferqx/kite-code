import type { ContextSource, ContextSources } from '../../context';
import type {
  AcceptedInformation,
  ActionContext,
  ActionDefinition,
  ArtifactRef,
  ConditionReadContext,
  Extension,
  ExtensionRecord,
  Json,
  JsonSchema,
  NecessaryConditions,
  OperationRef,
  PublicExecution,
  ReadContext,
  RunInitializationContext,
  ToolDefinition,
  ToolResult,
} from '../../extensions';
import { AgentError } from '../../storage/types';
import { type AutomaticValidationOptions, createAutomaticValidation } from './automatic';
import { checkArtifactSchema, checkSemanticResult } from './verification';

export type { AutomaticValidationOptions } from './automatic';

export const planningExtensionId = 'builtin.planning';
const contentType = 'builtin.planning.record';
const text: JsonSchema = { type: 'string', minLength: 1 };
const schema = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required });
const empty = schema({});
const targetSchema = schema({
  executionId: text,
  attempt: { type: 'integer', minimum: 1 },
  definitionId: text,
  definitionVersion: text,
  inputDigest: text,
  resultRevision: text,
});
type Ref = Parameters<NecessaryConditions['evaluate']>[0][number];
type Target = {
  executionId: string;
  attempt: number;
  definitionId: string;
  definitionVersion: string;
  inputDigest: string;
  resultRevision: string;
};
export interface PlanningOptions {
  automaticValidation?: AutomaticValidationOptions;
  requirePlan?: boolean;
  requiredValidation?: boolean;
  allowWaiver?: boolean;
  requiredReceiptDefinitions?: readonly { definitionId: string; definitionVersion: string }[];
  allowedExecutionModes?: readonly string[];
  /** Host-selected ordinary Tool returning a complete baseline SHA-256, never model metadata. */
  fileHashChecker?: { definitionId: string; definitionVersion: string };
  /** Explicit host registration of a supervised command Job; no ambient Shell fallback. */
  commandChecker?: { definitionId: string; definitionVersion: string };
  /** Host-qualified read-only MCP definitions, not remote annotations or model declarations. */
  mcpCheckers?: readonly {
    id: string;
    definitionId: string;
    definitionVersion: string;
    sourceDefinitionId: string;
    sourceDefinitionVersion: string;
  }[];
}
export interface PlanningRunPolicy {
  /** Trusted host only; false never weakens the factory's existing obligation. */
  requirePlan?: boolean;
  /** Actual immutable manifest Tool identities qualified read-only by the host. */
  readOnlyDefinitions?: readonly {
    kind: 'tool';
    definitionId: string;
    definitionVersion: string;
  }[];
}
export type PlanningState =
  | { status: 'disabled' | 'pending' }
  | {
      status: 'approved';
      mode: 'auto' | 'accept_edits';
      planId: string;
      version: number;
      digest: string;
    };
export interface PlanningInitialization {
  run: { id: string; sessionId: string };
  forExtension(id: string): Promise<RunInitializationContext>;
}
function object(value: Json | undefined): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('planning_invalid_record');
  return value;
}
function string(value: Json | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('planning_invalid_input');
  return value;
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function digest(value: Json) {
  return digestBytes(new TextEncoder().encode(canonical(value)));
}
async function digestBytes(value: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function decode(record: ExtensionRecord | null): Record<string, Json> | null {
  if (!record) return null;
  if (record.contentType !== contentType || record.contentVersion !== 1)
    throw new Error('planning_record_version_unavailable');
  return object(record.value);
}
async function write(context: ActionContext, key: string, value: Json, immutable = false) {
  const old = await context.records.get(key);
  if (old) decode(old);
  if (immutable && old) {
    if (canonical(old.value) !== canonical(value)) throw new Error('planning_identity_conflict');
    return old;
  }
  return context.records.write({
    key,
    expectedRevision: old?.revision ?? null,
    contentType,
    contentVersion: 1,
    value: old ? { ...object(old.value), ...object(value) } : value,
    executable: true,
  });
}
async function writeAt(
  context: ActionContext,
  key: string,
  value: Json,
  prior: ExtensionRecord | null,
) {
  return context.records.write({
    key,
    expectedRevision: prior?.revision ?? null,
    contentType,
    contentVersion: 1,
    executable: true,
    value: prior ? { ...object(prior.value), ...object(value) } : value,
  });
}
const knownPreflight = new Set([
  'planning_invalid_record',
  'planning_invalid_input',
  'planning_record_version_unavailable',
  'planning_identity_conflict',
  'planning_information_proof_unavailable',
  'planning_information_proof_invalid',
  'planning_run_mismatch',
  'planning_review_body_invalid',
  'planning_review_body_unavailable',
  'plan_version_conflict',
  'plan_steps_invalid',
  'plan_identity_mismatch',
  'plan_missing',
  'plan_step_missing',
  'plan_progress_conflict',
  'plan_terminal_rollback',
  'plan_compensation_evidence_required',
  'plan_execution_evidence_required',
  'plan_execution_scope_mismatch',
  'plan_steps_incomplete',
  'plan_requirement_missing',
  'plan_completion_evidence_required',
  'validation_host_checks_missing',
  'validation_plan_missing',
  'validation_waiver_not_allowed',
  'validation_requirement_missing',
  'validation_waiver_unknown_effect',
  'validation_waiver_target_changed',
  'record_revision_conflict',
  'extension_record_format_unavailable',
]);
function guarded(execute: (input: Json, context: ActionContext) => Promise<ToolResult>) {
  return async (input: Json, context: ActionContext): Promise<ToolResult> => {
    try {
      return await execute(input, context);
    } catch (error) {
      if (!(error instanceof Error) || !knownPreflight.has(error.message)) throw error;
      return { outcome: 'failed', content: error.message };
    }
  };
}

function result(value: Json) {
  return { outcome: 'succeeded' as const, content: canonical(value), details: value };
}
async function accepted(
  context: ActionContext,
  kind: 'question' | 'plan_review',
  request: Json,
): Promise<AcceptedInformation> {
  if (!context.requestInteractionWithReceipt)
    throw new Error('planning_information_proof_unavailable');
  const proof = await context.requestInteractionWithReceipt({ kind, request });
  const actual = await context.getInteraction?.(proof.interactionId);
  if (
    !actual ||
    actual.acceptedDecisionRevision !== proof.decisionRevision ||
    actual.executionId !== context.executionId ||
    actual.originStoreId !== proof.originStoreId ||
    actual.sessionId !== context.sessionId ||
    canonical(actual.request) !== canonical(request) ||
    canonical(actual.answer as Json) !== canonical(proof.answer as Json)
  )
    throw new Error('planning_information_proof_invalid');
  return proof;
}
async function proofValid(
  context: ConditionReadContext,
  value: Record<string, Json>,
  request: Json,
  ref: Ref,
) {
  const proof = object(value.proof);
  const interaction = await context.getInteraction?.(string(proof.interactionId));
  const execution = interaction ? await context.getExecution(interaction.executionId) : null;
  return (
    !!interaction &&
    !!execution &&
    (interaction.kind !== 'plan_review' || execution.runId === ref.runId) &&
    execution.sessionId === ref.sessionId &&
    execution.originStoreId === ref.originStoreId &&
    interaction.originStoreId === ref.originStoreId &&
    interaction.sessionId === ref.sessionId &&
    interaction.kind === object(proof.answer).kind &&
    interaction.state === 'answered' &&
    interaction.acceptedDecisionRevision !== null &&
    interaction.acceptedDecisionRevision === proof.decisionRevision &&
    interaction.executionId === proof.executionId &&
    interaction.attempt === proof.attempt &&
    canonical(interaction.request) === canonical(request) &&
    canonical(interaction.answer as Json) === canonical(proof.answer!)
  );
}
async function receiptStatus(
  read: Pick<ReadContext, 'getExecution'>,
  actual: PublicExecution | null,
  target: Target,
  runId: string,
  storeId: string | undefined,
  sessionId: string,
) {
  if (!actual) return 'missing';
  if (
    actual.originStoreId !== storeId ||
    actual.sessionId !== sessionId ||
    actual.attempt !== target.attempt ||
    actual.definitionId !== target.definitionId ||
    actual.definitionVersion !== target.definitionVersion ||
    actual.inputDigest !== target.inputDigest ||
    actual.resultRevision !== target.resultRevision
  )
    return 'scope_mismatch';
  if (actual.runId !== runId) {
    if (actual.kind !== 'job') return 'scope_mismatch';
    let parentId = actual.parentExecutionId,
      matched = false;
    const visited = new Set([actual.id]);
    for (let depth = 0; parentId && depth < 32; depth++) {
      if (visited.has(parentId)) return 'scope_mismatch';
      visited.add(parentId);
      const parent = await read.getExecution(parentId);
      if (
        !parent ||
        parent.originStoreId !== storeId ||
        parent.sessionId !== sessionId ||
        parent.rootWorkCommandId !== actual.rootWorkCommandId ||
        parent.rootWorkSeq !== actual.rootWorkSeq
      )
        return 'scope_mismatch';
      if (parent.runId === runId) {
        matched = parent.kind === 'tool';
        break;
      }
      if (parent.runId !== null) return 'scope_mismatch';
      parentId = parent.parentExecutionId;
    }
    if (!matched) return 'scope_mismatch';
  }
  if (
    actual.kind === 'model' ||
    ['planning.', 'validation.'].some((prefix) => actual.definitionId?.startsWith(prefix))
  )
    return 'inconclusive';
  if (actual.status === 'outcome_unknown') return 'unknown';
  return actual.status === 'succeeded'
    ? 'passed'
    : actual.status === 'failed'
      ? 'failed'
      : 'inconclusive';
}

async function unknownVerification(
  read: Pick<ReadContext, 'getExecution'> & { records: Pick<ReadContext['records'], 'get'> },
  runId: string,
  spec: Record<string, Json> | null,
) {
  const bindingPointer = decode(await read.records.get(`run/${runId}/validation.binding.current`));
  const binding = bindingPointer
    ? decode(await read.records.get(string(bindingPointer.key)))
    : null;
  const bindings = binding ? object(binding.bindings) : {};
  if (spec && Array.isArray(spec.checks))
    for (let i = 0; i < spec.checks.length; i++) {
      const check = object(spec.checks[i]);
      for (const candidate of [check, bindings[String(i)] ? object(bindings[String(i)]) : null]) {
        if (
          candidate?.target &&
          (await read.getExecution(string(object(candidate.target).executionId)))?.status ===
            'outcome_unknown'
        )
          return true;
      }
    }
  const pointer = decode(await read.records.get(`run/${runId}/validation.current`));
  const attempt = pointer ? decode(await read.records.get(string(pointer.key))) : null;
  return (
    !!attempt &&
    Array.isArray(attempt.checks) &&
    attempt.checks.some((check) => object(check).outcome === 'unknown')
  );
}

/** Business records and predicates only. Permissions and execution authority remain in the host. */
export function createPlanningValidation(inputOptions: PlanningOptions = {}) {
  const configured = inputOptions.requiredReceiptDefinitions ?? [];
  if (
    !Array.isArray(configured) ||
    configured.length > 64 ||
    configured.some(
      (item) =>
        !item ||
        Object.keys(item).some((key) => !['definitionId', 'definitionVersion'].includes(key)) ||
        typeof item.definitionId !== 'string' ||
        !item.definitionId.trim() ||
        item.definitionId.length > 512 ||
        typeof item.definitionVersion !== 'string' ||
        !item.definitionVersion.trim() ||
        item.definitionVersion.length > 512,
    ) ||
    new Set(configured.map((item) => canonical([item.definitionId, item.definitionVersion])))
      .size !== configured.length
  )
    throw new Error('validation_host_policy_invalid');
  if (
    inputOptions.fileHashChecker &&
    (Object.keys(inputOptions.fileHashChecker).some(
      (key) => !['definitionId', 'definitionVersion'].includes(key),
    ) ||
      !inputOptions.fileHashChecker.definitionId?.trim() ||
      !inputOptions.fileHashChecker.definitionVersion?.trim())
  )
    throw new Error('validation_host_checker_invalid');
  const mcpCheckers = inputOptions.mcpCheckers ?? [];
  for (const checker of [inputOptions.commandChecker, ...mcpCheckers]) {
    if (
      checker &&
      (!checker.definitionId?.trim() ||
        !checker.definitionVersion?.trim() ||
        Object.keys(checker).some(
          (key) =>
            ![
              'id',
              'definitionId',
              'definitionVersion',
              'sourceDefinitionId',
              'sourceDefinitionVersion',
            ].includes(key),
        ))
    )
      throw new Error('validation_host_checker_invalid');
  }
  if (
    mcpCheckers.length > 64 ||
    mcpCheckers.some(
      (checker) =>
        !checker.id?.trim() ||
        !checker.sourceDefinitionId?.trim() ||
        !checker.sourceDefinitionVersion?.trim(),
    ) ||
    new Set(mcpCheckers.map((checker) => checker.id)).size !== mcpCheckers.length
  )
    throw new Error('validation_host_checker_invalid');
  const options = Object.freeze({
    ...inputOptions,
    commandChecker: inputOptions.commandChecker
      ? Object.freeze({ ...inputOptions.commandChecker })
      : undefined,
    mcpCheckers: Object.freeze(mcpCheckers.map((checker) => Object.freeze({ ...checker }))),
    fileHashChecker: inputOptions.fileHashChecker
      ? Object.freeze({ ...inputOptions.fileHashChecker })
      : undefined,
    requiredReceiptDefinitions: Object.freeze(configured.map((item) => Object.freeze({ ...item }))),
    allowedExecutionModes: Object.freeze([
      ...(inputOptions.allowedExecutionModes ?? ['auto', 'accept_edits']),
    ]),
  });
  const automatic = inputOptions.automaticValidation
    ? createAutomaticValidation(planningExtensionId, inputOptions.automaticValidation)
    : null;
  const modes = [...options.allowedExecutionModes];
  if (!modes.length || modes.some((mode) => !['auto', 'accept_edits'].includes(mode)))
    throw new Error('planning_execution_mode_invalid');
  function semanticDefinition(spec: Record<string, Json>, check: Record<string, Json>) {
    if (check.kind === 'command') {
      if (
        !spec.commandChecker ||
        !options.commandChecker ||
        check.input === undefined ||
        canonical(spec.commandChecker) !== canonical(options.commandChecker)
      )
        return null;
      return { ...options.commandChecker, kind: 'job' as const };
    }
    if (check.kind === 'mcp' && Array.isArray(spec.mcpCheckers)) {
      const configured = options.mcpCheckers.find((checker) => checker.id === check.checkerId);
      if (
        !configured ||
        !spec.mcpCheckers.some((checker) => canonical(checker) === canonical(configured))
      )
        return null;
      return { ...configured, kind: 'tool' as const };
    }
    return null;
  }
  async function semanticProof(
    read: Pick<ReadContext, 'getExecution' | 'getRun' | 'getInteraction'> & {
      records: Pick<ReadContext['records'], 'get'>;
    },
    spec: Record<string, Json>,
    check: Record<string, Json>,
    actual: PublicExecution | null,
    target: Target,
    operationRef: OperationRef,
    checkIndex: number,
    parentExecutionId: string,
    runId: string,
    storeId: string | undefined,
    sessionId: string,
  ) {
    const definition = semanticDefinition(spec, check);
    if (
      !operationRef ||
      operationRef.originStoreId !== storeId ||
      operationRef.sessionId !== sessionId ||
      operationRef.extensionId !== planningExtensionId ||
      (operationRef.executionId !== null && operationRef.executionId !== target.executionId) ||
      (operationRef.executionId === null && actual?.kind !== 'tool') ||
      operationRef.commandId !== actual?.originCommandId ||
      operationRef.key !== `verification/${parentExecutionId}/${checkIndex}`
    )
      return 'scope_mismatch';
    if (
      !actual ||
      !definition ||
      actual.kind !== definition.kind ||
      actual.parentExecutionId !== parentExecutionId ||
      actual.definitionId !== definition.definitionId ||
      actual.definitionVersion !== definition.definitionVersion ||
      actual.inputDigest !== (await digest(check.input!))
    )
      return 'inconclusive';
    // Nested ordinary Tools as well as Jobs carry their actual parent rather than a guessed Run.
    const parent = await read.getExecution(parentExecutionId);
    if (
      !parent ||
      parent.runId !== runId ||
      parent.kind !== 'tool' ||
      parent.definitionId !== 'validation.check' ||
      parent.sessionId !== sessionId ||
      parent.originStoreId !== storeId ||
      actual.originStoreId !== storeId ||
      actual.sessionId !== sessionId ||
      (actual.runId !== null && actual.runId !== runId) ||
      actual.rootWorkCommandId !== parent.rootWorkCommandId ||
      actual.attempt !== target.attempt ||
      actual.definitionId !== target.definitionId ||
      actual.definitionVersion !== target.definitionVersion ||
      actual.inputDigest !== target.inputDigest ||
      actual.resultRevision !== target.resultRevision
    )
      return 'scope_mismatch';
    if (actual.status === 'outcome_unknown') return 'unknown';
    if (actual.status !== 'succeeded' && !(check.kind === 'command' && actual.status === 'failed'))
      return actual.status === 'failed' ? 'failed' : 'inconclusive';
    if (spec.plan !== null && !(await matchesPlanSource({ ...read, sessionId }, actual)))
      return 'scope_mismatch';
    if (check.kind === 'mcp') {
      const source = object(check.target) as unknown as Target;
      const original = await read.getExecution(source.executionId);
      if (
        !('sourceDefinitionId' in definition) ||
        source.definitionId !== definition.sourceDefinitionId ||
        source.definitionVersion !== definition.sourceDefinitionVersion ||
        (await receiptStatus(read, original, source, runId, storeId, sessionId)) !== 'passed' ||
        (spec.plan !== null &&
          (!original || !(await matchesPlanSource({ ...read, sessionId }, original))))
      )
        return 'scope_mismatch';
    }
    try {
      return checkSemanticResult(check, actual);
    } catch {
      return 'inconclusive';
    }
  }
  const management = new Set([
    'planning.read',
    'planning.write',
    'planning.review',
    'planning.update',
    'validation.define',
    'validation.check',
    'validation.rebind',
  ]);
  const planInput = schema({
    planId: text,
    expectedVersion: { type: ['integer', 'null'], minimum: 1 },
    title: text,
    body: text,
    steps: { type: 'array', minItems: 1, items: schema({ id: text, title: text }) },
  });
  const reviewInput = schema({
    planId: text,
    version: { type: 'integer', minimum: 1 },
    digest: text,
  });
  const reviewRequest = (current: Record<string, Json>, plan: Record<string, Json>): Json => ({
    kind: 'plan_review',
    planId: current.planId!,
    version: String(current.version),
    digest: current.digest!,
    content: canonical(plan),
    allowedModes: modes,
  });
  const attachmentRequest = (current: Record<string, Json>, seal: Record<string, Json>): Json => ({
    kind: 'plan_review',
    planId: current.planId!,
    version: String(current.version),
    digest: current.digest!,
    content:
      'The complete plan is in the verified attachment. Read its full content before answering.',
    allowedModes: modes,
    // Existing complete-Interaction attachment protocol; this is information, never a policy grant.
    policy: {
      review: {
        kind: 'artifact',
        complete: true,
        encoding: 'utf-8',
        contentVersion: 1,
        reference: seal.reference!,
        hash: seal.hash!,
        originStoreId: seal.originStoreId!,
        sessionId: seal.sessionId!,
        runId: seal.runId!,
        executionId: seal.executionId!,
        planDigest: current.digest!,
        planRecordKey: seal.planRecordKey!,
        planRecordRevision: seal.planRecordRevision!,
        bodyRecordRevision: seal.bodyRecordRevision!,
      },
    },
  });
  async function sealedRequest(
    read: Pick<ConditionReadContext, 'records'>,
    current: Record<string, Json>,
    planRecord: ExtensionRecord,
    approval: Record<string, Json>,
  ): Promise<Json | null> {
    const plan = decode(planRecord)!;
    if (approval.bodyRecordKey === undefined) return reviewRequest(current, plan);
    const proof = object(approval.proof),
      executionId = string(proof.executionId);
    if (approval.bodyRecordKey !== `review.body/${executionId}`) return null;
    const sealRecord = await read.records.get(string(approval.bodyRecordKey));
    const seal = decode(sealRecord);
    if (!seal) return null;
    const reference = object(seal.reference),
      scope = object(reference.scope);
    if (
      seal.kind !== 'plan_review_body' ||
      seal.contentVersion !== 1 ||
      seal.bodyRecordRevision !== sealRecord!.revision ||
      seal.executionId !== executionId ||
      seal.runId !== approval.runId ||
      seal.runId !== proof.runId ||
      seal.sessionId !== proof.sessionId ||
      seal.originStoreId !== proof.originStoreId ||
      seal.originStoreId !== sealRecord!.originStoreId ||
      seal.originStoreId !== planRecord.originStoreId ||
      seal.planRecordKey !== planRecord.key ||
      seal.planRecordRevision !== planRecord.revision ||
      seal.planId !== current.planId ||
      seal.version !== current.version ||
      seal.digest !== current.digest ||
      scope.kind !== 'execution' ||
      scope.id !== executionId ||
      reference.mediaType !== 'application/json' ||
      reference.size !== String(new TextEncoder().encode(canonical(plan)).byteLength) ||
      seal.hash !== (await digest(plan))
    )
      return null;
    return attachmentRequest(current, seal);
  }
  async function verifyReviewBody(
    context: ActionContext,
    reference: ArtifactRef,
    plan: Record<string, Json>,
  ) {
    if (!context.artifacts) throw new Error('planning_review_body_unavailable');
    const content = await context.artifacts.read(reference);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new Error('planning_review_body_invalid');
    }
    if (
      String(content.byteLength) !== reference.size ||
      text !== canonical(plan) ||
      (await digestBytes(content)) !== (await digest(plan))
    )
      throw new Error('planning_review_body_invalid');
  }
  const tools: ToolDefinition[] = [];
  const functions: Record<
    string,
    {
      input: JsonSchema;
      execute(input: Json, context: ActionContext): Promise<ToolResult>;
    }
  > = {
    'planning.read': {
      input: empty,
      async execute(_input, context) {
        const current = await context.records.get('plan.current');
        const pointer = decode(current);
        const plan = pointer ? await context.records.get(string(pointer.key)) : null;
        return result({ current: current?.value ?? null, plan: plan?.value ?? null });
      },
    },
    'planning.write': {
      input: planInput,
      async execute(input, context) {
        const value = object(input),
          original = await context.records.get('plan.current'),
          current = decode(original);
        if ((current?.version ?? null) !== value.expectedVersion)
          throw new Error('plan_version_conflict');
        const steps = value.steps;
        if (
          !Array.isArray(steps) ||
          new Set(steps.map((s) => string(object(s).id))).size !== steps.length
        )
          throw new Error('plan_steps_invalid');
        const version = Number(current?.version ?? 0) + 1;
        const plan = {
          planId: string(value.planId),
          version,
          title: string(value.title),
          body: string(value.body),
          steps,
        };
        const hash = await digest(plan),
          key = `plan/${encodeURIComponent(plan.planId)}/${version}`;
        await write(context, key, { kind: 'plan_document', ...plan, digest: hash }, true);
        await writeAt(
          context,
          'plan.current',
          {
            kind: 'plan_current',
            key,
            planId: plan.planId,
            version,
            digest: hash,
          },
          original,
        );
        return result({ planId: plan.planId, version, digest: hash });
      },
    },
    'planning.review': {
      input: reviewInput,
      async execute(input, context) {
        const current = decode(await context.records.get('plan.current'));
        const requested = object(input);
        if (!current || ['planId', 'version', 'digest'].some((k) => current[k] !== requested[k]))
          throw new Error('plan_identity_mismatch');
        const planRecord = await context.records.get(string(current.key));
        const plan = decode(planRecord);
        if (!plan) throw new Error('plan_missing');
        const execution = await context.getExecution(context.executionId);
        if (!execution?.originStoreId || execution.sessionId !== context.sessionId)
          throw new Error('planning_run_mismatch');
        let request = reviewRequest(current, plan);
        let bodyReference: ArtifactRef | undefined;
        let bodyRecordKey: string | undefined;
        // This routes by actual canonical metadata size; it never limits the plan body.
        if (new TextEncoder().encode(canonical(request)).byteLength > 32768) {
          if (!context.artifacts) throw new Error('planning_review_body_unavailable');
          bodyReference = await context.artifacts.publish({
            key: 'complete-plan-review',
            mediaType: 'application/json',
            content: new TextEncoder().encode(canonical(plan)),
          });
          if (
            bodyReference.scope?.kind !== 'execution' ||
            bodyReference.scope.id !== context.executionId
          )
            throw new Error('planning_review_body_invalid');
          await verifyReviewBody(context, bodyReference, plan);
          const seal: Record<string, Json> = {
            kind: 'plan_review_body',
            contentVersion: 1,
            bodyRecordRevision: '1',
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
            planRecordKey: planRecord!.key,
            planRecordRevision: planRecord!.revision,
            originStoreId: execution.originStoreId,
            sessionId: context.sessionId,
            runId: execution.runId,
            executionId: context.executionId,
            reference: bodyReference as unknown as Json,
            hash: await digest(plan),
          };
          bodyRecordKey = `review.body/${context.executionId}`;
          await write(context, bodyRecordKey, seal, true);
          request = attachmentRequest(current, seal);
        }
        const proof = await accepted(context, 'plan_review', request);
        if (
          proof.answer.kind !== 'plan_review' ||
          !['approve', 'revise', 'deny'].includes(proof.answer.decision) ||
          (proof.answer.decision === 'approve' && !modes.includes(proof.answer.mode ?? ''))
        )
          return result({ status: 'not_approved' });
        const review = {
          decision: proof.answer.decision,
          ...(proof.answer.feedback !== undefined ? { feedback: proof.answer.feedback } : {}),
        };
        if (proof.answer.decision !== 'approve')
          return result({ status: 'not_approved', ...review });
        if (bodyReference) await verifyReviewBody(context, bodyReference, plan);
        const latest = decode(await context.records.get('plan.current'));
        if (!latest || ['planId', 'version', 'digest'].some((k) => latest[k] !== requested[k]))
          throw new Error('plan_identity_mismatch');
        const approval = {
          kind: 'plan_approval',
          runId: execution?.runId ?? null,
          request,
          proof: proof as unknown as Json,
          ...(bodyRecordKey ? { bodyRecordKey } : {}),
        };
        if (
          bodyRecordKey &&
          canonical(
            (await sealedRequest(
              context,
              current,
              (await context.records.get(string(current.key)))!,
              approval,
            )) as Json,
          ) !== canonical(request)
        )
          throw new Error('planning_review_body_invalid');
        if (execution?.runId)
          await write(
            context,
            `run/${execution.runId}/approval/${encodeURIComponent(string(current.planId))}/${current.version}`,
            approval,
            true,
          );
        // Context contribution only; dispatch authority reads the immutable Run-specific proof.
        await write(
          context,
          `approval.current/${encodeURIComponent(string(current.planId))}/${current.version}`,
          approval,
        );
        const legacyKey = `approval/${encodeURIComponent(string(current.planId))}/${current.version}`;
        if (!(await context.records.get(legacyKey)))
          await write(context, legacyKey, approval, true);
        return result({ status: 'approved', mode: proof.answer.mode!, ...review });
      },
    },
    'planning.update': {
      input: schema(
        {
          runId: text,
          planId: text,
          version: { type: 'integer', minimum: 1 },
          digest: text,
          expectedProgressRevision: { type: ['string', 'null'] },
          stepId: text,
          status: { enum: ['pending', 'running', 'completed', 'failed', 'blocked', 'compensated'] },
          executionId: text,
          completePlan: { type: 'boolean' },
        },
        ['runId', 'planId', 'version', 'digest', 'expectedProgressRevision', 'stepId', 'status'],
      ),
      async execute(input, context) {
        const value = object(input),
          runId = string(value.runId),
          own = await context.getExecution(context.executionId);
        if (!own || (own.runId !== null && own.runId !== runId) || !(await context.getRun(runId)))
          throw new Error('planning_run_mismatch');
        const current = decode(await context.records.get('plan.current'));
        if (!current || ['planId', 'version', 'digest'].some((k) => value[k] !== current[k]))
          throw new Error('plan_identity_mismatch');
        const plan = decode(await context.records.get(string(current.key)))!;
        if (
          !Array.isArray(plan.steps) ||
          !plan.steps.some((step) => object(step).id === value.stepId)
        )
          throw new Error('plan_step_missing');
        const key = `progress/${encodeURIComponent(string(current.planId))}/${current.version}`;
        const old = await context.records.get(key),
          previous = decode(old);
        if ((old?.revision ?? null) !== value.expectedProgressRevision)
          throw new Error('plan_progress_conflict');
        const steps = { ...(previous ? object(previous.steps) : {}) },
          stepId = string(value.stepId);
        const prior = steps[stepId] ? object(steps[stepId]) : null;
        if (
          prior?.status === 'completed' &&
          !['completed', 'compensated'].includes(String(value.status))
        )
          throw new Error('plan_terminal_rollback');
        if (
          value.status === 'compensated' &&
          (prior?.status !== 'completed' ||
            !prior.receipt ||
            object(prior.receipt).executionId === value.executionId)
        )
          throw new Error('plan_compensation_evidence_required');
        let receipt: Json = prior?.receipt ?? null;
        if (['completed', 'compensated'].includes(String(value.status))) {
          const actual = await context.getExecution(string(value.executionId));
          if (
            actual?.status !== 'succeeded' ||
            actual.sessionId !== context.sessionId ||
            actual.originStoreId !== own.originStoreId ||
            !actual.inputDigest ||
            !actual.definitionId ||
            !actual.definitionVersion ||
            !actual.attempt ||
            actual.kind === 'model' ||
            management.has(actual.definitionId) ||
            !(await matchesPlanSource(context, actual))
          )
            throw new Error('plan_execution_evidence_required');
          receipt = {
            executionId: actual.id,
            attempt: actual.attempt,
            definitionId: actual.definitionId,
            definitionVersion: actual.definitionVersion,
            inputDigest: actual.inputDigest,
            resultRevision: actual.resultRevision,
          };
          if (
            (await receiptStatus(
              context,
              actual,
              receipt as unknown as Target,
              runId,
              own.originStoreId,
              context.sessionId,
            )) !== 'passed'
          )
            throw new Error('plan_execution_scope_mismatch');
        }
        steps[stepId] = {
          ...prior,
          status: value.status!,
          receipt,
          ...(value.status === 'compensated'
            ? { originalReceipt: prior?.originalReceipt ?? prior?.receipt ?? null }
            : {}),
        };
        const progress = {
          kind: 'plan_progress',
          runId,
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
          steps,
          completePlan: value.completePlan === true,
        };
        if (value.completePlan === true) {
          if (
            !plan.steps.length ||
            !plan.steps.every(
              (step) =>
                steps[string(object(step).id)] &&
                object(steps[string(object(step).id)]).status === 'completed',
            )
          )
            throw new Error('plan_steps_incomplete');
          const refs: Ref[] = [];
          for (const kind of ['plan', 'validation'] as const) {
            const requirementId = `${kind}.required`,
              recordKey = `run/${runId}/${requirementId}`,
              record = await context.records.get(recordKey);
            if (!record && kind === 'validation') continue;
            if (!record?.originStoreId) throw new Error('plan_requirement_missing');
            refs.push({
              extensionId: planningExtensionId,
              definitionVersion: '1',
              requirementId,
              recordKey,
              revision: record.revision,
              originStoreId: record.originStoreId,
              runId,
              sessionId: context.sessionId,
              phase: kind === 'plan' ? 'both' : 'completion',
            });
          }
          // Candidate check only. Core independently re-reads and commits all actual obligations.
          const checks = await conditions.evaluate(refs, 'dispatch', {
            boundary: {
              sessionId: context.sessionId,
              runId,
              executionId: own.id,
              attempt: own.attempt ?? null,
              kind: 'job',
              definitionId: 'planning.complete-candidate',
              definitionVersion: '1',
            },
            async forRequirement() {
              return context;
            },
          });
          if (checks.some((check) => !['satisfied', 'waived'].includes(check.outcome)))
            throw new Error('plan_completion_evidence_required');
        }
        await write(context, `${key}/attempt/${context.executionId}`, progress, true);
        const saved = await writeAt(context, key, progress, old);
        return result({ ...progress, revision: saved.revision });
      },
    },
    'validation.define': {
      input: schema({
        runId: text,
        checks: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            oneOf: [
              schema({ kind: { const: 'receipt' }, target: targetSchema }),
              schema({
                kind: { const: 'file_hash' },
                path: { type: 'string', minLength: 1, maxLength: 4096 },
                sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              }),
              schema({
                kind: { const: 'artifact_schema' },
                target: targetSchema,
                artifactRef: { type: 'object' },
                schema: { type: 'object' },
              }),
              schema({ kind: { enum: ['command', 'mcp'] }, description: text }),
              schema({
                kind: { const: 'command' },
                input: { type: 'object' },
                expectedExitCode: { type: 'integer' },
              }),
              schema({
                kind: { const: 'mcp' },
                checkerId: text,
                input: { type: 'object' },
                target: targetSchema,
                schema: { type: 'object' },
              }),
            ],
          },
        },
      }),
      async execute(input, context) {
        const value = object(input),
          runId = string(value.runId),
          own = await context.getExecution(context.executionId);
        if (!own || own.runId !== runId)
          return { outcome: 'failed', content: 'validation_run_mismatch' };
        const key = `run/${runId}/validation.spec`;
        const old = await context.records.get(key);
        if (old) return { outcome: 'failed', content: 'validation_spec_immutable' };
        const requirement = decode(await context.records.get(`run/${runId}/validation.required`));
        const requiredDefinitions = (requirement?.requiredReceiptDefinitions ??
          options.requiredReceiptDefinitions) as unknown as {
          definitionId: string;
          definitionVersion: string;
        }[];
        const checks = value.checks as Json[];
        if (
          !requiredDefinitions.every((required) =>
            checks.some((check) => {
              const item = object(check);
              const target = ['receipt', 'artifact_schema'].includes(String(item.kind))
                ? object(item.target)
                : null;
              return (
                target?.definitionId === required.definitionId &&
                target.definitionVersion === required.definitionVersion
              );
            }),
          )
        )
          throw new Error('validation_host_checks_missing');
        const planRequirement = await context.records.get(`run/${runId}/plan.required`);
        const currentPlan = planRequirement
          ? decode(await context.records.get('plan.current'))
          : null;
        if (planRequirement && !currentPlan) throw new Error('validation_plan_missing');
        const record = await write(
          context,
          key,
          {
            kind: 'validation_spec',
            runId,
            checks: value.checks!,
            plan: currentPlan,
            fileHashChecker: options.fileHashChecker ? { ...options.fileHashChecker } : null,
            commandChecker: options.commandChecker ? { ...options.commandChecker } : null,
            mcpCheckers: options.mcpCheckers.map((checker) => ({ ...checker })),
          },
          true,
        );
        return result({ key, revision: record.revision });
      },
    },
    'validation.rebind': {
      input: schema({
        runId: text,
        expectedRevision: { type: ['string', 'null'] },
        bindings: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: schema(
            {
              index: { type: 'integer', minimum: 0 },
              target: targetSchema,
              artifactRef: { type: 'object' },
            },
            ['index', 'target'],
          ),
        },
      }),
      async execute(input, context) {
        const value = object(input),
          runId = string(value.runId),
          own = await context.getExecution(context.executionId);
        if (own?.runId !== runId) return { outcome: 'failed', content: 'validation_run_mismatch' };
        const spec = decode(await context.records.get(`run/${runId}/validation.spec`));
        const pointer = await context.records.get(`run/${runId}/validation.binding.current`);
        if (
          !spec ||
          !Array.isArray(spec.checks) ||
          (pointer?.revision ?? null) !== value.expectedRevision
        )
          return { outcome: 'failed', content: 'validation_binding_changed' };
        const previous = decode(pointer),
          prior = previous ? decode(await context.records.get(string(previous.key))) : null;
        const bindings = { ...(prior ? object(prior.bindings) : {}) };
        for (const raw of value.bindings as Json[]) {
          const binding = object(raw),
            index = Number(binding.index);
          if (!spec.checks[index])
            return { outcome: 'failed', content: 'validation_binding_index' };
          const check = object(spec.checks[index]),
            target = object(binding.target) as unknown as Target;
          if (!['receipt', 'artifact_schema', 'mcp'].includes(String(check.kind)))
            return { outcome: 'failed', content: 'validation_binding_kind' };
          const original = object(check.target);
          if (
            target.definitionId !== original.definitionId ||
            target.definitionVersion !== original.definitionVersion
          )
            return { outcome: 'failed', content: 'validation_binding_definition_changed' };
          const actual = await context.getExecution(target.executionId);
          if (
            (await receiptStatus(
              context,
              actual,
              target,
              runId,
              own.originStoreId,
              context.sessionId,
            )) !== 'passed'
          )
            return { outcome: 'failed', content: 'validation_binding_receipt_invalid' };
          if (spec.plan !== null && actual && !(await matchesPlanSource(context, actual)))
            return { outcome: 'failed', content: 'validation_binding_source_changed' };
          bindings[String(index)] = { ...binding };
        }
        const key = `run/${runId}/validation.binding/${context.executionId}`;
        await write(
          context,
          key,
          { kind: 'validation_binding', runId, bindings, previous: previous?.key ?? null },
          true,
        );
        await context.records.write({
          key: `run/${runId}/validation.binding.current`,
          expectedRevision: value.expectedRevision as string | null,
          contentType,
          contentVersion: 1,
          executable: true,
          value: {
            ...(pointer ? object(pointer.value) : {}),
            kind: 'validation_binding_current',
            key,
          },
        });
        return result({ key });
      },
    },
    'validation.check': {
      input: schema({ runId: text }),
      async execute(input, context) {
        const runId = string(object(input).runId),
          own = await context.getExecution(context.executionId);
        if (!own || own.runId !== runId)
          return { outcome: 'failed', content: 'validation_run_mismatch' };
        const spec = await context.records.get(`run/${runId}/validation.spec`),
          value = decode(spec);
        if (!value || !Array.isArray(value.checks)) return result({ outcome: 'missing' });
        // Capture both heads before asynchronous checks. A late callback never covers a newer binding/attempt.
        const head = await context.records.get(`run/${runId}/validation.current`);
        const bindingPointer = await context.records.get(`run/${runId}/validation.binding.current`);
        const bindingValue = decode(bindingPointer),
          bindingRecord = bindingValue
            ? decode(await context.records.get(string(bindingValue.key)))
            : null;
        const bindings = bindingRecord ? object(bindingRecord.bindings) : {};
        const checks: Json[] = [];
        for (let index = 0; index < value.checks.length; index++) {
          const check = object(value.checks[index]),
            binding = bindings[String(index)] ? object(bindings[String(index)]) : check;
          if (['command', 'mcp'].includes(String(check.kind)) && check.input !== undefined) {
            const definition = semanticDefinition(value, check);
            if (!definition) {
              checks.push({
                kind: check.kind!,
                outcome: 'inconclusive',
                reason: 'validation_checker_unavailable',
              });
              continue;
            }
            if (check.kind === 'mcp') {
              const source = object(binding.target) as unknown as Target;
              const original = await context.getExecution(source.executionId);
              if (
                !('sourceDefinitionId' in definition) ||
                source.definitionId !== definition.sourceDefinitionId ||
                source.definitionVersion !== definition.sourceDefinitionVersion ||
                (await receiptStatus(
                  context,
                  original,
                  source,
                  runId,
                  own.originStoreId,
                  context.sessionId,
                )) !== 'passed' ||
                (value.plan !== null &&
                  (!original || !(await matchesPlanSource(context, original))))
              ) {
                checks.push({
                  kind: check.kind,
                  outcome: 'inconclusive',
                  reason: 'validation_source_mismatch',
                });
                continue;
              }
            }
            let operation: OperationRef;
            try {
              operation = await context.operations.ensure({
                key: `verification/${context.executionId}/${index}`,
                request: {
                  kind: definition.kind,
                  definitionId: definition.definitionId,
                  definitionVersion: definition.definitionVersion,
                  input: check.input,
                },
                cancellation: 'attached',
              });
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'operation_definition_unavailable')
                throw error;
              checks.push({
                kind: check.kind!,
                outcome: 'inconclusive',
                reason: 'validation_checker_unavailable',
              });
              continue;
            }
            const actual = await context.operations.wait(operation);
            const target: Target = {
              executionId: actual.id,
              attempt: actual.attempt!,
              definitionId: actual.definitionId!,
              definitionVersion: actual.definitionVersion!,
              inputDigest: actual.inputDigest!,
              resultRevision: actual.resultRevision,
            };
            checks.push({
              kind: check.kind!,
              target: target as unknown as Json,
              operationRef: operation as unknown as Json,
              outcome: await semanticProof(
                context,
                value,
                check.kind === 'mcp' ? { ...check, target: binding.target! } : check,
                actual,
                target,
                operation,
                index,
                context.executionId,
                runId,
                own.originStoreId,
                context.sessionId,
              ),
            });
            continue;
          }
          if (check.kind === 'file_hash') {
            const checker = value.fileHashChecker ? object(value.fileHashChecker) : null;
            if (!checker) {
              checks.push({
                outcome: 'inconclusive',
                reason: 'validation_checker_unavailable',
                kind: check.kind,
              });
              continue;
            }
            let operation: OperationRef;
            try {
              operation = await context.operations.ensure({
                key: `verification/${context.executionId}/${index}`,
                request: {
                  kind: 'tool',
                  definitionId: string(checker.definitionId),
                  definitionVersion: string(checker.definitionVersion),
                  input: { path: check.path!, offset: 1, limit: 1 },
                },
              });
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'operation_definition_unavailable')
                throw error;
              checks.push({
                outcome: 'inconclusive',
                reason: 'validation_checker_unavailable',
                kind: check.kind,
              });
              continue;
            }
            const actual = await context.operations.wait(operation);
            if (actual.status !== 'succeeded') {
              checks.push({
                outcome: actual.status === 'outcome_unknown' ? 'unknown' : 'inconclusive',
                kind: check.kind,
                checkerExecutionId: actual.id,
              });
              continue;
            }
            try {
              const snapshot = object(JSON.parse(string(object(actual.result).content)) as Json),
                baseline = object(snapshot.baseline),
                observed = string(baseline.hash);
              if (!/^[a-f0-9]{64}$/.test(observed)) throw new Error('validation_baseline_invalid');
              checks.push({
                kind: check.kind,
                outcome: observed === check.sha256 ? 'passed' : 'failed',
                observedHash: observed,
                checkerExecutionId: actual.id,
              });
            } catch {
              checks.push({
                kind: check.kind,
                outcome: 'inconclusive',
                reason: 'validation_baseline_invalid',
              });
            }
            continue;
          }
          if (!['receipt', 'artifact_schema'].includes(String(check.kind))) {
            checks.push({
              outcome: 'inconclusive',
              reason: 'validation_capability_unavailable',
              kind: check.kind!,
            });
            continue;
          }
          const target = object(binding.target) as unknown as Target,
            actual = await context.getExecution(target.executionId);
          const status =
            value.plan !== null && actual && !(await matchesPlanSource(context, actual))
              ? 'scope_mismatch'
              : await receiptStatus(
                  context,
                  actual,
                  target,
                  runId,
                  own.originStoreId,
                  context.sessionId,
                );
          if (check.kind === 'artifact_schema' && status === 'passed') {
            const ref = binding.artifactRef ?? check.artifactRef!;
            const refs =
              actual?.result && typeof actual.result === 'object' && !Array.isArray(actual.result)
                ? actual.result.artifactRefs
                : null;
            if (
              !context.artifacts ||
              !Array.isArray(refs) ||
              !refs.some((item) => canonical(item) === canonical(ref))
            ) {
              checks.push({
                outcome: 'inconclusive',
                reason: 'validation_artifact_reference_unavailable',
                target: binding.target!,
                kind: check.kind,
              });
              continue;
            }
            try {
              const checked = await checkArtifactSchema(
                context.artifacts,
                ref as unknown as ArtifactRef,
                check.schema!,
              );
              checks.push({
                ...checked,
                target: binding.target!,
                artifactRef: ref,
                kind: check.kind,
              });
            } catch {
              checks.push({
                outcome: 'inconclusive',
                reason: 'validation_artifact_unavailable',
                target: binding.target!,
                kind: check.kind,
              });
            }
          } else
            checks.push({
              outcome: status,
              target: binding.target!,
              result: actual?.result ?? null,
              kind: check.kind!,
            });
        }
        const outcome = checks.every((c) => object(c).outcome === 'passed')
          ? 'passed'
          : 'unsatisfied';
        const evidence = {
          kind: 'validation_attempt',
          specRevision: spec!.revision,
          bindingRevision: bindingPointer?.revision ?? null,
          checkerExecutionId: context.executionId,
          runId,
          checks,
          outcome,
        };
        const key = `run/${runId}/validation.attempt/${context.executionId}`;
        await write(context, key, evidence, true);
        if (
          (await context.records.get(`run/${runId}/validation.binding.current`))?.revision !==
          bindingPointer?.revision
        )
          return { outcome: 'failed', content: 'validation_binding_changed' };
        await context.records.write({
          key: `run/${runId}/validation.current`,
          expectedRevision: head?.revision ?? null,
          contentType,
          contentVersion: 1,
          executable: true,
          value: { ...(head ? object(head.value) : {}), kind: 'validation_current', key },
        });
        return result(evidence);
      },
    },
  };
  for (const [id, fn] of Object.entries(functions))
    tools.push({
      id,
      version: '1',
      description: `Explicit ${id} business operation`,
      inputSchema: fn.input,
      execute: guarded(fn.execute),
    });
  const actions: ActionDefinition[] = ['planning.write', 'planning.review', 'planning.update'].map(
    (id) => ({
      id,
      version: '1',
      description: `User ${id}`,
      inputSchema: functions[id]!.input,
      async prepare(input) {
        return input;
      },
      execute: guarded(functions[id]!.execute),
    }),
  );
  actions.push({
    id: 'validation.waive',
    version: '1',
    description: 'Request an exact user waiver; never grants Tool permissions',
    inputSchema: schema({ recordKey: text, reason: text }),
    async prepare(input) {
      return input;
    },
    async execute(input, context) {
      if (!options.allowWaiver) throw new Error('validation_waiver_not_allowed');
      const value = object(input),
        recordKey = string(value.recordKey),
        record = await context.records.get(recordKey),
        obligation = decode(record);
      if (!record || !obligation || obligation.kind !== 'validation')
        throw new Error('validation_requirement_missing');
      const waiverHead = await context.records.get(`${recordKey}/waiver.current`);
      if (waiverHead) decode(waiverHead);
      const spec = await context.records.get(`run/${obligation.runId}/validation.spec`);
      const bindingPointer = await context.records.get(
        `run/${obligation.runId}/validation.binding.current`,
      );
      const specValue = decode(spec),
        plan = decode(await context.records.get('plan.current'));
      if (await unknownVerification(context, string(obligation.runId), specValue))
        throw new Error('validation_waiver_unknown_effect');
      const request = {
        kind: 'validation_waiver',
        specRevision: spec?.revision ?? null,
        bindingRevision: bindingPointer?.revision ?? null,
        spec: specValue,
        plan,
        recordKey,
        revision: record.revision,
        originStoreId: record.originStoreId,
        runId: obligation.runId!,
        requirementId: obligation.requirementId!,
        reason: string(value.reason),
      };
      const proof = await accepted(context, 'question', {
        schema: schema({ waive: { const: true } }),
        ...request,
      });
      if (proof.answer.kind !== 'question' || object(proof.answer.answers).waive !== true)
        return result({ outcome: 'unsatisfied' });
      if (
        (await context.records.get(`run/${obligation.runId}/validation.spec`))?.revision !==
          spec?.revision ||
        (await context.records.get(`run/${obligation.runId}/validation.binding.current`))
          ?.revision !== bindingPointer?.revision ||
        canonical(decode(await context.records.get('plan.current'))) !== canonical(plan)
      )
        throw new Error('validation_waiver_target_changed');
      const waiverKey = `${recordKey}/waiver.attempt/${context.executionId}`;
      await write(
        context,
        waiverKey,
        {
          kind: 'waiver',
          request: proof.request,
          proof: proof as unknown as Json,
          savedAt: Date.now(),
          actor: 'user',
        },
        true,
      );
      await writeAt(
        context,
        `${recordKey}/waiver.current`,
        { kind: 'waiver_current', key: waiverKey },
        waiverHead,
      );
      return result({ outcome: 'waived' });
    },
  });
  const waiverAction = actions[actions.length - 1]!;
  waiverAction.execute = guarded(waiverAction.execute);
  tools.push({
    id: 'validation.request_waiver',
    version: '1',
    description: 'Ask the user for an exact waiver; the Tool cannot approve it',
    inputSchema: waiverAction.inputSchema,
    execute: waiverAction.execute,
  });
  management.add('validation.request_waiver');
  const conditions: NecessaryConditions = {
    async evaluate(refs, phase, context) {
      return Promise.all(
        refs.map(
          async (ref): Promise<Awaited<ReturnType<NecessaryConditions['evaluate']>>[number]> => {
            if (automatic && ref.requirementId === 'mutation.required')
              return automatic.evaluate(ref, phase, context);
            let outcome: 'satisfied' | 'waived' | 'unsatisfied' = 'unsatisfied';
            let reason = 'business_evidence_missing';
            if (!context)
              return {
                requirement: ref,
                recordRevision: ref.revision,
                outcome,
                evidence: { reason: 'condition_context_unavailable' },
              };
            const read = await context.forRequirement(ref),
              record = await read.records.get(ref.recordKey),
              obligation = decode(record);
            if (
              !obligation ||
              ref.extensionId !== planningExtensionId ||
              ref.definitionVersion !== '1' ||
              obligation.requirementId !== ref.requirementId ||
              record?.revision !== ref.revision ||
              record.originStoreId !== ref.originStoreId ||
              obligation.runId !== ref.runId
            )
              return {
                requirement: ref,
                recordRevision: record?.revision ?? ref.revision,
                outcome,
                evidence: { reason: 'requirement_identity_mismatch' },
              };
            // A sealed same-Session continuation inherits the completed original
            // plan; it is not the original Run's preapproval planning conversation.
            const inheritedPlanContinuation =
              obligation.kind === 'plan' &&
              context.boundary.sessionId === ref.sessionId &&
              context.boundary.runId !== null &&
              context.boundary.runId !== ref.runId;
            if (
              phase === 'completion' &&
              ref.executionId === undefined &&
              !(context.boundary.runId === ref.runId && context.boundary.executionId === null) &&
              !inheritedPlanContinuation
            )
              return {
                requirement: ref,
                recordRevision: record!.revision,
                outcome: 'satisfied',
                evidence: { reason: 'nonapplicable_run_boundary' },
              };
            if (obligation.kind === 'plan') {
              const state = await readPlanningState(read, {
                runId: ref.runId,
                originStoreId: ref.originStoreId,
              });
              if (state.status === 'approved') outcome = 'satisfied';
              if (phase === 'completion' && outcome === 'satisfied') {
                const pointer = decode(await read.records.get('plan.current'))!;
                const plan = decode(await read.records.get(string(pointer.key)))!;
                const progress = decode(
                  await read.records.get(
                    `progress/${encodeURIComponent(string(pointer.planId))}/${pointer.version}`,
                  ),
                );
                if (
                  !progress ||
                  progress.runId !== ref.runId ||
                  progress.digest !== pointer.digest ||
                  progress.completePlan !== true ||
                  !Array.isArray(plan.steps) ||
                  !plan.steps.length
                )
                  outcome = 'unsatisfied';
                else
                  for (const step of plan.steps) {
                    const state = object(progress.steps)[string(object(step).id)];
                    if (
                      !state ||
                      object(state).status !== 'completed' ||
                      !object(state).receipt ||
                      (await receiptStatus(
                        read,
                        await read.getExecution(string(object(object(state).receipt).executionId)),
                        object(object(state).receipt) as unknown as Target,
                        ref.runId,
                        ref.originStoreId,
                        ref.sessionId,
                      )) !== 'passed'
                    )
                      outcome = 'unsatisfied';
                    else if (
                      !(await matchesPlanSource(
                        read,
                        (await read.getExecution(
                          string(object(object(state).receipt).executionId),
                        ))!,
                      ))
                    )
                      outcome = 'unsatisfied';
                  }
              }
              const boundary = context.boundary;
              if (
                phase === 'dispatch' &&
                boundary.kind === 'tool' &&
                Array.isArray(obligation.readOnlyDefinitions) &&
                obligation.readOnlyDefinitions.some((item) => {
                  const definition = object(item);
                  return (
                    definition.kind === boundary.kind &&
                    definition.definitionId === boundary.definitionId &&
                    definition.definitionVersion === boundary.definitionVersion
                  );
                })
              ) {
                outcome = 'satisfied';
                reason = 'planning_host_read_only_boundary';
              }
              if (
                phase === 'dispatch' &&
                boundary &&
                !inheritedPlanContinuation &&
                (boundary.kind === 'model' ||
                  (boundary.kind === 'tool' &&
                    boundary.definitionVersion === '1' &&
                    management.has(boundary.definitionId ?? '')))
              ) {
                outcome = 'satisfied';
                reason = 'planning_management_boundary';
              }
            } else if (obligation.kind === 'validation') {
              const spec = await read.records.get(`run/${ref.runId}/validation.spec`),
                specValue = decode(spec);
              const planRequirement = await read.records.get(`run/${ref.runId}/plan.required`);
              const pointer = decode(await read.records.get(`run/${ref.runId}/validation.current`));
              const attempt = pointer ? decode(await read.records.get(string(pointer.key))) : null;
              const bindingPointer = await read.records.get(
                `run/${ref.runId}/validation.binding.current`,
              );
              const bindingValue = decode(bindingPointer),
                binding = bindingValue
                  ? decode(await read.records.get(string(bindingValue.key)))
                  : null;
              const bindings = binding ? object(binding.bindings) : {};
              if (
                spec &&
                specValue &&
                (
                  obligation.requiredReceiptDefinitions as unknown as {
                    definitionId: string;
                    definitionVersion: string;
                  }[]
                ).every(
                  (required) =>
                    Array.isArray(specValue.checks) &&
                    specValue.checks.some((check) => {
                      const item = object(check);
                      const target = ['receipt', 'artifact_schema'].includes(String(item.kind))
                        ? object(item.target)
                        : null;
                      return (
                        target?.definitionId === required.definitionId &&
                        target.definitionVersion === required.definitionVersion
                      );
                    }),
                ) &&
                ((!planRequirement && specValue.plan === null) ||
                  (specValue.plan !== null &&
                    canonical(specValue.plan!) ===
                      canonical(decode(await read.records.get('plan.current'))))) &&
                attempt?.specRevision === spec.revision &&
                attempt.runId === ref.runId &&
                Array.isArray(specValue.checks) &&
                Array.isArray(attempt.checks) &&
                specValue.checks.length > 0 &&
                specValue.checks.length === attempt.checks.length
              ) {
                let passed = true;
                if (attempt.checkerExecutionId) {
                  const checker = await read.getExecution(string(attempt.checkerExecutionId));
                  if (
                    !checker ||
                    checker.runId !== ref.runId ||
                    checker.sessionId !== ref.sessionId ||
                    checker.originStoreId !== ref.originStoreId ||
                    checker.status !== 'succeeded' ||
                    checker.definitionId !== 'validation.check' ||
                    checker.definitionVersion !== '1' ||
                    canonical(object(checker.result).details ?? null) !== canonical(attempt)
                  )
                    passed = false;
                  if (attempt.bindingRevision !== (bindingPointer?.revision ?? null))
                    passed = false;
                }
                for (let i = 0; i < specValue.checks.length; i++) {
                  const check = object(specValue.checks[i]),
                    evidence = object(attempt.checks[i]);
                  const targetBinding = bindings[String(i)] ? object(bindings[String(i)]) : check;
                  if (evidence.outcome !== 'passed') {
                    passed = false;
                    continue;
                  }
                  if (['command', 'mcp'].includes(String(check.kind))) {
                    if (!evidence.target || !evidence.operationRef || !attempt.checkerExecutionId) {
                      passed = false;
                      continue;
                    }
                    const target = object(evidence.target) as unknown as Target;
                    if (
                      (await semanticProof(
                        read,
                        specValue,
                        check.kind === 'mcp' ? { ...check, target: targetBinding.target! } : check,
                        await read.getExecution(target.executionId),
                        target,
                        evidence.operationRef as unknown as OperationRef,
                        i,
                        string(attempt.checkerExecutionId),
                        ref.runId,
                        ref.originStoreId,
                        ref.sessionId,
                      )) !== 'passed'
                    )
                      passed = false;
                    continue;
                  }
                  if (check.kind === 'file_hash') {
                    const checker = evidence.checkerExecutionId
                      ? await read.getExecution(string(evidence.checkerExecutionId))
                      : null;
                    const definition = specValue.fileHashChecker
                      ? object(specValue.fileHashChecker)
                      : null;
                    if (
                      !checker ||
                      !definition ||
                      checker.status !== 'succeeded' ||
                      checker.parentExecutionId !== attempt.checkerExecutionId ||
                      checker.originStoreId !== ref.originStoreId ||
                      checker.sessionId !== ref.sessionId ||
                      checker.definitionId !== definition.definitionId ||
                      checker.definitionVersion !== definition.definitionVersion ||
                      checker.inputDigest !==
                        (await digest({ path: check.path!, offset: 1, limit: 1 })) ||
                      evidence.observedHash !== check.sha256
                    )
                      passed = false;
                    if (checker) {
                      try {
                        const snapshot = object(
                          JSON.parse(string(object(checker.result).content)) as Json,
                        );
                        if (object(snapshot.baseline).hash !== evidence.observedHash)
                          passed = false;
                      } catch {
                        passed = false;
                      }
                    }
                    continue;
                  }
                  if (
                    !['receipt', 'artifact_schema'].includes(String(check.kind)) ||
                    canonical(targetBinding.target!) !== canonical(evidence.target!) ||
                    (await receiptStatus(
                      read,
                      await read.getExecution(string(object(targetBinding.target).executionId)),
                      object(targetBinding.target) as unknown as Target,
                      ref.runId,
                      ref.originStoreId,
                      ref.sessionId,
                    )) !== 'passed'
                  ) {
                    passed = false;
                    continue;
                  }
                  const actual = await read.getExecution(
                    string(object(targetBinding.target).executionId),
                  );
                  if (
                    specValue.plan !== null &&
                    (!actual || !(await matchesPlanSource(read, actual)))
                  )
                    passed = false;
                  if (check.kind === 'artifact_schema') {
                    const refs = actual ? object(actual.result).artifactRefs : null;
                    if (
                      !attempt.checkerExecutionId ||
                      !Array.isArray(refs) ||
                      !refs.some((item) => canonical(item) === canonical(evidence.artifactRef!)) ||
                      canonical(evidence.artifactRef!) !==
                        canonical(targetBinding.artifactRef ?? check.artifactRef!)
                    )
                      passed = false;
                  }
                }
                if (passed) outcome = 'satisfied';
              }
              if (outcome !== 'satisfied' && options.allowWaiver) {
                const waiverHead = decode(
                  await read.records.get(`${ref.recordKey}/waiver.current`),
                );
                const waiver = waiverHead
                  ? decode(await read.records.get(string(waiverHead.key)))
                  : null;
                if (waiver) {
                  const request = object(waiver.request),
                    proof = object(waiver.proof),
                    answer = object(proof.answer);
                  const unknownEffect = await unknownVerification(read, ref.runId, specValue);
                  if (
                    !unknownEffect &&
                    request.specRevision === (spec?.revision ?? null) &&
                    request.bindingRevision === (bindingPointer?.revision ?? null) &&
                    canonical(request.spec!) === canonical(specValue) &&
                    canonical(request.plan!) ===
                      canonical(decode(await read.records.get('plan.current'))) &&
                    request.recordKey === ref.recordKey &&
                    request.revision === ref.revision &&
                    request.runId === ref.runId &&
                    request.originStoreId === ref.originStoreId &&
                    request.requirementId === ref.requirementId &&
                    typeof request.reason === 'string' &&
                    request.reason.trim() &&
                    answer.kind === 'question' &&
                    object(answer.answers).waive === true &&
                    (await proofValid(read, waiver, request, ref))
                  )
                    outcome = 'waived';
                }
              }
            }
            return {
              requirement: ref,
              recordRevision: record!.revision,
              outcome,
              evidence: { kind: obligation.kind!, reason, outcome },
            };
          },
        ),
      );
    },
  };
  if (automatic) tools.push(automatic.tool);
  const extension: Extension = {
    ...(automatic
      ? {
          mutationGovernance: automatic.governance,
          completionGovernance: automatic.completion,
          conditions,
        }
      : {}),
    id: planningExtensionId,
    version: '1',
    apiMajor: 1,
    tools,
    actions,
    records: [
      ...(automatic
        ? [
            {
              contentType: 'agent.mutation-policy',
              contentVersion: 1,
              schema: {
                type: 'object',
                required: [
                  'kind',
                  'runId',
                  'requirementId',
                  'definitions',
                  'checkDefinitionId',
                  'checkDefinitionVersion',
                ],
                properties: { kind: { const: 'mutation_policy' } },
                additionalProperties: true,
              } as JsonSchema,
            },
          ]
        : []),
      {
        contentType,
        contentVersion: 1,
        schema: {
          oneOf: [
            ['plan', 'validation'].map((kind) => ({
              ...schema({ kind: { const: kind }, runId: text, requirementId: text }),
              additionalProperties: true,
            })),
            {
              ...schema({
                kind: { const: 'plan_document' },
                planId: text,
                version: { type: 'integer', minimum: 1 },
                title: text,
                body: text,
                steps: { type: 'array' },
                digest: text,
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'plan_current' },
                key: text,
                planId: text,
                version: { type: 'integer', minimum: 1 },
                digest: text,
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'plan_progress' },
                runId: text,
                planId: text,
                version: { type: 'integer' },
                digest: text,
                steps: { type: 'object' },
                completePlan: { type: 'boolean' },
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'plan_approval' },
                request: { type: 'object' },
                proof: { type: 'object' },
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'plan_review_body' },
                contentVersion: { const: 1 },
                bodyRecordRevision: text,
                planId: text,
                version: { type: 'integer', minimum: 1 },
                digest: text,
                planRecordKey: text,
                planRecordRevision: text,
                originStoreId: text,
                sessionId: text,
                runId: { type: ['string', 'null'] },
                executionId: text,
                reference: { type: 'object' },
                hash: text,
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'validation_spec' },
                runId: text,
                checks: { type: 'array', minItems: 1, maxItems: 64 },
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'validation_attempt' },
                runId: text,
                specRevision: text,
                checks: { type: 'array' },
                outcome: { enum: ['passed', 'unsatisfied'] },
              }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'validation_binding' },
                runId: text,
                bindings: { type: 'object' },
              }),
              additionalProperties: true,
            },
            {
              ...schema({ kind: { const: 'validation_binding_current' }, key: text }),
              additionalProperties: true,
            },
            {
              ...schema({ kind: { const: 'validation_current' }, key: text }),
              additionalProperties: true,
            },
            {
              ...schema({ kind: { const: 'waiver_current' }, key: text }),
              additionalProperties: true,
            },
            {
              ...schema({
                kind: { const: 'waiver' },
                request: { type: 'object' },
                proof: { type: 'object' },
                savedAt: { type: 'number' },
                actor: { const: 'user' },
              }),
              additionalProperties: true,
            },
          ].flat(),
        },
      },
    ],
    queries: [
      {
        id: 'planning.status',
        version: '1',
        description: 'Read current plan and exact business records',
        inputSchema: empty,
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(_input, context) {
          const pointer = await context.records.get('plan.current');
          return [
            {
              extensionId: planningExtensionId,
              contentType,
              contentVersion: 1,
              summary: pointer ? 'Current plan' : 'No plan',
              payload: pointer?.value ?? null,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  const query = extension.queries![0]!;
  const extendedExtension: Extension = {
    ...extension,
    queries: [
      ...extension.queries!,
      {
        ...query,
        id: 'validation.status',
        description: 'Read exact Run verification and waiver facts',
        inputSchema: schema({ runId: text }),
        async execute(input, context) {
          const runId = string(object(input).runId);
          if (!(await context.getRun(runId))) throw new Error('validation_run_unavailable');
          const prefix = `run/${runId}`;
          const obligation = await context.records.get(`${prefix}/validation.required`);
          const spec = await context.records.get(`${prefix}/validation.spec`);
          const pointer = await context.records.get(`${prefix}/validation.current`);
          const pointerValue =
            pointer?.contentType === contentType && pointer.contentVersion === 1
              ? object(pointer.value)
              : null;
          const resolvedKey = typeof pointerValue?.key === 'string' ? pointerValue.key : null;
          const attempt = resolvedKey ? await context.records.get(resolvedKey) : null;
          const bindingPointer = await context.records.get(`${prefix}/validation.binding.current`);
          const bindingValue =
            bindingPointer?.contentType === contentType && bindingPointer.contentVersion === 1
              ? object(bindingPointer.value)
              : null;
          const bindingKey = typeof bindingValue?.key === 'string' ? bindingValue.key : null;
          const binding = bindingKey ? await context.records.get(bindingKey) : null;
          const waiverHead = await context.records.get(
            `${prefix}/validation.required/waiver.current`,
          );
          const waiverHeadValue =
            waiverHead?.contentType === contentType && waiverHead.contentVersion === 1
              ? object(waiverHead.value)
              : null;
          const waiverKey = typeof waiverHeadValue?.key === 'string' ? waiverHeadValue.key : null;
          const waiver = waiverKey ? await context.records.get(waiverKey) : null;
          return [
            {
              extensionId: planningExtensionId,
              contentType,
              contentVersion: 1,
              summary: waiver
                ? 'User waiver recorded'
                : attempt
                  ? 'Verification attempt recorded'
                  : 'Verification evidence unavailable',
              payload: {
                runId,
                resolution:
                  (pointer && !resolvedKey) ||
                  (bindingPointer && !bindingKey) ||
                  (waiverHead && !waiverKey)
                    ? 'unavailable'
                    : 'available',
                current: pointer?.value ?? null,
                bindingCurrent: bindingPointer?.value ?? null,
                binding: binding?.value ?? null,
                obligation: obligation?.value ?? null,
                spec: spec?.value ?? null,
                attempt: attempt?.value ?? null,
                waiverCurrent: waiverHead?.value ?? null,
                waiver: waiver?.value ?? null,
              },
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  async function readPlanningState(
    read: ConditionReadContext,
    identity: { runId: string; originStoreId: string },
  ): Promise<PlanningState> {
    const run = await read.getRun(identity.runId);
    if (!run || run.sessionId !== read.sessionId) throw new Error('planning_run_mismatch');
    const record = await read.records.get(`run/${identity.runId}/plan.required`);
    if (!record) return { status: 'disabled' };
    const obligation = decode(record)!;
    if (
      record.originStoreId !== identity.originStoreId ||
      obligation.kind !== 'plan' ||
      obligation.runId !== identity.runId ||
      obligation.requirementId !== 'plan.required'
    )
      throw new Error('planning_run_mismatch');
    const current = decode(await read.records.get('plan.current'));
    if (!current) return { status: 'pending' };
    const planRecord = await read.records.get(string(current.key));
    const plan = decode(planRecord);
    const approval = decode(
      await read.records.get(
        `run/${identity.runId}/approval/${encodeURIComponent(string(current.planId))}/${current.version}`,
      ),
    );
    if (!plan || !approval || approval.runId !== identity.runId) return { status: 'pending' };
    const request = await sealedRequest(read, current, planRecord!, approval);
    if (!request) return { status: 'pending' };
    const ref: Ref = {
      extensionId: planningExtensionId,
      definitionVersion: '1',
      requirementId: 'plan.required',
      recordKey: record.key,
      revision: record.revision,
      sessionId: read.sessionId,
      runId: identity.runId,
      originStoreId: identity.originStoreId,
      phase: 'both',
    };
    const answer = object(object(approval.proof).answer);
    if (
      plan.digest !== current.digest ||
      (await digest({
        planId: plan.planId!,
        version: plan.version!,
        title: plan.title!,
        body: plan.body!,
        steps: plan.steps!,
      })) !== current.digest ||
      !(await proofValid(read, approval, request, ref)) ||
      answer.kind !== 'plan_review' ||
      answer.decision !== 'approve' ||
      !modes.includes(String(answer.mode))
    )
      return { status: 'pending' };
    return {
      status: 'approved',
      mode: answer.mode as 'auto' | 'accept_edits',
      planId: string(current.planId),
      version: Number(current.version),
      digest: string(current.digest),
    };
  }
  async function initializeRequirements(
    input: PlanningInitialization,
    policy: PlanningRunPolicy = {},
  ): Promise<Ref[]> {
    if (policy.requirePlan !== undefined && typeof policy.requirePlan !== 'boolean')
      throw new Error('planning_host_read_only_invalid');
    const readOnlyDefinitions = (policy.readOnlyDefinitions ?? []).map((definition) => {
      if (
        definition.kind !== 'tool' ||
        Object.keys(definition).some(
          (key) => !['kind', 'definitionId', 'definitionVersion'].includes(key),
        )
      )
        throw new Error('planning_host_read_only_invalid');
      return {
        kind: 'tool',
        definitionId: string(definition.definitionId),
        definitionVersion: string(definition.definitionVersion),
      };
    });
    if (
      new Set(readOnlyDefinitions.map((definition) => canonical(definition))).size !==
      readOnlyDefinitions.length
    )
      throw new Error('planning_host_read_only_invalid');
    const context = await input.forExtension(planningExtensionId),
      refs: Ref[] = [];
    if (automatic) refs.push(await automatic.initialize(input));
    for (const kind of ['plan', 'validation'] as const) {
      if (
        !(kind === 'plan'
          ? options.requirePlan || policy.requirePlan === true
          : options.requiredValidation)
      )
        continue;
      const requirementId = `${kind}.required`,
        key = `run/${input.run.id}/${requirementId}`;
      const record = await context.records.create({
        key,
        contentType,
        contentVersion: 1,
        value: {
          kind,
          runId: input.run.id,
          requirementId,
          requiredReceiptDefinitions: options.requiredReceiptDefinitions as unknown as Json,
          ...(kind === 'plan' ? { readOnlyDefinitions } : {}),
        },
      });
      refs.push({
        extensionId: planningExtensionId,
        definitionVersion: '1',
        requirementId,
        recordKey: key,
        revision: record.revision,
        sessionId: input.run.sessionId,
        runId: input.run.id,
        phase: kind === 'plan' ? 'both' : 'completion',
      });
    }
    return refs;
  }
  async function capturePlan(
    sessionId: string,
    context: Pick<ReadContext, 'getRun' | 'getExecution' | 'getInteraction'> & {
      records: Pick<ReadContext['records'], 'get'>;
    },
  ): Promise<ContextSource[]> {
    const pointer = decode(await context.records.get('plan.current'));
    if (!pointer) return [];
    const planRecord = await context.records.get(string(pointer.key));
    const plan = decode(planRecord);
    if (!plan) throw new Error('plan_missing');
    const candidate = decode(
      await context.records.get(
        `approval.current/${encodeURIComponent(string(pointer.planId))}/${pointer.version}`,
      ),
    );
    let approval: Record<string, Json> | null = null;
    if (candidate && typeof candidate.runId === 'string') {
      const run = await context.getRun(candidate.runId);
      if (run?.isActive && run.sessionId === sessionId) {
        const immutable = decode(
          await context.records.get(
            `run/${run.id}/approval/${encodeURIComponent(string(pointer.planId))}/${pointer.version}`,
          ),
        );
        if (immutable && canonical(immutable) === canonical(candidate)) {
          const proof = object(immutable.proof);
          const execution = await context.getExecution(string(proof.executionId));
          const request = await sealedRequest(context, pointer, planRecord!, immutable);
          if (
            request &&
            execution?.originStoreId &&
            (await proofValid({ ...context, sessionId }, immutable, request, {
              extensionId: planningExtensionId,
              definitionVersion: '1',
              requirementId: 'plan.required',
              recordKey: `run/${run.id}/plan.required`,
              revision: '1',
              runId: run.id,
              sessionId,
              originStoreId: execution.originStoreId,
              phase: 'both',
            }))
          )
            approval = immutable;
        }
      }
    }
    return planSource(sessionId, pointer, plan, approval);
  }
  async function planSource(
    sessionId: string,
    pointer: Record<string, Json>,
    plan: Record<string, Json>,
    approval: Record<string, Json> | null,
  ): Promise<ContextSource[]> {
    const proof = approval ? object(approval.proof) : null;
    const content = {
      kind: 'current_plan',
      current: pointer,
      plan,
      approval: proof
        ? {
            interactionId: proof.interactionId!,
            decisionRevision: proof.decisionRevision!,
            answer: proof.answer!,
          }
        : null,
    };
    const hash = await digest(content);
    return [
      {
        id: `${planningExtensionId}:${sessionId}:${pointer.planId}:${pointer.version}`,
        kind: 'planning',
        role: 'user',
        scope: sessionId,
        digest: hash,
        content: canonical(content),
      },
    ];
  }
  async function matchesPlanSource(
    context: Pick<ReadContext, 'sessionId' | 'getRun' | 'getExecution' | 'getInteraction'> & {
      records: Pick<ReadContext['records'], 'get'>;
    },
    actual: PublicExecution,
  ) {
    // Receipt verification uses the original execution's immutable approval,
    // rather than today's informational contribution (inactive Runs show null).
    if (actual.sessionId !== context.sessionId || !actual.originStoreId) return false;
    let bound = actual;
    const seen = new Set<string>();
    for (let depth = 0; bound.runId === null && depth < 32; depth++) {
      if (!bound.parentExecutionId || seen.has(bound.id)) return false;
      seen.add(bound.id);
      const parent = await context.getExecution(bound.parentExecutionId);
      if (
        !parent ||
        parent.sessionId !== actual.sessionId ||
        parent.originStoreId !== actual.originStoreId ||
        parent.rootWorkCommandId !== actual.rootWorkCommandId ||
        parent.rootWorkSeq !== actual.rootWorkSeq
      )
        return false;
      bound = parent;
    }
    if (!bound.runId) return false;
    const run = await context.getRun(bound.runId);
    if (!run || run.sessionId !== actual.sessionId) return false;
    const read = { ...context, sessionId: context.sessionId };
    const state = await readPlanningState(read, {
      runId: run.id,
      originStoreId: actual.originStoreId,
    });
    if (state.status !== 'approved') return false;
    const pointer = decode(await context.records.get('plan.current'));
    if (
      !pointer ||
      pointer.planId !== state.planId ||
      pointer.version !== state.version ||
      pointer.digest !== state.digest
    )
      return false;
    const plan = decode(await context.records.get(string(pointer.key)));
    const approval = decode(
      await context.records.get(
        `run/${run.id}/approval/${encodeURIComponent(state.planId)}/${state.version}`,
      ),
    );
    if (!plan || !approval) return false;
    const expected = await planSource(context.sessionId, pointer, plan, approval);
    return !!actual.sources?.some(
      (source) => source.id === expected[0]!.id && source.digest === expected[0]!.digest,
    );
  }
  function sourcesFor(
    readRecords: (
      sessionId: string,
    ) => Promise<Pick<ReadContext, 'records' | 'getRun' | 'getExecution' | 'getInteraction'>>,
  ): ContextSources {
    return {
      async capture(request) {
        return capturePlan(request.sessionId, await readRecords(request.sessionId));
      },
    };
  }
  return {
    extension: {
      ...extendedExtension,
      context: {
        async capture(request, context) {
          return capturePlan(request.sessionId, context);
        },
        async captureBatch(requests, context) {
          for (const request of requests)
            if (request.sessionId !== context.sessionId)
              throw new AgentError('invalid_extension_scope');
          if (!requests.length) return [];
          return capturePlan(context.sessionId, context);
        },
      },
    } satisfies Extension,
    conditions,
    initializeRequirements,
    readPlanningState,
    sourcesFor,
  };
}
