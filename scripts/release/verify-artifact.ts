import { resolve } from 'node:path';
import { type VerifiedSyntheticArtifact, verifyBootstrapArtifact } from './bootstrap-verifier';

/**
 * Storage-level verification entrypoint. This validates the exact same bytes as
 * the bootstrap verifier and never executes the payload.
 */
export function verifySyntheticReleaseArtifact(directory: string): VerifiedSyntheticArtifact {
  return verifyBootstrapArtifact(directory);
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? 'dist/release-synthetic');
  const verified = verifySyntheticReleaseArtifact(directory);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'verified_synthetic_fixture',
        productionArtifact: false,
        distributable: verified.signature.distributable,
        realSigstoreSigningEnabled: verified.signature.realSigstoreSigningEnabled,
        payloadSha256: verified.manifest.payloadSha256,
        manifestSha256: verified.signature.manifestSha256,
      },
      null,
      2,
    )}\n`,
  );
}
