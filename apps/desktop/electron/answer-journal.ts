import type {
  AgentClient,
  AnswerInteractionRequest,
  Command,
  Interaction,
  SessionView,
} from '@kite-ai/client';
import type { InteractionAnswerSubmission } from '../src/controller';
import { verifyInteractionAnswerReceipt } from '../src/controller';
import type { NativeAnswerMetadata } from '../src/native-bridge';
import { callerCanonical, callerDigest } from './caller-journal';

export type NativeAnswerIntent = {
  scope: { storeId: string; sessionId: string; workspaceId: string; contextSelectionId: string };
  subjectId: string;
  interaction: Pick<
    Interaction,
    | 'id'
    | 'sessionId'
    | 'executionId'
    | 'runId'
    | 'revision'
    | 'kind'
    | 'attempt'
    | 'definitionId'
    | 'definitionVersion'
    | 'inputDigest'
    | 'policyRevision'
  >;
  observationDigest: string;
  request: AnswerInteractionRequest;
  bodyDigest: string;
  requestDigest: string;
};
export type NativeAnswerRecord = {
  intent: NativeAnswerIntent;
  phase: 'submitting' | 'unknown' | 'accepted' | 'failed';
};
export interface NativeAnswerData {
  answers(): NativeAnswerRecord[];
  beginAnswer(record: NativeAnswerRecord): { created: boolean; value: NativeAnswerRecord };
  finishAnswer(commandId: string, phase: NativeAnswerRecord['phase']): NativeAnswerRecord;
}
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
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('answer_storage_unavailable');
}
export const answerRequestDigest = (interactionId: string, request: AnswerInteractionRequest) =>
  callerDigest({
    kind: 'interaction.answer',
    interactionId,
    expectedRevision: request.expectedRevision,
    answer: request.answer,
  });
export function validateAnswerRecord(raw: unknown): NativeAnswerRecord {
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
    throw Error('answer_storage_unavailable');
  const answer = request.answer;
  if (
    !answer ||
    typeof answer !== 'object' ||
    Array.isArray(answer) ||
    !('kind' in answer) ||
    answer.kind !== target.kind
  )
    throw Error('answer_storage_unavailable');
  if (answer.kind === 'approval') {
    closed(answer, ['kind', 'decision', ...('grant' in answer ? ['grant'] : [])]);
    if (
      !['approve', 'deny'].includes(String((answer as Record<string, unknown>).decision)) ||
      ('grant' in answer && !['approve_once', 'same_command'].includes(String(answer.grant)))
    )
      throw Error('answer_storage_unavailable');
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
      throw Error('answer_storage_unavailable');
  }
  const json = JSON.stringify(raw);
  const stack: unknown[] = [answer];
  const seen = new Set<object>();
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'number' && !Number.isFinite(value))
      throw Error('answer_storage_unavailable');
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  if (
    Buffer.byteLength(json) > 4 * 1048576 ||
    callerCanonical(JSON.parse(json)) !== callerCanonical(raw) ||
    intent.bodyDigest !== callerDigest(request) ||
    intent.requestDigest !==
      answerRequestDigest(String(target.id), request as unknown as AnswerInteractionRequest)
  )
    throw Error('answer_storage_unavailable');
  return structuredClone(raw) as NativeAnswerRecord;
}
const key = (record: NativeAnswerRecord) =>
  `${record.intent.scope.storeId}/${record.intent.interaction.id}/${record.intent.interaction.revision}`;
