import { createHash } from 'node:crypto';
import { z } from 'zod';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const PROVIDER_DATA_POLICY_VERSION = 1 as const;

/** @qualification-surface-v1 {"sourceSurfaceId":"provider:route-policy","featureId":"MODEL_CONTEXT-ROUTE_POLICY-001","domain":"model_context","observableContract":"provider_open_world_protocol","risk":"p0","riskRationale":"provider_egress_boundary","owner":"core-model","entrypoints":["runtime"],"sourceKind":"contract","symbol":"providerRouteIdentityV1Schema"} */
export const providerRouteIdentityV1Schema = z
  .object({
    providerType: z.string().trim().min(1),
    operatorId: z.string().trim().min(1),
    endpointOrigin: z.string().url(),
    endpointClass: z.string().trim().min(1),
    deploymentId: z.string().trim().min(1),
    region: z.string().trim().min(1),
  })
  .strict();

export type ProviderRouteIdentityV1 = z.infer<typeof providerRouteIdentityV1Schema>;

const allowedPayloadKindsSchema = z
  .object({
    userPrompt: z.boolean(),
    fileSnippet: z.boolean(),
    toolResult: z.boolean(),
    summary: z.boolean(),
  })
  .strict();

export const providerDataPolicyV1Schema = z
  .object({
    version: z.literal(PROVIDER_DATA_POLICY_VERSION),
    policyId: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    decisionId: z.literal('D-14'),
    approvedRevision: z.string().trim().min(1),
    effectiveFrom: z.string().regex(ISO_DATE_TIME_PATTERN),
    expiresAt: z.string().regex(ISO_DATE_TIME_PATTERN),
    routeId: z.string().trim().min(1),
    providerType: z.string().trim().min(1),
    operatorId: z.string().trim().min(1),
    endpointOrigin: z.string().url(),
    endpointClass: z.string().trim().min(1),
    deploymentId: z.string().trim().min(1),
    endpointIdentityDigest: z.string().regex(SHA256_PATTERN),
    region: z.string().trim().min(1),
    credentialOwner: z.enum(['user_os_identity', 'enterprise_admin']),
    maxWorkspaceDataClassification: z.enum(['public', 'internal', 'confidential']),
    allowedPayloadKinds: allowedPayloadKindsSchema,
    contentRetention: z.string().trim().min(1),
    trainingUse: z.enum(['prohibited', 'contract_defined']),
    abuseMonitoring: z.enum(['none', 'metadata_only', 'content_contract_defined']),
    deletionBoundary: z.string().trim().min(1),
    subprocessors: z.array(z.string().trim().min(1)),
    dpaOrAdminApproval: z.enum(['not_required', 'required_and_verified']),
    userDisclosureId: z.string().trim().min(1),
    requestLogging: z.enum(['none', 'metadata', 'content_contract_defined']),
    errorLogging: z.enum(['none', 'metadata', 'content_contract_defined']),
    productDeletionScope: z.string().trim().min(1),
    allowRemoteMcpContentEgress: z.boolean(),
    allowProductionContentEvaluation: z.literal(false),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Date.parse(policy.expiresAt) <= Date.parse(policy.effectiveFrom)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than effectiveFrom',
      });
    }
    const expectedDigest = computeProviderEndpointIdentityDigest({
      providerType: policy.providerType,
      operatorId: policy.operatorId,
      endpointOrigin: policy.endpointOrigin,
      endpointClass: policy.endpointClass,
      deploymentId: policy.deploymentId,
      region: policy.region,
    });
    if (policy.endpointIdentityDigest !== expectedDigest) {
      context.addIssue({
        code: 'custom',
        path: ['endpointIdentityDigest'],
        message: 'endpointIdentityDigest does not match the canonical route identity',
      });
    }
  });

export type ProviderDataPolicyV1 = z.infer<typeof providerDataPolicyV1Schema>;

