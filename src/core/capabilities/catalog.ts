import { createHash } from 'node:crypto';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  CapabilitySnapshot,
  EffectProfile,
} from '@/protocol/capabilities';

export const UNKNOWN_EXTERNAL_EFFECTS: EffectProfile = Object.freeze({
  filesystem: 'unknown',
  network: 'unknown',
  externalState: 'unknown',
});

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestCapability(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function descriptorRevision(input: Omit<CapabilityDescriptor, 'revision'>): string {
  return digestCapability(input);
}

/** @qualification-surface-v1 {"sourceSurfaceId":"capability-catalog:snapshot","featureId":"CAPABILITY-CATALOG_SNAPSHOT-001","domain":"runtime","observableContract":"capability_catalog_protocol","risk":"p0","riskRationale":"governed_runtime_boundary","owner":"core-capabilities","entrypoints":["runtime"],"sourceKind":"contract","symbol":"createSnapshot"} */
export function createSnapshot(descriptors: CapabilityDescriptor[]): CapabilitySnapshot {
  const ordered = [...descriptors].sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
  return {
    revision: digestCapability(
      ordered.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
      })),
    ),
    descriptors: ordered,
  };
}

/** @qualification-surface-v1 {"sourceSurfaceId":"capability-catalog:binding","featureId":"CAPABILITY-CATALOG_BINDING-001","domain":"runtime","observableContract":"capability_catalog_protocol","risk":"p0","riskRationale":"governed_runtime_boundary","owner":"core-capabilities","entrypoints":["runtime"],"sourceKind":"contract","symbol":"createBinding","l0Binding":{"adapterId":"capability-catalog-binding-v1","assertionId":"l0.capability-catalog.binding-v1"}} */
export function createBinding(input: {
  descriptor: CapabilityDescriptor;
  exposedToolName: string;
  turnId: string;
}): CapabilityBinding {
  const schemaDigest = digestCapability(input.descriptor.inputSchema ?? {});
  return {
    bindingId: digestCapability({
      capabilityId: input.descriptor.capabilityId,
      revision: input.descriptor.revision,
      exposedToolName: input.exposedToolName,
      schemaDigest,
      turnId: input.turnId,
    }),
    capabilityId: input.descriptor.capabilityId,
    capabilityRevision: input.descriptor.revision,
    exposedToolName: input.exposedToolName,
    schemaDigest,
    issuedForTurnId: input.turnId,
  };
}
