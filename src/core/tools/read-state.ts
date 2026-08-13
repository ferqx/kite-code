/**
 * Actor-scoped read-state tracking within a session (ADR-0042 §1, ADR-0043 §3).
 *
 * read_file / write_file / edit_file 成功后记录内容指纹；edit_file 的
 * "先读后改 / 过期拒绝" 前置校验据此判断当前 actor 是否持有
 * 最新内容。Parent 使用稳定的 session scope；每个 subagent
 * 使用其稳定 id，防止 parent/child/sibling 之间共享 freshness。
 */
import { createHash } from 'node:crypto';

export type ReadStateCheck = 'fresh' | 'stale' | 'not_read';

export interface SessionReadTracker {
  /** 记录一次成功的读/写指纹（Map 插入序 = 访问时序）。 */
  record(path: string, contentHash: string): void;
  /**
   * 对照当前内容指纹：
   * - 无记录 → not_read
   * - 有记录但当前不可读（null）或指纹不一致 → stale
   * - 指纹一致 → fresh
   */
  check(path: string, currentContentHash: string | null): ReadStateCheck;
  readonly size: number;
}

const MAX_TRACKED_FILES = 10000;
const MAX_TRACKED_ACTOR_SCOPES = 256;

class SessionReadTrackerImpl implements SessionReadTracker {
  readonly #stamps = new Map<string, string>();

  record(path: string, contentHash: string): void {
    if (this.#stamps.size >= MAX_TRACKED_FILES && !this.#stamps.has(path)) {
      // 容量上限：丢弃最旧的一半（Map 保持插入序）。
      // Cap reached: evict the oldest half (Map keeps insertion order).
      let dropped = 0;
      for (const key of this.#stamps.keys()) {
        if (dropped++ >= MAX_TRACKED_FILES / 2) break;
        this.#stamps.delete(key);
      }
    }
    this.#stamps.delete(path); // 刷新访问时序 / refresh recency
    this.#stamps.set(path, contentHash);
  }

  check(path: string, currentContentHash: string | null): ReadStateCheck {
    const recorded = this.#stamps.get(path);
    if (recorded === undefined) return 'not_read';
    if (currentContentHash === null) return 'stale';
    return recorded === currentContentHash ? 'fresh' : 'stale';
  }

  get size(): number {
    return this.#stamps.size;
  }
}

const trackers = new Map<string, SessionReadTracker>();

/**
 * 取 actor 的 tracker。actorId 缺失时使用稳定的 parent/session scope；
 * 存在时在 session 内命名空间化，避免 subagent 与 parent 或 sibling 共享读取状态。
 * Tracker 仅存内存：进程重启后未恢复的读取状态会 fail closed 为 not_read。
 */
export function sessionReadTracker(sessionKey: string, actorId?: string): SessionReadTracker {
  const scopeKey = JSON.stringify(
    actorId ? ['actor-read-state-v1', sessionKey, actorId] : ['parent-read-state-v1', sessionKey],
  );
  let tracker = trackers.get(scopeKey);
  if (!tracker) {
    if (trackers.size >= MAX_TRACKED_ACTOR_SCOPES) {
      const oldest = trackers.keys().next();
      if (!oldest.done && oldest.value) trackers.delete(oldest.value);
    }
    tracker = new SessionReadTrackerImpl();
    trackers.set(scopeKey, tracker);
  }
  return tracker;
}

/** 内容指纹（sha256；调用方负责对换行正规化后的文本取哈希）。 */
export function fileContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
