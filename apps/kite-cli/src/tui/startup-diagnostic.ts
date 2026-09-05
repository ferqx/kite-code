import { RuntimeClientError } from '@kite-ai/runtime-client';
import { type AppServerPairingMode, formatAppServerMismatch } from '../app-server-diagnostic';

/** Turns an initialize failure into an actionable pre-Ink startup diagnostic. */
export function formatTuiStartupError(error: unknown, pairing?: AppServerPairingMode): string {
  if (error instanceof RuntimeClientError && error.code === 'server_mismatch') {
    return formatAppServerMismatch(pairing ?? 'same_build');
  }
  return error instanceof Error ? error.message : String(error);
}
