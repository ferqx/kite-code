import { createHash } from 'node:crypto';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/execution-boundary';
import { canonicalWorkspaceKey } from '@/core/config/mcp-project-approvals';
import type { ExecutionBoundaryV1, ExecutionCapabilitySurfaceV1 } from '@/core/sandbox/types';
import type { McpServerConfig, McpTransportType } from './types';

export type McpTransportOperationV1 =
  | 'connect'
  | 'tool_call'
  | 'resource_read'
  | 'tool_list'
  | 'prompt_list'
  | 'resource_list'
  | 'oauth_finish';

export interface McpTransportBoundaryIdentityV1 {
  version: 1;
  workspaceKey: string;
  executionBoundaryRevision: string;
  runIdentity: string;
  profileIdentity: string;
  networkPolicyRevision: string;
  localStdioMcp: boolean;
  remoteHttpMcp: boolean;
  identityDigest: string;
}

export interface McpTransportInvocationBindingV1 {
  boundaryIdentityDigest: string;
  invocationId: string;
  toolCallId: string;
  endpointRevision: string;
}

export interface McpTransportAdmissionRequestV1 extends McpTransportInvocationBindingV1 {
  version: 1;
  operation: McpTransportOperationV1;
  transport: McpTransportType;
  serverIdentity: string;
  workspaceKey: string;
  executionBoundaryRevision: string;
  runIdentity: string;
  profileIdentity: string;
  networkPolicyRevision: string;
  canonicalEndpoint: string;
  endpointIdentityDigest: string;
}

export interface McpTransportAdmissionReceiptV1 extends McpTransportAdmissionRequestV1 {
  outcome: 'allowed';
  receiptDigest: string;
}

export interface McpTransportBoundaryControllerV1 {
  readonly identity: McpTransportBoundaryIdentityV1;
  admit(request: McpTransportAdmissionRequestV1): Promise<McpTransportAdmissionReceiptV1>;
}

export type McpTransportBoundaryFailureCodeV1 =
  | 'boundary_unavailable'
  | 'workspace_mismatch'
  | 'transport_denied'
  | 'invocation_identity_missing'
  | 'boundary_identity_mismatch'
  | 'endpoint_revision_mismatch'
  | 'admission_receipt_mismatch';

export class McpTransportBoundaryErrorV1 extends Error {
  readonly code: McpTransportBoundaryFailureCodeV1;

  constructor(code: McpTransportBoundaryFailureCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpTransportBoundaryErrorV1';
    this.code = code;
  }
}

/** @qualification-surface-v1 {"sourceSurfaceId":"mcp:open-world-contract","featureId":"MCP-OPEN_WORLD_CONTRACT-001","domain":"mcp","observableContract":"mcp_open_world_protocol","risk":"p0","riskRationale":"open_world_mcp_risk","owner":"core-mcp","entrypoints":["cli","runtime","tui"],"sourceKind":"contract","symbol":"createMcpTransportBoundaryIdentityV1"} */
export function createMcpTransportBoundaryIdentityV1(input: {
  workspaceRoot: string;
  executionBoundary: ExecutionBoundaryV1;
  executionSurface: ExecutionCapabilitySurfaceV1;
  runIdentity: string;
  profileIdentity: string;
  networkPolicyRevision: string;
}): McpTransportBoundaryIdentityV1 {
  const canonical = {
    version: 1 as const,
    workspaceKey: canonicalWorkspaceKey(input.workspaceRoot),
    executionBoundaryRevision: computeExecutionBoundaryDigestV1(input.executionBoundary),
    runIdentity: nonEmptyIdentity(input.runIdentity, 'runIdentity'),
    profileIdentity: nonEmptyIdentity(input.profileIdentity, 'profileIdentity'),
    networkPolicyRevision: nonEmptyIdentity(input.networkPolicyRevision, 'networkPolicyRevision'),
    // Local stdio remains excluded until a real sandbox-backed transport
    // factory exists; a capability-surface bit alone cannot manufacture one.
    localStdioMcp: false,
    remoteHttpMcp: input.executionSurface.network === true,
  };
  return Object.freeze({ ...canonical, identityDigest: digest(canonical) });
}

export function createMcpTransportAdmissionReceiptV1(
  request: McpTransportAdmissionRequestV1,
): McpTransportAdmissionReceiptV1 {
  const receipt = { ...request, outcome: 'allowed' as const };
  return Object.freeze({ ...receipt, receiptDigest: digest(receipt) });
}

export function assertMcpTransportAdmissionReceiptV1(
  request: McpTransportAdmissionRequestV1,
  receipt: McpTransportAdmissionReceiptV1,
): void {
  const expected = createMcpTransportAdmissionReceiptV1(request);
  if (
    receipt.version !== expected.version ||
    receipt.outcome !== 'allowed' ||
    receipt.operation !== expected.operation ||
    receipt.transport !== expected.transport ||
    receipt.serverIdentity !== expected.serverIdentity ||
    receipt.workspaceKey !== expected.workspaceKey ||
    receipt.executionBoundaryRevision !== expected.executionBoundaryRevision ||
    receipt.runIdentity !== expected.runIdentity ||
    receipt.profileIdentity !== expected.profileIdentity ||
    receipt.networkPolicyRevision !== expected.networkPolicyRevision ||
    receipt.canonicalEndpoint !== expected.canonicalEndpoint ||
    receipt.endpointIdentityDigest !== expected.endpointIdentityDigest ||
    receipt.boundaryIdentityDigest !== expected.boundaryIdentityDigest ||
    receipt.invocationId !== expected.invocationId ||
    receipt.toolCallId !== expected.toolCallId ||
    receipt.endpointRevision !== expected.endpointRevision ||
    receipt.receiptDigest !== expected.receiptDigest
  ) {
    throw new McpTransportBoundaryErrorV1(
      'admission_receipt_mismatch',
      'MCP transport admission receipt did not match this invocation.',
    );
  }
}

export function canonicalMcpHttpEndpointIdentityV1(config: McpServerConfig): {
  canonicalEndpoint: string;
  endpointIdentityDigest: string;
} {
  if (config.type !== 'http' || !config.url) {
    throw new McpTransportBoundaryErrorV1(
      'transport_denied',
      'A sealed HTTP MCP transport requires an explicit endpoint URL.',
    );
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch (error) {
    throw new McpTransportBoundaryErrorV1(
      'transport_denied',
      'The MCP HTTP endpoint URL is invalid.',
      { cause: error },
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new McpTransportBoundaryErrorV1(
      'transport_denied',
      'The MCP HTTP endpoint must be credential-free and cannot contain query or fragment data.',
    );
  }
  const canonicalEndpoint = url.href;
  return Object.freeze({
    canonicalEndpoint,
    endpointIdentityDigest: digest({ transport: 'http', canonicalEndpoint }),
  });
}

function nonEmptyIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be a non-empty identity`);
  return normalized;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
