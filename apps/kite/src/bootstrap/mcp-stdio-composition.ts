import { basename } from 'node:path';
import {
  createRuntimeHostMcpStdioProcessPort,
  isMcpStdioWrapperInvocation,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  runMcpStdioChildRuntime,
} from '@kite-ai/runtime-host';

/** App composition of the one Host-owned authenticated MCP stdio process mechanism. */
export function createInstalledMcpStdioProcessPort() {
  const executable = basename(process.execPath).toLowerCase();
  const runningUnderBun = executable === 'bun' || executable === 'bun.exe';
  return createRuntimeHostMcpStdioProcessPort({
    // Source runs use Host's checked TypeScript entrypoint. A standalone Kite
    // executable routes the internal flag before normal CLI/TUI bootstrap.
    ...(runningUnderBun ? {} : { wrapperPath: null }),
  });
}

/** Return true only for the private standalone child entrypoint. */
export function runKiteInternalMcpStdioChild(): boolean {
  if (!isMcpStdioWrapperInvocation(process.argv)) return false;
  runMcpStdioChildRuntime([MCP_STDIO_WRAPPER_ENTRYPOINT_]);
  return true;
}
