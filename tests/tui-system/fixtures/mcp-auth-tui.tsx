import { MemoryMcpCredentialStore } from '@kite-ai/builtin-runtime/mcp';
import { runTui } from '@kite-ai/kite-cli/tui';
import type { AppShellExecutor } from '#kite-service/sandbox/composition';
import { createInProcessTuiServiceConnector } from './in-process-service-connector';

const shellExecutor = (async (input) => ({
  ok: false,
  command: input.command,
  exitCode: -1,
  stdout: '',
  stderr: 'MCP auth fixture does not execute shell commands.',
})) as AppShellExecutor;
shellExecutor.prepare = async () => ({ mode: 'host_shell', backend: 'none' });

runTui({
  connectService: createInProcessTuiServiceConnector(shellExecutor, {
    mcpCredentialStore: new MemoryMcpCredentialStore(),
  }),
});
