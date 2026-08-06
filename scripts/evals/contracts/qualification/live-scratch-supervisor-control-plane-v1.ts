import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1 } from '../../../../release/qualification/l3-protected-scratch-supervisor-v1';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const L3_RESERVATION_ID =
  /^l3-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const L3_ALLOCATION_ID =
  /^l3-allocation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const L3_NONCE_CONSUMPTION_ID =
  /^l3-nonce-consumption-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const L3_PROTECTED_SCRATCH_SUPERVISOR_SERVICE_ID =
  'qualification-l3-protected-scratch-supervisor-v1' as const;
const NONCE = /^[a-f0-9]{32,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ATTESTATION_SECONDS = 60;
const MAX_NORMAL_EXIT_DELETE_MILLISECONDS = 1_000;
const CURRENT_EPHEMERAL_LOCAL_PROFILE_ID_V1 =
  'qualification-governance/ephemeral_local/v1' as const;
const CURRENT_EPHEMERAL_LOCAL_PROFILE_DIGEST_V1 =
  'sha256:84b74b5b3c54fac9d53a1f2c42524bee5cff27fce046e0f4b5737576e9a757b4' as const;

export const LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1 = 86_400;
export const LIVE_SCRATCH_SUPERVISOR_NORMAL_EXIT_DELETE_MILLISECONDS_V1 =
  MAX_NORMAL_EXIT_DELETE_MILLISECONDS;

const digestSchema = z.string().regex(DIGEST);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const signatureSchema = z.string().regex(BASE64).min(80).max(128);

const reservationIdSchema = z.string().regex(L3_RESERVATION_ID, {
  message: 'control-plane reservation id must be an opaque L3 UUIDv4 token',
});
const allocationIdSchema = z.string().regex(L3_ALLOCATION_ID, {
  message: 'control-plane allocation id must be an opaque service-generated UUIDv4 token',
});
const nonceConsumptionIdSchema = z.string().regex(L3_NONCE_CONSUMPTION_ID, {
  message: 'control-plane nonce-consumption id must be an opaque service-generated UUIDv4 token',
});
const serviceIdSchema = z.literal(L3_PROTECTED_SCRATCH_SUPERVISOR_SERVICE_ID);

function isOpaqueControlPlaneMetadata(value: string): boolean {
  return (
    L3_RESERVATION_ID.test(value) ||
    L3_ALLOCATION_ID.test(value) ||
    L3_NONCE_CONSUMPTION_ID.test(value) ||
    value === L3_PROTECTED_SCRATCH_SUPERVISOR_SERVICE_ID
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((value, index) => value === rightBytes[index])
  );
}

function timestampAtOrBefore(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs <= rightMs;
}

function timestampBefore(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs < rightMs;
}

function timestampIsAtOrBeforeDate(value: string, upperBound: Date): boolean {
  const valueMs = Date.parse(value);
  return (
    Number.isFinite(valueMs) &&
    Number.isFinite(upperBound.getTime()) &&
    valueMs <= upperBound.getTime()
  );
}

function expectedDeadline(allocatedAt: string): string | undefined {
  const allocatedAtMs = Date.parse(allocatedAt);
  if (!Number.isFinite(allocatedAtMs)) return undefined;
  const deadline = new Date(
    allocatedAtMs + LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1 * 1_000,
  );
  return Number.isFinite(deadline.getTime()) ? deadline.toISOString() : undefined;
}

function decodeEd25519Signature(value: string): Buffer | undefined {
  if (!BASE64.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.byteLength === 64 && decoded.toString('base64') === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function signatureMatches(input: {
  readonly publicKeyPem: string;
  readonly signingBytes: Uint8Array;
  readonly signature: string;
}): boolean {
  const signature = decodeEd25519Signature(input.signature);
  const publicKeyPem = canonicalEd25519PublicKeyPem(input.publicKeyPem);
  if (!signature || !publicKeyPem) return false;
  try {
    return verifySignature(null, Buffer.from(input.signingBytes), publicKeyPem, signature);
  } catch {
    return false;
  }
}

/** Accept only the canonical SPKI public encoding, never a private key. */
function canonicalEd25519PublicKeyPem(value: string): string | undefined {
  if (value.length === 0 || value.length > 8_192 || value.includes('\u0000')) return undefined;
  try {
    const key = createPublicKey(value);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return undefined;
    const canonicalPem = key.export({ type: 'spki', format: 'pem' }).toString();
    return canonicalPem === value ? canonicalPem : undefined;
  } catch {
    return undefined;
  }
}

/** A raw nonce is caller memory only; every retained record stores this digest. */
export function computeLiveScratchSupervisorNonceDigestV1(nonce: string): `sha256:${string}` {
  if (!NONCE.test(nonce)) throw new Error('live_scratch_supervisor_nonce_invalid');
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-supervisor-nonce.v1',
    new TextEncoder().encode(nonce),
  );
}

/** The root-protected manifest binds only a digest of its public attestation key. */
export function computeL3ProtectedScratchSupervisorPublicKeyDigestV1(
  publicKeyPem: string,
): `sha256:${string}` {
  const canonicalPem = canonicalEd25519PublicKeyPem(publicKeyPem);
  if (!canonicalPem) {
    throw new Error('l3_protected_scratch_supervisor_public_key_invalid');
  }
  return sha256DomainSeparated(
    'kite.qualification.l3-protected-scratch-supervisor-public-key.v1',
    new TextEncoder().encode(canonicalPem),
  );
}

/**
 * Metadata-only binding shared by the root-private recovery commitment and
 * the owner-only signed lifecycle-receipt projection. It has no path, PID,
 * UID, command, endpoint, credential, prompt, response, reasoning, source,
 * workspace, session, or child-output position.
 */
const liveScratchSupervisorGovernanceBindingV1Schema = z
  .object({
    profileId: z.literal(CURRENT_EPHEMERAL_LOCAL_PROFILE_ID_V1),
    profileDigest: z.literal(CURRENT_EPHEMERAL_LOCAL_PROFILE_DIGEST_V1),
    retentionClass: z.literal('ephemeral_local'),
    retention: z
      .object({
        maxAgeSeconds: z.literal(LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1),
        deleteTrigger: z.literal('process_exit'),
      })
      .strict(),
    storage: z
      .object({
        acl: z.literal('local_owner_only'),
        encryption: z.literal('local_owner_disk_encryption'),
        audit: z.literal('local_metadata_audit'),
      })
      .strict(),
    issuePublication: z.literal('default_deny'),
    requiredAuthorizer: z.literal('local_owner'),
    quotaLedgerDigests: z.object({ day: digestSchema, month: digestSchema }).strict(),
    retentionWitnessDigest: digestSchema,
    ownerOnlyReceiptProjectionPolicyDigest: digestSchema,
  })
  .strict();

export type LiveScratchSupervisorGovernanceBindingV1 = z.infer<
  typeof liveScratchSupervisorGovernanceBindingV1Schema
>;

export const liveScratchLifecycleBindingV1Schema = z
  .object({
    candidateClosureDigest: digestSchema,
    executionDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    corpusDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    governance: liveScratchSupervisorGovernanceBindingV1Schema,
    routePolicyDigest: digestSchema,
    workerBundleDigest: digestSchema,
    serviceEpochDigest: digestSchema,
    reservationId: reservationIdSchema,
    leaseFingerprint: digestSchema,
    journalPredecessorDigest: digestSchema,
    scratchHandleDigest: digestSchema,
  })
  .strict();

export type LiveScratchLifecycleBindingV1 = z.infer<typeof liveScratchLifecycleBindingV1Schema>;

export function computeLiveScratchLifecycleBindingDigestV1(
  binding: LiveScratchLifecycleBindingV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-lifecycle-binding.v1',
    canonicalJsonBytes(liveScratchLifecycleBindingV1Schema.parse(binding)),
  );
}

const protectedManifestMaterialV1Schema = z
  .object({
    schema: z.literal('L3ProtectedScratchSupervisorManifestV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    deploymentDigest: digestSchema,
    serviceId: serviceIdSchema,
    protocolDigest: digestSchema,
    daemonBundleDigest: digestSchema,
    workerBundleDigest: digestSchema,
    nativeCleanupHelperDigest: digestSchema,
    fixtureRegistryDigest: digestSchema,
    policyRegistryDigest: digestSchema,
    runnerBindingDigest: digestSchema,
    journalSchemaDigest: digestSchema,
    attestationPublicKeyDigest: digestSchema,
    crashRecoverySeconds: z.literal(LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1),
    normalExitDeleteMilliseconds: z.literal(MAX_NORMAL_EXIT_DELETE_MILLISECONDS),
    maintainerPeerAuthorization: z.literal('root_manifest_allowlist_only'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.deploymentDigest !== L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest) {
      context.addIssue({
        code: 'custom',
        path: ['deploymentDigest'],
        message: 'manifest must bind the exact source-owned protected deployment declaration',
      });
    }
  });

export type L3ProtectedScratchSupervisorManifestMaterialV1 = z.infer<
  typeof protectedManifestMaterialV1Schema
>;

export function computeL3ProtectedScratchSupervisorManifestDigestV1(
  material: L3ProtectedScratchSupervisorManifestMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l3-protected-scratch-supervisor-manifest.v1',
    canonicalJsonBytes(protectedManifestMaterialV1Schema.parse(material)),
  );
}

export const l3ProtectedScratchSupervisorManifestV1Schema = protectedManifestMaterialV1Schema
  .extend({ manifestDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { manifestDigest, ...material } = value;
    try {
      if (manifestDigest === computeL3ProtectedScratchSupervisorManifestDigestV1(material)) return;
      context.addIssue({
        code: 'custom',
        path: ['manifestDigest'],
        message: 'protected supervisor manifest digest mismatch',
      });
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'protected supervisor manifest material invalid',
      });
    }
  });

