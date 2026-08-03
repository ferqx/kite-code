import { describe, expect, test } from 'bun:test';
import {
  buildObservabilityBaselineLedgerV1,
  buildObservabilityBaselineSampleReceiptV1,
  type ObservabilityBaselineExpectationV1,
  type ObservabilityBaselineLedgerMaterialV1,
  type ObservabilityBaselineSampleReceiptV1,
  rebuildObservabilityBaselineV1,
  verifyObservabilityBaselineLedgerV1,
} from '../../scripts/operations/observability-baseline-ledger';
import {
  type ObservabilityBaselineReportV1,
  produceObservabilityBaselineReportV1,
} from '../../scripts/operations/produce-observability-baseline';
import { verifyObservabilityBaselineReportV1 } from '../../scripts/operations/verify-observability-baseline';
import { canonicalJson, sha256DomainSeparated } from '../../scripts/release/canonical-json';

const COMMIT = 'a'.repeat(40);

function digest(label: string): `sha256:${string}` {
  return sha256DomainSeparated('kite.tests.observability-baseline.v1', label);
}

function identity() {
  return {
    artifactIdentity: {
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      commit: COMMIT,
      payloadSha256: digest('payload'),
      canonicalManifestDigest: digest('manifest'),
      behaviorDigest: digest('behavior'),
      profileDigest: digest('profile'),
      gatePolicyDigest: digest('gate-policy'),
    },
    routeIdentity: {
      schema: 'ObservabilityBaselineRouteIdentityV1' as const,
      routeAlias: 'deepseek-v4-flash',
      routeDigest: digest('route'),
      providerDataPolicyDigest: digest('provider-policy'),
    },
    policyIdentity: {
      schema: 'ObservabilityBaselinePolicyIdentityV1' as const,
      policyId: 'agent-production-baseline-v1',
      revision: 1,
      policyDigest: digest('baseline-policy'),
      owner: 'github:@ferqx' as const,
      minimumSamples: 2,
      minimumObservationWindowSeconds: 60,
      approvedAt: '2026-08-03T00:00:00.000Z',
    },
    source: {
      schema: 'ObservabilityBaselineGithubSourceV1' as const,
      repository: 'ferqx/kite-code' as const,
      repositoryId: 'R_kgDOSKbi8g' as const,
      headSha: COMMIT,
      ref: 'refs/heads/main',
      workflowPath: '.github/workflows/observability-baseline.yml',
      workflowRef: 'ferqx/kite-code/.github/workflows/observability-baseline.yml@refs/heads/main',
      workflowSha: COMMIT,
      runId: '123',
      runAttempt: 1,
      jobName: 'observability-baseline',
      jobId: '456',
      retainedArtifactName: 'observability-baseline-retained-123-1',
      retainedArtifactId: '789',
      retainedArtifactDigest: digest('retained-artifact'),
      oidcIssuer: 'https://token.actions.githubusercontent.com' as const,
      producerIdentity: 'github-actions:observability-baseline-v1',
      attestationDigest: digest('attestation'),
      attestationSubjectDigest: digest('payload'),
    },
  };
}

function g0() {
  return {
    unauthorized_side_effects: 0,
    secret_or_content_egress: 0,
    sandbox_or_workspace_escape: 0,
    runtime_state_corruption: 0,
    required_verification_bypass: 0,
  };
}

function samples(): ObservabilityBaselineSampleReceiptV1[] {
  const first = buildObservabilityBaselineSampleReceiptV1({
    schema: 'ObservabilityBaselineSampleReceiptV1',
    sequence: 1,
    sampleId: `baseline_sample_${'1'.repeat(32)}`,
    previousReceiptDigest: null,
    observedAt: '2026-08-03T00:00:30.000Z',
    outcomeReceiptDigest: digest('outcome-1'),
    taskChecksPassed: true,
    humanAccepted: true,
    recoveryRequired: false,
    recoverySucceeded: null,
    unrelatedDiff: false,
    falseCompletion: false,
    integrated: true,
    reverted: false,
    g0: g0(),
    g1Failures: 0,
  });
  const second = buildObservabilityBaselineSampleReceiptV1({
    schema: 'ObservabilityBaselineSampleReceiptV1',
    sequence: 2,
    sampleId: `baseline_sample_${'2'.repeat(32)}`,
    previousReceiptDigest: first.receiptDigest,
    observedAt: '2026-08-03T00:01:30.000Z',
    outcomeReceiptDigest: digest('outcome-2'),
    taskChecksPassed: false,
    humanAccepted: null,
    recoveryRequired: true,
    recoverySucceeded: true,
    unrelatedDiff: true,
    falseCompletion: false,
    integrated: false,
    reverted: false,
    g0: g0(),
    g1Failures: 0,
  });
  return [first, second];
}

