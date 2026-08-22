import { createPublicKey } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJsonBytes, parseCanonicalJson, sha256Digest } from './canonical-json';

export const RELEASE_PAYLOAD_FILE = 'payload.bin';
export const RELEASE_MANIFEST_FILE = 'manifest.json';
export const RELEASE_SIGNATURE_FILE = 'manifest.sigstore.json';

export const SYNTHETIC_SIGNATURE_KIND = 'synthetic-ed25519-fixture-v1';
export const SYNTHETIC_TRUST_ROOT_ID = 'kite-code-release-fixture-v1';
export const SYNTHETIC_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
-----END PUBLIC KEY-----
`;

export const SYNTHETIC_PUBLIC_KEY_SHA256 = sha256Digest(
  createPublicKey(SYNTHETIC_PUBLIC_KEY_PEM).export({ format: 'der', type: 'spki' }),
);

const RELEASE_MANIFEST_KEYS = [
  'agentContractDigest',
  'buildRecipeDigest',
  'buildTimestamp',
  'behaviorDigest',
  'bunVersion',
  'commitSha',
  'defaultConfigDigest',
  'lockfileDigest',
  'modelVisibleToolRegistryDigest',
  'payloadSha256',
  'productVersion',
  'providerDataPolicyDigest',
  'releaseGatePolicyDigest',
  'releaseProfileDigest',
  'runtimeSchedulingPolicyDigest',
  'runtimeSchemaVersion',
  'supportedPlatforms',
  'supportedProviderTypes',
  'version',
] as const;

const SYNTHETIC_SIGNATURE_KEYS = [
  'algorithm',
  'distributable',
  'kind',
  'manifestSha256',
  'publicKeySha256',
  'realSigstoreSigningEnabled',
  'signatureBase64',
  'signedObject',
  'trustRootId',
  'version',
] as const;

export interface ReleaseManifestV1 {
  version: 1;
  productVersion: string;
  commitSha: string;
  buildTimestamp: string;
  bunVersion: string;
  payloadSha256: `sha256:${string}`;
  releaseProfileDigest: `sha256:${string}`;
  lockfileDigest: `sha256:${string}`;
  agentContractDigest: `sha256:${string}`;
  modelVisibleToolRegistryDigest: `sha256:${string}`;
  defaultConfigDigest: `sha256:${string}`;
  providerDataPolicyDigest: `sha256:${string}`;
  releaseGatePolicyDigest: `sha256:${string}`;
  runtimeSchedulingPolicyDigest: `sha256:${string}`;
  buildRecipeDigest: `sha256:${string}`;
  behaviorDigest: `sha256:${string}`;
  runtimeSchemaVersion: number;
  supportedPlatforms: string[];
  supportedProviderTypes: string[];
}

/**
 * A deliberately non-distributable signature fixture. The filename reserves
 * the detached bundle slot, but this object is not a Sigstore production bundle.
 */
export interface SyntheticSignatureBundleV1 {
  version: 1;
  kind: typeof SYNTHETIC_SIGNATURE_KIND;
  signedObject: 'canonical-release-manifest-v1';
  algorithm: 'ed25519';
  trustRootId: typeof SYNTHETIC_TRUST_ROOT_ID;
  publicKeySha256: `sha256:${string}`;
  manifestSha256: `sha256:${string}`;
  signatureBase64: string;
  distributable: false;
  realSigstoreSigningEnabled: false;
}

export interface ReleaseArtifactLayout {
  directory: string;
  payload: string;
  manifest: string;
  signature: string;
}

export type ReleaseArtifactErrorCode =
  | 'canonical_invalid'
  | 'layout_invalid'
  | 'payload_digest_mismatch'
  | 'schema_invalid'
  | 'signature_invalid';

export class ReleaseArtifactError extends Error {
  readonly code: ReleaseArtifactErrorCode;

  constructor(code: ReleaseArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ReleaseArtifactError';
    this.code = code;
  }
}

export function releaseArtifactLayout(directory: string): ReleaseArtifactLayout {
  const absolute = resolve(directory);
  return {
    directory: absolute,
    payload: resolve(absolute, RELEASE_PAYLOAD_FILE),
    manifest: resolve(absolute, RELEASE_MANIFEST_FILE),
    signature: resolve(absolute, RELEASE_SIGNATURE_FILE),
  };
}

export function encodeReleaseManifest(manifest: ReleaseManifestV1): Uint8Array {
  validateReleaseManifest(manifest);
  return canonicalJsonBytes(manifest);
}

export function decodeReleaseManifest(input: string | Uint8Array): ReleaseManifestV1 {
  let value: unknown;
  try {
    value = parseCanonicalJson(input);
  } catch (error) {
    throw canonicalArtifactError(error, 'manifest');
  }
  validateReleaseManifest(value);
  return value;
}

export function encodeSyntheticSignature(bundle: SyntheticSignatureBundleV1): Uint8Array {
  validateSyntheticSignatureBundle(bundle);
  return canonicalJsonBytes(bundle);
}

export function decodeSyntheticSignature(input: string | Uint8Array): SyntheticSignatureBundleV1 {
  let value: unknown;
  try {
    value = parseCanonicalJson(input);
  } catch (error) {
    throw canonicalArtifactError(error, 'detached signature bundle');
  }
  validateSyntheticSignatureBundle(value);
  return value;
}

export function validateReleaseManifest(value: unknown): asserts value is ReleaseManifestV1 {
  const manifest = expectExactObject(value, RELEASE_MANIFEST_KEYS, 'ReleaseManifestV1');
  if (manifest.version !== 1) schemaError('ReleaseManifestV1.version must equal 1.');
  expectNonEmptyString(manifest.productVersion, 'productVersion');
  if (typeof manifest.commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commitSha)) {
    schemaError('ReleaseManifestV1.commitSha must be a lowercase 40-character Git SHA.');
  }
  if (
    typeof manifest.buildTimestamp !== 'string' ||
    !isCanonicalTimestamp(manifest.buildTimestamp)
  ) {
    schemaError('ReleaseManifestV1.buildTimestamp must be a canonical UTC ISO timestamp.');
  }
  expectNonEmptyString(manifest.bunVersion, 'bunVersion');
  for (const field of [
    'payloadSha256',
    'releaseProfileDigest',
    'lockfileDigest',
    'agentContractDigest',
    'modelVisibleToolRegistryDigest',
    'defaultConfigDigest',
    'providerDataPolicyDigest',
    'releaseGatePolicyDigest',
    'runtimeSchedulingPolicyDigest',
    'buildRecipeDigest',
    'behaviorDigest',
  ] as const) {
    expectSha256(manifest[field], field);
  }
  if (
    typeof manifest.runtimeSchemaVersion !== 'number' ||
    !Number.isSafeInteger(manifest.runtimeSchemaVersion) ||
    manifest.runtimeSchemaVersion < 1
  ) {
    schemaError('ReleaseManifestV1.runtimeSchemaVersion must be a positive safe integer.');
  }
  expectSortedUniqueStrings(manifest.supportedPlatforms, 'supportedPlatforms');
  expectSortedUniqueStrings(manifest.supportedProviderTypes, 'supportedProviderTypes');
}

export function validateSyntheticSignatureBundle(
  value: unknown,
): asserts value is SyntheticSignatureBundleV1 {
  const bundle = expectExactObject(value, SYNTHETIC_SIGNATURE_KEYS, 'SyntheticSignatureBundleV1');
  if (bundle.version !== 1) schemaError('Synthetic signature version must equal 1.');
  if (bundle.kind !== SYNTHETIC_SIGNATURE_KIND) {
    schemaError('Only the non-distributable synthetic signature fixture is accepted.');
  }
  if (bundle.signedObject !== 'canonical-release-manifest-v1') {
    schemaError('Synthetic signature signedObject is invalid.');
  }
  if (bundle.algorithm !== 'ed25519') schemaError('Synthetic signature algorithm is invalid.');
  if (bundle.trustRootId !== SYNTHETIC_TRUST_ROOT_ID) {
    schemaError('Synthetic signature trust root is not pinned.');
  }
  if (bundle.publicKeySha256 !== SYNTHETIC_PUBLIC_KEY_SHA256) {
    schemaError('Synthetic signature public key digest does not match the pinned fixture root.');
  }
  expectSha256(bundle.manifestSha256, 'manifestSha256');
  if (bundle.distributable !== false || bundle.realSigstoreSigningEnabled !== false) {
    schemaError('Synthetic signatures must remain non-distributable with real Sigstore disabled.');
  }
  if (typeof bundle.signatureBase64 !== 'string' || !isCanonicalBase64(bundle.signatureBase64)) {
    schemaError('Synthetic signature must be canonical base64.');
  }
  if (Buffer.from(bundle.signatureBase64, 'base64').byteLength !== 64) {
    schemaError('Synthetic Ed25519 signature must be 64 bytes.');
  }
}

function canonicalArtifactError(error: unknown, subject: string): ReleaseArtifactError {
  const message = error instanceof Error ? error.message : String(error);
  return new ReleaseArtifactError('canonical_invalid', `Invalid canonical ${subject}: ${message}`);
}

function expectExactObject<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
  label: string,
): Record<Keys[number], unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    schemaError(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    schemaError(`${label} has missing or unknown fields.`);
  }
  return value as Record<Keys[number], unknown>;
}

function expectNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    schemaError(`ReleaseManifestV1.${field} must be a non-empty bounded string.`);
  }
}

function expectSha256(value: unknown, field: string): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    schemaError(`${field} must be a lowercase sha256 digest.`);
  }
}

function expectSortedUniqueStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    schemaError(`ReleaseManifestV1.${field} must be an array of non-empty strings.`);
  }
  const sorted = [...value].sort(compareStrings);
  if (value.some((entry, index) => entry !== sorted[index] || entry === value[index - 1])) {
    schemaError(`ReleaseManifestV1.${field} must be sorted and unique.`);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value;
}

function schemaError(message: string): never {
  throw new ReleaseArtifactError('schema_invalid', message);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
