import { createHash } from 'node:crypto';
import type { ExecutionBoundary, ExecutionNetworkMode } from './types';

/** Immutable, release-derived network ceiling consumed by each invocation. */
export interface NetworkBoundaryPolicy {
  version: 1;
  mode: ExecutionNetworkMode;
  allowedHosts: readonly string[];
  allowLocalAndPrivateNetwork: false;
  revision: string;
}

export function networkBoundaryPolicyFromExecutionBoundary(
  boundary: ExecutionBoundary,
  enabled: boolean,
): NetworkBoundaryPolicy {
  const mode = enabled ? boundary.networkMode : 'off';
  const allowedHosts = mode === 'allowlist' ? [...boundary.networkAllowlist] : [];
  const canonical = {
    version: 1 as const,
    executionBoundaryDigest: computeExecutionBoundaryDigest(boundary),
    mode,
    allowedHosts,
    allowLocalAndPrivateNetwork: false as const,
  };
  return Object.freeze({
    ...canonical,
    allowedHosts: Object.freeze(allowedHosts),
    revision: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
}

export function canonicalNetworkHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function computeExecutionBoundaryDigest(boundary: ExecutionBoundary): string {
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
