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
  type RuntimeClientBackgroundState,
  RuntimeClientError,
  type RuntimeClientNotificationWithGeneration,
  readCommandReceipt,
  recoverSessionIfSafe,
} from '@kite-ai/runtime-client';
import type {
  RuntimeApprovalInteraction,
  RuntimeChildSessionSummary,
  RuntimeCommand,
  RuntimeCommandErrorCode,
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
import {
  addCacheMetrics,
  type DesktopCacheMetrics,
  projectCacheMetrics,
  projectHistory,
} from './history-projection';
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

class CommandRejected extends Error {
  readonly code: RuntimeCommandErrorCode;
  constructor(message: string, code: RuntimeCommandErrorCode) {
    super(message);
    this.code = code;
  }
}

export type DesktopSessionSummary = Pick<
  RuntimeSessionProjection,
  'sessionId' | 'displayName' | 'workspace' | 'workspaceDigest' | 'updatedAt'
> &
  Partial<
    Pick<
      RuntimeSessionProjection,
      'revision' | 'lifecycle' | 'currentRun' | 'interactionQueue' | 'model'
    >
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
  recoverySessionId?: string;
  trust?: WorkspaceTrustQueryResponse;
  models?: ProviderModelSnapshot;
  mcp?: AppMcpSnapshot;
  skills?: SkillCatalogSnapshot;
  sessions: readonly DesktopSessionSummary[];
  selected?: string;
  messages: readonly Message[];
  cacheMetrics?: DesktopCacheMetrics;
  projection?: RuntimeSessionProjection;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  ready: boolean;
  loadingSession: boolean;
  hasLoadedHistory: boolean;
  background?: Readonly<Record<string, RuntimeClientBackgroundState>>;
  backgroundDisplay?: {
    readonly sessionId: string;
    readonly snapshot: RuntimeClientBackgroundState['snapshot'];
    readonly stale: boolean;
  };
  childSessions?: {
    readonly parentSessionId: string;
    readonly entries: readonly RuntimeChildSessionSummary[];
    readonly loading: boolean;
    readonly reconnecting?: boolean;
    readonly error?: string;
  };
  childDetail?: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly loading: boolean;
    readonly hasLoadedHistory: boolean;
    readonly messages: readonly Message[];
    readonly projection?: RuntimeSessionProjection;
    readonly error?: string;
  };
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

function childHistoryKey(parentSessionId: string, childSessionId: string): string {
  return `child:${parentSessionId}\0${childSessionId}`;
}

