import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createSourceOwnedQualificationCatalogV1,
  generateSourceOwnedFeatureMatrixV1,
} from '../../../release/qualification/source-owned-surface-v1';
import { diagnosticRouteIdentityV1Schema } from '../../../scripts/evals/contracts/qualification/evidence/live-observation-schema-v1';
import {
  assertLiveSuiteCorpusContentV1,
  assertLiveSuiteFixtureContentV1,
  assertLiveSuiteFixtureMatchesPolicyV1,
  assertLiveSuiteRunnerBindingV1,
  assertLiveSuiteRunnerSourceDriftV1,
  assertLiveSuiteSourceOwnedMatrixProjectionV1,
  buildLiveRouteDeclarationV1,
  buildLiveRouteDiagnosticIdentityV1,
  computeLiveSuiteRunnerDigestV1,
  computeLiveSuiteRunnerSourceDigestV1,
  diagnosticProviderDataPolicyV1Schema,
  getRegisteredLiveRouteDeclarationV1,
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
  L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
  L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
  L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1,
  L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1,
  L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
  L3_QWEN_LIVE_ROUTE_IDENTITY_V1,
  liveRouteDeclarationV1Schema,
  materializeL3LiveCompatibilityCorpusBytesV1,
  materializeL3LiveCompatibilityFixtureBytesV1,
  resolveLiveRouteForModelBoundaryV1,
} from '../../../scripts/evals/contracts/qualification/live-route-resolver-v1';
import {
  buildLiveSuitePolicyV1,
  liveSuitePolicyV1Schema,
  liveSuiteToolEnvironmentV1Schema,
} from '../../../scripts/evals/contracts/qualification/live-suite-policy-v1';

const ROUTE_ID = 'qualification-l3-qwen3.6-flash-v1';
const SENTINEL_KEY = 'live-route-credential-sentinel-not-for-output';
const QWEN_ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const NOW = '2026-08-06T00:00:00.000Z';
const FIXTURE_CONTENT_SENTINEL = 'classification=sealed_synthetic';
const CORPUS_CONTENT_SENTINEL = 'Return exactly ACK.';

function resolve(input: Partial<Parameters<typeof resolveLiveRouteForModelBoundaryV1>[0]> = {}) {
  return resolveLiveRouteForModelBoundaryV1({
    explicitOptIn: true,
    routeId: ROUTE_ID,
    policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
    environment: {
      KITE_QUALIFICATION_QWEN_API_KEY: SENTINEL_KEY,
      KITE_QUALIFICATION_QWEN_BASE_URL: QWEN_ENDPOINT,
    },
    now: NOW,
    ...input,
  });
}

