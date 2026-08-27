import { randomUUID } from 'node:crypto';
import type { LocalKiteConnection } from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClient } from '@kite-ai/runtime-client';
import type {
  RuntimeAccessNotification,
  RuntimeCheckpointProjection,
  RuntimeClientEvent,
  RuntimeClientInteraction,
  RuntimeCommand,
  RuntimeCommandReceipt,
  RuntimeContextProjection,
  RuntimeNotification,
  RuntimeRewindPreviewProjection,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type {
  SessionListProjection,
  SessionPresentationAction,
  SessionStatusProjection,
  TuiContextCompactionCommand,
  TuiContextCompactionProgress,
  TuiContextCompactionResult,
  TuiInitialSkillActivation,
  TuiModelRouteProjection,
  TuiRewindRequest,
  TuiRewindResult,
  TuiRuntimeClientFacade,
  TuiSessionFacade,
  TuiSessionRunDependencies,
  TuiSubmittedInteractionAction,
} from '../adapters/tui/session-adapter';
import { createTuiHistoryFacade } from '../runtime-client/tui-history-facade';
import type { RuntimePresentationEvent } from '../tui/runtime-presentation';

const CANCEL_RETRY_LIMIT = 8;
const RUN_WAIT_DEADLINE_MS = 30 * 60 * 1_000;

interface NativeSessionRecord {
  readonly threadId: string;
  readonly workspace: string;
  readonly interactions: Map<string, RuntimeClientInteraction>;
  readonly rewindWaiters: Map<
    string,
    {
      readonly resolve: (event: Extract<RuntimeClientEvent, { type: 'rewind.terminal' }>) => void;
      readonly reject: (error: unknown) => void;
    }
  >;
  readonly eventBuffer: RuntimePresentationEvent[];
  readonly conversationHistory: string[];
  readonly tokenStats: {
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalTokens: number;
  };
  name: string;
  foreground: boolean;
  dormant: boolean;
  localReplayRecovery: boolean;
  pendingInterrupt: boolean;
  interactionMode: 'accept_edits' | 'auto' | 'full';
  thinkingLevel: string | null;
  projection: RuntimeSessionProjection | undefined;
  context: RuntimeContextProjection | undefined;
  revision: number;
  reserved: boolean;
  agentLoopActive: boolean;
  dispatch: ((action: SessionPresentationAction) => void) | undefined;
  subscriptionController: AbortController | undefined;
  subscriptionPromise: Promise<void> | undefined;
  subscriptionError: unknown;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  runPromise: Promise<void> | undefined;
  runIdlePromise: Promise<void> | undefined;
  runProjectionRevisionFloor: number | undefined;
  commandBarrier: Promise<void>;
  resolveRun: (() => void) | undefined;
  rejectRun: ((error: unknown) => void) | undefined;
}

export interface NativeTuiRuntimeClientOptions {
  readonly connection: LocalKiteConnection;
  readonly workspace: string;
  readonly flushPresentation?: () => Promise<void>;
}

/**
 * Adapt the closed Native Runtime/History client to the presentation facade
 * consumed by the existing TUI. Every method below is an explicit client
 * operation; no Service Manager, Host, Store, or SessionRuntime object is
 * exposed to the terminal process.
 */
export function createNativeTuiRuntimeClient(
  options: NativeTuiRuntimeClientOptions,
): TuiRuntimeClientFacade {
  return new NativeTuiRuntimeClient(options).facade;
}

export function createNativeTuiRuntimeClientFactory(
  input: Pick<NativeTuiRuntimeClientOptions, 'connection'>,
): (dependencies: {
  readonly workspace: string;
  readonly flushPresentation?: () => Promise<void>;
}) => TuiRuntimeClientFacade {
  let owner: NativeTuiRuntimeClient | undefined;
  let admittedWorkspace: string | undefined;
  return (dependencies) => {
    if (admittedWorkspace !== undefined && admittedWorkspace !== dependencies.workspace) {
      throw new Error('TUI Runtime client Workspace identity changed after admission.');
    }
    admittedWorkspace = dependencies.workspace;
    owner ??= new NativeTuiRuntimeClient({
      connection: input.connection,
      workspace: dependencies.workspace,
      flushPresentation: dependencies.flushPresentation,
    });
    return owner.createFacade(dependencies.flushPresentation);
  };
}

class NativeTuiRuntimeClient {
  readonly #connection: LocalKiteConnection;
  readonly #runtime: RuntimeClient;
  readonly #history: ReturnType<typeof createTuiHistoryFacade>;
  readonly #workspace: string;
  readonly #sessions = new Map<string, NativeSessionRecord>();
  readonly #views = new Map<string, TuiSessionFacade>();
  readonly #commandIds = new Map<string, number>();
  readonly #commandNonce = randomUUID();
  readonly #unsubscribeSnapshot: () => void;
  readonly #facade: TuiRuntimeClientFacade;
  #activeId = '';
  #closed = false;
  #snapshotCallback: ((threadId: string) => void) | undefined;
  #flushPresentation: (() => Promise<void>) | undefined;

  constructor(options: NativeTuiRuntimeClientOptions) {
    if (options.workspace.length === 0) throw new TypeError('TUI workspace is required.');
    this.#connection = options.connection;
    this.#runtime = options.connection.runtime;
    this.#history = createTuiHistoryFacade(options.connection.history);
    this.#workspace = options.workspace;
    this.#flushPresentation = options.flushPresentation;
    this.#unsubscribeSnapshot = this.#runtime.snapshotStore.subscribe(() => {
      for (const record of this.#sessions.values()) this.#syncSnapshot(record);
      this.#snapshotCallback?.(this.#activeId);
    });
    this.#facade = this.createFacade(options.flushPresentation);
  }

  get facade(): TuiRuntimeClientFacade {
    return this.#facade;
  }

  createFacade(flushPresentation?: () => Promise<void>): TuiRuntimeClientFacade {
    if (flushPresentation) this.#flushPresentation = flushPresentation;
    return Object.freeze({
      submitUserAction: (action: TuiSubmittedInteractionAction) => this.#submitUserAction(action),
      createSession: (workspace: string) => this.#createSession(workspace),
      registerSession: (sessionId: string, workspace: string) =>
        this.#registerSession(sessionId, workspace),
      hasRuntime: (sessionId: string) => this.#sessions.has(sessionId),
      getRuntime: (sessionId: string) => this.#view(this.#sessions.get(sessionId)),
      forkRecoveredSessionForContinuation: (sessionId: string) =>
        this.#forkRecoveredSessionForContinuation(sessionId),
      getActiveId: () => this.#activeId,
      switchSession: (fromId: string, toId: string) => this.#switchSession(fromId, toId),
      getSnapshot: (
        previous?: ReadonlyArray<{ threadId: string; status: SessionStatusProjection }>,
      ) => this.#getSnapshot(previous),
      listPersistedSessions: (query?: string) => this.#history.listPersistedSessions(query),
      loadPersistedSession: (sessionId: string) => this.#history.loadPersistedSession(sessionId),
      waitForSessionReady: (sessionId: string) => this.#waitForSessionReady(sessionId),
      removeRuntime: (sessionId: string) => this.#removeRuntime(sessionId),
      deletePersistedSession: (sessionId: string) => this.#deletePersistedSession(sessionId),
      cancelRuntimeOperations: (sessionId: string) => this.#cancelRuntimeOperations(sessionId),
      abortAll: () => this.#abortAll(),
      dispose: () => this.#dispose(),
      shutdownObservability: (_timeoutMs: number) => Promise.resolve(),
      setSnapshotCallback: (callback: (threadId: string) => void) => {
        this.#snapshotCallback = callback;
      },
      onInterruptPending: (threadId: string) => this.#snapshotCallback?.(threadId),
      onStatusChange: (threadId: string) => this.#snapshotCallback?.(threadId),
      setName: (threadId: string, name: string) => {
        const record = this.#sessions.get(threadId);
        if (record && name.length > 0) record.name = name;
      },
      saveTokenStats: (threadId: string, status: SessionStatusProjection) => {
        const record = this.#sessions.get(threadId);
        if (!record) return;
        record.tokenStats.cacheHitTokens = status.cacheHitTokens;
        record.tokenStats.cacheMissTokens = status.cacheMissTokens;
        record.tokenStats.totalTokens = status.totalTokens;
      },
      applyPersistedModelRoute: (threadId: string, provider?: string, name?: string) =>
        this.#applyPersistedModelRoute(threadId, provider, name),
      buildContextStatusSnapshot: (threadId: string) =>
        this.#sessions.get(threadId)?.context
          ? toContextStatusSnapshot(this.#sessions.get(threadId)!.context!)
          : undefined,
      handleContextDisplay: (threadId: string) => this.#handleContextDisplay(threadId),
      handleContextCompaction: (
        threadId: string,
        instructions?: string,
        onProgress?: TuiContextCompactionProgress,
        onCommand?: TuiContextCompactionCommand,
      ) => this.#handleContextCompaction(threadId, instructions, onProgress, onCommand),
      handleContextReset: (threadId: string) => this.#handleContextReset(threadId),
      generateAndPersistSessionName: (threadId: string, task: string) =>
        this.#generateSessionName(threadId, task),
      getSessionProjection: (threadId: string) => this.#getSessionProjection(threadId),
      listRewindCheckpoints: (threadId: string) => this.#listRewindCheckpoints(threadId),
      previewRewind: (threadId: string, checkpointId: string) =>
        this.#previewRewind(threadId, checkpointId),
      executeRewind: (input: TuiRewindRequest) => this.#executeRewind(input),
      clearSessionCommandGrants: (threadId: string) => this.#clearSessionCommandGrants(threadId),
    });
  }

  #createSession(workspace: string): string {
    this.#assertWorkspace(workspace);
    this.#assertOpen();
    const threadId = `tui-${randomUUID()}`;
    const record = this.#newRecord(threadId, workspace);
    record.foreground = true;
    this.#setActive(threadId);
    void this.#admitAndSubscribe(record, 'create').catch(() => undefined);
    return threadId;
  }

  #registerSession(sessionId: string, workspace: string): TuiSessionFacade {
    this.#assertWorkspace(workspace);
    this.#assertOpen();
    const existing = this.#sessions.get(sessionId);
    if (existing) return this.#view(existing)!;
    if (!isIdentifier(sessionId)) throw new TypeError('Runtime session id is invalid.');
    const record = this.#newRecord(sessionId, workspace);
    record.dormant = true;
    void this.#admitAndSubscribe(record, 'resume').catch(() => undefined);
    return this.#view(record)!;
  }

  #newRecord(threadId: string, workspace: string): NativeSessionRecord {
    const previous = this.#sessions.get(threadId);
    if (previous) return previous;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const record: NativeSessionRecord = {
      threadId,
      workspace,
      interactions: new Map(),
      rewindWaiters: new Map(),
      eventBuffer: [],
      conversationHistory: [],
      tokenStats: { cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
      name: threadId,
      foreground: false,
      dormant: false,
      localReplayRecovery: false,
      pendingInterrupt: false,
      interactionMode: 'auto',
      thinkingLevel: null,
      projection: undefined,
      context: undefined,
      revision: 0,
      reserved: false,
      agentLoopActive: false,
      dispatch: undefined,
      subscriptionController: undefined,
      subscriptionPromise: undefined,
      subscriptionError: undefined,
      readyPromise,
      resolveReady,
      rejectReady,
      runPromise: undefined,
      runIdlePromise: undefined,
      runProjectionRevisionFloor: undefined,
      commandBarrier: Promise.resolve(),
      resolveRun: undefined,
      rejectRun: undefined,
    };
    this.#sessions.set(threadId, record);
    return record;
  }

  async #createRemoteSession(record: NativeSessionRecord): Promise<void> {
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(record.threadId, 'create'),
      type: 'create_session',
      workspace: record.workspace,
      bootstrapSessionId: record.threadId,
    });
    this.#assertApplied(receipt);
    this.#recordRevision(record, receipt);
    record.dormant = false;
  }

  async #admitAndSubscribe(
    record: NativeSessionRecord,
    operation: 'create' | 'resume',
  ): Promise<void> {
    try {
      if (operation === 'create') await this.#createRemoteSession(record);
      else await this.#resumeRemoteSession(record);
      // A connection can close while the admission command is in flight. Do not
      // establish a new long-lived subscription from a late command response.
      this.#assertOpen();
      // The admission command must complete before subscribing. This avoids
      // a transient session_not_found response for a newly-created session.
      await this.#openSessionSubscription(record);
      record.resolveReady();
    } catch (error) {
      record.subscriptionError = error;
      record.rejectReady(error);
      throw error;
    }
  }

  async #resumeRemoteSession(record: NativeSessionRecord): Promise<void> {
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(record.threadId, 'resume'),
      type: 'resume_session',
      sessionId: record.threadId,
    });
    this.#assertApplied(receipt);
    this.#recordRevision(record, receipt);
    record.dormant = false;
  }

  async #waitForSessionReady(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error(`Runtime session is unavailable: ${sessionId}`);
    await record.readyPromise;
    if (record.subscriptionError !== undefined) throw record.subscriptionError;
    this.#assertOpen();
  }

  async #openSessionSubscription(record: NativeSessionRecord): Promise<void> {
    if (this.#closed) return;
    const controller = new AbortController();
    record.subscriptionController = controller;
    const notifications = await this.#runtime.subscribeReady({
      spec: { scope: 'session', sessionId: record.threadId, includeEphemeral: true },
      signal: controller.signal,
    });
    record.subscriptionPromise = this.#consumeSessionSubscription(
      record,
      notifications,
      controller,
    );
  }

  async #consumeSessionSubscription(
    record: NativeSessionRecord,
    notifications: AsyncIterable<RuntimeAccessNotification>,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (const notification of notifications) {
        if (controller.signal.aborted || this.#closed) return;
        await this.#applyNotification(record, notification);
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.#closed) record.subscriptionError = error;
    }
  }

  async #applyNotification(
    record: NativeSessionRecord,
    notification: RuntimeAccessNotification,
  ): Promise<void> {
    let event: RuntimeClientEvent | undefined;
    let reconcileSnapshot = false;
    if (isRuntimeNotification(notification)) {
      if (notification.durability === 'ephemeral') {
        event = notification.event;
      } else {
        const projection = notification.projection.session;
        const authoritative =
          projection.revision >=
          Math.max(record.revision, record.runProjectionRevisionFloor ?? record.revision);
        if (projection.revision >= (record.projection?.revision ?? 0)) {
          record.projection = projection;
        }
        record.revision = Math.max(record.revision, notification.revision);
        if (authoritative) {
          record.agentLoopActive = isActiveWork(projection.activeWork);
          // The wire contract intentionally flattens both Host snapshots and
          // event-free durable projections to the same closed notification
          // shape. Reconcile either one when there is no client event below.
          reconcileSnapshot = true;
        }
        event = notification.projection.event;
      }
    }
    if (!event) {
      this.#syncSnapshot(record);
      if (reconcileSnapshot) this.#reconcileRuntimeProjection(record);
      this.#snapshotCallback?.(record.threadId);
      return;
    }
    if (event.type === 'rewind.terminal') {
      const waiter = record.rewindWaiters.get(event.commandId);
      record.rewindWaiters.delete(event.commandId);
      waiter?.resolve(event);
    }
    this.#applyEventFacts(record, event);
    if (record.foreground && record.dispatch) {
      record.dispatch({ type: 'RUNTIME_EVENT', event });
    } else {
      record.eventBuffer.push(event);
    }
    if (event.type === 'reasoning.activity' && event.state === 'completed') {
      await this.#flushPresentation?.();
    }
    if (isTerminalEvent(event)) {
      if (isActiveWork(record.projection?.activeWork)) {
        record.runIdlePromise ??= this.#resolveRunAfterRemoteIdle(record).finally(() => {
          record.runIdlePromise = undefined;
        });
      } else {
        record.agentLoopActive = false;
        record.resolveRun?.();
        record.resolveRun = undefined;
        record.rejectRun = undefined;
      }
    }
    this.#syncSnapshot(record);
    this.#snapshotCallback?.(record.threadId);
  }

  #reconcileRuntimeProjection(record: NativeSessionRecord): void {
    const work = record.projection?.activeWork;
    const active = isActiveWork(work);
    const interaction = active ? work.activeTurn?.interaction : undefined;
    if (interaction) {
      record.interactions.set(interaction.interactionId, interaction);
      record.pendingInterrupt = true;
    } else if (!active) {
      record.interactions.clear();
      record.pendingInterrupt = false;
      record.resolveRun?.();
      record.resolveRun = undefined;
      record.rejectRun = undefined;
    }
    if (record.foreground && record.dispatch) {
      record.dispatch({
        type: 'RECONCILE_RUNTIME_PROJECTION',
        active,
        ...(interaction === undefined ? {} : { interaction }),
      });
    }
  }

  #applyEventFacts(record: NativeSessionRecord, event: RuntimeClientEvent): void {
    if (event.type === 'user.message') record.conversationHistory.push(event.text);
    if (event.type === 'model.cache') {
      record.tokenStats.cacheHitTokens = event.cacheHitTokens;
      record.tokenStats.cacheMissTokens = event.cacheMissTokens;
      record.tokenStats.totalTokens = event.inputTokens + (event.outputTokens ?? 0);
    }
    const interaction = interactionFromEvent(event);
    if (interaction) record.interactions.set(interaction.interactionId, interaction);
    if (isSettlingEvent(event)) record.interactions.delete(event.interactionId);
    record.pendingInterrupt = record.interactions.size > 0;
  }

  #syncSnapshot(record: NativeSessionRecord): void {
    const current = this.#runtime.snapshotStore.getSnapshot().sessions[record.threadId];
    if (!current) return;
    record.projection = current.projection;
    record.revision = Math.max(record.revision, current.projection.revision);
    record.agentLoopActive = isActiveWork(current.projection.activeWork);
    if (current.projection.displayName) record.name = current.projection.displayName;
  }

  async #resolveRunAfterRemoteIdle(record: NativeSessionRecord): Promise<void> {
    const resolveRun = record.resolveRun;
    const rejectRun = record.rejectRun;
    try {
      const deadline = Date.now() + RUN_WAIT_DEADLINE_MS;
      while (!this.#closed && Date.now() < deadline) {
        const result = await this.#runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: record.threadId,
        });
        if (
          result.status === 'ok' &&
          result.queryType === 'get_session_projection' &&
          result.session
        ) {
          record.projection = result.session;
          record.revision = result.session.revision;
          if (!isActiveWork(result.session.activeWork)) {
            record.agentLoopActive = false;
            if (record.resolveRun === resolveRun) resolveRun?.();
            return;
          }
        }
        await Bun.sleep(25);
      }
      throw new Error('Runtime execution did not reach its cleanup barrier.');
    } catch (error) {
      if (record.rejectRun === rejectRun) rejectRun?.(error);
    }
  }

  #view(record: NativeSessionRecord | undefined): TuiSessionFacade | undefined {
    if (!record) return undefined;
    const existing = this.#views.get(record.threadId);
    if (existing) return existing;

    const view: TuiSessionFacade = {
      get threadId() {
        return record.threadId;
      },
      get workspace() {
        return record.workspace;
      },
      get agentLoopActive() {
        return record.agentLoopActive;
      },
      get pendingInterrupt() {
        return record.pendingInterrupt;
      },
      set pendingInterrupt(value: boolean) {
        record.pendingInterrupt = value;
      },
      get name() {
        return record.name;
      },
      get eventBuffer() {
        return record.eventBuffer;
      },
      get modelProvider() {
        return record.projection?.model?.provider ?? '';
      },
      get modelName() {
        return record.projection?.model?.name ?? '';
      },
      get reasoningEnabled() {
        return record.projection?.model?.reasoningEnabled ?? true;
      },
      get conversationHistory() {
        return record.conversationHistory;
      },
      set conversationHistory(value: string[]) {
        record.conversationHistory.splice(0, record.conversationHistory.length, ...value);
      },
      get thinkingLevel() {
        return record.thinkingLevel;
      },
      set thinkingLevel(value: string | null) {
        record.thinkingLevel = value;
      },
      get interactionMode() {
        return record.interactionMode;
      },
      set interactionMode(value) {
        record.interactionMode = value;
      },
      get dormant() {
        return record.dormant;
      },
      set dormant(value) {
        record.dormant = value;
      },
      get localReplayRecovery() {
        return record.localReplayRecovery;
      },
      set localReplayRecovery(value) {
        record.localReplayRecovery = value;
      },
      tryReservePrompt: () => {
        if (record.reserved || record.agentLoopActive) return false;
        record.reserved = true;
        return true;
      },
      waitForRunCompletion: () => this.#waitForRunCompletion(record),
      runTask: (
        task: string,
        dependencies: TuiSessionRunDependencies,
        requestedPhase?: import('@kite-ai/runtime-contract').AgentPhase,
        initialSkills?: TuiInitialSkillActivation[],
      ) => this.#runTask(record, task, dependencies, requestedPhase, initialSkills),
      abort: () => {
        void this.#cancelRuntime(record).catch(() => undefined);
      },
      setForeground: (foreground: boolean) => {
        record.foreground = foreground;
      },
      setInteractionMode: (mode) => {
        record.interactionMode = mode;
        record.commandBarrier = record.commandBarrier.then(() =>
          this.#setInteractionMode(record, mode),
        );
        void record.commandBarrier.catch(() => undefined);
      },
      setDormant: (value: boolean) => {
        record.dormant = value;
      },
      setLocalReplayRecovery: (value: boolean) => {
        record.localReplayRecovery = value;
      },
      setInteractionModeMirror: (mode) => {
        record.interactionMode = mode;
      },
      setThinkingLevel: (value: string | null) => {
        record.thinkingLevel = value;
      },
      setConversationHistory: (value: readonly string[]) => {
        record.conversationHistory.splice(0, record.conversationHistory.length, ...value);
      },
      appendBufferedEvents: (events: readonly RuntimePresentationEvent[]) => {
        record.eventBuffer.push(...events);
      },
    };
    this.#views.set(record.threadId, view);
    return view;
  }

  async #runTask(
    record: NativeSessionRecord,
    task: string,
    dependencies: TuiSessionRunDependencies,
    requestedPhase?: import('@kite-ai/runtime-contract').AgentPhase,
    initialSkills?: TuiInitialSkillActivation[],
  ): Promise<void> {
    await this.#waitForSessionReady(record.threadId);
    await record.commandBarrier;
    this.#assertOpen();
    record.dispatch = dependencies.dispatch;
    record.agentLoopActive = true;
    record.reserved = false;
    const completion = new Promise<void>((resolve, reject) => {
      record.resolveRun = resolve;
      record.rejectRun = reject;
    });
    record.runPromise = completion;
    try {
      const expectedRevision = this.#revision(record);
      // Fence an event-free projection before sending the command. RuntimeClient
      // can receive the next subscription message before this async continuation
      // observes the accepted receipt.
      record.runProjectionRevisionFloor = expectedRevision + 1;
      const receipt = await this.#runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: this.#nextCommandId(record.threadId, 'turn'),
        type: 'start_turn',
        sessionId: record.threadId,
        expectedRevision,
        input: task,
        ...(requestedPhase === undefined ? {} : { phase: requestedPhase }),
        ...(initialSkills === undefined ? {} : { initialSkills }),
      });
      this.#assertApplied(receipt);
      this.#recordRevision(record, receipt);
      record.runProjectionRevisionFloor =
        receipt.status === 'applied'
          ? receipt.revision
          : receipt.status === 'idempotent_replay'
            ? receipt.originalRevision
            : expectedRevision + 1;
      this.#syncSnapshot(record);
      await withDeadline(completion, RUN_WAIT_DEADLINE_MS, 'Runtime turn');
      await this.#flushPresentation?.();
    } catch (error) {
      record.rejectRun?.(error);
      throw error;
    } finally {
      record.resolveRun = undefined;
      record.rejectRun = undefined;
      record.runPromise = undefined;
      record.runProjectionRevisionFloor = undefined;
      record.agentLoopActive = false;
      record.reserved = false;
      this.#snapshotCallback?.(record.threadId);
    }
  }

  async #waitForRunCompletion(record: NativeSessionRecord): Promise<void> {
    await this.#waitForSessionReady(record.threadId);
    await record.runPromise;
  }

  async #setInteractionMode(
    record: NativeSessionRecord,
    mode: 'accept_edits' | 'auto' | 'full',
  ): Promise<void> {
    await this.#waitForSessionReady(record.threadId);
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(record.threadId, 'mode'),
      type: 'set_interaction_mode',
      sessionId: record.threadId,
      expectedRevision: this.#revision(record),
      mode,
    });
    this.#assertApplied(receipt);
    this.#recordRevision(record, receipt);
  }

  async #submitUserAction(action: TuiSubmittedInteractionAction): Promise<void> {
    const matchingRecords = [...this.#sessions.values()].filter((candidate) =>
      candidate.interactions.has(action.interactionId),
    );
    if (matchingRecords.length > 1) {
      throw new Error('The Runtime interaction is ambiguous across sessions.');
    }
    const record = matchingRecords[0] ?? this.#sessions.get(this.#activeId);
    if (!record) throw new Error('The active Runtime session is unavailable.');
    const pendingInteraction = record.interactions.get(action.interactionId);
    if (!pendingInteraction) {
      if (action.type === 'cancel') {
        await this.#cancelRuntime(record);
        return;
      }
      throw new Error('The Runtime interaction is no longer pending.');
    }
    const commandId = this.#nextCommandId(record.threadId, 'interaction');
    await this.#waitForSessionReady(record.threadId);
    let interaction = pendingInteraction;
    let expectedRevision = interaction.sessionRevision;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const command = interactionCommandForAction(
        record.threadId,
        commandId,
        expectedRevision,
        interaction,
        action,
      );
      if (!command) throw new Error('The Runtime interaction response does not match its request.');
      const receipt = await this.#runtime.command(command);
      if (
        receipt.status === 'conflict' &&
        receipt.code === 'revision_conflict' &&
        receipt.currentRevision !== undefined &&
        attempt < 2
      ) {
        // The interaction identity remains fenced by its original
        // sessionRevision/generation. Unrelated durable events may advance the
        // Host CAS without republishing that interaction, so retry the same
        // command id at the proven current revision instead of waiting forever
        // for an interaction refresh that is not part of the contract.
        expectedRevision = receipt.currentRevision;
        record.revision = Math.max(record.revision, receipt.currentRevision);
        continue;
      }
      if (receipt.status === 'rejected' && receipt.code === 'interaction_mismatch' && attempt < 2) {
        // Provider recovery persists `provider.action_started` before the Host publishes the
        // final pending interaction identity. A fast user can answer the preceding durable
        // notice first. This rejection proves no mutation was applied; wait only for the
        // exact newer interaction projection and retry the same command id once it arrives.
        const refreshed = await this.#waitForInteractionRefresh(
          record,
          action.interactionId,
          interaction.sessionRevision,
        );
        if (!refreshed) throw new Error('The Runtime interaction identity could not be refreshed.');
        interaction = refreshed;
        expectedRevision = refreshed.sessionRevision;
        continue;
      }
      this.#assertApplied(receipt);
      return;
    }
    throw new Error('The Runtime interaction could not be accepted.');
  }

  async #waitForInteractionRefresh(
    record: NativeSessionRecord,
    interactionId: string,
    afterRevision: number,
  ): Promise<RuntimeClientInteraction | undefined> {
    const deadline = Date.now() + 1_000;
    while (!this.#closed && Date.now() < deadline) {
      const current = record.interactions.get(interactionId);
      if (current && current.sessionRevision > afterRevision) return current;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  async #cancelRuntimeOperations(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    await this.#cancelRuntime(record);
    await this.#waitForRunCompletion(record);
  }

  async #cancelRuntime(record: NativeSessionRecord): Promise<void> {
    await this.#waitForSessionReady(record.threadId);
    const work = record.projection?.activeWork;
    if (!isActiveWork(work)) return;
    const activeWork = work;
    const turnId = activeWork.activeTurn?.turnId ?? record.threadId;
    let expectedRevision = this.#revision(record);
    for (let attempt = 0; attempt < CANCEL_RETRY_LIMIT; attempt += 1) {
      const receipt = await this.#runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: this.#nextCommandId(record.threadId, 'cancel'),
        type: 'cancel_turn',
        sessionId: record.threadId,
        expectedRevision,
        turnId,
      });
      if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
      if (receipt.status === 'not_found' && receipt.code === 'turn_not_found') return;
      if (
        receipt.status === 'conflict' &&
        receipt.code === 'revision_conflict' &&
        receipt.currentRevision !== undefined
      ) {
        this.#syncSnapshot(record);
        if (!isActiveWork(record.projection?.activeWork)) return;
        expectedRevision = receipt.currentRevision;
        continue;
      }
      throw new Error(`Runtime cancellation rejected: ${receipt.code}`);
    }
    throw new Error('Runtime cancellation rejected: revision_conflict');
  }

  #abortAll(): Promise<void> {
    const operations = [...this.#sessions.values()]
      .filter((record) => isActiveWork(record.projection?.activeWork))
      .map((record) => this.#cancelRuntime(record));
    return Promise.all(operations).then(() => undefined);
  }

  async #deletePersistedSession(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error(`Runtime session is unavailable: ${sessionId}`);
    await this.#cancelRuntimeOperations(sessionId);
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(sessionId, 'delete'),
      type: 'delete_session',
      sessionId,
      expectedRevision: this.#revision(record),
    });
    this.#assertApplied(receipt);
    await this.#removeRuntime(sessionId);
  }

  async #removeRuntime(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    record.subscriptionController?.abort();
    record.rejectReady(new Error('TUI Runtime session was removed before it became ready.'));
    record.rejectRun?.(new Error('TUI Runtime session was removed.'));
    for (const waiter of record.rewindWaiters.values()) {
      waiter.reject(new Error('TUI Runtime session was removed.'));
    }
    record.rewindWaiters.clear();
    this.#sessions.delete(sessionId);
    this.#views.delete(sessionId);
    if (this.#activeId === sessionId) this.#activeId = '';
  }

  #switchSession(fromId: string, toId: string): void {
    if (!this.#sessions.has(toId)) throw new Error(`Runtime session is unavailable: ${toId}`);
    const previous = this.#sessions.get(fromId);
    if (previous) previous.foreground = false;
    this.#sessions.get(toId)!.foreground = true;
    this.#setActive(toId);
  }

  #setActive(sessionId: string): void {
    for (const record of this.#sessions.values()) record.foreground = record.threadId === sessionId;
    this.#activeId = sessionId;
  }

  #getSnapshot(
    previous?: ReadonlyArray<{ threadId: string; status: SessionStatusProjection }>,
  ): SessionListProjection[] {
    const previousStatus = new Map(previous?.map((item) => [item.threadId, item.status]));
    return [...this.#sessions.values()].map((record) => {
      const status = statusForRecord(record, previousStatus.get(record.threadId));
      return {
        threadId: record.threadId,
        name: record.name,
        workspace: record.workspace,
        active: record.threadId === this.#activeId,
        running: record.agentLoopActive,
        pendingInterrupt: record.pendingInterrupt,
        interrupt: null,
        plan: null,
        interactionMode: record.interactionMode,
        status,
        turns: [],
        pendingToolCalls: {},
      };
    });
  }

  async #getSessionProjection(sessionId: string): Promise<RuntimeSessionProjection | null> {
    await this.#waitForSessionReady(sessionId);
    const result = await this.#runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (result.status !== 'ok' || result.queryType !== 'get_session_projection') return null;
    const record = this.#sessions.get(sessionId);
    if (record && result.session) {
      record.projection = result.session;
      record.revision = result.session.revision;
    }
    return result.session ?? null;
  }

  async #listRewindCheckpoints(sessionId: string): Promise<readonly RuntimeCheckpointProjection[]> {
    await this.#waitForSessionReady(sessionId);
    const result = await this.#runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_checkpoints',
      sessionId,
    });
    return result.status === 'ok' && result.queryType === 'list_checkpoints'
      ? (result.checkpoints ?? [])
      : [];
  }

  async #previewRewind(
    sessionId: string,
    checkpointId: string,
  ): Promise<RuntimeRewindPreviewProjection | null> {
    await this.#waitForSessionReady(sessionId);
    const result = await this.#runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_rewind_preview',
      sessionId,
      checkpointId,
    });
    return result.status === 'ok' && result.queryType === 'get_rewind_preview'
      ? (result.rewindPreview ?? null)
      : null;
  }

  async #executeRewind(input: TuiRewindRequest): Promise<TuiRewindResult> {
    const record = this.#sessions.get(input.sourceThreadId);
    if (!record) throw new Error(`Runtime session is unavailable: ${input.sourceThreadId}`);
    await this.#waitForSessionReady(input.sourceThreadId);
    const commandId = this.#nextCommandId(input.sourceThreadId, 'rewind');
    let resolveTerminal!: (event: Extract<RuntimeClientEvent, { type: 'rewind.terminal' }>) => void;
    let rejectTerminal!: (error: unknown) => void;
    const terminal = new Promise<Extract<RuntimeClientEvent, { type: 'rewind.terminal' }>>(
      (resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      },
    );
    record.rewindWaiters.set(commandId, {
      resolve: resolveTerminal,
      reject: rejectTerminal,
    });
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId,
      type: 'rewind_session',
      sessionId: input.sourceThreadId,
      expectedRevision: this.#revision(record),
      checkpointId: input.snapshotId,
      scope: input.scope === 'code_and_conversation' ? 'conversation_and_workspace' : input.scope,
    });
    try {
      this.#assertApplied(receipt);
      this.#recordRevision(record, receipt);
    } catch (error) {
      record.rewindWaiters.delete(commandId);
      throw error;
    }
    const outcome = await withDeadline(terminal, RUN_WAIT_DEADLINE_MS, 'Runtime rewind');
    if (outcome.status === 'failed') {
      throw new Error(`Runtime rewind failed: ${outcome.failureCode ?? 'execution_failed'}`);
    }
    const recoveredData =
      input.scope === 'code_only'
        ? null
        : await this.#history.loadPersistedSession(outcome.targetSessionId);
    return {
      targetThreadId: outcome.targetSessionId,
      recoveredData,
      fileOutcome: outcome.fileOutcome ?? null,
    };
  }

  async #forkRecoveredSessionForContinuation(
    sessionId: string,
  ): Promise<TuiSessionFacade | undefined> {
    const record = this.#sessions.get(sessionId);
    if (!record) return undefined;
    await this.#waitForSessionReady(sessionId);
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(sessionId, 'fork'),
      type: 'fork_session',
      sourceSessionId: sessionId,
      sourceRevision: this.#revision(record),
    });
    if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
      throw new Error(`Runtime fork rejected: ${receipt.code}`);
    }
    const targetSessionId = receipt.sessionId;
    const target = this.#newRecord(targetSessionId, record.workspace);
    target.localReplayRecovery = false;
    target.foreground = true;
    record.foreground = false;
    this.#setActive(targetSessionId);
    void this.#admitAndSubscribe(target, 'resume').catch(() => undefined);
    record.localReplayRecovery = false;
    return this.#view(target);
  }

  async #handleContextCompaction(
    sessionId: string,
    instructions?: string,
    onProgress?: TuiContextCompactionProgress,
    onCommand?: TuiContextCompactionCommand,
  ): Promise<TuiContextCompactionResult> {
    await this.#waitForSessionReady(sessionId);
    onProgress?.('preparing');
    const commandId = this.#nextCommandId(sessionId, 'compact');
    onCommand?.({ type: 'user.command_invoked', commandId, command: '/compact' });
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId,
      type: 'compact_session',
      sessionId,
      expectedRevision: this.#revision(this.#sessions.get(sessionId)!),
      mode: 'manual',
      ...(instructions === undefined ? {} : { instructions }),
    });
    this.#assertApplied(receipt);
    onProgress?.('validating');
    return { events: [], text: 'Context compaction requested.' };
  }

  async #handleContextReset(sessionId: string): Promise<TuiContextCompactionResult> {
    await this.#waitForSessionReady(sessionId);
    const record = this.#sessions.get(sessionId)!;
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(sessionId, 'reset'),
      type: 'compact_session',
      sessionId,
      expectedRevision: this.#revision(record),
      mode: 'reset',
    });
    this.#assertApplied(receipt);
    return { events: [], text: 'Context reset requested.' };
  }

  #handleContextDisplay(sessionId: string): string {
    const context = this.#sessions.get(sessionId)?.context;
    if (!context) return 'Context usage is unavailable until the Service returns a snapshot.';
    return `${context.usedTokens ?? 0} / ${context.availableTokens ?? 0} tokens`;
  }

  async #generateSessionName(_sessionId: string, task: string): Promise<string | null> {
    const name = task.trim().split(/\s+/u).slice(0, 8).join(' ').slice(0, 80);
    return name || null;
  }

  #applyPersistedModelRoute(
    _threadId: string,
    provider?: string,
    name?: string,
  ): TuiModelRouteProjection {
    return {
      provider: provider ?? '',
      name: name ?? '',
      reasoningEnabled: true,
    };
  }

  async #clearSessionCommandGrants(sessionId: string): Promise<RuntimeCommandReceipt> {
    await this.#waitForSessionReady(sessionId);
    const record = this.#sessions.get(sessionId)!;
    const receipt = await this.#runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: this.#nextCommandId(sessionId, 'clear-grants'),
      type: 'clear_session_command_grants',
      sessionId,
      expectedRevision: this.#revision(record),
    });
    this.#assertApplied(receipt);
    return receipt;
  }

  async #dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeSnapshot();
    // RuntimeClient.close() closes all local subscription queues as part of
    // the same client teardown. Aborting first would race its unsubscribe
    // request against connection close and create an unhandled request error.
    const closedError = new Error('TUI Runtime client is closed.');
    for (const record of this.#sessions.values()) {
      record.rejectReady(closedError);
      record.rejectRun?.(closedError);
      for (const waiter of record.rewindWaiters.values()) waiter.reject(closedError);
      record.rewindWaiters.clear();
    }
    this.#sessions.clear();
    this.#views.clear();
    // This is intentionally the Runtime Client connection close only. It
    // cannot call a Service Host/Store dispose or an implicit cancel-all.
    await this.#connection.close('tui_client_closed');
  }

  #assertWorkspace(workspace: string): void {
    if (workspace !== this.#workspace) {
      throw new Error('TUI Runtime Workspace is outside the admitted Service scope.');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('TUI Runtime client is closed.');
  }

  #revision(record: NativeSessionRecord): number {
    this.#syncSnapshot(record);
    return record.revision;
  }

  #recordRevision(record: NativeSessionRecord, receipt: RuntimeCommandReceipt): void {
    if (receipt.status === 'applied') record.revision = Math.max(record.revision, receipt.revision);
  }

  #nextCommandId(sessionId: string, operation: string): string {
    const key = `${sessionId}:${operation}`;
    const next = (this.#commandIds.get(key) ?? 0) + 1;
    this.#commandIds.set(key, next);
    return `tui-${operation}-${next}-${this.#commandNonce}-${sessionId}`;
  }

  #assertApplied(receipt: RuntimeCommandReceipt): void {
    if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
    throw new Error(`Runtime command rejected: ${receipt.code}`);
  }
}

