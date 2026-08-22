import type { BuiltinWorkspaceFilesystemInvocationDispatcherV1 } from '@kite/builtin-runtime/filesystem';
import {
  type BuiltinGitExecutionMechanismV1,
  type BuiltinMechanismRecordV1,
  type BuiltinShellExecutionResultV1,
  isReadOnlyShellCommandV1,
  mergeBuiltinMechanismBundleV1,
} from '#builtin-runtime';
import type {
  CapabilityExecutionMechanismV1,
  CapabilityPolicyEffectsV1,
  GitInspectRequestV1,
  RuntimeJsonValueV1,
  WorkspaceFilesystemOperationV1,
} from '#runtime-spi';

export type AppBuiltinMechanismGrantUsedV1 =
  | 'none'
  | 'approve_once'
  | 'same_command'
  | 'full_access';

export interface AppBuiltinShellExecutorInputV1 {
  readonly workspace: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly readOnly: boolean;
  readonly networkAccess: 'none' | 'approved';
  readonly filesystemAccess: 'workspace_only' | 'external_read' | 'approved_external';
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface AppBuiltinShellExecutorV1 {
  readonly execute: (
    input: Readonly<AppBuiltinShellExecutorInputV1>,
  ) => Promise<Readonly<BuiltinShellExecutionResultV1>>;
}

export interface AppBuiltinPreassembledMechanismResolverInputV1 {
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly workspace: string;
  readonly canonicalArguments: Readonly<RuntimeJsonValueV1>;
  readonly grantUsed: AppBuiltinMechanismGrantUsedV1;
  /** Optional for legacy policy-allow calls; mandatory for approve_once. */
  readonly authorizationKind?: 'policy_allow' | 'approved_call';
  readonly policyEffects: Readonly<CapabilityPolicyEffectsV1>;
  readonly signal: AbortSignal;
  readonly filesystemRuntime?: Readonly<BuiltinWorkspaceFilesystemInvocationDispatcherV1>;
  readonly gitBroker?: Readonly<BuiltinGitExecutionMechanismV1>;
  readonly shellExecutor?: Readonly<AppBuiltinShellExecutorV1>;
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** One exact wrapper for web, MCP, Skill, or planning. */
  readonly preassembledMechanism?: BuiltinMechanismRecordV1;
}

export type AppBuiltinMechanismResolverV1 = (
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
) => BuiltinMechanismRecordV1;

export type AppBuiltinMechanismResolverFailureCodeV1 =
  | 'invalid_facts'
  | 'mechanism_missing'
  | 'mechanism_wrapper_invalid'
  | 'unsupported_mechanism'
  | 'filesystem_path_invalid'
  | 'signal_aborted';

export class AppBuiltinMechanismResolverErrorV1 extends Error {
  readonly code: AppBuiltinMechanismResolverFailureCodeV1;

