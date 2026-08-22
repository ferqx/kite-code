import { runTui } from '@kite/kite/tui';
import type { AppShellExecutorV1, AppShellRuntimeDecisionV1 } from '@/app/sandbox/composition';

const preparation = new Promise<AppShellRuntimeDecisionV1>(() => {});

const shellExecutor = (async (input) => {
  await preparation;
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: 'unreachable deferred sandbox fixture',
  };
}) as AppShellExecutorV1;
shellExecutor.prepare = () => preparation;

runTui({ shellExecutor });
