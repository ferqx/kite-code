import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SandboxPreparationV1 } from '@kite/runtime-spi';
import { checkDangerousPaths } from './dangerous-paths';
import { sandboxCommandDigestV1 } from './execution/grant-authority';
import type { SandboxInvocationIdentityV1, ShellInput } from './shell-contract';
import {
  buildHostShellInvocationsV1,
  buildPolicyProvenReadOnlyHostShellInvocationsV1,
  resolveShellTimeoutMs,
} from './shell-executor';
import { POLICY_PROVEN_READ_ONLY_EXECUTION } from './trusted-readonly-environment';
import {
  DEFAULT_RESOURCE_LIMITS,
  type ResourceLimits,
  type ShellFilesystemMode,
  type ShellNetworkMode,
} from './types';

export type BuiltinSandboxPreparationErrorCodeV1 =
  | 'workspace_unavailable'
  | 'workspace_mismatch'
  | 'protected_path'
  | 'shell_unavailable';

export class BuiltinSandboxPreparationErrorV1 extends Error {
  readonly code: BuiltinSandboxPreparationErrorCodeV1;

  constructor(code: BuiltinSandboxPreparationErrorCodeV1, message: string) {
    super(message);
    this.name = 'BuiltinSandboxPreparationErrorV1';
    this.code = code;
  }
}

export interface BuiltinSandboxPreparationInputV1 {
  readonly identity: SandboxInvocationIdentityV1;
  readonly canonicalWorkspace: string;
  readonly workspace: string;
  readonly command: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly filesystemMode?: ShellFilesystemMode;
  readonly networkMode?: ShellNetworkMode;
  readonly executionTrust?: ShellInput['executionTrust'];
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<ResourceLimits>;
  readonly timeoutMs?: number;
}

export interface BuiltinSandboxPreparationResultV1 {
  readonly canonicalWorkspace: string;
  readonly preparation: SandboxPreparationV1;
}

/**
 * The sole pure authority for sandbox preparation facts. It performs no
 * lifecycle acknowledgement, provider allocation, persistence, or process
 * execution; those remain injected seams owned by Runtime/App composition.
 */
export function createBuiltinSandboxPreparationV1(
  input: BuiltinSandboxPreparationInputV1,
): BuiltinSandboxPreparationResultV1 {
  let canonicalWorkspace: string;
  let invocationWorkspace: string;
  try {
    canonicalWorkspace = realpathSync.native(resolve(input.canonicalWorkspace));
    invocationWorkspace = realpathSync.native(resolve(input.workspace));
  } catch (error) {
    throw new BuiltinSandboxPreparationErrorV1(
      'workspace_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (canonicalWorkspace !== invocationWorkspace) {
    throw new BuiltinSandboxPreparationErrorV1(
      'workspace_mismatch',
      'Sandbox invocation Workspace mismatch.',
    );
  }

  const deniedPath = checkDangerousPaths(input.command);
  if (deniedPath) {
    throw new BuiltinSandboxPreparationErrorV1(
      'protected_path',
      `Rejected: command references protected path '${deniedPath}'`,
    );
  }

  const candidates =
    input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION
      ? buildPolicyProvenReadOnlyHostShellInvocationsV1(input.command, input.workspace)
      : buildHostShellInvocationsV1(input.command);
  const argv = candidates[0]?.argv;
  if (!argv) {
    throw new BuiltinSandboxPreparationErrorV1(
      'shell_unavailable',
      'No trusted shell interpreter is available.',
    );
  }

  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...input.resourceLimits };
  const preparation = deepFreeze({
    schema: 'kite.sandbox-execution-provider.v1' as const,
    toolCallId: input.identity.toolCallId,
    capabilityId: input.identity.capabilityId,
    capabilityRevision: input.identity.capabilityRevision,
    invocationId: input.identity.invocationId,
    attempt: input.identity.attempt,
    effectiveEffectsDigest: input.identity.effectiveEffectsDigest,
    admissionDigest: input.identity.admissionDigest,
    canonicalWorkspace,
    argv: Object.freeze([...argv]),
    commandDigest: sandboxCommandDigestV1(argv),
    executionBoundaryDigest: input.executionBoundaryDigest,
    protectedPathRevision: input.protectedPathRevision,
    filesystemMode: input.filesystemMode ?? 'workspace_only',
    networkMode: input.networkMode ?? 'disabled',
    executionTrust:
      input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION
        ? POLICY_PROVEN_READ_ONLY_EXECUTION
        : null,
    resourceLimits: {
      ...limits,
      maxProcessTreeTasks: input.maxProcessTreeTasks ?? null,
    },
    timeoutMs: resolveShellTimeoutMs(input.timeoutMs),
    cancellationCorrelation: input.identity.cancellationCorrelation,
  });
  return Object.freeze({ canonicalWorkspace, preparation });
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}
