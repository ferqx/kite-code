import { createHash } from 'node:crypto';
import type { JsonValue, SuspendedSubagentSnapshot } from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';

/** Builtin-owned JSON boundary for durable continuation payloads. */
export function encodeSubagentContinuationSnapshot(
  snapshot: SuspendedSubagentSnapshot,
): SuspendedSubagentSnapshot {
  return cloneSnapshot(snapshot);
}

/** Decode to a mutation-isolated JSON value before the Core Model adapter rebuilds messages. */
export function decodeSubagentContinuationSnapshot(
  snapshot: SuspendedSubagentSnapshot,
): SuspendedSubagentSnapshot {
  return cloneSnapshot(snapshot);
}

/** Stable identity for one exact suspension in a child's continuation lineage. */
export function subagentContinuationCursorId(snapshot: SuspendedSubagentSnapshot): string {
  return `continuation-${digestCapabilityBindingValue({
    schema: 'kite.subagent-continuation-cursor.v1',
    subagentId: snapshot.subagentId,
    modelInvocationOrdinal: snapshot.modelInvocationOrdinal ?? 0,
    blockedToolCallId: snapshot.blockedTool.toolCallId,
    blockedRuntimeToolCallId: snapshot.blockedTool.runtimeToolCallId ?? null,
  })}`;
}

export function subagentTaskDigest(task: string): string {
  if (typeof task !== 'string' || task.length < 1 || task.length > 8_000) {
    throw new Error('Subagent task is outside the immutable Artifact boundary.');
  }
  return `sha256:${createHash('sha256').update(Buffer.from(task, 'utf8')).digest('hex')}`;
}

function cloneSnapshot(snapshot: SuspendedSubagentSnapshot): SuspendedSubagentSnapshot {
  const cloned = toJsonValue(snapshot, '$');
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('Subagent continuation must be a JSON object.');
  }
  return cloned as unknown as SuspendedSubagentSnapshot;
}

function toJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`Non-JSON number at ${path}`);
  }
  if (typeof value !== 'object') throw new Error(`Non-JSON value at ${path}`);
  if (seen.has(value)) throw new Error(`Circular value at ${path}`);
  if (value instanceof Set || value instanceof Map || value instanceof Date) {
    throw new Error(`Non-JSON value at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => toJsonValue(entry, `${path}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Non-JSON value at ${path}`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toJsonValue(entry, `${path}.${key}`, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}
