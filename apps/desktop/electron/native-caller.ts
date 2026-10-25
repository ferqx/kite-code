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
  permissionChangeAffectsView,
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
import { openEditor } from './editor';
import { NativeExtensions } from './extensions';
import { NativeFileChanges } from './file-changes';
import { NativeFileRecovery } from './file-recovery';
import { NativeInputFiles } from './input-files';
import { NativeInputImageReads } from './input-image-reads';
import { NativeInputImages } from './input-images';
import { NativeInteractionAttachmentReads } from './interaction-attachment-reads';
import { NativeInteractionHistoryReads } from './interaction-history-reads';
import { NativeJobOutputReads } from './job-output-reads';
import { NativeMcpSettings } from './mcp-settings';
import { verifyNativeMcpSourceAnswer } from './mcp-source-answer';
import { NativeModelOutputReads } from './model-output-reads';
import { NativeInputQueue } from './native-input-queue';
import { NativeProcessOwner } from './native-processes';
import { NativePermissionGrants } from './permission-grants';
import type { PrivateData } from './private-data';
import { NativeProviderSettings } from './provider-settings';
import { NativeRecovery } from './recovery';
import type { ScheduledTaskRunner } from './scheduled-task-runner';
import { NativeSessionManagement } from './session-management';
import { NativeSkillCatalogueReads } from './skill-catalogue-reads';
import { NativeToolMessages } from './tool-messages';
import { NativeUserMcpSettings } from './user-mcp-settings';
import { NativeWorkspaceRemovalPort } from './workspace-removal';