export type L3ProtectedScratchSupervisorManifestV1 = z.infer<
  typeof l3ProtectedScratchSupervisorManifestV1Schema
>;

export function buildL3ProtectedScratchSupervisorManifestV1(
  material: L3ProtectedScratchSupervisorManifestMaterialV1,
): L3ProtectedScratchSupervisorManifestV1 {
  const parsed = protectedManifestMaterialV1Schema.parse(material);
  return l3ProtectedScratchSupervisorManifestV1Schema.parse({
    ...parsed,
    manifestDigest: computeL3ProtectedScratchSupervisorManifestDigestV1(parsed),
  });
}

const attestationUnsignedMaterialV1Schema = z
  .object({
    schema: z.literal('LiveScratchSupervisorAttestationV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    manifestDigest: digestSchema,
    serviceEpochDigest: digestSchema,
    nonceDigest: digestSchema,
    requestBindingDigest: digestSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    signatureAlgorithm: z.literal('ed25519'),
  })
  .strict()
  .superRefine((value, context) => {
    const issuedAtMs = Date.parse(value.issuedAt);
    const expiresAtMs = Date.parse(value.expiresAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_ATTESTATION_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'attestation must be short-lived and expire after issuance',
      });
    }
  });

export type LiveScratchSupervisorAttestationUnsignedMaterialV1 = z.infer<
  typeof attestationUnsignedMaterialV1Schema
>;

export function liveScratchSupervisorAttestationSigningBytesV1(
  material: LiveScratchSupervisorAttestationUnsignedMaterialV1,
): Uint8Array {
  return canonicalJsonBytes(attestationUnsignedMaterialV1Schema.parse(material));
}

const attestationMaterialV1Schema = attestationUnsignedMaterialV1Schema
  .extend({ serviceSignature: signatureSchema })
  .strict();
export type LiveScratchSupervisorAttestationMaterialV1 = z.infer<
  typeof attestationMaterialV1Schema
>;

