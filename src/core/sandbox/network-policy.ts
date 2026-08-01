import { createHash } from 'node:crypto';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/execution-boundary';
import type { ExecutionBoundaryV1, ExecutionNetworkMode } from './types';

/** Immutable, release-derived network ceiling consumed by each invocation. */
export interface NetworkBoundaryPolicyV1 {
  version: 1;
  mode: ExecutionNetworkMode;
  allowedHosts: readonly string[];
  allowLocalAndPrivateNetwork: false;
  revision: string;
}

export function networkBoundaryPolicyFromExecutionBoundaryV1(
  boundary: ExecutionBoundaryV1,
  enabled: boolean,
): NetworkBoundaryPolicyV1 {
  const mode = enabled ? boundary.networkMode : 'off';
  const allowedHosts = mode === 'allowlist' ? [...boundary.networkAllowlist] : [];
  const canonical = {
    version: 1 as const,
    executionBoundaryDigest: computeExecutionBoundaryDigestV1(boundary),
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
