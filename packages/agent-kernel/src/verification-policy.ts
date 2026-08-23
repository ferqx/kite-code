export type KernelVerificationMode = 'not_required' | 'best_effort' | 'required';

export interface KernelVerificationEffects {
  readonly filesystem: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
  readonly network: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
  readonly externalState: 'none' | 'read' | 'write' | 'destructive' | 'unknown';
}

export interface KernelVerificationPolicyFacts {
  readonly baseline?: KernelVerificationMode;
  readonly capabilityEffects?: KernelVerificationEffects;
  readonly skillMode?: KernelVerificationMode;
  readonly userMode?: KernelVerificationMode;
}

const VERIFICATION_STRENGTH_: Readonly<Record<KernelVerificationMode, number>> = Object.freeze({
  not_required: 0,
  best_effort: 1,
  required: 2,
});

export function kernelEffectsRequireVerification(effects: KernelVerificationEffects): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

/** Verification sources may only raise the deterministic requirement. */
export function resolveKernelVerificationMode(
  facts: KernelVerificationPolicyFacts,
): KernelVerificationMode {
  const modes: KernelVerificationMode[] = [facts.baseline ?? 'not_required'];
  if (facts.skillMode) modes.push(facts.skillMode);
  if (facts.userMode) modes.push(facts.userMode);
  if (facts.capabilityEffects && kernelEffectsRequireVerification(facts.capabilityEffects)) {
    modes.push('required');
  }
  return modes.reduce((strongest, mode) =>
    VERIFICATION_STRENGTH_[mode] > VERIFICATION_STRENGTH_[strongest] ? mode : strongest,
  );
}
