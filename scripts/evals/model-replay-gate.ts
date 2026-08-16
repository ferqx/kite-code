import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readReplayPilotCatalogV1,
  runDeterministicModelReplayPilotV1,
} from '../../tests/evals/agent-tasks/replay-pilot';
import {
  readReplayRiskCatalogV1,
  runModelReplayRiskMatrixV1,
} from '../../tests/evals/agent-tasks/replay-risk-matrix';
import {
  MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1,
  MODEL_REPLAY_REQUIRED_CASE_IDS_V1,
  MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1,
  parseModelReplayGateManifestV1,
  verifyModelReplayGateQualificationFilesV1,
} from './contracts/model-replay-gate';
import { MODEL_REPLAY_PILOT_EXPECTED_REPORT_DIGEST_V1 } from './contracts/model-replay-pilot';

export interface ModelReplayGateEvidenceV1 {
  schema: 'ModelReplayGateEvidenceV1';
  status: 'passed';
  suiteId: 'model-replay-required-suite-v1';
  suiteRevision: 1;
  manifestDigest: typeof MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1;
  caseCount: 6;
  keyless: true;
  providerTransportAttempts: 0;
  contentLogged: false;
}

export async function runRequiredModelReplayGateV1(input?: {
  repositoryRoot?: string;
}): Promise<ModelReplayGateEvidenceV1> {
  const repositoryRoot = input?.repositoryRoot ?? fileURLToPath(new URL('../../', import.meta.url));
  const manifest = parseModelReplayGateManifestV1(
    readFileSync(new URL('./manifests/model-replay-gate-v1.json', import.meta.url)),
  );
  verifyModelReplayGateQualificationFilesV1({ manifest, repositoryRoot });

  const pilotCatalog = readReplayPilotCatalogV1().catalog;
  const riskCatalog = readReplayRiskCatalogV1().catalog;
  assertRouteBinding(manifest.bindings.routes[0], pilotCatalog.records);
  assertRouteBinding(manifest.bindings.routes[1], riskCatalog.records);

  const [pilotAb, pilotBa, risk] = await Promise.all([
    runDeterministicModelReplayPilotV1({ childSchedule: 'ab' }),
    runDeterministicModelReplayPilotV1({ childSchedule: 'ba' }),
    runModelReplayRiskMatrixV1(),
  ]);
  if (
    pilotAb.canonicalDigest !== MODEL_REPLAY_PILOT_EXPECTED_REPORT_DIGEST_V1 ||
    pilotBa.canonicalDigest !== pilotAb.canonicalDigest ||
    risk.canonicalDigest !== MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1 ||
    pilotAb.privacy.apiKeyRead ||
    pilotAb.privacy.providerTransportAttempts !== 0 ||
    pilotAb.privacy.networkAttempts !== 0 ||
    risk.apiKeyRead ||
    risk.providerTransportAttempts !== 0 ||
    !pilotAb.actorCursor.allRecordsConsumed ||
    !risk.allRecordsConsumed
  ) {
    throw new Error('MODEL_REPLAY_REQUIRED_GATE_EVIDENCE_INVALID');
  }

  return Object.freeze({
    schema: 'ModelReplayGateEvidenceV1',
    status: 'passed',
    suiteId: manifest.suite.suiteId,
    suiteRevision: manifest.suite.suiteRevision,
    manifestDigest: MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1,
    caseCount: MODEL_REPLAY_REQUIRED_CASE_IDS_V1.length as 6,
    keyless: true,
    providerTransportAttempts: 0,
    contentLogged: false,
  });
}

function assertRouteBinding(
  binding:
    | {
        routeFingerprint: string;
        adapterKind: string;
        adapterProtocolVersion: string;
        ownerFingerprint: string;
      }
    | undefined,
  records: ReadonlyArray<{
    routeFingerprint: string;
    adapterProtocolVersion: string;
    replayOwner: {
      adapterKind: string;
      adapterProtocolVersion: string;
      ownerFingerprint: string;
    };
  }>,
): void {
  if (
    !binding ||
    records.length === 0 ||
    records.some(
      (record) =>
        record.routeFingerprint !== binding.routeFingerprint ||
        record.adapterProtocolVersion !== binding.adapterProtocolVersion ||
        record.replayOwner.adapterKind !== binding.adapterKind ||
        record.replayOwner.adapterProtocolVersion !== binding.adapterProtocolVersion ||
        record.replayOwner.ownerFingerprint !== binding.ownerFingerprint,
    )
  ) {
    throw new Error('MODEL_REPLAY_REQUIRED_GATE_ROUTE_INVALID');
  }
}

if (import.meta.main) {
  try {
    const report = await runRequiredModelReplayGateV1();
    console.log(
      JSON.stringify({
        schema: report.schema,
        status: report.status,
        case: `${report.suiteId}@${report.suiteRevision}`,
        reason: 'approved_suite_evidence_passed',
        contentLogged: false,
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        schema: 'ModelReplayGateEvidenceV1',
        status: 'failed',
        case: 'model-replay-required-suite-v1@1',
        reason: 'model_replay_required_gate_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}
