import type { AgentConfig } from '@/core/config';
import type {
  ExecutionBoundaryAdmissionReasonV1,
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  SandboxBackend,
  SandboxRuntime,
} from '@/core/sandbox';

export const EXECUTION_STATUS_CAPABILITIES_V1 = [
  'network',
  'process',
  'write',
  'workspaceWrite',
  'shell',
  'skillChild',
  'localStdioMcp',
  'gitInspect',
] as const;

export type ExecutionStatusCapabilityV1 = (typeof EXECUTION_STATUS_CAPABILITIES_V1)[number];
export type ExecutionWorktreeModeV1 = 'current_checkout' | 'controller_worktree';

export type ExecutionStatusDisabledReasonV1 =
  | Exclude<ExecutionBoundaryAdmissionReasonV1, 'admitted' | 'verified_in_process_read_only'>
  | 'capability_not_admitted'
  | 'controller_ownership_unverified'
  | 'controller_worktree_disabled'
  | 'filesystem_read_only'
  | 'network_off'
  | 'sandbox_unavailable'
  | 'sandbox_verified_read_only_fallback';

type ExecutionBoundaryStatusSourceV1 = Pick<
  ExecutionBoundaryV1,
  | 'filesystemScope'
  | 'networkMode'
  | 'networkAllowlist'
  | 'protectedPathPolicy'
  | 'sandboxUnavailable'
>;

type ExecutionCapabilityStatusSourceV1 = Pick<
  ExecutionCapabilitySurfaceV1,
  ExecutionStatusCapabilityV1
>;

export interface ExecutionStatusProjectionInputV1 {
  /** Runtime-selected backend, not the release-profile request. */
  sandboxBackend: SandboxBackend;
  sandboxAvailable: boolean;
  boundary: ExecutionBoundaryStatusSourceV1;
  capabilitySurface: ExecutionCapabilityStatusSourceV1;
  worktreeMode: ExecutionWorktreeModeV1;
  controllerOwned: boolean;
  capabilityDisabledReasons?: Readonly<
    Partial<Record<ExecutionStatusCapabilityV1, readonly ExecutionStatusDisabledReasonV1[]>>
  >;
  worktreeDisabledReasons?: readonly ExecutionStatusDisabledReasonV1[];
}

export interface ExecutionStatusCapabilityProjectionV1 {
  capability: ExecutionStatusCapabilityV1;
  enabled: boolean;
  disabledReasons: readonly ExecutionStatusDisabledReasonV1[];
}

/**
 * User-facing execution status. It deliberately omits Workspace identity,
 * allowlisted hosts, process limits, qualification proof, and capability
 * catalog details, so it is not a second release profile or model surface.
 */
export interface ExecutionStatusProjectionV1 {
  version: 1;
  sandbox: {
    backend: SandboxBackend;
    available: boolean;
    unavailablePolicy: ExecutionBoundaryV1['sandboxUnavailable'];
    fallbackActive: boolean;
  };
  filesystemScope: ExecutionBoundaryV1['filesystemScope'];
  network: {
    mode: ExecutionBoundaryV1['networkMode'];
    allowlistedHostCount: number;
  };
  protectedPaths: {
    policy: ExecutionBoundaryV1['protectedPathPolicy'];
  };
  controllerWorktree: {
    mode: ExecutionWorktreeModeV1;
    controllerOwned: boolean;
    active: boolean;
    disabledReasons: readonly ExecutionStatusDisabledReasonV1[];
  };
  capabilities: readonly ExecutionStatusCapabilityProjectionV1[];
}

type AdmittedExecutionConfigV1 = AgentConfig & {
  executionBoundary: ExecutionBoundaryV1;
  executionCapabilitySurface: ExecutionCapabilitySurfaceV1;
  productionExecution: { qualificationId: string };
};

export interface ExecutionStatusWorktreeInputV1 {
  mode: ExecutionWorktreeModeV1;
  controllerOwned: boolean;
  disabledReasons?: readonly ExecutionStatusDisabledReasonV1[];
}

/**
 * Presentation-only adapter for a config that has already crossed the Core
 * production admission gate. This function does not grant capabilities.
 */
export function tryProjectAdmittedExecutionStatusV1(input: {
  config: AgentConfig;
  sandboxRuntime: Pick<SandboxRuntime, 'backend' | 'available'>;
  worktree?: ExecutionStatusWorktreeInputV1;
}): ExecutionStatusProjectionV1 | null {
  if (!isAdmittedExecutionConfigV1(input.config)) return null;
  const worktree = input.worktree ?? {
    mode: 'current_checkout' as const,
    controllerOwned: false,
    disabledReasons: ['controller_worktree_disabled'] as const,
  };
  return projectExecutionStatusV1({
    sandboxBackend: input.sandboxRuntime.backend,
    sandboxAvailable: input.sandboxRuntime.available,
    boundary: input.config.executionBoundary,
    capabilitySurface: input.config.executionCapabilitySurface,
    worktreeMode: worktree.mode,
    controllerOwned: worktree.controllerOwned,
    worktreeDisabledReasons: worktree.disabledReasons,
    capabilityDisabledReasons: input.config.executionCapabilitySurface.localStdioMcp
      ? undefined
      : { localStdioMcp: ['feature_disabled'] },
  });
}

