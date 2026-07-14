// src/core/mcp/index.ts

export type { PromptEntry } from './manager';
export { McpManager } from './manager';
export { normalizeMcpToolResult } from './result-normalizer';
export { parseMcpToolName } from './tool-adapter';
export type {
  McpHealthState,
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerState,
} from './types';