describe('AQ-8 L3 live route declaration and resolver', () => {
  test('uses one checked-in metadata-only Qwen route and a separately diagnostic policy', () => {
    expect(getRegisteredLiveRouteDeclarationV1(ROUTE_ID)).toEqual(
      L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
    );
    expect(L3_QWEN_LIVE_ROUTE_DECLARATION_V1).toMatchObject({
      schema: 'LiveRouteDeclarationV1',
      routeAlias: 'qualification-qwen3.6-flash',
      providerAdapter: 'openai-compatible',
      protocolFamily: 'openai_compatible',
      model: 'qwen3.6-flash',
      governance: { retentionClass: 'ephemeral_local' },
    });
    expect(L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1).toMatchObject({
      schema: 'LiveSuitePolicyV1',
      authority: 'diagnostic',
      evidenceEligible: false,
      routeId: ROUTE_ID,
      routeDeclarationDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.declarationDigest,
      routeIdentityDigest: L3_QWEN_LIVE_ROUTE_IDENTITY_V1.routeIdentityDigest,
      providerDataPolicyDigest: L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest,
      capabilitySourceBindingDigest:
        L3_QWEN_LIVE_ROUTE_DECLARATION_V1.capabilitySourceBindingDigest,
      maxRetries: 0,
      terminalOutcomes: ['cancelled', 'success'],
      credentialSources: ['environment'],
      toolEnvironment: L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1,
      toolEnvironmentDigest: L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1.toolEnvironmentDigest,
      sourceOwnedIdentity: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
      candidateClosureDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
    });
    expect(L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1).toEqual({
      schema: 'LiveSuiteToolEnvironmentV1',
      version: 1,
      toolExecution: 'in_process_fake_only',
      skillExecution: 'in_process_fake_only',
      subagentExecution: 'in_process_fake_only',
      mcpTransport: 'denied',
      stdioChildren: 'denied',
      shellChildren: 'denied',
      childEnvironmentAllowlist: [],
      toolEnvironmentDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.toolEnvironmentDigest,
    });
    expect(
      liveSuiteToolEnvironmentV1Schema.parse(L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1),
    ).toEqual(L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1);
    expect(diagnosticRouteIdentityV1Schema.parse(L3_QWEN_LIVE_ROUTE_IDENTITY_V1)).toEqual(
      L3_QWEN_LIVE_ROUTE_IDENTITY_V1,
    );

    const serialized = JSON.stringify({
      declaration: L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      dataPolicy: L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      candidate: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
    });
    expect(serialized).not.toContain(QWEN_ENDPOINT);
    expect(serialized).not.toContain('KITE_QUALIFICATION_QWEN_API_KEY');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain(FIXTURE_CONTENT_SENTINEL);
    expect(serialized).not.toContain(CORPUS_CONTENT_SENTINEL);
    expect(L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1).toMatchObject({
      schema: 'DiagnosticCandidateArtifactClosureV1',
      version: 1,
      artifacts: [
        {
          platformIdentity: 'local-host',
          artifact: {
            payloadSha256: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest,
            canonicalManifestDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureDigest,
            behaviorDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.identityDigest,
            profileDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
          },
        },
      ],
    });
    expect(L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.candidateClosureDigest).toBe(
      L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
    );
    assertLiveSuiteFixtureMatchesPolicyV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
    });
    const { policyDigest: _policyDigest, ...policyMaterial } =
      L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1;
    const candidateSplicedPolicy = buildLiveSuitePolicyV1({
      ...policyMaterial,
      candidateClosureDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(() =>
      assertLiveSuiteFixtureMatchesPolicyV1({
        policy: candidateSplicedPolicy,
        fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      }),
    ).toThrow('live_suite_fixture_policy_mismatch');
    assertLiveSuiteFixtureContentV1({
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      content: materializeL3LiveCompatibilityFixtureBytesV1(),
    });
    assertLiveSuiteCorpusContentV1({
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      content: materializeL3LiveCompatibilityCorpusBytesV1(),
    });
    expect(new TextDecoder().decode(materializeL3LiveCompatibilityCorpusBytesV1())).toBe(
      CORPUS_CONTENT_SENTINEL,
    );
    const firstFixture = materializeL3LiveCompatibilityFixtureBytesV1();
    const secondFixture = materializeL3LiveCompatibilityFixtureBytesV1();
    firstFixture[0] = firstFixture[0] === 0 ? 1 : 0;
    expect(secondFixture).not.toEqual(firstFixture);
    assertLiveSuiteRunnerBindingV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      runnerId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
      runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest as `sha256:${string}`,
    });
  });

  test('keeps the runtime L3 identity as a checked-in projection of the source-owned Matrix', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateSourceOwnedFeatureMatrixV1();
    const feature = matrix.features.find(
      (candidate) => candidate.id === 'MODEL_CONTEXT-ROUTE_POLICY-001',
    );
    const required = feature?.requiredEvidence.find(
      (requirement) =>
        requirement.layer === 'contract' &&
        requirement.suiteIds.includes('source-owned-surface-contract-v1'),
    );
    const matrixSuite = catalog.suites.find(
      (suite) => suite.suiteId === 'source-owned-surface-contract-v1',
    );
    if (!feature || !required || !matrixSuite)
      throw new Error('l3_source_owned_matrix_fact_missing');
    const assertionId = required.assertionIds[0];
    if (!assertionId) throw new Error('l3_source_owned_matrix_assertion_missing');

    assertLiveSuiteSourceOwnedMatrixProjectionV1({
      identity: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
      matrixDigest: matrix.matrixDigest as `sha256:${string}`,
      sourceSurfaceId: feature.sourceSurfaceId,
      featureId: feature.id,
      assertionId,
      matrixSuiteId: matrixSuite.suiteId,
      matrixSuiteDigest: matrixSuite.suiteDigest as `sha256:${string}`,
    });
    expect(L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.sourceOwnedIdentity.identityDigest).toBe(
      L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.sourceOwnedIdentity.identityDigest,
    );
    expect(() =>
      assertLiveSuiteSourceOwnedMatrixProjectionV1({
        identity: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
        matrixDigest: `sha256:${'f'.repeat(64)}`,
        sourceSurfaceId: feature.sourceSurfaceId,
        featureId: feature.id,
        assertionId,
        matrixSuiteId: matrixSuite.suiteId,
        matrixSuiteDigest: matrixSuite.suiteDigest as `sha256:${string}`,
      }),
    ).toThrow('live_suite_source_owned_matrix_drift');
  });

  test('binds the exact sealed runner source bytes without placing source in a record or report', () => {
    const runnerSource = readFileSync(
      new URL('../../../scripts/evals/qualification/run-l3-live-compatibility.ts', import.meta.url),
    );
    const sourceDigest = computeLiveSuiteRunnerSourceDigestV1(runnerSource);
    expect(sourceDigest).toBe(
      L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerSourceDigest as `sha256:${string}`,
    );
    expect(
      computeLiveSuiteRunnerDigestV1({
        runnerId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
        runnerSourceDigest: sourceDigest,
      }),
    ).not.toBe(
      computeLiveSuiteRunnerDigestV1({
        runnerId: 'qualification-l3-other-runner-v1',
        runnerSourceDigest: sourceDigest,
      }),
    );
    assertLiveSuiteRunnerSourceDriftV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      runnerId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
      sourceBytes: runnerSource,
    });
    expect(() =>
      assertLiveSuiteRunnerSourceDriftV1({
        policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
        fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
        runnerId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
        sourceBytes: new Uint8Array([...runnerSource, 0]),
      }),
    ).toThrow('live_suite_runner_source_drift');
  });

  test('requires explicit opt-in and exposes credential data only in the model-boundary lease', () => {
    const withoutOptIn = resolve({ explicitOptIn: false });
    expect(withoutOptIn).toMatchObject({
      status: 'blocked',
      authority: 'diagnostic',
      evidenceEligible: false,
      reasonCode: 'explicit_opt_in_required',
    });

    const resolved = resolve();
    expect(resolved.status).toBe('ready');
    if (resolved.status !== 'ready') throw new Error('live_route_expected_ready');
    expect(Object.keys(resolved).sort()).toEqual([
      'authority',
      'credentialSource',
      'evidenceEligible',
      'governance',
      'policyDigest',
      'policyId',
      'route',
      'status',
    ]);
    expect(resolved.route).toEqual(L3_QWEN_LIVE_ROUTE_IDENTITY_V1);
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(resolved)).not.toContain(QWEN_ENDPOINT);
    expect(JSON.stringify(resolved)).not.toContain('apiKey');

    const received = resolved.modelBoundary.withModelTransport((transport) => ({
      providerAdapter: transport.providerAdapter,
      protocolFamily: transport.protocolFamily,
      model: transport.model,
      hasExpectedEndpoint: transport.baseURL === QWEN_ENDPOINT,
      hasExpectedCredential: transport.apiKey === SENTINEL_KEY,
      serializedTransport: JSON.stringify(transport),
    }));
    expect(received).toEqual({
      providerAdapter: 'openai-compatible',
      protocolFamily: 'openai_compatible',
      model: 'qwen3.6-flash',
      hasExpectedEndpoint: true,
      hasExpectedCredential: true,
      serializedTransport: '{}',
    });
    expect(JSON.stringify(resolved.modelBoundary)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(resolved.modelBoundary)).not.toContain(QWEN_ENDPOINT);
  });

  test('fails closed on missing credentials, unknown routes, expiration, and a valid-but-drifted policy', () => {
    expect(resolve({ environment: {} })).toMatchObject({
      status: 'blocked',
      reasonCode: 'endpoint_not_allowed',
    });
    expect(
      resolve({
        environment: {
          KITE_QUALIFICATION_QWEN_API_KEY: SENTINEL_KEY,
          KITE_QUALIFICATION_QWEN_BASE_URL: 'https://example.invalid/compatible-mode/v1',
        },
      }),
    ).toMatchObject({
      status: 'blocked',
      reasonCode: 'endpoint_not_allowed',
    });
    expect(resolve({ routeId: 'qualification-l3-unknown-v1' })).toEqual({
      status: 'blocked',
      authority: 'diagnostic',
      evidenceEligible: false,
      reasonCode: 'route_not_registered',
    });
    expect(resolve({ now: '2027-01-01T00:00:00.000Z' })).toMatchObject({
      status: 'blocked',
      reasonCode: 'policy_expired',
    });

    const { policyDigest: _policyDigest, ...policyMaterial } =
      L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1;
    const driftedPolicy = buildLiveSuitePolicyV1({
      ...policyMaterial,
      routeDeclarationDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(resolve({ policy: driftedPolicy })).toMatchObject({
      status: 'blocked',
      reasonCode: 'route_policy_mismatch',
    });

    const { policyDigest: _expiredPolicyDigest, ...expiredPolicyMaterial } =
      L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1;
    const expiredPolicy = buildLiveSuitePolicyV1({
      ...expiredPolicyMaterial,
      expiresAt: '2026-08-05T00:00:01.000Z',
    });
    expect(resolve({ policy: expiredPolicy })).toMatchObject({
      status: 'blocked',
      reasonCode: 'policy_expired',
    });
    expect(resolve({ now: '2026-08-04T00:00:00.000Z' })).toMatchObject({
      status: 'blocked',
      reasonCode: 'policy_not_active',
    });
  });

  test('rejects extra keys and recomputes all route, data-policy, identity, and policy digests', () => {
    expect(
      liveRouteDeclarationV1Schema.safeParse({
        ...L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
        endpoint: QWEN_ENDPOINT,
      }).success,
    ).toBe(false);
    expect(
      diagnosticProviderDataPolicyV1Schema.safeParse({
        ...L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1,
        credential: SENTINEL_KEY,
      }).success,
    ).toBe(false);
    expect(
      liveSuitePolicyV1Schema.safeParse({
        ...L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
        prompt: 'not-permitted',
      }).success,
    ).toBe(false);
    expect(
      liveSuitePolicyV1Schema.safeParse({
        ...L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
        toolEnvironment: {
          ...L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.toolEnvironment,
          mcpTransport: 'allowed',
        },
      }).success,
    ).toBe(false);

    const { declarationDigest: _declarationDigest, ...declarationMaterial } =
      L3_QWEN_LIVE_ROUTE_DECLARATION_V1;
    const rebuiltDeclaration = buildLiveRouteDeclarationV1(declarationMaterial);
    expect(rebuiltDeclaration).toEqual(L3_QWEN_LIVE_ROUTE_DECLARATION_V1);
    expect(buildLiveRouteDiagnosticIdentityV1(rebuiltDeclaration)).toEqual(
      L3_QWEN_LIVE_ROUTE_IDENTITY_V1,
    );
    expect(() =>
      assertLiveSuiteFixtureContentV1({
        fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
        content: new Uint8Array([...materializeL3LiveCompatibilityFixtureBytesV1(), 1]),
      }),
    ).toThrow('live_suite_fixture_content_mismatch');
    expect(() =>
      assertLiveSuiteCorpusContentV1({
        fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
        content: new Uint8Array([...materializeL3LiveCompatibilityCorpusBytesV1(), 1]),
      }),
    ).toThrow('live_suite_corpus_content_mismatch');
    expect(() =>
      assertLiveSuiteRunnerBindingV1({
        policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
        fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
        runnerId: 'qualification-l3-other-runner-v1',
        runnerDigest:
          L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest as `sha256:${string}`,
      }),
    ).toThrow('live_suite_runner_binding_mismatch');
  });

  test('does not import a product config loader, read ambient environment, or implement network dispatch', () => {
    const source = readFileSync(
      new URL(
        '../../../scripts/evals/contracts/qualification/live-route-resolver-v1.ts',
        import.meta.url,
      ),
      'utf8',
    );
    for (const forbidden of [
      'loadAgentConfig',
      'loadProductionAgentConfig',
      'process.env',
      'generateText(',
      'fetch(',
      'console.log',
      'console.error',
      'ReleaseEvidenceV1',
      'gate-evaluator',
      'createSourceOwnedQualificationCatalogV1',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
