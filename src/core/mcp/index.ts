// src/core/mcp/index.ts

export type { PromptEntry } from './manager';
export { McpManager } from './manager';
export type { JsonSchemaDef } from './tool-adapter';
export { adaptMcpTool, jsonSchemaToZod } from './tool-adapter';
export type {
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerState,
} from './types';
