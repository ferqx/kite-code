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
import type { InteractionMode, RuntimeCommandContext } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
  runtimeHostStateInteractionBelongsToCurrentWork as interactionBelongsToCurrentWork,
  LIMITED_RESOURCE_BUDGET_,
  runtimeHostStateResolveFailureMode as resolveFailureMode,
  type StateRuntimeEffectExecutor,
} from '@kite-ai/runtime-host/kernel-adapter';
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
import { projectRuntimeSchedulerFacts } from './scheduler-facts';
import { eventsForRunCancellation, eventsForSupersededTurnRecovery } from './state-actions';
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
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';
import { failedTerminalOutcome } from './terminal-outcome';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';
import {
  assertPrecommittedStartTurn,
  type PrecommittedStartTurnDescriptor,
} from './turn-command-decision';

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
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
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
  /** Continue the already-active durable turn after a recovered interaction receipt commits. */
  resumeCommittedInteraction?: boolean;
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
    ) => Promise<boolean>;
    subagentContinuationArtifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
    subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
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
  abortExecution?: (reason: string) => void;
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
  registerRunCancellation?: (cancelRun: ((reason?: string) => RuntimeEvent[]) | null) => void;
  /** Command cancellation consumes already-committed events and must not persist another batch. */
  registerCommittedCommandCancellation?: (
    cancel: RuntimeCommittedCommandCancellation | null,
  ) => void;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
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
  let exitStatus: 'completed' | 'aborted' | 'fatal' = 'completed';
  let runCancelled = false;
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
  const abortExecution = (reason: string): void => {
    if (input.abortExecution) input.abortExecution(reason);
    else localExecutionController!.abort(reason);
  };
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
  const cancelAfterCommittedCommand = (
    events: readonly RuntimeEvent[],
    reason = 'Cancelled by user.',
  ): void => {
    if (runCancelled) return;
    runCancelled = true;
    exitStatus = 'aborted';
    for (const event of events) collector.recordRuntime(event);
    abortExecution(reason);
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
  const scheduleRunDeadline = (deadlineAt: string): void => {
    if (runDeadlineTimer) return;
    const remainingMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
    runDeadlineTimer = setTimeout(() => {
      if (runCancelled || kernel.getState().turn.status !== 'active') return;
      deadlineCancellationEvents = cancelForDeadline();
    }, remainingMs);
  };
  input.registerRunCancellation?.((reason?: string) => cancelRun(reason));
  input.registerCommittedCommandCancellation?.(cancelAfterCommittedCommand);
  try {
    if (externalCancellationEvents.length > 0) {
      externalCancellationEventsYielded = true;
      yield* externalCancellationEvents;
      return;
    }
    if (getFeatureFlags(input.config).resourceBudget) {
      if (kernel.getState().resourceBudget.status !== 'unconfigured') {
        if (kernel.getState().resourceBudget.status !== 'active') {
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
            startedAt.getTime() + LIMITED_RESOURCE_BUDGET_.maxRunDurationMs,
          ).toISOString(),
          budget: LIMITED_RESOURCE_BUDGET_,
        };
        kernel.processEvent(event);
        collector.recordRuntime(event);
        scheduleRunDeadline(event.deadlineAt);
        yield event;
      }
    }
    const activeBudget = kernel.getState().resourceBudget;
    if (activeBudget.status === 'active') scheduleRunDeadline(activeBudget.deadlineAt);
    if (hasPendingSubagentProviderRecovery(kernel.getState())) {
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
        kernel.processEvent(event);
        collector.recordRuntime(event);
        yield event;
        return;
      }
    }
    const precommittedStart = input.precommittedStart;
    if (precommittedStart) {
      assertPrecommittedStartTurn(kernel.getState(), precommittedStart, input.threadId);
    } else {
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
    }

    // Provider admission gates model execution, but it must not hide stale
    // Tool ownership from the successor-turn recovery above. Creating this
    // session-owned interaction only after the user turn is durably accepted
    // also prevents an admission prompt from swallowing that user message.
    const admissionEvents = requiredProviderAdmissionEvents(
      kernel.getState(),
      input.mcpManager,
      getFeatureFlags(input.config).mcpProviderAction,
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
      subagentContinuationArtifacts:
        'subagentContinuationArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentContinuationArtifacts
          : undefined,
      subagentTaskRequests:
        'subagentTaskRequests' in modelInvocationRuntime
          ? modelInvocationRuntime.subagentTaskRequests
          : undefined,
    };
    const executor = input.createRuntimeEffectPort(executorDependencies);
    for await (const event of runStateRuntimeLoop(
      kernel,
      executor,
      provider,
      10_000,
      (effect, state) =>
        getFeatureFlags(input.config).resourceBudget
          ? prepareRuntimeEffectForBudget(effect, state, {
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
              subagentEventSink: () => {},
            })
          : effect,
      executionSignal,
      (state) => projectRuntimeSchedulerFacts(state, modelInvocationRuntime.builtinToolCatalog),
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
    input.registerCommittedCommandCancellation?.(null);
    await collector.finalize(exitStatus);
  }
}
