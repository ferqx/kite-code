import { randomBytes } from 'node:crypto';
import type { GitBroker } from '@kite-ai/builtin-runtime/git';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import { createChatModel, createModelSecretDetector } from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { InteractionMode, SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
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
  type RuntimeInteractionEffect,
} from '../../runtime-client/interaction-projector';
import { projectRuntimeEphemeralNotification } from '../presentation-notification';
import type { PrecommittedInteractionActionDescriptor } from './command-interaction-decision';
import { assertPrecommittedRewind } from './command-rewind-decision';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from './RuntimeSessionCoordinator';
import type { RuntimeUserAction } from './state-actions';
import type { RuntimeActionProvider, RuntimeInteractionCommandCommitPort } from './state-runner';
import type { RuntimeEffect, RuntimeEvent, RuntimeState } from './state-runtime';
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
  readonly shellExecutor: ShellExecutor;
  readonly gitBroker?: GitBroker;
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
}

export type CliRuntimeInteractionResolution =
  | RuntimeUserAction
  | PrecommittedInteractionActionDescriptor;

interface PendingCliInteraction {
  readonly effect: RuntimeInteractionEffect;
  readonly interaction: RuntimeClientInteraction;
  readonly stateRevision: number;
  readonly commandCommit: RuntimeInteractionCommandCommitPort;
  readonly brokerIdentity: RuntimeInteractionIdentity;
}

