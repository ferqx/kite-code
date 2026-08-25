import { createBuiltinShellExecutor, type ShellExecutor } from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostProcessExecutionPort } from '@kite/runtime-host';

/** Test-only bare Host shell. Production receives an acknowledged App executor. */
export const shellTool: ShellExecutor = createBuiltinShellExecutor(
  createRuntimeHostProcessExecutionPort(),
);

export type { ShellExecutor, ShellInput, ShellResult } from '@kite/builtin-runtime/sandbox';
export {
  appendTimeoutMessage,
  assertInsideWorkspace,
  buildHostShellInvocations,
  buildPolicyProvenReadOnlyHostShellInvocations,
  DEFAULT_SHELL_TIMEOUT_MS,
  resolveShellTimeoutMs,
  timeoutMessage,
} from '@kite/builtin-runtime/sandbox';
export { readRuntimeHostProcessOutput as readWithProgress } from '@kite/runtime-host';
