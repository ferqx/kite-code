import packageJson from '../../package.json' with { type: 'json' };
import type { KiteRuntimeModeConnector } from '../service-mode';
import { createKiteRuntimeModeAdapter } from '../service-mode';
import { runTui as runTuiClient, type TuiBootstrapProps } from './index';

export type KiteTuiProps = Omit<TuiBootstrapProps, 'createSessionManager'> & {
  /** Explicit parent-owned Runtime connector supplied by the release composition. */
  readonly connectRuntime?: KiteRuntimeModeConnector;
};

export function runTui(props: KiteTuiProps = {}): void {
  if (props.runtimeMode) {
    const runtimeMode = props.runtimeMode;
    void runtimeMode.connection
      .prepareAppControl()
      .then(() => runTuiClient(props))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    return;
  }
  if (!props.connectRuntime) {
    throw new Error('Managed local App Server connector is unavailable.');
  }
  const connector = props.connectRuntime;
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
        runtimeMode: createKiteRuntimeModeAdapter(connection),
      });
    })
    .catch(async (error: unknown) => {
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
