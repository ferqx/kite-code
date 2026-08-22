import type { BuiltinSubagentRoleConfigV1 } from './roles';

/** Specific child Shell authority belongs to Builtin; Core supplies command-shape evidence only. */
export function subagentRoleAllowsShellCommandV1(input: {
  readonly role: Pick<BuiltinSubagentRoleConfigV1, 'allowedTools'>;
  readonly commandIsReadOnly: boolean;
}): boolean {
  return input.role.allowedTools === undefined || input.commandIsReadOnly;
}
