import { createHash } from 'node:crypto';
import type { CapabilityBindingV1 } from '@kite/runtime-spi';

export interface CreateCapabilityBindingInputV1 {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly inputSchema: unknown;
  readonly turnId: string;
}

/**
 * The one RMV1 binding constructor. Its canonicalization intentionally
 * preserves the State 25 digest produced by the legacy catalog helper.
 */
export function createCapabilityBindingV1(
  input: CreateCapabilityBindingInputV1,
): CapabilityBindingV1 {
  const schemaDigest = digestCapabilityBindingValueV1(input.inputSchema ?? {});
  return Object.freeze({
    bindingId: digestCapabilityBindingValueV1({
      capabilityId: input.capabilityId,
      revision: input.capabilityRevision,
      exposedToolName: input.exposedToolName,
      schemaDigest,
      turnId: input.turnId,
    }),
    capabilityId: input.capabilityId,
    capabilityRevision: input.capabilityRevision,
    exposedToolName: input.exposedToolName,
    schemaDigest,
    issuedForTurnId: input.turnId,
  });
}

export function digestCapabilityBindingValueV1(value: unknown): string {
  return createHash('sha256').update(stableBindingStringifyV1(value)).digest('hex');
}

function stableBindingStringifyV1(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableBindingStringifyV1).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableBindingStringifyV1(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
