import { runTui } from '@kite/kite/tui';
import {
  isMcpStdioWrapperInvocation,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  runMcpStdioChildRuntime,
  runPosixSupervisorChild,
} from '@kite/runtime-host';
import packageJson from '../../../package.json' with { type: 'json' };

const supervisorMode = process.argv.indexOf('--kite-internal-posix-supervisor-v1');
if (isMcpStdioWrapperInvocation(process.argv)) {
  runMcpStdioChildRuntime([MCP_STDIO_WRAPPER_ENTRYPOINT_]);
} else if (supervisorMode >= 0) {
  runPosixSupervisorChild(process.argv.slice(supervisorMode + 1));
} else if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  runTui();
}
