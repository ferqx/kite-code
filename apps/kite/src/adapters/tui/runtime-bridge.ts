import {
  RUNTIME_COMMAND_SCHEMA_,
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
import type {
  RuntimeHostCoordinatorPort,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from '@kite/runtime-host';
import {
  type RuntimeHostKernelInput,
  runtimeCommandFromKernelInput,
} from '@kite/runtime-host/kernel-adapter';
import type { ProjectIdentity } from '@kite/runtime-spi';
import { projectRuntimeEphemeralNotification } from '../../bootstrap/presentation-notification';
import type { RuntimeEvent } from '../../bootstrap/runtime/state-runtime';
import { type SessionDeps, SessionManager, type SessionRuntime } from '../../runtime/session';
import type { TuiSessionManager } from './session-adapter';

interface SessionAuthority {
  revision: number;
  workspace: string;
  lifecycle: 'open' | 'closed';
  activeWork?: RuntimeSessionProjection['activeWork'];
}

interface PendingRun {
  readonly dependencies: Parameters<SessionRuntime['runTask']>[1];
  readonly requestedPhase?: Parameters<SessionRuntime['runTask']>[2];
  readonly initialSkills?: Parameters<SessionRuntime['runTask']>[3];
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type ContextCompactionResult = Awaited<ReturnType<SessionManager['handleContextCompaction']>>;
type ContextCompactionProgress = Parameters<SessionManager['handleContextCompaction']>[2];
type ContextCompactionCommand = Parameters<SessionManager['handleContextCompaction']>[3];
type RewindResult = Awaited<ReturnType<SessionManager['executeRewind']>>;

interface PendingCompaction {
  readonly instructions?: string;
  readonly onProgress?: ContextCompactionProgress;
  readonly onCommand?: ContextCompactionCommand;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  result?: ContextCompactionResult;
}

interface PendingRewind {
  readonly workspace: string;
  result?: RewindResult;
}

const TUI_CANCEL_REVISION_RETRY_LIMIT = 8;

export function createTuiRuntimeClient(
  input: SessionDeps,
  createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPort,
  resolveProjectIdentity: (workspace: string) => ProjectIdentity,
): TuiSessionManager {
  return new TuiRuntimeBridge(input, createHost, resolveProjectIdentity).client;
}

class TuiRuntimeBridge implements RuntimeHostExecutionBridge {
  readonly #manager: SessionManager;
  readonly #access: RuntimeHostCoordinatorPort;
  readonly #sessions = new Map<string, SessionAuthority>();
  readonly #sessionReadiness = new Map<string, Promise<void>>();
  readonly #runtimeClients = new Map<string, object>();
  readonly #managerMembers = new Map<PropertyKey, unknown>();
  readonly #pendingRuns = new Map<string, PendingRun>();
  readonly #pendingCompactions = new Map<string, PendingCompaction>();
  readonly #pendingRewinds = new Map<string, PendingRewind>();
  readonly #streamSequences = new Map<string, number>();
  readonly #resolveProjectIdentity: (workspace: string) => ProjectIdentity;
  #commandSequence = 0;
  readonly client: TuiSessionManager;

  constructor(
    input: SessionDeps,
    createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPort,
    resolveProjectIdentity: (workspace: string) => ProjectIdentity,
  ) {
    this.#manager = new SessionManager(input);
    this.#access = createHost(this);
    this.#resolveProjectIdentity = resolveProjectIdentity;
    this.client = this.#createManagerClient();
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    const authority = this.#sessions.get(sessionId);
    if (!(await this.#manager.recoverRuntimeState(sessionId)) || !authority) return;
    authority.revision += 1;
    publish(this.#notification(sessionId, 'session'));
  }

  async prepare(
    input: RuntimeHostKernelInput,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<RuntimeHostPreparedExecution> {
    const command = runtimeCommandFromKernelInput(input);
    if (command.type === 'create_session') {
      const sessionId = command.bootstrapSessionId;
      if (!sessionId) return { receipt: this.#reject(command, 'invalid_session') };
      if (!this.#sessions.has(sessionId)) {
        this.#sessions.set(sessionId, {
          revision: 0,
          workspace: command.workspace,
          lifecycle: 'open',
        });
      }
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'resume_session') {
      const runtime = this.#manager.getRuntime(command.sessionId);
      if (!runtime) return { receipt: this.#notFound(command) };
      if (!this.#sessions.has(command.sessionId)) {
        this.#sessions.set(command.sessionId, {
          revision: command.afterRevision ?? 0,
          workspace: runtime.workspace,
          lifecycle: 'open',
        });
      }
      return { receipt: this.#applied(command, command.sessionId) };
    }
    const sessionId = 'sessionId' in command ? command.sessionId : command.sourceSessionId;
    const authority = this.#sessions.get(sessionId);
    const runtime = this.#manager.getRuntime(sessionId);
    if (!authority) return { receipt: this.#notFound(command) };
    if (command.type === 'close_session') {
      // An explicit close can race with the end of an operation, or arrive
      // after an admission-only cleanup has already released the Runtime.
      // Only a live Host operation owns a cancellation fact; manufacturing one
      // for an idle target mutates durable State and revision without work.
      const operationActive = this.#access.isSessionOperationActive(sessionId);
      if (operationActive) runtime?.persistCancellation('Runtime session closed.');
      authority.lifecycle = 'closed';
      if (operationActive) authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (!runtime) return { receipt: this.#notFound(command) };
    if (command.type === 'start_turn') {
      const pending = this.#pendingRuns.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'running',
        activeTurn: { turnId: command.commandId, status: 'running' },
      };
      const receipt = this.#applied(command, sessionId);
      return {
        receipt,
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: receipt.revision,
          operation: 'turn',
          run: (signal, requestAbort) =>
            this.#executeRun(command, runtime, pending, publish, signal, requestAbort),
          cancel: (reason) => pending.reject(abortError(reason)),
        },
      };
    }
    if (command.type === 'cancel_turn') {
      runtime.persistCancellation('Cancelled by user.');
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'set_interaction_mode') {
      runtime.setInteractionMode(command.mode);
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'compact_session') {
      const pending = this.#pendingCompactions.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      authority.revision += 1;
      const receipt = this.#applied(command, sessionId);
      return {
        receipt,
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: receipt.revision,
          operation: 'compaction',
          run: (signal, _requestAbort) => this.#executeCompaction(command, pending, signal),
          cancel: (reason) => pending.reject(abortError(reason)),
        },
      };
    }
    if (command.type === 'rewind_session') {
      const pending = this.#pendingRewinds.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      pending.result = await this.#manager.executeRewind({
        sourceThreadId: sessionId,
        snapshotId: command.checkpointId,
        scope:
          command.scope === 'conversation_and_workspace' ? 'code_and_conversation' : command.scope,
        workspace: pending.workspace,
      });
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    return { receipt: this.#reject(command, 'unsupported') };
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    _publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    // Keep explicit Host cancellation semantics intact. Admission-only load
    // rollback never enters this path: it releases the local bridge/runtime
    // state without issuing close_session or shutdownSession.
    this.#manager.getRuntime(sessionId)?.persistCancellation(reason);
  }

  async close(): Promise<void> {
    await this.#manager.closeRuntimeSessionCoordinators();
    await this.#manager.dispose();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (query.type === 'list_sessions') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        sessions: [...this.#sessions.keys()].map((sessionId) => this.#projection(sessionId)),
      });
    }
    if ('sessionId' in query && !this.#sessions.has(query.sessionId)) {
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
        revision: this.#sessions.get(query.sessionId)?.revision,
        session: this.#projection(query.sessionId),
      });
    }
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }

  async #executeRun(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    runtime: SessionRuntime,
    pending: PendingRun,
    publish: (notification: RuntimeNotification) => void,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    const sessionId = command.sessionId;
    const authority = this.#sessions.get(sessionId);
    if (!authority) {
      pending.reject(new Error(`Unknown TUI session: ${sessionId}`));
      return;
    }
    const dispatch = pending.dependencies.dispatch;
    try {
      await runtime.runTask(
        command.input,
        {
          ...pending.dependencies,
          dispatch: (action) => {
            if (action.type === 'RUNTIME_EVENT') {
              this.#publishPresentation(sessionId, action.event, publish);
            }
            dispatch(action);
          },
        },
        pending.requestedPhase,
        pending.initialSkills,
        signal,
        requestAbort,
      );
      const status = signal.aborted ? 'cancelled' : 'completed';
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status,
        activeTurn: { turnId: command.commandId, status },
      };
      publish(this.#notification(sessionId, 'work'));
      pending.resolve();
    } catch (error) {
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'failed',
        activeTurn: { turnId: command.commandId, status: 'failed' },
      };
      publish(this.#notification(sessionId, 'work'));
      pending.reject(error);
    } finally {
      this.#pendingRuns.delete(command.commandId);
    }
  }

  async #executeCompaction(
    command: Extract<RuntimeCommand, { type: 'compact_session' }>,
    pending: PendingCompaction,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      pending.result =
        command.mode === 'reset'
          ? await this.#manager.handleContextResetFromHost(command.sessionId, signal)
          : await this.#manager.executeHostCompaction(
              command.sessionId,
              pending.instructions,
              pending.onProgress,
              pending.onCommand,
              signal,
            );
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    }
  }

  #createManagerClient(): TuiSessionManager {
    return new Proxy(this.#manager, {
      get: (target, property) => {
        if (this.#managerMembers.has(property)) return this.#managerMembers.get(property);
        const member = (() => {
          if (property === 'createSession') {
            return (workspace: string): string => {
              const project = this.#resolveProjectIdentity(workspace);
              const sessionId = target.createSession(workspace, {
                projectId: project.projectId,
                canonicalWorkspaceDigest: project.workspaceDigest,
              });
              this.#trackSessionReadiness(sessionId, {
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'create'),
                type: 'create_session',
                workspace,
                bootstrapSessionId: sessionId,
              });
              return sessionId;
            };
          }
          if (property === 'dispose') {
            return async (): Promise<void> => {
              await this.#awaitAllSessionReadiness();
              await this.#access[Symbol.asyncDispose]();
            };
          }
          if (property === 'abortAll') {
            return async (): Promise<void> => {
              await this.#awaitAllSessionReadiness();
              await this.#access.cancelAllSessions('TUI shutdown requested.');
            };
          }
          if (property === 'cancelRuntimeOperations') {
            return async (sessionId: string): Promise<void> => {
              await this.#awaitSessionReadiness(sessionId);
              await this.#access.cancelSession(sessionId, 'Session operation cancelled.');
              await this.#access.waitForSessionIdle(sessionId);
            };
          }
          if (property === 'registerSession') {
            return (sessionId: string, workspace: string): object => {
              const runtime = target.registerSession(sessionId, workspace);
              this.#trackSessionReadiness(sessionId, {
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'resume'),
                type: 'resume_session',
                sessionId,
              });
              return this.#runtimeClient(runtime);
            };
          }
          if (property === 'waitForSessionReady') {
            return async (sessionId: string): Promise<void> => {
              await this.#awaitSessionReadiness(sessionId);
            };
          }
          if (property === 'getRuntime') {
            return (sessionId: string): object | undefined => {
              const runtime = target.getRuntime(sessionId);
              return runtime ? this.#runtimeClient(runtime) : undefined;
            };
          }
          if (property === 'forkRecoveredSessionForContinuation') {
            return (sessionId: string): object | undefined => {
              const runtime = target.forkRecoveredSessionForContinuation(sessionId);
              if (!runtime) return undefined;
              if (!this.#sessions.has(runtime.threadId)) {
                this.#sessions.set(runtime.threadId, {
                  revision: 0,
                  workspace: runtime.workspace,
                  lifecycle: 'open',
                });
              }
              return this.#runtimeClient(runtime);
            };
          }
          if (property === 'removeRuntime') {
            return async (sessionId: string): Promise<void> => {
              let cleanupError: unknown;
              const rememberError = (error: unknown): void => {
                cleanupError ??= error;
              };

              let readinessSettled = false;
              try {
                await this.#awaitSessionReadiness(sessionId);
                readinessSettled = true;
              } catch (error) {
                // A rejected resume/create admission still leaves a local
                // Runtime that must be removed. Preserve the rejection for
                // the caller, but do not strand the registration behind it.
                rememberError(error);
              }

              let operationActive = false;
              try {
                operationActive = this.#access.isSessionOperationActive(sessionId);
              } catch (error) {
                // If the Host cannot answer, fail closed and attempt the
                // draining close path before releasing the coordinator.
                operationActive = true;
                rememberError(error);
              }
              // A settled admission owns a Host lifecycle entry even when it
              // never started work. Close that entry without manufacturing a
              // cancellation fact; a failed admission has no confirmed Host
              // lifecycle to close. An observed live operation remains a
              // fail-closed close candidate even if readiness reporting failed.
              const shouldCloseHost = readinessSettled || operationActive;

              try {
                const authority = this.#sessions.get(sessionId);
                let closeApplied = false;
                if (authority && shouldCloseHost) {
                  try {
                    const receipt = await this.#access.command({
                      schema: RUNTIME_COMMAND_SCHEMA_,
                      commandId: this.#nextCommandId(sessionId, 'close'),
                      type: 'close_session',
                      sessionId,
                      expectedRevision: authority.revision,
                    });
                    this.#assertApplied(receipt);
                    closeApplied = true;
                  } catch (error) {
                    rememberError(error);
                  }
                }

                // A failed close can leave a scheduled operation alive;
                // always make one bounded drain attempt before releasing
                // the State coordinator and manager registration. This also
                // covers a Host operation whose local bridge authority was
                // lost while readiness was failing.
                if (closeApplied || operationActive) {
                  try {
                    await this.#access.waitForSessionIdle(sessionId);
                  } catch (error) {
                    rememberError(error);
                  }
                }
              } catch (error) {
                rememberError(error);
              }

              try {
                await target.releaseRuntimeSessionCoordinator(sessionId);
              } catch (error) {
                rememberError(error);
              }

              try {
                target.removeRuntimeAfterHostClose(sessionId);
              } catch (error) {
                rememberError(error);
              } finally {
                this.#runtimeClients.delete(sessionId);
                this.#sessionReadiness.delete(sessionId);
                this.#sessions.delete(sessionId);
              }

              if (cleanupError !== undefined) throw cleanupError;
            };
          }
          if (property === 'handleContextCompaction') {
            return async (
              sessionId: string,
              instructions?: string,
              onProgress?: ContextCompactionProgress,
              onCommand?: ContextCompactionCommand,
            ): Promise<ContextCompactionResult | undefined> => {
              await this.#awaitSessionReadiness(sessionId);
              const commandId = this.#nextCommandId(sessionId, 'compact');
              const deferred = createDeferred();
              const pending: PendingCompaction = {
                instructions,
                onProgress,
                onCommand,
                ...deferred,
              };
              this.#pendingCompactions.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId,
                  type: 'compact_session',
                  sessionId,
                  expectedRevision: this.#revision(sessionId),
                  mode: 'manual',
                  instructions,
                });
                this.#assertApplied(receipt);
                await pending.completion;
                return pending.result;
              } finally {
                this.#pendingCompactions.delete(commandId);
              }
            };
          }
          if (property === 'handleContextReset') {
            return async (sessionId: string): Promise<ContextCompactionResult | undefined> => {
              await this.#awaitSessionReadiness(sessionId);
              const commandId = this.#nextCommandId(sessionId, 'reset');
              const pending: PendingCompaction = { ...createDeferred() };
              this.#pendingCompactions.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId,
                  type: 'compact_session',
                  sessionId,
                  expectedRevision: this.#revision(sessionId),
                  mode: 'reset',
                });
                this.#assertApplied(receipt);
                await pending.completion;
                return pending.result;
              } finally {
                this.#pendingCompactions.delete(commandId);
              }
            };
          }
          if (property === 'executeRewind') {
            return async (input: {
              sourceThreadId: string;
              snapshotId: string;
              scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
              workspace: string;
            }): Promise<RewindResult | undefined> => {
              await this.#awaitSessionReadiness(input.sourceThreadId);
              const commandId = this.#nextCommandId(input.sourceThreadId, 'rewind');
              const pending: PendingRewind = { workspace: input.workspace };
              this.#pendingRewinds.set(commandId, pending);
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId,
                type: 'rewind_session',
                sessionId: input.sourceThreadId,
                expectedRevision: this.#revision(input.sourceThreadId),
                checkpointId: input.snapshotId,
                scope:
                  input.scope === 'code_and_conversation'
                    ? 'conversation_and_workspace'
                    : input.scope,
              });
              this.#pendingRewinds.delete(commandId);
              this.#assertApplied(receipt);
              return pending.result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        })();
        if (typeof member === 'function') this.#managerMembers.set(property, member);
        return member;
      },
    }) as unknown as TuiSessionManager;
  }

  #runtimeClient(runtime: SessionRuntime): object {
    const existing = this.#runtimeClients.get(runtime.threadId);
    if (existing) return existing;
    const client = new Proxy(runtime, {
      get: (target, property) => {
        if (property === 'runTask') {
          return async (
            task: string,
            dependencies: Parameters<SessionRuntime['runTask']>[1],
            requestedPhase?: Parameters<SessionRuntime['runTask']>[2],
            initialSkills?: Parameters<SessionRuntime['runTask']>[3],
          ): Promise<void> => {
            await this.#awaitSessionReadiness(target.threadId);
            const commandId = this.#nextCommandId(target.threadId, 'turn');
            const pending: PendingRun = {
              dependencies,
              requestedPhase,
              initialSkills,
              ...createDeferred(),
            };
            this.#pendingRuns.set(commandId, pending);
            try {
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId,
                type: 'start_turn',
                sessionId: target.threadId,
                expectedRevision: this.#revision(target.threadId),
                input: task,
                phase: requestedPhase,
                initialSkills,
              });
              this.#assertApplied(receipt);
              await pending.completion;
            } finally {
              this.#pendingRuns.delete(commandId);
            }
          };
        }
        if (property === 'waitForRunCompletion') {
          return async (): Promise<void> => {
            await this.#awaitSessionReadiness(target.threadId);
            await this.#access.waitForSessionIdle(target.threadId);
          };
        }
        if (property === 'abort') {
          return (): void => {
            // Ctrl+C is a synchronous TUI API. Stop the live Runtime before
            // returning so a Host revision race cannot leave provider or
            // Shell work running after the UI has accepted the cancellation.
            target.abort();
            void this.#cancelTurn(target).catch((error) => {
              target.reportRuntimeFailure(
                error instanceof Error
                  ? error.message
                  : `TUI Runtime cancellation failed: ${String(error)}`,
              );
            });
          };
        }
        if (property === 'setInteractionMode') {
          return (mode: 'accept_edits' | 'auto' | 'full'): void => {
            void this.#awaitSessionReadiness(target.threadId)
              .then(() =>
                this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId: this.#nextCommandId(target.threadId, 'mode'),
                  type: 'set_interaction_mode',
                  sessionId: target.threadId,
                  expectedRevision: this.#revision(target.threadId),
                  mode,
                }),
              )
              .catch(() => {});
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    this.#runtimeClients.set(runtime.threadId, client);
    return client;
  }

  async #cancelTurn(runtime: SessionRuntime): Promise<void> {
    await this.#awaitSessionReadiness(runtime.threadId);
    let expectedRevision = this.#revision(runtime.threadId);
    for (let attempt = 0; attempt < TUI_CANCEL_REVISION_RETRY_LIMIT; attempt += 1) {
      const receipt = await this.#access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: this.#nextCommandId(runtime.threadId, 'cancel'),
        type: 'cancel_turn',
        sessionId: runtime.threadId,
        expectedRevision,
        turnId: runtime.threadId,
      });
      if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
      if (
        receipt.status === 'conflict' &&
        receipt.code === 'revision_conflict' &&
        Number.isSafeInteger(receipt.currentRevision) &&
        receipt.currentRevision! >= 0
      ) {
        expectedRevision = receipt.currentRevision!;
        continue;
      }
      throw new Error(`TUI Runtime cancellation rejected: ${receipt.code}`);
    }
    throw new Error('TUI Runtime cancellation rejected: revision_conflict');
  }

  #publishPresentation(
    sessionId: string,
    event: RuntimeEvent,
    publish: (notification: RuntimeNotification) => void,
  ): void {
    const authority = this.#sessions.get(sessionId);
    if (!authority) return;
    const sequence = (this.#streamSequences.get(sessionId) ?? 0) + 1;
    const workId = authority.activeWork?.workId ?? sessionId;
    const turnId = authority.activeWork?.activeTurn?.turnId ?? workId;
    const ephemeral = projectRuntimeEphemeralNotification(event, {
      sessionId,
      workId,
      turnId,
      actorId: 'runtime-agent',
      attemptId: workId,
      streamId: workId,
      sequence,
    });
    if (ephemeral) {
      this.#streamSequences.set(sessionId, sequence);
      publish(ephemeral);
      return;
    }
    authority.revision += 1;
    publish({
      ...this.#notification(sessionId, 'turn'),
      projection: {
        kind: 'turn',
        session: this.#projection(sessionId),
        event: event as RuntimeNotificationEvent,
      },
    });
  }

  #notification(
    sessionId: string,
    kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence',
  ): Extract<RuntimeNotification, { durability: 'durable' }> {
    const projection = this.#projection(sessionId);
    return {
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: projection.revision,
      projection: { kind, session: projection },
    };
  }

  #projection(sessionId: string): RuntimeSessionProjection {
    const authority = this.#sessions.get(sessionId);
    if (!authority) throw new Error(`Unknown TUI session: ${sessionId}`);
    const runtime = this.#manager.getRuntime(sessionId);
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId,
      revision: authority.revision,
      displayName: runtime?.name,
      workspace: authority.workspace,
      lifecycle: authority.lifecycle,
      activeWork: authority.activeWork,
    };
  }

  #revision(sessionId: string): number {
    return this.#sessions.get(sessionId)?.revision ?? 0;
  }

  #trackSessionReadiness(
    sessionId: string,
    command: Extract<RuntimeCommand, { type: 'create_session' | 'resume_session' }>,
  ): void {
    const previous = this.#sessionReadiness.get(sessionId) ?? Promise.resolve();
    const readiness = previous.then(async () => {
      const receipt = await this.#access.command(command);
      this.#assertApplied(receipt);
    });
    this.#sessionReadiness.set(sessionId, readiness);
    // Creation remains a synchronous client API, so attach a rejection
    // observer here. Promise-returning follow-up operations still await and
    // surface the same failure; synchronous fire-and-forget methods attach
    // their own sinks instead of racing an absent Host authority.
    void readiness.catch(() => {});
  }

  async #awaitSessionReadiness(sessionId: string): Promise<void> {
    await this.#sessionReadiness.get(sessionId);
  }

  async #awaitAllSessionReadiness(): Promise<void> {
    await Promise.allSettled(this.#sessionReadiness.values());
  }

  #nextCommandId(sessionId: string, operation: string): string {
    this.#commandSequence += 1;
    return `tui:${sessionId}:${operation}:${this.#commandSequence}`;
  }

  #applied(
    command: RuntimeCommand,
    sessionId: string,
  ): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
    return {
      status: 'applied',
      commandId: command.commandId,
      sessionId,
      revision: this.#revision(sessionId),
    };
  }

  #reject(command: RuntimeCommand, code: RuntimeCommandErrorCode): RuntimeCommandReceipt {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision:
        'sessionId' in command ? this.#sessions.get(command.sessionId)?.revision : undefined,
    };
  }

  #notFound(command: RuntimeCommand): RuntimeCommandReceipt {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }

  #assertApplied(receipt: RuntimeCommandReceipt): void {
    if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
    throw new Error(`TUI Runtime command rejected: ${receipt.code}`);
  }
}

function createDeferred(): Pick<PendingRun, 'completion' | 'resolve' | 'reject'> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { completion, resolve, reject };
}

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}
