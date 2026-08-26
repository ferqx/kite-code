import type {
  ExecutionBoundary,
  ExecutionBoundaryAdmissionReason,
  ExecutionCapabilitySurface,
  SandboxBackend,
  SandboxRuntime,
} from '@kite-ai/builtin-runtime/sandbox';
import type { AgentConfig } from '#kite-cli/config';

export const EXECUTION_STATUS_CAPABILITIES_ = [
  'network',
  'process',
  'write',
  'workspaceWrite',
  'shell',
  'skillChild',
  'localStdioMcp',
  'gitInspect',
] as const;

export type ExecutionStatusCapability = (typeof EXECUTION_STATUS_CAPABILITIES_)[number];
export type ExecutionWorktreeMode = 'current_checkout' | 'controller_worktree';

export type ExecutionStatusDisabledReason =
  | Exclude<ExecutionBoundaryAdmissionReason, 'admitted' | 'verified_in_process_read_only'>
  | 'capability_not_admitted'
  | 'controller_ownership_unverified'
  | 'controller_worktree_disabled'
  | 'filesystem_read_only'
  | 'network_off'
  | 'sandbox_unavailable'
  | 'sandbox_verified_read_only_fallback';

type ExecutionBoundaryStatusSource = Pick<
  ExecutionBoundary,
  | 'filesystemScope'
  | 'networkMode'
  | 'networkAllowlist'
  | 'protectedPathPolicy'
  | 'sandboxUnavailable'
>;

type ExecutionCapabilityStatusSource = Pick<ExecutionCapabilitySurface, ExecutionStatusCapability>;

export interface ExecutionStatusProjectionInput {
  /** Runtime-selected backend, not the release-profile request. */
  sandboxBackend: SandboxBackend;
  sandboxAvailable: boolean;
  boundary: ExecutionBoundaryStatusSource;
  capabilitySurface: ExecutionCapabilityStatusSource;
  worktreeMode: ExecutionWorktreeMode;
  controllerOwned: boolean;
  capabilityDisabledReasons?: Readonly<
    Partial<Record<ExecutionStatusCapability, readonly ExecutionStatusDisabledReason[]>>
  >;
  worktreeDisabledReasons?: readonly ExecutionStatusDisabledReason[];
}

export interface ExecutionStatusCapabilityProjection {
  capability: ExecutionStatusCapability;
  enabled: boolean;
  disabledReasons: readonly ExecutionStatusDisabledReason[];
}

/**
 * User-facing execution status. It deliberately omits Workspace identity,
 * allowlisted hosts, process limits, qualification proof, and capability
 * catalog details, so it is not a second release profile or model surface.
 */
export interface ExecutionStatusProjection {
  version: 1;
  sandbox: {
    backend: SandboxBackend;
    available: boolean;
    unavailablePolicy: ExecutionBoundary['sandboxUnavailable'];
    fallbackActive: boolean;
  };
  filesystemScope: ExecutionBoundary['filesystemScope'];
  network: {
    mode: ExecutionBoundary['networkMode'];
    allowlistedHostCount: number;
  };
  protectedPaths: {
    policy: ExecutionBoundary['protectedPathPolicy'];
  };
  controllerWorktree: {
    mode: ExecutionWorktreeMode;
    controllerOwned: boolean;
    active: boolean;
    disabledReasons: readonly ExecutionStatusDisabledReason[];
  };
  capabilities: readonly ExecutionStatusCapabilityProjection[];
}

type AdmittedExecutionConfig = AgentConfig & {
  executionBoundary: ExecutionBoundary;
  executionCapabilitySurface: ExecutionCapabilitySurface;
  productionExecution: { qualificationId: string };
};

export interface ExecutionStatusWorktreeInput {
  mode: ExecutionWorktreeMode;
  controllerOwned: boolean;
  disabledReasons?: readonly ExecutionStatusDisabledReason[];
}

/**
 * Presentation-only adapter for a config that has already crossed the Core
 * production admission gate. This function does not grant capabilities.
 */
export function tryProjectAdmittedExecutionStatus(input: {
  config: AgentConfig;
  sandboxRuntime: Pick<SandboxRuntime, 'backend' | 'available'>;
  worktree?: ExecutionStatusWorktreeInput;
}): ExecutionStatusProjection | null {
  if (!isAdmittedExecutionConfig(input.config)) return null;
  const worktree = input.worktree ?? {
    mode: 'current_checkout' as const,
    controllerOwned: false,
    disabledReasons: ['controller_worktree_disabled'] as const,
  };
  return projectExecutionStatus({
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

export function formatExecutionStatus(status: ExecutionStatusProjection): string {
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

export function formatUnadmittedExecutionStatus(
  sandboxRuntime: Pick<SandboxRuntime, 'backend' | 'available'>,
): string {
  return [
    'Execution boundary: not admitted',
    `Sandbox: backend=${sandboxRuntime.backend} available=${yesNo(sandboxRuntime.available)}`,
    'Filesystem/network/protected-path/worktree/capability status: unavailable until production admission',
  ].join('\n');
}

export function projectExecutionStatus(
  input: ExecutionStatusProjectionInput,
): ExecutionStatusProjection {
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
    capabilities: EXECUTION_STATUS_CAPABILITIES_.map((capability) => {
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
  input: ExecutionStatusProjectionInput,
  capability: ExecutionStatusCapability,
  fallbackActive: boolean,
): ExecutionStatusDisabledReason[] {
  const reasons: ExecutionStatusDisabledReason[] = [];
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
  reasons: readonly ExecutionStatusDisabledReason[],
): ExecutionStatusDisabledReason[] {
  return [...new Set(reasons)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAdmittedExecutionConfig(config: AgentConfig): config is AdmittedExecutionConfig {
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
