import { createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeReleaseManifest,
  decodeSyntheticSignature,
  ReleaseArtifactError,
  type ReleaseArtifactLayout,
  type ReleaseManifestV1,
  releaseArtifactLayout,
  SYNTHETIC_PUBLIC_KEY_PEM,
  type SyntheticSignatureBundleV1,
} from './artifact-layout';
import { sha256Digest } from './canonical-json';

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SIGNATURE_BUNDLE_BYTES = 128 * 1024;

export interface VerifiedSyntheticArtifact {
  layout: ReleaseArtifactLayout;
  manifest: ReleaseManifestV1;
  signature: SyntheticSignatureBundleV1;
  canonicalManifestBytes: Uint8Array;
  /** Execute/load only these verified bytes; do not reopen `layout.payload`. */
  payloadBytes: Uint8Array;
}

/**
 * Bootstrap trust boundary for the pre-public synthetic fixture.
 *
 * No payload code is loaded or invoked here. Schema, canonical bytes, pinned
 * fixture signature, and payload digest must all succeed first.
 */
export function verifyBootstrapArtifact(directory: string): VerifiedSyntheticArtifact {
  const layout = releaseArtifactLayout(directory);
  const manifestBytes = readRegularFile(layout.manifest, MAX_MANIFEST_BYTES, 'manifest');
  const signatureBytes = readRegularFile(
    layout.signature,
    MAX_SIGNATURE_BUNDLE_BYTES,
    'detached signature bundle',
  );
  const manifest = decodeReleaseManifest(manifestBytes);
  const signature = decodeSyntheticSignature(signatureBytes);

  if (signature.manifestSha256 !== sha256Digest(manifestBytes)) {
    throw new ReleaseArtifactError(
      'signature_invalid',
      'Detached signature subject digest does not match canonical manifest bytes.',
    );
  }
  const signatureValid = verify(
    null,
    manifestBytes,
    createPublicKey(SYNTHETIC_PUBLIC_KEY_PEM),
    Buffer.from(signature.signatureBase64, 'base64'),
  );
  if (!signatureValid) {
    throw new ReleaseArtifactError(
      'signature_invalid',
      'Detached synthetic fixture signature verification failed.',
    );
  }

  const payloadBytes = readRegularFile(layout.payload, undefined, 'payload');
  if (sha256Digest(payloadBytes) !== manifest.payloadSha256) {
    throw new ReleaseArtifactError(
      'payload_digest_mismatch',
      'Payload sha256 does not match ReleaseManifestV1.payloadSha256.',
    );
  }

  return {
    layout,
    manifest,
    signature,
    canonicalManifestBytes: new Uint8Array(manifestBytes),
    payloadBytes: new Uint8Array(payloadBytes),
  };
}

/** The callback is unreachable until the complete pre-exec verification succeeds. */
export function verifyBeforePayloadExecution<Result>(
  directory: string,
  executeVerifiedBytes: (artifact: VerifiedSyntheticArtifact) => Result,
): Result {
  const artifact = verifyBootstrapArtifact(directory);
  return executeVerifiedBytes(artifact);
}

function readRegularFile(
  path: string,
  maximumBytes: number | undefined,
  label: string,
): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ReleaseArtifactError(
      'layout_invalid',
      `Cannot open release ${label} without following links: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new ReleaseArtifactError('layout_invalid', `Release ${label} must be a regular file.`);
    }
    if (maximumBytes !== undefined && stats.size > maximumBytes) {
      throw new ReleaseArtifactError('layout_invalid', `Release ${label} exceeds its size limit.`);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    throw new ReleaseArtifactError(
      'layout_invalid',
      `Cannot read release ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    closeSync(descriptor);
  }
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? 'dist/release-synthetic');
  const verified = verifyBootstrapArtifact(directory);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'verified_synthetic_fixture',
        distributable: false,
        realSigstoreSigningEnabled: false,
        directory: verified.layout.directory,
        payloadSha256: verified.manifest.payloadSha256,
        manifestSha256: verified.signature.manifestSha256,
      },
      null,
      2,
    )}\n`,
  );
}
