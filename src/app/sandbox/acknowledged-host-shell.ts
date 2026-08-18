import { type ShellExecutor, shellTool } from '@/core/tools/shell';

/**
 * The single App-owned construction point for ADR-0119 host-shell
 * availability fallback. Static boundary checks keep every other production
 * module from importing this factory directly.
 */
export function createAcknowledgedHostShellExecutorV1(): ShellExecutor {
  return shellTool;
}
