import { isAbsolute, resolve } from 'node:path';
import {
  expandHomeRelativePath,
  isDescriptorAdmittedByExecutionCapabilitySurface,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
  networkBoundaryPolicyFromExecutionBoundary,
} from '@kite-ai/builtin-runtime/sandbox';
import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import type { CapabilityPolicyRecovery } from '@kite-ai/runtime-spi';
import type { RuntimeEvent } from '#app/bootstrap/runtime/state-runtime';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';

export function productionExecutionSurfaceFailure(input: {
  readonly config: AgentConfig | undefined;
  readonly workspace: string;
  readonly descriptor: Readonly<CapabilityDescriptor> | undefined;
  readonly executionMechanism: string;
  readonly rawArguments: unknown;
}): string | null {
  const config = input.config;
  if (!config) return null;
  const surface = config.executionCapabilitySurface;
  if ('productionExecution' in config && (!config.executionBoundary || !surface)) {
    return 'Rejected by production execution boundary: protected-path gate is unavailable.';
  }
  if (!surface) return null;
  if (!input.descriptor) {
    return 'Rejected by production execution boundary: capability descriptor is unavailable.';
  }

  const argumentsRecord = isPlainRecord(input.rawArguments) ? input.rawArguments : undefined;
  const pathArgument = typeof argumentsRecord?.path === 'string' ? argumentsRecord.path : '';
  const outsideWorkspace = pathArgument
    ? isOutsideProductionWorkspace(input.workspace, pathArgument)
    : false;
  if (
    (outsideWorkspace && input.executionMechanism !== 'filesystem') ||
    !isDescriptorAdmittedByExecutionCapabilitySurface({ surface, descriptor: input.descriptor })
  ) {
    const reason =
      surface.process === false && surface.write === false
        ? 'tool is not in the sealed read-only catalog'
        : 'capability is outside the admitted execution surface';
    return `Rejected by production execution boundary: ${reason}.`;
  }
  return null;
}

function isOutsideProductionWorkspace(workspace: string, pathArgument: string): boolean {
  const normalized = expandHomeRelativePath(msys2ToWindowsPath(pathArgument));
  const target = isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
  return !isPathInsideWorkspace(workspace, target);
}

export function sealedMcpNetworkTerminal(input: {
  readonly config: AgentConfig | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
}): RuntimeEvent | null {
  const boundary = input.config?.executionBoundary;
  if (!boundary) return null;
  const policy = networkBoundaryPolicyFromExecutionBoundary(
    boundary,
    getFeatureFlags(input.config).networkBoundary === true,
  );
  const message =
    'MCP execution is unavailable under the sealed network boundary until its transport uses per-invocation endpoint admission.';
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.toolName,
    result: {
      ok: false,
      command: input.toolName,
      exitCode: -1,
      stdout: '',
      stderr: message,
      status: 'error',
      resultMeta: {
        networkPolicyRevision: policy.revision,
        networkAdmissionDigests: [],
        networkFailureCode: 'controller_unavailable',
      },
    },
    classifierAdvice: {
      detailCode: 'controller_unavailable',
      disposition: 'never',
      maximumAdditionalCalls: 0,
      safeAutomaticRetry: false,
    },
  };
}

export function policyRecoveryTerminal(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArguments: unknown;
  readonly reason: string;
  readonly recovery: Readonly<CapabilityPolicyRecovery>;
}): RuntimeEvent {
  const argumentsRecord = isPlainRecord(input.rawArguments) ? input.rawArguments : undefined;
  const command =
    typeof argumentsRecord?.command === 'string' ? argumentsRecord.command : input.toolName;
  const nextCapability =
    input.recovery.capabilityIntent === 'git_inspect' ? ('git_inspect' as const) : undefined;
  const disposition =
    input.recovery.disposition === 'never'
      ? ('never' as const)
      : input.recovery.disposition === 'retry'
        ? ('retry_once' as const)
        : input.recovery.disposition === 'redirect'
          ? ('alternative' as const)
          : ('user_action' as const);
  const maximumAdditionalCalls = input.recovery.maximumAdditionalCalls === 1 ? 1 : 0;
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.toolName,
    result: {
      ok: false,
      command,
      exitCode: -1,
      stdout: '',
      stderr: input.reason,
      status: 'error',
      ...(nextCapability ? { resultMeta: { nextCapability } } : {}),
    },
    classifierAdvice: {
      disposition,
      maximumAdditionalCalls,
      safeAutomaticRetry: input.recovery.safeAutomaticRetry,
      ...(input.recovery.capabilityIntent
        ? { capabilityIntent: input.recovery.capabilityIntent }
        : {}),
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
