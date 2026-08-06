import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1,
  L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1,
  L3_LIVE_AUTO_COMPACTION_POLICY_V1,
  L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1,
  L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
  L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
  L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1,
  L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
  L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1,
} from '../live-auto-compaction-policy-v1';
import {
  LIVE_ISOLATED_TRANSPORT_BINDING_V1,
  liveIsolatedTransportBindingIsClosedV1,
} from '../live-isolated-transport-binding-v1';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './governance-v1';
import {
  computeLiveAutoCompactionDurationBucketPolicyDigestV1,
  LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_DIGEST_V1,
  LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1,
  LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_DIGEST_V1,
  LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_V1,
} from './live-auto-compaction-schema-v1';
import {
  qualificationAttemptIdentityV1Schema,
  qualificationAttemptScopeV1Schema,
} from './live-observation-schema-v1';

const UNRESOLVED_RUNNER_SOURCE_DIGEST_V1 = `sha256:${'0'.repeat(64)}` as const;

/**
 * AQ-9B has a source-owned registry separate from AQ-8's single-dispatch
 * compatibility observation. It closes only diagnostic metadata and does not
 * expose a release-evidence, bundle, or Gate vocabulary.
 */
const sourceBoundScope = qualificationAttemptScopeV1Schema.parse({
  platformIdentity: 'local-host',
  releaseProfileDigest: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  entrypoint: 'runtime',
  testPolicyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
  routePolicyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
  route: L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1,
});

const sourceBoundIdentity = qualificationAttemptIdentityV1Schema.parse({
  matrixDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.matrixDigest,
  suiteDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.suiteDigest,
  oracleDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.oracleDigest,
  corpusDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.corpusDigest,
  evaluatorDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.evaluatorDigest,
  verifierDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
  runnerDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.runnerDigest,
});

const sourceBoundExecution = Object.freeze({
  platformIdentity: 'local-host',
  fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureId,
  runner: L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
  commit: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.artifacts[0]!.artifact.commit,
});

const sourceBoundGovernance = Object.freeze({
  retentionClass: 'ephemeral_local' as const,
  profileId: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileId,
  profileDigest: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest,
});

/**
 * The five values are intentionally duplicated through an exact equality
 * check below: the receipt contract must not silently turn a policy edit into
 * a larger live invocation envelope.
 */
const sourceBoundPhaseCaps = LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_V1;

export const L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1 = Object.freeze({
  schema: 'L3LiveAutoCompactionSourceRegistryV1' as const,
  version: 1 as const,
  authority: 'diagnostic' as const,
  evidenceEligible: false as const,
  candidate: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  scope: sourceBoundScope,
  identity: sourceBoundIdentity,
  execution: sourceBoundExecution,
  governance: sourceBoundGovernance,
  policy: Object.freeze({
    policyId: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyId,
    policyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
    routeIdentityDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.routeIdentityDigest,
    providerDataPolicyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.providerDataPolicyDigest,
    capabilityDeclarationDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.capabilityDeclarationDigest,
    promptEnvironmentDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.promptEnvironmentDigest,
    routeToolCatalogDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.routeToolCatalogDigest,
    toolEnvironmentDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.toolEnvironment.toolEnvironmentDigest,
    sourceOwnedIdentityDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.identityDigest,
    fixtureDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureDigest,
    corpusDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.corpusDigest,
    oracleDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.oracleDigest,
    evaluatorDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.evaluatorDigest,
    verifierDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
    runnerSourceDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1,
    runnerDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
    candidateClosureDigest: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
    matrixDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.matrixDigest,
    matrixSuiteDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.matrixSuiteDigest,
    suiteDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.suiteDigest,
    transportBindingDigest: LIVE_ISOLATED_TRANSPORT_BINDING_V1.bindingDigest,
  }),
  semantic: Object.freeze({
    compactAfterEstimatedTokens: 8_192,
    fullProjection: Object.freeze({ minimumTokens: 9_000, maximumTokens: 10_000 }),
    durationBucketPolicy: LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1,
    durationBucketPolicyDigest: LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_DIGEST_V1,
    phaseCaps: sourceBoundPhaseCaps,
    phaseCapsDigest: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.phaseCapsDigest,
    capability: Object.freeze({
      contextWindowTokens: 'unknown' as const,
      contextWindowSource: 'not_declared' as const,
      maxOutputTokens: 600 as const,
      maxOutputTokensSource: 'compatibility_config' as const,
    }),
    syntheticProjection: L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1,
  }),
  quota: Object.freeze({
    attempts: 2,
    tokens: 12_229,
    runWallClockSeconds: 600,
    costUsdMicros: 250_000,
  }),
});

