/** Explicit host-only configuration/credential leaf. Import does not discover or open files. */

export {
  type CredentialBackend,
  type CredentialReference,
  createCredentialVault,
  createTemporaryCredentialBackend,
} from './credentials';
export { createConfigurationSnapshot, resolveConfiguration } from './effective';
export {
  type ConfigurationDocument,
  type ConfigurationEdit,
  type ConfigurationFileOptions,
  inspectConfigurationFile,
  readConfigurationFile,
  repairConfigurationFile,
  updateConfigurationFile,
} from './files';
export {
  type McpRegistry,
  type McpSelectionReadSet,
  mcpCanonical,
  readMcpSelection,
  updateMcpSelection,
} from './mcp-selection';
export {
  deriveMcpSourceReadSet,
  type McpPrivateSourceEntry,
  type McpSourceApproval,
  type McpSourceBinding,
  type McpSourceCredentialBinding,
  type McpSourceDecisionProof,
  type McpSourceDocument,
  type McpSourceEntryDeclaration,
  type McpSourceEntryMutation,
  type McpSourceEntryPreview,
  type McpSourceEntryReceipt,
  type McpSourceIdentity,
  type McpSourceOptions,
  type McpSourceReadSet,
  type McpSourceScope,
  type McpSourceServer,
  readMcpSourceEntryPreview,
  readMcpSources,
  writeMcpSourceEntry,
  writeMcpSourceMetadata,
} from './mcp-sources';
export {
  createOsCredentialBackend,
  type NativeCredentialEntry,
  type NativeCredentialFactory,
} from './os-credentials';
export {
  ConfigurationError,
  type ConfigurationSnapshot,
  type EffectiveConfiguration,
  type JsonObject,
  type ModelConfiguration,
  type NamedConfiguration,
} from './types';
