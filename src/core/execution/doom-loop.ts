import { createHash } from 'node:crypto';
import type { PendingToolRequest } from '../harness/tool-requests';

export interface DoomLoopCheck {
  blocked: boolean;
  reason?: string;
  fingerprint?: string;
  count?: number;
}

export interface DoomLoopTrackerEntry {
  count: number;
  lastSeenAt: number;
}

/**
 * 计算工具调用的指纹。对同一工具名 + 相同 args，产生相同指纹。
 * Computes a stable fingerprint for a tool call. Same toolName + same args → same fingerprint.
 */
export function buildToolFingerprint(request: PendingToolRequest): string {
  const args = request.args as unknown as Record<string, unknown>;
  const payload = JSON.stringify({
    tool: request.name,
    // 对 shell_execute 只取 command + cwd；对 write_file/edit_file 只取 path
    // For shell_execute, only command + cwd; for write_file/edit_file, only path
    cmd: request.name === 'shell_execute' ? args.command : undefined,
    cwd: request.name === 'shell_execute' ? args.cwd : undefined,
    path: request.name === 'write_file' || request.name === 'edit_file' ? args.path : undefined,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 检查是否为 doom-loop：同一工具调用在短时间内重复过多。
 * Checks if a tool call has been repeated within a short window (doom-loop detection).
 *
 * @param tracker - 当前的 doom-loop 追踪状态 / Current doom-loop tracking state
 * @param request - 待检查的工具请求 / The tool request to check
 * @param threshold - 重复次数阈值（默认 3）/ Repeat count threshold (default 3)
 * @param windowMs - 时间窗口（默认 60_000ms）/ Time window in ms (default 60_000)
 */
export function checkDoomLoop(
  tracker: Record<string, DoomLoopTrackerEntry>,
  request: PendingToolRequest,
  threshold: number = 3,
  windowMs: number = 60_000,
): DoomLoopCheck {
  const fp = buildToolFingerprint(request);
  const entry = tracker[fp];
  const now = Date.now();

  if (entry && now - entry.lastSeenAt <= windowMs) {
    const count = entry.count + 1;
    if (count >= threshold) {
      return {
        blocked: true,
        reason: `Doom loop detected: same ${request.name} call repeated ${count} times within ${windowMs}ms.`,
        fingerprint: fp,
        count,
      };
    }
    return { blocked: false, fingerprint: fp, count };
  }

  // First occurrence or outside window — reset
  return { blocked: false, fingerprint: fp, count: 1 };
}

/**
 * 更新 doom-loop 追踪器，记录本次工具调用。
 * Updates the doom-loop tracker with the current tool call.
 */
export function updateDoomLoopTracker(
  tracker: Record<string, DoomLoopTrackerEntry>,
  fingerprint: string,
): Record<string, DoomLoopTrackerEntry> {
  const now = Date.now();
  const next = { ...tracker };

  // 清理超过 120s 的旧条目 / Purge entries older than 120s
  for (const key of Object.keys(next)) {
    if (now - next[key]!.lastSeenAt > 120_000) {
      delete next[key];
    }
  }

  const existing = next[fingerprint];
  next[fingerprint] = {
    count: (existing?.count ?? 0) + 1,
    lastSeenAt: now,
  };
  return next;
}
