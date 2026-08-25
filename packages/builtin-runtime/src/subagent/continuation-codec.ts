import { createHash } from 'node:crypto';
import type {
  JsonValue,
  SubagentApprovalFacts,
  SuspendedSubagentSnapshot,
} from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';

const MAX_APPROVAL_FACT_IDENTITY_LENGTH = 256;
const MAX_APPROVAL_FACT_COUNTER = 0x7fff_ffff;

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
  if ('approvalFacts' in cloned) {
    const approvalFacts = decodeSubagentApprovalFacts(
      (cloned as Record<string, unknown>).approvalFacts,
    );
    if (!approvalFacts) {
      throw new Error('Subagent continuation approval facts are malformed.');
    }
    (cloned as Record<string, unknown>).approvalFacts = approvalFacts;
  }
  return cloned as unknown as SuspendedSubagentSnapshot;
}

/**
 * Decode the optional approval facts at the Builtin-owned JSON boundary.
 * Unknown keys, unbounded identities, and non-canonical counters fail closed
 * before an artifact can be published or consumed.
 */
function decodeSubagentApprovalFacts(value: unknown): SubagentApprovalFacts | undefined {
  if (!plainRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  const required = [
    'bindingDigest',
    'childToolCallId',
    'generation',
    'parentToolCallId',
    'route',
    'sequence',
  ];
  const optional = ['runtimeToolCallId'];
  const requiredKeys = required.slice().sort();
  const optionalKeys = [...required, ...optional].sort();
  if (keys.join(',') !== requiredKeys.join(',') && keys.join(',') !== optionalKeys.join(',')) {
    return undefined;
  }
  if (
    (value.route !== 'auto_review' && value.route !== 'user') ||
    !boundedApprovalIdentity(value.bindingDigest) ||
    !boundedApprovalIdentity(value.parentToolCallId) ||
    !boundedApprovalIdentity(value.childToolCallId) ||
    !boundedApprovalCounter(value.generation) ||
    !boundedApprovalCounter(value.sequence) ||
    (value.runtimeToolCallId !== undefined && !boundedApprovalIdentity(value.runtimeToolCallId))
  ) {
    return undefined;
  }
  return Object.freeze({
    route: value.route,
    generation: value.generation,
    sequence: value.sequence,
    bindingDigest: value.bindingDigest,
    parentToolCallId: value.parentToolCallId,
    childToolCallId: value.childToolCallId,
    ...(value.runtimeToolCallId === undefined
      ? {}
      : { runtimeToolCallId: value.runtimeToolCallId }),
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedApprovalIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_APPROVAL_FACT_IDENTITY_LENGTH
  );
}

function boundedApprovalCounter(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_APPROVAL_FACT_COUNTER
  );
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
