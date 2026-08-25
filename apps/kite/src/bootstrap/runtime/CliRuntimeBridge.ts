import type { GitBroker } from '@kite/builtin-runtime/git';
import { createChatModel, createModelSecretDetector } from '@kite/builtin-runtime/model';
import type { ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type { InteractionMode, SkillScanOptions } from '@kite/runtime-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeNotificationEvent,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite/runtime-contract';
import type { RuntimeHostExecutionBridge, RuntimeHostPreparedExecution } from '@kite/runtime-host';
import {
  type RuntimeHostKernelInput,
  runtimeCommandFromKernelInput,
} from '@kite/runtime-host/kernel-adapter';
import type { ProjectIdentity } from '@kite/runtime-spi';
import type { AgentConfig } from '#app/config';
import { appSandboxBackendAvailable, type SandboxBackend } from '#app/sandbox/types';
import { projectRuntimeEphemeralNotification } from '../presentation-notification';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from './RuntimeSessionCoordinator';
import type { RuntimeUserAction } from './state-actions';
import type { RuntimeActionProvider } from './state-runner';
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

export function createCliRuntimeBridge(
  input: CliRuntimeBridgeInput,
  capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
  modelInvocationRuntimeFactory: (workspace: string) => RuntimeTurnInput['modelInvocationRuntime'],
  resolveRecoveryIdentity: (sessionId: string) => string,
  runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
): RuntimeHostExecutionBridge {
  return new CliRuntimeBridge(
    input,
    capabilityExecution,
    modelInvocationRuntimeFactory,
    resolveRecoveryIdentity,
    runtimeSessionCoordinator,
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
  #revision = 0;
  #created = false;
  #running = false;
  #closed = false;
  #activePublish: ((notification: RuntimeNotification) => void) | undefined;
  #activeWork: RuntimeSessionProjection['activeWork'];

  constructor(
    input: CliRuntimeBridgeInput,
    capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
    modelInvocationRuntimeFactory: (
      workspace: string,
    ) => RuntimeTurnInput['modelInvocationRuntime'],
    resolveRecoveryIdentity: (sessionId: string) => string,
    runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
  ) {
    this.#input = input;
    this.#capabilityExecution = capabilityExecution;
    this.#modelInvocationRuntimeFactory = modelInvocationRuntimeFactory;
    this.#resolveRecoveryIdentity = resolveRecoveryIdentity;
    this.#runtimeSessionCoordinator = runtimeSessionCoordinator;
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId || !this.#created) return;
    if (!this.#ensureCoordinator().recoveryChanged) return;
    this.#revision += 1;
    publish({
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: this.#revision,
      projection: { kind: 'session', session: this.#projection() },
    });
  }

  async prepare(
    input: RuntimeHostKernelInput,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<RuntimeHostPreparedExecution> {
    const command = runtimeCommandFromKernelInput(input);
    if (command.type === 'create_session') {
      if (
        this.#created ||
        command.workspace !== this.#input.workspace ||
        (command.bootstrapSessionId !== undefined &&
          command.bootstrapSessionId !== this.#input.sessionId)
      ) {
        return { receipt: this.#rejected(command, 'invalid_session') };
      }
      this.#created = true;
      return { receipt: this.#applied(command) };
    }
    if (!this.#created || this.#closed) {
      return { receipt: this.#rejected(command, 'session_unavailable') };
    }
    if ('sessionId' in command && command.sessionId !== this.#input.sessionId) {
      return { receipt: this.#notFound(command) };
    }
    if (command.type === 'resume_session') {
      // Host recovery has already run before prepare. Ensuring the coordinator
      // here binds the exact imported/current State before a successor turn;
      // no compatibility marker is projected to the CLI.
      this.#ensureCoordinator();
      return { receipt: this.#applied(command) };
    }
    if (command.type === 'start_turn') {
      if (this.#running) return { receipt: this.#rejected(command, 'runtime_busy') };
      this.#running = true;
      this.#revision += 1;
      this.#activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'running',
        activeTurn: { turnId: command.commandId, status: 'running' },
      };
      const receipt = this.#applied(command);
      return {
        receipt,
        execution: {
          sessionId: this.#input.sessionId,
          operationId: command.commandId,
          committedRevision: receipt.revision,
          operation: 'turn',
          run: (signal, requestAbort) => this.#runTurn(command, publish, signal, requestAbort),
        },
      };
    }
    if (command.type === 'cancel_turn') {
      if (!this.#running) return { receipt: this.#rejected(command, 'turn_not_found') };
      this.#persistCancellation('Cancelled by user.', publish);
      this.#revision += 1;
      return { receipt: this.#applied(command) };
    }
    if (command.type === 'close_session') {
      this.#persistCancellation('Runtime session closed.', publish);
      this.#closed = true;
      this.#revision += 1;
      return { receipt: this.#applied(command) };
    }
    return { receipt: this.#rejected(command, 'unsupported') };
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId || !this.#created) return;
    this.#persistCancellation(reason, publish);
    this.#closed = true;
  }

  close(): Promise<void> {
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
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }

  async #runTurn(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    publish: (notification: RuntimeNotification) => void,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    this.#activePublish = publish;
    const coordinator = this.#ensureCoordinator();
    coordinator.updateInteractionMode(this.#input.interactionMode);
    coordinator.updateSandboxAvailable(appSandboxBackendAvailable(this.#input.sandboxBackend));
    let status: NonNullable<RuntimeSessionProjection['activeWork']>['status'] = 'completed';
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
          initialSkillActivations: [...this.#input.initialSkillActivations],
        },
        createCliRuntimeProvider(),
      );
      let sequence = 0;
      for await (const event of generator) {
        const ephemeral = projectRuntimeEphemeralNotification(event, {
          sessionId: this.#input.sessionId,
          workId: command.commandId,
          turnId: command.commandId,
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
        this.#revision += 1;
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: {
            kind: 'turn',
            session: this.#projection(),
            event: event as RuntimeNotificationEvent,
          },
        });
        if (event.type === 'run.error') status = 'failed';
        if (event.type === 'turn.aborted') status = 'cancelled';
      }
    } catch (error) {
      status = signal.aborted ? 'cancelled' : 'failed';
      this.#revision += 1;
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision: this.#revision,
        projection: {
          kind: 'turn',
          session: this.#projection(),
          event: {
            type: 'run.error',
            message: error instanceof Error ? error.message : String(error),
            recoverable: false,
          },
        },
      });
    } finally {
      this.#running = false;
      this.#activePublish = undefined;
      this.#revision += 1;
      this.#activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status,
        activeTurn: { turnId: command.commandId, status },
      };
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision: this.#revision,
        projection: { kind: 'work', session: this.#projection() },
      });
    }
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

  #persistCancellation(
    reason: string,
    publish: (notification: RuntimeNotification) => void = this.#activePublish ?? (() => undefined),
  ): void {
    const events =
      this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.control.cancelRun(reason) ?? [];
    for (const event of events) {
      this.#revision += 1;
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision: this.#revision,
        projection: {
          kind: 'turn',
          session: this.#projection(),
          event: event as RuntimeNotificationEvent,
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
      activeWork: this.#activeWork,
    };
  }

  #applied(
    command: RuntimeCommand,
  ): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
    return {
      status: 'applied',
      commandId: command.commandId,
      sessionId: this.#input.sessionId,
      revision: this.#revision,
    };
  }

  #rejected(command: RuntimeCommand, code: RuntimeCommandErrorCode): RuntimeCommandReceipt {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision: this.#revision,
    };
  }

  #notFound(command: RuntimeCommand): RuntimeCommandReceipt {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }
}

function createCliRuntimeProvider(): RuntimeActionProvider {
  return {
    async requestAction(effect, state): Promise<RuntimeUserAction> {
      if (effect.type === 'request_verification_decision') {
        const record = state.verification.records[effect.verificationId];
        if (!record) throw new Error('Runtime requested a decision for missing verification.');
        console.error(`\n[VERIFICATION REQUIRED] ${record.spec.subject}: ${record.status}`);
        console.error(
          record.spec.compensation
            ? 'Type r/replan, w/waive, or c/compensate:'
            : 'Type r/replan or w/waive:',
        );
        const value = (await readStdin()).trim().toLowerCase();
        if ((value === 'c' || value === 'compensate') && record.spec.compensation) {
          return {
            type: 'request_verification_compensation',
            verificationId: effect.verificationId,
          };
        }
        console.error(
          value === 'w' || value === 'waive'
            ? 'Enter waiver reason:'
            : 'Enter replan/repair instruction:',
        );
        const detail = await readStdin();
        return value === 'w' || value === 'waive'
          ? { type: 'waive_verification', verificationId: effect.verificationId, reason: detail }
          : {
              type: 'replan_verification',
              verificationId: effect.verificationId,
              instruction: detail,
            };
      }
      if (effect.type === 'request_provider_action') {
        console.error(
          `\n[MCP PROVIDER ACTION] ${effect.providerId} requires ${effect.action}. ` +
            'This client does not yet provide an in-process recovery handler; deferring.',
        );
        return {
          type: 'provider_action_result',
          interactionId: effect.interactionId,
          outcome: 'deferred',
        };
      }
      if (effect.type === 'request_provider_admission') {
        console.error(
          `\n[REQUIRED MCP PROVIDER] ${effect.providerId} is ${effect.providerStatus}. ` +
            'This client does not yet provide the required-provider gate; cancelling this run.',
        );
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision: { kind: 'cancel' },
        };
      }
      if (state.interactions.kind === 'awaiting_tool_approval') {
        const approval = state.interactions.approval;
        const pending = state.pendingApprovals.get(effect.interactionId);
        if (!pending || pending.status !== 'awaiting_user') {
          throw new Error('CLI approval queue identity changed before input dispatch.');
        }
        console.error(`\n[APPROVAL REQUIRED] ${approval.tool}: ${approval.command}`);
        console.error(`Risk: ${approval.risk} | ${approval.summary}`);
        console.error(
          'Type y/yes to approve once, s/same to approve matching commands, or n to reject:',
        );
        const value = (await readStdin()).toLowerCase();
        if (value === 's' || value === 'same' || value === 'same_command') {
          return {
            type: 'approve',
            interactionId: effect.interactionId,
            generation: pending.generation,
            grant: 'same_command',
          };
        }
        if (value === 'y' || value === 'yes') {
          return {
            type: 'approve',
            interactionId: effect.interactionId,
            generation: pending.generation,
            grant: 'approve_once',
          };
        }
        return {
          type: 'reject',
          interactionId: effect.interactionId,
          generation: pending.generation,
        };
      }
      if (state.interactions.kind === 'awaiting_review') {
        const plan = state.interactions.plan;
        console.error(`\n[PLAN REVIEW] ${plan.name}\n${plan.description}`);
        console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
        const value = (await readStdin()).toLowerCase();
        const review = {
          type: 'plan_review_decision' as const,
          interactionId: effect.interactionId,
          planId: state.interactions.planId,
          version: state.interactions.version,
          structuralDigest: state.interactions.structuralDigest,
        };
        if (value === 'a' || value === 'auto') {
          return { ...review, decision: { kind: 'approve', nextMode: 'auto' } };
        }
        if (value === 'e' || value === 'accept-edits') {
          return { ...review, decision: { kind: 'approve', nextMode: 'accept_edits' } };
        }
        if (value === 'f' || value === 'feedback') {
          console.error('Enter your feedback:');
          return { ...review, decision: { kind: 'revise', feedback: await readStdin() } };
        }
        return { ...review, decision: { kind: 'cancel' } };
      }
      if (state.interactions.kind !== 'awaiting_user_input') {
        throw new Error('Runtime requested input without an input interaction.');
      }
      const request = state.interactions.request;
      console.error(`\n[QUESTION] ${request.question}`);
      request.options.forEach((option, index) => {
        console.error(`  ${index + 1}. ${option.label}`);
      });
      return { type: 'input', interactionId: effect.interactionId, text: await readStdin() };
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = process;
    const onData = (chunk: Buffer): void => {
      stdin.removeListener('data', onData);
      resolve(chunk.toString().trim());
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}