export function computeLiveScratchSupervisorAttestationDigestV1(
  material: LiveScratchSupervisorAttestationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-supervisor-attestation.v1',
    canonicalJsonBytes(attestationMaterialV1Schema.parse(material)),
  );
}

export const liveScratchSupervisorAttestationV1Schema = attestationMaterialV1Schema
  .extend({ attestationDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { attestationDigest, ...material } = value;
    try {
      if (attestationDigest === computeLiveScratchSupervisorAttestationDigestV1(material)) return;
      context.addIssue({
        code: 'custom',
        path: ['attestationDigest'],
        message: 'attestation digest mismatch',
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'attestation material invalid' });
    }
  });

export type LiveScratchSupervisorAttestationV1 = z.infer<
  typeof liveScratchSupervisorAttestationV1Schema
>;

export function buildLiveScratchSupervisorAttestationV1(
  material: LiveScratchSupervisorAttestationMaterialV1,
): LiveScratchSupervisorAttestationV1 {
  const parsed = attestationMaterialV1Schema.parse(material);
  return liveScratchSupervisorAttestationV1Schema.parse({
    ...parsed,
    attestationDigest: computeLiveScratchSupervisorAttestationDigestV1(parsed),
  });
}

/**
 * This verifies an Ed25519 service attestation against a public key whose
 * digest is pinned by the root-protected manifest. It is a pure verifier: it
 * cannot discover or trust a host manifest by itself and never activates a
 * runner.
 */
export function verifyLiveScratchSupervisorAttestationV1(input: {
  readonly attestation: unknown;
  readonly manifest: unknown;
  readonly trustedManifestDigest: string;
  readonly expectedNonce: string;
  readonly expectedRequestBindingDigest: string;
  readonly expectedServiceEpochDigest: string;
  readonly trustedPublicKeyPem: string;
  readonly now: Date;
}): boolean {
  const attestation = liveScratchSupervisorAttestationV1Schema.safeParse(input.attestation);
  const manifest = l3ProtectedScratchSupervisorManifestV1Schema.safeParse(input.manifest);
  if (!attestation.success || !manifest.success || !Number.isFinite(input.now.getTime()))
    return false;
  const expectedNonceDigest = (() => {
    try {
      return computeLiveScratchSupervisorNonceDigestV1(input.expectedNonce);
    } catch {
      return undefined;
    }
  })();
  const trustedPublicKeyDigest = (() => {
    try {
      return computeL3ProtectedScratchSupervisorPublicKeyDigestV1(input.trustedPublicKeyPem);
    } catch {
      return undefined;
    }
  })();
  const nowMs = input.now.getTime();
  const issuedAtMs = Date.parse(attestation.data.issuedAt);
  const expiresAtMs = Date.parse(attestation.data.expiresAt);
  if (
    !expectedNonceDigest ||
    !trustedPublicKeyDigest ||
    manifest.data.manifestDigest !== input.trustedManifestDigest ||
    attestation.data.manifestDigest !== manifest.data.manifestDigest ||
    attestation.data.nonceDigest !== expectedNonceDigest ||
    attestation.data.requestBindingDigest !== input.expectedRequestBindingDigest ||
    attestation.data.serviceEpochDigest !== input.expectedServiceEpochDigest ||
    manifest.data.attestationPublicKeyDigest !== trustedPublicKeyDigest ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    nowMs < issuedAtMs ||
    nowMs >= expiresAtMs
  ) {
    return false;
  }
  const { attestationDigest: _attestationDigest, serviceSignature, ...unsigned } = attestation.data;
  return signatureMatches({
    publicKeyPem: input.trustedPublicKeyPem,
    signingBytes: liveScratchSupervisorAttestationSigningBytesV1(unsigned),
    signature: serviceSignature,
  });
}

const journalSequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Root-private, fsynced pre-allocation record for the one nonce that a future
 * service atomically consumes. The nonce remains only in caller memory; the
 * record has its domain-separated digest. This record is never a public
 * observation or release input.
 */
const nonceConsumptionUnsignedMaterialV1Schema = z
  .object({
    schema: z.literal('LiveScratchSupervisorNonceConsumptionV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    consumptionId: nonceConsumptionIdSchema,
    allocationId: allocationIdSchema,
    manifestDigest: digestSchema,
    attestationDigest: digestSchema,
    serviceEpochDigest: digestSchema,
    nonceDigest: digestSchema,
    requestBindingDigest: digestSchema,
    reservationId: reservationIdSchema,
    leaseFingerprint: digestSchema,
    journalPredecessorDigest: digestSchema,
    journalSequence: journalSequenceSchema,
    consumedAt: isoTimestampSchema,
    consumptionState: z.literal('root_private_atomic_single_use_fsynced'),
    signatureAlgorithm: z.literal('ed25519'),
  })
  .strict();

export type LiveScratchSupervisorNonceConsumptionUnsignedMaterialV1 = z.infer<
  typeof nonceConsumptionUnsignedMaterialV1Schema
>;

export function liveScratchSupervisorNonceConsumptionSigningBytesV1(
  material: LiveScratchSupervisorNonceConsumptionUnsignedMaterialV1,
): Uint8Array {
  return canonicalJsonBytes(nonceConsumptionUnsignedMaterialV1Schema.parse(material));
}

const nonceConsumptionMaterialV1Schema = nonceConsumptionUnsignedMaterialV1Schema
  .extend({ serviceSignature: signatureSchema })
  .strict();
export type LiveScratchSupervisorNonceConsumptionMaterialV1 = z.infer<
  typeof nonceConsumptionMaterialV1Schema
>;

export function computeLiveScratchSupervisorNonceConsumptionDigestV1(
  material: LiveScratchSupervisorNonceConsumptionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-supervisor-nonce-consumption.v1',
    canonicalJsonBytes(nonceConsumptionMaterialV1Schema.parse(material)),
  );
}

