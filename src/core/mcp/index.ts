// src/core/mcp/index.ts

export type {
  McpApprovalControlState,
  McpAuthStatus,
  McpConfigStatus,
  McpControlSnapshot,
  McpServerControlState,
  McpServerKey,
  McpToolControlState,
} from './control-types';
export type { McpDiagnostic, McpDiagnosticCode } from './diagnostics';
export { diagnoseMcpError, redactDiagnosticMessage } from './diagnostics';
export type { McpManagerOptions, PromptEntry } from './manager';
export { McpManager } from './manager';
export { normalizeMcpToolResult } from './result-normalizer';
export type { McpRuntimeProvider } from './runtime-provider';
export {
  DefaultMcpSupervisor,
  type McpManagerControlPlane,
  type McpSupervisor,
  type McpSupervisorOptions,
} from './supervisor';
export { parseMcpToolName } from './tool-adapter';
export type {
  McpHealthState,
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerState,
} from './types';
