import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';
import {
  parseReleaseEvidence,
  type ReleaseEvidence,
  releaseEvidenceSchema,
} from './evidence-schema';

const RELEASE_EVIDENCE_DIGEST_DOMAIN = 'release-evidence-bundle-v1';

export type ReleaseEvidenceBundleInput = Omit<ReleaseEvidence, 'bundleDigest'>;

export function computeReleaseEvidenceBundleDigest(
  input: ReleaseEvidenceBundleInput,
): `sha256:${string}` {
  return sha256DomainSeparated(RELEASE_EVIDENCE_DIGEST_DOMAIN, canonicalJsonBytes(input));
}

export function buildReleaseEvidenceBundle(input: ReleaseEvidenceBundleInput): ReleaseEvidence {
  const candidate = {
    ...input,
    bundleDigest: computeReleaseEvidenceBundleDigest(input),
  };
  return releaseEvidenceSchema.parse(candidate);
}

export function verifyReleaseEvidenceBundle(value: unknown): ReleaseEvidence {
  const parsed = parseReleaseEvidence(value);
  const { bundleDigest, ...material } = parsed;
  const expected = computeReleaseEvidenceBundleDigest(material);
  if (bundleDigest !== expected) {
    throw new Error(`Release evidence bundle digest mismatch: expected ${expected}.`);
  }
  return parsed;
}
