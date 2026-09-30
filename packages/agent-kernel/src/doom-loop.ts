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

/** Keep diagnostic identity sensitive to the complete invocation arguments. */
export function kernelToolDoomLoopFingerprint(request: KernelDoomLoopRequest): string {
  return sha256Hex(stableStringify({ tool: request.name, args: request.args }));
}

/** Evaluate a private fingerprint against immutable State 27 facts. */
export function kernelCheckDoomLoopFingerprint(
  tracker: Readonly<Record<string, KernelDoomLoopTrackerEntry>>,
  fingerprint: string,
  _threshold: number,
  windowMs: number,
  observedAt: number,
): KernelDoomLoopCheck {
  const entry = tracker[fingerprint];
  const elapsed = entry ? observedAt - entry.lastSeenAt : undefined;
  if (entry && elapsed !== undefined && elapsed >= 0 && elapsed <= windowMs) {
    return { blocked: false, fingerprint, count: entry.count };
  }
  return { blocked: false, fingerprint, count: 0 };
}

/** Pure State 27 tracker transition. Time is always supplied as an explicit fact. */
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
