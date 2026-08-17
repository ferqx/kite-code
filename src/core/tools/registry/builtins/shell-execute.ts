import { z } from 'zod';
import {
  isDestructiveShellCommand,
  isNetworkCommand,
  isReadOnlyShellCommand,
  isVcsMutationCommand,
  isWriteLikeShellCommand,
} from '@/core/policies/shell-classification';
import { resolveShellTimeoutMs } from '@/core/tools/shell';
import { SHELL_EXECUTE_CONTRACT } from '@/core/tools/tool-contracts';
import { POLICY_PROVEN_READ_ONLY_EXECUTION } from '@/core/tools/trusted-readonly-environment';
import type { ShellIntent } from '@/core/types';
import { projectionDigest, truncateProjectedStreams } from '../projection';
import { defineExecutableTool } from '../spec';

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
      'Maximum runtime in milliseconds. Commands default to 600000ms when omitted; set a shorter limit for a TUI, dev server, watcher, or other long-running process, or a longer limit for an unusually slow finite command.',
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
  if (isReadOnlyShellCommand(trimmed)) return 'inspect';
  if (/\b(typecheck|lint|check)\b/i.test(trimmed)) return 'verify';
  return 'other';
}

// `satisfies` 校验每个取值都是合法 ShellIntent；ShellIntent 联合新增成员时
// 必须同步加入本表，否则 projectedShellIntent 会将其降级为 'other'。
// `satisfies` validates every entry against ShellIntent; new union members
// must be added here or projectedShellIntent downgrades them to 'other'.
const SHELL_INTENT_VALUES = [
  'inspect',
  'verify',
  'build',
  'test',
  'git',
  'other',
] as const satisfies readonly ShellIntent[];

/**
 * 从投影 resultMeta 收回 ShellIntent：运行时校验取代调用方盲 cast。
 * Recover a ShellIntent from projected resultMeta with runtime validation
 * instead of a blind cast at the call site.
 */
export function projectedShellIntent(meta: { intent?: string }): ShellIntent {
  return (SHELL_INTENT_VALUES as readonly string[]).includes(meta.intent ?? '')
    ? (meta.intent as ShellIntent)
    : 'other';
}

export const shellExecuteSpec = defineExecutableTool({
  name: 'shell_execute',
  kind: 'computer',
  contract: SHELL_EXECUTE_CONTRACT.sections,
  inputSchema: shellActionEnvelopeSchema,
  declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
  minimumApproval: 'user',
  governanceRevision: 'shell-effects-v1',
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
      if (!context.shellExecutor) {
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: '',
          stderr: 'Sandbox execution Provider is unavailable.',
          terminationReason: 'sandbox_denied' as const,
        };
      }
      const policyProvenReadOnly = isReadOnlyShellCommand(input.command);
      return await context.shellExecutor({
        workspace: context.workspace,
        command: input.command,
        signal: context.signal,
        timeoutMs: resolveShellTimeoutMs(input.timeout_ms),
        networkMode: context.shellNetworkMode,
        filesystemMode: context.shellFilesystemMode,
        executionTrust: policyProvenReadOnly ? POLICY_PROVEN_READ_ONLY_EXECUTION : undefined,
        onProgress: context.onShellProgress,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        command: input.command,
        exitCode: isAbort ? 130 : -1,
        stdout: '',
        stderr: isAbort ? 'Command cancelled by user.' : 'Shell execution adapter failed.',
      };
    }
  },
  projectResult: (output) => {
    const streams = truncateProjectedStreams(output.stdout, output.stderr);
    return {
      ok: output.ok,
      modelContent: output.ok ? streams.stdout : streams.stderr || streams.stdout,
      streams,
      resultMeta: {
        command: output.command,
        intent: classifyShellActionIntent(output.command),
        truncated: streams.truncated,
        rawResultDigest: projectionDigest(output.stdout, output.stderr, output.exitCode),
      },
      ...('terminationReason' in output && output.terminationReason
        ? { terminationReason: output.terminationReason }
        : {}),
    };
  },
});