export const liveScratchSupervisorNonceConsumptionV1Schema = nonceConsumptionMaterialV1Schema
  .extend({ nonceConsumptionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { nonceConsumptionDigest, ...material } = value;
    try {
      if (nonceConsumptionDigest === computeLiveScratchSupervisorNonceConsumptionDigestV1(material))
        return;
      context.addIssue({
        code: 'custom',
        path: ['nonceConsumptionDigest'],
        message: 'nonce-consumption digest mismatch',
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'nonce-consumption material invalid' });
    }
  });

export type LiveScratchSupervisorNonceConsumptionV1 = z.infer<
  typeof liveScratchSupervisorNonceConsumptionV1Schema
>;

export function buildLiveScratchSupervisorNonceConsumptionV1(
  material: LiveScratchSupervisorNonceConsumptionMaterialV1,
): LiveScratchSupervisorNonceConsumptionV1 {
  const parsed = nonceConsumptionMaterialV1Schema.parse(material);
  return liveScratchSupervisorNonceConsumptionV1Schema.parse({
    ...parsed,
    nonceConsumptionDigest: computeLiveScratchSupervisorNonceConsumptionDigestV1(parsed),
  });
}

/**
 * A signed query projection of the root-private, append-only nonce index. It
 * proves the exact set of allocations recorded for one nonce at `indexedAt`.
 * It is verifier input only: it is deliberately not embedded in an owner-only
 * lifecycle receipt or any qualification observation.
 */
const nonceConsumptionIndexUnsignedMaterialV1Schema = z
  .object({
    schema: z.literal('LiveScratchSupervisorNonceConsumptionIndexV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    manifestDigest: digestSchema,
    serviceEpochDigest: digestSchema,
    nonceDigest: digestSchema,
    requestBindingDigest: digestSchema,
    reservationId: reservationIdSchema,
    leaseFingerprint: digestSchema,
    indexedAt: isoTimestampSchema,
    indexCoverage: z.literal('complete_nonce_scope_at_indexed_at'),
    indexState: z.literal('root_private_atomic_single_use_index'),
    observedNonceConsumptionCount: z.number().int().min(1).max(64),
    observedUniqueAllocationCount: z.number().int().min(1).max(64),
    indexedConsumptionDigests: z.array(digestSchema).min(1).max(64),
    indexedAllocationIds: z.array(allocationIdSchema).min(1).max(64),
    journalHeadDigest: digestSchema,
    journalHeadSequence: journalSequenceSchema,
    signatureAlgorithm: z.literal('ed25519'),
  })
  .strict()
  .superRefine((value, context) => {
    const uniqueAllocationCount = new Set(value.indexedAllocationIds).size;
    if (value.observedNonceConsumptionCount !== value.indexedConsumptionDigests.length) {
      context.addIssue({
        code: 'custom',
        path: ['observedNonceConsumptionCount'],
        message: 'nonce-index consumption count must match its complete digest projection',
      });
    }
    if (value.observedUniqueAllocationCount !== uniqueAllocationCount) {
      context.addIssue({
        code: 'custom',
        path: ['observedUniqueAllocationCount'],
        message: 'nonce-index allocation count must match its complete allocation projection',
      });
    }
    if (value.indexedAllocationIds.length !== value.indexedConsumptionDigests.length) {
      context.addIssue({
        code: 'custom',
        message:
          'nonce-index allocation and consumption projections must remain positionally complete',
      });
    }
    if (!value.indexedConsumptionDigests.includes(value.journalHeadDigest)) {
      context.addIssue({
        code: 'custom',
        path: ['journalHeadDigest'],
        message: 'nonce-index journal head must be one of its nonce-scoped consumption records',
      });
    }
  });

export type LiveScratchSupervisorNonceConsumptionIndexUnsignedMaterialV1 = z.infer<
  typeof nonceConsumptionIndexUnsignedMaterialV1Schema
>;

export function liveScratchSupervisorNonceConsumptionIndexSigningBytesV1(
  material: LiveScratchSupervisorNonceConsumptionIndexUnsignedMaterialV1,
): Uint8Array {
  return canonicalJsonBytes(nonceConsumptionIndexUnsignedMaterialV1Schema.parse(material));
}

const nonceConsumptionIndexMaterialV1Schema = nonceConsumptionIndexUnsignedMaterialV1Schema
  .extend({ serviceSignature: signatureSchema })
  .strict();
export type LiveScratchSupervisorNonceConsumptionIndexMaterialV1 = z.infer<
  typeof nonceConsumptionIndexMaterialV1Schema
>;

export function computeLiveScratchSupervisorNonceConsumptionIndexDigestV1(
  material: LiveScratchSupervisorNonceConsumptionIndexMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-supervisor-nonce-consumption-index.v1',
    canonicalJsonBytes(nonceConsumptionIndexMaterialV1Schema.parse(material)),
  );
}

export const liveScratchSupervisorNonceConsumptionIndexV1Schema =
  nonceConsumptionIndexMaterialV1Schema
    .extend({ nonceConsumptionIndexDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { nonceConsumptionIndexDigest, ...material } = value;
      try {
        if (
          nonceConsumptionIndexDigest ===
          computeLiveScratchSupervisorNonceConsumptionIndexDigestV1(material)
        ) {
          return;
        }
        context.addIssue({
          code: 'custom',
          path: ['nonceConsumptionIndexDigest'],
          message: 'nonce-consumption index digest mismatch',
        });
      } catch {
        context.addIssue({ code: 'custom', message: 'nonce-consumption index material invalid' });
      }
    });

export type LiveScratchSupervisorNonceConsumptionIndexV1 = z.infer<
  typeof liveScratchSupervisorNonceConsumptionIndexV1Schema
>;

export function buildLiveScratchSupervisorNonceConsumptionIndexV1(
  material: LiveScratchSupervisorNonceConsumptionIndexMaterialV1,
): LiveScratchSupervisorNonceConsumptionIndexV1 {
  const parsed = nonceConsumptionIndexMaterialV1Schema.parse(material);
  return liveScratchSupervisorNonceConsumptionIndexV1Schema.parse({
    ...parsed,
    nonceConsumptionIndexDigest: computeLiveScratchSupervisorNonceConsumptionIndexDigestV1(parsed),
  });
}

