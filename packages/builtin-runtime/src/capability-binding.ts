import { createHash } from 'node:crypto';
import type { CapabilityBinding } from '@kite/runtime-spi';

export interface CreateCapabilityBindingInput {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly inputSchema: unknown;
  readonly turnId: string;
}

/**
 * The one RM binding constructor. Its canonicalization intentionally
 * preserves the State 25 digest produced by the legacy catalog helper.
 */
export function createCapabilityBinding(input: CreateCapabilityBindingInput): CapabilityBinding {
  const schemaDigest = digestCapabilityBindingValue(input.inputSchema ?? {});
  return Object.freeze({
    bindingId: digestCapabilityBindingValue({
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

export function digestCapabilityBindingValue(value: unknown): string {
  return createHash('sha256').update(stableBindingStringify(value)).digest('hex');
}

function stableBindingStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableBindingStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableBindingStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
