import { describe, expect, test } from 'bun:test';
import {
  createSourceOwnedQualificationCatalogV1,
  generateSourceOwnedFeatureMatrixV1,
} from '../../../release/qualification/source-owned-surface-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  buildDiagnosticModelCapabilityResolutionV1,
  buildLiveAutoCompactionSemanticReceiptV1,
  LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1,
  LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1,
  type LiveAutoCompactionSemanticReceiptMaterialV1,
  liveAutoCompactionDurationBucketForRunWallClockSecondsV1,
  liveAutoCompactionSemanticReceiptV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/live-auto-compaction-schema-v1';
import {
  L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1,
  l3LiveAutoCompactionSourceRegistryIsClosedV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-auto-compaction-source-registry-v1';
import {
  buildLiveAutoCompactionNotObservedReportV1,
  buildLiveAutoCompactionObservationVerifierContextV1,
  liveAutoCompactionObservationDiagnosticReportV1Schema,
  verifyLiveAutoCompactionObservationV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-auto-compaction-verifier-v1';
import {
  buildDiagnosticExecutionV1,
  buildLiveCompatibilityObservationV1,
  type QualificationAttemptIdentityV1,
} from '../../../scripts/evals/contracts/qualification/evidence/live-observation-schema-v1';
import {
  assertL3LiveAutoCompactionSourceOwnedMatrixProjectionV1,
  L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
} from '../../../scripts/evals/contracts/qualification/live-auto-compaction-policy-v1';

const STARTED_AT = '2026-08-06T00:00:00.000Z';
const OBSERVED_AT = '2026-08-06T00:00:01.000Z';
const RESERVATION_ID = 'l3-00000000-0000-4000-8000-000000000009';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function sourceBoundFacts(
  outcome: 'success' | 'cancelled',
  overrides: { identity?: QualificationAttemptIdentityV1 } = {},
) {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  const attempts = outcome === 'success' ? 2 : 1;
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    routePolicyDigest: source.policy.policyDigest,
    period: 'day',
    periodStart: '2026-08-06',
    reservationId: RESERVATION_ID,
    status: 'reconciled',
    reserved: source.quota,
    reconciled: {
      attempts,
      tokens: source.quota.tokens,
      runWallClockSeconds: 1,
      costUsdMicros: source.quota.costUsdMicros,
    },
  });
  const monthQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    routePolicyDigest: source.policy.policyDigest,
    period: 'month',
    periodStart: '2026-08-01',
    reservationId: RESERVATION_ID,
    status: 'reconciled',
    reserved: source.quota,
    reconciled: {
      attempts,
      tokens: source.quota.tokens,
      runWallClockSeconds: 1,
      costUsdMicros: source.quota.costUsdMicros,
    },
  });
  const retention = buildEvidenceRetentionWitnessV1({
    schema: 'EvidenceRetentionWitnessV1',
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    retentionClass: 'ephemeral_local',
    storage: {
      acl: 'local_owner_only',
      encryption: 'local_owner_disk_encryption',
      audit: 'local_metadata_audit',
    },
    deleteTrigger: 'process_exit',
    observedAt: STARTED_AT,
  });
  const governance = {
    retentionClass: 'ephemeral_local' as const,
    profileId: source.governance.profileId,
    profileDigest: source.governance.profileDigest,
    quotaLedgerDigests: {
      day: dayQuotaLedger.recordDigest,
      month: monthQuotaLedger.recordDigest,
    },
    storageDeletionWitnessDigest: retention.recordDigest,
  };
  const execution = buildDiagnosticExecutionV1({
    executionId: `l3-live-auto-compaction-execution-${RESERVATION_ID}`,
    platformIdentity: source.execution.platformIdentity,
    identity: {
      source: 'local_synthetic',
      fixtureId: source.execution.fixtureId,
      runner: source.execution.runner,
      commit: source.execution.commit,
      startedAt: STARTED_AT,
      endedAt: OBSERVED_AT,
    },
  });
  const identity = overrides.identity ?? source.identity;
  const context = buildLiveAutoCompactionObservationVerifierContextV1({
    schema: 'LiveAutoCompactionObservationVerifierContextV1',
    version: 1,
    candidate: source.candidate,
    governance,
    execution,
    scope: source.scope,
    identity,
    governanceWitnesses: { dayQuotaLedger, monthQuotaLedger, retention },
  });
  const observation = buildLiveCompatibilityObservationV1({
    schema: 'LiveCompatibilityObservationV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    observedAt: OBSERVED_AT,
    candidate: source.candidate,
    governance,
    execution,
    scope: source.scope,
    identity,
    outcome,
  });
  const capabilityResolution = buildDiagnosticModelCapabilityResolutionV1({
    schema: 'DiagnosticModelCapabilityResolutionV1',
    version: 1,
    capabilityDeclarationDigest: source.policy.capabilityDeclarationDigest,
    contextWindowTokens: 'unknown',
    contextWindowSource: 'not_declared',
    maxOutputTokens: 600,
    maxOutputTokensSource: 'compatibility_config',
  });
  const requestTurnDigest = digest('1');
  const receiptMaterial: LiveAutoCompactionSemanticReceiptMaterialV1 = {
    schema: 'LiveAutoCompactionSemanticReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l3-live-auto-compaction-receipt:${
      outcome === 'success' ? 'l3-auto-compaction-success-v1' : 'l3-auto-compaction-cancelled-v1'
    }`,
    caseId:
      outcome === 'success' ? 'l3-auto-compaction-success-v1' : 'l3-auto-compaction-cancelled-v1',
    outcome,
    compactAfterEstimatedTokens: source.semantic.compactAfterEstimatedTokens,
    fullProjectionTokenBucket: '9000_10000',
    durationBucket: 'duration_0_to_10_seconds',
    durationBucketPolicyDigest: source.semantic.durationBucketPolicyDigest,
    phaseCaps: source.semantic.phaseCaps,
    phaseCapsDigest: source.semantic.phaseCapsDigest,
    capabilityResolution,
    semanticEvents:
      outcome === 'success'
        ? [...LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1]
        : [...LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1],
    phases:
      outcome === 'success'
        ? {
            summaryPhaseState: 'dispatched_known',
            primaryPhaseState: 'dispatched_known',
            summaryDispatchCount: 1,
            primaryDispatchCount: 1,
            summaryProviderInputBucket: '0_7800',
            summaryOutputBucket: '0_600',
            primaryProviderInputBucket: '0_3229',
            primaryOutputBucket: '0_600',
            invocationTokenBucket: '0_12229',
          }
        : {
            summaryPhaseState: 'dispatched_known',
            primaryPhaseState: 'known_zero',
            summaryDispatchCount: 1,
            primaryDispatchCount: 0,
            summaryProviderInputBucket: '0_7800',
            summaryOutputBucket: 'not_observed',
            primaryProviderInputBucket: 'not_dispatched',
            primaryOutputBucket: 'not_dispatched',
            invocationTokenBucket: '0_12229',
          },
    turns:
      outcome === 'success'
        ? {
            requestTurnDigest,
            checkpointTurnDigest: requestTurnDigest,
            primaryDispatchTurnDigest: requestTurnDigest,
          }
        : {
            requestTurnDigest,
            failedTurnDigest: requestTurnDigest,
            stoppedTurnDigest: requestTurnDigest,
            nextTurnDigest: digest('2'),
          },
    sourceBinding: {
      policyDigest: source.policy.policyDigest,
      durationBucketPolicyDigest: source.semantic.durationBucketPolicyDigest,
      phaseCapsDigest: source.semantic.phaseCapsDigest,
      syntheticProjectionDigest: source.semantic.syntheticProjection.syntheticProjectionDigest,
      routeIdentityDigest: source.policy.routeIdentityDigest,
      providerDataPolicyDigest: source.policy.providerDataPolicyDigest,
      capabilityDeclarationDigest: source.policy.capabilityDeclarationDigest,
      promptEnvironmentDigest: source.policy.promptEnvironmentDigest,
      routeToolCatalogDigest: source.policy.routeToolCatalogDigest,
      toolEnvironmentDigest: source.policy.toolEnvironmentDigest,
      sourceOwnedIdentityDigest: source.policy.sourceOwnedIdentityDigest,
      candidateClosureDigest: source.policy.candidateClosureDigest,
      matrixDigest: source.policy.matrixDigest,
      matrixSuiteDigest: source.policy.matrixSuiteDigest,
      suiteDigest: source.policy.suiteDigest,
      fixtureDigest: source.policy.fixtureDigest,
      corpusDigest: source.policy.corpusDigest,
      oracleDigest: source.policy.oracleDigest,
      evaluatorDigest: source.policy.evaluatorDigest,
      verifierDigest: source.policy.verifierDigest,
      runnerSourceDigest: source.policy.runnerSourceDigest,
      runnerDigest: source.policy.runnerDigest,
      transportBindingDigest: source.policy.transportBindingDigest,
      executionDigest: execution.executionDigest,
      governanceProfileDigest: source.governance.profileDigest,
      dayQuotaLedgerDigest: dayQuotaLedger.recordDigest,
      monthQuotaLedgerDigest: monthQuotaLedger.recordDigest,
      retentionWitnessDigest: retention.recordDigest,
      observationRecordDigest: observation.recordDigest,
      observationReportDigest: observation.reportDigest,
    },
  };
  return {
    context,
    observation,
    receiptMaterial,
    receipt: buildLiveAutoCompactionSemanticReceiptV1(receiptMaterial),
  };
}

describe('AQ-9B specialized live auto-compaction evidence', () => {
  test('projects ledger-only wall-clock counters into a closed coarse bucket vocabulary', () => {
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(0)).toBe(
      'duration_0_to_10_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(10)).toBe(
      'duration_0_to_10_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(11)).toBe(
      'duration_11_to_60_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(60)).toBe(
      'duration_11_to_60_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(61)).toBe(
      'duration_61_to_600_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(600)).toBe(
      'duration_61_to_600_seconds',
    );
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(601)).toBeUndefined();
    expect(liveAutoCompactionDurationBucketForRunWallClockSecondsV1(-1)).toBeUndefined();
  });

  test('reconstructs the AQ-9B Matrix binding from the source-owned collector rather than a parallel inventory', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateSourceOwnedFeatureMatrixV1();
    const feature = matrix.features.find(
      (candidate) => candidate.id === 'MODEL_CONTEXT-AUTO_COMPACTION_FAILURE-001',
    );
    const required = feature?.requiredEvidence.find(
      (requirement) =>
        requirement.layer === 'contract' &&
        requirement.suiteIds.includes('source-owned-surface-contract-v1'),
    );
    const matrixSuite = catalog.suites.find(
      (suite) => suite.suiteId === 'source-owned-surface-contract-v1',
    );
    const assertionId = required?.assertionIds[0];
    if (!feature || !required || !matrixSuite || !assertionId) {
      throw new Error('l3_live_auto_compaction_source_owned_matrix_fact_missing');
    }
    assertL3LiveAutoCompactionSourceOwnedMatrixProjectionV1({
      identity: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
      matrixDigest: matrix.matrixDigest as `sha256:${string}`,
      sourceSurfaceId: feature.sourceSurfaceId,
      featureId: feature.id,
      assertionId,
      matrixSuiteId: matrixSuite.suiteId,
      matrixSuiteDigest: matrixSuite.suiteDigest as `sha256:${string}`,
    });
    expect(() =>
      assertL3LiveAutoCompactionSourceOwnedMatrixProjectionV1({
        identity: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
        matrixDigest: `sha256:${'f'.repeat(64)}`,
        sourceSurfaceId: feature.sourceSurfaceId,
        featureId: feature.id,
        assertionId,
        matrixSuiteId: matrixSuite.suiteId,
        matrixSuiteDigest: matrixSuite.suiteDigest as `sha256:${string}`,
      }),
    ).toThrow('live_auto_compaction_source_owned_matrix_drift');
  });

  test('reconstructs the independent two-phase policy, source identity, governance, outer observation, and success semantic receipt', () => {
    const { context, observation, receipt } = sourceBoundFacts('success');
    expect(l3LiveAutoCompactionSourceRegistryIsClosedV1()).toBe(true);
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'observed',
      reasonCode: 'observed_success',
      outcome: 'success',
      durationBucket: 'duration_0_to_10_seconds',
      candidateClosureDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1.candidate.closureDigest,
      observationRecordDigest: observation.recordDigest,
      semanticReceiptRecordDigest: receipt.recordDigest,
    });
  });

  test('accepts only the known summary dispatch / zero-primary cancellation branch and binds next-turn preflight', () => {
    const { context, observation, receipt } = sourceBoundFacts('cancelled');
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'observed',
      reasonCode: 'observed_cancelled',
      outcome: 'cancelled',
      durationBucket: 'duration_0_to_10_seconds',
    });
  });

  test('rejects unknown or possibly-dispatched phase state before it can become an observed receipt', () => {
    const { receiptMaterial } = sourceBoundFacts('cancelled');
    expect(() =>
      buildLiveAutoCompactionSemanticReceiptV1({
        ...receiptMaterial,
        phases: { ...receiptMaterial.phases, summaryPhaseState: 'dispatched_unknown' },
      }),
    ).toThrow();
    expect(
      liveAutoCompactionSemanticReceiptV1Schema.safeParse({
        ...receiptMaterial,
        phases: { ...receiptMaterial.phases, primaryPhaseState: 'not_started' },
      }).success,
    ).toBe(false);
    expect(
      buildLiveAutoCompactionNotObservedReportV1(undefined, 'phase_dispatch_unknown'),
    ).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'blocked',
      reasonCode: 'phase_dispatch_unknown',
    });
  });

  test('blocks a self-consistent semantic receipt whose Matrix digest was spliced after source binding', () => {
    const { context, observation, receiptMaterial } = sourceBoundFacts('success');
    const receipt = buildLiveAutoCompactionSemanticReceiptV1({
      ...receiptMaterial,
      sourceBinding: { ...receiptMaterial.sourceBinding, matrixDigest: digest('a') },
    });
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
  });

  test('binds the receipt coarse duration bucket to the reconciled ledger without exposing its raw counter', () => {
    const { context, observation, receiptMaterial } = sourceBoundFacts('success');
    const receipt = buildLiveAutoCompactionSemanticReceiptV1({
      ...receiptMaterial,
      durationBucket: 'duration_11_to_60_seconds',
    });
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      status: 'blocked',
      reasonCode: 'duration_bucket_mismatch',
    });
  });

  test('blocks a self-consistent receipt whose duration-bucket policy digest is not source-bound', () => {
    const { context, observation, receiptMaterial } = sourceBoundFacts('success');
    const durationBucketPolicyDigest = digest('c');
    const receipt = buildLiveAutoCompactionSemanticReceiptV1({
      ...receiptMaterial,
      durationBucketPolicyDigest,
      sourceBinding: {
        ...receiptMaterial.sourceBinding,
        durationBucketPolicyDigest,
      },
    });
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
  });

  test('blocks a self-consistent outer context whose AQ-9B suite digest differs from the source-owned registry', () => {
    const forgedIdentity = {
      ...L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1.identity,
      suiteDigest: digest('b'),
    };
    const { context, observation, receipt } = sourceBoundFacts('success', {
      identity: forgedIdentity,
    });
    expect(verifyLiveAutoCompactionObservationV1(observation, receipt, context)).toMatchObject({
      status: 'blocked',
      reasonCode: 'identity_drift',
    });
  });

  test('has no content-bearing or raw-duration receipt/report field', () => {
    const { context, observation, receipt } = sourceBoundFacts('success');
    expect(
      liveAutoCompactionSemanticReceiptV1Schema.safeParse({
        ...receipt,
        endpoint: 'https://example.invalid/v1',
      }).success,
    ).toBe(false);
    expect(
      liveAutoCompactionSemanticReceiptV1Schema.safeParse({
        ...receipt,
        durationSeconds: 1,
      }).success,
    ).toBe(false);
    const report = verifyLiveAutoCompactionObservationV1(observation, receipt, context);
    expect(
      liveAutoCompactionObservationDiagnosticReportV1Schema.safeParse({
        ...report,
        runWallClockSeconds: 1,
      }).success,
    ).toBe(false);
  });
});
