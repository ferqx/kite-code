import { runTui } from '@kite/kite/tui';
import type { AppShellExecutorV1 } from '@/app/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_V1,
  type AppPreparedShellExecutionPortV1,
  projectAppHostShellResultV1,
} from '@/app/sandbox/prepared-tool-pipeline';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let invocation = 0;

const shellExecutor = (async (input) => {
  invocation += 1;

  if (invocation === 1) {
    input.onProgress?.('OLD_SHELL_RUNNING\n', 'stdout');
    await new Promise<void>((resolve) => {
      if (input.signal?.aborted) {
        resolve();
        return;
      }
      input.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // Emulate the slower process-tree and sandbox cleanup observed on Windows.
    // The next prompt should already be visible, but its Runtime run must wait
    // for this predecessor to release the shared store/provider lease.
    await sleep(5_000);
    return {
      ok: false,
      command: input.command,
      exitCode: 130,
      stdout: 'OLD_SHELL_RUNNING\n',
      stderr: 'Command cancelled by user.',
    };
  }

  if (invocation === 2) {
    input.onProgress?.('SUCCESSOR_LINE_ONE\n', 'stdout');
    await sleep(500);
    input.onProgress?.('SUCCESSOR_LINE_TWO\n', 'stdout');
    await sleep(1_200);
    return {
      ok: true,
      command: input.command,
      exitCode: 0,
      stdout: 'SUCCESSOR_LINE_ONE\nSUCCESSOR_LINE_TWO\n',
      stderr: '',
    };
  }

  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Unexpected shell invocation ${invocation}`,
  };
}) as AppShellExecutorV1;

Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_V1, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    execute: async (input: Parameters<AppPreparedShellExecutionPortV1['execute']>[0]) =>
      projectAppHostShellResultV1(
        await shellExecutor({
          workspace: input.workspace,
          command: input.command,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          ...(input.networkMode ? { networkMode: input.networkMode } : {}),
          ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
          ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
          sandboxInvocationIdentity: input.identity,
        }),
      ),
  }),
});

shellExecutor.prepare = async () => ({
  mode: 'denied',
  backend: 'none',
  reason: 'fixture sandbox unavailable',
});

runTui({ shellExecutor });
