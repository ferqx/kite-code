import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { ReleaseArtifactIdentityV1 } from '../../../scripts/release/evidence-schema';
import { ADVERSARIAL_CONTRACT_CATALOG_V1 } from './adversarial-contract';
import { APPROVED_AGENT_TASK_CASE_IDS_V1, APPROVED_AGENT_TASK_SUITE_V1 } from './approved-suite';
import {
  AGENT_TASK_ADVERSARIAL_CATALOG_DIGEST_V1,
  type AgentTaskCandidateIdentityV1,
  type AgentTaskCaseLedgerV1,
  type AgentTaskEvidenceFixtureTrustRootV1,
  type AgentTaskEvidenceSourceV1,
  type AgentTaskFixtureRouteV1,
  type AgentTaskFormalAdversarialEvidenceV1,
  type AgentTaskFormalAdversarialReceiptV1,
  type AgentTaskG0CountsV1,
  type AgentTaskRealFrozenBaselineV1,
  type AgentTaskRetainedAttemptV1,
  type AuthenticatedAgentTaskEvidenceV1,
  authenticatedAgentTaskSigningBytesV1,
  computeAgentTaskAdversarialEvidenceDigestV1,
  computeAgentTaskAttemptDigestV1,
  computeAgentTaskCandidateDigestV1,
  computeAgentTaskCaseLedgerDigestV1,
  computeAgentTaskFrozenBaselineDigestV1,
  computeAgentTaskSourceDigestV1,
  computeAuthenticatedAgentTaskBundleDigestV1,
  verifyAuthenticatedAgentTaskEvidenceV1,
} from './authenticated-evidence';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const zeroG0: AgentTaskG0CountsV1 = {
  unauthorizedEffects: 0,
  secretOrContentExfiltration: 0,
  sandboxEscape: 0,
  falseCompletion: 0,
  requiredVerificationBypass: 0,
  concurrencyOrOrderingBypass: 0,
};

const fixtureRoot: AgentTaskEvidenceFixtureTrustRootV1 = {
  signerIdentity: 'fixture:agent-task-evidence-signer',
  keyId: 'fixture-ed25519-v1',
  publicKeyPem,
  repository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  workflowPath: '.github/workflows/agent-task-evaluation.yml',
  allowedRefs: ['refs/heads/main'],
};