function isRuntimeNotification(value: RuntimeAccessNotification): value is RuntimeNotification {
  return 'durability' in value;
}

function isActiveWork(
  work: RuntimeSessionProjection['activeWork'],
): work is NonNullable<RuntimeSessionProjection['activeWork']> {
  return (
    work !== undefined &&
    (work.status === 'queued' || work.status === 'running' || work.status === 'waiting')
  );
}

function isTerminalEvent(event: RuntimeClientEvent): boolean {
  return (
    event.type === 'run.terminal' ||
    event.type === 'turn.terminal' ||
    event.type === 'task.terminal' ||
    event.type === 'run.failure'
  );
}

function isSettlingEvent(
  event: RuntimeClientEvent,
): event is Extract<RuntimeClientEvent, { interactionId: string }> {
  return (
    event.type === 'interaction.settled' ||
    event.type === 'approval.granted' ||
    event.type === 'approval.rejected' ||
    event.type === 'input.answered' ||
    event.type === 'input.cancelled' ||
    event.type === 'plan.approved'
  );
}

function interactionFromEvent(event: RuntimeClientEvent): RuntimeClientInteraction | undefined {
  switch (event.type) {
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
    case 'provider.action':
    case 'verification.status':
      return event.interaction;
    default:
      return undefined;
  }
}

