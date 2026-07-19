export interface CircuitBreakerConfig {
  /** 连续拒绝次数阈值 / Consecutive rejection count threshold */
  maxRejections: number;
  /** 滑动窗口时间（ms）/ Sliding window in ms */
  windowMs: number;
  /** 窗口内总计拒绝数上限 / Max total rejections within window */
  maxTotalBlocks: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxRejections: 3,
  windowMs: 30_000,
  maxTotalBlocks: 20,
};

export interface RejectionEntry {
  timestamp: number;
  toolName: string;
  reason: string;
}

export interface CircuitBreakerState {
  status: 'closed' | 'open';
}

/** Auto-review 的持久化状态，替代原先分散的 4 个 channel。
 *  Persistent auto-review state grouping — replaces the former 4 scattered channels. */
export interface AutoReviewState {
  /** 待注入的跨节点警告（tools 节点消费后清除）/ Pending warnings for injection, cleared by tools node */
  pendingWarnings: Record<string, string>;
  /** 连续拒绝计数（断路器条件 A）/ Consecutive rejection count (breaker condition A) */
  consecutiveRejects: number;
  /** 拒绝历史记录（断路器滑动窗口）/ Rejection history (breaker sliding window) */
  rejectionHistory: RejectionEntry[];
  /** 断路器是否已触发 / Whether circuit breaker has tripped */
  circuitBreakerTripped: boolean;
}

export const DEFAULT_AUTO_REVIEW_STATE: AutoReviewState = {
  pendingWarnings: {},
  consecutiveRejects: 0,
  rejectionHistory: [],
  circuitBreakerTripped: false,
};

export interface CircuitBreakerResult {
  tripped: boolean;
  reason?: string;
  newConsecutiveRejects: number;
  newRejectionHistory: RejectionEntry[];
  newStatus: CircuitBreakerState;
}

/**
 * 评估断路器：累计拒绝计数和滑动窗口检测。
 * Evaluates the circuit breaker: counts consecutive and window-based rejections.
 *
 * - 批准/成功 → 重置连续计数
 * - 拒绝 → 连续计数 +1，检查是否触发断路器
 *
 * - Approval → resets consecutive counter
 * - Rejection → increments counter, checks trip conditions
 */
export function evaluateCircuitBreaker(
  consecutiveRejects: number,
  rejectionHistory: RejectionEntry[],
  config: CircuitBreakerConfig,
  isRejection: boolean,
  rejectionEntry?: RejectionEntry,
): CircuitBreakerResult {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  if (!isRejection) {
    // 批准：重置连续计数，清理旧历史 / Approval: reset consecutive count, prune old history
    return {
      tripped: false,
      newConsecutiveRejects: 0,
      newRejectionHistory: rejectionHistory.filter((r) => r.timestamp >= windowStart),
      newStatus: { status: 'closed' },
    };
  }

  // 拒绝：增加计数 / Rejection: increment counters
  const newConsecutive = consecutiveRejects + 1;
  const pruned = rejectionHistory.filter((r) => r.timestamp >= windowStart);
  const newHistory = rejectionEntry ? [...pruned, rejectionEntry] : pruned;
  // 总拒绝数 = 已剪裁的历史数量 + 当前这条 / Total = pruned count + current
  const totalInWindow = newHistory.length;

  // 条件 A：连续 N 次拒绝 / Condition A: N consecutive rejections
  if (newConsecutive >= config.maxRejections) {
    return {
      tripped: true,
      reason: `Circuit breaker tripped: ${newConsecutive} consecutive rejections (threshold: ${config.maxRejections})`,
      newConsecutiveRejects: newConsecutive,
      newRejectionHistory: newHistory,
      newStatus: { status: 'open' },
    };
  }

  // 条件 B：窗口内总计 N 次拒绝 / Condition B: total rejections in window
  if (totalInWindow >= config.maxTotalBlocks) {
    return {
      tripped: true,
      reason: `Circuit breaker tripped: ${totalInWindow} rejections within ${config.windowMs}ms (limit: ${config.maxTotalBlocks})`,
      newConsecutiveRejects: newConsecutive,
      newRejectionHistory: newHistory,
      newStatus: { status: 'open' },
    };
  }

  return {
    tripped: false,
    newConsecutiveRejects: newConsecutive,
    newRejectionHistory: newHistory,
    newStatus: { status: 'closed' },
  };
}
