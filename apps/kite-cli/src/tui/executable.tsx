import packageJson from '../../package.json' with { type: 'json' };
import type { KiteServiceModeConnector } from '../service-mode';
import { createKiteServiceModeAdapter } from '../service-mode';
import { runTui as runTuiClient, type TuiBootstrapProps } from './index';

export type KiteTuiProps = Omit<TuiBootstrapProps, 'createSessionManager'> & {
  /** Explicit managed Service connector supplied by the release composition. */
  readonly connectService?: KiteServiceModeConnector;
};

export function runTui(props: KiteTuiProps = {}): void {
  if (props.serviceMode) {
    const serviceMode = props.serviceMode;
    void serviceMode.connection
      .prepareAppControl()
      .then(() => runTuiClient(props))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    return;
  }
  if (!props.connectService) {
    throw new Error('Managed Local Runtime Service connector is unavailable.');
  }
  const connector = props.connectService;
  const workspace = process.cwd();
  void Promise.resolve()
    .then(() => connector.connect({ workspace }))
    .then(async (connection) => {
      await connection.prepareAppControl();
      return connection;
    })
    .then((connection) => {
      runTuiClient({
        ...props,
        serviceMode: createKiteServiceModeAdapter(connection),
      });
    })
    .catch(async (error: unknown) => {
      await props.disposeRuntime?.().catch(() => undefined);
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

if (import.meta.main) {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code TUI ${packageJson.version}`);
  } else {
    runTui();
  }
}
