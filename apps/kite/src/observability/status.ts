import { projectTelemetryStatusV1, type TelemetryConsentStatusV1 } from './consent';

export interface ObservabilityStatusV1 {
  version: 1;
  active: boolean;
  reason: 'enabled' | 'artifact_disabled' | 'feature_disabled' | TelemetryConsentStatusV1['reason'];
  artifactAuthority: boolean;
  featureEnabled: boolean;
  consent: ReturnType<typeof projectTelemetryStatusV1>;
  remoteExporterConfigured: boolean;
  diskSpool: false;
}

export function projectObservabilityStatusV1(input: {
  artifactTelemetryAllowed: boolean;
  featureEnabled: boolean;
  consent: TelemetryConsentStatusV1;
  remoteExporterConfigured: boolean;
}): ObservabilityStatusV1 {
  const active =
    input.artifactTelemetryAllowed &&
    input.featureEnabled &&
    input.consent.enabled &&
    input.remoteExporterConfigured;
  const reason: ObservabilityStatusV1['reason'] = !input.artifactTelemetryAllowed
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
    consent: projectTelemetryStatusV1(input.consent),
    remoteExporterConfigured: input.remoteExporterConfigured,
    diskSpool: false as const,
  });
}

export function formatObservabilityStatusV1(status: ObservabilityStatusV1): string {
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
