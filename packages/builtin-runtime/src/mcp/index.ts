// Builtin Runtime MCP public surface.

export type {
  McpStdioCleanupProofV1,
  McpStdioProcessHandleV1,
  McpStdioProcessLaunchV1,
  McpStdioProcessPortV1,
  McpStdioReadyProofV1,
  McpStdioTerminalProofV1,
} from '@kite/runtime-spi';
export type {
  McpArgumentInspectionV1,
  McpArgumentSnapshotV1,
  McpCapabilityRouteV1,
} from './argument-inspection';
export {
  inspectMcpArgumentsV1,
  mcpArgumentDigestV1,
  snapshotMcpArgumentsV1,
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
export type { CompiledCapabilitySchema, JsonSchema } from './capability-domain';
export {
  canonicalizeCapabilityArguments,
  compileCapabilitySchema,
  safeCapabilityMetadata,
  validateCapabilityArguments,
} from './capability-domain';
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
  BuiltinCredentialBrokerOptionsV1,
  BuiltinCredentialBrokerV1,
} from './credential-broker';
export { createBuiltinCredentialBrokerV1 } from './credential-broker';
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
  McpProviderFailurePolicyFactsV1,
  McpProviderRecoveryAction,
} from './provider-errors';
export {
  capabilityChangedProviderError,
  isMcpProviderError,
  McpProviderError,
  mcpProviderFailurePolicyFactsV1,
  providerErrorFromDiagnostic,
  providerErrorFromDirectoryEntry,
} from './provider-errors';
export {
  isMcpProviderCallableV1,
  isMcpProviderHealthyV1,
  isMcpProviderUnavailableV1,
  mcpProviderInventoryNextActionV1,
  mcpProviderSearchNextActionV1,
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
export { createMcpStdioTransportV1 } from './stdio-transport';
export {
  DefaultMcpSupervisor,
  type McpConnectionManagerControlPlane,
  type McpSupervisor,
  type McpSupervisorOptions,
} from './supervisor';
export { exposedMcpToolName } from './tool-adapter';
export type {
  BuiltinDynamicMcpSubjectFactsIdentityV1,
  BuiltinDynamicMcpSubjectFactsV1,
  BuiltinDynamicMcpToolPipelineCallbacksV1,
} from './tool-pipeline-callbacks';
export {
  BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1,
  createBuiltinDynamicMcpSubjectFactsV1,
  createBuiltinDynamicMcpToolPipelineCallbacksV1,
} from './tool-pipeline-callbacks';
export {
  configuredMcpToolNames,
  hasConfiguredMcpToolPolicy,
  isMcpToolEnabled,
  type ResolvedMcpToolPolicy,
  resolveMcpToolPolicy,
} from './tool-policy';
export type {
  McpTransportAdmissionReceiptV1,
  McpTransportAdmissionRequestV1,
  McpTransportBoundaryControllerV1,
  McpTransportBoundaryFailureCodeV1,
  McpTransportBoundaryIdentityV1,
  McpTransportInvocationBindingV1,
  McpTransportOperationV1,
} from './transport-boundary';
export {
  assertMcpTransportAdmissionReceiptV1,
  canonicalMcpHttpEndpointIdentityV1,
  createMcpTransportAdmissionReceiptV1,
  createMcpTransportBoundaryIdentityV1,
  McpTransportBoundaryErrorV1,
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
  McpWriteAdmissionDecisionV1,
  McpWriteDispatchAdmissionV1,
  McpWriteDispatchGuardV1,
  McpWriteDispatchRequestV1,
  McpWriteIntentV1,
  McpWriteInvocationFactsV1,
  McpWriteReceiptV1,
  McpWriteRouteContractV1,
  McpWriteRouteRegistryV1,
} from './write-governance';
export {
  classifyMcpWriteRecoveryV1,
  contractDigestV1,
  evaluateMcpWriteAdmissionV1,
  McpWriteGovernanceErrorV1,
  parseMcpWriteRouteRegistryV1,
  qualifyMcpWriteRouteV1,
  routeContractDigestV1,
  validateMcpWriteRouteContractV1,
} from './write-governance';
