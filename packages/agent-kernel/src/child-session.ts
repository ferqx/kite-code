import { sha256Hex } from './hash';
import type { ResourceUsage } from './state';

/** Exact private task-ref equality independent of JSON object insertion order. */
export function sameChildTaskArtifactRef(left: unknown, right: unknown): boolean {
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = ['artifactId', 'byteLength', 'integrityIdentifier', 'kind'];
  return (
    Object.keys(a).sort().join(',') === keys.join(',') &&
    Object.keys(b).sort().join(',') === keys.join(',') &&
    a.artifactId === b.artifactId &&
    a.byteLength === b.byteLength &&
    a.integrityIdentifier === b.integrityIdentifier &&
    a.kind === b.kind &&
    a.kind === 'subagent_task'
  );
}

export function childDelegatedUpperBoundDigest(usage: ResourceUsage): `sha256:${string}` {
  if (usage.source !== 'versioned_upper_bound')
    throw new Error('Child delegation requires a bounded usage estimate.');
  return `sha256:${sha256Hex(JSON.stringify(usage))}`;
}

/** Stable across an exact Tool attempt replay; no Provider or random identity enters it. */
export function childThreadIdForToolAttempt(input: {
  parentSessionId: string;
  parentInvocationId: string;
  parentToolCallId: string;
  attempt: number;
}): string {
  if (
    !input.parentSessionId ||
    !input.parentInvocationId ||
    !input.parentToolCallId ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1
  )
    throw new Error('Child Session Tool attempt identity is invalid.');
  return `child_${sha256Hex(
    JSON.stringify([
      'kite.child-session.v1',
      input.parentSessionId,
      input.parentInvocationId,
      input.parentToolCallId,
      input.attempt,
    ]),
  )}`;
}