function interactionCommandForAction(
  sessionId: string,
  commandId: string,
  expectedRevision: number,
  interaction: RuntimeClientInteraction,
  action: TuiSubmittedInteractionAction,
): Extract<RuntimeCommand, { readonly type: 'respond_interaction' }> | null {
  const base = {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'respond_interaction' as const,
    sessionId,
    // The interaction revision is part of the exact command identity as well as the CAS.
    expectedRevision,
  };
  switch (interaction.kind) {
    case 'approval': {
      if (action.type !== 'approve' && action.type !== 'reject' && action.type !== 'cancel') {
        return null;
      }
      return {
        ...base,
        interaction,
        response: {
          kind: 'approval',
          decision: action.type === 'approve' ? action.grant : 'reject',
        },
      };
    }
    case 'input': {
      if (action.type !== 'input' && action.type !== 'cancel') return null;
      return {
        ...base,
        interaction,
        response:
          action.type === 'input' ? { kind: 'text', value: action.text } : { kind: 'input_cancel' },
      };
    }
    case 'plan_review': {
      if (action.type === 'plan_review_decision') {
        return {
          ...base,
          interaction,
          response: {
            kind: 'plan_review',
            decision:
              action.decision.kind === 'approve'
                ? action.decision.nextMode
                : action.decision.kind === 'revise'
                  ? 'feedback'
                  : 'cancel',
            ...(action.decision.kind === 'revise' ? { feedback: action.decision.feedback } : {}),
          },
        };
      }
      if (action.type !== 'cancel') return null;
      return { ...base, interaction, response: { kind: 'plan_review', decision: 'cancel' } };
    }
    case 'provider_action': {
      if (action.type === 'cancel') {
        return {
          ...base,
          interaction,
          response: { kind: 'provider_action', outcome: 'cancelled' },
        };
      }
      if (action.type !== 'input' || !action.optionId) return null;
      const outcome =
        action.optionId === 'retry' || action.optionId === 'recover'
          ? ('completed' as const)
          : action.optionId === 'waive' || action.optionId === 'defer'
            ? ('deferred' as const)
            : action.optionId === 'cancel'
              ? ('cancelled' as const)
              : undefined;
      return outcome
        ? { ...base, interaction, response: { kind: 'provider_action', outcome } }
        : null;
    }
    case 'verification': {
      if (action.type !== 'cancel') return null;
      return {
        ...base,
        interaction,
        response: { kind: 'verification', decision: 'compensate', detail: 'Client cancelled.' },
      };
    }
  }
}

