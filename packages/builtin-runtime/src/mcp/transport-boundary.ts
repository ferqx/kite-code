import { createHash } from 'node:crypto';
import {
  canonicalWorkspaceKey,
  computeExecutionBoundaryDigest,
  type ExecutionBoundary,
  type ExecutionCapabilitySurface,
} from './mechanism-ports';
import type { McpServerConfig, McpTransportType } from './types';

export type McpTransportOperation =
  | 'connect'
  | 'tool_call'
  | 'resource_read'
  | 'tool_list'
  | 'prompt_list'
  | 'resource_list'
  | 'oauth_finish';

export interface McpTransportBoundaryIdentity {
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

export interface McpTransportInvocationBinding {
  boundaryIdentityDigest: string;
  invocationId: string;
  toolCallId: string;
  endpointRevision: string;
}

export interface McpTransportAdmissionRequest extends McpTransportInvocationBinding {
  version: 1;
  operation: McpTransportOperation;
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

export interface McpTransportAdmissionReceipt extends McpTransportAdmissionRequest {
  outcome: 'allowed';
  receiptDigest: string;
}

export interface McpTransportBoundaryController {
  readonly identity: McpTransportBoundaryIdentity;
  admit(request: McpTransportAdmissionRequest): Promise<McpTransportAdmissionReceipt>;
}

export type McpTransportBoundaryFailureCode =
  | 'boundary_unavailable'
  | 'workspace_mismatch'
  | 'transport_denied'
  | 'invocation_identity_missing'
  | 'boundary_identity_mismatch'
  | 'endpoint_revision_mismatch'
  | 'admission_receipt_mismatch';

export class McpTransportBoundaryError extends Error {
  readonly code: McpTransportBoundaryFailureCode;

  constructor(code: McpTransportBoundaryFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpTransportBoundaryError';
    this.code = code;
  }
}

export function createMcpTransportBoundaryIdentity(input: {
  workspaceRoot: string;
  executionBoundary: ExecutionBoundary;
  executionSurface: ExecutionCapabilitySurface;
  runIdentity: string;
  profileIdentity: string;
  networkPolicyRevision: string;
}): McpTransportBoundaryIdentity {
  const canonical = {
    version: 1 as const,
    workspaceKey: canonicalWorkspaceKey(input.workspaceRoot),
    executionBoundaryRevision: computeExecutionBoundaryDigest(input.executionBoundary),
    runIdentity: nonEmptyIdentity(input.runIdentity, 'runIdentity'),
    profileIdentity: nonEmptyIdentity(input.profileIdentity, 'profileIdentity'),
    networkPolicyRevision: nonEmptyIdentity(input.networkPolicyRevision, 'networkPolicyRevision'),
    localStdioMcp: input.executionSurface.localStdioMcp === true,
    remoteHttpMcp: input.executionSurface.network === true,
  };
  return Object.freeze({ ...canonical, identityDigest: digest(canonical) });
}

export function createMcpTransportAdmissionReceipt(
  request: McpTransportAdmissionRequest,
): McpTransportAdmissionReceipt {
  const receipt = { ...request, outcome: 'allowed' as const };
  return Object.freeze({ ...receipt, receiptDigest: digest(receipt) });
}

export function assertMcpTransportAdmissionReceipt(
  request: McpTransportAdmissionRequest,
  receipt: McpTransportAdmissionReceipt,
): void {
  const expected = createMcpTransportAdmissionReceipt(request);
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
    throw new McpTransportBoundaryError(
      'admission_receipt_mismatch',
      'MCP transport admission receipt did not match this invocation.',
    );
  }
}

export function canonicalMcpHttpEndpointIdentity(config: McpServerConfig): {
  canonicalEndpoint: string;
  endpointIdentityDigest: string;
} {
  if (config.type !== 'http' || !config.url) {
    throw new McpTransportBoundaryError(
      'transport_denied',
      'A sealed HTTP MCP transport requires an explicit endpoint URL.',
    );
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch (error) {
    throw new McpTransportBoundaryError(
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
    throw new McpTransportBoundaryError(
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
