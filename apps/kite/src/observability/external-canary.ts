import type { MetricExporter } from '@kite-ai/runtime-host';
import {
  admitProductionDistributionTargetIdentity,
  parseReleaseProfile,
} from '#app/config/release-profile';
import type { ReleaseComposition } from '#app/release/composition-root';
import { composeObservability } from './composition';
import {
  type AdminObservabilityPolicy,
  type ProjectTelemetryConfig,
  resolveTelemetryConsent,
  type UserTelemetryConfig,
} from './consent';

export type ExternalCanaryTelemetryBlockReason =
  | 'artifact_authority_missing'
  | 'artifact_authority_invalid'
  | 'release_channel_not_canary'
  | 'capability_disabled'
  | 'telemetry_disabled'
  | 'mandatory_audit_unavailable'
  | 'exporter_missing'
  | ReturnType<typeof resolveTelemetryConsent>['reason'];

/**
 * External canary cohort composition fixes the release channel to `canary` so
 * callers cannot accidentally reuse ordinary limited consent without the
 * separate canary opt-in.
 */
export function composeExternalCanaryObservability(input: {
  releaseComposition?: ReleaseComposition;
  user?: UserTelemetryConfig;
  project?: ProjectTelemetryConfig;
  admin?: AdminObservabilityPolicy;
  exporter?: MetricExporter;
  queueCapacity?: number;
}) {
  const release = input.releaseComposition;
  const suppliedProductionRelease = release?.active === true && release.production === true;
  let productionRelease: { profile: ReturnType<typeof parseReleaseProfile> } | undefined;
  if (suppliedProductionRelease) {
    try {
      const profile = parseReleaseProfile(release.profile);
      admitProductionDistributionTargetIdentity({
        profile,
        production: true,
        distributionTargetIdentity: release.distributionTargetIdentity,
      });
      productionRelease = { profile };
    } catch {
      productionRelease = undefined;
    }
  }
  const artifactAuthorityPresent = productionRelease !== undefined;
  const canaryRelease =
    productionRelease?.profile.channel === 'canary' ? productionRelease : undefined;
  const canaryProfile = canaryRelease !== undefined;
  const canaryCapability = canaryRelease?.profile.canaryCapability;
  const capabilityEnabled =
    canaryRelease !== undefined &&
    canaryCapability !== undefined &&
    canaryRelease.profile.capabilities[canaryCapability].maxRollout === 'canary';
  const telemetryAllowed = canaryRelease?.profile.telemetry.allowed === true;
  const consent = resolveTelemetryConsent({
    releaseChannel: 'canary',
    user: input.user,
    project: input.project,
    admin: input.admin,
  });
  const composition = composeObservability({
    artifactTelemetryAllowed: telemetryAllowed,
    featureEnabled: capabilityEnabled,
    consent,
    exporter: input.exporter,
    queueCapacity: input.queueCapacity,
    releaseRouteAliases: new Set(canaryRelease?.profile.data.providerRouteAllowlist ?? []),
    modelVisibleCapabilityAliases: new Set(canaryCapability ? [canaryCapability] : []),
  });
  const blockReason: ExternalCanaryTelemetryBlockReason | undefined = !artifactAuthorityPresent
    ? suppliedProductionRelease
      ? 'artifact_authority_invalid'
      : 'artifact_authority_missing'
    : !canaryProfile
      ? 'release_channel_not_canary'
      : !capabilityEnabled
        ? 'capability_disabled'
        : !telemetryAllowed
          ? 'telemetry_disabled'
          : !consent.enabled
            ? consent.reason
            : consent.managedSessionAdmission === 'denied'
              ? 'mandatory_audit_unavailable'
              : !input.exporter
                ? 'exporter_missing'
                : undefined;
  return Object.freeze({
    ...composition,
    consent,
    cohortAdmission: blockReason ? ('blocked' as const) : ('admitted' as const),
    ...(blockReason ? { blockReason } : {}),
  });
}
