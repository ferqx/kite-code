import packageJson from '../../package.json' with { type: 'json' };
import { createKiteCliRuntimeAccess, prepareKiteRuntimeSessionResume } from '../bootstrap';
import { runKiteInternalMcpStdioChild } from '../bootstrap/mcp-stdio-composition';
import { main } from './index';

export async function runCli(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    return;
  }
  await main({
    prepareRuntimeSessionResume: prepareKiteRuntimeSessionResume,
    createRuntimeAccess: createKiteCliRuntimeAccess,
  });
}

if (import.meta.main) {
  if (!runKiteInternalMcpStdioChild()) {
    runCli().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
