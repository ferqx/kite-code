import { randomUUID } from 'node:crypto';
import type { SkillManifest, SkillScanOptions } from '@kite/builtin-runtime';
import {
  createSkillCapabilityResolver,
  evaluateSkillActivation,
  refreshSkillCatalog,
} from '@kite/builtin-runtime';
import type {
  McpRuntimeProvider,
  RemoteMcpEgressPermitResolverV1,
} from '@kite/builtin-runtime/mcp';
import type { ContextCompactionProgressPhase } from '@kite/builtin-runtime/model';
import {
  createLocalCompactionDebugReporter,
  createModelSecretDetectorV1,
  ModelAttemptFailureErrorV1,
  type SupportedChatModel,
} from '@kite/builtin-runtime/model';
import type { SandboxBackend, ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type { AuthorizationMode, InteractionMode } from '@kite/runtime-contract';
import {
  type State26AuthorizationSourceV1 as AuthorizationSource,
  runtimeHostState26ActivePlanningV1 as getActivePlanning,
  runtimeHostState26ActiveTaskV1 as getActiveTask,
  runtimeHostState26InteractionBelongsToCurrentWorkV1 as interactionBelongsToCurrentWork,
  LIMITED_RESOURCE_BUDGET_V1,
  type State26RuntimeEffectExecutorV1,
} from '@kite/runtime-host';
import {
  prepareRuntimeEffectForBudgetV1,
  type RuntimeExecutorDependencies,
} from '#app/bootstrap/runtime/runtime-effect-dependencies';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';
import {
  createApprovedProviderDataAdmissionV1,
  ProviderDataAdmissionError,
} from '#app/config/provider-data-admission';
import type {
  SessionLoggingMode,
  SessionLoggingPolicyV1,
} from '#app/config/session-logging-policy';
import { resolveSessionLoggingPolicyV1 } from '#app/config/session-logging-policy';
import {
  hasPendingSandboxPreparationRecoveryV1,
  SANDBOX_PREPARATION_RECOVERY_V1,
  type SandboxPreparationRecoveryConsumerV1,
} from '#app/sandbox/runtime-execution';
import { SessionLogCollector, type SessionLoggingContentInspectorV1 } from '#app/session-logger';
import type { CapabilityExecutionPortV1 } from '#runtime-spi';
import { resolveFailureModeV1 } from './failure-mode-conformance';
import { recordRuntimeFailure } from './failures';
import { projectRuntimeSchedulerFactsV1 } from './scheduler-facts';
import { eventsForRunCancellation, eventsForSupersededTurnRecovery } from './state26-actions';
import {
  type RuntimeActionProvider,
  type RuntimeState26SessionPortV1,
  runState26RuntimeLoopV1,
} from './state26-runner';
import type {
  RuntimeEffect,
  RuntimeEvent,
  RuntimeState,
  State26SessionStorageV1,
} from './state26-runtime';
import { hasPendingSubagentProviderRecoveryV1 } from './subagent-provider-recovery';
import { failedTerminalOutcomeV1 } from './terminal-outcome';
import type { AppToolPipelineCompositionV1 } from './tool-pipeline-composition';

function exhaustedModelFailureModeV1(
  error: unknown,
): 'model_timeout' | 'model_rate_limit' | 'model_server_error' | undefined {
  if (!(error instanceof ModelAttemptFailureErrorV1)) return undefined;
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

/** Build redacted admission facts for unavailable required providers before model execution. */
export function requiredProviderAdmissionEvents(
  state: Readonly<RuntimeState>,
  mcpManager: McpRuntimeProvider | undefined,
  enabled: boolean,
): RuntimeEvent[] {
  if (
    !enabled ||
    !mcpManager ||
    (state.interactions.kind !== 'idle' &&
      state.interactions.kind !== 'awaiting_provider_admission')
  ) {
    return [];
  }
  const pending = new Set(state.providerAdmission.pending.map((entry) => entry.providerId));
  return mcpManager
    .getProviderDirectorySnapshot()
    .entries.filter(
      (entry) =>
        entry.required &&
        entry.status !== 'ready' &&
        entry.status !== 'degraded' &&
        !pending.has(entry.providerId) &&
        !state.providerAdmission.waivers[entry.providerId],
    )
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
    .map((entry) => ({
      type: 'provider.admission_required' as const,
      interactionId: randomUUID(),
      providerId: entry.providerId,
      source: entry.source,
      providerStatus: entry.status,
      ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
      retryable: entry.retryable,
    }));
}

/** Inputs for the graph-free runtime entry point. */
export interface RuntimeTurnInputV1 {
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
  /** Immutable App policy input; tests must inject an explicit fixture authority. */
  providerDataAdmission?: import('#app/config/provider-data-admission').ProviderDataAdmissionGateV1;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  /** Runtime Host registry port; required by capability-backed production tools. */
  capabilityExecution?: CapabilityExecutionPortV1;
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  /** Explicit user-requested Workflow Contract activations for the initial task. */
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  /** App-selected Model/Artifact/Subagent mechanisms; Core never constructs a concrete owner. */
  modelInvocationRuntime: {
    /** App projection of the Host's one frozen Builtin capability snapshot. */
    builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
    /** App-owned pipeline composition derived from that exact projection. */
    toolPipelineComposition?: AppToolPipelineCompositionV1;
    /** App-owned single Plan Artifact store; absent only for unavailable composition. */
    planArtifacts?: import('@kite/builtin-runtime/planning').PlanArtifactStore;
    gateway?: import('@kite/builtin-runtime/model').ModelInvocationGatewayV1;
    modelEffects?: import('@kite/builtin-runtime/model').BuiltinModelEffectCoordinatorV1;
    evidence?: import('@kite/builtin-runtime/model').ModelArtifactEvidenceAvailabilityV1;
    capabilityArtifacts?: import('@kite/builtin-runtime').CapabilityArtifactAccessV1;
    workspaceFilesystem?: import('@kite/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntimeV1;
    sandboxPreparationArtifacts?: import('@kite/builtin-runtime/sandbox').SandboxPreparationArtifactStoreV1;
    subagentRuntimeFactory?: import('./subagent/pipeline-runtime').AppSubagentRuntimeFactoryV1;
    reconcilePendingSubagents?: (
      persistence: Parameters<
        typeof import('./subagent-provider-recovery').reconcilePendingSubagentProvidersAfterCrashV1
      >[0]['persistence'],
    ) => Promise<boolean>;
    subagentContinuationArtifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
    subagentTaskRequests?: import('#builtin-runtime').SubagentTaskRequestArtifactAccessV1;
  };
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  /** 初始执行阶段 / Initial execution phase */
  phase?: 'planning' | 'building';
  thinkingLevel?: string | null;
  sandboxBackend?: SandboxBackend | 'unknown';
  signal?: AbortSignal;
  /** Host-owned controller callback; production execution always supplies it. */
  abortExecution?: (reason: string) => void;
  /** Exact State 25 session owned by the App/Host session coordinator. */
  runtimeSession: RuntimeState26SessionPortV1 & {
    readonly runtimeStore: State26SessionStorageV1;
    processEvents(events: RuntimeEvent[]): void;
  };
  /** Exact effect port owned by the App/Host session coordinator. */
  createRuntimeEffectPort: (
    dependencies: RuntimeExecutorDependencies,
  ) => State26RuntimeEffectExecutorV1<RuntimeState, RuntimeEvent, RuntimeEffect>;
  frontend?: string;
  /** App-resolved artifact/user/project policy. App composition roots should always inject it. */
  sessionLoggingPolicy?: SessionLoggingPolicyV1;
  /** Trusted detector required before content-mode text can be persisted. */
  sessionLoggingContentInspector?: SessionLoggingContentInspectorV1;
  onSessionLoggingStatus?: (status: { mode: SessionLoggingMode }) => void;
  onSessionLoggingDiagnostic?: (message: string) => void;
  /** Runtime coordinator registration for this turn's single cancellation transaction. */
  registerRunCancellation?: (cancelRun: ((reason?: string) => RuntimeEvent[]) | null) => void;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
}

/** Execute one turn against the caller-owned State 25 session and effect port. */
export async function* executeRuntimeTurnV1(
  input: RuntimeTurnInputV1,
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
    resolveSessionLoggingPolicyV1({
      enabled: getFeatureFlags(input.config).sessionLoggingPolicyV1,
    });
  input.onSessionLoggingStatus?.({ mode: sessionLoggingPolicy.mode });
  const sessionLoggingContentInspector =
    input.sessionLoggingContentInspector ??
    createModelSecretDetectorV1({
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
  let exitStatus: 'completed' | 'aborted' | 'fatal' = 'completed';
  let runCancelled = false;
  let runDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineCancellationEvents: RuntimeEvent[] = [];
  let deadlineEventsYielded = false;
  let deadlineTriggered = false;
  let deadlineTerminalYielded = false;
  let cancellationIncomplete = false;
  let externalCancellationEvents: RuntimeEvent[] = [];
  let externalCancellationEventsYielded = false;
  if (input.abortExecution && !input.signal) {
    throw new Error('Host-owned execution cancellation requires its AbortSignal.');
  }
  const localExecutionController = input.abortExecution ? undefined : new AbortController();
  const executionSignal = input.abortExecution ? input.signal! : localExecutionController!.signal;
  const abortExecution = (reason: string): void => {
    if (input.abortExecution) input.abortExecution(reason);
    else localExecutionController!.abort(reason);
  };
  const providerDataAdmission =
    input.providerDataAdmission ??
    createApprovedProviderDataAdmissionV1(input.config, new Date(), sessionLoggingContentInspector);
  const cancelRun = (
    reason = 'Cancelled by user.',
    cause: 'user' | 'error' = 'user',
  ): RuntimeEvent[] => {
    if (runCancelled || kernel.getState().turn.status !== 'active') return [];
    runCancelled = true;
    exitStatus = 'aborted';
    const events = eventsForRunCancellation(kernel.getState(), reason, cause);
    kernel.processEventBatch(events);
    const canonicalEvents = [...kernel.getLastAppliedEvents()];
    for (const event of canonicalEvents) collector.recordRuntime(event);
    abortExecution(reason);
    return canonicalEvents;
  };
  const externalAbortReason = (): string => {
    const reason = input.signal?.reason;
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === 'string' && reason.trim()) return reason;
    return 'Runtime cancelled by external signal.';
  };
  const forwardExternalAbort = () => {
    // The public AbortSignal is a real cancellation boundary, not merely a
    // transport hint. Persist the same durable cancellation transaction used
    // by the TUI before unblocking any effect/interaction wait.
    externalCancellationEvents = cancelRun(externalAbortReason(), 'user');
  };
  if (input.signal?.aborted) forwardExternalAbort();
  else input.signal?.addEventListener('abort', forwardExternalAbort, { once: true });
  const scheduleRunDeadline = (deadlineAt: string) => {
    if (!getFeatureFlags(input.config).boundedCancellationV1 || runDeadlineTimer) return;
    const remainingMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
    runDeadlineTimer = setTimeout(() => {
      if (runCancelled || kernel.getState().turn.status !== 'active') return;
      deadlineTriggered = true;
      deadlineCancellationEvents = cancelRun(
        'Runtime deadline exceeded; bounded cancellation started.',
        'error',
      );
    }, remainingMs);
  };
  const createDeadlineTerminalEvent = (): RuntimeEvent | undefined => {
    if (!deadlineTriggered || deadlineTerminalYielded) return undefined;
    deadlineTerminalYielded = true;
    const unknownReservation =
      kernel.getState().resourceBudget.status === 'active' &&
      Object.values(kernel.getState().resourceBudget.reservations).some(
        (reservation) => reservation.state === 'unknown',
      );
    const failure = recordRuntimeFailure({
      kind: cancellationIncomplete ? 'cancel_incomplete' : 'budget_exceeded',
      message: cancellationIncomplete
        ? 'Runtime deadline exceeded and descendant cleanup could not be confirmed.'
        : 'Runtime deadline exceeded and bounded cancellation completed.',
      phase: 'building',
      turnId: kernel.getState().turn.turnId,
      userVisible: true,
    });
    const conformance = resolveFailureModeV1(
      cancellationIncomplete ? 'cancel_timeout' : 'budget_exhausted',
      {
        knownExternalEffects: cancellationIncomplete || unknownReservation ? 'unknown' : 'known',
      },
    );
    return {
      type: 'run.error',
      message: failure.message,
      recoverable: false,
      failure: failure.failure,
      turnId: failure.turnId,
      outcome: conformance.terminalOutcome!,
    };
  };
  input.registerRunCancellation?.((reason) => cancelRun(reason));
  try {
    if (hasPendingSubagentProviderRecoveryV1(kernel.getState())) {
      const reconcilePendingSubagents =
        'reconcilePendingSubagents' in modelInvocationRuntime
          ? modelInvocationRuntime.reconcilePendingSubagents
          : undefined;
      const recoveryEvents: RuntimeEvent[] = [];
      const recovered = reconcilePendingSubagents
        ? await reconcilePendingSubagents({
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
          })
        : false;
      for (const event of recoveryEvents) {
        collector.recordRuntime(event);
        yield event;
      }
      if (!recovered) {
        const event: RuntimeEvent = {
          type: 'run.error',
          message: 'Subagent Provider crash recovery could not be confirmed.',
          recoverable: false,
          turnId: kernel.getState().turn.turnId,
        };
        kernel.processEvent(event);
        collector.recordRuntime(event);
        yield event;
        return;
      }
    }
    if (hasPendingSandboxPreparationRecoveryV1(kernel.getState())) {
      const artifacts =
        'sandboxPreparationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.sandboxPreparationArtifacts
          : undefined;
      const recovery = (
        input.shellExecutor as ShellExecutor & Partial<SandboxPreparationRecoveryConsumerV1>
      )?.[SANDBOX_PREPARATION_RECOVERY_V1];
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
        kernel.processEvent(event);
        collector.recordRuntime(event);
        yield event;
        return;
      }
    }
    if (externalCancellationEvents.length > 0) {
      externalCancellationEventsYielded = true;
      yield* externalCancellationEvents;
      return;
    }
    if (providerDataAdmission) {
      const readiness = providerDataAdmission([], 'primary_model');
      const event: RuntimeEvent = {
        type: 'provider.data_policy_status',
        status: readiness.admitted ? 'ready' : 'blocked',
        reason: readiness.reason,
        ...(readiness.registryDigest ? { registryDigest: readiness.registryDigest } : {}),
        ...(readiness.policyRevision ? { policyRevision: readiness.policyRevision } : {}),
      };
      kernel.processEvent(event);
      collector.recordRuntime(event);
      yield event;
    }
    if (getFeatureFlags(input.config).resourceBudgetV1) {
      if (kernel.getState().resourceBudget.status !== 'unconfigured') {
        if (kernel.getState().resourceBudget.status !== 'active') {
          const failure = recordRuntimeFailure({
            kind: 'mandatory_policy_unavailable',
            message:
              'ResourceBudgetV1 cannot start from a legacy snapshot; start a new production run.',
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
            outcome: failedTerminalOutcomeV1(failure.failure, {
              knownExternalEffects: 'none',
            }),
          };
          kernel.processEvent(event);
          collector.recordRuntime(event);
          yield event;
          return;
        }
      } else {
        const startedAt = new Date();
        const event: RuntimeEvent = {
          type: 'resource_budget.configured',
          runId: randomUUID(),
          startedAt: startedAt.toISOString(),
          deadlineAt: new Date(
            startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
          ).toISOString(),
          budget: LIMITED_RESOURCE_BUDGET_V1,
        };
        kernel.processEvent(event);
        collector.recordRuntime(event);
        yield event;
        scheduleRunDeadline(event.deadlineAt);
      }
    }
    const activeBudget = kernel.getState().resourceBudget;
    if (activeBudget.status === 'active') {
      scheduleRunDeadline(activeBudget.deadlineAt);
    }
    const resumedInteraction =
      getActiveTask(kernel.getState()) && interactionBelongsToCurrentWork(kernel.getState());
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
        kernel.processEvent(cancelled);
        collector.recordRuntime(cancelled);
        yield cancelled;
      }

      if (input.phase === 'planning' && !getActiveTask(kernel.getState())) {
        const taskStarted: RuntimeEvent = {
          type: 'task.started',
          taskId: randomUUID(),
          userGoal: input.userGoal ?? input.task,
          turnId: kernel.getState().turn.turnId,
        };
        kernel.processEvent(taskStarted);
        collector.recordRuntime(taskStarted);
        yield taskStarted;
      }

      if (input.phase === 'planning') {
        const activeTask = getActiveTask(kernel.getState());
        if (activeTask) {
          const entered: RuntimeEvent = {
            type: 'planning.entered',
            taskId: activeTask.taskId,
            source: 'user_command',
          };
          kernel.processEvent(entered);
          collector.recordRuntime(entered);
          yield entered;
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
            kernel.processEvent(failed);
            collector.recordRuntime(failed);
            yield failed;
            return;
          }
          kernel.processEvents(evaluation.events);
          for (const event of evaluation.events) {
            collector.recordRuntime(event);
            yield event;
          }
        }
      }
    }

    // Provider admission gates model execution, but it must not hide stale
    // Tool ownership from the successor-turn recovery above. Creating this
    // session-owned interaction only after the user turn is durably accepted
    // also prevents an admission prompt from swallowing that user message.
    const admissionEvents = requiredProviderAdmissionEvents(
      kernel.getState(),
      input.mcpManager,
      getFeatureFlags(input.config).mcpProviderActionV1,
    );
    for (const event of admissionEvents) {
      kernel.processEvent(event);
      collector.recordRuntime(event);
      yield event;
    }

    const executorDependencies: RuntimeExecutorDependencies = {
      config: input.config,
      model,
      shellExecutor: input.shellExecutor,
      gitBroker: input.gitBroker,
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
      skills: input.skills,
      skillOptions: input.skillOptions,
      signal: executionSignal,
      onCompactionProgress: input.onCompactionProgress,
      compactionReporter: input.config.compaction?.localDebug?.enabled
        ? createLocalCompactionDebugReporter({
            enabled: true,
            directory: input.config.compaction.localDebug.directory,
            sessionId: input.threadId,
          })
        : undefined,
      providerDataAdmission,
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
      subagentContinuationArtifacts:
        'subagentContinuationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentContinuationArtifacts
          : undefined,
      subagentTaskRequests:
        'subagentTaskRequests' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentTaskRequests
          : undefined,
      remoteMcpEgressPermitResolver: input.remoteMcpEgressPermitResolver,
    };
    const executor = input.createRuntimeEffectPort(executorDependencies);
    for await (const event of runState26RuntimeLoopV1(
      kernel,
      executor,
      provider,
      10_000,
      (effect, state) =>
        getFeatureFlags(input.config).resourceBudgetV1
          ? prepareRuntimeEffectForBudgetV1(effect, state, {
              config: input.config,
              model,
              shellExecutor: input.shellExecutor,
              gitBroker: input.gitBroker,
              sandboxBackend: input.sandboxBackend,
              mcpManager: input.mcpManager,
              builtinToolCatalog: modelInvocationRuntime.builtinToolCatalog,
              skills: input.skills,
              skillOptions: input.skillOptions,
              signal: executionSignal,
              providerDataAdmission,
              remoteMcpEgressPermitResolver: input.remoteMcpEgressPermitResolver,
              subagentEventSink: () => {},
            })
          : effect,
      executionSignal,
      (state) => projectRuntimeSchedulerFactsV1(state, modelInvocationRuntime.builtinToolCatalog),
    )) {
      collector.recordRuntime(event);
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
      if (
        event.type === 'runtime.cancellation_diagnostic' &&
        event.failure.kind === 'cancel_incomplete'
      ) {
        cancellationIncomplete = true;
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
      if (abortReasonAfterProjection) abortExecution(abortReasonAfterProjection);
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
    const deadlineTerminal = createDeadlineTerminalEvent();
    if (deadlineTerminal) {
      kernel.processEvent(deadlineTerminal);
      collector.recordRuntime(deadlineTerminal);
      yield deadlineTerminal;
    }
  } catch (error) {
    if (executionSignal.aborted) {
      exitStatus = 'aborted';
      if (!externalCancellationEventsYielded && externalCancellationEvents.length > 0) {
        externalCancellationEventsYielded = true;
        yield* externalCancellationEvents;
      }
      if (!deadlineEventsYielded && deadlineCancellationEvents.length > 0) {
        deadlineEventsYielded = true;
        yield* deadlineCancellationEvents;
      }
      const deadlineTerminal = createDeadlineTerminalEvent();
      if (deadlineTerminal) {
        kernel.processEvent(deadlineTerminal);
        collector.recordRuntime(deadlineTerminal);
        yield deadlineTerminal;
      }
      return;
    }
    exitStatus = 'fatal';
    const providerPolicyUnavailable =
      error instanceof ProviderDataAdmissionError &&
      (error.decision.reason === 'mandatory_policy_unavailable' ||
        error.decision.reason === 'provider_policy_missing' ||
        error.decision.reason === 'provider_policy_not_yet_effective' ||
        error.decision.reason === 'provider_policy_expired' ||
        error.decision.reason === 'provider_route_identity_mismatch');
    const knownExternalEffects =
      error instanceof ProviderDataAdmissionError
        ? error.knownExternalEffects
        : kernel.getState().resourceBudget.status === 'active' &&
            Object.values(kernel.getState().resourceBudget.reservations).some(
              (reservation) => reservation.state === 'unknown',
            )
          ? 'unknown'
          : 'known';
    const modelFailureMode = exhaustedModelFailureModeV1(error);
    const modelFailureResolution = modelFailureMode
      ? resolveFailureModeV1(modelFailureMode, {
          remainingModelRetryAttempts: 0,
          knownExternalEffects,
        })
      : undefined;
    const failure = recordRuntimeFailure({
      kind:
        error instanceof ProviderDataAdmissionError
          ? providerPolicyUnavailable
            ? 'mandatory_policy_unavailable'
            : 'policy_denied'
          : modelFailureMode
            ? 'model_retry_exhausted'
            : 'unknown',
      message: error instanceof Error ? error.message : String(error),
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
        failedTerminalOutcomeV1(failure.failure, { knownExternalEffects }),
    };
    kernel.processEvent(errorEvent);
    collector.recordRuntime(errorEvent);
    yield errorEvent;

    const aborted: RuntimeEvent = {
      type: 'turn.aborted',
      turnId: kernel.getState().turn.turnId,
      reason: errorEvent.message,
      cause: 'error',
    };
    kernel.processEvent(aborted);
    collector.recordRuntime(aborted);
    yield aborted;
  } finally {
    if (runDeadlineTimer) clearTimeout(runDeadlineTimer);
    input.signal?.removeEventListener('abort', forwardExternalAbort);
    input.registerRunCancellation?.(null);
    await collector.finalize(exitStatus);
  }
}
