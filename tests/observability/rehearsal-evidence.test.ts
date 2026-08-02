import { describe, expect, test } from 'bun:test';
import {
  adaptSyntheticRehearsalToReleaseEvidenceV1,
  buildSyntheticIncidentRehearsalV1,
  INCIDENT_REHEARSAL_SCENARIOS_V1,
  verifyIncidentRehearsalReportV1,
} from '../../scripts/operations/rehearsal-evidence';

describe('incident rehearsal evidence contract', () => {
  test('replays all required synthetic containment contracts without a production claim', () => {
    const report = buildSyntheticIncidentRehearsalV1();
    expect(report.scenarios.map((scenario) => scenario.scenario)).toEqual([
      ...INCIDENT_REHEARSAL_SCENARIOS_V1,
    ]);
    expect(report.scenarios.every((scenario) => scenario.rawContentCollected === false)).toBe(true);
    expect(report.operationsReady).toBe(false);
    expect(report.nonDistributable).toBe(true);
    verifyIncidentRehearsalReportV1(report);
    expect(adaptSyntheticRehearsalToReleaseEvidenceV1(report)).toMatchObject({
      gate: 'G4',
      status: 'not_run',
      reason: 'synthetic_contract_is_not_operations_evidence',
      nonDistributable: true,
    });
  });

  test('rejects tampered or incomplete reports', () => {
    const report = buildSyntheticIncidentRehearsalV1();
    expect(() =>
      verifyIncidentRehearsalReportV1({
        ...report,
        scenarios: report.scenarios.slice(1),
      }),
    ).toThrow('identity or canonical digest mismatch');
  });
});
