import type {
  KiteRuntimeApplicationPort,
  KiteServiceReadinessPort,
  KiteServiceShell,
  KiteServiceSignalPort,
  KiteServiceStatePort,
  KiteServiceTransportPort,
} from './ports';
import { createKiteServiceShell } from './shell';
import { createProcessSignalPort } from './signals';

/** Internal executable input. Runtime/Application ownership is always supplied by the caller. */
export interface KiteServiceExecutableOptions {
  readonly application: KiteRuntimeApplicationPort;
  readonly state: KiteServiceStatePort;
  readonly transport: KiteServiceTransportPort;
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export function createKiteServiceExecutable(
  options: KiteServiceExecutableOptions,
): KiteServiceShell {
  return createKiteServiceShell({
    ...options,
    signals: options.signals ?? createProcessSignalPort(),
  });
}

/**
 * Run the internal foreground child until SIGINT/SIGTERM. No default Runtime Application is
 * constructed here: the later composition tranche supplies the sole Host/Store owner.
 */
export async function runKiteService(options: KiteServiceExecutableOptions): Promise<void> {
  const shell = createKiteServiceExecutable(options);
  await shell.start();
  const result = await shell.waitForShutdown();
  if (result.outcome !== 'applied') {
    throw new Error(result.diagnostic ?? 'Service shutdown failed.');
  }
}
