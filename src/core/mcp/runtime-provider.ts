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

/** Runtime-facing MCP contract. It intentionally excludes control-plane mutation and UI state. */
export interface McpRuntimeProvider {
  getCapabilitySnapshot(): CapabilitySnapshot;
  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
  findCapability(capabilityId: string): CapabilityDescriptor | undefined;
  callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  readResource(serverName: string, uri: string): Promise<string>;
}