export const providerDataPolicyBundleV1Schema = z
  .object({
    version: z.literal(PROVIDER_DATA_POLICY_VERSION),
    decisionId: z.literal('D-14'),
    revision: z.string().trim().min(1),
    policies: z.array(providerDataPolicyV1Schema),
  })
  .strict()
  .superRefine((bundle, context) => {
    const identities = new Set<string>();
    for (const [index, policy] of bundle.policies.entries()) {
      const identity = `${policy.policyId}\0${policy.revision}\0${policy.endpointIdentityDigest}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['policies', index],
          message: 'provider policy identity must be unique',
        });
      }
      identities.add(identity);
    }
  });

export type ProviderDataPolicyBundleV1 = z.infer<typeof providerDataPolicyBundleV1Schema>;

export const workspaceDataLabelV1Schema = z
  .object({
    classification: z.enum(['public', 'internal', 'confidential', 'secret']),
    source: z.enum(['artifact', 'admin', 'project_raise_only', 'runtime_secret_detector']),
    provenance: z.enum(['user_prompt', 'workspace_file', 'tool_result', 'generated_summary']),
    canonicalPathDigest: z.string().regex(SHA256_PATTERN).optional(),
  })
  .strict();

export type WorkspaceDataLabelV1 = z.infer<typeof workspaceDataLabelV1Schema>;

const CLASSIFICATION_RANK: Readonly<Record<WorkspaceDataLabelV1['classification'], number>> =
  Object.freeze({
    public: 0,
    internal: 1,
    confidential: 2,
    secret: 3,
  });

function normalizeEndpointOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('endpointOrigin must not include credentials, query parameters, or fragments.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical JSON does not allow non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}.`);
}

export function normalizeProviderRouteIdentityV1(
  value: ProviderRouteIdentityV1,
): ProviderRouteIdentityV1 {
  const parsed = providerRouteIdentityV1Schema.parse(value);
  return {
    ...parsed,
    providerType: parsed.providerType.toLowerCase(),
    endpointOrigin: normalizeEndpointOrigin(parsed.endpointOrigin),
    endpointClass: parsed.endpointClass.toLowerCase(),
    region: parsed.region.toLowerCase(),
  };
}

export function computeProviderEndpointIdentityDigest(value: ProviderRouteIdentityV1): string {
  const canonical = canonicalJson(normalizeProviderRouteIdentityV1(value));
  return `sha256:${createHash('sha256')
    .update('kite.provider-route-identity.v1\0')
    .update(canonical)
    .digest('hex')}`;
}

export function parseProviderDataPolicyV1(value: unknown): ProviderDataPolicyV1 {
  return providerDataPolicyV1Schema.parse(value);
}

export function parseProviderDataPolicyBundleV1(value: unknown): ProviderDataPolicyBundleV1 {
  return providerDataPolicyBundleV1Schema.parse(value);
}

export function computeProviderDataPolicyBundleDigest(value: ProviderDataPolicyBundleV1): string {
  const parsed = parseProviderDataPolicyBundleV1(value);
  return `sha256:${createHash('sha256')
    .update('kite.provider-data-policy-bundle.v1\0')
    .update(canonicalJson(parsed))
    .digest('hex')}`;
}

/**
 * Select the highest classification without allowing project or user input to
 * lower an artifact, administrator, or secret-detector label.
 */
export function raiseWorkspaceDataLabelV1(
  current: WorkspaceDataLabelV1,
  candidate: WorkspaceDataLabelV1,
): WorkspaceDataLabelV1 {
  const parsedCurrent = workspaceDataLabelV1Schema.parse(current);
  const parsedCandidate = workspaceDataLabelV1Schema.parse(candidate);
  return CLASSIFICATION_RANK[parsedCandidate.classification] >
    CLASSIFICATION_RANK[parsedCurrent.classification]
    ? parsedCandidate
    : parsedCurrent;
}
