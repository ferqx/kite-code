import packageJson from '../../package.json' with { type: 'json' };
import { createKiteTuiSessionManager } from '../bootstrap';
import { runKiteInternalMcpStdioChildV1 } from '../bootstrap/mcp-stdio-composition';
import { runTui as runTuiClient, type TuiBootstrapProps } from './index';
import type { SessionManager } from './session-manager';

export type KiteTuiProps = Omit<TuiBootstrapProps, 'createSessionManager'>;

export function runTui(props: KiteTuiProps = {}): void {
  runTuiClient({
    ...props,
    createSessionManager: (dependencies) =>
      createKiteTuiSessionManager(dependencies as never) as unknown as SessionManager,
  });
}

if (import.meta.main) {
  if (runKiteInternalMcpStdioChildV1()) {
    // The private wrapper owns stdin/stdout until its authenticated terminal.
  } else if (process.argv.includes('--version')) {
    console.log(`Kite Code TUI ${packageJson.version}`);
  } else {
    runTui();
  }
}
