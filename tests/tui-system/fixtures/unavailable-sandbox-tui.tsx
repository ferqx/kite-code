import { runTui } from '@kite-ai/kite-cli/tui';
import type { AppShellExecutor, AppShellRuntimeDecision } from '#kite-service/sandbox/composition';
import { createInProcessTuiServiceConnector } from './in-process-service-connector';

const decision: AppShellRuntimeDecision = {
  mode: 'denied',
  backend: 'none',
  reason: 'sandbox_backend_unavailable',
};

const shellExecutor = (async (input) => ({
  ok: false,
  command: input.command,
  exitCode: -1,
  stdout: '',
  stderr: 'Sandbox unavailable; refusing unsandboxed shell execution.',
  terminationReason: 'sandbox_denied' as const,
})) as AppShellExecutor;
shellExecutor.prepare = async () => decision;

runTui({ connectRuntime: createInProcessTuiServiceConnector(shellExecutor) });
