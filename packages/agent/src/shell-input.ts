import { modelIdentifier } from './model-identifier';
import type { Json } from './storage/types';

export type ShellScope = {
  filesystem: 'workspace_write' | 'full_access';
  network: 'none' | 'internet';
};

export function validShellOutputTokens(value: Json): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** The persisted logical Tool identity survives attempts; command text never selects an identity. */
export function shellOperationKey(key: Json | undefined, executionId: string): string {
  return typeof key === 'string' ? key : `sh_${modelIdentifier(executionId)}`;
}

/** Shared request interpretation, not an authorization result. Jobs retain their historical input. */
export function parseShellCommandInput(
  input: Json,
  kind: 'execute' | 'launch' | 'job',
  scoped: boolean,
):
  | {
      command: string;
      cancellation: 'attached' | 'detached' | null;
      timeoutMs: number | null;
      background: boolean;
      executionScope: ShellScope;
      permissions?: ShellScope;
      workdir?: string;
    }
  | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const tool = kind !== 'job';
  const allowed = [
    'command',
    'workdir',
    ...(tool ? ['key', 'cancellation', 'description'] : []),
    ...(kind === 'execute'
      ? ['background', 'execution_timeout_ms', 'timeoutMs', 'max_output_tokens']
      : []),
    ...(scoped ? ['permissions', ...(tool ? ['filesystem', 'network'] : [])] : []),
  ];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    typeof input.command !== 'string' ||
    !input.command ||
    input.command.length > 262144 ||
    (input.workdir !== undefined &&
      (typeof input.workdir !== 'string' ||
        !input.workdir ||
        input.workdir.length > 4096 ||
        input.workdir.includes('\0'))) ||
    (input.key !== undefined &&
      (typeof input.key !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.key))) ||
    (input.description !== undefined && typeof input.description !== 'string') ||
    (input.background !== undefined && typeof input.background !== 'boolean') ||
    (input.max_output_tokens !== undefined && !validShellOutputTokens(input.max_output_tokens)) ||
    (input.cancellation !== undefined &&
      input.cancellation !== 'attached' &&
      input.cancellation !== 'detached') ||
    (input.timeoutMs !== undefined && input.execution_timeout_ms !== undefined)
  )
    return;
  const timeoutMs =
    input.execution_timeout_ms === undefined ? input.timeoutMs : input.execution_timeout_ms;
  const background = kind === 'launch' || input.background === true;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 3600000 ||
      background)
  )
    return;
  const flat = input.filesystem !== undefined || input.network !== undefined;
  if (flat && input.permissions !== undefined) return;
  const scope = flat
    ? {
        filesystem: input.filesystem === undefined ? 'workspace_write' : input.filesystem,
        network: input.network === undefined ? 'none' : input.network,
      }
    : input.permissions;
  if (
    scope !== undefined &&
    (!scope ||
      typeof scope !== 'object' ||
      Array.isArray(scope) ||
      Object.keys(scope).some((key) => !['filesystem', 'network'].includes(key)) ||
      (scope.filesystem !== 'workspace_write' && scope.filesystem !== 'full_access') ||
      (scope.network !== 'none' && scope.network !== 'internet'))
  )
    return;
  const permissions = scope as ShellScope | undefined;
  return {
    command: input.command,
    ...(typeof input.workdir === 'string' ? { workdir: input.workdir } : {}),
    cancellation: tool ? (input.cancellation === 'detached' ? 'detached' : 'attached') : null,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : null,
    background,
    executionScope: permissions ?? { filesystem: 'workspace_write', network: 'none' },
    ...(permissions ? { permissions } : {}),
  };
}
