import type { SandboxBackend } from './platform';

/** Legacy per-shell network switch used by the current development executor. */
export type ShellNetworkMode = 'disabled' | 'allow_all';

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
export interface ExecutionBackendCapabilitiesV1 {
  backend: SandboxBackend;
  filesystem: Readonly<Record<FilesystemScope, BoundaryEnforcementV1>>;
  network: Readonly<Record<ExecutionNetworkMode, BoundaryEnforcementV1>>;
  /** Required for bubblewrap; Seatbelt has a separate policy mechanism. */
  syscallFilter: BoundaryEnforcementV1;
  processTreeLimit: BoundaryEnforcementV1;
  childProcessInheritance: BoundaryEnforcementV1;
  verifiedInProcessReadOnly: BoundaryEnforcementV1;
}

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
  };
}

/** 沙箱执行器配置 / Sandbox executor configuration */
export interface SandboxOptions {
  /** 启用沙箱；false 时回退到裸 shellTool / Enable sandbox; fall back to bare shellTool when false */
  enabled: boolean;
  /** 工作目录路径 / Workspace directory path */
  workspace: string;
  /** Native filesystem ceiling. full_access is never a sandbox profile. */
  filesystemScope?: Exclude<FilesystemScope, 'full_access'>;
  /** App composition may opt into host Shell availability; it is never sandbox qualification. */
  unavailableFallback?: 'bare_shell' | 'fail';
  /** Optional non-UI diagnostic sink. Omitted callers stay silent. */
  onDiagnostic?: (message: string) => void;
  /** Explicit executable/runtime roots that the native profile may read but never write. */
  runtimeReadOnlyRoots?: readonly string[];
  /** 自定义资源限制（覆盖默认值）/ Custom resource limits (overrides defaults) */
  resourceLimits?: Partial<ResourceLimits>;
  /** Release-owned cgroup-v2 task ceiling for the complete invocation tree. */
  maxProcessTreeTasks?: number;
  /** Internal Windows direct-token startup probe; never creates staging. */
  startupProbe?: boolean;
  /** Trusted composition selection; avoids redetecting after asynchronous preflight. */
  selectedBackend?: SandboxBackend;
  /** Network access policy inside the sandbox. Defaults to disabled. */
  network?: {
    mode: ShellNetworkMode;
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