export class NativeCaller {
  private generation = 0;
  private selection = 0;
  private activation: { id: number; sessionId: string; selection: number } | undefined;
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
  private readonly workspaceAccessPreparations = new Set<string>();
  private workspaceAccessRefreshRequested = false;
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
  private readonly images = new NativeInputImages();
  private readonly inputFiles = new NativeInputFiles();
  private readonly imageReads: NativeInputImageReads;
  private readonly mcp: NativeMcpSettings;
  private readonly userMcp: NativeUserMcpSettings;
  private readonly skills: NativeSkillCatalogueReads;
  private readonly extensions: NativeExtensions;
  private readonly jobOutput: NativeJobOutputReads;
  private readonly fileChanges: NativeFileChanges;
  private readonly toolMessages: NativeToolMessages;
  private readonly interactionHistory: NativeInteractionHistoryReads;
  private readonly background: NativeBackground;
  private readonly environment: NativeBackground;
  private environmentRevision = 0;
  private selectedEnvironmentRevision = 0;
  private readonly observedMessages = new Map<string, Message>();
  private historyEpoch = 0;
  private historyHead?: { sessionId: string; selection: number; cursor: string };
  private observationUnavailable = false;
  private resetHistory: { selection: number; sessionId: string; resolve: () => void } | undefined;
  private messageRead:
    | {
        readId: string;
        generation: number;
        selection: number;
        sessionId: string;
        storeId: string;
        upperSeq: string;
        abort: AbortController;
        effectiveLimit?: number;
      }
    | undefined;
  private inputDirectory: { readId: string; abort: AbortController } | undefined;
  private readonly cancellations = new Map<string, string>();
  private readonly creations = new Map<string, NativeCreation>();
  private readonly creating = new Map<string, Promise<NativeCreation>>();
  private readonly controller: DesktopController;
  private readonly input: DesktopInput;
  private readonly inputQueue: NativeInputQueue;
  private readonly callerJournal: NativeCallerJournal | undefined;
  private readonly answerJournal: NativeAnswerJournal | undefined;
  private readonly callerReads = new Map<
    string,
    { commandId: string; body: string; hash: string; nextOffset: number }
  >();
  private scheduledTasks: ScheduledTaskRunner | undefined;
  private settingsMutationTail: Promise<unknown> = Promise.resolve();
  private serializeSettingsMutation<T>(work: () => Promise<T>): Promise<T> {
    const result = this.settingsMutationTail.then(work);
    this.settingsMutationTail = result.catch(() => {});
    return result;
  }
  setScheduledTasks(runner: ScheduledTaskRunner) {
    this.scheduledTasks = runner;
  }
  private readonly client: AgentClient;
  private readonly emit: (event: NativeEvent) => void;
  private readonly privateData: PrivateData | undefined;
  private initialAdmission: (() => boolean) | undefined;
  private readonly processes: NativeProcessOwner;
  constructor(
    client: AgentClient,
    emit: (event: NativeEvent) => void,
    privateData?: PrivateData,
    protectedRoots: readonly string[] = [],
    initialAdmission?: { readonly client: AgentClient; consume(): boolean },
    processes = new NativeProcessOwner(),
  ) {
    this.processes = processes;
    this.client = client;
    this.emit = emit;
    this.privateData = privateData;
    if (initialAdmission && initialAdmission.client !== client)
      throw new ClientError('connection_not_admitted');
    this.initialAdmission = initialAdmission?.consume;
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
        const info = this.client.serverInfo;
        // A metadata refresh temporarily clears controller.snapshot. It does not
        // revoke an admitted root's read leases while the same selection remains
        // current; every child read still verifies its live backend binding.
        const snapshot = this.environmentSnapshot();
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
      this.processes,
      (sessionId, ids) =>
        this.images.publish(this.client, this.client.serverInfo!.storeId!, sessionId, ids),
      (sessionId, ids) =>
        this.inputFiles.publish(this.client, this.client.serverInfo!.storeId!, sessionId, ids),
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
    this.inputQueue = new NativeInputQueue(
      client,
      () => {
        const scope = messageScope();
        const subjectId = this.client.serverInfo?.subjectId;
        return scope && subjectId && !this.permissionUnavailable && this.privateData
          ? { ...scope, subjectId }
          : undefined;
      },
      () => this.requirePrivateData(),
      () => this.changed(),
    );
    this.toolMessages = new NativeToolMessages(
      client,
      messageScope,
      () => this.observedMessages,
      () => {
        const scope = messageScope();
        if (!scope) return [];
        const fresh = this.controller.snapshot;
        const snapshot =
          fresh?.sessionId === scope.sessionId
            ? fresh
            : this.lastView?.selection === scope.viewSelection
              ? this.lastView.snapshot
              : undefined;
        if (
          !snapshot ||
          snapshot.sessionId !== scope.sessionId ||
          snapshot.view.storeId !== scope.storeId
        )
          return [];
        const runs = new Set(
          snapshot.view.runs
            .filter(
              (run) =>
                run.isActive &&
                run.originStoreId === scope.storeId &&
                run.sessionId === scope.sessionId,
            )
            .map((run) => run.id),
        );
        return snapshot.view.executions.filter(
          (execution) =>
            execution.kind === 'tool' &&
            execution.originStoreId === scope.storeId &&
            execution.sessionId === scope.sessionId &&
            !!execution.runId &&
            runs.has(execution.runId),
        );
      },
    );
    this.imageReads = new NativeInputImageReads(client, messageScope, () => this.observedMessages);
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
        snapshot = this.environmentSnapshot(),
        execution = snapshot?.view.executions.find((item) => item.id === executionId);
      if (
        !scope ||
        this.observationUnavailable ||
        this.permissionUnavailable ||
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
      return !this.closed && client.serverInfo?.storeId
        ? { generation: this.generation, storeId: client.serverInfo.storeId }
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
    this.userMcp = new NativeUserMcpSettings(
      client,
      () =>
        !this.closed && this.client.serverInfo?.storeId
          ? {
              generation: this.generation,
              storeId: this.client.serverInfo.storeId,
            }
          : undefined,
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
  private releaseReads(includeGlobalSettings = true) {
    this.inputQueue.release();
    this.environment.release();
    this.controller.cancelInteractionRead();
    this.callerReads.clear();
    this.configuration.release();
    this.inputConfiguration.release();
    this.providers.release();
    this.mcp.release();
    if (includeGlobalSettings) {
      this.userMcp.release();
      this.skills.release();
    }
    this.extensions.release();
    this.jobOutput.release();
    this.fileChanges.release();
    this.toolMessages.release();
    this.imageReads.release();
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
  private environmentSnapshot(): DesktopSnapshot | undefined {
    if (this.permissionUnavailable) return undefined;
    const snapshot =
      this.controller.snapshot ??
      (this.refreshing &&
      this.lastView?.selection === this.selection &&
      this.lastView.snapshot.sessionId === this.selected
        ? this.lastView.snapshot
        : undefined);
    return snapshot &&
      snapshot.sessionId === this.selected &&
      snapshot.view.storeId === this.client.serverInfo?.storeId &&
      snapshot.view.session.parentSessionId === null &&
      snapshot.view.session.deletedAt === null
      ? snapshot
      : undefined;
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
            if (selected === this.selected && view === this.selection) {
              this.permissionUnavailable = true;
              this.environment.release();
              this.jobOutput.release();
            }
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
    // Main may hand off its just-completed paired admission. Consume it once;
    // serverInfo alone is insufficient after network disposal or a later attach.
    const initialAdmission = this.initialAdmission;
    this.initialAdmission = undefined;
    if (!initialAdmission?.()) await this.client.connect();
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
      this.historyHead = undefined;
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
        readySeen = false,
        startAfter: AppliedCursor | undefined;
      while (!signal.signal.aborted && !this.closed) {
        try {
          if (reset) {
            readySeen = false;
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
            onReady: async (ready) => {
              // observe() reconnects internally. A new transport needs a fresh history
              // baseline even when replay did not expire; ready's head is not an ACK.
              if (readySeen) {
                this.historyEpoch++;
                this.historyHead = undefined;
                this.messageRead?.abort.abort();
              }
              readySeen = true;
              this.environmentRevision++;
              this.selectedEnvironmentRevision++;
              this.observationUnavailable = false;
              this.permissionUnavailable = false;
              this.changed();
              if (
                this.selected &&
                this.client.serverInfo?.capabilities.includes('session_reconciliation')
              ) {
                const sessionId = this.selected,
                  selection = this.selection;
                try {
                  await this.controller.selectSession(sessionId);
                } catch {
                  if (this.selected === sessionId && this.selection === selection) {
                    this.permissionUnavailable = true;
                    this.changed();
                  }
                }
              }
              // A ready-only stream at the reloaded baseline adds no new facts.
              if (!startAfter || ready.highWaterCursor !== startAfter.sequence)
                this.scheduleRefresh(signal.signal);
            },
            onChange: (change) => {
              this.environmentRevision++;
              const historyOnly =
                !!this.selected &&
                this.client.serverInfo?.capabilities.includes('message_changes') &&
                ((change.type === 'message.updated' && change.sessionId === this.selected) ||
                  (change.type === 'session.renamed' && change.sessionId !== this.selected) ||
                  (change.type.endsWith('.history_collected') &&
                    change.sessionId !== this.selected));
              if (historyOnly) {
                this.historyHead = {
                  sessionId: this.selected!,
                  selection: this.selection,
                  cursor: change.cursor,
                };
                this.changed();
              }
              this.scheduleDirectoryRefresh();
              // The global cursor is still acknowledged for every change. Only
              // selected facts and their observed root/Workspace controls invalidate metadata.
              if (
                (!change.sessionId && change.type !== 'host_control.changed') ||
                change.sessionId === this.selected ||
                permissionChangeAffectsView(
                  change,
                  this.controller.permissionView,
                  this.client.serverInfo?.storeId,
                )
              ) {
                // Preparation itself re-reads the applied grant. Its own durable event
                // must not invalidate that read; foreign changes still refresh immediately.
                if (
                  change.type === 'host_control.changed' &&
                  this.workspaceAccessPreparations.has(change.objectId)
                )
                  this.workspaceAccessRefreshRequested = true;
                else if (!historyOnly) this.scheduleSelectionRefresh(signal.signal);
              }
              // Creation is conservative: the next exact root directory establishes
              // a new descendant's membership. Known descendants need no foreign View GET.
              if (
                !change.sessionId ||
                change.sessionId === this.selected ||
                change.type === 'session.created' ||
                this.environment.includesSession(change.sessionId)
              )
                this.selectedEnvironmentRevision++;
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
            canReadInputQueue:
              !!this.privateData &&
              this.client.serverInfo!.capabilities.includes('pending_input_queue'),
            viewGeneration: snapshot.generation,
            viewSelection: this.selection,
            historyCursor: this.client.serverInfo!.capabilities.includes('message_changes')
              ? snapshot.view.snapshotCursor
              : undefined,
            historyTargetCursor:
              this.historyHead?.sessionId === this.selected &&
              this.historyHead.selection === this.selection &&
              BigInt(this.historyHead.cursor) > BigInt(snapshot.view.snapshotCursor)
                ? this.historyHead.cursor
                : undefined,
            storeId: snapshot.view.storeId,
            session: snapshot.view.session,
            runs: snapshot.view.runs,
            // Same-selection refresh keeps readonly display facts, while all
            // actions still wait for fresh permissions. Real observation or
            // permission loss revokes the hot indicator immediately.
            compressionProgress:
              this.observationUnavailable || this.permissionUnavailable
                ? undefined
                : snapshot.view.compressionProgress,
            compressionMessages: snapshot.view.messages
              .filter((message) => message.compression && !message.originMessage)
              .map(({ id, sessionId, runId, seq, sourceIds, status, compression }) => ({
                id,
                sessionId,
                runId,
                seq,
                sourceIds,
                status,
                compression,
                role: 'assistant' as const,
                content: '',
              })),
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
      selectedEnvironmentRevision: this.selectedEnvironmentRevision,
      environmentReadUnavailable:
        this.observationUnavailable || this.permissionUnavailable || !this.environmentSnapshot(),
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
      userMcpSubmissions: this.userMcp.submissions,
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
  async openEditor(editor: DesktopEditor, target: string): Promise<void> {
    if (this.closed) throw new ClientError('native_draining');
    await openEditor(editor, target, this.processes);
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
      this.images.reset();
      this.inputFiles.reset();
      this.releaseReads();
      this.background.release();
      this.invalidateDirectory(true);
      this.directoryEnabled = true;
      this.selection++;
      const generation = ++this.generation;
      this.selected = undefined;
      this.activation = undefined;
      await this.startObservation();
      this.check(generation);
      return this.state();
    }
    if (
      request.method.startsWith('settings.mcp.') &&
      !['settings.mcp.lookup', 'settings.mcp.clear', 'settings.mcp.close'].includes(request.method)
    )
      throw new ClientError('mcp_user_scope_required');
    if (
      !request.method.startsWith('background.') &&
      !request.method.startsWith('interactionHistory.') &&
      !request.method.startsWith('extensions.') &&
      !request.method.startsWith('settings.userMcp.') &&
      ![
        // These reads use the exact retained selection and report unavailable
        // permissions while metadata refreshes; they must not wait for that GET.
        'state',
        'messages',
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
        'toolMessages.contextUsage',
        'toolMessages.close',
        'input.image.open',
        'input.image.read',
        'input.image.close',
        'input.images.begin',
        'input.images.append',
        'input.images.finish',
        'input.images.release',
        'input.files.begin',
        'input.files.append',
        'input.files.finish',
        'input.files.release',
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
      case 'input.queue.read':
        result = await this.inputQueue.read(request);
        break;
      case 'input.queue.close':
        this.inputQueue.closeRead(request.readId);
        result = null;
        break;
      case 'input.queue.withdraw':
      case 'input.queue.reorder':
        result = await this.inputQueue.mutate(request);
        break;
      case 'input.queue.lookup':
        result = await this.inputQueue.lookup(request.commandId);
        break;
      case 'input.queue.ack':
        this.inputQueue.ack(request.commandId);
        result = null;
        break;
      case 'input.images.begin':
        this.images.begin(request);
        result = null;
        break;
      case 'input.files.begin':
        this.inputFiles.begin(request);
        result = null;
        break;
      case 'input.files.append':
        this.inputFiles.append(request.id, request.offset, request.data);
        result = null;
        break;
      case 'input.files.finish':
        this.inputFiles.finish(request.id);
        result = null;
        break;
      case 'input.files.release':
        this.inputFiles.release(request.id);
        result = null;
        break;
      case 'input.images.append':
        this.images.append(request.id, request.offset, request.data);
        result = null;
        break;
      case 'input.images.finish':
        this.images.finish(request.id);
        result = null;
        break;
      case 'input.images.release':
        this.images.release(request.id);
        result = null;
        break;
      case 'input.image.open':
        result = await this.imageReads.open(request);
        break;
      case 'input.image.read':
        result = this.imageReads.read(request.readId, request.offset);
        break;
      case 'input.image.close':
        this.imageReads.close(request.readId);
        result = null;
        break;
      case 'scheduled.list':
      case 'scheduled.save':
      case 'scheduled.toggle':
      case 'scheduled.delete':
      case 'scheduled.runNow': {
        const tasks = this.scheduledTasks;
        if (!tasks) throw new ClientError('scheduled_tasks_unavailable');
        if (request.method === 'scheduled.save')
          await this.serializeSettingsMutation(async () => {
            this.check(generation);
            this.providers.assertSchedulingAllowed();
            return tasks.save(request.input, request.operation);
          });
        else if (request.method === 'scheduled.toggle')
          await this.serializeSettingsMutation(async () => {
            this.check(generation);
            if (request.enabled) this.providers.assertSchedulingAllowed();
            return tasks.toggle(request.id, request.enabled);
          });
        else if (request.method === 'scheduled.delete')
          await this.serializeSettingsMutation(async () => {
            this.check(generation);
            return tasks.delete(request.id);
          });
        else if (request.method === 'scheduled.runNow') await tasks.runNow(request.id);
        result = tasks.list();
        break;
      }
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
      case 'toolMessages.contextUsage':
        result = await this.toolMessages.contextUsage(request);
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
        result = await this.fileChanges.detail(request.changeId, request.readId, request.offset);
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
      case 'settings.userMcp.read':
        return this.userMcp.read();
      case 'settings.userMcp.close':
        this.userMcp.release();
        return this.state();
      case 'settings.userMcp.submit':
        return this.userMcp.submit(request.observationId, request.operation);
      case 'settings.userMcp.lookup':
        return this.userMcp.lookup(request.commandId);
      case 'settings.userMcp.cancel':
        return this.userMcp.cancel(request.commandId);
      case 'settings.userMcp.clear':
        this.userMcp.clear(request.commandId);
        return this.state();
      case 'settings.userMcp.tools':
        return this.userMcp.tools(
          request.observationId,
          request.serverId,
          request.connectionGeneration,
          request.afterIndex,
        );
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
      case 'context.results.next':
        result = await this.context.nextResults(request.observationId);
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
        result = await this.configuration.read();
        break;
      case 'input.models.read': {
        if (!this.selected) throw new ClientError('native_selection_changed');
        const sessionId = this.selected;
        const facts = await this.inputConfiguration.read();
        result = {
          ...facts,
          ...(this.privateData?.modelRoute(facts.storeId, sessionId)
            ? { selectedModelId: this.privateData.modelRoute(facts.storeId, sessionId) }
            : {}),
        };
        break;
      }
      case 'conversation.models.read':
        result = { ...(await this.preparationConfiguration.read()), canWrite: false };
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
        result = await this.serializeSettingsMutation(async () => {
          this.check(generation);
          return this.providers.submit(request.observationId, request.operation, request.secret);
        });
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
        const previous = this.activation;
        const retry = request.activationId !== undefined && previous?.id === request.activationId;
        if (
          request.activationId !== undefined &&
          previous &&
          (request.activationId < previous.id ||
            (retry &&
              (previous.sessionId !== request.sessionId ||
                previous.selection !== this.selection ||
                this.selected !== request.sessionId)))
        )
          throw new ClientError('native_selection_changed');
        if (retry) {
          // A lost IPC reply or failed read does not authorize replaying activation's POST.
          const check = () => {
            this.check(generation);
            if (
              this.activation !== previous ||
              this.selected !== request.sessionId ||
              this.selection !== previous!.selection
            )
              throw new ClientError('native_selection_changed');
          };
          check();
          let refreshed = false;
          while (this.refreshing) {
            await this.refreshing.catch(() => {});
            check();
            if (
              !this.permissionUnavailable &&
              this.controller.snapshot?.sessionId === request.sessionId
            ) {
              refreshed = true;
              break;
            }
          }
          if (!refreshed) {
            const reading = this.controller.refreshSession(request.sessionId);
            this.refreshing = reading;
            try {
              await reading;
            } finally {
              if (this.refreshing === reading) this.refreshing = undefined;
              if (this.refreshRequested && this.observer)
                this.scheduleRefresh(this.observer.signal);
            }
          }
          check();
          this.permissionUnavailable = false;
          const snapshot = this.selectScope(request.sessionId);
          this.contextWorkspace = {
            sessionId: request.sessionId,
            selection: this.selection,
            workspaceId: snapshot.view.session.workspaceId,
          };
          result = this.state();
          break;
        }
        this.releaseReads(false);
        this.lastView = undefined;
        this.contextWorkspace = undefined;
        this.selection++;
        this.selected = request.sessionId;
        this.activation =
          request.activationId === undefined
            ? undefined
            : { id: request.activationId, sessionId: request.sessionId, selection: this.selection };
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
        if (!request.changes && BigInt(upperSeq) > BigInt(snapshot.view.session.nextSeq))
          throw new ClientError('history_high_water_unavailable');
        const historyCursor =
          this.historyHead?.sessionId === this.selected &&
          this.historyHead.selection === selection &&
          BigInt(this.historyHead.cursor) > BigInt(snapshot.view.snapshotCursor)
            ? this.historyHead.cursor
            : snapshot.view.snapshotCursor;
        if (request.changes && BigInt(request.changes.upperCursor) > BigInt(historyCursor))
          throw new ClientError('history_high_water_unavailable');
        const readId = request.readId ?? crypto.randomUUID();
        if (
          this.messageRead?.readId !== readId ||
          this.messageRead.generation !== request.generation ||
          this.messageRead.selection !== selection ||
          this.messageRead.sessionId !== request.sessionId ||
          this.messageRead.storeId !== snapshot.view.storeId ||
          this.messageRead.upperSeq !== upperSeq ||
          this.messageRead.abort.signal.aborted
        ) {
          this.messageRead?.abort.abort();
          this.messageRead = {
            readId,
            generation: request.generation,
            selection,
            sessionId: request.sessionId,
            storeId: snapshot.view.storeId,
            upperSeq,
            abort: new AbortController(),
          };
        }
        const reading = this.messageRead!;
        let limit = Math.min(request.limit ?? 100, reading.effectiveLimit ?? Infinity);
        for (;;) {
          let messages: Message[];
          let changesPage: Awaited<ReturnType<AgentClient['listMessageChanges']>> | undefined;
          try {
            if (request.changes) {
              changesPage = await this.client.listMessageChanges(
                request.sessionId,
                {
                  storeId: snapshot.view.storeId,
                  ...request.changes,
                  upperSeq: request.upperSeq,
                  afterSeq: request.afterSeq,
                  limit,
                },
                { signal: reading.abort.signal },
              );
              messages = changesPage.messages;
            } else
              messages = await this.client.listMessages(request.sessionId, {
                afterSeq: request.afterSeq,
                upperSeq,
                limit,
                signal: reading.abort.signal,
              });
          } catch (error) {
            if (
              request.changes &&
              (error as { code?: string }).code === 'cursor_expired' &&
              selection === this.selection &&
              request.sessionId === this.selected
            ) {
              this.historyEpoch++;
              this.historyHead = undefined;
              await this.controller.refreshSession(request.sessionId);
              this.changed();
            }
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
            highWaterSeq: changesPage?.highWaterSeq ?? upperSeq,
            nextAfterSeq: changesPage
              ? changesPage.nextAfterSeq
              : messages.length === limit && messages.at(-1)!.seq !== upperSeq
                ? messages.at(-1)!.seq
                : null,
            ...(changesPage
              ? {
                  changes: {
                    afterCursor: changesPage.afterCursor,
                    upperCursor: changesPage.upperCursor,
                    nextCursor: changesPage.nextCursor,
                    removedIds: changesPage.removedIds,
                  },
                }
              : {}),
          };
          if (Buffer.byteLength(JSON.stringify(page)) > 4 * 1048576 - 256) {
            if (limit === 1) throw new ClientError('history_item_unavailable');
            limit = Math.max(1, Math.floor(limit / 2));
            continue;
          }
          if (changesPage) reading.upperSeq = changesPage.highWaterSeq;
          reading.effectiveLimit = Math.min(reading.effectiveLimit ?? Infinity, limit);
          for (const message of messages)
            this.observedMessages.set(message.id, structuredClone(message));
          for (const id of changesPage?.removedIds ?? []) this.observedMessages.delete(id);
          if (
            page.nextAfterSeq === null &&
            !request.changes &&
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
        if (snapshot.permissions) {
          const before = this.controller.permissionSubmissions.length;
          const preparation = this.controller.prepareWorkspaceAccess(
            snapshot.permissions.observationId,
          );
          const grant = this.controller.permissionSubmissions[before];
          if (grant) this.workspaceAccessPreparations.add(grant.intent.commandId);
          try {
            await preparation;
          } finally {
            if (grant) this.workspaceAccessPreparations.delete(grant.intent.commandId);
            if (!this.workspaceAccessPreparations.size && this.workspaceAccessRefreshRequested) {
              this.workspaceAccessRefreshRequested = false;
              if (this.observer) this.scheduleSelectionRefresh(this.observer.signal);
            }
          }
          this.check(generation);
          if (originalSelection !== this.selection || this.selected !== request.sessionId)
            throw new ClientError('native_selection_changed');
        }
        let intent = request.intent;
        if (request.imageIds?.length) {
          const images = await this.images.publish(
            this.client,
            snapshot.view.storeId,
            request.sessionId,
            request.imageIds,
          );
          this.check(generation);
          if (originalSelection !== this.selection || this.selected !== request.sessionId)
            throw new ClientError('native_selection_changed');
          intent = { ...request.intent, images };
        }
        if (request.fileIds?.length) {
          const files = await this.inputFiles.publish(
            this.client,
            snapshot.view.storeId,
            request.sessionId,
            request.fileIds,
          );
          this.check(generation);
          if (originalSelection !== this.selection || this.selected !== request.sessionId)
            throw new ClientError('native_selection_changed');
          intent = { ...intent, files };
        }
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
        const prepared = await this.requireCaller().prepare(request.sessionId, intent, draftProof);
        if (intent.kind !== 'input.steer' && intent.modelId)
          this.requirePrivateData().rememberModelRoute(
            intent.expectedStoreId,
            request.sessionId,
            intent.modelId,
          );
        this.check(generation);
        if (originalSelection !== this.selection || this.selected !== request.sessionId)
          throw new ClientError('native_selection_changed');
        result = inputMetadata(
          intent.kind === 'run.start'
            ? await this.input.start(request.sessionId, intent)
            : intent.kind === 'input.steer'
              ? await this.input.steer(request.sessionId, intent)
              : await this.input.followUp(request.sessionId, intent),
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
          if (selected === this.selected && view === this.selection) {
            this.permissionUnavailable = true;
            this.environment.release();
            this.jobOutput.release();
          }
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
    this.initialAdmission = undefined;
    this.directoryEnabled = false;
    this.releaseReads();
    this.background.release();
    this.invalidateDirectory(true);
    this.preparationConfiguration.release();
    this.workspaceObservation = undefined;
    this.selection++;
    this.generation++;
    this.images.reset();
    this.inputFiles.reset();
    this.selected = undefined;
  }
  async disposeNetwork() {
    this.initialAdmission = undefined;
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
    const stopped = this.processes.close();
    try {
      await this.images.close();
      await this.inputFiles.close();
      await this.imageReads.closeAll();
      await this.disposeNetwork();
      await this.inputQueue.close();
      await this.settingsMutationTail;
      await Promise.allSettled(this.creating.values());
      await this.conversation.close();
      this.input.disposeObserver();
      this.controller.disposeNetwork();
    } finally {
      await stopped;
    }
  }
  private acceptWorkspaceRemoval(result: import('../src/native-bridge').NativeWorkspaceRemoval) {
    if (result.phase !== 'applied' || result.storeId !== this.client.serverInfo?.storeId) return;
    if (
      this.directory?.sessions.find((s) => s.id === this.selected)?.workspaceId ===
        result.workspaceId ||
      this.lastView?.snapshot.view.session.workspaceId === result.workspaceId
    ) {
      this.releaseReads(false);
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
