import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';
import {
  type LimitedSloRebuildV1,
  limitedSloGithubSourceV1Schema,
  rebuildLimitedSloObservationV1,
  verifyLimitedSloSampleLedgerV1,
} from './limited-slo-ledger';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// No production observation producer or attestation verifier has been approved.
// This registry is deliberately not injectable by a caller: a future non-empty
// revision requires governed source code and release-policy changes.
const TRUSTED_LIMITED_SLO_PRODUCERS_V1: readonly string[] = Object.freeze([]);

export const limitedSloQualificationExpectationV1Schema = z
  .object({
    policyDigest: digestSchema,
    limitedApprovalDecisionDigest: digestSchema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    source: limitedSloGithubSourceV1Schema,
    reportDigest: digestSchema,
    verifierDigest: digestSchema,
  })
  .strict();

export type LimitedSloQualificationExpectationV1 = z.infer<
  typeof limitedSloQualificationExpectationV1Schema
>;

export interface LimitedSloQualificationVerificationV1 {
  schema: 'LimitedSloQualificationVerificationV1';
  status: 'blocked';
  productionEvidenceEligible: false;
  trustRegistryConfigured: false;
  ledgerDigest: `sha256:${string}`;
  rebuildDigest: `sha256:${string}`;
  expectationDigest: `sha256:${string}`;
  trustRegistryDigest: `sha256:${string}`;
  reasonCodes: string[];
  rebuild: LimitedSloRebuildV1;
  verificationDigest: `sha256:${string}`;
}

/**
 * Independently verifies retained evidence and expected GitHub/candidate
 * identity. It cannot authenticate production observations until a governed
 * producer/attestation trust root is registered in this module.
 */
export function verifyLimitedSloQualificationV1(input: {
  ledger: unknown;
  expected: unknown;
}): LimitedSloQualificationVerificationV1 {
  const ledger = verifyLimitedSloSampleLedgerV1(input.ledger);
  const expected = limitedSloQualificationExpectationV1Schema.parse(input.expected);
  const rebuild = rebuildLimitedSloObservationV1(ledger);
  const reasons = new Set<string>(['authenticated_observation_verifier_not_configured']);

  for (const field of [
    'policyDigest',
    'limitedApprovalDecisionDigest',
    'routeDigest',
    'cohortDigest',
  ] as const) {
    if (ledger[field] !== expected[field]) reasons.add(`identity_mismatch:${field}`);
  }
  for (const field of [
    'canonicalRepository',
    'repositoryId',
    'commit',
    'payloadSha256',
    'canonicalManifestDigest',
    'behaviorDigest',
    'profileDigest',
    'gatePolicyDigest',
  ] as const) {
    if (ledger.artifactIdentity[field] !== expected.artifactIdentity[field]) {
      reasons.add(`artifact_identity_mismatch:${field}`);
    }
  }
  for (const field of [
    'repository',
    'repositoryId',
    'headSha',
    'ref',
    'workflowPath',
    'workflowRef',
    'workflowSha',
    'runId',
    'runAttempt',
    'jobName',
    'jobId',
    'artifactName',
    'artifactId',
    'artifactDigest',
    'oidcIssuer',
    'attestationSubjectDigest',
  ] as const) {
    if (ledger.source[field] !== expected.source[field]) {
      reasons.add(`source_identity_mismatch:${field}`);
    }
  }
  for (const [sourceField, artifactField] of [
    ['repository', 'canonicalRepository'],
    ['repositoryId', 'repositoryId'],
    ['headSha', 'commit'],
    ['workflowSha', 'commit'],
    ['artifactDigest', 'payloadSha256'],
    ['attestationSubjectDigest', 'payloadSha256'],
  ] as const) {
    if (expected.source[sourceField] !== expected.artifactIdentity[artifactField]) {
      reasons.add(`expected_source_artifact_mismatch:${sourceField}`);
    }
  }
  if (ledger.droppedSampleCount !== 0) reasons.add('retained_sample_drop_observed');

  const expectationDigest = sha256DomainSeparated(
    'kite.operations.limited-slo-expectation.v1',
    canonicalJson(expected),
  );
  const trustRegistryDigest = sha256DomainSeparated(
    'kite.operations.limited-slo-trust-registry.v1',
    canonicalJson(TRUSTED_LIMITED_SLO_PRODUCERS_V1),
  );
  const withoutDigest = {
    schema: 'LimitedSloQualificationVerificationV1' as const,
    status: 'blocked' as const,
    productionEvidenceEligible: false as const,
    trustRegistryConfigured: false as const,
    ledgerDigest: ledger.ledgerDigest as `sha256:${string}`,
    rebuildDigest: rebuild.rebuildDigest,
    expectationDigest,
    trustRegistryDigest,
    reasonCodes: [...reasons].sort(),
    rebuild,
  };
  return {
    ...withoutDigest,
    verificationDigest: sha256DomainSeparated(
      'kite.operations.limited-slo-verification.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
