import {
  describeServiceStartupProgress,
  formatServiceStartupReport,
  type ServiceStartupProgress,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { RuntimeClientError, RuntimeClientStartupError } from '@kite-ai/runtime-client';
import { type AppServerPairingMode, formatAppServerMismatch } from '../app-server-diagnostic';

/** Turns an initialize failure into an actionable pre-Ink startup diagnostic. */
export function formatTuiStartupError(error: unknown, pairing?: AppServerPairingMode): string {
  if (error instanceof RuntimeClientStartupError) {
    return `${error.message}\n可将以下脱敏诊断保存，用于排查：\n${formatServiceStartupReport({
      code: error.diagnosticCode,
      actualSchema: error.actualSchema,
      expectedSchema: error.expectedSchema,
      ...(error.stage ? { stage: error.stage } : {}),
    })}`;
  }
  if (
    error instanceof RuntimeClientError &&
    (error.code === 'server_mismatch' ||
      (error.code === 'protocol_error' &&
        error.protocol?.data.code === 'protocol_version_mismatch'))
  ) {
    return formatAppServerMismatch(pairing ?? 'same_build');
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatTuiStartupProgress(progress: ServiceStartupProgress): string {
  return describeServiceStartupProgress(progress);
}
