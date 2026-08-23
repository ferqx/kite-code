import { isReadOnlyShellCommand } from '../catalog-contract';
import type { ShellExecutor, ShellInput, ShellResult } from '../sandbox/shell-contract';
import { subagentRoleAllowsShellCommand } from './role-ceiling';
import type { BuiltinSubagentRoleConfig } from './roles';

/**
 * The stable, pre-dispatch refusal envelope for a read-only subagent role.
 *
 * This is intentionally structural instead of importing Core's
 * ToolExecutionResult. Core may enrich the result at its adapter seam, but
 * the policy decision and refusal text are owned by Builtin Runtime.
 */
export interface BuiltinSubagentShellRejection extends ShellResult {
  readonly status: 'rejected';
  readonly classifierAdvice: {
    readonly detailCode: 'policy_denied';
    readonly disposition: 'never';
    readonly maximumAdditionalCalls: 0;
    readonly requiresNewModelResponse: false;
    readonly safeAutomaticRetry: false;
  };
}

function readOnlyShellRejection(command: string): BuiltinSubagentShellRejection | undefined {
  if (isReadOnlyShellCommand(command)) return undefined;
  return {
    ok: false,
    command,
    exitCode: -1,
    stdout: '',
    stderr: `Command rejected: "${command}" is not a read-only command. This sub-agent has read-only access only.`,
    status: 'rejected',
    classifierAdvice: {
      detailCode: 'policy_denied',
      disposition: 'never',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    },
  };
}

/** Apply the Builtin role shell ceiling before a child tool can reach a port. */
export function rejectShellOutsideSubAgentRoleCeiling(
  role: Pick<BuiltinSubagentRoleConfig, 'allowedTools'>,
  command: string,
): BuiltinSubagentShellRejection | undefined {
  return subagentRoleAllowsShellCommand({
    role,
    commandIsReadOnly: isReadOnlyShellCommand(command),
  })
    ? undefined
    : readOnlyShellRejection(command);
}

/** Bind the role ceiling to an injected Shell executor without a fallback owner. */
export function resolveSubAgentShellExecutor(
  role: Pick<BuiltinSubagentRoleConfig, 'allowedTools'>,
  shellExecutor?: ShellExecutor,
): ShellExecutor | undefined {
  if (!role.allowedTools || !shellExecutor) return shellExecutor;
  return async (shellInput: ShellInput) =>
    readOnlyShellRejection(shellInput.command) ?? shellExecutor(shellInput);
}
