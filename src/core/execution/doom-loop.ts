import { createHash } from 'node:crypto';
import { stableStringify } from '@/core/harness/tool-policy';

interface FingerprintableToolRequest {
  name: string;
  args: unknown;
}

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
export function buildToolFingerprint(request: FingerprintableToolRequest): string {
  const args = request.args as unknown as Record<string, unknown>;
  const identityArgs =
    request.name === 'shell_execute'
      ? { command: args.command, cwd: args.cwd }
      : request.name === 'write_file' || request.name === 'edit_file'
        ? { path: args.path }
        : args;
  const payload = stableStringify({
    tool: request.name,
    // Shell and file mutations use their governed execution target. Other tools
    // retain their complete canonical arguments to avoid cross-request collisions.
    args: identityArgs,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 检查是否为 doom-loop：同一工具调用在短时间内重复过多。
 * Checks if a tool call has been repeated within a short window (doom-loop detection).
 *
 * The current request is recorded by the reducer before this check runs, so
 * `count` is the durable observed count rather than a speculative increment.
 *
 * @param tracker - 当前的 doom-loop 追踪状态 / Current doom-loop tracking state
 * @param request - 待检查的工具请求 / The tool request to check
 * @param threshold - 重复次数阈值（默认 3）/ Repeat count threshold (default 3)
 * @param windowMs - 时间窗口（默认 60_000ms）/ Time window in ms (default 60_000)
 */
export function checkDoomLoop(
  tracker: Record<string, DoomLoopTrackerEntry>,
  request: FingerprintableToolRequest,
  threshold: number = 3,
  windowMs: number = 60_000,
  now: number = Date.now(),
): DoomLoopCheck {
  const fp = buildToolFingerprint(request);
  const entry = tracker[fp];

  const elapsed = entry ? now - entry.lastSeenAt : undefined;
  if (entry && elapsed != null && elapsed >= 0 && elapsed <= windowMs) {
    const count = entry.count;
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

  // No durable occurrence exists in the active window.
  return { blocked: false, fingerprint: fp, count: 0 };
}

/** Check a precomputed private fingerprint without reconstructing persisted arguments. */
export function checkDoomLoopFingerprint(
  tracker: Record<string, DoomLoopTrackerEntry>,
  fingerprint: string,
  threshold: number = 3,
  windowMs: number = 60_000,
  now: number = Date.now(),
): DoomLoopCheck {
  const entry = tracker[fingerprint];
  const elapsed = entry ? now - entry.lastSeenAt : undefined;
  if (entry && elapsed != null && elapsed >= 0 && elapsed <= windowMs) {
    return entry.count >= threshold
      ? {
          blocked: true,
          reason: `Doom loop detected: same private call repeated ${entry.count} times within ${windowMs}ms.`,
          fingerprint,
          count: entry.count,
        }
      : { blocked: false, fingerprint, count: entry.count };
  }
  return { blocked: false, fingerprint, count: 0 };
}

/**
 * 更新 doom-loop 追踪器，记录本次工具调用。
 * Updates the doom-loop tracker with the current tool call.
 */
export function updateDoomLoopTracker(
  tracker: Record<string, DoomLoopTrackerEntry>,
  fingerprint: string,
  now: number = Date.now(),
  windowMs: number = 60_000,
): Record<string, DoomLoopTrackerEntry> {
  const next = { ...tracker };

  // 清理超过 120s 的旧条目 / Purge entries older than 120s
  for (const key of Object.keys(next)) {
    if (now - next[key]!.lastSeenAt > 120_000) {
      delete next[key];
    }
  }

  const existing = next[fingerprint];
  const elapsed = existing ? now - existing.lastSeenAt : undefined;
  next[fingerprint] = {
    count:
      existing && elapsed != null && elapsed >= 0 && elapsed <= windowMs ? existing.count + 1 : 1,
    lastSeenAt: now,
  };
  return next;
}
