import type { AgentEvent } from "@/protocol/events";
import type { AgentConfig } from "@/core/config/index";
import type { TuiUserInputProvider } from "./provider";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { McpManager } from "@/core/mcp";
import type { SessionSnapshot, StatusState } from "./types";
import { runAgent, isRecoverableError } from "@/core/runner";
import { buildRunAgentParams } from "./run-agent";
import { createSandboxExecutor } from "@/core/sandbox/index";

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
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.agentLoopActive = false;
    this.generator = null;
  }

  clearBuffer(): void {
    this.eventBuffer = [];
    this.conversationHistory = [];
    this.pendingSkills = [];
    this.pendingInterrupt = false;
  }

  /** 运行 agent 任务，支持前台和后台两种模式 / Run agent task in foreground or background mode */
  async runTask(
    task: string,
    deps: {
      dispatch: (action: any) => void;
      provider: TuiUserInputProvider;
      config: AgentConfig;
    },
    mode: "foreground" | "background",
  ): Promise<void> {
    if (this.agentLoopActive) return;

    // 构建待注入的 skills 内容 / Build pending skills content for injection
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
    });

    // 后台模式：使用缓冲提供器，事件进入 buffer 而非直接 dispatch / Background mode: buffer events instead of dispatching
    const actualProvider = mode === "background"
      ? this._createBufferingProvider()
      : deps.provider;

    const generator = runAgent(actualProvider, runAgentParams);
    this.generator = generator;

    let aborted = false;

    try {
      for await (const _ of generator) {
        if (abortController.signal.aborted) {
          aborted = true;
          break;
        }
      }
      if (!aborted) deps.dispatch({ type: "SET_EXITED" });
    } catch (e: any) {
      const errorEvent: AgentEvent = {
        type: "error",
        data: { message: e?.message ?? String(e), recoverable: isRecoverableError(e) },
      };
      if (mode === "foreground") {
        deps.provider.onEvent(errorEvent);
      } else {
        this.eventBuffer.push(errorEvent);
      }
      deps.dispatch({ type: "SET_EXITED" });
    } finally {
      this.abortController = null;
      this.generator = null;
      if (mode === "foreground") {
        deps.provider.reset();
      }
    }
  }

  /** 创建后台缓冲提供器：事件进 buffer，中断立即返回 cancel / Create background buffering provider */
  private _createBufferingProvider(): TuiUserInputProvider {
    const self = this;
    return {
      onEvent(event: AgentEvent): void {
        self.eventBuffer.push(event);
        if (self.eventBuffer.length > SessionRuntime.MAX_BUFFER) {
          self.eventBuffer.shift();
        }
        if (event.type === "need_approval" || event.type === "need_input") {
          self.pendingInterrupt = true;
          self.notifyInterrupt?.();
        }
      },
      async requestAction(): Promise<{ type: "cancel" }> {
        return { type: "cancel" };
      },
      reset(): void {},
      submitAction(): void {},
      getPendingInterrupt(): null { return null; },
      teardown(): Promise<void> { return Promise.resolve(); },
      compactRequested: false,
    } as unknown as TuiUserInputProvider;
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
    const fromRt = this.runtimes.get(fromId);
    if (fromRt) {
      fromRt.eventBuffer = [];  // 切换时清空离开的会话缓冲区 / Clear outgoing session buffer on switch
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

  /** 设置会话名称（在 generateSessionName 后调用）/ Set session display name */
  setName(threadId: string, name: string): void {
    const rt = this.runtimes.get(threadId);
    if (rt) rt.name = name;
  }

  setSnapshotCallback(fn: (threadId: string) => void): void {
    this.snapshotCallback = fn;
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
