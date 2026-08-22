import type { MetricExporterV1 } from '@kite/runtime-host';
import {
  admitProductionDistributionTargetIdentityV1,
  parseReleaseProfileV1,
} from '#app/config/release-profile';
import type { ReleaseCompositionV1 } from '#app/release/composition-root';
import { composeObservabilityV1 } from './composition';
import {
  type AdminObservabilityPolicyV1,
  type ProjectTelemetryConfigV1,
  resolveTelemetryConsentV1,
  type UserTelemetryConfigV1,
} from './consent';

export type ExternalCanaryTelemetryBlockReasonV1 =
  | 'artifact_authority_missing'
  | 'artifact_authority_invalid'
  | 'release_channel_not_canary'
  | 'capability_disabled'
  | 'telemetry_disabled'
  | 'mandatory_audit_unavailable'
  | 'exporter_missing'
  | ReturnType<typeof resolveTelemetryConsentV1>['reason'];

/**
 * External canary cohort composition fixes the release channel to `canary` so
 * callers cannot accidentally reuse ordinary limited consent without the
 * separate canary opt-in.
 */
export function composeExternalCanaryObservabilityV1(input: {
  releaseComposition?: ReleaseCompositionV1;
  user?: UserTelemetryConfigV1;
  project?: ProjectTelemetryConfigV1;
  admin?: AdminObservabilityPolicyV1;
  exporter?: MetricExporterV1;
  queueCapacity?: number;
}) {
  const release = input.releaseComposition;
  const suppliedProductionRelease = release?.active === true && release.production === true;
  let productionRelease: { profile: ReturnType<typeof parseReleaseProfileV1> } | undefined;
  if (suppliedProductionRelease) {
    try {
      const profile = parseReleaseProfileV1(release.profile);
      admitProductionDistributionTargetIdentityV1({
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
  const consent = resolveTelemetryConsentV1({
    releaseChannel: 'canary',
    user: input.user,
    project: input.project,
    admin: input.admin,
  });
  const composition = composeObservabilityV1({
    artifactTelemetryAllowed: telemetryAllowed,
    featureEnabled: capabilityEnabled,
    consent,
    exporter: input.exporter,
    queueCapacity: input.queueCapacity,
    releaseRouteAliases: new Set(canaryRelease?.profile.data.providerRouteAllowlist ?? []),
    modelVisibleCapabilityAliases: new Set(canaryCapability ? [canaryCapability] : []),
  });
  const blockReason: ExternalCanaryTelemetryBlockReasonV1 | undefined = !artifactAuthorityPresent
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
