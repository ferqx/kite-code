import { randomUUID } from 'node:crypto';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import {
  createApprovedProviderDataAdmissionV1,
  ProviderDataAdmissionError,
} from '@/core/config/provider-data-admission';
import type {
  SessionLoggingMode,
  SessionLoggingPolicyV1,
} from '@/core/config/session-logging-policy';
import { resolveSessionLoggingPolicyV1 } from '@/core/config/session-logging-policy';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { RemoteMcpEgressPermitResolverV1 } from '@/core/mcp/egress-permit';
import { createLocalCompactionDebugReporter } from '@/core/model/compaction-debug';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import type { SandboxBackend } from '@/core/sandbox';
import {
  createRuntimeSecretDetectorV1,
  SessionLogCollector,
  type SessionLoggingContentInspectorV1,
} from '@/core/session-logger';
import {
  createSkillCapabilityResolver,
  evaluateSkillActivation,
  refreshSkillCatalog,
} from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationSource } from '@/core/types';
import type { AuthorizationMode, InteractionMode } from '@/protocol/events';
import { eventsForRunCancellation } from './actions';
import type { RuntimeEvent } from './events';
import { createRuntimeEffectExecutor, prepareRuntimeEffectForBudgetV1 } from './executor';
import { recordRuntimeFailure } from './failures';
import { createAgentKernel } from './kernel';
import { LIMITED_RESOURCE_BUDGET_V1 } from './resource-budget';
import { type RuntimeActionProvider, runRuntimeLoop } from './runner';
import { getActivePlanning, getActiveTask } from './state';
import { failedTerminalOutcomeV1 } from './terminal-outcome';

/** Build redacted admission facts for unavailable required providers before model execution. */
export function requiredProviderAdmissionEvents(
  state: Readonly<import('./state').RuntimeState>,
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
export interface RunRuntimeAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  runtimeStorePath: string;
  config: AgentConfig;
  model?: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  /** Explicit user-requested Workflow Contract activations for the initial task. */
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  interactionMode?: InteractionMode;
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  /** 初始执行阶段 / Initial execution phase */
  phase?: 'planning' | 'building';
  thinkingLevel?: string | null;
  sandboxBackend?: SandboxBackend | 'unknown';
  signal?: AbortSignal;
  frontend?: string;
  /** App-resolved artifact/user/project policy. App composition roots should always inject it. */
  sessionLoggingPolicy?: SessionLoggingPolicyV1;
  /** Trusted detector required before content-mode text can be persisted. */
  sessionLoggingContentInspector?: SessionLoggingContentInspectorV1;
  onSessionLoggingStatus?: (status: { mode: SessionLoggingMode }) => void;
  onSessionLoggingDiagnostic?: (message: string) => void;
  /** App-shell control plane for injecting durable user commands into a live Kernel. */
  onKernelControl?: (control: RuntimeKernelControl | null) => void;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
}

/** Durable control surface exposed to an app shell while a Kernel run is live. */
export interface RuntimeKernelControl {
  getState: () => Readonly<import('./state').RuntimeState>;
  processEvent: (event: RuntimeEvent) => void;
  cancelRun: (reason?: string) => RuntimeEvent[];
}

