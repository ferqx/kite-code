import type { AgentEvent } from "@/protocol/events";
import type { AgentConfig } from "@/core/config/index";
import type { TuiUserInputProvider } from "./provider";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { McpManager } from "@/core/mcp";
import type { SessionSnapshot, StatusState } from "./types";
import { runAgent, isRecoverableError } from "@/core/runner";
import { buildRunAgentParams } from "./run-agent";
import { createSandboxExecutor } from "@/core/sandbox/index";

/** 可丢弃的缓冲事件类型（text/reason 为非关键信息，丢弃时不丢失用户可见状态） */
const DISPOSABLE_EVENT_TYPES = new Set(["text", "reason"]);

/** 工厂依赖：注入到每个 SessionRuntime */
export interface SessionDeps {
  config: AgentConfig;
  provider: TuiUserInputProvider;
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;
}

/** 单会话运行时：持有独立的 AbortController、generator、缓冲 */
export class SessionRuntime {
  readonly threadId: string;
  readonly workspace: string;

  abortController: AbortController | null = null;
  agentLoopActive = false;
  pendingInterrupt = false;
  eventBuffer: AgentEvent[] = [];
  static readonly MAX_BUFFER = 1000;

  conversationHistory: string[] = [];
  pendingSkills: string[] = [];
  thinkingLevel: string | null = null;
  name: string;

  readonly skillManifests: SkillManifest[];
  readonly skillOptions: SkillScanOptions | null;
  readonly mcpManager: McpManager | null;

  generator: AsyncGenerator<AgentEvent> | null = null;
  /** 当后台会话命中中断时通知 Manager 刷新快照 / Callback to notify Manager on background interrupt */
  notifyInterrupt: (() => void) | null = null;

  // ── 双模式代理：生成器始终使用 _proxyProvider，通过 _foreground 切换事件路由 ──
  private _foreground = true;
  private _foregroundWake: (() => void) | null = null;
  private _proxyProvider: TuiUserInputProvider;
  /** 每实例独立的中断状态，不与 realProvider 共享 pendingResolve。中断永久等待用户处理 */
  private _pendingInterrupt: any = null;
  private _pendingResolve: ((action: any) => void) | null = null;

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
      dispatch: (action: any) => void;
      provider: TuiUserInputProvider;
      config: AgentConfig;
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
    this.abortController = abortController;

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
      // 后台会话注入 full_access，避免中断阻塞 generator
      authorizationOverride: this._foreground ? undefined : { current: "full_access" as const },
    });

    // 始终使用代理提供器 — 事件路由由 _foreground 控制
    const generator = runAgent(this._proxyProvider as any, runAgentParams);
    this.generator = generator;

    let aborted = false;

    try {
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
    return {
      onEvent(event: AgentEvent): void {
        if (self._foreground) {
          realProvider.onEvent(event);
        } else {
          self._pushToBuffer(event);
          if (event.type === "need_approval" || event.type === "need_input") {
            self.pendingInterrupt = true;
            self.notifyInterrupt?.();
          }
        }
      },

      async requestAction(
        payload: { kind: string; approval?: any; question?: any },
      ): Promise<any> {
        if (!self._foreground) {
          // 后台中断：标记并等待前台切换
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
        return new Promise<any>((resolve) => {
          self._pendingResolve = resolve;
        });
      },

      submitAction(action: any): void {
        self._resolveInterrupt(action);
      },

      reset(): void {
        self._resolveInterrupt({ type: "cancel" as const });
      },

      getPendingInterrupt(): any {
        return self._pendingInterrupt;
      },

      teardown(): Promise<void> {
        self._resolveInterrupt({ type: "cancel" as const });
        return Promise.resolve();
      },

      get compactRequested(): boolean { return (realProvider as any).compactRequested ?? false; },
      set compactRequested(v: boolean) { (realProvider as any).compactRequested = v; },
    } as unknown as TuiUserInputProvider;
  }

  private _resolveInterrupt(action: any): void {
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

  constructor(private deps: SessionDeps) {}

  createSession(workspace: string): string {
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
      fromRt.setForeground(false);
      fromRt.pendingInterrupt = false;
    }
    this.activeId = toId;
  }

  deactivateSession(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    if (rt.agentLoopActive) return;
    rt.abortController = null;
    rt.generator = null;
    rt.eventBuffer = [];
  }

  getSnapshot(): SessionSnapshot[] {
    const result: SessionSnapshot[] = [];
    for (const [threadId, rt] of this.runtimes) {
      result.push({
        threadId,
        name: rt.name,
        workspace: rt.workspace,
        active: threadId === this.activeId,
        running: rt.agentLoopActive,
        pendingInterrupt: rt.pendingInterrupt,
        plan: null,
        status: initialStatusSnapshot(),
        blocks: [],
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
}

function initialStatusSnapshot(): StatusState {
  return {
    phase: "building",
    plan: null,
    authorization: "default",
    workspaceAccess: "write",
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelName: "",
    thinkingMode: "",
  };
}
