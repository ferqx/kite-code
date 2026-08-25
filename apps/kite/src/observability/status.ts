import { projectTelemetryStatus, type TelemetryConsentStatus } from './consent';

export interface ObservabilityStatus {
  version: 1;
  active: boolean;
  reason: 'enabled' | 'artifact_disabled' | 'feature_disabled' | TelemetryConsentStatus['reason'];
  artifactAuthority: boolean;
  featureEnabled: boolean;
  consent: ReturnType<typeof projectTelemetryStatus>;
  remoteExporterConfigured: boolean;
  diskSpool: false;
}

export function projectObservabilityStatus(input: {
  artifactTelemetryAllowed: boolean;
  featureEnabled: boolean;
  consent: TelemetryConsentStatus;
  remoteExporterConfigured: boolean;
}): ObservabilityStatus {
  const active =
    input.artifactTelemetryAllowed &&
    input.featureEnabled &&
    input.consent.enabled &&
    input.remoteExporterConfigured;
  const reason: ObservabilityStatus['reason'] = !input.artifactTelemetryAllowed
    ? 'artifact_disabled'
    : !input.featureEnabled
      ? 'feature_disabled'
      : !input.consent.enabled
        ? input.consent.reason
        : !input.remoteExporterConfigured
          ? 'endpoint_disabled'
          : 'enabled';
  return Object.freeze({
    version: 1 as const,
    active,
    reason,
    artifactAuthority: input.artifactTelemetryAllowed,
    featureEnabled: input.featureEnabled,
    consent: projectTelemetryStatus(input.consent),
    remoteExporterConfigured: input.remoteExporterConfigured,
    diskSpool: false as const,
  });
}

export function formatObservabilityStatus(status: ObservabilityStatus): string {
  return [
    `Observability: ${status.active ? 'active' : `inactive (${status.reason})`}`,
    `Artifact authority: ${status.artifactAuthority ? 'present' : 'absent'}`,
    `Metrics feature: ${status.featureEnabled ? 'enabled' : 'disabled'}`,
    `Consent: ${status.consent.consent}`,
    `Endpoint policy: ${status.consent.endpointPolicy}`,
    `Remote exporter: ${status.remoteExporterConfigured ? 'configured' : 'not configured'}`,
    'Disk spool: disabled',
  ].join('\n');
}
