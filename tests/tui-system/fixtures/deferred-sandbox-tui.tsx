import { runTui } from '@kite-ai/kite-cli/tui';
import type { AppShellExecutor, AppShellRuntimeDecision } from '#kite-service/sandbox/composition';
import { createInProcessTuiServiceConnector } from './in-process-service-connector';

const preparation = new Promise<AppShellRuntimeDecision>(() => {});

const shellExecutor = (async (input) => {
  await preparation;
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: 'unreachable deferred sandbox fixture',
  };
}) as AppShellExecutor;
shellExecutor.prepare = () => preparation;

runTui({ connectService: createInProcessTuiServiceConnector(shellExecutor) });
