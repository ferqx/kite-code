import { basename } from 'node:path';
import {
  createRuntimeHostMcpStdioProcessPortV1,
  isMcpStdioWrapperInvocationV1,
  MCP_STDIO_WRAPPER_ENTRYPOINT_V1,
  runMcpStdioChildRuntimeV1,
} from '@kite/runtime-host';
import { loadInstalledRuntimeAuthorityKeyV1 } from './project-identity-composition';

/** App composition of the one Host-owned authenticated MCP stdio process mechanism. */
export function createInstalledMcpStdioProcessPortV1() {
  const executable = basename(process.execPath).toLowerCase();
  const runningUnderBun = executable === 'bun' || executable === 'bun.exe';
  return createRuntimeHostMcpStdioProcessPortV1({
    installationKey: loadInstalledRuntimeAuthorityKeyV1(),
    // Source runs use Host's checked TypeScript entrypoint. A standalone Kite
    // executable routes the internal flag before normal CLI/TUI bootstrap.
    ...(runningUnderBun ? {} : { wrapperPath: null }),
  });
}

/** Return true only for the private standalone child entrypoint. */
export function runKiteInternalMcpStdioChildV1(): boolean {
  if (!isMcpStdioWrapperInvocationV1(process.argv)) return false;
  runMcpStdioChildRuntimeV1([MCP_STDIO_WRAPPER_ENTRYPOINT_V1]);
  return true;
}
