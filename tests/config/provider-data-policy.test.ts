import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProviderDataPolicyRegistryV1,
  evaluateProviderDataAdmissionV1,
  loadProviderDataPolicyRegistryV1,
  providerPayloadFromModelPromptV1,
} from '@/core/config/provider-data-admission';
import {
  computeProviderDataPolicyBundleDigest,
  computeProviderEndpointIdentityDigest,
  parseProviderDataPolicyBundleV1,
  parseProviderDataPolicyV1,
  raiseWorkspaceDataLabelV1,
} from '@/core/config/provider-data-policy';
import {
  loadProviderRouteCandidateBundleV1,
  providerRouteCandidateBundleV1Schema,
} from '@/core/config/provider-route-candidate';
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

  test('records DeepSeek as a non-admissible candidate without widening the approved bundle', () => {
    const candidates = loadProviderRouteCandidateBundleV1(new Date('2026-08-02T12:00:00.000Z'));
    expect(candidates.revision).toBe('d14-candidates-2026-08-02.1');
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]).toMatchObject({
      candidateId: 'deepseek-official-region-unknown-v4-flash',
      status: 'blocked_policy_evidence',
      modelIds: ['deepseek-v4-flash'],
      route: { region: 'unknown' },
      assessment: { processingRegion: 'unknown', productionContentAllowed: false },
    });
    const approved = parseProviderDataPolicyBundleV1(
      JSON.parse(
        readFileSync(
          join(process.cwd(), 'release/provider-data-policies/approved-v1.json'),
          'utf8',
        ),
      ),
    );
    expect(approved.policies).toEqual([]);
    expect(() => loadProviderRouteCandidateBundleV1(new Date('2026-09-01T00:00:00.000Z'))).toThrow(
      'stale',
    );
    const duplicatePurpose = structuredClone(candidates);
    duplicatePurpose.candidates[0]!.officialSources[3]!.purpose = 'privacy_policy';
    expect(() => providerRouteCandidateBundleV1Schema.parse(duplicatePurpose)).toThrow(
      'exactly one official source',
    );
    for (const replacement of [
      'https://attacker.example/policy',
      'https://user@cdn.deepseek.com/policy',
      'https://cdn.deepseek.com:8443/policy',
      'http://cdn.deepseek.com/policy',
    ]) {
      const substituted = structuredClone(candidates);
      substituted.candidates[0]!.officialSources.find(
        (source) => source.purpose === 'privacy_policy',
      )!.url = replacement;
      expect(() => providerRouteCandidateBundleV1Schema.parse(substituted)).toThrow(
        'pinned DeepSeek HTTPS origin',
      );
    }
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

  test('fails closed when prompt provenance loses an explicit workspace label', () => {
    const payload = providerPayloadFromModelPromptV1([
      { role: 'system', content: 'runtime-owned instructions' },
      { role: 'user', content: 'user-provided context' },
      { role: 'tool', content: 'workspace file contents' },
    ]);
    expect(payload.map((part) => part.label)).toEqual([
      {
        classification: 'internal',
        source: 'artifact',
        provenance: 'generated_summary',
      },
      {
        classification: 'confidential',
        source: 'artifact',
        provenance: 'user_prompt',
      },
      {
        classification: 'confidential',
        source: 'artifact',
        provenance: 'tool_result',
      },
    ]);
  });

  test('loads only the canonical bundle and fails closed on digest drift or expiry', () => {
    const bundle = {
      version: 1 as const,
      decisionId: 'D-14' as const,
      revision: 'registry-1',
      policies: [policy()],
    };
    const registry = createProviderDataPolicyRegistryV1(bundle, new Date('2026-08-01T00:00:00Z'));
    const admitted = evaluateProviderDataAdmissionV1({
      featureEnabled: true,
      profile: 'limited',
      registry,
      route,
      now: new Date('2026-08-01T00:00:00Z'),
      payload: [
        {
          kind: 'user_prompt',
          text: 'summarize public API behavior',
          label: {
            classification: 'internal',
            source: 'artifact',
            provenance: 'user_prompt',
          },
        },
      ],
    });
    expect(admitted).toMatchObject({
      admitted: true,
      reason: 'admitted',
      routeAlias: 'openai-compatible:operator.example:primary:US-EAST',
      maxWorkspaceDataClassification: 'confidential',
    });
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'limited',
        registry,
        route,
        now: new Date('2026-08-01T00:00:00Z'),
        purpose: 'auto_review',
        payload: [],
      }),
    ).toMatchObject({
      admitted: false,
      reason: 'provider_content_evaluation_denied',
    });
    expect(admitted).not.toHaveProperty('endpointOrigin');
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'limited',
        registry,
        expectedRegistryDigest: `sha256:${'0'.repeat(64)}`,
        route,
        payload: [],
      }).reason,
    ).toBe('provider_route_identity_mismatch');
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'limited',
        registry,
        route,
        now: new Date('2028-01-01T00:00:00Z'),
        payload: [],
      }).reason,
    ).toBe('provider_policy_expired');
  });

  test('loads the release warehouse without allowing config overlays', () => {
    const registry = loadProviderDataPolicyRegistryV1(
      join(process.cwd(), 'release/provider-data-policies/approved-v1.json'),
      new Date('2026-07-30T00:00:00Z'),
    );
    expect(registry.revision).toBe('m0-empty-2026-07-30');
    expect(registry.policiesByRouteDigest).toEqual({});
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'limited',
        registry,
        route,
        payload: [],
      }),
    ).toMatchObject({ admitted: false, reason: 'provider_policy_missing' });
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'internal_experimental',
        registry,
        route,
        payload: [
          {
            kind: 'file_snippet',
            text: 'confidential design',
            label: {
              classification: 'confidential',
              source: 'artifact',
              provenance: 'workspace_file',
            },
          },
        ],
      }),
    ).toMatchObject({ admitted: false, reason: 'provider_data_classification_denied' });
    expect(
      evaluateProviderDataAdmissionV1({
        featureEnabled: true,
        profile: 'internal_experimental',
        registry,
        route,
        payload: [
          {
            kind: 'user_prompt',
            text: 'read ~/.ssh/id_ed25519',
            label: {
              classification: 'internal',
              source: 'artifact',
              provenance: 'user_prompt',
            },
          },
        ],
      }),
    ).toMatchObject({ admitted: false, reason: 'provider_secret_denied' });
  });
});
