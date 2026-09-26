import { randomBytes } from 'node:crypto';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import { createChatModel, createModelSecretDetector } from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { SubagentResultArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import type { InteractionMode, SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAbortReason,
  type RuntimeBackgroundExecutionProjection,
  type RuntimeBackgroundExecutionSnapshot,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeCommandContext,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeInteractionQueueProjection,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
  runtimeAbortCause,
  sameRuntimeClientInteractionIdentity,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from '@kite-ai/runtime-host';
import {
  fundingBudgetForRun,
  requiredBackgroundTaskIds,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { ProjectIdentity } from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#kite-service/config';
import { getFeatureFlags } from '#kite-service/config/features';
import { appSandboxBackendAvailable, type SandboxBackend } from '#kite-service/sandbox/types';
import {
  ContextCompactionService,
  type HostCompactionPlan,
} from '../../runtime/session/context-compaction-service';
import { RewindService, type RewindSettlement } from '../../runtime/session/rewind-service';
import {
  createRuntimeInteractionBroker,
  RUNTIME_INTERACTION_IDENTITY_SCHEMA_,
  type RuntimeInteractionBroker,
  type RuntimeInteractionIdentity,
} from '../../runtime-application/interaction-broker';
import { projectRuntimeClientEvent } from '../../runtime-client/event-projector';
import {
  mapRuntimeInteractionResponseToUserAction,
  projectRuntimeClientInteraction,
  projectRuntimeClientInteractionQueue,
  type RuntimeInteractionEffect,
  resolveRuntimeInteractionEffect,
} from '../../runtime-client/interaction-projector';
import { RuntimePresentationFrame } from '../../runtime-client/presentation-frame';
import { KiteAppServerSessionError } from '../kite-session-app-server-storage';
import { projectRuntimeEphemeralNotification } from '../presentation-notification';
import type { PrecommittedInteractionActionDescriptor } from './command-interaction-decision';
import { assertPrecommittedRewind } from './command-rewind-decision';
import { managedShellOwnerKey, managedShellRuntime } from './managed-shell';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from './RuntimeSessionCoordinator';
import type { AppWorkspaceEffectCompositionFactory } from './runtime-effect-dependencies';
import { reconcileRuntimeSessionAfterRestart } from './session-restart-recovery';
import {
  canContinueAcceptedIndependentChild,
  canContinueBlockedIndependentChild,
  canContinueSettledGlobalAdmission,
  obsoleteGlobalAdmissionSettlementEvents,
  type RuntimeUserAction,
} from './state-actions';
import type { RuntimeActionProvider, RuntimeInteractionCommandCommitPort } from './state-runner';
import type { RuntimeEffect, RuntimeEvent, RuntimeState } from './state-runtime';
import type { AfterTurnContinuationRuntime } from './subagent/after-turn-continuation';
import {
  type BackgroundSubagentControlRuntime,
  backgroundSubagentOwnerKey,
} from './subagent/background-runtime';
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';
import type {
  PrecommittedStartTurnDescriptor,
  StartTurnSkillPlanningContext,
} from './turn-command-decision';
import type { RuntimeTurnInput } from './turn-coordinator';

export interface CliRuntimeBridgeInput {
  readonly enqueueSessionWork?: <Result>(
    sessionId: string,
    operation: () => Result | Promise<Result>,
  ) => Promise<Result>;
  readonly restartRecoveryOwnership?: () =>
    | {
        readonly kind: 'fenced_previous_execution';
        readonly controllerGeneration: number;
        readonly assertCurrent: () => boolean;
      }
    | undefined;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectIdentity: ProjectIdentity;
  readonly checkpointPath: string;
  /** Read a settled Session after its execution coordinator has been released. */
  readonly storedProjection?: () => RuntimeSessionProjection | undefined;
  readonly config: AgentConfig;
  /** Resolve a client-selected Session route without exposing Provider credentials on the wire. */
  readonly resolveModelConfig?: (route: {
    readonly provider: string;
    readonly name: string;
  }) => AgentConfig;
  readonly shellExecutor: ShellExecutor;
  readonly interactionMode: InteractionMode;
  readonly sandboxBackend: SandboxBackend;
  /** Narrow Workspace-owned provider; the bridge never owns or stops its supervisor. */
  readonly mcpManager?: McpRuntimeProvider;
  readonly skillManifests?: readonly SkillManifest[];
  readonly skillOptions: SkillScanOptions;
  readonly initialSkillActivations: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
  readonly onSessionLoggingStatus?: (status: {
    readonly mode: 'off' | 'metadata' | 'content';
  }) => void;
  readonly onSessionLoggingDiagnostic?: (message: string) => void;
  /** Worker-owned effect composition factory; it receives only pinned admission context. */
  readonly workspaceEffectCompositionFactory?: AppWorkspaceEffectCompositionFactory;
  /** Private App Server child admission owner; absent for legacy and CLI paths. */
  readonly childSessionAcceptance?: RuntimeTurnInput['childSessionAcceptance'];
  readonly crossSessionQueueMail?: RuntimeTurnInput['crossSessionQueueMail'];
  /** Best-effort wake for durable Agent notices derived from a committed Run cancellation. */
  readonly onCommittedCancel?: () => void;
  readonly followupPolicyForPreparedTool?: (
    input: Parameters<NonNullable<RuntimeTurnInput['followupPolicyForPreparedTool']>>[0],
    activeRunConfig: Readonly<AgentConfig>,
  ) => ReturnType<NonNullable<RuntimeTurnInput['followupPolicyForPreparedTool']>>;
  readonly pendingFollowupFunding?: () => NonNullable<
    Parameters<typeof reconcileRuntimeSessionAfterRestart>[0]['preservePendingFollowupFunding']
  >;
  readonly preparedFollowupRecoveryProofs?: () => NonNullable<
    Parameters<typeof reconcileRuntimeSessionAfterRestart>[0]['preservePreparedFollowupModels']
  >;
  readonly preparedCurrentTurnRecoveryProofs?: () => NonNullable<
    Parameters<typeof reconcileRuntimeSessionAfterRestart>[0]['preservePreparedCurrentTurnModels']
  >;
  readonly dispatchedChildRecoveryProofs?: () => NonNullable<
    Parameters<typeof reconcileRuntimeSessionAfterRestart>[0]['preserveDispatchedChildDelegations']
  >;
}

export type CliRuntimeInteractionResolution =
  | RuntimeUserAction
  | PrecommittedInteractionActionDescriptor;

interface PendingCliInteraction {
  readonly effect: RuntimeInteractionEffect;
  readonly interaction: RuntimeClientInteraction;
  readonly commandCommit: RuntimeInteractionCommandCommitPort;
  readonly brokerIdentity: RuntimeInteractionIdentity;
}

interface CliRuntimeTurnExecutionInput {
  readonly operationId: string;
  readonly task: string;
  readonly userGoal: string;
  readonly precommittedStart?: PrecommittedStartTurnDescriptor;
  readonly resumeCommittedInteraction?: boolean;
  readonly commandContext?: Readonly<RuntimeCommandContext>;
  /** Immutable model/config snapshot selected when this Run was admitted. */
  readonly config: AgentConfig;
}

function canResumeRequiredChildWait(
  run: RuntimeSessionProjection['currentRun'],
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
): boolean {
  const waiting = state.completionGuard.waitingReason;
  return (
    run?.status === 'waiting' &&
    run.waitingReason?.kind === 'required_background' &&
    waiting?.kind === 'required_background' &&
    JSON.stringify([...run.waitingReason.taskIds].sort()) ===
      JSON.stringify([...waiting.taskIds].sort()) &&
    canContinueBlockedIndependentChild(state, journal)
  );
}

export interface ConfigurableCliRuntimeBridge extends RuntimeHostExecutionBridge {
  recoverCommittedResume: NonNullable<RuntimeHostExecutionBridge['recoverCommittedResume']>;
  /** Changes the desired configuration for the next admitted Run only. */
  applySelectedConfig(config: AgentConfig): void;
  /** Parent-scoped durable wake for a Store-verified private child approval proxy. */
  publishChildApprovalWake(
    event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
    publish?: (notification: RuntimeNotification) => void,
  ): void;
}

export function createCliRuntimeBridge(
  input: CliRuntimeBridgeInput,
  capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
  modelInvocationRuntimeFactory: (workspace: string) => RuntimeTurnInput['modelInvocationRuntime'],
  resolveRecoveryIdentity: (sessionId: string) => string,
  runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
  interactionBroker?: RuntimeInteractionBroker<CliRuntimeInteractionResolution>,
  interactionClientIds?: (sessionId: string) => readonly string[],
): ConfigurableCliRuntimeBridge {
  return new CliRuntimeBridge(
    input,
    capabilityExecution,
    modelInvocationRuntimeFactory,
    resolveRecoveryIdentity,
    runtimeSessionCoordinator,
    interactionBroker,
    interactionClientIds,
  );
}

export function readBackgroundExecutionSnapshot(input: {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly workspace: string;
  readonly modelInvocationRuntimeFactory: (
    workspace: string,
  ) => RuntimeTurnInput['modelInvocationRuntime'];
  readonly recoveryIdentityKey: string;
  readonly independentChildSnapshot?: Readonly<{
    aggregateGeneration: string;
    watermark: number;
    executions: readonly RuntimeBackgroundExecutionProjection[];
  }>;
}): RuntimeBackgroundExecutionSnapshot {
  const shell = managedShellRuntime.listSnapshot(
    input.sessionId,
    managedShellOwnerKey(input.sessionId, input.workspace),
  );
  const modelRuntime = input.modelInvocationRuntimeFactory(input.workspace);
  const backgroundSubagentRuntime =
    'backgroundSubagentRuntime' in modelRuntime
      ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined)
      : undefined;
  const children = backgroundSubagentRuntime?.listSnapshot(
    input.sessionId,
    backgroundSubagentOwnerKey(input.sessionId, input.recoveryIdentityKey),
  );
  const independent = input.independentChildSnapshot;
  const independentIds = new Set(independent?.executions.map((entry) => entry.executionId) ?? []);
  return Object.freeze({
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    aggregateGeneration: `${shell.aggregateGeneration}:${children?.aggregateGeneration ?? 'no-subagents'}:${independent?.aggregateGeneration ?? 'no-independent-children'}`,
    // Both owner watermarks are monotonic within the combined aggregate
    // generation. Their sum advances whenever either directory changes.
    watermark: shell.watermark + (children?.watermark ?? 0) + (independent?.watermark ?? 0),
    executions: Object.freeze(
      [
        ...shell.executions,
        ...(children?.executions ?? []).filter((item) => !independentIds.has(item.executionId)),
        ...(independent?.executions ?? []),
      ].map((item) => Object.freeze({ ...item, sessionRevision: input.sessionRevision })),
    ),
  });
}

class CliRuntimeBridge implements ConfigurableCliRuntimeBridge {
  readonly #input: CliRuntimeBridgeInput;
  readonly #capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>;
  readonly #modelInvocationRuntimeFactory: (
    workspace: string,
  ) => RuntimeTurnInput['modelInvocationRuntime'];
  readonly #resolveRecoveryIdentity: (sessionId: string) => string;
  readonly #runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess;
  readonly #interactionBroker: RuntimeInteractionBroker<CliRuntimeInteractionResolution>;
  readonly #ownsInteractionBroker: boolean;
  readonly #interactionClientIds: (sessionId: string) => readonly string[];
  readonly #contextCompactionService: ContextCompactionService;
  #manualCompactionInFlightId: string | null = null;
  #revision = 0;
  #created = false;
  #closed = false;
  #activePublish: ((notification: RuntimeNotification) => void) | undefined;
  #activePresentationFrame: RuntimePresentationFrame | undefined;
  #pendingInteraction: PendingCliInteraction | undefined;
  #desiredConfig: AgentConfig;
  readonly #pendingIndependentStops = new Set<string>();
  #activeRunConfig: AgentConfig | undefined;
  readonly #pendingAfterTurnRecoveries = new Set<string>();

  constructor(
    input: CliRuntimeBridgeInput,
    capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
    modelInvocationRuntimeFactory: (
      workspace: string,
    ) => RuntimeTurnInput['modelInvocationRuntime'],
    resolveRecoveryIdentity: (sessionId: string) => string,
    runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
    interactionBroker?: RuntimeInteractionBroker<CliRuntimeInteractionResolution>,
    interactionClientIds?: (sessionId: string) => readonly string[],
  ) {
    this.#input = input;
    this.#capabilityExecution = capabilityExecution;
    this.#modelInvocationRuntimeFactory = modelInvocationRuntimeFactory;
    this.#resolveRecoveryIdentity = resolveRecoveryIdentity;
    this.#runtimeSessionCoordinator = runtimeSessionCoordinator;
    this.#interactionBroker = interactionBroker ?? createRuntimeInteractionBroker();
    this.#ownsInteractionBroker = interactionBroker === undefined;
    this.#interactionClientIds = interactionClientIds ?? (() => []);
    this.#desiredConfig = input.config;
    this.#contextCompactionService = new ContextCompactionService(
      () => {
        const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
        return {
          runtimeSessionCoordinator: this.#runtimeSessionCoordinator,
          builtinToolCatalog: modelRuntime.builtinToolCatalog,
          capabilityExecution: this.#capabilityExecution,
          modelInvocationRuntimeFactory: this.#modelInvocationRuntimeFactory,
        };
      },
      (threadId) => (threadId === this.#input.sessionId ? this.#compactionRuntime() : undefined),
    );
  }

  applySelectedConfig(config: AgentConfig): void {
    this.#desiredConfig = config;
  }

  publishChildApprovalWake(
    event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
    publish?: (notification: RuntimeNotification) => void,
  ): void {
    const coordinator = this.#ensureCoordinator();
    coordinator.control.processEvent(event);
    const revision = coordinator.getState().revision;
    this.#revision = revision;
    const activePublish = publish ?? this.#activePublish;
    if (activePublish) this.#publishCommittedEvents([event], revision, activePublish, 'session');
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId) return;
    const coordinator = this.#ensureCoordinator();
    this.#driveBackgroundStopIntents(coordinator);
    if (!this.#created) this.#recoverFailedAfterTurnReservationReleases(coordinator);
    if (!this.#created) {
      const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
      const children =
        'backgroundSubagentRuntime' in modelRuntime
          ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime)
          : undefined;
      const ownerKey = backgroundSubagentOwnerKey(
        this.#input.sessionId,
        this.#resolveRecoveryIdentity(this.#input.sessionId),
      );
      for (const event of children?.settlementRecoveryEvents?.(ownerKey) ?? [])
        if (event.type === 'subagent.background_result_persisted')
          coordinator.control.processEvent(event as RuntimeEvent);
    }
    if (!this.#created) this.#queuePendingAfterTurnRecoveries(coordinator);
    const recoveryOwnership = this.#input.restartRecoveryOwnership?.();
    if (recoveryOwnership) {
      const result = await reconcileRuntimeSessionAfterRestart({
        control: coordinator.control,
        modelInvocationRuntime: this.#modelInvocationRuntimeFactory(this.#input.workspace),
        shellExecutor: this.#input.shellExecutor,
        recoveryOwnership,
        preserveReservedChildDelegations:
          this.#input.childSessionAcceptance?.pendingDelegationReservations?.(),
        preservePendingAfterTurnDelegations:
          this.#input.childSessionAcceptance?.pendingAfterTurnDelegations?.(),
        preserveLiveAfterTurnDelegations:
          this.#input.childSessionAcceptance?.liveAfterTurnDelegations?.(),
        preserveSealedAfterTurnReports:
          this.#input.childSessionAcceptance?.sealedAfterTurnReports?.(),
        preservePendingFollowupFunding: this.#input.pendingFollowupFunding?.(),
        preservePreparedFollowupModels: this.#input.preparedFollowupRecoveryProofs?.(),
        preservePreparedCurrentTurnModels: this.#input.preparedCurrentTurnRecoveryProofs?.(),
        preserveDispatchedChildDelegations: this.#input.dispatchedChildRecoveryProofs?.(),
        historyEvents: coordinator
          .getStateRuntimeStorage()
          .sessions.loadEventsStrict(sessionId)
          .map((entry) => entry.event),
      });
      if (!result.complete)
        throw new KiteAppServerSessionError(
          'recovery_required',
          'Previous execution resources could not yet be reconciled.',
        );
    }
    this.#created = true;
    this.#closed = false;
    const state = coordinator.getState();
    this.#revision = state.revision;
    if (!coordinator.recoveryChanged && !recoveryOwnership) return;
    // Resolve the restored Run at the committed revision before projecting
    // intermediate recovery events from the same atomic batch.
    coordinator.session.getLifecycleProjection();
    // Drain restored events before a successor Run is created. Otherwise their
    // old revisions would later be projected against the successor's Run.
    this.#publishCommittedEvents([], this.#revision, publish, 'session');
    publish({
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: this.#revision,
      projection: { kind: 'session', session: this.#projection() },
    });
  }

  #driveBackgroundStopIntents(coordinator: RuntimeSessionCoordinator): void {
    const events = coordinator
      .getStateRuntimeStorage()
      .sessions.loadEventsStrict(this.#input.sessionId)
      .map((entry) => entry.event);
    const done = new Set(
      events
        .filter(
          (event) =>
            event.type === 'background_execution.stop_settled' ||
            event.type === 'background_execution.stop_unknown',
        )
        .map((event) => event.commandId),
    );
    const shellOwner = managedShellOwnerKey(this.#input.sessionId, this.#input.workspace);
    const shell = managedShellRuntime.listSnapshot(this.#input.sessionId, shellOwner);
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    const children =
      'backgroundSubagentRuntime' in modelRuntime
        ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined)
        : undefined;
    const childOwner = backgroundSubagentOwnerKey(
      this.#input.sessionId,
      this.#resolveRecoveryIdentity(this.#input.sessionId),
    );
    const childSnapshot = children?.listSnapshot(this.#input.sessionId, childOwner);
    const independent = this.#input.childSessionAcceptance?.backgroundSnapshot?.();
    const independentIds = new Set(independent?.executions.map((item) => item.executionId) ?? []);
    for (const intent of events) {
      if (intent.type !== 'background_execution.stop_requested' || done.has(intent.commandId))
        continue;
      const target = [
        ...shell.executions,
        ...(childSnapshot?.executions ?? []).filter(
          (item) => !independentIds.has(item.executionId),
        ),
        ...(independent?.executions ?? []),
      ].find(
        (item) =>
          item.executionId === intent.executionId &&
          item.kind === intent.executionKind &&
          item.ownerGeneration === intent.ownerGeneration,
      );
      if (!target) {
        this.#settleBackgroundStop(coordinator, intent.commandId, intent.executionId, false);
        continue;
      }
      if (target.cleanupConfirmed) {
        this.#settleBackgroundStop(coordinator, intent.commandId, intent.executionId, true);
        continue;
      }
      if (target.status === 'unavailable') {
        this.#settleBackgroundStop(coordinator, intent.commandId, intent.executionId, false);
        continue;
      }
      const settled = () => {
        const redrive = () => {
          const current = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
          if (current) this.#driveBackgroundStopIntents(current);
        };
        if (this.#input.enqueueSessionWork)
          void this.#input.enqueueSessionWork(this.#input.sessionId, redrive);
        else queueMicrotask(redrive);
      };
      const requested =
        intent.executionKind === 'subagent'
          ? independentIds.has(intent.executionId)
            ? (() => {
                const taskControl = this.#input.childSessionAcceptance?.taskControl;
                if (!taskControl) {
                  this.#settleBackgroundStop(
                    coordinator,
                    intent.commandId,
                    intent.executionId,
                    false,
                  );
                  return true;
                }
                if (this.#pendingIndependentStops.has(intent.commandId)) return true;
                this.#pendingIndependentStops.add(intent.commandId);
                void taskControl
                  .cancelTask(intent.executionId)
                  .then((result) => {
                    if (result.status === 'unknown' || result.status === 'not_found')
                      this.#settleBackgroundStop(
                        coordinator,
                        intent.commandId,
                        intent.executionId,
                        false,
                      );
                    else settled();
                  })
                  .catch(() =>
                    this.#settleBackgroundStop(
                      coordinator,
                      intent.commandId,
                      intent.executionId,
                      false,
                    ),
                  )
                  .finally(() => this.#pendingIndependentStops.delete(intent.commandId));
                return true;
              })()
            : (children?.requestCancel(childOwner, intent.executionId, settled) ?? false)
          : managedShellRuntime.requestStop(intent.executionId, shellOwner, settled);
      // The handle may become terminal after the snapshot above but before the
      // stop request registers its callback. Re-read the directory so every
      // durable stop intent receives a terminal settlement.
      if (!requested) settled();
    }
  }

  #recoverFailedAfterTurnReservationReleases(coordinator: RuntimeSessionCoordinator): void {
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    const children =
      'backgroundSubagentRuntime' in modelRuntime
        ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined)
        : undefined;
    const ownerKey = backgroundSubagentOwnerKey(
      this.#input.sessionId,
      this.#resolveRecoveryIdentity(this.#input.sessionId),
    );
    const state = coordinator.getState();
    if (state.resourceBudget.status !== 'active') return;
    const pendingIndependentChildAllotments = new Set(
      this.#input.childSessionAcceptance?.pendingDelegationReservations?.() ?? [],
    );
    for (const reservationId of children?.settlementRecoveryReservations?.(ownerKey) ?? []) {
      // Legacy after-turn cleanup cannot release an exact unsettled independent
      // child intent. Its Store claim remains the authority for cancellation.
      if (pendingIndependentChildAllotments.has(reservationId)) continue;
      if (state.resourceBudget.reservations[reservationId]?.state !== 'reserved') continue;
      coordinator.control.processEvent({
        type: 'resource_budget.released',
        reservationId,
      });
    }
    for (const invocation of Object.values(state.capabilities.invocations)) {
      const lifecycle = invocation.subagentProviderLifecycle;
      const link = lifecycle?.childSession;
      if (
        link?.disposition !== 'after_turn' ||
        !link.terminalImport ||
        lifecycle?.backgroundResult?.afterTurn
      )
        continue;
      const funding = fundingBudgetForRun(coordinator.getState(), link.fundingRunId);
      const report = Object.values(funding?.reservations ?? {}).find(
        (reservation) =>
          reservation.invocationId ===
          `model-invocation:after-turn:${lifecycle?.childInvocationId}`,
      );
      if (report?.state === 'reserved')
        coordinator.control.processEvent({
          type: 'resource_budget.released',
          reservationId: report.reservationId,
        });
    }
  }

  #queuePendingAfterTurnRecoveries(coordinator: RuntimeSessionCoordinator): void {
    const events = coordinator
      .getStateRuntimeStorage()
      .sessions.loadEventsStrict(this.#input.sessionId)
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<typeof event, { type: 'subagent.background_result_persisted' }> =>
          event.type === 'subagent.background_result_persisted' && event.afterTurn !== undefined,
      );
    for (const event of events) {
      const afterTurn = event.afterTurn!;
      const state = coordinator.getState();
      const funding = fundingBudgetForRun(state, event.originRunId);
      if (
        funding?.reservations[afterTurn.reservationId]?.state !== 'reserved' ||
        this.#pendingAfterTurnRecoveries.has(event.notificationId)
      ) {
        continue;
      }
      this.#pendingAfterTurnRecoveries.add(event.notificationId);
      const recover = async () => {
        try {
          const current = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
          if (!current) return;
          const currentState = current.getState();
          const funding = fundingBudgetForRun(currentState, event.originRunId);
          if (funding?.reservations[afterTurn.reservationId]?.state !== 'reserved') {
            return;
          }
          const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
          const children =
            'backgroundSubagentRuntime' in modelRuntime
              ? (modelRuntime.backgroundSubagentRuntime as
                  | BackgroundSubagentControlRuntime
                  | undefined)
              : undefined;
          const continuation =
            'afterTurnContinuationRuntime' in modelRuntime
              ? (modelRuntime.afterTurnContinuationRuntime as
                  | AfterTurnContinuationRuntime
                  | undefined)
              : undefined;
          if (!continuation) return;
          const ownerKey = backgroundSubagentOwnerKey(
            this.#input.sessionId,
            this.#resolveRecoveryIdentity(this.#input.sessionId),
          );
          const independent = Object.values(currentState.capabilities.invocations)
            .map((invocation) => invocation.subagentProviderLifecycle?.childSession)
            .find(
              (link) =>
                link?.disposition === 'after_turn' &&
                link.originToolCallId === event.originToolCallId &&
                link.originRunId === event.originRunId &&
                link.terminalImport?.resultRef.integrityIdentifier ===
                  event.artifactIntegrityIdentifier,
            );
          const child = independent
            ? current.getStateRuntimeStorage().sessions.loadSnapshot(independent.childThreadId)
            : null;
          const sealed = child?.childSessionOrigin?.terminal;
          const independentRef =
            child?.childSessionOrigin?.childInvocationId === event.taskId &&
            sealed?.resultRef.integrityIdentifier === event.artifactIntegrityIdentifier &&
            sealed?.status === afterTurn.status &&
            'childResultArtifacts' in modelRuntime
              ? (modelRuntime.childResultArtifacts as SubagentResultArtifactAccess).lookup(
                  ownerKey,
                  event.taskId,
                )?.ref
              : undefined;
          const durable = independent
            ? undefined
            : await children?.readTask(ownerKey, event.taskId);
          const artifact = (independentRef ?? durable?.artifact) as
            | Readonly<{
                artifactId: string;
                kind: 'subagent_task';
                integrityIdentifier: string;
                byteLength: number;
              }>
            | undefined;
          if (!artifact || artifact.integrityIdentifier !== event.artifactIntegrityIdentifier)
            return;
          await continuation.deliver({
            sessionId: this.#input.sessionId,
            admissionRevision: afterTurn.admissionRevision,
            phase: afterTurn.phase,
            attempt: event.attempt,
            reservation: {
              reservationId: afterTurn.reservationId,
              originRunId: event.originRunId,
              deadlineAt: funding.deadlineAt,
              preparationEvents: [],
            },
            notification: {
              notificationId: event.notificationId,
              source: 'subagent',
              modelRole: 'user',
              ownerKey,
              taskId: event.taskId,
              originRunId: event.originRunId,
              originTurnId: event.originTurnId,
              originToolCallId: event.originToolCallId,
              attempt: event.attempt,
              status: afterTurn.status,
              shortReport: event.shortReport,
              resultArtifact: artifact,
              cancelRequested: afterTurn.cancelRequested,
            },
            persistEvents: async (
              settlementEvents: Parameters<typeof current.control.processEvent>[0][],
            ) => {
              for (const settlementEvent of settlementEvents) {
                current.control.processEvent(settlementEvent);
              }
              return true;
            },
          });
        } finally {
          this.#pendingAfterTurnRecoveries.delete(event.notificationId);
        }
      };
      if (this.#input.enqueueSessionWork) {
        void this.#input.enqueueSessionWork(this.#input.sessionId, recover).catch(() => {
          // The durable pending intent remains authoritative for the next recovery pass.
        });
      } else {
        queueMicrotask(() => {
          void recover().catch(() => {
            // The durable pending intent remains authoritative for the next recovery pass.
          });
        });
      }
    }
  }

  #hasLiveBackgroundExecutions(): boolean {
    const shell = managedShellRuntime.listSnapshot(
      this.#input.sessionId,
      managedShellOwnerKey(this.#input.sessionId, this.#input.workspace),
    );
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    const children =
      'backgroundSubagentRuntime' in modelRuntime
        ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined)
        : undefined;
    const childSnapshot = children?.listSnapshot(
      this.#input.sessionId,
      backgroundSubagentOwnerKey(
        this.#input.sessionId,
        this.#resolveRecoveryIdentity(this.#input.sessionId),
      ),
    );
    const independent = this.#input.childSessionAcceptance?.backgroundSnapshot?.();
    return [
      ...shell.executions,
      ...(childSnapshot?.executions ?? []),
      ...(independent?.executions ?? []),
    ].some((execution) => !execution.cleanupConfirmed);
  }

  #settleBackgroundStop(
    coordinator: RuntimeSessionCoordinator,
    commandId: string,
    executionId: string,
    confirmed: boolean,
  ): void {
    const events = coordinator
      .getStateRuntimeStorage()
      .sessions.loadEventsStrict(this.#input.sessionId)
      .map((entry) => entry.event);
    if (
      events.some(
        (event) =>
          (event.type === 'background_execution.stop_settled' ||
            event.type === 'background_execution.stop_unknown') &&
          event.commandId === commandId,
      )
    )
      return;
    coordinator.control.processEvent(
      confirmed
        ? {
            type: 'background_execution.stop_settled',
            commandId,
            executionId,
            cleanupConfirmed: true,
          }
        : {
            type: 'background_execution.stop_unknown',
            commandId,
            executionId,
            reason: 'external_outcome_unknown',
          },
    );
    this.#revision = coordinator.getState().revision;
  }

  /** Rebuild only an already-committed resume with no durable dispatch facts. */
  async recoverCommittedResume(
    command: Extract<RuntimeCommand, { readonly type: 'resume_session' }>,
    committedRevision: number,
    publish: (notification: RuntimeNotification) => void,
    commandContext?: Readonly<RuntimeCommandContext>,
  ): Promise<RuntimeHostPreparedExecution | undefined> {
    if (command.sessionId !== this.#input.sessionId) return undefined;
    const coordinator = this.#runtimeSessionCoordinator.get(command.sessionId);
    if (coordinator?.lifecycle !== 'idle') return;
    const state = coordinator.getState();
    const run = coordinator.session.getLifecycleProjection().currentRun;
    if (
      state.revision !== committedRevision ||
      (run?.status !== 'running' && run?.status !== 'waiting') ||
      run.activeTurnId !== state.turn.turnId ||
      run.taskId !== state.activeTaskId ||
      !(() => {
        const journal = coordinator
          .getStateRuntimeStorage()
          .sessions.loadEventsStrict(command.sessionId);
        return run.status === 'waiting'
          ? this.#input.childSessionAcceptance !== undefined &&
              canResumeRequiredChildWait(run, state, journal)
          : canContinueSettledGlobalAdmission(state, journal) ||
              (this.#input.childSessionAcceptance !== undefined &&
                canContinueAcceptedIndependentChild(state, journal));
      })()
    )
      return;
    const prepared = this.#preparedInteractionResume(
      command.commandId,
      coordinator,
      {
        status: 'applied',
        commandId: command.commandId,
        sessionId: command.sessionId,
        revision: committedRevision,
      },
      commandContext,
    );
    this.#activePublish = publish;
    return prepared;
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    const terminal = (
      receipt: Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }>,
    ): RuntimeHostCommandInspection => ({
      kind: 'terminal',
      receipt,
    });
    if (command.type === 'fork_session') {
      if (command.sourceSessionId !== this.#input.sessionId || !this.#created || this.#closed) {
        return terminal(this.#rejected(command, 'session_unavailable'));
      }
      const source = this.#runtimeSessionCoordinator.get(command.sourceSessionId);
      if (!source) return terminal(this.#rejected(command, 'session_unavailable'));
      if (this.#hasLiveBackgroundExecutions()) {
        return terminal(this.#rejected(command, 'runtime_busy'));
      }
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: context.targetSessionId,
          commit: async (evidence) => {
            const committed = source.commitForkSessionCommand(
              command,
              context.targetSessionId,
              this.#resolveRecoveryIdentity(context.targetSessionId),
              evidence,
            );
            if (committed.status !== 'applied') {
              throw new Error('Runtime fork checkpoint is unavailable.');
            }
            return { receipt: receiptFromStored(committed.receipt) };
          },
        },
      };
    }
    if (context.targetSessionId !== this.#input.sessionId) {
      return terminal(this.#rejected(command, 'invalid_session'));
    }
    if (command.type === 'create_session') {
      if (
        this.#created ||
        command.workspace !== this.#input.workspace ||
        (command.bootstrapSessionId !== undefined &&
          command.bootstrapSessionId !== this.#input.sessionId)
      ) {
        return terminal(this.#rejected(command, 'invalid_session'));
      }
      return this.#snapshotDecision(
        (coordinator) => ({
          activate: () => {
            if (command.model) {
              this.#desiredConfig = this.#resolveModelConfig(command.model);
            }
            this.#created = true;
            this.#closed = false;
            this.#revision = coordinator.getState().revision;
          },
          releaseOnFailure: true,
        }),
        command.model,
      );
    }
    if (!this.#created || this.#closed) {
      return terminal(this.#rejected(command, 'session_unavailable'));
    }
    if ('sessionId' in command && command.sessionId !== this.#input.sessionId) {
      return terminal(this.#notFound(command));
    }
    if (command.type === 'stop_background_execution') {
      if (!this.#input.enqueueSessionWork) return terminal(this.#rejected(command, 'unsupported'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      const currentRevision = coordinator.getState().revision;
      if (command.expectedRevision !== currentRevision) {
        this.#revision = currentRevision;
        return terminal(this.#rejected(command, 'revision_conflict'));
      }
      const shellOwner = managedShellOwnerKey(this.#input.sessionId, this.#input.workspace);
      const shell = managedShellRuntime.listSnapshot(this.#input.sessionId, shellOwner);
      const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
      const children =
        'backgroundSubagentRuntime' in modelRuntime
          ? (modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined)
          : undefined;
      const childOwner = backgroundSubagentOwnerKey(
        this.#input.sessionId,
        this.#resolveRecoveryIdentity(this.#input.sessionId),
      );
      const child = children?.listSnapshot(this.#input.sessionId, childOwner);
      const independent = this.#input.childSessionAcceptance?.backgroundSnapshot?.();
      const independentIds = new Set(independent?.executions.map((item) => item.executionId) ?? []);
      const target = [
        ...shell.executions,
        ...(child?.executions ?? []).filter((item) => !independentIds.has(item.executionId)),
        ...(independent?.executions ?? []),
      ].find((item) => item.executionId === command.executionId);
      if (
        !target ||
        target.kind !== command.executionKind ||
        target.ownerGeneration !== command.expectedOwnerGeneration ||
        target.revision !== command.expectedExecutionRevision ||
        target.status !== 'running'
      )
        return terminal(this.#rejected(command, 'target_ended'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          validate: () => {
            const commitRevision = coordinator.getState().revision;
            if (command.expectedRevision !== commitRevision) {
              this.#revision = commitRevision;
              return {
                status: 'conflict' as const,
                commandId: command.commandId,
                code: 'revision_conflict' as const,
                currentRevision: commitRevision,
              };
            }
            const currentShell = managedShellRuntime.listSnapshot(
              this.#input.sessionId,
              shellOwner,
            );
            const currentChild = children?.listSnapshot(this.#input.sessionId, childOwner);
            const currentIndependent = this.#input.childSessionAcceptance?.backgroundSnapshot?.();
            const currentIndependentIds = new Set(
              currentIndependent?.executions.map((item) => item.executionId) ?? [],
            );
            const currentTarget = [
              ...currentShell.executions,
              ...(currentChild?.executions ?? []).filter(
                (item) => !currentIndependentIds.has(item.executionId),
              ),
              ...(currentIndependent?.executions ?? []),
            ].find((item) => item.executionId === command.executionId);
            if (
              !currentTarget ||
              currentTarget.kind !== command.executionKind ||
              currentTarget.ownerGeneration !== command.expectedOwnerGeneration ||
              currentTarget.revision !== command.expectedExecutionRevision ||
              currentTarget.status !== 'running'
            ) {
              this.#revision = commitRevision;
              return this.#rejected(command, 'target_ended');
            }
            return undefined;
          },
          commit: async (evidence) => {
            const committed = coordinator.session.commitCommandBatch(
              [
                {
                  type: 'background_execution.stop_requested',
                  commandId: command.commandId,
                  executionId: command.executionId,
                  executionKind: command.executionKind,
                  ownerGeneration: command.expectedOwnerGeneration,
                },
              ],
              evidence,
            );
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async () => {
                this.#revision = receipt.revision;
                this.#driveBackgroundStopIntents(coordinator);
              },
            };
          },
        },
      };
    }
    if (command.type === 'respond_interaction') {
      const pending = this.#pendingInteraction;
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) {
        return terminal(this.#rejected(command, 'interaction_mismatch'));
      }
      const state = coordinator.getState();
      const childApproval =
        command.interaction.kind === 'approval'
          ? this.#input.childSessionAcceptance?.approvalProxy?.read(
              command.interaction.interactionId,
            )
          : null;
      if (childApproval) {
        if (
          command.interaction.kind !== 'approval' ||
          command.response.kind !== 'approval' ||
          command.expectedRevision !== state.revision ||
          command.sessionId !== this.#input.sessionId ||
          childApproval.parentSessionId !== this.#input.sessionId ||
          childApproval.status !== 'pending' ||
          command.response.decision === 'same_command'
        )
          return terminal(this.#rejected(command, 'interaction_mismatch'));
        const approvalProxy = this.#input.childSessionAcceptance!.approvalProxy!;
        const childDecision = command.response.decision;
        return {
          kind: 'accepted',
          decision: {
            targetSessionId: this.#input.sessionId,
            commit: async (evidence) => {
              const committed = approvalProxy.decide({
                parentState: state,
                interaction: command.interaction as Extract<
                  RuntimeClientInteraction,
                  { kind: 'approval' }
                >,
                decision: childDecision,
                evidence,
              });
              const receipt = receiptFromStored(committed);
              return {
                receipt,
                activation: async (publish) => {
                  this.#revision = receipt.revision;
                  approvalProxy.publishDecided(command.interaction.interactionId, (event) =>
                    this.publishChildApprovalWake(event, publish),
                  );
                  approvalProxy.activateDecision(command.interaction.interactionId);
                },
              };
            },
          },
        };
      }
      const effect = pending?.effect ?? resolveRuntimeInteractionEffect(state, command.interaction);
      if (
        !effect ||
        (pending && !sameInteractionIdentity(pending.interaction, command.interaction)) ||
        (!pending && !coordinator.commitInteractionCommand)
      ) {
        return terminal(this.#rejected(command, 'interaction_mismatch'));
      }
      const action = mapRuntimeInteractionResponseToUserAction({
        state,
        effect,
        interaction: command.interaction,
        response: command.response,
        expectedStateRevision: command.expectedRevision,
      });
      if (!action) return terminal(this.#rejected(command, 'interaction_mismatch'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = pending
              ? pending.commandCommit.commit(action, evidence, command.expectedRevision)
              : coordinator.commitInteractionCommand!({
                  action,
                  sessionId: command.sessionId,
                  interactionId: command.interaction.interactionId,
                  expectedRevision: command.expectedRevision,
                  effectType: effect.type,
                  reservationReconciliationEvents: [],
                  sandboxAvailable: coordinator.getSandboxAvailable() === true,
                  evidence,
                });
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                try {
                  if (pending && this.#pendingInteraction !== pending) {
                    throw new Error(
                      'Runtime interaction activation no longer owns its pending waiter.',
                    );
                  }
                  if (pending) this.#pendingInteraction = undefined;
                  this.#revision = receipt.revision;
                  this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
                  if (pending) {
                    const resolution = this.#interactionBroker.resolve(
                      pending.brokerIdentity,
                      committed.descriptor,
                    );
                    if (resolution !== 'resolved') {
                      throw new Error(
                        `Runtime interaction broker resolution failed: ${resolution}`,
                      );
                    }
                  } else {
                    this.#activePublish = publish;
                  }
                } catch (error) {
                  // The pending field was cleared before publication. Release
                  // this exact waiter as well as any accepted recovered resume.
                  if (pending) this.#interactionBroker.reject(pending.brokerIdentity, error);
                  this.#failActivation(coordinator, publish, error);
                }
              },
              ...(pending || coordinator.getState().turn.status !== 'active'
                ? {}
                : {
                    preparedExecution: this.#preparedInteractionResume(
                      command.commandId,
                      coordinator,
                      receipt,
                      context.commandContext,
                    ),
                  }),
            };
          },
        },
      };
    }
    if (command.type === 'resume_session') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (coordinator?.lifecycle === 'idle') {
        const state = coordinator.getState();
        const run = coordinator.session.getLifecycleProjection().currentRun;
        if (
          (run?.status === 'waiting' || run?.status === 'running') &&
          run.activeTurnId === state.turn.turnId &&
          run.taskId === state.activeTaskId
        ) {
          const journal = coordinator
            .getStateRuntimeStorage()
            .sessions.loadEventsStrict(this.#input.sessionId);
          const events =
            run.status === 'waiting' ? obsoleteGlobalAdmissionSettlementEvents(state, journal) : [];
          const canResumeOriginalTurn =
            (run.status === 'running' &&
              (canContinueSettledGlobalAdmission(state, journal) ||
                (this.#input.childSessionAcceptance !== undefined &&
                  canContinueAcceptedIndependentChild(state, journal)))) ||
            (this.#input.childSessionAcceptance !== undefined &&
              canResumeRequiredChildWait(run, state, journal));
          if (events.length > 0 || canResumeOriginalTurn) {
            return {
              kind: 'accepted',
              decision: {
                targetSessionId: this.#input.sessionId,
                commit: async (evidence) => {
                  // The command receipt, admission settlement and original Run
                  // waiting-to-running transition share the Host transaction.
                  const committed =
                    events.length > 0
                      ? coordinator.commitObsoleteAdmissionResumeCommand(events, evidence)
                      : {
                          receipt: coordinator.session.commitCommandSnapshot(evidence),
                          events: [],
                        };
                  const receipt = receiptFromStored(committed.receipt);
                  return {
                    receipt,
                    activation: async (publish) => {
                      this.#revision = receipt.revision;
                      this.#created = true;
                      this.#closed = false;
                      this.#activePublish = publish;
                      this.#publishCommittedEvents(
                        committed.events,
                        receipt.revision,
                        publish,
                        'turn',
                      );
                    },
                    preparedExecution: this.#preparedInteractionResume(
                      command.commandId,
                      coordinator,
                      receipt,
                      context.commandContext,
                    ),
                  };
                },
              },
            };
          }
        }
      }
      return this.#snapshotDecision((coordinator) => ({
        activate: () => {
          this.#revision = coordinator.getState().revision;
          this.#created = true;
          this.#closed = false;
        },
      }));
    }
    if (command.type === 'start_turn') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      if (coordinator.isTurnActive()) return terminal(this.#rejected(command, 'runtime_busy'));
      // A previous cancelled Turn may have reached its user-visible terminal
      // before bounded Provider cleanup finishes. Never admit a successor
      // into those recovery facts; the active execution owns reconciliation
      // until its generator releases the Session.
      if (hasPendingSubagentProviderRecovery(coordinator.getState())) {
        return terminal(this.#rejected(command, 'runtime_busy'));
      }
      const admittedConfig = command.model
        ? this.#resolveModelConfig(command.model)
        : this.#desiredConfig;
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitStartTurnCommand(
              command,
              evidence,
              this.#startSkillPlanningContext(command, admittedConfig),
              { provider: admittedConfig.providerName, name: admittedConfig.modelName },
            );
            const receipt = receiptFromStored(committed.receipt);
            if (command.model) {
              this.#desiredConfig = admittedConfig;
            }
            return {
              receipt,
              activation: async (publish) => {
                try {
                  this.#activeRunConfig = admittedConfig;
                  coordinator.activateStartTurnRun?.(committed.descriptor.turnId);
                  this.#revision = receipt.revision;
                  this.#activePublish = publish;
                  this.#publishCommittedEvents(
                    committed.events,
                    receipt.revision,
                    publish,
                    'turn',
                    {
                      runId: committed.descriptor.turnId,
                      ...(committed.descriptor.taskId === undefined
                        ? {}
                        : { taskId: committed.descriptor.taskId }),
                      turnId: committed.descriptor.turnId,
                    },
                  );
                } catch (error) {
                  this.#failActivation(coordinator, publish, error);
                }
              },
              preparedExecution: this.#preparedStart(
                command,
                committed.descriptor,
                receipt,
                context.commandContext,
                admittedConfig,
              ),
            };
          },
        },
      };
    }
    if (command.type === 'steer_turn') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      const state = coordinator.getState();
      const run = coordinator.session.getLifecycleProjection().currentRun;
      if (
        state.turn.status !== 'active' ||
        state.turn.turnId !== command.expectedTurnId ||
        run?.runId !== command.expectedRunId
      ) {
        return terminal(this.#rejected(command, 'target_ended'));
      }
      if (!coordinator.canAcceptSteerInput()) {
        return terminal(this.#rejected(command, 'steer_queue_full'));
      }
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const pending = this.#pendingInteraction;
            const committed = coordinator.commitSteerTurnCommand(command, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                this.#revision = receipt.revision;
                this.#activePublish = publish;
                this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn', {
                  runId: command.expectedRunId,
                  turnId: command.expectedTurnId,
                });
                managedShellRuntime.notifyInput(
                  managedShellOwnerKey(this.#input.sessionId, this.#input.workspace),
                );
                if (
                  committed.supersededInteractionId &&
                  pending?.interaction.interactionId === committed.supersededInteractionId
                ) {
                  if (this.#pendingInteraction === pending) this.#pendingInteraction = undefined;
                  const resolution = this.#interactionBroker.resolve(pending.brokerIdentity, {
                    type: 'superseded_by_user_input',
                    interactionId: committed.supersededInteractionId,
                  });
                  if (resolution !== 'resolved') {
                    throw new Error(`Runtime steer interaction supersession failed: ${resolution}`);
                  }
                }
              },
            };
          },
        },
      };
    }
    if (command.type === 'cancel_turn') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      if (coordinator.getState().turn.status !== 'active')
        return terminal(this.#rejected(command, 'turn_not_found'));
      if (coordinator.session.getLifecycleProjection().currentRun?.runId !== command.runId) {
        return terminal(this.#rejected(command, 'turn_not_found'));
      }
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitCancelTurnCommand(command, evidence),
      );
    }
    if (command.type === 'set_interaction_mode') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitInteractionModeCommand(command, evidence),
      );
    }
    if (command.type === 'compact_session') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      if (coordinator.isTurnActive()) return terminal(this.#rejected(command, 'runtime_busy'));
      const plan = this.#contextCompactionService.inspectHostCompactionCommand({
        threadId: this.#input.sessionId,
        commandId: command.commandId,
        mode: command.mode,
        ...(command.instructions === undefined ? {} : { customInstructions: command.instructions }),
      });
      return this.#compactionDecision(command, coordinator, plan);
    }
    if (command.type === 'rewind_session') {
      if (this.#hasLiveBackgroundExecutions()) {
        return terminal(this.#rejected(command, 'runtime_busy'));
      }
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator?.commitRewindCommand || !coordinator.persistRewindTerminal) {
        return terminal(this.#rejected(command, 'session_unavailable'));
      }
      if (coordinator.isTurnActive()) return terminal(this.#rejected(command, 'runtime_busy'));
      const storage = coordinator.getStateRuntimeStorage();
      const rewind = new RewindService({
        storage,
        resolveRecoveryIdentity: this.#resolveRecoveryIdentity,
        allocateRecoveryIdentity: () => randomBytes(32).toString('hex'),
      });
      if (!rewind.isCheckpointAvailable(command.sessionId, command.checkpointId)) {
        return terminal(this.#rejected(command, 'checkpoint_unavailable'));
      }
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitRewindCommand!(command, evidence);
            const receipt = receiptFromStored(committed.receipt);
            let publishResult: ((notification: RuntimeNotification) => void) | undefined;
            return {
              receipt,
              activation: async (publish) => {
                publishResult = publish;
                this.#revision = receipt.revision;
                this.#publishCommittedEvents(
                  committed.events,
                  receipt.revision,
                  publish,
                  'session',
                );
              },
              preparedExecution: {
                execution: {
                  sessionId: this.#input.sessionId,
                  operationId: command.commandId,
                  committedRevision: receipt.revision,
                  operation: 'rewind',
                  run: async () => {
                    if (!publishResult) throw new Error('Runtime rewind publisher is unavailable.');
                    const intent = assertPrecommittedRewind(
                      coordinator.getState(),
                      committed.descriptor,
                    );
                    const settled = await rewind.executeCommittedIntent({
                      intent,
                      workspace: this.#input.workspace,
                      persistTerminal: (event) => {
                        const applied = coordinator.persistRewindTerminal!(event);
                        if (applied.length !== 1) {
                          throw new Error('Runtime rewind terminal event was not persisted.');
                        }
                      },
                    });
                    this.#revision = coordinator.getState().revision;
                    publishResult!({
                      schema: RUNTIME_NOTIFICATION_SCHEMA_,
                      durability: 'durable',
                      sessionId: this.#input.sessionId,
                      revision: this.#revision,
                      projection: {
                        kind: 'session',
                        session: this.#projection(),
                        event: projectRewindTerminal(settled),
                      },
                    });
                  },
                },
              },
            };
          },
        },
      };
    }
    if (command.type === 'close_session') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#closeDecision(command, (evidence) =>
        coordinator.commitCloseSessionCommand(command, evidence),
      );
    }
    if (command.type === 'clear_session_command_grants') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#clearSessionCommandGrantsDecision(command, coordinator);
    }
    return terminal(this.#rejected(command, 'unsupported'));
  }

  #snapshotDecision(
    afterCommit: (coordinator: RuntimeSessionCoordinator) => {
      readonly activate: () => void;
      readonly releaseOnFailure?: boolean;
    },
    sessionModelRoute?: { readonly provider: string; readonly name: string },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const existing = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
          const coordinator = existing ?? this.#ensureCoordinator();
          const committed = afterCommit(coordinator);
          try {
            const receipt = receiptFromStored(
              coordinator.session.commitCommandSnapshot(evidence, sessionModelRoute),
            );
            return { receipt, activation: async () => committed.activate() };
          } catch (error) {
            if (!existing && committed.releaseOnFailure) {
              await this.#runtimeSessionCoordinator.release(this.#input.sessionId);
            }
            throw error;
          }
        },
      },
    };
  }

  #controlDecision(
    command: Extract<RuntimeCommand, { type: 'cancel_turn' | 'set_interaction_mode' }>,
    commit: (evidence: RuntimeCommandCommitEvidence) => {
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly events: readonly RuntimeEvent[];
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const committed = commit(evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              this.#revision = receipt.revision;
              if (command.type === 'cancel_turn') {
                this.#rejectPendingInteraction(new Error('Runtime interaction cancelled.'));
              }
              this.#publishCommittedEvents(
                committed.events,
                receipt.revision,
                publish,
                'turn',
                command.type === 'cancel_turn'
                  ? { runId: command.runId, turnId: command.turnId }
                  : {},
              );
              if (command.type === 'cancel_turn') this.#input.onCommittedCancel?.();
            },
          };
        },
      },
    };
  }

  #clearSessionCommandGrantsDecision(
    command: Extract<RuntimeCommand, { type: 'clear_session_command_grants' }>,
    coordinator: RuntimeSessionCoordinator,
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const committed = coordinator.commitClearSessionCommandGrantsCommand(command, evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              this.#revision = receipt.revision;
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'session');
            },
          };
        },
      },
    };
  }

  #compactionDecision(
    command: Extract<RuntimeCommand, { type: 'compact_session' }>,
    coordinator: RuntimeSessionCoordinator,
    plan: HostCompactionPlan,
  ): RuntimeHostCommandInspection {
    if (plan.rejectionCode) {
      return { kind: 'terminal', receipt: this.#rejected(command, plan.rejectionCode) };
    }
    if (plan.events.length > 0 && !coordinator.commitCompactionCommandEvents) {
      return { kind: 'terminal', receipt: this.#rejected(command, 'session_unavailable') };
    }
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          let publishResult: ((notification: RuntimeNotification) => void) | undefined;
          const committed =
            plan.events.length > 0
              ? coordinator.commitCompactionCommandEvents!(plan.events, evidence)
              : { receipt: coordinator.session.commitCommandSnapshot(evidence), events: [] };
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              publishResult = publish;
              this.#revision = receipt.revision;
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'session');
            },
            ...(plan.shouldSchedule && plan.compactionId
              ? {
                  preparedExecution: {
                    execution: {
                      sessionId: this.#input.sessionId,
                      operationId: command.commandId,
                      committedRevision: receipt.revision,
                      operation: 'compaction' as const,
                      run: async (signal: AbortSignal) => {
                        if (!publishResult) {
                          throw new Error('Runtime compaction publisher is unavailable.');
                        }
                        const events =
                          await this.#contextCompactionService.executeCommittedHostCompaction(
                            this.#input.sessionId,
                            plan,
                            signal,
                          );
                        if (events.length === 0) return;
                        this.#revision = coordinator.getState().revision;
                        this.#publishCommittedEvents(
                          events,
                          this.#revision,
                          publishResult,
                          'session',
                        );
                      },
                    },
                  },
                }
              : {}),
          };
        },
      },
    };
  }

  #closeDecision(
    _command: Extract<RuntimeCommand, { type: 'close_session' }>,
    commit: (evidence: RuntimeCommandCommitEvidence) => {
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly events: readonly RuntimeEvent[];
      readonly wasActive: boolean;
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const committed = commit(evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              this.#revision = receipt.revision;
              this.#closed = true;
              this.#rejectPendingInteraction(new Error('Runtime session closed.'));
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'session');
              await this.shutdownSession(this.#input.sessionId, 'Runtime session closed.', publish);
            },
          };
        },
      },
    };
  }

  #preparedStart(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    descriptor: PrecommittedStartTurnDescriptor,
    receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
    commandContext?: Readonly<RuntimeCommandContext>,
    config: AgentConfig = this.#desiredConfig,
  ): RuntimeHostPreparedExecution {
    return {
      execution: {
        sessionId: this.#input.sessionId,
        operationId: command.commandId,
        committedRevision: receipt.revision,
        operation: 'turn',
        run: (signal, requestAbort) =>
          this.#runTurn(
            {
              operationId: command.commandId,
              task: command.input,
              userGoal: command.input,
              precommittedStart: descriptor,
              config,
              ...(commandContext === undefined ? {} : { commandContext }),
            },
            this.#ensureCoordinator(),
            signal,
            requestAbort,
          ),
      },
    };
  }

  #preparedInteractionResume(
    operationId: string,
    coordinator: RuntimeSessionCoordinator,
    receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
    commandContext?: Readonly<RuntimeCommandContext>,
  ): RuntimeHostPreparedExecution {
    const state = coordinator.getState();
    const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
    if (!task || state.turn.status !== 'active') {
      throw new Error('Recovered Runtime interaction has no active durable turn to resume.');
    }
    const config = this.#activeRunConfig ?? this.#desiredConfig;
    this.#activeRunConfig = config;
    return {
      execution: {
        sessionId: this.#input.sessionId,
        operationId,
        committedRevision: receipt.revision,
        operation: 'turn',
        run: async (signal, requestAbort) => {
          if (this.#input.childSessionAcceptance)
            await this.#waitForAcceptedIndependentChild(coordinator, signal);
          return this.#runTurn(
            {
              operationId,
              task: task.userGoal,
              userGoal: task.userGoal,
              resumeCommittedInteraction: true,
              config,
              ...(commandContext === undefined ? {} : { commandContext }),
            },
            coordinator,
            signal,
            requestAbort,
          );
        },
      },
    };
  }

  async #waitForAcceptedIndependentChild(
    coordinator: RuntimeSessionCoordinator,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('Parent resume was cancelled.');
      const state = coordinator.getState();
      const required = new Set(requiredBackgroundTaskIds(state));
      const pending = Object.values(state.capabilities.invocations).some((invocation) => {
        const lifecycle = invocation.subagentProviderLifecycle;
        return (
          lifecycle?.childSession !== undefined &&
          lifecycle.childSession.terminalImport === undefined &&
          required.has(lifecycle.childInvocationId)
        );
      });
      if (!pending || state.turn.status !== 'active') return;
      if (!coordinator.session.waitForRevisionChange)
        throw new Error('Independent child parent revision wait is unavailable.');
      await coordinator.session.waitForRevisionChange(state.revision, signal);
    }
  }

  #publishCommittedEvents(
    events: readonly RuntimeEvent[],
    finalRevision: number,
    publish: (notification: RuntimeNotification) => void,
    kind: 'session' | 'turn',
    identity: Readonly<{ runId?: string; taskId?: string; turnId?: string }> = {},
  ): void {
    this.#flushActivePresentation();
    const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
    if (!coordinator) throw new Error('Runtime committed event coordinator is unavailable.');
    const firstRevision = finalRevision - events.length + 1;
    for (const [index, event] of events.entries()) {
      const revision = firstRevision + index;
      if (
        coordinator.revisionForEvent?.(event) !== revision ||
        coordinator.stateForEvent?.(event)?.revision !== revision
      )
        throw new Error('Runtime committed event State projection is unavailable.');
    }
    // Generator delivery and command activation may interleave. Both consume
    // this one commit-ordered queue; a later generator yield is already delivered.
    const directEvents = new Set(events);
    for (const event of coordinator.takeCommittedEventsThrough(finalRevision)) {
      const eventState = coordinator.stateForEvent?.(event);
      const revision = coordinator.revisionForEvent?.(event);
      if (revision === undefined || !eventState || eventState.revision !== revision)
        throw new Error('Runtime committed event State projection is unavailable.');
      const session = this.#projection(revision, eventState);
      let projectedEvent = projectRuntimeClientEvent(event, { sessionRevision: revision });
      if (event.type === 'provider.action_started') {
        const interaction = session.interactionQueue.interactions.find(
          (item) => item.interactionId === event.interactionId,
        );
        if (interaction) projectedEvent = { type: 'interaction.available', interaction };
      }
      if (projectedEvent?.type === 'run.terminal' && session.currentRun)
        projectedEvent = { ...projectedEvent, runId: session.currentRun.runId };
      // Events already pending before this direct batch retain the Run/Turn
      // projected by their exact post-event State. This matters when a late
      // background completion is drained by the successor start activation.
      const directIdentity = directEvents.has(event) ? identity : {};
      const runId = directIdentity.runId ?? session.currentRun?.runId;
      const taskId =
        directIdentity.taskId ?? session.activeTask?.taskId ?? session.currentRun?.taskId;
      const turnId = directIdentity.turnId ?? session.currentRun?.activeTurnId;
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision,
        ...(runId === undefined ? {} : { runId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(turnId === undefined ? {} : { turnId }),
        projection: {
          kind,
          session,
          ...(projectedEvent === undefined ? {} : { event: projectedEvent }),
        },
      });
    }
    this.#revision = Math.max(this.#revision, finalRevision);
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId || !this.#created) return;
    this.#rejectPendingInteraction(new Error(reason));
    if (!this.#closed) this.#persistCancellation(reason, publish);
    this.#closed = true;
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    const disposeSubagents =
      'backgroundSubagentRuntime' in modelRuntime
        ? (
            modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined
          )?.disposeOwner?.(
            backgroundSubagentOwnerKey(
              this.#input.sessionId,
              this.#resolveRecoveryIdentity(this.#input.sessionId),
            ),
            reason,
          )
        : undefined;
    const independent = this.#input.childSessionAcceptance?.backgroundSnapshot?.().executions ?? [];
    const childTaskControl = this.#input.childSessionAcceptance?.taskControl;
    if (independent.some((execution) => !execution.cleanupConfirmed) && !childTaskControl)
      throw new Error('Independent child Session cleanup port is unavailable.');
    const disposeIndependent = Promise.all(
      independent
        .filter((execution) => !execution.cleanupConfirmed)
        .map((execution) =>
          childTaskControl!.cancelTask(execution.executionId, {
            waitMs: 2_000,
            abortCause: 'error',
          }),
        ),
    ).then((results) => {
      if (
        results.some(
          (result) =>
            result.status === 'running' ||
            result.status === 'unknown' ||
            result.status === 'not_found' ||
            result.cleanup_confirmed !== true,
        )
      ) {
        throw new Error('Independent child Session cleanup is unconfirmed.');
      }
    });
    await Promise.all([
      managedShellRuntime.disposeOwner(
        managedShellOwnerKey(this.#input.sessionId, this.#input.workspace),
        reason,
      ),
      disposeSubagents,
      disposeIndependent,
    ]);
    const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
    if (coordinator) this.#driveBackgroundStopIntents(coordinator);
  }

  async close(): Promise<void> {
    if (this.#ownsInteractionBroker) this.#interactionBroker.close();
    await managedShellRuntime.disposeOwner(
      managedShellOwnerKey(this.#input.sessionId, this.#input.workspace),
    );
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    if ('backgroundSubagentRuntime' in modelRuntime)
      await (
        modelRuntime.backgroundSubagentRuntime as BackgroundSubagentControlRuntime | undefined
      )?.disposeOwner?.(
        backgroundSubagentOwnerKey(
          this.#input.sessionId,
          this.#resolveRecoveryIdentity(this.#input.sessionId),
        ),
      );
    await this.#runtimeSessionCoordinator.close();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    let projection: RuntimeSessionProjection;
    try {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      const currentState = coordinator?.getState();
      projection =
        currentState === undefined
          ? (this.#input.storedProjection?.() ?? this.#projection())
          : this.#projection(currentState.revision, currentState);
    } catch {
      return Promise.resolve({
        status: 'unavailable',
        queryType: query.type,
        code: 'session_unavailable',
      });
    }
    if (query.type === 'list_sessions') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        sessions: this.#created ? [projection] : [],
      });
    }
    if ('sessionId' in query && query.sessionId !== this.#input.sessionId) {
      return Promise.resolve({
        status: 'not_found',
        queryType: query.type,
        code: 'session_not_found',
      });
    }
    if (query.type === 'get_session_projection') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: projection.revision,
        session: projection,
      });
    }
    if (query.type === 'get_context_status') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: projection.revision,
        context: {
          sessionId: this.#input.sessionId,
          revision: projection.revision,
          compactionAvailable: coordinator?.isTurnActive() !== true && !this.#closed,
        },
      });
    }
    if (query.type === 'list_background_executions' || query.type === 'get_background_execution') {
      const snapshot = readBackgroundExecutionSnapshot({
        sessionId: this.#input.sessionId,
        sessionRevision: projection.revision,
        workspace: this.#input.workspace,
        modelInvocationRuntimeFactory: this.#modelInvocationRuntimeFactory,
        recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
        independentChildSnapshot: this.#input.childSessionAcceptance?.backgroundSnapshot?.(),
      });
      const executions = snapshot.executions;
      if (query.type === 'list_background_executions') {
        return Promise.resolve({
          status: 'ok',
          queryType: query.type,
          backgroundSnapshot: snapshot,
        });
      }
      const execution = executions.find((item) => item.executionId === query.executionId);
      return Promise.resolve(
        execution
          ? { status: 'ok', queryType: query.type, backgroundExecution: execution }
          : { status: 'not_found', queryType: query.type, code: 'run_not_found' },
      );
    }
    if (query.type === 'list_checkpoints') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) {
        return Promise.resolve({
          status: 'not_found',
          queryType: query.type,
          code: 'session_not_found',
        });
      }
      const storage = coordinator.getStateRuntimeStorage();
      const rewind = new RewindService({
        storage,
        resolveRecoveryIdentity: this.#resolveRecoveryIdentity,
        allocateRecoveryIdentity: () => randomBytes(32).toString('hex'),
      });
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#revision,
        checkpoints: rewind.listCheckpoints(query.sessionId).map((checkpoint) => {
          const snapshot = storage.checkpoints.loadNamedSnapshot(
            query.sessionId,
            checkpoint.snapshotId,
          );
          return {
            checkpointId: checkpoint.snapshotId,
            sessionId: query.sessionId,
            revision: snapshot?.revision ?? 0,
            eventPosition: checkpoint.eventPosition,
            createdAt: checkpoint.createdAt,
            ...(checkpoint.targetMessage === undefined
              ? {}
              : { targetMessage: checkpoint.targetMessage.slice(0, 8_192) }),
            ...(checkpoint.targetMessageCreatedAt === undefined
              ? {}
              : { targetMessageCreatedAt: checkpoint.targetMessageCreatedAt }),
            affectedFileCount: checkpoint.affectedFileCount ?? 0,
          };
        }),
      });
    }
    if (query.type === 'get_rewind_preview') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) {
        return Promise.resolve({
          status: 'not_found',
          queryType: query.type,
          code: 'session_not_found',
        });
      }
      const rewind = new RewindService({
        storage: coordinator.getStateRuntimeStorage(),
        resolveRecoveryIdentity: this.#resolveRecoveryIdentity,
        allocateRecoveryIdentity: () => randomBytes(32).toString('hex'),
      });
      const preview = rewind.preview(query.sessionId, query.checkpointId, this.#input.workspace);
      return Promise.resolve(
        preview
          ? {
              status: 'ok',
              queryType: query.type,
              revision: this.#revision,
              rewindPreview: {
                checkpointId: query.checkpointId,
                sessionId: query.sessionId,
                revision: this.#revision,
                files: preview.files.slice(0, 10_000),
                lineStatsAvailable: preview.lineStatsAvailable,
                addedLines: preview.addedLines,
                removedLines: preview.removedLines,
                conflictCount: preview.conflictCount,
                failureCount: preview.failureCount,
              },
            }
          : {
              status: 'not_found',
              queryType: query.type,
              code: 'checkpoint_unavailable',
            },
      );
    }
    throw new Error('Runtime query is outside the closed V1 vocabulary.');
  }

  async #runTurn(
    execution: CliRuntimeTurnExecutionInput,
    coordinator: RuntimeSessionCoordinator,
    signal: AbortSignal,
    requestAbort: (reason: RuntimeAbortReason | string) => void,
  ): Promise<void> {
    const publish = this.#activePublish;
    let publishedRevision = this.#revision;
    let sequence = 0;
    const presentation = new RuntimePresentationFrame();
    this.#activePresentationFrame = presentation;
    try {
      coordinator.updateSandboxAvailable(appSandboxBackendAvailable(this.#input.sandboxBackend));
      if (!publish) throw new Error('Runtime CLI command activation is unavailable.');
      const executionState = coordinator.getState();
      const lifecycle = coordinator.session.getLifecycleProjection();
      const presentationRunId = lifecycle.currentRun?.runId ?? execution.precommittedStart?.turnId;
      if (!presentationRunId) {
        throw new Error('Runtime turn execution has no accepted Run identity.');
      }
      const presentationTaskId =
        lifecycle.activeTask?.taskId ??
        lifecycle.currentRun?.taskId ??
        execution.precommittedStart?.taskId;
      const presentationWorkId = presentationTaskId ?? presentationRunId;
      const presentationTurnId =
        lifecycle.currentRun?.activeTurnId ??
        executionState.turn.turnId ??
        execution.precommittedStart?.turnId;
      if (!presentationTurnId) {
        throw new Error('Runtime turn execution has no accepted Turn identity.');
      }
      const recoveryIdentityKey = this.#resolveRecoveryIdentity(this.#input.sessionId);
      const backgroundModelInvocationPersistence = this.#backgroundModelInvocationPersistence(
        coordinator,
        recoveryIdentityKey,
      );
      const publishPresentation = (event: RuntimeEvent): void => {
        const notification = projectRuntimeEphemeralNotification(event, {
          sessionId: this.#input.sessionId,
          workId: presentationWorkId,
          runId: presentationRunId,
          ...(presentationTaskId === undefined ? {} : { taskId: presentationTaskId }),
          turnId: presentationTurnId,
          actorId: 'runtime-agent',
          attemptId: execution.operationId,
          streamId: execution.operationId,
          sequence: sequence + 1,
        });
        if (!notification) {
          throw new Error('Runtime presentation frame emitted a non-ephemeral event.');
        }
        sequence += 1;
        publish(notification);
      };
      const generator = coordinator.executeTurn(
        {
          task: execution.task,
          userGoal: execution.userGoal,
          userId: this.#input.userId,
          threadId: this.#input.sessionId,
          workspace: this.#input.workspace,
          recoveryIdentityKey,
          capabilityExecution: this.#capabilityExecution,
          modelInvocationRuntime: this.#modelInvocationRuntimeFactory(this.#input.workspace),
          config: execution.config,
          model: createChatModel(execution.config),
          shellExecutor: this.#input.shellExecutor,
          mcpManager: this.#input.mcpManager,
          interactionMode: this.#input.interactionMode,
          sandboxBackend: this.#input.sandboxBackend,
          frontend: 'cli',
          signal,
          ...(execution.commandContext === undefined
            ? {}
            : { commandContext: execution.commandContext }),
          ...(this.#input.workspaceEffectCompositionFactory === undefined
            ? {}
            : {
                workspaceEffectCompositionFactory: this.#input.workspaceEffectCompositionFactory,
              }),
          abortExecution: requestAbort,
          sessionLoggingPolicy: execution.config.sessionLoggingPolicy,
          sessionLoggingContentInspector: createModelSecretDetector({
            knownSecrets: [execution.config.apiKey],
          }),
          onSessionLoggingStatus: this.#input.onSessionLoggingStatus,
          onSessionLoggingDiagnostic: this.#input.onSessionLoggingDiagnostic,
          skillOptions: this.#input.skillOptions,
          skills: this.#input.skillManifests ? [...this.#input.skillManifests] : [],
          initialSkillActivations: [],
          ...(execution.precommittedStart === undefined
            ? {}
            : { precommittedStart: execution.precommittedStart }),
          ...(execution.resumeCommittedInteraction === true
            ? { resumeCommittedInteraction: true }
            : {}),
          ...(backgroundModelInvocationPersistence === undefined
            ? {}
            : { backgroundModelInvocationPersistence }),
          ...(this.#input.childSessionAcceptance === undefined
            ? {}
            : { childSessionAcceptance: this.#input.childSessionAcceptance }),
          ...(this.#input.crossSessionQueueMail === undefined
            ? {}
            : { crossSessionQueueMail: this.#input.crossSessionQueueMail }),
          ...(this.#input.followupPolicyForPreparedTool === undefined
            ? {}
            : {
                followupPolicyForPreparedTool: (
                  input: Parameters<
                    NonNullable<RuntimeTurnInput['followupPolicyForPreparedTool']>
                  >[0],
                ) => this.#input.followupPolicyForPreparedTool!(input, execution.config),
              }),
        },
        this.#createClientActionProvider(publish),
      );
      for await (const event of generator) {
        if (presentation.push(event, publishPresentation)) continue;
        presentation.flush();
        const eventRevision = coordinator.revisionForEvent?.(event);
        const eventState = coordinator.stateForEvent?.(event);
        if (eventRevision === undefined || !eventState || eventState.revision !== eventRevision) {
          // A detached background commit can advance and drain the canonical
          // commit queue before the parent generator resumes with its local
          // event object. Publication follows that queue, not generator object
          // identity; flush everything committed through the current State.
          this.#publishCommittedEvents([], coordinator.getState().revision, publish, 'turn');
          publishedRevision = Math.max(publishedRevision, this.#revision);
          continue;
        }
        this.#publishCommittedEvents([event], eventRevision, publish, 'turn', {
          runId: presentationRunId,
          ...(presentationTaskId === undefined ? {} : { taskId: presentationTaskId }),
          turnId: presentationTurnId,
        });
        publishedRevision = Math.max(publishedRevision, this.#revision);
      }
    } catch (error) {
      this.#closeUncertainActiveTurn(coordinator, error, signal);
    } finally {
      try {
        presentation.flush();
      } catch (error) {
        this.#closeUncertainActiveTurn(coordinator, error, signal);
      }
      if (this.#activePresentationFrame === presentation) {
        this.#activePresentationFrame = undefined;
      }
      this.#activePublish = undefined;
      const terminalState = coordinator.getState();
      this.#revision = terminalState.revision;
      if (publish && this.#revision >= publishedRevision) {
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: { kind: 'work', session: this.#projection() },
        });
      }
      if (terminalState.turn.status !== 'active') this.#activeRunConfig = undefined;
    }
  }

  #backgroundModelInvocationPersistence(
    coordinator: RuntimeSessionCoordinator,
    recoveryIdentityKey: string,
  ): NonNullable<RuntimeTurnInput['backgroundModelInvocationPersistence']> | undefined {
    const enqueueSessionWork = this.#input.enqueueSessionWork;
    if (!enqueueSessionWork) return undefined;
    const sessionId = this.#input.sessionId;
    const currentState = (): Readonly<RuntimeState> | undefined => {
      if (
        this.#closed ||
        this.#runtimeSessionCoordinator.get(sessionId) !== coordinator ||
        coordinator.lifecycle === 'closing' ||
        coordinator.lifecycle === 'closed'
      ) {
        return undefined;
      }
      try {
        const state = coordinator.getState();
        return state.toolRecovery.identityKey === recoveryIdentityKey ? state : undefined;
      } catch {
        return undefined;
      }
    };
    return Object.freeze({
      ownerKey: backgroundSubagentOwnerKey(sessionId, recoveryIdentityKey),
      recoveryIdentityKey,
      getState: () => {
        const state = currentState();
        if (!state) {
          throw new Error('Background model persistence authority is no longer current.');
        }
        return state;
      },
      persistEvents: async (events: RuntimeEvent[]) => {
        if (events.length === 0) return true;
        try {
          return await enqueueSessionWork(sessionId, () => {
            if (!currentState()) return false;
            try {
              coordinator.control.processEventBatch(events);
              this.#revision = coordinator.getState().revision;
              return true;
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      },
    });
  }

  #failActivation(
    coordinator: RuntimeSessionCoordinator,
    publish: (notification: RuntimeNotification) => void,
    error: unknown,
  ): never {
    // Commit is durable, but Host does not dispatch after failed activation.
    try {
      this.#closeUncertainActiveTurn(coordinator, error);
      this.#revision = coordinator.getState().revision;
      try {
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: { kind: 'work', session: this.#projection() },
        });
      } catch {
        // A failed publisher must not replace the original activation error.
        // The persisted terminal remains available to query and History.
      }
    } finally {
      this.#activePublish = undefined;
      this.#activeRunConfig = undefined;
    }
    throw error;
  }

  #closeUncertainActiveTurn(
    coordinator: RuntimeSessionCoordinator,
    error: unknown,
    signal?: AbortSignal,
  ): void {
    const state = coordinator.getState();
    if (state.turn.status !== 'active') return;
    coordinator.control.processEventBatch([
      {
        type: 'run.error',
        message: error instanceof Error ? error.message : String(error),
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
      {
        type: 'turn.aborted',
        turnId: state.turn.turnId,
        reason: 'Runtime presentation or bridge closure could not be confirmed.',
        cause: signal?.aborted ? runtimeAbortCause(signal.reason) : 'error',
      },
    ]);
  }

  #startSkillPlanningContext(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    config = this.#desiredConfig,
  ): StartTurnSkillPlanningContext | undefined {
    if (!command.initialSkills || command.initialSkills.length === 0) return undefined;
    const flags = getFeatureFlags(config);
    // CLI deliberately has no MCP manager. MCP-backed catalog entries are
    // therefore rejected by the shared planner instead of acquiring I/O in
    // Host's pure inspection/commit phase.
    return {
      skillOptions: this.#input.skillOptions,
      flags: {
        skillActivation: flags.skillActivation,
        skillWorkflow: flags.skillWorkflow,
      },
    };
  }

  #ensureCoordinator(): RuntimeSessionCoordinator {
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    return this.#runtimeSessionCoordinator.ensure({
      sessionId: this.#input.sessionId,
      userId: this.#input.userId,
      workspace: this.#input.workspace,
      projectId: this.#input.projectIdentity.projectId,
      canonicalWorkspaceDigest: this.#input.projectIdentity.workspaceDigest,
      interactionMode: this.#input.interactionMode,
      recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
      sandboxAvailable: appSandboxBackendAvailable(this.#input.sandboxBackend),
      modelArtifactEvidence: modelRuntime.evidence,
      capabilityArtifactEvidence:
        'capabilityArtifacts' in modelRuntime ? modelRuntime.capabilityArtifacts : undefined,
      preserveReservedChildDelegations:
        this.#input.childSessionAcceptance?.pendingDelegationReservations?.(),
      preservePendingAfterTurnDelegations:
        this.#input.childSessionAcceptance?.pendingAfterTurnDelegations?.(),
      preserveLiveAfterTurnDelegations:
        this.#input.childSessionAcceptance?.liveAfterTurnDelegations?.(),
      preserveSealedAfterTurnReports:
        this.#input.childSessionAcceptance?.sealedAfterTurnReports?.(),
      preservePendingFollowupFunding: this.#input.pendingFollowupFunding?.(),
      preservePreparedFollowupModels: this.#input.preparedFollowupRecoveryProofs?.(),
      preservePreparedCurrentTurnModels: this.#input.preparedCurrentTurnRecoveryProofs?.(),
      preserveDispatchedChildDelegations: this.#input.dispatchedChildRecoveryProofs?.(),
    });
  }

  /** Narrow adapter consumed by ContextCompactionService's Host-only methods. */
  #compactionRuntime() {
    const bridge = this;
    return {
      config: this.#activeRunConfig ?? this.#desiredConfig,
      workspace: this.#input.workspace,
      threadId: this.#input.sessionId,
      skillManifests: [...(this.#input.skillManifests ?? [])],
      skillOptions: this.#input.skillOptions,
      mcpManager: this.#input.mcpManager ?? null,
      authorizedExecutionControl:
        this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.control ?? null,
      get manualCompactionInFlightId() {
        return bridge.#manualCompactionInFlightId;
      },
      set manualCompactionInFlightId(value: string | null) {
        bridge.#manualCompactionInFlightId = value;
      },
      runManualCompactionExclusive: async <T>(
        operation: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> => operation(new AbortController().signal),
      waitForRunCompletion: async (): Promise<void> => undefined,
    };
  }

  #createClientActionProvider(
    publish: (notification: RuntimeNotification) => void,
  ): RuntimeActionProvider {
    return Object.freeze({
      requestAction: (
        effect: RuntimeEffect,
        state: RuntimeState,
        commandCommit: RuntimeInteractionCommandCommitPort,
      ): Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor> => {
        if (!isRuntimeInteractionEffect(effect) || this.#pendingInteraction) {
          return Promise.reject(new Error('Runtime interaction request is unavailable.'));
        }
        const interaction = projectRuntimeClientInteraction(state, effect, {
          sessionRevision: state.revision,
        });
        if (!interaction) {
          return Promise.reject(new Error('Runtime interaction identity is invalid.'));
        }
        const brokerIdentity = interactionBrokerIdentity(this.#input.sessionId, interaction);
        const waiter = this.#interactionBroker.publish(brokerIdentity);
        for (const clientId of this.#interactionClientIds(this.#input.sessionId)) {
          waiter.attach(clientId);
        }
        this.#pendingInteraction = { effect, interaction, commandCommit, brokerIdentity };
        this.#publishCommittedEvents([], state.revision, publish, 'turn');
        return waiter.wait();
      },
    });
  }

  #rejectPendingInteraction(error: unknown): void {
    const pending = this.#pendingInteraction;
    if (!pending) return;
    this.#pendingInteraction = undefined;
    this.#interactionBroker.reject(pending.brokerIdentity, error);
  }

  #persistCancellation(
    reason: string,
    publish: (notification: RuntimeNotification) => void = this.#activePublish ?? (() => undefined),
  ): void {
    this.#flushActivePresentation();
    const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
    const lifecycle = coordinator?.session.getLifecycleProjection();
    const runId = lifecycle?.currentRun?.runId;
    const taskId = lifecycle?.activeTask?.taskId ?? lifecycle?.currentRun?.taskId;
    const turnId = lifecycle?.currentRun?.activeTurnId ?? coordinator?.getState().turn.turnId;
    const events = coordinator?.control.cancelRun(reason, 'error') ?? [];
    if (events.length > 0 && coordinator) {
      this.#publishCommittedEvents(events, coordinator.getState().revision, publish, 'turn', {
        ...(runId === undefined ? {} : { runId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(turnId === undefined ? {} : { turnId }),
      });
    }
  }

  #flushActivePresentation(): void {
    this.#activePresentationFrame?.flush();
  }

  #projection(
    revision = this.#revision,
    exactState?: Readonly<RuntimeState>,
  ): RuntimeSessionProjection {
    const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
    const state = exactState ?? coordinator?.getState();
    if (!state || state.revision !== revision) {
      throw new Error(
        'Runtime interaction State is unavailable for the exact projection revision.',
      );
    }
    const rootInteractions = projectRuntimeClientInteractionQueue(state, {
      sessionRevision: revision,
    });
    const childApprovals = this.#input.childSessionAcceptance?.approvalProxy?.list(state) ?? [];
    const interactionQueue: RuntimeInteractionQueueProjection =
      childApprovals.length === 0
        ? rootInteractions
        : {
            ...rootInteractions,
            interactions: [...rootInteractions.interactions, ...childApprovals],
            activeInteractionId:
              rootInteractions.activeInteractionId ?? childApprovals[0]!.interactionId,
          };
    const lifecycle = coordinator?.session.getLifecycleProjection(state) ?? {};
    const currentRun = lifecycle.currentRun
      ? (() => {
          const { activeInteractionId: _internalInteractionId, ...run } = lifecycle.currentRun;
          return interactionQueue.activeInteractionId === undefined
            ? run
            : { ...run, activeInteractionId: interactionQueue.activeInteractionId };
        })()
      : undefined;
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId: this.#input.sessionId,
      revision,
      workspace: this.#input.workspace,
      ...(state.session.canonicalWorkspaceDigest === undefined
        ? {}
        : { workspaceDigest: state.session.canonicalWorkspaceDigest }),
      lifecycle: this.#closed ? 'closed' : 'open',
      model: {
        provider: (this.#activeRunConfig ?? this.#desiredConfig).providerName,
        name: (this.#activeRunConfig ?? this.#desiredConfig).modelName,
      },
      interactionQueue,
      ...(lifecycle.activeTask === undefined ? {} : { activeTask: lifecycle.activeTask }),
      ...(currentRun === undefined ? {} : { currentRun }),
    };
  }

  #resolveModelConfig(route: { readonly provider: string; readonly name: string }): AgentConfig {
    if (this.#input.resolveModelConfig) return this.#input.resolveModelConfig(route);
    if (
      route.provider === this.#desiredConfig.providerName &&
      route.name === this.#desiredConfig.modelName
    )
      return this.#desiredConfig;
    throw new Error(`Model route '${route.provider}/${route.name}' is unavailable.`);
  }

  #rejected(
    command: RuntimeCommand,
    code: RuntimeCommandErrorCode,
  ): {
    readonly status: 'rejected';
    readonly commandId: string;
    readonly code: RuntimeCommandErrorCode;
    readonly currentRevision: number;
  } {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision: this.#revision,
    };
  }

  #notFound(command: RuntimeCommand): {
    readonly status: 'not_found';
    readonly commandId: string;
    readonly code: 'session_not_found';
  } {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }
}