function ledgerMaterial(
  overrides: Partial<ObservabilityBaselineLedgerMaterialV1> = {},
): ObservabilityBaselineLedgerMaterialV1 {
  const ids = identity();
  const retained = samples();
  return {
    schema: 'ObservabilityBaselineLedgerV1',
    ...ids,
    startedAt: '2026-08-03T00:00:00.000Z',
    endedAt: '2026-08-03T00:02:00.000Z',
    declaredSampleCount: retained.length,
    droppedSampleCount: 0,
    samples: retained,
    ...overrides,
  };
}

function expectation(
  material: ObservabilityBaselineLedgerMaterialV1 = ledgerMaterial(),
): ObservabilityBaselineExpectationV1 {
  return {
    schema: 'ObservabilityBaselineExpectationV1',
    artifactIdentity: structuredClone(material.artifactIdentity),
    routeIdentity: structuredClone(material.routeIdentity),
    policyIdentity: structuredClone(material.policyIdentity),
    source: structuredClone(material.source),
  };
}

describe('observability baseline retained report contract', () => {
  test('rebuilds every aggregate and binds exact production-shaped identity', () => {
    const material = ledgerMaterial();
    const ledger = buildObservabilityBaselineLedgerV1(material);
    const rebuild = rebuildObservabilityBaselineV1(ledger);
    expect(rebuild).toMatchObject({
      sampleCount: 2,
      noData: false,
      unknownMetrics: [],
      metrics: {
        task_checks_passed: { observedCount: 2, positiveCount: 1, rate: 0.5 },
        human_accepted: { observedCount: 1, positiveCount: 1, rate: 1 },
        recovery_success: { observedCount: 1, positiveCount: 1, rate: 1 },
        unrelated_diff: { observedCount: 2, positiveCount: 1, rate: 0.5 },
        false_completion: { observedCount: 2, positiveCount: 0, rate: 0 },
        integrated: { observedCount: 2, positiveCount: 1, rate: 0.5 },
        reverted: { observedCount: 2, positiveCount: 0, rate: 0 },
      },
    });

    const report = produceObservabilityBaselineReportV1(ledger);
    expect(report).toMatchObject({
      status: 'blocked',
      baselineState: 'observed_unqualified',
      evidenceEligible: false,
      sourceAuthority: 'unconfigured',
      artifactIdentity: material.artifactIdentity,
      routeIdentity: material.routeIdentity,
      policyIdentity: material.policyIdentity,
      source: material.source,
    });
    const verification = verifyObservabilityBaselineReportV1({
      ledger,
      report,
      expected: expectation(material),
    });
    expect(verification).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      sourceIdentityVerified: true,
      retainedRebuildVerified: true,
      sourceAuthorityConfigured: false,
    });
    expect(verification.reasonCodes).toEqual([
      'production_attestation_verifier_unconfigured',
      'source_owned_baseline_authority_unconfigured',
    ]);
  });

  test('keeps an empty retained window unknown and blocked', () => {
    const material = ledgerMaterial({
      declaredSampleCount: 0,
      samples: [],
    });
    const ledger = buildObservabilityBaselineLedgerV1(material);
    const report = produceObservabilityBaselineReportV1(ledger);
    expect(report.baselineState).toBe('unknown');
    expect(report.rebuild.noData).toBe(true);
    expect(report.rebuild.unknownMetrics).toEqual([
      'task_checks_passed',
      'human_accepted',
      'recovery_success',
      'unrelated_diff',
      'false_completion',
      'integrated',
      'reverted',
    ]);
    expect(report.reasonCodes).toContain('no_data');
    expect(report.reasonCodes).toContain('sample_count_insufficient');
    expect(report.reasonCodes).toContain('metric_unknown:human_accepted');
    expect(
      verifyObservabilityBaselineReportV1({
        ledger,
        report,
        expected: expectation(material),
      }).status,
    ).toBe('blocked');
  });

  test('rejects retained receipt tampering, broken chains, and fabricated counts', () => {
    const ledger = buildObservabilityBaselineLedgerV1(ledgerMaterial());
    const tampered = structuredClone(ledger);
    tampered.samples[0]!.taskChecksPassed = false;
    expect(() => verifyObservabilityBaselineLedgerV1(tampered)).toThrow('sample digest mismatch');

    const broken = structuredClone(ledger);
    broken.samples[1]!.previousReceiptDigest = digest('wrong-previous');
    expect(() => verifyObservabilityBaselineLedgerV1(broken)).toThrow('digest chain is broken');

    const fabricatedCount = structuredClone(ledger);
    fabricatedCount.declaredSampleCount = 3;
    expect(() => verifyObservabilityBaselineLedgerV1(fabricatedCount)).toThrow(
      'declared sample count',
    );

    const postSelectedPolicy = ledgerMaterial();
    postSelectedPolicy.policyIdentity.approvedAt = '2026-08-03T00:00:01.000Z';
    expect(() => buildObservabilityBaselineLedgerV1(postSelectedPolicy)).toThrow(
      'not approved before collection',
    );
  });

  test('rejects fabricated aggregates even when the attacker recomputes the outer report digest', () => {
    const material = ledgerMaterial();
    const ledger = buildObservabilityBaselineLedgerV1(material);
    const report = produceObservabilityBaselineReportV1(ledger);
    const forged = structuredClone(report) as ObservabilityBaselineReportV1;
    forged.rebuild.metrics.task_checks_passed.rate = 1;
    const { reportDigest: _oldDigest, ...forgedMaterial } = forged;
    forged.reportDigest = sha256DomainSeparated(
      'kite.operations.observability-baseline-report.v1',
      canonicalJson(forgedMaterial),
    );
    expect(() =>
      verifyObservabilityBaselineReportV1({
        ledger,
        report: forged,
        expected: expectation(material),
      }),
    ).toThrow('does not rebuild exactly');
  });

  test('rejects source, artifact, route, and policy splice attempts', () => {
    const material = ledgerMaterial();
    const ledger = buildObservabilityBaselineLedgerV1(material);
    const report = produceObservabilityBaselineReportV1(ledger);
    const cases: Array<[string, ObservabilityBaselineExpectationV1]> = [
      [
        'artifact',
        {
          ...expectation(material),
          artifactIdentity: {
            ...material.artifactIdentity,
            profileDigest: digest('other-profile'),
          },
        },
      ],
      [
        'route',
        {
          ...expectation(material),
          routeIdentity: { ...material.routeIdentity, routeDigest: digest('other-route') },
        },
      ],
      [
        'policy',
        {
          ...expectation(material),
          policyIdentity: { ...material.policyIdentity, policyDigest: digest('other-policy') },
        },
      ],
      [
        'source',
        {
          ...expectation(material),
          source: { ...material.source, runId: '999' },
        },
      ],
    ];
    for (const [kind, expected] of cases) {
      expect(() => verifyObservabilityBaselineReportV1({ ledger, report, expected })).toThrow(
        `${kind} identity mismatch`,
      );
    }
  });

  test('does not accept caller-declared authority or hidden report fields', () => {
    const material = ledgerMaterial();
    const ledger = buildObservabilityBaselineLedgerV1(material);
    const report = produceObservabilityBaselineReportV1(ledger);
    expect(() =>
      verifyObservabilityBaselineReportV1({
        ledger,
        report: { ...report, sourceAuthority: 'verified' },
        expected: expectation(material),
      }),
    ).toThrow();
    expect(() =>
      verifyObservabilityBaselineReportV1({
        ledger,
        report: { ...report, claimedProductionApproval: true },
        expected: expectation(material),
      }),
    ).toThrow();
  });
});
