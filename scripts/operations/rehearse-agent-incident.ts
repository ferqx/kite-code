import {
  adaptSyntheticRehearsalToReleaseEvidenceV1,
  buildSyntheticIncidentRehearsalV1,
  verifyIncidentRehearsalReportV1,
} from './rehearsal-evidence';

export function runSyntheticIncidentRehearsalV1() {
  const report = buildSyntheticIncidentRehearsalV1();
  verifyIncidentRehearsalReportV1(report);
  return {
    report,
    evidence: adaptSyntheticRehearsalToReleaseEvidenceV1(report),
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(runSyntheticIncidentRehearsalV1(), null, 2));
}
