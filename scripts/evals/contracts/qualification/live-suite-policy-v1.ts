import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './evidence/governance-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L3 live-suite policy identifiers must not contain an endpoint, absolute path, or unsafe metadata',
});
const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

/**
 * The only terminal observations an L3 invocation may report. Network and
 * provider failures are deliberately not observations; AQ-9A covers their
 * deterministic failure semantics and the live path remains blocked.
 */
export const LIVE_SUITE_TERMINAL_OUTCOMES_V1 = ['cancelled', 'success'] as const;
export type LiveSuiteTerminalOutcomeV1 = (typeof LIVE_SUITE_TERMINAL_OUTCOMES_V1)[number];

/** Closed, metadata-only reasons for a zero-network preflight refusal. */
export const LIVE_SUITE_BLOCKED_REASON_CODES_V1 = [
  'budget_exhausted',
  'capability_not_declared',
  'credential_missing',
  'credential_source_not_allowed',
  'endpoint_not_allowed',
  'explicit_opt_in_required',
  'governance_reservation_unavailable',
  'policy_expired',
  'policy_invalid',
  'policy_not_active',
  'route_not_registered',
  'route_policy_mismatch',
  'timeout',
] as const;
export type LiveSuiteBlockedReasonCodeV1 = (typeof LIVE_SUITE_BLOCKED_REASON_CODES_V1)[number];

const policyGovernanceV1Schema = z
  .object({
    retentionClass: z.literal('ephemeral_local'),
    profileId: identifierSchema,
    profileDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    if (value.profileId !== expected.profileId || value.profileDigest !== expected.profileDigest) {
      context.addIssue({
        code: 'custom',
        message: 'L3 policy must bind the exact ephemeral-local diagnostic governance profile',
      });
    }
  });
export type LiveSuitePolicyGovernanceV1 = z.infer<typeof policyGovernanceV1Schema>;

const liveSuiteBudgetV1Schema = z
  .object({
    maxAttemptsPerInvocation: positiveIntegerSchema,
    maxInputTokens: positiveIntegerSchema,
    maxOutputTokens: positiveIntegerSchema,
    maxTotalTokens: positiveIntegerSchema,
    maxRunWallClockSeconds: positiveIntegerSchema,
    maxCostUsdMicros: positiveIntegerSchema,
    maxConcurrentInvocations: positiveIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ceiling = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.quotas.perRun;
    if (
      value.maxAttemptsPerInvocation > ceiling.attempts ||
      value.maxTotalTokens > ceiling.tokens ||
      value.maxRunWallClockSeconds > ceiling.runWallClockSeconds ||
      value.maxCostUsdMicros > ceiling.costUsdMicros ||
      value.maxConcurrentInvocations >
        EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.quotas.maxConcurrentRuns
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L3 policy budget cannot exceed the bound ephemeral-local governance ceiling',
      });
    }
    if (value.maxInputTokens + value.maxOutputTokens > value.maxTotalTokens) {
      context.addIssue({
        code: 'custom',
        message: 'L3 policy input/output maxima must fit within the total-token ceiling',
      });
    }
  });
export type LiveSuiteBudgetV1 = z.infer<typeof liveSuiteBudgetV1Schema>;

const liveSuiteSamplingV1Schema = z
  .object({
    mode: z.literal('deterministic_fixed'),
    temperatureMilli: z.literal(0),
    topPMilli: z.literal(1_000),
  })
  .strict();
export type LiveSuiteSamplingV1 = z.infer<typeof liveSuiteSamplingV1Schema>;

/**
 * Source-owned L3 environment declaration. The only initial Tool/Skill/
 * Subagent implementation is in-process deterministic fake behavior; no MCP,
 * stdio, shell, or child execution has a transport path.
 */
const liveSuiteToolEnvironmentMaterialV1Schema = z
  .object({
    schema: z.literal('LiveSuiteToolEnvironmentV1'),
    version: z.literal(1),
    toolExecution: z.literal('in_process_fake_only'),
    skillExecution: z.literal('in_process_fake_only'),
    subagentExecution: z.literal('in_process_fake_only'),
    mcpTransport: z.literal('denied'),
    stdioChildren: z.literal('denied'),
    shellChildren: z.literal('denied'),
    childEnvironmentAllowlist: z.array(z.never()).length(0),
  })
  .strict();
