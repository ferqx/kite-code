import type {
  AppMcpActionResponse,
  AppMcpServer,
  AppMcpSnapshot,
  ProviderModelSnapshot,
  SkillCatalogSnapshot,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
  type KiteAppServerConnection,
} from '@kite-ai/kite-local-runtime/client/protocol';
import {
  RuntimeClientError,
  type RuntimeClientNotificationWithGeneration,
} from '@kite-ai/runtime-client';
import type {
  RuntimeApprovalInteraction,
  RuntimeCommand,
  RuntimeInputInteraction,
  RuntimeInteractionResponse,
  RuntimeLogSessionPage,
  RuntimePlanReviewInteraction,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import type {
  BranchSnapshot,
  DesktopConfirmOptions,
  DesktopProject,
  DesktopRuntimeStatus,
  KiteDesktopBridge,
} from './bridge';
import { projectHistory } from './history-projection';
import { type ProviderInput, saveProvider } from './models';
import { isActiveRun, type Message, projectEventWithIdentity } from './presentation';
import { SessionHistoryCache } from './session-cache';
import { type DesktopConnectionInfo, desktopTransport } from './transport';

export type { BranchSnapshot, DesktopProject } from './bridge';

export class CommandResultUnknown extends Error {
  readonly commandType?: RuntimeCommand['type'];
  constructor(message: string, commandType?: RuntimeCommand['type']) {
    super(message);
    this.commandType = commandType;
  }
  sessionId?: string;
}

export type DesktopSessionSummary = Pick<
  RuntimeSessionProjection,
  'sessionId' | 'displayName' | 'workspace' | 'workspaceDigest' | 'updatedAt'
> &
  Partial<
    Pick<RuntimeSessionProjection, 'revision' | 'lifecycle' | 'currentRun' | 'interactionQueue'>
  > & {
    workspaceName?: string;
    workspaceId?: string;
  };

export interface DesktopView {
  projects?: readonly DesktopProject[];
  directory?: readonly DesktopSessionSummary[];
  directoryLoading?: readonly string[];
  directoryErrors?: Readonly<Record<string, string>>;
  projectError?: string;
  modelError?: string;
  branchError?: string;
  branch?: BranchSnapshot;
  workspace: string;
  connected: boolean;
  error?: string;
  commandError?: string;
  trust?: WorkspaceTrustQueryResponse;
  models?: ProviderModelSnapshot;
  mcp?: AppMcpSnapshot;
  skills?: SkillCatalogSnapshot;
  sessions: readonly DesktopSessionSummary[];
  selected?: string;
  messages: readonly Message[];
  projection?: RuntimeSessionProjection;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  ready: boolean;
  loadingSession: boolean;
  hasLoadedHistory: boolean;
}

export async function readCompleteSessionDirectory(
  readPage: (cursor?: RuntimeLogSessionPage['nextCursor']) => Promise<RuntimeLogSessionPage>,
): Promise<RuntimeLogSessionPage['entries'][number][]> {
  const entries: RuntimeLogSessionPage['entries'][number][] = [];
  let cursor: RuntimeLogSessionPage['nextCursor'];
  for (;;) {
    const page = await readPage(cursor);
    entries.push(...page.entries);
    if (!page.hasMore) return entries;
    if (
      !page.nextCursor ||
      (cursor &&
        page.nextCursor.updatedAt === cursor.updatedAt &&
        page.nextCursor.sessionId === cursor.sessionId)
    )
      throw new Error('会话目录分页未继续前进。');
    cursor = page.nextCursor;
  }
}

export class DesktopClient {
  readonly #bridge?: KiteDesktopBridge;
  constructor(bridge?: KiteDesktopBridge) {
    this.#bridge = bridge;
  }

  #view: DesktopView = {
    workspace: '',
    connected: false,
    sessions: [],
    messages: [],
    ready: false,
    loadingSession: false,
    hasLoadedHistory: false,
  };
  #listeners = new Set<() => void>();
  #connection?: KiteAppServerConnection;
  #connectionId?: number;
  #selection?: AbortController;
  #selectionLoad?: {
    sessionId: string;
    connection: KiteAppServerConnection;
    promise: Promise<void>;
  };
  #calibratedSelection?: {
    readonly controller: AbortController;
    readonly subscriptionGeneration: number;
  };
  readonly #historyCache = new SessionHistoryCache();
  #historyConnection?: KiteAppServerConnection;
  #historyWorkspaceDigest?: string;
  #mcpRead = 0;
  #skillsRead = 0;
  #unsubscribe?: () => void;
  #admitted = new Set<string>();
  #connecting?: Promise<void>;
  #recovering?: Promise<void>;
  #wakeRecovery?: () => void;
  #workspacePreparation?: Promise<void>;
  #directoryRead = 0;
  #recoveryGeneration = 0;
  #branchRead = 0;
  #modelRead = 0;
  #modelCatalogInitialized = false;
  getSnapshot = () => this.#view;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #native() {
    const bridge = this.#bridge ?? (typeof window === 'undefined' ? undefined : window.kiteDesktop);
    if (!bridge) throw new Error('Desktop 宿主接口不可用。');
    return bridge;
  }
  handleHeaderMouseDown(clickCount: 1 | 2) {
    return clickCount === 2 ? this.#native().toggleWindowMaximize() : Promise.resolve();
  }
  confirm(options: DesktopConfirmOptions) {
    return this.#native().showConfirm(options);
  }
  copyText(text: string) {
    return this.#native().writeClipboardText(text);
  }
  #publish(change: Partial<DesktopView>) {
    if (
      Object.entries(change).every(([key, value]) => this.#view[key as keyof DesktopView] === value)
    )
      return;
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }
  report(error: unknown) {
    this.#publish({ error: messageOf(error) });
  }
  clearError() {
    this.#publish({
      error: undefined,
      commandError: undefined,
      projectError: undefined,
      branchError: undefined,
    });
  }

  async openProject() {
    if (this.#connection) throw new Error('请先断开当前项目。');
    const selected = await this.pickProject();
    if (selected) await this.activateProject(selected);
  }
  async refreshProjects() {
    const projects = await this.#native().listProjects();
    const current = this.#view.projects;
    this.#publish({
      projects:
        current?.length === projects.length &&
        current.every(
          (project, index) =>
            project.path === projects[index]?.path &&
            project.lastOpenedAt === projects[index]?.lastOpenedAt &&
            project.directoryMissing === projects[index]?.directoryMissing,
        )
          ? current
          : projects,
    });
  }
  hasNativeConnection() {
    return this.#connectionId !== undefined;
  }
  async restoreWorkspace() {
    if (this.#connection?.status === 'active') {
      await this.#workspacePreparation;
      return;
    }
    const status: DesktopRuntimeStatus = await this.#native().runtimeStatus();
    if (this.getSnapshot().connected) return;
    this.#publish({ workspace: status.workspace ?? '' });
    await this.connect();
    await this.#workspacePreparation;
  }
  async pickProject() {
    const path = await this.#native().pickWorkspace();
    if (path) await this.refreshProjects();
    return path;
  }
  async activateProject(path: string) {
    if (this.#connection) {
      if (this.#view.workspace !== path) throw new Error('请先断开当前项目。');
    } else {
      await this.#native().activateWorkspace(path);
      await this.connect({ refreshDirectory: false });
    }
    await this.#workspacePreparation;
    // Explicit project selection is consent for this workspace. Startup and
    // reconnect only read trust; associated external roots still need consent.
    const trust = this.#view.trust;
    if (trust?.status === 'unknown' && trust.canDecide && !trust.externalReadScope.roots.length)
      await this.trustProject();
  }
  async checkProject(workspace: string) {
    // Native query validates the explicitly registered canonical directory without activating it.
    return this.#native().checkWorkspace(workspace);
  }
  async queryProjectBranch(workspace: string) {
    await this.checkProject(workspace);
    return this.#native().queryWorkspaceBranch(workspace);
  }
  async refreshBranch() {
    const read = ++this.#branchRead;
    const workspace = this.#view.workspace;
    if (!workspace) return;
    try {
      const branch = await this.#native().queryWorkspaceBranch(workspace);
      if (this.#view.workspace === workspace && read === this.#branchRead)
        this.#publish({ branch, branchError: undefined });
      return branch;
    } catch (error) {
      if (this.#view.workspace === workspace && read === this.#branchRead)
        this.#publish({ branch: undefined, branchError: messageOf(error) });
      throw error;
    }
  }
  async hasActiveTasks() {
    if (this.#connection?.status !== 'active') return this.hasNativeConnection();
    const result = await this.#connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'list_sessions',
    });
    if (result.status !== 'ok' || !result.sessions || result.sessions.length >= 1000) return true;
    return result.sessions.some(isActiveRun);
  }
  async switchBranch(name: string) {
    const expected = this.#view.branch;
    if (!expected || expected.workspace !== this.#view.workspace)
      throw new Error('请先刷新当前项目分支。');
    if (expected.current === name) return;
    if (this.#view.trust?.status !== 'trusted') throw new Error('请先确认工作区信任。');
    const connection = this.#requireConnection();
    const directory = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'list_sessions',
    });
    if (directory.status !== 'ok' || !directory.sessions || directory.sessions.length >= 1000)
      throw new Error('无法完整确认任务状态，暂时不能切换分支。');
    if (
      directory.sessions.some(
        (session) =>
          session.workspaceDigest === this.#view.trust?.workspace.workspaceDigest &&
          isActiveRun(session),
      )
    )
      throw new Error('项目中有运行或等待中的任务，请先结束任务再切换分支。');
    const actual = await this.refreshBranch();
    if (!actual || !sameEnvironment(expected, actual))
      throw new Error('项目或分支已改变，请重新选择。');
    if (!actual.canSwitch) throw new Error('请打开 Git 仓库根目录后切换分支。');
    if (actual.dirty) throw new Error('工作区有未提交或未跟踪的改动，请先处理后再切换分支。');
    if (!actual.branches.includes(name)) throw new Error('所选本地分支已不存在，请刷新后重试。');
    await this.disconnect();
    this.#publish({ branch: undefined });
    let failure: unknown;
    try {
      const branch = await this.#native().switchWorkspaceBranch(actual, name);
      this.#publish({ branch });
    } catch (error) {
      failure = error;
    }
    // Always query the actual environment. Never retry or undo the Git mutation.
    try {
      await this.refreshBranch();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.connect();
      await this.#workspacePreparation;
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  async prepareNewConversation() {
    const connection = this.#requireConnection();
    const workspace = this.#view.workspace;
    const expected = this.#view.branch;
    // Git is an optional project capability, not a precondition for general work.
    await this.checkProject(workspace);
    const [, trust] = await Promise.all([
      expected ? this.refreshBranch().catch(() => undefined) : undefined,
      readWithDeadline(
        connection.app.queryWorkspaceTrust({
          schema: 'kite.app.workspace-trust.query-request.v1',
          workspace,
        }),
      ),
    ]);
    if (this.#connection !== connection || this.#view.workspace !== workspace)
      throw new Error('项目连接已改变，请重新检查。');
    this.#publish({ trust });
    if (trust.status !== 'trusted') throw new Error('请先确认工作区信任。');
    const models = this.#view.models;
    if (!models) throw new Error('请先配置可用的模型。');
    const selected = models.selected;
    if (
      !selected ||
      !models.providers.some(
        (provider) => provider.provider === selected.provider && provider.readiness === 'ready',
      )
    )
      throw new Error('请先配置可用的模型。');
  }
  connect(options: { refreshDirectory?: boolean } = {}): Promise<void> {
    if (this.#connection?.status === 'active')
      return this.#view.selected && !this.#view.ready
        ? this.refreshSessions().then(() => this.selectSession(this.#view.selected!))
        : Promise.resolve();
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect(options.refreshDirectory ?? true).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }
  async #connect(refreshDirectory: boolean) {
    const selected = this.#view.selected;
    await this.#detach();
    const info: DesktopConnectionInfo = await this.#native().runtimeOpen();
    const connection = createAppServerProtocolConnection(
      desktopTransport(info, this.#native()),
      info.expectedServerVersion,
      { name: 'kite-desktop', version: '0.1.0', instanceId: crypto.randomUUID() },
      KITE_APP_SERVER_PROTOCOL_METHODS_,
    );
    this.#connection = connection;
    this.#connectionId = info.connectionId;
    this.#publish({
      workspace: info.workspace,
      error: undefined,
      ...(this.#view.workspace !== info.workspace
        ? {
            selected: undefined,
            sessions: [],
            messages: [],
            projection: undefined,
            ready: false,
            loadingSession: false,
            hasLoadedHistory: false,
          }
        : {}),
    });
    this.#unsubscribe = connection.subscribe(() => {
      if (this.#connection !== connection) return;
      const snapshot = connection.snapshotStore.getSnapshot();
      const session = this.#view.selected ? snapshot.sessions[this.#view.selected] : undefined;
      const calibrated = this.#calibratedSelection;
      const resyncSession =
        this.#view.selected &&
        session &&
        calibrated &&
        calibrated?.controller === this.#selection &&
        (!session.ready || session.subscriptionGeneration !== calibrated.subscriptionGeneration)
          ? this.#view.selected
          : undefined;
      if (resyncSession) this.#calibratedSelection = undefined;
      const runFinished =
        isActiveRun(this.#view.projection) &&
        !!session?.projection &&
        !isActiveRun(session.projection);
      const sessions = this.#view.sessions.map((item) =>
        mergeSessionSummary(item, snapshot.sessions[item.sessionId]?.projection),
      );
      const directory = this.#view.directory?.map((item) =>
        mergeSessionSummary(item, snapshot.sessions[item.sessionId]?.projection),
      );
      this.#publish({
        connected: connection.status === 'active',
        ready:
          connection.status === 'active' &&
          this.#calibratedSelection !== undefined &&
          this.#calibratedSelection.controller === this.#selection &&
          this.#calibratedSelection.subscriptionGeneration === session?.subscriptionGeneration &&
          !this.#selection?.signal.aborted &&
          (session?.ready ?? false),
        ...(session?.projection ? { projection: session.projection } : {}),
        // Refresh known summaries in place; live output must not move a clicked row.
        sessions: sessions.every((item, index) => item === this.#view.sessions[index])
          ? this.#view.sessions
          : sessions,
        ...(directory && !directory.every((item, index) => item === this.#view.directory?.[index])
          ? { directory }
          : {}),
      });
      if (resyncSession) {
        // A replacement subscription restores projection, not omitted message events.
        // Retain the body and reuse the existing bounded selection calibration once.
        void (this.#selectionLoad?.promise ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => {
            if (
              this.#connection === connection &&
              this.#selection === calibrated?.controller &&
              !this.#selection?.signal.aborted
            )
              return this.selectSession(resyncSession);
            return undefined;
          })
          .catch((error) => this.report(error));
      }
      if (connection.status === 'closed' || connection.status === 'disconnected') this.#recover();
      if (runFinished && connection.status === 'active')
        void this.refreshSessions().catch((error) => this.report(error));
    });
    try {
      await connection.prepareAppControl();
    } catch (error) {
      await this.#detach().catch(() => undefined);
      throw error;
    }
    this.#publish({ connected: true });
    // Independent read capabilities cannot tear down a healthy protocol peer.
    if (refreshDirectory) await this.refreshDirectory().catch(() => undefined);
    this.#workspacePreparation = this.#prepareWorkspace(connection);
    if (selected && this.#view.selected === selected && !this.#view.loadingSession)
      await this.selectSession(selected).catch((error) => {
        if (connection.status === 'active') this.report(error);
      });
  }
  async #prepareWorkspace(connection: KiteAppServerConnection) {
    const workspace = this.#view.workspace;
    if (!workspace) return;
    try {
      const [branch, trust] = await Promise.all([
        this.refreshBranch().catch(() => undefined),
        readWithDeadline(
          connection.app.queryWorkspaceTrust({
            schema: 'kite.app.workspace-trust.query-request.v1',
            workspace,
          }),
        ),
      ]);
      if (this.#connection !== connection) return;
      this.#publish({ trust, projectError: undefined });
      if (
        branch?.repository &&
        trust.status === 'unknown' &&
        trust.canDecide &&
        !trust.externalReadScope.roots.length
      )
        await this.trustProject();
      if (this.#connection !== connection) return;
      this.#updateSessions(connection);
    } catch (error) {
      if (this.#connection === connection && connection.status === 'active')
        this.#publish({ projectError: messageOf(error) });
      return;
    }
    // Provider/model choices are application/session concerns. A Workspace switch must not
    // reload or blank the selector; Settings owns explicit catalog refreshes.
    if (!this.#modelCatalogInitialized) {
      this.#modelCatalogInitialized = true;
      await this.refreshModels().catch(() => undefined);
    }
  }
  #recover() {
    if (this.#recovering) return;
    const generation = this.#recoveryGeneration;
    this.#recovering = (async () => {
      let attempt = 0;
      while (generation === this.#recoveryGeneration) {
        const delay = [250, 1000, 3000][Math.min(attempt++, 2)]!;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.#wakeRecovery = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wakeRecovery = undefined;
        if (generation !== this.#recoveryGeneration) return;
        if (this.#connection?.status === 'active') return;
        try {
          await this.connect();
          if (this.getSnapshot().connected) return;
        } catch {
          // Reattachment is internal. Retain content and retry with capped backoff;
          // only explicit user actions report their outcome, and writes are never replayed.
        }
      }
    })().finally(() => {
      this.#recovering = undefined;
    });
  }
  async #detach() {
    this.#selection?.abort();
    this.#selectionLoad = undefined;
    this.#calibratedSelection = undefined;
    this.#historyCache.clear();
    this.#historyConnection = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#admitted.clear();
    this.#publish({ connected: false, ready: false, loadingSession: false });
    if (connection) await connection.close();
  }
  async disconnect() {
    ++this.#recoveryGeneration;
    this.#wakeRecovery?.();
    await this.#recovering;
    const connectionId = this.#connectionId;
    await this.#detach();
    this.#connectionId = undefined;
    this.#publish({ trust: undefined, mcp: undefined, skills: undefined });
    // Only an explicit project/branch switch or exit owns process shutdown.
    if (connectionId !== undefined) await this.#native().runtimeClose(connectionId);
  }
  #requireConnection() {
    if (this.#connection?.status !== 'active') throw new Error('请先连接项目。');
    return this.#connection;
  }
  async trustProject() {
    const trust = this.#view.trust;
    if (!trust) throw new Error('尚未读取工作区信任。');
    const result = await this.#requireConnection().app.decideWorkspaceTrust({
      schema: 'kite.app.workspace-trust.decision-request.v1',
      workspace: trust.workspace,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
      externalReadScopeDigest: trust.externalReadScope.digest,
    });
    this.#publish({
      trust: {
        ...trust,
        status: result.status,
        revision: result.revision,
        workspace: result.workspace,
        externalReadScope: result.externalReadScope,
      },
    });
    if (result.status !== 'trusted') throw new Error(`工作区信任未生效：${result.outcome}`);
  }
  async refreshDirectory() {
    const connection = this.#requireConnection();
    const read = ++this.#directoryRead;
    // Saved text links persisted membership to the native picker. No project I/O is needed.
    const paths = new Map(
      await Promise.all(
        (this.#view.projects ?? []).map(
          async (project) => [await pathDigest(project.path), project.path] as const,
        ),
      ),
    );
    const scopes = ['', ...paths.keys()];
    if (this.#connection !== connection || read !== this.#directoryRead) return;
    this.#publish({ directoryLoading: scopes.map((scope) => paths.get(scope) ?? scope) });
    const failures: unknown[] = [];
    const load = async (scope: string) => {
      const label = paths.get(scope) ?? scope;
      try {
        const entries = await readCompleteSessionDirectory(async (cursor) => {
          let page: RuntimeLogSessionPage;
          for (let attempt = 0; ; attempt++) {
            try {
              page = await readWithDeadline(
                connection.history.listSessions({
                  limit: 100,
                  ...(scope ? { workspaceDigest: scope } : {}),
                  ...(cursor ? { cursor } : {}),
                }),
              );
              break;
            } catch (error) {
              if (
                attempt ||
                connection.status !== 'active' ||
                (error instanceof RuntimeClientError && error.protocol?.data.retryable === false)
              )
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          return page;
        });
        if (this.#connection !== connection || read !== this.#directoryRead) return;
        const sessions: DesktopSessionSummary[] = entries.map((entry) => ({
          sessionId: entry.sessionId,
          displayName: entry.displayName,
          updatedAt: new Date(entry.updatedAt).toISOString(),
          workspaceDigest: entry.workspace?.workspaceDigest,
          workspaceId: entry.workspace?.workspaceId,
          workspaceName: entry.workspace?.displayName,
          workspace: entry.workspace ? paths.get(entry.workspace.workspaceDigest) : undefined,
        }));
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        const previous = this.#view.directory ?? [];
        const known = new Set(previous.map((session) => session.sessionId));
        const errors = { ...this.#view.directoryErrors };
        delete errors[label];
        this.#publish({
          directoryErrors: errors,
          directory: [
            ...sessions.filter((session) => !known.has(session.sessionId)),
            ...previous.flatMap(
              (session) =>
                byId.get(session.sessionId) ??
                (scope && session.workspaceDigest !== scope ? [session] : []),
            ),
          ],
        });
        this.#updateSessions(connection);
      } catch (error) {
        failures.push(error);
        if (
          this.#connection === connection &&
          connection.status === 'active' &&
          read === this.#directoryRead
        )
          this.#publish({
            directoryErrors: { ...this.#view.directoryErrors, [label]: messageOf(error) },
          });
      } finally {
        if (this.#connection === connection && read === this.#directoryRead)
          this.#publish({
            directoryLoading: this.#view.directoryLoading?.filter((key) => key !== label),
          });
      }
    };
    // Each worker advances independently; one slow space cannot hold the next space behind it.
    // Bound outstanding RPCs below the protocol request limit even with many saved projects.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, scopes.length) }, async () => {
        while (
          next < scopes.length &&
          this.#connection === connection &&
          read === this.#directoryRead
        )
          await load(scopes[next++]!);
      }),
    );
    if (scopes.length && failures.length === scopes.length) throw failures[0];
  }
  #updateSessions(connection: KiteAppServerConnection) {
    if (this.#connection !== connection) return;
    this.#publish({
      sessions: (this.#view.directory ?? []).filter(
        (session) =>
          session.workspaceDigest !== undefined &&
          session.workspaceDigest === this.#view.trust?.workspace.workspaceDigest,
      ),
    });
  }
  async refreshSessions() {
    const connection = this.#requireConnection();
    await this.refreshDirectory();
    this.#updateSessions(connection);
  }
  async openFile(path: string, editor: 'vscode' | 'zed' | 'textedit') {
    this.#requireConnection();
    await this.#native().openEditor(this.#connectionId!, path, editor);
  }
  async refreshModels() {
    const read = ++this.#modelRead;
    const connection = this.#requireConnection();
    const workspace = this.#view.trust?.workspace;
    if (!workspace) throw new Error('尚未读取工作区。');
    let models: ProviderModelSnapshot;
    try {
      models = await readWithDeadline(
        connection.app.getProviderModelSnapshot({
          schema: 'kite.app.provider-model.snapshot-request.v1',
          workspace,
        }),
      );
    } catch (error) {
      if (
        this.#connection === connection &&
        connection.status === 'active' &&
        read === this.#modelRead
      )
        this.#publish({ modelError: messageOf(error) });
      throw error;
    }
    if (this.#connection === connection && read === this.#modelRead)
      this.#publish({ models, modelError: undefined });
    return models;
  }
  async configureProvider(input: ProviderInput) {
    await saveProvider(this.#requireConnection(), input, () => this.refreshModels());
  }
  async refreshMcp() {
    await this.#workspacePreparation;
    const read = ++this.#mcpRead;
    const connection = this.#requireConnection();
    const workspace = this.#view.trust?.workspace;
    if (!workspace) throw new Error('尚未读取工作区。');
    const mcp = await connection.app.getMcpSnapshot({
      schema: 'kite.app.mcp.snapshot-request.v1',
      workspace,
    });
    if (this.#connection === connection && read === this.#mcpRead) this.#publish({ mcp });
  }
  async refreshSkills() {
    await this.#workspacePreparation;
    const read = ++this.#skillsRead;
    const connection = this.#requireConnection();
    const workspace = this.#view.trust?.workspace;
    if (!workspace) throw new Error('尚未读取工作区。');
    const skills = await connection.app.getSkillCatalog({
      schema: 'kite.app.skill-catalog.request.v1',
      workspace,
    });
    if (this.#connection === connection && read === this.#skillsRead) this.#publish({ skills });
  }
  async runMcpAction(server: AppMcpServer, type: 'login' | 'reconnect' | 'cancel_auth') {
    const connection = this.#requireConnection();
    const workspace = this.#view.mcp?.workspace;
    if (!workspace) throw new Error('请先刷新 MCP 状态。');
    ++this.#mcpRead;
    let response: AppMcpActionResponse;
    try {
      response = await connection.app.applyMcpAction({
        schema: 'kite.app.mcp.action-request.v1',
        workspace,
        action: { type, key: server.key, expectedRevision: server.revision },
      });
    } catch {
      if (this.#connection !== connection) return;
      await this.refreshMcp().catch(() => undefined);
      throw new Error('MCP 操作结果未知，请检查状态后再决定是否重试。');
    }
    if (this.#connection !== connection) return;
    this.#publish({ mcp: response.snapshot });
    if (response.outcome !== 'applied')
      throw new Error(`MCP 操作未确认生效（${response.outcome}），请检查最新状态。`);
  }
  async selectModel(provider: string, name: string) {
    const connection = this.#requireConnection();
    const models = this.#view.models;
    if (!models) throw new Error('请先刷新模型配置。');
    let result: Awaited<ReturnType<KiteAppServerConnection['app']['selectProviderModel']>>;
    try {
      result = await connection.app.selectProviderModel({
        schema: 'kite.app.provider-model.select-request.v1',
        workspace: models.workspace,
        provider,
        name,
        expectedRevision: models.revision,
      });
    } catch {
      await this.refreshModels().catch(() => undefined);
      throw new Error('模型切换结果未知，请检查当前模型后再决定是否重试。');
    }
    if (this.#connection !== connection) return;
    this.#publish({ models: result.snapshot });
    if (result.outcome !== 'applied' && result.outcome !== 'already_selected')
      throw new Error(`模型未确认切换（${result.outcome}），请检查最新配置后重新选择。`);
  }
  async #command(command: RuntimeCommand) {
    const connection = this.#requireConnection();
    this.#publish({ commandError: undefined });
    let receipt: Awaited<ReturnType<typeof connection.runtime.command>>;
    try {
      receipt = await connection.runtime.command(command);
    } catch (cause) {
      if (
        cause instanceof RuntimeClientError &&
        cause.code !== 'connection_closed' &&
        cause.code !== 'connection_failed' &&
        // Admission unavailability is a pre-dispatch rejection. A generic internal
        // error may follow a durable commit, so its mutation result remains unknown.
        (cause.protocol?.data.code !== 'internal_error' ||
          cause.protocol.data.detailCode === 'temporarily_unavailable')
      ) {
        this.#publish({ commandError: cause.message });
        throw cause;
      }
      const error = new CommandResultUnknown(
        '操作提交结果未知。请检查会话与实际文件，再决定是否继续；不会自动重发。',
        command.type,
      );
      this.#publish({ commandError: error.message });
      throw error;
    }
    if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay')
      throw new Error(`操作未执行：${receipt.code}`);
    return receipt;
  }
  async newSession(model?: { readonly provider: string; readonly name: string }): Promise<string> {
    if (this.#view.trust?.status !== 'trusted') throw new Error('请先确认工作区信任。');
    const connection = this.#requireConnection();
    const selection = this.#selection;
    const selected = this.#view.selected;
    const sessionId = crypto.randomUUID();
    try {
      await this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'create_session',
        workspace: this.#view.workspace,
        bootstrapSessionId: sessionId,
        ...(model === undefined ? {} : { model }),
      });
    } catch (error) {
      if (error instanceof CommandResultUnknown) {
        error.sessionId = sessionId;
        // A late receipt belongs to this creation, not to a newer reading selection.
        if (
          this.#connection === connection &&
          this.#selection === selection &&
          this.#view.selected === selected
        ) {
          this.#selection?.abort();
          this.#selectionLoad = undefined;
          this.#calibratedSelection = undefined;
          this.#publish({
            selected: sessionId,
            messages: [],
            projection: undefined,
            ready: false,
            loadingSession: false,
            hasLoadedHistory: false,
          });
        }
      }
      throw error;
    }
    this.#admitted.add(sessionId);
    return sessionId;
  }
  selectSession(sessionId: string): Promise<void> {
    const connection = this.#connection;
    if (connection?.status !== 'active') return Promise.reject(new Error('请先连接项目。'));
    if (
      this.#selectionLoad?.sessionId === sessionId &&
      this.#selectionLoad.connection === connection
    )
      return this.#selectionLoad.promise;
    if (this.#view.selected === sessionId && this.#view.ready && !this.#view.loadingSession)
      return Promise.resolve();
    const promise = this.#loadSelection(sessionId, connection).finally(() => {
      if (this.#selectionLoad?.promise === promise) this.#selectionLoad = undefined;
    });
    this.#selectionLoad = { sessionId, connection, promise };
    return promise;
  }

  async #loadSelection(sessionId: string, connection: KiteAppServerConnection) {
    const sameSelection = this.#view.selected === sessionId;
    // Take first, so the target does not compete with the departing view for the inactive budget.
    const cached = sameSelection ? undefined : this.#historyCache.take(sessionId);
    if (
      !sameSelection &&
      this.#view.selected &&
      this.#view.hasLoadedHistory &&
      this.#historyConnection === connection &&
      this.#historyWorkspaceDigest
    ) {
      this.#historyCache.save(
        this.#view.selected,
        this.#historyWorkspaceDigest,
        this.#view.messages,
      );
    }
    this.#selection?.abort();
    const controller = new AbortController();
    this.#selection = controller;
    this.#calibratedSelection = undefined;
    const listedDigest = this.#view.directory?.find(
      (item) => item.sessionId === sessionId,
    )?.workspaceDigest;
    const usableCache =
      cached && (!listedDigest || listedDigest === cached.workspaceDigest) ? cached : undefined;
    this.#historyWorkspaceDigest = sameSelection
      ? this.#historyWorkspaceDigest
      : usableCache?.workspaceDigest;
    this.#historyConnection = sameSelection
      ? this.#historyConnection
      : usableCache
        ? connection
        : undefined;
    this.#publish({
      selected: sessionId,
      messages: sameSelection ? this.#view.messages : (usableCache?.messages ?? []),
      hasLoadedHistory: sameSelection
        ? this.#view.hasLoadedHistory
        : (usableCache?.hasLoadedHistory ?? false),
      ready: false,
      projection: sameSelection ? this.#view.projection : undefined,
      // Keep the last confirmed mode as a disabled loading placeholder. Clearing it makes
      // the controlled selector render Auto before the target Session history arrives.
      interactionMode: this.#view.interactionMode,
      error: undefined,
      loadingSession: true,
    });
    let timedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const loadingTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new Error('会话加载超时，请重新加载会话。'));
    }, 20_000);
    try {
      // Durable history is a read boundary of its own. A broken live projection
      // or subscription must not prevent the first reading of saved messages.
      let messages = await Promise.race([
        this.#readHistory(connection, sessionId, this.#view.messages, controller.signal),
        deadline,
      ]);
      if (
        controller.signal.aborted ||
        this.#connection !== connection ||
        this.#selection !== controller
      )
        return;
      // History is already authorized for the requested Session by the Service.
      // Directory membership can label reading; only fresh projection below
      // establishes the workspace identity needed for interactive readiness.
      this.#historyWorkspaceDigest ??= listedDigest;
      this.#historyConnection = connection;
      this.#publish({
        messages: messages.messages,
        interactionMode: messages.interactionMode,
        hasLoadedHistory: true,
      });
      const result = await Promise.race([
        connection.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId,
        }),
        deadline,
      ]);
      if (controller.signal.aborted || this.#connection !== connection) return;
      if (result.status === 'not_found')
        throw new InvalidHistoryIdentity('会话已不可用，请刷新目录。');
      if (result.status !== 'ok') throw new Error('会话暂时无法更新，请重新加载会话。');
      if (!result.session?.workspaceDigest)
        throw new InvalidHistoryIdentity('会话所属空间不可用，请刷新目录。');
      if (
        this.#historyWorkspaceDigest &&
        this.#historyWorkspaceDigest !== result.session.workspaceDigest
      )
        throw new InvalidHistoryIdentity('会话所属空间已改变，请重新加载会话。');
      this.#historyWorkspaceDigest = result.session.workspaceDigest;
      if (!this.#view.directory?.some((session) => session.sessionId === sessionId)) {
        const matches = await Promise.all(
          (this.#view.projects ?? []).map(async (project) =>
            (await pathDigest(project.path)) === result.session!.workspaceDigest
              ? project.path
              : undefined,
          ),
        );
        if (controller.signal.aborted || this.#connection !== connection) return;
        this.#publish({
          directory: [
            ...(this.#view.directory ?? []),
            {
              ...result.session,
              workspace: matches.find((path) => path !== undefined),
              workspaceId: result.session.workspaceDigest,
            },
          ],
        });
      }
      const notifications = await Promise.race([
        connection.runtime.subscribeReadyWithGeneration({
          spec: { scope: 'session', sessionId, includeEphemeral: true },
          signal: controller.signal,
        }),
        deadline,
      ]);
      // The initial subscription contains a current snapshot, not every event
      // since the History read. If that watermark advanced, calibrate once more
      // while the established subscription buffers all subsequent events.
      let subscribed = connection.snapshotStore.getSnapshot().sessions[sessionId];
      while (
        subscribed &&
        (!subscribed.ready || subscribed.projection.revision > messages.throughSequence)
      ) {
        messages = await Promise.race([
          this.#readHistory(connection, sessionId, this.#view.messages, controller.signal),
          deadline,
        ]);
        const current = connection.snapshotStore.getSnapshot().sessions[sessionId];
        // Later events in the same subscription are buffered. A resync during
        // this read invalidates that guarantee and needs a new history boundary.
        if (current?.ready && current.subscriptionGeneration === subscribed.subscriptionGeneration)
          break;
        subscribed = current;
      }
      if (
        controller.signal.aborted ||
        this.#connection !== connection ||
        this.#selection !== controller
      )
        return;
      const session = connection.snapshotStore.getSnapshot().sessions[sessionId];
      this.#historyConnection = connection;
      if (!session?.ready) throw new Error('会话订阅尚未恢复，请重新加载会话。');
      this.#calibratedSelection = {
        controller,
        subscriptionGeneration: session.subscriptionGeneration,
      };
      this.#publish({
        messages: messages.messages,
        interactionMode: messages.interactionMode,
        hasLoadedHistory: true,
        projection: session?.projection,
        ready: session?.ready ?? false,
      });
      void this.#followSelection(
        connection,
        controller,
        sessionId,
        notifications,
        messages.throughSequence,
      );
    } catch (error) {
      if (
        this.#selection !== controller ||
        this.#connection !== connection ||
        (!timedOut && controller.signal.aborted)
      )
        return;
      controller.abort();
      this.#calibratedSelection = undefined;
      if (invalidatesHistory(error)) {
        this.#historyWorkspaceDigest = undefined;
        this.#historyConnection = undefined;
        this.#publish({ messages: [], hasLoadedHistory: false, projection: undefined });
      }
      this.#publish({ ready: false });
      if (timedOut) throw new Error('会话加载超时，请重新加载会话。');
      if (this.#view.hasLoadedHistory)
        throw new Error(`会话更新失败，已保留已读内容。${messageOf(error)}`);
      throw error;
    } finally {
      clearTimeout(loadingTimeout);
      if (this.#selection === controller) this.#publish({ loadingSession: false });
    }
  }
  // Kept outside the subscription closure so full transcripts and old snapshots can be collected.
  async #readHistory(
    connection: KiteAppServerConnection,
    sessionId: string,
    previous: readonly Message[],
    signal: AbortSignal,
  ) {
    const transcript = await connection.history.loadSession(sessionId, undefined, { signal });
    const messages = await projectHistory(transcript.records, previous, signal);
    return {
      messages,
      interactionMode: transcript.interactionMode,
      throughSequence: transcript.session.lastSequence,
    };
  }

  async #followSelection(
    connection: KiteAppServerConnection,
    controller: AbortController,
    sessionId: string,
    notifications: AsyncIterable<RuntimeClientNotificationWithGeneration>,
    throughSequence: number,
  ) {
    try {
      for await (const { notification, connectionGeneration } of notifications) {
        if (
          controller.signal.aborted ||
          this.#selection !== controller ||
          this.#connection !== connection
        )
          return;
        if (
          connectionGeneration !== connection.generation ||
          !('durability' in notification) ||
          notification.sessionId !== sessionId
        )
          continue;
        // Durable revisions are source-record sequences; ephemeral sequence numbers are stream-local.
        if (notification.durability === 'durable' && notification.revision <= throughSequence)
          continue;
        const event =
          notification.durability === 'ephemeral'
            ? notification.event
            : notification.projection.event;
        if (event)
          this.#publish({
            messages: projectEventWithIdentity(this.#view.messages, event, {
              turnId: notification.turnId,
            }),
            ...(event.type === 'interaction_mode.changed' ? { interactionMode: event.mode } : {}),
          });
      }
      if (
        !controller.signal.aborted &&
        this.#connection === connection &&
        this.#selection === controller
      )
        throw new Error('会话订阅已结束，请重新加载会话。');
    } catch (error) {
      if (
        !controller.signal.aborted &&
        this.#connection === connection &&
        this.#selection === controller
      ) {
        this.#calibratedSelection = undefined;
        this.#publish({ ready: false });
        this.report(error);
      }
    }
  }

  async send(
    input: string,
    targetSessionId?: string,
    model?: { readonly provider: string; readonly name: string },
  ) {
    const sessionId = targetSessionId ?? this.#view.selected;
    if (!sessionId || !input.trim()) return;
    // Explicit creation targets remain independent of the current reading selection.
    if (sessionId === this.#view.selected && (!this.#view.ready || this.#view.loadingSession))
      throw new Error('会话尚未同步完成，请稍后再试。');
    const trust = this.#view.trust;
    if (trust?.status !== 'trusted') throw new Error('请先确认工作区信任。');
    const trustedWorkspaceDigest = trust.workspace.workspaceDigest;
    const knownSession =
      this.#view.selected === sessionId
        ? this.#view.projection
        : this.#view.directory?.find((session) => session.sessionId === sessionId);
    if (knownSession?.workspaceDigest && knownSession.workspaceDigest !== trustedWorkspaceDigest)
      throw new Error('请先选择此会话的工作目录再继续任务。');
    if (!this.#admitted.has(sessionId)) {
      await this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'resume_session',
        sessionId,
      });
      this.#admitted.add(sessionId);
    }
    const connection = this.#requireConnection();
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (result.status !== 'ok' || !result.session) throw new Error('会话当前不可用。');
    if (result.session.workspaceDigest !== trustedWorkspaceDigest)
      throw new Error('请先选择此会话的工作目录再继续任务。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'start_turn',
      sessionId,
      expectedRevision: result.session.revision,
      input,
      phase: 'building',
      ...(model === undefined ? {} : { model }),
    });
  }
  async setInteractionMode(sessionId: string, mode: 'accept_edits' | 'auto' | 'full') {
    const connection = this.#requireConnection();
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (result.status !== 'ok' || !result.session) throw new Error('会话当前不可用。');
    try {
      await this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'set_interaction_mode',
        sessionId,
        expectedRevision: result.session.revision,
        mode,
      });
    } catch (error) {
      if (!(error instanceof CommandResultUnknown)) throw error;
      try {
        const transcript = await connection.history.loadSession(sessionId);
        if (this.#connection === connection && transcript.interactionMode === mode) {
          if (this.#view.selected === sessionId)
            this.#publish({ interactionMode: mode, commandError: undefined });
          return;
        }
      } catch {
        // The original mutation remains unknown when its durable result cannot be read.
      }
      const unknown = new CommandResultUnknown(
        '权限切换结果未知。请检查当前会话权限后再决定是否重试；不会自动重发。',
        'set_interaction_mode',
      );
      this.#publish({ commandError: unknown.message });
      throw unknown;
    }
    if (this.#view.selected === sessionId) this.#publish({ interactionMode: mode });
  }
  async cancel() {
    if (!this.#view.ready || this.#view.loadingSession)
      throw new Error('会话尚未同步完成，请稍后再试。');
    const projection = this.#view.projection;
    const run = projection?.currentRun;
    if (!projection || !run) return;
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'cancel_turn',
      sessionId: projection.sessionId,
      expectedRevision: projection.revision,
      runId: run.runId,
      turnId: run.activeTurnId ?? run.initialTurnId,
    });
  }

  async respondApproval(
    sessionId: string,
    interaction: RuntimeApprovalInteraction,
    decision: 'approve_once' | 'same_command' | 'reject',
  ) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('审批所属会话已改变，请重新查看。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response: { kind: 'approval', decision },
    });
  }
  async respondInput(
    sessionId: string,
    interaction: RuntimeInputInteraction,
    value?: string,
    answers?: Readonly<Record<string, string>>,
  ) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('问题所属会话已改变，请重新查看。');
    if (
      value !== undefined &&
      (!value.trim() ||
        (!interaction.allowFreeText &&
          !interaction.options?.some((option) => option.id === value || option.label === value)))
    )
      throw new Error('请选择有效选项或填写回答。');
    if (answers !== undefined) {
      const questions = interaction.questions ?? [];
      if (
        questions.length === 0 ||
        Object.keys(answers).length !== questions.length ||
        questions.some((question) => {
          const answer = answers[question.id];
          return (
            !answer?.trim() ||
            (!question.allowFreeText && !question.options?.some((option) => option.id === answer))
          );
        })
      )
        throw new Error('请完成全部问题后再提交。');
    }
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response:
        value === undefined
          ? { kind: 'input_cancel' }
          : { kind: 'text', value, ...(answers === undefined ? {} : { answers }) },
    });
  }
  async respondPlan(
    sessionId: string,
    interaction: RuntimePlanReviewInteraction,
    response: Extract<RuntimeInteractionResponse, { kind: 'plan_review' }>,
  ) {
    if (this.#view.selected !== sessionId || !this.#view.ready)
      throw new Error('计划所属会话已改变，请重新查看。');
    if (response.decision === 'feedback' && !response.feedback?.trim())
      throw new Error('请填写修改要求。');
    if (
      (response.decision === 'auto' || response.decision === 'accept_edits') &&
      (!interaction.review || interaction.review.truncated)
    )
      throw new Error('请先取得完整可读的计划正文。');
    await this.#command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'respond_interaction',
      sessionId,
      expectedRevision: interaction.sessionRevision,
      interaction,
      response,
    });
  }
}

