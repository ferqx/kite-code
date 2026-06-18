// src/core/mcp/types.ts
import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';

/** MCP transport type */
export type McpTransportType = 'stdio' | 'http';

/** MCP Server configuration */
export interface McpServerConfig {
  type: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  risk?: 'read';
  /** 单次工具调用/资源读取超时（毫秒），覆盖默认值 / Per-operation timeout in ms, overrides defaults */
  timeout?: number;
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
