import { runTui } from '@kite/kite/tui';
import { runPosixSupervisorChildV1 } from '@kite/runtime-host';
import packageJson from '../../../package.json' with { type: 'json' };

const supervisorMode = process.argv.indexOf('--kite-internal-posix-supervisor-v1');
if (supervisorMode >= 0) {
  runPosixSupervisorChildV1(process.argv.slice(supervisorMode + 1));
} else if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  runTui();
}
