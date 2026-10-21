import { type ModelAdapter, ModelAttemptError, type ModelRequest } from '@kite-ai/ai';
import Ajv from 'ajv';
import type { ContextSource } from '../context';
import type {
  ActionContext,
  ActionDefinition,
  ArtifactRef,
  AuthorizationRequest,
  ConditionReadContext,
  Extension,
  ExtensionRecord,
  JobDefinition,
  JobHandle,
  NecessaryConditions,
  Permissions,
  StopConfirmation,
  ToolDefinition,
  ToolResult,
} from '../extensions';
import { canonicalJson, semanticDigest } from '../json';
import { bodyReference } from '../model-body';
import { type ModelOutputReference, ModelOutputWriter } from '../model-output';
import { captureModelRequestMetadata, modelMetadataJson } from '../model-snapshot';
import { createModelToolSurface, modelToolMessages } from '../model-tools';
import type { AuthorizationReviewBinding } from '../runtime';
import type { ReadAuthorizationReviewInput, Store } from '../storage/port';
import {
  AgentError,
  type CommandRecord,
  type ExecutionRecord,
  type Json,
  type OwnerRef,
  type RequirementEvaluation,
  type RequirementRecordRead,
  type RequirementRef,
  type RunRecord,
  type ToolCall,
} from '../storage/types';
import {
  type AuthorizationChangeWait,
  AuthorizationRefreshRequired,
  modeControlsChanged,
} from './authorization-refresh';
import {
  type AcceptedAuthorization,
  AuthorizationDeniedError,
  InteractionGate,
} from './interactions';
import { createProgressWriter } from './progress';
import type { ExecutionResources } from './resources';
import { type ToolDispatchAdmission, ToolDispatchCancelledError } from './tool-dispatch-admission';

export interface ModelResponse {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Json;
  executionId: string;
  finishReason?: string;
}
/** Core dispatch facts are separate from the extension-controlled ToolResult payload. */
export interface ToolExecutionResult {
  result: ToolResult;
  dispatched?: boolean;
}
/** Core-observed metadata, kept separate from an evaluator's claimed proof. */
interface RequirementObservation {
  phase: 'dispatch' | 'completion';
  references: RequirementRef[];
  records: { extensionId: string; sessionId: string; read: RequirementRecordRead }[];
  safety: {
    requirement: RequirementRef;
    read: import('../storage/types').RequirementExecutionSafetyRead;
  }[];
}
/** Only Core's own inconsistent read-set observation qualifies for a fresh read. */
/** Only the model Store dispatch gate can issue this internal completion proof. */
class InputProcessingDecidedAdmission extends AgentError {
  constructor() {
    super('input_processing_decided');
  }
}

class ConditionSnapshotChangedError extends AgentError {
  constructor() {
    super('necessary_condition_snapshot_changed');
  }
}
export interface ExecutionScope {
  /** Core-owned interpretation of one durable human input, never a business grant. */
  humanInputInterpretation?: { inputCommandId: string; inputDigest: string };
  toolAdmission?: ToolDispatchAdmission;
  modelRetry?: import('../model-attempt').ModelRetrySource;
  compressionId?: string;
  /** Core-owned state at the boundary before this replaceable Model attempt. */
  continuation?: Json;
  run: RunRecord;
  owner: OwnerRef;
  workspaceId: string;
  signal: AbortSignal;
  decisionSources?: readonly ContextSource[];
  checkFreshness?: () => Promise<void>;
  checkpoint?: () => Promise<void>;
  bindings?: ScopedBindings;
}
export interface ScopedBindings {
  readonly authorizationReview?: AuthorizationReviewBinding;
  readonly extensions: readonly Extension[];
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly jobs: ReadonlyMap<string, JobDefinition>;
  readonly permissions?: Permissions;
  readonly conditions?: NecessaryConditions;
  readonly capabilitySnapshot?: Json;
  retain(): () => Promise<void>;
}
export interface StandaloneScope {
  command: CommandRecord;
  owner: OwnerRef;
  workspaceId: string;
  signal: AbortSignal;
  parentExecutionId?: string;
  /** Actual cancellation edge sealed by the original operation Command. */
  cancelWithParent?: boolean;
  requirements?: readonly RequirementRef[];
  checkFreshness?: () => Promise<void>;
  checkpoint?: () => Promise<void>;
  bindings?: ScopedBindings;
  /** Host-sealed preparation reads and a freshly observed current dispatch predicate. */
  captureDispatchReadSet?: (
    executionId: string,
  ) => Promise<import('../storage/types').DispatchReadSet>;
}
export type ToolScope = ExecutionScope | StandaloneScope;
function identity(scope: ToolScope) {
  return 'run' in scope
    ? {
        sessionId: scope.run.sessionId,
        runId: scope.run.id,
        originStoreId: scope.run.originStoreId,
        originCommandId: scope.run.originCommandId,
      }
    : {
        sessionId: scope.command.sessionId,
        runId: null,
        originStoreId: scope.command.originStoreId,
        originCommandId: scope.command.id,
      };
}
export interface ExecutionOptions {
  waitForChange?: AuthorizationChangeWait;
  /** Internal observation after dispatch acknowledgement, before entering the adapter. */
  onModelStart?: (scope: ExecutionScope, execution: ExecutionRecord) => void;
  /** Internal post-commit observation; never a gate or an extension execution context. */
  onModelSettled?: (scope: ExecutionScope, execution: ExecutionRecord) => void;
  reviewAuthorization?: (
    scope: ToolScope,
    request: AuthorizationRequest,
    source: Json,
    decision: import('../extensions').PermissionDecision,
  ) => Promise<ReadAuthorizationReviewInput | null>;
  openModelInput?: (scope: ExecutionScope, input: Json) => Promise<ModelRequest>;
  sealModelInput?: (scope: ExecutionScope, request: ModelRequest) => Promise<Json>;
  publishModelOutput?: (
    scope: ExecutionScope,
    executionId: string,
    value: Json,
  ) => Promise<import('../storage/types').ArtifactReference>;
  sealModelMetadata?: (scope: ExecutionScope, metadata: Json) => Promise<Json>;
  sealSource?: (scope: ToolScope, source: Json) => Promise<Json>;
  sealApprovalRequest?: (scope: ToolScope, executionId: string, request: Json) => Promise<Json>;
  verifyApprovalRequest?: (
    scope: ToolScope,
    executionId: string,
    saved: Json,
    actual: Json,
  ) => Promise<void>;
  store: Store;
  permissions: Permissions;
  conditions?: NecessaryConditions;
  conditionContext?: (
    scope: ToolScope,
    reference: RequirementRef,
    onRecord: (record: ExtensionRecord | null, key: string) => void,
    boundaryExecutionId?: string,
  ) => Promise<ConditionReadContext>;
  resources: ExecutionResources;
  toolContext?: (
    scope: ToolScope,
    definition: ToolDefinition,
    executionId: string,
    source: Json,
  ) => Promise<ActionContext>;
  onLiveExecution?: (
    executionId: string,
    scope: ToolScope,
    controller: AbortController,
  ) => () => void;
  /** Core-owned local child admission. Leaf Job adapters cannot supply this authority. */
  admitJob?: (
    definition: JobDefinition,
    scope: StandaloneScope,
  ) => Promise<(() => void) | undefined>;
  validateArtifacts?: (scope: ToolScope, references: readonly ArtifactRef[]) => Promise<void>;
}

