import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';
import {
  parseReleaseEvidenceV1,
  type ReleaseEvidenceV1,
  releaseEvidenceV1Schema,
} from './evidence-schema';

const RELEASE_EVIDENCE_DIGEST_DOMAIN = 'release-evidence-bundle-v1';

export type ReleaseEvidenceBundleInputV1 = Omit<ReleaseEvidenceV1, 'bundleDigest'>;

export function computeReleaseEvidenceBundleDigestV1(
  input: ReleaseEvidenceBundleInputV1,
): `sha256:${string}` {
  return sha256DomainSeparated(RELEASE_EVIDENCE_DIGEST_DOMAIN, canonicalJsonBytes(input));
}

export function buildReleaseEvidenceBundleV1(
  input: ReleaseEvidenceBundleInputV1,
): ReleaseEvidenceV1 {
  const candidate = {
    ...input,
    bundleDigest: computeReleaseEvidenceBundleDigestV1(input),
  };
  return releaseEvidenceV1Schema.parse(candidate);
}

export function verifyReleaseEvidenceBundleV1(value: unknown): ReleaseEvidenceV1 {
  const parsed = parseReleaseEvidenceV1(value);
  const { bundleDigest, ...material } = parsed;
  const expected = computeReleaseEvidenceBundleDigestV1(material);
  if (bundleDigest !== expected) {
    throw new Error(`Release evidence bundle digest mismatch: expected ${expected}.`);
  }
  return parsed;
}
