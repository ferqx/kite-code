import { createBuiltinShellExecutor, type ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import { createRuntimeHostProcessExecutionPort } from '@kite-ai/runtime-host';

/**
 * The single App-owned construction point for ADR-0119 host-shell
 * availability fallback. Static boundary checks keep every other production
 * module from importing this factory directly.
 */
export function createAcknowledgedHostShellExecutor(): ShellExecutor {
  return createBuiltinShellExecutor(createRuntimeHostProcessExecutionPort());
}
