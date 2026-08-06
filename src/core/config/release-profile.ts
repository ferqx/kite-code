import { z } from 'zod';
import type { CapabilityApproval } from '@/protocol/capabilities';
import type { VerificationMode } from '@/protocol/verification';
import {
  type CapabilityReleaseState,
  capabilityReleaseStateSchema,
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
} from './release-capabilities';
import {
  EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1,
  type EmbeddedReleaseProfileIdV1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
  type ProductionDistributionTargetIdentityV1,
} from './release-surface-registry';

export type {
  EmbeddedReleaseProfileDeclarationV1,
  EmbeddedReleaseProfileIdV1,
  ProductionDistributionTargetIdentityV1,
  ProductionDistributionTargetV1,
} from './release-surface-registry';
export {
  EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1,
  EMBEDDED_RELEASE_PROFILE_IDS_V1,
  PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1,
} from './release-surface-registry';

export const RELEASE_PROFILE_VERSION = 1 as const;

export function parseProductionDistributionTargetIdentityV1(
  value: unknown,
): ProductionDistributionTargetIdentityV1 {
  const identity = typeof value === 'string' ? value.trim() : '';
  if (!identity) {
    throw new ProductionReleaseProfileAdmissionError('distribution_target_identity_missing');
  }
  if (!Object.hasOwn(PRODUCTION_DISTRIBUTION_TARGETS_V1, identity)) {
    throw new ProductionReleaseProfileAdmissionError('distribution_target_identity_unsupported');
  }
  return identity as ProductionDistributionTargetIdentityV1;
}

const finiteNonNegativeIntegerSchema = z.number().finite().int().nonnegative();
const identitySchema = z.string().trim().min(1);
const pathSchema = z.string().trim().min(1);

const capabilityShape = Object.fromEntries(
  RELEASE_CAPABILITIES.map((capability) => [capability, capabilityReleaseStateSchema]),
) as Record<ReleaseCapability, typeof capabilityReleaseStateSchema>;

export const releaseCapabilityStatesSchema = z.object(capabilityShape).strict();

const releaseSafetyV1Schema = z
  .object({
    requireWorkspaceTrust: z.literal(true),
    requireSandbox: z.boolean(),
    sandboxUnavailable: z.enum(['fail', 'verified_in_process_read_only']),
    maxInteractionMode: z.enum(['accept_edits', 'auto', 'full']),
    maxFilesystemScope: z.enum(['read_only', 'workspace_write', 'full_access']),
    networkMode: z.enum(['off', 'allowlist']),
    networkAllowlist: z.array(identitySchema),
    networkDenylist: z.array(identitySchema),
    allowLocalAndPrivateNetwork: z.literal(false),
    protectedPathPolicy: z.enum(['deny', 'prompt']),
    protectedPaths: z.array(pathSchema),
    allowUnsandboxedAutoExecution: z.literal(false),
    allowProjectFeatureEscalation: z.literal(false),
    allowCliFeatureEscalation: z.literal(false),
    mcpProviderAllowlist: z.array(identitySchema),
    mcpProviderDenylist: z.array(identitySchema),
  })
  .strict();

const releaseDataV1Schema = z
  .object({
    providerRouteAllowlist: z.array(identitySchema),
    providerRouteDenylist: z.array(identitySchema),
    maxWorkspaceDataClassification: z.enum(['public', 'internal', 'confidential']),
    allowRemoteMcpContentEgress: z.boolean(),
    allowProductionContentEvaluation: z.literal(false),
  })
  .strict();

