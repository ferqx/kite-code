import packageJson from '../../package.json' with { type: 'json' };
import { createKiteTuiSessionManager } from '../bootstrap';
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
  if (process.argv.includes('--version')) {
    console.log(`Kite Code TUI ${packageJson.version}`);
  } else {
    runTui();
  }
}
