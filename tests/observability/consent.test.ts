import { describe, expect, test } from 'bun:test';
import { METRIC_DEFINITIONS_V1 } from '@kite/runtime-host';
import { composeObservabilityV1 } from '../../apps/kite/src/observability/composition';
import {
  projectTelemetryStatusV1,
  resolveTelemetryConsentV1,
  TELEMETRY_METRICS_BY_CATEGORY_V1,
  type TelemetryConsentGrantV1,
} from '../../apps/kite/src/observability/consent';
import {
  formatObservabilityStatusV1,
  projectObservabilityStatusV1,
} from '../../apps/kite/src/observability/status';

const grant: TelemetryConsentGrantV1 = {
  state: 'granted',
  metricCategories: ['run_turn', 'runtime_resource'],
  receiver: 'Kite Operations',
  retentionDays: 30,
  withdrawalMethod: 'Run telemetry disable in settings.',
  canaryOptIn: true,
};

describe('telemetry consent and composition', () => {
  test('maps every metric to exactly one consent category', () => {
    const categorized = Object.values(TELEMETRY_METRICS_BY_CATEGORY_V1).flat();
    expect(Array.from(categorized, String).sort()).toEqual(
      Object.keys(METRIC_DEFINITIONS_V1).sort(),
    );
    expect(new Set(categorized).size).toBe(categorized.length);
  });

  test('is remote-off by default and project configuration can never enable it', () => {
    expect(resolveTelemetryConsentV1({ releaseChannel: 'limited' })).toMatchObject({
      enabled: false,
      reason: 'default_off',
    });
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'limited',
        project: { enabled: true },
        user: { enabled: true, endpointPolicy: 'vendor_managed', consent: grant },
      }),
    ).toMatchObject({ enabled: false, reason: 'project_enable_forbidden' });
  });

  test('requires explicit consent and a separate canary opt-in', () => {
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'limited',
        user: { enabled: true, endpointPolicy: 'vendor_managed' },
      }).reason,
    ).toBe('consent_missing');
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'canary',
        user: {
          enabled: true,
          endpointPolicy: 'vendor_managed',
          consent: { ...grant, canaryOptIn: false },
        },
      }).reason,
    ).toBe('canary_opt_in_missing');
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'canary',
        user: { enabled: true, endpointPolicy: 'vendor_managed', consent: grant },
      }),
    ).toMatchObject({
      enabled: true,
      consent: 'granted',
      endpointPolicy: 'vendor_managed',
      receiver: 'Kite Operations',
      retentionDays: 30,
    });
  });

  test('admin/project disable and withdrawal are monotonic', () => {
    const user = { enabled: true, endpointPolicy: 'vendor_managed' as const, consent: grant };
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'limited',
        user,
        admin: { forceTelemetryDisabled: true },
      }).reason,
    ).toBe('admin_forced_off');
    expect(
      resolveTelemetryConsentV1({ releaseChannel: 'limited', user, project: { enabled: false } })
        .reason,
    ).toBe('project_disabled');
    expect(
      resolveTelemetryConsentV1({
        releaseChannel: 'limited',
        user: { ...user, consent: { ...grant, state: 'withdrawn' } },
      }),
    ).toMatchObject({ enabled: false, consent: 'withdrawn', reason: 'consent_withdrawn' });
  });

  test('content logging and provider consent never imply telemetry consent or leak secrets in status', () => {
    const status = resolveTelemetryConsentV1({
      releaseChannel: 'limited',
      user: {
        contentLoggingConsent: true,
        modelProviderConsent: true,
        endpointSecret: 'SECRET-ENDPOINT-TOKEN',
      },
    });
    expect(status.enabled).toBeFalse();
    expect(JSON.stringify(projectTelemetryStatusV1(status))).not.toContain('SECRET-ENDPOINT-TOKEN');
  });

  test('mandatory enterprise audit is separate and unavailable audit denies managed sessions', () => {
    const status = resolveTelemetryConsentV1({
      releaseChannel: 'internal',
      admin: { mandatoryAudit: { required: true, available: false } },
    });
    expect(status).toMatchObject({
      enabled: false,
      mandatoryAudit: 'unavailable',
      managedSessionAdmission: 'denied',
    });
  });

  test('composition injects no-op unless flag, consent, and exporter are all present', () => {
    const consent = resolveTelemetryConsentV1({
      releaseChannel: 'limited',
      user: { enabled: true, endpointPolicy: 'vendor_managed', consent: grant },
    });
    expect(composeObservabilityV1({ consent }).telemetryEnabled).toBeFalse();
    const exporter = { export: async () => {} };
    expect(composeObservabilityV1({ consent, exporter, queueCapacity: 2 }).telemetryEnabled).toBe(
      false,
    );
    const composed = composeObservabilityV1({
      artifactTelemetryAllowed: true,
      featureEnabled: true,
      consent,
      exporter,
      queueCapacity: 2,
    });
    expect(composed.telemetryEnabled).toBeTrue();
    expect(composed.reporter.status()).toMatchObject({
      enabled: true,
      capacity: 2,
      diskSpool: false,
    });

    const auditDenied = composeObservabilityV1({
      artifactTelemetryAllowed: true,
      featureEnabled: true,
      consent: { ...consent, managedSessionAdmission: 'denied' },
      exporter,
    });
    expect(auditDenied.telemetryEnabled).toBeFalse();
    expect(auditDenied.reporter.status().enabled).toBeFalse();
  });

  test('status keeps ordinary entrypoints inactive and redacts endpoint material', () => {
    const consent = resolveTelemetryConsentV1({
      releaseChannel: 'limited',
      user: {
        enabled: true,
        endpointPolicy: 'vendor_managed',
        endpointSecret: 'DO-NOT-PRINT-THIS',
        consent: grant,
      },
    });
    const status = projectObservabilityStatusV1({
      artifactTelemetryAllowed: false,
      featureEnabled: true,
      consent,
      remoteExporterConfigured: true,
    });
    expect(status).toMatchObject({ active: false, reason: 'artifact_disabled' });
    expect(JSON.stringify(status)).not.toContain('DO-NOT-PRINT-THIS');
    expect(formatObservabilityStatusV1(status)).toContain('Artifact authority: absent');
  });
});
