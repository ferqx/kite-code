import type { EffectProfile } from '@/protocol/capabilities';
import type { VerificationMode } from '@/protocol/verification';

const STRENGTH: Record<VerificationMode, number> = {
  not_required: 0,
  best_effort: 1,
  required: 2,
};

export interface VerificationPolicyInput {
  baseline?: VerificationMode;
  capabilityEffects?: EffectProfile;
  skillMode?: VerificationMode;
  userMode?: VerificationMode;
}

/** Verification sources may only raise the effective requirement. */
export function resolveVerificationMode(input: VerificationPolicyInput): VerificationMode {
  const modes: VerificationMode[] = [input.baseline ?? 'not_required'];
  if (input.skillMode) modes.push(input.skillMode);
  if (input.userMode) modes.push(input.userMode);
  if (input.capabilityEffects && requiresVerification(input.capabilityEffects)) {
    modes.push('required');
  }
  return modes.reduce((strongest, mode) =>
    STRENGTH[mode] > STRENGTH[strongest] ? mode : strongest,
  );
}

/** @qualification-surface-v1 {"sourceSurfaceId":"verification:policy","featureId":"VERIFICATION-POLICY_REQUIREMENT-001","domain":"verification","observableContract":"verification_completion","risk":"p0","riskRationale":"verification_bypass_risk","owner":"core-verification","entrypoints":["runtime"],"sourceKind":"contract","symbol":"requiresVerification","l0Binding":{"adapterId":"verification-policy-requirement-v1","assertionId":"l0.verification-policy.requirement-v1"}} */
export function requiresVerification(effects: EffectProfile): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}
