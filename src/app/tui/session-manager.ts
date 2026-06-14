import type { AgentEvent } from "@/protocol/events";
import type { InterruptPayload, UserAction } from "@/protocol/actions";
import type { UserInputProvider } from "@/protocol/provider";
import type { AgentConfig } from "@/core/config/index";
import type { TuiUserInputProvider } from "./provider";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { McpManager } from "@/core/mcp";
import type { SessionSnapshot, StatusState } from "./types";
import type { Action } from "./App";
import { runAgent, isRecoverableError } from "@/core/runner";
import { buildRunAgentParams } from "./run-agent";
import { createSandboxExecutor } from "@/core/sandbox/index";
import { Database } from "bun:sqlite";

/** 可丢弃的缓冲事件类型（text/reason 为非关键信息，丢弃时不丢失用户可见状态） */
const DISPOSABLE_EVENT_TYPES = new Set(["text", "reason"]);

/** 工厂依赖：注入到每个 SessionRuntime */
export interface SessionDeps {
  config: AgentConfig;
  provider: TuiUserInputProvider;
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;
  /** checkpoint DB 路径，用于持久化 token 统计 / Checkpoint DB path for persisting token stats */
  checkpointPath: string;
}

/** 单会话运行时：持有独立的 AbortController、generator、缓冲 */
export class SessionRuntime {
  readonly threadId: string;
  readonly workspace: string;

  abortController: AbortController | null = null;
  agentLoopActive = false;
  pendingInterrupt = false;
  eventBuffer: AgentEvent[] = [];
  /** true if loaded from DB and state not yet hydrated / 从 DB 加载但尚未加载完整状态 */
  dormant = false;
  static readonly MAX_BUFFER = 1000;

  conversationHistory: string[] = [];
  pendingSkills: string[] = [];
  thinkingLevel: string | null = null;
  name: string;

  skillManifests: SkillManifest[];
  readonly skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;

  generator: AsyncGenerator<AgentEvent> | null = null;
  /** 当后台会话命中中断时通知 Manager 刷新快照 / Callback to notify Manager on background interrupt */
  notifyInterrupt: (() => void) | null = null;

  // ── 双模式代理：生成器始终使用 _proxyProvider，通过 _foreground 切换事件路由 ──
  private _foreground = true;
  private _foregroundWake: (() => void) | null = null;
  private _proxyProvider: UserInputProvider;
  /** 每实例独立的中断状态，不与 realProvider 共享 pendingResolve。中断永久等待用户处理 */
  private _pendingInterrupt: InterruptPayload | null = null;
  private _pendingResolve: ((action: UserAction) => void) | null = null;

  constructor(
    threadId: string,
    workspace: string,
    deps: SessionDeps,
  ) {
    this.threadId = threadId;
    this.workspace = workspace;
    this.name = threadId;
    this.skillManifests = deps.skillManifests;
    this.skillOptions = deps.skillOptions;
    this.mcpManager = deps.mcpManager;

    this._proxyProvider = this._createProxyProvider(deps.provider);
  }

  // ── 公开 API ──

  abort(): void {
    // 必须先 resolve 挂起的中断，否则 generator 永远卡在 requestAction 的 Promise 上，
    // runAgent 的 finally 块无法执行，checkpointer.close() 永远不会被调用，导致 DB 句柄泄漏
    this.resolveInterrupt({ type: "cancel" as const });
    this.abortController?.abort();
    this.abortController = null;
    this.agentLoopActive = false;
    this.generator = null;
    // 如果有挂起的后台中断等待，解除阻塞
    this._foregroundWake?.();
    this._foregroundWake = null;
  }

  clearBuffer(): void {
    this.eventBuffer = [];
    this.conversationHistory = [];
    this.pendingSkills = [];
    this.pendingInterrupt = false;
  }

  /** 切换到前台：新事件路由到 provider.onEvent，唤醒挂起的后台中断 */
  setForeground(foreground: boolean): void {
    this._foreground = foreground;
    if (foreground) {
      this._foregroundWake?.();
      this._foregroundWake = null;
    }
  }

  // ── Agent 运行 ──

