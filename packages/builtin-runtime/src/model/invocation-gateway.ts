import {
  MODEL_INVOCATION_ENVELOPE_SCHEMA_,
  MODEL_RESPONSE_RECORD_SCHEMA_,
  type ModelInvocationEnvelope,
  type ModelInvocationPurpose,
  type ModelResponseRecord,
  type PrivateArtifactRef,
  type Sha256Digest,
} from '@kite-ai/runtime-spi';
import type { ModelArtifactStore } from './artifacts';
import type { SupportedChatModel } from './factory';
import { type AIMessage, aiMessage } from './messages';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  type BuiltinModelOperationExecutionPort,
} from './operation';
import { derivePrivateImmutableArtifactReference } from './private-immutable-artifacts';
import { ModelAttemptFailureError, type ModelResponseSource } from './response-source';
import {
  canonicalModelJson,
  computeModelSurfaceDigest,
  computePrivateModelEvidenceDigest,
} from './surface-canonicalizer';
import type { CompiledModelSurface } from './surface-compiler';

export type { SingleAttemptTransport } from './response-source';

export type ModelInvocationInterruptReason =
  | 'runtime_restored'
  | 'attempts_exhausted'
  | 'cancelled'
  | 'cancelled_before_dispatch'
  | 'attempt_timeout'
  | 'provider_failure'
  | 'surface_identity_changed'
  | 'persistence_unavailable';

export type BuiltinModelEvent = Readonly<{ type: string; [key: string]: unknown }>;

export interface ModelInvocationStateView {
  readonly revision: number;
  readonly session: { readonly threadId: string; readonly projectId?: string };
  readonly turn: { readonly turnId: string };
  readonly resourceBudget?: { readonly status: string };
}

/** Minimum durable facts required to resume one prepared, unattempted request. */
export interface ModelPreparedResumeStateView extends ModelInvocationStateView {
  readonly turn: { readonly turnId: string; readonly status: string };
  readonly modelInvocations: Readonly<
    Record<
      string,
      Readonly<{
        invocationId: string;
        purpose: ModelInvocationPurpose | 'verification_review';
        status: string;
        attempts: number;
        surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
        surfaceIntegrityIdentifier: string;
        routeFingerprint: string;
        estimatedInputTokens?: number;
        preparedStateRevision: number;
        budget: ModelInvocationEnvelope['resource']['budget'];
        limits: ModelInvocationEnvelope['resource']['limits'];
        parentInvocationId: string | null;
        parentToolCallId: string | null;
        dispatchCertainty?: string;
        responseArtifact?: PrivateArtifactRef;
      }>
    >
  >;
  readonly resourceBudget: Readonly<{
    status: string;
    runId?: string;
    reservations?: Readonly<
      Record<
        string,
        Readonly<{
          reservationId: string;
          runId: string;
          invocationId: string;
          resourceKind: string;
          state: string;
          parentReservationId?: string;
          executableUpperBound: Readonly<{
            counters: Readonly<{
              modelRequests: number;
              inputTokens: number;
              outputTokens: number;
            }>;
          }>;
        }>
      >
    >;
  }>;
}

export interface ModelRuntimeIdSource {
  next(scope: 'model_invocation'): string;
  now(): number;
}

export interface ModelResourcePreparationPlan {
  budget: ModelInvocationEnvelope['resource']['budget'];
  preparationEvents: BuiltinModelEvent[];
  maxOutputTokens?: number;
}

export type ModelResourcePlanner = (
  state: Readonly<ModelInvocationStateView>,
  input: {
    invocationId: string;
    inputTokens: number;
    requestedMaxOutputTokens?: number;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
    replaceReservationId?: string;
  },
) => ModelResourcePreparationPlan;

const DEFAULT_LIMITS = Object.freeze({
  maxAttempts: 5,
  // A model request is bounded by its caller's cancellation deadline, not a
  // gateway-owned wall-clock timer. Zero keeps the legacy persisted field
  // decode-compatible while disabling the obsolete per-attempt deadline.
  perAttemptTimeoutMs: 0,
  totalTimeBudgetMs: 60_000,
});

const RATE_LIMIT_RETRY_SLOT_MS = 500;

function createLiveModelRuntimeIdSource(): ModelRuntimeIdSource {
  return Object.freeze({
    next: (_scope: 'model_invocation') => crypto.randomUUID(),
    now: () => Date.now(),
  });
}

function planUnconfiguredModelResource(
  state: Readonly<ModelInvocationStateView>,
  input: Parameters<ModelResourcePlanner>[1],
): ModelResourcePreparationPlan {
  if (state.resourceBudget?.status && state.resourceBudget.status !== 'unconfigured') {
    throw new Error('Active resource budgets require a Host-owned Model resource planner.');
  }
  return {
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    preparationEvents: [],
    ...(input.requestedMaxOutputTokens ? { maxOutputTokens: input.requestedMaxOutputTokens } : {}),
  };
}

function createZeroModelResourceUsage() {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
    source: 'actual' as const,
  };
}

export interface ModelInvocationPersistence<
  State extends ModelInvocationStateView = ModelInvocationStateView,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
> {
  getState(): Readonly<State>;
  persistEvents(events: Event[]): Promise<boolean>;
  /** One Host transaction for model/budget admission and an opaque prepared mail batch. */
  persistAdmission?(input: {
    readonly invocationId: string;
    readonly events: Event[];
    readonly mailPreparation: ModelMailPreparationDescriptor;
  }): Promise<boolean>;
}

