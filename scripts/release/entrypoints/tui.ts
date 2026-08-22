import { runTui } from '@kite/kite/tui';
import {
  isMcpStdioWrapperInvocationV1,
  MCP_STDIO_WRAPPER_ENTRYPOINT_V1,
  runMcpStdioChildRuntimeV1,
  runPosixSupervisorChildV1,
} from '@kite/runtime-host';
import packageJson from '../../../package.json' with { type: 'json' };

const supervisorMode = process.argv.indexOf('--kite-internal-posix-supervisor-v1');
if (isMcpStdioWrapperInvocationV1(process.argv)) {
  runMcpStdioChildRuntimeV1([MCP_STDIO_WRAPPER_ENTRYPOINT_V1]);
} else if (supervisorMode >= 0) {
  runPosixSupervisorChildV1(process.argv.slice(supervisorMode + 1));
} else if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  runTui();
}