export function createCliRuntimeBridge(
  input: CliRuntimeBridgeInput,
  capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
  modelInvocationRuntimeFactory: (workspace: string) => RuntimeTurnInput['modelInvocationRuntime'],
  resolveRecoveryIdentity: (sessionId: string) => string,
  runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
  interactionBroker?: RuntimeInteractionBroker<CliRuntimeInteractionResolution>,
  interactionClientIds?: (sessionId: string) => readonly string[],
): RuntimeHostExecutionBridge {
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

class CliRuntimeBridge implements RuntimeHostExecutionBridge {
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
  #running = false;
  #closed = false;
  #activePublish: ((notification: RuntimeNotification) => void) | undefined;
  #activeWork: RuntimeSessionProjection['activeWork'];
  #pendingInteraction: PendingCliInteraction | undefined;

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

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId) return;
    const coordinator = this.#ensureCoordinator();
    this.#created = true;
    this.#closed = false;
    this.#revision = coordinator.getState().revision;
    if (!coordinator.recoveryChanged) return;
    publish({
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: this.#revision,
      projection: { kind: 'session', session: this.#projection() },
    });
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
      return this.#snapshotDecision((coordinator) => ({
        activate: () => {
          this.#created = true;
          this.#closed = false;
          this.#revision = coordinator.getState().revision;
        },
        releaseOnFailure: true,
      }));
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
      if (
        !pending ||
        !coordinator ||
        !sameInteractionIdentity(pending.interaction, command.interaction)
      ) {
        return terminal(this.#rejected(command, 'interaction_mismatch'));
      }
      const action = mapRuntimeInteractionResponseToUserAction({
        state: coordinator.getState(),
        effect: pending.effect,
        interaction: command.interaction,
        response: command.response,
        expectedStateRevision: pending.stateRevision,
      });
      if (!action) return terminal(this.#rejected(command, 'interaction_mismatch'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = pending.commandCommit.commit(action, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                if (this.#pendingInteraction !== pending) {
                  throw new Error(
                    'Runtime interaction activation no longer owns its pending waiter.',
                  );
                }
                this.#pendingInteraction = undefined;
                this.#revision = receipt.revision;
                this.#activeWork = clearActiveInteraction(this.#activeWork);
                this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
                const resolution = this.#interactionBroker.resolve(
                  pending.brokerIdentity,
                  committed.descriptor,
                );
                if (resolution !== 'resolved') {
                  throw new Error(`Runtime interaction broker resolution failed: ${resolution}`);
                }
              },
            };
          },
        },
      };
    }
    if (command.type === 'resume_session') {
      return this.#snapshotDecision((coordinator) => ({
        activate: () => {
          this.#revision = coordinator.getState().revision;
          this.#created = true;
          this.#closed = false;
        },
      }));
    }
    if (command.type === 'start_turn') {
      if (this.#running) return terminal(this.#rejected(command, 'runtime_busy'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitStartTurnCommand(
              command,
              evidence,
              this.#startSkillPlanningContext(command),
            );
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                this.#revision = receipt.revision;
                this.#running = true;
                this.#activePublish = publish;
                this.#activeWork = {
                  workId: command.commandId,
                  phase: committed.descriptor.phase,
                  status: 'running',
                  activeTurn: { turnId: committed.descriptor.turnId, status: 'running' },
                };
                this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
              },
              preparedExecution: this.#preparedStart(command, committed.descriptor, receipt),
            };
          },
        },
      };
    }
    if (command.type === 'cancel_turn') {
      if (!this.#running) return terminal(this.#rejected(command, 'turn_not_found'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
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
      if (this.#running) return terminal(this.#rejected(command, 'runtime_busy'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      const plan = this.#contextCompactionService.inspectHostCompactionCommand({
        threadId: this.#input.sessionId,
        commandId: command.commandId,
        mode: command.mode,
        ...(command.instructions === undefined ? {} : { customInstructions: command.instructions }),
      });
      return this.#compactionDecision(command, coordinator, plan);
    }
    if (command.type === 'rewind_session') {
      if (this.#running) return terminal(this.#rejected(command, 'runtime_busy'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator?.commitRewindCommand || !coordinator.persistRewindTerminal) {
        return terminal(this.#rejected(command, 'session_unavailable'));
      }
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
                      projection: { kind: 'session', session: this.#projection() },
                    });
                    publishResult!({
                      schema: RUNTIME_NOTIFICATION_SCHEMA_,
                      durability: 'ephemeral',
                      sessionId: this.#input.sessionId,
                      workId: this.#activeWork?.workId ?? command.commandId,
                      turnId: this.#activeWork?.activeTurn?.turnId ?? command.commandId,
                      actorId: 'runtime-rewind',
                      attemptId: command.commandId,
                      compositionRevision: 'runtime-state-store',
                      streamId: command.commandId,
                      sequence: 1,
                      event: projectRewindTerminal(settled),
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
            const receipt = receiptFromStored(coordinator.session.commitCommandSnapshot(evidence));
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
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
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
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          let publishResult: ((notification: RuntimeNotification) => void) | undefined;
          const committed =
            plan.events.length > 0
              ? coordinator.session.commitCommandBatch(plan.events, evidence)
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
              this.#running = false;
              this.#rejectPendingInteraction(new Error('Runtime session closed.'));
              this.#activeWork = terminalizeActiveWork(this.#activeWork, 'cancelled');
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
  ): RuntimeHostPreparedExecution {
    return {
      execution: {
        sessionId: this.#input.sessionId,
        operationId: command.commandId,
        committedRevision: receipt.revision,
        operation: 'turn',
        run: (signal, requestAbort) =>
          this.#runTurn(command, this.#ensureCoordinator(), descriptor, signal, requestAbort),
      },
    };
  }

  #publishCommittedEvents(
    events: readonly RuntimeEvent[],
    finalRevision: number,
    publish: (notification: RuntimeNotification) => void,
    kind: 'session' | 'turn',
  ): void {
    const firstRevision = finalRevision - events.length + 1;
    for (const [index, event] of events.entries()) {
      const revision = firstRevision + index;
      const projectedEvent = safelyProjectRuntimeEvent(event, revision);
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision,
        projection: {
          kind,
          session: { ...this.#projection(), revision },
          ...(projectedEvent === undefined ? {} : { event: projectedEvent }),
        },
      });
    }
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
    const projection = this.#projection();
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
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#revision,
        context: {
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          compactionAvailable: !this.#running && !this.#closed,
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
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    coordinator: RuntimeSessionCoordinator,
    precommittedStart: PrecommittedStartTurnDescriptor,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    coordinator.updateSandboxAvailable(appSandboxBackendAvailable(this.#input.sandboxBackend));
    const publish = this.#activePublish;
    if (!publish) throw new Error('Runtime CLI command activation is unavailable.');
    let status: NonNullable<RuntimeSessionProjection['activeWork']>['status'] = 'completed';
    let publishedRevision = this.#revision;
    try {
      const generator = coordinator.executeTurn(
        {
          task: command.input,
          userGoal: command.input,
          userId: this.#input.userId,
          threadId: this.#input.sessionId,
          workspace: this.#input.workspace,
          recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
          capabilityExecution: this.#capabilityExecution,
          modelInvocationRuntime: this.#modelInvocationRuntimeFactory(this.#input.workspace),
          config: this.#input.config,
          model: createChatModel(this.#input.config),
          shellExecutor: this.#input.shellExecutor,
          gitBroker: this.#input.gitBroker,
          mcpManager: this.#input.mcpManager,
          interactionMode: this.#input.interactionMode,
          sandboxBackend: this.#input.sandboxBackend,
          frontend: 'cli',
          signal,
          abortExecution: requestAbort,
          sessionLoggingPolicy: this.#input.config.sessionLoggingPolicy,
          sessionLoggingContentInspector: createModelSecretDetector({
            knownSecrets: [this.#input.config.apiKey],
          }),
          onSessionLoggingStatus: this.#input.onSessionLoggingStatus,
          onSessionLoggingDiagnostic: this.#input.onSessionLoggingDiagnostic,
          skillOptions: this.#input.skillOptions,
          skills: this.#input.skillManifests ? [...this.#input.skillManifests] : [],
          initialSkillActivations: [],
          precommittedStart,
        },
        this.#createClientActionProvider(publish),
      );
      let sequence = 0;
      for await (const event of generator) {
        const ephemeral = projectRuntimeEphemeralNotification(event, {
          sessionId: this.#input.sessionId,
          workId: this.#activeWork?.workId ?? command.commandId,
          turnId: this.#activeWork?.activeTurn?.turnId ?? command.commandId,
          actorId: 'runtime-agent',
          attemptId: command.commandId,
          streamId: command.commandId,
          sequence: sequence + 1,
        });
        if (ephemeral) {
          sequence += 1;
          publish(ephemeral);
          continue;
        }
        const eventRevision = coordinator.revisionForEvent?.(event);
        if (eventRevision === undefined || eventRevision <= publishedRevision) {
          throw new Error('Runtime event revision was unavailable or out of order.');
        }
        const projectedEvent = projectRuntimeClientEvent(event, {
          sessionRevision: eventRevision,
        });
        // `provider.action_started` advances State before the authoritative pending interaction
        // is projected. Publishing an event-less revision here would race the older
        // `provider.action_required` identity against the next user response. Let the action
        // provider publish the exact revision with `interaction.available` instead.
        if (event.type === 'provider.action_started' && projectedEvent === undefined) continue;
        this.#revision = eventRevision;
        publishedRevision = this.#revision;
        const interaction = interactionFromClientEvent(projectedEvent);
        if (interaction) {
          this.#activeWork = setActiveInteraction(this.#activeWork, interaction);
        }
        if (
          projectedEvent?.type === 'interaction.settled' ||
          projectedEvent?.type === 'plan.approved'
        ) {
          this.#activeWork = clearActiveInteraction(this.#activeWork);
        }
        const terminalStatus = terminalStatusFromClientEvent(projectedEvent);
        if (terminalStatus) {
          status = terminalStatus;
          this.#activeWork = terminalizeActiveWork(this.#activeWork, status);
        }
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: {
            kind: 'turn',
            session: this.#projection(),
            event: projectedEvent,
          },
        });
      }
    } catch {
      status = signal.aborted ? 'cancelled' : 'failed';
    } finally {
      this.#running = false;
      this.#activePublish = undefined;
      this.#revision = coordinator.getState().revision;
      this.#activeWork = terminalizeActiveWork(this.#activeWork, status);
      if (this.#revision >= publishedRevision) {
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: { kind: 'work', session: this.#projection() },
        });
      }
    }
  }

  #startSkillPlanningContext(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
  ): StartTurnSkillPlanningContext | undefined {
    if (!command.initialSkills || command.initialSkills.length === 0) return undefined;
    const flags = getFeatureFlags(this.#input.config);
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
      config: this.#input.config,
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
        const priorRevision = this.#revision;
        this.#revision = state.revision;
        this.#activeWork = setActiveInteraction(this.#activeWork, interaction);
        this.#pendingInteraction = {
          effect,
          interaction,
          stateRevision: state.revision,
          commandCommit,
          brokerIdentity,
        };
        if (state.revision > priorRevision) {
          publish({
            schema: RUNTIME_NOTIFICATION_SCHEMA_,
            durability: 'durable',
            sessionId: this.#input.sessionId,
            revision: state.revision,
            projection: {
              kind: 'interaction',
              session: this.#projection(),
              event: { type: 'interaction.available', interaction },
            },
          });
        }
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
    const events =
      this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.control.cancelRun(reason) ?? [];
    for (const event of events) {
      this.#revision =
        this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.getState().revision ??
        this.#revision;
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision: this.#revision,
        projection: {
          kind: 'turn',
          session: this.#projection(),
          event: projectRuntimeClientEvent(event, { sessionRevision: this.#revision }),
        },
      });
    }
  }

  #projection(): RuntimeSessionProjection {
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId: this.#input.sessionId,
      revision: this.#revision,
      workspace: this.#input.workspace,
      lifecycle: this.#closed ? 'closed' : 'open',
      model: {
        provider: this.#input.config.providerName,
        name: this.#input.config.modelName,
      },
      ...(this.#activeWork === undefined ? {} : { activeWork: this.#activeWork }),
    };
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

function setActiveInteraction(
  work: RuntimeSessionProjection['activeWork'],
  interaction: RuntimeClientInteraction,
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status: 'waiting',
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status: 'waiting', interaction }
      : undefined,
  };
}