/** A private Host lookup identity. Message bodies never enter Gateway evidence. */
export interface ModelMailPreparationDescriptor {
  readonly preparationId: string;
}

export interface PreparedModelSurface {
  readonly compiled: CompiledModelSurface;
  readonly mailPreparation?: ModelMailPreparationDescriptor;
  /** Exact child provenance resolved from the prepared transcript. */
  readonly provenance?: ModelInvocationProvenanceInput;
}

export interface ModelInvocationProvenanceInput {
  parentInvocationId?: string | null;
  parentToolCallId?: string | null;
  contextCheckpointId?: string | null;
  promptContractVersion: string;
  projectionEnvironmentDigest: Sha256Digest;
  capabilityBindingDigest: Sha256Digest;
}

export interface NormalizedModelResponse {
  readonly invocationId: string;
  readonly message: ModelResponseRecord['response']['message'];
  readonly finishReason: ModelResponseRecord['response']['finishReason'];
  readonly usage: ModelResponseRecord['response']['usage'];
  readonly providerMetadata: ModelResponseRecord['response']['providerMetadata'];
}

export interface ModelCompletionFinalization<
  T,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
> {
  events: Event[];
  value: T;
}

export interface PendingModelCompletion<Event extends BuiltinModelEvent = BuiltinModelEvent> {
  readonly invocationId: string;
  commit(): Promise<NormalizedModelResponse>;
  commitWith<T>(
    finalizer: (
      response: Readonly<NormalizedModelResponse>,
    ) => ModelCompletionFinalization<T, Event>,
  ): Promise<T>;
}

export type ModelArtifactWriter = Pick<ModelArtifactStore, 'writeSurface' | 'writeResponse'> &
  Partial<Pick<ModelArtifactStore, 'readSurface'>>;

type ModelDispatchEnvelope = Readonly<{
  provenance: Readonly<
    Pick<
      ModelInvocationEnvelope['provenance'],
      'invocationId' | 'threadId' | 'turnId' | 'stateRevision'
    >
  >;
  resource: Readonly<ModelInvocationEnvelope['resource']>;
}>;

/**
 * Content-free correlation for a model invocation that failed after its
 * durable identity was allocated. Callers may expose the opaque id, but never
 * the private provider error carried as the cause.
 */
export class ModelInvocationExecutionError extends Error {
  readonly invocationId: string;

  constructor(invocationId: string, cause: unknown) {
    super(
      cause instanceof Error ? cause.message : 'Model invocation execution failed.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ModelInvocationExecutionError';
    this.invocationId = invocationId;
  }
}

export class ModelInvocationGateway {
  readonly #artifacts: ModelArtifactWriter;
  readonly #source: ModelResponseSource;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #runtimeIdSource: ModelRuntimeIdSource;
  readonly #planResource: ModelResourcePlanner;
  readonly #operationExecution: BuiltinModelOperationExecutionPort;
  /**
   * HTTP 429 is normally shared by every concurrent invocation on one model
   * route. Keep one route-local retry horizon so sibling Subagents do not all
   * repeat the same exponential schedule and hit the Provider as a herd.
   */
  readonly #nextRateLimitRetryAtByRoute = new Map<string, number>();

  constructor(input: {
    artifacts: ModelArtifactWriter;
    source: ModelResponseSource;
    now?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    runtimeIdSource?: ModelRuntimeIdSource;
    planResource?: ModelResourcePlanner;
    operationExecution: BuiltinModelOperationExecutionPort;
  }) {
    this.#artifacts = input.artifacts;
    this.#source = input.source;
    this.#runtimeIdSource = input.runtimeIdSource ?? createLiveModelRuntimeIdSource();
    this.#planResource = input.planResource ?? planUnconfiguredModelResource;
    this.#operationExecution = input.operationExecution;
    this.#now = input.now ?? (() => this.#runtimeIdSource.now());
    this.#sleep = input.sleep ?? abortableSleep;
  }

