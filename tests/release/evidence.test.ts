import { describe, expect, test } from 'bun:test';
import { sha256Digest } from '../../scripts/release/canonical-json';
import {
  buildReleaseEvidenceBundleV1,
  type ReleaseEvidenceBundleInputV1,
  verifyReleaseEvidenceBundleV1,
} from '../../scripts/release/evidence-bundle';
import {
  RELEASE_EVIDENCE_KINDS,
  RELEASE_EVIDENCE_SCHEMA,
  type ReleaseArtifactIdentityV1,
  releaseEvidenceV1Schema,
} from '../../scripts/release/evidence-schema';

const COMMIT = 'a'.repeat(40);
const NOW = '2026-08-02T01:00:00.000Z';

function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}

function artifactIdentity(): ReleaseArtifactIdentityV1 {
  return {
    canonicalRepository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    commit: COMMIT,
    payloadSha256: digest('payload'),
    canonicalManifestDigest: digest('manifest'),
    behaviorDigest: digest('behavior'),
    profileDigest: digest('profile'),
    gatePolicyDigest: digest('gate-policy'),
  };
}

function input(): ReleaseEvidenceBundleInputV1 {
  const identity = artifactIdentity();
  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    evidenceBundleId: 'synthetic-foundation-evidence-v1',
    generatedAt: NOW,
    artifactIdentity: identity,
    nonDistributable: true,
    syntheticTrustRoot: true,
    results: [
      {
        evidenceId: 'required-ci',
        kind: 'required_ci',
        gate: 'G1',
        status: 'passed',
        artifactIdentity: identity,
        executionIdentity: {
          source: 'local_synthetic',
          fixtureId: 'release-foundation-v1',
          runner: 'bun-test',
          commit: COMMIT,
          startedAt: '2026-08-02T00:59:00.000Z',
          endedAt: NOW,
        },
        suiteIdentity: 'tests/release/foundation-v1',
        record: {
          uri: 'https://example.invalid/evidence/required-ci.json',
          digest: digest('required-ci-record'),
        },
        summary: 'Synthetic contract fixture passed.',
      },
    ],
    risks: [],
    exceptions: [],
  };
}

describe('ReleaseEvidenceV1', () => {
  test('keeps limited cohort SLO distinct from later capability canary SLO evidence', () => {
    expect(RELEASE_EVIDENCE_KINDS).toContain('limited_slo');
    expect(RELEASE_EVIDENCE_KINDS).toContain('canary_slo');
  });

  test('builds and independently verifies a canonical identity-bound bundle', () => {
    const bundle = buildReleaseEvidenceBundleV1(input());
    expect(bundle.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyReleaseEvidenceBundleV1(structuredClone(bundle))).toEqual(bundle);
  });

  test('rejects digest tampering and result identity splicing', () => {
    const bundle = buildReleaseEvidenceBundleV1(input());
    expect(() =>
      verifyReleaseEvidenceBundleV1({ ...bundle, bundleDigest: digest('tampered') }),
    ).toThrow('digest mismatch');
    const otherIdentity = { ...bundle.artifactIdentity, payloadSha256: digest('other') };
    expect(() =>
      releaseEvidenceV1Schema.parse({
        ...bundle,
        results: [{ ...bundle.results[0], artifactIdentity: otherIdentity }],
      }),
    ).toThrow('exact bundle artifact identity');
  });

  test('keeps synthetic roots non-distributable and rejects G0/G1 exceptions', () => {
    const base = input();
    expect(() =>
      releaseEvidenceV1Schema.parse({
        ...buildReleaseEvidenceBundleV1(base),
        nonDistributable: false,
      }),
    ).toThrow('non-distributable');
    expect(() =>
      releaseEvidenceV1Schema.parse({
        ...buildReleaseEvidenceBundleV1(base),
        exceptions: [
          {
            exceptionId: 'waive-g1',
            evidenceId: 'required-ci',
            gate: 'G1',
            approvedBy: 'github:@ferqx',
            reason: 'not permitted',
            approvedAt: NOW,
            expiresAt: '2026-08-03T01:00:00.000Z',
            record: { uri: 'https://example.invalid/waiver', digest: digest('waiver') },
          },
        ],
      }),
    ).toThrow('cannot be waived');
  });

  test('rejects unknown fields that could smuggle raw user content', () => {
    const bundle = buildReleaseEvidenceBundleV1(input());
    expect(() => releaseEvidenceV1Schema.parse({ ...bundle, rawUserContent: 'secret' })).toThrow();
    expect(() =>
      releaseEvidenceV1Schema.parse({
        ...bundle,
        results: [{ ...bundle.results[0], transcript: 'secret' }],
      }),
    ).toThrow();
  });
});
