import {
  BufferedMetricReporterV1,
  type MetricExporterV1,
  type MetricReporterV1,
  NoopMetricReporterV1,
} from '@/core/observability/reporter';
import { allowedMetricNamesForConsentV1, type TelemetryConsentStatusV1 } from './consent';

export interface ObservabilityCompositionV1 {
  reporter: MetricReporterV1;
  telemetryEnabled: boolean;
  managedSessionAdmission: 'admitted' | 'denied';
}

export function composeObservabilityV1(input: {
  featureEnabled?: boolean;
  artifactTelemetryAllowed?: boolean;
  consent: TelemetryConsentStatusV1;
  exporter?: MetricExporterV1;
  queueCapacity?: number;
  releaseRouteAliases?: ReadonlySet<string>;
  modelVisibleCapabilityAliases?: ReadonlySet<string>;
}): ObservabilityCompositionV1 {
  const telemetryEnabled =
    input.artifactTelemetryAllowed === true &&
    input.featureEnabled === true &&
    input.consent.enabled &&
    input.consent.managedSessionAdmission === 'admitted' &&
    input.exporter !== undefined;
  return Object.freeze({
    reporter: telemetryEnabled
      ? new BufferedMetricReporterV1({
          enabled: true,
          capacity: input.queueCapacity ?? 512,
          exporter: input.exporter!,
          allowedMetricNames: allowedMetricNamesForConsentV1(input.consent.metricCategories),
          controlledAliases: {
            route: input.releaseRouteAliases ?? new Set(),
            capability: input.modelVisibleCapabilityAliases ?? new Set(),
          },
        })
      : new NoopMetricReporterV1(),
    telemetryEnabled,
    managedSessionAdmission: input.consent.managedSessionAdmission,
  });
}
