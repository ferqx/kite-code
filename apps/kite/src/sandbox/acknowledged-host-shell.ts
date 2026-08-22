import { createBuiltinShellExecutorV1, type ShellExecutor } from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostProcessExecutionPortV1 } from '@kite/runtime-host';

/**
 * The single App-owned construction point for ADR-0119 host-shell
 * availability fallback. Static boundary checks keep every other production
 * module from importing this factory directly.
 */
export function createAcknowledgedHostShellExecutorV1(): ShellExecutor {
  return createBuiltinShellExecutorV1(createRuntimeHostProcessExecutionPortV1());
}
