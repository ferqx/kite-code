import { randomBytes } from 'node:crypto';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import { createChatModel, createModelSecretDetector } from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { InteractionMode, SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
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
  sameRuntimeClientInteractionIdentity,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from '@kite-ai/runtime-host';
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
import { projectRuntimeEphemeralNotification } from '../presentation-notification';
import type { PrecommittedInteractionActionDescriptor } from './command-interaction-decision';
import { assertPrecommittedRewind } from './command-rewind-decision';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from './RuntimeSessionCoordinator';
import type { AppWorkspaceEffectCompositionFactory } from './runtime-effect-dependencies';
import {
  canContinueSettledGlobalAdmission,
  obsoleteGlobalAdmissionSettlementEvents,
  type RuntimeUserAction,
} from './state-actions';
import type { RuntimeActionProvider, RuntimeInteractionCommandCommitPort } from './state-runner';
import type { RuntimeEffect, RuntimeEvent, RuntimeState } from './state-runtime';
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';
import type {
  PrecommittedStartTurnDescriptor,
  StartTurnSkillPlanningContext,
} from './turn-command-decision';
import type { RuntimeTurnInput } from './turn-coordinator';

export interface CliRuntimeBridgeInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectIdentity: ProjectIdentity;
  readonly checkpointPath: string;
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

export interface ConfigurableCliRuntimeBridge extends RuntimeHostExecutionBridge {
  /** Changes the desired configuration for the next admitted Run only. */
  applySelectedConfig(config: AgentConfig): void;
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
  #activeRunConfig: AgentConfig | undefined;

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

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId) return;
    const coordinator = this.#ensureCoordinator();
    this.#created = true;
    this.#closed = false;
    const state = coordinator.getState();
    this.#revision = state.revision;
    if (!coordinator.recoveryChanged) return;
    publish({
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: this.#revision,
      projection: { kind: 'session', session: this.#projection() },
    });
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
    if (!coordinator || coordinator.isTurnActive() || coordinator.lifecycle !== 'idle') return;
    const state = coordinator.getState();
    const run = coordinator.session.getLifecycleProjection().currentRun;
    if (
      state.revision !== committedRevision ||
      run?.status !== 'running' ||
      run.activeTurnId !== state.turn.turnId ||
      run.taskId !== state.activeTaskId ||
      !canContinueSettledGlobalAdmission(
        state,
        coordinator.getStateRuntimeStorage().sessions.loadEventsStrict(command.sessionId),
      )
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
    if (command.type === 'respond_interaction') {
      const pending = this.#pendingInteraction;
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) {
        return terminal(this.#rejected(command, 'interaction_mismatch'));
      }
      const state = coordinator.getState();
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
      if (coordinator && !coordinator.isTurnActive() && coordinator.lifecycle === 'idle') {
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
          const settledBeforeDispatch =
            run.status === 'running' && canContinueSettledGlobalAdmission(state, journal);
          if (events.length > 0 || settledBeforeDispatch) {
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
    if (command.type === 'cancel_turn') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      if (!coordinator.isTurnActive()) return terminal(this.#rejected(command, 'turn_not_found'));
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
        run: (signal, requestAbort) =>
          this.#runTurn(
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
          ),
      },
    };
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
      const runId = identity.runId ?? session.currentRun?.runId;
      const taskId = identity.taskId ?? session.activeTask?.taskId ?? session.currentRun?.taskId;
      const turnId = identity.turnId ?? session.currentRun?.activeTurnId;
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
  }

  close(): Promise<void> {
    if (this.#ownsInteractionBroker) this.#interactionBroker.close();
    return this.#runtimeSessionCoordinator.close();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    let projection: RuntimeSessionProjection;
    try {
      projection = this.#projection();
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
        revision: this.#revision,
        session: projection,
      });
    }
    if (query.type === 'get_context_status') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#revision,
        context: {
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          compactionAvailable: coordinator?.isTurnActive() !== true && !this.#closed,
        },
      });
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
    requestAbort: (reason: string) => void,
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
          recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
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
        },
        this.#createClientActionProvider(publish),
      );
      for await (const event of generator) {
        if (presentation.push(event, publishPresentation)) continue;
        presentation.flush();
        const eventRevision = coordinator.revisionForEvent?.(event);
        const eventState = coordinator.stateForEvent?.(event);
        if (eventRevision === undefined || !eventState || eventState.revision !== eventRevision) {
          throw new Error('Runtime event revision was unavailable or out of order.');
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
        cause: signal?.aborted ? 'user' : 'error',
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
    const events = coordinator?.control.cancelRun(reason) ?? [];
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
    const interactionQueue: RuntimeInteractionQueueProjection =
      projectRuntimeClientInteractionQueue(state, {
        sessionRevision: revision,
      });
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