export function assertAnswerRecords(records: readonly NativeAnswerRecord[]) {
  const targets = new Set<string>(),
    commands = new Set<string>();
  for (const record of records) {
    if (targets.has(key(record)) || commands.has(record.intent.request.commandId))
      throw Error('answer_intent_conflict');
    targets.add(key(record));
    commands.add(record.intent.request.commandId);
  }
}
/** Local intents are durable evidence only. This class deliberately exposes no cold POST method. */
export class NativeAnswerJournal {
  private readonly client: AgentClient;
  private readonly data: NativeAnswerData;
  constructor(client: AgentClient, data: NativeAnswerData) {
    this.client = client;
    this.data = data;
  }
  records() {
    const records = this.data.answers();
    assertAnswerRecords(records);
    return records;
  }
  metadata(view?: SessionView): NativeAnswerMetadata[] {
    return this.records().map(({ intent, phase }) => ({
      scope: intent.scope,
      subjectId: intent.subjectId,
      interaction: {
        id: intent.interaction.id,
        revision: intent.interaction.revision,
        kind: intent.interaction.kind,
      },
      bodyDigest: intent.bodyDigest,
      requestDigest: intent.requestDigest,
      request: {
        expectedStoreId: intent.request.expectedStoreId,
        commandId: intent.request.commandId,
        expectedRevision: intent.request.expectedRevision,
      },
      phase: phase === 'submitting' ? 'unknown' : phase,
      association:
        this.client.serverInfo?.storeId === intent.scope.storeId &&
        this.client.serverInfo?.subjectId === intent.subjectId &&
        view?.storeId === intent.scope.storeId &&
        view.session.id === intent.scope.sessionId &&
        view.session.workspaceId === intent.scope.workspaceId &&
        view.session.contextSelectionId === intent.scope.contextSelectionId
          ? 'current'
          : 'unavailable',
    }));
  }
  saved(interaction: Interaction) {
    return this.records().find(
      (record) =>
        record.intent.scope.storeId === interaction.originStoreId &&
        record.intent.interaction.id === interaction.id &&
        record.intent.interaction.revision === interaction.revision,
    );
  }
  async prepare(submission: InteractionAnswerSubmission, view: SessionView) {
    const card = submission.interaction,
      request = submission.intent,
      subjectId = this.client.serverInfo?.subjectId;
    if (
      !subjectId ||
      view.storeId !== card.originStoreId ||
      view.session.id !== card.presentationSessionId ||
      this.client.serverInfo?.storeId !== card.originStoreId ||
      request.expectedStoreId !== card.originStoreId ||
      request.expectedRevision !== card.revision ||
      card.state !== 'pending'
    )
      throw Error('answer_scope_unavailable');
    if (this.saved(card)) throw Error('interaction_answer_already_saved');
    const {
      id,
      sessionId,
      executionId,
      runId,
      revision,
      kind,
      attempt,
      definitionId,
      definitionVersion,
      inputDigest,
      policyRevision,
    } = card;
    const row = validateAnswerRecord({
      intent: {
        scope: {
          storeId: view.storeId,
          sessionId: view.session.id,
          workspaceId: view.session.workspaceId,
          contextSelectionId: view.session.contextSelectionId,
        },
        subjectId,
        interaction: {
          id,
          sessionId,
          executionId,
          runId,
          revision,
          kind,
          attempt,
          definitionId,
          definitionVersion,
          inputDigest,
          policyRevision,
        },
        observationDigest: callerDigest(card),
        request: structuredClone(request),
        bodyDigest: callerDigest(request),
        requestDigest: answerRequestDigest(card.id, request),
      },
      phase: 'submitting',
    });
    if (!this.data.beginAnswer(row).created) throw Error('interaction_answer_already_saved');
  }
  finish(submission: InteractionAnswerSubmission) {
    const row = this.records().find(
      (record) => record.intent.request.commandId === submission.intent.commandId,
    );
    if (
      !row ||
      callerCanonical(row.intent.request) !== callerCanonical(submission.intent) ||
      row.intent.interaction.id !== submission.interaction.id ||
      row.intent.scope.sessionId !== submission.interaction.presentationSessionId
    )
      throw Error('answer_intent_conflict');
    if (submission.phase === 'accepted' && !submission.receipt)
      throw Error('answer_receipt_unavailable');
    if (submission.receipt && ['accepted', 'failed'].includes(submission.phase)) {
      verifyInteractionAnswerReceipt(submission.interaction, submission.intent, submission.receipt);
      if (
        submission.receipt.subjectId !== row.intent.subjectId ||
        submission.receipt.requestDigest !== row.intent.requestDigest
      )
        throw Error('answer_receipt_unavailable');
    }
    this.data.finishAnswer(
      submission.intent.commandId,
      submission.phase === 'accepted'
        ? 'accepted'
        : submission.phase === 'failed'
          ? 'failed'
          : 'unknown',
    );
  }
  async lookup(commandId: string): Promise<Command> {
    const record = this.records().find((row) => row.intent.request.commandId === commandId);
    if (!record) throw Error('answer_intent_missing');
    const intent = record.intent;
    if (
      this.client.serverInfo?.storeId !== intent.scope.storeId ||
      this.client.serverInfo?.subjectId !== intent.subjectId
    )
      throw Error('answer_origin_unavailable');
    try {
      const view = await this.client.getView(intent.scope.sessionId);
      if (
        view.storeId !== intent.scope.storeId ||
        view.session.id !== intent.scope.sessionId ||
        view.session.workspaceId !== intent.scope.workspaceId
      )
        throw Error('answer_origin_unavailable');
      const command = await this.client.getCommand(commandId);
      const phase = verifyInteractionAnswerReceipt(
        { id: intent.interaction.id, presentationSessionId: intent.scope.sessionId },
        intent.request,
        command,
      );
      if (command.subjectId !== intent.subjectId || command.requestDigest !== intent.requestDigest)
        throw Error('answer_receipt_unavailable');
      this.data.finishAnswer(commandId, phase);
      return command;
    } catch (error) {
      this.data.finishAnswer(commandId, 'unknown');
      throw error;
    }
  }
}
