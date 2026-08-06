import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import {
  LIVE_ISOLATED_TRANSPORT_BINDING_V1,
  liveIsolatedTransportBindingIsClosedV1,
} from '../live-isolated-transport-binding-v1';
import {
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
  L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
  L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
  L3_QWEN_LIVE_ROUTE_IDENTITY_V1,
} from '../live-route-resolver-v1';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './governance-v1';
import {
  qualificationAttemptIdentityV1Schema,
  qualificationAttemptScopeV1Schema,
} from './live-observation-schema-v1';

/**
 * The only source-owned closure a local L3 verifier accepts.  It is derived
 * from reviewed declarations, not from a runner-supplied verifier context.
 * It contains no endpoint, credential, fixture/corpus bytes, product config,
 * or release-control vocabulary.
 */
const sourceBoundScope = qualificationAttemptScopeV1Schema.parse({
  platformIdentity: 'local-host',
  releaseProfileDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  entrypoint: 'runtime',
  testPolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
  routePolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
  route: L3_QWEN_LIVE_ROUTE_IDENTITY_V1,
});

const sourceBoundIdentity = qualificationAttemptIdentityV1Schema.parse({
  matrixDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.matrixDigest,
  suiteDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.suiteDigest,
  oracleDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.oracleDigest,
  corpusDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.corpusDigest,
  evaluatorDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.evaluatorDigest,
  verifierDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
  runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest,
});

const sourceBoundExecution = Object.freeze({
  platformIdentity: 'local-host',
  fixtureId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureId,
  runner: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
  commit: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.artifacts[0]!.artifact.commit,
});

const sourceBoundGovernance = Object.freeze({
  retentionClass: 'ephemeral_local' as const,
  profileId: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileId,
  profileDigest: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest,
});

export const L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1 = Object.freeze({
  schema: 'L3LiveObservationSourceRegistryV1' as const,
  version: 1 as const,
  authority: 'diagnostic' as const,
  evidenceEligible: false as const,
  candidate: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  scope: sourceBoundScope,
  identity: sourceBoundIdentity,
  execution: sourceBoundExecution,
  governance: sourceBoundGovernance,
  policy: Object.freeze({
    policyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
    routeIdentityDigest: L3_QWEN_LIVE_ROUTE_IDENTITY_V1.routeIdentityDigest,
    sourceOwnedIdentityDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.identityDigest,
    fixtureDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureDigest,
    corpusDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.corpusDigest,
    oracleDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.oracleDigest,
    evaluatorDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.evaluatorDigest,
    verifierDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
    runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest,
    candidateClosureDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
    matrixDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.matrixDigest,
    matrixSuiteDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.matrixSuiteDigest,
    suiteDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.suiteDigest,
    transportBindingDigest: LIVE_ISOLATED_TRANSPORT_BINDING_V1.bindingDigest,
  }),
  quota: Object.freeze({
    attempts: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxAttemptsPerInvocation,
    tokens: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxTotalTokens,
    runWallClockSeconds: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxRunWallClockSeconds,
    costUsdMicros: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxCostUsdMicros,
  }),
});

export const L3_LIVE_OBSERVATION_SOURCE_REGISTRY_DIGEST_V1 = sha256DomainSeparated(
  'kite.qualification.live-observation-source-registry.v1',
  canonicalJsonBytes(L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1),
);

/**
 * Reconstruct the fixed relationships before accepting any caller-provided
 * context.  The verifier calls this on every observation so a future edit to
 * one declaration cannot silently turn a stale projection into authority.
 */
export function l3LiveObservationSourceRegistryIsClosedV1(): boolean {
  const source = L3_LIVE_OBSERVATION_SOURCE_REGISTRY_V1;
  const artifact = source.candidate.artifacts.find(
    (slot) => slot.platformIdentity === source.execution.platformIdentity,
  )?.artifact;
  const route = source.scope.route;
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
    route.routeIdentityDigest === source.policy.routeIdentityDigest &&
    source.identity.matrixDigest === source.policy.matrixDigest &&
    source.identity.suiteDigest === source.policy.suiteDigest &&
    source.identity.oracleDigest === source.policy.oracleDigest &&
    source.identity.corpusDigest === source.policy.corpusDigest &&
    source.identity.evaluatorDigest === source.policy.evaluatorDigest &&
    source.identity.verifierDigest === source.policy.verifierDigest &&
    source.identity.runnerDigest === source.policy.runnerDigest &&
    source.policy.transportBindingDigest === LIVE_ISOLATED_TRANSPORT_BINDING_V1.bindingDigest &&
    liveIsolatedTransportBindingIsClosedV1()
  );
}
