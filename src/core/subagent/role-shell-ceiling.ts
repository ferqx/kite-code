import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { isReadOnlyShellCommand } from '@/core/policies/shell-classification';
import type { ShellExecutor } from '@/core/tools/shell';
import type { SubAgentRoleConfig } from './types';

function readOnlyShellRejection(command: string): ToolExecutionResult | undefined {
  if (isReadOnlyShellCommand(command)) return undefined;
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

export function rejectShellOutsideSubAgentRoleCeiling(
  role: SubAgentRoleConfig,
  command: string,
): ToolExecutionResult | undefined {
  return role.allowedTools ? readOnlyShellRejection(command) : undefined;
}

export function resolveSubAgentShellExecutor(
  role: SubAgentRoleConfig,
  shellExecutor?: ShellExecutor,
): ShellExecutor | undefined {
  if (!role.allowedTools || !shellExecutor) return shellExecutor;
  return async (shellInput) =>
    readOnlyShellRejection(shellInput.command) ?? shellExecutor(shellInput);
}
