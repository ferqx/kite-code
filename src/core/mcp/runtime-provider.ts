import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';

/** Runtime-facing MCP contract. It intentionally excludes control-plane mutation and UI state. */
export interface McpRuntimeProvider {
  getCapabilitySnapshot(): CapabilitySnapshot;
  findCapability(capabilityId: string): CapabilityDescriptor | undefined;
  callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  readResource(serverName: string, uri: string): Promise<string>;
}
