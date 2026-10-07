import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
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
import { type AcceptedAuthorization, InteractionGate } from './interactions';
import { createProgressWriter } from './progress';
import type { ExecutionResources } from './resources';

export interface ModelResponse {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Json;
  executionId: string;
}
export interface ExecutionScope {
  compressionId?: string;
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
  private readonly unconfirmedJobs = new Map<
    string,
    { definition: JobDefinition; handle?: JobHandle; release: () => void | Promise<void> }
  >();
  constructor(options: ExecutionOptions) {
    this.options = options;
    this.interactions = new InteractionGate(options.store, options.permissions);
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
      ? new InteractionGate(this.options.store, scope.bindings.permissions)
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
      ? new InteractionGate(this.options.store, scope.bindings.permissions)
      : this.interactions;
    return gate.authorize(
      {
        ...this.interactionScope(scope, request.executionId),
        final,
        previousReview: this.authorizationReviews.get(request.executionId),
        ...(!final && this.options.reviewAuthorization
          ? {
              review: async (decision: import('../extensions').PermissionDecision) => {
                const reference = await this.options.reviewAuthorization!(
                  scope,
                  request,
                  source,
                  decision,
                );
                if (reference) this.authorizationReviews.set(request.executionId, reference);
                return reference;
              },
            }
          : {}),
      },
      request,
      source,
    );
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
      release?.();
      scope.signal.removeEventListener('abort', abort);
    }
  }
  async requirements(
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
    if (!references.length) return [];
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
                    throw new AgentError('necessary_condition_snapshot_changed');
                  reads!.set(recordKey, read);
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
                    throw new AgentError('necessary_condition_snapshot_changed');
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
    return evaluations.map((original) => {
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
  private async dispatch(
    scope: ToolScope,
    executionId: string,
    definitionId: string,
    definitionVersion: string,
    input: Json,
    source: Json,
    kind: AuthorizationRequest['kind'] = 'tool',
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
    await this.options.store.markDispatching({
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
    });
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
          ...(scope.compressionId ? { compressionId: scope.compressionId } : {}),
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
    if (!planned) {
      const capturedMetadata = modelMetadataJson(
        await captureModelRequestMetadata(scope, model, request),
      );
      const modelMetadata = this.options.sealModelMetadata
        ? await this.options.sealModelMetadata(scope, capturedMetadata)
        : capturedMetadata;
      await this.prepare(scope, {
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
    let content = '';
    let reasoning = '';
    const calls: ToolCall[] = [];
    let output: ModelOutputWriter | undefined;
    const preview = () => content.slice(0, 4096);
    const partial = async (ref: ModelOutputReference) => {
      await this.options.store.persistModelPartial({
        expectedStoreId: scope.run.originStoreId,
        owner: scope.owner,
        executionId,
        content: preview(),
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
    let finish: { reason: string; usage: Json } | undefined;
    try {
      const actualRequest = this.options.openModelInput
        ? await this.options.openModelInput(scope, input)
        : request;
      scope.signal.throwIfAborted();
      release = await this.options.resources.acquire(
        { slot: 'model' },
        { sessionId: scope.run.sessionId, workspaceId: scope.workspaceId },
        scope.signal,
      );
      await this.dispatch(scope, executionId, request.modelId, '1', input, source, 'model');
      dispatched = true;
      scope.signal.throwIfAborted();
      let savedLength = 0;
      let savedAt = Date.now();
      for await (const event of model.stream(actualRequest, { signal: scope.signal })) {
        if (finish) throw new AgentError('model_event_after_finish');
        scope.signal.throwIfAborted();
        if (event.type === 'text_delta') {
          content += event.text;
          if (output) await output.text('text', event.text);
        } else if (event.type === 'reasoning_delta') {
          reasoning += event.text;
          if (output) await output.text('reasoning', event.text);
        } else if (event.type === 'tool_call') {
          const call = { id: event.id, name: event.name, arguments: event.arguments };
          calls.push(call);
          if (output) await output.call(call);
        } else finish = { reason: event.reason, usage: { ...event.usage } };
        if (
          !output &&
          Buffer.byteLength(content) +
            Buffer.byteLength(reasoning) +
            calls.reduce((sum, call) => sum + Buffer.byteLength(call.arguments), 0) >
            64 * 1024
        )
          await activateOutput();
        if (!output && (content.length - savedLength >= 32768 || Date.now() - savedAt >= 100)) {
          await this.options.store.persistModelPartial({
            expectedStoreId: scope.run.originStoreId,
            owner: scope.owner,
            executionId,
            content,
          });
          savedLength = content.length;
          savedAt = Date.now();
        }
      }
      if (!finish || finish.reason === 'length' || finish.reason === 'cancelled')
        throw new AgentError('model_response_incomplete');
      if (new Set(calls.map((call) => call.id)).size !== calls.length)
        throw new AgentError('duplicate_tool_call_id');
      await this.options.store.finishExecution({
        expectedStoreId: scope.run.originStoreId,
        owner: scope.owner,
        executionId,
        status: 'succeeded',
        result: {
          content: output ? preview() : content,
          reasoning: output ? '' : reasoning,
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
          content: output ? preview() : content,
          toolCalls: output ? [] : calls,
          sourceIds: [executionId],
          ...(output ? { modelOutput: output.descriptor(true)! } : {}),
        },
      });
      return { content, reasoning, toolCalls: calls, usage: finish.usage, executionId };
    } catch (error) {
      if (dispatched && content && !output)
        await this.options.store
          .persistModelPartial({
            expectedStoreId: scope.run.originStoreId,
            owner: scope.owner,
            executionId,
            content,
          })
          .catch(() => {});
      await this.options.store
        .finishExecution({
          expectedStoreId: scope.run.originStoreId,
          owner: scope.owner,
          executionId,
          status: scope.signal.aborted ? 'cancelled' : 'failed',
          result: {
            code: error instanceof AgentError ? error.code : 'model_failed',
            incomplete: true,
            content: output ? preview() : content.slice(0, 64 * 1024),
            reasoning: output ? '' : reasoning.slice(0, 64 * 1024),
            ...(output?.descriptor()
              ? { modelOutput: output.descriptor() as unknown as Json }
              : {}),
          },
        })
        .catch(() => {});
      throw error;
    } finally {
      release?.();
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
    const executionId = planned?.id ?? crypto.randomUUID();
    return this.liveScope(scope, executionId, (bound) =>
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
  ): Promise<ToolResult> {
    const work = identity(scope);
    let source: Json = decisionSource ?? {
      kind: 'model_decision',
      modelExecutionId: sourceExecutionId,
      sources: JSON.parse(
        JSON.stringify('run' in scope ? (scope.decisionSources ?? []) : []),
      ) as Json,
    };
    if (!planned && this.options.sealSource) source = await this.options.sealSource(scope, source);
    let input: Json;
    try {
      input = JSON.parse(call.arguments) as Json;
    } catch {
      return this.recordRejectedTool(
        scope,
        executionId,
        call,
        stepId,
        source,
        null,
        'invalid_tool_arguments',
      );
    }
    if (!definition)
      return this.recordRejectedTool(
        scope,
        executionId,
        call,
        stepId,
        source,
        input,
        'tool_not_available',
      );
    if (!this.validator.compile(definition.inputSchema)(input))
      return this.recordRejectedTool(
        scope,
        executionId,
        call,
        stepId,
        source,
        input,
        'invalid_tool_arguments',
        definition.version,
      );
    await this.prepare(scope, {
      executionId,
      stepId,
      callId: call.id,
      kind: 'tool',
      definitionId: definition.id,
      definitionVersion: definition.version,
      input,
      decisionSource: source,
    });
    let release: (() => void) | undefined;
    let dispatched = false;
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
      {
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
      await this.authorize(
        scope,
        {
          kind: 'tool',
          sessionId: work.sessionId,
          runId: work.runId,
          executionId,
          definitionId: definition.id,
          definitionVersion: definition.version,
          input,
          signal: scope.signal,
        },
        source,
      );
      release = await this.options.resources.acquire(
        definition.resources,
        { sessionId: work.sessionId, workspaceId: scope.workspaceId },
        scope.signal,
      );
      await this.dispatch(scope, executionId, definition.id, definition.version, input, source);
      dispatched = true;
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
      result = await definition.execute(input, {
        ...context,
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
        content: error instanceof AgentError ? error.code : 'tool_failed',
        details: {
          code: error instanceof AgentError ? error.code : 'tool_failed',
          dispatchCommitted: dispatched,
          adapterAttempted: attempted,
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
          return stored.result as unknown as ToolResult;
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
      return result;
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
    },
  ): Promise<void> {
    const { executionId, definition } = input;
    const existing = await this.options.store.getExecution(executionId);
    if (!existing) throw new AgentError('execution_not_found');
    scope = { ...scope, requirements: existing.requirements };
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
    let handle: JobHandle | undefined;
    let attempted = false;
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
    try {
      await this.authorize(
        scope,
        {
          kind: 'job',
          sessionId: scope.command.sessionId,
          runId: null,
          executionId,
          definitionId: definition.id,
          definitionVersion: definition.version,
          input: input.request,
          signal: scope.signal,
        },
        input.source,
      );
      release = await this.options.admitJob?.(definition, scope);
      const releaseAdmission = release;
      const releaseResources = await this.options.resources.acquire(
        definition.resources,
        { sessionId: scope.command.sessionId, workspaceId: scope.workspaceId },
        scope.signal,
      );
      // The original implementation must remain alive with an unconfirmed handle,
      // beyond the observer operation's ordinary binding lease.
      let releaseBinding: (() => Promise<void>) | undefined;
      try {
        releaseBinding = scope.bindings?.retain();
      } catch (error) {
        releaseResources();
        await releaseAdmission?.();
        release = undefined;
        throw error;
      }
      release = async () => {
        releaseResources();
        await releaseAdmission?.();
        await releaseBinding?.();
      };
      if (definition.recovery && definition.reconcile) {
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
      const dispatchAuthorization = await this.dispatch(
        scope,
        executionId,
        definition.id,
        definition.version,
        input.request,
        input.source,
        'job',
      );
      scope.signal.throwIfAborted();
      attempted = true;
      handle = await definition.start(input.request, {
        sessionId: scope.command.sessionId,
        executionId,
        signal: scope.signal,
        dispatchAuthorization,
      });
      await this.options.store.markRunning({
        expectedStoreId: scope.command.originStoreId,
        owner: scope.owner,
        executionId,
        reference: handle.reference,
      });
      scope.signal.addEventListener('abort', cancel, { once: true });
      if (scope.signal.aborted) cancel();
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
        } else {
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
      if (!supervisionEnded) {
        cancel();
        await cancellation;
      }
    } catch (error) {
      if (handle && !supervisionEnded) {
        cancel();
        await cancellation;
      }
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
      ...(input.predecessorExecutionId
        ? { predecessorExecutionId: input.predecessorExecutionId, attempt: input.attempt }
        : {}),
    });
    let release: (() => void) | undefined;
    let attempted = false;
    let result: ToolResult;
    try {
      await this.authorize(
        scope,
        {
          kind: 'job',
          sessionId: scope.command.sessionId,
          runId: null,
          executionId: input.executionId,
          definitionId,
          definitionVersion: input.definition.version,
          input: input.prepared,
          signal: scope.signal,
        },
        input.decisionSource,
      );
      release = await this.options.resources.acquire(
        input.definition.resources,
        { sessionId: scope.command.sessionId, workspaceId: scope.workspaceId },
        scope.signal,
      );
      await this.dispatch(
        scope,
        input.executionId,
        definitionId,
        input.definition.version,
        input.prepared,
        input.decisionSource,
        'job',
      );
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
