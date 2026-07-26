/**
 * 会话级读取状态跟踪（ADR-0042 §1，ADR-0043 §3）。
 * Session-level read-state tracking (ADR-0042 §1, ADR-0043 §3).
 *
 * read_file / write_file / edit_file 成功后记录内容指纹；edit_file 的
 * "先读后改 / 过期拒绝" 前置校验（后续提交启用）据此判断模型是否持有
 * 最新内容。当前仅记录：记录行为本身不改变任何工具语义。
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
const MAX_TRACKED_SESSIONS = 256;

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
 * 取会话的 tracker（threadId 键；缺失时退回 workspace 键）。
 * 主会话与 subagent fork 共享同一 threadId 的 tracker，与 ADR-0042 §4
 * 原像的记录链口径一致。
 */
export function sessionReadTracker(sessionKey: string): SessionReadTracker {
  let tracker = trackers.get(sessionKey);
  if (!tracker) {
    if (trackers.size >= MAX_TRACKED_SESSIONS) {
      const oldest = trackers.keys().next();
      if (!oldest.done && oldest.value) trackers.delete(oldest.value);
    }
    tracker = new SessionReadTrackerImpl();
    trackers.set(sessionKey, tracker);
  }
  return tracker;
}

/** 内容指纹（sha256；调用方负责对换行正规化后的文本取哈希）。 */
export function fileContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
