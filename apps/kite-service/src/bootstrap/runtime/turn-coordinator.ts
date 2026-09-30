import { randomUUID } from 'node:crypto';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type { ContextCompactionProgressPhase } from '@kite-ai/builtin-runtime/model';
import {
  createLocalCompactionDebugReporter,
  createModelSecretDetector,
  ModelAttemptFailureError,
  type SupportedChatModel,
} from '@kite-ai/builtin-runtime/model';
import type { SandboxBackend, ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { SkillManifest, SkillScanOptions } from '@kite-ai/builtin-runtime/skills';
import {
  createSkillCapabilityResolver,
  evaluateSkillActivation,
  refreshSkillCatalog,
} from '@kite-ai/builtin-runtime/skills';
import {
  createRuntimeAbortReason,
  type InteractionMode,
  type RuntimeAbortCause,
  type RuntimeAbortReason,
  type RuntimeCommandContext,
  runtimeAbortCause,
  runtimeAbortMessage,
} from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
  runtimeHostStateInteractionBelongsToCurrentWork as interactionBelongsToCurrentWork,
  requiredBackgroundTaskIds,
  requiredManagedShellIds,
  runtimeHostStateResolveFailureMode as resolveFailureMode,
  type StateRuntimeEffectExecutor,
  UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import { CHILD_SESSION_TASK_USER_GOAL } from '@kite-ai/runtime-host/storage';
import {
  type AppWorkspaceEffectCompositionFactory,
  prepareRuntimeEffectForBudget,
  type RuntimeExecutorDependencies,
} from '#kite-service/bootstrap/runtime/runtime-effect-dependencies';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';
import type {
  SessionLoggingMode,
  SessionLoggingPolicy,
} from '#kite-service/config/session-logging-policy';
import { resolveSessionLoggingPolicy } from '#kite-service/config/session-logging-policy';
import {
  hasPendingSandboxPreparationRecovery,
  SANDBOX_PREPARATION_RECOVERY_,
  type SandboxPreparationRecoveryConsumer,
} from '#kite-service/sandbox/runtime-execution';
import {
  SessionLogCollector,
  type SessionLoggingContentInspector,
} from '#kite-service/session-logger';
import type { CapabilityExecutionPort } from '#runtime-spi';
import { recordRuntimeFailure } from './failures';
import { managedShellOwnerKey, managedShellRuntime } from './managed-shell';
import { projectRuntimeSchedulerFacts } from './scheduler-facts';
import {
  eventsForRunCancellation,
  eventsForSettledSubagentHistory,
  eventsForSupersededTurnRecovery,
  hasSettledSubagentHistoryCandidate,
} from './state-actions';
import {
  type RuntimeActionProvider,
  type RuntimeStateSessionPort,
  runStateRuntimeLoop,
} from './state-runner';
import type {
  RuntimeEffect,
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './state-runtime';
import {
  type BackgroundSubagentControlRuntime,
  backgroundSubagentOwnerKey,
} from './subagent/background-runtime';
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';
import { failedTerminalOutcome } from './terminal-outcome';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';
import {
  assertPrecommittedStartTurn,
  type PrecommittedStartTurnDescriptor,
} from './turn-command-decision';

export function hasTerminalRequiredManagedShell(
  state: Readonly<RuntimeState>,
  executions: ReturnType<typeof managedShellRuntime.listSnapshot>['executions'],
): boolean {
  const requiredShellIds = requiredManagedShellIds(state);
  return (
    requiredShellIds.size > 0 &&
    [...requiredShellIds].every((shellId) =>
      executions.some(
        (execution) =>
          execution.executionId === shellId &&
          execution.kind === 'shell' &&
          execution.status !== 'running' &&
          execution.status !== 'stopping' &&
          execution.cleanupConfirmed,
      ),
    )
  );
}

export function inspectRequiredBackgroundSettlement(
  awaitedTaskIds: ReadonlySet<string>,
  currentState: Readonly<RuntimeState>,
  executions: readonly Readonly<{ executionId: string; status: string }>[],
  recoveryEvents: readonly Readonly<Record<string, unknown>>[],
):
  | { readonly kind: 'none' }
  | { readonly kind: 'state_changed'; readonly events: readonly RuntimeEvent[] } {
  if (awaitedTaskIds.size === 0) return { kind: 'none' };
  const currentRequired = new Set(
    requiredBackgroundTaskIds(currentState).filter((taskId) => awaitedTaskIds.has(taskId)),
  );
  if ([...awaitedTaskIds].every((taskId) => !currentRequired.has(taskId))) {
    return { kind: 'state_changed', events: [] };
  }
  const visibleIds = new Set(executions.map((execution) => execution.executionId));
  const unavailableIds = [
    ...executions
      .filter(
        (execution) =>
          currentRequired.has(execution.executionId) && execution.status === 'unavailable',
      )
      .map((execution) => execution.executionId),
    ...[...currentRequired].filter((taskId) => !visibleIds.has(taskId)),
  ];
  if (unavailableIds.length === 0) return { kind: 'none' };
  const recoveryByTask = new Map(
    recoveryEvents
      .filter(
        (event) =>
          event.type === 'subagent.background_result_persisted' &&
          typeof event.taskId === 'string' &&
          currentRequired.has(event.taskId),
      )
      .map((event) => [event.taskId as string, event as RuntimeEvent] as const),
  );
  if (unavailableIds.some((taskId) => !recoveryByTask.has(taskId))) {
    throw new Error('Required background sub-agent settlement requires explicit recovery.');
  }
  return {
    kind: 'state_changed',
    events: unavailableIds.map((taskId) => recoveryByTask.get(taskId) as RuntimeEvent),
  };
}

function exhaustedModelFailureMode(
  error: unknown,
): 'model_timeout' | 'model_rate_limit' | 'model_server_error' | undefined {
  if (!(error instanceof ModelAttemptFailureError)) return undefined;
  if (error.outcome.kind !== 'retryable_failure') return undefined;
  switch (error.outcome.classification) {
    case 'attempt_timeout':
      return 'model_timeout';
    case 'provider_rate_limited':
      return 'model_rate_limit';
    case 'provider_unavailable':
    case 'connection_failure':
      return 'model_server_error';
  }
}

function fatalModelFailure(error: unknown):
  | {
      readonly kind: 'provider_auth_required' | 'model_refused' | 'model_server_error';
      readonly message: string;
    }
  | undefined {
  if (!(error instanceof ModelAttemptFailureError) || error.outcome.kind !== 'fatal_failure') {
    return undefined;
  }
  if (error.outcome.classification === 'provider_failure') {
    return {
      kind: 'model_server_error',
      message: 'Model Provider failed the request.',
    };
  }
  if (error.outcome.providerStatusCode === 401 || error.outcome.providerStatusCode === 403) {
    return {
      kind: 'provider_auth_required',
      message: 'Model Provider rejected authentication or authorization.',
    };
  }
  return {
    kind: 'model_refused',
    message: 'Model Provider rejected the request.',
  };
}

/** Inputs for the graph-free runtime entry point. */
export interface RuntimeTurnInput {
  task: string;
  /** User-authored goal before App/project context is appended to `task`. */
  userGoal?: string;
  userId: string;
  threadId: string;
  workspace: string;
  /** Host-supplied stable private identity; production never allocates it in Core. */
  recoveryIdentityKey: string;
  config: AgentConfig;
  /** App-selected concrete Model binding; Core never constructs a Provider model. */
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  /** Runtime Host registry port; required by capability-backed production tools. */
  capabilityExecution?: CapabilityExecutionPort;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  /** Explicit user-requested Workflow Contract activations for the initial task. */
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  /**
   * A Host command transaction has already committed every start fact.  The
   * runner must validate this exact State identity and continue from it rather
   * than appending a second message, task, turn, or skill activation.
   */
  precommittedStart?: PrecommittedStartTurnDescriptor;
  /** Exact first child Run already activated by the child Session transaction. */
  precommittedChildActivation?: PrecommittedChildActivationDescriptor;
  /** Continue the already-active durable turn after a recovered interaction receipt commits. */
  resumeCommittedInteraction?: boolean;
  /** Host Session-mailbox authority retained by detached background children. */
  backgroundModelInvocationPersistence?: RuntimeExecutorDependencies['backgroundModelInvocationPersistence'];
  /** Private parent Task receipt owner for independent child admission. */
  childSessionAcceptance?: RuntimeExecutorDependencies['childSessionAcceptance'];
  /** Exact sealed grant ceiling for an independently activated child. */
  childToolCeiling?: RuntimeExecutorDependencies['childToolCeiling'];
  crossSessionQueueMail?: RuntimeExecutorDependencies['crossSessionQueueMail'];
  followupPolicyForPreparedTool?: RuntimeExecutorDependencies['followupPolicyForPreparedTool'];
  currentTurnFollowup?: RuntimeExecutorDependencies['currentTurnFollowup'];
  crossSessionChildIdentity?: RuntimeExecutorDependencies['crossSessionChildIdentity'];
  /** App-selected Model/Artifact/Subagent mechanisms; Core never constructs a concrete owner. */
  modelInvocationRuntime: {
    /** App projection of the Host's one frozen Builtin capability snapshot. */
    builtinToolCatalog: import('@kite-ai/builtin-runtime').BuiltinToolCatalogProjection;
    /** App-owned pipeline composition derived from that exact projection. */
    toolPipelineComposition?: AppToolPipelineComposition;
    /** App-owned single Plan Artifact store; absent only for unavailable composition. */
    planArtifacts?: import('@kite-ai/builtin-runtime/planning').PlanArtifactStore;
    gateway?: import('@kite-ai/builtin-runtime/model').ModelInvocationGateway;
    modelEffects?: import('@kite-ai/builtin-runtime/model').BuiltinModelEffectCoordinator;
    evidence?: import('@kite-ai/builtin-runtime/model').ModelArtifactEvidenceAvailability;
    capabilityArtifacts?: import('@kite-ai/builtin-runtime').CapabilityArtifactAccess;
    workspaceFilesystem?: import('@kite-ai/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntime;
    sandboxPreparationArtifacts?: import('@kite-ai/builtin-runtime/sandbox').SandboxPreparationArtifactStore;
    subagentRuntimeFactory?: import('./subagent/pipeline-runtime').AppSubagentRuntimeFactory;
    reconcilePendingSubagents?: (
      persistence: Parameters<
        typeof import('./subagent-provider-recovery').reconcilePendingSubagentProvidersAfterCrash
      >[0]['persistence'],
      options?: Readonly<{
        terminalDisposition?: 'unknown' | 'preserve_user_cancellation';
      }>,
    ) => Promise<boolean>;
    subagentContinuationArtifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
    subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
    checkpointArtifacts?: Pick<
      import('@kite-ai/builtin-runtime/subagent').SubagentCheckpointArtifactStore,
      'write'
    >;
  };
  interactionMode?: InteractionMode;
  /** 初始执行阶段 / Initial execution phase */
  phase?: 'planning' | 'building';
  thinkingLevel?: string | null;
  sandboxBackend?: SandboxBackend | 'unknown';
  signal?: AbortSignal;
  /** Admission-time command identity; never recovered from Session state. */
  commandContext?: Readonly<RuntimeCommandContext>;
  /** Optional Worker-owned effect composition factory bound to that context. */
  workspaceEffectCompositionFactory?: AppWorkspaceEffectCompositionFactory;
  /** Host-owned controller callback; production execution always supplies it. */
  abortExecution?: (reason: RuntimeAbortReason | string) => void;
  /** Exact State 27 session owned by the App/Host session coordinator. */
  runtimeSession: RuntimeStateSessionPort & {
    readonly runtimeStore: StateRuntimeStorage;
    processEvents(events: RuntimeEvent[]): void;
  };
  /** Exact effect port owned by the App/Host session coordinator. */
  createRuntimeEffectPort: (
    dependencies: RuntimeExecutorDependencies,
  ) => StateRuntimeEffectExecutor<RuntimeState, RuntimeEvent, RuntimeEffect>;
  frontend?: string;
  /** App-resolved artifact/user/project policy. App composition roots should always inject it. */
  sessionLoggingPolicy?: SessionLoggingPolicy;
  /** Trusted detector required before content-mode text can be persisted. */
  sessionLoggingContentInspector?: SessionLoggingContentInspector;
  onSessionLoggingStatus?: (status: { mode: SessionLoggingMode }) => void;
  onSessionLoggingDiagnostic?: (message: string) => void;
  /** Runtime coordinator registration for ordinary non-command cancellation. */
  registerRunCancellation?: (
    cancelRun: ((reason?: string, cause?: RuntimeAbortCause) => RuntimeEvent[]) | null,
  ) => void;
  /** Command cancellation consumes already-committed events and must not persist another batch. */
  registerCommittedCommandCancellation?: (
    cancel: RuntimeCommittedCommandCancellation | null,
  ) => void;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
}

/** Contains identities only; the delegated task body remains in its private Artifact. */
export interface PrecommittedChildActivationDescriptor {
  readonly sessionId: string;
  readonly committedRevision: number;
  readonly childRunId: string;
  readonly parentSessionId: string;
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly attempt: number;
  readonly childInvocationId: string;
  readonly grantDigest: string;
  readonly taskArtifactId: string;
  readonly taskArtifactByteLength: number;
  readonly taskArtifactDigest: string;
  readonly taskTextDigest: string;
  readonly fundingRunId: string;
  readonly delegatedReservationId: string;
  readonly delegatedUpperBoundDigest: string;
}

export function assertPrecommittedChildActivation(
  state: Readonly<RuntimeState>,
  descriptor: PrecommittedChildActivationDescriptor,
  sessionId: string,
  currentRunId: string | null | undefined,
): void {
  const origin = state.childSessionOrigin;
  if (
    descriptor.sessionId !== sessionId ||
    state.session.threadId !== sessionId ||
    state.revision !== descriptor.committedRevision ||
    state.turn.turnId !== descriptor.childRunId ||
    state.turn.status !== 'active' ||
    currentRunId !== descriptor.childRunId ||
    state.resourceBudget.status !== 'active' ||
    state.resourceBudget.runId !== descriptor.childRunId ||
    state.transcript.messages.length !== 0 ||
    state.activeTaskId !== descriptor.childInvocationId ||
    state.tasks[descriptor.childInvocationId]?.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
    state.tasks[descriptor.childInvocationId]?.status !== 'active' ||
    !origin ||
    origin.terminal !== undefined ||
    origin.taskInputAdmitted !== true ||
    origin.parentSessionId !== descriptor.parentSessionId ||
    origin.parentInvocationId !== descriptor.parentInvocationId ||
    origin.parentToolCallId !== descriptor.parentToolCallId ||
    origin.attempt !== descriptor.attempt ||
    origin.childInvocationId !== descriptor.childInvocationId ||
    origin.grantDigest !== descriptor.grantDigest ||
    origin.taskArtifactRef.artifactId !== descriptor.taskArtifactId ||
    origin.taskArtifactRef.kind !== 'subagent_task' ||
    origin.taskArtifactRef.integrityIdentifier !== descriptor.taskArtifactDigest ||
    origin.taskArtifactRef.byteLength !== descriptor.taskArtifactByteLength ||
    origin.taskArtifactDigest !== descriptor.taskArtifactDigest ||
    origin.taskTextDigest !== descriptor.taskTextDigest ||
    origin.fundingRunId !== descriptor.fundingRunId ||
    origin.delegatedReservationId !== descriptor.delegatedReservationId ||
    origin.delegatedUpperBoundDigest !== descriptor.delegatedUpperBoundDigest
  ) {
    throw new Error('Runtime precommitted child activation does not match current State and Run.');
  }
}

export type RuntimeCommittedCommandCancellation = (
  events: readonly RuntimeEvent[],
  reason?: string,
) => void;

/** Execute one turn against the caller-owned State 27 session and effect port. */
export async function* executeRuntimeTurn(
  input: RuntimeTurnInput,
  provider: RuntimeActionProvider,
): AsyncGenerator<RuntimeEvent> {
  const model = input.model;
  const modelInvocationRuntime = input.modelInvocationRuntime;
  const modelInvocationGateway = modelInvocationRuntime.gateway;
  const kernel = input.runtimeSession;
  if (kernel.getState().session.threadId !== input.threadId) {
    throw new Error('Runtime Kernel session identity mismatch.');
  }
  const sessionLoggingPolicy =
    input.sessionLoggingPolicy ??
    input.config.sessionLoggingPolicy ??
    resolveSessionLoggingPolicy({
      enabled: getFeatureFlags(input.config).sessionLoggingPolicy,
    });
  input.onSessionLoggingStatus?.({ mode: sessionLoggingPolicy.mode });
  const sessionLoggingContentInspector =
    input.sessionLoggingContentInspector ??
    createModelSecretDetector({
      knownSecrets: [input.config.apiKey],
    });
  const collector = new SessionLogCollector(
    input.threadId,
    input.workspace,
    input.frontend ?? 'runtime',
    { provider: input.config.providerName, name: input.config.modelName },
    {
      policy: sessionLoggingPolicy,
      contentInspector: sessionLoggingContentInspector,
      onDiagnostic: (diagnostic) => input.onSessionLoggingDiagnostic?.(diagnostic.message),
    },
  );
  const reconcilePendingSubagentProviders = async (
    terminalDisposition: 'unknown' | 'preserve_user_cancellation' = 'unknown',
  ): Promise<{
    readonly recovered: boolean;
    readonly events: RuntimeEvent[];
  }> => {
    if (!hasPendingSubagentProviderRecovery(kernel.getState())) {
      return { recovered: true, events: [] };
    }
    const reconcilePendingSubagents =
      'reconcilePendingSubagents' in modelInvocationRuntime
        ? modelInvocationRuntime.reconcilePendingSubagents
        : undefined;
    const events: RuntimeEvent[] = [];
    const recovered = reconcilePendingSubagents
      ? await reconcilePendingSubagents(
          {
            getState: () => kernel.getState(),
            persistEvents: async (pendingEvents) => {
              try {
                kernel.processEvents(pendingEvents);
                events.push(...pendingEvents);
                return true;
              } catch {
                return false;
              }
            },
          },
          { terminalDisposition },
        )
      : false;
    return { recovered, events };
  };
  let exitStatus: 'completed' | 'aborted' | 'fatal' = 'completed';
  let runCancelled = false;
  let stateRunner: AsyncGenerator<RuntimeEvent> | undefined;
  let runnerFailed = false;
  let runnerCompleted = false;
  let runDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineCancellationEvents: RuntimeEvent[] = [];
  let deadlineEventsYielded = false;
  let externalCancellationEvents: RuntimeEvent[] = [];
  let externalCancellationEventsYielded = false;
  if (input.abortExecution && !input.signal) {
    throw new Error('Host-owned execution cancellation requires its AbortSignal.');
  }
  const localExecutionController = input.abortExecution ? undefined : new AbortController();
  const executionSignal = input.abortExecution ? input.signal! : localExecutionController!.signal;
  const abortExecution = (reason: string, cause: RuntimeAbortCause = 'error'): void => {
    const abortReason = createRuntimeAbortReason(cause, reason);
    if (input.abortExecution) input.abortExecution(abortReason);
    else localExecutionController!.abort(abortReason);
  };
  const cancelRun = (
    reason = 'Cancelled by user.',
    cause: 'user' | 'error' = 'user',
  ): RuntimeEvent[] => {
    if (runCancelled || kernel.getState().turn.status !== 'active') return [];
    runCancelled = true;
    exitStatus = 'aborted';
    const events = eventsForRunCancellation(kernel.getState(), reason, cause);
    try {
      kernel.processEventBatch(events);
      const canonicalEvents = [...kernel.getLastAppliedEvents()];
      for (const event of canonicalEvents) collector.recordRuntime(event);
      return canonicalEvents;
    } finally {
      // A fenced/failed durable cancellation must still stop local Provider I/O.
      // Only successfully committed events above may be published as terminal facts.
      abortExecution(reason, cause);
    }
  };
  const interruptClosedStream = (): void => {
    const state = kernel.getState();
    if (state.turn.status !== 'active') return;
    const reason = 'Runtime execution stream closed before a durable Turn terminal.';
    runCancelled = true;
    exitStatus = 'fatal';
    try {
      const events = kernel.processEventBatch([
        {
          type: 'run.error',
          message: reason,
          recoverable: false,
          turnId: state.turn.turnId,
          outcome: {
            version: 1,
            status: 'unknown',
            reasonCode: 'unknown',
            knownExternalEffects: 'unknown',
            safeRetry: false,
            recoveryEntry: 'reconcile',
            pendingVerification: false,
          },
        },
        ...eventsForRunCancellation(state, reason, 'error'),
      ]);
      for (const event of events) collector.recordRuntime(event);
    } finally {
      // Stop local I/O even if this owner can no longer commit a terminal.
      abortExecution(reason);
    }
  };
  const cancelAfterCommittedCommand = (
    events: readonly RuntimeEvent[],
    reason = 'Cancelled by user.',
  ): void => {
    if (runCancelled) return;
    runCancelled = true;
    exitStatus = 'aborted';
    for (const event of events) collector.recordRuntime(event);
    abortExecution(reason, 'user');
  };
  const cancelForDeadline = (): RuntimeEvent[] => {
    const cancellationEvents = cancelRun('Runtime deadline exceeded.', 'error');
    if (cancellationEvents.length === 0) return [];
    const hasUnknownEffects =
      kernel.getState().resourceBudget.status === 'active' &&
      Object.values(kernel.getState().resourceBudget.reservations).some(
        (reservation) => reservation.state === 'unknown',
      );
    const failure = recordRuntimeFailure({
      kind: hasUnknownEffects ? 'cancel_incomplete' : 'budget_exceeded',
      message: hasUnknownEffects
        ? 'Runtime deadline exceeded before cleanup could be confirmed.'
        : 'Runtime deadline exceeded.',
      phase: 'building',
      turnId: kernel.getState().turn.turnId,
      userVisible: true,
    });
    const errorEvent: RuntimeEvent = {
      type: 'run.error',
      message: failure.message,
      recoverable: false,
      failure: failure.failure,
      turnId: failure.turnId,
      outcome: failedTerminalOutcome(failure.failure, {
        knownExternalEffects: hasUnknownEffects ? 'unknown' : 'known',
      }),
    };
    kernel.processEvent(errorEvent);
    const canonicalErrorEvents = [...kernel.getLastAppliedEvents()];
    for (const event of canonicalErrorEvents) collector.recordRuntime(event);
    return [...cancellationEvents, ...canonicalErrorEvents];
  };
  const externalAbortReason = (): string => runtimeAbortMessage(input.signal?.reason);
  const forwardExternalAbort = () => {
    // The public AbortSignal is a real cancellation boundary, not merely a
    // transport hint. Persist the same durable cancellation transaction used
    // by the TUI before unblocking any effect/interaction wait.
    try {
      externalCancellationEvents = cancelRun(
        externalAbortReason(),
        runtimeAbortCause(input.signal?.reason),
      );
    } catch (error) {
      // Do not throw from AbortSignal dispatch: other Provider abort listeners
      // must still run, even after this Session has lost write authority.
      console.error('External cancellation could not be persisted; continuing local abort.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (input.signal?.aborted) forwardExternalAbort();
  else input.signal?.addEventListener('abort', forwardExternalAbort, { once: true });
  const scheduleRunDeadline = (): void => {
    if (runDeadlineTimer) {
      clearTimeout(runDeadlineTimer);
      runDeadlineTimer = undefined;
    }
    const current = kernel.getState();
    const budget = current.resourceBudget;
    if (
      runCancelled ||
      current.turn.status !== 'active' ||
      budget.status !== 'active' ||
      budget.requiredChildWait
    )
      return;
    const remainingMs = Math.max(0, Date.parse(budget.deadlineAt) - Date.now());
    runDeadlineTimer = setTimeout(() => {
      runDeadlineTimer = undefined;
      const latest = kernel.getState();
      if (runCancelled || latest.turn.status !== 'active') return;
      if (latest.resourceBudget.status !== 'active' || latest.resourceBudget.requiredChildWait)
        return;
      if (Date.now() < Date.parse(latest.resourceBudget.deadlineAt)) {
        scheduleRunDeadline();
        return;
      }
      deadlineCancellationEvents = cancelForDeadline();
    }, remainingMs);
  };
  input.registerRunCancellation?.((reason?: string, cause?: RuntimeAbortCause) =>
    cancelRun(reason, cause),
  );
  input.registerCommittedCommandCancellation?.(cancelAfterCommittedCommand);
  try {
    if (externalCancellationEvents.length > 0) {
      externalCancellationEventsYielded = true;
      yield* externalCancellationEvents;
      return;
    }
    const precommittedStart = input.precommittedStart;
    const precommittedChildActivation = input.precommittedChildActivation;
    if (precommittedStart && precommittedChildActivation) {
      throw new Error('Runtime turn cannot use two precommitted start identities.');
    }
    if (precommittedStart) {
      // Validate the exact command commit before budget initialization or
      // recovery appends any runner-owned events and advances State revision.
      assertPrecommittedStartTurn(kernel.getState(), precommittedStart, input.threadId);
    }
    if (precommittedChildActivation) {
      if (!getFeatureFlags(input.config).resourceBudget) {
        throw new Error('Runtime child activation requires resource budgeting.');
      }
      assertPrecommittedChildActivation(
        kernel.getState(),
        precommittedChildActivation,
        input.threadId,
        kernel.currentRunId?.(),
      );
    }
    if (getFeatureFlags(input.config).resourceBudget) {
      const budgetRunId = precommittedStart?.turnId;
      const budget = kernel.getState().resourceBudget;
      const configureForNewRun =
        (budgetRunId !== undefined &&
          (budget.status === 'unconfigured' || budget.runId !== budgetRunId)) ||
        (budgetRunId === undefined &&
          !precommittedChildActivation &&
          budget.status === 'active' &&
          kernel.getState().turn.status !== 'active');
      if (budget.status !== 'unconfigured' && !configureForNewRun) {
        if (budget.status !== 'active') {
          const failure = recordRuntimeFailure({
            kind: 'mandatory_policy_unavailable',
            message:
              'ResourceBudget cannot start from a legacy snapshot; start a new production run.',
            phase: 'building',
            turnId: kernel.getState().turn.turnId,
            userVisible: true,
          });
          const event: RuntimeEvent = {
            type: 'run.error',
            message: failure.message,
            recoverable: false,
            failure: failure.failure,
            turnId: failure.turnId,
            outcome: failedTerminalOutcome(failure.failure, {
              knownExternalEffects: 'none',
            }),
          };
          for (const applied of kernel.processEventBatch([
            event,
            ...eventsForRunCancellation(kernel.getState(), event.message, 'error'),
          ])) {
            collector.recordRuntime(applied);
            yield applied;
          }
          return;
        }
        if (
          !kernel.getState().childSessionOrigin &&
          budget.budget.unboundedCumulativeUsage !== true &&
          budget.budget.durationOnlyChildRun !== true
        ) {
          const event: RuntimeEvent = {
            type: 'resource_budget.cumulative_limits_removed',
            runId: budget.runId,
          };
          for (const accepted of kernel.processEventBatch([event])) {
            collector.recordRuntime(accepted);
            yield accepted;
          }
        }
      } else {
        const startedAt = new Date();
        const maxConcurrentSubagents =
          input.config.resources?.maxConcurrentSubagents ??
          UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_.maxConcurrentSubagents;
        const event: RuntimeEvent = {
          type: 'resource_budget.configured',
          runId: budgetRunId ?? randomUUID(),
          startedAt: startedAt.toISOString(),
          deadlineAt: new Date(
            startedAt.getTime() + UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_.maxRunDurationMs,
          ).toISOString(),
          budget: {
            ...UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_,
            maxConcurrentSubagents,
            maxConcurrentWriters: maxConcurrentSubagents,
          },
        };
        const applied = kernel.processEventBatch([event]);
        scheduleRunDeadline();
        for (const accepted of applied) {
          collector.recordRuntime(accepted);
          yield accepted;
        }
      }
    }
    const activeBudget = kernel.getState().resourceBudget;
    if (activeBudget.status === 'active') scheduleRunDeadline();
    if (hasPendingSubagentProviderRecovery(kernel.getState())) {
      const recovery = await reconcilePendingSubagentProviders();
      for (const event of recovery.events) {
        collector.recordRuntime(event);
        yield event;
      }
      if (!recovery.recovered) {
        const event: RuntimeEvent = {
          type: 'run.error',
          message: 'Subagent Provider crash recovery could not be confirmed.',
          recoverable: false,
          turnId: kernel.getState().turn.turnId,
        };
        for (const applied of kernel.processEventBatch([
          event,
          ...eventsForRunCancellation(kernel.getState(), event.message, 'error'),
        ])) {
          collector.recordRuntime(applied);
          yield applied;
        }
        return;
      }
    }
    if (hasPendingSandboxPreparationRecovery(kernel.getState())) {
      const artifacts =
        'sandboxPreparationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.sandboxPreparationArtifacts
          : undefined;
      const recovery = (
        input.shellExecutor as ShellExecutor & Partial<SandboxPreparationRecoveryConsumer>
      )?.[SANDBOX_PREPARATION_RECOVERY_];
      const recoveryEvents: RuntimeEvent[] = [];
      const recovered =
        artifacts && recovery
          ? await recovery.call(input.shellExecutor, {
              artifacts,
              persistence: {
                getState: () => kernel.getState(),
                persistEvents: async (events) => {
                  try {
                    kernel.processEvents(events);
                    recoveryEvents.push(...events);
                    return true;
                  } catch {
                    return false;
                  }
                },
              },
            })
          : false;
      for (const event of recoveryEvents) {
        collector.recordRuntime(event);
        yield event;
      }
      if (!recovered) {
        const event: RuntimeEvent = {
          type: 'run.error',
          message: 'Sandbox preparation crash recovery could not be confirmed.',
          recoverable: false,
          turnId: kernel.getState().turn.turnId,
        };
        for (const applied of kernel.processEventBatch([
          event,
          ...eventsForRunCancellation(kernel.getState(), event.message, 'error'),
        ])) {
          collector.recordRuntime(applied);
          yield applied;
        }
        return;
      }
    }
    if (!precommittedStart && !precommittedChildActivation) {
      const resumedInteraction =
        input.resumeCommittedInteraction === true ||
        (getActiveTask(kernel.getState()) && interactionBelongsToCurrentWork(kernel.getState()));
      if (!resumedInteraction) {
        const recoveryEvents = eventsForSupersededTurnRecovery(kernel.getState());
        if (recoveryEvents.length > 0) {
          kernel.processEventBatch(recoveryEvents);
          for (const event of kernel.getLastAppliedEvents()) {
            collector.recordRuntime(event);
            yield event;
          }
        }

        // Shift+Tab persists a planning_empty placeholder before the user has
        // supplied a goal. Close that placeholder explicitly so the real Task
        // retains the submitted prompt as its durable userGoal.
        const placeholder = getActiveTask(kernel.getState());
        if (
          input.phase === 'planning' &&
          placeholder?.userGoal.trim() === '' &&
          getActivePlanning(kernel.getState()).kind === 'planning_empty'
        ) {
          const cancelled: RuntimeEvent = {
            type: 'task.cancelled',
            taskId: placeholder.taskId,
            reason: 'Replaced Plan Mode placeholder with the submitted task.',
          };
          for (const applied of kernel.processEventBatch([cancelled])) {
            collector.recordRuntime(applied);
            yield applied;
          }
        }

        if (input.phase === 'planning' && !getActiveTask(kernel.getState())) {
          const taskStarted: RuntimeEvent = {
            type: 'task.started',
            taskId: randomUUID(),
            userGoal: input.userGoal ?? input.task,
            turnId: kernel.getState().turn.turnId,
          };
          for (const applied of kernel.processEventBatch([taskStarted])) {
            collector.recordRuntime(applied);
            yield applied;
          }
        }

        if (input.phase === 'planning') {
          const activeTask = getActiveTask(kernel.getState());
          if (activeTask) {
            const entered: RuntimeEvent = {
              type: 'planning.entered',
              taskId: activeTask.taskId,
              source: 'user_command',
            };
            for (const applied of kernel.processEventBatch([entered])) {
              collector.recordRuntime(applied);
              yield applied;
            }
          }
        }

        const initial: RuntimeEvent = {
          type: 'user.message_appended',
          messageId: randomUUID(),
          content: input.task,
          ...(input.userGoal ? { userGoal: input.userGoal } : {}),
        };
        const turnStarted: RuntimeEvent = {
          type: 'turn.started',
          turnId: crypto.randomUUID(),
        };
        const acceptedTurnEvents = kernel.processEventBatch([initial, turnStarted]);
        for (const event of acceptedTurnEvents) {
          collector.recordRuntime(event);
          yield event;
        }

        if (input.initialSkillActivations && input.initialSkillActivations.length > 0) {
          const catalog = input.skillOptions
            ? refreshSkillCatalog(input.skillOptions, {
                resolveCapability: createSkillCapabilityResolver(input.mcpManager),
              })
            : undefined;
          for (const requested of input.initialSkillActivations) {
            const evaluation = catalog
              ? evaluateSkillActivation({
                  state: kernel.getState(),
                  catalog,
                  flags: getFeatureFlags(input.config),
                  request: {
                    skillId: requested.skillId,
                    input: requested.input,
                    requestedBy: 'user',
                    implicit: false,
                  },
                })
              : { ok: false as const, reason: 'Skill catalog is unavailable.' };
            if (!evaluation.ok) {
              const failed: RuntimeEvent = {
                type: 'run.error',
                message: `Skill activation rejected: ${evaluation.reason}`,
                recoverable: false,
                turnId: kernel.getState().turn.turnId,
              };
              for (const applied of kernel.processEventBatch([
                failed,
                ...eventsForRunCancellation(kernel.getState(), failed.message, 'error'),
              ])) {
                collector.recordRuntime(applied);
                yield applied;
              }
              return;
            }
            for (const event of kernel.processEventBatch(evaluation.events)) {
              collector.recordRuntime(event);
              yield event;
            }
          }
        }
      }
    }

    // Independent Session TriggerTurn and interrupt require their exact Host
    // command commits in addition to the QueueOnly delivery authority.
    const queueOnlyMailboxAvailable = Boolean(
      input.crossSessionQueueMail &&
        kernel.commitCrossSessionQueueMailCommand &&
        kernel.persistCrossSessionQueueMailModelInput,
    );
    const agentMailboxAvailable = Boolean(
      queueOnlyMailboxAvailable &&
        kernel.commitCrossSessionFollowupCommand &&
        kernel.commitCrossSessionInterruptCommand &&
        input.followupPolicyForPreparedTool,
    );
    const agentMailboxQueueOnlyAvailable = queueOnlyMailboxAvailable && !agentMailboxAvailable;
    const executorDependencies: RuntimeExecutorDependencies = {
      config: input.config,
      model,
      shellExecutor: input.shellExecutor,
      sandboxBackend: input.sandboxBackend,
      mcpManager: input.mcpManager,
      capabilityExecution: input.capabilityExecution,
      builtinToolCatalog: modelInvocationRuntime.builtinToolCatalog,
      toolPipelineComposition: modelInvocationRuntime.toolPipelineComposition,
      planArtifactStore:
        'planArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.planArtifacts
          : undefined,
      runtimeStore: kernel.runtimeStore,
      childSessionAcceptance: input.childSessionAcceptance,
      childToolCeiling: input.childToolCeiling,
      crossSessionQueueMail: input.crossSessionQueueMail,
      followupPolicyForPreparedTool: input.followupPolicyForPreparedTool,
      currentTurnFollowup: input.currentTurnFollowup,
      crossSessionChildIdentity: input.crossSessionChildIdentity,
      agentMailboxAvailable,
      agentMailboxQueueOnlyAvailable,
      skills: input.skills,
      skillOptions: input.skillOptions,
      signal: executionSignal,
      ...(input.commandContext === undefined ? {} : { commandContext: input.commandContext }),
      ...(input.workspaceEffectCompositionFactory === undefined
        ? {}
        : { workspaceEffectCompositionFactory: input.workspaceEffectCompositionFactory }),
      onCompactionProgress: input.onCompactionProgress,
      compactionReporter: input.config.compaction?.localDebug?.enabled
        ? createLocalCompactionDebugReporter({
            enabled: true,
            directory: input.config.compaction.localDebug.directory,
            sessionId: input.threadId,
          })
        : undefined,
      modelInvocationGateway,
      modelEffectCoordinator: modelInvocationRuntime.modelEffects,
      capabilityArtifactStore:
        'capabilityArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.capabilityArtifacts
          : undefined,
      workspaceFilesystemRuntime:
        'workspaceFilesystem' in modelInvocationRuntime
          ? modelInvocationRuntime.workspaceFilesystem
          : undefined,
      sandboxPreparationArtifacts:
        'sandboxPreparationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.sandboxPreparationArtifacts
          : undefined,
      subagentRuntimeFactory:
        'subagentRuntimeFactory' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentRuntimeFactory
          : undefined,
      delegatedTaskArtifacts:
        'delegatedTaskArtifacts' in modelInvocationRuntime
          ? (modelInvocationRuntime.delegatedTaskArtifacts as RuntimeExecutorDependencies['delegatedTaskArtifacts'])
          : undefined,
      backgroundSubagentRuntime:
        'backgroundSubagentRuntime' in modelInvocationRuntime
          ? (modelInvocationRuntime.backgroundSubagentRuntime as RuntimeExecutorDependencies['backgroundSubagentRuntime'])
          : undefined,
      afterTurnContinuationRuntime:
        'afterTurnContinuationRuntime' in modelInvocationRuntime
          ? (modelInvocationRuntime.afterTurnContinuationRuntime as RuntimeExecutorDependencies['afterTurnContinuationRuntime'])
          : undefined,
      backgroundModelInvocationPersistence: input.backgroundModelInvocationPersistence,
      subagentContinuationArtifacts:
        'subagentContinuationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentContinuationArtifacts
          : undefined,
      subagentTaskRequests:
        'subagentTaskRequests' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentTaskRequests
          : undefined,
      checkpointArtifacts:
        'checkpointArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.checkpointArtifacts
          : undefined,
    };
    const executor = input.createRuntimeEffectPort(executorDependencies);
    stateRunner = runStateRuntimeLoop(
      kernel,
      executor,
      provider,
      10_000,
      (effect, state) =>
        getFeatureFlags(input.config).resourceBudget
          ? prepareRuntimeEffectForBudget(effect, state, {
              ...executorDependencies,
              subagentEventSink: () => {},
            })
          : effect,
      executionSignal,
      (state) => projectRuntimeSchedulerFacts(state, modelInvocationRuntime.builtinToolCatalog),
      (error) => {
        if (executionSignal.aborted) return;
        runnerFailed = true;
        // This is an execution failure, not user cancellation or a waiver of
        // unknown effects. The catch below persists the classified failure.
        runCancelled = true;
        abortExecution(error instanceof Error ? error.message : String(error));
      },
      async (state, waitSignal) => {
        const revision = state.revision;
        const ownerKey = managedShellOwnerKey(input.threadId, input.workspace);
        const shellWatermark = managedShellRuntime.ownerWatermark(ownerKey);
        const children =
          'backgroundSubagentRuntime' in modelInvocationRuntime
            ? (modelInvocationRuntime.backgroundSubagentRuntime as
                | BackgroundSubagentControlRuntime
                | undefined)
            : undefined;
        const childOwnerKey = backgroundSubagentOwnerKey(input.threadId, input.recoveryIdentityKey);
        const childWatermark = children?.ownerWatermark(childOwnerKey);
        const inspectRequiredShells = (currentState: Readonly<RuntimeState>) => {
          const executions = managedShellRuntime.listSnapshot(input.threadId, ownerKey).executions;
          for (const shellId of requiredManagedShellIds(currentState)) {
            if (!executions.some((execution) => execution.executionId === shellId)) {
              throw new Error(`Required managed Shell owner is unavailable: ${shellId}`);
            }
          }
          return hasTerminalRequiredManagedShell(currentState, executions);
        };
        const requiredBackground = new Set(requiredBackgroundTaskIds(state));
        const awaitedBackground = new Set(
          state.completionGuard.waitingReason?.kind === 'required_background'
            ? state.completionGuard.waitingReason.taskIds
            : requiredBackground,
        );
        let pendingIndependentTaskIds: string[] = [];
        const inspectRequiredBackground = async () => {
          if (awaitedBackground.size === 0) return undefined;
          const currentState = kernel.getState();
          if (currentState.revision !== revision) return 'state_changed' as const;
          const recoveryBlocked = Object.values(currentState.capabilities.invocations).find(
            (invocation) =>
              awaitedBackground.has(
                invocation.subagentProviderLifecycle?.childInvocationId ?? '',
              ) &&
              invocation.subagentProviderLifecycle?.childSession?.recoveryDiagnostic !== undefined,
          );
          if (recoveryBlocked)
            throw new Error('Required child Session needs explicit execution recovery.');
          const independentChildren = new Set(
            Object.values(currentState.capabilities.invocations)
              .filter(
                (invocation) => invocation.subagentProviderLifecycle?.childSession !== undefined,
              )
              .map((invocation) => invocation.subagentProviderLifecycle!.childInvocationId),
          );
          const independentAwaited = [...awaitedBackground].filter((taskId) =>
            independentChildren.has(taskId),
          );
          pendingIndependentTaskIds = [];
          if (independentAwaited.length > 0) {
            const taskControl = input.childSessionAcceptance?.taskControl;
            if (!taskControl)
              throw new Error('Required child Session Task control is unavailable.');
            for (const taskId of independentAwaited) {
              const task = await taskControl.readTask(taskId);
              if (waitSignal?.aborted || kernel.getState().revision !== revision)
                return 'state_changed' as const;
              if (task.status === 'unknown' || task.status === 'not_found')
                throw new Error('Required child Session needs explicit execution recovery.');
              if (task.status === 'running' || task.status === 'cancelling')
                pendingIndependentTaskIds.push(taskId);
            }
          }
          if (!children) return undefined;
          const legacyAwaited = new Set(
            [...awaitedBackground].filter((taskId) => !independentChildren.has(taskId)),
          );
          if (legacyAwaited.size === 0) return undefined;
          const inspection = inspectRequiredBackgroundSettlement(
            legacyAwaited,
            currentState,
            children.listSnapshot(input.threadId, childOwnerKey).executions,
            children.settlementRecoveryEvents?.(childOwnerKey) ?? [],
          );
          if (inspection.kind === 'none') return undefined;
          for (const event of inspection.events) kernel.processEvent(event);
          return 'state_changed' as const;
        };
        if (requiredBackground.size === 0 && inspectRequiredShells(state)) {
          return 'managed_shell_terminal' as const;
        }
        const existingBackground = await inspectRequiredBackground();
        if (existingBackground) return existingBackground;
        const taskWaitController = new AbortController();
        const abortTaskWait = () => taskWaitController.abort();
        waitSignal?.addEventListener('abort', abortTaskWait, { once: true });
        if (waitSignal?.aborted) abortTaskWait();
        let wake: 'state_changed' | 'managed_shell_changed' | 'background_changed';
        try {
          const taskControl = input.childSessionAcceptance?.taskControl;
          const taskWaits = [];
          for (let offset = 0; offset < pendingIndependentTaskIds.length; offset += 8) {
            taskWaits.push(
              taskControl!
                .waitTasks(
                  pendingIndependentTaskIds.slice(offset, offset + 8),
                  60_000,
                  taskWaitController.signal,
                  { wakeOnModelRetry: false },
                )
                .then(() => 'background_changed' as const),
            );
          }
          wake = await Promise.race([
            (
              kernel.waitForRevisionChange?.(revision, waitSignal) ?? new Promise<void>(() => {})
            ).then(() => 'state_changed' as const),
            managedShellRuntime
              .waitForOwnerChange(ownerKey, shellWatermark, waitSignal)
              .then(() => 'managed_shell_changed' as const),
            ...(children && childWatermark !== undefined
              ? [
                  children
                    .waitForOwnerChange(childOwnerKey, childWatermark, waitSignal)
                    .then(() => 'background_changed' as const),
                ]
              : []),
            ...taskWaits,
          ]);
        } finally {
          taskWaitController.abort();
          waitSignal?.removeEventListener('abort', abortTaskWait);
        }
        if (wake === 'state_changed') return wake;
        if (wake === 'background_changed') {
          const settledBackground = await inspectRequiredBackground();
          if (settledBackground) return settledBackground;
          return wake;
        }
        const currentState = kernel.getState();
        return requiredBackgroundTaskIds(currentState).length === 0 &&
          inspectRequiredShells(currentState)
          ? ('managed_shell_terminal' as const)
          : wake;
      },
    );
    // Own iterator closure explicitly: abort incomplete work before returning
    // the runner, so its finally can drain Provider cleanup before releasing it.
    for (;;) {
      const step = await stateRunner.next();
      if (step.done) {
        runnerCompleted = true;
        break;
      }
      const event = step.value;
      collector.recordRuntime(event);
      if (
        event.type === 'resource_budget.required_child_wait_started' ||
        event.type === 'resource_budget.required_child_wait_ended'
      )
        scheduleRunDeadline();
      let abortReasonAfterProjection: string | undefined;
      if (event.type === 'approval.rejected' && event.failure?.kind === 'approval_rejected') {
        runCancelled = true;
        exitStatus = 'aborted';
        abortReasonAfterProjection = event.reason;
      }
      if (event.type === 'turn.aborted' && event.cause === 'user') {
        runCancelled = true;
        exitStatus = 'aborted';
        abortReasonAfterProjection = event.reason;
      }
      // Task lifecycle facts are durable RuntimeEvents, but remain internal to
      // the legacy public stream; UI projections are driven by planning/tool
      // events and existing consumers should not see extra turn markers.
      if (event.type === 'task.completed') continue;
      yield event;
      // The Runtime fact is already durable at this point. Let the consumer
      // project that canonical settlement before Host aborts the shared root
      // signal; otherwise the outer lifecycle can correctly reject all
      // post-abort events while accidentally hiding the rejection itself.
      if (abortReasonAfterProjection) abortExecution(abortReasonAfterProjection, 'user');
    }
    if (runCancelled && 'backgroundSubagentRuntime' in modelInvocationRuntime) {
      const background = modelInvocationRuntime.backgroundSubagentRuntime as
        | BackgroundSubagentControlRuntime
        | undefined;
      await background?.cancelOrigin(
        backgroundSubagentOwnerKey(input.threadId, input.recoveryIdentityKey),
        kernel.getState().turn.turnId,
        kernel.getState().turn.abortReason ?? 'origin_run_cancelled',
      );
    }
    // A cancelled concurrent tool batch can exhaust the generic effect
    // cleanup grace while its Subagent Provider handles are still durable.
    // Reconcile those handles before this generator releases the Session turn
    // owner; otherwise a queued successor can commit a new Turn and inherit
    // the predecessor's recovery events as a fatal run.error.
    if (hasPendingSubagentProviderRecovery(kernel.getState())) {
      const recovery = await reconcilePendingSubagentProviders(
        kernel.getState().turn.abortCause === 'user' ? 'preserve_user_cancellation' : 'unknown',
      );
      for (const event of recovery.events) {
        collector.recordRuntime(event);
        yield event;
      }
      if (!recovery.recovered) {
        const event: RuntimeEvent = {
          type: 'run.error',
          message: 'Subagent Provider cancellation cleanup could not be confirmed.',
          recoverable: false,
          turnId: kernel.getState().turn.turnId,
        };
        for (const applied of kernel.processEventBatch([
          event,
          ...eventsForRunCancellation(kernel.getState(), event.message, 'error'),
        ])) {
          collector.recordRuntime(applied);
          yield applied;
        }
        return;
      }
    }
    if (!executionSignal.aborted && kernel.getState().turn.status === 'active') {
      throw new Error('Runtime State runner exited without a durable Turn terminal.');
    }
    if (executionSignal.aborted) exitStatus = 'aborted';
    if (!externalCancellationEventsYielded && externalCancellationEvents.length > 0) {
      externalCancellationEventsYielded = true;
      yield* externalCancellationEvents;
    }
    if (deadlineCancellationEvents.length > 0) {
      deadlineEventsYielded = true;
      yield* deadlineCancellationEvents;
    }
  } catch (error) {
    if (executionSignal.aborted && !runnerFailed) {
      exitStatus = 'aborted';
      if (!externalCancellationEventsYielded && externalCancellationEvents.length > 0) {
        externalCancellationEventsYielded = true;
        yield* externalCancellationEvents;
      }
      if (!deadlineEventsYielded && deadlineCancellationEvents.length > 0) {
        deadlineEventsYielded = true;
        yield* deadlineCancellationEvents;
      }
      return;
    }
    exitStatus = 'fatal';
    const knownExternalEffects =
      kernel.getState().resourceBudget.status === 'active' &&
      Object.values(kernel.getState().resourceBudget.reservations).some(
        (reservation) => reservation.state === 'unknown',
      )
        ? 'unknown'
        : 'known';
    const modelFailureMode = exhaustedModelFailureMode(error);
    const fatalModel = fatalModelFailure(error);
    const modelFailureResolution = modelFailureMode
      ? resolveFailureMode(modelFailureMode, {
          remainingModelRetryAttempts: 0,
          knownExternalEffects,
        })
      : undefined;
    const exhaustedFailureKind =
      modelFailureMode === 'model_server_error'
        ? 'provider_unavailable'
        : modelFailureMode === 'model_rate_limit'
          ? 'model_rate_limited'
          : modelFailureMode;
    const failure = recordRuntimeFailure({
      // Keep the exhausted terminal outcome distinct from the content-free
      // attempt cause that operators and clients can act on.
      kind: exhaustedFailureKind ?? (fatalModel ? fatalModel.kind : 'unknown'),
      message: fatalModel?.message ?? (error instanceof Error ? error.message : String(error)),
      phase: 'building',
      turnId: kernel.getState().turn.turnId,
      userVisible: true,
    });
    const errorEvent: RuntimeEvent = {
      type: 'run.error',
      message: failure.message,
      recoverable: false,
      failure: failure.failure,
      turnId: failure.turnId,
      outcome:
        modelFailureResolution?.terminalOutcome ??
        failedTerminalOutcome(failure.failure, { knownExternalEffects }),
    };
    const terminalEvents = kernel.processEventBatch([
      errorEvent,
      ...eventsForRunCancellation(kernel.getState(), errorEvent.message, 'error'),
    ]);
    runCancelled = true;
    abortExecution(errorEvent.message);
    for (const event of terminalEvents) {
      collector.recordRuntime(event);
      yield event;
    }
  } finally {
    try {
      interruptClosedStream();
    } finally {
      try {
        await stateRunner?.return(undefined);
        if (!runnerCompleted && hasPendingSubagentProviderRecovery(kernel.getState())) {
          const recovery = await reconcilePendingSubagentProviders(
            kernel.getState().turn.abortCause === 'user' ? 'preserve_user_cancellation' : 'unknown',
          );
          for (const event of recovery.events) collector.recordRuntime(event);
        }
        if (!runnerCompleted && hasSettledSubagentHistoryCandidate(kernel.getState())) {
          const history = input.runtimeSession.runtimeStore.sessions
            .loadEventsStrict(input.threadId)
            .map((entry) => entry.event);
          const terminals = eventsForSettledSubagentHistory(kernel.getState(), history);
          if (terminals.length > 0) {
            for (const event of kernel.processEventBatch(terminals)) collector.recordRuntime(event);
          }
        }
      } finally {
        if (runDeadlineTimer) clearTimeout(runDeadlineTimer);
        input.signal?.removeEventListener('abort', forwardExternalAbort);
        input.registerRunCancellation?.(null);
        input.registerCommittedCommandCancellation?.(null);
        // IteratorClose (for example a failed client-event projection) bypasses
        // the loop's terminal check. Closing a stream is not evidence that its
        // still-active Turn completed successfully.
        await collector.finalize(
          exitStatus === 'completed' && kernel.getState().turn.status !== 'completed'
            ? 'fatal'
            : exitStatus,
        );
      }
    }
  }
}
