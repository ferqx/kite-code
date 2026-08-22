import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProtectedPathEvaluatorV1 {
  readonly workspaceRoot: string;
  evaluate(access: { path: string; operation: 'read' | 'write' | 'execute' }): Readonly<{
    outcome: 'allow' | 'deny' | 'prompt';
    reason: string;
    canonicalPath: string | null;
  }>;
}

export interface NetworkBoundaryPolicyV1 {
  version: 1;
  mode: 'off' | 'allowlist';
  allowedHosts: readonly string[];
  allowLocalAndPrivateNetwork: false;
  revision: string;
}

export interface NetworkResolvedAddressV1 {
  address: string;
  family: 4 | 6;
}

export type NetworkBoundaryFailureCode =
  | 'network_off'
  | 'invalid_url'
  | 'protocol_denied'
  | 'credentials_denied'
  | 'host_not_allowlisted'
  | 'ip_literal_denied'
  | 'dns_unavailable'
  | 'private_or_reserved_address'
  | 'endpoint_revision_mismatch'
  | 'redirect_denied'
  | 'request_body_too_large'
  | 'response_body_too_large'
  | 'controller_unavailable';

export type NetworkResolverV1 = (hostname: string) => Promise<readonly NetworkResolvedAddressV1[]>;
export interface NetworkAdmissionReceiptV1 {
  version: 1;
  outcome: 'allowed';
  toolCallId: string;
  invocationId: string;
  hop: number;
  policyRevision: string;
  canonicalOrigin: string;
  host: string;
  address: string;
  family: 4 | 6;
  endpointRevision: string;
  expectedEndpointRevision?: string;
  receiptDigest: string;
}

export interface NetworkDenialReceiptV1 {
  version: 1;
  outcome: 'denied';
  toolCallId: string;
  invocationId: string;
  hop: number;
  policyRevision: string;
  canonicalOrigin: string;
  host: string;
  failureCode: NetworkBoundaryFailureCode;
  expectedEndpointRevision?: string;
  receiptDigest: string;
}

export type NetworkDecisionReceiptV1 = NetworkAdmissionReceiptV1 | NetworkDenialReceiptV1;
export type NetworkDecisionRecorderV1 = (
  decision: NetworkDecisionReceiptV1,
) => void | Promise<void>;
export type PinnedNetworkRequestV1 = (input: {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  admission: NetworkAdmissionReceiptV1;
}) => Promise<Response>;

export interface NetworkBoundaryFetchOptionsV1 {
  resolver?: NetworkResolverV1;
  recordDecision?: NetworkDecisionRecorderV1;
  toolCallId?: string;
  invocationIdFactory?: () => string;
  request?: PinnedNetworkRequestV1;
}

export type NetworkBoundaryFetchFactoryV1 = (
  policy: NetworkBoundaryPolicyV1,
  options: NetworkBoundaryFetchOptionsV1,
) => typeof fetch;

export interface ExecutionBoundaryV1 {
  filesystemScope: 'read_only' | 'workspace_write' | 'full_access';
  workspaceRoot: string;
  networkMode: 'off' | 'allowlist';
  networkAllowlist: string[];
  allowLocalAndPrivateNetwork: false;
  protectedPathPolicy: 'deny' | 'prompt';
  maxProcessTreeSizePerShellInvocation: number;
  sandboxRequired: boolean;
  sandboxUnavailable: 'fail' | 'verified_in_process_read_only';
}

export interface ExecutionCapabilitySurfaceV1 {
  inProcessReadOnlyTools?: unknown;
  network: boolean;
  process?: boolean;
  write?: boolean;
  workspaceWrite?: boolean;
  shell?: boolean;
  skillChild?: boolean;
  localStdioMcp?: boolean;
  gitInspect?: boolean;
  brokeredGitFeatureRevision?: string | null;
}

export function canonicalWorkspaceKeyV1(workspace: string): string {
  const canonical = realpathSync.native(resolve(workspace));
  let normalized = canonical.replaceAll('\\', '/');
  if (/^[A-Z]:\//.test(normalized)) normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return createHash('sha256').update(`kite-mcp-workspace-v1\0${normalized}`).digest('hex');
}

export function computeExecutionBoundaryDigestV1(boundary: ExecutionBoundaryV1): string {
  const canonical = JSON.stringify({
    filesystemScope: boundary.filesystemScope,
    workspaceRoot: boundary.workspaceRoot,
    networkMode: boundary.networkMode,
    networkAllowlist: boundary.networkAllowlist,
    allowLocalAndPrivateNetwork: boundary.allowLocalAndPrivateNetwork,
    protectedPathPolicy: boundary.protectedPathPolicy,
    maxProcessTreeSizePerShellInvocation: boundary.maxProcessTreeSizePerShellInvocation,
    sandboxRequired: boundary.sandboxRequired,
    sandboxUnavailable: boundary.sandboxUnavailable,
  });
  return `sha256:${createHash('sha256')
    .update('kite.execution-boundary.v1\0')
    .update(canonical)
    .digest('hex')}`;
}
