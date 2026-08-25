// Builtin Runtime MCP public surface.

export type {
  McpStdioCleanupProof,
  McpStdioProcessHandle,
  McpStdioProcessLaunch,
  McpStdioProcessPort,
  McpStdioReadyProof,
  McpStdioTerminalProof,
} from '@kite-ai/runtime-spi';
export type { CompiledCapabilitySchema, JsonSchema } from '../skills/capability-domain';
export {
  canonicalizeCapabilityArguments,
  compileCapabilitySchema,
  validateCapabilityArguments,
} from '../skills/capability-domain';
export type {
  McpArgumentInspection,
  McpArgumentSnapshot,
  McpCapabilityRoute,
} from './argument-inspection';
export {
  inspectMcpArguments,
  mcpArgumentDigest,
  snapshotMcpArguments,
} from './argument-inspection';
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
export { safeCapabilityMetadata } from './capability-domain';
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
  BuiltinCredentialBroker,
  BuiltinCredentialBrokerOptions,
} from './credential-broker';
export { createBuiltinCredentialBroker } from './credential-broker';
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
export type {
  McpInventoryFailure,
  McpInventoryNextAction,
  McpInventoryProviderSummary,
  McpInventoryQuery,
  McpInventoryResult,
  McpInventorySuccess,
  McpInventoryToolSummary,
} from './inventory';
export { buildMcpInventory } from './inventory';
export type { McpConnectionManagerOptions, PromptEntry } from './manager';
export { McpConnectionManager, modelVisibleMcpDescription } from './manager';
export type { KiteMcpOAuthProviderOptions } from './oauth-provider';
export { KiteMcpOAuthProvider } from './oauth-provider';
export { revokeMcpOAuthToken } from './oauth-revocation';
export type {
  McpProviderFailureKind,
  McpProviderFailurePolicyFacts,
  McpProviderRecoveryAction,
} from './provider-errors';
export {
  capabilityChangedProviderError,
  isMcpProviderError,
  McpProviderError,
  mcpProviderFailurePolicyFacts,
  providerErrorFromDiagnostic,
  providerErrorFromDirectoryEntry,
} from './provider-errors';
export {
  isMcpProviderCallable,
  isMcpProviderHealthy,
  isMcpProviderUnavailable,
  mcpProviderInventoryNextAction,
  mcpProviderSearchNextAction,
} from './provider-status';
export { normalizeMcpToolResult } from './result-normalizer';
export type {
  McpCapabilityInvocation,
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpProviderDirectoryStatus,
  McpResourceDirectoryEntry,
  McpResourceDirectorySnapshot,
  McpRuntimeProvider,
} from './runtime-provider';
export { createMcpStdioTransport } from './stdio-transport';
export {
  DefaultMcpSupervisor,
  type McpConnectionManagerControlPlane,
  type McpSupervisor,
  type McpSupervisorOptions,
} from './supervisor';
export { exposedMcpToolName } from './tool-adapter';
export type {
  BuiltinDynamicMcpSubjectFacts,
  BuiltinDynamicMcpSubjectFactsIdentity,
  BuiltinDynamicMcpToolPipelineCallbacks,
} from './tool-pipeline-callbacks';
export {
  BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_,
  createBuiltinDynamicMcpSubjectFacts,
  createBuiltinDynamicMcpToolPipelineCallbacks,
} from './tool-pipeline-callbacks';
export {
  configuredMcpToolNames,
  hasConfiguredMcpToolPolicy,
  isMcpToolEnabled,
  type ResolvedMcpToolPolicy,
  resolveMcpToolPolicy,
} from './tool-policy';
export type {
  McpTransportAdmissionReceipt,
  McpTransportAdmissionRequest,
  McpTransportBoundaryController,
  McpTransportBoundaryFailureCode,
  McpTransportBoundaryIdentity,
  McpTransportInvocationBinding,
  McpTransportOperation,
} from './transport-boundary';
export {
  assertMcpTransportAdmissionReceipt,
  canonicalMcpHttpEndpointIdentity,
  createMcpTransportAdmissionReceipt,
  createMcpTransportBoundaryIdentity,
  McpTransportBoundaryError,
} from './transport-boundary';
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
export type {
  McpWriteAdmissionDecision,
  McpWriteDispatchAdmission,
  McpWriteDispatchGuard,
  McpWriteDispatchRequest,
  McpWriteIntent,
  McpWriteInvocationFacts,
  McpWriteReceipt,
  McpWriteRouteContract,
  McpWriteRouteRegistry,
} from './write-governance';
export {
  classifyMcpWriteRecovery,
  contractDigest,
  evaluateMcpWriteAdmission,
  McpWriteGovernanceError,
  parseMcpWriteRouteRegistry,
  qualifyMcpWriteRoute,
  routeContractDigest,
  validateMcpWriteRouteContract,
} from './write-governance';
