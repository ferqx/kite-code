import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SandboxPreparation } from '@kite/runtime-spi';
import { sandboxCommandDigest } from './execution/grant-authority';
import type { SandboxInvocationIdentity, ShellInput } from './shell-contract';
import {
  buildHostShellInvocations,
  buildPolicyProvenReadOnlyHostShellInvocations,
  resolveShellTimeoutMs,
} from './shell-executor';
import { POLICY_PROVEN_READ_ONLY_EXECUTION } from './trusted-readonly-environment';
import {
  DEFAULT_RESOURCE_LIMITS,
  type ResourceLimits,
  type ShellFilesystemMode,
  type ShellNetworkMode,
} from './types';

export type BuiltinSandboxPreparationErrorCode =
  | 'workspace_unavailable'
  | 'workspace_mismatch'
  | 'shell_unavailable';

export class BuiltinSandboxPreparationError extends Error {
  readonly code: BuiltinSandboxPreparationErrorCode;

  constructor(code: BuiltinSandboxPreparationErrorCode, message: string) {
    super(message);
    this.name = 'BuiltinSandboxPreparationError';
    this.code = code;
  }
}

export interface BuiltinSandboxPreparationInput {
  readonly identity: SandboxInvocationIdentity;
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

export interface BuiltinSandboxPreparationResult {
  readonly canonicalWorkspace: string;
  readonly preparation: SandboxPreparation;
}

/**
 * The sole pure authority for sandbox preparation facts. It performs no
 * lifecycle acknowledgement, provider allocation, persistence, or process
 * execution; those remain injected seams owned by Runtime/App composition.
 */
export function createBuiltinSandboxPreparation(
  input: BuiltinSandboxPreparationInput,
): BuiltinSandboxPreparationResult {
  let canonicalWorkspace: string;
  let invocationWorkspace: string;
  try {
    canonicalWorkspace = realpathSync.native(resolve(input.canonicalWorkspace));
    invocationWorkspace = realpathSync.native(resolve(input.workspace));
  } catch (error) {
    throw new BuiltinSandboxPreparationError(
      'workspace_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (canonicalWorkspace !== invocationWorkspace) {
    throw new BuiltinSandboxPreparationError(
      'workspace_mismatch',
      'Sandbox invocation Workspace mismatch.',
    );
  }

  const candidates =
    input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION
      ? buildPolicyProvenReadOnlyHostShellInvocations(input.command, input.workspace)
      : buildHostShellInvocations(input.command);
  const argv = candidates[0]?.argv;
  if (!argv) {
    throw new BuiltinSandboxPreparationError(
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
    commandDigest: sandboxCommandDigest(argv),
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
