import type { FileRecoveryIntent } from '@kite-ai/client/file-recovery-intent';
export interface FileRecoveryCLIArguments {
  kind: 'files';
  action: 'checkpoints' | 'detail' | 'restore' | 'lookup' | 'continue' | 'intents';
  sessionId: string;
  pointId?: string;
  scope?: FileRecoveryIntent['scope'];
  input?: Record<string, unknown>;
  server?: string;
  dataRoot?: string;
}
export function fileRecoveryExitCode(intent: FileRecoveryIntent): number {
  const legs = [intent.code, intent.fork].filter((leg) => leg !== null);
  return legs.every((leg) => leg!.phase === 'succeeded')
    ? 0
    : legs.some((leg) => leg!.phase === 'failed')
      ? 1
      : 2;
}
