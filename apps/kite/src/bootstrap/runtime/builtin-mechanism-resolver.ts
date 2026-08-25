import type { BuiltinWorkspaceFilesystemInvocationDispatcher } from '@kite/builtin-runtime/filesystem';
import {
  type BuiltinGitExecutionMechanism,
  type BuiltinMechanismRecord,
  type BuiltinShellExecutionResult,
  isReadOnlyShellCommand,
  mergeBuiltinMechanismBundle,
} from '#builtin-runtime';
import type {
  CapabilityExecutionMechanism,
  CapabilityPolicyEffects,
  CapabilitySandboxScopeFact,
  GitInspectRequest,
  RuntimeJsonValue,
  WorkspaceFilesystemOperation,
} from '#runtime-spi';

export type AppBuiltinMechanismGrantUsed = 'none' | 'approve_once' | 'same_command';

export interface AppBuiltinShellExecutorInput {
  readonly workspace: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly readOnly: boolean;
  readonly networkAccess: 'none' | 'approved';
  readonly filesystemAccess: 'workspace_only' | 'external_read' | 'approved_external';
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface AppBuiltinShellExecutor {
  readonly execute: (
    input: Readonly<AppBuiltinShellExecutorInput>,
  ) => Promise<Readonly<BuiltinShellExecutionResult>>;
}

export interface AppBuiltinPreassembledMechanismResolverInput {
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly workspace: string;
  readonly canonicalArguments: Readonly<RuntimeJsonValue>;
  readonly grantUsed: AppBuiltinMechanismGrantUsed;
  readonly interactionMode: 'auto' | 'accept_edits' | 'full';
  readonly sandboxScope: Readonly<CapabilitySandboxScopeFact> | null;
  /** Optional for legacy policy-allow calls; mandatory for approve_once. */
  readonly authorizationKind?: 'policy_allow' | 'approved_call';
  readonly policyEffects: Readonly<CapabilityPolicyEffects>;
  readonly signal: AbortSignal;
  readonly filesystemRuntime?: Readonly<BuiltinWorkspaceFilesystemInvocationDispatcher>;
  readonly gitBroker?: Readonly<BuiltinGitExecutionMechanism>;
  readonly shellExecutor?: Readonly<AppBuiltinShellExecutor>;
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** One exact wrapper for web, MCP, Skill, or planning. */
  readonly preassembledMechanism?: BuiltinMechanismRecord;
}

export type AppBuiltinMechanismResolver = (
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
) => BuiltinMechanismRecord;

export type AppBuiltinMechanismResolverFailureCode =
  | 'invalid_facts'
  | 'mechanism_missing'
  | 'mechanism_wrapper_invalid'
  | 'unsupported_mechanism'
  | 'filesystem_path_invalid'
  | 'signal_aborted';

export class AppBuiltinMechanismResolverError extends Error {
  readonly code: AppBuiltinMechanismResolverFailureCode;

