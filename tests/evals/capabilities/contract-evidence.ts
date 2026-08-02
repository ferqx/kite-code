import {
  type McpWriteRouteContractV1,
  qualifyMcpWriteRouteV1,
} from '../../mcp/write-contract-fixtures';
import {
  qualifySkillContractOnlyV1,
  type SkillEffectClassV1,
} from '../../skills/conformance-fixtures';

export function buildMcpWriteContractEvidenceV1(input: {
  route?: McpWriteRouteContractV1;
  observedRouteDigest?: string;
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
  duplicateSideEffects: number;
  unauthorizedSideEffects: number;
  dataBoundaryViolations: number;
  now: Date;
}) {
  const qualification = qualifyMcpWriteRouteV1(input);
  return Object.freeze({
    schemaVersion: 1 as const,
    capability: 'mcp_write' as const,
    executionClass: 'local_contract_only' as const,
    productionRouteConfigured: Boolean(input.route),
    formalTaskEvidence: input.formalTaskEvidence,
    status: qualification.status === 'qualified' ? ('blocked' as const) : qualification.status,
    reasonCodes: [
      ...(qualification.status === 'qualified' ? ['contract_only_cannot_qualify'] : []),
      ...qualification.reasonCodes,
    ].sort(),
    maturity: 'not_observed' as const,
    milestone: 'not_produced' as const,
  });
}

export function buildSkillContractEvidenceV1(input: {
  capability: 'skills_readonly' | 'skills_effectful';
  effectClass: SkillEffectClassV1;
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
  dependencyRevisionMatches: boolean;
  maliciousInstructionDetected: boolean;
  invalidShadowingDetected: boolean;
  referenceBoundaryViolation: boolean;
  duplicateSideEffect: boolean;
  falseCompletion: boolean;
}) {
  const qualification = qualifySkillContractOnlyV1(input);
  return Object.freeze({
    schemaVersion: 1 as const,
    capability: input.capability,
    ...qualification,
    maturity: 'not_observed' as const,
    milestone: 'not_produced' as const,
  });
}
