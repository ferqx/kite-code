import {
  canonicalFileRecoveryIntent,
  canTransitionFileRecoveryPhase,
  type FileRecoveryIntent,
  parseFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';

export const fileRecoveryIntentId = (intent: FileRecoveryIntent): string =>
  intent.code?.request.commandId ?? intent.fork!.request.commandId;

export interface NativeFileRecoveryJournal {
  fileRecoveries(): Promise<FileRecoveryIntent[]>;
  prepareFileRecovery(
    intent: FileRecoveryIntent,
  ): Promise<{ created: boolean; value: FileRecoveryIntent }>;
  updateFileRecovery(
    intent: FileRecoveryIntent,
    previous: FileRecoveryIntent,
  ): Promise<FileRecoveryIntent>;
}

/** Every applicable Command identity belongs to exactly one saved intent, including its second leg. */
export function assertFileRecoveryCommands(values: readonly FileRecoveryIntent[]) {
  const commands = new Set<string>();
  for (const value of values)
    for (const leg of [value.code, value.fork]) {
      if (!leg) continue;
      if (commands.has(leg.request.commandId)) throw Error('file_recovery_intent_conflict');
      commands.add(leg.request.commandId);
    }
}

export function fileRecoveryRow(row: Record<string, unknown>): string {
  if (
    typeof row.intent_id !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.state_hex !== 'string'
  )
    throw Error('file_recovery_storage_unavailable');
  const bytes = Buffer.from(row.state_hex, 'hex');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('file_recovery_storage_unavailable');
  }
  if (text !== row.state || Buffer.byteLength(row.state) !== bytes.length)
    throw Error('file_recovery_storage_unavailable');
  return text;
}

export async function parseFileRecoveryRow(
  row: Record<string, unknown>,
): Promise<FileRecoveryIntent> {
  try {
    const value = await parseFileRecoveryIntent(JSON.parse(fileRecoveryRow(row)));
    if (fileRecoveryIntentId(value) !== row.intent_id)
      throw Error('file_recovery_storage_unavailable');
    return value;
  } catch {
    throw Error('file_recovery_storage_unavailable');
  }
}

export function assertFileRecoveryTransition(
  previous: FileRecoveryIntent,
  next: FileRecoveryIntent,
) {
  if (canonicalFileRecoveryIntent(previous) !== canonicalFileRecoveryIntent(next))
    throw Error('file_recovery_intent_conflict');
  for (const leg of ['code', 'fork'] as const) {
    if (
      previous[leg] &&
      next[leg] &&
      !canTransitionFileRecoveryPhase(previous[leg]!.phase, next[leg]!.phase)
    )
      throw Error('file_recovery_phase_conflict');
  }
}