  /** 运行 agent 任务。始终使用代理提供器，通过 _foreground 控制事件路由 */
  async runTask(
    task: string,
    deps: {
      dispatch: (action: Action) => void;
      provider: TuiUserInputProvider;
      config: AgentConfig;
      model?: import("@/core/model/factory").SupportedChatModel;
    },
  ): Promise<void> {
    if (this.agentLoopActive) return;

    // 构建待注入的 skills 内容
    let pendingSkillsContent = "";
    if (this.pendingSkills.length > 0) {
      pendingSkillsContent = this.pendingSkills.join("");
      this.pendingSkills = [];
    }

    const shellContext = this.conversationHistory.length > 0
      ? "\n" + this.conversationHistory.join("\n")
      : "";
    const shellExecutor = createSandboxExecutor({ enabled: true, workspace: this.workspace });

    const abortController = new AbortController();

    const runAgentParams = buildRunAgentParams({
      task,
      threadId: this.threadId,
      workspace: this.workspace,
      config: deps.config,
      shellExecutor,
      signal: abortController.signal,
      thinkingLevel: this.thinkingLevel,
      skills: this.skillManifests,
      skillOptions: this.skillOptions,
      mcpManager: this.mcpManager,
      pendingSkillsContent,
      shellContext,
      model: deps.model,
      // 后台会话注入 full_access，避免中断阻塞 generator
      authorizationOverride: this._foreground ? undefined : { current: "full_access" as const },
    });

    // 始终使用代理提供器 — 事件路由由 _foreground 控制
    const generator = runAgent(this._proxyProvider, runAgentParams);

    // 所有状态变更必须在 try 块内，防止 buildRunAgentParams/runAgent 抛出时
    // agentLoopActive 和 abortController 泄漏导致会话永久冻结
    let aborted = false;
    try {
      this.agentLoopActive = true;
      this.abortController = abortController;
      this.generator = generator;
      for await (const _ of generator) {
        if (abortController.signal.aborted) {
          aborted = true;
          break;
        }
      }
      if (!aborted && this._foreground) {
        deps.dispatch({ type: "SET_EXITED" });
      }
    } catch (e: any) {
      const errorEvent: AgentEvent = {
        type: "error",
        data: { message: e?.message ?? String(e), recoverable: isRecoverableError(e) },
      };
      if (this._foreground) {
        deps.provider.onEvent(errorEvent);
      } else {
        this._pushToBuffer(errorEvent);
      }
      if (this._foreground) {
        deps.dispatch({ type: "SET_EXITED" });
      }
    } finally {
      this.agentLoopActive = false;
      this.abortController = null;
      this.generator = null;
      if (this._foreground) {
        deps.provider.reset();
      }
    }
  }

  // ── 私有：代理提供器 & 缓冲 ──

  /** 推送事件到缓冲，溢出时优先丢弃非关键事件 */
  private _pushToBuffer(event: AgentEvent): void {
    if (this.eventBuffer.length >= SessionRuntime.MAX_BUFFER) {
      // 查找第一个可丢弃事件的下标
      const dropIdx = this.eventBuffer.findIndex(
        (e) => DISPOSABLE_EVENT_TYPES.has(e.type),
      );
      if (dropIdx >= 0) {
        this.eventBuffer.splice(dropIdx, 1);
      } else {
        // 无可丢弃事件，移除最老的
        this.eventBuffer.shift();
      }
    }
    this.eventBuffer.push(event);
  }