/**
 * This checks a service-signed, root-private nonce-index projection. The
 * future protected daemon must build the index atomically before allocation;
 * this pure schema cannot create that root-private state or activate a run.
 */
export function verifyLiveScratchSupervisorNonceConsumptionV1(input: {
  readonly nonceConsumption: unknown;
  readonly rootPrivateNonceConsumptionIndex: unknown;
  readonly attestation: unknown;
  readonly manifest: unknown;
  readonly trustedManifestDigest: string;
  readonly trustedPublicKeyPem: string;
  readonly expectedNonce: string;
  readonly expectedBinding: LiveScratchLifecycleBindingV1;
  readonly expectedAllocationId: string;
  readonly now: Date;
}): boolean {
  const nonceConsumption = liveScratchSupervisorNonceConsumptionV1Schema.safeParse(
    input.nonceConsumption,
  );
  const index = liveScratchSupervisorNonceConsumptionIndexV1Schema.safeParse(
    input.rootPrivateNonceConsumptionIndex,
  );
  const attestation = liveScratchSupervisorAttestationV1Schema.safeParse(input.attestation);
  const manifest = l3ProtectedScratchSupervisorManifestV1Schema.safeParse(input.manifest);
  const binding = liveScratchLifecycleBindingV1Schema.safeParse(input.expectedBinding);
  const allocationId = allocationIdSchema.safeParse(input.expectedAllocationId);
  if (
    !nonceConsumption.success ||
    !index.success ||
    !attestation.success ||
    !manifest.success ||
    !binding.success ||
    !allocationId.success ||
    !Number.isFinite(input.now.getTime())
  ) {
    return false;
  }
  const record = nonceConsumption.data;
  const rootIndex = index.data;
  const bindingDigest = computeLiveScratchLifecycleBindingDigestV1(binding.data);
  const expectedNonceDigest = (() => {
    try {
      return computeLiveScratchSupervisorNonceDigestV1(input.expectedNonce);
    } catch {
      return undefined;
    }
  })();
  if (
    !expectedNonceDigest ||
    record.manifestDigest !== manifest.data.manifestDigest ||
    record.attestationDigest !== attestation.data.attestationDigest ||
    record.serviceEpochDigest !== binding.data.serviceEpochDigest ||
    record.nonceDigest !== expectedNonceDigest ||
    record.requestBindingDigest !== bindingDigest ||
    record.reservationId !== binding.data.reservationId ||
    record.leaseFingerprint !== binding.data.leaseFingerprint ||
    record.journalPredecessorDigest !== binding.data.journalPredecessorDigest ||
    record.allocationId !== allocationId.data ||
    rootIndex.manifestDigest !== record.manifestDigest ||
    rootIndex.serviceEpochDigest !== record.serviceEpochDigest ||
    rootIndex.nonceDigest !== record.nonceDigest ||
    rootIndex.requestBindingDigest !== record.requestBindingDigest ||
    rootIndex.reservationId !== record.reservationId ||
    rootIndex.leaseFingerprint !== record.leaseFingerprint ||
    rootIndex.observedNonceConsumptionCount !== 1 ||
    rootIndex.observedUniqueAllocationCount !== 1 ||
    rootIndex.indexedConsumptionDigests.length !== 1 ||
    rootIndex.indexedAllocationIds.length !== 1 ||
    rootIndex.indexedConsumptionDigests[0] !== record.nonceConsumptionDigest ||
    rootIndex.indexedAllocationIds[0] !== record.allocationId ||
    rootIndex.journalHeadDigest !== record.nonceConsumptionDigest ||
    rootIndex.journalHeadSequence !== record.journalSequence ||
    !timestampAtOrBefore(record.consumedAt, rootIndex.indexedAt) ||
    !timestampIsAtOrBeforeDate(rootIndex.indexedAt, input.now) ||
    !verifyLiveScratchSupervisorAttestationV1({
      attestation: attestation.data,
      manifest: manifest.data,
      trustedManifestDigest: input.trustedManifestDigest,
      expectedNonce: input.expectedNonce,
      expectedRequestBindingDigest: bindingDigest,
      expectedServiceEpochDigest: record.serviceEpochDigest,
      trustedPublicKeyPem: input.trustedPublicKeyPem,
      now: new Date(record.consumedAt),
    })
  ) {
    return false;
  }
  const {
    nonceConsumptionDigest: _nonceConsumptionDigest,
    serviceSignature,
    ...unsignedRecord
  } = record;
  if (
    !signatureMatches({
      publicKeyPem: input.trustedPublicKeyPem,
      signingBytes: liveScratchSupervisorNonceConsumptionSigningBytesV1(unsignedRecord),
      signature: serviceSignature,
    })
  ) {
    return false;
  }
  const {
    nonceConsumptionIndexDigest: _nonceConsumptionIndexDigest,
    serviceSignature: indexSignature,
    ...unsignedIndex
  } = rootIndex;
  return signatureMatches({
    publicKeyPem: input.trustedPublicKeyPem,
    signingBytes: liveScratchSupervisorNonceConsumptionIndexSigningBytesV1(unsignedIndex),
    signature: indexSignature,
  });
}

