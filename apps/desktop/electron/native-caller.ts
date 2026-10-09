import {
  type AgentClient,
  type AppliedCursor,
  ClientError,
  type CreateWorkspaceRequest,
  interactionAttachment,
  type Message,
  requiresInteractionAttachment,
  type Workspace,
} from '@kite-ai/client';
import {
  createDesktopController,
  type DesktopController,
  type DesktopSnapshot,
} from '../src/controller';
import type { DesktopEditor } from '../src/file-changes-bridge';
import { DesktopInput, inputMetadata } from '../src/input';
import type {
  NativeCreation,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../src/native-bridge';
import { NativeAnswerJournal } from './answer-journal';
import { NativeBackground } from './background';
import {
  callerCanonical,
  callerMetadata,
  callerTextDigest,
  NativeCallerJournal,
} from './caller-journal';
import { NativeConfiguration } from './configuration';
import { NativeContext } from './context';
import { NativeConversation } from './conversation';
import { NativeExtensions } from './extensions';
import { NativeFileChanges } from './file-changes';
import { NativeFileRecovery } from './file-recovery';
import { NativeInteractionAttachmentReads } from './interaction-attachment-reads';
import { NativeInteractionHistoryReads } from './interaction-history-reads';
import { NativeJobOutputReads } from './job-output-reads';
import { NativeMcpSettings } from './mcp-settings';
import { verifyNativeMcpSourceAnswer } from './mcp-source-answer';
import { NativeModelOutputReads } from './model-output-reads';
import { NativePermissionGrants } from './permission-grants';
import type { PrivateData } from './private-data';
import { NativeProviderSettings } from './provider-settings';
import { NativeRecovery } from './recovery';
import { NativeSessionManagement } from './session-management';
import { NativeSkillCatalogueReads } from './skill-catalogue-reads';
import { NativeToolMessages } from './tool-messages';
import { NativeWorkspaceRemovalPort } from './workspace-removal';

export class NativeCaller {
  private generation = 0;
  private selection = 0;
  private selected: string | undefined;
  private lastView: { selection: number; snapshot: DesktopSnapshot } | undefined;
  private contextWorkspace:
    | { sessionId: string; selection: number; workspaceId: string }
    | undefined;
  private closed = false;
  private permissionUnavailable = false;
  private observer: AbortController | undefined;
  private stream: Promise<void> | undefined;
  private refreshing: Promise<unknown> | undefined;
  private refreshRequested = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly outputReads: NativeModelOutputReads;
  private readonly inputReads: NativeModelOutputReads<'modelInput'>;
  private readonly attachmentReads: NativeInteractionAttachmentReads;
  private readonly grants: NativePermissionGrants;
  private readonly context: NativeContext;
  private readonly recovery: NativeRecovery;
  private readonly fileRecovery: NativeFileRecovery;
  private readonly sessions: NativeSessionManagement;
  private readonly workspaceRemoval: NativeWorkspaceRemovalPort;
  private readonly configuration: NativeConfiguration;
  private readonly inputConfiguration: NativeConfiguration;
  private readonly preparationConfiguration: NativeConfiguration;
  private readonly conversation: NativeConversation;
  private workspaceObservation?: { generation: number; storeId: string; workspaces: Workspace[] };
  private directory?: NativeDirectory;
  private directoryUnavailable = false;
  private directoryEnabled = false;
  private directoryRefreshing?: Promise<void>;
  private directoryRefreshRequested = false;
  private directoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private directoryEpoch = 0;
  private directoryRead?: {
    generation: number;
    epoch: number;
    abort: AbortController;
    promise: Promise<NativeDirectory>;
  };
  private readonly providers: NativeProviderSettings;
  private readonly mcp: NativeMcpSettings;
  private readonly skills: NativeSkillCatalogueReads;
  private readonly extensions: NativeExtensions;
  private readonly jobOutput: NativeJobOutputReads;
  private readonly fileChanges: NativeFileChanges;
  private readonly toolMessages: NativeToolMessages;
  private readonly interactionHistory: NativeInteractionHistoryReads;
  private readonly background: NativeBackground;
  private readonly environment: NativeBackground;
  private environmentRevision = 0;
  private readonly observedMessages = new Map<string, Message>();
  private historyEpoch = 0;
  private observationUnavailable = false;
  private resetHistory: { selection: number; sessionId: string; resolve: () => void } | undefined;
  private messageRead: { readId: string; abort: AbortController } | undefined;
  private inputDirectory: { readId: string; abort: AbortController } | undefined;
  private readonly cancellations = new Map<string, string>();
  private readonly creations = new Map<string, NativeCreation>();
  private readonly creating = new Map<string, Promise<NativeCreation>>();
  private readonly controller: DesktopController;
  private readonly input: DesktopInput;
  private readonly callerJournal: NativeCallerJournal | undefined;
  private readonly answerJournal: NativeAnswerJournal | undefined;
  private readonly callerReads = new Map<
    string,
    { commandId: string; body: string; hash: string; nextOffset: number }
  >();
  private readonly client: AgentClient;
  private readonly emit: (event: NativeEvent) => void;
  private readonly privateData: PrivateData | undefined;
  constructor(
    client: AgentClient,
    emit: (event: NativeEvent) => void,
    privateData?: PrivateData,
    protectedRoots: readonly string[] = [],
  ) {
    this.client = client;
    this.emit = emit;
    this.privateData = privateData;
    this.answerJournal = privateData ? new NativeAnswerJournal(client, privateData) : undefined;
    if (!client.serverInfo?.storeId) throw new ClientError('connection_not_admitted');
    try {
      for (const value of privateData?.creations() ?? []) {
        const original =
          value.phase === 'pending' ? privateData!.finish(value.input.commandId, 'unknown') : value;
        this.creations.set(original.input.commandId, original);
      }
    } catch {
      // Private user data failure does not prevent reading Service history.
    }
    this.controller = createDesktopController({
      admittedClient: client,
      readContextOnSelect: false,
      readActiveCommandOnSelect: true,
      onSnapshot: () => this.changed(),
      onPermissionSubmission: () => this.changed(),
      onInteractionSubmission: () => this.changed(),
      interactionAnswerJournal: {
        prepare: (submission, view) => this.requireAnswers().prepare(submission, view),
        finish: (submission) => this.requireAnswers().finish(submission),
        lookup: (submission) => this.requireAnswers().lookup(submission.intent.commandId),
      },
    });
    this.callerJournal = privateData ? new NativeCallerJournal(client, privateData) : undefined;
    this.workspaceRemoval = new NativeWorkspaceRemovalPort(
      client,
      () => this.privateData,
      () => {
        const info = this.client.serverInfo;
        return !this.closed && this.generation > 0 && info?.storeId && info.subjectId
          ? { generation: this.generation, storeId: info.storeId, subjectId: info.subjectId }
          : undefined;
      },
      (id) => {
        const observed = this.workspaceObservation;
        return !this.observationUnavailable &&
          observed?.generation === this.generation &&
          observed.storeId === this.client.serverInfo?.storeId
          ? observed.workspaces.find((w) => w.id === id)
          : undefined;
      },
      () => this.changed(),
    );
    this.background = new NativeBackground(
      client,
      () => {
        const info = this.client.serverInfo;
        return !this.closed &&
          !this.observationUnavailable &&
          this.generation > 0 &&
          info?.storeId &&
          info.subjectId
          ? { generation: this.generation, storeId: info.storeId, subjectId: info.subjectId }
          : undefined;
      },
      {
        prepare: (item, commandId) => this.requireCaller().prepareBackgroundStop(item, commandId),
        submit: (commandId) => this.requireCaller().submit(commandId),
      },
    );
    this.environment = new NativeBackground(
      client,
      () => {
        const info = this.client.serverInfo,
          snapshot = this.controller.snapshot;
        return !this.closed &&
          !this.observationUnavailable &&
          this.generation > 0 &&
          info?.storeId &&
          info.subjectId &&
          snapshot?.sessionId === this.selected &&
          snapshot?.view.storeId === info.storeId &&
          snapshot.view.session.parentSessionId === null &&
          snapshot.view.session.deletedAt === null
          ? {
              generation: this.generation,
              storeId: info.storeId,
              subjectId: info.subjectId,
              rootSessionId: snapshot.sessionId,
              viewSelection: this.selection,
            }
          : undefined;
      },
      {
        prepare: (item, commandId) => this.requireCaller().prepareBackgroundStop(item, commandId),
        submit: (commandId) => this.requireCaller().submit(commandId),
      },
    );
    this.input = new DesktopInput({
      admittedClient: client,
      onSubmission: () => this.changed(),
      caller: {
        submit: async (sessionId, intent) => {
          const journal = this.requireCaller();
          await journal.prepare(sessionId, intent);
          return journal.submit(intent.commandId);
        },
        lookup: (commandId) => this.requireCaller().lookup(commandId),
      },
    });
    const preparationScope = () =>
      !this.closed && !this.observationUnavailable && this.generation > 0
        ? { generation: this.generation, storeId: this.client.serverInfo!.storeId! }
        : undefined;
    this.preparationConfiguration = new NativeConfiguration(client, () => {
      const scope = preparationScope();
      return scope ? { ...scope, selection: 0 } : undefined;
    });
    this.conversation = new NativeConversation(
      client,
      preparationScope,
      (id) => {
        const scope = preparationScope(),
          observed = this.workspaceObservation;
        return scope &&
          observed?.generation === scope.generation &&
          observed.storeId === scope.storeId
          ? observed.workspaces.find((workspace) => workspace.id === id)
          : undefined;
      },
      () => this.requirePrivateData(),
      (input, onFirst) => this.create(input, onFirst),
      (commandId) => this.lookupCreation(commandId),
      () => this.requireCaller(),
      this.input,
      () => this.hasActiveWork(),
      () => this.changed(),
      protectedRoots,
    );
    const current = () =>
      !this.closed && this.selected
        ? {
            generation: this.generation,
            selection: this.selection,
            storeId: this.client.serverInfo!.storeId!,
            sessionId: this.selected,
          }
        : undefined;
    this.outputReads = new NativeModelOutputReads(client, current);
    const messageScope = () => {
      const scope = current(),
        fresh = this.controller.snapshot;
      // An ordinary observation refresh temporarily clears the controller snapshot.
      // The same verified reading identity remains valid; reset/selection still releases it.
      const snapshot = scope
        ? fresh?.sessionId === scope.sessionId
          ? fresh
          : this.lastView?.selection === scope.selection &&
              this.lastView.snapshot.sessionId === scope.sessionId
            ? this.lastView.snapshot
            : undefined
        : undefined;
      return scope &&
        !this.observationUnavailable &&
        snapshot?.sessionId === scope.sessionId &&
        snapshot.view.storeId === scope.storeId
        ? {
            generation: scope.generation,
            viewSelection: scope.selection,
            historyEpoch: this.historyEpoch,
            storeId: scope.storeId,
            sessionId: scope.sessionId,
            workspaceId: snapshot.view.session.workspaceId,
          }
        : undefined;
    };
    this.toolMessages = new NativeToolMessages(client, messageScope, () => this.observedMessages);
    this.interactionHistory = new NativeInteractionHistoryReads(client, messageScope);
    this.extensions = new NativeExtensions(
      client,
      () => {
        const scope = messageScope(),
          fresh = this.controller.snapshot,
          snapshot =
            fresh?.sessionId === this.selected
              ? fresh
              : this.lastView?.selection === this.selection
                ? this.lastView.snapshot
                : undefined;
        return scope &&
          snapshot?.sessionId === scope.sessionId &&
          snapshot.view.session.parentSessionId === null &&
          snapshot.view.session.deletedAt === null
          ? { ...scope, contextSelectionId: snapshot.view.session.contextSelectionId }
          : undefined;
      },
      {
        prepare: (sessionId, request) => this.requireCaller().prepare(sessionId, request),
        submit: (commandId) => this.requireCaller().submit(commandId),
        lookup: (commandId) => this.requireCaller().lookup(commandId),
        records: () => this.requireCaller().records(),
        releaseFirst: (commandId) => this.requireCaller().releaseFirst(commandId),
      },
    );
    this.fileChanges = new NativeFileChanges(
      client,
      messageScope,
      (id) => this.observedMessages.get(id),
      (id) => {
        const observed = this.workspaceObservation;
        return !this.observationUnavailable &&
          observed?.generation === this.generation &&
          observed.storeId === this.client.serverInfo?.storeId
          ? observed.workspaces.find((workspace) => workspace.id === id)
          : undefined;
      },
      protectedRoots,
    );
    this.jobOutput = new NativeJobOutputReads(client, (executionId) => {
      const scope = current(),
        snapshot = this.controller.snapshot,
        execution = snapshot?.view.executions.find((item) => item.id === executionId);
      if (
        !scope ||
        this.observationUnavailable ||
        !snapshot ||
        snapshot.sessionId !== scope.sessionId ||
        snapshot.view.storeId !== scope.storeId ||
        !execution ||
        !execution.originStoreId ||
        execution.sessionId !== scope.sessionId ||
        execution.kind !== 'job'
      )
        return undefined;
      return {
        generation: scope.generation,
        viewSelection: scope.selection,
        historyEpoch: this.historyEpoch,
        storeId: scope.storeId,
        originStoreId: execution.originStoreId,
        sessionId: scope.sessionId,
        workspaceId: snapshot.view.session.workspaceId,
        executionId,
      };
    });
    this.skills = new NativeSkillCatalogueReads(client, () => {
      const scope = current(),
        snapshot = this.controller.snapshot;
      return scope && snapshot?.sessionId === scope.sessionId
        ? {
            generation: scope.generation,
            viewSelection: scope.selection,
            historyEpoch: this.historyEpoch,
            storeId: scope.storeId,
            sessionId: scope.sessionId,
            workspaceId: snapshot.view.session.workspaceId,
          }
        : undefined;
    });
    this.attachmentReads = new NativeInteractionAttachmentReads(
      this.controller.readInteractionAttachment.bind(this.controller),
      () => {
        const scope = current(),
          snapshot = this.controller.snapshot;
        return scope && snapshot?.sessionId === scope.sessionId
          ? { ...scope, interactions: snapshot.interactions }
          : undefined;
      },
    );
    this.configuration = new NativeConfiguration(
      client,
      () =>
        !this.closed
          ? {
              generation: this.generation,
              selection: this.selection,
              storeId: this.client.serverInfo!.storeId!,
              ...(this.selected ? { sessionId: this.selected } : {}),
            }
          : undefined,
      () => this.changed(),
      privateData,
    );
    const configurationScope = () =>
      !this.closed
        ? {
            generation: this.generation,
            selection: this.selection,
            storeId: this.client.serverInfo!.storeId!,
            ...(this.selected ? { sessionId: this.selected } : {}),
          }
        : undefined;
    this.inputConfiguration = new NativeConfiguration(client, configurationScope);
    this.providers = new NativeProviderSettings(
      client,
      configurationScope,
      () => this.changed(),
      privateData,
    );
    this.mcp = new NativeMcpSettings(
      client,
      current,
      () => this.changed(),
      privateData,
      async (row, executionId) => {
        if (
          client.serverInfo?.storeId !== row.request.expectedStoreId ||
          client.serverInfo.subjectId !== row.subjectId
        )
          throw new ClientError('mcp_cancel_scope_unavailable');
        const journal = this.requireCaller();
        const prior = journal
          .records()
          .find(
            (record) =>
              record.intent.request.kind === 'execution.cancel' &&
              record.intent.request.executionId === executionId &&
              record.intent.scope.storeId === row.request.expectedStoreId &&
              record.intent.scope.sessionId === row.sessionId &&
              record.intent.subjectId === row.subjectId,
          );
        const commandId =
          prior?.intent.request.commandId ??
          this.cancellations.get(`mcp:${executionId}`) ??
          crypto.randomUUID();
        this.cancellations.set(`mcp:${executionId}`, commandId);
        if (!prior)
          await journal.prepare(row.sessionId, {
            kind: 'execution.cancel',
            commandId,
            expectedStoreId: row.request.expectedStoreId,
            executionId,
          });
        await journal.submit(commandId);
      },
    );
    this.fileRecovery = new NativeFileRecovery(client, current, () => this.changed(), privateData);
    this.recovery = new NativeRecovery(client, current, () => this.changed(), privateData);
    this.sessions = new NativeSessionManagement(client, current, () => this.changed());
    this.inputReads = new NativeModelOutputReads(client, current, 'modelInput');
    this.grants = new NativePermissionGrants(
      client,
      () => {
        const scope = current(),
          snapshot = this.controller.snapshot;
        if (!scope) return undefined;
        const workspaceId =
          snapshot?.sessionId === scope.sessionId
            ? snapshot.view.session.workspaceId
            : this.contextWorkspace?.sessionId === scope.sessionId &&
                this.contextWorkspace.selection === scope.selection
              ? this.contextWorkspace.workspaceId
              : undefined;
        return workspaceId ? { ...scope, workspaceId } : undefined;
      },
      () => this.changed(),
    );
    this.context = new NativeContext(
      client,
      () => {
        const scope = current(),
          snapshot = this.controller.snapshot;
        if (!scope) return undefined;
        const workspaceId =
          snapshot?.sessionId === scope.sessionId
            ? snapshot.view.session.workspaceId
            : this.contextWorkspace?.sessionId === scope.sessionId &&
                this.contextWorkspace.selection === scope.selection
              ? this.contextWorkspace.workspaceId
              : undefined;
        return workspaceId ? { ...scope, workspaceId } : undefined;
      },
      () => this.changed(),
    );
  }
  private requireCaller() {
    if (!this.callerJournal) throw new ClientError('caller_storage_unavailable');
    return this.callerJournal;
  }
  private requireAnswers() {
    if (!this.answerJournal) throw new ClientError('answer_storage_unavailable');
    return this.answerJournal;
  }
  private requirePrivateData() {
    if (!this.privateData) throw new ClientError('draft_storage_unavailable');
    return this.privateData;
  }
  private changed() {
    if (!this.closed) this.emit({ generation: this.generation, kind: 'changed' });
  }
  private check(generation: number) {
    if (this.closed || generation !== this.generation)
      throw new ClientError('native_generation_changed');
  }
  private selectScope(sessionId: string) {
    const snapshot = this.controller.snapshot;
    if (!snapshot || this.selected !== sessionId || snapshot.sessionId !== sessionId)
      throw new ClientError('native_selection_changed');
    return snapshot;
  }
  private writableScope(sessionId: string) {
    const snapshot = this.selectScope(sessionId);
    if (snapshot.view.session.parentSessionId !== null)
      throw new ClientError('child_session_readonly');
    return snapshot;
  }
  private releaseReads() {
    this.environment.release();
    this.controller.cancelInteractionRead();
    this.callerReads.clear();
    this.configuration.release();
    this.inputConfiguration.release();
    this.providers.release();
    this.mcp.release();
    this.skills.release();
    this.extensions.release();
    this.jobOutput.release();
    this.fileChanges.release();
    this.toolMessages.release();
    this.interactionHistory.release();
    this.resetHistory?.resolve();
    this.resetHistory = undefined;
    this.messageRead?.abort.abort();
    this.messageRead = undefined;
    this.outputReads.release();
    this.inputReads.release();
    this.attachmentReads.release();
    this.inputDirectory?.abort.abort();
    this.grants.release();
    this.context.release();
    this.recovery.release();
    this.fileRecovery.release();
    this.sessions.release();
    this.observedMessages.clear();
  }
  private invalidateDirectory(clear = false) {
    this.directoryEpoch++;
    this.directoryRead?.abort.abort();
    this.directoryRead = undefined;
    this.directoryRefreshing = undefined;
    this.directoryRefreshRequested = false;
    clearTimeout(this.directoryRefreshTimer);
    this.directoryRefreshTimer = undefined;
    this.directoryUnavailable = true;
    this.workspaceObservation = undefined;
    if (clear) this.directory = undefined;
  }
  private directoryState(): NativeDirectory | undefined {
    return this.directory
      ? { ...this.directory, unavailable: this.directoryUnavailable || this.observationUnavailable }
      : undefined;
  }
  private async readDirectory(): Promise<NativeDirectory> {
    const generation = this.generation,
      epoch = this.directoryEpoch;
    if (this.directoryRead?.generation === generation && this.directoryRead.epoch === epoch)
      return this.directoryRead.promise;
    const abort = new AbortController(),
      storeId = this.client.serverInfo!.storeId!;
    const promise = (async () => {
      const workspaces = await this.client.listAllWorkspaces({ signal: abort.signal });
      const sessions = this.client.serverInfo!.capabilities.includes('session_directory_activity')
        ? (await this.client.listAllSessionDirectory({ signal: abort.signal })).map((item) => ({
            ...item.session,
            activity: item.activity,
          }))
        : await this.client.listAllSessions({ signal: abort.signal });
      this.check(generation);
      abort.signal.throwIfAborted();
      if (epoch !== this.directoryEpoch || this.client.serverInfo?.storeId !== storeId)
        throw new ClientError('directory_identity_conflict');
      this.directory = { storeId, workspaces, sessions };
      this.directoryUnavailable = false;
      this.workspaceObservation = { generation, storeId, workspaces };
      return this.directory;
    })().catch((error) => {
      if (generation === this.generation && epoch === this.directoryEpoch)
        this.directoryUnavailable = true;
      if (abort.signal.aborted && epoch !== this.directoryEpoch)
        throw new ClientError('directory_observation_changed');
      throw error;
    });
    const reading = { generation, epoch, abort, promise };
    this.directoryRead = reading;
    try {
      return await promise;
    } finally {
      if (this.directoryRead === reading) this.directoryRead = undefined;
    }
  }
  private scheduleDirectoryRefresh() {
    if (!this.directoryEnabled || this.closed) return;
    this.directoryRefreshRequested = true;
    if (this.directoryRefreshing || this.directoryRefreshTimer) return;
    this.directoryRefreshRequested = false;
    const generation = this.generation;
    const refresh = this.readDirectory().then(
      () => {},
      () => {},
    );
    this.directoryRefreshing = refresh;
    void refresh.finally(() => {
      if (this.directoryRefreshing !== refresh) return;
      this.directoryRefreshing = undefined;
      if (generation !== this.generation || !this.directoryEnabled || this.closed) return;
      this.changed();
      // Persistent output can notify once per segment. Keep one successor observation,
      // including notifications that arrive just after a fast directory read finishes.
      this.directoryRefreshTimer = setTimeout(() => {
        this.directoryRefreshTimer = undefined;
        if (this.directoryRefreshRequested) this.scheduleDirectoryRefresh();
      }, 100);
    });
  }
  private scheduleRefresh(signal: AbortSignal) {
    this.scheduleDirectoryRefresh();
    this.scheduleSelectionRefresh(signal);
  }
  private scheduleSelectionRefresh(signal: AbortSignal) {
    this.refreshRequested = true;
    if (this.refreshing || this.refreshTimer || signal.aborted || this.closed) return;
    const refresh = (async () => {
      if (this.refreshRequested && !this.closed && !signal.aborted) {
        this.refreshRequested = false;
        const selected = this.selected,
          view = this.selection;
        if (selected) {
          try {
            await this.controller.refreshSession(selected);
            if (selected === this.selected && view === this.selection)
              this.permissionUnavailable = false;
          } catch {
            if (selected === this.selected && view === this.selection)
              this.permissionUnavailable = true;
          }
        }
      }
      this.changed();
    })();
    this.refreshing = refresh;
    void refresh.finally(() => {
      if (this.refreshing !== refresh) return;
      this.refreshing = undefined;
      if (!signal.aborted && !this.closed)
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          if (this.refreshRequested) this.scheduleSelectionRefresh(signal);
        }, 100);
    });
  }
  private async drainRefresh() {
    const pending = this.refreshing;
    await pending;
    if (this.refreshing === pending) this.refreshing = undefined;
  }
  private async startObservation() {
    if (this.stream) return;
    await this.client.connect();
    const signal = new AbortController();
    this.observer = signal;
    const originalStore = this.client.serverInfo!.storeId!;
    const invalidate = () => {
      this.invalidateDirectory();
      this.background.release();
      this.environment.release();
      this.observationUnavailable = true;
      this.permissionUnavailable = true;
      this.historyEpoch++;
      this.skills.release();
      this.extensions.release();
      this.jobOutput.release();
      this.fileChanges.release();
      this.toolMessages.release();
      this.interactionHistory.release();
      this.attachmentReads.release();
      this.messageRead?.abort.abort();
      this.grants.release();
      this.context.release();
      this.recovery.release();
      this.fileRecovery.release();
      this.sessions.release();
      this.changed();
    };
    this.stream = (async () => {
      let reset = false,
        startAfter: AppliedCursor | undefined;
      while (!signal.signal.aborted && !this.closed) {
        try {
          if (reset) {
            if (this.client.serverInfo!.storeId !== originalStore)
              throw new ClientError('store_identity_mismatch');
            const baseline = await this.client.listWorkspaceDirectory(
              { storeId: originalStore, limit: 1 },
              { signal: signal.signal },
            );
            startAfter = { storeId: originalStore, sequence: baseline.snapshotCursor };
            if (this.directoryEnabled) await this.readDirectory();
            if (this.selected) {
              const sessionId = this.selected,
                selection = this.selection;
              await this.controller.selectSession(sessionId);
              if (this.selected === sessionId && this.selection === selection) {
                const complete = new Promise<void>((resolve) => {
                  this.resetHistory = { selection, sessionId, resolve };
                });
                this.changed();
                await complete;
              }
            }
            reset = false;
          }
          const acknowledged = this.client.lastAppliedCursor;
          if (
            startAfter &&
            acknowledged &&
            acknowledged.storeId === startAfter.storeId &&
            BigInt(acknowledged.sequence) >= BigInt(startAfter.sequence)
          )
            startAfter = undefined;
          await this.client.observe({
            signal: signal.signal,
            ...(startAfter ? { startAfter } : acknowledged ? { cursor: acknowledged } : {}),
            onReady: (ready) => {
              this.environmentRevision++;
              this.observationUnavailable = false;
              this.permissionUnavailable = false;
              this.changed();
              // A ready-only stream at the reloaded baseline adds no new facts.
              if (!startAfter || ready.highWaterCursor !== startAfter.sequence)
                this.scheduleRefresh(signal.signal);
            },
            onChange: () => {
              this.environmentRevision++;
              this.scheduleRefresh(signal.signal);
            },
            onReset: () => {
              reset = true;
              invalidate();
            },
          });
          if (!signal.signal.aborted && !this.closed && !reset) invalidate();
        } catch (error) {
          if (signal.signal.aborted || this.closed) break;
          invalidate();
          if (
            [
              'store_identity_mismatch',
              'bootstrap_identity_mismatch',
              'profile_identity_mismatch',
            ].includes((error as { code?: string }).code ?? '')
          )
            break;
          reset = true;
        }
        if (!signal.signal.aborted && !this.closed)
          await new Promise<void>((resolve) => {
            const abort = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              signal.signal.removeEventListener('abort', abort);
              resolve();
            }, 250);
            signal.signal.addEventListener('abort', abort, { once: true });
          });
      }
    })().finally(() => {
      if (this.observer === signal) {
        this.observer = undefined;
        this.stream = undefined;
      }
    });
  }

  private callerState() {
    try {
      return { callerSubmissions: this.requireCaller().records().map(callerMetadata) };
    } catch {
      return { callerSubmissions: [], callerUnavailable: true };
    }
  }
  state(): NativeState {
    const fresh = this.controller.snapshot;
    if (fresh && fresh.sessionId === this.selected)
      this.lastView = { selection: this.selection, snapshot: fresh };
    const snapshot =
      fresh?.sessionId === this.selected
        ? fresh
        : this.lastView?.selection === this.selection &&
            this.lastView.snapshot.sessionId === this.selected
          ? this.lastView.snapshot
          : undefined;
    const unavailable =
      this.observationUnavailable ||
      this.permissionUnavailable ||
      !fresh ||
      fresh.sessionId !== this.selected;
    const selection =
      snapshot && this.selected === snapshot.sessionId
        ? {
            canReadSkills: this.client.serverInfo!.capabilities.includes('skill_catalogue'),
            canReadExtensions: this.client.serverInfo!.capabilities.includes('extension_queries'),
            canInvokeExtensions:
              this.client.serverInfo!.capabilities.includes('extensions_actions') &&
              this.client.serverInfo!.capabilities.includes('commands'),
            canReadModelOutput: this.client.serverInfo!.capabilities.includes('model_outputs'),
            canReadModelInput: this.client.serverInfo!.capabilities.includes('model_inputs'),
            canReadPermissionGrants:
              this.client.serverInfo!.capabilities.includes('permission_grants'),
            canReadContext: this.client.serverInfo!.capabilities.includes('context'),
            viewGeneration: snapshot.generation,
            viewSelection: this.selection,
            storeId: snapshot.view.storeId,
            session: snapshot.view.session,
            runs: snapshot.view.runs,
            activeCommand: snapshot.activeCommand,
            executions: snapshot.view.executions,
            interactions: snapshot.interactions,
            interactionsAfterId: snapshot.interactionsAfterId,
            permissions: unavailable ? undefined : snapshot.permissions,
            permissionUnavailable: unavailable,
            viewLoading: !fresh && !this.permissionUnavailable,
          }
        : undefined;
    return {
      generation: this.generation,
      environmentRevision: this.environmentRevision,
      directory: this.directoryState(),
      backgroundUnavailable: this.observationUnavailable,
      selection,
      historyEpoch: this.historyEpoch,
      creationSubmissions: [...this.creations.values()],
      grantSubmissions: this.grants.submissions,
      contextSubmissions: this.context.submissions,
      fileRecoverySubmissions: this.fileRecovery.submissions,
      recoverySubmissions: this.recovery.submissions,
      compressionSubmissions: this.context.compressionSubmissions,
      sessionSubmissions: this.sessions.submissions,
      workspaceRemovalSubmissions: this.workspaceRemoval.submissions,
      workspaceRemovalUnavailable: this.workspaceRemoval.storageUnavailable,
      modelSettingsSubmissions: this.configuration.submissions,
      providerSettingsSubmissions: this.providers.submissions,
      mcpSubmissions: this.mcp.submissions,
      mcpUnavailable: this.mcp.storageUnavailable,
      inputSubmissions: this.input.submissions.map(inputMetadata),
      ...this.callerState(),
      permissionSubmissions: [
        ...this.controller.permissionSubmissions,
        ...this.conversation.permissionSubmissions,
      ],
      interactionSubmissions: this.controller.interactionSubmissions,
      ...this.answerState(snapshot?.view),
    };
  }
  private answerState(view?: DesktopSnapshot['view']) {
    try {
      return { answerSubmissions: this.requireAnswers().metadata(view) };
    } catch {
      return { answerSubmissions: [], answerUnavailable: true };
    }
  }
  private create(input: NativeCreation['input'], onFirst?: () => void): Promise<NativeCreation> {
    if (input.expectedStoreId !== this.client.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const saved = this.requirePrivateData().begin(structuredClone(input));
    const pending = this.creating.get(input.commandId);
    if (pending) return pending;
    if (!saved.created) {
      this.creations.set(input.commandId, saved.value);
      return Promise.resolve(saved.value);
    }
    onFirst?.();
    this.creations.set(input.commandId, saved.value);
    this.changed();
    const work = (async () => {
      let value: NativeCreation;
      try {
        const session = await this.client.createSession(saved.value.input);
        if (
          session.id !== input.sessionId ||
          session.workspaceId !== input.workspaceId ||
          session.parentSessionId !== null
        )
          throw new ClientError('creation_identity_mismatch');
        value = this.requirePrivateData().finish(input.commandId, 'created');
      } catch (error) {
        const known =
          error instanceof ClientError &&
          error.problem &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status);
        value = this.requirePrivateData().finish(
          input.commandId,
          known ? 'rejected' : 'unknown',
          error instanceof ClientError ? error.code : 'network_outcome_unknown',
        );
      }
      this.creations.set(input.commandId, value);
      this.changed();
      return value;
    })().finally(() => {
      this.creating.delete(input.commandId);
      this.changed();
    });
    this.creating.set(input.commandId, work);
    return work;
  }
  private async lookupCreation(commandId: string): Promise<NativeCreation> {
    const original = this.creations.get(commandId);
    if (!original) throw new ClientError('creation_intent_missing');
    if (original.input.expectedStoreId !== this.client.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const command = await this.client.getCommand(commandId);
    if (!command) return original;
    if (
      command.id !== commandId ||
      command.sessionId !== original.input.sessionId ||
      command.originStoreId !== original.input.expectedStoreId ||
      command.kind !== 'session.create'
    )
      throw new ClientError('creation_identity_mismatch');
    let value = original;
    if (command.status === 'applied') {
      if (
        !command.receipt ||
        typeof command.receipt !== 'object' ||
        Array.isArray(command.receipt) ||
        command.receipt.sessionId !== original.input.sessionId
      )
        throw new ClientError('creation_identity_mismatch');
      const view = await this.client.getView(original.input.sessionId);
      if (
        view.storeId !== original.input.expectedStoreId ||
        view.session.id !== original.input.sessionId ||
        view.session.workspaceId !== original.input.workspaceId ||
        view.session.parentSessionId !== null ||
        view.session.deletedAt !== null
      )
        throw new ClientError('creation_identity_mismatch');
      value = this.requirePrivateData().finish(commandId, 'created');
    } else if (command.status === 'rejected')
      value = this.requirePrivateData().finish(commandId, 'rejected');
    this.creations.set(commandId, value);
    this.changed();
    return value;
  }
  async openChangedFile(
    request: Extract<NativeRequest, { method: 'fileChanges.open' }>,
    perform: (editor: DesktopEditor, target: string) => Promise<void>,
  ) {
    await this.drainRefresh();
    this.check(request.generation);
    await this.fileChanges.open(request.changeId, request.editor, perform);
    this.check(request.generation);
  }
  async openMessageFile(
    request: Extract<NativeRequest, { method: 'messageFile.open' }>,
    perform: (editor: DesktopEditor, target: string) => Promise<void>,
  ) {
    await this.drainRefresh();
    this.check(request.generation);
    await this.fileChanges.openMessageFile(request, perform);
    this.check(request.generation);
  }
  async invoke(request: NativeRequest): Promise<NativeResult> {
    if (request.method === 'attach') {
      if (this.closed) throw new ClientError('native_closed');
      this.releaseReads();
      this.background.release();
      this.invalidateDirectory(true);
      this.directoryEnabled = true;
      this.selection++;
      const generation = ++this.generation;
      this.selected = undefined;
      await this.startObservation();
      this.check(generation);
      return this.state();
    }
    if (
      !request.method.startsWith('background.') &&
      !request.method.startsWith('interactionHistory.') &&
      !request.method.startsWith('extensions.') &&
      ![
        'select',
        'detach',
        'workspace.removal.lookup',
        'messages.close',
        'modelInputs.close',
        'modelOutput.close',
        'modelInput.close',
        'interactionAttachment.close',
        'recovery.close',
        'fileRecovery.close',
        'interactions.close',
        'settings.skills.close',
        'settings.skills.open',
        'settings.skills.next',
        'jobOutput.open',
        'jobOutput.next',
        'jobOutput.close',
        'fileChanges.list',
        'fileTargets.list',
        'toolMessages.list',
        'toolMessages.runs',
        'toolMessages.usage',
        'toolMessages.close',
        'fileChanges.detail',
        'fileChanges.close',
      ].includes(request.method)
    )
      await this.drainRefresh();
    this.check(request.generation);
    const generation = request.generation;
    const background =
      'surface' in request && request.surface === 'environment'
        ? this.environment
        : this.background;
    let result: NativeResult;
    switch (request.method) {
      case 'extensions.open':
        result = await this.extensions.open(request);
        break;
      case 'extensions.query':
        result = await this.extensions.query(request);
        break;
      case 'extensions.read':
        result = this.extensions.read(request);
        break;
      case 'extensions.close':
        this.extensions.close(request.readId);
        result = null;
        break;
      case 'extensions.release':
        this.extensions.release();
        result = null;
        break;
      case 'extensions.invoke':
        result = await this.extensions.invoke(request);
        this.changed();
        break;
      case 'extensions.lookup':
        result = await this.extensions.lookup(request.commandId);
        this.changed();
        break;
      case 'interactionHistory.open':
        result = await this.interactionHistory.open(request);
        break;
      case 'interactionHistory.next':
        result = await this.interactionHistory.next(request.readId);
        break;
      case 'interactionHistory.close':
        this.interactionHistory.close(request.readId);
        result = null;
        break;
      case 'interactionHistory.attachment.open':
        result = await this.interactionHistory.attachments.open(request);
        break;
      case 'interactionHistory.attachment.read':
        result = this.interactionHistory.attachments.read(request);
        break;
      case 'interactionHistory.attachment.close':
        this.interactionHistory.attachments.close(request.readId);
        result = null;
        break;
      case 'toolMessages.list':
        result = await this.toolMessages.list(request);
        break;
      case 'toolMessages.runs':
        result = await this.toolMessages.runs(request);
        break;
      case 'toolMessages.usage':
        result = await this.toolMessages.usage(request);
        break;
      case 'toolMessages.close':
        this.toolMessages.close(request.readId);
        result = null;
        break;
      case 'fileChanges.list':
        result = await this.fileChanges.list(request);
        break;
      case 'fileTargets.list':
        result = await this.fileChanges.list(request, true);
        break;
      case 'fileChanges.detail':
        result = await this.fileChanges.detail(request.changeId, request.readId);
        break;
      case 'fileChanges.close':
        this.fileChanges.close(request.readId);
        result = null;
        break;
      case 'fileChanges.open':
      case 'messageFile.open':
        throw new ClientError('native_host_operation_unavailable');
      case 'background.open':
        result = await background.open(request.readId);
        break;
      case 'background.next':
        result = background.next(request.readId);
        break;
      case 'background.close':
        background.close(request.readId);
        result = null;
        break;
      case 'background.stop':
        result = await background.stop(
          request.observationId,
          request.executionId,
          request.commandId,
        );
        this.changed();
        break;
      case 'background.output.open':
        result = await background.outputOpen(request);
        break;
      case 'background.output.next':
        result = await background.outputNext(request.readId);
        break;
      case 'background.output.close':
        background.outputClose(request.readId);
        result = null;
        break;
      case 'background.child.open':
        result = await background.childOpen(request);
        break;
      case 'background.child.read':
        result = background.childRead(request);
        break;
      case 'background.child.close':
        background.childClose(request.readId);
        result = null;
        break;
      case 'jobOutput.open':
        result = await this.jobOutput.open(request);
        break;
      case 'jobOutput.next':
        result = await this.jobOutput.next(request.readId);
        break;
      case 'jobOutput.close':
        this.jobOutput.close(request.readId);
        result = null;
        break;
      case 'settings.skills.open':
        result = await this.skills.open(request);
        break;
      case 'settings.skills.next':
        result = await this.skills.next(request.readId);
        break;
      case 'settings.skills.close':
        this.skills.close(request.readId);
        result = null;
        break;
      case 'settings.mcp.read':
        result = await this.mcp.read();
        break;
      case 'settings.mcp.close':
        this.mcp.release();
        result = null;
        break;
      case 'settings.mcp.sources':
        result = await this.mcp.sources(request.observationId, request.afterId);
        break;
      case 'settings.mcp.snapshots':
        result = await this.mcp.snapshots(request.observationId, request.afterKey);
        break;
      case 'settings.mcp.auth':
        result = await this.mcp.auth(request.observationId, request.serverId);
        break;
      case 'settings.mcp.removePreview':
        result = await this.mcp.removePreview(
          request.observationId,
          request.serverId,
          request.scope,
        );
        break;
      case 'settings.mcp.submit':
        result = await this.mcp.submit(request.observationId, request.operation);
        break;
      case 'settings.mcp.lookup':
        result = await this.mcp.lookup(request.commandId);
        break;
      case 'settings.mcp.cancel':
        result = await this.mcp.cancel(request.commandId);
        break;
      case 'settings.mcp.clear':
        this.mcp.clear(request.commandId);
        result = null;
        break;
      case 'settings.mcp.tools':
        result = await this.mcp.tools(request.observationId, request.recordKey, request.startIndex);
        break;
      case 'settings.mcp.descriptor':
        result = await this.mcp.descriptor(
          request.observationId,
          request.recordKey,
          request.index,
          request.readId,
        );
        break;
      case 'settings.mcp.descriptor.read':
        result = this.mcp.descriptorRead(request.readId, request.offset, request.limit);
        break;
      case 'settings.mcp.descriptor.close':
        this.mcp.descriptorClose(request.readId);
        result = null;
        break;
      case 'interactions.next': {
        this.selectScope(this.selected ?? '');
        await this.controller.nextInteractionPage(request.viewGeneration, request.afterId);
        result = this.state();
        break;
      }
      case 'interactions.close':
        this.controller.cancelInteractionRead(request.viewGeneration);
        result = null;
        break;
      case 'fileRecovery.list':
        result = await this.fileRecovery.list(request.readId, request.afterKey);
        break;
      case 'fileRecovery.detail':
        result = await this.fileRecovery.detail(
          request.pointId,
          request.readId,
          request.inputRevision,
        );
        break;
      case 'fileRecovery.status':
        result = await this.fileRecovery.status(request.pointId, request.restoreId, request.readId);
        break;
      case 'fileRecovery.begin':
        result = await this.fileRecovery.begin(
          request.observationId,
          request.scope,
          request.title,
          request.inputRevision,
        );
        break;
      case 'fileRecovery.continue':
        result = await this.fileRecovery.continue(request.intentId);
        break;
      case 'fileRecovery.lookup':
        result = await this.fileRecovery.lookup(request.intentId, request.readId);
        break;
      case 'fileRecovery.listSaved':
        result = await this.fileRecovery.saved();
        break;
      case 'fileRecovery.close':
        this.fileRecovery.close(request.readId);
        result = null;
        break;
      case 'session.observe':
        result = await this.sessions.observe(request.sessionId);
        break;
      case 'session.fork':
      case 'session.rename':
      case 'session.delete':
        if (this.permissionUnavailable || this.controller.snapshot?.sessionId !== this.selected)
          throw new ClientError('session_view_unavailable');
        result = await this.sessions.submit(
          request.observationId,
          request.method === 'session.fork'
            ? 'fork'
            : request.method === 'session.rename'
              ? 'rename'
              : 'delete',
          'title' in request ? request.title : undefined,
        );
        break;
      case 'lookupSessionMutation':
        result = await this.sessions.lookup(request.commandId);
        break;
      case 'recovery.prepare':
        result = await this.recovery.prepare(request.kind, request.targetId, request.readId);
        break;
      case 'recovery.submit':
        result = await this.recovery.submit(request.observationId, request.confirm);
        break;
      case 'recovery.lookup':
        result = await this.recovery.lookup(request.commandId, request.readId);
        break;
      case 'recovery.close':
        this.recovery.close(request.readId);
        result = null;
        break;
      case 'context.read':
        result = await this.context.read(request.sessionId, false, request.readId);
        break;
      case 'context.next':
        result = await this.context.read(request.sessionId, true, request.readId);
        break;
      case 'context.close':
        this.context.close(request.readId);
        result = null;
        break;
      case 'context.rewind':
        if (this.permissionUnavailable || this.controller.snapshot?.sessionId !== this.selected)
          throw new ClientError('context_view_unavailable');
        result = await this.context.rewind(request.observationId, request.boundary);
        break;
      case 'context.include':
        if (this.permissionUnavailable || this.controller.snapshot?.sessionId !== this.selected)
          throw new ClientError('context_view_unavailable');
        result = await this.context.include(
          request.observationId,
          request.executionId,
          request.resultRevision,
          request.scope,
        );
        break;
      case 'lookupContext':
        result = await this.context.lookup(request.commandId);
        break;
      case 'context.compress':
      case 'context.resetCompression':
        if (this.permissionUnavailable) throw new ClientError('context_view_unavailable');
        result = await this.context.maintainCompression(
          request.observationId,
          request.method === 'context.compress' ? 'compress' : 'reset',
          'focus' in request ? request.focus : undefined,
        );
        break;
      case 'lookupCompression':
        result = await this.context.lookupCompression(request.commandId);
        break;
      case 'state':
        result = this.state();
        break;
      case 'settings.models.read':
        result = await this.configuration.read(request.scope);
        break;
      case 'input.models.read': {
        if (!this.selected) throw new ClientError('native_selection_changed');
        const sessionId = this.selected;
        const facts = await this.inputConfiguration.read('workspace');
        result = {
          ...facts,
          ...(this.privateData?.modelRoute(facts.storeId, sessionId)
            ? { selectedModelId: this.privateData.modelRoute(facts.storeId, sessionId) }
            : {}),
        };
        break;
      }
      case 'conversation.models.read':
        result = { ...(await this.preparationConfiguration.read('user')), canWrite: false };
        break;
      case 'conversation.branch':
        result = await this.conversation.branch(request.workspaceId);
        break;
      case 'conversation.send':
        result = await this.conversation.send(request);
        break;
      case 'conversation.lookup':
        result = await this.conversation.lookup(request.commandId);
        break;
      case 'settings.providers.read':
        result = await this.providers.read();
        break;
      case 'settings.providers.save':
        result = await this.providers.submit(
          request.observationId,
          request.operation,
          request.secret,
        );
        break;
      case 'settings.providers.lookup':
        result = await this.providers.lookup(request.commandId);
        break;
      case 'settings.providers.close':
        this.providers.cancelRead();
        result = null;
        break;
      case 'settings.models.enabled':
      case 'settings.models.default':
        result = await this.configuration.submit(
          request.observationId,
          request.method === 'settings.models.default'
            ? { kind: 'default', modelId: request.modelId }
            : { kind: 'enabled', modelId: request.modelId, enabled: request.enabled },
        );
        break;
      case 'settings.models.lookup':
        result = await this.configuration.lookup(request.commandId);
        break;
      case 'settings.models.close':
        this.configuration.release();
        result = null;
        break;
      case 'workspace.removal.lookup':
        result = await this.workspaceRemoval.lookup(request.commandId);
        this.acceptWorkspaceRemoval(result);
        break;
      case 'workspace.remove':
      case 'workspace.pick':
        throw new ClientError('native_host_operation_required');
      case 'detach':
        this.detach();
        return null;
      case 'directory':
        await this.readDirectory();
        result = this.directoryState()!;
        break;
      case 'select': {
        this.releaseReads();
        this.lastView = undefined;
        this.contextWorkspace = undefined;
        this.selection++;
        this.selected = request.sessionId;
        const view = this.selection;
        const reading = this.controller
          .selectSession(request.sessionId)
          .then(() => {
            if (this.selected === request.sessionId && this.selection === view)
              this.permissionUnavailable = false;
          })
          .catch((error) => {
            if (this.selected === request.sessionId && this.selection === view)
              this.permissionUnavailable = true;
            throw error;
          });
        this.refreshing = reading;
        try {
          await reading;
        } finally {
          if (this.refreshing === reading) this.refreshing = undefined;
          if (this.refreshRequested && this.observer) this.scheduleRefresh(this.observer.signal);
        }
        await this.drainRefresh();
        if (this.selected !== request.sessionId || view !== this.selection)
          throw new ClientError('native_selection_changed');
        const snapshot = this.selectScope(request.sessionId);
        this.contextWorkspace = {
          sessionId: request.sessionId,
          selection: view,
          workspaceId: snapshot.view.session.workspaceId,
        };
        result = this.state();
        break;
      }
      case 'createSession':
        result = await this.create({
          expectedStoreId: request.expectedStoreId,
          workspaceId: request.workspaceId,
          commandId: request.commandId,
          sessionId: request.sessionId,
          title: request.title,
        });
        break;
      case 'lookupCreation':
        result = await this.lookupCreation(request.commandId);
        break;
      case 'modelInputs.close':
        if (this.inputDirectory?.readId === request.readId) this.inputDirectory.abort.abort();
        result = null;
        break;
      case 'modelInputs.list': {
        const snapshot = this.selectScope(request.sessionId);
        if (snapshot.view.storeId !== request.expectedStoreId)
          throw new ClientError('store_identity_mismatch');
        const view = this.selection,
          abort = new AbortController();
        this.inputDirectory?.abort.abort();
        this.inputDirectory = { readId: request.readId, abort };
        try {
          result = await this.client.listModelInputs(request.sessionId, {
            expectedStoreId: request.expectedStoreId,
            ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
            ...(request.upperSeq === undefined ? {} : { upperSeq: request.upperSeq }),
            limit: request.limit ?? 200,
            signal: abort.signal,
          });
          abort.signal.throwIfAborted();
          if (this.selection !== view || this.selected !== request.sessionId)
            throw new ClientError('native_selection_changed');
        } finally {
          if (this.inputDirectory?.abort === abort) this.inputDirectory = undefined;
        }
        break;
      }
      case 'modelInput.open':
        this.outputReads.release();
        result = await this.inputReads.open(request);
        break;
      case 'modelInput.read':
        result = this.inputReads.read(request);
        break;
      case 'modelInput.close':
        this.inputReads.close(request.readId);
        result = null;
        break;
      case 'modelOutput.open': {
        this.inputReads.release();
        const message = request.messageId
          ? this.observedMessages.get(request.messageId)
          : undefined;
        if (
          request.messageId &&
          (!message ||
            message.sessionId !== this.selected ||
            message.outputBody?.executionId !== request.executionId ||
            message.outputBody.readAvailability === 'unsupported')
        )
          throw new ClientError('model_output_message_unavailable');
        const origin = message?.originMessage;
        if (origin && origin.runId === null)
          throw new ClientError('model_output_identity_mismatch');
        const runId = origin?.runId ?? message?.runId;
        if (message && !runId) throw new ClientError('model_output_identity_mismatch');
        result = await this.outputReads.open(
          request,
          message
            ? {
                sessionId: origin?.sessionId ?? message.sessionId,
                ...(origin ? { originStoreId: origin.storeId } : {}),
                runId: runId!,
                body: message.outputBody!,
              }
            : undefined,
        );
        break;
      }
      case 'modelOutput.read':
        result = this.outputReads.read(request);
        break;
      case 'modelOutput.close':
        this.outputReads.close(request.readId);
        result = null;
        break;
      case 'messages.close':
        if (this.messageRead?.readId === request.readId) {
          this.messageRead.abort.abort();
          this.messageRead = undefined;
        }
        result = null;
        break;
      case 'messages': {
        const snapshot =
          this.controller.snapshot?.sessionId === request.sessionId
            ? this.controller.snapshot
            : this.lastView?.selection === this.selection &&
                this.lastView.snapshot.sessionId === request.sessionId
              ? this.lastView.snapshot
              : undefined;
        if (!snapshot || this.selected !== request.sessionId)
          throw new ClientError('native_selection_changed');
        if (request.expectedStoreId && request.expectedStoreId !== snapshot.view.storeId)
          throw new ClientError('store_identity_mismatch');
        const upperSeq = request.upperSeq ?? snapshot.view.session.nextSeq,
          selection = this.selection;
        if (BigInt(upperSeq) > BigInt(snapshot.view.session.nextSeq))
          throw new ClientError('history_high_water_unavailable');
        const readId = request.readId ?? crypto.randomUUID();
        if (this.messageRead?.readId !== readId) {
          this.messageRead?.abort.abort();
          this.messageRead = { readId, abort: new AbortController() };
        }
        const reading = this.messageRead!;
        let limit = request.limit ?? 100;
        for (;;) {
          let messages: Message[];
          try {
            messages = await this.client.listMessages(request.sessionId, {
              afterSeq: request.afterSeq,
              upperSeq,
              limit,
              signal: reading.abort.signal,
            });
          } catch (error) {
            if ((error as { code?: string }).code !== 'response_too_large' || limit === 1)
              throw error;
            limit = Math.max(1, Math.floor(limit / 2));
            continue;
          }
          reading.abort.signal.throwIfAborted();
          if (
            selection !== this.selection ||
            request.sessionId !== this.selected ||
            this.messageRead !== reading
          )
            throw new ClientError('native_selection_changed');
          const page = {
            messages,
            highWaterSeq: upperSeq,
            nextAfterSeq:
              messages.length === limit && messages.at(-1)!.seq !== upperSeq
                ? messages.at(-1)!.seq
                : null,
          };
          if (Buffer.byteLength(JSON.stringify(page)) > 4 * 1048576 - 256) {
            if (limit === 1) throw new ClientError('history_item_unavailable');
            limit = Math.max(1, Math.floor(limit / 2));
            continue;
          }
          for (const message of messages)
            this.observedMessages.set(message.id, structuredClone(message));
          if (
            page.nextAfterSeq === null &&
            this.resetHistory?.selection === selection &&
            this.resetHistory.sessionId === request.sessionId &&
            upperSeq === snapshot.view.session.nextSeq
          ) {
            this.resetHistory.resolve();
            this.resetHistory = undefined;
          }
          result = page;
          break;
        }
        break;
      }
      case 'caller.list':
        result = {
          kind: 'caller.directory',
          records: this.requireCaller().records().map(callerMetadata),
        };
        break;
      case 'caller.prepare': {
        this.writableScope(request.sessionId);
        const row = await this.requireCaller().prepare(
          request.sessionId,
          request.intent,
          request.draft,
        );
        if (
          (request.intent.kind === 'run.start' || request.intent.kind === 'input.follow_up') &&
          request.intent.modelId
        )
          this.requirePrivateData().rememberModelRoute(
            request.intent.expectedStoreId,
            request.sessionId,
            request.intent.modelId,
          );
        result = callerMetadata(row);
        break;
      }
      case 'caller.submit':
      case 'caller.lookup': {
        let verified = true;
        try {
          const original = this.requireCaller()
            .records()
            .find((row) => row.intent.request.commandId === request.commandId);
          if (
            request.method === 'caller.submit' &&
            original?.intent.request.kind !== 'extension.invoke'
          )
            await this.requireCaller().submit(request.commandId);
          else await this.requireCaller().lookup(request.commandId);
        } catch {
          verified = false;
        }
        const row = this.requireCaller()
          .records()
          .find((r) => r.intent.request.commandId === request.commandId);
        if (!row) throw new ClientError('caller_intent_missing');
        result = { ...callerMetadata(row), ...(!verified ? { phase: 'unknown' as const } : {}) };
        break;
      }
      case 'caller.clear':
        await this.requireCaller().clear(request.commandId);
        result = null;
        break;
      case 'caller.body': {
        const row = this.requireCaller()
          .records()
          .find((r) => r.intent.request.commandId === request.commandId);
        if (!row) throw new ClientError('caller_intent_missing');
        let read = this.callerReads.get(request.readId);
        if (!read) {
          if (request.offset !== 0 || this.callerReads.size >= 16)
            throw new ClientError('caller_reader_unavailable');
          const body = callerCanonical(row.intent.request);
          read = {
            commandId: request.commandId,
            body,
            hash: callerTextDigest(body),
            nextOffset: 0,
          };
          this.callerReads.set(request.readId, read);
        }
        if (
          read.commandId !== request.commandId ||
          read.hash !== row.intent.bodyDigest ||
          request.offset !== read.nextOffset
        )
          throw new ClientError('caller_reader_unavailable');
        let end = Math.min(read.body.length, request.offset + request.limit);
        if (
          end < read.body.length &&
          end > request.offset &&
          /[\uD800-\uDBFF]/.test(read.body[end - 1]!)
        )
          end--;
        if (end === request.offset && end < read.body.length)
          throw new ClientError('caller_reader_unavailable');
        read.nextOffset = end;
        result = {
          kind: 'caller.body',
          commandId: read.commandId,
          readId: request.readId,
          bodyDigest: read.hash,
          offset: request.offset,
          nextOffset: end,
          eof: end === read.body.length,
          data: read.body.slice(request.offset, end),
          bodyBytes: Buffer.byteLength(read.body),
        };
        break;
      }
      case 'caller.close':
        this.callerReads.delete(request.readId);
        result = null;
        break;
      case 'submit': {
        const originalSelection = this.selection;
        const snapshot = this.writableScope(request.sessionId);
        if (request.intent.expectedStoreId !== snapshot.view.storeId)
          throw new ClientError('store_identity_mismatch');
        let draftProof = request.draft;
        if (!draftProof) {
          const saved = this.requirePrivateData().read({
            storeId: snapshot.view.storeId,
            workspaceId: snapshot.view.session.workspaceId,
            rootSessionId: request.sessionId,
          });
          if (saved.content === request.intent.content)
            draftProof = {
              id: saved.id,
              revision: String(saved.revision),
              textDigest: callerTextDigest(saved.content),
            };
        }
        const prepared = await this.requireCaller().prepare(
          request.sessionId,
          request.intent,
          draftProof,
        );
        if (request.intent.kind !== 'input.steer' && request.intent.modelId)
          this.requirePrivateData().rememberModelRoute(
            request.intent.expectedStoreId,
            request.sessionId,
            request.intent.modelId,
          );
        this.check(generation);
        if (originalSelection !== this.selection || this.selected !== request.sessionId)
          throw new ClientError('native_selection_changed');
        result = inputMetadata(
          request.intent.kind === 'run.start'
            ? await this.input.start(request.sessionId, request.intent)
            : request.intent.kind === 'input.steer'
              ? await this.input.steer(request.sessionId, request.intent)
              : await this.input.followUp(request.sessionId, request.intent),
        );
        if (prepared.intent.draft && result) result = { ...result, draft: prepared.intent.draft };
        break;
      }
      case 'cancelInput': {
        const journal = this.requireCaller(),
          original = journal
            .records()
            .find((r) => r.intent.request.commandId === request.commandId);
        if (
          !original ||
          ['command.cancel', 'execution.cancel'].includes(original.intent.request.kind)
        )
          throw new ClientError('input_intent_missing');
        const previous = journal
          .records()
          .find(
            (r) =>
              r.intent.request.kind === 'command.cancel' &&
              r.intent.request.targetCommandId === request.commandId &&
              r.intent.scope.storeId === original.intent.scope.storeId &&
              r.intent.scope.sessionId === original.intent.scope.sessionId,
          );
        const id =
          previous?.intent.request.commandId ??
          this.cancellations.get(request.commandId) ??
          crypto.randomUUID();
        this.cancellations.set(request.commandId, id);
        if (!previous)
          await journal.prepare(original.intent.scope.sessionId, {
            kind: 'command.cancel',
            commandId: id,
            expectedStoreId: original.intent.scope.storeId,
            targetCommandId: request.commandId,
          });
        try {
          await journal.submit(id);
        } catch {}
        const row = journal.records().find((r) => r.intent.request.commandId === id);
        if (!row) throw new ClientError('caller_intent_missing');
        result = callerMetadata(row);
        break;
      }
      case 'lookupInput':
        result = inputMetadata(await this.input.lookup(request.commandId));
        break;
      case 'lookupInteraction': {
        const saved = this.controller.interactionSubmissions.find(
          (value) => value.intent.commandId === request.commandId,
        );
        result = saved
          ? await this.controller.lookupInteractionAnswer(saved.interaction)
          : await this.requireAnswers().lookup(request.commandId);
        break;
      }
      case 'lookupPermission':
        result = this.conversation.permissionSubmissions.some(
          (row) => row.intent.commandId === request.commandId,
        )
          ? await this.conversation.lookupPermission(request.commandId)
          : await this.controller.lookupPermissionMutation(request.commandId);
        break;
      case 'permission.mode':
      case 'permission.trust': {
        this.writableScope(this.selected ?? '');
        if (this.permissionUnavailable) throw new ClientError('permission_facts_unavailable');
        if (
          this.conversation.permissionSubmissions.some((row) =>
            ['saved', 'submitting', 'unknown'].includes(row.phase),
          )
        )
          throw new ClientError('permission_intent_pending');
        result =
          request.method === 'permission.mode'
            ? await this.controller.setPermissionMode(
                request.mode,
                request.makeDefault,
                request.observationId,
              )
            : await this.controller.setWorkspaceTrust(request.trusted, request.observationId);
        break;
      }
      case 'permission.refresh': {
        const selected = this.selected,
          view = this.selection;
        try {
          await this.controller.refreshPermissions();
          await this.refreshing;
          if (selected === this.selected && view === this.selection)
            this.permissionUnavailable = false;
        } catch (error) {
          if (selected === this.selected && view === this.selection)
            this.permissionUnavailable = true;
          this.changed();
          throw error;
        }
        result = this.state();
        break;
      }
      case 'interactionAttachment.open':
        this.selectScope(this.selected ?? '');
        result = await this.attachmentReads.open(request);
        break;
      case 'interactionAttachment.read':
        result = this.attachmentReads.read(request);
        break;
      case 'interactionAttachment.close':
        this.attachmentReads.close(request.readId);
        result = null;
        break;
      case 'interaction.answer': {
        const snapshot = this.selectScope(this.selected ?? '');
        const card = snapshot.interactions.find(
          (card) => card.id === request.interactionId && card.revision === request.revision,
        );
        if (!card) throw new ClientError('interaction_observation_changed');
        verifyNativeMcpSourceAnswer(card, request.answer, this.client.serverInfo!.storeId!);
        if (requiresInteractionAttachment(card)) {
          const attachment = interactionAttachment(card);
          if (!attachment || !this.attachmentReads.hasLoaded(attachment.key))
            throw new ClientError('attachment_not_loaded');
        }
        if (!this.controller.interactionSubmission(card) && this.requireAnswers().saved(card))
          throw new ClientError('interaction_answer_already_saved');
        result = await this.controller.answerInteraction(card, request.answer);
        break;
      }
      case 'draft.list':
        result = this.requirePrivateData().list(request.afterId);
        break;
      case 'draft.original': {
        const original = this.requirePrivateData().readId(request.draftId);
        let association: 'current' | 'unavailable' = 'unavailable';
        if (original.storeId === this.client.serverInfo!.storeId) {
          try {
            const view = await this.client.getView(original.rootSessionId);
            if (
              view.storeId === original.storeId &&
              view.session.workspaceId === original.workspaceId &&
              (view.session.rootSessionId ?? view.session.id) === original.rootSessionId &&
              view.session.deletedAt === null
            )
              association = 'current';
          } catch {}
        }
        result = { ...original, association };
        break;
      }
      case 'draft.read':
      case 'draft.write': {
        const snapshot = this.writableScope(request.sessionId);
        if (snapshot.view.session.deletedAt !== null)
          throw new ClientError('draft_association_unavailable');
        const scope = {
          storeId: snapshot.view.storeId,
          workspaceId: snapshot.view.session.workspaceId,
          rootSessionId: snapshot.view.session.rootSessionId ?? snapshot.view.session.id,
        };
        result =
          request.method === 'draft.read'
            ? this.requirePrivateData().read(scope)
            : this.requirePrivateData().save(scope, request.revision, request.content);
        break;
      }
      case 'grants.read':
        result = await this.grants.read(request);
        break;
      case 'grants.clear':
        if (this.permissionUnavailable || this.controller.snapshot?.sessionId !== this.selected)
          throw new ClientError('permission_observation_unavailable');
        result = await this.grants.clear(request.observationId);
        break;
      case 'lookupGrant':
        result = await this.grants.lookup(request.commandId);
        break;
    }
    this.check(generation);
    return result;
  }
  detach() {
    this.directoryEnabled = false;
    this.releaseReads();
    this.background.release();
    this.invalidateDirectory(true);
    this.preparationConfiguration.release();
    this.workspaceObservation = undefined;
    this.selection++;
    this.generation++;
    this.selected = undefined;
  }
  async disposeNetwork() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshRequested = false;
    this.releaseReads();
    this.background.release();
    this.invalidateDirectory();
    this.observer?.abort();
    this.client.disposeNetwork();
    await this.stream;
    this.observer = undefined;
    this.stream = undefined;
  }
  async close() {
    this.closed = true;
    this.detach();
    await this.disposeNetwork();
    await Promise.allSettled(this.creating.values());
    await this.conversation.close();
    this.input.disposeObserver();
    this.controller.disposeNetwork();
  }
  private acceptWorkspaceRemoval(result: import('../src/native-bridge').NativeWorkspaceRemoval) {
    if (result.phase !== 'applied' || result.storeId !== this.client.serverInfo?.storeId) return;
    if (
      this.directory?.sessions.find((s) => s.id === this.selected)?.workspaceId ===
        result.workspaceId ||
      this.lastView?.snapshot.view.session.workspaceId === result.workspaceId
    ) {
      this.releaseReads();
      this.selected = undefined;
      this.lastView = undefined;
      this.contextWorkspace = undefined;
      this.selection++;
    }
    this.invalidateDirectory();
    this.changed();
  }
  async removeWorkspace(
    generation: number,
    workspaceId: string,
    confirm: (label: string) => Promise<boolean>,
  ) {
    this.check(generation);
    const result = await this.workspaceRemoval.remove(workspaceId, confirm);
    this.check(generation);
    this.acceptWorkspaceRemoval(result);
    return result;
  }
  async registerWorkspace(
    generation: number,
    workspace: Omit<CreateWorkspaceRequest, 'expectedStoreId'>,
  ) {
    this.check(generation);
    const existing = (await this.client.listAllWorkspaces()).find(
      (w) => w.rootUri === workspace.rootUri,
    );
    this.check(generation);
    const result =
      existing ??
      (await this.client.createWorkspace({
        ...workspace,
        expectedStoreId: this.client.serverInfo!.storeId!,
      }));
    this.check(generation);
    return result;
  }
  async hasActiveWork(signal?: AbortSignal) {
    const sessions = await this.client.listAllSessions({ signal });
    for (const session of sessions) {
      const view = await this.client.getView(session.id, { signal });
      if (
        view.runs.some((run) => run.isActive) ||
        view.executions.some((execution) =>
          ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(execution.status),
        )
      )
        return true;
    }
    return false;
  }
}
