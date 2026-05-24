import type { AgentEvent } from "@/protocol/events";
import type { AgentConfig } from "@/core/config/index";
import type { TuiUserInputProvider } from "./provider";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { McpManager } from "@/core/mcp";
import type { SessionSnapshot, StatusState } from "./types";

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

  readonly skillManifests: SkillManifest[];
  readonly skillOptions: SkillScanOptions | null;
  readonly mcpManager: McpManager | null;

  generator: AsyncGenerator<AgentEvent> | null = null;

  constructor(
    threadId: string,
    workspace: string,
    deps: SessionDeps,
  ) {
    this.threadId = threadId;
    this.workspace = workspace;
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
        name: threadId,
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
