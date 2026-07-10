// ── Agent Runtime Kernel 核心协调器 / Agent Runtime Kernel core coordinator ──
// AgentKernel 封装 RuntimeState 管理、事件管道和策略决策。
// RuntimeState、事件持久化和效果执行调度的统一入口。
//
// AgentKernel encapsulates RuntimeState management, event pipeline,
// and policy decisions.  Single entry point for state, persistence, and effect dispatch.

import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimePolicy } from '@/core/policies/runtime-policy';
import type { InteractionMode } from '@/protocol/events';
import { eventsForRuntimeAction, type RuntimeUserAction } from './actions';
import type { RuntimeEffect } from './effects';
import type { RuntimeEvent } from './events';
import { reduceRuntimeState } from './reducer';
import { decideNextEffect } from './scheduler';
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

/** Executes an effect and returns facts for the Kernel to reduce/persist. */
export type RuntimeEffectExecutor = (
  effect: RuntimeEffect,
  state: Readonly<RuntimeState>,
) => Promise<RuntimeEvent[]>;

// ── AgentKernel 实现 / AgentKernel implementation ──

/**
 * AgentKernel — 运行时状态的唯一管理入口。
 * AgentKernel — single management entry point for runtime state.
 *
 * 职责 / Responsibilities:
 * - 维护 RuntimeState（通过 reducer 处理事件更新）/ Maintain RuntimeState (update via reducer)
 * - 持久化 RuntimeEvent 到 EventStore / Persist RuntimeEvents to EventStore
 * - 管理 RuntimePolicy（根据 mode 创建策略）/ Manage RuntimePolicy (create policy from mode)
 * - 状态快照保存 / State snapshot persistence
 *
 * 不负责 / Does NOT handle:
 * - 调用模型（由 model-controller 负责）/ Calling the model (model-controller)
 * - 执行工具（由 tool-controller 负责）/ Executing tools (tool-controller)
 * - UI action collection（由 app/provider 负责）/ UI action collection (app/provider)
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
   * 处理单个 RuntimeEvent：reduce → persist。
   * Process a single RuntimeEvent: reduce → persist.
   */
  processEvent(event: RuntimeEvent): void {
    // 1. 更新状态 / Update state
    this.state = reduceRuntimeState(this.state, event);

    // 2. 持久化事件 / Persist event
    this.store.appendEvents(this.state.session.threadId, [event]);

    // Keep the snapshot at the same durability boundary as the append-only
    // event log.  A process crash must not leave a newer event log behind an
    // old (or absent) snapshot that resume would silently ignore.
    this.store.saveSnapshot(this.state.session.threadId, this.state);

    if (event.type === 'run.completed') {
      this.store.saveNamedSnapshot(
        this.state.session.threadId,
        `turn-${event.turnId}-${this.store.getLastEventPosition(this.state.session.threadId)}`,
        this.state,
      );
    }
  }

  /**
   * 批量处理多个 RuntimeEvent。
   * Process multiple RuntimeEvents in batch.
   */
  processEvents(events: RuntimeEvent[]): void {
    for (const event of events) {
      this.processEvent(event);
    }
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

  /**
   * Execute deterministic effects until the runtime needs user input or the
   * supplied executor stops emitting facts.  The executor never receives a
   * mutable state reference and cannot bypass processEvent().
   */
  async run(executor: RuntimeEffectExecutor, maxEffects = 10_000): Promise<RuntimeEffect> {
    for (let index = 0; index < maxEffects; index++) {
      const effect = decideNextEffect(this.state);
      if (
        effect.type === 'request_user_input' ||
        effect.type === 'request_plan_review' ||
        effect.type === 'request_tool_approval' ||
        effect.type === 'stop' ||
        effect.type === 'emit_final'
      ) {
        return effect;
      }
      const events = await executor(effect, this.getState());
      if (events.length === 0) return { type: 'stop' };
      this.processEvents(events);
    }
    throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
  }

  /** Apply a user action only when it matches the currently persisted interaction. */
  applyAction(action: RuntimeUserAction): void {
    this.processEvents(eventsForRuntimeAction(this.state, action));
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

  /** Save a stable recovery point for rewind/fork without involving Graph checkpoints. */
  saveNamedSnapshot(name: string): void {
    this.store.saveNamedSnapshot(this.state.session.threadId, name, this.state);
  }

  /** Restore a named RuntimeStore recovery point into this Kernel. */
  restoreNamedSnapshot(name: string): boolean {
    const snapshot = this.store.loadNamedSnapshot<RuntimeState>(this.state.session.threadId, name);
    if (!snapshot) return false;
    this.state = snapshot;
    return true;
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
  const freshState = createInitialRuntimeState({
    threadId: params.threadId,
    userId: params.userId,
    workspace: params.workspace,
    interactionMode: params.interactionMode ?? 'ask',
  });
  const restoredState = store.loadSnapshot<RuntimeState>(params.threadId);
  const initialState =
    restoredState?.session.threadId === params.threadId ? restoredState : freshState;

  return new AgentKernel({
    store,
    initialState,
    interactionMode: params.interactionMode ?? 'ask',
    sandboxAvailable: params.sandboxAvailable,
  });
}
