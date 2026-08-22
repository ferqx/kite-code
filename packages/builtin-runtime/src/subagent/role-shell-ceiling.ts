import { isReadOnlyShellCommandV1 } from '../catalog-contract';
import type { ShellExecutor, ShellInput, ShellResult } from '../sandbox/shell-contract';
import { subagentRoleAllowsShellCommandV1 } from './role-ceiling';
import type { BuiltinSubagentRoleConfigV1 } from './roles';

/**
 * The stable, pre-dispatch refusal envelope for a read-only subagent role.
 *
 * This is intentionally structural instead of importing Core's
 * ToolExecutionResult. Core may enrich the result at its adapter seam, but
 * the policy decision and refusal text are owned by Builtin Runtime.
 */
export interface BuiltinSubagentShellRejectionV1 extends ShellResult {
  readonly status: 'rejected';
  readonly classifierAdviceV1: {
    readonly detailCode: 'policy_denied';
    readonly disposition: 'never';
    readonly maximumAdditionalCalls: 0;
    readonly requiresNewModelResponse: false;
    readonly safeAutomaticRetry: false;
  };
}

function readOnlyShellRejectionV1(command: string): BuiltinSubagentShellRejectionV1 | undefined {
  if (isReadOnlyShellCommandV1(command)) return undefined;
  return {
    ok: false,
    command,
    exitCode: -1,
    stdout: '',
    stderr: `Command rejected: "${command}" is not a read-only command. This sub-agent has read-only access only.`,
    status: 'rejected',
    classifierAdviceV1: {
      detailCode: 'policy_denied',
      disposition: 'never',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    },
  };
}

/** Apply the Builtin role shell ceiling before a child tool can reach a port. */
export function rejectShellOutsideSubAgentRoleCeilingV1(
  role: Pick<BuiltinSubagentRoleConfigV1, 'allowedTools'>,
  command: string,
): BuiltinSubagentShellRejectionV1 | undefined {
  return subagentRoleAllowsShellCommandV1({
    role,
    commandIsReadOnly: isReadOnlyShellCommandV1(command),
  })
    ? undefined
    : readOnlyShellRejectionV1(command);
}

/** Bind the role ceiling to an injected Shell executor without a fallback owner. */
export function resolveSubAgentShellExecutorV1(
  role: Pick<BuiltinSubagentRoleConfigV1, 'allowedTools'>,
  shellExecutor?: ShellExecutor,
): ShellExecutor | undefined {
  if (!role.allowedTools || !shellExecutor) return shellExecutor;
  return async (shellInput: ShellInput) =>
    readOnlyShellRejectionV1(shellInput.command) ?? shellExecutor(shellInput);
}
