import type { BuiltinSubagentRoleConfig } from './roles';

/** Specific child Shell authority belongs to Builtin; Core supplies command-shape evidence only. */
export function subagentRoleAllowsShellCommand(input: {
  readonly role: Pick<BuiltinSubagentRoleConfig, 'allowedTools'>;
  readonly commandIsReadOnly: boolean;
}): boolean {
  return input.role.allowedTools === undefined || input.commandIsReadOnly;
}
