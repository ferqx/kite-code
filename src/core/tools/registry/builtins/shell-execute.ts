import { z } from 'zod';
import {
  classifyShellRisk,
  isDestructiveShellCommand,
  isNetworkCommand,
  isReadOnlyShellCommand,
  isVcsMutationCommand,
  isWriteLikeShellCommand,
} from '@/core/policies/shell-classification';
import { shellTool } from '@/core/tools/shell';
import { SHELL_EXECUTE_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellActionEnvelope, ShellIntent, ShellResult } from '@/core/types';
import type { ToolSpec } from '../spec';

export const shellActionEnvelopeSchema = z.object({
  command: z.string().describe('Shell command to execute in the workspace'),
  description: z
    .string()
    .optional()
    .describe('Short human-readable description of what this command does (shown to the user)'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum runtime in milliseconds. Use this for commands that start a TUI, dev server, watcher, or other long-running process.',
    ),
});

/** Audit metadata is derived from command shape; it is never accepted from the model. */
export function classifyShellActionIntent(command: string): ShellIntent {
  const trimmed = command.trim();
  if (
    /(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|(^|[;&|]\s*)(pytest|cargo test|go test)\b/i.test(
      trimmed,
    )
  ) {
    return 'test';
  }
  if (
    /(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?(build|compile)\b|(^|[;&|]\s*)(cargo build|go build)\b/i.test(
      trimmed,
    )
  ) {
    return 'build';
  }
  if (/(^|[;&|]\s*)git\b/i.test(trimmed)) return 'git';
  if (classifyShellRisk(trimmed) === 'read') return 'inspect';
  if (/\b(typecheck|lint|check)\b/i.test(trimmed)) return 'verify';
  return 'other';
}

export const shellExecuteSpec: ToolSpec<ShellActionEnvelope, ShellResult> = {
  name: 'shell_execute',
  kind: 'computer',
  contract: SHELL_EXECUTE_CONTRACT.sections,
  inputSchema: shellActionEnvelopeSchema,
  declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
  minimumApproval: 'user',
  effects: (input) => {
    const command = input.command;
    if (isReadOnlyShellCommand(command)) {
      return {
        effectClass: 'read_only',
        sideEffect: false,
        classificationReason: 'Shell command matches the conservative read-only allowlist.',
      };
    }
    if (isNetworkCommand(command)) {
      return {
        effectClass: 'external_side_effect',
        sideEffect: true,
        classificationReason: 'Shell command may access the network.',
      };
    }
    if (
      isDestructiveShellCommand(command) ||
      isVcsMutationCommand(command) ||
      isWriteLikeShellCommand(command)
    ) {
      return {
        effectClass: 'workspace_write',
        sideEffect: true,
        classificationReason: 'Shell command may mutate files or version-control state.',
      };
    }
    return {
      effectClass: 'unknown',
      sideEffect: true,
      classificationReason: 'Shell command could not be proven read-only.',
    };
  },
  approvalSummary: (input) => input.command,
  execute: async (input, context) => {
    try {
      return await (context.shellExecutor ?? shellTool)({
        workspace: context.workspace,
        command: input.command,
        signal: context.signal,
        timeoutMs: input.timeout_ms,
        networkMode: context.shellNetworkMode,
        onProgress: context.onShellProgress,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        command: input.command,
        exitCode: isAbort ? 130 : -1,
        stdout: '',
        stderr: isAbort
          ? 'Command cancelled by user.'
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Run', preview: output.command },
  }),
};
