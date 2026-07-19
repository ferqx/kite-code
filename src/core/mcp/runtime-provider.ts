import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigSourceKind } from '@/core/config/mcp-config';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';
import type { McpDiagnosticCode } from './diagnostics';

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
  signal?: AbortSignal;
}

/** Runtime-facing MCP contract. It intentionally excludes control-plane mutation and UI state. */
export interface McpRuntimeProvider {
  getCapabilitySnapshot(): CapabilitySnapshot;
  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
  getResourceDirectorySnapshot(): McpResourceDirectorySnapshot;
  findCapability(capabilityId: string): CapabilityDescriptor | undefined;
  /** Wait for an already-configured remote provider to become executable. */
  ensureProviderReady?(providerId: string, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  callCapability(invocation: McpCapabilityInvocation): Promise<CallToolResult>;
  readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<string>;
}
