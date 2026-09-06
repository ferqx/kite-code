import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite-ai/runtime-contract';
import type { RuntimeModule } from '@kite-ai/runtime-spi';
import { createGitRuntimeModule } from './git/runtime-module';
import { createModelRuntimeModule } from './model/runtime-module';
import { createPlanningRuntimeModule } from './planning/runtime-module';
import { createSubagentRuntimeModule } from './subagent/runtime-module';
import { createToolSearchRuntimeModule } from './tool-search';
import { createVerificationRuntimeModule } from './verification/runtime-module';

export type { WorkspaceFilesystemGrantVerifier } from '@kite-ai/runtime-spi';
export type {
  BuiltinPreparedTaskDispatchAdapter,
  BuiltinPreparedToolDispatchAdapter,
  BuiltinPreparedToolDispatchFailureCode,
  BuiltinPreparedToolDispatchInput,
  BuiltinPreparedToolDispatchPort,
  CreateBuiltinPreparedTaskDispatchAdapterInput,
  CreateBuiltinPreparedToolDispatchAdapterInput,
} from './builtin-prepared-dispatch-adapter';
export {
  BuiltinPreparedToolDispatchError,
  createBuiltinPreparedTaskDispatchAdapter,
  createBuiltinPreparedToolDispatchAdapter,
  projectBuiltinDynamicMcpExecutionReceiptTerminalResult,
  projectBuiltinExecutionReceiptTerminalResult,
  projectBuiltinOperationTerminalResult,
} from './builtin-prepared-dispatch-adapter';
export {
  assertRestoredCapabilityArtifactEvidence,
  type CapabilityArtifactAccess,
  type CapabilityArtifactBinding,
  type CapabilityArtifactEnvelope,
  CapabilityArtifactError,
  type CapabilityArtifactErrorCode,
  type CapabilityArtifactReader,
  CapabilityArtifactStore,
  type CapabilityArtifactStoreOptions,
  type CapabilityArtifactWriter,
  capabilityArtifactRoot,
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  readBoundCapabilityArtifact,
} from './capability-artifacts';
export type { CreateCapabilityBindingInput } from './capability-binding';
export {
  createCapabilityBinding,
  digestCapabilityBindingValue,
} from './capability-binding';
export type {
  BuiltinCapabilitySearchCandidate,
  BuiltinCapabilitySearchProviderDiagnostic,
  CapabilityDisclosureDecision,
  CapabilityDisclosureMode,
  SearchableCapabilityDescriptor,
  SearchableProviderEntry,
} from './capability-disclosure';
export {
  chooseCapabilityDisclosure,
  estimateCapabilityCatalogTokens,
  modelVisibleCapabilitySchema,
  projectCapabilitySearchCandidates,
  projectUnavailableProviderSearch,
  searchableCapabilitySnapshot,
  searchCapabilitySnapshot,
  searchUnavailableProviders,
} from './capability-disclosure';
export type {
  BuiltinExecutionTraitsInput,
  BuiltinToolContractOptions,
  BuiltinToolSchemaHintEntry,
  BuiltinToolTurnContext,
  CreateBuiltinZodParserOptions,
} from './catalog-contract';
export {
  activateSkillAvailability,
  alwaysAvailable,
  builtinExecutionTraits,
  createBuiltinZodParser,
  defineBuiltinCapabilityContract,
  formatBuiltinToolParseError,
  formatBuiltinToolSchemaHint,
  isDestructiveShellCommand,
  isNetworkShellCommand,
  isReadOnlyShellCommand,
  isVcsMutationShellCommand,
  isWriteShellCommand,
  parserForBuiltinOperation,
  projectBuiltinExecutionTraits,
  readSkillAvailability,
  type ShellReadOnlyUncertaintyCode,
  shellEffectsClassifier,
  shellReadOnlyUncertaintyCode,
  staticEffectsClassifier,
  taskAvailability,
  taskEffectsClassifier,
  taskModelInputSchema,
  taskModelParser,
  taskModelSchema,
  taskRuntimeParser,
  toolSearchAvailability,
} from './catalog-contract';
export {
  assertDescriptorRelativeMutationSupported,
  atomicReplaceInLockedWindowsDirectory,
  closeOpenedDirectoryChain,
  type DescriptorRelativeDirectoryChain,
  openExclusiveFileAt,
  openOrCreateDirectoryChainAt,
  renameAt,
  unlinkAt,
} from './filesystem/descriptor-relative';
export {
  computeLineDiff,
  type DiffLine,
  type DiffResult,
  formatContentOutput,
  formatDiffOutput,
  formatMultiHunkDiff,
} from './filesystem/diff';
export {
  validateWorkspaceFilesystemIntentRecord,
  validateWorkspaceFilesystemMutationReadyRecord,
  validateWorkspaceFilesystemObservationRecord,
  workspaceFilesystemIntentDigest,
  workspaceFilesystemMutationReadyDigest,
} from './filesystem/evidence';
export {
  validateWorkspaceFilesystemOperation,
  WorkspaceFilesystemGrantAuthority,
  type WorkspaceFilesystemGrantAuthorityOptions,
  WorkspaceFilesystemGrantError,
  workspaceFilesystemContentHash,
  workspaceFilesystemOperationDigest,
  workspaceFilesystemProtectedBoundaryDigest,
  workspaceFilesystemStringDigest,
  workspaceFilesystemTargetEvidence,
  workspaceFilesystemTargetIdentityDigest,
} from './filesystem/grant-authority';
export {
  LocalWorkspaceFilesystemProvider,
  type LocalWorkspaceFilesystemProviderOptions,
} from './filesystem/local-provider';
export type {
  BuiltinWorkspaceFilesystemMutationDispatchErrorCode,
  BuiltinWorkspaceFilesystemRewindProjection,
  CreateBuiltinWorkspaceFilesystemMutationDispatcherInput,
} from './filesystem/mutation-dispatcher';
export {
  BuiltinWorkspaceFilesystemMutationCommitUnknownError,
  BuiltinWorkspaceFilesystemMutationDispatchError,
  createBuiltinWorkspaceFilesystemMutationDispatcher,
} from './filesystem/mutation-dispatcher';
export type {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorCode,
  BuiltinWorkspaceFilesystemTerminalVerificationResult,
  BuiltinWorkspaceFilesystemTerminalVerifier,
} from './filesystem/observation-authority';
export {
  BuiltinWorkspaceFilesystemObservationAuthorityError,
  verifyBuiltinWorkspaceFilesystemTerminal,
} from './filesystem/observation-authority';
export {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedOutput,
  truncateProjectedStreams,
} from './filesystem/projection';
export type {
  BuiltinWorkspaceFilesystemActorIdentity,
  BuiltinWorkspaceFilesystemReadDispatchErrorCode,
  CreateBuiltinWorkspaceFilesystemReadDispatcherInput,
} from './filesystem/read-dispatcher';
export {
  BuiltinWorkspaceFilesystemReadDispatchError,
  createBuiltinWorkspaceFilesystemReadDispatcher,
} from './filesystem/read-dispatcher';
export {
  type BuiltinProtectedPathEvaluator,
  createGitBroker,
  type GitBroker,
  type GitProcessAdapter,
  type GitProcessRequest,
  type GitProcessResult,
  isGitRevision,
} from './git/broker';
export {
  type BrokeredGitQualificationDecision,
  qualifyBrokeredGitNativeDeny,
} from './git/qualification';
export type {
  BuiltinFilesystemExecutionMechanism,
  BuiltinFilesystemPipelineResult,
  BuiltinGitExecutionMechanism,
  GitExecutionMechanisms,
  GitOperationId,
} from './git/runtime-module';
export {
  createGitRuntimeModule,
  EDIT_FILE_INPUT_SCHEMA_,
  GIT_CAPABILITY_REVISIONS_,
  GIT_EXECUTOR_REVISIONS_,
  GIT_INSPECT_INPUT_SCHEMA_,
  GIT_OPERATION_IDS_,
  GIT_PROVIDER_ID_,
  MAX_MODEL_READ_FILE_CHARS_,
  READ_FILE_INPUT_SCHEMA_,
  SEARCH_CONTENT_INPUT_SCHEMA_,
  SEARCH_FILES_INPUT_SCHEMA_,
  WRITE_FILE_INPUT_SCHEMA_,
} from './git/runtime-module';
export type {
  BuiltinMechanismRecord,
  MergeBuiltinMechanismBundleInput,
} from './mechanism-authority';
export {
  BuiltinMechanismAuthorityError,
  mergeBuiltinMechanismBundle,
} from './mechanism-authority';
export type {
  BuiltinMcpExecutionMechanism,
  BuiltinMcpRuntimePort,
  BuiltinOperationExecutionValue,
  BuiltinRuntimeEventValue,
  BuiltinSkillExecutionMechanism,
  BuiltinWebExecutionMechanism,
  ModelExecutionMechanisms,
  ModelOperationId,
} from './model/runtime-module';
export {
  ACTIVATE_SKILL_INPUT_SCHEMA_,
  BuiltinMcpExecutionUnknownError,
  COMPLETE_SKILL_INPUT_SCHEMA_,
  createModelRuntimeModule,
  DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_,
  isBuiltinOperationExecutionValue,
  LIST_MCP_RESOURCES_INPUT_SCHEMA_,
  LIST_MCP_TOOLS_INPUT_SCHEMA_,
  MODEL_CAPABILITY_REVISIONS_,
  MODEL_EXECUTOR_REVISIONS_,
  MODEL_OPERATION_IDS_,
  MODEL_PROVIDER_ID_,
  READ_MCP_RESOURCE_INPUT_SCHEMA_,
  READ_SKILL_REFERENCE_INPUT_SCHEMA_,
  WEB_FETCH_INPUT_SCHEMA_,
} from './model/runtime-module';
export {
  BUILTIN_CONTEXT_COMPILER_ID_,
  BUILTIN_CONTEXT_COMPILER_REVISION_,
  BUILTIN_CONTEXT_SOURCE_IDS_,
  createBuiltinContextCompilerPort,
} from './model-context';
export type { BuiltinObservabilityProjector } from './observability';
export {
  createBuiltinObservabilityProjector,
  LowCardinalityAliasMapper,
} from './observability';
export type {
  BuiltinShellExecutionMechanism,
  BuiltinShellExecutionResult,
  BuiltinShellIntent,
  PlanningExecutionMechanisms,
} from './planning/runtime-module';
export {
  BuiltinShellExecutionUnknownError,
  classifyBuiltinShellIntent,
  createPlanningRuntimeModule,
  DEFAULT_SHELL_TIMEOUT_MS_,
  PLANNING_CAPABILITY_REVISION_,
  PLANNING_EXECUTOR_REVISION_,
  PLANNING_OPERATION_ID_,
  PLANNING_PROVIDER_ID_,
  projectBuiltinShellIntent,
  SHELL_EXECUTE_INPUT_SCHEMA_,
} from './planning/runtime-module';
export type {
  BuiltinDynamicMcpPolicyInput,
  BuiltinPolicyRuleResult,
  CreateBuiltinPolicyCompilerInput,
} from './policy-compiler';
export {
  activateSkillBuiltinPolicyRule,
  askUserBuiltinPolicyRule,
  BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
  capabilityRiskFromEffects,
  compileBuiltinDynamicMcpPolicy,
  createBuiltinPolicyCompiler,
  fileBuiltinPolicyRule,
  planBuiltinPolicyRule,
  readOnlyBuiltinPolicyRule,
  shellBuiltinPolicyRule,
  taskBuiltinPolicyRule,
  webFetchBuiltinPolicyRule,
} from './policy-compiler';
export type { BuiltinRuntimeToolPipelineCallbacks } from './runtime-tool-pipeline-callbacks';
export { createBuiltinRuntimeToolPipelineCallbacks } from './runtime-tool-pipeline-callbacks';
export {
  isDeclaredGitMutation,
  isDeclaredGitRemoteMutation,
  isDeclaredReadOnlyGitBranch,
  isDeclaredReadOnlyGitRemote,
  SHELL_SEMANTICS_REGISTRY_,
  SHELL_SEMANTICS_REGISTRY_SCHEMA_,
  SHELL_SEMANTICS_REVISION_,
  type ShellGitSemanticDescriptor,
  type ShellProgramSemanticDescriptor,
  type ShellSemanticInspector,
  type ShellSemanticsRegistry,
  shellSemanticInspector,
} from './shell-semantics';
export type {
  BuiltinInternalOperationCatalogEntry,
  BuiltinModelToolCatalogEntry,
  BuiltinModelToolSet,
  BuiltinToolAvailability,
  BuiltinToolCapabilityProjection,
  BuiltinToolCatalogEntry,
  BuiltinToolCatalogProjection,
  BuiltinToolEffectClass,
  BuiltinUnknownToolFieldsProjection,
  CreateBuiltinToolCatalogProjectionOptions,
} from './tool-catalog';
export {
  createBuiltinModelToolSet,
  createBuiltinToolCatalogProjection,
  failClosedBuiltinToolCapability,
  projectBuiltinUnknownToolFieldsObservation,
} from './tool-catalog';
export type {
  KnownToolName,
  ToolContract,
  ToolContractSection,
  ToolDescriptionStyle,
} from './tool-contracts';
export {
  ASK_USER_CONTRACT,
  BUILTIN_TOOL_CONTRACTS,
  buildDescription,
  builtinToolDescription,
  EDIT_FILE_CONTRACT,
  getToolContract,
  KNOWN_TOOL_NAMES,
  LIST_MCP_RESOURCES_CONTRACT,
  LIST_MCP_TOOLS_CONTRACT,
  READ_FILE_CONTRACT,
  READ_MCP_RESOURCE_CONTRACT,
  READ_PLAN_CONTRACT,
  SEARCH_CONTENT_CONTRACT,
  SEARCH_FILES_CONTRACT,
  SHELL_EXECUTE_CONTRACT,
  TASK_CONTRACT,
  TOOL_CONTRACTS,
  TOOL_SEARCH_CONTRACT,
  toolContractSection,
  UPDATE_PLAN_CONTRACT,
  WEB_FETCH_CONTRACT,
  WRITE_FILE_CONTRACT,
  WRITE_PLAN_CONTRACT,
} from './tool-contracts';
export type { BuiltinToolPipelineCallbacks } from './tool-pipeline-callbacks';
export {
  BUILTIN_PREPARED_CALL_FACTS_SCHEMA_,
  createBuiltinToolPipelineCallbacks,
} from './tool-pipeline-callbacks';
export type {
  BuiltinToolAvailabilityContext,
  BuiltinValidatedInvocationProjection,
  InvalidToolRequest,
  PendingBuiltinToolRequest,
  PendingMcpToolRequest,
  PendingToolRequest,
  ToolRequestParseFailureCode,
  ToolRequestParseResult,
} from './tool-request';
export {
  isMcpRequest,
  pendingToolRequestFromValidatedInvocation,
  toolRequestFromCall,
} from './tool-request';
export type { BuiltinToolResultDigestProjection } from './tool-result-projection';
export {
  projectBuiltinToolResultDigests,
  toolExecutionModelContent,
} from './tool-result-projection';
export type { BuiltinJsonSchemaOptions } from './tool-schemas';
export {
  BUILTIN_ACTIVATE_SKILL_SCHEMA_,
  BUILTIN_ASK_USER_SCHEMA_,
  BUILTIN_COMPLETE_SKILL_SCHEMA_,
  BUILTIN_DYNAMIC_MCP_SCHEMA_,
  BUILTIN_EDIT_FILE_SCHEMA_,
  BUILTIN_GIT_INSPECT_SCHEMA_,
  BUILTIN_JSON_SCHEMAS_,
  BUILTIN_LIST_MCP_RESOURCES_SCHEMA_,
  BUILTIN_LIST_MCP_TOOLS_SCHEMA_,
  BUILTIN_READ_FILE_SCHEMA_,
  BUILTIN_READ_MCP_RESOURCE_SCHEMA_,
  BUILTIN_READ_PLAN_SCHEMA_,
  BUILTIN_READ_SKILL_REFERENCE_SCHEMA_,
  BUILTIN_SEARCH_CONTENT_SCHEMA_,
  BUILTIN_SEARCH_FILES_SCHEMA_,
  BUILTIN_SHELL_EXECUTE_SCHEMA_,
  BUILTIN_TASK_PRIVATE_SCHEMA_,
  BUILTIN_TASK_PUBLIC_SCHEMA_,
  BUILTIN_TASK_RUNTIME_SCHEMA_,
  BUILTIN_TOOL_SEARCH_SCHEMA_,
  BUILTIN_UPDATE_PLAN_SCHEMA_,
  BUILTIN_WEB_FETCH_SCHEMA_,
  BUILTIN_WRITE_FILE_SCHEMA_,
  BUILTIN_WRITE_PLAN_SCHEMA_,
  BUILTIN_ZOD_SCHEMAS_,
  builtinJsonSchema,
} from './tool-schemas';
export type {
  ToolSearchCandidate,
  ToolSearchDescriptorInput,
  ToolSearchExecutionValue,
  ToolSearchProviderDiagnostic,
  ToolSearchProviderEntryInput,
  ToolSearchProviderFacts,
  ToolSearchResult,
} from './tool-search';
export {
  createToolSearchProviderFacts,
  createToolSearchRuntimeModule,
  isToolSearchExecutionValue,
  TOOL_SEARCH_CAPABILITY_ID_,
  TOOL_SEARCH_CAPABILITY_REVISION_,
  TOOL_SEARCH_EXECUTOR_REVISION_,
  TOOL_SEARCH_INPUT_SCHEMA_,
  TOOL_SEARCH_PROVIDER_ID_,
} from './tool-search';
export type {
  BuiltinCapabilityTurnContext,
  BuiltinCapabilityTurnContextInput,
} from './turn-context';
export { createBuiltinCapabilityTurnContext } from './turn-context';
export const BUILTIN_RUNTIME_DOMAINS_ = Object.freeze([
  'model',
  'context',
  'skills',
  'filesystem',
  'mcp',
  'sandbox',
  'verification',
  'subagent',
  'observability',
] as const);

/** The exact concrete Builtin owner set grows only at each vertical operation cutover. */
export function createBuiltinRuntimeModules(): readonly RuntimeModule[] {
  if (RUNTIME_CONTRACT_BOUNDARY_.revision !== 'runtime-contract-current') {
    throw new Error('builtin runtime contract revision mismatch');
  }
  return Object.freeze([
    createToolSearchRuntimeModule(),
    createModelRuntimeModule(),
    createGitRuntimeModule(),
    createPlanningRuntimeModule(),
    createSubagentRuntimeModule(),
    createVerificationRuntimeModule(),
  ]);
}