export class UnifiedExecution {
  private readonly validator = new Ajv({ allErrors: true, strict: false });
  private readonly options: ExecutionOptions;
  private readonly interactions: InteractionGate;
  private readonly authorizationReviews = new Map<string, ReadAuthorizationReviewInput>();
  private readonly authorizationDecisions = new Map<string, AcceptedAuthorization>();
  private readonly unconfirmedJobs = new Map<
    string,
    { definition: JobDefinition; handle?: JobHandle; release: () => void | Promise<void> }
  >();
  constructor(options: ExecutionOptions) {
    this.options = options;
    this.interactions = new InteractionGate(
      options.store,
      options.permissions,
      options.waitForChange,
    );
  }
  private interactionScope(scope: ToolScope, executionId: string) {
    return {
      expectedStoreId: identity(scope).originStoreId,
      owner: scope.owner,
      executionId,
      signal: scope.signal,
      requiredRefs: 'run' in scope ? scope.run.requirements : (scope.requirements ?? []),
      requirements: () => this.requirements(scope, 'dispatch', executionId),
      checkFreshness: scope.checkFreshness,
      checkpoint: scope.checkpoint,
      ...(this.options.sealApprovalRequest
        ? {
            sealApprovalRequest: (request: Json) =>
              this.options.sealApprovalRequest!(scope, executionId, request),
          }
        : {}),
      ...(this.options.verifyApprovalRequest
        ? {
            verifyApprovalRequest: (saved: Json, actual: Json) =>
              this.options.verifyApprovalRequest!(scope, executionId, saved, actual),
          }
        : {}),
    };
  }
  inputRequester(scope: ToolScope, executionId: string) {
    const request = this.interactionRequester(scope, executionId);
    return (input: Json) => request({ kind: 'question', request: input });
  }
  interactionRequester(scope: ToolScope, executionId: string) {
    return this.interactions.requester(this.interactionScope(scope, executionId));
  }
  interactionRequesterWithReceipt(scope: ToolScope, executionId: string) {
    const gate = scope.bindings?.permissions
      ? new InteractionGate(
          this.options.store,
          scope.bindings.permissions,
          this.options.waitForChange,
        )
      : this.interactions;
    return gate.informationRequester(this.interactionScope(scope, executionId));
  }
  private authorize(
    scope: ToolScope,
    request: AuthorizationRequest,
    source: Json,
    final = false,
  ): Promise<AcceptedAuthorization> {
    const gate = scope.bindings?.permissions
      ? new InteractionGate(
          this.options.store,
          scope.bindings.permissions,
          this.options.waitForChange,
        )
      : this.interactions;
    return gate
      .authorize(
        {
          ...this.interactionScope(scope, request.executionId),
          final,
          previousReview: this.authorizationReviews.get(request.executionId),
          previousPolicy: this.authorizationDecisions.get(request.executionId),
          ...(!final && this.options.reviewAuthorization
            ? {
                review: async (
                  decision: import('../extensions').PermissionDecision,
                  signal: AbortSignal,
                ) => {
                  const reference = await this.options.reviewAuthorization!(
                    { ...scope, signal },
                    { ...request, signal },
                    source,
                    decision,
                  );
                  if (reference && !signal.aborted)
                    this.authorizationReviews.set(request.executionId, reference);
                  return reference;
                },
              }
            : {}),
        },
        request,
        source,
      )
      .then((decision) => {
        this.authorizationDecisions.set(request.executionId, decision);
        const review = this.authorizationReviews.get(request.executionId);
        // An ask-user review is not a review grant. Keep its exact reference
        // after human acceptance so final dispatch can still verify the review
        // request and policy without starting another resource-bound review.
        if (
          !decision.reviewExecutionId &&
          (!decision.interactionId || review?.policyRevision !== decision.revision)
        )
          this.authorizationReviews.delete(request.executionId);
        return decision;
      });
  }
  private async liveScope<T extends ToolScope, R>(
    scope: T,
    executionId: string,
    work: (scope: T) => Promise<R>,
  ): Promise<R> {
    const controller = new AbortController();
    const abort = () => controller.abort(scope.signal.reason);
    scope.signal.addEventListener('abort', abort, { once: true });
    if (scope.signal.aborted) abort();
    const bound = { ...scope, signal: controller.signal } as T;
    const release = this.options.onLiveExecution?.(executionId, bound, controller);
    try {
      return await work(bound);
    } finally {
      this.authorizationReviews.delete(executionId);
      this.authorizationDecisions.delete(executionId);
      release?.();
      scope.signal.removeEventListener('abort', abort);
    }
  }
  async requirements(
    scope: ToolScope,
    phase: 'dispatch' | 'completion',
    executionId?: string,
    allowUnsatisfied = false,
  ): Promise<RequirementEvaluation[]> {
    return (await this.requirementEvaluation(scope, phase, executionId, allowUnsatisfied))
      .evaluations;
  }
  async requirementEvaluation(
    scope: ToolScope,
    phase: 'dispatch' | 'completion',
    executionId?: string,
    allowUnsatisfied = false,
  ): Promise<{ evaluations: RequirementEvaluation[]; observation: RequirementObservation }> {
    for (;;) {
      scope.signal.throwIfAborted();
      try {
        return await this.evaluateRequirements(scope, phase, executionId, allowUnsatisfied);
      } catch (error) {
        if (!(error instanceof ConditionSnapshotChangedError)) throw error;
        // A concurrent writer invalidated this read-only evaluation. Yield and re-read
        // current facts; never replay a Model, Tool, approval or external effect.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  private async evaluateRequirements(
    scope: ToolScope,
    phase: 'dispatch' | 'completion',
    executionId?: string,
    allowUnsatisfied = false,
  ) {
    if ('run' in scope) {
      const current = await this.options.store.getRun(scope.run.id);
      if (!current) throw new AgentError('run_not_found');
      // New obligations strengthen future boundaries; a stale in-memory Run cannot omit them.
      scope.run.requirements = current.requirements;
    }
    const references = (
      'run' in scope ? scope.run.requirements : (scope.requirements ?? [])
    ).filter((ref) => ref.phase === phase || ref.phase === 'both');
    const observedRecords = new Map<string, RequirementObservation['records'][number]>();
    const observeRecord = (reference: RequirementRef, read: RequirementRecordRead) => {
      const key = JSON.stringify([reference.extensionId, reference.sessionId, read.key]);
      const previous = observedRecords.get(key)?.read;
      if (
        previous &&
        (previous.revision !== read.revision || previous.originStoreId !== read.originStoreId)
      )
        // Different requirements can depend on the same record. Preserve every
        // dependency by restarting this pure evaluation when their snapshots differ.
        throw new ConditionSnapshotChangedError();
      observedRecords.set(key, {
        extensionId: reference.extensionId,
        sessionId: reference.sessionId,
        read: structuredClone(read),
      });
    };
    for (const reference of references) {
      scope.signal.throwIfAborted();
      const record = await this.options.store.getExtensionRecord({
        extensionId: reference.extensionId,
        sessionId: reference.sessionId,
        key: reference.recordKey,
      });
      observeRecord(reference, {
        key: reference.recordKey,
        revision: record?.revision ?? null,
        originStoreId: record?.originStoreId ?? null,
      });
    }
    if (!references.length)
      return {
        evaluations: [],
        observation: { phase, references: [], records: [], safety: [] },
      };
    const fallback = scope.bindings?.conditions ?? this.options.conditions;
    const providers = new Map(
      (scope.bindings?.extensions ?? [])
        .filter((extension) => extension.conditions)
        .map((extension) => [extension.id, extension.conditions!]),
    );
    const conditions: import('../extensions').NecessaryConditions = {
      evaluate: async (refs, stage, context) => {
        const evaluations: RequirementEvaluation[] = [];
        const remaining: RequirementRef[] = [];
        for (const namespace of new Set(
          refs
            .filter((ref) => ref.evaluationProvider === 'extension')
            .map((ref) => ref.extensionId),
        )) {
          const group = refs.filter(
            (ref) => ref.evaluationProvider === 'extension' && ref.extensionId === namespace,
          );
          const provider = providers.get(namespace);
          if (!provider) throw new AgentError('necessary_condition_implementation_missing');
          const scoped = context
            ? {
                ...context,
                forRequirement: (reference: RequirementRef) => {
                  if (
                    !group.some(
                      (ref) =>
                        canonicalJson(ref as unknown as Json) ===
                        canonicalJson(reference as unknown as Json),
                    )
                  )
                    throw new AgentError('requirement_scope_mismatch');
                  return context.forRequirement(reference);
                },
              }
            : undefined;
          evaluations.push(...(await provider.evaluate(group, stage, scoped)));
        }
        remaining.push(...refs.filter((ref) => ref.evaluationProvider !== 'extension'));
        if (remaining.length) {
          if (!fallback) throw new AgentError('necessary_condition_implementation_missing');
          evaluations.push(...(await fallback.evaluate(remaining, stage, context)));
        }
        return evaluations;
      },
    };
    if (!conditions) throw new AgentError('necessary_condition_implementation_missing');
    const referenceKey = (ref: RequirementRef) => canonicalJson(ref as unknown as Json);
    const readSets = new Map<string, Map<string, RequirementRecordRead>>();
    const safetySets = new Map<
      string,
      import('../storage/types').RequirementExecutionSafetyRead[]
    >();
    const execution = executionId ? await this.options.store.getExecution(executionId) : null;
    const work = identity(scope);
    if (executionId && (!execution || execution.sessionId !== work.sessionId))
      throw new AgentError('requirement_scope_mismatch');
    const evaluations = await conditions.evaluate(
      references,
      phase,
      this.options.conditionContext
        ? {
            boundary: Object.freeze({
              sessionId: work.sessionId,
              runId: work.runId,
              executionId: execution?.id ?? null,
              kind: execution?.kind ?? null,
              definitionId: execution?.definitionId ?? null,
              definitionVersion: execution?.definitionVersion ?? null,
              attempt: execution?.attempt ?? null,
            }),
            forRequirement: async (reference) => {
              const key = referenceKey(reference);
              if (!references.some((candidate) => referenceKey(candidate) === key))
                throw new AgentError('requirement_scope_mismatch');
              let reads = readSets.get(key);
              if (!reads) {
                reads = new Map();
                readSets.set(key, reads);
              }
              const boundary =
                execution?.kind === 'tool' && execution.runId === reference.runId
                  ? execution.id
                  : undefined;
              const prepared = await this.options.conditionContext!(
                scope,
                reference,
                (record, recordKey) => {
                  if (!reads!.has(recordKey) && reads!.size >= 64)
                    throw new AgentError('requirement_read_set_invalid');
                  const read = {
                    key: recordKey,
                    revision: record?.revision ?? null,
                    originStoreId: record?.originStoreId ?? null,
                  };
                  const previous = reads!.get(recordKey);
                  if (
                    previous &&
                    canonicalJson(previous as unknown as Json) !==
                      canonicalJson(read as unknown as Json)
                  )
                    throw new ConditionSnapshotChangedError();
                  reads!.set(recordKey, read);
                  observeRecord(reference, read);
                },
                boundary,
              );
              if (!prepared.readRunExecutionSafety) return prepared;
              return {
                ...prepared,
                readRunExecutionSafety: async (runId: string) => {
                  if (runId !== reference.runId)
                    throw new AgentError('execution_safety_scope_denied');
                  const fact = await prepared.readRunExecutionSafety!(runId);
                  const observed = {
                    runId,
                    excludedExecutionId: fact.excludedExecutionId,
                    revision: fact.revision,
                    unconfirmed: fact.unconfirmed,
                  };
                  const prior = safetySets.get(key)?.[0];
                  if (
                    prior &&
                    canonicalJson(prior as unknown as Json) !==
                      canonicalJson(observed as unknown as Json)
                  )
                    throw new ConditionSnapshotChangedError();
                  safetySets.set(key, [observed]);
                  return fact;
                },
              };
            },
          }
        : undefined,
    );
    if (
      evaluations.length !== references.length ||
      evaluations.some(
        (item) =>
          !(
            allowUnsatisfied && phase === 'completion'
              ? ['satisfied', 'waived', 'unsatisfied']
              : ['satisfied', 'waived']
          ).includes(item.outcome),
      )
    )
      throw new AgentError('necessary_condition_unsatisfied');
    const prepared = evaluations.map((original) => {
      const safety = safetySets.get(referenceKey(original.requirement));
      if (
        original.executionSafetyReads !== undefined &&
        canonicalJson(original.executionSafetyReads as unknown as Json) !==
          canonicalJson((safety ?? []) as unknown as Json)
      )
        throw new AgentError('requirement_read_set_invalid');
      const evaluation = safety ? { ...original, executionSafetyReads: safety } : original;
      const reads = readSets.get(referenceKey(evaluation.requirement));
      if (!reads?.size) return evaluation;
      const merged = new Map(reads);
      for (const read of evaluation.recordReads ?? []) {
        const actual = merged.get(read.key);
        if (
          actual &&
          canonicalJson(actual as unknown as Json) !== canonicalJson(read as unknown as Json)
        )
          throw new AgentError('necessary_condition_snapshot_changed');
        merged.set(read.key, read);
      }
      return { ...evaluation, recordReads: [...merged.values()] };
    });
    return {
      evaluations: prepared,
      observation: {
        phase,
        references: structuredClone(references),
        records: [...observedRecords.values()],
        safety: references.flatMap((requirement) =>
          (safetySets.get(referenceKey(requirement)) ?? []).map((read) => ({
            requirement: structuredClone(requirement),
            read: structuredClone(read),
          })),
        ),
      },
    };
  }
  async requirementsChanged(
    scope: ToolScope,
    observation: RequirementObservation,
  ): Promise<boolean> {
    const work = identity(scope);
    if ('run' in scope) {
      const current = await this.options.store.getRun(scope.run.id);
      const refs = (current?.requirements ?? []).filter(
        (ref) => ref.phase === observation.phase || ref.phase === 'both',
      );
      const keys = (values: RequirementRef[]) =>
        values.map((value) => canonicalJson(value as unknown as Json)).sort();
      if (canonicalJson(keys(refs)) !== canonicalJson(keys(observation.references))) return true;
    }
    for (const { extensionId, sessionId, read } of observation.records) {
      scope.signal.throwIfAborted();
      const current = await this.options.store.getExtensionRecord({
        extensionId,
        sessionId,
        key: read.key,
      });
      if (
        (current?.revision ?? null) !== read.revision ||
        (current?.originStoreId ?? null) !== read.originStoreId
      )
        return true;
    }
    const command = observation.safety.length
      ? await this.options.store.getCommand(work.originCommandId)
      : null;
    for (const { requirement, read } of observation.safety) {
      scope.signal.throwIfAborted();
      if (!command) throw new AgentError('command_not_found');
      const current = await this.options.store.readRunExecutionSafety({
        expectedStoreId: work.originStoreId,
        sessionId: requirement.sessionId,
        subjectId: command.subjectId,
        runId: requirement.runId,
        ...(read.excludedExecutionId ? { excludeExecutionId: read.excludedExecutionId } : {}),
      });
      if (current.revision !== read.revision || current.unconfirmed !== read.unconfirmed)
        return true;
    }
    return false;
  }
  private async prepare(
    scope: ToolScope,
    input: {
      executionId: string;
      stepId: string;
      callId: string;
      kind: 'model' | 'tool' | 'job';
      definitionId: string;
      definitionVersion: string;
      input: Json;
      decisionSource: Json;
      modelMetadata?: Json;
      cancelWithParent?: boolean;
    },
  ) {
    const work = identity(scope);
    return this.options.store.planExecution({
      ...input,
      expectedStoreId: work.originStoreId,
      owner: scope.owner,
      sessionId: work.sessionId,
      runId: work.runId,
      originCommandId: work.originCommandId,
      ...(!('run' in scope) && scope.parentExecutionId
        ? { parentExecutionId: scope.parentExecutionId }
        : {}),
      ...(!('run' in scope) && scope.cancelWithParent !== undefined
        ? { cancelWithParent: scope.cancelWithParent }
        : {}),
    });
  }
  /** Reacquire only before dispatch; completed/unknown effects never enter this loop. */
  private async acquireDispatch(
    scope: ToolScope,
    executionId: string,
    definitionId: string,
    definitionVersion: string,
    input: Json,
    source: Json,
    resources: Parameters<ExecutionResources['acquire']>[0],
    kind: AuthorizationRequest['kind'] = 'tool',
    onStoreCancellation?: () => void,
    admit?: (signal: AbortSignal) => Promise<(() => void) | undefined>,
  ) {
    const work = identity(scope);
    for (;;) {
      const cursor = (await this.options.store.getMetadata()).lastChangeCursor;
      const request = {
        kind,
        sessionId: work.sessionId,
        runId: work.runId,
        executionId,
        definitionId,
        definitionVersion,
        input,
        signal: scope.signal,
      };
      const decision = await this.authorize(scope, request, source);
      let releaseAdmission: (() => void) | undefined;
      let releaseResources: (() => void) | undefined;
      const release = () => {
        releaseResources?.();
        releaseResources = undefined;
        releaseAdmission?.();
        releaseAdmission = undefined;
      };
      try {
        const controller = new AbortController();
        const abort = () => controller.abort(scope.signal.reason);
        scope.signal.addEventListener('abort', abort, { once: true });
        if (scope.signal.aborted) abort();
        const gate = new InteractionGate(
          this.options.store,
          scope.bindings?.permissions ?? this.options.permissions,
          this.options.waitForChange,
        );
        try {
          await Promise.race([
            (async () => {
              releaseAdmission = await admit?.(controller.signal);
              controller.signal.throwIfAborted();
              releaseResources = await this.options.resources.acquire(
                resources,
                { sessionId: work.sessionId, workspaceId: scope.workspaceId },
                controller.signal,
              );
              if (controller.signal.aborted) {
                release();
                controller.signal.throwIfAborted();
              }
            })().catch((error) => {
              release();
              throw error;
            }),
            gate.policyChanged(
              { ...this.interactionScope(scope, executionId), signal: controller.signal },
              { ...request, signal: controller.signal },
              decision,
              cursor,
            ),
          ]);
        } finally {
          controller.abort();
          scope.signal.removeEventListener('abort', abort);
        }
        const authorization = await this.dispatch(
          scope,
          executionId,
          definitionId,
          definitionVersion,
          input,
          source,
          kind,
          onStoreCancellation,
        );
        return { release, authorization };
      } catch (error) {
        release();
        if (
          kind === 'job' &&
          'command' in scope &&
          error instanceof AgentError &&
          ['input_unresolved', 'work_not_selected', 'work_paused'].includes(error.code) &&
          this.options.waitForChange
        ) {
          const execution = await this.options.store.getExecution(executionId);
          // Only Core-managed, never-dispatched child carriers have this retry boundary.
          // A work selection defers new effects; it does not retire an accepted assignment.
          if (execution?.childSessionId && execution.status === 'planned') {
            for (;;) {
              scope.signal.throwIfAborted();
              const state = await this.options.store.readHumanWorkEligibility({
                expectedStoreId: work.originStoreId,
                sessionId: execution.sessionId,
                subjectId: scope.command.subjectId,
                rootWorkCommandId: execution.rootWorkCommandId,
                rootWorkSeq: execution.rootWorkSeq,
              });
              if (state.state === 'eligible') break;
              if (
                !['input_unresolved', 'work_not_selected', 'work_paused'].includes(
                  state.reason ?? '',
                )
              ) {
                const current = await this.options.store.getExecution(executionId);
                if (!current?.cancelRequestedAt)
                  throw new AgentError(state.reason ?? 'human_work_blocked');
                // Let the ordinary live-execution cancellation watcher settle its
                // exact original scope; a revoked selection alone is not cancellation.
              }
              await this.options.waitForChange(state.cursor, scope.signal, 30000);
            }
            this.authorizationReviews.delete(executionId);
            this.authorizationDecisions.delete(executionId);
            continue;
          }
        }
        if (
          !(error instanceof AgentError) ||
          !['authorization_refresh_required', 'permission_control_changed'].includes(error.code)
        )
          throw error;
        if (
          error.code === 'authorization_refresh_required' &&
          !(error instanceof AuthorizationRefreshRequired)
        )
          throw error;
        const current = await this.options.store.getExecution(executionId);
        if (current?.status !== 'planned') throw error;
        if (error.code === 'permission_control_changed') {
          const refreshed = await (
            scope.bindings?.permissions ?? this.options.permissions
          ).authorize(request);
          // Re-reading a revision is not a new policy decision. Trust revocation and
          // opaque/static injected policies retain the original fail-closed boundary.
          if (
            !modeControlsChanged(decision.controlReads, refreshed.controlReads) ||
            refreshed.revision === decision.revision
          )
            throw error;
        }
        this.authorizationReviews.delete(executionId);
        this.authorizationDecisions.delete(executionId);
        scope.signal.throwIfAborted();
      }
    }
  }

  private async dispatch(
    scope: ToolScope,
    executionId: string,
    definitionId: string,
    definitionVersion: string,
    input: Json,
    source: Json,
    kind: AuthorizationRequest['kind'] = 'tool',
    onStoreCancellation?: () => void,
  ) {
    const work = identity(scope);
    scope.signal.throwIfAborted();
    const request: AuthorizationRequest = {
      kind,
      sessionId: work.sessionId,
      runId: work.runId,
      executionId,
      definitionId,
      definitionVersion,
      input:
        kind === 'model' && 'run' in scope && this.options.openModelInput
          ? (JSON.parse(JSON.stringify(await this.options.openModelInput(scope, input))) as Json)
          : input,
      signal: scope.signal,
    };
    const decision = await this.authorize(scope, request, source, true);
    const controlReads =
      decision.controlReads === undefined ? undefined : structuredClone(decision.controlReads);
    const requirements = await this.requirements(scope, 'dispatch', executionId);
    await scope.checkFreshness?.();
    scope.signal.throwIfAborted();
    const readSet =
      'captureDispatchReadSet' in scope
        ? await scope.captureDispatchReadSet?.(executionId)
        : undefined;
    scope.signal.throwIfAborted();
    const dispatchInput = {
      expectedStoreId: work.originStoreId,
      owner: scope.owner,
      executionId,
      ...(readSet === undefined ? {} : { readSet }),
      authorization: {
        ...(decision.grant === undefined ? {} : { grant: structuredClone(decision.grant) }),
        ...(decision.snapshot === undefined
          ? {}
          : { snapshot: structuredClone(decision.snapshot) }),
        ...(controlReads === undefined ? {} : { controlReads }),
        allowed: true,
        revision: decision.revision,
        definitionVersion,
        inputDigest: await semanticDigest(input),
        ...(decision.reviewExecutionId ? { reviewExecutionId: decision.reviewExecutionId } : {}),
        ...(decision.interactionId
          ? { interactionId: decision.interactionId, decisionRevision: decision.decisionRevision }
          : {}),
      },
      requirements,
      freshness: { checked: true, source },
    } satisfies Parameters<Store['markDispatching']>[0];
    try {
      await this.options.store.markDispatching(dispatchInput);
    } catch (error) {
      if (error instanceof AgentError && error.code === 'cancelled_before_dispatch')
        onStoreCancellation?.();
      if (
        kind === 'model' &&
        error instanceof AgentError &&
        error.code === 'input_processing_decided'
      )
        throw new InputProcessingDecidedAdmission();
      throw error;
    }
    return {
      revision: decision.revision,
      ...(decision.snapshot === undefined ? {} : { snapshot: structuredClone(decision.snapshot) }),
    };
  }
  async model(
    scope: ExecutionScope,
    model: ModelAdapter,
    request: ModelRequest,
    stepId: string,
    planned?: ExecutionRecord,
  ): Promise<ModelResponse> {
    return this.liveScope(scope, request.requestId, (bound) =>
      this.performModel(bound, model, request, stepId, planned),
    );
  }
  private async performModel(
    scope: ExecutionScope,
    model: ModelAdapter,
    request: ModelRequest,
    stepId: string,
    planned?: ExecutionRecord,
  ): Promise<ModelResponse> {
    const surface = createModelToolSurface(request, scope.bindings?.tools ?? new Map());
    const executionId = request.requestId;
    const input = planned
      ? structuredClone(planned.input)
      : this.options.sealModelInput
        ? await this.options.sealModelInput(scope, request)
        : (JSON.parse(JSON.stringify(request)) as Json);
    let source: Json = planned
      ? structuredClone(planned.decisionSource)
      : {
          kind: 'model_request',
          ...(scope.humanInputInterpretation
            ? { humanInputInterpretation: { ...scope.humanInputInterpretation } }
            : {}),
          ...(scope.modelRetry ? { retry: { ...scope.modelRetry } } : {}),
          ...(scope.compressionId ? { compressionId: scope.compressionId } : {}),
          ...(scope.continuation ? { continuation: scope.continuation } : {}),
          requestId: executionId,
          sourceIds: request.messages.flatMap((message) => message.sourceIds ?? []),
          sources: JSON.parse(JSON.stringify(scope.decisionSources ?? [])) as Json,
          toolBindings: request.tools.flatMap((tool) => {
            const extension = scope.bindings?.extensions.find((candidate) =>
              candidate.tools?.some(
                (definition) =>
                  definition.id === tool.id && definition.version === tool.definitionVersion,
              ),
            );
            return extension
              ? [{ id: tool.id, version: tool.definitionVersion, extensionId: extension.id }]
              : [];
          }),
          ...(scope.bindings?.capabilitySnapshot === undefined
            ? {}
            : { capabilitySnapshot: scope.bindings.capabilitySnapshot }),
        };
    if (!planned && this.options.sealSource) source = await this.options.sealSource(scope, source);
    let execution = planned;
    if (!planned) {
      const capturedMetadata = modelMetadataJson(
        await captureModelRequestMetadata(
          scope,
          model,
          request,
          surface.changed ? surface.request : undefined,
        ),
      );
      const modelMetadata = this.options.sealModelMetadata
        ? await this.options.sealModelMetadata(scope, capturedMetadata)
        : capturedMetadata;
      execution = await this.prepare(scope, {
        executionId,
        stepId,
        callId: executionId,
        kind: 'model',
        modelMetadata,
        definitionId: request.modelId,
        definitionVersion: '1',
        input,
        decisionSource: source,
      });
    }
    let release: (() => void) | undefined;
    let dispatched = false;
    let cancelledByStoreAdmission = false;
    let content = '';
    let reasoning = '';
    let firstOutput: 'content' | 'reasoning' | 'tool_calls' | undefined;
    const calls: ToolCall[] = [];
    let output: ModelOutputWriter | undefined;
    const preview = () => content.slice(0, 4096);
    const partial = async (ref: ModelOutputReference) => {
      await this.options.store.persistModelPartial({
        expectedStoreId: scope.run.originStoreId,
        owner: scope.owner,
        executionId,
        content: preview(),
        ...(firstOutput ? { firstOutput } : {}),
        modelOutput: ref,
      });
    };
    const activateOutput = async () => {
      if (!this.options.publishModelOutput) throw new AgentError('artifact_content_unavailable');
      const command = await this.options.store.getCommand(scope.run.originCommandId);
      if (!command) throw new AgentError('command_not_found');
      output = new ModelOutputWriter(
        {
          storeId: scope.run.originStoreId,
          sessionId: scope.run.sessionId,
          subjectId: command.subjectId,
          executionId,
        },
        (value) => this.options.publishModelOutput!(scope, executionId, value),
        partial,
      );
      await output.text('text', content);
      await output.text('reasoning', reasoning);
      for (const call of calls) await output.call(call);
    };
    let finish: { reason: string; usage: Json; continuation?: Json } | undefined;
    let recordedUsage: Json | undefined;
    try {
      const actualRequest = this.options.openModelInput
        ? await this.options.openModelInput(scope, input)
        : request;
      scope.signal.throwIfAborted();
      const acquired = await this.acquireDispatch(
        scope,
        executionId,
        request.modelId,
        '1',
        input,
        source,
        { slot: 'model' },
        'model',
        () => {
          cancelledByStoreAdmission = true;
        },
      );
      release = acquired.release;
      dispatched = true;
      scope.signal.throwIfAborted();
      try {
        this.options.onModelStart?.(scope, execution!);
      } catch {
        // Observation cannot change dispatch admission or the actual Model outcome.
      }
      let savedLength = 0;
      let savedAt = Date.now();
      const modelRequest = {
        ...actualRequest,
        tools: surface.tools,
        messages: modelToolMessages(actualRequest.messages),
      };
      for await (const event of model.stream(modelRequest, { signal: scope.signal })) {
        if (finish) throw new AgentError('model_event_after_finish');
        if (event.type === 'usage') recordedUsage = structuredClone({ ...event.usage });
        scope.signal.throwIfAborted();
        if (event.type === 'usage') {
          continue;
        } else if (event.type === 'text_delta') {
          if (event.text.length) firstOutput ??= 'content';
          content += event.text;
          if (output) await output.text('text', event.text);
        } else if (event.type === 'reasoning_delta') {
          if (event.text.length) firstOutput ??= 'reasoning';
          reasoning += event.text;
          if (output) await output.text('reasoning', event.text);
        } else if (event.type === 'tool_call') {
          firstOutput ??= 'tool_calls';
          const call = surface.decode(event);
          calls.push(call);
          if (output) await output.call(call);
        } else {
          recordedUsage = structuredClone({ ...event.usage });
          finish = {
            reason: event.reason,
            usage: recordedUsage,
            ...(event.continuation === undefined
              ? {}
              : { continuation: structuredClone(event.continuation) }),
          };
        }
        if (
          !output &&
          Buffer.byteLength(content) +
            Buffer.byteLength(reasoning) +
            calls.reduce((sum, call) => sum + Buffer.byteLength(call.arguments), 0) >
            64 * 1024
        )
          await activateOutput();
        if (
          !output &&
          ((savedLength === 0 && content.length + reasoning.length > 0) ||
            content.length + reasoning.length - savedLength >= 32768 ||
            Date.now() - savedAt >= 100)
        ) {
          await this.options.store.persistModelPartial({
            expectedStoreId: scope.run.originStoreId,
            owner: scope.owner,
            executionId,
            content,
            reasoning,
            ...(firstOutput ? { firstOutput } : {}),
          });
          savedLength = content.length + reasoning.length;
          savedAt = Date.now();
        }
      }
      if (!finish || finish.reason === 'cancelled')
        throw new AgentError('model_response_incomplete');
      if (finish.reason === 'length' && scope.compressionId)
        throw new AgentError('model_response_incomplete');
      // A truncated tool batch cannot prove that all call arguments were received.
      // Retrying the Model is safe because none of these calls has been dispatched.
      if (finish.reason === 'length' && (calls.length || !content.trim()))
        throw new ModelAttemptError('stream_incomplete');
      if (new Set(calls.map((call) => call.id)).size !== calls.length)
        throw new AgentError('duplicate_tool_call_id');
      if (finish.continuation !== undefined) {
        if (!output) await activateOutput();
        await output!.continuation(finish.continuation);
      }
      const settled = await this.options.store.finishExecution({
        expectedStoreId: scope.run.originStoreId,
        owner: scope.owner,
        executionId,
        status: 'succeeded',
        result: {
          content: output ? preview() : content,
          reasoning: output ? '' : reasoning,
          ...(firstOutput ? { firstOutput } : {}),
          toolCalls: output ? [] : calls.map((call) => ({ ...call })),
          ...(output ? { modelOutput: output.descriptor(true) as unknown as Json } : {}),
          usage: finish.usage,
          finishReason: finish.reason,
          ...(input &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          bodyReference(input.body)
            ? { modelInputBodyHash: bodyReference(input.body)!.reference.hash }
            : {}),
        },
        message: {
          role: 'assistant',
          ...(firstOutput ? { firstOutput } : {}),
          content: output ? preview() : content,
          toolCalls: output ? [] : calls,
          sourceIds: [executionId],
          ...(output ? { modelOutput: output.descriptor(true)! } : {}),
        },
      });
      this.modelSettled(scope, settled);
      return {
        content,
        reasoning,
        toolCalls: calls,
        usage: finish.usage,
        executionId,
        finishReason: finish.reason,
      };
    } catch (error) {
      if (dispatched && (content || reasoning) && !output)
        await this.options.store
          .persistModelPartial({
            expectedStoreId: scope.run.originStoreId,
            owner: scope.owner,
            executionId,
            content,
            reasoning,
            ...(firstOutput ? { firstOutput } : {}),
          })
          .catch(() => {});
      const settled = await this.options.store
        .finishExecution({
          expectedStoreId: scope.run.originStoreId,
          owner: scope.owner,
          executionId,
          status: scope.signal.aborted || cancelledByStoreAdmission ? 'cancelled' : 'failed',
          result: {
            code:
              error instanceof AgentError
                ? error.code
                : ModelAttemptError.isInstance(error)
                  ? error.message
                  : 'model_failed',
            incomplete: true,
            // Core-local dispatch proof, never a field supplied by the Adapter.
            ...(error instanceof InputProcessingDecidedAdmission && !dispatched
              ? { dispatchCommitted: false }
              : {}),
            ...(recordedUsage === undefined ? {} : { usage: recordedUsage }),
            content: output ? preview() : content.slice(0, 64 * 1024),
            reasoning: output ? '' : reasoning.slice(0, 64 * 1024),
            ...(firstOutput ? { firstOutput } : {}),
            ...(output?.descriptor()
              ? { modelOutput: output.descriptor() as unknown as Json }
              : {}),
          },
        })
        .catch(() => {});
      if (settled) this.modelSettled(scope, settled);
      throw error;
    } finally {
      release?.();
    }
  }
  private modelSettled(scope: ExecutionScope, execution: ExecutionRecord): void {
    try {
      this.options.onModelSettled?.(scope, execution);
    } catch {
      // A committed result cannot be downgraded by non-authoritative observation.
    }
  }
  async tool(
    scope: ToolScope,
    definition: ToolDefinition | undefined,
    call: ToolCall,
    stepId: string,
    sourceExecutionId: string,
    decisionSource?: Json,
    planned?: ExecutionRecord,
  ): Promise<ToolResult> {
    return (
      await this.toolExecution(
        scope,
        definition,
        call,
        stepId,
        sourceExecutionId,
        decisionSource,
        planned,
      )
    ).result;
  }
  async toolExecution(
    scope: ToolScope,
    definition: ToolDefinition | undefined,
    call: ToolCall,
    stepId: string,
    sourceExecutionId: string,
    decisionSource?: Json,
    planned?: ExecutionRecord,
  ): Promise<ToolExecutionResult> {
    const executionId = planned?.id ?? crypto.randomUUID();
    let outcome: ToolExecutionResult | undefined, failure: unknown;
    try {
      outcome = await this.liveScope(scope, executionId, (bound) =>
        this.performTool(
          bound,
          definition,
          call,
          stepId,
          sourceExecutionId,
          executionId,
          planned?.decisionSource ?? decisionSource,
          planned,
        ),
      );
      return outcome;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if ('run' in scope)
        scope.toolAdmission?.settled(outcome?.result, failure, outcome?.dispatched);
    }
  }
  private async performTool(
    scope: ToolScope,
    definition: ToolDefinition | undefined,
    call: ToolCall,
    stepId: string,
    sourceExecutionId: string,
    executionId: string,
    decisionSource?: Json,
    planned?: ExecutionRecord,
  ): Promise<ToolExecutionResult> {
    const work = identity(scope);
    let source: Json = decisionSource ?? {
      kind: 'model_decision',
      modelExecutionId: sourceExecutionId,
      sources: JSON.parse(
        JSON.stringify('run' in scope ? (scope.decisionSources ?? []) : []),
      ) as Json,
    };
    if (!planned && definition?.recovery && definition.resume)
      source = {
        ...(source as Record<string, Json>),
        toolRecoveryVersion: definition.recovery.version,
      };
    if (!planned && this.options.sealSource) source = await this.options.sealSource(scope, source);
    let input: Json;
    try {
      input = JSON.parse(call.arguments) as Json;
    } catch {
      return {
        result: await this.recordRejectedTool(
          scope,
          executionId,
          call,
          stepId,
          source,
          null,
          'invalid_tool_arguments',
        ),
        dispatched: false,
      };
    }
    if (call.model?.error)
      return {
        result: await this.recordRejectedTool(
          scope,
          executionId,
          call,
          stepId,
          source,
          input,
          call.model.error,
          definition?.version,
        ),
        dispatched: false,
      };
    if (!definition)
      return {
        result: await this.recordRejectedTool(
          scope,
          executionId,
          call,
          stepId,
          source,
          input,
          'tool_not_available',
        ),
        dispatched: false,
      };
    if (!this.validator.compile(definition.inputSchema)(input))
      return {
        result: await this.recordRejectedTool(
          scope,
          executionId,
          call,
          stepId,
          source,
          input,
          'invalid_tool_arguments',
          definition.version,
        ),
        dispatched: false,
      };
    const resuming = planned && ['dispatching', 'running'].includes(planned.status);
    const continued = resuming ? await this.options.store.getExecution(executionId) : undefined;
    if (
      resuming &&
      (!definition.resume ||
        !definition.recovery?.version ||
        (source as Record<string, Json>).toolRecoveryVersion !== definition.recovery.version ||
        continued?.ownerGeneration !== scope.owner.generation ||
        continued.status !== planned.status)
    )
      throw new AgentError('tool_continuation_unavailable');
    const execution = resuming
      ? continued!
      : await this.prepare(scope, {
          executionId,
          stepId,
          callId: call.id,
          kind: 'tool',
          definitionId: definition.id,
          definitionVersion: definition.version,
          input,
          decisionSource: source,
        });
    if (!('run' in scope)) scope = { ...scope, requirements: execution.requirements };
    let release: (() => void) | undefined;
    let dispatched = Boolean(resuming);
    let attempted = false;
    let result: ToolResult;
    const progress = createProgressWriter((content) =>
      this.options.store.appendExecutionOutput({
        expectedStoreId: work.originStoreId,
        owner: scope.owner,
        executionId,
        stream: 'progress',
        content,
      }),
    );
    try {
      if ('run' in scope) await scope.toolAdmission?.wait();
      if (!resuming) {
        const references =
          'run' in scope
            ? (await this.options.store.getRun(scope.run.id))?.requirements
            : scope.requirements;
        for (const extension of scope.bindings?.extensions ?? []) {
          const governance = extension.mutationGovernance;
          if (
            !governance?.definitions.some(
              (value) => value.id === definition.id && value.version === definition.version,
            )
          )
            continue;
          const reference = references?.find(
            (ref) =>
              ref.extensionId === extension.id && ref.requirementId === governance.requirementId,
          );
          if (!reference) throw new AgentError('mutation_policy_missing');
          await this.options.store.registerMutationIntent({
            expectedStoreId: work.originStoreId,
            owner: scope.owner,
            executionId,
            requirement: reference,
            descriptor: await governance.describe({
              definitionId: definition.id,
              definitionVersion: definition.version,
              input: structuredClone(input),
            }),
          });
        }
      }
      let dispatchAuthorization: Awaited<ReturnType<UnifiedExecution['dispatch']>> | undefined;
      if (resuming)
        release = await this.options.resources.acquire(
          definition.resources,
          { sessionId: work.sessionId, workspaceId: scope.workspaceId },
          scope.signal,
        );
      else {
        const acquired = await this.acquireDispatch(
          scope,
          executionId,
          definition.id,
          definition.version,
          input,
          source,
          definition.resources,
        );
        release = acquired.release;
        dispatchAuthorization = acquired.authorization;
      }
      dispatched = true;
      if ('run' in scope) scope.toolAdmission?.dispatched();
      scope.signal.throwIfAborted();
      const context = this.options.toolContext
        ? await this.options.toolContext(scope, definition, executionId, source)
        : this.unavailableContext(work.sessionId, executionId, scope.signal);
      attempted = true;
      const requestInteractionWithReceipt = this.interactionRequesterWithReceipt(
        scope,
        executionId,
      );
      const requestInteraction = async (input: {
        kind: 'question' | 'plan_review';
        request: Json;
      }) => {
        const { answer } = await requestInteractionWithReceipt(input);
        return answer.kind === 'question' ? answer.answers : (answer as unknown as Json);
      };
      result = await (resuming ? definition.resume! : definition.execute).call(definition, input, {
        ...context,
        dispatchAuthorization,
        runId: work.runId,
        reportProgress: progress.report,
        requestInput: (request) => requestInteraction({ kind: 'question', request }),
        requestInteraction,
        requestInteractionWithReceipt,
      });
      if (
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(result.outcome) ||
        typeof result.content !== 'string'
      )
        throw new AgentError('invalid_tool_result');
      if (result.modelContent) {
        if (
          result.modelContent.kind !== 'artifact' ||
          result.modelContent.encoding !== 'utf-8' ||
          !this.options.validateArtifacts
        )
          throw new AgentError('model_content_invalid');
        await this.options.validateArtifacts(scope, [result.modelContent.reference]);
      }
      if (result.artifactRefs?.length) {
        if (!this.options.validateArtifacts)
          throw new AgentError('artifact_references_unavailable');
        await this.options.validateArtifacts(scope, result.artifactRefs);
      }
    } catch (error) {
      result = {
        outcome: attempted
          ? 'outcome_unknown'
          : error instanceof AgentError && error.code === 'approval_denied'
            ? 'failed'
            : error instanceof AgentError && error.code === 'superseded_by_user_input'
              ? 'cancelled'
              : scope.signal.aborted
                ? 'cancelled'
                : 'failed',
        content:
          !attempted &&
          !dispatched &&
          error instanceof AuthorizationDeniedError &&
          error.reason === 'plan_approval_required'
            ? 'Plan mode is read-only. This Tool was not dispatched. No file was written by this call.'
            : error instanceof ToolDispatchCancelledError
              ? error.code
              : error instanceof AgentError
                ? error.code
                : 'tool_failed',
        details: {
          code:
            error instanceof AgentError || error instanceof ToolDispatchCancelledError
              ? error.code
              : 'tool_failed',
          dispatchCommitted: dispatched,
          adapterAttempted: attempted,
          ...(error instanceof AuthorizationDeniedError ? { reason: error.reason } : {}),
        },
      };
    }
    const progressFailure = await progress.finish();
    try {
      if (
        result.content === 'input_pending' ||
        result.content === 'superseded_by_user_input' ||
        result.content === 'cancelled_before_dispatch'
      ) {
        await scope.checkpoint?.();
        const stored = await this.options.store.getExecution(executionId);
        if (
          stored?.status === 'cancelled' &&
          stored.result &&
          typeof stored.result === 'object' &&
          !Array.isArray(stored.result) &&
          stored.result.content === 'superseded_by_user_input'
        )
          return {
            result: stored.result as unknown as ToolResult,
            dispatched: stored.authorization?.dispatched,
          };
      }
      await this.options.store.finishExecution({
        expectedStoreId: work.originStoreId,
        owner: scope.owner,
        executionId,
        status: result.outcome,
        result: {
          ...JSON.parse(JSON.stringify(result)),
          ...(progressFailure
            ? { progressPersistence: { state: 'failed', code: progressFailure } }
            : {}),
        } as Json,
        ...(work.runId
          ? {
              message: {
                role:
                  decisionSource &&
                  typeof decisionSource === 'object' &&
                  !Array.isArray(decisionSource) &&
                  decisionSource.kind === 'completion_decision'
                    ? ('user' as const)
                    : ('tool' as const),
                content:
                  decisionSource &&
                  typeof decisionSource === 'object' &&
                  !Array.isArray(decisionSource) &&
                  decisionSource.kind === 'completion_decision'
                    ? `<execution_result trust="untrusted" executionId="${executionId}">${result.content}</execution_result>`
                    : result.content,
                ...(decisionSource &&
                typeof decisionSource === 'object' &&
                !Array.isArray(decisionSource) &&
                decisionSource.kind === 'completion_decision'
                  ? {}
                  : { toolCallId: call.id }),
                sourceIds: [executionId],
              },
            }
          : {}),
      });
      return { result, dispatched };
    } finally {
      release?.();
    }
  }
  private unavailableContext(
    sessionId: string,
    executionId: string,
    signal: AbortSignal,
  ): ActionContext {
    const unavailable = async (): Promise<never> => {
      throw new AgentError('scoped_operations_unavailable');
    };
    return {
      sessionId,
      executionId,
      signal,
      getRun: unavailable,
      getExecution: unavailable,
      records: { get: unavailable, list: unavailable, write: unavailable },
      operations: {
        ensure: unavailable,
        get: unavailable,
        readAgent: unavailable,
        sendAgentInput: unavailable,
        readOutput: unavailable,
        wait: unavailable,
        waitAny: unavailable,
        cancel: unavailable,
      },
    };
  }
  /** The operation was durably created before this method. Its promise covers the actual lifetime. */
  async job(
    scope: StandaloneScope,
    input: {
      executionId: string;
      definition: JobDefinition;
      request: Json;
      source: Json;
      cancelWithParent: boolean;
      resumedChild?: JobHandle | 'activation';
    },
  ): Promise<void> {
    return this.liveScope(scope, input.executionId, (bound) => this.performJob(bound, input));
  }
  private async performJob(
    scope: StandaloneScope,
    input: {
      executionId: string;
      definition: JobDefinition;
      request: Json;
      source: Json;
      cancelWithParent: boolean;
      resumedChild?: JobHandle | 'activation';
    },
  ): Promise<void> {
    const { executionId, definition } = input;
    const existing = await this.options.store.getExecution(executionId);
    if (!existing) throw new AgentError('execution_not_found');
    scope = { ...scope, requirements: existing.requirements };
    if (input.resumedChild && input.resumedChild !== 'activation') {
      const reference = input.resumedChild.reference as Record<string, Json>;
      const run =
        typeof reference.runId === 'string' && (await this.options.store.getRun(reference.runId));
      if (
        existing.kind !== 'job' ||
        !existing.childSessionId ||
        !run ||
        !['dispatching', 'running'].includes(existing.status) ||
        existing.ownerGeneration !== scope.owner.generation ||
        existing.definitionId !== definition.id ||
        existing.definitionVersion !== definition.version ||
        reference.kind !== 'child_session' ||
        reference.childSessionId !== existing.childSessionId ||
        run.originCommandId !== `child-start-${existing.id}` ||
        reference.commandId !== run.originCommandId ||
        run.sessionId !== existing.childSessionId ||
        canonicalJson(existing.input) !== canonicalJson(input.request) ||
        (existing.reference !== null &&
          canonicalJson(existing.reference) !== canonicalJson(input.resumedChild.reference))
      )
        throw new AgentError('child_recovery_changed');
    } else if (input.resumedChild === 'activation') {
      if (
        existing.kind !== 'job' ||
        !existing.childSessionId ||
        existing.status !== 'dispatching' ||
        existing.ownerGeneration !== scope.owner.generation ||
        existing.definitionId !== definition.id ||
        existing.definitionVersion !== definition.version ||
        existing.reference !== null
      )
        throw new AgentError('child_recovery_changed');
    } else
      await this.prepare(scope, {
        executionId,
        stepId: `operation-${scope.command.id}`,
        callId: scope.command.id,
        kind: 'job',
        definitionId: definition.id,
        definitionVersion: definition.version,
        input: input.request,
        decisionSource: input.source,
        cancelWithParent: input.cancelWithParent,
      });
    let release: (() => void | Promise<void>) | undefined;
    let handle: JobHandle | undefined =
      input.resumedChild && input.resumedChild !== 'activation' ? input.resumedChild : undefined;
    let attempted = Boolean(handle);
    let observedTerminal = false;
    let supervisionEnded = false;
    let confirmation: StopConfirmation | undefined;
    let cancellation: Promise<void> | undefined;
    let result: ToolResult | undefined;
    const cancel = () => {
      if (!handle || cancellation) return;
      cancellation = definition.cancel(handle).then(
        (value) => {
          confirmation = value;
        },
        () => {
          confirmation = { status: 'unknown' };
        },
      );
    };
    const observe = async (terminalOnly = false) => {
      if (!handle) throw new AgentError('child_handle_unavailable');
      for await (const event of definition.observe(handle)) {
        if (observedTerminal) throw new AgentError('job_event_after_terminal');
        if (event.type === 'terminal') {
          if (
            !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
              event.result.outcome,
            ) ||
            typeof event.result.content !== 'string'
          )
            throw new AgentError('invalid_job_result');
          result = event.result;
          if (result.modelContent) {
            if (
              result.modelContent.kind !== 'artifact' ||
              result.modelContent.encoding !== 'utf-8' ||
              !this.options.validateArtifacts
            )
              throw new AgentError('model_content_invalid');
            await this.options.validateArtifacts(scope, [result.modelContent.reference]);
          }
          if (result.artifactRefs?.length) {
            if (!this.options.validateArtifacts)
              throw new AgentError('artifact_references_unavailable');
            await this.options.validateArtifacts(scope, result.artifactRefs);
          }
          observedTerminal = true;
          supervisionEnded = event.supervision === 'ended';
          if (!supervisionEnded)
            result = {
              outcome: 'outcome_unknown',
              content: 'job_stop_unconfirmed',
              details: { actualResult: JSON.parse(JSON.stringify(event.result)) as Json },
            };
        } else if (!terminalOnly) {
          const stream = event.type === 'progress' ? 'progress' : event.stream;
          const content =
            event.type === 'progress'
              ? JSON.stringify(event.value)
              : event.type === 'output'
                ? event.content
                : '';
          await this.options.store.appendExecutionOutput({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            executionId,
            stream,
            content,
            ...(event.type === 'output_dropped' ? { droppedBytes: event.bytes } : {}),
          });
        }
      }
      if (!observedTerminal) throw new AgentError('job_terminal_missing');
    };
    try {
      if (!input.resumedChild && definition.recovery && definition.reconcile) {
        const extension = scope.bindings?.extensions.find((candidate) =>
          candidate.jobs?.some(
            (job) => job.id === definition.id && job.version === definition.version,
          ),
        );
        if (!extension || !definition.recovery.version)
          throw new AgentError('job_recovery_manifest_unavailable');
        await this.options.store.sealJobRecoveryManifest({
          expectedStoreId: scope.command.originStoreId,
          owner: scope.owner,
          executionId,
          manifest: {
            extensionId: extension.id,
            extensionVersion: extension.version,
            adapterId: definition.id,
            adapterVersion: definition.version,
            inputSchema: definition.inputSchema,
            resources: (definition.resources ?? null) as Json,
            recovery: {
              version: definition.recovery.version,
              configuration: structuredClone(definition.recovery.configuration),
            },
          },
        });
      }
      let dispatchAuthorization: Awaited<ReturnType<UnifiedExecution['dispatch']>> | undefined;
      if (input.resumedChild) {
        const releaseAdmission = await this.options.admitJob?.(definition, scope);
        let releaseResources: (() => void) | undefined;
        release = () => {
          releaseResources?.();
          releaseAdmission?.();
        };
        releaseResources = await this.options.resources.acquire(
          definition.resources,
          { sessionId: scope.command.sessionId, workspaceId: scope.workspaceId },
          scope.signal,
        );
      } else {
        const acquired = await this.acquireDispatch(
          scope,
          executionId,
          definition.id,
          definition.version,
          input.request,
          input.source,
          definition.resources,
          'job',
          undefined,
          (signal) =>
            this.options.admitJob?.(definition, { ...scope, signal }) ?? Promise.resolve(undefined),
        );
        release = acquired.release;
        dispatchAuthorization = acquired.authorization;
      }
      const releaseExecutionResources = release;
      const releaseBinding = scope.bindings?.retain();
      release = async () => {
        releaseExecutionResources?.();
        await releaseBinding?.();
      };
      scope.signal.throwIfAborted();
      attempted = true;
      handle =
        (input.resumedChild !== 'activation' ? input.resumedChild : undefined) ??
        (await definition.start(input.request, {
          sessionId: scope.command.sessionId,
          executionId,
          signal: scope.signal,
          dispatchAuthorization,
        }));
      if (existing.status !== 'running' || !input.resumedChild)
        await this.options.store.markRunning({
          expectedStoreId: scope.command.originStoreId,
          owner: scope.owner,
          executionId,
          reference: handle.reference,
        });
      scope.signal.addEventListener('abort', cancel, { once: true });
      if (scope.signal.aborted) cancel();
      await observe();
      if (!supervisionEnded) {
        cancel();
        await cancellation;
      }
    } catch (error) {
      if (handle && !supervisionEnded) {
        cancel();
        await cancellation;
      }
      let observedChildCancellation = false;
      if (
        input.resumedChild &&
        handle &&
        scope.signal.aborted &&
        !observedTerminal &&
        (confirmation?.status === 'stopped' || confirmation?.status === 'already_finished')
      ) {
        try {
          // Only trusted child supervision may read its original Run after a known stop.
          // An external adapter's stop confirmation does not prove its business result.
          await observe(true);
          observedChildCancellation = observedTerminal && supervisionEnded;
        } catch {
          /* Preserve unknown when the original child result cannot be verified. */
        }
      }
      if (!observedChildCancellation)
        result = {
          outcome: attempted ? 'outcome_unknown' : scope.signal.aborted ? 'cancelled' : 'failed',
          content: error instanceof AgentError ? error.code : 'job_failed',
          details: {
            adapterAttempted: attempted,
            stopConfirmation: confirmation
              ? (JSON.parse(JSON.stringify(confirmation)) as Json)
              : null,
          },
        };
    } finally {
      scope.signal.removeEventListener('abort', cancel);
      await cancellation;
    }
    let requirements: Awaited<ReturnType<UnifiedExecution['requirements']>> = [];
    if (result!.outcome === 'succeeded') {
      try {
        requirements = await this.requirements(scope, 'completion', executionId);
      } catch (error) {
        result = {
          outcome: 'failed',
          content: error instanceof AgentError ? error.code : 'necessary_condition_failed',
          details: { actualResult: JSON.parse(JSON.stringify(result)) as Json },
        };
      }
    }
    try {
      await this.options.store.finishExecution({
        expectedStoreId: scope.command.originStoreId,
        owner: scope.owner,
        executionId,
        status: result!.outcome,
        result: JSON.parse(JSON.stringify(result)) as Json,
        requirements,
      });
    } finally {
      if (
        attempted &&
        !supervisionEnded &&
        confirmation?.status !== 'stopped' &&
        confirmation?.status !== 'already_finished' &&
        release
      ) {
        // An unconfirmed live process still owns its permit; a local error cannot invent exit.
        this.unconfirmedJobs.set(executionId, { definition, handle, release });
        release = undefined;
      } else {
        await this.disposeJob(executionId, definition, handle, release);
      }
    }
  }
  private async disposeJob(
    executionId: string,
    definition: JobDefinition,
    handle: JobHandle | undefined,
    release: (() => void | Promise<void>) | undefined,
  ) {
    try {
      if (handle) await definition.dispose(handle);
    } catch (error) {
      this.unconfirmedJobs.set(executionId, { definition, handle, release: release ?? (() => {}) });
      throw error;
    }
    await release?.();
  }
  get unconfirmedJobCount(): number {
    return this.unconfirmedJobs.size;
  }
  async stopUnconfirmedJobs(): Promise<void> {
    await Promise.allSettled(
      [...this.unconfirmedJobs].map(async ([id, job]) => {
        if (!job.handle) return;
        const confirmation = await job.definition.cancel(job.handle);
        if (confirmation.status !== 'stopped' && confirmation.status !== 'already_finished') return;
        await job.definition.dispose(job.handle);
        await job.release();
        this.unconfirmedJobs.delete(id);
      }),
    );
    // A failed or unconfirmed cancel still owns the original handle and permit.
    // The host must retain its Store/profile resources rather than claim exit.
    if (this.unconfirmedJobs.size) throw new AgentError('shutdown_cleanup_unconfirmed');
  }
  private async recordRejectedTool(
    scope: ToolScope,
    executionId: string,
    call: ToolCall,
    stepId: string,
    source: Json,
    input: Json,
    code: string,
    version = 'unavailable',
  ): Promise<ToolResult> {
    const work = identity(scope);
    await this.prepare(scope, {
      executionId,
      stepId,
      callId: call.id,
      kind: 'tool',
      definitionId: call.name,
      definitionVersion: version,
      input,
      decisionSource: source,
    });
    const result: ToolResult = { outcome: 'failed', content: code, details: { code } };
    await this.options.store.finishExecution({
      expectedStoreId: work.originStoreId,
      owner: scope.owner,
      executionId,
      status: 'failed',
      result: JSON.parse(JSON.stringify(result)) as Json,
      ...(work.runId
        ? {
            message: {
              role: 'tool' as const,
              content: code,
              toolCallId: call.id,
              sourceIds: [executionId],
            },
          }
        : {}),
    });
    return result;
  }
  async action(
    scope: StandaloneScope,
    input: {
      executionId: string;
      extensionId: string;
      definition: ActionDefinition;
      prepared: Json;
      decisionSource: Json;
      predecessorExecutionId?: string;
      attempt?: number;
      reprepareOnFreshness?: boolean;
      execute: (signal: AbortSignal) => Promise<ToolResult>;
    },
  ): Promise<ToolResult> {
    return this.liveScope(scope, input.executionId, (bound) => this.performAction(bound, input));
  }
  private async performAction(
    scope: StandaloneScope,
    input: {
      executionId: string;
      extensionId: string;
      definition: ActionDefinition;
      prepared: Json;
      decisionSource: Json;
      predecessorExecutionId?: string;
      attempt?: number;
      reprepareOnFreshness?: boolean;
      execute: (signal: AbortSignal) => Promise<ToolResult>;
    },
  ): Promise<ToolResult> {
    const definitionId = `${input.extensionId}/${input.definition.id}`;
    await this.options.store.planAction({
      expectedStoreId: scope.command.originStoreId,
      owner: scope.owner,
      commandId: scope.command.id,
      executionId: input.executionId,
      extensionId: input.extensionId,
      definitionId,
      definitionVersion: input.definition.version,
      input: input.prepared,
      decisionSource: input.decisionSource,
      ...(scope.parentExecutionId ? { parentExecutionId: scope.parentExecutionId } : {}),
      ...(input.predecessorExecutionId
        ? { predecessorExecutionId: input.predecessorExecutionId, attempt: input.attempt }
        : {}),
    });
    let release: (() => void) | undefined;
    let attempted = false;
    let result: ToolResult;
    try {
      const acquired = await this.acquireDispatch(
        scope,
        input.executionId,
        definitionId,
        input.definition.version,
        input.prepared,
        input.decisionSource,
        input.definition.resources,
        'job',
      );
      release = acquired.release;
      scope.signal.throwIfAborted();
      attempted = true;
      result = await input.execute(scope.signal);
      if (
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(result.outcome) ||
        typeof result.content !== 'string'
      )
        throw new AgentError('invalid_action_result');
      if (result.modelContent) {
        if (
          result.modelContent.kind !== 'artifact' ||
          result.modelContent.encoding !== 'utf-8' ||
          !this.options.validateArtifacts
        )
          throw new AgentError('model_content_invalid');
        await this.options.validateArtifacts(scope, [result.modelContent.reference]);
      }
      if (result.artifactRefs?.length) {
        if (!this.options.validateArtifacts)
          throw new AgentError('artifact_references_unavailable');
        await this.options.validateArtifacts(scope, result.artifactRefs);
      }
    } catch (error) {
      result = {
        outcome: attempted ? 'outcome_unknown' : scope.signal.aborted ? 'cancelled' : 'failed',
        content: error instanceof AgentError ? error.code : 'action_failed',
        details: {
          code: error instanceof AgentError ? error.code : 'action_failed',
          adapterAttempted: attempted,
        },
      };
    }
    try {
      const details = result.details;
      const preparingNextAttempt =
        input.reprepareOnFreshness === true &&
        result.outcome === 'failed' &&
        details &&
        typeof details === 'object' &&
        !Array.isArray(details) &&
        details.code === 'context_refresh_required' &&
        details.adapterAttempted === false;
      await this.options.store.applyExtensionAction({
        expectedStoreId: scope.command.originStoreId,
        owner: scope.owner,
        executionId: input.executionId,
        extensionId: input.extensionId,
        status: result.outcome,
        result: JSON.parse(JSON.stringify(result)) as Json,
        preparingNextAttempt: !!preparingNextAttempt,
      });
      return result;
    } finally {
      release?.();
    }
  }
}
