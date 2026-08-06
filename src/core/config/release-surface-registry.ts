import type { ReleaseCapabilityIdV1 } from './capability-ids';

/**
 * Public release-surface declarations shared by the runtime release profile
 * and diagnostic inventory. This is intentionally data-only: it contains no
 * gate names, evidence shapes, or admission evaluation.
 */
export const PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1 = [
  'macos-15-arm64',
  'ubuntu-24.04-x64',
  'windows-2025-x64',
] as const;

export type ProductionDistributionTargetIdentityV1 =
  (typeof PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1)[number];

export type ProductionDistributionTargetV1 = Readonly<{
  identity: ProductionDistributionTargetIdentityV1;
  platform: 'macos' | 'linux' | 'windows';
  arch: 'arm64' | 'x64';
  nativeRunner: 'macos-15' | 'ubuntu-24.04' | 'windows-2025';
}>;

/** Closed distribution target registry; membership alone admits no effect. */
export const PRODUCTION_DISTRIBUTION_TARGETS_V1: Readonly<
  Record<ProductionDistributionTargetIdentityV1, ProductionDistributionTargetV1>
> = Object.freeze({
  'macos-15-arm64': Object.freeze({
    identity: 'macos-15-arm64',
    platform: 'macos',
    arch: 'arm64',
    nativeRunner: 'macos-15',
  }),
  'ubuntu-24.04-x64': Object.freeze({
    identity: 'ubuntu-24.04-x64',
    platform: 'linux',
    arch: 'x64',
    nativeRunner: 'ubuntu-24.04',
  }),
  'windows-2025-x64': Object.freeze({
    identity: 'windows-2025-x64',
    platform: 'windows',
    arch: 'x64',
    nativeRunner: 'windows-2025',
  }),
});

/** D-04 effectful execution support remains independently empty. */
export const SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1: readonly string[] = Object.freeze([]);

export const EMBEDDED_RELEASE_PROFILE_IDS_V1 = [
  'internal-dogfood',
  'limited-production',
  'capability-canary',
  'general-availability',
] as const;

export type EmbeddedReleaseProfileIdV1 = (typeof EMBEDDED_RELEASE_PROFILE_IDS_V1)[number];

export type EmbeddedReleaseProfileDeclarationV1 = Readonly<{
  profileId: EmbeddedReleaseProfileIdV1;
  channel: 'internal' | 'limited' | 'canary' | 'ga';
  canaryCapability?: ReleaseCapabilityIdV1;
}>;

/**
 * The runtime builds the closed fail-closed profiles from this declaration.
 * It is the public identity/channel source for both runtime and diagnostics.
 */
export const EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1: readonly EmbeddedReleaseProfileDeclarationV1[] =
  Object.freeze([
    Object.freeze({ profileId: 'internal-dogfood', channel: 'internal' }),
    Object.freeze({ profileId: 'limited-production', channel: 'limited' }),
    Object.freeze({
      profileId: 'capability-canary',
      channel: 'canary',
      canaryCapability: 'builtin_read_tools',
    }),
    Object.freeze({ profileId: 'general-availability', channel: 'ga' }),
  ]);