  async invoke<State extends ModelInvocationStateView, Event extends BuiltinModelEvent>(input: {
    model: SupportedChatModel;
    compiled?: CompiledModelSurface;
    /** Called once with the Gateway-owned identity, before Surface publication or planning. */
    prepareSurface?: (invocationId: string) => PreparedModelSurface | Promise<PreparedModelSurface>;
    persistence: ModelInvocationPersistence<State, Event>;
    provenance?: ModelInvocationProvenanceInput;
    resourceKind: 'model' | 'compaction' | 'verification';
    parentReservationId?: string;
    replaceReservationId?: string;
    limits?: Partial<ModelInvocationEnvelope['resource']['limits']>;
    /** Fixed wall-clock limit for a source-funded first child attempt. */
    hardAttemptTimeoutMs?: number;
    signal?: AbortSignal;
    emitEphemeral?: (event: Event) => void;
  }): Promise<PendingModelCompletion<Event>> {
    const invocationId = this.#runtimeIdSource.next('model_invocation');
    if (!!input.compiled === !!input.prepareSurface)
      throw new Error('Model invocation requires exactly one compiled Surface source.');
    const preparedSurface = input.prepareSurface
      ? await input.prepareSurface(invocationId)
      : { compiled: input.compiled };
    const compiled = preparedSurface?.compiled;
    const provenance =
      ('provenance' in preparedSurface ? preparedSurface.provenance : undefined) ??
      input.provenance;
    if (!provenance) throw new Error('Model invocation provenance is unavailable.');
    if (
      !compiled ||
      (input.prepareSurface && (!Object.isFrozen(compiled) || !Object.isFrozen(compiled.surface)))
    )
      throw new Error('Prepared Model Surface must be frozen.');
    const mailPreparation =
      'mailPreparation' in preparedSurface ? preparedSurface.mailPreparation : undefined;
    if (
      mailPreparation !== undefined &&
      (!mailPreparation ||
        typeof mailPreparation !== 'object' ||
        Object.keys(mailPreparation).length !== 1 ||
        !Object.hasOwn(mailPreparation, 'preparationId') ||
        typeof mailPreparation.preparationId !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(mailPreparation.preparationId))
    )
      throw new Error('Model mail preparation identity is invalid.');
    if (mailPreparation && !input.persistence.persistAdmission)
      throw new Error('Model mail preparation requires atomic admission persistence.');
    const limits = normalizeLimits(input.limits);
    if (
      input.hardAttemptTimeoutMs !== undefined &&
      (!Number.isSafeInteger(input.hardAttemptTimeoutMs) || input.hardAttemptTimeoutMs <= 0)
    )
      throw new Error('Model hard attempt deadline must be finite and positive.');
    const initialSurfaceDigest = computeModelSurfaceDigest(compiled.surface);
    if (initialSurfaceDigest !== compiled.surfaceDigest) {
      throw new Error('Frozen Model Surface identity changed before dispatch.');
    }

    // Artifact publication precedes resource preparation. A later local failure can
    // only leave an immutable orphan eligible for reachability-based GC.
    const surfaceArtifact = this.#artifacts.writeSurface(compiled.surface);
    const state = input.persistence.getState();

    const resource = this.#planResource(state, {
      invocationId,
      inputTokens: compiled.estimatedInputTokens,
      ...(compiled.surface.request.maxOutputTokens
        ? { requestedMaxOutputTokens: compiled.surface.request.maxOutputTokens }
        : {}),
      resourceKind: input.resourceKind,
      ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
      ...(input.replaceReservationId ? { replaceReservationId: input.replaceReservationId } : {}),
    });
    assertResourceMatchesSurface(resource, compiled);
    const envelope: ModelInvocationEnvelope = {
      schema: MODEL_INVOCATION_ENVELOPE_SCHEMA_,
      surface: {
        artifact: surfaceArtifact,
        surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
      },
      provenance: {
        invocationId,
        threadId: state.session.threadId,
        turnId: state.turn.turnId,
        parentInvocationId: provenance.parentInvocationId ?? null,
        parentToolCallId: provenance.parentToolCallId ?? null,
        stateRevision: state.revision,
        contextCheckpointId: provenance.contextCheckpointId ?? null,
        promptContractVersion: provenance.promptContractVersion,
        projectionEnvironmentDigest: provenance.projectionEnvironmentDigest,
        capabilityBindingDigest: provenance.capabilityBindingDigest,
      },
      resource: { budget: resource.budget, limits },
    };
    const prepared: BuiltinModelEvent = {
      type: 'model.invocation_prepared',
      invocationId,
      purpose: compiled.surface.purpose,
      surfaceArtifact,
      surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
      routeFingerprint: compiled.surface.route.routeFingerprint,
      estimatedInputTokens: compiled.estimatedInputTokens,
      budget: envelope.resource.budget,
      limits,
      preparedStateRevision: state.revision,
      parentInvocationId: envelope.provenance.parentInvocationId,
      parentToolCallId: envelope.provenance.parentToolCallId,
    };
    const admissionEvents = asModelEvents<Event>([...resource.preparationEvents, prepared]);
    if (mailPreparation) {
      await persistModelAdmission(input.persistence, {
        invocationId,
        events: admissionEvents,
        mailPreparation: Object.freeze({ preparationId: mailPreparation.preparationId }),
      });
    } else await persistAck(input.persistence, admissionEvents);