function childHistoryPrefix(parentSessionId: string): string {
  return `child:${parentSessionId}\0`;
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
    background: {},
  };
  #listeners = new Set<() => void>();
  #connection?: KiteAppServerConnection;
  #connectionId?: number;
  #selection?: AbortController;
  #childRead?: AbortController;
  #childRestore?: { readonly parentSessionId: string; readonly childSessionId: string };
  #calibratedChild?: {
    readonly controller: AbortController;
    readonly subscriptionGeneration: number;
  };
  #childListRead = 0;
  #childListRefreshInFlight?: { readonly sessionId: string; readonly promise: Promise<void> };
  readonly #childSessionCache = new Map<string, readonly RuntimeChildSessionSummary[]>();
  readonly #backgroundDisplayCache = new Map<string, RuntimeClientBackgroundState['snapshot']>();
  readonly #invalidatedPresentationSessions = new Set<string>();
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
  #indexSubscription?: AbortController;
  #initialIndex?: {
    readonly connection: KiteAppServerConnection;
    readonly sessions: Map<string, RuntimeSessionProjection>;
  };
  #backgroundRefreshTimer?: ReturnType<typeof setInterval>;
  #backgroundRefreshSessionId?: string;
  #readingPageSuspended = false;
  #backgroundRefreshInFlight?: {
    readonly connection: KiteAppServerConnection;
    readonly sessionId: string;
    readonly promise: Promise<unknown>;
  };
  #admitted = new Set<string>();
  readonly #workspaceRemovalTokens = new Map<string, string>();
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
  async hasActiveSessionTasks(): Promise<boolean> {
    const connection = this.#requireConnection();
    const directory = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'list_sessions',
    });
    if (directory.status !== 'ok' || !directory.sessions || directory.sessions.length >= 1000)
      throw new Error('无法完整确认任务状态。');
    return directory.sessions.some(isActiveRun);
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
      recoverySessionId: undefined,
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
  readStartupStatus() {
    return this.#native().runtimeStartupStatus();
  }
  saveStartupDiagnostic() {
    return this.#native().saveStartupDiagnostic();
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
  async removeProject(id: string): Promise<{ selectedRemoved: boolean; workspace: string }> {
    if (!this.#view.projects) await this.refreshProjects();
    const project = this.#view.projects?.find((entry) => entry.path === id);
    const digest = project ? await pathDigest(project.path) : id;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error('无法确认空间身份，请刷新目录后重试。');
    if (!project && !this.#view.directory?.some((entry) => entry.workspaceDigest === digest))
      throw new Error('空间已不在目录中，请刷新后重试。');
    const connection = this.#requireConnection();
    const roots = await this.#listWorkspaceSessions(connection, digest);
    const selectedRemoved = Boolean(
      this.#view.selected &&
        (roots.includes(this.#view.selected) || this.#view.projection?.workspaceDigest === digest),
    );
    let deleted = 0;
    const token = this.#workspaceRemovalTokens.get(digest) ?? crypto.randomUUID();
    this.#workspaceRemovalTokens.set(digest, token);
    let removeConfirmed = false;
    const finalize = async () => {
      await (this.#connection ?? connection).runtime.requestApp('app/workspace/remove', {
        phase: 'finalize',
        workspaceDigest: digest,
        token,
        ...(project ? { workspace: project.path } : {}),
      });
      this.#workspaceRemovalTokens.delete(digest);
    };
    try {
      const response = await connection.runtime.requestApp('app/workspace/remove', {
        phase: 'remove',
        workspaceDigest: digest,
        token,
        ...(project ? { workspace: project.path } : {}),
      });
      if (response.token !== token || typeof response.deletedSessions !== 'number')
        throw new Error('服务端空间移除回执无效。');
      removeConfirmed = true;
      deleted = response.deletedSessions;
      for (const sessionId of roots) this.#removeDeletedSessionFromView(sessionId);
      if ((await this.#listWorkspaceSessions(connection, digest)).length)
        throw new Error('空间中出现新的会话，请重新核对后再移除。');
    } catch (error) {
      if (removeConfirmed) await finalize();
      // A lost remove response is retryable with this operation token. The
      // registration stays visible so the user can repeat the same removal.
      throw new Error(`空间移除未完成，已删除 ${deleted} 条会话；项目仍保留。${messageOf(error)}`);
    }
    if (this.#connection !== connection) {
      await finalize();
      throw new Error('连接已改变，项目仍保留，请刷新后核对。');
    }
    // Keep the native registration available until the durable deletion gate
    // has been released. A failed finalize can then be retried with this token.
    try {
      await finalize();
    } catch (error) {
      throw new Error(
        `空间历史已删除，但服务端收尾尚未确认；项目仍保留，请稍后重试。${messageOf(error)}`,
      );
    }
    if (project) {
      await this.#native().removeWorkspace(project.path);
      // The native registration is already gone. Keep the confirmed result in
      // the view even when a follow-up read of the project list fails.
      this.#publish({
        projects: this.#view.projects?.filter((entry) => entry.path !== project.path),
      });
      try {
        await this.refreshProjects();
        if (!this.#view.projectError) this.#publish({ projectError: undefined });
      } catch (error) {
        this.#publish({ projectError: `空间已移除，项目列表暂时无法刷新：${messageOf(error)}` });
      }
    }
    this.#publish({
      directory: this.#view.directory?.filter((entry) => entry.workspaceDigest !== digest),
      ...(selectedRemoved ? { selected: undefined } : {}),
    });
    if (selectedRemoved || (project && this.#view.workspace === project.path)) {
      await this.#detach();
      this.#publish({
        selected: undefined,
        projection: undefined,
        messages: [],
        workspace: '',
        trust: undefined,
        branch: undefined,
        ready: false,
      });
      await this.connect();
    }
    await this.refreshDirectory();
    return { selectedRemoved, workspace: this.#view.workspace };
  }

  #removeDeletedSessionFromView(sessionId: string) {
    this.#admitted.delete(sessionId);
    this.#childSessionCache.delete(sessionId);
    this.#backgroundDisplayCache.delete(sessionId);
    this.#invalidatedPresentationSessions.delete(sessionId);
    this.#historyCache.take(sessionId);
    this.#historyCache.evictWhere((key) => key.startsWith(childHistoryPrefix(sessionId)));
    ++this.#directoryRead;
    const selected = this.#view.selected === sessionId;
    if (selected) {
      this.#stopBackgroundRefresh();
      this.#selection?.abort();
      this.#selection = undefined;
      this.#selectionLoad = undefined;
      this.#calibratedSelection = undefined;
      this.#childRestore = undefined;
      this.#childRead?.abort();
      this.#childRead = undefined;
      this.#calibratedChild = undefined;
      ++this.#childListRead;
      this.#childListRefreshInFlight = undefined;
      this.#historyConnection = undefined;
      this.#historyWorkspaceDigest = undefined;
    }
    this.#publish({
      directory: this.#view.directory?.filter((entry) => entry.sessionId !== sessionId),
      directoryLoading: undefined,
      sessions: this.#view.sessions.filter((entry) => entry.sessionId !== sessionId),
      ...(selected
        ? {
            selected: undefined,
            projection: undefined,
            messages: [],
            cacheMetrics: undefined,
            ready: false,
            loadingSession: false,
            hasLoadedHistory: false,
            childSessions: undefined,
            childDetail: undefined,
            backgroundDisplay: undefined,
          }
        : {}),
    });
  }

  async #listWorkspaceSessions(
    connection: KiteAppServerConnection,
    digest: string,
  ): Promise<string[]> {
    const entries = await readCompleteSessionDirectory((cursor) =>
      connection.history.listSessions({
        limit: 100,
        workspaceDigest: digest,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (entries.some((entry) => entry.workspace?.workspaceDigest !== digest))
      throw new Error('会话空间身份不一致，未继续删除。');
    return entries.map((entry) => entry.sessionId);
  }

  async activateProject(path: string) {
    if (this.#connection && this.#view.workspace !== path) await this.#detach();
    if (!this.#connection) {
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
    if (directory.sessions.some(isActiveRun))
      throw new Error('切换分支需要重新加载项目配置，请等待其他空间的任务结束后再切换。');
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
        (provider) =>
          provider.provider === selected.provider &&
          provider.readiness === 'ready' &&
          provider.models.some((model) => model.name === selected.name && model.enabled !== false),
      )
    )
      throw new Error('请先配置可用的模型。');
  }
  connect(options: { refreshDirectory?: boolean } = {}): Promise<void> {
    if (this.#connection?.status === 'active')
      return !this.#readingPageSuspended &&
        !this.#view.childDetail &&
        this.#view.selected &&
        !this.#view.ready
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
    if (selected && this.#view.childDetail?.parentSessionId === selected)
      this.#childRestore = {
        parentSessionId: selected,
        childSessionId: this.#view.childDetail.childSessionId,
      };
    await this.#detach({ preserveReadingPage: true });
    const info: DesktopConnectionInfo = await this.#native().runtimeOpen();
    const connection = createAppServerProtocolConnection(
      desktopTransport(info, this.#native()),
      info.expectedServerVersion,
      { name: 'kite-desktop', version: '0.1.0', instanceId: crypto.randomUUID() },
      KITE_APP_SERVER_PROTOCOL_METHODS_,
    );
    this.#connection = connection;
    this.#connectionId = info.connectionId;
    if (this.#view.workspace !== info.workspace) {
      this.#childRestore = undefined;
      this.#childSessionCache.clear();
      this.#backgroundDisplayCache.clear();
      this.#historyCache.clear();
    }
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
            backgroundDisplay: undefined,
            childSessions: undefined,
            childDetail: undefined,
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
      const childDetail = this.#view.childDetail;
      const childSession = childDetail ? snapshot.sessions[childDetail.childSessionId] : undefined;
      const calibratedChild = this.#calibratedChild;
      const resyncChild =
        childDetail &&
        calibratedChild !== undefined &&
        calibratedChild.controller === this.#childRead &&
        (!childSession?.ready ||
          childSession.subscriptionGeneration !== calibratedChild.subscriptionGeneration)
          ? {
              parentSessionId: childDetail.parentSessionId,
              childSessionId: childDetail.childSessionId,
            }
          : undefined;
      if (resyncSession) this.#calibratedSelection = undefined;
      if (resyncChild) this.#calibratedChild = undefined;
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
        background: snapshot.background,
        backgroundDisplay: this.#backgroundDisplayFor(
          this.#view.selected,
          this.#view.selected ? snapshot.background[this.#view.selected] : undefined,
        ),
        ...(childDetail &&
        childSession?.projection &&
        childSession.projection !== childDetail.projection &&
        !resyncChild
          ? { childDetail: { ...childDetail, projection: childSession.projection } }
          : {}),
      });
      this.#syncBackgroundRefresh(connection, snapshot);
      if (resyncChild && connection.status === 'active')
        void this.openChildSession(resyncChild.parentSessionId, resyncChild.childSessionId).catch(
          (error) => this.report(error),
        );
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
      if (runFinished && connection.status === 'active') {
        if (this.#view.selected) {
          const completedSessionId = this.#view.selected;
          void this.refreshChildSessions(this.#view.selected, { silent: true }).catch(
            () => undefined,
          );
          if (connection.runtime.features.backgroundQuery)
            void connection.runtime
              .query({
                schema: 'kite.runtime-query.v1',
                type: 'list_background_executions',
                sessionId: completedSessionId,
              })
              .catch(() => undefined);
        }
        void this.refreshSessions().catch((error) => this.report(error));
      }
    });
    try {
      await connection.prepareAppControl();
    } catch (error) {
      await this.#detach({ preserveReadingPage: true }).catch(() => undefined);
      throw error;
    }
    const indexSubscription = new AbortController();
    this.#indexSubscription = indexSubscription;
    void (async () => {
      while (!indexSubscription.signal.aborted && this.#connection === connection) {
        let reset:
          | {
              serverInstanceId: string;
              generation: number;
              indexRevision: number;
              sessions: Map<string, RuntimeSessionProjection>;
            }
          | undefined;
        let current:
          | { serverInstanceId: string; generation: number; indexRevision: number }
          | undefined;
        try {
          for await (const notification of connection.runtime.observeSessionIndex(
            indexSubscription.signal,
          )) {
            if (indexSubscription.signal.aborted || this.#connection !== connection) break;
            if (!('type' in notification)) continue;
            switch (notification.type) {
              case 'index_reset_begin':
                this.#initialIndex = undefined;
                reset = {
                  serverInstanceId: notification.serverInstanceId,
                  generation: notification.generation,
                  indexRevision: notification.indexRevision,
                  sessions: new Map(),
                };
                current = undefined;
                break;
              case 'session_upsert':
                if (
                  reset &&
                  reset.serverInstanceId === notification.serverInstanceId &&
                  reset.generation === notification.generation &&
                  reset.indexRevision === notification.indexRevision
                )
                  reset.sessions.set(notification.session.sessionId, notification.session);
                else if (
                  current &&
                  current.serverInstanceId === notification.serverInstanceId &&
                  current.generation === notification.generation &&
                  notification.indexRevision > current.indexRevision
                ) {
                  current.indexRevision = notification.indexRevision;
                  if (this.#initialIndex?.connection === connection)
                    this.#initialIndex.sessions.set(
                      notification.session.sessionId,
                      notification.session,
                    );
                  this.#applyIndexProjections([notification.session]);
                }
                break;
              case 'session_remove':
                if (
                  current &&
                  current.serverInstanceId === notification.serverInstanceId &&
                  current.generation === notification.generation &&
                  notification.indexRevision > current.indexRevision
                ) {
                  current.indexRevision = notification.indexRevision;
                  if (this.#initialIndex?.connection === connection)
                    this.#initialIndex.sessions.delete(notification.sessionId);
                  this.#removeDeletedSessionFromView(notification.sessionId);
                }
                break;
              case 'index_reset_end': {
                if (
                  !reset ||
                  reset.serverInstanceId !== notification.serverInstanceId ||
                  reset.generation !== notification.generation ||
                  reset.indexRevision !== notification.indexRevision
                )
                  break;
                current = {
                  serverInstanceId: reset.serverInstanceId,
                  generation: reset.generation,
                  indexRevision: reset.indexRevision,
                };
                this.#initialIndex = { connection, sessions: reset.sessions };
                this.#applyIndexProjections(reset.sessions.values(), true);
                const selected = this.#view.selected;
                if (selected && !reset.sessions.has(selected)) {
                  const result = await connection.runtime.query({
                    schema: 'kite.runtime-query.v1',
                    type: 'get_session_projection',
                    sessionId: selected,
                  });
                  if (
                    result.status === 'not_found' &&
                    this.#connection === connection &&
                    this.#view.selected === selected
                  )
                    this.#removeDeletedSessionFromView(selected);
                }
                reset = undefined;
                break;
              }
            }
          }
        } catch (error) {
          if (!indexSubscription.signal.aborted && this.#connection === connection)
            this.report(error);
        }
        if (indexSubscription.signal.aborted || this.#connection !== connection) break;
        // The runtime client closes the iterator when subscription acquisition
        // fails. Reacquire it so a later reset can catch offline deletions.
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    })();
    this.#publish({ connected: true });
    // Independent read capabilities cannot tear down a healthy protocol peer.
    if (refreshDirectory) await this.refreshDirectory().catch(() => undefined);
    this.#workspacePreparation = this.#prepareWorkspace(connection);
    if (
      selected &&
      !this.#readingPageSuspended &&
      (!this.#view.childDetail || this.#childRestore?.parentSessionId === selected) &&
      this.#view.selected === selected
    )
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
  async #detach(options: { readonly preserveReadingPage?: boolean } = {}) {
    const currentDisplay = this.#view.backgroundDisplay;
    const backgroundDisplay =
      options.preserveReadingPage &&
      currentDisplay &&
      currentDisplay.sessionId === this.#view.selected
        ? { ...currentDisplay, stale: true }
        : undefined;
    this.#stopBackgroundRefresh();
    this.#indexSubscription?.abort();
    this.#indexSubscription = undefined;
    this.#initialIndex = undefined;
    this.#selection?.abort();
    this.#childRead?.abort();
    this.#childRead = undefined;
    this.#calibratedChild = undefined;
    this.#childListRead++;
    this.#childListRefreshInFlight = undefined;
    this.#selectionLoad = undefined;
    this.#calibratedSelection = undefined;
    this.#historyCache.clear();
    this.#childSessionCache.clear();
    this.#backgroundDisplayCache.clear();
    if (backgroundDisplay)
      this.#backgroundDisplayCache.set(backgroundDisplay.sessionId, backgroundDisplay.snapshot);
    this.#invalidatedPresentationSessions.clear();
    this.#historyConnection = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#admitted.clear();
    const childSessions = options.preserveReadingPage ? this.#view.childSessions : undefined;
    const childDetail = options.preserveReadingPage ? this.#view.childDetail : undefined;
    this.#publish({
      connected: false,
      ready: false,
      loadingSession: !!options.preserveReadingPage && !!this.#view.selected && !childDetail,
      childSessions: childSessions
        ? { ...childSessions, loading: true, reconnecting: true, error: undefined }
        : undefined,
      childDetail: childDetail
        ? { ...childDetail, loading: true, projection: undefined, error: undefined }
        : undefined,
      backgroundDisplay,
    });
    if (connection) await connection.close();
  }

  #stopBackgroundRefresh() {
    if (this.#backgroundRefreshTimer) clearInterval(this.#backgroundRefreshTimer);
    this.#backgroundRefreshTimer = undefined;
    this.#backgroundRefreshSessionId = undefined;
  }

  #syncBackgroundRefresh(
    connection: KiteAppServerConnection,
    snapshot: ReturnType<KiteAppServerConnection['snapshotStore']['getSnapshot']>,
  ) {
    // A detached child may settle while the parent generator remains in its
    // completion wait, so no presentation event is pushed for that partial
    // result. Query only the selected active Run and keep one read in flight.
    const sessionId = this.#view.selected;
    const session = sessionId ? snapshot.sessions[sessionId] : undefined;
    if (
      !sessionId ||
      this.#view.childDetail !== undefined ||
      this.#readingPageSuspended ||
      !connection.runtime.features.backgroundQuery ||
      connection.status !== 'active' ||
      !isActiveRun(session?.projection)
    ) {
      this.#stopBackgroundRefresh();
      return;
    }
    if (this.#backgroundRefreshSessionId === sessionId) return;
    this.#stopBackgroundRefresh();
    this.#backgroundRefreshSessionId = sessionId;
    const refresh = () => {
      if (this.#connection !== connection || this.#view.selected !== sessionId) return;
      if (
        this.#backgroundRefreshInFlight?.connection === connection &&
        this.#backgroundRefreshInFlight.sessionId === sessionId
      )
        return;
      const promise = connection.runtime
        .query({ schema: 'kite.runtime-query.v1', type: 'list_background_executions', sessionId })
        .catch(() => undefined);
      // Child creation follows the parent's started event. Read the persisted
      // parent-scoped list while the Run is active so either detail entry appears
      // as soon as that child exists, including when creation raced the event.
      void this.refreshChildSessions(sessionId, { silent: true }).catch(() => undefined);
      this.#backgroundRefreshInFlight = { connection, sessionId, promise };
      void promise.finally(() => {
        if (this.#backgroundRefreshInFlight?.promise === promise)
          this.#backgroundRefreshInFlight = undefined;
      });
    };
    refresh();
    this.#backgroundRefreshTimer = setInterval(refresh, 1_000);
  }
  async disconnect() {
    ++this.#recoveryGeneration;
    this.#childRestore = undefined;
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
          model: entry.model,
        }));
        const initialIndex =
          this.#initialIndex?.connection === connection ? this.#initialIndex.sessions : undefined;
        const byId = new Map(
          sessions.map((session) => {
            const projection = initialIndex?.get(session.sessionId);
            return [
              session.sessionId,
              projection?.workspaceDigest === session.workspaceDigest
                ? mergeSessionSummary(session, projection, true)
                : session,
            ] as const;
          }),
        );
        const previous = this.#view.directory ?? [];
        const known = new Set(previous.map((session) => session.sessionId));
        const errors = { ...this.#view.directoryErrors };
        delete errors[label];
        this.#publish({
          directoryErrors: errors,
          directory: [
            ...sessions
              .filter((session) => !known.has(session.sessionId))
              .map((session) => byId.get(session.sessionId)!),
            ...previous.flatMap(
              (session) =>
                (byId.has(session.sessionId)
                  ? retainLiveSummary(byId.get(session.sessionId)!, session)
                  : undefined) ?? (scope && session.workspaceDigest !== scope ? [session] : []),
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
    if (
      this.#connection === connection &&
      read === this.#directoryRead &&
      failures.length < scopes.length
    )
      this.#initialIndex = undefined;
    if (scopes.length && failures.length === scopes.length) throw failures[0];
  }
  #applyIndexProjections(projections: Iterable<RuntimeSessionProjection>, reset = false) {
    const byId = new Map<string, RuntimeSessionProjection>();
    for (const projection of projections) byId.set(projection.sessionId, projection);
    if (!byId.size) return;
    const update = (entries: readonly DesktopSessionSummary[]) => {
      let changed = false;
      const merged = entries.map((entry) => {
        const projection = byId.get(entry.sessionId);
        if (!projection || projection.workspaceDigest !== entry.workspaceDigest) return entry;
        const next = mergeSessionSummary(entry, projection, reset);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? merged : entries;
    };
    const directory = this.#view.directory ? update(this.#view.directory) : undefined;
    const sessions = update(this.#view.sessions);
    if (directory === this.#view.directory && sessions === this.#view.sessions) return;
    this.#publish({ ...(directory ? { directory } : {}), sessions });
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
  async setModelEnabled(provider: string, name: string, enabled: boolean) {
    const connection = this.#requireConnection();
    const models = this.#view.models;
    if (!models) throw new Error('请先刷新模型配置。');
    let result: Awaited<ReturnType<KiteAppServerConnection['app']['setProviderModelEnabled']>>;
    try {
      result = await connection.app.setProviderModelEnabled({
        schema: 'kite.app.provider-model.set-enabled-request.v1',
        workspace: models.workspace,
        provider,
        name,
        enabled,
        expectedRevision: models.revision,
      });
    } catch {
      await this.refreshModels().catch(() => undefined);
      throw new Error('模型启用状态结果未知，请检查最新状态后再决定是否重试。');
    }
    if (this.#connection !== connection) return;
    this.#publish({ models: result.snapshot });
    if (result.outcome !== 'applied' && result.outcome !== 'already_selected')
      throw new Error(`模型启用状态未确认更新（${result.outcome}），请检查最新配置。`);
  }
  async #command(
    command: RuntimeCommand,
    allowRecovery = true,
  ): Promise<Awaited<ReturnType<KiteAppServerConnection['runtime']['command']>>> {
    const connection = this.#requireConnection();
    this.#publish({ commandError: undefined });
    let receipt: Awaited<ReturnType<typeof connection.runtime.command>>;
    try {
      receipt = await connection.runtime.command(command);
    } catch (cause) {
      try {
        const committed = await readCommandReceipt(connection.runtime, command);
        if (committed) return committed;
      } catch {}
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
    if (
      receipt.status === 'rejected' &&
      receipt.code === 'session_recovery_required' &&
      allowRecovery &&
      'sessionId' in command &&
      command.type !== 'recover_session'
    ) {
      const recovered = await recoverSessionIfSafe(
        connection.runtime,
        command.sessionId,
        crypto.randomUUID(),
      );
      if (recovered?.status === 'applied' || recovered?.status === 'idempotent_replay') {
        if (this.#connection !== connection) throw new Error('连接已变化，请重新加载会话。');
        this.#admitted.delete(command.sessionId);
        return this.#command(command, false);
      }
    }
    if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
      const reasons: Partial<Record<typeof receipt.code, string>> = {
        session_recovery_required:
          '会话需要恢复核对。旧执行的清理或外部结果尚未确认；不会重发旧操作。',
        session_cleanup_pending: '旧执行尚未确认清理完成，请等待原服务结束相关执行后重试。',
        external_outcome_unknown: '存在结果未知的外部操作，请先核对实际结果；不会自动重跑。',
        runtime_busy: '此会话正在执行或等待清理，请稍后重试。',
        storage_unavailable: '会话存储当前不可用，请检查服务与存储后重试。',
      };
      if (
        'sessionId' in command &&
        [
          'session_recovery_required',
          'session_cleanup_pending',
          'external_outcome_unknown',
        ].includes(receipt.code)
      ) {
        this.#admitted.delete(command.sessionId);
        this.#publish({
          recoverySessionId: command.sessionId,
          ...(this.#view.selected === command.sessionId ? { ready: false } : {}),
        });
      }
      throw new CommandRejected(
        reasons[receipt.code] ?? `操作未执行：${receipt.code}`,
        receipt.code,
      );
    }
    return receipt;
  }
  async checkSessionRecovery() {
    const sessionId = this.#view.recoverySessionId;
    if (!sessionId) return;
    const connection = this.#requireConnection();
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_recovery',
      sessionId,
    });
    if (result.status !== 'ok' || !result.recovery)
      throw new Error('无法读取恢复状态，请检查连接后重试。');
    if (result.recovery.action === 'recover') {
      const recovered = await recoverSessionIfSafe(
        connection.runtime,
        sessionId,
        crypto.randomUUID(),
      );
      if (recovered?.status !== 'applied' && recovered?.status !== 'idempotent_replay')
        throw new Error('恢复状态已变化，请重新检查。');
    } else if (result.recovery.action !== 'continue') {
      throw new Error(
        result.recovery.pendingEffectCount || result.recovery.unknownEffectCount
          ? `旧操作的外部结果尚未确认。请核对相关文件或外部服务；此次检查没有重跑操作。${result.recovery.effects?.length ? ` 操作：${result.recovery.effects.map((effect) => effect.effectId).join('、')}` : ''}`
          : '旧执行尚未确认清理完成。请让原服务结束相关执行后再检查；历史仍可阅读。',
      );
    }
    if (this.#connection !== connection) throw new Error('连接已变化，请重新加载会话。');
    this.#admitted.delete(sessionId);
    this.clearError();
    if (this.#view.selected === sessionId) {
      this.#publish({ ready: false });
      await this.selectSession(sessionId);
    }
  }

  async stopBackgroundExecution(
    execution: import('@kite-ai/runtime-contract').RuntimeBackgroundExecutionProjection,
  ) {
    const connection = this.#requireConnection();
    if (!connection.runtime.features.backgroundControl)
      throw new Error('当前 Runtime Host 不支持停止后台执行。');
    const result = await connection.runtime.stopBackgroundExecution({
      commandId: crypto.randomUUID(),
      execution,
    });
    if (this.#connection !== connection) throw new Error('连接已变化，请刷新后台状态。');
    if (result.receipt.status === 'applied' || result.receipt.status === 'idempotent_replay')
      return;
    if (result.receipt.status === 'conflict')
      throw new Error('会话状态已更新；已刷新同一后台执行，请确认后重试。');
    throw new Error(
      result.receipt.code === 'target_ended'
        ? '该后台执行已结束；状态已刷新。'
        : `停止请求未受理：${result.receipt.code}`,
    );
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
  #backgroundDisplayFor(
    sessionId: string | undefined,
    state?: RuntimeClientBackgroundState,
  ): DesktopView['backgroundDisplay'] {
    if (!sessionId || this.#invalidatedPresentationSessions.has(sessionId)) return undefined;
    if (state && !state.stale) {
      if (this.#backgroundDisplayCache.get(sessionId) !== state.snapshot) {
        this.#backgroundDisplayCache.delete(sessionId);
        this.#backgroundDisplayCache.set(sessionId, state.snapshot);
        if (this.#backgroundDisplayCache.size > 16)
          this.#backgroundDisplayCache.delete(this.#backgroundDisplayCache.keys().next().value!);
      }
      const current = this.#view.backgroundDisplay;
      return current?.sessionId === sessionId &&
        current.snapshot === state.snapshot &&
        !current.stale
        ? current
        : { sessionId, snapshot: state.snapshot, stale: false };
    }
    const snapshot = this.#backgroundDisplayCache.get(sessionId);
    if (!snapshot) return undefined;
    const current = this.#view.backgroundDisplay;
    return current?.sessionId === sessionId && current.snapshot === snapshot && current.stale
      ? current
      : { sessionId, snapshot, stale: true };
  }

  selectSession(sessionId: string): Promise<void> {
    if (this.#view.childSessions?.entries.some((entry) => entry.sessionId === sessionId))
      return Promise.reject(new Error('子会话只能通过父会话的环境信息读取。'));
    this.#readingPageSuspended = false;
    const cachedChildren = this.#childSessionCache.get(sessionId);
    if (sessionId !== this.#view.selected) {
      this.#cacheCurrentChildDetail();
      this.#childRestore = undefined;
      this.#childRead?.abort();
      this.#childRead = undefined;
      this.#calibratedChild = undefined;
      this.#childListRead++;
      this.#childListRefreshInFlight = undefined;
      this.#publish({
        childSessions: cachedChildren
          ? { parentSessionId: sessionId, entries: cachedChildren, loading: false }
          : undefined,
        childDetail: undefined,
      });
    } else if (!this.#view.childSessions && cachedChildren) {
      this.#publish({
        childSessions: { parentSessionId: sessionId, entries: cachedChildren, loading: false },
      });
    }
    const connection = this.#connection;
    if (connection?.status !== 'active') {
      // Record the user's latest choice before waiting for a reconnect. Older
      // clicks must not replay after the peer becomes active and replace it.
      this.#selection?.abort();
      this.#selectionLoad = undefined;
      this.#calibratedSelection = undefined;
      const sameSelection = this.#view.selected === sessionId;
      this.#publish({
        selected: sessionId,
        messages: sameSelection ? this.#view.messages : [],
        cacheMetrics: sameSelection ? this.#view.cacheMetrics : undefined,
        hasLoadedHistory: sameSelection ? this.#view.hasLoadedHistory : false,
        projection: sameSelection ? this.#view.projection : undefined,
        backgroundDisplay: sameSelection ? this.#view.backgroundDisplay : undefined,
        ready: false,
        loadingSession: true,
      });
      return this.connect().then(() =>
        this.#view.selected === sessionId ? this.selectSession(sessionId) : undefined,
      );
    }
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

  refreshChildSessions(
    parentSessionId: string,
    options?: { readonly silent?: boolean },
  ): Promise<void> {
    if (this.#childListRefreshInFlight?.sessionId === parentSessionId)
      return this.#childListRefreshInFlight.promise;
    const effectiveOptions = {
      silent: options?.silent ?? this.#childSessionCache.has(parentSessionId),
    };
    const promise = this.#readChildSessions(parentSessionId, effectiveOptions).finally(() => {
      if (this.#childListRefreshInFlight?.promise === promise)
        this.#childListRefreshInFlight = undefined;
    });
    this.#childListRefreshInFlight = { sessionId: parentSessionId, promise };
    return promise;
  }

  async #readChildSessions(
    parentSessionId: string,
    options?: { readonly silent?: boolean },
  ): Promise<void> {
    const connection = this.#requireConnection();
    if (this.#view.selected !== parentSessionId || !this.#view.ready)
      throw new Error('请先打开父会话。');
    const read = ++this.#childListRead;
    const previous =
      this.#view.childSessions?.parentSessionId === parentSessionId
        ? this.#view.childSessions.entries
        : [];
    const reconnecting =
      this.#view.childSessions?.parentSessionId === parentSessionId &&
      this.#view.childSessions.reconnecting;
    if (!options?.silent)
      this.#publish({
        childSessions: { parentSessionId, entries: previous, loading: true, reconnecting },
      });
    try {
      const entries: RuntimeChildSessionSummary[] = [];
      let cursor: { updatedAtMs: number; sessionId: string } | undefined;
      for (;;) {
        const result = await connection.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'list_child_sessions',
          sessionId: parentSessionId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (result.status !== 'ok' || !result.childSessions)
          throw new Error('子会话列表暂时不可用。');
        if (result.childSessions.some((child) => child.parentSessionId !== parentSessionId))
          throw new Error('子会话归属与父会话不一致。');
        entries.push(...result.childSessions);
        if (entries.length > 1000) throw new Error('子会话列表超出读取上限。');
        if (!result.nextChildCursor) break;
        if (
          cursor &&
          cursor.sessionId === result.nextChildCursor.sessionId &&
          cursor.updatedAtMs === result.nextChildCursor.updatedAtMs
        )
          throw new Error('子会话列表分页未继续前进。');
        cursor = result.nextChildCursor;
      }
      entries.sort(
        (left, right) =>
          right.updatedAtMs - left.updatedAtMs || right.sessionId.localeCompare(left.sessionId),
      );
      if (
        this.#connection === connection &&
        this.#view.selected === parentSessionId &&
        read === this.#childListRead
      ) {
        this.#childSessionCache.delete(parentSessionId);
        this.#childSessionCache.set(parentSessionId, entries);
        if (this.#childSessionCache.size > 16)
          this.#childSessionCache.delete(this.#childSessionCache.keys().next().value!);
        if (
          this.#view.childDetail?.parentSessionId === parentSessionId &&
          !entries.some((entry) => entry.sessionId === this.#view.childDetail?.childSessionId)
        )
          this.leaveChildSession();
        const validChildKeys = new Set(
          entries.map((entry) => childHistoryKey(parentSessionId, entry.sessionId)),
        );
        this.#historyCache.evictWhere(
          (key) => key.startsWith(childHistoryPrefix(parentSessionId)) && !validChildKeys.has(key),
        );
        if (
          !this.#view.childSessions ||
          this.#view.childSessions.parentSessionId !== parentSessionId ||
          this.#view.childSessions.loading ||
          this.#view.childSessions.reconnecting ||
          this.#view.childSessions.error ||
          entries.length !== previous.length ||
          entries.some(
            (entry, index) =>
              entry.sessionId !== previous[index]?.sessionId ||
              entry.revision !== previous[index]?.revision ||
              entry.displayName !== previous[index]?.displayName,
          )
        )
          this.#publish({ childSessions: { parentSessionId, entries, loading: false } });
        const restore = this.#childRestore;
        if (restore?.parentSessionId === parentSessionId) {
          if (!entries.some((entry) => entry.sessionId === restore.childSessionId))
            this.#childRestore = undefined;
          else if (
            !this.#view.childDetail ||
            this.#view.childDetail.childSessionId === restore.childSessionId
          ) {
            this.#childRestore = undefined;
            void this.openChildSession(parentSessionId, restore.childSessionId).catch((error) =>
              this.report(error),
            );
          } else this.#childRestore = undefined;
        }
      }
    } catch (error) {
      if (
        this.#connection === connection &&
        this.#view.selected === parentSessionId &&
        read === this.#childListRead &&
        !options?.silent
      )
        this.#publish({
          childSessions: {
            parentSessionId,
            entries: previous,
            loading: false,
            reconnecting,
            error: messageOf(error),
          },
        });
    }
  }

  leaveChildSession(options: { readonly restoreParent?: boolean } = {}) {
    const parentSessionId = this.#view.childDetail?.parentSessionId;
    this.#cacheCurrentChildDetail();
    this.#childRestore = undefined;
    this.#childRead?.abort();
    this.#childRead = undefined;
    this.#calibratedChild = undefined;
    this.#publish({ childDetail: undefined });
    if (
      options.restoreParent !== false &&
      parentSessionId &&
      this.#view.selected === parentSessionId
    )
      void this.selectSession(parentSessionId).catch((error) => this.report(error));
  }

  leaveSessionPage() {
    this.leaveChildSession({ restoreParent: false });
    this.#readingPageSuspended = true;
    this.#selection?.abort();
    this.#selectionLoad = undefined;
    this.#calibratedSelection = undefined;
    this.#stopBackgroundRefresh();
    this.#publish({ ready: false });
  }

  #cacheCurrentChildDetail(): void {
    const detail = this.#view.childDetail;
    if (
      !detail?.hasLoadedHistory ||
      !this.#connection ||
      this.#historyConnection !== this.#connection ||
      !this.#historyWorkspaceDigest ||
      (detail.projection && detail.projection.workspaceDigest !== this.#historyWorkspaceDigest)
    )
      return;
    this.#historyCache.save(
      childHistoryKey(detail.parentSessionId, detail.childSessionId),
      this.#historyWorkspaceDigest,
      detail.messages,
    );
  }

  #removeInvalidChildFromView(parentSessionId: string, childSessionId: string): void {
    const cached = this.#childSessionCache.get(parentSessionId);
    if (cached) {
      this.#childSessionCache.set(
        parentSessionId,
        cached.filter((entry) => entry.sessionId !== childSessionId),
      );
    }
    this.#historyCache.take(childHistoryKey(parentSessionId, childSessionId));
    ++this.#childListRead;
    this.#childListRefreshInFlight = undefined;
    if (this.#childRestore?.childSessionId === childSessionId) this.#childRestore = undefined;
    const childSessions = this.#view.childSessions;
    if (childSessions?.parentSessionId === parentSessionId)
      this.#publish({
        childSessions: {
          ...childSessions,
          entries: childSessions.entries.filter((entry) => entry.sessionId !== childSessionId),
          loading: false,
        },
      });
  }

  async openChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const connection = this.#requireConnection();
    if (
      this.#view.selected !== parentSessionId ||
      !this.#view.childSessions?.entries.some(
        (entry) => entry.parentSessionId === parentSessionId && entry.sessionId === childSessionId,
      )
    )
      throw new Error('请先从父会话的环境信息或工具消息选择子会话。');
    const loadChildSession = connection.history.loadChildSession;
    if (!loadChildSession) throw new Error('当前服务不支持子会话历史读取。');
    if (this.#childRestore?.childSessionId !== childSessionId) this.#childRestore = undefined;
    const sameChild =
      this.#view.childDetail?.parentSessionId === parentSessionId &&
      this.#view.childDetail.childSessionId === childSessionId;
    const cached = sameChild
      ? undefined
      : this.#historyCache.take(childHistoryKey(parentSessionId, childSessionId));
    const usableCache =
      cached &&
      this.#historyConnection === connection &&
      cached.workspaceDigest === this.#historyWorkspaceDigest
        ? cached
        : undefined;
    if (!sameChild) this.#cacheCurrentChildDetail();
    // The parent remains an executing Service Session, but its reading stream
    // belongs to the departing page and must not follow the child page. This
    // also applies when reconnect kept the old child page mounted.
    this.#selection?.abort();
    this.#selectionLoad = undefined;
    this.#calibratedSelection = undefined;
    this.#stopBackgroundRefresh();
    this.#publish({ ready: false, loadingSession: false });
    this.#childRead?.abort();
    this.#calibratedChild = undefined;
    const controller = new AbortController();
    this.#childRead = controller;
    const currentRead = () =>
      !controller.signal.aborted &&
      this.#childRead === controller &&
      this.#connection === connection &&
      this.#view.selected === parentSessionId;
    const previous = sameChild ? this.#view.childDetail!.messages : (usableCache?.messages ?? []);
    const hasLoadedHistory = sameChild
      ? this.#view.childDetail!.hasLoadedHistory
      : (usableCache?.hasLoadedHistory ?? false);
    this.#publish({
      childDetail: {
        parentSessionId,
        childSessionId,
        loading: true,
        hasLoadedHistory,
        messages: previous,
      },
    });
    try {
      let [transcript, result] = await Promise.all([
        loadChildSession(parentSessionId, childSessionId, undefined, { signal: controller.signal }),
        connection.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_child_session_projection',
          sessionId: parentSessionId,
          childSessionId,
        }),
      ]);
      if (result.status === 'not_found') throw new InvalidHistoryIdentity('子会话已不可用。');
      if (result.status !== 'ok' || !result.session) throw new Error('子会话详情暂时不可用。');
      if (
        result.session.sessionId !== childSessionId ||
        transcript.session.sessionId !== childSessionId
      )
        throw new Error('子会话详情身份不一致。');
      if (!currentRead()) return;
      let messages = await projectHistory(transcript.records, previous, controller.signal);
      if (!currentRead()) return;
      this.#publish({
        childDetail: {
          parentSessionId,
          childSessionId,
          loading: true,
          hasLoadedHistory: true,
          messages,
          projection: result.session,
        },
      });
      const notifications = await connection.runtime.subscribeChildReadyWithGeneration({
        spec: {
          scope: 'child_session',
          parentSessionId,
          childSessionId,
          afterRevision: transcript.session.lastSequence,
          includeEphemeral: true,
        },
        signal: controller.signal,
      });
      if (!currentRead()) return;
      // The subscription starts at a current child projection. History may have
      // advanced while we were subscribing, so read through that watermark while
      // the established stream buffers subsequent events.
      let subscribed = connection.snapshotStore.getSnapshot().sessions[childSessionId];
      while (
        subscribed &&
        (!subscribed.ready || subscribed.projection.revision > transcript.session.lastSequence)
      ) {
        transcript = await loadChildSession(parentSessionId, childSessionId, undefined, {
          signal: controller.signal,
        });
        messages = await projectHistory(transcript.records, messages, controller.signal);
        const current = connection.snapshotStore.getSnapshot().sessions[childSessionId];
        if (current?.ready && current.subscriptionGeneration === subscribed.subscriptionGeneration)
          break;
        subscribed = current;
      }
      if (!currentRead()) return;
      subscribed = connection.snapshotStore.getSnapshot().sessions[childSessionId];
      if (!subscribed?.ready) throw new Error('子会话订阅尚未恢复，请刷新详情。');
      this.#calibratedChild = {
        controller,
        subscriptionGeneration: subscribed.subscriptionGeneration,
      };
      this.#publish({
        childDetail: {
          ...this.#view.childDetail!,
          loading: false,
          messages,
          projection: subscribed.projection,
        },
      });
      void this.#followChildSession(
        connection,
        controller,
        parentSessionId,
        childSessionId,
        notifications,
        transcript.session.lastSequence,
      );
    } catch (error) {
      if (currentRead()) {
        const invalid = invalidatesHistory(error);
        if (invalid) this.#removeInvalidChildFromView(parentSessionId, childSessionId);
        this.#publish({
          childDetail: {
            parentSessionId,
            childSessionId,
            loading: false,
            hasLoadedHistory:
              !invalid && (this.#view.childDetail?.hasLoadedHistory ?? hasLoadedHistory),
            messages: invalid
              ? []
              : this.#view.childDetail?.childSessionId === childSessionId
                ? this.#view.childDetail.messages
                : previous,
            error: messageOf(error),
          },
        });
      }
    }
  }

  async #followChildSession(
    connection: KiteAppServerConnection,
    controller: AbortController,
    parentSessionId: string,
    childSessionId: string,
    notifications: AsyncIterable<RuntimeClientNotificationWithGeneration>,
    throughSequence: number,
  ) {
    try {
      for await (const { notification, connectionGeneration } of notifications) {
        if (
          controller.signal.aborted ||
          this.#childRead !== controller ||
          this.#connection !== connection ||
          this.#view.selected !== parentSessionId
        )
          return;
        if (
          connectionGeneration !== connection.generation ||
          !('durability' in notification) ||
          notification.sessionId !== childSessionId
        )
          continue;
        if (notification.durability === 'durable' && notification.revision <= throughSequence)
          continue;
        const event =
          notification.durability === 'ephemeral'
            ? notification.event
            : notification.projection.event;
        if (!event) continue;
        const detail = this.#view.childDetail;
        if (detail?.childSessionId !== childSessionId) return;
        this.#publish({
          childDetail: {
            ...detail,
            messages: projectEventWithIdentity(detail.messages, event, {
              turnId: notification.turnId,
              observedAt: Date.now(),
            }),
          },
        });
      }
      if (!controller.signal.aborted) throw new Error('子会话订阅已结束，请刷新详情。');
    } catch (error) {
      if (
        !controller.signal.aborted &&
        this.#childRead === controller &&
        this.#connection === connection &&
        this.#view.childDetail?.childSessionId === childSessionId
      ) {
        this.#calibratedChild = undefined;
        this.#publish({
          childDetail: { ...this.#view.childDetail, error: messageOf(error) },
        });
      }
    }
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
      backgroundDisplay: this.#backgroundDisplayFor(
        sessionId,
        connection.snapshotStore.getSnapshot().background[sessionId],
      ),
      messages: sameSelection ? this.#view.messages : (usableCache?.messages ?? []),
      cacheMetrics: sameSelection ? this.#view.cacheMetrics : undefined,
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
        cacheMetrics: messages.cacheMetrics,
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
      if (result.status === 'not_found') {
        this.#removeDeletedSessionFromView(sessionId);
        throw new InvalidHistoryIdentity('会话已不可用，请刷新目录。');
      }
      if (result.status !== 'ok') throw new Error('会话暂时无法更新，请重新加载会话。');
      if (!result.session?.workspaceDigest)
        throw new InvalidHistoryIdentity('会话所属空间不可用，请刷新目录。');
      if (
        this.#historyWorkspaceDigest &&
        this.#historyWorkspaceDigest !== result.session.workspaceDigest
      )
        throw new InvalidHistoryIdentity('会话所属空间已改变，请重新加载会话。');
      this.#historyWorkspaceDigest = result.session.workspaceDigest;
      this.#invalidatedPresentationSessions.delete(sessionId);
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
        cacheMetrics: messages.cacheMetrics,
        interactionMode: messages.interactionMode,
        hasLoadedHistory: true,
        projection: session?.projection,
        ready: session?.ready ?? false,
      });
      void this.refreshChildSessions(sessionId).catch(() => undefined);
      if (connection.runtime.features.backgroundQuery)
        void connection.runtime
          .query({
            schema: 'kite.runtime-query.v1',
            type: 'list_background_executions',
            sessionId,
          })
          .catch(() => undefined);
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
        this.#invalidatedPresentationSessions.add(sessionId);
        this.#childSessionCache.delete(sessionId);
        this.#backgroundDisplayCache.delete(sessionId);
        this.#childRestore = undefined;
        ++this.#childListRead;
        this.#childListRefreshInFlight = undefined;
        this.#historyWorkspaceDigest = undefined;
        this.#historyConnection = undefined;
        this.#publish({
          messages: [],
          cacheMetrics: undefined,
          hasLoadedHistory: false,
          projection: undefined,
          childSessions: undefined,
          childDetail: undefined,
          backgroundDisplay: undefined,
        });
      }
      this.#publish({ ready: false });
      if (timedOut) {
        await connection.close().catch(() => undefined);
        if (this.#connection === connection) {
          this.#connection = undefined;
          this.#publish({ connected: false });
        }
        throw new Error('会话加载超时，请重新加载会话。');
      }
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
      cacheMetrics: projectCacheMetrics(transcript.records),
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
              observedAt: Date.now(),
            }),
            cacheMetrics: addCacheMetrics(this.#view.cacheMetrics, event),
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
    // Existing Sessions are admitted by the Service against their persisted workspace.
    // A renderer project selection or local directory is not a prerequisite for conversation.
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
    const activeRun = result.session.currentRun;
    if (
      activeRun?.activeTurnId &&
      (activeRun.status === 'queued' ||
        activeRun.status === 'running' ||
        activeRun.status === 'waiting')
    ) {
      await this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'steer_turn',
        sessionId,
        expectedRunId: activeRun.runId,
        expectedTurnId: activeRun.activeTurnId,
        input,
      });
      return;
    }
    const startTurn = (expectedRevision: number) =>
      this.#command({
        schema: 'kite.runtime-command.v1',
        commandId: crypto.randomUUID(),
        type: 'start_turn',
        sessionId,
        expectedRevision,
        input,
        phase: 'building',
        ...(model === undefined ? {} : { model }),
      });
    try {
      await startTurn(result.session.revision);
    } catch (error) {
      if (!(error instanceof CommandRejected) || error.code !== 'revision_conflict') throw error;
      if (this.#connection !== connection) throw new Error('连接已变化，请重新加载会话。');
      const refreshed = await connection.runtime.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      if (refreshed.status !== 'ok' || !refreshed.session)
        throw new Error('会话状态已更新，但最新状态读取失败；消息未发送，请重试。');
      if (isActiveRun(refreshed.session))
        throw new Error('会话状态已更新且已有任务正在运行；消息未发送，请确认后重新发送。');
      if (this.#connection !== connection) throw new Error('连接已变化，请重新加载会话。');
      await startTurn(refreshed.session.revision);
    }
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
  reset = false,
): DesktopSessionSummary {
  if (!projection || (!reset && projection.revision < (summary.revision ?? 0))) return summary;
  if (
    projection.revision === summary.revision &&
    projection.lifecycle === summary.lifecycle &&
    projection.currentRun === summary.currentRun &&
    projection.interactionQueue === summary.interactionQueue &&
    (projection.model?.provider ?? summary.model?.provider) === summary.model?.provider &&
    (projection.model?.name ?? summary.model?.name) === summary.model?.name &&
    (projection.updatedAt ?? summary.updatedAt) === summary.updatedAt
  )
    return summary;
  return {
    ...summary,
    revision: projection.revision,
    lifecycle: projection.lifecycle,
    currentRun: projection.currentRun,
    interactionQueue: projection.interactionQueue,
    model: projection.model ?? summary.model,
    updatedAt: projection.updatedAt ?? summary.updatedAt,
  };
}

function retainLiveSummary(
  refreshed: DesktopSessionSummary,
  previous: DesktopSessionSummary,
): DesktopSessionSummary {
  if (previous.revision === undefined || refreshed.revision !== undefined) return refreshed;
  return {
    ...refreshed,
    revision: previous.revision,
    lifecycle: previous.lifecycle,
    currentRun: previous.currentRun,
    interactionQueue: previous.interactionQueue,
    model: previous.model ?? refreshed.model,
    updatedAt:
      previous.updatedAt && (!refreshed.updatedAt || previous.updatedAt > refreshed.updatedAt)
        ? previous.updatedAt
        : refreshed.updatedAt,
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
    if (error.code === 'history_too_large') return '会话历史超过当前客户端的单次读取容量';
    if (error.code === 'request_overloaded') return '历史读取请求过多，请稍后重试';
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
        history_snapshot_changed: '会话历史在读取期间发生变化，请重试',
        history_too_large: '会话历史超过当前客户端的单次读取容量',
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
