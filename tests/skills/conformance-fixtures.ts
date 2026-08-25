import type { SkillWorkflowContract } from '@kite/builtin-runtime/skills';
import type { CapabilityDescriptor, EffectProfile } from '@kite/runtime-contract';

const EFFECTFUL = new Set<EffectProfile[keyof EffectProfile]>(['write', 'destructive', 'unknown']);

export type SkillEffectClass = 'readonly' | 'effectful';

export function classifySkillEffects(input: {
  contract: Pick<
    SkillWorkflowContract,
    'effectiveEffects' | 'effectiveMinimumApproval' | 'effectiveCapabilityCeiling'
  >;
  dependencies: readonly Pick<CapabilityDescriptor, 'effectiveEffects'>[];
}): SkillEffectClass {
  const effects = [
    ...Object.values(input.contract.effectiveEffects),
    ...input.dependencies.flatMap((dependency) => Object.values(dependency.effectiveEffects)),
  ];
  return effects.some((effect) => EFFECTFUL.has(effect)) ? 'effectful' : 'readonly';
}

export function evaluateSkillClassAdmission(input: {
  effectClass: SkillEffectClass;
  source: 'builtin' | 'admin' | 'project' | 'user';
  adminAllowlisted: boolean;
  workspaceTrusted: boolean;
  workflowEnabled: boolean;
  activationEnabled: boolean;
  verificationMode: SkillWorkflowContract['verification']['mode'];
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
}): Readonly<{ status: 'admitted' | 'blocked' | 'off'; reasonCodes: string[] }> {
  const reasons = new Set<string>();
  if (!input.workflowEnabled) reasons.add('skill_workflow_flag_off');
  if (!input.activationEnabled) reasons.add('skill_activation_flag_off');
  if (!input.adminAllowlisted && input.source !== 'builtin') reasons.add('source_not_allowlisted');
  if (input.source === 'project' && !input.workspaceTrusted) reasons.add('workspace_untrusted');
  if (input.effectClass === 'effectful' && input.verificationMode !== 'required')
    reasons.add('verification_not_required');
  if (input.formalTaskEvidence !== 'passed') reasons.add('formal_task_evidence_not_passed');
  return Object.freeze({
    status: reasons.size ? 'blocked' : 'admitted',
    reasonCodes: [...reasons].sort(),
  });
}

export function qualifySkillContractOnly(input: {
  effectClass: SkillEffectClass;
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
  dependencyRevisionMatches: boolean;
  maliciousInstructionDetected: boolean;
  invalidShadowingDetected: boolean;
  referenceBoundaryViolation: boolean;
  duplicateSideEffect: boolean;
  falseCompletion: boolean;
}): Readonly<{
  executionClass: 'local_contract_only';
  status: 'blocked' | 'off';
  reasonCodes: string[];
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
}> {
  const reasons = new Set<string>();
  if (input.formalTaskEvidence !== 'passed') reasons.add('formal_task_evidence_not_passed');
  if (!input.dependencyRevisionMatches) reasons.add('dependency_revision_drift');
  if (input.maliciousInstructionDetected) reasons.add('malicious_instruction');
  if (input.invalidShadowingDetected) reasons.add('invalid_shadowing');
  if (input.referenceBoundaryViolation) reasons.add('reference_boundary_violation');
  if (input.duplicateSideEffect) reasons.add('duplicate_side_effect');
  if (input.falseCompletion) reasons.add('false_completion');
  const hardFailure = [
    !input.dependencyRevisionMatches,
    input.maliciousInstructionDetected,
    input.invalidShadowingDetected,
    input.referenceBoundaryViolation,
    input.duplicateSideEffect,
    input.falseCompletion,
  ].some(Boolean);
  return Object.freeze({
    executionClass: 'local_contract_only',
    status: hardFailure ? 'off' : 'blocked',
    reasonCodes: [...reasons].sort(),
    formalTaskEvidence: input.formalTaskEvidence,
  });
}
