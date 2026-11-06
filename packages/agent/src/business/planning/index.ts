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
  PublicExecution,
  ReadContext,
  RunInitializationContext,
  ToolDefinition,
  ToolResult,
} from '../../extensions';
import { AgentError } from '../../storage/types';
import type { PlanFile, PlanFiles } from './files';

export { createPlanFiles } from './files';

export const planningExtensionId = 'builtin.planning';
const contentType = 'builtin.planning.record';
const text: JsonSchema = { type: 'string', minLength: 1 };
const schema = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required });
const empty = schema({});
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
  /** Trusted host opt-in: a premature completion returns one keyed planning diagnostic. */
  completionGuidance?: boolean;
  requirePlan?: boolean;
  allowedExecutionModes?: readonly string[];
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
  'plan_file_changed',
  'plan_file_missing',
  'plan_file_invalid',
  'plan_file_recovery_required',
  'file_baseline_conflict',
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

/** Business records and predicates only. Permissions and execution authority remain in the host. */
export function createPlanningValidation(
  inputOptions: PlanningOptions = {},
  planFiles?: PlanFiles,
  readExecutionInput?: (executionId: string) => Promise<Json>,
  isReadOnlyShell?: (input: Json) => Promise<boolean>,
  isReadOnlyGitWorktree?: (execution: Readonly<PublicExecution>, input: Json) => Promise<boolean>,
) {
  if (
    Object.keys(inputOptions).some(
      (key) => !['completionGuidance', 'requirePlan', 'allowedExecutionModes'].includes(key),
    )
  )
    throw new AgentError('planning_options_unavailable');
  async function isShellSearch(
    read: ConditionReadContext,
    boundary: import('../../extensions').NecessaryConditionContext['boundary'],
  ) {
    if (
      !isReadOnlyShell ||
      !readExecutionInput ||
      !boundary.executionId ||
      boundary.definitionVersion !== '1' ||
      !(
        (boundary.kind === 'tool' &&
          ['shell.execute', 'shell.launch'].includes(boundary.definitionId ?? '')) ||
        (boundary.kind === 'job' && boundary.definitionId === 'shell.command')
      )
    )
      return false;
    const actual = await read.getExecution(boundary.executionId);
    if (
      !actual ||
      actual.sessionId !== read.sessionId ||
      actual.sessionId !== boundary.sessionId ||
      actual.runId !== boundary.runId ||
      actual.attempt !== boundary.attempt ||
      actual.kind !== boundary.kind ||
      actual.definitionId !== boundary.definitionId ||
      actual.definitionVersion !== boundary.definitionVersion
    )
      return false;
    const input = await readExecutionInput(actual.id);
    return (await digest(input)) === actual.inputDigest && (await isReadOnlyShell(input));
  }
  async function isGitWorktreeList(
    read: ConditionReadContext,
    boundary: import('../../extensions').NecessaryConditionContext['boundary'],
  ) {
    if (
      !isReadOnlyGitWorktree ||
      !readExecutionInput ||
      !boundary.executionId ||
      boundary.definitionVersion !== '1' ||
      !(
        (boundary.kind === 'tool' && boundary.definitionId === 'git.worktree') ||
        (boundary.kind === 'job' && boundary.definitionId === 'shell.command')
      )
    )
      return false;
    const actual = await read.getExecution(boundary.executionId);
    if (
      !actual ||
      actual.id !== boundary.executionId ||
      actual.sessionId !== read.sessionId ||
      actual.sessionId !== boundary.sessionId ||
      actual.runId !== boundary.runId ||
      actual.attempt !== boundary.attempt ||
      actual.kind !== boundary.kind ||
      actual.definitionId !== boundary.definitionId ||
      actual.definitionVersion !== boundary.definitionVersion
    )
      return false;
    const input = await readExecutionInput(actual.id);
    if ((await digest(input)) !== actual.inputDigest) return false;
    // These observations carry no dispatch authority. The trusted Host must still
    // identify this exact mixed Tool action or canonical readonly worker launch.
    const frozenInput = structuredClone(input);
    const freeze = (value: Json): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(frozenInput);
    return (
      (await isReadOnlyGitWorktree(Object.freeze(structuredClone(actual)), frozenInput)) === true
    );
  }
  async function isFileEdit(
    read: ConditionReadContext,
    boundary: import('../../extensions').NecessaryConditionContext['boundary'],
  ) {
    if (
      !planFiles ||
      !readExecutionInput ||
      boundary.kind !== 'tool' ||
      !boundary.executionId ||
      boundary.sessionId !== read.sessionId ||
      !['files.write', 'files.edit'].includes(boundary.definitionId ?? '') ||
      !(
        boundary.definitionVersion === '2' ||
        (boundary.definitionId === 'files.write' && boundary.definitionVersion === '3')
      )
    )
      return false;
    const actual = await read.getExecution(boundary.executionId);
    if (
      !actual ||
      actual.runId !== boundary.runId ||
      actual.definitionId !== boundary.definitionId ||
      actual.definitionVersion !== boundary.definitionVersion
    )
      return false;
    const input = await readExecutionInput(boundary.executionId);
    if ((await digest(input)) !== actual.inputDigest) return false;
    const current = decode(await read.records.get('plan.current'));
    const plan = current ? decode(await read.records.get(string(current.key))) : null;
    if (
      !plan?.file ||
      decode(await read.records.get('plan.file.publication'))?.state === 'pending' ||
      object(input).path !== planFiles.path(plan.file as unknown as PlanFile)
    )
      return false;
    return true;
  }
  const options = Object.freeze({
    ...inputOptions,
    allowedExecutionModes: Object.freeze([
      ...(inputOptions.allowedExecutionModes ?? ['auto', 'accept_edits']),
    ]),
  });
  const modes = [...options.allowedExecutionModes];
  if (!modes.length || modes.some((mode) => !['auto', 'accept_edits'].includes(mode)))
    throw new Error('planning_execution_mode_invalid');
  const management = new Set([
    'planning.read',
    'planning.write',
    'planning.review',
    'planning.update',
  ]);
  const planInput = schema(
    {
      planId: text,
      expectedVersion: { type: ['integer', 'null'], minimum: 1 },
      title: text,
      body: text,
      steps: { type: 'array', minItems: 1, items: schema({ id: text, title: text }) },
      fileBase: {
        anyOf: [
          { type: 'null' },
          schema({
            hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            size: { type: 'integer', minimum: 0 },
            device: text,
            inode: text,
          }),
        ],
        description:
          'Only for deliberate reconciliation of an externally changed plan: pass the fresh complete file baseline. Null is create-only recovery of a missing file. Approval remains separate.',
      },
    },
    ['planId', 'expectedVersion', 'title', 'body', 'steps'],
  );
  async function latestPlanDocument(context: ActionContext, planId: string, upperVersion: number) {
    let afterKey: string | undefined;
    let latest: Record<string, Json> | null = null;
    for (;;) {
      const page = await context.records.list({
        contentType,
        limit: 200,
        ...(afterKey ? { afterKey } : {}),
      });
      for (const record of page) {
        if (!record.key.startsWith(`plan/${encodeURIComponent(planId)}/`)) continue;
        const plan = decode(record)!;
        if (
          record.extensionId !== planningExtensionId ||
          record.sessionId !== context.sessionId ||
          !record.originStoreId ||
          plan.kind !== 'plan_document' ||
          plan.planId !== planId ||
          !Number.isSafeInteger(plan.version) ||
          Number(plan.version) < 1 ||
          record.key !== `plan/${encodeURIComponent(planId)}/${plan.version}`
        )
          throw new Error('planning_invalid_record');
        if (
          Number(plan.version) <= upperVersion &&
          (!latest || Number(plan.version) > Number(latest.version))
        )
          latest = plan;
      }
      if (page.length < 200) break;
      afterKey = page.at(-1)!.key;
    }
    if (
      latest &&
      latest.digest !==
        (await digest({
          planId: latest.planId!,
          version: latest.version!,
          title: latest.title!,
          body: latest.body!,
          steps: latest.steps!,
        }))
    )
      throw new Error('planning_invalid_record');
    return latest;
  }
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
        const own = await context.getExecution(context.executionId);
        const progress = pointer
          ? await context.records.get(
              `progress/${encodeURIComponent(string(pointer.planId))}/${pointer.version}`,
            )
          : null;
        return result({
          current: current?.value ?? null,
          plan: plan?.value ?? null,
          ...(planFiles && plan && object(plan.value).file
            ? { filePath: planFiles.path(object(plan.value).file as unknown as PlanFile) }
            : {}),
          runId: own?.runId ?? null,
          progress: progress ? { revision: progress.revision, value: progress.value } : null,
        });
      },
    },
    'planning.write': {
      input: planInput,
      async execute(input, context) {
        const value = object(input),
          original = await context.records.get('plan.current'),
          current = decode(original);
        if (planFiles && current && current.version === Number(value.expectedVersion ?? 0) + 1) {
          const pending = decode(await context.records.get('plan.file.publication'));
          const saved = decode(await context.records.get(string(current.key)));
          if (
            pending?.state === 'pending' &&
            pending.key === current.key &&
            pending.digest === current.digest &&
            saved?.file &&
            ['planId', 'title', 'body', 'steps'].every(
              (name) => canonical(saved[name]!) === canonical(value[name]!),
            )
          ) {
            await planFiles.verify(saved.file as unknown as PlanFile, string(saved.body));
            await write(context, 'plan.file.publication', { ...pending, state: 'committed' });
            return result({
              planId: current.planId!,
              version: current.version!,
              digest: current.digest!,
              filePath: planFiles.path(saved.file as unknown as PlanFile),
            });
          }
        }
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
        let file: PlanFile | undefined;
        if (planFiles) {
          const own = await context.getExecution(context.executionId);
          if (!own?.originStoreId || own.sessionId !== context.sessionId)
            throw new Error('planning_run_mismatch');
          const priorPlan = current ? decode(await context.records.get(string(current.key))) : null;
          const previousPlan =
            priorPlan?.planId === plan.planId
              ? priorPlan
              : await latestPlanDocument(context, plan.planId, Number(current?.version ?? 0));
          const pendingRecord = await context.records.get('plan.file.publication');
          const pending = decode(pendingRecord);
          const recovering = pending?.state === 'pending';
          const publication = {
            storeId: own.originStoreId,
            sessionId: context.sessionId,
            planId: plan.planId,
            body: plan.body,
            previous: previousPlan?.file ? (previousPlan.file as unknown as PlanFile) : null,
            ...(value.fileBase !== undefined
              ? {
                  fileBase: value.fileBase as unknown as
                    | import('../../tools/files').FileBaseline
                    | null,
                }
              : {}),
          };
          if (recovering && (pending.digest !== hash || pending.key !== key))
            throw new Error('plan_file_recovery_required');
          const described = planFiles.describe(publication);
          if (!recovering) {
            if (priorPlan?.file && value.fileBase === undefined)
              await planFiles.verify(priorPlan.file as unknown as PlanFile, string(priorPlan.body));
            if (previousPlan?.file && previousPlan !== priorPlan && value.fileBase === undefined)
              await planFiles.verify(
                previousPlan.file as unknown as PlanFile,
                string(previousPlan.body),
              );
            await writeAt(
              context,
              'plan.file.publication',
              {
                kind: 'plan_file_publication',
                state: 'pending',
                key,
                digest: hash,
                file: described as unknown as Json,
              },
              pendingRecord,
            );
          }
          file = await planFiles.publish({
            ...publication,
            recover: recovering,
          });
        }
        try {
          await write(
            context,
            key,
            {
              kind: 'plan_document',
              ...plan,
              digest: hash,
              ...(file ? { file: file as unknown as Json } : {}),
            },
            true,
          );
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
          if (file)
            await write(context, 'plan.file.publication', {
              kind: 'plan_file_publication',
              state: 'committed',
              key,
              digest: hash,
              file: file as unknown as Json,
            });
          return result({
            planId: plan.planId,
            version,
            digest: hash,
            ...(file ? { filePath: planFiles!.path(file) } : {}),
          });
        } catch (error) {
          if (!file) throw error;
          const code =
            error instanceof Error && knownPreflight.has(error.message)
              ? error.message
              : 'planning_operation_failed';
          return {
            outcome: 'outcome_unknown',
            content: `plan_file_publish_unknown: Plan file publication completed, but updating its remaining Planning records did not finish. The file may already contain the requested change. Inspect the original execution and current plan before any further mutation. Do not resubmit this operation. Failure code: ${code}.`,
            details: { code: 'plan_file_publish_unknown', failureCode: code },
          };
        }
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
        if (planFiles) {
          if (
            !plan.file ||
            decode(await context.records.get('plan.file.publication'))?.state === 'pending'
          )
            throw new Error('plan_file_recovery_required');
          await planFiles.verify(plan.file as unknown as PlanFile, string(plan.body));
        }
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
        if (planFiles) {
          if (decode(await context.records.get('plan.file.publication'))?.state === 'pending')
            throw new Error('plan_file_recovery_required');
          await planFiles.verify(plan.file as unknown as PlanFile, string(plan.body));
        }
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
          for (const kind of ['plan'] as const) {
            const requirementId = `${kind}.required`,
              recordKey = `run/${runId}/${requirementId}`,
              record = await context.records.get(recordKey);
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
              phase: 'both',
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
          if (checks.some((check) => check.outcome !== 'satisfied'))
            throw new Error('plan_completion_evidence_required');
        }
        await write(context, `${key}/attempt/${context.executionId}`, progress, true);
        const saved = await writeAt(context, key, progress, old);
        return result({ ...progress, revision: saved.revision });
      },
    },
  };
  const modelTools: Readonly<Record<string, { name: string; description: string }>> = {
    'planning.read': {
      name: 'read_plan',
      description: 'Read the current plan, version and progress before changing or reviewing it.',
    },
    'planning.write': {
      name: 'write_plan',
      description:
        'Save a new plan version with its goal and steps; saving does not approve execution.',
    },
    'planning.review': {
      name: 'request_plan_review',
      description: 'Present the exact current plan to the user for approval or revision.',
    },
    'planning.update': {
      name: 'update_plan_progress',
      description:
        'Update progress for the current plan using actual execution receipts; cannot approve a plan.',
    },
  };
  for (const [id, fn] of Object.entries(functions))
    tools.push({
      id,
      version: '1',
      model: { name: modelTools[id]!.name, snakeCase: true },
      description: modelTools[id]!.description,
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

  const conditions: NecessaryConditions = {
    async evaluate(refs, phase, context) {
      return Promise.all(
        refs.map(
          async (ref): Promise<Awaited<ReturnType<NecessaryConditions['evaluate']>>[number]> => {
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
                !inheritedPlanContinuation &&
                (await isShellSearch(read, boundary))
              ) {
                outcome = 'satisfied';
                reason = 'planning_read_only_shell_search';
              }
              if (
                phase === 'dispatch' &&
                !inheritedPlanContinuation &&
                (await isGitWorktreeList(read, boundary))
              ) {
                outcome = 'satisfied';
                reason = 'planning_read_only_git_worktree';
              }
              if (
                phase === 'dispatch' &&
                !inheritedPlanContinuation &&
                (await isFileEdit(read, boundary))
              ) {
                outcome = 'satisfied';
                reason = 'planning_exact_file_boundary';
              }
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
                  (boundary.kind === 'job' &&
                    boundary.definitionId === `${planningExtensionId}/planning.write` &&
                    boundary.definitionVersion === '1') ||
                  (boundary.kind === 'tool' &&
                    boundary.definitionVersion === '1' &&
                    management.has(boundary.definitionId ?? '')))
              ) {
                outcome = 'satisfied';
                reason = 'planning_management_boundary';
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
  const extension: Extension = {
    ...(options.completionGuidance
      ? {
          completionGovernance: {
            async prepare(input) {
              const ref = input.requirements.find(
                (value) =>
                  value.extensionId === planningExtensionId &&
                  value.definitionVersion === '1' &&
                  value.requirementId === 'plan.required' &&
                  value.runId === input.runId,
              );
              if (
                ref &&
                typeof ref.originStoreId === 'string' &&
                input.evaluations.some(
                  (evaluation) =>
                    evaluation.requirement.recordKey === ref.recordKey &&
                    evaluation.requirement.originStoreId === ref.originStoreId &&
                    evaluation.outcome === 'unsatisfied',
                )
              ) {
                const read = await input.context.forRequirement(ref);
                const state = await readPlanningState(read, {
                  runId: ref.runId,
                  originStoreId: ref.originStoreId,
                });
                if (state.status === 'pending') {
                  const current = await read.records.get('plan.current');
                  return {
                    kind: 'continue',
                    key: `plan-review:${ref.recordKey}:${current?.revision ?? 'missing'}`,
                    content: canonical({
                      code: 'plan_draft_pending',
                      planning: 'planning_draft',
                      current: current?.value ?? null,
                      instruction:
                        'The required plan is not approved. Save a complete plan and request planning.review for its exact version and digest. Text claiming completion cannot approve a plan or dispatch work.',
                    }),
                  };
                }
              }
              return null;
            },
          } satisfies import('../../extensions').CompletionGovernance,
        }
      : {}),
    id: planningExtensionId,
    version: '1',
    apiMajor: 1,
    tools,
    actions,
    records: [
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
                kind: { const: 'plan_file_publication' },
                state: { enum: ['pending', 'committed'] },
                key: text,
                digest: text,
                file: { type: 'object' },
              }),
            },
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
      ...(planFiles
        ? [
            {
              id: 'planning.file',
              version: '1',
              description: 'Read the exact current editable plan file binding',
              inputSchema: empty,
              outputSchema: { type: 'array', items: { type: 'object' } } as JsonSchema,
              async execute(_input: Json, context: ReadContext) {
                const pointer = decode(await context.records.get('plan.current'));
                const plan = pointer
                  ? decode(await context.records.get(string(pointer.key)))
                  : null;
                if (!plan?.file) return [];
                if (decode(await context.records.get('plan.file.publication'))?.state === 'pending')
                  throw new AgentError('plan_file_recovery_required');
                return [
                  {
                    extensionId: planningExtensionId,
                    contentType,
                    contentVersion: 1,
                    summary: 'Current plan file',
                    payload: {
                      planId: plan.planId!,
                      title: plan.title!,
                      steps: plan.steps!,
                      version: plan.version!,
                      digest: plan.digest!,
                      file: plan.file,
                      path: planFiles.path(plan.file as unknown as PlanFile),
                    },
                    artifactRefs: [],
                    actions: [],
                  },
                ];
              },
            },
          ]
        : []),
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
      {
        id: 'planning.progress.view',
        version: '1',
        description: 'Read exact approved current plan and Run-specific progress for display',
        inputSchema: schema({ runId: text }),
        outputSchema: { type: 'array', items: { type: 'object' } },
        async execute(input, context) {
          const runId = string(object(input).runId),
            run = await context.getRun(runId);
          if (
            !run ||
            run.sessionId !== context.sessionId ||
            typeof run.originStoreId !== 'string' ||
            !run.originStoreId
          )
            throw new Error('planning_run_mismatch');
          const state = await readPlanningState(context, {
            runId,
            originStoreId: run.originStoreId,
          });
          let current: Json = null,
            plan: Json = null,
            progress: Json = null;
          if (state.status === 'approved') {
            const pointer = decode(await context.records.get('plan.current'));
            if (
              !pointer ||
              ['planId', 'version', 'digest'].some(
                (key) => pointer[key] !== state[key as 'planId' | 'version' | 'digest'],
              )
            )
              throw new Error('plan_identity_mismatch');
            const document = decode(await context.records.get(string(pointer.key)));
            if (
              !document ||
              ['planId', 'version', 'digest'].some((key) => document[key] !== pointer[key])
            )
              throw new Error('plan_identity_mismatch');
            const actual = decode(
              await context.records.get(
                `progress/${encodeURIComponent(state.planId)}/${state.version}`,
              ),
            );
            if (actual && actual.runId === runId) {
              if (
                actual.kind !== 'plan_progress' ||
                ['planId', 'version', 'digest'].some((key) => actual[key] !== pointer[key])
              )
                throw new Error('plan_identity_mismatch');
              progress = actual;
            }
            if (canonical(decode(await context.records.get('plan.current'))) !== canonical(pointer))
              throw new Error('plan_identity_mismatch');
            current = pointer;
            plan = document;
          }
          return [
            {
              extensionId: planningExtensionId,
              contentType,
              contentVersion: 1,
              summary:
                state.status === 'approved'
                  ? 'Approved current plan progress'
                  : 'Approved plan unavailable',
              payload: {
                runId,
                originStoreId: run.originStoreId,
                approvalStatus: state.status,
                current,
                plan,
                progress,
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
    if (planFiles) {
      if (
        !plan?.file ||
        decode(await read.records.get('plan.file.publication'))?.state === 'pending'
      )
        return { status: 'pending' };
      try {
        await planFiles.verify(plan.file as unknown as PlanFile, string(plan.body));
      } catch {
        return { status: 'pending' };
      }
    }
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
    for (const kind of ['plan'] as const) {
      if (!(options.requirePlan || policy.requirePlan === true)) continue;
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
    return planSource(sessionId, pointer, plan, approval, context);
  }
  async function planSource(
    sessionId: string,
    pointer: Record<string, Json>,
    plan: Record<string, Json>,
    approval: Record<string, Json> | null,
    context: { records: Pick<ReadContext['records'], 'get'> },
  ): Promise<ContextSource[]> {
    let fileState: string | undefined;
    if (planFiles) {
      fileState = 'unavailable';
      if (decode(await context.records.get('plan.file.publication'))?.state === 'pending')
        fileState = 'publication_pending';
      else if (plan.file) {
        try {
          await planFiles.verify(plan.file as unknown as PlanFile, string(plan.body));
          fileState = 'matches_record';
        } catch {
          fileState = 'changed_or_unavailable';
        }
      }
    }
    const proof =
      approval && (!planFiles || fileState === 'matches_record') ? object(approval.proof) : null;
    const content = {
      kind: 'current_plan',
      current: pointer,
      plan,
      ...(fileState ? { fileState } : {}),
      ...(planFiles && plan.file
        ? { filePath: planFiles.path(plan.file as unknown as PlanFile) }
        : {}),
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
        placement: 'after_history',
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
    const expected = await planSource(context.sessionId, pointer, plan, approval, context);
    return !!actual.sources?.some(
      (source) => source.id === expected[0]!.id && source.digest === expected[0]!.digest,
    );
  }
  async function captureModelContext(
    request: import('../../context').SourceRequest,
    context: ReadContext,
  ): Promise<ContextSource[]> {
    const result = await capturePlan(request.sessionId, context);
    if (!request.runId) return result;
    const run = await context.getRun(request.runId);
    if (!run || run.sessionId !== request.sessionId || !run.originStoreId)
      throw new Error('planning_run_mismatch');
    const state = await readPlanningState(context, {
      runId: run.id,
      originStoreId: run.originStoreId,
    });
    const content = [
      `run: ${run.id}`,
      `plan_requirement: ${canonical(state as unknown as Json)}`,
      'Planning is a plan mode, not an Agent execution phase. This observes the actual Run-specific plan approval requirement; approval does not grant tool permissions.',
      'This is Runtime-generated observation, not a user request or execution grant.',
    ].join('\n');
    return [
      ...result,
      {
        id: `${planningExtensionId}:runtime:${run.id}`,
        kind: 'runtime_state',
        role: 'user',
        placement: 'runtime',
        scope: request.sessionId,
        digest: await digest(content),
        content,
      },
    ];
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
      ...extension,
      context: {
        async capture(request, context) {
          return captureModelContext(request, context);
        },
        async captureBatch(requests, context) {
          for (const request of requests)
            if (request.sessionId !== context.sessionId)
              throw new AgentError('invalid_extension_scope');
          if (!requests.length) return [];
          const model = requests.find(
            (request) =>
              request.input &&
              typeof request.input === 'object' &&
              !Array.isArray(request.input) &&
              request.input.kind === 'model_request',
          );
          return captureModelContext(model ?? requests[0]!, context);
        },
      },
    } satisfies Extension,
    conditions,
    initializeRequirements,
    readPlanningState,
    sourcesFor,
  };
}
