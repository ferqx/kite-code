import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './evidence/governance-v1';
import {
  buildDiagnosticCandidateArtifactClosureV1,
  type DiagnosticRouteIdentityV1,
  diagnosticRouteIdentityV1Schema,
} from './evidence/live-observation-schema-v1';
import {
  hasQualificationControlCharacterV1,
  isQualificationSafeIdentifierV1,
} from './evidence/metadata-safety-v1';
import {
  buildLiveSuitePolicyV1,
  buildLiveSuiteSourceOwnedIdentityV1,
  buildLiveSuiteToolEnvironmentV1,
  type LiveSuiteBlockedReasonCodeV1,
  type LiveSuitePolicyV1,
  liveSuitePolicyV1Schema,
  liveSuiteSourceOwnedIdentityV1Schema,
} from './live-suite-policy-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L3 live-route identifiers must not contain an endpoint, absolute path, or unsafe metadata',
});
const isoTimestampSchema = z.iso.datetime({ offset: true });

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function sameGovernance(
  left: { retentionClass: string; profileId: string; profileDigest: string },
  right: { retentionClass: string; profileId: string; profileDigest: string },
): boolean {
  return (
    left.retentionClass === right.retentionClass &&
    left.profileId === right.profileId &&
    left.profileDigest === right.profileDigest
  );
}

const liveRouteGovernanceV1Schema = z
  .object({
    retentionClass: z.literal('ephemeral_local'),
    profileId: identifierSchema,
    profileDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    if (!sameGovernance(value, expected)) {
      context.addIssue({
        code: 'custom',
        message: 'L3 route must bind the exact ephemeral-local diagnostic governance profile',
      });
    }
  });
export type LiveRouteGovernanceV1 = z.infer<typeof liveRouteGovernanceV1Schema>;

/**
 * This policy is separate from the production ProviderDataPolicyV1. It binds
 * only a sealed-synthetic diagnostic route and cannot represent production
 * content admission.
 */
const diagnosticProviderDataPolicyMaterialV1Schema = z
  .object({
    schema: z.literal('DiagnosticProviderDataPolicyV1'),
    version: z.literal(1),
    policyId: identifierSchema,
    routeId: identifierSchema,
    operatorId: identifierSchema,
    originIdentityDigest: digestSchema,
    allowedDataClasses: z.array(z.literal('sealed_synthetic')).length(1),
    contentRetention: z.literal('provider_terms_reference'),
    contentTraining: z.literal('provider_terms_reference'),
    permittedUse: z.literal('diagnostic_compatibility_only'),
    credentialSources: z.array(z.literal('environment')).length(1),
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'diagnostic provider-data policy expiry must follow issue time',
      });
    }
  });
export type DiagnosticProviderDataPolicyMaterialV1 = z.infer<
  typeof diagnosticProviderDataPolicyMaterialV1Schema
>;

export function computeDiagnosticProviderDataPolicyDigestV1(
  material: DiagnosticProviderDataPolicyMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.diagnostic-provider-data-policy.v1',
    canonicalJsonBytes(diagnosticProviderDataPolicyMaterialV1Schema.parse(material)),
  );
}

export const diagnosticProviderDataPolicyV1Schema = diagnosticProviderDataPolicyMaterialV1Schema
  .extend({ policyDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { policyDigest, ...material } = value;
    const expected = computeDiagnosticProviderDataPolicyDigestV1(material);
    if (policyDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['policyDigest'],
        message: `diagnostic provider-data policy digest mismatch: expected ${expected}`,
      });
    }
  });
export type DiagnosticProviderDataPolicyV1 = z.infer<typeof diagnosticProviderDataPolicyV1Schema>;

export function buildDiagnosticProviderDataPolicyV1(
  material: DiagnosticProviderDataPolicyMaterialV1,
): DiagnosticProviderDataPolicyV1 {
  const parsed = diagnosticProviderDataPolicyMaterialV1Schema.parse(material);
  return diagnosticProviderDataPolicyV1Schema.parse({
    ...parsed,
    policyDigest: computeDiagnosticProviderDataPolicyDigestV1(parsed),
  });
}

const liveRouteDeclarationMaterialV1Schema = z
  .object({
    schema: z.literal('LiveRouteDeclarationV1'),
    version: z.literal(1),
    routeId: identifierSchema,
    routeAlias: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    providerAdapter: z.literal('openai-compatible'),
    protocolFamily: z.literal('openai_compatible'),
    model: z.literal('qwen3.6-flash'),
    endpointIdentityDigest: digestSchema,
    capabilityId: identifierSchema,
    capabilitySourceRef: z.literal(
      'src/core/config/provider-data-policy.ts#providerRouteIdentityV1Schema',
    ),
    capabilitySourceBindingDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    toolCatalogDigest: digestSchema,
    governance: liveRouteGovernanceV1Schema,
  })
  .strict();
export type LiveRouteDeclarationMaterialV1 = z.infer<typeof liveRouteDeclarationMaterialV1Schema>;

export function computeLiveRouteDeclarationDigestV1(
  material: LiveRouteDeclarationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-route-declaration.v1',
    canonicalJsonBytes(liveRouteDeclarationMaterialV1Schema.parse(material)),
  );
}

export const liveRouteDeclarationV1Schema = liveRouteDeclarationMaterialV1Schema
  .extend({ declarationDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { declarationDigest, ...material } = value;
    const expected = computeLiveRouteDeclarationDigestV1(material);
    if (declarationDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['declarationDigest'],
        message: `L3 live-route declaration digest mismatch: expected ${expected}`,
      });
    }
  });
export type LiveRouteDeclarationV1 = z.infer<typeof liveRouteDeclarationV1Schema>;

export function buildLiveRouteDeclarationV1(
  material: LiveRouteDeclarationMaterialV1,
): LiveRouteDeclarationV1 {
  const parsed = liveRouteDeclarationMaterialV1Schema.parse(material);
  return liveRouteDeclarationV1Schema.parse({
    ...parsed,
    declarationDigest: computeLiveRouteDeclarationDigestV1(parsed),
  });
}

const liveRouteIdentityMaterialV1Schema = z
  .object({
    routeAlias: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    model: z.literal('qwen3.6-flash'),
    protocolFamily: z.literal('openai_compatible'),
    endpointIdentityDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    toolCatalogDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
  })
  .strict();
type LiveRouteIdentityMaterialV1 = z.infer<typeof liveRouteIdentityMaterialV1Schema>;