describe('authenticated Agent task evidence contract', () => {
  test.each([
    ['pinned_route_or_baseline_change', 8, 96],
    ['release_candidate', 20, 240],
  ] as const)('rebuilds complete D-07 %s evidence', (stage, attemptsPerCase, total) => {
    const result = verifyAuthenticatedAgentTaskEvidenceV1(buildEvidence(stage));

    expect(result).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      attemptsPerCase,
      verifiedCaseCount: 12,
      verifiedAttemptCount: total,
      signatureVerified: false,
      fixtureRouteMatched: false,
      productionAuthenticationModel: 'github_actions_oidc_keyless_sigstore',
      formalAdversarialPassed: true,
      d07PolicyPassed: true,
      reasonCodes: [
        'contract_conformance_not_production',
        'production_route_unconfigured',
        'production_sigstore_verifier_unconfigured',
      ],
    });
    expect(result.perCase).toHaveLength(12);
    expect(result.perCase.every((entry) => entry.successRate === 1)).toBeTrue();
    expect(result.aggregate).toMatchObject({
      attempts: total,
      successes: total,
      successRate: 1,
      g0: zeroG0,
      p95: { latencyMs: 100, totalTokens: 500, userCorrections: 0 },
    });
  });

  test('binds source head/repository to the complete shared Release artifact identity', () => {
    const evidence = buildEvidence('release_candidate');
    evidence.source.headSha = 'c'.repeat(40);
    evidence.source.workflowSha = evidence.source.headSha;
    resignEvidence(evidence);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(evidence)).toThrow(
      'exact Release artifact repository and commit identity',
    );

    const identityDrift = buildEvidence('release_candidate');
    identityDrift.candidate.releaseArtifactIdentity.behaviorDigest = digest('drifted-behavior');
    resignEvidence(identityDrift);
    const original = buildEvidence('release_candidate');
    expect(computeAgentTaskCandidateDigestV1(identityDrift.candidate)).not.toBe(
      computeAgentTaskCandidateDigestV1(original.candidate),
    );
    expect(identityDrift.bundleDigest).not.toBe(original.bundleDigest);
  });

  test('requires the exact canonical 21-case adversarial receipt ledger', () => {
    const missing = buildEvidence('pinned_route_or_baseline_change');
    missing.adversarial.receipts.pop();
    resignEvidence(missing);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(missing)).toThrow(
      'exactly 21 stable case receipts',
    );

    const reordered = buildEvidence('pinned_route_or_baseline_change');
    const first = reordered.adversarial.receipts[0];
    const second = reordered.adversarial.receipts[1];
    if (!first || !second) throw new Error('fixture lost adversarial receipts');
    reordered.adversarial.receipts[0] = second;
    reordered.adversarial.receipts[1] = first;
    resignEvidence(reordered);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(reordered)).toThrow(
      'missing, unknown, duplicated, or reordered',
    );

    const duplicate = buildEvidence('pinned_route_or_baseline_change');
    const receipt = duplicate.adversarial.receipts[0];
    if (!receipt) throw new Error('fixture lost adversarial receipt');
    duplicate.adversarial.receipts[1] = structuredClone(receipt);
    resignEvidence(duplicate);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(duplicate)).toThrow(
      'missing, unknown, duplicated, or reordered',
    );

    const unknown = buildEvidence('pinned_route_or_baseline_change');
    const unknownReceipt = unknown.adversarial.receipts[0];
    if (!unknownReceipt) throw new Error('fixture lost adversarial receipt');
    unknownReceipt.caseId = 'unknown-adversarial.v1';
    resignEvidence(unknown);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(unknown)).toThrow(
      'missing, unknown, duplicated, or reordered',
    );
  });

  test('rejects adversarial catalog drift and cross-candidate evidence', () => {
    const catalogDrift = buildEvidence('release_candidate');
    catalogDrift.adversarial.catalogDigest = digest('drifted-catalog');
    resignEvidence(catalogDrift);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(catalogDrift)).toThrow(
      'catalog digest does not match',
    );

    const crossCandidate = buildEvidence('release_candidate');
    crossCandidate.adversarial.candidateDigest = digest('different-candidate');
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(crossCandidate)).toThrow(
      'does not bind the same source and candidate',
    );
  });

  test('reconstructs per-case, aggregate, G0, false-completion, and p95 failures before auth', () => {
    const evidence = buildEvidence('pinned_route_or_baseline_change');
    const firstLedger = evidence.caseLedgers[0];
    if (!firstLedger) throw new Error('fixture lost retained ledger');
    for (const attempt of firstLedger.attempts.slice(0, 2)) {
      attempt.outcome = 'failed';
      attempt.checksPassed = false;
      attempt.verificationStatus = 'failed';
    }
    const g0Attempt = firstLedger.attempts[0];
    if (!g0Attempt) throw new Error('fixture lost retained attempt');
    g0Attempt.g0.falseCompletion = 1;
    for (const attempt of firstLedger.attempts) {
      attempt.metrics.latencyMs = 2_000;
    }
    resignEvidence(evidence);

    const result = verifyAuthenticatedAgentTaskEvidenceV1(evidence);
    expect(result.status).toBe('failed');
    expect(result.d07PolicyPassed).toBeFalse();
    expect(result.perCase[0]).toMatchObject({ attempts: 8, successes: 6, successRate: 0.75 });
    expect(result.aggregate.g0.falseCompletion).toBe(1);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        `case_success_below_threshold:${APPROVED_AGENT_TASK_CASE_IDS_V1[0]}`,
        'g0_observed:falseCompletion',
        'p95_regression:latencyMs',
        'production_route_unconfigured',
        'production_sigstore_verifier_unconfigured',
      ]),
    );
  });

  test('reports failed when a formal adversarial case fails before production auth', () => {
    const evidence = buildEvidence('release_candidate');
    const receipt = evidence.adversarial.receipts[0];
    if (!receipt) throw new Error('fixture lost adversarial receipt');
    receipt.outcome = 'failed';
    evidence.adversarial.status = 'failed';
    resignEvidence(evidence);

    const result = verifyAuthenticatedAgentTaskEvidenceV1(evidence);
    expect(result).toMatchObject({
      status: 'failed',
      evidenceEligible: false,
      formalAdversarialPassed: false,
    });
    expect(result.reasonCodes).toContain(`formal_adversarial_case_failed:${receipt.caseId}`);
  });

  test('requires every failed attempt to carry Verification status failed', () => {
    const evidence = buildEvidence('pinned_route_or_baseline_change');
    const attempt = evidence.caseLedgers[0]?.attempts[0];
    if (!attempt) throw new Error('fixture lost retained attempt');
    attempt.outcome = 'failed';
    attempt.checksPassed = false;
    attempt.verificationStatus = 'passed';
    resignEvidence(evidence);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(evidence)).toThrow(
      'Every failed retained attempt must have Verification status failed',
    );
  });

  test('rejects missing/best-only/tampered attempts and frozen baseline drift', () => {
    const missing = buildEvidence('pinned_route_or_baseline_change');
    missing.caseLedgers[0]?.attempts.pop();
    resignEvidence(missing);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(missing)).toThrow(
      'must retain exactly 8 attempts',
    );

    const tampered = buildEvidence('pinned_route_or_baseline_change');
    const attempt = tampered.caseLedgers[0]?.attempts[0];
    if (!attempt) throw new Error('fixture lost retained attempt');
    attempt.metrics.totalTokens = 999;
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(tampered)).toThrow(
      'attempt digest does not rebuild',
    );

    const baselineDrift = buildEvidence('pinned_route_or_baseline_change');
    baselineDrift.candidate.frozenBaseline.p95.latencyMs += 1;
    resignEvidence(baselineDrift, { preserveBaselineDigest: true });
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(baselineDrift)).toThrow(
      'baseline identity digest does not rebuild',
    );
  });

  test('fixture signatures and caller production labels can never upgrade production', () => {
    const evidence = buildEvidence('pinned_route_or_baseline_change');
    const mislabeledFixtureRoot = { ...fixtureRoot, authority: 'production' as const };
    const result = verifyAuthenticatedAgentTaskEvidenceV1(evidence, {
      trustRoots: [mislabeledFixtureRoot],
      routes: [fixtureRoute(evidence.candidate)],
    });
    expect(result).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      signatureVerified: true,
      fixtureRouteMatched: true,
      productionAuthenticationModel: 'github_actions_oidc_keyless_sigstore',
      reasonCodes: [
        'contract_conformance_not_production',
        'fixture_ed25519_not_production',
        'production_route_unconfigured',
        'production_sigstore_verifier_unconfigured',
      ],
    });
  });

  test('rejects workflow drift and invalid fixture signatures', () => {
    const workflowDrift = buildEvidence('pinned_route_or_baseline_change');
    workflowDrift.source.workflowSha = 'b'.repeat(40);
    resignEvidence(workflowDrift);
    expect(() => verifyAuthenticatedAgentTaskEvidenceV1(workflowDrift)).toThrow(
      'workflow SHA must equal',
    );

    const signatureDrift = buildEvidence('pinned_route_or_baseline_change');
    if (signatureDrift.signature.kind !== 'fixture_ed25519') {
      throw new Error('fixture evidence lost its fixture signature');
    }
    signatureDrift.signature.valueBase64 = Buffer.alloc(64).toString('base64');
    expect(() =>
      verifyAuthenticatedAgentTaskEvidenceV1(signatureDrift, {
        trustRoots: [fixtureRoot],
        routes: [fixtureRoute(signatureDrift.candidate)],
      }),
    ).toThrow('signature is invalid');
  });
});