  constructor(code: AppBuiltinMechanismResolverFailureCodeV1) {
    super(`Builtin mechanism resolver failed closed: ${code}.`);
    this.name = 'AppBuiltinMechanismResolverErrorV1';
    this.code = code;
  }
}

/**
 * Create the App-only mechanism resolver. The returned function consumes
 * already-canonical, already-authorized facts and contributes only the one
 * mechanism map required by the selected Builtin operation.
 */
export function createAppBuiltinMechanismResolverV1(): AppBuiltinMechanismResolverV1 {
  return (input) => resolveBuiltinMechanismsV1(input);
}

function resolveBuiltinMechanismsV1(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
): BuiltinMechanismRecordV1 {
  assertFactsV1(input);

  switch (input.executionMechanism) {
    case 'catalog':
      if (input.preassembledMechanism !== undefined) failV1('mechanism_wrapper_invalid');
      return mergeBuiltinMechanismBundleV1({ executionMechanism: 'catalog' });
    case 'filesystem':
      return filesystemMechanismV1(input);
    case 'git':
      return gitMechanismV1(input);
    case 'shell':
      return shellMechanismV1(input);
    case 'web':
    case 'mcp':
    case 'skill':
    case 'planning':
      return preassembledMechanismV1(input);
    case 'subagent':
    case 'user_input':
    case 'model':
    case 'verification':
      failV1('unsupported_mechanism');
  }
}

function filesystemMechanismV1(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
): BuiltinMechanismRecordV1 {
  if (input.preassembledMechanism !== undefined || !input.filesystemRuntime) {
    failV1('mechanism_missing');
  }
  const externalReadAllowed =
    input.policyEffects.externalRead === true && input.policyEffects.externalWrite !== true;
  const externalWriteAllowed =
    input.policyEffects.externalWrite === true && input.grantUsed !== 'none';
  const allowExternalPaths = externalReadAllowed || externalWriteAllowed;
  const mechanism = Object.freeze({
    allowExternalPaths,
    dispatch: async (operation: WorkspaceFilesystemOperationV1) => {
      const scoped = scopeFilesystemOperationV1(operation, {
        externalReadAllowed,
        externalWriteAllowed,
      });
      return input.filesystemRuntime!.dispatch(scoped);
    },
  });
  return mergeBuiltinMechanismBundleV1({
    executionMechanism: 'filesystem',
    prepared: Object.freeze({ filesystem: mechanism }),
  });
}

function scopeFilesystemOperationV1(
  operation: WorkspaceFilesystemOperationV1,
  policy: Readonly<{
    readonly externalReadAllowed: boolean;
    readonly externalWriteAllowed: boolean;
  }>,
): WorkspaceFilesystemOperationV1 {
  if (
    !operation ||
    typeof operation !== 'object' ||
    typeof operation.path !== 'string' ||
    operation.path.length === 0 ||
    operation.path.length > 16_384 ||
    /\p{Cc}/u.test(operation.path)
  ) {
    failV1('filesystem_path_invalid');
  }
  const mutation = operation.kind === 'write_file' || operation.kind === 'edit_file';
  const pathScope = mutation
    ? policy.externalWriteAllowed
      ? 'approved_external'
      : 'workspace_only'
    : policy.externalReadAllowed
      ? 'external_read'
      : 'workspace_only';
  // App only binds the already-authorized scope. Raw lexical bytes must reach
  // the Builtin filesystem owner unchanged; the Provider alone resolves and
  // canonicalizes the target under the protected boundary.
  return Object.freeze({ ...operation, pathScope });
}

function gitMechanismV1(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
): BuiltinMechanismRecordV1 {
  if (input.preassembledMechanism !== undefined || !input.gitBroker) {
    failV1('mechanism_missing');
  }
  const broker = input.gitBroker;
  const mechanism = Object.freeze({
    inspect: (request: GitInspectRequestV1, signal?: AbortSignal) =>
      broker.inspect(request, signal ?? input.signal),
  });
  return mergeBuiltinMechanismBundleV1({
    executionMechanism: 'git',
    prepared: Object.freeze({ git: mechanism }),
  });
}

function shellMechanismV1(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
): BuiltinMechanismRecordV1 {
  if (input.preassembledMechanism !== undefined || !input.shellExecutor) {
    failV1('mechanism_missing');
  }
  const command = recordStringV1(input.canonicalArguments, 'command');
  const readOnly = isReadOnlyShellCommandV1(command);
  // Preserve the accepted State26 grant semantics: any durable Shell grant
  // authorizes the already-governed network mode. App does not reinterpret
  // the command or narrow a Builtin policy compilation a second time.
  const networkAccess = input.grantUsed !== 'none' ? 'approved' : 'none';
  const externalFilesystem = Boolean(
    input.policyEffects.externalRead ||
      input.policyEffects.externalWrite ||
      input.policyEffects.uncertainEffects,
  );
  const filesystemAccess =
    externalFilesystem && input.grantUsed !== 'none' ? 'approved_external' : 'workspace_only';
  const executor = input.shellExecutor;
  const mechanism = Object.freeze({
    execute: (shellInput: Readonly<{ command: string; timeoutMs: number }>) => {
      if (input.signal.aborted) failV1('signal_aborted');
      if (
        typeof shellInput.command !== 'string' ||
        shellInput.command !== command ||
        !Number.isSafeInteger(shellInput.timeoutMs) ||
        shellInput.timeoutMs <= 0
      ) {
        failV1('invalid_facts');
      }
      return executor.execute({
        workspace: input.workspace,
        command: shellInput.command,
        timeoutMs: shellInput.timeoutMs,
        signal: input.signal,
        readOnly,
        networkAccess,
        filesystemAccess,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
    },
  });
  return mergeBuiltinMechanismBundleV1({
    executionMechanism: 'shell',
    prepared: Object.freeze({ shell: mechanism }),
  });
}

function preassembledMechanismV1(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>,
): BuiltinMechanismRecordV1 {
  if (!input.preassembledMechanism) failV1('mechanism_missing');
  try {
    return mergeBuiltinMechanismBundleV1({
      executionMechanism: input.executionMechanism,
      prepared: input.preassembledMechanism,
    });
  } catch {
    failV1('mechanism_wrapper_invalid');
  }
}

function assertFactsV1(input: Readonly<AppBuiltinPreassembledMechanismResolverInputV1>): void {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.workspace !== 'string' ||
    input.workspace.length === 0 ||
    !input.signal ||
    typeof input.signal.aborted !== 'boolean' ||
    typeof input.signal.addEventListener !== 'function' ||
    !['none', 'approve_once', 'same_command', 'full_access'].includes(input.grantUsed)
  ) {
    failV1('invalid_facts');
  }
  if (
    input.authorizationKind !== undefined &&
    input.authorizationKind !== 'policy_allow' &&
    input.authorizationKind !== 'approved_call'
  ) {
    failV1('invalid_facts');
  }
  if (input.grantUsed === 'approve_once' && input.authorizationKind !== 'approved_call') {
    failV1('invalid_facts');
  }
  assertFrozenJsonV1(input.canonicalArguments, 'canonical arguments');
  if (!input.policyEffects || !Object.isFrozen(input.policyEffects)) {
    failV1('invalid_facts');
  }
  if (input.preassembledMechanism !== undefined) {
    if (
      !Object.isFrozen(input.preassembledMechanism) ||
      Array.isArray(input.preassembledMechanism)
    ) {
      failV1('mechanism_wrapper_invalid');
    }
  }
}

function assertFrozenJsonV1(value: unknown, label: string): asserts value is RuntimeJsonValueV1 {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) failV1('invalid_facts');
      return;
    }
    if (typeof candidate !== 'object' || !Object.isFrozen(candidate) || seen.has(candidate)) {
      failV1('invalid_facts');
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) failV1('invalid_facts');
      for (const item of Object.values(candidate)) visit(item);
    }
    seen.delete(candidate);
  };
  try {
    visit(value);
  } catch (error) {
    if (error instanceof AppBuiltinMechanismResolverErrorV1) throw error;
    throw new AppBuiltinMechanismResolverErrorV1('invalid_facts');
  }
  void label;
}

function recordStringV1(value: RuntimeJsonValueV1, key: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failV1('invalid_facts');
  }
  const record = value as { readonly [key: string]: RuntimeJsonValueV1 };
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    failV1('invalid_facts');
  }
  return record[key] as string;
}

function failV1(code: AppBuiltinMechanismResolverFailureCodeV1): never {
  throw new AppBuiltinMechanismResolverErrorV1(code);
}
