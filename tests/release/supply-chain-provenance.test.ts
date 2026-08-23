import { describe, expect, test } from 'bun:test';
import {
  evaluateReleaseProvenanceIdentity,
  PINNED_RELEASE_REPOSITORY,
  PINNED_RELEASE_REPOSITORY_ID,
  PINNED_RELEASE_WORKFLOW_PATH,
  REAL_RELEASE_PROVENANCE_VERIFICATION_ENABLED,
  ReleaseProvenanceIdentityError,
} from '../../scripts/release/verify-provenance';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;
const COMMIT = '1'.repeat(40);
const WORKFLOW_SHA = '2'.repeat(40);

function claims() {
  const ref = 'refs/tags/v0.1.0';
  return {
    version: 1,
    source: 'github_actions_oidc',
    canonicalRepository: PINNED_RELEASE_REPOSITORY,
    repositoryId: PINNED_RELEASE_REPOSITORY_ID,
    repositoryVisibility: 'private',
    workflowPath: PINNED_RELEASE_WORKFLOW_PATH,
    workflowRef: `${PINNED_RELEASE_REPOSITORY}/${PINNED_RELEASE_WORKFLOW_PATH}@${ref}`,
    workflowSha: WORKFLOW_SHA,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    ref,
    commit: COMMIT,
    runId: '12345',
    runAttempt: 1,
    artifactDigest: A,
    subjects: { payloadSha256: B, canonicalManifestDigest: C, sbomSha256: D },
    gateReplayStatus: 'passed',
    sigstoreBundleVerified: false,
    githubAttestationVerified: false,
    nativePlatformSignatureVerified: false,
    nonDistributable: true,
  };
}

const expected = {
  commit: COMMIT,
  workflowSha: WORKFLOW_SHA,
  artifactDigest: A,
  payloadSha256: B,
  canonicalManifestDigest: C,
  sbomSha256: D,
};

describe('release provenance identity contract', () => {
  test('pins repository, workflow, ref, run, attempt and every subject but stays blocked', () => {
    expect(REAL_RELEASE_PROVENANCE_VERIFICATION_ENABLED).toBe(false);
    expect(evaluateReleaseProvenanceIdentity({ claims: claims(), expected })).toEqual({
      status: 'blocked',
      reason: 'non_distributable_input',
      productionAccepted: false,
      identityContractMatched: true,
    });

    const privateLookingProduction = {
      ...claims(),
      nonDistributable: false,
      sigstoreBundleVerified: true,
      githubAttestationVerified: true,
      nativePlatformSignatureVerified: true,
    };
    expect(
      evaluateReleaseProvenanceIdentity({ claims: privateLookingProduction, expected }).reason,
    ).toBe('repository_private');
  });

  test('rejects pinned identity and artifact subject mismatches', () => {
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: { ...claims(), repositoryId: 'R_wrong' },
        expected,
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('claims_invalid'));
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: claims(),
        expected: { ...expected, artifactDigest: B },
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('identity_mismatch'));
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: { ...claims(), runAttempt: 0 },
        expected,
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('claims_invalid'));
  });

  test('rejects branches, unpinned workflow refs and unknown claims', () => {
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: { ...claims(), ref: 'refs/heads/main' },
        expected,
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('claims_invalid'));
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: {
          ...claims(),
          workflowRef: `${PINNED_RELEASE_REPOSITORY}/${PINNED_RELEASE_WORKFLOW_PATH}@refs/heads/main`,
        },
        expected,
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('claims_invalid'));
    expect(() =>
      evaluateReleaseProvenanceIdentity({
        claims: { ...claims(), syntheticApproval: true },
        expected,
      }),
    ).toThrow(new ReleaseProvenanceIdentityError('claims_invalid'));
  });
});