export function computeLiveRouteIdentityDigestV1(
  material: LiveRouteIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-route-identity.v1',
    canonicalJsonBytes(liveRouteIdentityMaterialV1Schema.parse(material)),
  );
}

export function buildLiveRouteDiagnosticIdentityV1(
  declaration: LiveRouteDeclarationV1,
): DiagnosticRouteIdentityV1 {
  const parsed = liveRouteDeclarationV1Schema.parse(declaration);
  const material = liveRouteIdentityMaterialV1Schema.parse({
    routeAlias: parsed.routeAlias,
    model: parsed.model,
    protocolFamily: parsed.protocolFamily,
    endpointIdentityDigest: parsed.endpointIdentityDigest,
    providerDataPolicyDigest: parsed.providerDataPolicyDigest,
    promptEnvironmentDigest: parsed.promptEnvironmentDigest,
    toolCatalogDigest: parsed.toolCatalogDigest,
    capabilityDeclarationDigest: parsed.capabilityDeclarationDigest,
  });
  return diagnosticRouteIdentityV1Schema.parse({
    routeAlias: material.routeAlias,
    model: material.model,
    protocolFamily: material.protocolFamily,
    routeIdentityDigest: computeLiveRouteIdentityDigestV1(material),
    providerDataPolicyDigest: material.providerDataPolicyDigest,
    promptEnvironmentDigest: material.promptEnvironmentDigest,
    toolCatalogDigest: material.toolCatalogDigest,
    capabilityDeclarationDigest: material.capabilityDeclarationDigest,
  });
}

function digestFixedLiveFactV1(
  domain: string,
  material: Record<string, unknown>,
): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(material));
}

const QWEN_QUALIFICATION_ENVIRONMENT_KEYS_V1 = Object.freeze({
  endpoint: 'KITE_QUALIFICATION_QWEN_BASE_URL',
  credential: 'KITE_QUALIFICATION_QWEN_API_KEY',
});

/**
 * This is a digest of the reviewed Qwen origin identity, not an endpoint. The
 * full endpoint is supplied only to the resolver's parent boundary and is
 * rejected unless its canonical identity reconstructs this exact value.
 */
const L3_QWEN_ENDPOINT_IDENTITY_DIGEST_V1 =
  'sha256:8b808fcb42f9bb8db5b9ec8c4c92c3ab12ca4492adcd69329a5f30d7f128e6c3' as const;

