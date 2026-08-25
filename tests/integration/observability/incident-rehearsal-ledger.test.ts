import { describe, expect, test } from 'bun:test';
import {
  buildIncidentRehearsalReceipt,
  computeIncidentRehearsalBundleDigest,
  computeIncidentRehearsalLedgerDigest,
  verifyIncidentRehearsalEvidence,
} from '../../../scripts/operations/incident-rehearsal-ledger';
import { INCIDENT_REHEARSAL_SCENARIOS_ } from '../../../scripts/operations/rehearsal-evidence';
import { canonicalJson, sha256DomainSeparated } from '../../../scripts/release/canonical-json';

const digest = (label: string): `sha256:${string}` =>
  sha256DomainSeparated('kite.operations.incident-rehearsal-test.v1', label);
const source = {
  schema: 'IncidentRehearsalSource',
  repository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  headSha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  workflowPath: '.github/workflows/incident-rehearsal.yml',
  workflowRef: 'ferqx/kite-code/.github/workflows/incident-rehearsal.yml@refs/heads/main',
  workflowSha: 'a'.repeat(40),
  runId: '123',
  runAttempt: 1,
  jobName: 'incident-rehearsal',
  artifactId: '456',
  artifactName: 'incident-rehearsal-123',
  startedAt: '2026-08-03T00:00:00.000Z',
  endedAt: '2026-08-03T00:10:00.000Z',
} as const;
const artifactIdentity = {
  canonicalRepository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  commit: 'a'.repeat(40),
  payloadSha256: digest('payload'),
  canonicalManifestDigest: digest('manifest'),
  behaviorDigest: digest('behavior'),
  profileDigest: digest('profile'),
  gatePolicyDigest: digest('gate'),
} as const;
const routeDigest = digest('route');
const cohortDigest = digest('cohort');

function fixture() {
  const sourceDigest = sha256DomainSeparated(
    'kite.operations.incident-rehearsal-source.v1',
    canonicalJson(source),
  );
  const artifactIdentityDigest = sha256DomainSeparated(
    'kite.operations.incident-rehearsal-artifact.v1',
    canonicalJson(artifactIdentity),
  );
  let previousReceiptDigest: string | null = null;
  const receipts = INCIDENT_REHEARSAL_SCENARIOS_.map((scenario, index) => {
    const receipt = buildIncidentRehearsalReceipt({
      schema: 'IncidentRehearsalReceipt',
      sequence: index + 1,
      scenario,
      sourceDigest,
      artifactIdentityDigest,
      routeDigest,
      cohortDigest,
      requestedAt: `2026-08-03T00:0${index}:00.000Z`,
      completedAt: `2026-08-03T00:0${index}:30.000Z`,
      outcome: 'passed',
      actionReceiptDigest: digest(`action-${scenario}`),
      staleProcessOrSessionCount: 0,
      rawContentCollected: false,
      previousReceiptDigest,
    });
    previousReceiptDigest = receipt.receiptDigest;
    return receipt;
  });
  const material = {
    schema: 'IncidentRehearsalEvidence' as const,
    executionClass: 'contract_conformance' as const,
    source,
    artifactIdentity,
    routeDigest,
    cohortDigest,
    receipts,
    ledgerDigest: computeIncidentRehearsalLedgerDigest(receipts),
  };
  const bundleDigest = computeIncidentRehearsalBundleDigest(material);
  return {
    evidence: {
      ...material,
      bundleDigest,
      authentication: {
        kind: 'unconfigured' as const,
        subjectDigest: bundleDigest,
        reason: 'production_incident_rehearsal_authority_unconfigured' as const,
      },
    },
    expectedSource: source,
    expectedArtifactIdentity: artifactIdentity,
    expectedRouteDigest: routeDigest,
    expectedCohortDigest: cohortDigest,
  };
}

describe('retained incident rehearsal ledger', () => {
  test('rebuilds all eight scenarios but remains blocked without production authority', () => {
    expect(verifyIncidentRehearsalEvidence(fixture())).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      verifiedScenarioCount: 8,
      reasonCodes: [
        'contract_conformance_not_production',
        'production_incident_rehearsal_authority_unconfigured',
      ],
    });
  });

  test('rejects receipt-chain tampering and source identity splicing', () => {
    const chain = fixture();
    chain.evidence.receipts[1]!.previousReceiptDigest = null;
    expect(() => verifyIncidentRehearsalEvidence(chain)).toThrow('order or chain');

    const sourceSplice = fixture();
    expect(() =>
      verifyIncidentRehearsalEvidence({
        ...sourceSplice,
        expectedSource: { ...source, runId: '999' },
      }),
    ).toThrow('source identity');
  });

  test('marks failed scenarios and stale runtime state as failed after canonical rebuild', () => {
    const candidate = fixture();
    const first = candidate.evidence.receipts[0]!;
    const { receiptDigest: _receiptDigest, ...material } = first;
    candidate.evidence.receipts[0] = buildIncidentRehearsalReceipt({
      ...material,
      outcome: 'failed',
      staleProcessOrSessionCount: 1,
    });
    let previous: string | null = null;
    candidate.evidence.receipts = candidate.evidence.receipts.map((receipt) => {
      const { receiptDigest: _digest, ...receiptMaterial } = receipt;
      const rebuilt = buildIncidentRehearsalReceipt({
        ...receiptMaterial,
        previousReceiptDigest: previous,
      });
      previous = rebuilt.receiptDigest;
      return rebuilt;
    });
    candidate.evidence.ledgerDigest = computeIncidentRehearsalLedgerDigest(
      candidate.evidence.receipts,
    );
    const {
      bundleDigest: _bundle,
      authentication: _authentication,
      ...evidenceMaterial
    } = candidate.evidence;
    candidate.evidence.bundleDigest = computeIncidentRehearsalBundleDigest(evidenceMaterial);
    candidate.evidence.authentication.subjectDigest = candidate.evidence.bundleDigest;
    const result = verifyIncidentRehearsalEvidence(candidate);
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'scenario_failed:capability_off',
        'stale_runtime_state:capability_off',
      ]),
    );
  });
});