    return this.#dispatchPrepared(input, {
      compiled,
      surfaceArtifact,
      envelope,
      initialSurfaceDigest,
    });
  }

  /** Resume only the original prepared identity after a durable, pre-dispatch gate. */
  async resumePrepared<
    State extends ModelPreparedResumeStateView,
    Event extends BuiltinModelEvent,
  >(input: {
    readonly model: SupportedChatModel;
    readonly persistence: ModelInvocationPersistence<State, Event>;
    readonly invocationId: string;
    readonly expectedStateRevision: number;
    readonly expectedTurnId: string;
    readonly expectedRouteFingerprint: string;
    readonly surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
    readonly surfaceIntegrityIdentifier: string;
    readonly hardAttemptTimeoutMs: number;
    /** The target owner checks route plus source activation receipt before any attempt fact. */
    readonly beforeDispatch: (
      identity: Readonly<{
        invocationId: string;
        sessionId: string;
        turnId: string;
        preparedStateRevision: number;
        observedStateRevision: number;
        surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
        surfaceIntegrityIdentifier: string;
        reservationId: string;
      }>,
    ) => Promise<boolean>;
    readonly signal?: AbortSignal;
    readonly emitEphemeral?: (event: Event) => void;
  }): Promise<PendingModelCompletion<Event>> {
    if (!this.#artifacts.readSurface)
      throw new Error('Prepared Model Surface reader is unavailable.');
    const state = input.persistence.getState();
    const prepared = state.modelInvocations[input.invocationId];
    const reservationId =
      prepared?.budget.kind === 'reservation' ? prepared.budget.reservationId : '';
    const reservation = state.resourceBudget.reservations?.[reservationId];
    if (
      !prepared ||
      !input.invocationId ||
      !Number.isSafeInteger(input.expectedStateRevision) ||
      state.revision !== input.expectedStateRevision ||
      state.turn.turnId !== input.expectedTurnId ||
      state.turn.status !== 'active' ||
      prepared.invocationId !== input.invocationId ||
      prepared.purpose !== 'primary_agent' ||
      prepared.status !== 'prepared' ||
      prepared.attempts !== 0 ||
      (prepared.dispatchCertainty !== undefined && prepared.dispatchCertainty !== 'none') ||
      prepared.responseArtifact !== undefined ||
      prepared.budget.kind !== 'reservation' ||
      prepared.parentInvocationId !== null ||
      prepared.parentToolCallId !== null ||
      prepared.preparedStateRevision >= state.revision ||
      prepared.routeFingerprint !== input.expectedRouteFingerprint ||
      !Number.isSafeInteger(prepared.estimatedInputTokens) ||
      prepared.estimatedInputTokens! < 0 ||
      prepared.surfaceArtifact.artifactId !== input.surfaceArtifact.artifactId ||
      prepared.surfaceArtifact.integrityIdentifier !== input.surfaceArtifact.integrityIdentifier ||
      prepared.surfaceArtifact.byteLength !== input.surfaceArtifact.byteLength ||
      prepared.surfaceIntegrityIdentifier !== input.surfaceIntegrityIdentifier ||
      prepared.surfaceIntegrityIdentifier !== input.surfaceArtifact.integrityIdentifier ||
      prepared.limits.maxAttempts !== 1 ||
      !Number.isSafeInteger(input.hardAttemptTimeoutMs) ||
      input.hardAttemptTimeoutMs <= 0 ||
      prepared.limits.perAttemptTimeoutMs !== input.hardAttemptTimeoutMs ||
      prepared.limits.totalTimeBudgetMs !== input.hardAttemptTimeoutMs ||
      state.resourceBudget.status !== 'active' ||
      state.resourceBudget.runId !== input.expectedTurnId ||
      !reservation ||
      reservation.reservationId !== reservationId ||
      reservation.runId !== input.expectedTurnId ||
      reservation.invocationId !== `model-invocation:${input.invocationId}` ||
      reservation.resourceKind !== 'model' ||
      reservation.state !== 'reserved' ||
      (reservation.parentReservationId ?? null) !== prepared.budget.parentReservationId ||
      reservation.executableUpperBound.counters.modelRequests !== 1 ||
      !Number.isSafeInteger(reservation.executableUpperBound.counters.inputTokens) ||
      prepared.estimatedInputTokens! > reservation.executableUpperBound.counters.inputTokens ||
      !Number.isSafeInteger(reservation.executableUpperBound.counters.outputTokens)
    )
      throw new Error('Prepared Model invocation has stale or attempted durable authority.');
    const surface = this.#artifacts.readSurface(input.surfaceArtifact);
    const canonical = canonicalModelJson(surface);
    const verifiedRef = derivePrivateImmutableArtifactReference(
      'model-artifacts',
      'model_surface',
      Buffer.from(canonical, 'utf8'),
    );
    if (
      verifiedRef.artifactId !== input.surfaceArtifact.artifactId ||
      verifiedRef.integrityIdentifier !== input.surfaceIntegrityIdentifier ||
      verifiedRef.byteLength !== input.surfaceArtifact.byteLength ||
      surface.purpose !== prepared.purpose ||
      surface.route.routeFingerprint !== prepared.routeFingerprint ||
      surface.request.maxOutputTokens === null ||
      surface.request.maxOutputTokens === undefined ||
      surface.request.maxOutputTokens > reservation.executableUpperBound.counters.outputTokens
    )
      throw new Error('Prepared Model Surface differs from its durable artifact.');
    const surfaceDigest = computeModelSurfaceDigest(surface);
    if (input.signal?.aborted) throw abortReason(input.signal);
    const identity = Object.freeze({
      invocationId: input.invocationId,
      sessionId: state.session.threadId,
      turnId: state.turn.turnId,
      preparedStateRevision: prepared.preparedStateRevision,
      observedStateRevision: state.revision,
      surfaceArtifact: input.surfaceArtifact,
      surfaceIntegrityIdentifier: input.surfaceIntegrityIdentifier,
      reservationId,
    });
    if (!(await input.beforeDispatch(identity)))
      throw new Error('Prepared Model dispatch gate has no durable source acknowledgement.');
    const afterGate = input.persistence.getState();
    if (
      afterGate.revision !== state.revision ||
      afterGate.modelInvocations[input.invocationId]?.status !== 'prepared' ||
      afterGate.modelInvocations[input.invocationId]?.attempts !== 0 ||
      afterGate.resourceBudget.reservations?.[reservationId]?.state !== 'reserved'
    )
      throw new Error('Prepared Model authority changed before dispatch.');
    return this.#dispatchPrepared(input, {
      compiled: { surface: deepFreeze(surface), surfaceDigest },
      surfaceArtifact: input.surfaceArtifact,
      envelope: {
        provenance: {
          invocationId: input.invocationId,
          threadId: state.session.threadId,
          turnId: state.turn.turnId,
          stateRevision: prepared.preparedStateRevision,
        },
        resource: { budget: prepared.budget, limits: prepared.limits },
      },
      initialSurfaceDigest: surfaceDigest,
    });
  }

  async #dispatchPrepared<Event extends BuiltinModelEvent>(
    input: {
      readonly model: SupportedChatModel;
      readonly persistence: ModelInvocationPersistence<ModelInvocationStateView, Event>;
      readonly hardAttemptTimeoutMs?: number;
      readonly signal?: AbortSignal;
      readonly emitEphemeral?: (event: Event) => void;
    },
    prepared: {
      readonly compiled: Pick<CompiledModelSurface, 'surface' | 'surfaceDigest'>;
      readonly surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
      readonly envelope: ModelDispatchEnvelope;
      readonly initialSurfaceDigest: Sha256Digest;
    },
  ): Promise<PendingModelCompletion<Event>> {
    const { compiled, surfaceArtifact, envelope, initialSurfaceDigest } = prepared;
    const invocationId = envelope.provenance.invocationId;
    const limits = envelope.resource.limits;
    const resource = envelope.resource;

    let retryBudgetStartedAt: number | undefined;
    let priorError: unknown;
    let retryDelayMs = 0;
    let retryBaselineText = '';
    let retryBaselineReasoning = '';
    let attemptText = '';
    let attemptReasoning = '';
    let interruptionReason: ModelInvocationInterruptReason = 'attempts_exhausted';
    let lastFailureDiagnostic: ModelFailureDiagnostic | undefined;
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
      if (input.signal?.aborted) {
        await this.#interrupt(input.persistence, envelope, 'cancelled_before_dispatch', 'none');
        throw abortReason(input.signal);
      }
      if (attempt > 1) {
        const remainingMs = remainingRetryBudgetMs(
          retryBudgetStartedAt,
          limits.totalTimeBudgetMs,
          this.#now(),
        );
        if (remainingMs <= 0) break;
        try {
          await this.#sleep(Math.min(retryDelayMs, remainingMs), input.signal);
        } catch (error) {
          await this.#interrupt(input.persistence, envelope, 'cancelled', 'attempted');
          throw error;
        }
      }
      const remainingMs = remainingRetryBudgetMs(
        retryBudgetStartedAt,
        limits.totalTimeBudgetMs,
        this.#now(),
      );
      if (attempt > 1 && remainingMs <= 0) break;
      const attemptEvents: BuiltinModelEvent[] = [];
      if (attempt === 1 && resource.budget.kind === 'reservation') {
        attemptEvents.push({
          type: 'resource_budget.dispatch_started',
          reservationId: resource.budget.reservationId,
        });
      }
      attemptEvents.push({
        type: 'model.invocation_attempt_started',
        invocationId,
        attempt,
        maxAttempts: limits.maxAttempts,
      });
      if (attempt === 1 && compiled.surface.purpose === 'primary_agent') {
        attemptEvents.push({ type: 'model.requested', requestId: invocationId, invocationId });
      }
      await persistAck(input.persistence, asModelEvents<Event>(attemptEvents));
      if (input.signal?.aborted) {
        await this.#interrupt(input.persistence, envelope, 'cancelled', 'none');
        throw abortReason(input.signal);
      }
      if (computeModelSurfaceDigest(compiled.surface) !== initialSurfaceDigest) {
        await this.#interrupt(input.persistence, envelope, 'surface_identity_changed', 'none');
        throw new Error('Frozen Model Surface changed after attempt acknowledgement.');
      }

      attemptText = '';
      attemptReasoning = '';
      let visibleReasoningLength = 0;
      const visibleReasoningSegments = new Map<string, string>();
      const attemptAbort = boundedAttemptSignal(
        input.signal,
        limits.perAttemptTimeoutMs,
        input.hardAttemptTimeoutMs,
      );
      let outcome: Awaited<ReturnType<ModelResponseSource['attempt']>>;
      try {
        outcome = await waitForAttemptSignal(
          this.#operationExecution.execute({
            operationId: BUILTIN_MODEL_OPERATION_BY_PURPOSE_[compiled.surface.purpose],
            purpose: compiled.surface.purpose,
            invocationId,
            attemptOrdinal: attempt,
            threadId: envelope.provenance.threadId,
            turnId: envelope.provenance.turnId,
            stateRevision: envelope.provenance.stateRevision,
            surfaceDigest: initialSurfaceDigest,
            input: Object.freeze({
              purpose: compiled.surface.purpose,
              invocation_id: invocationId,
              attempt_ordinal: attempt,
              thread_id: envelope.provenance.threadId,
              turn_id: envelope.provenance.turnId,
              state_revision: envelope.provenance.stateRevision,
              surface_digest: initialSurfaceDigest,
            }),
            signal: attemptAbort.signal,
            attempt: () =>
              this.#source.attempt({
                model: input.model,
                surface: compiled.surface,
                attemptOrdinal: attempt,
                signal: attemptAbort.signal,
                onActivity: attemptAbort.refresh,
                onTextCumulative: (text) => {
                  attemptText = text;
                  const visible = visibleRetryPrefix(text, attempt, retryBaselineText);
                  if (visible) {
                    input.emitEphemeral?.(
                      asModelEvent<Event>({
                        type: 'model.text_delta',
                        requestId: invocationId,
                        text: visible,
                      }),
                    );
                  }
                },
                onReasoningCumulative: (text, segmentId) => {
                  attemptReasoning = text;
                  const visible = visibleRetryPrefix(text, attempt, retryBaselineReasoning);
                  const delta = visible.slice(visibleReasoningLength);
                  visibleReasoningLength = visible.length;
                  if (!delta) return;
                  const segment = `${visibleReasoningSegments.get(segmentId) ?? ''}${delta}`;
                  visibleReasoningSegments.set(segmentId, segment);
                  input.emitEphemeral?.(
                    asModelEvent<Event>({
                      type: 'model.reasoning_delta',
                      requestId: invocationId,
                      segmentId,
                      text: segment,
                    }),
                  );
                },
                onReasoningCompleted: (_text, segmentId) => {
                  const segment = visibleReasoningSegments.get(segmentId);
                  visibleReasoningSegments.delete(segmentId);
                  if (!segment) return;
                  input.emitEphemeral?.(
                    asModelEvent<Event>({
                      type: 'model.reasoning_completed',
                      requestId: invocationId,
                      segmentId,
                      text: segment,
                    }),
                  );
                },
              }),
          }),
          attemptAbort.signal,
        );
      } catch (error) {
        attemptAbort.dispose();
        const dispatchCertainty = responseSourceDispatchCertainty(error);
        const reason: ModelInvocationInterruptReason = input.signal?.aborted
          ? 'cancelled'
          : attemptAbort.signal.aborted
            ? 'attempt_timeout'
            : 'provider_failure';
        try {
          await this.#interrupt(input.persistence, envelope, reason, dispatchCertainty);
        } catch (terminalizationError) {
          throw new ModelInvocationExecutionError(invocationId, terminalizationError);
        }
        throw new ModelInvocationExecutionError(invocationId, error);
      }
      attemptAbort.dispose();
      if (input.signal?.aborted || attemptAbort.signal.aborted) {
        const reason: ModelInvocationInterruptReason = input.signal?.aborted
          ? 'cancelled'
          : 'attempt_timeout';
        await this.#interrupt(input.persistence, envelope, reason, 'attempted');
        throw abortReason(input.signal?.aborted ? input.signal : attemptAbort.signal);
      }
      if (outcome.kind === 'success') {
        const responseRecord: ModelResponseRecord = {
          schema: MODEL_RESPONSE_RECORD_SCHEMA_,
          invocationId,
          surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
          route: compiled.surface.route,
          response: outcome.response,
          nativeReplayState: outcome.nativeReplayState,
        };
        const responseArtifact = this.#artifacts.writeResponse(responseRecord);
        const normalized = deepFreeze({ invocationId, ...outcome.response });
        return this.#pendingCompletion(
          input.persistence,
          envelope,
          responseArtifact,
          normalized,
          input.signal,
        );
      }
      priorError = new ModelAttemptFailureError(
        outcome,
        this.#source.failureError?.(outcome),
        invocationId,
      );
      lastFailureDiagnostic = modelFailureDiagnostic(outcome);
      retryBaselineText = attemptText;
      retryBaselineReasoning = attemptReasoning;
      const transient = outcome.kind === 'retryable_failure';
      if (transient && retryBudgetStartedAt == null) retryBudgetStartedAt = this.#now();
      const retryBudgetRemaining = remainingRetryBudgetMs(
        retryBudgetStartedAt,
        limits.totalTimeBudgetMs,
        this.#now(),
      );
      if (
        input.signal?.aborted ||
        (outcome.kind === 'aborted' && outcome.classification === 'cancelled')
      ) {
        interruptionReason = 'cancelled';
      } else if (!transient) interruptionReason = 'provider_failure';
      if (attempt >= limits.maxAttempts || !transient || retryBudgetRemaining <= 0) break;
      const baseRetryDelayMs = retryDelay(attempt, retryBudgetRemaining);
      retryDelayMs =
        outcome.classification === 'provider_rate_limited'
          ? this.#reserveRateLimitRetryDelay(
              compiled.surface.route.routeFingerprint,
              baseRetryDelayMs,
              retryBudgetRemaining,
            )
          : baseRetryDelayMs;
      // The Source owns one outcome only. Gateway persists retry state and the
      // next attempt receives a separate acknowledgement immediately before it.
      await persistAck(
        input.persistence,
        asModelEvents<Event>([
          {
            type: 'model.retry',
            invocationId,
            attempt,
            maxAttempts: limits.maxAttempts,
            error: 'transient_model_connection_error',
            delayMs: retryDelayMs,
            ...lastFailureDiagnostic,
          },
        ]),
      );
    }
    try {
      await this.#interrupt(
        input.persistence,
        envelope,
        interruptionReason,
        'attempted',
        lastFailureDiagnostic,
      );
    } catch (terminalizationError) {
      throw new ModelInvocationExecutionError(invocationId, terminalizationError);
    }
    if (priorError) throw priorError;
    throw new ModelInvocationExecutionError(
      invocationId,
      new Error('Model invocation attempt budget was exhausted.'),
    );
  }

  #reserveRateLimitRetryDelay(
    routeFingerprint: string,
    baseDelayMs: number,
    remainingMs: number,
  ): number {
    const now = this.#now();
    const earliestRetryAt = now + baseDelayMs;
    const scheduledRetryAt = Math.max(
      earliestRetryAt,
      this.#nextRateLimitRetryAtByRoute.get(routeFingerprint) ?? earliestRetryAt,
    );
    this.#nextRateLimitRetryAtByRoute.set(
      routeFingerprint,
      scheduledRetryAt + Math.max(RATE_LIMIT_RETRY_SLOT_MS, baseDelayMs),
    );
    return Math.max(0, Math.min(scheduledRetryAt - now, remainingMs));
  }

  #pendingCompletion<Event extends BuiltinModelEvent>(
    persistence: ModelInvocationPersistence<ModelInvocationStateView, Event>,
    envelope: ModelDispatchEnvelope,
    responseArtifact: ReturnType<ModelArtifactWriter['writeResponse']>,
    response: Readonly<NormalizedModelResponse>,
    signal?: AbortSignal,
  ): PendingModelCompletion<Event> {
    let committed = false;
    const commitWith = async <T>(
      finalizer: (
        value: Readonly<NormalizedModelResponse>,
      ) => ModelCompletionFinalization<T, Event>,
    ): Promise<T> => {
      if (committed) throw new Error('Model completion handle is single-use.');
      committed = true;
      if (signal?.aborted) {
        await this.#interrupt(persistence, envelope, 'cancelled', 'attempted');
        throw abortReason(signal);
      }
      let finalized: ModelCompletionFinalization<T, Event>;
      try {
        finalized = finalizer(response);
        if (finalized && typeof (finalized as { then?: unknown }).then === 'function') {
          throw new Error('Model completion finalizer must be pure and synchronous.');
        }
      } catch (error) {
        // The Source has already produced an attempted outcome. A private
        // publication/finalization fault must terminalize that attempt before
        // control returns; the single-use handle can never retry the Source.
        await this.#interrupt(persistence, envelope, 'persistence_unavailable', 'attempted');
        throw error;
      }
      if (signal?.aborted) {
        await this.#interrupt(persistence, envelope, 'cancelled', 'attempted');
        throw abortReason(signal);
      }
      const events: BuiltinModelEvent[] = [
        {
          type: 'model.invocation_completed',
          invocationId: envelope.provenance.invocationId,
          responseArtifact,
          finishReason: response.finishReason,
        },
        ...finalized.events,
      ];
      if (envelope.resource.budget.kind === 'reservation') {
        const usage = createZeroModelResourceUsage();
        usage.counters.modelRequests = 1;
        usage.counters.inputTokens = response.usage.inputTokens ?? 0;
        usage.counters.outputTokens = response.usage.outputTokens ?? 0;
        events.push({
          type: 'resource_budget.reconciled',
          reservationId: envelope.resource.budget.reservationId,
          actual: usage,
        });
      }
      await persistAck(persistence, asModelEvents<Event>(events));
      return finalized.value;
    };
    return Object.freeze({
      invocationId: envelope.provenance.invocationId,
      commit: () => commitWith((value) => ({ events: [], value })),
      commitWith,
    });
  }

  async #interrupt<Event extends BuiltinModelEvent>(
    persistence: ModelInvocationPersistence<ModelInvocationStateView, Event>,
    envelope: ModelDispatchEnvelope,
    reasonCode: ModelInvocationInterruptReason,
    dispatchCertainty: 'none' | 'attempted' | 'unknown',
    failureDiagnostic?: ModelFailureDiagnostic,
  ): Promise<void> {
    const events: BuiltinModelEvent[] = [
      {
        type: 'model.invocation_interrupted',
        invocationId: envelope.provenance.invocationId,
        dispatchCertainty,
        reasonCode,
        ...failureDiagnostic,
      },
    ];
    if (envelope.resource.budget.kind === 'reservation') {
      events.push(
        dispatchCertainty === 'none'
          ? {
              type: 'resource_budget.released',
              reservationId: envelope.resource.budget.reservationId,
              proof: 'local_pre_dispatch_failure',
            }
          : {
              type: 'resource_budget.unknown',
              reservationId: envelope.resource.budget.reservationId,
            },
      );
    }
    await persistAck(persistence, asModelEvents<Event>(events));
  }
}

