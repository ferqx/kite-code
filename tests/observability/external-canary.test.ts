import { describe, expect, test } from 'bun:test';
import type { TelemetryConsentGrantV1 } from '@/app/observability/consent';
import { composeExternalCanaryObservabilityV1 } from '@/app/observability/external-canary';
import { resolveReleaseCompositionV1 } from '@/app/release/composition-root';
import { type AgentConfig, EMBEDDED_RELEASE_PROFILES_V1 } from '@/core/config';
import { createMetricSampleV1 } from '@/core/observability/metrics';

const grant: TelemetryConsentGrantV1 = {
  state: 'granted',
  metricCategories: ['run_turn', 'runtime_resource'],
  receiver: 'Kite Operations',
  retentionDays: 30,
  withdrawalMethod: 'Disable telemetry in user settings.',
  canaryOptIn: true,
};

describe('external canary telemetry admission', () => {
  const config: AgentConfig = {
    apiKey: '',
    baseURL: '',
    providerName: 'test',
    providerType: 'openai-compatible',
    modelName: 'test',
    features: { releaseProfileV1: true },
    sandbox: { enabled: true },
  };
  const unavailableCanary = resolveReleaseCompositionV1({
    config,
    artifactReleaseProfileV1Enabled: true,
    profileId: 'capability-canary',
    production: true,
    distributionTargetIdentity: 'ubuntu-24.04-x64',
  });

  test('requires release-owned canary authority and separate canary opt-in', () => {
    const common = {
      exporter: { export: async () => {} },
      user: { enabled: true, endpointPolicy: 'vendor_managed' as const, consent: grant },
    };
    expect(composeExternalCanaryObservabilityV1(common)).toMatchObject({
      cohortAdmission: 'blocked',
      blockReason: 'artifact_authority_missing',
    });
    expect(
      composeExternalCanaryObservabilityV1({ ...common, releaseComposition: unavailableCanary }),
    ).toMatchObject({ cohortAdmission: 'blocked', blockReason: 'artifact_authority_missing' });
    const missingOptIn = composeExternalCanaryObservabilityV1({
      ...common,
      user: { ...common.user, consent: { ...grant, canaryOptIn: false } },
    });
    expect(missingOptIn).toMatchObject({
      cohortAdmission: 'blocked',
      blockReason: 'artifact_authority_missing',
    });
    expect(missingOptIn.consent.reason).toBe('canary_opt_in_missing');

    const forgedProfile = structuredClone(EMBEDDED_RELEASE_PROFILES_V1['capability-canary']);
    forgedProfile.capabilities.builtin_read_tools.maxRollout = 'canary';
    forgedProfile.telemetry.allowed = true;
    expect(
      composeExternalCanaryObservabilityV1({
        ...common,
        releaseComposition: {
          version: 1,
          active: true,
          production: true,
          distributionTargetIdentity: 'ubuntu-24.04-x64',
          profile: forgedProfile,
        },
      }),
    ).toMatchObject({ cohortAdmission: 'blocked', blockReason: 'artifact_authority_invalid' });
  });

  test('withdrawal and project enable requests block the cohort', () => {
    const base = {
      exporter: { export: async () => {} },
      user: { enabled: true, endpointPolicy: 'vendor_managed' as const, consent: grant },
    };
    expect(composeExternalCanaryObservabilityV1(base).blockReason).toBe(
      'artifact_authority_missing',
    );
    const projectBlocked = composeExternalCanaryObservabilityV1({
      ...base,
      project: { enabled: true },
    }).blockReason;
    expect(projectBlocked).toBe('artifact_authority_missing');
    const auditBlocked = composeExternalCanaryObservabilityV1({
      ...base,
      admin: { mandatoryAudit: { required: true, available: false } },
    });
    expect(auditBlocked).toMatchObject({
      cohortAdmission: 'blocked',
      blockReason: 'artifact_authority_missing',
      managedSessionAdmission: 'denied',
    });
  });

  test('rebuilds samples strictly and enforces consented metric categories before export', async () => {
    const exported: unknown[] = [];
    const composition = composeExternalCanaryObservabilityV1({
      exporter: {
        export: async (samples) => {
          exported.push(...samples);
        },
      },
      user: {
        enabled: true,
        endpointPolicy: 'vendor_managed',
        consent: { ...grant, metricCategories: ['run_turn'] },
      },
    });
    const run = createMetricSampleV1({
      name: 'run_total',
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    composition.reporter.report({ ...run, prompt: 'SECRET' } as never);
    composition.reporter.report(
      createMetricSampleV1({
        name: 'model_request_total',
        observedAt: '2026-08-02T00:00:00.000Z',
      }),
    );
    composition.reporter.report(run);
    await composition.reporter.flush(100);
    expect(exported).toEqual([]);
    expect(composition.reporter.status().enabled).toBe(false);
  });
});
