import { createBuiltinShellExecutorV1, type ShellExecutor } from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostProcessExecutionPortV1 } from '@kite/runtime-host';

/** Test-only bare Host shell. Production receives an acknowledged App executor. */
export const shellTool: ShellExecutor = createBuiltinShellExecutorV1(
  createRuntimeHostProcessExecutionPortV1(),
);

export type { ShellExecutor, ShellInput, ShellResult } from '@kite/builtin-runtime/sandbox';
export {
  appendTimeoutMessage,
  assertInsideWorkspace,
  buildHostShellInvocationsV1,
  buildPolicyProvenReadOnlyHostShellInvocationsV1,
  DEFAULT_SHELL_TIMEOUT_MS,
  resolveShellTimeoutMs,
  timeoutMessage,
} from '@kite/builtin-runtime/sandbox';
export { readRuntimeHostProcessOutputV1 as readWithProgress } from '@kite/runtime-host';
