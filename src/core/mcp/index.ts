// src/core/mcp/index.ts

export type {
  CallbackServerFactory,
  DefaultMcpAuthCoordinatorOptions,
  McpAuthCoordinator,
  McpAuthResult,
  McpAuthSnapshot,
  McpAuthStatus as McpOAuthStatus,
  McpAuthTarget,
} from './auth-coordinator';
export { DefaultMcpAuthCoordinator } from './auth-coordinator';
export type { BrowserOpener } from './browser-opener';
export { NativeBrowserOpener } from './browser-opener';
export type {
  McpApprovalControlState,
  McpAuthStatus,
  McpConfigStatus,
  McpControlSnapshot,
  McpServerControlState,
  McpServerKey,
  McpToolControlState,
} from './control-types';
export type {
  McpBearerCredentialMaterial,
  McpCredentialKey,
  McpCredentialMaterial,
  McpCredentialStore,
  McpCredentialStoreStatus,
  McpOAuthCredentialMaterial,
  NativeMcpCredentialStoreOptions,
} from './credential-store';
export {
  credentialAccount,
  McpCredentialStoreError,
  MemoryMcpCredentialStore,
  NativeMcpCredentialStore,
} from './credential-store';
export type { McpDiagnostic, McpDiagnosticCode } from './diagnostics';
export { diagnoseMcpError, redactDiagnosticMessage } from './diagnostics';
export type { McpManagerOptions, PromptEntry } from './manager';
export { McpManager } from './manager';
export type { KiteMcpOAuthProviderOptions } from './oauth-provider';
export { KiteMcpOAuthProvider } from './oauth-provider';
export { revokeMcpOAuthToken } from './oauth-revocation';
export type { McpProviderFailureKind, McpProviderRecoveryAction } from './provider-errors';
export {
  capabilityChangedProviderError,
  isMcpProviderError,
  McpProviderError,
  providerErrorFromDiagnostic,
  providerErrorFromDirectoryEntry,
} from './provider-errors';
export { normalizeMcpToolResult } from './result-normalizer';
export type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpProviderDirectoryStatus,
  McpResourceDirectoryEntry,
  McpResourceDirectorySnapshot,
  McpRuntimeProvider,
} from './runtime-provider';
export {
  DefaultMcpSupervisor,
  type McpManagerControlPlane,
  type McpSupervisor,
  type McpSupervisorOptions,
} from './supervisor';
export { exposedMcpToolName, parseMcpToolName } from './tool-adapter';
export {
  configuredMcpToolNames,
  hasConfiguredMcpToolPolicy,
  isMcpToolEnabled,
  type ResolvedMcpToolPolicy,
  resolveMcpToolPolicy,
} from './tool-policy';
export type {
  McpAuthConfig,
  McpHealthState,
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerState,
  McpToolPolicyConfig,
  McpToolRetryPolicy,
} from './types';
