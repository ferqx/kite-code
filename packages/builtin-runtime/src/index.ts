import { RUNTIME_CONTRACT_BOUNDARY_V1 } from '@kite/runtime-contract';
import type { RuntimeModuleV1 } from '@kite/runtime-spi';
import { createRmv111RuntimeModuleV1 } from './rmv1-11-operations';
import { createRmv112RuntimeModuleV1 } from './rmv1-12-operations';
import { createRmv113RuntimeModuleV1 } from './rmv1-13-operations';
import { createRmv114RuntimeModuleV1 } from './rmv1-14-operations';
import { createRmv115RuntimeModuleV1 } from './rmv1-15-operations';
import { createToolSearchRuntimeModuleV1 } from './tool-search';

export type { WorkspaceFilesystemGrantVerifierV1 } from '@kite/runtime-spi';
export type {
  BuiltinPreparedTaskDispatchAdapterV1,
  BuiltinPreparedToolDispatchAdapterV1,
  BuiltinPreparedToolDispatchFailureCodeV1,
  BuiltinPreparedToolDispatchInputV1,
  BuiltinPreparedToolDispatchPortV1,
  CreateBuiltinPreparedTaskDispatchAdapterInputV1,
  CreateBuiltinPreparedToolDispatchAdapterInputV1,
} from './builtin-prepared-dispatch-adapter';
export {
  BuiltinPreparedToolDispatchErrorV1,
  createBuiltinPreparedTaskDispatchAdapterV1,
  createBuiltinPreparedToolDispatchAdapterV1,
  projectBuiltinDynamicMcpExecutionReceiptTerminalResultV1,
  projectBuiltinExecutionReceiptTerminalResultV1,
  projectBuiltinOperationTerminalResultV1,
} from './builtin-prepared-dispatch-adapter';
export {
  assertRestoredCapabilityArtifactEvidenceV1,
  type CapabilityArtifactAccessV1,
  type CapabilityArtifactBindingV1,
  type CapabilityArtifactEnvelopeV1,
  CapabilityArtifactError,
  type CapabilityArtifactErrorCodeV1,
  type CapabilityArtifactReaderV1,
  CapabilityArtifactStore,
  type CapabilityArtifactStoreOptionsV1,
  type CapabilityArtifactWriterV1,
  capabilityArtifactRootV1,
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
  readBoundCapabilityArtifactV1,
} from './capability-artifacts';
export type { CreateCapabilityBindingInputV1 } from './capability-binding';
export {
  createCapabilityBindingV1,
  digestCapabilityBindingValueV1,
} from './capability-binding';
export type {
  BuiltinCapabilitySearchCandidateV1,
  BuiltinCapabilitySearchProviderDiagnosticV1,
  CapabilityDisclosureDecisionV1,
  CapabilityDisclosureModeV1,
  SearchableCapabilityDescriptorV1,
  SearchableProviderEntryV1,
} from './capability-disclosure';
export {
  chooseCapabilityDisclosureV1,
  estimateCapabilityCatalogTokensV1,
  modelVisibleCapabilitySchemaV1,
  projectCapabilitySearchCandidatesV1,
  projectUnavailableProviderSearchV1,
  searchableCapabilitySnapshotV1,
  searchCapabilitySnapshotV1,
  searchUnavailableProvidersV1,
} from './capability-disclosure';
export type {
  BuiltinExecutionTraitsInputV1,
  BuiltinToolContractOptionsV1,
  BuiltinToolSchemaHintEntryV1,
  BuiltinToolTurnContextV1,
  CreateBuiltinZodParserOptionsV1,
} from './catalog-contract';
export {
  activateSkillAvailabilityV1,
  alwaysAvailableV1,
  builtinExecutionTraitsV1,
  createBuiltinZodParserV1,
  defineBuiltinCapabilityContractV1,
  formatBuiltinToolParseErrorV1,
  formatBuiltinToolSchemaHintV1,
  gitAvailabilityV1,
  hasBrokeredGitExecutableTokenV1,
  isDestructiveShellCommandV1,
  isNetworkShellCommandV1,
  isReadOnlyShellCommandV1,
  isVcsMutationShellCommandV1,
  isWriteShellCommandV1,
  parserForBuiltinOperationV1,
  projectBuiltinExecutionTraitsV1,
  readSkillAvailabilityV1,
  shellEffectsClassifierV1,
  staticEffectsClassifierV1,
  taskAvailabilityV1,
  taskEffectsClassifierV1,
  taskModelInputSchemaV1,
  taskModelParserV1,
  taskModelSchemaV1,
  taskRuntimeParserV1,
  toolSearchAvailabilityV1,
} from './catalog-contract';
export {
  assertDescriptorRelativeMutationSupportedV1,
  atomicReplaceInLockedWindowsDirectoryV1,
  closeOpenedDirectoryChainV1,
  type DescriptorRelativeDirectoryChainV1,
  openExclusiveFileAtV1,
  openOrCreateDirectoryChainAtV1,
  renameAtV1,
  unlinkAtV1,
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
  validateWorkspaceFilesystemIntentRecordV1,
  validateWorkspaceFilesystemMutationReadyRecordV1,
  validateWorkspaceFilesystemObservationRecordV1,
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
} from './filesystem/evidence';
export {
  validateWorkspaceFilesystemOperationV1,
  type WorkspaceFilesystemGrantAuthorityOptionsV1,
  WorkspaceFilesystemGrantAuthorityV1,
  WorkspaceFilesystemGrantErrorV1,
  workspaceFilesystemContentHashV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemStringDigestV1,
  workspaceFilesystemTargetEvidenceV1,
  workspaceFilesystemTargetIdentityDigestV1,
} from './filesystem/grant-authority';
export {
  type LocalWorkspaceFilesystemProviderOptionsV1,
  LocalWorkspaceFilesystemProviderV1,
} from './filesystem/local-provider';
export type {
  BuiltinWorkspaceFilesystemCheckpointProjectionV1,
  BuiltinWorkspaceFilesystemMutationDispatchErrorCodeV1,
  CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1,
} from './filesystem/mutation-dispatcher';
export {
  BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1,
  BuiltinWorkspaceFilesystemMutationDispatchErrorV1,
  createBuiltinWorkspaceFilesystemMutationDispatcherV1,
} from './filesystem/mutation-dispatcher';
export type {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorCodeV1,
  BuiltinWorkspaceFilesystemTerminalVerificationResultV1,
  BuiltinWorkspaceFilesystemTerminalVerifierV1,
} from './filesystem/observation-authority';
export {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorV1,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
} from './filesystem/observation-authority';
export {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedOutput,
  truncateProjectedStreams,
} from './filesystem/projection';
export type {
  BuiltinWorkspaceFilesystemActorIdentityV1,
  BuiltinWorkspaceFilesystemReadDispatchErrorCodeV1,
  CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1,
} from './filesystem/read-dispatcher';
export {
  BuiltinWorkspaceFilesystemReadDispatchErrorV1,
  createBuiltinWorkspaceFilesystemReadDispatcherV1,
} from './filesystem/read-dispatcher';
export {
  type BuiltinProtectedPathEvaluatorV1,
  createGitBrokerV1,
  type GitBrokerV1,
  type GitProcessAdapterV1,
  type GitProcessRequestV1,
  type GitProcessResultV1,
  isGitRevisionV1,
} from './git/broker';
export {
  type BrokeredGitQualificationDecisionV1,
  qualifyBrokeredGitNativeDenyV1,
} from './git/qualification';
export type {
  BuiltinMechanismRecordV1,
  MergeBuiltinMechanismBundleInputV1,
} from './mechanism-authority';
export {
  BuiltinMechanismAuthorityErrorV1,
  mergeBuiltinMechanismBundleV1,
} from './mechanism-authority';
export {
  BUILTIN_CONTEXT_COMPILER_ID_V1,
  BUILTIN_CONTEXT_COMPILER_REVISION_V1,
  BUILTIN_CONTEXT_SOURCE_IDS_V1,
  createBuiltinContextCompilerPortV1,
} from './model-context';
export type { BuiltinObservabilityProjectorV1 } from './observability';
export {
  createBuiltinObservabilityProjectorV1,
  LowCardinalityAliasMapperV1,
} from './observability';
export type {
  BuiltinDynamicMcpPolicyInputV1,
  BuiltinPolicyRuleResultV1,
  CreateBuiltinPolicyCompilerInputV1,
} from './policy-compiler';
export {
  activateSkillBuiltinPolicyRuleV1,
  askUserBuiltinPolicyRuleV1,
  BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
  capabilityRiskFromEffectsV1,
  compileBuiltinDynamicMcpPolicyV1,
  createBuiltinPolicyCompilerV1,
  fileBuiltinPolicyRuleV1,
  planBuiltinPolicyRuleV1,
  readOnlyBuiltinPolicyRuleV1,
  shellBuiltinPolicyRuleV1,
  taskBuiltinPolicyRuleV1,
  webFetchBuiltinPolicyRuleV1,
} from './policy-compiler';
export type {
  BuiltinMcpExecutionMechanismV1,
  BuiltinMcpRuntimePortV1,
  BuiltinOperationExecutionValueV1,
  BuiltinRuntimeEventValueV1,
  BuiltinSkillExecutionMechanismV1,
  BuiltinWebExecutionMechanismV1,
  Rmv111ExecutionMechanismsV1,
  Rmv111OperationIdV1,
} from './rmv1-11-operations';
export {
  ACTIVATE_SKILL_INPUT_SCHEMA_V1,
  BuiltinMcpExecutionUnknownErrorV1,
  COMPLETE_SKILL_INPUT_SCHEMA_V1,
  createRmv111RuntimeModuleV1,
  DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_V1,
  isBuiltinOperationExecutionValueV1,
  LIST_MCP_RESOURCES_INPUT_SCHEMA_V1,
  LIST_MCP_TOOLS_INPUT_SCHEMA_V1,
  READ_MCP_RESOURCE_INPUT_SCHEMA_V1,
  READ_SKILL_REFERENCE_INPUT_SCHEMA_V1,
  RMV1_11_CAPABILITY_REVISIONS_V1,
  RMV1_11_EXECUTOR_REVISIONS_V1,
  RMV1_11_OPERATION_IDS_V1,
  RMV1_11_PROVIDER_ID_V1,
  WEB_FETCH_INPUT_SCHEMA_V1,
} from './rmv1-11-operations';
export type {
  BuiltinFilesystemExecutionMechanismV1,
  BuiltinFilesystemPipelineResultV1,
  BuiltinGitExecutionMechanismV1,
  Rmv112ExecutionMechanismsV1,
  Rmv112OperationIdV1,
} from './rmv1-12-operations';
export {
  createRmv112RuntimeModuleV1,
  EDIT_FILE_INPUT_SCHEMA_V1,
  GIT_INSPECT_INPUT_SCHEMA_V1,
  MAX_MODEL_READ_FILE_CHARS_V1,
  READ_FILE_INPUT_SCHEMA_V1,
  RMV1_12_CAPABILITY_REVISIONS_V1,
  RMV1_12_EXECUTOR_REVISIONS_V1,
  RMV1_12_OPERATION_IDS_V1,
  RMV1_12_PROVIDER_ID_V1,
  SEARCH_CONTENT_INPUT_SCHEMA_V1,
  SEARCH_FILES_INPUT_SCHEMA_V1,
  WRITE_FILE_INPUT_SCHEMA_V1,
} from './rmv1-12-operations';
export type {
  BuiltinShellExecutionMechanismV1,
  BuiltinShellExecutionResultV1,
  BuiltinShellIntentV1,
  Rmv113ExecutionMechanismsV1,
} from './rmv1-13-operations';
export {
  BuiltinShellExecutionUnknownErrorV1,
  classifyBuiltinShellIntentV1,
  createRmv113RuntimeModuleV1,
  DEFAULT_SHELL_TIMEOUT_MS_V1,
  projectBuiltinShellIntentV1,
  RMV1_13_CAPABILITY_REVISION_V1,
  RMV1_13_EXECUTOR_REVISION_V1,
  RMV1_13_OPERATION_ID_V1,
  RMV1_13_PROVIDER_ID_V1,
  SHELL_EXECUTE_INPUT_SCHEMA_V1,
} from './rmv1-13-operations';
export type {
  BuiltinPlanActionResultV1,
  BuiltinPlanningExecutionMechanismV1,
  BuiltinReadPlanInputV1,
  BuiltinSubagentExecutionMechanismV1,
  BuiltinUpdatePlanInputV1,
  BuiltinVerificationExecutionMechanismV1,
  BuiltinWritePlanInputV1,
  Rmv114ExecutionMechanismsV1,
  Rmv114OperationIdV1,
  Rmv114ToolOperationIdV1,
} from './rmv1-14-operations';
export {
  ASK_USER_INPUT_SCHEMA_V1,
  createRmv114RuntimeModuleV1,
  isBuiltinSubagentTaskToolNameV1,
  normalizeAskUserRequestV1,
  planningContinuationAfterPlanSubagentV1,
  projectSubagentResultV1,
  READ_PLAN_INPUT_SCHEMA_V1,
  RMV1_14_CAPABILITY_REVISIONS_V1,
  RMV1_14_EXECUTOR_REVISIONS_V1,
  RMV1_14_OPERATION_IDS_V1,
  RMV1_14_PROVIDER_ID_V1,
  TASK_INPUT_SCHEMA_V1,
  UPDATE_PLAN_INPUT_SCHEMA_V1,
  validateDelegatedTaskV1,
  WRITE_PLAN_INPUT_SCHEMA_V1,
} from './rmv1-14-operations';
export type {
  BuiltinModelExecutionMechanismV1,
  Rmv115ExecutionMechanismsV1,
  Rmv115OperationIdV1,
} from './rmv1-15-operations';
export {
  createRmv115RuntimeModuleV1,
  RMV1_15_CAPABILITY_REVISIONS_V1,
  RMV1_15_EXECUTOR_REVISIONS_V1,
  RMV1_15_OPERATION_IDS_V1,
  RMV1_15_PROVIDER_ID_V1,
} from './rmv1-15-operations';
export type { BuiltinRuntimeToolPipelineCallbacksV1 } from './runtime-tool-pipeline-callbacks';
export { createBuiltinRuntimeToolPipelineCallbacksV1 } from './runtime-tool-pipeline-callbacks';
export type {
  SkillActivationEvaluation,
  SkillActivationRequest,
} from './skills/activation';
export { evaluateSkillActivation, skillFrameInvalidationReason } from './skills/activation';
export type {
  CompiledCapabilitySchemaV1,
  JsonSchemaV1,
} from './skills/capability-domain';
export {
  canonicalizeCapabilityArgumentsV1,
  compileCapabilitySchemaV1,
  createCapabilitySnapshotV1,
  descriptorRevisionV1,
  digestCapabilityValueV1,
  validateCapabilityArgumentsV1,
} from './skills/capability-domain';
export type {
  RefreshSkillCatalogOptions,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillMcpCapabilityResolverPortV1,
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
export type { SkillRuntimeEventV1 } from './skills/runtime-domain';
export { verificationRequestForSkillV1 } from './skills/runtime-domain';
export type { SkillManifest, SkillScanOptions } from './skills/types';
export type {
  CompiledSkillWorkflow,
  CompileSkillWorkflowInput,
  SkillDiagnostic,
  SkillWorkflowContract,
} from './skills/workflow';
export { compileSkillWorkflow, SKILL_WORKFLOW_SCHEMA_VERSION } from './skills/workflow';
export {
  BuiltinChildRuntimeDriverV1,
  type BuiltinChildRuntimeResumeRegistrationV1,
  type BuiltinChildRuntimeStartRegistrationV1,
} from './subagent/child-runtime-driver';
export {
  createGovernedLocalSubagentCompositionV1,
  type GovernedSubagentCompositionV1,
} from './subagent/composition';
export {
  type SubagentContinuationArtifactAccessV1,
  SubagentContinuationArtifactErrorV1,
  type SubagentContinuationArtifactOwnerV1,
  SubagentContinuationArtifactStoreV1,
} from './subagent/continuation-artifacts';
export {
  decodeSubagentContinuationSnapshotV1,
  encodeSubagentContinuationSnapshotV1,
  subagentContinuationCursorIdV1,
  subagentTaskDigestV1,
} from './subagent/continuation-codec';
export {
  SubagentGrantAuthorityV1,
  SubagentGrantErrorV1,
  type SubagentGrantVerifierV1,
} from './subagent/grant-authority';
export {
  type SubagentLifecycleArtifactAccessV1,
  SubagentLifecycleArtifactErrorV1,
  SubagentLifecycleArtifactStoreV1,
} from './subagent/lifecycle-artifacts';
export { subagentDispatchIntentDigestV1 } from './subagent/lifecycle-evidence';
export {
  type BuiltinSubagentTaskArtifactAccessV1,
  type LocalSubagentDriverResultV1,
  type LocalSubagentLifecycleDriverV1,
  LocalSubagentProviderV1,
} from './subagent/local-provider';
export {
  type BuiltinSubagentModelContextInputV1,
  type BuiltinSubagentModelContextV1,
  createBuiltinSubagentModelContextV1,
} from './subagent/model-context';
export {
  type BuiltinSubagentModelLoopCompletedV1,
  type BuiltinSubagentModelLoopConsumerDecisionV1,
  type BuiltinSubagentModelLoopConsumerInputV1,
  type BuiltinSubagentModelLoopConsumerPortV1,
  type BuiltinSubagentModelLoopCoordinatorV1,
  BuiltinSubagentModelLoopErrorV1,
  type BuiltinSubagentModelLoopInputV1,
  type BuiltinSubagentModelLoopProvenanceContextV1,
  type BuiltinSubagentModelLoopProvenanceFactoryV1,
  type BuiltinSubagentModelLoopResourceContextV1,
  type BuiltinSubagentModelLoopResultV1,
  createBuiltinSubagentModelLoopEngineV1,
} from './subagent/model-loop-engine';
export { subagentRoleAllowsShellCommandV1 } from './subagent/role-ceiling';
export {
  type BuiltinSubagentShellRejectionV1,
  rejectShellOutsideSubAgentRoleCeilingV1,
  resolveSubAgentShellExecutorV1,
} from './subagent/role-shell-ceiling';
export {
  BUILTIN_ROLES,
  type BuiltinSubagentRoleConfigV1,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  getRoleConfig,
} from './subagent/roles';
export {
  type SubagentTaskArtifactAccessV1,
  SubagentTaskArtifactErrorV1,
  type SubagentTaskArtifactOwnerV1,
  type SubagentTaskArtifactPayloadV1,
  type SubagentTaskArtifactStoreOptionsV1,
  SubagentTaskArtifactStoreV1,
  type SubagentTaskRequestArtifactAccessV1,
  SubagentTaskRequestArtifactStoreV1,
} from './subagent/task-artifacts';
export {
  type BuiltinModelToolSurfaceFromProjectionInputV1,
  type BuiltinSubagentDynamicMcpBindingV1,
  type BuiltinSubagentToolSurfaceInputV1,
  type BuiltinSubagentToolSurfaceV1,
  createBuiltinModelToolSurfaceFromProjectionV1,
  createBuiltinSubagentToolSurfaceV1,
} from './subagent/tool-surface';
export type {
  BuiltinInternalOperationCatalogEntryV1,
  BuiltinModelToolCatalogEntryV1,
  BuiltinModelToolSetV1,
  BuiltinToolAvailabilityV1,
  BuiltinToolCapabilityProjectionV1,
  BuiltinToolCatalogEntryV1,
  BuiltinToolCatalogProjectionV1,
  BuiltinToolEffectClassV1,
  BuiltinUnknownToolFieldsProjectionV1,
  CreateBuiltinToolCatalogProjectionOptionsV1,
} from './tool-catalog';
export {
  createBuiltinModelToolSetV1,
  createBuiltinToolCatalogProjectionV1,
  failClosedBuiltinToolCapabilityV1,
  projectBuiltinUnknownToolFieldsObservationV1,
} from './tool-catalog';
export type {
  KnownToolName,
  LegacyToolContractSection,
  ToolContract,
  ToolContractSection,
  ToolContractSource,
  ToolDescriptionVersion,
} from './tool-contracts';
export {
  ASK_USER_CONTRACT,
  BUILTIN_TOOL_CONTRACTS,
  buildDescription,
  builtinToolDescriptionV1,
  EDIT_FILE_CONTRACT,
  GIT_INSPECT_CONTRACT,
  getToolContract,
  isStructuredToolContract,
  KNOWN_TOOL_NAMES,
  LIST_MCP_RESOURCES_CONTRACT,
  LIST_MCP_TOOLS_CONTRACT,
  normalizeToolContract,
  READ_FILE_CONTRACT,
  READ_MCP_RESOURCE_CONTRACT,
  READ_PLAN_CONTRACT,
  SEARCH_CONTENT_CONTRACT,
  SEARCH_FILES_CONTRACT,
  SHELL_EXECUTE_CONTRACT,
  TASK_CONTRACT,
  TOOL_CONTRACTS,
  TOOL_SEARCH_CONTRACT,
  UPDATE_PLAN_CONTRACT,
  WEB_FETCH_CONTRACT,
  WRITE_FILE_CONTRACT,
  WRITE_PLAN_CONTRACT,
} from './tool-contracts';
export type { BuiltinToolPipelineCallbacksV1 } from './tool-pipeline-callbacks';
export {
  BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1,
  createBuiltinToolPipelineCallbacksV1,
} from './tool-pipeline-callbacks';
export type {
  BuiltinToolAvailabilityContextV1,
  BuiltinValidatedInvocationProjectionV1,
  InvalidToolRequest,
  PendingBuiltinToolRequest,
  PendingMcpToolRequest,
  PendingToolRequest,
  ToolRequestParseFailureCodeV1,
  ToolRequestParseResult,
} from './tool-request';
export {
  isMcpRequest,
  pendingToolRequestFromValidatedInvocationV1,
  toolRequestFromCall,
} from './tool-request';
export type { BuiltinToolResultDigestProjectionV1 } from './tool-result-projection';
export {
  projectBuiltinToolResultDigestsV1,
  toolExecutionModelContentV1,
} from './tool-result-projection';
export type { BuiltinJsonSchemaOptionsV1 } from './tool-schemas';
export {
  BUILTIN_ACTIVATE_SKILL_SCHEMA_V1,
  BUILTIN_ASK_USER_SCHEMA_V1,
  BUILTIN_COMPLETE_SKILL_SCHEMA_V1,
  BUILTIN_DYNAMIC_MCP_SCHEMA_V1,
  BUILTIN_EDIT_FILE_SCHEMA_V1,
  BUILTIN_GIT_INSPECT_SCHEMA_V1,
  BUILTIN_JSON_SCHEMAS_V1,
  BUILTIN_LIST_MCP_RESOURCES_SCHEMA_V1,
  BUILTIN_LIST_MCP_TOOLS_SCHEMA_V1,
  BUILTIN_READ_FILE_SCHEMA_V1,
  BUILTIN_READ_MCP_RESOURCE_SCHEMA_V1,
  BUILTIN_READ_PLAN_SCHEMA_V1,
  BUILTIN_READ_SKILL_REFERENCE_SCHEMA_V1,
  BUILTIN_SEARCH_CONTENT_SCHEMA_V1,
  BUILTIN_SEARCH_FILES_SCHEMA_V1,
  BUILTIN_SHELL_EXECUTE_SCHEMA_V1,
  BUILTIN_TASK_LEGACY_PLANNING_SCHEMA_V1,
  BUILTIN_TASK_PRIVATE_SCHEMA_V1,
  BUILTIN_TASK_PUBLIC_SCHEMA_V1,
  BUILTIN_TASK_RUNTIME_SCHEMA_V1,
  BUILTIN_TOOL_SEARCH_SCHEMA_V1,
  BUILTIN_UPDATE_PLAN_SCHEMA_V1,
  BUILTIN_WEB_FETCH_SCHEMA_V1,
  BUILTIN_WRITE_FILE_SCHEMA_V1,
  BUILTIN_WRITE_PLAN_SCHEMA_V1,
  BUILTIN_ZOD_SCHEMAS_V1,
  builtinJsonSchemaV1,
} from './tool-schemas';
export type {
  ToolSearchCandidateV1,
  ToolSearchDescriptorInputV1,
  ToolSearchExecutionValueV1,
  ToolSearchProviderDiagnosticV1,
  ToolSearchProviderEntryInputV1,
  ToolSearchProviderFactsV1,
  ToolSearchResultV1,
} from './tool-search';
export {
  createToolSearchProviderFactsV1,
  createToolSearchRuntimeModuleV1,
  isToolSearchExecutionValueV1,
  TOOL_SEARCH_CAPABILITY_ID_V1,
  TOOL_SEARCH_CAPABILITY_REVISION_V1,
  TOOL_SEARCH_EXECUTOR_REVISION_V1,
  TOOL_SEARCH_INPUT_SCHEMA_V1,
  TOOL_SEARCH_PROVIDER_ID_V1,
} from './tool-search';
export type {
  BuiltinCapabilityTurnContextInputV1,
  BuiltinCapabilityTurnContextV1,
} from './turn-context';
export { createBuiltinCapabilityTurnContextV1 } from './turn-context';
export {
  type BuiltinCapabilityVerificationRequestV1,
  createBuiltinCapabilityVerificationRequestV1,
  validateBuiltinVerificationSpecV1,
} from './verification/contract';
export {
  type BuiltinDeterministicVerificationDependenciesV1,
  BuiltinVerificationDispatchErrorV1,
  type BuiltinVerificationMcpPortV1,
  type BuiltinVerificationReceiptViewV1,
  type BuiltinVerificationShellPortV1,
  type BuiltinVerificationStateViewV1,
  executeDeterministicVerificationChecksV1,
} from './verification/deterministic-executor';

export const BUILTIN_RUNTIME_DOMAINS_V1 = Object.freeze([
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
export function createBuiltinRuntimeModules(): readonly RuntimeModuleV1[] {
  if (RUNTIME_CONTRACT_BOUNDARY_V1.revision !== 'rmv1-03') {
    throw new Error('builtin runtime contract revision mismatch');
  }
  return Object.freeze([
    createToolSearchRuntimeModuleV1(),
    createRmv111RuntimeModuleV1(),
    createRmv112RuntimeModuleV1(),
    createRmv113RuntimeModuleV1(),
    createRmv114RuntimeModuleV1(),
    createRmv115RuntimeModuleV1(),
  ]);
}
