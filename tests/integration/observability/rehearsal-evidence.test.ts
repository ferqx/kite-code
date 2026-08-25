import { describe, expect, test } from 'bun:test';
import {
  adaptSyntheticRehearsalToReleaseEvidence,
  buildSyntheticIncidentRehearsal,
  INCIDENT_REHEARSAL_SCENARIOS_,
  verifyIncidentRehearsalReport,
} from '../../../scripts/operations/rehearsal-evidence';

describe('incident rehearsal evidence contract', () => {
  test('replays all required synthetic containment contracts without a production claim', () => {
    const report = buildSyntheticIncidentRehearsal();
    expect(report.scenarios.map((scenario) => scenario.scenario)).toEqual([
      ...INCIDENT_REHEARSAL_SCENARIOS_,
    ]);
    expect(report.scenarios.every((scenario) => scenario.rawContentCollected === false)).toBe(true);
    expect(report.operationsReady).toBe(false);
    expect(report.nonDistributable).toBe(true);
    verifyIncidentRehearsalReport(report);
    expect(adaptSyntheticRehearsalToReleaseEvidence(report)).toMatchObject({
      gate: 'G4',
      status: 'not_run',
      reason: 'synthetic_contract_is_not_operations_evidence',
      nonDistributable: true,
    });
  });

  test('rejects tampered or incomplete reports', () => {
    const report = buildSyntheticIncidentRehearsal();
    expect(() =>
      verifyIncidentRehearsalReport({
        ...report,
        scenarios: report.scenarios.slice(1),
      }),
    ).toThrow('identity or canonical digest mismatch');
  });
});
