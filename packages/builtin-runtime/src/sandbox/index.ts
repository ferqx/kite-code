export type { SandboxPreparationLifecycle } from '@kite-ai/runtime-spi';
export { projectApprovedProxyEnvironment } from './approved-proxy-environment';
export { generateBwrapArgs } from './bwrap';
export { findUsableCgroupPidsRunner } from './cgroup-pids';
export {
  buildCgroupPidsInvocation,
  type CgroupPidsRunner,
  type CgroupPidsScopeIdentity,
  createCgroupPidsUnitName,
  isCgroupPidsExecutablePath,
  isCgroupPidsPath,
  isCgroupPidsUnitName,
} from './cgroup-pids-contract';
export {
  checkDangerousCanonicalPath,
  checkDangerousPaths,
  checkDangerousSearchRoot,
  type FixedDangerousPathIdentity,
  resolveFixedDangerousPathIdentities,
} from './dangerous-paths';
export type { ExecutionEnvironmentIdentity } from './environment-identity';
export { readExecutionEnvironmentIdentity } from './environment-identity';
export { sandboxBackendCapabilities } from './execution/backend-capabilities';
export {
  directoryNamesAt,
  openDirectoryAt,
  removeDirectoryTreeAt,
  removeEmptyDirectoryAt,
} from './execution/descriptor-relative-cleanup';
export {
  SandboxExecutionGrantAuthority,
  SandboxExecutionGrantError,
  type SandboxExecutionGrantVerifier,
  type SandboxPreparationIntentRecord,
  sandboxCleanupDigest,
  sandboxCommandDigest,
  sandboxPreparationDigest,
  sandboxPreparedPlanDigest,
} from './execution/grant-authority';
export {
  buildCgroupPidsKillInvocation,
  cgroupPidsUnitFromArgv,
  LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_,
  type LinuxCgroupScopeCandidate,
  parseCgroupPidsEmpty,
  parseCgroupPidsPopulated,
  parseLinuxCgroupScopeIdentity,
} from './execution/linux-cgroup-scope';
export {
  LocalSandboxExecutionProvider,
  type LocalSandboxExecutionProviderOptions,
} from './execution/local-provider';
export {
  cleanupPosixSandboxRuntimeRootsNoSpawn,
  cleanupSandboxRuntimeDirNoSpawn,
  cleanupWindowsSandboxRuntimeDirNoSpawn,
  createPosixSandboxRuntimeRootsForPreparation,
  createSandboxRuntimeDirForPreparation,
  createWindowsSandboxRuntimeDirForPreparation,
  type PosixSandboxRuntimeRoots,
  sandboxRuntimeDirForPreparation,
  sandboxRuntimeRootsForPreparation,
} from './execution/local-runtime-filesystem';
export {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
} from './execution/local-shell-preparation';
export {
  buildWindowsRestrictedTokenEnvForTest,
  createWindowsRestrictedTokenCapabilitySid,
  createWindowsRestrictedTokenDirectWorkspace,
  createWindowsRestrictedTokenInvocationName,
  DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES,
  decodeWindowsRestrictedTokenPreparedTransport,
  prepareWindowsRestrictedTokenTransport,
  type RestrictedTokenInvocationRequest,
  resolveBunExecutableForWindowsRestrictedToken,
  resolveWindowsRestrictedTokenFilesystemScope,
  resolveWindowsRestrictedTokenNetworkMode,
  restrictedTokenNetworkUnsupportedReason,
  type SandboxShellPreparationInput,
  WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST,
  type WindowsRestrictedTokenDirectWorkspace,
  type WindowsRestrictedTokenExecutorOptions,
  type WindowsRestrictedTokenPreparationResult,
  type WindowsRestrictedTokenPreparedTransport,
  windowsApprovedNetworkScopeError,
  wrapWindowsRestrictedTokenCommand,
} from './execution/windows-preparation';
export {
  isDescriptorAdmittedByExecutionCapabilitySurface,
  type SandboxCapabilityDescriptor,
} from './execution-capability-surface';
export { resolveSandboxExitCode } from './executor';
export { isDescriptorAdmittedByInProcessReadOnlyCatalog } from './in-process-read-only';
export type {
  NetworkAdmissionReceipt,
  NetworkBoundaryEnforcer,
  NetworkBoundaryFailureCode,
  NetworkDecisionReceipt,
  NetworkDecisionRecorder,
  NetworkResolvedAddress,
  NetworkResolver,
} from './network-enforcer';
export {
  createNetworkBoundaryEnforcer,
  createNetworkBoundaryFetch,
  isPublicNetworkAddress,
  NetworkBoundaryError,
} from './network-enforcer';
export type { NetworkBoundaryPolicy } from './network-policy';
export {
  canonicalNetworkHostname,
  networkBoundaryPolicyFromExecutionBoundary,
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
  discoverSandboxBackendCandidate,
  findUsableBubblewrap,
  isSandboxAvailable,
  resolveSandboxRuntime,
  sandboxBackendAvailable,
  selectSandboxBackend,
  usableBubblewrapPath,
} from './platform';
export {
  SandboxPreparationArtifactError,
  type SandboxPreparationArtifactErrorCode,
  SandboxPreparationArtifactStore,
  type SandboxPreparationArtifactStoreOptions,
  sandboxPreparationArtifactRoot,
} from './preparation-artifacts';
export {
  BuiltinSandboxPreparationError,
  type BuiltinSandboxPreparationErrorCode,
  type BuiltinSandboxPreparationInput,
  type BuiltinSandboxPreparationResult,
  createBuiltinSandboxPreparation,
} from './preparation-authority';
export {
  sandboxAbandonmentLifecycleIntentDigest,
  sandboxDisposalLifecycleIntentDigest,
  sandboxPreparationIntentDigest,
  sandboxPreparationReadyDigest,
  validateSandboxPreparationIntentRecord,
  validateSandboxPreparationReadyRecord,
} from './preparation-evidence';
export type {
  BuiltinPreparedShellDisposalEvidence,
  BuiltinPreparedShellExecutionConsumerOptions,
  BuiltinPreparedShellExecutionInput,
  BuiltinPreparedShellExecutionKind,
  BuiltinPreparedShellExecutionResult,
} from './prepared-execution-consumer';
export { createBuiltinPreparedShellExecutionConsumer } from './prepared-execution-consumer';
export {
  currentProcessTreeCapability,
  type ProcessTreeCapabilityEvidence,
  type ProcessTreeHardLimitMechanism,
} from './process-tree-capability';
export {
  canonicalExistingPath,
  discoverRuntimeReadOnlyRoots,
  generateSandboxProfile,
  type SandboxGitAccess,
  type SandboxProfileOptions,
} from './profile';
export {
  type CreateProtectedPathEvaluatorInput,
  createProtectedPathEvaluator,
  PROTECTED_WORKSPACE_DIRECTORIES_,
  PROTECTED_WORKSPACE_FILE_PREFIXES_,
  PROTECTED_WORKSPACE_FILES_,
  type ProtectedPathAccess,
  type ProtectedPathDecision,
  type ProtectedPathDecisionReason,
  type ProtectedPathEvaluator,
  type ProtectedPathOperation,
} from './protected-path';
export { findApplySeccomp, resolveSeccompPath } from './seccomp';
export {
  findBashBinary,
  findSystemBash,
  gatherSystemBashCandidates,
  isWslStubPath,
  type SystemBashCandidates,
} from './shell-bash-path';
export type {
  SandboxInvocationIdentity,
  ShellExecutor,
  ShellInput,
  ShellNetworkBroker,
  ShellProcessHandle,
  ShellProcessPort,
  ShellProcessTermination,
  ShellProcessTree,
  ShellResult,
} from './shell-contract';
export {
  appendTimeoutMessage,
  assertInsideWorkspace,
  buildHostShellInvocations,
  buildPolicyProvenReadOnlyHostShellInvocations,
  createBuiltinShellExecutor,
  DEFAULT_SHELL_TIMEOUT_MS,
  type HostShellInvocation,
  type HostShellKind,
  type HostShellResolutionDeps,
  resolveShellTimeoutMs,
  timeoutMessage,
} from './shell-executor';
export {
  buildPolicyProvenReadOnlyEnv,
  buildWorkspaceExcludedPath,
  POLICY_PROVEN_READ_ONLY_EXECUTION,
} from './trusted-readonly-environment';
export type {
  BoundaryEnforcement,
  ExecutionBackendCapabilities,
  ExecutionBoundary,
  ExecutionBoundaryAdmission,
  ExecutionBoundaryAdmissionReason,
  ExecutionCapabilitySurface,
  ExecutionNetworkMode,
  FilesystemScope,
  InProcessReadOnlyToolCatalog,
  InProcessReadOnlyToolContract,
  ProductionExecutionEntrypoint,
  ProductionExecutionQualification,
  ProductionExecutionQualificationRegistry,
  ProductionPlatformQualification,
  ProtectedPathPolicy,
  ResourceLimits,
  SandboxUnavailablePolicy,
  ShellFilesystemMode,
  ShellNetworkMode,
} from './types';
export { DEFAULT_RESOURCE_LIMITS } from './types';
export {
  resolveWindowsManagedNetworkSetupStatus,
  setupWindowsManagedNetwork,
  type WindowsManagedNetworkSetupDependencies,
  type WindowsManagedNetworkSetupState,
  type WindowsManagedNetworkSetupStatus,
} from './windows-network-setup';
export {
  clearWindowsSandboxRunnerCache,
  parseWindowsSandboxRunnerManifest,
  type ResolveWindowsSandboxRunnerOptions,
  resolveInstalledWindowsRunnerManifestLocation,
  resolveWindowsSandboxRunner,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsSandboxRunner,
  type WindowsSandboxRunnerManifest,
} from './windows-runner';
