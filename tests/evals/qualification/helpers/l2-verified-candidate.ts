import type { L2NativeCandidateIdentityV1 } from '../../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import { STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1 } from '../../../../src/app/release/standalone-keyring-unavailable';

/** Test-only structural stand-in for a runtime result already verified by the candidate verifier. */
export function verifiedCandidateWithStandaloneKeyringMarkerV1(
  candidate: L2NativeCandidateIdentityV1,
): unknown {
  const suffix = candidate.target.platform === 'win32' ? '.exe' : '';
  const executable = new TextEncoder().encode(
    `fixture-standalone-binary:${STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1}`,
  );
  return {
    archivePath: 'candidate.tar.gz',
    archiveSha256: candidate.artifact.payloadSha256,
    manifest: {
      commitSha: candidate.artifact.commit,
      target: {
        id: candidate.target.candidateTargetId,
        os: candidate.target.platform,
        arch: candidate.target.arch,
      },
    },
    manifestBytes: new Uint8Array(),
    manifestSha256: candidate.artifact.canonicalManifestDigest,
    candidateId: 'l2-verified-candidate-fixture',
    files: new Map<string, Uint8Array>([
      [`bin/kite${suffix}`, executable],
      [`bin/kite-tui${suffix}`, executable],
    ]),
  };
}