function mergeSessionSummary(
  summary: DesktopSessionSummary,
  projection?: RuntimeSessionProjection,
): DesktopSessionSummary {
  if (!projection || projection.revision < (summary.revision ?? 0)) return summary;
  if (
    projection.revision === summary.revision &&
    projection.lifecycle === summary.lifecycle &&
    projection.currentRun === summary.currentRun &&
    projection.interactionQueue === summary.interactionQueue &&
    (projection.updatedAt ?? summary.updatedAt) === summary.updatedAt
  )
    return summary;
  return {
    ...summary,
    revision: projection.revision,
    lifecycle: projection.lifecycle,
    currentRun: projection.currentRun,
    interactionQueue: projection.interactionQueue,
    updatedAt: projection.updatedAt ?? summary.updatedAt,
  };
}

function sameEnvironment(left: BranchSnapshot, right: BranchSnapshot) {
  return (
    left.workspace === right.workspace &&
    left.repository === right.repository &&
    left.root === right.root &&
    left.current === right.current &&
    left.head === right.head
  );
}

function messageOf(error: unknown) {
  if (error instanceof RuntimeClientError) {
    const detail = error.protocol?.data.detailCode;
    if (detail)
      return {
        workspace_unavailable: '工作目录已不存在或无法访问',
        configuration_unavailable: '模型配置无法读取',
        temporarily_unavailable: '历史存储正忙，稍后将重新读取',
        session_not_found: '会话记录不存在',
        session_unavailable: '历史存储无法读取',
        corrupt_event: '会话中的历史记录损坏',
        invalid_request: '历史读取请求无效',
      }[detail];
  }
  return error instanceof Error ? error.message : String(error);
}
async function pathDigest(path: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function readWithDeadline<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('读取超时，已保留现有内容。')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class InvalidHistoryIdentity extends Error {}

function invalidatesHistory(error: unknown): boolean {
  if (error instanceof InvalidHistoryIdentity) return true;
  if (!(error instanceof RuntimeClientError)) return false;
  return (
    error.protocol?.data.detailCode === 'session_not_found' ||
    error.protocol?.data.code === 'unauthorized'
  );
}