function canonicalizeQwenEndpointForModelBoundaryV1(value: string): string | undefined {
  try {
    const endpoint = new URL(value);
    const pathname =
      endpoint.pathname.length > 1 ? endpoint.pathname.replace(/\/+$/, '') : endpoint.pathname;
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.port !== '' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      pathname === '/' ||
      pathname.includes('..')
    ) {
      return undefined;
    }
    const identityDigest = digestFixedLiveFactV1(
      'kite.qualification.live-route.endpoint-identity.v1',
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        pathname,
      },
    );
    if (identityDigest !== L3_QWEN_ENDPOINT_IDENTITY_DIGEST_V1) return undefined;
    return `${endpoint.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

const L3_QWEN_ROUTE_ID_V1 = 'qualification-l3-qwen3.6-flash-v1';
const L3_QWEN_CAPABILITY_DECLARATION_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-route.capability-declaration.v1',
  {
    capabilityId: 'qualification-live-model-compatibility-v1',
    capabilitySourceRef: 'src/core/config/provider-data-policy.ts#providerRouteIdentityV1Schema',
    capabilitySourceBindingDigest: digestFixedLiveFactV1(
      'kite.qualification.live-route.capability-source-binding.v1',
      {
        sourceSurfaceId: 'provider:route-policy',
        featureId: 'MODEL_CONTEXT-ROUTE_POLICY-001',
        sourceRef: 'src/core/config/provider-data-policy.ts#providerRouteIdentityV1Schema',
      },
    ),
    exposure: 'diagnostic_only',
    inputClass: 'sealed_synthetic',
  },
);
const L3_QWEN_CAPABILITY_SOURCE_BINDING_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-route.capability-source-binding.v1',
  {
    sourceSurfaceId: 'provider:route-policy',
    featureId: 'MODEL_CONTEXT-ROUTE_POLICY-001',
    sourceRef: 'src/core/config/provider-data-policy.ts#providerRouteIdentityV1Schema',
  },
);
const L3_QWEN_PROMPT_ENVIRONMENT_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-route.prompt-environment.v1',
  {
    environmentId: 'qualification-sealed-synthetic-prompt-environment-v1',
    contentClass: 'sealed_synthetic',
  },
);

/**
 * The route has no transport-capable tools. This explicit, separately
 * digestible declaration prevents a later runner from silently adding skills,
 * MCP, subagents, stdio, shell children, or inherited child environment.
 */
export const L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1 = buildLiveSuiteToolEnvironmentV1({
  schema: 'LiveSuiteToolEnvironmentV1',
  version: 1,
  toolExecution: 'in_process_fake_only',
  skillExecution: 'in_process_fake_only',
  subagentExecution: 'in_process_fake_only',
  mcpTransport: 'denied',
  stdioChildren: 'denied',
  shellChildren: 'denied',
  childEnvironmentAllowlist: [],
});
const L3_QWEN_TOOL_CATALOG_DIGEST_V1 =
  L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1.toolEnvironmentDigest;

export const L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1 = buildDiagnosticProviderDataPolicyV1({
  schema: 'DiagnosticProviderDataPolicyV1',
  version: 1,
  policyId: 'qualification-provider-data/qwen3.6-flash/v1',
  routeId: L3_QWEN_ROUTE_ID_V1,
  operatorId: 'aliyun-token-plan',
  originIdentityDigest: L3_QWEN_ENDPOINT_IDENTITY_DIGEST_V1,
  allowedDataClasses: ['sealed_synthetic'],
  contentRetention: 'provider_terms_reference',
  contentTraining: 'provider_terms_reference',
  permittedUse: 'diagnostic_compatibility_only',
  credentialSources: ['environment'],
  issuedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-12-31T00:00:00.000Z',
});

export const L3_QWEN_LIVE_ROUTE_DECLARATION_V1 = buildLiveRouteDeclarationV1({
  schema: 'LiveRouteDeclarationV1',
  version: 1,
  routeId: L3_QWEN_ROUTE_ID_V1,
  routeAlias: 'qualification-qwen3.6-flash',
  providerAdapter: 'openai-compatible',
  protocolFamily: 'openai_compatible',
  model: 'qwen3.6-flash',
  endpointIdentityDigest: L3_QWEN_ENDPOINT_IDENTITY_DIGEST_V1,
  capabilityId: 'qualification-live-model-compatibility-v1',
  capabilitySourceRef: 'src/core/config/provider-data-policy.ts#providerRouteIdentityV1Schema',
  capabilitySourceBindingDigest: L3_QWEN_CAPABILITY_SOURCE_BINDING_DIGEST_V1,
  capabilityDeclarationDigest: L3_QWEN_CAPABILITY_DECLARATION_DIGEST_V1,
  providerDataPolicyDigest: L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest,
  promptEnvironmentDigest: L3_QWEN_PROMPT_ENVIRONMENT_DIGEST_V1,
  toolCatalogDigest: L3_QWEN_TOOL_CATALOG_DIGEST_V1,
  governance: {
    retentionClass: 'ephemeral_local',
    profileId: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileId,
    profileDigest: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest,
  },
});

/** The declaration is a reviewed, metadata-only source of truth. */
export const LIVE_ROUTE_DECLARATIONS_V1 = [L3_QWEN_LIVE_ROUTE_DECLARATION_V1] as const;

const LIVE_ROUTE_BY_ID_V1 = new Map(
  LIVE_ROUTE_DECLARATIONS_V1.map((declaration) => [declaration.routeId, declaration]),
);

export const L3_QWEN_LIVE_ROUTE_IDENTITY_V1 = buildLiveRouteDiagnosticIdentityV1(
  L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
);

const L3_LIVE_COMPATIBILITY_MATRIX_ID_V1 = 'source-owned-agent-feature-qualification-matrix-v1';
const L3_LIVE_COMPATIBILITY_MATRIX_DIGEST_V1 =
  'sha256:c3ad9d993e6238f2a7c683c02577a7bc144c03c9941fe293e8ba485be1bfeaf2' as const;
const L3_LIVE_COMPATIBILITY_SOURCE_SURFACE_ID_V1 = 'provider:route-policy';
const L3_LIVE_COMPATIBILITY_FEATURE_ID_V1 = 'MODEL_CONTEXT-ROUTE_POLICY-001';
const L3_LIVE_COMPATIBILITY_ASSERTION_ID_V1 = 'assertion:provider/route-policy';
const L3_LIVE_COMPATIBILITY_MATRIX_SUITE_ID_V1 = 'source-owned-surface-contract-v1';
const L3_LIVE_COMPATIBILITY_MATRIX_SUITE_DIGEST_V1 =
  'sha256:e3cf714067abef429d2094120f6c974eff4855130ff7d80a7371893158737212' as const;
const L3_LIVE_COMPATIBILITY_SUITE_ID_V1 = 'qualification-l3-live-compatibility-v1';
const L3_LIVE_COMPATIBILITY_VERIFIER_ID_V1 = 'qualification-l3-live-compatibility-verifier-v1';
const L3_LIVE_COMPATIBILITY_VERIFIER_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-suite.verifier.v1',
  {
    verifierId: L3_LIVE_COMPATIBILITY_VERIFIER_ID_V1,
    authority: 'diagnostic',
    evidenceEligible: false,
    terminalOutcomes: ['cancelled', 'success'],
    rejectContent: true,
    rejectReleaseGateInput: true,
  },
);

function computeL3LiveCompatibilitySuiteDigestV1(input: {
  matrixDigest: `sha256:${string}`;
  matrixSuiteDigest: `sha256:${string}`;
  verifierDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return digestFixedLiveFactV1('kite.qualification.live-suite.identity-suite.v1', {
    suiteId: L3_LIVE_COMPATIBILITY_SUITE_ID_V1,
    sourceSurfaceId: L3_LIVE_COMPATIBILITY_SOURCE_SURFACE_ID_V1,
    featureId: L3_LIVE_COMPATIBILITY_FEATURE_ID_V1,
    assertionId: L3_LIVE_COMPATIBILITY_ASSERTION_ID_V1,
    matrixDigest: input.matrixDigest,
    matrixSuiteId: L3_LIVE_COMPATIBILITY_MATRIX_SUITE_ID_V1,
    matrixSuiteDigest: input.matrixSuiteDigest,
    verifierId: L3_LIVE_COMPATIBILITY_VERIFIER_ID_V1,
    verifierDigest: input.verifierDigest,
    caseIds: ['l3-live-cancelled-v1', 'l3-live-success-v1'],
  });
}

/**
 * Runtime consumes only this fixed metadata projection. The source-owned
 * Matrix is reconstructed exclusively by a test-only drift check below.
 */
export const L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1 = buildLiveSuiteSourceOwnedIdentityV1({
  schema: 'LiveSuiteSourceOwnedIdentityV1',
  version: 1,
  matrixId: L3_LIVE_COMPATIBILITY_MATRIX_ID_V1,
  matrixDigest: L3_LIVE_COMPATIBILITY_MATRIX_DIGEST_V1,
  sourceSurfaceId: L3_LIVE_COMPATIBILITY_SOURCE_SURFACE_ID_V1,
  featureId: L3_LIVE_COMPATIBILITY_FEATURE_ID_V1,
  assertionId: L3_LIVE_COMPATIBILITY_ASSERTION_ID_V1,
  matrixSuiteId: L3_LIVE_COMPATIBILITY_MATRIX_SUITE_ID_V1,
  matrixSuiteDigest: L3_LIVE_COMPATIBILITY_MATRIX_SUITE_DIGEST_V1,
  suiteId: L3_LIVE_COMPATIBILITY_SUITE_ID_V1,
  suiteDigest: computeL3LiveCompatibilitySuiteDigestV1({
    matrixDigest: L3_LIVE_COMPATIBILITY_MATRIX_DIGEST_V1,
    matrixSuiteDigest: L3_LIVE_COMPATIBILITY_MATRIX_SUITE_DIGEST_V1,
    verifierDigest: L3_LIVE_COMPATIBILITY_VERIFIER_DIGEST_V1,
  }),
  verifierId: L3_LIVE_COMPATIBILITY_VERIFIER_ID_V1,
  verifierDigest: L3_LIVE_COMPATIBILITY_VERIFIER_DIGEST_V1,
});

/**
 * Test-only hook. It consumes reconstructed source-owned metadata supplied by
 * its caller, never reads source files or a workspace itself.
 */
export function assertLiveSuiteSourceOwnedMatrixProjectionV1(input: {
  identity: unknown;
  matrixDigest: `sha256:${string}`;
  sourceSurfaceId: string;
  featureId: string;
  assertionId: string;
  matrixSuiteId: string;
  matrixSuiteDigest: `sha256:${string}`;
}): void {
  const identity = liveSuiteSourceOwnedIdentityV1Schema.parse(input.identity);
  if (
    identity.matrixDigest !== input.matrixDigest ||
    identity.sourceSurfaceId !== input.sourceSurfaceId ||
    identity.featureId !== input.featureId ||
    identity.assertionId !== input.assertionId ||
    identity.matrixSuiteId !== input.matrixSuiteId ||
    identity.matrixSuiteDigest !== input.matrixSuiteDigest
  ) {
    throw new Error('live_suite_source_owned_matrix_drift');
  }
}

const liveSuiteFixtureDeclarationMaterialV1Schema = z
  .object({
    schema: z.literal('LiveSuiteFixtureDeclarationV1'),
    version: z.literal(1),
    fixtureId: identifierSchema,
    contentDigest: digestSchema,
    fixtureDigest: digestSchema,
    corpusId: identifierSchema,
    corpusContentDigest: digestSchema,
    corpusDigest: digestSchema,
    oracleId: identifierSchema,
    oracleDigest: digestSchema,
    evaluatorId: identifierSchema,
    evaluatorDigest: digestSchema,
    runnerId: identifierSchema,
    runnerSourceDigest: digestSchema,
    runnerDigest: digestSchema,
    candidateClosureDigest: digestSchema,
    sourceOwnedIdentity: liveSuiteSourceOwnedIdentityV1Schema,
    promptEnvironmentDigest: digestSchema,
    toolEnvironmentDigest: digestSchema,
  })
  .strict();
export type LiveSuiteFixtureDeclarationMaterialV1 = z.infer<
  typeof liveSuiteFixtureDeclarationMaterialV1Schema
>;

export function computeLiveSuiteFixtureDeclarationDigestV1(
  material: LiveSuiteFixtureDeclarationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.fixture-declaration.v1',
    canonicalJsonBytes(liveSuiteFixtureDeclarationMaterialV1Schema.parse(material)),
  );
}

/**
 * This digest is calculated over sealed synthetic bytes at the runner boundary
 * and never appears in a report as bytes or text. The source-owned fixture is
 * nonempty; later history remains separately bound by corpus/prompt identities.
 */
export function computeLiveSuiteFixtureContentDigestV1(content: Uint8Array): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.live-suite.fixture-content.v1', content);
}

export function computeLiveSuiteFixtureDigestV1(input: {
  fixtureId: string;
  contentDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.fixture.v1',
    canonicalJsonBytes({
      fixtureId: identifierSchema.parse(input.fixtureId),
      contentClass: 'sealed_synthetic',
      contentDigest: digestSchema.parse(input.contentDigest),
    }),
  );
}

export function computeLiveSuiteCorpusContentDigestV1(content: Uint8Array): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.live-suite.corpus-content.v1', content);
}

export function computeLiveSuiteCorpusDigestV1(input: {
  corpusId: string;
  fixtureContentDigest: `sha256:${string}`;
  corpusContentDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.corpus.v1',
    canonicalJsonBytes({
      corpusId: identifierSchema.parse(input.corpusId),
      fixtureContentDigest: digestSchema.parse(input.fixtureContentDigest),
      corpusContentDigest: digestSchema.parse(input.corpusContentDigest),
    }),
  );
}

export const liveSuiteFixtureDeclarationV1Schema = liveSuiteFixtureDeclarationMaterialV1Schema
  .extend({ fixtureDeclarationDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { fixtureDeclarationDigest, ...material } = value;
    const expected = computeLiveSuiteFixtureDeclarationDigestV1(material);
    if (fixtureDeclarationDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['fixtureDeclarationDigest'],
        message: `L3 live-suite fixture declaration digest mismatch: expected ${expected}`,
      });
    }
  });
export type LiveSuiteFixtureDeclarationV1 = z.infer<typeof liveSuiteFixtureDeclarationV1Schema>;

export function buildLiveSuiteFixtureDeclarationV1(
  material: LiveSuiteFixtureDeclarationMaterialV1,
): LiveSuiteFixtureDeclarationV1 {
  const parsed = liveSuiteFixtureDeclarationMaterialV1Schema.parse(material);
  return liveSuiteFixtureDeclarationV1Schema.parse({
    ...parsed,
    fixtureDeclarationDigest: computeLiveSuiteFixtureDeclarationDigestV1(parsed),
  });
}

/**
 * Checked-in, nonempty safe input. It is never a report field: the policy and
 * evidence carry only its content digest. The runner materializes a fresh copy
 * into its read-only synthetic root and must not execute it.
 */
const L3_LIVE_COMPATIBILITY_FIXTURE_BYTES_V1 = new TextEncoder().encode(
  'schema=qualification-l3-sealed-synthetic-fixture-v1\nclassification=sealed_synthetic\nmode=diagnostic_only\n',
);
const L3_LIVE_COMPATIBILITY_CORPUS_BYTES_V1 = new TextEncoder().encode('Return exactly ACK.');

export function materializeL3LiveCompatibilityFixtureBytesV1(): Uint8Array {
  return new Uint8Array(L3_LIVE_COMPATIBILITY_FIXTURE_BYTES_V1);
}

export function materializeL3LiveCompatibilityCorpusBytesV1(): Uint8Array {
  return new Uint8Array(L3_LIVE_COMPATIBILITY_CORPUS_BYTES_V1);
}

export const L3_LIVE_COMPATIBILITY_FIXTURE_CONTENT_DIGEST_V1 =
  computeLiveSuiteFixtureContentDigestV1(L3_LIVE_COMPATIBILITY_FIXTURE_BYTES_V1);
export const L3_LIVE_COMPATIBILITY_CORPUS_CONTENT_DIGEST_V1 = computeLiveSuiteCorpusContentDigestV1(
  L3_LIVE_COMPATIBILITY_CORPUS_BYTES_V1,
);

/** Reserved fail-closed marker; it must never appear in an executable L3 policy. */
const LIVE_SUITE_RUNNER_SOURCE_DIGEST_UNRESOLVED_V1 = `sha256:${'0'.repeat(64)}` as const;

/**
 * Digest of the exact checked-in sealed orchestration entrypoint. It binds no
 * source body into an observation; a test-only hook recomputes it from bytes.
 */
export const L3_LIVE_COMPATIBILITY_RUNNER_SOURCE_DIGEST_V1 =
  'sha256:d232dbd3fd03766f1758e3f0008283d778b3dda9d9e3a5681511f0bc9f447e91' as const;
const L3_LIVE_COMPATIBILITY_RUNNER_ID_V1 = 'qualification-l3-live-compatibility-runner-v1';

/** Domain-separated digest of the runner source bytes; source body is never retained. */
export function computeLiveSuiteRunnerSourceDigestV1(sourceBytes: Uint8Array): `sha256:${string}` {
  if (sourceBytes.byteLength === 0) throw new Error('live_suite_runner_source_empty');
  return sha256DomainSeparated('kite.qualification.live-suite.runner-source.v1', sourceBytes);
}

/** Bind the runner name and its independently calculated source digest. */
export function computeLiveSuiteRunnerDigestV1(input: {
  runnerId: string;
  runnerSourceDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-suite.runner.v1',
    canonicalJsonBytes({
      runnerId: identifierSchema.parse(input.runnerId),
      runnerSourceDigest: digestSchema.parse(input.runnerSourceDigest),
    }),
  );
}

const L3_LIVE_COMPATIBILITY_FIXTURE_DIGEST_V1 = computeLiveSuiteFixtureDigestV1({
  fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
  contentDigest: L3_LIVE_COMPATIBILITY_FIXTURE_CONTENT_DIGEST_V1,
});
const L3_LIVE_COMPATIBILITY_CORPUS_DIGEST_V1 = computeLiveSuiteCorpusDigestV1({
  corpusId: 'qualification-l3-live-compatibility-corpus-v1',
  fixtureContentDigest: L3_LIVE_COMPATIBILITY_FIXTURE_CONTENT_DIGEST_V1,
  corpusContentDigest: L3_LIVE_COMPATIBILITY_CORPUS_CONTENT_DIGEST_V1,
});
const L3_LIVE_COMPATIBILITY_RUNNER_DIGEST_V1 = computeLiveSuiteRunnerDigestV1({
  runnerId: L3_LIVE_COMPATIBILITY_RUNNER_ID_V1,
  runnerSourceDigest: L3_LIVE_COMPATIBILITY_RUNNER_SOURCE_DIGEST_V1,
});
export const L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-suite.diagnostic-scope-profile.v1',
  {
    profile: 'local-live-diagnostic-observation-v1',
  },
);

/**
 * A sealed L3 invocation binds a synthetic diagnostic candidate identity.
 * It is not a repository artifact or an input to any release decision: it
 * only closes the local candidate/execution/runner relation inside the
 * diagnostic observation and its verifier context.
 */
// `local_synthetic` has no repository revision. Keep the established reserved
// sentinel instead of minting a parallel candidate SHA; fixture, runner,
// Matrix, policy, and candidate-closure digests provide the actual binding.
const L3_LIVE_COMPATIBILITY_LOCAL_SYNTHETIC_COMMIT_V1 =
  '0000000000000000000000000000000000000000' as const;
const L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_BINDING_DIGEST_V1 = digestFixedLiveFactV1(
  'kite.qualification.live-suite.diagnostic-candidate-binding.v1',
  {
    fixtureDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DIGEST_V1,
    corpusDigest: L3_LIVE_COMPATIBILITY_CORPUS_DIGEST_V1,
    oracleDigest: digestFixedLiveFactV1('kite.qualification.live-suite.oracle.v1', {
      oracleId: 'qualification-l3-live-compatibility-oracle-v1',
    }),
    evaluatorDigest: digestFixedLiveFactV1('kite.qualification.live-suite.evaluator.v1', {
      evaluatorId: 'qualification-l3-live-compatibility-evaluator-v1',
    }),
    runnerDigest: L3_LIVE_COMPATIBILITY_RUNNER_DIGEST_V1,
    sourceOwnedIdentityDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.identityDigest,
    governanceProfileDigest: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest,
  },
);

export const L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1 =
  buildDiagnosticCandidateArtifactClosureV1({
    schema: 'DiagnosticCandidateArtifactClosureV1',
    version: 1,
    artifacts: [
      {
        platformIdentity: 'local-host',
        artifact: {
          canonicalRepository: 'diagnostic/qualification',
          repositoryId: 'diagnostic_l3_live_compatibility_v1',
          commit: L3_LIVE_COMPATIBILITY_LOCAL_SYNTHETIC_COMMIT_V1,
          payloadSha256: L3_LIVE_COMPATIBILITY_RUNNER_DIGEST_V1,
          canonicalManifestDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DIGEST_V1,
          behaviorDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.identityDigest,
          profileDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
          gatePolicyDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_BINDING_DIGEST_V1,
        },
      },
    ],
  });

/** Content-free manifest a later sealed runner must bind before materializing bytes. */
export const L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1 = buildLiveSuiteFixtureDeclarationV1({
  schema: 'LiveSuiteFixtureDeclarationV1',
  version: 1,
  fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
  contentDigest: L3_LIVE_COMPATIBILITY_FIXTURE_CONTENT_DIGEST_V1,
  fixtureDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DIGEST_V1,
  corpusId: 'qualification-l3-live-compatibility-corpus-v1',
  corpusContentDigest: L3_LIVE_COMPATIBILITY_CORPUS_CONTENT_DIGEST_V1,
  corpusDigest: L3_LIVE_COMPATIBILITY_CORPUS_DIGEST_V1,
  oracleId: 'qualification-l3-live-compatibility-oracle-v1',
  oracleDigest: digestFixedLiveFactV1('kite.qualification.live-suite.oracle.v1', {
    oracleId: 'qualification-l3-live-compatibility-oracle-v1',
  }),
  evaluatorId: 'qualification-l3-live-compatibility-evaluator-v1',
  evaluatorDigest: digestFixedLiveFactV1('kite.qualification.live-suite.evaluator.v1', {
    evaluatorId: 'qualification-l3-live-compatibility-evaluator-v1',
  }),
  runnerId: L3_LIVE_COMPATIBILITY_RUNNER_ID_V1,
  runnerSourceDigest: L3_LIVE_COMPATIBILITY_RUNNER_SOURCE_DIGEST_V1,
  runnerDigest: L3_LIVE_COMPATIBILITY_RUNNER_DIGEST_V1,
  candidateClosureDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
  sourceOwnedIdentity: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
  promptEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.promptEnvironmentDigest,
  toolEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.toolCatalogDigest,
});

export function assertLiveSuiteFixtureMatchesPolicyV1(input: {
  policy: unknown;
  fixture: unknown;
}): void {
  const policy = liveSuitePolicyV1Schema.parse(input.policy);
  const fixture = liveSuiteFixtureDeclarationV1Schema.parse(input.fixture);
  if (
    policy.fixtureId !== fixture.fixtureId ||
    policy.fixtureDigest !== fixture.fixtureDigest ||
    policy.corpusDigest !== fixture.corpusDigest ||
    policy.oracleDigest !== fixture.oracleDigest ||
    policy.evaluatorDigest !== fixture.evaluatorDigest ||
    policy.runnerSourceDigest !== fixture.runnerSourceDigest ||
    policy.runnerDigest !== fixture.runnerDigest ||
    policy.candidateClosureDigest !== fixture.candidateClosureDigest ||
    policy.sourceOwnedIdentity.identityDigest !== fixture.sourceOwnedIdentity.identityDigest ||
    policy.promptEnvironmentDigest !== fixture.promptEnvironmentDigest ||
    policy.toolEnvironmentDigest !== fixture.toolEnvironmentDigest
  ) {
    throw new Error('live_suite_fixture_policy_mismatch');
  }
}

/** Verify a runner's sealed fixture bytes without retaining them in any record. */
export function assertLiveSuiteFixtureContentV1(input: {
  fixture: unknown;
  content: Uint8Array;
}): void {
  const fixture = liveSuiteFixtureDeclarationV1Schema.parse(input.fixture);
  const contentDigest = computeLiveSuiteFixtureContentDigestV1(input.content);
  if (
    contentDigest !== fixture.contentDigest ||
    computeLiveSuiteFixtureDigestV1({
      fixtureId: fixture.fixtureId,
      contentDigest: fixture.contentDigest as `sha256:${string}`,
    }) !== fixture.fixtureDigest
  ) {
    throw new Error('live_suite_fixture_content_mismatch');
  }
}

/** Verify the exact sealed corpus bytes without retaining them in a report. */
export function assertLiveSuiteCorpusContentV1(input: {
  fixture: unknown;
  content: Uint8Array;
}): void {
  const fixture = liveSuiteFixtureDeclarationV1Schema.parse(input.fixture);
  const corpusContentDigest = computeLiveSuiteCorpusContentDigestV1(input.content);
  if (
    corpusContentDigest !== fixture.corpusContentDigest ||
    computeLiveSuiteCorpusDigestV1({
      corpusId: fixture.corpusId,
      fixtureContentDigest: fixture.contentDigest as `sha256:${string}`,
      corpusContentDigest: fixture.corpusContentDigest as `sha256:${string}`,
    }) !== fixture.corpusDigest
  ) {
    throw new Error('live_suite_corpus_content_mismatch');
  }
}

/**
 * Hook for the future sealed runner's source-digest test. It accepts only the
 * runner identity/digest and never an executable path, source body, or output.
 */
export function assertLiveSuiteRunnerBindingV1(input: {
  policy: unknown;
  fixture: unknown;
  runnerId: string;
  runnerDigest: `sha256:${string}`;
}): void {
  assertLiveSuiteFixtureMatchesPolicyV1({ policy: input.policy, fixture: input.fixture });
  const fixture = liveSuiteFixtureDeclarationV1Schema.parse(input.fixture);
  if (
    identifierSchema.parse(input.runnerId) !== fixture.runnerId ||
    input.runnerDigest !== fixture.runnerDigest
  ) {
    throw new Error('live_suite_runner_binding_mismatch');
  }
}

/**
 * Test-only source-drift hook. The runner never invokes this API: runtime
 * does not read workspace source. Tests feed checked-in runner bytes, which
 * are reduced immediately to a digest and never written to a record/report.
 */
export function assertLiveSuiteRunnerSourceDriftV1(input: {
  policy: unknown;
  fixture: unknown;
  runnerId: string;
  sourceBytes: Uint8Array;
}): void {
  assertLiveSuiteFixtureMatchesPolicyV1({ policy: input.policy, fixture: input.fixture });
  const fixture = liveSuiteFixtureDeclarationV1Schema.parse(input.fixture);
  if (fixture.runnerSourceDigest === LIVE_SUITE_RUNNER_SOURCE_DIGEST_UNRESOLVED_V1) {
    throw new Error('live_suite_runner_source_digest_unresolved');
  }
  const runnerSourceDigest = computeLiveSuiteRunnerSourceDigestV1(input.sourceBytes);
  const runnerDigest = computeLiveSuiteRunnerDigestV1({
    runnerId: input.runnerId,
    runnerSourceDigest,
  });
  if (
    identifierSchema.parse(input.runnerId) !== fixture.runnerId ||
    runnerSourceDigest !== fixture.runnerSourceDigest ||
    runnerDigest !== fixture.runnerDigest
  ) {
    throw new Error('live_suite_runner_source_drift');
  }
}

export const L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1 = buildLiveSuitePolicyV1({
  schema: 'LiveSuitePolicyV1',
  version: 1,
  authority: 'diagnostic',
  evidenceEligible: false,
  issuedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-12-31T00:00:00.000Z',
  policyId: 'qualification-l3-live-compatibility-policy-v1',
  suiteId: L3_LIVE_COMPATIBILITY_SUITE_ID_V1,
  sourceOwnedIdentity: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
  routeId: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.routeId,
  routeDeclarationDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.declarationDigest,
  routeIdentityDigest: L3_QWEN_LIVE_ROUTE_IDENTITY_V1.routeIdentityDigest,
  providerDataPolicyDigest: L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest,
  capabilityDeclarationDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.capabilityDeclarationDigest,
  capabilitySourceBindingDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.capabilitySourceBindingDigest,
  governance: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.governance,
  caseIds: ['l3-live-cancelled-v1', 'l3-live-success-v1'],
  fixtureId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureId,
  fixtureDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureDigest,
  corpusDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.corpusDigest,
  oracleDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.oracleDigest,
  evaluatorDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.evaluatorDigest,
  runnerSourceDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerSourceDigest,
  runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest,
  candidateClosureDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.candidateClosureDigest,
  promptEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.promptEnvironmentDigest,
  toolEnvironment: L3_LIVE_COMPATIBILITY_TOOL_ENVIRONMENT_V1,
  toolEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.toolCatalogDigest,
  sampling: { mode: 'deterministic_fixed', temperatureMilli: 0, topPMilli: 1_000 },
  budget: {
    maxAttemptsPerInvocation: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 600,
    maxTotalTokens: 12_288,
    maxRunWallClockSeconds: 600,
    maxCostUsdMicros: 250_000,
    maxConcurrentInvocations: 1,
  },
  maxRetries: 0,
  terminalOutcomes: ['cancelled', 'success'],
  blockedReasonCodes: [
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
  ],
  credentialSources: ['environment'],
  aggregate: {
    denominator: 1,
    minimumSuccesses: 1,
    confidenceInterval: 'wilson_95',
    attemptIndependence: 'separate_opt_in_invocation',
    missingOutcome: 'blocked',
    overBudgetOutcome: 'blocked',
    timeoutOutcome: 'blocked',
  },
});

export interface LiveRouteModelBoundaryLeaseV1 {
  readonly route: DiagnosticRouteIdentityV1;
  readonly credentialSource: 'environment';
  /**
   * The sole handoff of raw transport data. Callers must invoke this only at
   * the parent model boundary; the lease is intentionally never made
   * enumerable on diagnostic output objects.
   */
  withModelTransport<T>(
    modelBoundary: (
      transport: Readonly<{
        providerAdapter: 'openai-compatible';
        protocolFamily: 'openai_compatible';
        baseURL: string;
        model: 'qwen3.6-flash';
        apiKey: string;
      }>,
    ) => T,
  ): T;
}

export interface LiveRouteResolutionReadyV1 {
  readonly status: 'ready';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly route: DiagnosticRouteIdentityV1;
  readonly policyId: string;
  readonly policyDigest: `sha256:${string}`;
  readonly governance: LiveRouteGovernanceV1;
  readonly credentialSource: 'environment';
  /** Non-enumerable: it must never reach report/stdout/evidence serialization. */
  readonly modelBoundary: LiveRouteModelBoundaryLeaseV1;
}

export interface LiveRouteResolutionBlockedV1 {
  readonly status: 'blocked';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly reasonCode: LiveSuiteBlockedReasonCodeV1;
  readonly route?: DiagnosticRouteIdentityV1;
  readonly policyId?: string;
  readonly policyDigest?: `sha256:${string}`;
}

export type LiveRouteResolutionV1 = LiveRouteResolutionReadyV1 | LiveRouteResolutionBlockedV1;

/**
 * Policy-free, source-owned transport lease result.  It is deliberately
 * narrower than the AQ-8 resolution result: callers cannot supply a generic
 * policy here, so a later diagnostic suite must validate its own exact policy
 * before it can reuse this registered route/credential boundary.
 */
export interface RegisteredLiveRouteLeaseReadyV1 {
  readonly status: 'ready';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly route: DiagnosticRouteIdentityV1;
  readonly governance: LiveRouteGovernanceV1;
  readonly credentialSource: 'environment';
  /** Non-enumerable: raw endpoint/key never form part of a report. */
  readonly modelBoundary: LiveRouteModelBoundaryLeaseV1;
}

export interface RegisteredLiveRouteLeaseBlockedV1 {
  readonly status: 'blocked';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly reasonCode: LiveSuiteBlockedReasonCodeV1;
  readonly route?: DiagnosticRouteIdentityV1;
}

export type RegisteredLiveRouteLeaseResolutionV1 =
  | RegisteredLiveRouteLeaseReadyV1
  | RegisteredLiveRouteLeaseBlockedV1;

export interface ResolveRegisteredLiveRouteLeaseInputV1 {
  readonly explicitOptIn: boolean;
  readonly routeId: string;
  /** Parent-supplied environment; this resolver never reads ambient state itself. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Injected clock prevents hidden ambient-time behavior in the contract. */
  readonly now: string;
}

export interface ResolveLiveRouteForModelBoundaryInputV1 {
  readonly explicitOptIn: boolean;
  readonly routeId: string;
  readonly policy: unknown;
  /** Parent-supplied environment; this resolver never reads ambient state itself. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Injected clock prevents hidden ambient-time behavior in the contract. */
  readonly now: string;
}

function blocked(
  reasonCode: LiveSuiteBlockedReasonCodeV1,
  options: {
    route?: DiagnosticRouteIdentityV1;
    policy?: LiveSuitePolicyV1;
  } = {},
): LiveRouteResolutionBlockedV1 {
  return Object.freeze({
    status: 'blocked' as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    reasonCode,
    ...(options.route ? { route: options.route } : {}),
    ...(options.policy
      ? {
          policyId: options.policy.policyId,
          policyDigest: options.policy.policyDigest as `sha256:${string}`,
        }
      : {}),
  });
}

function policyMatchesRoute(
  policy: LiveSuitePolicyV1,
  declaration: LiveRouteDeclarationV1,
  route: DiagnosticRouteIdentityV1,
): boolean {
  return (
    policy.routeId === declaration.routeId &&
    policy.routeDeclarationDigest === declaration.declarationDigest &&
    policy.routeIdentityDigest === route.routeIdentityDigest &&
    policy.providerDataPolicyDigest === declaration.providerDataPolicyDigest &&
    policy.capabilityDeclarationDigest === declaration.capabilityDeclarationDigest &&
    policy.capabilitySourceBindingDigest === declaration.capabilitySourceBindingDigest &&
    policy.sourceOwnedIdentity.identityDigest ===
      L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.identityDigest &&
    policy.candidateClosureDigest ===
      L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest &&
    policy.promptEnvironmentDigest === declaration.promptEnvironmentDigest &&
    policy.toolEnvironmentDigest === declaration.toolCatalogDigest &&
    sameGovernance(policy.governance, declaration.governance)
  );
}

function leaseFor(
  route: DiagnosticRouteIdentityV1,
  baseURL: string,
  apiKey: string,
): LiveRouteModelBoundaryLeaseV1 {
  return Object.freeze({
    route,
    credentialSource: 'environment' as const,
    withModelTransport<T>(
      modelBoundary: (
        transport: Readonly<{
          providerAdapter: 'openai-compatible';
          protocolFamily: 'openai_compatible';
          baseURL: string;
          model: 'qwen3.6-flash';
          apiKey: string;
        }>,
      ) => T,
    ): T {
      const transport = {} as Readonly<{
        providerAdapter: 'openai-compatible';
        protocolFamily: 'openai_compatible';
        baseURL: string;
        model: 'qwen3.6-flash';
        apiKey: string;
      }>;
      Object.defineProperties(transport, {
        providerAdapter: { enumerable: false, value: 'openai-compatible' as const },
        protocolFamily: { enumerable: false, value: 'openai_compatible' as const },
        baseURL: { enumerable: false, value: baseURL },
        model: { enumerable: false, value: 'qwen3.6-flash' as const },
        apiKey: { enumerable: false, value: apiKey },
      });
      return modelBoundary(Object.freeze(transport));
    },
  });
}

function blockedRegisteredLease(
  reasonCode: LiveSuiteBlockedReasonCodeV1,
  route?: DiagnosticRouteIdentityV1,
): RegisteredLiveRouteLeaseBlockedV1 {
  return Object.freeze({
    status: 'blocked' as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    reasonCode,
    ...(route ? { route } : {}),
  });
}

/**
 * Resolve a reviewed diagnostic route and create its non-enumerable model
 * lease without accepting any suite policy.  AQ-8 still owns its exact
 * `LiveSuitePolicyV1` match below; AQ-9B can use this only after its separate
 * source-owned multi-dispatch policy has been checked by its own wrapper.
 */
export function resolveRegisteredLiveRouteLeaseV1(
  input: ResolveRegisteredLiveRouteLeaseInputV1,
): RegisteredLiveRouteLeaseResolutionV1 {
  const declaration = LIVE_ROUTE_BY_ID_V1.get(input.routeId);
  if (!declaration) return blockedRegisteredLease('route_not_registered');

  const route = buildLiveRouteDiagnosticIdentityV1(declaration);
  if (!input.explicitOptIn) return blockedRegisteredLease('explicit_opt_in_required', route);
  if (!isoTimestampSchema.safeParse(input.now).success)
    return blockedRegisteredLease('policy_invalid', route);
  if (Date.parse(input.now) < Date.parse(L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.issuedAt)) {
    return blockedRegisteredLease('policy_not_active', route);
  }
  if (Date.parse(input.now) >= Date.parse(L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.expiresAt)) {
    return blockedRegisteredLease('policy_expired', route);
  }
  if (
    L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.routeId !== declaration.routeId ||
    L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest !==
      declaration.providerDataPolicyDigest ||
    L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.originIdentityDigest !==
      declaration.endpointIdentityDigest
  ) {
    return blockedRegisteredLease('capability_not_declared', route);
  }
  const baseURL = canonicalizeQwenEndpointForModelBoundaryV1(
    input.environment[QWEN_QUALIFICATION_ENVIRONMENT_KEYS_V1.endpoint] ?? '',
  );
  if (!baseURL) return blockedRegisteredLease('endpoint_not_allowed', route);
  const apiKey = input.environment[QWEN_QUALIFICATION_ENVIRONMENT_KEYS_V1.credential];
  if (!apiKey || apiKey.trim() !== apiKey || hasQualificationControlCharacterV1(apiKey)) {
    return blockedRegisteredLease('credential_missing', route);
  }

  const result: Omit<RegisteredLiveRouteLeaseReadyV1, 'modelBoundary'> = {
    status: 'ready',
    authority: 'diagnostic',
    evidenceEligible: false,
    route,
    governance: declaration.governance,
    credentialSource: 'environment',
  };
  Object.defineProperty(result, 'modelBoundary', {
    enumerable: false,
    value: leaseFor(route, baseURL, apiKey),
  });
  return Object.freeze(result as RegisteredLiveRouteLeaseReadyV1);
}

/**
 * Resolve exactly one checked-in diagnostic route. This is a no-network,
 * no-config-loader preflight. The returned record is metadata-only; raw
 * endpoint and key remain reachable only through its non-enumerable lease.
 */
export function resolveLiveRouteForModelBoundaryV1(
  input: ResolveLiveRouteForModelBoundaryInputV1,
): LiveRouteResolutionV1 {
  const declaration = LIVE_ROUTE_BY_ID_V1.get(input.routeId);
  if (!declaration) return blocked('route_not_registered');

  const route = buildLiveRouteDiagnosticIdentityV1(declaration);
  const parsedPolicy = liveSuitePolicyV1Schema.safeParse(input.policy);
  if (!parsedPolicy.success) return blocked('policy_invalid', { route });
  const policy = parsedPolicy.data;
  if (!policyMatchesRoute(policy, declaration, route)) {
    return blocked('route_policy_mismatch', { route, policy });
  }
  if (!input.explicitOptIn) return blocked('explicit_opt_in_required', { route, policy });
  if (!isoTimestampSchema.safeParse(input.now).success)
    return blocked('policy_invalid', { route, policy });
  if (Date.parse(input.now) < Date.parse(policy.issuedAt)) {
    return blocked('policy_not_active', { route, policy });
  }
  if (Date.parse(input.now) >= Date.parse(policy.expiresAt)) {
    return blocked('policy_expired', { route, policy });
  }
  const registered = resolveRegisteredLiveRouteLeaseV1({
    explicitOptIn: input.explicitOptIn,
    routeId: input.routeId,
    environment: input.environment,
    now: input.now,
  });
  if (registered.status === 'blocked') {
    return blocked(registered.reasonCode, { route, policy });
  }

  const result: Omit<LiveRouteResolutionReadyV1, 'modelBoundary'> = {
    status: 'ready',
    authority: 'diagnostic',
    evidenceEligible: false,
    route,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest as `sha256:${string}`,
    governance: registered.governance,
    credentialSource: 'environment',
  };
  Object.defineProperty(result, 'modelBoundary', {
    enumerable: false,
    value: registered.modelBoundary,
  });
  return Object.freeze(result as LiveRouteResolutionReadyV1);
}

/** Source-owned lookup for a caller that wants to reject an unknown route before preflight. */
export function getRegisteredLiveRouteDeclarationV1(
  routeId: string,
): LiveRouteDeclarationV1 | undefined {
  return LIVE_ROUTE_BY_ID_V1.get(routeId);
}

export function assertLiveRouteDeclarationRegistryV1(): void {
  const ids = LIVE_ROUTE_DECLARATIONS_V1.map((entry) => entry.routeId);
  if (!codePointSortedUnique(ids) || new Set(ids).size !== ids.length) {
    throw new Error('live_route_declaration_registry_invalid');
  }
}

assertLiveRouteDeclarationRegistryV1();
