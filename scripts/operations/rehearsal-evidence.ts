import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';

export const INCIDENT_REHEARSAL_SCENARIOS_ = Object.freeze([
  'capability_off',
  'cohort_zero',
  'artifact_rollback',
  'provider_credential_rotation',
  'telemetry_exporter_failure',
  'sandbox_worktree_g0',
  'compaction_critical',
  'mandatory_admin_policy_unavailable',
] as const);

export type IncidentRehearsalScenario = (typeof INCIDENT_REHEARSAL_SCENARIOS_)[number];

export interface IncidentRehearsalReport {
  schema: 'IncidentRehearsalReport';
  fixtureClass: 'synthetic_contract_only';
  generatedAt: '1970-01-01T00:00:00.000Z';
  operator: 'github:@ferqx';
  backup: 'none_single_maintainer';
  nonDistributable: true;
  operationsReady: false;
  status: 'contract_replay_passed';
  scenarios: readonly {
    scenario: IncidentRehearsalScenario;
    outcome: 'passed_contract';
    actionReceipt: 'synthetic_no_external_effect';
    staleProcessOrSessionCount: 0;
    rawContentCollected: false;
  }[];
  reportDigest: `sha256:${string}`;
}

export interface OperationsEvidenceAdapter {
  schema: 'OperationsEvidenceAdapter';
  gate: 'G4';
  kind: 'incident_rehearsal';
  status: 'not_run';
  reason: 'synthetic_contract_is_not_operations_evidence';
  reportDigest: `sha256:${string}`;
  nonDistributable: true;
}

function reportWithoutDigest(): Omit<IncidentRehearsalReport, 'reportDigest'> {
  return {
    schema: 'IncidentRehearsalReport',
    fixtureClass: 'synthetic_contract_only',
    generatedAt: '1970-01-01T00:00:00.000Z',
    operator: 'github:@ferqx',
    backup: 'none_single_maintainer',
    nonDistributable: true,
    operationsReady: false,
    status: 'contract_replay_passed',
    scenarios: INCIDENT_REHEARSAL_SCENARIOS_.map((scenario) => ({
      scenario,
      outcome: 'passed_contract' as const,
      actionReceipt: 'synthetic_no_external_effect' as const,
      staleProcessOrSessionCount: 0 as const,
      rawContentCollected: false as const,
    })),
  };
}

export function buildSyntheticIncidentRehearsal(): IncidentRehearsalReport {
  const report = reportWithoutDigest();
  return {
    ...report,
    reportDigest: sha256DomainSeparated(
      'kite.operations.rehearsal-report.v1',
      canonicalJson(report),
    ),
  };
}

export function verifyIncidentRehearsalReport(report: IncidentRehearsalReport): void {
  const expected = buildSyntheticIncidentRehearsal();
  if (canonicalJson(report) !== canonicalJson(expected)) {
    throw new Error('Incident rehearsal report identity or canonical digest mismatch.');
  }
}

export function adaptSyntheticRehearsalToReleaseEvidence(
  report: IncidentRehearsalReport,
): OperationsEvidenceAdapter {
  verifyIncidentRehearsalReport(report);
  return {
    schema: 'OperationsEvidenceAdapter',
    gate: 'G4',
    kind: 'incident_rehearsal',
    status: 'not_run',
    reason: 'synthetic_contract_is_not_operations_evidence',
    reportDigest: report.reportDigest,
    nonDistributable: true,
  };
}