function statusForRecord(
  record: NativeSessionRecord,
  previous?: SessionStatusProjection,
): SessionStatusProjection {
  const work = record.projection?.activeWork;
  const cacheHitTokens = record.tokenStats.cacheHitTokens || previous?.cacheHitTokens || 0;
  const cacheMissTokens = record.tokenStats.cacheMissTokens || previous?.cacheMissTokens || 0;
  const totalTokens = record.tokenStats.totalTokens || previous?.totalTokens || 0;
  const totalCacheTokens = cacheHitTokens + cacheMissTokens;
  return {
    phase: work?.phase ?? previous?.phase ?? 'building',
    plan: null,
    pendingPlan: null,
    workspaceAccess: 'write',
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: totalCacheTokens > 0 ? cacheHitTokens / totalCacheTokens : 0,
    totalTokens,
    currentNode: null,
    modelProvider: previous?.modelProvider ?? '',
    modelName: previous?.modelName ?? '',
    thinkingMode: record.thinkingLevel ?? previous?.thinkingMode ?? '',
    reasoningEnabled: true,
    retryState: previous?.retryState ?? null,
    ...(record.context ? { contextSnapshot: toContextStatusSnapshot(record.context) } : {}),
  };
}

function toContextStatusSnapshot(
  context: RuntimeContextProjection,
): NonNullable<SessionStatusProjection['contextSnapshot']> {
  const totalInputTokens = context.usedTokens ?? 0;
  const availableTokens = context.availableTokens;
  const utilization =
    availableTokens && availableTokens > 0 ? totalInputTokens / availableTokens : undefined;
  return {
    estimate: {
      systemTokens: 0,
      toolSchemaTokens: 0,
      transcriptTokens: totalInputTokens,
      summaryTokens: 0,
      dynamicRuntimeTokens: 0,
      framingTokens: 0,
      totalInputTokens,
    },
    status:
      utilization !== undefined && utilization >= 0.94
        ? 'hard_limit'
        : utilization !== undefined && utilization >= 0.8
          ? 'warning'
          : 'normal',
    ...(availableTokens === undefined
      ? {}
      : { usableInputTokens: Math.max(0, availableTokens - totalInputTokens) }),
    ...(utilization === undefined ? {} : { utilization }),
  };
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value);
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
