import type { ExecutionBackendCapabilitiesV1 } from '@/protocol/sandbox-execution-provider';
import type { SandboxBackend } from './platform';

export type { ExecutionBackendCapabilitiesV1 } from '@/protocol/sandbox-execution-provider';

/** Legacy per-shell network switch used by the current development executor. */
export type ShellNetworkMode = 'disabled' | 'allow_all';

/** Per-invocation native-sandbox filesystem scope selected after approval. */
export type ShellFilesystemMode = 'workspace_only' | 'allow_all';

/** Filesystem authority carried by the release-pinned execution boundary. */
export type FilesystemScope = 'read_only' | 'workspace_write' | 'full_access';

/** Network authority carried by the release-pinned execution boundary. */
export type ExecutionNetworkMode = 'off' | 'allowlist';

export type ProtectedPathPolicy = 'deny' | 'prompt';
export type SandboxUnavailablePolicy = 'fail' | 'verified_in_process_read_only';

/**
 * Release-pinned execution boundary. User/project/CLI configuration may only
 * consume a resolved boundary; it cannot manufacture or widen one.
 */
export interface ExecutionBoundaryV1 {
  filesystemScope: FilesystemScope;
  /** Canonical realpath shared with Workspace Trust identity. */
  workspaceRoot: string;
  networkMode: ExecutionNetworkMode;
  /** Exact host allowlist. Empty when networkMode is off. */
  networkAllowlist: string[];
  /** Local/private destinations are never configurable in V1. */
  allowLocalAndPrivateNetwork: false;
  protectedPathPolicy: ProtectedPathPolicy;
  /** Complete shell process tree, not top-level invocation concurrency. */
  maxProcessTreeSizePerShellInvocation: number;
  sandboxRequired: boolean;
  sandboxUnavailable: SandboxUnavailablePolicy;
}

export type BoundaryEnforcementV1 = 'enforced' | 'unsupported';

/**
 * Concrete backend strength. This intentionally cannot be reduced to a
 * sandboxAvailable boolean: every production-relevant dimension is explicit.
 */
export type ProductionPlatformQualificationV1 = 'supported' | 'read_only_only' | 'excluded';

export type ProductionExecutionEntrypointV1 = 'tui' | 'foreground_cli';

export interface InProcessReadOnlyToolContractV1 {
  toolId: string;
  descriptorRevision: string;
  filesystem: 'workspace_read';
  network: 'none';
  process: false;
  write: false;
  externalPath: false;
}

export interface InProcessReadOnlyToolCatalogV1 {
  version: 1;
  revision: string;
  digest: string;
  tools: readonly InProcessReadOnlyToolContractV1[];
}

/** Release-gate output pinned to native evidence and one exact environment. */
export interface ProductionExecutionQualificationV1 {
  version: 1;
  qualificationId: string;
  decisionId: 'D-04';
  outcome: Exclude<ProductionPlatformQualificationV1, 'excluded'>;
  platform: 'darwin' | 'linux' | 'win32';
  osRelease: string;
  osVersion: string;
  arch: string;
  bunVersion: string;
  backend: SandboxBackend;
  selectedNetworkMode: ExecutionNetworkMode;
  entrypoints: readonly ProductionExecutionEntrypointV1[];
  evidenceDigest: string;
  evidenceCommit: string;
  backendCapabilities: ExecutionBackendCapabilitiesV1;
  /** Exact process-backed capabilities admitted by this native evidence. */
  processCapabilitySurface: {
    shell: boolean;
    skillChild: boolean;
    localStdioMcp: boolean;
    /** Optional brokered-Git qualification; absence means both Git axes are excluded. */
    brokeredGit?: {
      featureRevision: typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1;
      inspect: boolean;
      shellDenyEvidence: import('@/protocol/git').GitShellDenyEvidenceV1;
    };
  };
  inProcessReadOnlyTools: InProcessReadOnlyToolCatalogV1;
}

export interface ProductionExecutionQualificationRegistryV1 {
  version: 1;
  decisionId: 'D-04';
  revision: string;
  status: 'accepted_empty_support_set' | 'accepted_non_empty_support_set';
  selectedNetworkMode: ExecutionNetworkMode;
  evidenceCommit: string;
  digest: string;
  qualifications: readonly ProductionExecutionQualificationV1[];
}

export interface ExecutionCapabilitySurfaceV1 {
  /** Full catalog identity/effect contract; tool IDs alone are not sufficient evidence. */
  inProcessReadOnlyTools: InProcessReadOnlyToolCatalogV1 | null;
  network: boolean;
  process: boolean;
  write: boolean;
  workspaceWrite: boolean;
  shell: boolean;
  skillChild: boolean;
  localStdioMcp: boolean;
  /** App-owned typed Git broker axes; generic process/read/write never imply them. */
  gitInspect: boolean;
  /** Disclosure, dispatch and native shell metadata deny must match this exact revision. */
  brokeredGitFeatureRevision:
    | typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1
    | null;
}

export type ExecutionBoundaryAdmissionReasonV1 =
  | 'admitted'
  | 'verified_in_process_read_only'
  | 'feature_disabled'
  | 'boundary_missing'
  | 'boundary_invalid'
  | 'workspace_mismatch'
  | 'platform_excluded'
  | 'approved_qualification_unavailable'
  | 'qualification_environment_mismatch'
  | 'qualification_boundary_mismatch'
  | 'sandbox_disabled'
  | 'full_access_not_qualified'
  | 'platform_read_only_only'
  | 'sandbox_required'
  | 'backend_filesystem_unsupported'
  | 'backend_network_unsupported'
  | 'backend_syscall_filter_unsupported'
  | 'backend_process_tree_unsupported'
  | 'backend_child_inheritance_unsupported'
  | 'read_only_fallback_unverified';

export interface ExecutionBoundaryAdmissionV1 {
  allowed: boolean;
  admissionKind: 'denied' | 'technical_evaluation' | 'release_approved';
  reason: ExecutionBoundaryAdmissionReasonV1;
  boundary?: ExecutionBoundaryV1;
  workspaceKey?: string;
  surface: ExecutionCapabilitySurfaceV1;
  qualificationProof?: {
    registryRevision: string;
    registryDigest: string;
    qualificationId: string;
    evidenceDigest: string;
    brokeredGitShellDenyEvidence?: import('@/protocol/git').GitShellDenyEvidenceV1;
  };
}

/** shell 执行资源限制 / Shell execution resource limits */
export interface ResourceLimits {
  /** CPU 时间上限（秒）/ CPU time limit (seconds) */
  cpuTime: number;
  /** 虚拟内存上限（KB）/ Virtual memory limit (KB) */
  virtualMemory: number;
  /** 单文件写入大小上限（KB）/ File size limit (KB) */
  fileSize: number;
  /** 文件描述符上限 / File descriptor limit */
  fileDescriptors: number;
  /** 进程数上限 / Process count limit */
  processes: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuTime: 120,
  virtualMemory: -1, // macOS 不支持；0/负值表示跳过 / not supported on macOS; skip
  fileSize: 1048576, // 512MB (macOS blocks = 512 bytes)
  fileDescriptors: 256,
  processes: -1, // sandbox 内不可靠 / unreliable inside sandbox; skip
};