export type LiveSuiteToolEnvironmentMaterialV1 = z.infer<
  typeof liveSuiteToolEnvironmentMaterialV1Schema
>;

export function computeLiveSuiteToolEnvironmentDigestV1(
  material: LiveSuiteToolEnvironmentMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.tool-environment.v1',
    canonicalJsonBytes(liveSuiteToolEnvironmentMaterialV1Schema.parse(material)),
  );
}

export const liveSuiteToolEnvironmentV1Schema = liveSuiteToolEnvironmentMaterialV1Schema
  .extend({ toolEnvironmentDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { toolEnvironmentDigest, ...material } = value;
    const expected = computeLiveSuiteToolEnvironmentDigestV1(material);
    if (toolEnvironmentDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['toolEnvironmentDigest'],
        message: `L3 tool-environment digest mismatch: expected ${expected}`,
      });
    }
  });
export type LiveSuiteToolEnvironmentV1 = z.infer<typeof liveSuiteToolEnvironmentV1Schema>;

export function buildLiveSuiteToolEnvironmentV1(
  material: LiveSuiteToolEnvironmentMaterialV1,
): LiveSuiteToolEnvironmentV1 {
  const parsed = liveSuiteToolEnvironmentMaterialV1Schema.parse(material);
  return liveSuiteToolEnvironmentV1Schema.parse({
    ...parsed,
    toolEnvironmentDigest: computeLiveSuiteToolEnvironmentDigestV1(parsed),
  });
}

/**
 * A checked-in projection of the source-owned Matrix relationship used by an
 * L3 suite. Runtime only receives this immutable digest material; tests may
 * reconstruct the source-owned Matrix separately and compare it to this
 * declaration. It intentionally cannot load a workspace or a catalog.
 */
const liveSuiteSourceOwnedIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('LiveSuiteSourceOwnedIdentityV1'),
    version: z.literal(1),
    matrixId: identifierSchema,
    matrixDigest: digestSchema,
    sourceSurfaceId: identifierSchema,
    featureId: identifierSchema,
    assertionId: identifierSchema,
    matrixSuiteId: identifierSchema,
    matrixSuiteDigest: digestSchema,
    suiteId: identifierSchema,
    suiteDigest: digestSchema,
    verifierId: identifierSchema,
    verifierDigest: digestSchema,
  })
  .strict();
export type LiveSuiteSourceOwnedIdentityMaterialV1 = z.infer<
  typeof liveSuiteSourceOwnedIdentityMaterialV1Schema
>;

export function computeLiveSuiteSourceOwnedIdentityDigestV1(
  material: LiveSuiteSourceOwnedIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.source-owned-identity.v1',
    canonicalJsonBytes(liveSuiteSourceOwnedIdentityMaterialV1Schema.parse(material)),
  );
}

export const liveSuiteSourceOwnedIdentityV1Schema = liveSuiteSourceOwnedIdentityMaterialV1Schema
  .extend({ identityDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { identityDigest, ...material } = value;
    const expected = computeLiveSuiteSourceOwnedIdentityDigestV1(material);
    if (identityDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['identityDigest'],
        message: `L3 source-owned identity digest mismatch: expected ${expected}`,
      });
    }
  });
export type LiveSuiteSourceOwnedIdentityV1 = z.infer<typeof liveSuiteSourceOwnedIdentityV1Schema>;

export function buildLiveSuiteSourceOwnedIdentityV1(
  material: LiveSuiteSourceOwnedIdentityMaterialV1,
): LiveSuiteSourceOwnedIdentityV1 {
  const parsed = liveSuiteSourceOwnedIdentityMaterialV1Schema.parse(material);
  return liveSuiteSourceOwnedIdentityV1Schema.parse({
    ...parsed,
    identityDigest: computeLiveSuiteSourceOwnedIdentityDigestV1(parsed),
  });
}

const liveSuiteAggregateV1Schema = z
  .object({
    denominator: positiveIntegerSchema,
    minimumSuccesses: nonNegativeIntegerSchema,
    confidenceInterval: z.literal('wilson_95'),
    attemptIndependence: z.literal('separate_opt_in_invocation'),
    missingOutcome: z.literal('blocked'),
    overBudgetOutcome: z.literal('blocked'),
    timeoutOutcome: z.literal('blocked'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumSuccesses > value.denominator) {
      context.addIssue({
        code: 'custom',
        path: ['minimumSuccesses'],
        message: 'L3 aggregate minimum successes cannot exceed its denominator',
      });
    }
  });
