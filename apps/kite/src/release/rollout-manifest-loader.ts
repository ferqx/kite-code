import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  composeReleaseProfileV1,
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
  type ReleaseProfileRestrictionLayerV1,
  type ReleaseProfileV1,
  type RolloutStage,
} from '#app/config';
import { canonicalJsonBytes, parseCanonicalJson, sha256Digest } from './canonical-json';
import {
  createRolloutCacheRecordV1,
  decodeIdentityBoundRolloutCacheV1,
  type RolloutArtifactIdentityV1,
  type RolloutCacheRecordV1,
  rolloutArtifactIdentityV1Schema,
} from './rollout-cache';

export const ROLLOUT_MANIFEST_ENABLED_BY_DEFAULT = false as const;
export const ROLLOUT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const ROLLOUT_MAX_MANIFEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const SYNTHETIC_ROLLOUT_KEY_IDS = [
  'kite-rollout-fixture-2026-a',
  'kite-rollout-fixture-2026-b',
] as const;

const SYNTHETIC_ROLLOUT_TRUST_BUNDLE = Object.freeze({
  'kite-rollout-fixture-2026-a': Object.freeze({
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
-----END PUBLIC KEY-----
`,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
  }),
  'kite-rollout-fixture-2026-b': Object.freeze({
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=
-----END PUBLIC KEY-----
`,
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil: '2027-07-01T00:00:00.000Z',
  }),
});

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.string().refine(isCanonicalTimestamp);
const identitySchema = z.string().trim().min(1).max(512);
const capabilitySchema = z.enum(RELEASE_CAPABILITIES);
const rolloutStageSchema = z.enum(['off', 'internal', 'canary', 'general']);

const capabilityRolloutRestrictionsSchema = z
  .record(z.string(), rolloutStageSchema)
  .superRefine((restrictions, context) => {
    for (const capability of Object.keys(restrictions)) {
      if (!capabilitySchema.safeParse(capability).success) {
        context.addIssue({ code: 'custom', path: [capability], message: 'unknown capability' });
      }
    }
  });

const sortedUniqueIdentityListSchema = z
  .array(identitySchema)
  .max(256)
  .superRefine((values, context) => {
    const sorted = [...values].sort();
    if (values.some((value, index) => value !== sorted[index] || value === values[index - 1])) {
      context.addIssue({ code: 'custom', message: 'identity list must be sorted and unique' });
    }
  });

const sortedUniqueCapabilityListSchema = z
  .array(capabilitySchema)
  .superRefine((values, context) => {
    const sorted = [...values].sort();
    if (values.some((value, index) => value !== sorted[index] || value === values[index - 1])) {
      context.addIssue({ code: 'custom', message: 'capability list must be sorted and unique' });
    }
  });

export const disableOnlyRolloutManifestV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('disable-only-rollout-manifest-v1'),
    artifactIdentity: rolloutArtifactIdentityV1Schema,
    sequence: z.number().int().positive().safe(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    keyId: z.enum(SYNTHETIC_ROLLOUT_KEY_IDS),
    restrictions: z
      .object({
        disableCapabilities: sortedUniqueCapabilityListSchema,
        maxRollout: capabilityRolloutRestrictionsSchema,
        cohortPercent: z.number().int().min(0).max(100),
        networkAllowlist: sortedUniqueIdentityListSchema,
        mcpProviderAllowlist: sortedUniqueIdentityListSchema,
        providerRouteAllowlist: sortedUniqueIdentityListSchema,
      })
      .strict(),
    synthetic: z.literal(true),
    nonDistributable: z.literal(true),
    realRolloutSigningEnabled: z.literal(false),
  })
  .strict();

export type DisableOnlyRolloutManifestV1 = z.infer<typeof disableOnlyRolloutManifestV1Schema>;

export const syntheticRolloutSignatureV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('synthetic-rollout-ed25519-fixture-v1'),
    keyId: z.enum(SYNTHETIC_ROLLOUT_KEY_IDS),
    manifestSha256: digestSchema,
    signatureBase64: z.string().refine(isCanonicalBase64),
    nonDistributable: z.literal(true),
    realRolloutSigningEnabled: z.literal(false),
  })
  .strict();

