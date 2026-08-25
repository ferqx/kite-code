import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProtectedPathEvaluator {
  readonly workspaceRoot: string;
  evaluate(access: { path: string; operation: 'read' | 'write' | 'execute' }): Readonly<{
    outcome: 'allow' | 'deny' | 'prompt';
    reason: string;
    canonicalPath: string | null;
  }>;
}

export interface NetworkBoundaryPolicy {
  version: 1;
  mode: 'off' | 'allowlist';
  allowedHosts: readonly string[];
  allowLocalAndPrivateNetwork: false;
  revision: string;
}

export interface NetworkResolvedAddress {
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

export type NetworkResolver = (hostname: string) => Promise<readonly NetworkResolvedAddress[]>;
export interface NetworkAdmissionReceipt {
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

export interface NetworkDenialReceipt {
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

export type NetworkDecisionReceipt = NetworkAdmissionReceipt | NetworkDenialReceipt;
export type NetworkDecisionRecorder = (decision: NetworkDecisionReceipt) => void | Promise<void>;
export type PinnedNetworkRequest = (input: {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  admission: NetworkAdmissionReceipt;
}) => Promise<Response>;

export interface NetworkBoundaryFetchOptions {
  resolver?: NetworkResolver;
  recordDecision?: NetworkDecisionRecorder;
  toolCallId?: string;
  invocationIdFactory?: () => string;
  request?: PinnedNetworkRequest;
}

export type NetworkBoundaryFetchFactory = (
  policy: NetworkBoundaryPolicy,
  options: NetworkBoundaryFetchOptions,
) => typeof fetch;

export interface ExecutionBoundary {
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

export interface ExecutionCapabilitySurface {
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

export function canonicalWorkspaceKey(workspace: string): string {
  const canonical = realpathSync.native(resolve(workspace));
  let normalized = canonical.replaceAll('\\', '/');
  if (/^[A-Z]:\//.test(normalized)) normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return createHash('sha256').update(`kite-mcp-workspace-v1\0${normalized}`).digest('hex');
}

export function computeExecutionBoundaryDigest(boundary: ExecutionBoundary): string {
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