type ModelFailureDiagnostic = Readonly<{
  failureClassification:
    | 'provider_rate_limited'
    | 'provider_unavailable'
    | 'connection_failure'
    | 'attempt_timeout'
    | 'provider_rejected'
    | 'provider_failure'
    | 'cancelled'
    | 'transport_aborted';
  providerStatusCode?: number | null;
  timedOut?: boolean;
}>;

function modelFailureDiagnostic(
  outcome: Exclude<import('@kite-ai/runtime-spi').ModelAttemptOutcome, { kind: 'success' }>,
): ModelFailureDiagnostic {
  if (outcome.kind === 'retryable_failure') {
    return {
      failureClassification: outcome.classification,
      providerStatusCode: outcome.retryObservation.providerStatusCode,
      timedOut: outcome.retryObservation.timedOut,
    };
  }
  if (outcome.kind === 'fatal_failure') {
    return {
      failureClassification: outcome.classification,
      providerStatusCode: outcome.providerStatusCode,
    };
  }
  return { failureClassification: outcome.classification };
}

export function normalizedModelResponseToAIMessage(
  response: Readonly<NormalizedModelResponse>,
): AIMessage {
  const text = response.message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const reasoning = response.message.content
    .filter(
      (part): part is Extract<typeof part, { type: 'reasoning' }> => part.type === 'reasoning',
    )
    .map((part) => part.text)
    .join('');
  const responseId = response.providerMetadata.responseId;
  return aiMessage({
    id: typeof responseId === 'string' ? responseId : undefined,
    content: text,
    tool_calls: response.message.content.flatMap((part) =>
      part.type === 'tool_call'
        ? [
            {
              id: part.toolCallId,
              name: part.toolName,
              args: part.input as Record<string, unknown>,
              type: 'tool_call' as const,
            },
          ]
        : [],
    ),
    additional_kwargs: { reasoning_content: reasoning },
    response_metadata: {
      finishReason: response.finishReason,
      usage: {
        prompt_tokens: response.usage.inputTokens ?? undefined,
        input_tokens: response.usage.inputTokens ?? undefined,
        completion_tokens: response.usage.outputTokens ?? undefined,
        total_tokens: response.usage.totalTokens ?? undefined,
        prompt_cache_hit_tokens: response.usage.cacheReadTokens ?? undefined,
      },
    },
  });
}

