// src/core/mcp/index.ts
export { McpManager } from "./manager";
export type { PromptEntry } from "./manager";
export { adaptMcpTool, jsonSchemaToZod } from "./tool-adapter";
export type { JsonSchemaDef } from "./tool-adapter";
export type { McpServerConfig, McpServerState, McpPrompt } from "./types";