function buildEvidence(
  stage: AgentTaskCandidateIdentityV1['stage'],
): AuthenticatedAgentTaskEvidenceV1 {
  const releaseArtifactIdentity = artifactIdentity('candidate', 'a'.repeat(40));
  const source: AgentTaskEvidenceSourceV1 = {
    schema: 'AgentTaskEvidenceSourceV1',
    repository: releaseArtifactIdentity.canonicalRepository,
    repositoryId: releaseArtifactIdentity.repositoryId,
    headSha: releaseArtifactIdentity.commit,
    ref: 'refs/heads/main',
    workflowPath: '.github/workflows/agent-task-evaluation.yml',
    workflowRef: 'ferqx/kite-code/.github/workflows/agent-task-evaluation.yml@refs/heads/main',
    workflowSha: releaseArtifactIdentity.commit,
    runId: '30750000001',
    runAttempt: 1,
    job: 'agent-task-evaluation',
    artifactId: '9000000001',
    artifactName: 'agent-task-evaluation-30750000001',
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T01:00:00.000Z',
  };
  const baselineWithoutDigest: Omit<AgentTaskRealFrozenBaselineV1, 'baselineDigest'> = {
    schema: 'AgentTaskRealFrozenBaselineV1',
    baselineId: 'agent-task-baseline-v1',
    routeIdentity: 'provider:managed/route:v1/model:v1',
    routeDigest: digest('route'),
    releaseArtifactIdentity: artifactIdentity('baseline', 'b'.repeat(40)),
    oracleDigest: digest('baseline-oracle'),
    configDigest: digest('baseline-config'),
    frozenAt: '2026-08-01T00:00:00.000Z',
    p95: { latencyMs: 1_000, totalTokens: 1_000, userCorrections: 4 },
  };
  const candidate: AgentTaskCandidateIdentityV1 = {
    schema: 'AgentTaskCandidateIdentityV1',
    stage,
    suiteId: APPROVED_AGENT_TASK_SUITE_V1.suiteId,
    suiteRevision: APPROVED_AGENT_TASK_SUITE_V1.revision,
    suiteDigest: APPROVED_AGENT_TASK_SUITE_V1.suiteDigest,
    routeIdentity: baselineWithoutDigest.routeIdentity,
    routeDigest: baselineWithoutDigest.routeDigest,
    releaseArtifactIdentity,
    oracleDigest: digest('oracle'),
    configDigest: digest('config'),
    frozenBaseline: {
      ...baselineWithoutDigest,
      baselineDigest: computeAgentTaskFrozenBaselineDigestV1(baselineWithoutDigest),
    },
  };
  const sourceDigest = computeAgentTaskSourceDigestV1(source);
  const candidateDigest = computeAgentTaskCandidateDigestV1(candidate);
  const attemptsPerCase = stage === 'release_candidate' ? 20 : 8;
  const caseLedgers: AgentTaskCaseLedgerV1[] = APPROVED_AGENT_TASK_CASE_IDS_V1.map(
    (caseId, caseIndex) => {
      const attempts: AgentTaskRetainedAttemptV1[] = Array.from(
        { length: attemptsPerCase },
        (_, attemptIndex) => {
          const withoutDigest: Omit<AgentTaskRetainedAttemptV1, 'attemptDigest'> = {
            schema: 'AgentTaskRetainedAttemptV1',
            caseId,
            attemptIndex,
            attemptId: `case-${caseIndex + 1}-attempt-${attemptIndex + 1}`,
            sourceDigest,
            candidateDigest,
            startedAt: timestamp(caseIndex, attemptIndex, 0),
            endedAt: timestamp(caseIndex, attemptIndex, 1),
            retained: true,
            outcome: 'passed',
            checksPassed: true,
            verificationStatus: 'passed',
            oracleResultDigest: digest(`oracle-result-${caseIndex}-${attemptIndex}`),
            metrics: { latencyMs: 100, totalTokens: 500, userCorrections: 0 },
            g0: { ...zeroG0 },
          };
          return {
            ...withoutDigest,
            attemptDigest: computeAgentTaskAttemptDigestV1(withoutDigest),
          };
        },
      );
      const withoutDigest = { schema: 'AgentTaskCaseLedgerV1' as const, caseId, attempts };
      return {
        ...withoutDigest,
        ledgerDigest: computeAgentTaskCaseLedgerDigestV1(withoutDigest),
      };
    },
  );
  const receipts: AgentTaskFormalAdversarialReceiptV1[] = ADVERSARIAL_CONTRACT_CATALOG_V1.map(
    (contract, index) => ({
      schema: 'AgentTaskFormalAdversarialReceiptV1',
      caseId: contract.caseId,
      reportDigest: digest(`adversarial-report-${index}`),
      outcome: 'passed',
      g0: { ...zeroG0 },
    }),
  );
  const adversarialWithoutDigest: Omit<AgentTaskFormalAdversarialEvidenceV1, 'evidenceDigest'> = {
    schema: 'AgentTaskFormalAdversarialEvidenceV1',
    sourceDigest,
    candidateDigest,
    catalogDigest: AGENT_TASK_ADVERSARIAL_CATALOG_DIGEST_V1,
    status: 'passed',
    receipts,
  };
  const evidence: AuthenticatedAgentTaskEvidenceV1 = {
    schema: 'AuthenticatedAgentTaskEvidenceV1',
    executionClass: 'contract_conformance',
    source,
    candidate,
    caseLedgers,
    adversarial: {
      ...adversarialWithoutDigest,
      evidenceDigest: computeAgentTaskAdversarialEvidenceDigestV1(adversarialWithoutDigest),
    },
    signedAt: '2026-08-02T01:00:01.000Z',
    signerIdentity: fixtureRoot.signerIdentity,
    keyId: fixtureRoot.keyId,
    bundleDigest: digest('placeholder'),
    signature: { kind: 'fixture_ed25519', algorithm: 'ed25519', valueBase64: 'AA==' },
  };
  resignEvidence(evidence);
  return evidence;
}