export function computeModelInvocationPrivateDigest(domain: string, value: unknown): Sha256Digest {
  return computePrivateModelEvidenceDigest(domain, value);
}

function assertResourceMatchesSurface(
  resource: ModelResourcePreparationPlan,
  compiled: CompiledModelSurface,
): void {
  const requested = compiled.surface.request.maxOutputTokens;
  if (
    requested != null &&
    resource.maxOutputTokens != null &&
    requested > resource.maxOutputTokens
  ) {
    throw new Error('Frozen Model Surface exceeds its admitted output reservation.');
  }
}

function normalizeLimits(
  input: Partial<ModelInvocationEnvelope['resource']['limits']> | undefined,
): ModelInvocationEnvelope['resource']['limits'] {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'perAttemptTimeoutMs' ? 0 : 1)) {
      throw new Error(`Model invocation ${key} must be a positive safe integer.`);
    }
  }
  if (limits.perAttemptTimeoutMs > 0 && limits.perAttemptTimeoutMs > limits.totalTimeBudgetMs) {
    throw new Error('Model per-attempt timeout exceeds its total time budget.');
  }
  return limits;
}

function asModelEvent<Event extends BuiltinModelEvent>(event: BuiltinModelEvent): Event {
  return event as Event;
}

function asModelEvents<Event extends BuiltinModelEvent>(
  events: readonly BuiltinModelEvent[],
): Event[] {
  return events as Event[];
}