/** Start a fresh RuntimeStore-backed session without LangGraph/checkpoint state. */
export async function* runRuntimeAgent(
  input: RunRuntimeAgentInput,
  provider: RuntimeActionProvider,
): AsyncGenerator<RuntimeEvent> {
  const model =
    input.model ??
    createChatModel({
      ...input.config,
      reasoningEffort: input.thinkingLevel ?? input.config.reasoningEffort ?? null,
    });
  const kernel = createAgentKernel({
    threadId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    storePath: input.runtimeStorePath,
    interactionMode: input.interactionMode ?? input.config.interactionMode ?? 'accept_edits',
    authorizationMode: input.authorizationMode,
    authorizationSource: input.authorizationSource,
    // Plan entry is a persisted event below; initialPhase is no longer the
    // source of truth for the task lifecycle.
    phase: 'building',
    sandboxAvailable: input.sandboxBackend === 'seatbelt' || input.sandboxBackend === 'bubblewrap',
  });
  const sessionLoggingPolicy =
    input.sessionLoggingPolicy ??
    input.config.sessionLoggingPolicy ??
    resolveSessionLoggingPolicyV1({
      enabled: getFeatureFlags(input.config).sessionLoggingPolicyV1,
    });
  input.onSessionLoggingStatus?.({ mode: sessionLoggingPolicy.mode });
  const sessionLoggingContentInspector =
    input.sessionLoggingContentInspector ??
    createRuntimeSecretDetectorV1({
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
  const executionAbortController = new AbortController();
  const providerDataAdmission = getFeatureFlags(input.config).providerDataPolicyV1
    ? createApprovedProviderDataAdmissionV1(input.config)
    : undefined;
  const forwardExternalAbort = () => executionAbortController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardExternalAbort();
  else input.signal?.addEventListener('abort', forwardExternalAbort, { once: true });
  const cancelRun = (
    reason = 'Cancelled by user.',
    cause: 'user' | 'error' = 'user',
  ): RuntimeEvent[] => {
    if (runCancelled) return [];
    runCancelled = true;
    exitStatus = 'aborted';
    const events = eventsForRunCancellation(kernel.getState(), reason, cause);
    kernel.processEventBatch(events);
    for (const event of events) collector.recordRuntime(event);
    executionAbortController.abort(reason);
    return events;
  };
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
    return {
      type: 'run.error',
      message: failure.message,
      recoverable: false,
      failure: failure.failure,
      turnId: failure.turnId,
      outcome: failedTerminalOutcomeV1(failure.failure, {
        knownExternalEffects: cancellationIncomplete || unknownReservation ? 'unknown' : 'known',
        reasonCode: cancellationIncomplete ? 'cancel_incomplete' : 'budget_exhausted',
      }),
    };
  };
  input.onKernelControl?.({
    getState: () => kernel.getState(),
    processEvent: (event) => {
      kernel.processEvent(event);
    },
    cancelRun: (reason) => cancelRun(reason),
  });
  try {
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

    const resumedInteraction =
      getActiveTask(kernel.getState()) && kernel.getState().interactions.kind !== 'idle';
    if (!resumedInteraction) {
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
          userGoal: input.task,
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
      };
      kernel.processEvent(initial);
      collector.recordRuntime(initial);
      yield initial;

      const turnStarted: RuntimeEvent = {
        type: 'turn.started',
        turnId: crypto.randomUUID(),
      };
      kernel.processEvent(turnStarted);
      collector.recordRuntime(turnStarted);
      yield turnStarted;

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

    const executor = createRuntimeEffectExecutor({
      config: input.config,
      model,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      runtimeStore: kernel.runtimeStore,
      skills: input.skills,
      skillOptions: input.skillOptions,
      signal: executionAbortController.signal,
      onCompactionProgress: input.onCompactionProgress,
      compactionReporter: input.config.compaction?.localDebug?.enabled
        ? createLocalCompactionDebugReporter({
            enabled: true,
            directory: input.config.compaction.localDebug.directory,
            sessionId: input.threadId,
          })
        : undefined,
      providerDataAdmission,
      remoteMcpEgressPermitResolver: input.remoteMcpEgressPermitResolver,
    });
    for await (const event of runRuntimeLoop(
      kernel,
      executor,
      provider,
      10_000,
      (effect, state) =>
        getFeatureFlags(input.config).resourceBudgetV1
          ? prepareRuntimeEffectForBudgetV1(effect, state as import('./state').RuntimeState, {
              config: input.config,
              model,
              shellExecutor: input.shellExecutor,
              mcpManager: input.mcpManager,
              skills: input.skills,
              skillOptions: input.skillOptions,
              signal: executionAbortController.signal,
              providerDataAdmission,
              remoteMcpEgressPermitResolver: input.remoteMcpEgressPermitResolver,
              subagentEventSink: () => {},
            })
          : effect,
      executionAbortController.signal,
    )) {
      collector.recordRuntime(event);
      if (event.type === 'approval.rejected' && event.failure?.kind === 'approval_rejected') {
        runCancelled = true;
        exitStatus = 'aborted';
        executionAbortController.abort(event.reason);
      }
      if (event.type === 'turn.aborted' && event.cause === 'user') {
        runCancelled = true;
        exitStatus = 'aborted';
        executionAbortController.abort(event.reason);
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
    }
    if (executionAbortController.signal.aborted) exitStatus = 'aborted';
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
    if (executionAbortController.signal.aborted) {
      exitStatus = 'aborted';
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
    const failure = recordRuntimeFailure({
      kind:
        error instanceof ProviderDataAdmissionError
          ? providerPolicyUnavailable
            ? 'mandatory_policy_unavailable'
            : 'policy_denied'
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
      outcome: failedTerminalOutcomeV1(failure.failure, {
        knownExternalEffects:
          error instanceof ProviderDataAdmissionError
            ? error.knownExternalEffects
            : kernel.getState().resourceBudget.status === 'active' &&
                Object.values(kernel.getState().resourceBudget.reservations).some(
                  (reservation) => reservation.state === 'unknown',
                )
              ? 'unknown'
              : 'known',
      }),
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
    input.onKernelControl?.(null);
    await collector.finalize(exitStatus);
    kernel.close();
  }
}