export const releaseProfileV1Schema = z
  .object({
    version: z.literal(RELEASE_PROFILE_VERSION),
    profileId: identitySchema,
    channel: z.enum(['internal', 'limited', 'canary', 'ga']),
    capabilities: releaseCapabilityStatesSchema,
    canaryCapability: z.enum(RELEASE_CAPABILITIES).optional(),
    safety: releaseSafetyV1Schema,
    resources: z
      .object({
        maxRunDurationMs: finiteNonNegativeIntegerSchema,
        maxTurns: finiteNonNegativeIntegerSchema,
        maxModelRequests: finiteNonNegativeIntegerSchema,
        maxToolInvocations: finiteNonNegativeIntegerSchema,
        maxRunInputTokens: finiteNonNegativeIntegerSchema,
        maxRunOutputTokens: finiteNonNegativeIntegerSchema,
        maxConcurrentSubagents: finiteNonNegativeIntegerSchema,
        maxConcurrentWriters: finiteNonNegativeIntegerSchema,
        maxConcurrentToolInvocations: finiteNonNegativeIntegerSchema,
        maxConcurrentShellInvocations: finiteNonNegativeIntegerSchema,
        maxProcessTreeSizePerShellInvocation: finiteNonNegativeIntegerSchema,
        maxConcurrencyWaitMs: finiteNonNegativeIntegerSchema,
        maxArtifactBytes: finiteNonNegativeIntegerSchema,
      })
      .strict(),
    data: releaseDataV1Schema,
    logging: z
      .object({
        defaultMode: z.enum(['off', 'metadata']),
        allowContentOptIn: z.boolean(),
        retentionDays: finiteNonNegativeIntegerSchema,
        maxTotalBytes: finiteNonNegativeIntegerSchema,
        maxSessionBytes: finiteNonNegativeIntegerSchema,
      })
      .strict(),
    telemetry: z
      .object({
        allowed: z.boolean(),
        requiresConsent: z.literal(true),
        endpointPolicy: z.enum(['admin_only', 'user_configured']),
      })
      .strict(),
    requirements: z
      .object({
        minimumApproval: z.enum(['none', 'auto_review', 'user']),
        minimumVerification: z.enum(['not_required', 'best_effort', 'required']),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.channel === 'canary' && !profile.canaryCapability) {
      context.addIssue({
        code: 'custom',
        path: ['canaryCapability'],
        message: 'canary profiles must identify exactly one canary capability',
      });
    }
    if (profile.channel !== 'canary' && profile.canaryCapability) {
      context.addIssue({
        code: 'custom',
        path: ['canaryCapability'],
        message: 'only canary profiles may identify a canary capability',
      });
    }
    if (profile.safety.networkMode === 'off' && profile.safety.networkAllowlist.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['safety', 'networkAllowlist'],
        message: 'networkAllowlist must be empty when networkMode is off',
      });
    }
    if (
      profile.safety.networkMode === 'allowlist' &&
      profile.safety.networkAllowlist.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['safety', 'networkAllowlist'],
        message: 'allowlist mode requires at least one network host',
      });
    }
    if (profile.logging.maxSessionBytes > profile.logging.maxTotalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['logging', 'maxSessionBytes'],
        message: 'maxSessionBytes must not exceed maxTotalBytes',
      });
    }
    if (profile.channel === 'ga') {
      for (const capability of RELEASE_CAPABILITIES) {
        const state = profile.capabilities[capability];
        if (
          state.maxRollout !== 'off' &&
          !(state.maturity === 'stable' && state.maxRollout === 'general')
        ) {
          context.addIssue({
            code: 'custom',
            path: ['capabilities', capability],
            message: 'GA profiles may enable only stable capabilities at general rollout',
          });
        }
      }
    }
  })
  .transform((profile) => ({
    ...profile,
    capabilities: Object.fromEntries(
      RELEASE_CAPABILITIES.map((capability) => [
        capability,
        { ...profile.capabilities[capability] },
      ]),
    ) as Record<ReleaseCapability, CapabilityReleaseState>,
    safety: normalizeSafetySets(profile.safety),
    data: normalizeDataSets(profile.data),
  }));

export type ReleaseProfileV1 = z.infer<typeof releaseProfileV1Schema>;
export type ReleaseChannelV1 = ReleaseProfileV1['channel'];
export type ReleaseProfileApprovalRequirementV1 = CapabilityApproval;
export type ReleaseProfileVerificationRequirementV1 = VerificationMode;

export class ProductionReleaseProfileAdmissionError extends Error {
  readonly reason:
    | 'feature_disabled'
    | 'distribution_target_capabilities_not_off'
    | 'distribution_target_identity_missing'
    | 'distribution_target_identity_unsupported'
    | 'production_internal_profile'
    | 'profile_not_embedded';

