import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { verifyCallerIntentRecords } from './caller-intents';
import { MaintenanceError } from './types';

const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** DB3 caller bytes are UI assets. Content proofs never confer receipt or POST authority. */
export function verifyDesktopCallerRows(db: Database): void {
  let bytes = 0;
  const records: unknown[] = [];
  try {
    for (const row of db
      .query<{ command_id: string; state: string; state_hex: string }, []>(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM caller_intents ORDER BY command_id',
      )
      .iterate()) {
      if (
        typeof row.command_id !== 'string' ||
        typeof row.state !== 'string' ||
        Buffer.from(row.state).toString('hex').toUpperCase() !== row.state_hex ||
        records.length >= 128
      )
        throw Error();
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16 * 1024 * 1024) throw Error();
      const record = JSON.parse(row.state);
      verifyCallerIntentRecords([record]);
      const intent = record.intent as {
        request: Record<string, Json>;
        bodyDigest: string;
        requestDigest: string;
      };
      const request = { ...intent.request };
      delete request.expectedStoreId;
      delete request.commandId;
      if (
        row.command_id !== intent.request.commandId ||
        intent.bodyDigest !== digest(intent.request) ||
        intent.requestDigest !== digest(request)
      )
        throw Error();
      records.push(record);
    }
    verifyCallerIntentRecords(records);
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