async function persistAck<State extends ModelInvocationStateView, Event extends BuiltinModelEvent>(
  persistence: ModelInvocationPersistence<State, Event>,
  events: Event[],
): Promise<void> {
  if (events.length === 0) return;
  let applied: boolean;
  try {
    applied = await persistence.persistEvents(events);
  } catch (error) {
    throw new Error('Model invocation evidence persistence failed.', { cause: error });
  }
  if (!applied) throw new Error('Model invocation evidence acknowledgement was rejected.');
}

async function persistModelAdmission<
  State extends ModelInvocationStateView,
  Event extends BuiltinModelEvent,
>(
  persistence: ModelInvocationPersistence<State, Event>,
  input: {
    readonly invocationId: string;
    readonly events: Event[];
    readonly mailPreparation: ModelMailPreparationDescriptor;
  },
): Promise<void> {
  if (!persistence.persistAdmission)
    throw new Error('Model mail preparation requires atomic admission persistence.');
  let applied: boolean;
  try {
    applied = await persistence.persistAdmission(input);
  } catch (error) {
    throw new Error('Model invocation admission persistence failed.', { cause: error });
  }
  if (!applied) throw new Error('Model invocation admission acknowledgement was rejected.');
}

function retryDelay(attempt: number, remainingMs: number): number {
  return Math.max(0, Math.min(4_000, 500 * 2 ** (attempt - 1), remainingMs));
}

