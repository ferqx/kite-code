export type KernelVerificationModeV1 = 'not_required' | 'best_effort' | 'required';

export interface KernelVerificationEffectsV1 {
  readonly filesystem: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
  readonly network: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
  readonly externalState: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
}

export interface KernelVerificationPolicyFactsV1 {
  readonly baseline?: KernelVerificationModeV1;
  readonly capabilityEffects?: KernelVerificationEffectsV1;
  readonly skillMode?: KernelVerificationModeV1;
  readonly userMode?: KernelVerificationModeV1;
}

const VERIFICATION_STRENGTH_V1: Readonly<Record<KernelVerificationModeV1, number>> = Object.freeze({
  not_required: 0,
  best_effort: 1,
  required: 2,
});

export function kernelEffectsRequireVerificationV1(effects: KernelVerificationEffectsV1): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

/** Verification sources may only raise the deterministic requirement. */
export function resolveKernelVerificationModeV1(
  facts: KernelVerificationPolicyFactsV1,
): KernelVerificationModeV1 {
  const modes: KernelVerificationModeV1[] = [facts.baseline ?? 'not_required'];
  if (facts.skillMode) modes.push(facts.skillMode);
  if (facts.userMode) modes.push(facts.userMode);
  if (facts.capabilityEffects && kernelEffectsRequireVerificationV1(facts.capabilityEffects)) {
    modes.push('required');
  }
  return modes.reduce((strongest, mode) =>
    VERIFICATION_STRENGTH_V1[mode] > VERIFICATION_STRENGTH_V1[strongest] ? mode : strongest,
  );
}
