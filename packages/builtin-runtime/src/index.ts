import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite/runtime-contract';
import type { RuntimeModule } from '@kite/runtime-spi';
import { createGitRuntimeModule } from './git-operations';
import { createModelRuntimeModule } from './model-operations';
import { createPlanningRuntimeModule } from './planning-operations';
import { createSubagentRuntimeModule } from './subagent-operations';
import { createToolSearchRuntimeModule } from './tool-search';
import { createVerificationRuntimeModule } from './verification-operations';

export type { WorkspaceFilesystemGrantVerifier } from '@kite/runtime-spi';
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
  gitAvailability,
  hasBrokeredGitExecutableToken,
  isDestructiveShellCommand,
  isNetworkShellCommand,
  isReadOnlyShellCommand,
  isVcsMutationShellCommand,
  isWriteShellCommand,
  parserForBuiltinOperation,
  projectBuiltinExecutionTraits,
  readSkillAvailability,
  shellEffectsClassifier,
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
  BuiltinWorkspaceFilesystemCheckpointProjection,
  BuiltinWorkspaceFilesystemMutationDispatchErrorCode,
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
} from './git-operations';
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
} from './git-operations';
export type {
  BuiltinMechanismRecord,
  MergeBuiltinMechanismBundleInput,
} from './mechanism-authority';
export {
  BuiltinMechanismAuthorityError,
  mergeBuiltinMechanismBundle,
} from './mechanism-authority';
export {
  BUILTIN_CONTEXT_COMPILER_ID_,
  BUILTIN_CONTEXT_COMPILER_REVISION_,
  BUILTIN_CONTEXT_SOURCE_IDS_,
  createBuiltinContextCompilerPort,
} from './model-context';
export type {
  BuiltinMcpExecutionMechanism,
  BuiltinMcpRuntimePort,
  BuiltinOperationExecutionValue,
  BuiltinRuntimeEventValue,
  BuiltinSkillExecutionMechanism,
  BuiltinWebExecutionMechanism,
  ModelExecutionMechanisms,
  ModelOperationId,
} from './model-operations';
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
} from './model-operations';
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
} from './planning-operations';
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
} from './planning-operations';
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
export type {
  SkillActivationEvaluation,
  SkillActivationRequest,
} from './skills/activation';
export { evaluateSkillActivation, skillFrameInvalidationReason } from './skills/activation';
export type {
  CompiledCapabilitySchema,
  JsonSchema,
} from './skills/capability-domain';
export {
  canonicalizeCapabilityArguments,
  compileCapabilitySchema,
  createCapabilitySnapshot,
  descriptorRevision,
  digestCapabilityValue,
  validateCapabilityArguments,
} from './skills/capability-domain';
export type {
  RefreshSkillCatalogOptions,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillMcpCapabilityResolverPort,
} from './skills/catalog';
export {
  createSkillCapabilityResolver,
  findSkillCatalogEntry,
  refreshSkillCatalog,
  scanCompiledSkillManifests,
} from './skills/catalog';
export type {
  SkillActivationContext,
  SkillLifecycleContext,
  SkillLifecycleEmission,
} from './skills/lifecycle';
export {
  activateSkillLifecycle,
  completeSkillLifecycle,
  findActiveSkillFrame,
  readSkillReference,
} from './skills/lifecycle';
export type { SkillRuntimeEvent } from './skills/runtime-domain';
export { verificationRequestForSkill } from './skills/runtime-domain';
export type { SkillManifest, SkillScanOptions } from './skills/types';
export type {
  CompiledSkillWorkflow,
  CompileSkillWorkflowInput,
  SkillDiagnostic,
  SkillWorkflowContract,
} from './skills/workflow';
export { compileSkillWorkflow, SKILL_WORKFLOW_SCHEMA_VERSION } from './skills/workflow';
export {
  BuiltinChildRuntimeDriver,
  type BuiltinChildRuntimeResumeRegistration,
  type BuiltinChildRuntimeStartRegistration,
} from './subagent/child-runtime-driver';
export {
  createGovernedLocalSubagentComposition,
  type GovernedSubagentComposition,
} from './subagent/composition';
export {
  type SubagentContinuationArtifactAccess,
  SubagentContinuationArtifactError,
  type SubagentContinuationArtifactOwner,
  SubagentContinuationArtifactStore,
} from './subagent/continuation-artifacts';
export {
  decodeSubagentContinuationSnapshot,
  encodeSubagentContinuationSnapshot,
  subagentContinuationCursorId,
  subagentTaskDigest,
} from './subagent/continuation-codec';
export {
  SubagentGrantAuthority,
  SubagentGrantError,
  type SubagentGrantVerifier,
} from './subagent/grant-authority';
export {
  type SubagentLifecycleArtifactAccess,
  SubagentLifecycleArtifactError,
  SubagentLifecycleArtifactStore,
} from './subagent/lifecycle-artifacts';
export { subagentDispatchIntentDigest } from './subagent/lifecycle-evidence';
export {
  type BuiltinSubagentTaskArtifactAccess,
  type LocalSubagentDriverResult,
  type LocalSubagentLifecycleDriver,
  LocalSubagentProvider,
} from './subagent/local-provider';
export {
  type BuiltinSubagentModelContext,
  type BuiltinSubagentModelContextInput,
  createBuiltinSubagentModelContext,
} from './subagent/model-context';
export {
  type BuiltinSubagentModelLoopCompleted,
  type BuiltinSubagentModelLoopConsumerDecision,
  type BuiltinSubagentModelLoopConsumerInput,
  type BuiltinSubagentModelLoopConsumerPort,
  type BuiltinSubagentModelLoopCoordinator,
  BuiltinSubagentModelLoopError,
  type BuiltinSubagentModelLoopInput,
  type BuiltinSubagentModelLoopProvenanceContext,
  type BuiltinSubagentModelLoopProvenanceFactory,
  type BuiltinSubagentModelLoopResourceContext,
  type BuiltinSubagentModelLoopResult,
  createBuiltinSubagentModelLoopEngine,
} from './subagent/model-loop-engine';
export { subagentRoleAllowsShellCommand } from './subagent/role-ceiling';
export {
  type BuiltinSubagentShellRejection,
  rejectShellOutsideSubAgentRoleCeiling,
  resolveSubAgentShellExecutor,
} from './subagent/role-shell-ceiling';
export {
  BUILTIN_ROLES,
  type BuiltinSubagentRoleConfig,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  getRoleConfig,
} from './subagent/roles';
export {
  type SubagentTaskArtifactAccess,
  SubagentTaskArtifactError,
  type SubagentTaskArtifactOwner,
  type SubagentTaskArtifactPayload,
  SubagentTaskArtifactStore,
  type SubagentTaskArtifactStoreOptions,
  type SubagentTaskRequestArtifactAccess,
  SubagentTaskRequestArtifactStore,
} from './subagent/task-artifacts';
export {
  type BuiltinModelToolSurfaceFromProjectionInput,
  type BuiltinSubagentDynamicMcpBinding,
  type BuiltinSubagentToolSurface,
  type BuiltinSubagentToolSurfaceInput,
  createBuiltinModelToolSurfaceFromProjection,
  createBuiltinSubagentToolSurface,
} from './subagent/tool-surface';
export type {
  BuiltinPlanActionResult,
  BuiltinPlanningExecutionMechanism,
  BuiltinReadPlanInput,
  BuiltinSubagentExecutionMechanism,
  BuiltinUpdatePlanInput,
  BuiltinVerificationExecutionMechanism,
  BuiltinWritePlanInput,
  SubagentExecutionMechanisms,
  SubagentOperationId,
  SubagentToolOperationId,
} from './subagent-operations';
export {
  ASK_USER_INPUT_SCHEMA_,
  createSubagentRuntimeModule,
  isBuiltinSubagentTaskToolName,
  normalizeAskUserRequest,
  planningContinuationAfterPlanSubagent,
  projectSubagentResult,
  READ_PLAN_INPUT_SCHEMA_,
  SUBAGENT_CAPABILITY_REVISIONS_,
  SUBAGENT_EXECUTOR_REVISIONS_,
  SUBAGENT_OPERATION_IDS_,
  SUBAGENT_PROVIDER_ID_,
  TASK_INPUT_SCHEMA_,
  UPDATE_PLAN_INPUT_SCHEMA_,
  validateDelegatedTask,
  WRITE_PLAN_INPUT_SCHEMA_,
} from './subagent-operations';
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
  GIT_INSPECT_CONTRACT,
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
export {
  type BuiltinCapabilityVerificationRequest,
  createBuiltinCapabilityVerificationRequest,
  validateBuiltinVerificationSpec,
} from './verification/contract';
export {
  type BuiltinDeterministicVerificationDependencies,
  BuiltinVerificationDispatchError,
  type BuiltinVerificationMcpPort,
  type BuiltinVerificationReceiptView,
  type BuiltinVerificationShellPort,
  type BuiltinVerificationStateView,
  executeDeterministicVerificationChecks,
} from './verification/deterministic-executor';
export type {
  BuiltinModelExecutionMechanism,
  VerificationExecutionMechanisms,
  VerificationOperationId,
} from './verification-operations';
export {
  createVerificationRuntimeModule,
  VERIFICATION_CAPABILITY_REVISIONS_,
  VERIFICATION_EXECUTOR_REVISIONS_,
  VERIFICATION_OPERATION_IDS_,
  VERIFICATION_PROVIDER_ID_,
} from './verification-operations';

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
  if (RUNTIME_CONTRACT_BOUNDARY_.revision !== 'rmv1-03') {
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