export type LiveSuiteAggregateV1 = z.infer<typeof liveSuiteAggregateV1Schema>;

const liveSuitePolicyMaterialV1Schema = z
  .object({
    schema: z.literal('LiveSuitePolicyV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    policyId: identifierSchema,
    suiteId: identifierSchema,
    sourceOwnedIdentity: liveSuiteSourceOwnedIdentityV1Schema,
    routeId: identifierSchema,
    routeDeclarationDigest: digestSchema,
    routeIdentityDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
    capabilitySourceBindingDigest: digestSchema,
    governance: policyGovernanceV1Schema,
    caseIds: z.array(identifierSchema).min(1),
    fixtureId: identifierSchema,
    fixtureDigest: digestSchema,
    corpusDigest: digestSchema,
    oracleDigest: digestSchema,
    evaluatorDigest: digestSchema,
    runnerSourceDigest: digestSchema,
    runnerDigest: digestSchema,
    candidateClosureDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    toolEnvironment: liveSuiteToolEnvironmentV1Schema,
    toolEnvironmentDigest: digestSchema,
    sampling: liveSuiteSamplingV1Schema,
    budget: liveSuiteBudgetV1Schema,
    maxRetries: z.literal(0),
    terminalOutcomes: z.array(z.enum(LIVE_SUITE_TERMINAL_OUTCOMES_V1)),
    blockedReasonCodes: z.array(z.enum(LIVE_SUITE_BLOCKED_REASON_CODES_V1)),
    credentialSources: z.array(z.literal('environment')),
    aggregate: liveSuiteAggregateV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'L3 live-suite policy expiry must follow issue time',
      });
    }
    if (!codePointSortedUnique(value.caseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['caseIds'],
        message: 'L3 policy case IDs must be code-point sorted and unique',
      });
    }
    if (value.suiteId !== value.sourceOwnedIdentity.suiteId) {
      context.addIssue({
        code: 'custom',
        path: ['suiteId'],
        message: 'L3 policy suite ID must bind its source-owned identity declaration',
      });
    }
    if (!exactInventory(value.terminalOutcomes, LIVE_SUITE_TERMINAL_OUTCOMES_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['terminalOutcomes'],
        message: 'L3 policy must retain the exact success/cancel terminal observation vocabulary',
      });
    }
    if (!exactInventory(value.blockedReasonCodes, LIVE_SUITE_BLOCKED_REASON_CODES_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['blockedReasonCodes'],
        message: 'L3 policy must retain the exact registered preflight-blocked reason vocabulary',
      });
    }
    if (!exactInventory(value.credentialSources, ['environment'])) {
      context.addIssue({
        code: 'custom',
        path: ['credentialSources'],
        message: 'AQ-8 currently permits only the environment credential resolver boundary',
      });
    }
    if (value.toolEnvironment.toolEnvironmentDigest !== value.toolEnvironmentDigest) {
      context.addIssue({
        code: 'custom',
        path: ['toolEnvironmentDigest'],
        message: 'L3 policy tool-environment digest must bind the exact zero-child declaration',
      });
    }
  });

export type LiveSuitePolicyMaterialV1 = z.infer<typeof liveSuitePolicyMaterialV1Schema>;

export function computeLiveSuitePolicyDigestV1(
  material: LiveSuitePolicyMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite-policy.v1',
    canonicalJsonBytes(liveSuitePolicyMaterialV1Schema.parse(material)),
  );
}

export const liveSuitePolicyV1Schema = liveSuitePolicyMaterialV1Schema
  .extend({ policyDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { policyDigest, ...material } = value;
    const expected = computeLiveSuitePolicyDigestV1(material);
    if (policyDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['policyDigest'],
        message: `L3 live-suite policy digest mismatch: expected ${expected}`,
      });
    }
  });
export type LiveSuitePolicyV1 = z.infer<typeof liveSuitePolicyV1Schema>;

export function buildLiveSuitePolicyV1(material: LiveSuitePolicyMaterialV1): LiveSuitePolicyV1 {
  const parsed = liveSuitePolicyMaterialV1Schema.parse(material);
  return liveSuitePolicyV1Schema.parse({
    ...parsed,
    policyDigest: computeLiveSuitePolicyDigestV1(parsed),
  });
}
