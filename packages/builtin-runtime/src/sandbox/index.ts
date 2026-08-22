export type { SandboxPreparationLifecycleV1 } from '@kite/runtime-spi';
export { projectApprovedProxyEnvironmentV1 } from './approved-proxy-environment';
export { generateBwrapArgs } from './bwrap';
export { findUsableCgroupPidsRunnerV1 } from './cgroup-pids';
export {
  buildCgroupPidsInvocationV1,
  type CgroupPidsRunnerV1,
  type CgroupPidsScopeIdentityV1,
  createCgroupPidsUnitNameV1,
  isCgroupPidsExecutablePathV1,
  isCgroupPidsPathV1,
  isCgroupPidsUnitNameV1,
} from './cgroup-pids-contract';
export {
  checkDangerousCanonicalPathV1,
  checkDangerousPaths,
  type FixedDangerousPathIdentityV1,
  resolveFixedDangerousPathIdentitiesV1,
} from './dangerous-paths';
export type { ExecutionEnvironmentIdentityV1 } from './environment-identity';
export { readExecutionEnvironmentIdentityV1 } from './environment-identity';
export { sandboxBackendCapabilitiesV1 } from './execution/backend-capabilities';
export {
  directoryNamesAtV1,
  openDirectoryAtV1,
  removeDirectoryTreeAtV1,
  removeEmptyDirectoryAtV1,
} from './execution/descriptor-relative-cleanup';
export {
  SandboxExecutionGrantAuthorityV1,
  SandboxExecutionGrantErrorV1,
  type SandboxExecutionGrantVerifierV1,
  type SandboxPreparationIntentRecordV1,
  sandboxCleanupDigestV1,
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
  sandboxPreparedPlanDigestV1,
} from './execution/grant-authority';
export {
  buildCgroupPidsKillInvocationV1,
  cgroupPidsUnitFromArgvV1,
  LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_V1,
  type LinuxCgroupScopeCandidateV1,
  parseCgroupPidsEmptyV1,
  parseCgroupPidsPopulatedV1,
  parseLinuxCgroupScopeIdentityV1,
} from './execution/linux-cgroup-scope';
export {
  type LocalSandboxExecutionProviderOptionsV1,
  LocalSandboxExecutionProviderV1,
} from './execution/local-provider';
export {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  cleanupSandboxRuntimeDirNoSpawnV1,
  cleanupWindowsSandboxRuntimeDirNoSpawnV1,
  createPosixSandboxRuntimeRootsForPreparationV1,
  createSandboxRuntimeDirForPreparationV1,
  createWindowsSandboxRuntimeDirForPreparationV1,
  type PosixSandboxRuntimeRootsV1,
  sandboxRuntimeDirForPreparationV1,
  sandboxRuntimeRootsForPreparationV1,
} from './execution/local-runtime-filesystem';
export {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
} from './execution/local-shell-preparation';
export {
  buildWindowsRestrictedTokenEnvForTest,
  createWindowsRestrictedTokenCapabilitySidV1,
  createWindowsRestrictedTokenDirectWorkspaceV1,
  createWindowsRestrictedTokenInvocationName,
  DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES,
  decodeWindowsRestrictedTokenPreparedTransportV1,
  prepareWindowsRestrictedTokenTransportV1,
  type RestrictedTokenInvocationRequestV1,
  resolveBunExecutableForWindowsRestrictedTokenV1,
  resolveWindowsRestrictedTokenFilesystemScopeV1,
  resolveWindowsRestrictedTokenNetworkModeV1,
  restrictedTokenNetworkUnsupportedReasonV1,
  type SandboxShellPreparationInputV1,
  WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST,
  type WindowsRestrictedTokenDirectWorkspaceV1,
  type WindowsRestrictedTokenExecutorOptionsV1,
  type WindowsRestrictedTokenPreparationResultV1,
  type WindowsRestrictedTokenPreparedTransportV1,
  windowsApprovedNetworkScopeErrorV1,
  wrapWindowsRestrictedTokenCommandV1,
} from './execution/windows-preparation';
export {
  isDescriptorAdmittedByExecutionCapabilitySurfaceV1,
  type SandboxCapabilityDescriptorV1,
} from './execution-capability-surface';
export { resolveSandboxExitCode } from './executor';
export { isDescriptorAdmittedByInProcessReadOnlyCatalogV1 } from './in-process-read-only';
export type {
  NetworkAdmissionReceiptV1,
  NetworkBoundaryEnforcerV1,
  NetworkBoundaryFailureCode,
  NetworkDecisionReceiptV1,
  NetworkDecisionRecorderV1,
  NetworkResolvedAddressV1,
  NetworkResolverV1,
} from './network-enforcer';
export {
  createNetworkBoundaryEnforcerV1,
  createNetworkBoundaryFetchV1,
  isPublicNetworkAddress,
  NetworkBoundaryError,
} from './network-enforcer';
export type { NetworkBoundaryPolicyV1 } from './network-policy';
export {
  canonicalNetworkHostname,
  networkBoundaryPolicyFromExecutionBoundaryV1,
} from './network-policy';
export {
  canonicalPathForComparison,
  expandHomeRelativePath,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
  normalizeMsys2DrivePathsInShellCommand,
  normalizeMsys2PathsInText,
} from './path-utils';
export type { ResolveSandboxRuntimeOptions, SandboxBackend, SandboxRuntime } from './platform';
export {
  BUBBLEWRAP_USABILITY_PROBE_ARGS,
  detectSandboxBackend,
  discoverSandboxBackendCandidateV1,
  findUsableBubblewrap,
  isSandboxAvailable,
  resolveSandboxRuntime,
  sandboxSupportsFullModeV1,
  selectSandboxBackend,
  usableBubblewrapPath,
} from './platform';
export {
  type SandboxPreparationArtifactErrorCodeV1,
  SandboxPreparationArtifactErrorV1,
  type SandboxPreparationArtifactStoreOptionsV1,
  SandboxPreparationArtifactStoreV1,
  sandboxPreparationArtifactRootV1,
} from './preparation-artifacts';
export {
  type BuiltinSandboxPreparationErrorCodeV1,
  BuiltinSandboxPreparationErrorV1,
  type BuiltinSandboxPreparationInputV1,
  type BuiltinSandboxPreparationResultV1,
  createBuiltinSandboxPreparationV1,
} from './preparation-authority';
export {
  sandboxAbandonmentLifecycleIntentDigestV1,
  sandboxDisposalLifecycleIntentDigestV1,
  sandboxPreparationIntentDigestV1,
  sandboxPreparationReadyDigestV1,
  validateSandboxPreparationIntentRecordV1,
  validateSandboxPreparationReadyRecordV1,
} from './preparation-evidence';
export type {
  BuiltinPreparedShellDisposalEvidenceV1,
  BuiltinPreparedShellExecutionConsumerOptionsV1,
  BuiltinPreparedShellExecutionInputV1,
  BuiltinPreparedShellExecutionKindV1,
  BuiltinPreparedShellExecutionResultV1,
} from './prepared-execution-consumer';
export { createBuiltinPreparedShellExecutionConsumerV1 } from './prepared-execution-consumer';
export {
  currentProcessTreeCapabilityV1,
  type ProcessTreeCapabilityEvidenceV1,
  type ProcessTreeHardLimitMechanismV1,
} from './process-tree-capability';
export {
  canonicalExistingPath,
  discoverRuntimeReadOnlyRoots,
  generateSandboxProfile,
  type SandboxGitAccess,
  type SandboxProfileOptions,
} from './profile';
export {
  type CreateProtectedPathEvaluatorV1Input,
  createProtectedPathEvaluatorV1,
  PROTECTED_WORKSPACE_DIRECTORIES_V1,
  PROTECTED_WORKSPACE_FILE_PREFIXES_V1,
  PROTECTED_WORKSPACE_FILES_V1,
  type ProtectedPathAccessV1,
  type ProtectedPathDecisionReasonV1,
  type ProtectedPathDecisionV1,
  type ProtectedPathEvaluatorV1,
  type ProtectedPathOperationV1,
} from './protected-path';
export { findApplySeccomp, resolveSeccompPath } from './seccomp';
export {
  findBashBinary,
  findSystemBash,
  gatherSystemBashCandidates,
  isWslStubPath,
  type SystemBashCandidatesV1,
} from './shell-bash-path';
export type {
  SandboxInvocationIdentityV1,
  ShellExecutor,
  ShellInput,
  ShellNetworkBrokerV1,
  ShellProcessHandleV1,
  ShellProcessPortV1,
  ShellProcessTerminationV1,
  ShellProcessTreeV1,
  ShellResult,
} from './shell-contract';
export {
  appendTimeoutMessage,
  assertInsideWorkspace,
  buildHostShellInvocationsV1,
  buildPolicyProvenReadOnlyHostShellInvocationsV1,
  createBuiltinShellExecutorV1,
  DEFAULT_SHELL_TIMEOUT_MS,
  type HostShellInvocationV1,
  type HostShellKindV1,
  type HostShellResolutionDepsV1,
  resolveShellTimeoutMs,
  timeoutMessage,
} from './shell-executor';
export {
  buildPolicyProvenReadOnlyEnv,
  buildWorkspaceExcludedPath,
  POLICY_PROVEN_READ_ONLY_EXECUTION,
} from './trusted-readonly-environment';
export type {
  BoundaryEnforcementV1,
  ExecutionBackendCapabilitiesV1,
  ExecutionBoundaryAdmissionReasonV1,
  ExecutionBoundaryAdmissionV1,
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ExecutionNetworkMode,
  FilesystemScope,
  InProcessReadOnlyToolCatalogV1,
  InProcessReadOnlyToolContractV1,
  ProductionExecutionEntrypointV1,
  ProductionExecutionQualificationRegistryV1,
  ProductionExecutionQualificationV1,
  ProductionPlatformQualificationV1,
  ProtectedPathPolicy,
  ResourceLimits,
  SandboxUnavailablePolicy,
  ShellFilesystemMode,
  ShellNetworkMode,
} from './types';
export { DEFAULT_RESOURCE_LIMITS } from './types';
export {
  resolveWindowsManagedNetworkSetupStatusV1,
  setupWindowsManagedNetworkV1,
  type WindowsManagedNetworkSetupDependenciesV1,
  type WindowsManagedNetworkSetupStateV1,
  type WindowsManagedNetworkSetupStatusV1,
} from './windows-network-setup';
export {
  clearWindowsSandboxRunnerCacheV1,
  parseWindowsSandboxRunnerManifestV1,
  type ResolveWindowsSandboxRunnerOptionsV1,
  resolveInstalledWindowsRunnerManifestLocationV1,
  resolveWindowsSandboxRunnerV1,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsSandboxRunnerManifestV1,
  type WindowsSandboxRunnerV1,
} from './windows-runner';