export type SyntheticRolloutSignatureV1 = z.infer<typeof syntheticRolloutSignatureV1Schema>;

export interface VerifiedDisableOnlyRolloutV1 {
  manifest: DisableOnlyRolloutManifestV1;
  signature: SyntheticRolloutSignatureV1;
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
  restrictionLayer: ReleaseProfileRestrictionLayerV1;
  effectiveProfile: ReleaseProfileV1;
}

export class DisableOnlyRolloutError extends Error {
  readonly code:
    | 'schema_invalid'
    | 'signature_invalid'
    | 'identity_mismatch'
    | 'time_invalid'
    | 'cohort_escalation'
    | 'restriction_escalation';

  constructor(code: DisableOnlyRolloutError['code']) {
    super(`Disable-only rollout manifest failed closed: ${code}`);
    this.name = 'DisableOnlyRolloutError';
    this.code = code;
  }
}

export type DisableOnlyRolloutResolutionV1 =
  | {
      status: 'disabled' | 'embedded_ceiling';
      source: 'embedded';
      effectiveProfile: ReleaseProfileV1;
      cohortPercent: number;
    }
  | {
      status: 'applied';
      source: 'remote' | 'cache';
      effectiveProfile: ReleaseProfileV1;
      cohortPercent: number;
      sequence: number;
      restrictionLayer: ReleaseProfileRestrictionLayerV1;
      cacheRecord: RolloutCacheRecordV1;
    }
  | {
      status: 'denied';
      source: 'mandatory_admin';
      reason: 'valid_identity_bound_rollout_unavailable';
    };

export function encodeDisableOnlyRolloutManifestV1(value: unknown): Uint8Array {
  return canonicalJsonBytes(disableOnlyRolloutManifestV1Schema.parse(value));
}

export function encodeSyntheticRolloutSignatureV1(value: unknown): Uint8Array {
  return canonicalJsonBytes(syntheticRolloutSignatureV1Schema.parse(value));
}

export function verifyDisableOnlyRolloutManifestV1(input: {
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
  expectedIdentity: RolloutArtifactIdentityV1;
  embeddedProfile: ReleaseProfileV1;
  embeddedCohortPercent: number;
  now: Date;
}): VerifiedDisableOnlyRolloutV1 {
  return verifyDisableOnlyRolloutManifestInternalV1(input, false);
}

function verifyDisableOnlyRolloutManifestInternalV1(
  input: {
    manifestBytes: Uint8Array;
    signatureBytes: Uint8Array;
    expectedIdentity: RolloutArtifactIdentityV1;
    embeddedProfile: ReleaseProfileV1;
    embeddedCohortPercent: number;
    now: Date;
  },
  allowExpiredForReplayCheck: boolean,
): VerifiedDisableOnlyRolloutV1 {
  if (input.manifestBytes.byteLength > 256 * 1024 || input.signatureBytes.byteLength > 32 * 1024) {
    throw new DisableOnlyRolloutError('schema_invalid');
  }
  let manifest: DisableOnlyRolloutManifestV1;
  let signature: SyntheticRolloutSignatureV1;
  try {
    manifest = disableOnlyRolloutManifestV1Schema.parse(parseCanonicalJson(input.manifestBytes));
    signature = syntheticRolloutSignatureV1Schema.parse(parseCanonicalJson(input.signatureBytes));
  } catch {
    throw new DisableOnlyRolloutError('schema_invalid');
  }
  if (!sameArtifactIdentity(manifest.artifactIdentity, input.expectedIdentity)) {
    throw new DisableOnlyRolloutError('identity_mismatch');
  }
  if (
    signature.keyId !== manifest.keyId ||
    signature.manifestSha256 !== sha256Digest(input.manifestBytes)
  ) {
    throw new DisableOnlyRolloutError('signature_invalid');
  }
  const trust = SYNTHETIC_ROLLOUT_TRUST_BUNDLE[manifest.keyId];
  const signatureBytes = Buffer.from(signature.signatureBase64, 'base64');
  if (
    signatureBytes.byteLength !== 64 ||
    !verify(null, input.manifestBytes, createPublicKey(trust.publicKeyPem), signatureBytes)
  ) {
    throw new DisableOnlyRolloutError('signature_invalid');
  }
  verifyManifestTime(manifest, trust, input.now, allowExpiredForReplayCheck);
  if (
    !Number.isInteger(input.embeddedCohortPercent) ||
    input.embeddedCohortPercent < 0 ||
    input.embeddedCohortPercent > 100 ||
    manifest.restrictions.cohortPercent > input.embeddedCohortPercent
  ) {
    throw new DisableOnlyRolloutError('cohort_escalation');
  }

  const restrictionLayer = restrictionLayerFromManifest(manifest);
  let effectiveProfile: ReleaseProfileV1;
  try {
    effectiveProfile = composeReleaseProfileV1({
      embedded: input.embeddedProfile,
      layers: [restrictionLayer],
    });
  } catch {
    throw new DisableOnlyRolloutError('restriction_escalation');
  }
  return {
    manifest,
    signature,
    manifestBytes: new Uint8Array(input.manifestBytes),
    signatureBytes: new Uint8Array(input.signatureBytes),
    restrictionLayer,
    effectiveProfile,
  };
}