  constructor(code: AppBuiltinMechanismResolverFailureCode) {
    super(`Builtin mechanism resolver failed closed: ${code}.`);
    this.name = 'AppBuiltinMechanismResolverError';
    this.code = code;
  }
}

/**
 * Create the App-only mechanism resolver. The returned function consumes
 * already-canonical, already-authorized facts and contributes only the one
 * mechanism map required by the selected Builtin operation.
 */
export function createAppBuiltinMechanismResolver(): AppBuiltinMechanismResolver {
  return (input) => resolveBuiltinMechanisms(input);
}

function resolveBuiltinMechanisms(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
): BuiltinMechanismRecord {
  assertFacts(input);

  switch (input.executionMechanism) {
    case 'catalog':
      if (input.preassembledMechanism !== undefined) fail('mechanism_wrapper_invalid');
      return mergeBuiltinMechanismBundle({ executionMechanism: 'catalog' });
    case 'filesystem':
      return filesystemMechanism(input);
    case 'git':
      return gitMechanism(input);
    case 'shell':
      return shellMechanism(input);
    case 'web':
    case 'mcp':
    case 'skill':
    case 'planning':
      return preassembledMechanism(input);
    case 'subagent':
    case 'user_input':
    case 'model':
    case 'verification':
      fail('unsupported_mechanism');
  }
}

function filesystemMechanism(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
): BuiltinMechanismRecord {
  if (input.preassembledMechanism !== undefined || !input.filesystemRuntime) {
    fail('mechanism_missing');
  }
  const expandedAuthority = input.grantUsed !== 'none' || input.interactionMode === 'full';
  const externalReadAllowed =
    input.policyEffects.externalRead === true && input.policyEffects.externalWrite !== true;
  const externalWriteAllowed = input.policyEffects.externalWrite === true && expandedAuthority;
  const allowExternalPaths = externalReadAllowed || externalWriteAllowed;
  const mechanism = Object.freeze({
    allowExternalPaths,
    dispatch: async (operation: WorkspaceFilesystemOperation) => {
      const scoped = scopeFilesystemOperation(operation, {
        externalReadAllowed,
        externalWriteAllowed,
      });
      return input.filesystemRuntime!.dispatch(scoped);
    },
  });
  return mergeBuiltinMechanismBundle({
    executionMechanism: 'filesystem',
    prepared: Object.freeze({ filesystem: mechanism }),
  });
}

function scopeFilesystemOperation(
  operation: WorkspaceFilesystemOperation,
  policy: Readonly<{
    readonly externalReadAllowed: boolean;
    readonly externalWriteAllowed: boolean;
  }>,
): WorkspaceFilesystemOperation {
  if (
    !operation ||
    typeof operation !== 'object' ||
    typeof operation.path !== 'string' ||
    operation.path.length === 0 ||
    operation.path.length > 16_384 ||
    /\p{Cc}/u.test(operation.path)
  ) {
    fail('filesystem_path_invalid');
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

function gitMechanism(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
): BuiltinMechanismRecord {
  if (input.preassembledMechanism !== undefined || !input.gitBroker) {
    fail('mechanism_missing');
  }
  const broker = input.gitBroker;
  const mechanism = Object.freeze({
    inspect: (request: GitInspectRequest, signal?: AbortSignal) =>
      broker.inspect(request, signal ?? input.signal),
  });
  return mergeBuiltinMechanismBundle({
    executionMechanism: 'git',
    prepared: Object.freeze({ git: mechanism }),
  });
}

function shellMechanism(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
): BuiltinMechanismRecord {
  if (input.preassembledMechanism !== undefined || !input.shellExecutor) {
    fail('mechanism_missing');
  }
  const command = recordString(input.canonicalArguments, 'command');
  const sandboxScope = input.sandboxScope;
  if (!sandboxScope) fail('invalid_facts');
  const readOnly = sandboxScope.filesystem === 'read_only' || isReadOnlyShellCommand(command);
  // Authorization and scope remain separate: a durable grant permits the
  // invocation, while compiled effects select the minimum sandbox lane.
  const expandedAuthority = input.grantUsed !== 'none' || input.interactionMode === 'full';
  const networkAccess =
    sandboxScope.network === 'allow_all' && expandedAuthority ? 'approved' : 'none';
  const filesystemAccess =
    sandboxScope.filesystem === 'full_access' && expandedAuthority
      ? 'approved_external'
      : 'workspace_only';
  if (
    (sandboxScope.network === 'allow_all' || sandboxScope.filesystem === 'full_access') &&
    !expandedAuthority
  ) {
    fail('invalid_facts');
  }
  const executor = input.shellExecutor;
  const mechanism = Object.freeze({
    execute: (shellInput: Readonly<{ command: string; timeoutMs: number }>) => {
      if (input.signal.aborted) fail('signal_aborted');
      if (
        typeof shellInput.command !== 'string' ||
        shellInput.command !== command ||
        !Number.isSafeInteger(shellInput.timeoutMs) ||
        shellInput.timeoutMs <= 0
      ) {
        fail('invalid_facts');
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
  return mergeBuiltinMechanismBundle({
    executionMechanism: 'shell',
    prepared: Object.freeze({ shell: mechanism }),
  });
}

function preassembledMechanism(
  input: Readonly<AppBuiltinPreassembledMechanismResolverInput>,
): BuiltinMechanismRecord {
  if (!input.preassembledMechanism) fail('mechanism_missing');
  try {
    return mergeBuiltinMechanismBundle({
      executionMechanism: input.executionMechanism,
      prepared: input.preassembledMechanism,
    });
  } catch {
    fail('mechanism_wrapper_invalid');
  }
}

function assertFacts(input: Readonly<AppBuiltinPreassembledMechanismResolverInput>): void {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.workspace !== 'string' ||
    input.workspace.length === 0 ||
    !input.signal ||
    typeof input.signal.aborted !== 'boolean' ||
    typeof input.signal.addEventListener !== 'function' ||
    !['none', 'approve_once', 'same_command'].includes(input.grantUsed) ||
    !['auto', 'accept_edits', 'full'].includes(input.interactionMode) ||
    !validSandboxScope(input.sandboxScope)
  ) {
    fail('invalid_facts');
  }
  if (
    input.authorizationKind !== undefined &&
    input.authorizationKind !== 'policy_allow' &&
    input.authorizationKind !== 'approved_call'
  ) {
    fail('invalid_facts');
  }
  if (input.grantUsed === 'approve_once' && input.authorizationKind !== 'approved_call') {
    fail('invalid_facts');
  }
  assertFrozenJson(input.canonicalArguments, 'canonical arguments');
  if (!input.policyEffects || !Object.isFrozen(input.policyEffects)) {
    fail('invalid_facts');
  }
  if (input.preassembledMechanism !== undefined) {
    if (
      !Object.isFrozen(input.preassembledMechanism) ||
      Array.isArray(input.preassembledMechanism)
    ) {
      fail('mechanism_wrapper_invalid');
    }
  }
}

function validSandboxScope(value: unknown): value is Readonly<CapabilitySandboxScopeFact> | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    Object.keys(scope).length === 4 &&
    ['baseline', 'expanded', 'unrestricted'].includes(String(scope.kind)) &&
    ['read_only', 'workspace_write', 'full_access'].includes(String(scope.filesystem)) &&
    ['disabled', 'allow_all'].includes(String(scope.network)) &&
    typeof scope.digest === 'string' &&
    scope.digest.length > 0
  );
}

function assertFrozenJson(value: unknown, label: string): asserts value is RuntimeJsonValue {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail('invalid_facts');
      return;
    }
    if (typeof candidate !== 'object' || !Object.isFrozen(candidate) || seen.has(candidate)) {
      fail('invalid_facts');
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) fail('invalid_facts');
      for (const item of Object.values(candidate)) visit(item);
    }
    seen.delete(candidate);
  };
  try {
    visit(value);
  } catch (error) {
    if (error instanceof AppBuiltinMechanismResolverError) throw error;
    throw new AppBuiltinMechanismResolverError('invalid_facts');
  }
  void label;
}

function recordString(value: RuntimeJsonValue, key: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_facts');
  }
  const record = value as { readonly [key: string]: RuntimeJsonValue };
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    fail('invalid_facts');
  }
  return record[key] as string;
}

function fail(code: AppBuiltinMechanismResolverFailureCode): never {
  throw new AppBuiltinMechanismResolverError(code);
}
