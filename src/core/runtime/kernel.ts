// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// Phase 4: AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// 将当前 runner.ts 中分散的 reduceRuntimeState + store.appendEvents + projectRuntimeEventToAgentEvent
// 调用收敛为统一入口，为 Phase 5 的 checkpoint 降级和主循环重构打基础。
//
// Phase 4: AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions. Converges the scattered reduceRuntimeState + store.appendEvents +
// projectRuntimeEventToAgentEvent calls in runner.ts into a single entry point,
// laying the foundation for Phase 5 checkpoint demotion and main loop refactoring.
//
// 注意：kernel.ts 当前是 factoring change（代码重组），不改行为语义。
// 完整的主循环（while decideNextEffect + controller dispatch）留在 Phase 5 实现。
// Note: kernel.ts is currently a factoring change (code reorganization), no behavior changes.
// The full main loop (while decideNextEffect + controller dispatch) is deferred to Phase 5.

import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimePolicy } from '@/core/policies/runtime-policy';
import type { AgentEvent, InteractionMode } from '@/protocol/events';
import type { RuntimeEvent } from './events';
import { projectRuntimeEventToAgentEvent } from './projection';
import { reduceRuntimeState } from './reducer';
import { createInitialRuntimeState, type RuntimeState } from './state';
import { createRuntimeStore, type RuntimeStore } from './store';

// ── Kernel 配置 / Kernel configuration ──

/** AgentKernel 初始化参数 / AgentKernel initialization parameters */
export interface KernelConfig {
  /** 运行时状态存储 / Runtime state store */
  store: RuntimeStore;
  /** 初始运行时状态 / Initial runtime state */
  initialState: RuntimeState;
  /** 交互模式 / Interaction mode */
  interactionMode: InteractionMode;
  /** 沙箱是否可用（影响 full mode 行为）/ Whether sandbox is available */
  sandboxAvailable?: boolean;
}

// ── AgentKernel 实现 / AgentKernel implementation ──

/**
 * AgentKernel — 运行时状态的唯一管理入口。
 * AgentKernel — single management entry point for runtime state.
 *
 * 职责 / Responsibilities:
 * - 维护 RuntimeState（通过 reducer 处理事件更新）/ Maintain RuntimeState (update via reducer)
 * - 持久化 RuntimeEvent 到 EventStore / Persist RuntimeEvents to EventStore
 * - 投影 RuntimeEvent 为 AgentEvent（供 TUI 消费）/ Project RuntimeEvents to AgentEvents (for TUI)
 * - 管理 RuntimePolicy（根据 mode 创建策略）/ Manage RuntimePolicy (create policy from mode)
 * - 状态快照保存 / State snapshot persistence
 *
 * 不负责 / Does NOT handle:
 * - 调用模型（由 model-controller 负责）/ Calling the model (model-controller)
 * - 执行工具（由 tool-controller 负责）/ Executing tools (tool-controller)
 * - 主循环控制（Phase 5 将添加）/ Main loop control (coming in Phase 5)
 */
export class AgentKernel {
  private store: RuntimeStore;
  private state: RuntimeState;
  private policy: RuntimePolicy;
  private sandboxAvailable: boolean;

  constructor(config: KernelConfig) {
    this.store = config.store;
    this.state = config.initialState;
    this.sandboxAvailable = config.sandboxAvailable ?? false;
    this.policy = createModePolicy(config.interactionMode, this.sandboxAvailable);
  }

  // ── 事件处理 / Event processing ──

  /**
   * 处理单个 RuntimeEvent：reduce → persist → project。
   * Process a single RuntimeEvent: reduce → persist → project.
   *
   * @param event - 要处理的运行时事件 / Runtime event to process
   * @returns 投影后的 AgentEvent 数组（供 TUI 消费）/ Projected AgentEvent array (for TUI)
   */
  processEvent(event: RuntimeEvent): AgentEvent[] {
    // 1. 更新状态 / Update state
    this.state = reduceRuntimeState(this.state, event);

    // 2. 持久化事件 / Persist event
    this.store.appendEvents(this.state.session.threadId, [event]);

    // 3. 投影为 TUI 事件 / Project to TUI events
    return projectRuntimeEventToAgentEvent(event);
  }