const allocationCommitmentUnsignedMaterialV1Schema = z
  .object({
    schema: z.literal('LiveScratchAllocationCommitmentV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    allocationId: allocationIdSchema,
    manifestDigest: digestSchema,
    attestationDigest: digestSchema,
    nonceConsumptionDigest: digestSchema,
    nonceConsumptionIndexDigest: digestSchema,
    nonceConsumptionJournalSequence: journalSequenceSchema,
    commitmentJournalPredecessorDigest: digestSchema,
    commitmentJournalSequence: journalSequenceSchema,
    serviceEpochDigest: digestSchema,
    binding: liveScratchLifecycleBindingV1Schema,
    committedAt: isoTimestampSchema,
    allocatedAt: isoTimestampSchema,
    deletionDeadlineAt: isoTimestampSchema,
    allocationState: z.literal('allocation_commitment_fsynced'),
    recoveryIndex: z.literal('root_private_metadata_only'),
    signatureAlgorithm: z.literal('ed25519'),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = expectedDeadline(value.allocatedAt);
    if (!expected || value.deletionDeadlineAt !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['deletionDeadlineAt'],
        message: 'commitment deadline must be exactly the 86,400-second crash-recovery bound',
      });
    }
    if (!timestampBefore(value.committedAt, value.allocatedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'commitment must be journaled strictly before allocation',
      });
    }
    if (value.commitmentJournalPredecessorDigest !== value.nonceConsumptionDigest) {
      context.addIssue({
        code: 'custom',
        path: ['commitmentJournalPredecessorDigest'],
        message: 'commitment journal must directly follow the nonce-consumption record',
      });
    }
    if (value.commitmentJournalSequence !== value.nonceConsumptionJournalSequence + 1) {
      context.addIssue({
        code: 'custom',
        path: ['commitmentJournalSequence'],
        message: 'commitment journal sequence must immediately follow nonce consumption',
      });
    }
    if (value.serviceEpochDigest !== value.binding.serviceEpochDigest) {
      context.addIssue({
        code: 'custom',
        path: ['serviceEpochDigest'],
        message: 'commitment epoch must match lifecycle binding',
      });
    }
  });

export type LiveScratchAllocationCommitmentUnsignedMaterialV1 = z.infer<
  typeof allocationCommitmentUnsignedMaterialV1Schema
>;

export function liveScratchAllocationCommitmentSigningBytesV1(
  material: LiveScratchAllocationCommitmentUnsignedMaterialV1,
): Uint8Array {
  return canonicalJsonBytes(allocationCommitmentUnsignedMaterialV1Schema.parse(material));
}

const allocationCommitmentMaterialV1Schema = allocationCommitmentUnsignedMaterialV1Schema
  .extend({ serviceSignature: signatureSchema })
  .strict();
export type LiveScratchAllocationCommitmentMaterialV1 = z.infer<
  typeof allocationCommitmentMaterialV1Schema
>;

export function computeLiveScratchAllocationCommitmentDigestV1(
  material: LiveScratchAllocationCommitmentMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-allocation-commitment.v1',
    canonicalJsonBytes(allocationCommitmentMaterialV1Schema.parse(material)),
  );
}

export const liveScratchAllocationCommitmentV1Schema = allocationCommitmentMaterialV1Schema
  .extend({ commitmentDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { commitmentDigest, ...material } = value;
    try {
      if (commitmentDigest === computeLiveScratchAllocationCommitmentDigestV1(material)) return;
      context.addIssue({
        code: 'custom',
        path: ['commitmentDigest'],
        message: 'allocation commitment digest mismatch',
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'allocation commitment material invalid' });
    }
  });

export type LiveScratchAllocationCommitmentV1 = z.infer<
  typeof liveScratchAllocationCommitmentV1Schema
>;

export function buildLiveScratchAllocationCommitmentV1(
  material: LiveScratchAllocationCommitmentMaterialV1,
): LiveScratchAllocationCommitmentV1 {
  const parsed = allocationCommitmentMaterialV1Schema.parse(material);
  return liveScratchAllocationCommitmentV1Schema.parse({
    ...parsed,
    commitmentDigest: computeLiveScratchAllocationCommitmentDigestV1(parsed),
  });
}

const lifecycleReceiptUnsignedMaterialV1Schema = z
  .object({
    schema: z.literal('LiveScratchLifecycleReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    allocationId: allocationIdSchema,
    commitmentDigest: digestSchema,
    manifestDigest: digestSchema,
    attestationDigest: digestSchema,
    nonceConsumptionDigest: digestSchema,
    nonceConsumptionIndexDigest: digestSchema,
    nonceConsumptionJournalSequence: journalSequenceSchema,
    commitmentJournalPredecessorDigest: digestSchema,
    commitmentJournalSequence: journalSequenceSchema,
    serviceEpochDigest: digestSchema,
    binding: liveScratchLifecycleBindingV1Schema,
    ownerOnlyReceiptProjectionDigest: digestSchema,
    committedAt: isoTimestampSchema,
    allocatedAt: isoTimestampSchema,
    deletionDeadlineAt: isoTimestampSchema,
    workerExitedAt: isoTimestampSchema,
    processReapedAt: isoTimestampSchema,
    scrubStartedAt: isoTimestampSchema,
    deletedAt: isoTimestampSchema,
    deletionTrigger: z.enum(['normal_exit_deleted', 'crash_recovery_deleted']),
    containmentState: z.literal('process_group_absent'),
    deletionState: z.literal('root_deleted'),
    journalState: z.literal('deletion_proof_finalized'),
    nativeProofKind: z.literal('linux_root_native_helper_v1'),
    nativeLifecycleProofDigest: digestSchema,
    signatureAlgorithm: z.literal('ed25519'),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = expectedDeadline(value.allocatedAt);
    if (!expected || value.deletionDeadlineAt !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['deletionDeadlineAt'],
        message: 'receipt deadline must be exactly the 86,400-second crash-recovery bound',
      });
    }
    if (
      !timestampBefore(value.committedAt, value.allocatedAt) ||
      !timestampAtOrBefore(value.allocatedAt, value.workerExitedAt) ||
      !timestampAtOrBefore(value.workerExitedAt, value.processReapedAt) ||
      !timestampAtOrBefore(value.processReapedAt, value.scrubStartedAt) ||
      !timestampAtOrBefore(value.scrubStartedAt, value.deletedAt) ||
      !timestampAtOrBefore(value.deletedAt, value.deletionDeadlineAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'receipt lifecycle timestamps must be monotonic and remain inside retention',
      });
    }
    if (value.commitmentJournalPredecessorDigest !== value.nonceConsumptionDigest) {
      context.addIssue({
        code: 'custom',
        path: ['commitmentJournalPredecessorDigest'],
        message: 'receipt must retain the direct nonce-consumption journal predecessor',
      });
    }
    if (value.commitmentJournalSequence !== value.nonceConsumptionJournalSequence + 1) {
      context.addIssue({
        code: 'custom',
        path: ['commitmentJournalSequence'],
        message: 'receipt must retain strict nonce-consumption journal ordering',
      });
    }
    if (value.serviceEpochDigest !== value.binding.serviceEpochDigest) {
      context.addIssue({
        code: 'custom',
        path: ['serviceEpochDigest'],
        message: 'receipt epoch must match lifecycle binding',
      });
    }
    if (value.deletionTrigger === 'normal_exit_deleted') {
      const workerExitedAtMs = Date.parse(value.workerExitedAt);
      const reapedAtMs = Date.parse(value.processReapedAt);
      const deletedAtMs = Date.parse(value.deletedAt);
      if (
        !Number.isFinite(workerExitedAtMs) ||
        !Number.isFinite(reapedAtMs) ||
        !Number.isFinite(deletedAtMs) ||
        reapedAtMs - workerExitedAtMs > MAX_NORMAL_EXIT_DELETE_MILLISECONDS ||
        deletedAtMs - workerExitedAtMs > MAX_NORMAL_EXIT_DELETE_MILLISECONDS
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'normal exit reaping and deletion must complete from worker exit within the fixed immediate-delete bound',
        });
      }
    }
  });

