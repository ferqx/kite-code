import {
  type CapabilityApprovalV1,
  type CapabilityDescriptorV1,
  type CapabilityEffectLevelV1,
  type CapabilitySnapshotV1,
  type CompiledCapabilitySchemaV1,
  canonicalizeCapabilityArgumentsV1,
  compileCapabilitySchemaV1,
  createCapabilitySnapshotV1,
  descriptorRevisionV1,
  digestCapabilityValueV1,
  type EffectProfileV1,
  type JsonSchemaV1,
  validateCapabilityArgumentsV1,
} from '../skills/capability-domain';

export type CapabilityApproval = CapabilityApprovalV1;
export type CapabilityAvailability = CapabilityDescriptorV1['availability'];
export type CapabilityEffectLevel = CapabilityEffectLevelV1;
export type CapabilityDescriptor = CapabilityDescriptorV1;
export type CapabilitySnapshot = CapabilitySnapshotV1;
export type CompiledCapabilitySchema = CompiledCapabilitySchemaV1;
export type EffectProfile = EffectProfileV1;
export type JsonSchema = JsonSchemaV1;

export interface CapabilityFailure {
  kind: string;
  message: string;
  retryable: boolean;
  modelFixable: boolean;
  needsUserIntervention: boolean;
  terminatesTurn: boolean;
  journal: boolean;
  parseFailureCode?: string;
}

export interface CapabilityResult {
  status: 'success' | 'partial' | 'error' | 'cancelled' | 'unknown';
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  error?: CapabilityFailure;
  providerMeta?: Record<string, unknown>;
}

export const UNKNOWN_EXTERNAL_EFFECTS: EffectProfile = Object.freeze({
  filesystem: 'unknown',
  network: 'unknown',
  externalState: 'unknown',
});

export const compileCapabilitySchema = compileCapabilitySchemaV1;
export const canonicalizeCapabilityArguments = canonicalizeCapabilityArgumentsV1;
export const createSnapshot = createCapabilitySnapshotV1;
export const descriptorRevision = descriptorRevisionV1;
export const digestCapability = digestCapabilityValueV1;
export const validateCapabilityArguments = validateCapabilityArgumentsV1;

export function toolInvalidArgumentsFailure(message: string): CapabilityFailure {
  return {
    kind: 'tool_invalid_args',
    message,
    retryable: false,
    modelFixable: true,
    needsUserIntervention: false,
    terminatesTurn: false,
    journal: true,
  };
}

export function safeCapabilityMetadata(value: string, maximum = 96): string {
  const cleaned = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? ' '
      : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, Math.max(0, maximum)).join('');
}
