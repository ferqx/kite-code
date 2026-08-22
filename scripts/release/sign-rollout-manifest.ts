import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  disableOnlyRolloutManifestV1Schema,
  encodeDisableOnlyRolloutManifestV1,
  encodeSyntheticRolloutSignatureV1,
  type SyntheticRolloutSignatureV1,
} from '../../apps/kite/src/release/rollout-manifest-loader';
import { parseCanonicalJson, sha256Digest } from './canonical-json';

const SYNTHETIC_ROLLOUT_PRIVATE_KEYS = Object.freeze({
  'kite-rollout-fixture-2026-a': `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`,
  'kite-rollout-fixture-2026-b': `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/
-----END PRIVATE KEY-----
`,
});

export interface SignedSyntheticRolloutFixtureV1 {
  manifestBytes: Uint8Array;
  signature: SyntheticRolloutSignatureV1;
  signatureBytes: Uint8Array;
}

/**
 * Test-only signer. Both private keys are deliberately committed fixtures and
 * can never establish production authenticity or distributable authority.
 */
export function signSyntheticRolloutManifestV1(
  manifestValue: unknown,
): SignedSyntheticRolloutFixtureV1 {
  const manifest = disableOnlyRolloutManifestV1Schema.parse(manifestValue);
  const manifestBytes = encodeDisableOnlyRolloutManifestV1(manifest);
  const privateKey = SYNTHETIC_ROLLOUT_PRIVATE_KEYS[manifest.keyId];
  const signature: SyntheticRolloutSignatureV1 = {
    version: 1,
    kind: 'synthetic-rollout-ed25519-fixture-v1',
    keyId: manifest.keyId,
    manifestSha256: sha256Digest(manifestBytes),
    signatureBase64: sign(null, manifestBytes, createPrivateKey(privateKey)).toString('base64'),
    nonDistributable: true,
    realRolloutSigningEnabled: false,
  };
  return {
    manifestBytes,
    signature,
    signatureBytes: encodeSyntheticRolloutSignatureV1(signature),
  };
}

if (import.meta.main) {
  const manifestPath = resolve(process.argv[2] ?? 'rollout-manifest.json');
  const signaturePath = resolve(process.argv[3] ?? 'rollout-manifest.sig.json');
  const manifest = parseCanonicalJson(readFileSync(manifestPath));
  const signed = signSyntheticRolloutManifestV1(manifest);
  writeFileSync(signaturePath, signed.signatureBytes, { mode: 0o600, flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify({ mode: 'synthetic_non_distributable', realRolloutSigningEnabled: false, manifestSha256: signed.signature.manifestSha256 })}\n`,
  );
}