export type LiveScratchLifecycleReceiptUnsignedMaterialV1 = z.infer<
  typeof lifecycleReceiptUnsignedMaterialV1Schema
>;

export function liveScratchLifecycleReceiptSigningBytesV1(
  material: LiveScratchLifecycleReceiptUnsignedMaterialV1,
): Uint8Array {
  return canonicalJsonBytes(lifecycleReceiptUnsignedMaterialV1Schema.parse(material));
}

const lifecycleReceiptMaterialV1Schema = lifecycleReceiptUnsignedMaterialV1Schema
  .extend({ serviceSignature: signatureSchema })
  .strict();
export type LiveScratchLifecycleReceiptMaterialV1 = z.infer<
  typeof lifecycleReceiptMaterialV1Schema
>;

export function computeLiveScratchLifecycleReceiptDigestV1(
  material: LiveScratchLifecycleReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-lifecycle-receipt.v1',
    canonicalJsonBytes(lifecycleReceiptMaterialV1Schema.parse(material)),
  );
}

export const liveScratchLifecycleReceiptV1Schema = lifecycleReceiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    try {
      if (receiptDigest === computeLiveScratchLifecycleReceiptDigestV1(material)) return;
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: 'lifecycle receipt digest mismatch',
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'lifecycle receipt material invalid' });
    }
  });

export type LiveScratchLifecycleReceiptV1 = z.infer<typeof liveScratchLifecycleReceiptV1Schema>;

export function buildLiveScratchLifecycleReceiptV1(
  material: LiveScratchLifecycleReceiptMaterialV1,
): LiveScratchLifecycleReceiptV1 {
  const parsed = lifecycleReceiptMaterialV1Schema.parse(material);
  return liveScratchLifecycleReceiptV1Schema.parse({
    ...parsed,
    receiptDigest: computeLiveScratchLifecycleReceiptDigestV1(parsed),
  });
}

function commitmentMatchesManifestAndAttestation(input: {
  readonly commitment: LiveScratchAllocationCommitmentV1;
  readonly nonceConsumption: LiveScratchSupervisorNonceConsumptionV1;
  readonly rootPrivateNonceConsumptionIndex: LiveScratchSupervisorNonceConsumptionIndexV1;
  readonly attestation: LiveScratchSupervisorAttestationV1;
  readonly manifest: L3ProtectedScratchSupervisorManifestV1;
  readonly trustedManifestDigest: string;
  readonly trustedPublicKeyPem: string;
  readonly expectedNonce: string;
}): boolean {
  const bindingDigest = computeLiveScratchLifecycleBindingDigestV1(input.commitment.binding);
  const allocationAtMs = Date.parse(input.commitment.allocatedAt);
  const attestationExpiresAtMs = Date.parse(input.attestation.expiresAt);
  if (
    input.commitment.manifestDigest !== input.manifest.manifestDigest ||
    input.commitment.attestationDigest !== input.attestation.attestationDigest ||
    input.commitment.nonceConsumptionDigest !== input.nonceConsumption.nonceConsumptionDigest ||
    input.commitment.nonceConsumptionIndexDigest !==
      input.rootPrivateNonceConsumptionIndex.nonceConsumptionIndexDigest ||
    input.commitment.nonceConsumptionJournalSequence !== input.nonceConsumption.journalSequence ||
    input.commitment.commitmentJournalPredecessorDigest !==
      input.nonceConsumption.nonceConsumptionDigest ||
    input.commitment.commitmentJournalSequence !== input.nonceConsumption.journalSequence + 1 ||
    input.commitment.serviceEpochDigest !== input.attestation.serviceEpochDigest ||
    input.commitment.serviceEpochDigest !== input.commitment.binding.serviceEpochDigest ||
    input.commitment.binding.workerBundleDigest !== input.manifest.workerBundleDigest ||
    input.commitment.binding.runnerDigest !== input.manifest.runnerBindingDigest ||
    input.attestation.requestBindingDigest !== bindingDigest ||
    !timestampAtOrBefore(input.nonceConsumption.consumedAt, input.commitment.committedAt) ||
    !timestampAtOrBefore(
      input.rootPrivateNonceConsumptionIndex.indexedAt,
      input.commitment.committedAt,
    ) ||
    !Number.isFinite(allocationAtMs) ||
    !Number.isFinite(attestationExpiresAtMs) ||
    allocationAtMs >= attestationExpiresAtMs ||
    !verifyLiveScratchSupervisorNonceConsumptionV1({
      nonceConsumption: input.nonceConsumption,
      rootPrivateNonceConsumptionIndex: input.rootPrivateNonceConsumptionIndex,
      attestation: input.attestation,
      manifest: input.manifest,
      trustedManifestDigest: input.trustedManifestDigest,
      trustedPublicKeyPem: input.trustedPublicKeyPem,
      expectedNonce: input.expectedNonce,
      expectedBinding: input.commitment.binding,
      expectedAllocationId: input.commitment.allocationId,
      now: new Date(input.commitment.committedAt),
    }) ||
    !verifyLiveScratchSupervisorAttestationV1({
      attestation: input.attestation,
      manifest: input.manifest,
      trustedManifestDigest: input.trustedManifestDigest,
      expectedNonce: input.expectedNonce,
      expectedRequestBindingDigest: bindingDigest,
      expectedServiceEpochDigest: input.commitment.serviceEpochDigest,
      trustedPublicKeyPem: input.trustedPublicKeyPem,
      // The attestation must still be fresh when the journal commitment is made.
      now: new Date(input.commitment.committedAt),
    }) ||
    !verifyLiveScratchSupervisorAttestationV1({
      attestation: input.attestation,
      manifest: input.manifest,
      trustedManifestDigest: input.trustedManifestDigest,
      expectedNonce: input.expectedNonce,
      expectedRequestBindingDigest: bindingDigest,
      expectedServiceEpochDigest: input.commitment.serviceEpochDigest,
      trustedPublicKeyPem: input.trustedPublicKeyPem,
      // Allocation must occur while the one-shot attestation is still live.
      now: new Date(input.commitment.allocatedAt),
    })
  ) {
    return false;
  }
  const { commitmentDigest: _commitmentDigest, serviceSignature, ...unsigned } = input.commitment;
  return signatureMatches({
    publicKeyPem: input.trustedPublicKeyPem,
    signingBytes: liveScratchAllocationCommitmentSigningBytesV1(unsigned),
    signature: serviceSignature,
  });
}

