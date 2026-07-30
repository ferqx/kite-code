import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeProviderDataPolicyBundleDigest,
  computeProviderEndpointIdentityDigest,
  parseProviderDataPolicyBundleV1,
  parseProviderDataPolicyV1,
  raiseWorkspaceDataLabelV1,
} from '@/core/config/provider-data-policy';
import {
  DEFAULT_SESSION_LOGGING_POLICY_V1,
  parseSessionLoggingPolicyV1,
  resolveSessionLoggingPolicyV1,
  tightenSessionLoggingPolicyV1,
} from '@/core/config/session-logging-policy';

const route = {
  providerType: 'openai-compatible',
  operatorId: 'operator.example',
  endpointOrigin: 'https://API.EXAMPLE.test/v1/',
  endpointClass: 'Managed',
  deploymentId: 'primary',
  region: 'US-EAST',
};

function policy() {
  return {
    version: 1 as const,
    policyId: 'example-policy',
    revision: '2026-07-30.1',
    decisionId: 'D-14' as const,
    approvedRevision: 'review-1',
    effectiveFrom: '2026-07-30T00:00:00Z',
    expiresAt: '2027-07-30T00:00:00Z',
    routeId: 'example-primary',
    ...route,
    endpointIdentityDigest: computeProviderEndpointIdentityDigest(route),
    credentialOwner: 'user_os_identity' as const,
    maxWorkspaceDataClassification: 'confidential' as const,
    allowedPayloadKinds: {
      userPrompt: true,
      fileSnippet: true,
      toolResult: false,
      summary: true,
    },
    contentRetention: 'contract-30-days',
    trainingUse: 'prohibited' as const,
    abuseMonitoring: 'metadata_only' as const,
    deletionBoundary: 'provider-contract',
    subprocessors: [],
    dpaOrAdminApproval: 'required_and_verified' as const,
    userDisclosureId: 'provider-disclosure-v1',
    requestLogging: 'metadata' as const,
    errorLogging: 'metadata' as const,
    productDeletionScope: 'local-records-only',
    allowRemoteMcpContentEgress: false,
    allowProductionContentEvaluation: false as const,
  };
}

describe('SessionLoggingPolicyV1', () => {
  test('freezes the D-02 metadata-first default and disables it behind the migration flag', () => {
    expect(DEFAULT_SESSION_LOGGING_POLICY_V1).toEqual({
      version: 1,
      mode: 'metadata',
      retentionDays: 7,
      maxTotalBytes: 256 * 1024 * 1024,
      maxSessionBytes: 16 * 1024 * 1024,
      includeReasoning: false,
      includeFileContent: false,
      includeToolContent: false,
    });
    expect(resolveSessionLoggingPolicyV1({ enabled: false }).mode).toBe('off');
    expect(resolveSessionLoggingPolicyV1({ enabled: true }).mode).toBe('metadata');
  });

  test('allows only monotonic tightening', () => {
    const tightened = tightenSessionLoggingPolicyV1(DEFAULT_SESSION_LOGGING_POLICY_V1, {
      retentionDays: 3,
      maxSessionBytes: 1024,
      mode: 'off',
    });
    expect(tightened).toMatchObject({ retentionDays: 3, maxSessionBytes: 1024, mode: 'off' });
    expect(() => tightenSessionLoggingPolicyV1(tightened, { mode: 'metadata' })).toThrow(
      'cannot be widened',
    );
    expect(() =>
      tightenSessionLoggingPolicyV1(DEFAULT_SESSION_LOGGING_POLICY_V1, { retentionDays: 8 }),
    ).toThrow('can only be lowered');
  });

  test('rejects content-bearing or internally inconsistent policies', () => {
    expect(() =>
      parseSessionLoggingPolicyV1({
        ...DEFAULT_SESSION_LOGGING_POLICY_V1,
        includeReasoning: true,
      }),
    ).toThrow();
    expect(() =>
      parseSessionLoggingPolicyV1({
        ...DEFAULT_SESSION_LOGGING_POLICY_V1,
        maxTotalBytes: 10,
        maxSessionBytes: 11,
      }),
    ).toThrow('maxSessionBytes');
  });
});

describe('ProviderDataPolicyV1', () => {
  test('binds qualification to canonical route identity instead of a model name', () => {
    const digest = computeProviderEndpointIdentityDigest(route);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      computeProviderEndpointIdentityDigest({
        ...route,
        endpointOrigin: 'https://api.example.test/v1',
        endpointClass: 'managed',
        region: 'us-east',
      }),
    ).toBe(digest);
    expect(computeProviderEndpointIdentityDigest({ ...route, deploymentId: 'secondary' })).not.toBe(
      digest,
    );
    expect(parseProviderDataPolicyV1(policy()).endpointIdentityDigest).toBe(digest);
  });

  test('fails closed for route identity drift and invalid review lifetime', () => {
    expect(() =>
      parseProviderDataPolicyV1({
        ...policy(),
        endpointIdentityDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow('canonical route identity');
    expect(() =>
      parseProviderDataPolicyV1({
        ...policy(),
        expiresAt: '2026-07-29T00:00:00Z',
      }),
    ).toThrow('later than');
    expect(() =>
      parseProviderDataPolicyV1({ ...policy(), allowProductionContentEvaluation: true }),
    ).toThrow();
  });

  test('ships an explicitly empty M0-approved route bundle with stable digest', () => {
    const path = join(process.cwd(), 'release/provider-data-policies/approved-v1.json');
    const bundle = parseProviderDataPolicyBundleV1(JSON.parse(readFileSync(path, 'utf8')));
    expect(bundle).toEqual({
      version: 1,
      decisionId: 'D-14',
      revision: 'm0-empty-2026-07-30',
      policies: [],
    });
    expect(computeProviderDataPolicyBundleDigest(bundle)).toBe(
      computeProviderDataPolicyBundleDigest(structuredClone(bundle)),
    );
  });

  test('uses deny-wins classification composition', () => {
    const internal = {
      classification: 'internal' as const,
      source: 'artifact' as const,
      provenance: 'workspace_file' as const,
    };
    const secret = {
      classification: 'secret' as const,
      source: 'runtime_secret_detector' as const,
      provenance: 'user_prompt' as const,
    };
    expect(raiseWorkspaceDataLabelV1(internal, secret)).toEqual(secret);
    expect(raiseWorkspaceDataLabelV1(secret, internal)).toEqual(secret);
  });
});
