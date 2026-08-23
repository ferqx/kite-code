import { sha256Hex } from './hash';

export interface KernelDoomLoopRequest {
  readonly name: string;
  readonly args: unknown;
}

export interface KernelDoomLoopTrackerEntry {
  readonly count: number;
  readonly lastSeenAt: number;
}

export interface KernelDoomLoopCheck {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly fingerprint: string;
  readonly count: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'undefined' : serialized;
}

/** Deterministically bind the State 25 repeat policy to the governed execution target. */
export function kernelToolDoomLoopFingerprint(request: KernelDoomLoopRequest): string {
  const record =
    request.args !== null && typeof request.args === 'object' && !Array.isArray(request.args)
      ? (request.args as Record<string, unknown>)
      : {};
  const identityArgs =
    request.name === 'shell_execute'
      ? { command: record.command, cwd: record.cwd }
      : request.name === 'write_file' || request.name === 'edit_file'
        ? { path: record.path }
        : request.args;
  return sha256Hex(stableStringify({ tool: request.name, args: identityArgs }));
}

/** Evaluate a private fingerprint against immutable State 25 facts. */
export function kernelCheckDoomLoopFingerprint(
  tracker: Readonly<Record<string, KernelDoomLoopTrackerEntry>>,
  fingerprint: string,
  threshold: number,
  windowMs: number,
  observedAt: number,
): KernelDoomLoopCheck {
  const entry = tracker[fingerprint];
  const elapsed = entry ? observedAt - entry.lastSeenAt : undefined;
  if (entry && elapsed !== undefined && elapsed >= 0 && elapsed <= windowMs) {
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

/** Pure State 25 tracker transition. Time is always supplied as an explicit fact. */
export function kernelUpdateDoomLoopTracker(
  tracker: Readonly<Record<string, KernelDoomLoopTrackerEntry>>,
  fingerprint: string,
  observedAt: number,
  windowMs = 60_000,
): Readonly<Record<string, KernelDoomLoopTrackerEntry>> {
  const next = { ...tracker };
  for (const [key, entry] of Object.entries(next)) {
    if (observedAt - entry.lastSeenAt > 120_000) delete next[key];
  }
  const existing = next[fingerprint];
  const elapsed = existing ? observedAt - existing.lastSeenAt : undefined;
  next[fingerprint] = {
    count:
      existing && elapsed !== undefined && elapsed >= 0 && elapsed <= windowMs
        ? existing.count + 1
        : 1,
    lastSeenAt: observedAt,
  };
  return next;
}