function remainingRetryBudgetMs(
  startedAt: number | undefined,
  totalTimeBudgetMs: number,
  now: number,
): number {
  return startedAt == null ? totalTimeBudgetMs : totalTimeBudgetMs - (now - startedAt);
}

function responseSourceDispatchCertainty(error: unknown): 'none' | 'attempted' {
  if (
    error &&
    typeof error === 'object' &&
    (error as { dispatchCertainty?: unknown }).dispatchCertainty === 'none'
  ) {
    return 'none';
  }
  return 'attempted';
}

function visibleRetryPrefix(value: string, attempt: number, baseline: string): string {
  if (attempt === 1) return value;
  if (baseline.startsWith(value)) return '';
  if (value.startsWith(baseline)) return value.slice(baseline.length);
  return value;
}

function boundedAttemptSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  hardTimeoutMs?: number,
): { signal: AbortSignal; refresh(): void; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardTimer =
    hardTimeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new Error('Model hard attempt deadline elapsed.')),
          hardTimeoutMs,
        );
  const refresh = () => {
    if (disposed || controller.signal.aborted) return;
    if (timeoutMs <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Model attempt timed out.')), timeoutMs);
  };
  const onAbort = () => controller.abort(abortReason(parent!));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  refresh();
  return {
    signal: controller.signal,
    refresh,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function waitForAttemptSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Model invocation aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new Error('Model retry sleep aborted.'));
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