function isRuntimeInteractionEffect(effect: RuntimeEffect): effect is RuntimeInteractionEffect {
  switch (effect.type) {
    case 'request_tool_approval':
    case 'request_user_input':
    case 'request_plan_review':
    case 'request_provider_action':
    case 'request_provider_admission':
    case 'request_verification_decision':
      return true;
    default:
      return false;
  }
}

function projectRewindTerminal(
  settled: RewindSettlement,
): Extract<import('@kite-ai/runtime-contract').RuntimeClientEvent, { type: 'rewind.terminal' }> {
  if (settled.status === 'failed') {
    const terminal = settled.terminal;
    return {
      type: 'rewind.terminal',
      rewindId: terminal.rewindId,
      commandId: terminal.commandId,
      sourceSessionId: terminal.sourceSessionId,
      targetSessionId: terminal.targetSessionId,
      status: 'failed',
      failureCode: terminal.failureCode,
    };
  }
  const terminal = settled.terminal;
  const fileOutcome = settled.result.fileOutcome;
  return {
    type: 'rewind.terminal',
    rewindId: terminal.rewindId,
    commandId: terminal.commandId,
    sourceSessionId: terminal.sourceSessionId,
    targetSessionId: terminal.targetSessionId,
    status: 'completed',
    ...(fileOutcome
      ? {
          fileOutcome: {
            restored: fileOutcome.restored.slice(0, 10_000),
            deleted: fileOutcome.deleted.slice(0, 10_000),
            failed: fileOutcome.failed.slice(0, 10_000).map((item) => ({
              path: item.path.slice(0, 8_192),
              error: item.error.slice(0, 8_192),
            })),
            conflicts: fileOutcome.conflicts.slice(0, 10_000).map((item) => ({
              path: item.path.slice(0, 8_192),
              reason: item.reason,
            })),
          },
        }
      : {}),
  };
}

function sameInteractionIdentity(
  expected: RuntimeClientInteraction,
  actual: RuntimeClientInteraction,
): boolean {
  return sameRuntimeClientInteractionIdentity(expected, actual);
}

function interactionBrokerIdentity(
  sessionId: string,
  interaction: RuntimeClientInteraction,
): RuntimeInteractionIdentity {
  return {
    schema: RUNTIME_INTERACTION_IDENTITY_SCHEMA_,
    sessionId,
    interactionId: interaction.interactionId,
    generation: interaction.kind === 'approval' ? interaction.generation : 0,
    revision: interaction.sessionRevision,
  };
}

function receiptFromStored(
  receipt: RuntimeStoredCommandReceipt,
): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
  return {
    status: 'applied',
    commandId: receipt.commandId,
    sessionId: receipt.targetSessionId,
    revision: receipt.committedRevision,
  };
}
