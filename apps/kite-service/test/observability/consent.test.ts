import { describe, expect, test } from 'bun:test';
import { METRIC_DEFINITIONS_ } from '@kite-ai/runtime-host';
import { composeObservability } from '../../src/observability/composition';
import {
  projectTelemetryStatus,
  resolveTelemetryConsent,
  TELEMETRY_METRICS_BY_CATEGORY_,
  type TelemetryConsentGrant,
} from '../../src/observability/consent';
import {
  formatObservabilityStatus,
  projectObservabilityStatus,
} from '../../src/observability/status';

const grant: TelemetryConsentGrant = {
  state: 'granted',
  metricCategories: ['run_turn', 'runtime_resource'],
  receiver: 'Kite Operations',
  retentionDays: 30,
  withdrawalMethod: 'Run telemetry disable in settings.',
  canaryOptIn: true,
};

describe('telemetry consent and composition', () => {
  test('maps every metric to exactly one consent category', () => {
    const categorized = Object.values(TELEMETRY_METRICS_BY_CATEGORY_).flat();
    expect(Array.from(categorized, String).sort()).toEqual(Object.keys(METRIC_DEFINITIONS_).sort());
    expect(new Set(categorized).size).toBe(categorized.length);
  });

  test('is remote-off by default and project configuration can never enable it', () => {
    expect(resolveTelemetryConsent({ releaseChannel: 'limited' })).toMatchObject({
      enabled: false,
      reason: 'default_off',
    });
    expect(
      resolveTelemetryConsent({
        releaseChannel: 'limited',
        project: { enabled: true },
        user: { enabled: true, endpointPolicy: 'vendor_managed', consent: grant },
      }),
    ).toMatchObject({ enabled: false, reason: 'project_enable_forbidden' });
  });

  test('requires explicit consent and a separate canary opt-in', () => {
    expect(
      resolveTelemetryConsent({
        releaseChannel: 'limited',
        user: { enabled: true, endpointPolicy: 'vendor_managed' },
      }).reason,
    ).toBe('consent_missing');
    expect(
      resolveTelemetryConsent({
        releaseChannel: 'canary',
        user: {
          enabled: true,
          endpointPolicy: 'vendor_managed',
          consent: { ...grant, canaryOptIn: false },
        },
      }).reason,
    ).toBe('canary_opt_in_missing');
    expect(
      resolveTelemetryConsent({
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
      resolveTelemetryConsent({
        releaseChannel: 'limited',
        user,
        admin: { forceTelemetryDisabled: true },
      }).reason,
    ).toBe('admin_forced_off');
    expect(
      resolveTelemetryConsent({ releaseChannel: 'limited', user, project: { enabled: false } })
        .reason,
    ).toBe('project_disabled');
    expect(
      resolveTelemetryConsent({
        releaseChannel: 'limited',
        user: { ...user, consent: { ...grant, state: 'withdrawn' } },
      }),
    ).toMatchObject({ enabled: false, consent: 'withdrawn', reason: 'consent_withdrawn' });
  });

  test('content logging and provider consent never imply telemetry consent or leak secrets in status', () => {
    const status = resolveTelemetryConsent({
      releaseChannel: 'limited',
      user: {
        contentLoggingConsent: true,
        modelProviderConsent: true,
        endpointSecret: 'SECRET-ENDPOINT-TOKEN',
      },
    });
    expect(status.enabled).toBeFalse();
    expect(JSON.stringify(projectTelemetryStatus(status))).not.toContain('SECRET-ENDPOINT-TOKEN');
  });

  test('mandatory enterprise audit is separate and unavailable audit denies managed sessions', () => {
    const status = resolveTelemetryConsent({
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
    const consent = resolveTelemetryConsent({
      releaseChannel: 'limited',
      user: { enabled: true, endpointPolicy: 'vendor_managed', consent: grant },
    });
    expect(composeObservability({ consent }).telemetryEnabled).toBeFalse();
    const exporter = { export: async () => {} };
    expect(composeObservability({ consent, exporter, queueCapacity: 2 }).telemetryEnabled).toBe(
      false,
    );
    const composed = composeObservability({
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

    const auditDenied = composeObservability({
      artifactTelemetryAllowed: true,
      featureEnabled: true,
      consent: { ...consent, managedSessionAdmission: 'denied' },
      exporter,
    });
    expect(auditDenied.telemetryEnabled).toBeFalse();
    expect(auditDenied.reporter.status().enabled).toBeFalse();
  });

  test('status keeps ordinary entrypoints inactive and redacts endpoint material', () => {
    const consent = resolveTelemetryConsent({
      releaseChannel: 'limited',
      user: {
        enabled: true,
        endpointPolicy: 'vendor_managed',
        endpointSecret: 'DO-NOT-PRINT-THIS',
        consent: grant,
      },
    });
    const status = projectObservabilityStatus({
      artifactTelemetryAllowed: false,
      featureEnabled: true,
      consent,
      remoteExporterConfigured: true,
    });
    expect(status).toMatchObject({ active: false, reason: 'artifact_disabled' });
    expect(JSON.stringify(status)).not.toContain('DO-NOT-PRINT-THIS');
    expect(formatObservabilityStatus(status)).toContain('Artifact authority: absent');
  });
});
