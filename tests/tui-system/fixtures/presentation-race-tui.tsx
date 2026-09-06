import { runTui } from '@kite-ai/kite-cli/tui';
import type { AppShellExecutor } from '#kite-service/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  type AppPreparedShellExecutionPort,
  projectAppHostShellResult,
} from '#kite-service/sandbox/prepared-tool-pipeline';
import { createInProcessTuiServiceConnector } from './in-process-service-connector';

const deliveryMode = process.env.KITE_TUI_FIXTURE_DELIVERY_MODE ?? 'normal';

const shellExecutor = (async (input) => {
  input.onProgress?.('LATE_EPHEMERAL_TOOL_PROGRESS_MARKER\n', 'stdout');
  return {
    ok: true,
    command: input.command,
    exitCode: 0,
    stdout: 'LATE_DURABLE_TOOL_LIFECYCLE_MARKER\n',
    stderr: '',
  };
}) as AppShellExecutor;

Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    execute: async (input: Parameters<AppPreparedShellExecutionPort['execute']>[0]) =>
      projectAppHostShellResult(
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
  mode: 'host_shell',
  backend: 'none',
});

const protocolDelivery =
  deliveryMode === 'terminal-before-receipt'
    ? { deferStartTurnReceiptUntilTerminal: true as const }
    : deliveryMode === 'late-events'
      ? {
          duplicateEphemeralEventMarkersAfterTerminal: [
            'LATE_AFTER_TERMINAL',
            'LATE_EPHEMERAL_REASONING_MARKER',
            'LATE_EPHEMERAL_TOOL_PROGRESS_MARKER',
          ],
          duplicateDurableEventMarkersAfterTerminal: ['LATE_DURABLE_TOOL_LIFECYCLE_MARKER'],
        }
      : {};

runTui({
  connectRuntime: createInProcessTuiServiceConnector(shellExecutor, { protocolDelivery }),
});