export const L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_DIGEST_V1 = sha256DomainSeparated(
  'kite.qualification.live-auto-compaction-source-registry.v1',
  canonicalJsonBytes(L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1),
);

function sameCanonicalValueV1(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

/**
 * Freshly reconstruct all fixed policy-to-receipt links for every verifier
 * invocation. A changed policy, fixture, matrix, runner, phase cap, route, or
 * governance profile therefore invalidates rather than reinterprets a record.
 */
export function l3LiveAutoCompactionSourceRegistryIsClosedV1(): boolean {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  const policy = L3_LIVE_AUTO_COMPACTION_POLICY_V1;
  const fixture = L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1;
  const identity = L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1;
  const artifact = source.candidate.artifacts.find(
    (slot) => slot.platformIdentity === source.execution.platformIdentity,
  )?.artifact;
  const route = source.scope.route;
  const caps = source.semantic.phaseCaps;
  const { phaseCapsDigest: policyPhaseCapsDigest, ...policyPhaseCaps } = policy.phaseCaps;
  return (
    artifact !== undefined &&
    source.candidate.closureDigest === source.policy.candidateClosureDigest &&
    artifact.payloadSha256 === source.policy.runnerDigest &&
    artifact.canonicalManifestDigest === source.policy.fixtureDigest &&
    artifact.behaviorDigest === source.policy.sourceOwnedIdentityDigest &&
    artifact.profileDigest === source.scope.releaseProfileDigest &&
    source.scope.testPolicyDigest === source.policy.policyDigest &&
    source.scope.routePolicyDigest === source.policy.policyDigest &&
    route !== undefined &&
    sameCanonicalValueV1(route, L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1) &&
    route.routeIdentityDigest === source.policy.routeIdentityDigest &&
    route.providerDataPolicyDigest === source.policy.providerDataPolicyDigest &&
    route.promptEnvironmentDigest === source.policy.promptEnvironmentDigest &&
    route.toolCatalogDigest === source.policy.routeToolCatalogDigest &&
    route.capabilityDeclarationDigest === source.policy.capabilityDeclarationDigest &&
    source.identity.matrixDigest === source.policy.matrixDigest &&
    source.identity.suiteDigest === source.policy.suiteDigest &&
    source.identity.oracleDigest === source.policy.oracleDigest &&
    source.identity.corpusDigest === source.policy.corpusDigest &&
    source.identity.evaluatorDigest === source.policy.evaluatorDigest &&
    source.identity.verifierDigest === source.policy.verifierDigest &&
    source.identity.runnerDigest === source.policy.runnerDigest &&
    source.execution.fixtureId === fixture.fixtureId &&
    source.execution.runner === L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1 &&
    source.execution.commit === artifact.commit &&
    source.governance.profileId === policy.governance.profileId &&
    source.governance.profileDigest === policy.governance.profileDigest &&
    source.governance.profileId ===
      EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileId &&
    source.governance.profileDigest ===
      EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest &&
    source.policy.policyDigest === policy.policyDigest &&
    source.policy.routeIdentityDigest === policy.routeIdentityDigest &&
    source.policy.providerDataPolicyDigest === policy.providerDataPolicyDigest &&
    source.policy.capabilityDeclarationDigest === policy.capabilityDeclarationDigest &&
    source.policy.promptEnvironmentDigest === policy.promptEnvironmentDigest &&
    source.policy.routeToolCatalogDigest === policy.routeToolCatalogDigest &&
    source.policy.toolEnvironmentDigest === policy.toolEnvironment.toolEnvironmentDigest &&
    source.policy.sourceOwnedIdentityDigest === identity.identityDigest &&
    source.policy.fixtureDigest === fixture.fixtureDigest &&
    source.policy.corpusDigest === fixture.corpusDigest &&
    source.policy.oracleDigest === fixture.oracleDigest &&
    source.policy.evaluatorDigest === fixture.evaluatorDigest &&
    source.policy.verifierDigest === identity.verifierDigest &&
    source.policy.runnerSourceDigest === L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1 &&
    source.policy.runnerSourceDigest !== UNRESOLVED_RUNNER_SOURCE_DIGEST_V1 &&
    source.policy.runnerDigest === fixture.runnerDigest &&
    source.policy.runnerDigest === L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1 &&
    source.policy.candidateClosureDigest === fixture.candidateClosureDigest &&
    source.policy.candidateClosureDigest === source.candidate.closureDigest &&
    sameCanonicalValueV1(fixture.sourceOwnedIdentity, identity) &&
    fixture.promptEnvironmentDigest === source.policy.promptEnvironmentDigest &&
    fixture.routeToolCatalogDigest === source.policy.routeToolCatalogDigest &&
    fixture.toolEnvironmentDigest === source.policy.toolEnvironmentDigest &&
    source.policy.matrixDigest === identity.matrixDigest &&
    source.policy.matrixSuiteDigest === identity.matrixSuiteDigest &&
    source.policy.suiteDigest === identity.suiteDigest &&
    source.policy.transportBindingDigest === LIVE_ISOLATED_TRANSPORT_BINDING_V1.bindingDigest &&
    liveIsolatedTransportBindingIsClosedV1() &&
    sameCanonicalValueV1(policy.sourceOwnedIdentity, identity) &&
    policy.candidateClosureDigest === source.candidate.closureDigest &&
    policy.fixtureId === fixture.fixtureId &&
    policy.fixtureDigest === fixture.fixtureDigest &&
    policy.corpusDigest === fixture.corpusDigest &&
    policy.oracleDigest === fixture.oracleDigest &&
    policy.evaluatorDigest === fixture.evaluatorDigest &&
    policy.runnerSourceDigest === L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1 &&
    policy.runnerDigest === L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1 &&
    sameCanonicalValueV1(policy.phaseCaps, L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1) &&
    sameCanonicalValueV1(policyPhaseCaps, caps) &&
    policyPhaseCapsDigest === source.semantic.phaseCapsDigest &&
    source.semantic.phaseCapsDigest === LIVE_AUTO_COMPACTION_SEMANTIC_PHASE_CAPS_DIGEST_V1 &&
    caps.summaryProviderInputMax +
      caps.summaryOutputMax +
      caps.followUpProviderInputMax +
      caps.followUpOutputMax ===
      caps.totalMax &&
    source.semantic.compactAfterEstimatedTokens ===
      policy.runtimeConfiguration.compactAfterEstimatedTokens &&
    source.semantic.compactAfterEstimatedTokens === policy.fullProjection.thresholdTokens &&
    source.semantic.fullProjection.minimumTokens === policy.fullProjection.minTokens &&
    source.semantic.fullProjection.maximumTokens === policy.fullProjection.maxTokens &&
    sameCanonicalValueV1(
      source.semantic.syntheticProjection,
      L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1,
    ) &&
    source.semantic.syntheticProjection.syntheticProjectionDigest ===
      policy.syntheticProjection.syntheticProjectionDigest &&
    source.semantic.syntheticProjection.historyChunkRepeats ===
      policy.syntheticProjection.historyChunkRepeats &&
    sameCanonicalValueV1(
      source.semantic.durationBucketPolicy,
      LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_V1,
    ) &&
    source.semantic.durationBucketPolicyDigest ===
      computeLiveAutoCompactionDurationBucketPolicyDigestV1(source.semantic.durationBucketPolicy) &&
    source.semantic.durationBucketPolicyDigest ===
      LIVE_AUTO_COMPACTION_DURATION_BUCKET_POLICY_DIGEST_V1 &&
    source.semantic.durationBucketPolicy.maxRunWallClockSeconds ===
      source.quota.runWallClockSeconds &&
    source.quota.attempts === policy.budget.maxAttemptsPerInvocation &&
    source.quota.tokens === policy.budget.maxTotalTokens &&
    source.quota.runWallClockSeconds === policy.budget.maxRunWallClockSeconds &&
    source.quota.costUsdMicros === policy.budget.maxCostUsdMicros
  );
}