function resignEvidence(
  evidence: AuthenticatedAgentTaskEvidenceV1,
  options: { preserveBaselineDigest?: boolean } = {},
): void {
  if (!options.preserveBaselineDigest) {
    const { baselineDigest: _baselineDigest, ...baselineMaterial } =
      evidence.candidate.frozenBaseline;
    evidence.candidate.frozenBaseline.baselineDigest =
      computeAgentTaskFrozenBaselineDigestV1(baselineMaterial);
  }
  const sourceDigest = computeAgentTaskSourceDigestV1(evidence.source);
  const candidateDigest = computeAgentTaskCandidateDigestV1(evidence.candidate);
  for (const ledger of evidence.caseLedgers) {
    for (const attempt of ledger.attempts) {
      attempt.sourceDigest = sourceDigest;
      attempt.candidateDigest = candidateDigest;
      const { attemptDigest: _attemptDigest, ...attemptMaterial } = attempt;
      attempt.attemptDigest = computeAgentTaskAttemptDigestV1(attemptMaterial);
    }
    const { ledgerDigest: _ledgerDigest, ...ledgerMaterial } = ledger;
    ledger.ledgerDigest = computeAgentTaskCaseLedgerDigestV1(ledgerMaterial);
  }
  evidence.adversarial.sourceDigest = sourceDigest;
  evidence.adversarial.candidateDigest = candidateDigest;
  const { evidenceDigest: _evidenceDigest, ...adversarialMaterial } = evidence.adversarial;
  evidence.adversarial.evidenceDigest =
    computeAgentTaskAdversarialEvidenceDigestV1(adversarialMaterial);
  const { bundleDigest: _bundleDigest, signature: _signature, ...bundleMaterial } = evidence;
  evidence.bundleDigest = computeAuthenticatedAgentTaskBundleDigestV1(bundleMaterial);
  evidence.signature = {
    kind: 'fixture_ed25519',
    algorithm: 'ed25519',
    valueBase64: sign(
      null,
      authenticatedAgentTaskSigningBytesV1(evidence.bundleDigest as `sha256:${string}`),
      privateKey,
    ).toString('base64'),
  };
}

function artifactIdentity(label: string, commit: string): ReleaseArtifactIdentityV1 {
  return {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    commit,
    payloadSha256: digest(`${label}-payload`),
    canonicalManifestDigest: digest(`${label}-manifest`),
    behaviorDigest: digest(`${label}-behavior`),
    profileDigest: digest(`${label}-profile`),
    gatePolicyDigest: digest(`${label}-gate-policy`),
  };
}

function fixtureRoute(candidate: AgentTaskCandidateIdentityV1): AgentTaskFixtureRouteV1 {
  return {
    routeIdentity: candidate.routeIdentity,
    routeDigest: candidate.routeDigest as `sha256:${string}`,
  };
}

function timestamp(caseIndex: number, attemptIndex: number, offset: 0 | 1): string {
  const milliseconds =
    Date.parse('2026-08-02T00:00:00.000Z') + (caseIndex * 20 + attemptIndex * 2 + offset) * 1_000;
  return new Date(milliseconds).toISOString();
}

function digest(value: string): `sha256:${string}` {
  const hex = Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
  return `sha256:${hex}`;
}