  constructor(
    reason:
      | 'feature_disabled'
      | 'distribution_target_capabilities_not_off'
      | 'distribution_target_identity_missing'
      | 'distribution_target_identity_unsupported'
      | 'production_internal_profile'
      | 'profile_not_embedded',
  ) {
    super(`Production release profile admission denied: ${reason}`);
    this.name = 'ProductionReleaseProfileAdmissionError';
    this.reason = reason;
  }
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeSafetySets(safety: z.input<typeof releaseSafetyV1Schema>) {
  const networkDenylist = normalizeSet(safety.networkDenylist);
  const mcpProviderDenylist = normalizeSet(safety.mcpProviderDenylist);
  const deniedNetworkHosts = new Set(networkDenylist);
  const deniedMcpProviders = new Set(mcpProviderDenylist);
  const networkAllowlist = normalizeSet(safety.networkAllowlist).filter(
    (host) => !deniedNetworkHosts.has(host),
  );
  return {
    ...safety,
    networkMode:
      safety.networkMode === 'allowlist' && networkAllowlist.length === 0
        ? ('off' as const)
        : safety.networkMode,
    networkAllowlist,
    networkDenylist,
    protectedPaths: normalizeSet(safety.protectedPaths),
    mcpProviderAllowlist: normalizeSet(safety.mcpProviderAllowlist).filter(
      (provider) => !deniedMcpProviders.has(provider),
    ),
    mcpProviderDenylist,
  };
}

function normalizeDataSets(data: z.input<typeof releaseDataV1Schema>) {
  const providerRouteDenylist = normalizeSet(data.providerRouteDenylist);
  const deniedRoutes = new Set(providerRouteDenylist);
  return {
    ...data,
    providerRouteAllowlist: normalizeSet(data.providerRouteAllowlist).filter(
      (route) => !deniedRoutes.has(route),
    ),
    providerRouteDenylist,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** @qualification-entry-rejection-v1 {"entrypointId":"runtime","denialFamily":"capability_ceiling_off","sourceKind":"contract","symbol":"allCapabilitiesOff"} */
function allCapabilitiesOff(): Record<ReleaseCapability, CapabilityReleaseState> {
  return Object.fromEntries(
    RELEASE_CAPABILITIES.map((capability) => [
      capability,
      { maturity: 'under_development', maxRollout: 'off' },
    ]),
  ) as Record<ReleaseCapability, CapabilityReleaseState>;
}

/** @qualification-entry-rejection-v1 {"entrypointId":"runtime","denialFamily":"capability_ceiling_off","sourceKind":"contract","symbol":"failClosedEmbeddedProfile"} */
/** @qualification-entry-rejection-v1 {"entrypointId":"runtime","denialFamily":"release_profile_closed","sourceKind":"contract","symbol":"failClosedEmbeddedProfile"} */
function failClosedEmbeddedProfile(
  profileId: EmbeddedReleaseProfileIdV1,
  channel: ReleaseChannelV1,
  canaryCapability?: ReleaseCapability,
): ReleaseProfileV1 {
  return parseReleaseProfileV1({
    version: 1,
    profileId,
    channel,
    capabilities: allCapabilitiesOff(),
    ...(canaryCapability ? { canaryCapability } : {}),
    safety: {
      requireWorkspaceTrust: true,
      requireSandbox: true,
      sandboxUnavailable: 'fail',
      maxInteractionMode: 'accept_edits',
      maxFilesystemScope: 'read_only',
      networkMode: 'off',
      networkAllowlist: [],
      networkDenylist: [],
      allowLocalAndPrivateNetwork: false,
      protectedPathPolicy: 'deny',
      protectedPaths: [],
      allowUnsandboxedAutoExecution: false,
      allowProjectFeatureEscalation: false,
      allowCliFeatureEscalation: false,
      mcpProviderAllowlist: [],
      mcpProviderDenylist: [],
    },
    resources: {
      maxRunDurationMs: 0,
      maxTurns: 0,
      maxModelRequests: 0,
      maxToolInvocations: 0,
      maxRunInputTokens: 0,
      maxRunOutputTokens: 0,
      maxConcurrentSubagents: 0,
      maxConcurrentWriters: 0,
      maxConcurrentToolInvocations: 0,
      maxConcurrentShellInvocations: 0,
      maxProcessTreeSizePerShellInvocation: 0,
      maxConcurrencyWaitMs: 0,
      maxArtifactBytes: 0,
    },
    data: {
      providerRouteAllowlist: [],
      providerRouteDenylist: [],
      maxWorkspaceDataClassification: 'public',
      allowRemoteMcpContentEgress: false,
      allowProductionContentEvaluation: false,
    },
    logging: {
      defaultMode: 'off',
      allowContentOptIn: false,
      retentionDays: 0,
      maxTotalBytes: 0,
      maxSessionBytes: 0,
    },
    telemetry: { allowed: false, requiresConsent: true, endpointPolicy: 'admin_only' },
    requirements: { minimumApproval: 'user', minimumVerification: 'required' },
  });
}

/**
 * Static, non-distributable ceilings. D-04 keeps every capability and budget
 * closed; these values are schema fixtures until an ADR admits a real target.
 */
export const EMBEDDED_RELEASE_PROFILES_V1: Readonly<
  Record<EmbeddedReleaseProfileIdV1, ReleaseProfileV1>
> = deepFreeze(
  Object.fromEntries(
    EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1.map((declaration) => [
      declaration.profileId,
      failClosedEmbeddedProfile(
        declaration.profileId,
        declaration.channel,
        declaration.canaryCapability,
      ),
    ]),
  ) as Record<EmbeddedReleaseProfileIdV1, ReleaseProfileV1>,
);

export function parseReleaseProfileV1(value: unknown): ReleaseProfileV1 {
  return releaseProfileV1Schema.parse(value);
}

/**
 * Bind a production composition to one release-owned distribution identity.
 * The controlled-config boundary calls this again so an in-memory forged
 * composition cannot bypass the release profile admission decision.
 */
/** @qualification-entry-rejection-v1 {"entrypointId":"runtime","denialFamily":"unadmitted_execution_target","sourceKind":"contract","symbol":"admitProductionDistributionTargetIdentityV1"} */
export function admitProductionDistributionTargetIdentityV1(input: {
  profile: ReleaseProfileV1;
  production: true;
  distributionTargetIdentity?: string;
}): ProductionDistributionTargetIdentityV1;
export function admitProductionDistributionTargetIdentityV1(input: {
  profile: ReleaseProfileV1;
  production: false;
  distributionTargetIdentity?: string;
}): undefined;
export function admitProductionDistributionTargetIdentityV1(input: {
  profile: ReleaseProfileV1;
  production: boolean;
  distributionTargetIdentity?: string;
}): ProductionDistributionTargetIdentityV1 | undefined;
export function admitProductionDistributionTargetIdentityV1(input: {
  profile: ReleaseProfileV1;
  production: boolean;
  distributionTargetIdentity?: string;
}): ProductionDistributionTargetIdentityV1 | undefined {
  if (!input.production) return undefined;
  if (input.profile.channel === 'internal') {
    throw new ProductionReleaseProfileAdmissionError('production_internal_profile');
  }
  if (Object.values(input.profile.capabilities).some((state) => state.maxRollout !== 'off')) {
    throw new ProductionReleaseProfileAdmissionError('distribution_target_capabilities_not_off');
  }
  return parseProductionDistributionTargetIdentityV1(input.distributionTargetIdentity);
}

/** @qualification-entry-rejection-v1 {"entrypointId":"runtime","denialFamily":"release_profile_closed","sourceKind":"contract","symbol":"admitEmbeddedReleaseProfileV1"} */
/** Admission must run before any production Runtime/provider/transport exists. */
export function admitEmbeddedReleaseProfileV1(input: {
  profileId: EmbeddedReleaseProfileIdV1;
  releaseProfileV1Enabled: boolean;
  production?: boolean;
  distributionTargetIdentity?: string;
}): ReleaseProfileV1 {
  if (!input.releaseProfileV1Enabled) {
    throw new ProductionReleaseProfileAdmissionError('feature_disabled');
  }
  const profile = EMBEDDED_RELEASE_PROFILES_V1[input.profileId];
  if (!profile) throw new ProductionReleaseProfileAdmissionError('profile_not_embedded');
  admitProductionDistributionTargetIdentityV1({
    profile,
    production: input.production ?? false,
    distributionTargetIdentity: input.distributionTargetIdentity,
  });
  return parseReleaseProfileV1(profile);
}
