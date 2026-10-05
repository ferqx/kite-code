import { createHash } from 'node:crypto';
import type { ContextSource } from '../../context';
import type {
  AcceptedInformation,
  ArtifactRef,
  Extension,
  ExtensionRecord,
  Json,
  OperationRef,
  PublicExecution,
  ReadContext,
  ToolContext,
  ToolResult,
} from '../../extensions';
import { canonicalJson } from '../../json';
import type { RunRequirementInitializer } from '../../runtime';
import {
  type CompiledSkillWorkflow,
  readWorkflowReference,
  revalidateSkillWorkflow,
  type WorkflowCapability,
} from '../../skills/workflow-contract';
import { validateWorkflowArguments } from '../../skills/workflow-contract/schema';
import { AgentError, type RequirementEvaluation, type RequirementRef } from '../../storage/types';

export const skillWorkflowExtensionId = 'builtin.skill-workflow';
const anchorType = 'application/vnd.kite.skill-activation+json';
const stateType = 'application/vnd.kite.skill-workflow-state+json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const objectSchema = { type: 'object' };
const attemptSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
function attemptNumber(value: unknown = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new AgentError('workflow_attempt_invalid');
  return Number(value);
}
const keySchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' };
const schema = (properties: Record<string, Json>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const lifecycle = new Set([
  'activate_skill',
  'read_skill_reference',
  'complete_skill',
  'verify_skill',
  'repair_skill',
  'decide_skill_verification',
]);
export interface WorkflowActivationInput {
  readonly key: string;
  readonly skillId: string;
  readonly input: Json;
}
export interface WorkflowCapabilityBinding {
  readonly capabilityId: string;
  readonly kind: 'tool' | 'job';
  readonly definitionId: string;
  readonly definitionVersion: string;
}
export interface SkillWorkflowOptions {
  /** Trusted host policy only; neither Skill text nor model arguments can enable a waiver. */
  readonly userDecisions?: {
    readonly version: '1';
    readonly allowWaiver: boolean;
    readonly allowReplan: boolean;
    readonly allowCompensation?: boolean;
  };
  readonly flags: {
    readonly skillActivation: boolean;
    readonly skillWorkflow: boolean;
    readonly verification: boolean;
  };
  readonly entries: readonly CompiledSkillWorkflow[];
  /** Full original Command intent, reconstructed by the trusted host for a cold Run binding. */
  readonly initialActivations?: readonly WorkflowActivationInput[];
  readonly resolveCapability?: (id: string) => WorkflowCapability | undefined;
  readonly capabilities: readonly WorkflowCapabilityBinding[];
  /** Trusted already-registered child roles. Input text does not configure or grant child permissions. */
  readonly forkConfigurations?: readonly {
    agent: string;
    configurationId: string;
    definitionVersion: string;
  }[];
  /** Trusted ordinary supervised Job. The callback describes input; it never executes the script. */
  readonly verificationJob?: {
    definitionId: string;
    definitionVersion: string;
    prepare(input: {
      entry: CompiledSkillWorkflow;
      activationId: string;
      attempt: number;
      outputDigest: string;
      output: Json;
    }): Json;
  };
  readonly compensationJob?: {
    definitionId: string;
    definitionVersion: string;
    supports(entry: CompiledSkillWorkflow): boolean;
    prepare(input: {
      entry: CompiledSkillWorkflow;
      activationId: string;
      attempt: number;
      outputDigest: string;
      output: Json;
      decisionKey: string;
      decisionDigest: string;
    }): Json;
  };
}
function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('workflow_record_invalid');
  return value as Record<string, Json>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AgentError('workflow_input_invalid');
  return value;
}
function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
function result(value: Json, outcome: ToolResult['outcome'] = 'succeeded'): ToolResult {
  return { outcome, content: canonicalJson(value), details: value };
}
function frameKey(runId: string, key: string): string {
  return `run/${runId}/workflow.${hash(key)}`;
}
function decode(record: ExtensionRecord | null, type: string): Record<string, Json> | null {
  if (!record) return null;
  if (record.contentType !== type || record.contentVersion !== 1)
    throw new AgentError('workflow_record_invalid');
  return object(record.value);
}
/** Explicit business registration; construction does not scan files, open a Store, or execute a Skill. */
export function createSkillWorkflow(supplied: SkillWorkflowOptions) {
  const flags = Object.freeze({ ...supplied.flags });
  const userDecisions = supplied.userDecisions
    ? Object.freeze({ ...supplied.userDecisions })
    : null;
  if (
    userDecisions &&
    (userDecisions.version !== '1' ||
      typeof userDecisions.allowWaiver !== 'boolean' ||
      typeof userDecisions.allowReplan !== 'boolean' ||
      (userDecisions.allowCompensation !== undefined &&
        typeof userDecisions.allowCompensation !== 'boolean'))
  )
    throw new AgentError('workflow_user_decisions_invalid');
  const entries = new Map(
    supplied.entries.map((entry) => [entry.descriptor.capabilityId, structuredClone(entry)]),
  );
  if (entries.size !== supplied.entries.length) throw new AgentError('workflow_duplicate_skill');
  const capabilities = structuredClone(supplied.capabilities);
  const initialActivations =
    supplied.initialActivations === undefined
      ? undefined
      : structuredClone(supplied.initialActivations);
  const originalInputs = new Map<string, Json>();
  const forks = new Map(
    (supplied.forkConfigurations ?? []).map((role) => [role.agent, Object.freeze({ ...role })]),
  );
  const resolver = supplied.resolveCapability;
  const verificationJob = supplied.verificationJob ? { ...supplied.verificationJob } : undefined;
  const compensationJob = supplied.compensationJob ? { ...supplied.compensationJob } : undefined;
  const enabled = flags.skillActivation && flags.skillWorkflow;
  function boundEntry(frame: Record<string, Json>) {
    const entry = entries.get(string(frame.skillId));
    if (!entry?.contract || entry.descriptor.revision !== frame.skillRevision)
      throw new AgentError('workflow_activation_unverifiable');
    return { ...entry, contract: entry.contract };
  }
  function originalInput(frame: Record<string, Json>): Json {
    const selected = initialActivations?.find(
      (value) => value.key === frame.activationId && value.skillId === frame.skillId,
    );
    const value =
      frame.requestedBy === 'model'
        ? frame.input
        : (originalInputs.get(frameKey(string(frame.runId), string(frame.activationId))) ??
          selected?.input);
    if (value === undefined || hash(canonicalJson(value)) !== frame.inputDigest)
      throw new AgentError('workflow_activation_input_unverifiable');
    return value;
  }
  function current(
    id: string,
    revision?: string,
  ): CompiledSkillWorkflow & { contract: NonNullable<CompiledSkillWorkflow['contract']> } {
    const sealed = entries.get(id);
    if (!sealed?.contract || sealed.descriptor.availability !== 'available')
      throw new AgentError('workflow_unavailable');
    const actual = revalidateSkillWorkflow(sealed, resolver);
    if (
      !actual.contract ||
      actual.descriptor.availability !== 'available' ||
      actual.descriptor.revision !== (revision ?? sealed.descriptor.revision)
    )
      throw new AgentError('workflow_source_changed');
    return { ...actual, contract: actual.contract };
  }
  function prepare(
    input: WorkflowActivationInput,
    requestedBy: 'user' | 'model',
    runId: string,
    sessionId: string,
  ): Json {
    if (!enabled) throw new AgentError('workflow_disabled');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.key)) throw new AgentError('workflow_input_invalid');
    const entry = current(input.skillId),
      contract = entry.contract;
    if (
      !(requestedBy === 'user'
        ? contract.invocation.allowManual
        : contract.invocation.allowImplicit)
    )
      throw new AgentError('workflow_activation_not_allowed');
    const error = validateWorkflowArguments(contract.inputSchema, input.input);
    if (error) throw new AgentError('workflow_input_schema_invalid');
    const risk = Object.values(contract.effectiveEffects).some((effect) =>
      ['write', 'destructive', 'unknown'].includes(effect),
    );
    const verificationMode = flags.verification
      ? risk
        ? 'required'
        : contract.verification.mode
      : 'not_required';
    return {
      kind: 'activation',
      runId,
      sessionId,
      activationId: input.key,
      skillId: input.skillId,
      skillRevision: entry.descriptor.revision,
      ...(requestedBy === 'model' ? { input: json(input.input) } : {}),
      inputDigest: hash(canonicalJson(input.input)),
      activationInputDigest: hash(
        canonicalJson({ key: input.key, skill_id: input.skillId, input: input.input }),
      ),
      requestedBy,
      verificationMode,
      verificationEnabled: flags.verification,
    };
  }
  function ref(record: ExtensionRecord, runId: string, sessionId: string): RequirementRef {
    return {
      extensionId: skillWorkflowExtensionId,
      definitionVersion: '1',
      evaluationProvider: 'extension',
      requirementId: `workflow.${hash(string(object(record.value).activationId))}`,
      recordKey: record.key,
      revision: record.revision,
      runId,
      sessionId,
      phase: 'both',
    };
  }
  async function write(context: ToolContext, key: string, value: Json) {
    const previous = await context.records.get(key);
    if (previous) {
      if (
        previous.contentType !== stateType ||
        canonicalJson(previous.value) !== canonicalJson(value)
      )
        throw new AgentError('workflow_result_conflict');
      return previous;
    }
    return context.records.write({
      key,
      expectedRevision: null,
      contentType: stateType,
      contentVersion: 1,
      executable: true,
      value,
    });
  }
  function attemptPath(key: string, attempt: number) {
    return `${key}/attempts/${attemptNumber(attempt)}`;
  }
  function openingValue(
    record: ExtensionRecord,
    frame: Record<string, Json>,
    attempt: number,
    createdBy: 'initial' | 'repair' | 'replan',
    executionId: string | null,
    detail: string | null,
    decisionKey: string | null = null,
  ): Json {
    return {
      kind: 'attempt',
      attempt,
      activationId: frame.activationId!,
      skillId: frame.skillId!,
      skillRevision: frame.skillRevision!,
      runId: frame.runId!,
      sessionId: frame.sessionId!,
      originStoreId: record.originStoreId,
      anchorRevision: record.revision,
      previousAttempt: attempt === 1 ? null : attempt - 1,
      createdBy,
      executionId,
      detail,
      decisionKey,
    };
  }
  async function initializeAttempt(
    context: ToolContext,
    record: ExtensionRecord,
    frame: Record<string, Json>,
  ) {
    await write(
      context,
      `${attemptPath(record.key, 1)}/opening`,
      openingValue(record, frame, 1, 'initial', null, null),
    );
    if (!(await context.records.get(`${record.key}/head`)))
      await write(context, `${record.key}/head`, { kind: 'head', attempt: 1 });
  }
  async function get(context: ToolContext, activationId: string, attempt = 1, historical = false) {
    if (!context.runId) throw new AgentError('workflow_run_required');
    attemptNumber(attempt);
    const key = frameKey(context.runId, activationId),
      record = await context.records.get(key);
    const frame = decode(record, anchorType);
    if (
      !record ||
      !frame ||
      frame.runId !== context.runId ||
      frame.sessionId !== context.sessionId ||
      frame.activationId !== activationId
    )
      throw new AgentError('workflow_activation_unavailable');
    const headRecord = await context.records.get(`${key}/head`),
      head = decode(headRecord, stateType);
    const path = attemptPath(key, attempt),
      opening = decode(await context.records.get(`${path}/opening`), stateType);
    if (
      !headRecord ||
      !head ||
      head.kind !== 'head' ||
      !opening ||
      opening.kind !== 'attempt' ||
      opening.attempt !== attempt ||
      opening.anchorRevision !== record.revision ||
      opening.originStoreId !== record.originStoreId ||
      opening.runId !== context.runId ||
      opening.sessionId !== context.sessionId ||
      opening.skillRevision !== frame.skillRevision ||
      opening.skillId !== frame.skillId ||
      opening.activationId !== activationId
    )
      throw new AgentError('workflow_attempt_unverifiable');
    if (!historical && (head.attempt !== attempt || head.waiverKey))
      throw new AgentError('workflow_attempt_stale');
    const closed = decode(await context.records.get(`${path}/closed`), stateType);
    const proof = decode(await context.records.get(`${path}/verification`), stateType);
    const settled =
      closed &&
      (frame.verificationMode !== 'required' || proof?.outcome === 'passed' || head.waiverKey);
    return {
      key,
      path,
      record,
      frame: { ...frame, input: originalInput(frame) } as Record<string, Json>,
      headRecord,
      head,
      opening,
      closed,
      proof,
      invalidated: await context.records.get(`${path}/invalidated`),
      entry: settled
        ? boundEntry(frame)
        : current(string(frame.skillId), string(frame.skillRevision)),
    };
  }
  async function safety(context: Pick<ReadContext, 'readRunExecutionSafety'>, runId: string) {
    if (!context.readRunExecutionSafety)
      throw new AgentError('workflow_execution_safety_unavailable');
    const facts = await context.readRunExecutionSafety(runId);
    if (facts.unconfirmed) throw new AgentError('workflow_unknown_effect');
    return facts;
  }
  async function advance(
    context: ToolContext,
    active: Awaited<ReturnType<typeof get>>,
    createdBy: 'repair' | 'replan',
    detail: string,
    decisionKey: string | null = null,
  ) {
    context.signal.throwIfAborted();
    if (!detail.trim()) throw new AgentError('workflow_decision_detail_required');
    if (!active.closed || !active.proof || active.proof.outcome !== 'failed' || active.invalidated)
      throw new AgentError('workflow_repair_unavailable');
    const reference = {
      ...ref(active.record, string(active.frame.runId), context.sessionId),
      originStoreId: string(active.record.originStoreId),
    };
    if (
      !(await validVerification(
        context,
        reference,
        active.frame,
        attemptNumber(active.head.attempt),
        active.closed,
        active.proof,
        active.path,
        'failed',
      ))
    )
      throw new AgentError('workflow_repair_unverifiable');
    await safety(context, string(active.frame.runId));
    const attempt = attemptNumber(Number(active.head.attempt) + 1);
    const path = attemptPath(active.key, attempt);
    await write(
      context,
      `${path}/opening`,
      openingValue(
        active.record,
        active.frame,
        attempt,
        createdBy,
        context.executionId,
        detail.trim(),
        decisionKey,
      ),
    );
    await context.records.write({
      key: `${active.key}/head`,
      expectedRevision: active.headRecord.revision,
      contentType: stateType,
      contentVersion: 1,
      executable: true,
      value: { kind: 'head', attempt },
    });
    if (active.entry.contract.context.mode === 'fork')
      return fork(context, string(active.frame.activationId), attempt);
    return result({
      activationId: active.frame.activationId!,
      attempt,
      status: 'active',
      input: active.frame.input!,
      instructions: active.entry.contract.instructions,
      detail: detail.trim(),
      outputSchema: json(active.entry.contract.outputSchema),
      verificationMode: active.frame.verificationMode!,
    });
  }
  async function frames(context: ReadContext) {
    const found: {
      record: ExtensionRecord;
      frame: Record<string, Json>;
    }[] = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await context.records.list({
        contentType: anchorType,
        limit: 100,
        ...(afterKey ? { afterKey } : {}),
      });
      for (const record of page) {
        const frame = decode(record, anchorType)!;
        const run = await context.getRun(string(frame.runId));
        if (
          run?.isActive &&
          run.sessionId === context.sessionId &&
          frame.sessionId === context.sessionId
        )
          found.push({
            record,
            frame,
          });
      }
      if (page.length < 100) break;
      afterKey = page[page.length - 1]!.key;
    }
    return found;
  }
  const initializeRequirements: RunRequirementInitializer = async (input) => {
    const request = object(input.command.request);
    const envelopes = request.extensionInputs;
    if (envelopes === undefined) return [];
    if (!Array.isArray(envelopes)) throw new AgentError('workflow_input_invalid');
    const selected = envelopes.filter(
      (item) => object(item).extensionId === skillWorkflowExtensionId,
    );
    if (!selected.length) return [];
    if (selected.length !== 1) throw new AgentError('workflow_duplicate_input');
    const envelope = object(selected[0]);
    if (envelope.definitionVersion !== '1') throw new AgentError('workflow_version_unavailable');
    const payload = object(envelope.input);
    if (Object.keys(payload).join(',') !== 'activations' || !Array.isArray(payload.activations))
      throw new AgentError('workflow_input_invalid');
    if (
      initialActivations !== undefined &&
      canonicalJson(json(initialActivations)) !== canonicalJson(payload.activations)
    )
      throw new AgentError('workflow_activation_input_unverifiable');
    const keys = new Set<string>();
    const values = payload.activations.map((value) => {
      const item = object(value);
      if (Object.keys(item).sort().join(',') !== 'input,key,skillId')
        throw new AgentError('workflow_input_invalid');
      const key = string(item.key);
      if (keys.has(key)) throw new AgentError('workflow_duplicate_activation');
      keys.add(key);
      originalInputs.set(frameKey(input.run.id, key), json(item.input!));
      return prepare(
        { key, skillId: string(item.skillId), input: item.input! },
        'user',
        input.run.id,
        input.run.sessionId,
      );
    });
    const context = await input.forExtension(skillWorkflowExtensionId),
      refs: RequirementRef[] = [];
    for (const value of values) {
      const record = await context.records.create({
        key: frameKey(input.run.id, string(object(value).activationId)),
        contentType: anchorType,
        contentVersion: 1,
        value,
      });
      const frame = object(value);
      await context.records.create({
        key: `${attemptPath(record.key, 1)}/opening`,
        contentType: stateType,
        contentVersion: 1,
        value: openingValue(record, frame, 1, 'initial', null, null),
      });
      await context.records.create({
        key: `${record.key}/head`,
        contentType: stateType,
        contentVersion: 1,
        value: { kind: 'head', attempt: 1 },
      });
      refs.push(ref(record, input.run.id, input.run.sessionId));
    }
    return refs;
  };
  async function readFullResult(execution: PublicExecution, context: ToolContext): Promise<string> {
    const value = object(execution.result);
    if (value.outcome !== 'succeeded' || execution.status !== 'succeeded')
      throw new AgentError('workflow_fork_failed');
    if (value.modelContent === undefined) return string(value.content);
    const content = object(value.modelContent),
      reference = object(content.reference),
      scope = object(reference.scope);
    if (
      content.kind !== 'artifact' ||
      content.encoding !== 'utf-8' ||
      scope.kind !== 'execution' ||
      scope.id !== execution.id ||
      !context.artifacts
    )
      throw new AgentError('workflow_result_unverifiable');
    const artifact: ArtifactRef = {
      id: string(reference.id),
      size: string(reference.size),
      mediaType: string(reference.mediaType),
      scope: { kind: 'execution', id: execution.id },
    };
    const bytes = await context.artifacts.read(artifact);
    if (String(bytes.byteLength) !== artifact.size)
      throw new AgentError('workflow_result_unverifiable');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async function waitOriginal(
    context: ToolContext,
    operation: OperationRef,
    activationId: string,
    attempt: number,
  ) {
    for (;;) {
      context.signal.throwIfAborted();
      try {
        return await context.operations.wait(operation, {
          signal: context.signal,
          timeoutMs: 30000,
        });
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
        // A user approval or an active ordinary child may outlive one observation window.
        // Read the exact original attempt again; never create or redispatch another operation.
        await get(context, activationId, attempt);
      }
    }
  }
  async function verify(
    context: ToolContext,
    activationId: string,
    attempt = 1,
  ): Promise<ToolResult> {
    const active = await get(context, activationId, attempt, true),
      { frame, path, entry, closed } = active;
    if (active.invalidated) throw new AgentError('workflow_invalidated');
    if (closed?.status !== 'closed') throw new AgentError('workflow_not_completed');
    if (frame.verificationMode === 'not_required')
      return result({ activationId, attempt, verification: 'not_required' });
    if (active.proof)
      return result(active.proof, active.proof.outcome === 'passed' ? 'succeeded' : 'failed');
    if (active.head.attempt !== attempt || active.head.waiverKey)
      throw new AgentError('workflow_attempt_stale');
    const outputDigest = hash(canonicalJson(closed.output!));
    const binding = {
      activationId,
      attempt,
      outputDigest,
      anchorRevision: active.record.revision,
      originStoreId: active.record.originStoreId,
      sessionId: context.sessionId,
      runId: context.runId,
      skillRevision: frame.skillRevision!,
    };
    let proof: Json;
    if (entry.contract.verification.strategy !== 'script') {
      if (validateWorkflowArguments(entry.contract.outputSchema, closed.output))
        throw new AgentError('workflow_output_schema_invalid');
      proof = { ...binding, outcome: 'passed', kind: 'schema', executionId: context.executionId };
    } else {
      if (!verificationJob) throw new AgentError('workflow_verifier_unavailable');
      const checkpoint = decode(
        await context.records.get(`${path}/verification-operation`),
        stateType,
      );
      let operation: OperationRef;
      if (checkpoint) operation = checkpoint.ref as unknown as OperationRef;
      else {
        const input = json(
          verificationJob.prepare({
            entry,
            activationId,
            attempt,
            outputDigest,
            output: closed.output!,
          }),
        );
        const created = await context.operations.ensure({
          key: `workflow-verify-${hash(path)}`,
          planRecordKey: active.key,
          request: {
            kind: 'job',
            definitionId: verificationJob.definitionId,
            definitionVersion: verificationJob.definitionVersion,
            input,
          },
        });
        await write(context, `${path}/verification-operation`, {
          ref: json(created),
          input,
          parentExecutionId: context.executionId,
          attempt,
          outputDigest,
        });
        operation = created;
      }
      const execution = await waitOriginal(context, operation, activationId, attempt);
      const latest = await get(context, activationId, attempt);
      if (latest.headRecord.revision !== active.headRecord.revision)
        throw new AgentError('workflow_attempt_stale');
      current(string(frame.skillId), string(frame.skillRevision));
      const passed =
        execution.status === 'succeeded' && object(execution.result).outcome === 'succeeded';
      proof = {
        ...binding,
        outcome: passed ? 'passed' : execution.status === 'outcome_unknown' ? 'unknown' : 'failed',
        kind: 'script',
        executionId: execution.id,
        resultRevision: execution.resultRevision,
        definitionId: verificationJob.definitionId,
        definitionVersion: verificationJob.definitionVersion,
      };
    }
    await write(context, `${path}/verification`, proof);
    return result(proof, object(proof).outcome === 'passed' ? 'succeeded' : 'failed');
  }
  async function complete(
    context: ToolContext,
    activationId: string,
    output: Json,
    attempt = 1,
  ): Promise<ToolResult> {
    const { path, frame, entry, record, headRecord, invalidated } = await get(
      context,
      activationId,
      attempt,
    );
    if (invalidated) throw new AgentError('workflow_invalidated');
    if (validateWorkflowArguments(entry.contract.outputSchema, output))
      throw new AgentError('workflow_output_schema_invalid');
    let forkProof: Json = null;
    if (entry.contract.context.mode === 'fork') {
      const checkpoint = decode(await context.records.get(`${path}/fork-operation`), stateType);
      const operation = checkpoint ? object(checkpoint.ref) : null;
      const execution = operation?.executionId
        ? await context.getExecution(string(operation.executionId))
        : null;
      const role = forks.get(entry.contract.context.agent);
      if (
        !execution ||
        !role ||
        execution.kind !== 'job' ||
        execution.definitionId !== `agent/${role.configurationId}` ||
        execution.definitionVersion !== role.definitionVersion ||
        execution.originStoreId !== record.originStoreId ||
        execution.sessionId !== context.sessionId ||
        execution.originCommandId !== operation?.commandId ||
        execution.parentExecutionId !== checkpoint?.parentExecutionId
      )
        throw new AgentError('workflow_fork_unverifiable');
      let original: Json;
      try {
        original = JSON.parse(await readFullResult(execution, context)) as Json;
      } catch {
        throw new AgentError('workflow_fork_unverifiable');
      }
      if (canonicalJson(original) !== canonicalJson(output))
        throw new AgentError('workflow_fork_output_mismatch');
      forkProof = {
        executionId: execution.id,
        resultRevision: execution.resultRevision,
        outputDigest: hash(canonicalJson(output)),
      };
    }
    const prior = decode(await context.records.get(`${path}/closed`), stateType);
    if (
      prior &&
      (prior.status !== 'closed' || canonicalJson(prior.output!) !== canonicalJson(output))
    )
      throw new AgentError('workflow_result_conflict');
    if (!prior)
      await write(context, `${path}/closed`, {
        activationId,
        attempt,
        status: 'closed',
        output,
        outputDigest: hash(canonicalJson(output)),
        anchorRevision: record.revision,
        headRevision: headRecord.revision,
        executionId: context.executionId,
        forkProof,
      });
    if (frame.verificationMode !== 'not_required') return verify(context, activationId, attempt);
    return result({ activationId, attempt, status: 'closed', output });
  }
  async function fork(
    context: ToolContext,
    activationId: string,
    attempt = 1,
  ): Promise<ToolResult> {
    const active = await get(context, activationId, attempt),
      { path, entry } = active;
    if (active.invalidated) throw new AgentError('workflow_invalidated');
    const role = forks.get(entry.contract.context.agent);
    if (!role) throw new AgentError('workflow_fork_unavailable');
    try {
      const existing = decode(await context.records.get(`${path}/fork-operation`), stateType);
      let operation: OperationRef;
      if (existing) operation = existing.ref as unknown as OperationRef;
      else {
        const carrier = await context.getExecution(context.executionId);
        if (
          !carrier ||
          carrier.runId !== context.runId ||
          carrier.kind !== 'tool' ||
          carrier.sessionId !== context.sessionId ||
          carrier.originStoreId !== active.record.originStoreId ||
          carrier.definitionVersion !== '1' ||
          !['activate_skill', 'repair_skill', 'decide_skill_verification'].includes(
            carrier.definitionId ?? '',
          )
        )
          throw new AgentError('workflow_fork_unverifiable');
        await write(context, `${path}/fork-opening`, {
          kind: 'fork_opening',
          activationId,
          attempt,
          anchorRevision: active.record.revision,
          skillId: active.frame.skillId!,
          skillRevision: active.frame.skillRevision!,
          runId: context.runId,
          sessionId: context.sessionId,
          originStoreId: active.record.originStoreId,
          headRevision: active.headRecord.revision,
          carrierExecutionId: carrier.id,
          carrierDefinitionId: string(carrier.definitionId),
          carrierDefinitionVersion: '1',
          carrierInputDigest: string(carrier.inputDigest),
          configurationId: role.configurationId,
          configurationVersion: role.definitionVersion,
        });
        const created = await context.operations.ensure({
          key: `workflow-fork-${hash(path)}`,
          planRecordKey: active.key,
          request: {
            kind: 'agent',
            configurationId: role.configurationId,
            input: {
              content: `Execute the explicitly activated Skill and return exactly one JSON object matching its output schema.\n${entry.contract.instructions}\nInput: ${canonicalJson(active.frame.input!)}\nRepair instruction: ${active.opening.detail ?? ''}\nOutput schema: ${JSON.stringify(entry.contract.outputSchema)}`,
            },
          },
        });
        await write(context, `${path}/fork-operation`, {
          ref: json(created),
          parentExecutionId: context.executionId,
          attempt,
        });
        operation = created;
      }
      const execution = await waitOriginal(context, operation, activationId, attempt);
      let output: Json;
      try {
        output = JSON.parse(await readFullResult(execution, context)) as Json;
      } catch {
        throw new AgentError('workflow_output_schema_invalid');
      }
      return await complete(context, activationId, output, attempt);
    } catch (error) {
      if (!context.signal.aborted && !(await context.records.get(`${path}/closed`)))
        await write(context, `${path}/invalidated`, {
          activationId,
          attempt,
          status: 'invalidated',
          reason: error instanceof AgentError ? error.code : 'workflow_fork_failed',
          executionId: context.executionId,
        });
      throw error;
    }
  }
  async function validVerification(
    read: Pick<ReadContext, 'getExecution'> & { records: Pick<ReadContext['records'], 'get'> },
    reference: RequirementRef,
    frame: Record<string, Json>,
    attempt: number,
    closed: Record<string, Json>,
    proof: Record<string, Json>,
    path: string,
    expected: 'passed' | 'failed',
  ) {
    if (
      proof.outcome !== expected ||
      proof.activationId !== frame.activationId ||
      proof.attempt !== attempt ||
      proof.anchorRevision !== reference.revision ||
      proof.runId !== reference.runId ||
      proof.sessionId !== reference.sessionId ||
      proof.originStoreId !== reference.originStoreId ||
      proof.skillRevision !== frame.skillRevision ||
      proof.outputDigest !== hash(canonicalJson(closed.output!))
    )
      return false;
    const execution = await read.getExecution(string(proof.executionId));
    if (
      !execution ||
      execution.originStoreId !== reference.originStoreId ||
      execution.sessionId !== reference.sessionId
    )
      return false;
    if (proof.kind === 'schema')
      return (
        expected === 'passed' &&
        execution.status === 'succeeded' &&
        execution.runId === reference.runId &&
        execution.kind === 'tool' &&
        execution.definitionVersion === '1' &&
        lifecycle.has(execution.definitionId ?? '')
      );
    const checkpoint = decode(await read.records.get(`${path}/verification-operation`), stateType);
    const operation = checkpoint ? object(checkpoint.ref) : null;
    const parent = execution.parentExecutionId
      ? await read.getExecution(execution.parentExecutionId)
      : null;
    return (
      proof.kind === 'script' &&
      execution.kind === 'job' &&
      execution.resultRevision !== null &&
      execution.status === (expected === 'passed' ? 'succeeded' : 'failed') &&
      object(execution.result).outcome === (expected === 'passed' ? 'succeeded' : 'failed') &&
      parent?.kind === 'tool' &&
      parent.originStoreId === reference.originStoreId &&
      parent.sessionId === reference.sessionId &&
      parent.runId === reference.runId &&
      parent.definitionVersion === '1' &&
      lifecycle.has(parent.definitionId ?? '') &&
      operation?.executionId === execution.id &&
      operation.commandId === execution.originCommandId &&
      checkpoint?.parentExecutionId === execution.parentExecutionId &&
      checkpoint?.attempt === attempt &&
      checkpoint.outputDigest === proof.outputDigest &&
      proof.resultRevision === execution.resultRevision &&
      proof.definitionId === execution.definitionId &&
      proof.definitionVersion === execution.definitionVersion &&
      execution.definitionId === verificationJob?.definitionId &&
      execution.definitionVersion === verificationJob?.definitionVersion &&
      execution.inputDigest === hash(canonicalJson(checkpoint.input!))
    );
  }
  async function acceptedDecision(
    read: Pick<ReadContext, 'getInteraction'>,
    proof: Record<string, Json>,
    request: Json,
    reference: RequirementRef,
  ) {
    const actual = await read.getInteraction?.(string(proof.interactionId));
    return (
      proof.originStoreId === reference.originStoreId &&
      proof.sessionId === reference.sessionId &&
      proof.runId === reference.runId &&
      actual &&
      actual.kind === 'question' &&
      actual.state === 'answered' &&
      actual.originStoreId === reference.originStoreId &&
      actual.sessionId === reference.sessionId &&
      actual.runId === reference.runId &&
      actual.definitionId === 'decide_skill_verification' &&
      actual.definitionVersion === '1' &&
      actual.executionId === proof.executionId &&
      actual.attempt === proof.attempt &&
      actual.acceptedDecisionRevision !== null &&
      actual.acceptedDecisionRevision === proof.decisionRevision &&
      canonicalJson(actual.request) === canonicalJson(request) &&
      canonicalJson(actual.answer as Json) === canonicalJson(proof.answer!)
    );
  }
  function allowedDecisions(frame: Record<string, Json>) {
    return [
      userDecisions?.allowReplan ? 'replan' : null,
      userDecisions?.allowWaiver ? 'waive' : null,
      userDecisions?.allowCompensation &&
      boundEntry(frame).contract.recovery.compensation &&
      compensationJob?.supports(boundEntry(frame))
        ? 'compensate'
        : null,
    ].filter((value): value is string => value !== null);
  }
  function decisionRequest(
    reference: RequirementRef,
    frame: Record<string, Json>,
    attempt: number,
    headRevision: Json,
    proof: Record<string, Json>,
  ): Json {
    const allowed = allowedDecisions(frame);
    return {
      kind: 'skill_workflow_verification',
      originStoreId: reference.originStoreId!,
      sessionId: reference.sessionId,
      runId: reference.runId,
      activationId: frame.activationId!,
      anchorKey: reference.recordKey,
      anchorRevision: reference.revision,
      requirementId: reference.requirementId,
      requirementRevision: reference.revision,
      skillId: frame.skillId!,
      skillRevision: frame.skillRevision!,
      attempt,
      headRevision,
      outputDigest: proof.outputDigest!,
      verifier: proof,
      schema: schema({
        decision: { type: 'string', enum: allowed },
        detail: { type: 'string', minLength: 1 },
      }),
    };
  }
  async function validOpening(
    read: Pick<ReadContext, 'getExecution' | 'getInteraction'> & {
      records: Pick<ReadContext['records'], 'get'>;
    },
    reference: RequirementRef,
    frame: Record<string, Json>,
    attempt: number,
    opening: Record<string, Json>,
  ) {
    if (attempt === 1)
      return (
        opening.createdBy === 'initial' &&
        opening.previousAttempt === null &&
        opening.executionId === null &&
        opening.detail === null &&
        opening.decisionKey === null
      );
    if (
      opening.previousAttempt !== attempt - 1 ||
      typeof opening.detail !== 'string' ||
      !opening.detail.trim() ||
      !['repair', 'replan'].includes(String(opening.createdBy))
    )
      return false;
    const parent = await read.getExecution(string(opening.executionId));
    if (
      !parent ||
      parent.runId !== reference.runId ||
      parent.originStoreId !== reference.originStoreId ||
      parent.sessionId !== reference.sessionId ||
      parent.kind !== 'tool' ||
      parent.definitionVersion !== '1' ||
      parent.definitionId !==
        (opening.createdBy === 'repair' ? 'repair_skill' : 'decide_skill_verification')
    )
      return false;
    const previousPath = attemptPath(reference.recordKey, attempt - 1),
      closed = decode(await read.records.get(`${previousPath}/closed`), stateType),
      proof = decode(await read.records.get(`${previousPath}/verification`), stateType);
    if (
      !closed ||
      !proof ||
      !(await validVerification(
        read,
        reference,
        frame,
        attempt - 1,
        closed,
        proof,
        previousPath,
        'failed',
      ))
    )
      return false;
    if (opening.createdBy === 'repair') return opening.decisionKey === null;
    if (
      !userDecisions?.allowReplan ||
      opening.decisionKey !== `${previousPath}/decision/${parent.id}`
    )
      return false;
    const saved = decode(await read.records.get(string(opening.decisionKey)), stateType);
    if (
      !saved ||
      saved.kind !== 'user_decision' ||
      saved.outcome !== 'replan' ||
      saved.detail !== opening.detail
    )
      return false;
    const accepted = object(saved.proof),
      answers = object(object(accepted.answer).answers),
      expected = decisionRequest(reference, frame, attempt - 1, closed.headRevision!, proof);
    return (
      accepted.executionId === parent.id &&
      answers.decision === 'replan' &&
      typeof answers.detail === 'string' &&
      answers.detail.trim() === opening.detail &&
      canonicalJson(saved.request!) === canonicalJson(expected) &&
      canonicalJson(accepted.request!) === canonicalJson(expected) &&
      !!(await acceptedDecision(read, accepted, expected, reference))
    );
  }
  async function compensate(
    context: ToolContext,
    active: Awaited<ReturnType<typeof get>>,
    decisionKey: string,
  ): Promise<ToolResult> {
    if (
      !compensationJob ||
      !active.entry.contract.recovery.compensation ||
      !compensationJob.supports(active.entry)
    )
      throw new AgentError('workflow_compensation_unavailable');
    const attempt = attemptNumber(active.head.attempt),
      activationId = string(active.frame.activationId);
    const checkpoint = decode(
      await context.records.get(`${active.path}/compensation-operation`),
      stateType,
    );
    let operation: OperationRef;
    if (checkpoint) operation = checkpoint.ref as unknown as OperationRef;
    else {
      const decision = await context.records.get(decisionKey);
      if (!decision) throw new AgentError('workflow_decision_proof_invalid');
      const input = json(
        compensationJob.prepare({
          entry: active.entry,
          activationId,
          attempt,
          outputDigest: hash(canonicalJson(active.closed!.output!)),
          output: active.closed!.output!,
          decisionKey,
          decisionDigest: hash(canonicalJson(decision.value)),
        }),
      );
      await write(context, `${active.path}/compensation-opening`, {
        input,
        parentExecutionId: context.executionId,
        attempt,
        decisionKey,
        decisionDigest: hash(canonicalJson(decision.value)),
        headRevision: active.headRecord.revision,
        outputDigest: active.closed!.outputDigest!,
      });
      operation = await context.operations.ensure({
        key: `workflow-compensate-${hash(active.path)}`,
        planRecordKey: active.key,
        request: {
          kind: 'job',
          definitionId: compensationJob.definitionId,
          definitionVersion: compensationJob.definitionVersion,
          input,
        },
      });
      await write(context, `${active.path}/compensation-operation`, {
        ref: json(operation),
        input,
        parentExecutionId: context.executionId,
        attempt,
        decisionKey,
        decisionDigest: hash(canonicalJson(decision.value)),
      });
    }
    const execution = await waitOriginal(context, operation, activationId, attempt);
    const latest = await get(context, activationId, attempt);
    if (latest.headRecord.revision !== active.headRecord.revision)
      throw new AgentError('workflow_attempt_stale');
    if (
      execution.kind !== 'job' ||
      execution.definitionId !== compensationJob.definitionId ||
      execution.definitionVersion !== compensationJob.definitionVersion ||
      execution.originStoreId !== active.record.originStoreId ||
      execution.sessionId !== context.sessionId ||
      execution.originCommandId !== operation.commandId ||
      execution.resultRevision === null
    )
      throw new AgentError('workflow_compensation_unverifiable');
    const saved = decode(
      await context.records.get(`${active.path}/compensation-result`),
      stateType,
    );
    if (saved) return result(saved, saved.outcome === 'compensated' ? 'succeeded' : 'failed');
    const proof: Json = {
      kind: 'compensation',
      outcome:
        execution.status === 'succeeded' && object(execution.result).outcome === 'succeeded'
          ? 'compensated'
          : execution.status === 'outcome_unknown'
            ? 'unknown'
            : execution.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
      activationId,
      attempt,
      originStoreId: active.record.originStoreId,
      sessionId: context.sessionId,
      runId: context.runId,
      anchorRevision: active.record.revision,
      headRevision: active.headRecord.revision,
      skillRevision: active.frame.skillRevision!,
      outputDigest: active.closed!.outputDigest!,
      executionId: execution.id,
      resultRevision: execution.resultRevision,
      definitionId: execution.definitionId,
      definitionVersion: execution.definitionVersion,
      decisionKey: checkpoint?.decisionKey ?? decisionKey,
    };
    await write(context, `${active.path}/compensation-result`, proof);
    return result(proof, object(proof).outcome === 'compensated' ? 'succeeded' : 'failed');
  }
  async function validCompensationOpening(
    read: Pick<ReadContext, 'getExecution' | 'getInteraction' | 'readRunExecutionSafety'> & {
      records: Pick<ReadContext['records'], 'get'>;
    },
    reference: RequirementRef,
    frame: Record<string, Json>,
    attempt: number,
    closed: Record<string, Json>,
    proof: Record<string, Json>,
    path: string,
    headRecord: ExtensionRecord,
    boundary: PublicExecution | null,
    parent: PublicExecution | null,
    entry: ReturnType<typeof current>,
  ) {
    if (
      !userDecisions?.allowCompensation ||
      !compensationJob?.supports(entry) ||
      boundary?.kind !== 'job' ||
      boundary.definitionId !== compensationJob.definitionId ||
      boundary.definitionVersion !== compensationJob.definitionVersion ||
      boundary.originStoreId !== reference.originStoreId ||
      boundary.sessionId !== reference.sessionId ||
      parent?.kind !== 'tool' ||
      parent.definitionId !== 'decide_skill_verification' ||
      parent.definitionVersion !== '1' ||
      parent.originStoreId !== reference.originStoreId ||
      parent.sessionId !== reference.sessionId ||
      parent.runId !== reference.runId ||
      !['dispatching', 'running'].includes(parent.status) ||
      !(await validVerification(read, reference, frame, attempt, closed, proof, path, 'failed'))
    )
      return false;
    const opening = decode(await read.records.get(`${path}/compensation-opening`), stateType);
    if (
      !opening ||
      opening.parentExecutionId !== parent.id ||
      opening.attempt !== attempt ||
      opening.headRevision !== headRecord.revision ||
      opening.outputDigest !== closed.outputDigest
    )
      return false;
    const decisionKey = string(opening.decisionKey),
      decision = decode(await read.records.get(decisionKey), stateType);
    if (
      !decision ||
      decision.kind !== 'user_decision' ||
      decision.outcome !== 'compensation_requested' ||
      decisionKey !== `${path}/decision/${parent.id}` ||
      opening.decisionDigest !== hash(canonicalJson(decision))
    )
      return false;
    const accepted = object(decision.proof),
      answers = object(object(accepted.answer).answers);
    const expected = decisionRequest(reference, frame, attempt, closed.headRevision!, proof);
    if (
      answers.decision !== 'compensate' ||
      typeof answers.detail !== 'string' ||
      !answers.detail.trim() ||
      decision.detail !== answers.detail.trim() ||
      accepted.executionId !== parent.id ||
      canonicalJson(decision.request!) !== canonicalJson(expected) ||
      !(await acceptedDecision(read, accepted, expected, reference))
    )
      return false;
    const expectedInput = compensationJob.prepare({
      entry,
      activationId: string(frame.activationId),
      attempt,
      outputDigest: hash(canonicalJson(closed.output!)),
      output: closed.output!,
      decisionKey,
      decisionDigest: hash(canonicalJson(decision)),
    });
    if (
      canonicalJson(opening.input!) !== canonicalJson(expectedInput) ||
      boundary.inputDigest !== hash(canonicalJson(expectedInput))
    )
      return false;
    const facts = await read.readRunExecutionSafety?.(reference.runId);
    return (
      !!facts &&
      facts.excludedExecutionId === null &&
      facts.originStoreId === reference.originStoreId &&
      facts.sessionId === reference.sessionId &&
      facts.unconfirmedExecutionIds.every((id) => id === boundary.id || id === parent.id)
    );
  }
  async function decide(
    context: ToolContext,
    activationId: string,
    attempt: number,
  ): Promise<ToolResult> {
    if (!context.requestInteractionWithReceipt)
      throw new AgentError('workflow_user_decision_unavailable');
    const active = await get(context, activationId, attempt);
    const allowed = allowedDecisions(active.frame);
    if (!allowed.length) throw new AgentError('workflow_user_decision_unavailable');
    if (!active.closed || !active.proof || active.invalidated)
      throw new AgentError('workflow_decision_unavailable');
    const reference = {
      ...ref(active.record, context.runId!, context.sessionId),
      originStoreId: string(active.record.originStoreId),
    };
    if (
      !(await validVerification(
        context,
        reference,
        active.frame,
        attempt,
        active.closed,
        active.proof,
        active.path,
        'failed',
      ))
    )
      throw new AgentError('workflow_decision_unverifiable');
    await safety(context, context.runId!);
    const request = decisionRequest(
      reference,
      active.frame,
      attempt,
      active.headRecord.revision,
      active.proof,
    );
    const proof: AcceptedInformation = await context.requestInteractionWithReceipt({
      kind: 'question',
      request,
    });
    context.signal.throwIfAborted();
    if (
      !(await acceptedDecision(context, object(json(proof)), request, reference)) ||
      proof.executionId !== context.executionId ||
      canonicalJson(proof.request) !== canonicalJson(request) ||
      proof.answer.kind !== 'question'
    )
      throw new AgentError('workflow_decision_proof_invalid');
    const answers = object(proof.answer.answers),
      decision = string(answers.decision),
      detail = string(answers.detail).trim();
    if (!allowed.includes(decision) || !detail)
      throw new AgentError('workflow_decision_detail_required');
    const latest = await get(context, activationId, attempt);
    if (
      latest.headRecord.revision !== active.headRecord.revision ||
      canonicalJson(latest.closed!) !== canonicalJson(active.closed) ||
      canonicalJson(latest.proof!) !== canonicalJson(active.proof)
    )
      throw new AgentError('workflow_decision_target_changed');
    await safety(context, context.runId!);
    const decisionKey = `${active.path}/decision/${context.executionId}`;
    await write(context, decisionKey, {
      kind: 'user_decision',
      outcome:
        decision === 'waive'
          ? 'waived'
          : decision === 'compensate'
            ? 'compensation_requested'
            : 'replan',
      request,
      proof: json(proof),
      detail,
      recordedAt: Date.now(),
    });
    if (decision === 'replan') return advance(context, latest, 'replan', detail, decisionKey);
    if (decision === 'compensate') return compensate(context, latest, decisionKey);
    await context.records.write({
      key: `${active.key}/head`,
      expectedRevision: active.headRecord.revision,
      contentType: stateType,
      contentVersion: 1,
      executable: true,
      value: { kind: 'head', attempt, waiverKey: decisionKey },
    });
    return result({ activationId, attempt, outcome: 'waived', verification: 'failed' });
  }
  const extension: Extension = {
    id: skillWorkflowExtensionId,
    version: '1',
    apiMajor: 1,
    records: [anchorType, stateType].map((contentType) => ({
      contentType,
      contentVersion: 1,
      schema: objectSchema,
      fork: { mode: 'omit' as const },
    })),
    tools: [
      {
        id: 'activate_skill',
        version: '1',
        description: 'Activate an explicitly available Skill Workflow; never grants capabilities',
        inputSchema: schema({
          key: keySchema,
          skill_id: { type: 'string', minLength: 1 },
          input: objectSchema,
        }),
        async execute(input, context) {
          if (!context.runId || !context.requirements)
            throw new AgentError('workflow_run_required');
          const value = object(input),
            activationId = string(value.key),
            key = frameKey(context.runId, activationId);
          let anchor = await context.records.get(key);
          const prepared = prepare(
            { key: activationId, skillId: string(value.skill_id), input: value.input! },
            anchor && object(anchor.value).requestedBy === 'user' ? 'user' : 'model',
            context.runId,
            context.sessionId,
          );
          if (
            anchor &&
            (anchor.contentType !== anchorType ||
              canonicalJson(anchor.value) !== canonicalJson(prepared))
          )
            throw new AgentError('workflow_activation_conflict');
          if (!anchor)
            anchor = await context.records.write({
              key,
              expectedRevision: null,
              contentType: anchorType,
              contentVersion: 1,
              executable: true,
              value: prepared,
            });
          await initializeAttempt(context, anchor, object(anchor.value));
          const requirement = ref(anchor, context.runId, context.sessionId);
          await context.requirements.register([
            {
              definitionVersion: requirement.definitionVersion,
              requirementId: requirement.requirementId,
              recordKey: requirement.recordKey,
              revision: requirement.revision,
              phase: requirement.phase,
            },
          ]);
          if (current(string(value.skill_id)).contract.context.mode === 'fork')
            return fork(context, activationId);
          const active = await get(context, activationId);
          return result({
            activationId,
            attempt: 1,
            status: active.closed ? 'closed' : 'active',
            input: active.frame.input!,
            instructions: active.entry.contract.instructions,
            outputSchema: json(active.entry.contract.outputSchema),
            verificationMode: active.frame.verificationMode!,
          });
        },
      },
      {
        id: 'read_skill_reference',
        version: '1',
        description: 'Read an active Workflow declared resource without execution',
        inputSchema: schema(
          {
            activation_id: keySchema,
            path: { type: 'string', minLength: 1 },
            attempt: attemptSchema,
          },
          ['activation_id', 'path'],
        ),
        async execute(input, context) {
          const value = object(input),
            active = await get(context, string(value.activation_id), attemptNumber(value.attempt));
          if (active.closed) throw new AgentError('workflow_already_closed');
          return result(json(readWorkflowReference(active.entry, string(value.path), resolver)));
        },
      },
      {
        id: 'complete_skill',
        version: '1',
        description:
          'Validate exact structured Workflow output and record its verification independently',
        inputSchema: schema(
          { activation_id: keySchema, output: objectSchema, attempt: attemptSchema },
          ['activation_id', 'output'],
        ),
        execute(input, context) {
          const value = object(input);
          return complete(
            context,
            string(value.activation_id),
            value.output!,
            attemptNumber(value.attempt),
          );
        },
      },
      {
        id: 'verify_skill',
        version: '1',
        description: 'Read or perform the original Workflow verification through its admitted Job',
        inputSchema: schema({ activation_id: keySchema, attempt: attemptSchema }, [
          'activation_id',
        ]),
        execute(input, context) {
          const value = object(input);
          return verify(context, string(value.activation_id), attemptNumber(value.attempt));
        },
      },
      {
        id: 'repair_skill',
        version: '1',
        description:
          'Create an explicit repair attempt preserving original failed evidence and capabilities',
        inputSchema: schema({
          activation_id: keySchema,
          attempt: attemptSchema,
          detail: { type: 'string', minLength: 1 },
        }),
        async execute(input, context) {
          const value = object(input);
          return advance(
            context,
            await get(context, string(value.activation_id), attemptNumber(value.attempt)),
            'repair',
            string(value.detail),
          );
        },
      },
      {
        id: 'decide_skill_verification',
        version: '1',
        description:
          'Ask the actual user to replan or waive the exact failed verification; never grants permissions',
        inputSchema: schema({ activation_id: keySchema, attempt: attemptSchema }),
        execute(input, context) {
          const value = object(input);
          return decide(context, string(value.activation_id), attemptNumber(value.attempt));
        },
      },
    ],
    context: {
      async capture(_request, context): Promise<ContextSource[]> {
        if (!enabled) return [];
        const catalogue = canonicalJson({
          kind: 'workflow_catalogue',
          skills: [...entries.values()]
            .filter((entry) => entry.contract && entry.descriptor.availability === 'available')
            .map((entry) => ({
              skillId: entry.descriptor.capabilityId,
              revision: entry.descriptor.revision,
              description: entry.descriptor.description,
              invocation: json(entry.contract!.invocation),
              inputSchema: json(entry.contract!.inputSchema),
            })),
        });
        const activeFrames = await frames(context);
        for (const { record, frame } of activeFrames) {
          const head = decode(await context.records.get(`${record.key}/head`), stateType);
          if (!head) throw new AgentError('workflow_attempt_unverifiable');
          const path = attemptPath(record.key, attemptNumber(head.attempt));
          const closed = await context.records.get(`${path}/closed`);
          const verification = decode(await context.records.get(`${path}/verification`), stateType);
          if (
            !(await context.records.get(`${path}/invalidated`)) &&
            (!closed ||
              (frame.verificationMode === 'required' &&
                verification?.outcome !== 'passed' &&
                !head.waiverKey))
          )
            current(string(frame.skillId), string(frame.skillRevision));
        }
        const intents = activeFrames
          .filter(({ frame }) => frame.requestedBy === 'user')
          .map(({ frame }) => {
            const contract = boundEntry(frame).contract;
            const content = canonicalJson({
              kind: 'workflow_activation_intent',
              activationId: frame.activationId!,
              skillId: frame.skillId!,
              revision: frame.skillRevision!,
              input: originalInput(frame),
              verificationMode: frame.verificationMode!,
              instructions: contract.context.mode === 'inline' ? contract.instructions : '',
              outputSchema: json(contract.outputSchema),
              contextMode: contract.context.mode,
            });
            return {
              id: `${skillWorkflowExtensionId}:${frame.runId}:${frame.activationId}`,
              kind: 'skill-workflow',
              scope: 'run-workflow',
              digest: hash(content),
              content,
            };
          });
        return [
          {
            id: `${skillWorkflowExtensionId}:catalogue`,
            kind: 'skill-workflow',
            scope: context.sessionId,
            digest: hash(catalogue),
            content: catalogue,
          },
          ...intents,
        ];
      },
    },
    conditions: {
      async evaluate(refs, phase, context) {
        if (!context) throw new AgentError('workflow_condition_context_missing');
        return Promise.all(
          refs.map(async (reference): Promise<RequirementEvaluation> => {
            const read = await context.forRequirement(reference),
              anchor = await read.records.get(reference.recordKey);
            const frame = decode(anchor, anchorType);
            const answer = (
              outcome: 'satisfied' | 'waived' | 'unsatisfied',
              reason: string,
            ): RequirementEvaluation => ({
              requirement: reference,
              recordRevision: anchor?.revision ?? reference.revision,
              outcome,
              evidence: { reason },
            });
            if (
              !anchor ||
              !frame ||
              anchor.originStoreId !== reference.originStoreId ||
              anchor.revision !== reference.revision ||
              frame.runId !== reference.runId ||
              frame.sessionId !== reference.sessionId
            )
              return answer('unsatisfied', 'workflow_activation_unverifiable');
            const headRecord = await read.records.get(`${reference.recordKey}/head`),
              head = decode(headRecord, stateType);
            if (!headRecord || !head || head.kind !== 'head')
              return answer('unsatisfied', 'workflow_attempt_unverifiable');
            const attempt = attemptNumber(head.attempt),
              path = attemptPath(reference.recordKey, attempt);
            const opening = decode(await read.records.get(`${path}/opening`), stateType);
            if (
              opening?.kind !== 'attempt' ||
              opening.attempt !== attempt ||
              opening.runId !== reference.runId ||
              opening.sessionId !== reference.sessionId ||
              opening.originStoreId !== reference.originStoreId ||
              opening.anchorRevision !== reference.revision ||
              opening.activationId !== frame.activationId ||
              opening.skillRevision !== frame.skillRevision ||
              opening.skillId !== frame.skillId
            )
              return answer('unsatisfied', 'workflow_attempt_unverifiable');
            if (!(await validOpening(read, reference, frame, attempt, opening)))
              return answer('unsatisfied', 'workflow_opening_unverifiable');
            if (context.boundary.runId !== null && context.boundary.runId !== reference.runId)
              return answer('satisfied', 'nonapplicable_run_boundary');
            const boundaryExecution = context.boundary.executionId
              ? await read.getExecution(context.boundary.executionId)
              : null;
            let boundaryRunId = context.boundary.runId,
              parent = boundaryExecution;
            const visited = new Set<string>();
            while (!boundaryRunId && parent?.parentExecutionId && !visited.has(parent.id)) {
              visited.add(parent.id);
              parent = await read.getExecution(parent.parentExecutionId);
              if (
                parent?.sessionId !== reference.sessionId ||
                parent.originStoreId !== reference.originStoreId
              )
                break;
              boundaryRunId = parent.runId;
            }
            if (boundaryRunId !== reference.runId)
              return answer('satisfied', 'nonapplicable_run_boundary');
            if (phase === 'completion' && context.boundary.executionId !== null)
              return answer('satisfied', 'nonapplicable_execution_completion');
            const closed = decode(await read.records.get(`${path}/closed`), stateType);
            if (await read.records.get(`${path}/invalidated`))
              return answer('unsatisfied', 'workflow_invalidated');
            const proof = decode(await read.records.get(`${path}/verification`), stateType);
            const verified =
              closed &&
              proof &&
              (await validVerification(
                read,
                reference,
                frame,
                attempt,
                closed,
                proof,
                path,
                'passed',
              ));
            let waived = false;
            if (head.waiverKey) {
              const waiverKey = string(head.waiverKey),
                decision = decode(await read.records.get(waiverKey), stateType);
              if (
                decision &&
                decision.kind === 'user_decision' &&
                decision.outcome === 'waived' &&
                userDecisions?.allowWaiver &&
                closed &&
                proof &&
                (await validVerification(
                  read,
                  reference,
                  frame,
                  attempt,
                  closed,
                  proof,
                  path,
                  'failed',
                ))
              ) {
                const request = object(decision.request),
                  accepted = object(decision.proof),
                  answers = object(object(accepted.answer).answers);
                const expected = decisionRequest(
                  reference,
                  frame,
                  attempt,
                  closed.headRevision!,
                  proof,
                );
                const facts = await read.readRunExecutionSafety?.(reference.runId);
                waived =
                  !!facts &&
                  !facts.unconfirmed &&
                  waiverKey === `${path}/decision/${accepted.executionId}` &&
                  typeof decision.recordedAt === 'number' &&
                  Number.isFinite(decision.recordedAt) &&
                  answers.decision === 'waive' &&
                  typeof answers.detail === 'string' &&
                  !!answers.detail.trim() &&
                  decision.detail === answers.detail.trim() &&
                  canonicalJson(request) === canonicalJson(expected) &&
                  canonicalJson(accepted.request!) === canonicalJson(expected) &&
                  !!(await acceptedDecision(read, accepted, expected, reference));
              }
            }
            const settled = closed && (frame.verificationMode !== 'required' || verified || waived);
            let entry: ReturnType<typeof current>;
            try {
              entry = settled
                ? boundEntry(frame)
                : current(string(frame.skillId), string(frame.skillRevision));
            } catch {
              return answer('unsatisfied', 'workflow_source_changed');
            }
            if (phase === 'dispatch') {
              if (
                settled ||
                context.boundary.kind === 'model' ||
                (context.boundary.kind === 'tool' &&
                  context.boundary.definitionVersion === '1' &&
                  lifecycle.has(context.boundary.definitionId ?? ''))
              )
                return answer('satisfied', 'workflow_lifecycle_boundary');
              const carrierParent = boundaryExecution?.parentExecutionId
                ? await read.getExecution(boundaryExecution.parentExecutionId)
                : null;
              const role = forks.get(entry.contract.context.agent);
              const forkOpening = decode(await read.records.get(`${path}/fork-opening`), stateType);
              const forkCarrier =
                entry.contract.context.mode === 'fork' &&
                role &&
                forkOpening &&
                context.boundary.kind === 'job' &&
                context.boundary.definitionId === `agent/${role.configurationId}` &&
                context.boundary.definitionVersion === role.definitionVersion &&
                carrierParent?.kind === 'tool' &&
                carrierParent.runId === reference.runId &&
                carrierParent.originStoreId === reference.originStoreId &&
                carrierParent.sessionId === reference.sessionId &&
                carrierParent.definitionVersion === '1' &&
                ['activate_skill', 'repair_skill', 'decide_skill_verification'].includes(
                  carrierParent.definitionId ?? '',
                ) &&
                forkOpening.attempt === attempt &&
                forkOpening.headRevision === headRecord.revision &&
                forkOpening.carrierExecutionId === carrierParent.id &&
                forkOpening.carrierInputDigest === carrierParent.inputDigest &&
                forkOpening.carrierDefinitionId === carrierParent.definitionId &&
                forkOpening.anchorRevision === reference.revision &&
                forkOpening.configurationId === role.configurationId &&
                forkOpening.configurationVersion === role.definitionVersion;
              const verifier =
                closed &&
                verificationJob &&
                context.boundary.kind === 'job' &&
                context.boundary.definitionId === verificationJob.definitionId &&
                context.boundary.definitionVersion === verificationJob.definitionVersion &&
                carrierParent?.kind === 'tool' &&
                carrierParent.runId === reference.runId &&
                carrierParent.originStoreId === reference.originStoreId &&
                carrierParent.sessionId === reference.sessionId &&
                carrierParent.definitionVersion === '1' &&
                lifecycle.has(carrierParent.definitionId ?? '') &&
                boundaryExecution?.inputDigest ===
                  hash(
                    canonicalJson(
                      verificationJob.prepare({
                        entry,
                        activationId: string(frame.activationId),
                        attempt,
                        outputDigest: hash(canonicalJson(closed.output!)),
                        output: closed.output!,
                      }),
                    ),
                  );
              const compensator =
                closed &&
                proof &&
                (await validCompensationOpening(
                  read,
                  reference,
                  frame,
                  attempt,
                  closed,
                  proof,
                  path,
                  headRecord,
                  boundaryExecution,
                  carrierParent,
                  entry,
                ));
              const admitted =
                forkCarrier ||
                verifier ||
                compensator ||
                capabilities.some(
                  (binding) =>
                    binding.kind === context.boundary.kind &&
                    binding.definitionId === context.boundary.definitionId &&
                    binding.definitionVersion === context.boundary.definitionVersion &&
                    entry.contract.effectiveCapabilityCeiling.includes(binding.capabilityId),
                );
              return answer(
                admitted ? 'satisfied' : 'unsatisfied',
                admitted ? 'workflow_capability_allowed' : 'workflow_capability_denied',
              );
            }
            if (
              closed?.status !== 'closed' ||
              closed.attempt !== attempt ||
              closed.anchorRevision !== reference.revision ||
              closed.outputDigest !== hash(canonicalJson(closed.output!)) ||
              validateWorkflowArguments(entry.contract.outputSchema, closed.output)
            )
              return answer('unsatisfied', 'workflow_active');
            if (entry.contract.context.mode === 'fork') {
              const forkProof = closed.forkProof ? object(closed.forkProof) : null;
              const original = forkProof
                ? await read.getExecution(string(forkProof.executionId))
                : null;
              const checkpoint = decode(
                await read.records.get(`${path}/fork-operation`),
                stateType,
              );
              const operation = checkpoint ? object(checkpoint.ref) : null,
                role = forks.get(entry.contract.context.agent);
              const forkOpening = decode(await read.records.get(`${path}/fork-opening`), stateType);
              if (
                !forkProof ||
                !original ||
                !role ||
                original.status !== 'succeeded' ||
                original.originStoreId !== reference.originStoreId ||
                original.sessionId !== reference.sessionId ||
                original.kind !== 'job' ||
                original.definitionId !== `agent/${role.configurationId}` ||
                original.definitionVersion !== role.definitionVersion ||
                operation?.executionId !== original.id ||
                operation.commandId !== original.originCommandId ||
                original.parentExecutionId !== checkpoint?.parentExecutionId ||
                checkpoint?.attempt !== attempt ||
                forkOpening?.carrierExecutionId !== original.parentExecutionId ||
                forkProof.resultRevision !== original.resultRevision ||
                forkProof.outputDigest !== closed.outputDigest
              )
                return answer('unsatisfied', 'workflow_fork_unverifiable');
            }
            if (waived) return answer('waived', 'workflow_user_waiver');
            if (frame.verificationMode !== 'required')
              return answer('satisfied', 'workflow_closed');
            return answer(
              verified ? 'satisfied' : 'unsatisfied',
              verified ? 'workflow_verification_passed' : 'workflow_verification_required',
            );
          }),
        );
      },
    },
  };
  // Business refusals are known failures; an adapter's unresolved Execution remains unknown independently.
  const registered: Extension = {
    ...extension,
    tools: extension.tools!.map((tool) => ({
      ...tool,
      async execute(input, context) {
        try {
          return await tool.execute(input, context);
        } catch (error) {
          if (
            !(error instanceof AgentError) ||
            !(error.code.startsWith('workflow_') || error.code === 'record_revision_conflict')
          )
            throw error;
          return { outcome: 'failed', content: error.code, details: { code: error.code } };
        }
      },
    })),
  };
  return { extension: registered, initializeRequirements, enabled };
}
export type {
  CompiledSkillWorkflow,
  SkillWorkflowContract,
  WorkflowCapability,
} from '../../skills/workflow-contract';
export {
  compileSkillWorkflow,
  readWorkflowReference,
  revalidateSkillWorkflow,
} from '../../skills/workflow-contract';
export { validateWorkflowArguments } from '../../skills/workflow-contract/schema';
export {
  createSkillWorkflowCompensator,
  type SkillWorkflowCompensatorOptions,
} from './compensator';
export { createSkillWorkflowVerifier, type SkillWorkflowVerifierOptions } from './verifier';
