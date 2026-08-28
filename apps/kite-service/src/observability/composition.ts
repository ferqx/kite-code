import { createBuiltinObservabilityProjector } from '@kite-ai/builtin-runtime';
import {
  BufferedMetricReporter,
  type MetricExporter,
  type MetricReporter,
  NoopMetricReporter,
  projectRuntimeObservabilityFact,
} from '@kite-ai/runtime-host';
import { allowedMetricNamesForConsent, type TelemetryConsentStatus } from './consent';
import { RuntimeMetricBridge } from './runtime-bridge';

export interface ObservabilityComposition {
  reporter: MetricReporter;
  bridge: RuntimeMetricBridge;
  telemetryEnabled: boolean;
  managedSessionAdmission: 'admitted' | 'denied';
}

export function composeObservability(input: {
  featureEnabled?: boolean;
  artifactTelemetryAllowed?: boolean;
  consent: TelemetryConsentStatus;
  exporter?: MetricExporter;
  queueCapacity?: number;
  releaseRouteAliases?: ReadonlySet<string>;
  modelVisibleCapabilityAliases?: ReadonlySet<string>;
}): ObservabilityComposition {
  const telemetryEnabled =
    input.artifactTelemetryAllowed === true &&
    input.featureEnabled === true &&
    input.consent.enabled &&
    input.consent.managedSessionAdmission === 'admitted' &&
    input.exporter !== undefined;
  const reporter = telemetryEnabled
    ? new BufferedMetricReporter({
        enabled: true,
        capacity: input.queueCapacity ?? 512,
        exporter: input.exporter!,
        allowedMetricNames: allowedMetricNamesForConsent(input.consent.metricCategories),
        controlledAliases: {
          route: input.releaseRouteAliases ?? new Set(),
          capability: input.modelVisibleCapabilityAliases ?? new Set(),
        },
      })
    : new NoopMetricReporter();
  const projector = createBuiltinObservabilityProjector({
    releaseRouteAliases: [...(input.releaseRouteAliases ?? new Set())],
    modelVisibleCapabilityAliases: [...(input.modelVisibleCapabilityAliases ?? new Set())],
  });
  return Object.freeze({
    reporter,
    bridge: new RuntimeMetricBridge({ projector, reporter }),
    telemetryEnabled,
    managedSessionAdmission: input.consent.managedSessionAdmission,
  });
}

/** App composition wrapper; CLI/TUI clients never import Host projection authority directly. */
export function observeRuntimeFact(
  composition: Pick<ObservabilityComposition, 'bridge'>,
  event: unknown,
  observedAt: string,
): void {
  const fact = projectRuntimeObservabilityFact(event, observedAt);
  if (fact) composition.bridge.observeRuntimeFact(fact);
}
