import { describe, expect, test } from 'bun:test';
import { createMetricSample } from '@kite/runtime-host';
import { type AgentConfig, EMBEDDED_RELEASE_PROFILES_ } from '#app/config';
import type { TelemetryConsentGrant } from '@/app/observability/consent';
import { composeExternalCanaryObservability } from '@/app/observability/external-canary';
import { resolveReleaseComposition } from '@/app/release/composition-root';

const grant: TelemetryConsentGrant = {
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
    features: { releaseProfile: true },
    sandbox: { enabled: true },
  };
  const unavailableCanary = resolveReleaseComposition({
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
    expect(composeExternalCanaryObservability(common)).toMatchObject({
      cohortAdmission: 'blocked',
      blockReason: 'artifact_authority_missing',
    });
    expect(
      composeExternalCanaryObservability({ ...common, releaseComposition: unavailableCanary }),
    ).toMatchObject({ cohortAdmission: 'blocked', blockReason: 'artifact_authority_missing' });
    const missingOptIn = composeExternalCanaryObservability({
      ...common,
      user: { ...common.user, consent: { ...grant, canaryOptIn: false } },
    });
    expect(missingOptIn).toMatchObject({
      cohortAdmission: 'blocked',
      blockReason: 'artifact_authority_missing',
    });
    expect(missingOptIn.consent.reason).toBe('canary_opt_in_missing');

    const forgedProfile = structuredClone(EMBEDDED_RELEASE_PROFILES_['capability-canary']);
    forgedProfile.capabilities.builtin_read_tools.maxRollout = 'canary';
    forgedProfile.telemetry.allowed = true;
    expect(
      composeExternalCanaryObservability({
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
    expect(composeExternalCanaryObservability(base).blockReason).toBe('artifact_authority_missing');
    const projectBlocked = composeExternalCanaryObservability({
      ...base,
      project: { enabled: true },
    }).blockReason;
    expect(projectBlocked).toBe('artifact_authority_missing');
    const auditBlocked = composeExternalCanaryObservability({
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
    const composition = composeExternalCanaryObservability({
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
    const run = createMetricSample({
      name: 'run_total',
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    composition.reporter.report({ ...run, prompt: 'SECRET' } as never);
    composition.reporter.report(
      createMetricSample({
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