export function formatExecutionStatusV1(status: ExecutionStatusProjectionV1): string {
  const capabilities = status.capabilities
    .map(({ capability, enabled, disabledReasons }) =>
      enabled
        ? `  - ${capability}: enabled`
        : `  - ${capability}: disabled (${disabledReasons.join(', ')})`,
    )
    .join('\n');
  const worktreeReasons = status.controllerWorktree.active
    ? ''
    : ` (${status.controllerWorktree.disabledReasons.join(', ')})`;
  return [
    'Execution boundary: admitted',
    `Sandbox: backend=${status.sandbox.backend} available=${yesNo(status.sandbox.available)} fallback=${yesNo(status.sandbox.fallbackActive)} unavailable_policy=${status.sandbox.unavailablePolicy}`,
    `Filesystem: scope=${status.filesystemScope} protected_paths=${status.protectedPaths.policy}`,
    `Network: mode=${status.network.mode} allowlisted_host_count=${status.network.allowlistedHostCount}`,
    `Controller worktree: active=${yesNo(status.controllerWorktree.active)} mode=${status.controllerWorktree.mode}${worktreeReasons}`,
    'Capabilities:',
    capabilities,
  ].join('\n');
}

export function formatUnadmittedExecutionStatusV1(
  sandboxRuntime: Pick<SandboxRuntime, 'backend' | 'available'>,
): string {
  return [
    'Execution boundary: not admitted',
    `Sandbox: backend=${sandboxRuntime.backend} available=${yesNo(sandboxRuntime.available)}`,
    'Filesystem/network/protected-path/worktree/capability status: unavailable until production admission',
  ].join('\n');
}

export function projectExecutionStatusV1(
  input: ExecutionStatusProjectionInputV1,
): ExecutionStatusProjectionV1 {
  const fallbackActive =
    !input.sandboxAvailable &&
    input.boundary.sandboxUnavailable === 'verified_in_process_read_only';
  const controllerWorktreeActive =
    input.worktreeMode === 'controller_worktree' && input.controllerOwned;

  return {
    version: 1,
    sandbox: {
      backend: input.sandboxBackend,
      available: input.sandboxAvailable,
      unavailablePolicy: input.boundary.sandboxUnavailable,
      fallbackActive,
    },
    filesystemScope: input.boundary.filesystemScope,
    network: {
      mode: input.boundary.networkMode,
      allowlistedHostCount:
        input.boundary.networkMode === 'allowlist' ? input.boundary.networkAllowlist.length : 0,
    },
    protectedPaths: {
      policy: input.boundary.protectedPathPolicy,
    },
    controllerWorktree: {
      mode: input.worktreeMode,
      controllerOwned: input.controllerOwned,
      active: controllerWorktreeActive,
      disabledReasons: controllerWorktreeActive
        ? []
        : normalizeReasons([
            ...(input.worktreeDisabledReasons ?? []),
            input.worktreeMode === 'controller_worktree'
              ? 'controller_ownership_unverified'
              : 'controller_worktree_disabled',
          ]),
    },
    capabilities: EXECUTION_STATUS_CAPABILITIES_V1.map((capability) => {
      const enabled = input.capabilitySurface[capability];
      const disabledReasons = [
        ...defaultCapabilityDisabledReasons(input, capability, fallbackActive),
        ...(input.capabilityDisabledReasons?.[capability] ?? []),
      ];
      if (disabledReasons.length === 0) disabledReasons.push('capability_not_admitted');
      return {
        capability,
        enabled,
        disabledReasons: enabled ? [] : normalizeReasons(disabledReasons),
      };
    }),
  };
}

function defaultCapabilityDisabledReasons(
  input: ExecutionStatusProjectionInputV1,
  capability: ExecutionStatusCapabilityV1,
  fallbackActive: boolean,
): ExecutionStatusDisabledReasonV1[] {
  const reasons: ExecutionStatusDisabledReasonV1[] = [];
  if (!input.sandboxAvailable) {
    reasons.push(fallbackActive ? 'sandbox_verified_read_only_fallback' : 'sandbox_unavailable');
  }
  if (capability === 'network' && input.boundary.networkMode === 'off') {
    reasons.push('network_off');
  }
  if (
    (capability === 'write' || capability === 'workspaceWrite') &&
    input.boundary.filesystemScope === 'read_only'
  ) {
    reasons.push('filesystem_read_only');
  }
  return reasons;
}

function normalizeReasons(
  reasons: readonly ExecutionStatusDisabledReasonV1[],
): ExecutionStatusDisabledReasonV1[] {
  return [...new Set(reasons)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAdmittedExecutionConfigV1(config: AgentConfig): config is AdmittedExecutionConfigV1 {
  const productionExecution = (config as AgentConfig & { productionExecution?: unknown })
    .productionExecution;
  return (
    config.executionBoundary !== undefined &&
    config.executionCapabilitySurface !== undefined &&
    typeof productionExecution === 'object' &&
    productionExecution !== null &&
    typeof (productionExecution as { qualificationId?: unknown }).qualificationId === 'string'
  );
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