function interactionFromClientEvent(
  event: ReturnType<typeof projectRuntimeClientEvent>,
): RuntimeClientInteraction | undefined {
  switch (event?.type) {
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      return event.interaction;
    case 'provider.action':
      return event.status === 'required' ? event.interaction : undefined;
    case 'verification.status':
      return event.status === 'pending' ? event.interaction : undefined;
    default:
      return undefined;
  }
}

function terminalStatusFromClientEvent(
  event: ReturnType<typeof projectRuntimeClientEvent>,
): 'cancelled' | 'failed' | 'completed' | undefined {
  switch (event?.type) {
    case 'task.terminal':
    case 'turn.terminal':
    case 'run.terminal':
      return event.status === 'aborted' ? 'cancelled' : event.status;
    default:
      return undefined;
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

function clearActiveInteraction(
  work: RuntimeSessionProjection['activeWork'],
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status: 'running',
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status: 'running', interaction: undefined }
      : undefined,
  };
}

function terminalizeActiveWork(
  work: RuntimeSessionProjection['activeWork'],
  status: 'cancelled' | 'failed' | 'completed',
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status,
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status, interaction: undefined }
      : undefined,
  };
}

function sameInteractionIdentity(
  expected: RuntimeClientInteraction,
  actual: RuntimeClientInteraction,
): boolean {
  if (
    expected.kind !== actual.kind ||
    expected.interactionId !== actual.interactionId ||
    expected.sessionRevision !== actual.sessionRevision
  ) {
    return false;
  }
  switch (expected.kind) {
    case 'approval':
      return (
        actual.kind === 'approval' &&
        expected.generation === actual.generation &&
        expected.grants.length === actual.grants.length &&
        expected.grants.every((grant, index) => grant === actual.grants[index])
      );
    case 'input':
      return actual.kind === 'input';
    case 'plan_review':
      return (
        actual.kind === 'plan_review' &&
        expected.plan.planId === actual.plan.planId &&
        expected.plan.version === actual.plan.version &&
        expected.plan.structuralDigest === actual.plan.structuralDigest
      );
    case 'provider_action':
      return (
        actual.kind === 'provider_action' &&
        expected.action === actual.action &&
        expected.provider.providerId === actual.provider.providerId &&
        expected.provider.directoryRevision === actual.provider.directoryRevision
      );
    case 'verification':
      return (
        actual.kind === 'verification' &&
        expected.verification.verificationId === actual.verification.verificationId &&
        expected.verification.revision === actual.verification.revision
      );
  }
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

function safelyProjectRuntimeEvent(event: RuntimeEvent, revision: number) {
  try {
    return projectRuntimeClientEvent(event, { sessionRevision: revision });
  } catch {
    return undefined;
  }
}
