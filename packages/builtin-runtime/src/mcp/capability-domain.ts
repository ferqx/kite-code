import {
  type CapabilityDescriptor,
  createCapabilitySnapshot,
  digestCapabilityValue,
  type EffectProfile,
} from '../skills/capability-domain';

export type {
  CapabilityApproval,
  CapabilityDescriptor,
  CapabilityEffectLevel,
  CapabilitySnapshot,
  CompiledCapabilitySchema,
  EffectProfile,
  JsonSchema,
} from '../skills/capability-domain';
export {
  canonicalizeCapabilityArguments,
  compileCapabilitySchema,
  descriptorRevision,
  validateCapabilityArguments,
} from '../skills/capability-domain';
export type CapabilityAvailability = CapabilityDescriptor['availability'];

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

export const createSnapshot = createCapabilitySnapshot;
export const digestCapability = digestCapabilityValue;

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