  /**
   * 批量处理多个 RuntimeEvent。
   * Process multiple RuntimeEvents in batch.
   *
   * @param events - 要处理的运行时事件数组 / Array of runtime events
   * @returns 聚合的 AgentEvent 数组 / Aggregated AgentEvent array
   */
  processEvents(events: RuntimeEvent[]): AgentEvent[] {
    const result: AgentEvent[] = [];
    for (const event of events) {
      result.push(...this.processEvent(event));
    }
    return result;
  }

  // ── 状态访问 / State access ──

  /**
   * 获取当前运行时状态的只读副本。
   * Get a read-only copy of the current runtime state.
   */
  getState(): Readonly<RuntimeState> {
    return this.state;
  }

  /**
   * 获取当前运行时策略。
   * Get the current runtime policy.
   */
  getPolicy(): RuntimePolicy {
    return this.policy;
  }

  /**
   * 获取当前交互模式。
   * Get the current interaction mode.
   */
  getMode(): InteractionMode {
    return this.state.mode;
  }

  // ── 持久化 / Persistence ──

  /**
   * 保存当前状态的快照到 EventStore。
   * Save a snapshot of the current state to the EventStore.
   */
  saveSnapshot(): void {
    this.store.saveSnapshot(this.state.session.threadId, this.state);
  }

  /**
   * 从 EventStore 加载状态快照。
   * Load a state snapshot from the EventStore.
   *
   * @param threadId - 线程 ID / Thread id
   * @returns 恢复的 RuntimeState，无快照时返回 null
   */
  loadSnapshot(threadId: string): RuntimeState | null {
    return this.store.loadSnapshot<RuntimeState>(threadId);
  }

  /**
   * 加载线程的事件日志。
   * Load event log for a thread.
   *
   * @param threadId - 线程 ID / Thread id
   * @param since - 可选的起始事件 ID / Optional starting event id
   * @returns 事件日志条目数组 / Array of stored events
   */
  loadEvents(threadId: string, since?: number) {
    return this.store.loadEvents(threadId, since);
  }

  // ── 生命周期 / Lifecycle ──

  /**
   * 关闭 kernel（释放 store 连接等）。
   * Close the kernel (release store connections, etc.).
   */
  close(): void {
    this.store.close();
  }
}

// ── 工厂函数 / Factory ──

/**
 * 创建 AgentKernel 实例的便捷工厂。
 * Convenience factory for creating an AgentKernel instance.
 *
 * @param threadId - 线程 ID / Thread id
 * @param userId - 用户 ID / User id
 * @param workspace - 工作目录 / Workspace path
 * @param storePath - RuntimeStore 数据库路径 / RuntimeStore database path
 * @param interactionMode - 交互模式，默认 'ask' / Interaction mode, defaults to 'ask'
 * @param sandboxAvailable - 沙箱是否可用 / Whether sandbox is available
 * @returns 初始化的 AgentKernel 实例 / Initialized AgentKernel instance
 */
export function createAgentKernel(params: {
  threadId: string;
  userId: string;
  workspace: string;
  storePath: string;
  interactionMode?: InteractionMode;
  sandboxAvailable?: boolean;
}): AgentKernel {
  const store = createRuntimeStore(params.storePath);
  const initialState = createInitialRuntimeState({
    threadId: params.threadId,
    userId: params.userId,
    workspace: params.workspace,
    interactionMode: params.interactionMode ?? 'ask',
  });

  return new AgentKernel({
    store,
    initialState,
    interactionMode: params.interactionMode ?? 'ask',
    sandboxAvailable: params.sandboxAvailable,
  });
}
