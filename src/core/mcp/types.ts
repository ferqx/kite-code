// src/core/mcp/types.ts
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";

/** MCP transport type */
export type McpTransportType = "stdio" | "http";

/** MCP Server configuration */
export interface McpServerConfig {
  type: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  risk?: "read";
}

/** MCP Prompt */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** MCP Resource */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP Resource Content */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** MCP Server runtime state */
export interface McpServerState {
  config: McpServerConfig;
  client: unknown; // Client from SDK
  tools: SdkTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
  connected: boolean;
  error?: string;
}
