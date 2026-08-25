import {
  adaptSyntheticRehearsalToReleaseEvidence,
  buildSyntheticIncidentRehearsal,
  verifyIncidentRehearsalReport,
} from './rehearsal-evidence';

export function runSyntheticIncidentRehearsal() {
  const report = buildSyntheticIncidentRehearsal();
  verifyIncidentRehearsalReport(report);
  return {
    report,
    evidence: adaptSyntheticRehearsalToReleaseEvidence(report),
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(runSyntheticIncidentRehearsal(), null, 2));
}