  /** 创建代理提供器。interrupt 使用运行时自身状态，永久等待用户处理 */
  private _createProxyProvider(realProvider: TuiUserInputProvider): TuiUserInputProvider {
    const self = this;
    const proxy = {
      onEvent(event: AgentEvent): void {
        if (self._foreground) {
          realProvider.onEvent(event);
        } else {
          // need_input is auto-cancelled in background (requestAction returns cancel immediately),
          // so don't buffer it — replay would create an unanswerable zombie question
          if (event.type === "need_input") return;
          self._pushToBuffer(event);
          if (event.type === "need_approval") {
            self.pendingInterrupt = true;
            self.notifyInterrupt?.();
          }
        }
      },

      async requestAction(payload: InterruptPayload): Promise<UserAction> {
        if (!self._foreground) {
          // user_input in background: auto-cancel (user can't respond)
          // need_approval won't fire due to authorizationOverride, but guard anyway
          if (payload.kind === "input") {
            return { type: "cancel" as const };
          }
          // 后台 tool_approval 中断：标记并等待前台切换
          // Background tool_approval: mark and wait for foreground switch
          self.pendingInterrupt = true;
          self.notifyInterrupt?.();
          await new Promise<void>((resolve) => {
            self._foregroundWake = resolve;
          });
          if (!self.abortController) {
            return { type: "cancel" as const };
          }
          self.pendingInterrupt = false;
        }
        // 使用运行时自身的中断状态，永久等待用户处理
        self._pendingInterrupt = payload;
        return new Promise<UserAction>((resolve) => {
          self._pendingResolve = resolve;
        });
      },

      submitAction(action: UserAction): void {
        self.resolveInterrupt(action);
      },

      reset(): void {
        self.resolveInterrupt({ type: "cancel" as const });
      },

      getPendingInterrupt(): InterruptPayload | null {
        return self._pendingInterrupt;
      },

      teardown(): Promise<void> {
        self.resolveInterrupt({ type: "cancel" as const });
        return Promise.resolve();
      },
    };
    return proxy as unknown as TuiUserInputProvider;
  }

  /** 解析挂起的中断（由 SessionManager 的中央 bridge 调用）/ Resolve pending interrupt (called by SessionManager's central bridge) */
  resolveInterrupt(action: UserAction): void {
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingInterrupt = null;
      r(action);
    }
  }
}

/** 多会话管理器：创建/切换/查快照 */
export class SessionManager {
  private runtimes = new Map<string, SessionRuntime>();
  private activeId = "";
  private snapshotCallback: ((threadId: string) => void) | null = null;
  private static sessionCounter = 0;
  /** token 统计内存缓存，避免 getSnapshot 每次打开 DB / In-memory token stats cache to avoid DB access in getSnapshot */
  private tokenStatsCache = new Map<string, { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number }>();
  /** 复用的 DB 连接，避免每次 saveTokenStats 开新连接 / Reusable DB connection to avoid opening a new one on every save */
  private _statsDb: Database | null = null;
  /** 防抖定时器：合并高频 token 统计变更为批量写入，避免每个 stream chunk 都写 DB
   *  Debounce timers: batch high-frequency token stat changes into fewer writes */
  private _statsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 防抖延迟（毫秒）/ Debounce delay in ms */
  private static readonly STATS_DEBOUNCE_MS = 1000;

  constructor(private deps: SessionDeps) {
    // Central bridge: when UI components (ApprovalBlock, InputBlock) call submitAction
    // on the real provider, route to the active runtime's resolveInterrupt.
    // This runs once, avoiding the chain-wrapping anti-pattern of per-runtime bridges.
    if (deps.provider.submitAction) {
      const origSubmit = deps.provider.submitAction.bind(deps.provider);
      deps.provider.submitAction = (action: UserAction) => {
        origSubmit(action);
        const active = this.runtimes.get(this.activeId);
        active?.resolveInterrupt(action);
      };
    }
  }

  /** 懒加载 stats DB 连接 / Lazy-load the stats DB connection */
  private get statsDb(): Database {
    if (!this._statsDb) {
      this._statsDb = new Database(this.deps.checkpointPath);
      // WAL 模式提升并发读写性能，与 BunSqliteSaver 保持一致
      // Enable WAL mode for consistent concurrent read/write behavior with BunSqliteSaver
      this._statsDb.run("pragma journal_mode = wal");
      this._statsDb.run("pragma busy_timeout = 5000");
      this._statsDb.run(`create table if not exists session_stats (
        thread_id text primary key not null,
        cache_hit_tokens integer not null default 0,
        cache_miss_tokens integer not null default 0,
        total_tokens integer not null default 0,
        updated_at text not null default (datetime('now')))`);
    }
    return this._statsDb;
  }