export function resolveDisableOnlyRolloutV1(input: {
  enabled?: boolean;
  mandatoryAdmin: boolean;
  embeddedProfile: ReleaseProfileV1;
  embeddedCohortPercent: number;
  expectedIdentity: RolloutArtifactIdentityV1;
  now: Date;
  remote?:
    | { status: 'unavailable' }
    | { status: 'available'; manifestBytes: Uint8Array; signatureBytes: Uint8Array };
  cachedRecord?: unknown;
}): DisableOnlyRolloutResolutionV1 {
  if (!(input.enabled ?? ROLLOUT_MANIFEST_ENABLED_BY_DEFAULT)) {
    if (input.mandatoryAdmin) {
      return {
        status: 'denied',
        source: 'mandatory_admin',
        reason: 'valid_identity_bound_rollout_unavailable',
      };
    }
    return embeddedResolution('disabled', input.embeddedProfile, input.embeddedCohortPercent);
  }

  const cached = inspectCached(input);
  if (input.remote?.status === 'available') {
    try {
      const remote = verifyDisableOnlyRolloutManifestV1({
        manifestBytes: input.remote.manifestBytes,
        signatureBytes: input.remote.signatureBytes,
        expectedIdentity: input.expectedIdentity,
        embeddedProfile: input.embeddedProfile,
        embeddedCohortPercent: input.embeddedCohortPercent,
        now: input.now,
      });
      if (!cached || remote.manifest.sequence > cached.highWaterSequence) {
        return appliedResolution('remote', remote, input.expectedIdentity);
      }
    } catch {
      // A bad remote response has no authority. Fall through to a valid cache.
    }
  }
  if (cached?.applicable)
    return appliedResolution('cache', cached.verified, input.expectedIdentity);
  if (input.mandatoryAdmin) {
    return {
      status: 'denied',
      source: 'mandatory_admin',
      reason: 'valid_identity_bound_rollout_unavailable',
    };
  }
  return embeddedResolution('embedded_ceiling', input.embeddedProfile, input.embeddedCohortPercent);
}

function inspectCached(input: {
  cachedRecord?: unknown;
  expectedIdentity: RolloutArtifactIdentityV1;
  embeddedProfile: ReleaseProfileV1;
  embeddedCohortPercent: number;
  now: Date;
}):
  | {
      verified: VerifiedDisableOnlyRolloutV1;
      highWaterSequence: number;
      applicable: boolean;
    }
  | undefined {
  if (!input.cachedRecord) return undefined;
  try {
    const cached = decodeIdentityBoundRolloutCacheV1({
      record: input.cachedRecord,
      expectedIdentity: input.expectedIdentity,
    });
    const verified = verifyDisableOnlyRolloutManifestInternalV1(
      {
        manifestBytes: cached.manifestBytes,
        signatureBytes: cached.signatureBytes,
        expectedIdentity: input.expectedIdentity,
        embeddedProfile: input.embeddedProfile,
        embeddedCohortPercent: input.embeddedCohortPercent,
        now: input.now,
      },
      true,
    );
    if (
      cached.record.sequence !== verified.manifest.sequence ||
      cached.record.expiresAt !== verified.manifest.expiresAt
    ) {
      return undefined;
    }
    return {
      verified,
      highWaterSequence: verified.manifest.sequence,
      applicable: input.now.getTime() < Date.parse(verified.manifest.expiresAt),
    };
  } catch {
    return undefined;
  }
}

