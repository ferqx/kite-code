import type { ReleaseCompositionV1 } from './composition-root';
import type { ExecutionStatusProjectionV1 } from './execution-status';

export interface ReleaseStatusProjectionV1 {
  version: 1;
  active: boolean;
  production: boolean;
  inactiveReason?: string;
  profile?: {
    id: string;
    channel: string;
  };
  capabilities: Array<{
    capability: string;
    maturity: string;
    rollout: string;
    enabled: boolean;
    disabledReasons: string[];
  }>;
  execution: {
    admitted: boolean;
    sandboxBackend?: string;
    filesystemScope?: string;
    networkMode?: string;
    controllerWorktreeActive?: boolean;
  };
  logging?: { defaultMode: string; contentOptInAllowed: boolean };
  telemetry?: { allowed: boolean };
  data?: { providerRouteCount: number; remoteMcpContentEgress: boolean };
  verification?: { requirement: string };
}

/** User-facing, non-model status projection with no paths, route names, or cohort identity. */
export function projectReleaseStatusV1(input: {
  composition: ReleaseCompositionV1;
  executionStatus?: ExecutionStatusProjectionV1 | null;
}): ReleaseStatusProjectionV1 {
  const execution = input.executionStatus
    ? {
        admitted: true,
        sandboxBackend: input.executionStatus.sandbox.backend,
        filesystemScope: input.executionStatus.filesystemScope,
        networkMode: input.executionStatus.network.mode,
        controllerWorktreeActive: input.executionStatus.controllerWorktree.active,
      }
    : { admitted: false };
  if (!input.composition.active) {
    return {
      version: 1,
      active: false,
      production: input.composition.production,
      inactiveReason: input.composition.reason,
      capabilities: [],
      execution,
    };
  }
  const profile = input.composition.profile;
  return {
    version: 1,
    active: true,
    production: input.composition.production,
    profile: { id: profile.profileId, channel: profile.channel },
    capabilities: Object.entries(profile.capabilities).map(([capability, state]) => ({
      capability,
      maturity: state.maturity,
      rollout: state.maxRollout,
      enabled: state.maxRollout !== 'off',
      disabledReasons: state.maxRollout === 'off' ? ['release_rollout_off'] : [],
    })),
    execution,
    logging: {
      defaultMode: profile.logging.defaultMode,
      contentOptInAllowed: profile.logging.allowContentOptIn,
    },
    telemetry: { allowed: profile.telemetry.allowed },
    data: {
      providerRouteCount: profile.data.providerRouteAllowlist.length,
      remoteMcpContentEgress: profile.data.allowRemoteMcpContentEgress,
    },
    verification: { requirement: profile.requirements.minimumVerification },
  };
}

export function formatReleaseStatusV1(status: ReleaseStatusProjectionV1): string {
  if (!status.active) {
    return [
      `Release control: inactive (${status.inactiveReason ?? 'unknown'})`,
      `Production artifact: ${status.production ? 'requested but not admitted' : 'no'}`,
      `Execution admission: ${status.execution.admitted ? 'admitted' : 'not admitted'}`,
      'Capabilities: unavailable until artifact and rollout admission',
    ].join('\n');
  }
  const capabilities = status.capabilities
    .map((entry) =>
      entry.enabled
        ? `  - ${entry.capability}: ${entry.maturity}/${entry.rollout}`
        : `  - ${entry.capability}: disabled (${entry.disabledReasons.join(', ')})`,
    )
    .join('\n');
  return [
    `Release control: active profile=${status.profile?.id} channel=${status.profile?.channel}`,
    `Production artifact: ${status.production ? 'yes' : 'no'}`,
    `Execution admission: ${status.execution.admitted ? 'admitted' : 'not admitted'}`,
    `Logging: default=${status.logging?.defaultMode} content_opt_in=${yesNo(status.logging?.contentOptInAllowed)}`,
    `Telemetry: allowed=${yesNo(status.telemetry?.allowed)}`,
    `Data routes: admitted_count=${status.data?.providerRouteCount ?? 0} remote_mcp_content=${yesNo(status.data?.remoteMcpContentEgress)}`,
    `Verification: ${status.verification?.requirement}`,
    'Capabilities:',
    capabilities,
  ].join('\n');
}

function yesNo(value: boolean | undefined): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