  /** 持久化 token 统计到 checkpoint DB（防抖合并，避免每次 token 变化都写 DB）
   *  Persist token stats to DB with debounce, avoiding a write on every token change */
  saveTokenStats(threadId: string, status: StatusState, immediate = false): void {
    const stats = { cacheHitTokens: status.cacheHitTokens, cacheMissTokens: status.cacheMissTokens, totalTokens: status.totalTokens };
    this.tokenStatsCache.set(threadId, stats);

    if (immediate) {
      this._flushTokenStatsNow(threadId, stats);
      return;
    }

    // 清除旧定时器，创建新的合并定时器
    const existing = this._statsDebounceTimers.get(threadId);
    if (existing) clearTimeout(existing);
    this._statsDebounceTimers.set(threadId, setTimeout(() => {
      this._statsDebounceTimers.delete(threadId);
      // 从缓存读取最新值而非闭包捕获，避免跨调用 stale write 风险
      // Read latest from cache rather than closure-captured value to avoid stale-write risk
      const latest = this.tokenStatsCache.get(threadId) ?? stats;
      this._flushTokenStatsNow(threadId, latest);
    }, SessionManager.STATS_DEBOUNCE_MS));
  }

  /** 立即写入 DB（绕过防抖）/ Immediate DB write (bypasses debounce) */
  private _flushTokenStatsNow(
    threadId: string,
    stats: { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number },
  ): void {
    try {
      this.statsDb.run(
        `insert or replace into session_stats (thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens, updated_at)
         values (?, ?, ?, ?, datetime('now'))`,
        [threadId, stats.cacheHitTokens, stats.cacheMissTokens, stats.totalTokens],
      );
    } catch (e) {
      console.warn(`[SessionManager] Failed to persist token stats for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  createSession(workspace: string): string {
    // Deactivate old session before creating new one — same logic as switchSession
    const oldRt = this.runtimes.get(this.activeId);
    if (oldRt) {
      oldRt.resolveInterrupt({ type: "cancel" as const });
      oldRt.setForeground(false);
      oldRt.pendingInterrupt = false;
    }
    const threadId = `tui-${Date.now().toString(36)}-${SessionManager.sessionCounter++}`;
    const rt = new SessionRuntime(threadId, workspace, this.deps);
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.runtimes.set(threadId, rt);
    this.activeId = threadId;
    return threadId;
  }

  getRuntime(threadId: string): SessionRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  getActiveId(): string {
    return this.activeId;
  }

  switchSession(fromId: string, toId: string): void {
    // 离开的会话切到后台模式
    const fromRt = this.runtimes.get(fromId);
    if (fromRt) {
      // 取消旧会话的挂起中断，防止 generator 卡在 requestAction 的 Promise 上
      fromRt.resolveInterrupt({ type: "cancel" as const });
      fromRt.setForeground(false);
      fromRt.pendingInterrupt = false;
    }
    this.activeId = toId;
  }

  /** 懒加载：首次访问时从 DB 批量载入 token 统计到内存缓存
   *  Lazy load: populate in-memory cache from DB on first access */
  private ensureTokenStatsLoaded(): void {
    if (this.tokenStatsCache.size > 0) return;
    try {
      const rows = this.statsDb
        .query(`select thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens from session_stats`)
        .all() as Array<{ thread_id: string; cache_hit_tokens: number; cache_miss_tokens: number; total_tokens: number }>;
      for (const r of rows) {
        this.tokenStatsCache.set(r.thread_id, { cacheHitTokens: r.cache_hit_tokens, cacheMissTokens: r.cache_miss_tokens, totalTokens: r.total_tokens });
      }
    } catch (e) {
      console.warn(`[SessionManager] Failed to load token stats from DB: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 创建会话快照列表。
   *  @param prevSessions 前一次 snapshot 数组，用于继承已累积的 token 统计等跨生命周期状态。
   *  Create session snapshot list.
   *  @param prevSessions previous snapshot array, used to inherit accumulated token stats across lifecycles. */
  getSnapshot(prevSessions?: ReadonlyArray<{ threadId: string; status: StatusState }>): SessionSnapshot[] {
    // 首次调用时从 DB 批量加载到内存缓存 / Bulk load from DB into memory cache on first call
    this.ensureTokenStatsLoaded();
    const prevMap = new Map(prevSessions?.map(s => [s.threadId, s.status]));
    const result: SessionSnapshot[] = [];
    for (const [threadId, rt] of this.runtimes) {
      const prevStatus = prevMap.get(threadId);
      const dbStats = this.tokenStatsCache.get(threadId);
      result.push({
        threadId,
        name: rt.name,
        workspace: rt.workspace,
        active: threadId === this.activeId,
        running: rt.agentLoopActive,
        pendingInterrupt: rt.pendingInterrupt,
        interrupt: null,
        plan: null,
        status: {
          ...initialStatusSnapshot(),
          ...(dbStats ?? {}),         // 从 DB 恢复的 token 统计
          ...(prevStatus ?? {}),      // 内存中保留的状态（优先级最高）
        },
        turns: [],
      });
    }
    return result;
  }

  onInterruptPending(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  onStatusChange(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  /** 设置会话名称（在 generateSessionName 后调用） */
  setName(threadId: string, name: string): void {
    const rt = this.runtimes.get(threadId);
    if (rt) rt.name = name;
  }

  setSnapshotCallback(fn: (threadId: string) => void): void {
    this.snapshotCallback = fn;
  }

  // ── 供 index.tsx /new 拦截使用 ──

  /** 注册一个由外部创建的 threadId（如 FORK） */
  registerSession(threadId: string, workspace: string): SessionRuntime {
    const rt = new SessionRuntime(threadId, workspace, this.deps);
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.runtimes.set(threadId, rt);
    return rt;
  }

  /** 检查指定 threadId 是否已有运行时 / Check if a runtime exists for threadId */
  hasRuntime(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  /** 移除运行时（会话删除后调用）/ Remove a runtime (called after session deletion) */
  removeRuntime(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (rt) {
      rt.abort();
      rt.clearBuffer();
    }
    this.runtimes.delete(threadId);
    // Don't leave activeId pointing to a deleted session
    if (this.activeId === threadId) {
      this.activeId = "";
    }
  }

  /** 中止所有运行中的会话（退出时调用）/ Abort all running sessions (called on exit) */
  abortAll(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.agentLoopActive) {
        rt.abort();
      }
    }
  }

  /** 清理资源：刷新所有防抖写入、关闭 DB 连接 / Cleanup: flush all pending debounce writes, close DB */
  dispose(): void {
    // 清除所有防抖定时器并立即写入最新值
    // Clear all debounce timers and write latest values immediately
    for (const [threadId, timer] of this._statsDebounceTimers) {
      clearTimeout(timer);
      const stats = this.tokenStatsCache.get(threadId);
      if (stats) this._flushTokenStatsNow(threadId, stats);
    }
    this._statsDebounceTimers.clear();

    // 关闭 stats DB 连接，确保 WAL/SHM 文件正确合并
    // Close stats DB connection to properly merge WAL/SHM files
    if (this._statsDb) {
      try { this._statsDb.close(); } catch { /* best-effort */ }
      this._statsDb = null;
    }
  }

  /** 同步 skills 到所有现有运行时（skills 扫描完成后调用）/ Sync skill manifests to all existing runtimes (called after skill scan completes) */
  updateSkillManifests(manifests: SkillManifest[]): void {
    this.deps.skillManifests = manifests;
    for (const rt of this.runtimes.values()) {
      rt.skillManifests = manifests;
    }
  }

  /** 同步 MCP manager 到所有现有运行时（MCP 连接完成后调用）/ Sync MCP manager to all existing runtimes (called after MCP connect completes) */
  updateMcpManager(mcp: McpManager): void {
    this.deps.mcpManager = mcp;
    for (const rt of this.runtimes.values()) {
      rt.mcpManager = mcp;
    }
  }
}

function initialStatusSnapshot(): StatusState {
  return {
    phase: "building",
    plan: null,
    authorization: "default",
    workspaceAccess: "write",
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: "",
    modelName: "",
    thinkingMode: "",
    retryState: null,
  };
}
