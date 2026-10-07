import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { closePrivate as closeSync, openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';

const invalid = () => new MaintenanceError('backup_file_recovery_intents_invalid');
const sha = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return row;
}
function sequence(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw invalid();
}
function text(value: unknown, min: number, max: number): asserts value is string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max)
    throw invalid();
}
function message(value: unknown, nullable: boolean) {
  if (value === null && nullable) return null;
  const row = object(value, ['messageId', 'seq']);
  if (!id(row.messageId)) throw invalid();
  sequence(row.seq);
  if (row.seq === '0') throw invalid();
  return row as { messageId: string; seq: string };
}
function checkpoint(value: unknown) {
  const point = object(value, ['id', 'boundary', 'workspace']);
  if (!hash(point.id)) throw invalid();
  const boundary = object(point.boundary, [
    'storeId',
    'workspaceId',
    'sessionId',
    'runId',
    'contextSelectionId',
    'messageId',
    'messageSeq',
    'triggerMessageId',
    'triggerSeq',
  ]);
  for (const key of [
    'storeId',
    'workspaceId',
    'sessionId',
    'runId',
    'contextSelectionId',
    'triggerMessageId',
  ])
    if (!id(boundary[key])) throw invalid();
  sequence(boundary.messageSeq);
  sequence(boundary.triggerSeq);
  if (
    (boundary.messageId === null) !== (boundary.messageSeq === '0') ||
    (boundary.messageId !== null && !id(boundary.messageId)) ||
    BigInt(boundary.triggerSeq) <= BigInt(boundary.messageSeq)
  )
    throw invalid();
  const workspace = object(point.workspace, ['device', 'inode']);
  for (const field of Object.values(workspace))
    if (typeof field !== 'string' || !/^(0|[1-9][0-9]*)$/.test(field)) throw invalid();
  return point;
}
const phases = new Set([
  'not_started',
  'prepared',
  'submitting',
  'pending',
  'succeeded',
  'failed',
  'unknown',
]);
/** Closed local metadata; validation confers neither a receipt nor a POST permit. */
export function verifyFileRecoveryIntent(value: unknown) {
  const row = object(value, [
    'version',
    'scope',
    'storeId',
    'sessionId',
    'workspaceId',
    'subjectId',
    'contextSelectionId',
    'checkpoint',
    'boundary',
    'trigger',
    'code',
    'fork',
  ]);
  if (row.version !== 1 || !['session', 'code', 'both'].includes(row.scope as string))
    throw invalid();
  for (const field of ['storeId', 'sessionId', 'workspaceId', 'contextSelectionId'])
    if (!id(row[field])) throw invalid();
  text(row.subjectId, 1, 256);
  const point = checkpoint(row.checkpoint);
  const boundary = message(row.boundary, true),
    trigger = message(row.trigger, false)!;
  if (boundary && BigInt(boundary.seq) >= BigInt(trigger.seq)) throw invalid();
  if (
    (row.code === null) !== (row.scope === 'session') ||
    (row.fork === null) !== (row.scope === 'code')
  )
    throw invalid();
  const commands: string[] = [];
  for (const kind of ['code', 'fork'] as const) {
    if (row[kind] === null) continue;
    const leg = object(row[kind], ['request', 'requestDigest', 'phase']);
    if (!hash(leg.requestDigest) || !phases.has(leg.phase as string)) throw invalid();
    const request = object(
      leg.request,
      kind === 'code'
        ? [
            'expectedStoreId',
            'commandId',
            'kind',
            'extensionId',
            'actionId',
            'definitionVersion',
            'input',
          ]
        : [
            'expectedStoreId',
            'commandId',
            'expectedContextSelectionId',
            'boundary',
            'newSessionId',
            'title',
          ],
    );
    if (request.expectedStoreId !== row.storeId || !id(request.commandId)) throw invalid();
    commands.push(request.commandId);
    let canonical: Json;
    if (kind === 'code') {
      const input = object(request.input, ['checkpointId', 'restoreId']);
      if (
        request.kind !== 'extension.invoke' ||
        request.extensionId !== 'builtin.files' ||
        request.actionId !== 'files.checkpoint.restore' ||
        request.definitionVersion !== '1' ||
        input.checkpointId !== point.id ||
        !id(input.restoreId)
      )
        throw invalid();
      canonical = {
        kind: 'extension.invoke',
        extensionId: 'builtin.files',
        actionId: 'files.checkpoint.restore',
        definitionVersion: '1',
        input: input as Json,
      };
    } else {
      text(request.title, 1, 512);
      if (
        Buffer.byteLength(request.title) > 4096 ||
        !id(request.newSessionId) ||
        request.newSessionId === row.sessionId ||
        request.expectedContextSelectionId !== row.contextSelectionId ||
        canonicalJson(request.boundary as Json) !== canonicalJson(row.boundary as Json)
      )
        throw invalid();
      message(request.boundary, true);
      canonical = {
        kind: 'session.create',
        title: request.title,
        fork: {
          sourceSessionId: row.sessionId as string,
          expectedContextSelectionId: row.contextSelectionId as string,
          boundary: request.boundary as Json,
        },
      };
    }
    if (sha(canonical) !== leg.requestDigest) throw invalid();
  }
  if (new Set(commands).size !== commands.length) throw invalid();
  if (
    row.scope === 'both' &&
    (row.fork as { phase: string }).phase !== 'not_started' &&
    (row.code as { phase: string }).phase !== 'succeeded'
  )
    throw invalid();
  return { row, commands, intentId: commands[0]! };
}
export function verifyFileRecoveryIntentRecords(records: unknown): void {
  if (!Array.isArray(records) || records.length > 128) throw invalid();
  const commands = new Set<string>();
  for (const value of records) {
    for (const command of verifyFileRecoveryIntent(value).commands) {
      if (commands.has(command)) throw invalid();
      commands.add(command);
    }
  }
}
export function verifyDesktopFileRecoveryRows(db: Database): void {
  const records: unknown[] = [];
  let bytes = 0;
  try {
    for (const row of db
      .query<{ intent_id: string; state: string; state_hex: string }, []>(
        'SELECT intent_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM file_recovery_intents ORDER BY intent_id',
      )
      .iterate()) {
      if (
        typeof row.state !== 'string' ||
        Buffer.from(row.state).toString('hex').toUpperCase() !== row.state_hex ||
        records.length >= 128
      )
        throw invalid();
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16 * 1024 * 1024) throw invalid();
      const value = JSON.parse(row.state);
      if (verifyFileRecoveryIntent(value).intentId !== row.intent_id) throw invalid();
      records.push(value);
    }
    verifyFileRecoveryIntentRecords(records);
  } catch {
    throw invalid();
  }
}
export function verifyFileRecoveryIntentsDocument(path: string): void {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      (process.platform !== 'win32' && (Number(before.mode) & 0o777) !== 0o600) ||
      before.nlink !== 1n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 16n * 1024n * 1024n
    )
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const size = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!size) throw invalid();
      offset += size;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'uid', 'nlink'].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      throw invalid();
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), [
      'version',
      'records',
    ]);
    if (value.version !== 1) throw invalid();
    verifyFileRecoveryIntentRecords(value.records);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw invalid();
  } finally {
    closeSync(fd);
  }
}