/**
 * Verify the signed receipt chain. A future client must obtain the public key
 * from a root-protected installed manifest and native helper proof from the
 * signed service bundle; this function neither discovers either input nor
 * changes activation.
 */
export function verifyLiveScratchLifecycleReceiptV1(input: {
  readonly receipt: unknown;
  readonly commitment: unknown;
  readonly nonceConsumption: unknown;
  readonly rootPrivateNonceConsumptionIndex: unknown;
  readonly attestation: unknown;
  readonly manifest: unknown;
  readonly trustedManifestDigest: string;
  readonly trustedPublicKeyPem: string;
  readonly expectedNonce: string;
}): boolean {
  const receipt = liveScratchLifecycleReceiptV1Schema.safeParse(input.receipt);
  const commitment = liveScratchAllocationCommitmentV1Schema.safeParse(input.commitment);
  const nonceConsumption = liveScratchSupervisorNonceConsumptionV1Schema.safeParse(
    input.nonceConsumption,
  );
  const rootPrivateNonceConsumptionIndex =
    liveScratchSupervisorNonceConsumptionIndexV1Schema.safeParse(
      input.rootPrivateNonceConsumptionIndex,
    );
  const attestation = liveScratchSupervisorAttestationV1Schema.safeParse(input.attestation);
  const manifest = l3ProtectedScratchSupervisorManifestV1Schema.safeParse(input.manifest);
  if (
    !receipt.success ||
    !commitment.success ||
    !nonceConsumption.success ||
    !rootPrivateNonceConsumptionIndex.success ||
    !attestation.success ||
    !manifest.success
  ) {
    return false;
  }
  if (
    !commitmentMatchesManifestAndAttestation({
      commitment: commitment.data,
      nonceConsumption: nonceConsumption.data,
      rootPrivateNonceConsumptionIndex: rootPrivateNonceConsumptionIndex.data,
      attestation: attestation.data,
      manifest: manifest.data,
      trustedManifestDigest: input.trustedManifestDigest,
      trustedPublicKeyPem: input.trustedPublicKeyPem,
      expectedNonce: input.expectedNonce,
    })
  ) {
    return false;
  }
  const record = receipt.data;
  if (
    record.allocationId !== commitment.data.allocationId ||
    record.commitmentDigest !== commitment.data.commitmentDigest ||
    record.manifestDigest !== commitment.data.manifestDigest ||
    record.attestationDigest !== commitment.data.attestationDigest ||
    record.nonceConsumptionDigest !== commitment.data.nonceConsumptionDigest ||
    record.nonceConsumptionIndexDigest !== commitment.data.nonceConsumptionIndexDigest ||
    record.nonceConsumptionJournalSequence !== commitment.data.nonceConsumptionJournalSequence ||
    record.commitmentJournalPredecessorDigest !==
      commitment.data.commitmentJournalPredecessorDigest ||
    record.commitmentJournalSequence !== commitment.data.commitmentJournalSequence ||
    record.serviceEpochDigest !== commitment.data.serviceEpochDigest ||
    record.committedAt !== commitment.data.committedAt ||
    record.allocatedAt !== commitment.data.allocatedAt ||
    record.deletionDeadlineAt !== commitment.data.deletionDeadlineAt ||
    !canonicalEqual(record.binding, commitment.data.binding)
  ) {
    return false;
  }
  const { receiptDigest: _receiptDigest, serviceSignature, ...unsigned } = record;
  return signatureMatches({
    publicKeyPem: input.trustedPublicKeyPem,
    signingBytes: liveScratchLifecycleReceiptSigningBytesV1(unsigned),
    signature: serviceSignature,
  });
}

/** Reject accidental free-form metadata before it can enter a future receipt. */
export function isSafeLiveScratchSupervisorMetadataV1(value: string): boolean {
  return isOpaqueControlPlaneMetadata(value);
}