function appliedResolution(
  source: 'remote' | 'cache',
  verified: VerifiedDisableOnlyRolloutV1,
  artifactIdentity: RolloutArtifactIdentityV1,
): Extract<DisableOnlyRolloutResolutionV1, { status: 'applied' }> {
  return {
    status: 'applied',
    source,
    effectiveProfile: verified.effectiveProfile,
    cohortPercent: verified.manifest.restrictions.cohortPercent,
    sequence: verified.manifest.sequence,
    restrictionLayer: verified.restrictionLayer,
    cacheRecord: createRolloutCacheRecordV1({
      artifactIdentity,
      sequence: verified.manifest.sequence,
      expiresAt: verified.manifest.expiresAt,
      manifestBytes: verified.manifestBytes,
      signatureBytes: verified.signatureBytes,
    }),
  };
}

function embeddedResolution(
  status: 'disabled' | 'embedded_ceiling',
  profile: ReleaseProfileV1,
  cohortPercent: number,
): Extract<DisableOnlyRolloutResolutionV1, { status: 'disabled' | 'embedded_ceiling' }> {
  return { status, source: 'embedded', effectiveProfile: profile, cohortPercent };
}

function restrictionLayerFromManifest(
  manifest: DisableOnlyRolloutManifestV1,
): ReleaseProfileRestrictionLayerV1 {
  const maxRollout = { ...manifest.restrictions.maxRollout } as Partial<
    Record<ReleaseCapability, RolloutStage>
  >;
  for (const capability of manifest.restrictions.disableCapabilities)
    maxRollout[capability] = 'off';
  const capabilities = Object.fromEntries(
    Object.entries(maxRollout).map(([capability, rollout]) => [
      capability,
      rollout === 'off' ? { enabled: false, maxRollout: rollout } : { maxRollout: rollout },
    ]),
  );
  return {
    source: 'rollout',
    restrictions: {
      capabilities,
      safety: {
        networkAllowlist: manifest.restrictions.networkAllowlist,
        mcpProviderAllowlist: manifest.restrictions.mcpProviderAllowlist,
      },
      data: { providerRouteAllowlist: manifest.restrictions.providerRouteAllowlist },
    },
  };
}

function verifyManifestTime(
  manifest: DisableOnlyRolloutManifestV1,
  trust: (typeof SYNTHETIC_ROLLOUT_TRUST_BUNDLE)[DisableOnlyRolloutManifestV1['keyId']],
  now: Date,
  allowExpiredForReplayCheck: boolean,
): void {
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  const current = now.getTime();
  if (
    !Number.isFinite(current) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ROLLOUT_MAX_MANIFEST_LIFETIME_MS ||
    issuedAt > current + ROLLOUT_MAX_CLOCK_SKEW_MS ||
    (!allowExpiredForReplayCheck && current >= expiresAt) ||
    issuedAt < Date.parse(trust.validFrom) ||
    issuedAt >= Date.parse(trust.validUntil) ||
    expiresAt > Date.parse(trust.validUntil)
  ) {
    throw new DisableOnlyRolloutError('time_invalid');
  }
}

function sameArtifactIdentity(
  left: RolloutArtifactIdentityV1,
  right: RolloutArtifactIdentityV1,
): boolean {
  return (
    left.canonicalRepository === right.canonicalRepository &&
    left.repositoryId === right.repositoryId &&
    left.commit === right.commit &&
    left.payloadSha256 === right.payloadSha256 &&
    left.releaseProfileDigest === right.releaseProfileDigest
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value;
}
