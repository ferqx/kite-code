import type { CompactionRouteIdentityV1 } from '../../../scripts/evals/contracts/compaction-route-qualification';

export * from '../../../scripts/evals/contracts/compaction-route-qualification';

export function syntheticRouteIdentity(): CompactionRouteIdentityV1 {
  return {
    version: 1,
    providerType: 'synthetic-provider',
    endpointClass: 'custom',
    deploymentRoute: 'local-fixture-only',
    modelIdentity: 'synthetic-model-v1',
    resolvedCapabilitySources: ['fixture:synthetic'],
    summaryLimit: 4_096,
    tokenLimit: 16_384,
    narrativeLimit: 8_192,
    promptPolicyDigest: `sha256:${'1'.repeat(64)}`,
    estimatorIdentity: 'synthetic-estimator-v1',
    toolSkillEnvironmentDigest: `sha256:${'2'.repeat(64)}`,
    providerDataPolicyDigest: `sha256:${'3'.repeat(64)}`,
    evaluatorDigest: `sha256:${'4'.repeat(64)}`,
    suiteDigest: `sha256:${'5'.repeat(64)}`,
    scorerDigest: `sha256:${'6'.repeat(64)}`,
    artifactDigest: `sha256:${'7'.repeat(64)}`,
  };
}
