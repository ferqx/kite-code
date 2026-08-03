import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigSourceKind } from '@/core/config/mcp-config';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';
import type { McpDiagnosticCode } from './diagnostics';
import type { McpCapabilityRouteV1, RemoteMcpEgressInvocationPolicyV1 } from './egress-permit';
import type { McpTransportInvocationBindingV1 } from './transport-boundary';

export type McpProviderDirectoryStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';

/** Redacted provider availability metadata. It never contains transport or credential material. */
export interface McpProviderDirectoryEntry {
  providerId: string;
  status: McpProviderDirectoryStatus;
  required: boolean;
  source: McpConfigSourceKind | 'explicit';
  lastKnownCapabilityNames: readonly string[];
  diagnosticCode?: McpDiagnosticCode;
  retryable: boolean;
}

export interface McpProviderDirectorySnapshot {
  revision: string;
  entries: readonly Readonly<McpProviderDirectoryEntry>[];
}

export interface McpResourceDirectoryEntry {
  providerId: string;
  uri: string;
  name: string;
  mimeType?: string;
}

export interface McpResourceDirectorySnapshot {
  revision: string;
  resources: readonly Readonly<McpResourceDirectoryEntry>[];
}

export interface McpCapabilityInvocation {
  capabilityId: string;
  expectedRevision: string;
  arguments: Record<string, unknown>;
  remoteEgress?: RemoteMcpEgressInvocationPolicyV1;
  transportBoundary?: McpTransportInvocationBindingV1;
  /** Durable release-owned facts required before any production MCP write dispatch. */
  writeGovernance?: Readonly<{
    userApprovalReceiptDigest: string;
    providerDataPolicyRevision: string;
    providerDataPolicyReceiptDigest: string;
  }>;
  signal?: AbortSignal;
}

/** Runtime-facing MCP contract. It intentionally excludes control-plane mutation and UI state. */
export interface McpRuntimeProvider {
  getCapabilitySnapshot(): CapabilitySnapshot;
  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
  getResourceDirectorySnapshot(): McpResourceDirectorySnapshot;
  findCapability(capabilityId: string): CapabilityDescriptor | undefined;
  /** Redacted transport identity used by the independent remote-content gate. */
  getCapabilityRoute?(capabilityId: string): McpCapabilityRouteV1 | undefined;
  /** Wait for an already-configured remote provider to become executable. */
  ensureProviderReady?(providerId: string, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  callCapability(invocation: McpCapabilityInvocation): Promise<CallToolResult>;
  readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    transportBoundary?: McpTransportInvocationBindingV1,
  ): Promise<string>;
}
