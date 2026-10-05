import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { MaintenanceError } from './types';

const canonical = (value: unknown) => canonicalJson(value as Json);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = (value: unknown) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) < 9223372036854775807n;
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error();
}
const answerRequestDigest = (interactionId: string, request: Record<string, Json>) =>
  digest({
    kind: 'interaction.answer',
    interactionId,
    expectedRevision: request.expectedRevision,
    answer: request.answer,
  });
function validateAnswerRecord(raw: unknown): void {
  closed(raw, ['intent', 'phase']);
  closed(raw.intent, [
    'scope',
    'subjectId',
    'interaction',
    'observationDigest',
    'request',
    'bodyDigest',
    'requestDigest',
  ]);
  const intent = raw.intent;
  closed(intent.scope, ['storeId', 'sessionId', 'workspaceId', 'contextSelectionId']);
  closed(intent.interaction, [
    'id',
    'sessionId',
    'executionId',
    'runId',
    'revision',
    'kind',
    'attempt',
    'definitionId',
    'definitionVersion',
    'inputDigest',
    'policyRevision',
  ]);
  closed(intent.request, ['expectedStoreId', 'commandId', 'expectedRevision', 'answer']);
  const target = intent.interaction,
    request = intent.request;
  if (
    !Object.values(intent.scope).every(id) ||
    ![target.id, target.sessionId, target.executionId].every(id) ||
    !(target.runId === null || id(target.runId)) ||
    !decimal(target.revision) ||
    !Number.isSafeInteger(target.attempt) ||
    Number(target.attempt) < 1 ||
    !['approval', 'question', 'plan_review'].includes(String(target.kind)) ||
    ![
      target.definitionId,
      target.definitionVersion,
      target.inputDigest,
      target.policyRevision,
    ].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 4096) ||
    typeof intent.subjectId !== 'string' ||
    !intent.subjectId ||
    intent.subjectId.length > 256 ||
    !hash(intent.observationDigest) ||
    !id(request.commandId) ||
    request.expectedStoreId !== intent.scope.storeId ||
    request.expectedRevision !== target.revision ||
    !['submitting', 'unknown', 'accepted', 'failed'].includes(String(raw.phase))
  )
    throw Error();
  const answer = request.answer;
  if (
    !answer ||
    typeof answer !== 'object' ||
    Array.isArray(answer) ||
    !('kind' in answer) ||
    answer.kind !== target.kind
  )
    throw Error();
  if (answer.kind === 'approval') {
    closed(answer, ['kind', 'decision', ...('grant' in answer ? ['grant'] : [])]);
    if (
      !['approve', 'deny'].includes(String((answer as Record<string, unknown>).decision)) ||
      ('grant' in answer && !['approve_once', 'same_command'].includes(String(answer.grant)))
    )
      throw Error();
  } else if (answer.kind === 'question') closed(answer, ['kind', 'answers']);
  else {
    closed(answer, [
      'kind',
      'decision',
      ...('feedback' in answer ? ['feedback'] : []),
      ...('mode' in answer ? ['mode'] : []),
    ]);
    if (
      !['approve', 'deny', 'revise'].includes(
        String((answer as Record<string, unknown>).decision),
      ) ||
      ('feedback' in answer && typeof answer.feedback !== 'string') ||
      ('mode' in answer && typeof answer.mode !== 'string')
    )
      throw Error();
  }
  const json = JSON.stringify(raw);
  const stack: unknown[] = [answer];
  const seen = new Set<object>();
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error();
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  if (
    Buffer.byteLength(json) > 4 * 1048576 ||
    canonical(JSON.parse(json)) !== canonical(raw) ||
    intent.bodyDigest !== digest(request) ||
    intent.requestDigest !== answerRequestDigest(String(target.id), request as Record<string, Json>)
  )
    throw Error();
}

/** DB5 answer requests remain original caller bytes, never restored receipt or POST authority. */
export function verifyDesktopAnswerRows(db: Database): void {
  let bytes = 0,
    count = 0;
  const commands = new Set<string>(),
    targets = new Set<string>();
  try {
    for (const row of db
      .query<{ command_id: string; state: string; state_hex: string }, []>(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM answer_intents ORDER BY command_id',
      )
      .iterate()) {
      if (
        typeof row.command_id !== 'string' ||
        typeof row.state !== 'string' ||
        Buffer.from(row.state).toString('hex').toUpperCase() !== row.state_hex ||
        ++count > 128
      )
        throw Error();
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16 * 1048576) throw Error();
      const value: unknown = JSON.parse(row.state);
      validateAnswerRecord(value);
      const record = value as {
        intent: {
          scope: { storeId: string };
          interaction: { id: string; revision: string };
          request: { commandId: string };
        };
      };
      const intent = record.intent,
        target = `${intent.scope.storeId}/${intent.interaction.id}/${intent.interaction.revision}`;
      if (
        row.command_id !== intent.request.commandId ||
        commands.has(row.command_id) ||
        targets.has(target)
      )
        throw Error();
      commands.add(row.command_id);
      targets.add(target);
    }
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
