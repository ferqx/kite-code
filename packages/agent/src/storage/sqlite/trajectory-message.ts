import { createHash } from 'node:crypto';
import { trajectoryEventSchema, trajectoryIdentityPayload } from '@kite-ai/trajectory';
import { canonicalJson } from '../../json';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
function json(value: unknown): Record<string, Json> | null {
  try {
    return typeof value === 'string' ? object(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const intact = (row: Row, request: Record<string, Json> | null) =>
  request !== null && digest(request) === row.request_digest;

/** Descriptions never carry a local URI, transport body or access authority. */
export function trajectoryMessageAttachments(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const attachment = object(item);
    if (typeof attachment?.name !== 'string') return [];
    const reference = object(attachment.reference);
    return [
      {
        name: attachment.name,
        ...(typeof reference?.mediaType === 'string' ? { mediaType: reference.mediaType } : {}),
        ...(typeof reference?.size === 'string' && /^(0|[1-9][0-9]*)$/.test(reference.size)
          ? { size: reference.size }
          : {}),
      },
    ];
  });
}

function userCommand(db: SqliteOperations, message: Row, source: Record<string, Json>, run: Row) {
  if (
    !Array.isArray(source.sourceIds) ||
    source.sourceIds.length !== 1 ||
    typeof source.sourceIds[0] !== 'string'
  )
    return null;
  const command = db.row(
    'SELECT * FROM command WHERE id=? AND session_id=?',
    source.sourceIds[0],
    message.session_id!,
  );
  const request = json(command?.request_json);
  const session = db.row('SELECT parent_id,root_id FROM session WHERE id=?', message.session_id!);
  const creator =
    session &&
    db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      session.root_id!,
    );
  if (
    !command ||
    !request ||
    session?.parent_id !== null ||
    creator?.subject_id !== command.subject_id ||
    !intact(command, request) ||
    command.cancelled ||
    !['accepted', 'applied'].includes(String(command.status)) ||
    request.content !== source.content ||
    !['run.start', 'input.steer', 'input.follow_up'].includes(String(command.kind))
  )
    return null;
  if (
    command.kind === 'run.start'
      ? run.origin_command_id !== command.id
      : source.originCommandId !== command.id ||
        source.inputKind !== command.kind ||
        (request.targetRunId !== run.id && run.origin_command_id !== command.id)
  )
    return null;
  if (
    command.kind === 'run.start' &&
    db.row(
      "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='user' ORDER BY seq LIMIT 1",
      message.session_id!,
      run.id!,
    )?.id !== message.id
  )
    return null;
  if (
    canonicalJson(request.images ?? []) !== canonicalJson(source.images ?? []) ||
    canonicalJson(request.files ?? []) !== canonicalJson(source.files ?? [])
  )
    return null;
  if (command.target_command_id) {
    const target = db.row('SELECT * FROM command WHERE id=?', command.target_command_id);
    const targetRequest = json(target?.request_json);
    const raw =
      target?.kind === 'human.input'
        ? target
        : target?.kind === 'human.input.decision' &&
            typeof targetRequest?.inputCommandId === 'string'
          ? db.row(
              "SELECT * FROM command WHERE id=? AND kind='human.input'",
              targetRequest.inputCommandId,
            )
          : null;
    const rawRequest = json(raw?.request_json);
    if (
      !raw ||
      !rawRequest ||
      raw.session_id !== message.session_id ||
      raw.subject_id !== command.subject_id ||
      raw.origin_store_id !== command.origin_store_id ||
      !intact(raw, rawRequest) ||
      rawRequest.content !== source.content
    )
      return null;
    if (
      target?.kind === 'human.input.decision' &&
      (!intact(target, targetRequest) || targetRequest?.inputDigest !== raw.request_digest)
    )
      return null;
  }
  return command;
}

function publicInterpretation(
  db: SqliteOperations,
  message: Row,
  model: Row,
  marker: Record<string, Json>,
) {
  if (typeof marker.inputCommandId !== 'string' || typeof marker.inputDigest !== 'string')
    return null;
  const raw = db.row(
    "SELECT * FROM command WHERE id=? AND session_id=? AND kind='human.input'",
    marker.inputCommandId,
    message.session_id!,
  );
  if (
    !raw ||
    raw.origin_store_id !== model.origin_store_id ||
    raw.request_digest !== marker.inputDigest ||
    !intact(raw, json(raw.request_json))
  )
    return null;
  const receipt = json(raw.receipt_json);
  const observation = object(receipt?.observation);
  const decision =
    typeof receipt?.decisionCommandId === 'string'
      ? db.row(
          "SELECT * FROM command WHERE id=? AND session_id=? AND kind='human.input.decision'",
          receipt.decisionCommandId,
          message.session_id!,
        )
      : null;
  const decisionRequest = json(decision?.request_json),
    interpretation = object(decisionRequest?.interpretation);
  const exact =
    observation !== null &&
    observation.executionId === model.id &&
    observation.messageId === message.id &&
    observation.runId === model.run_id &&
    decision !== null &&
    decisionRequest !== null &&
    interpretation !== null &&
    intact(decision, decisionRequest) &&
    decision.subject_id === raw.subject_id &&
    decision.origin_store_id === raw.origin_store_id &&
    decisionRequest.inputCommandId === raw.id &&
    decisionRequest.inputDigest === raw.request_digest &&
    interpretation.executionId === model.id &&
    interpretation.answer === observation.answer &&
    interpretation.clarification === observation.clarification;
  const answer = exact && typeof observation.answer === 'string' ? observation.answer : '';
  const clarification =
    exact && typeof observation.clarification === 'string' ? observation.clarification : '';
  return {
    content: exact
      ? clarification || answer || '输入关联已记录。'
      : message.status === 'incomplete'
        ? '正在核实这条输入与原工作的关联…'
        : '输入解释已保存，等待核实原输入的关联。',
  };
}

/** Called only in the source mutation transaction. Readers never consult mutable Message/receipt rows. */
export function trajectoryMessage(
  db: SqliteOperations,
  sessionId: string,
  objectId: string,
  sourceEventType: string,
  currentStoreId: string,
) {
  let messageId = objectId;
  if (sourceEventType === 'human.input_decided') {
    const decision = db.row(
      "SELECT * FROM command WHERE id=? AND session_id=? AND kind='human.input.decision'",
      objectId,
      sessionId,
    );
    const request = json(decision?.request_json),
      receipt = json(decision?.receipt_json),
      observation = object(receipt?.observation),
      interpretation = object(request?.interpretation);
    if (
      !decision ||
      !intact(decision, request) ||
      typeof request?.inputCommandId !== 'string' ||
      typeof observation?.messageId !== 'string'
    )
      return null;
    const raw = db.row(
      "SELECT * FROM command WHERE id=? AND session_id=? AND kind='human.input'",
      request.inputCommandId,
      sessionId,
    );
    const rawReceipt = json(raw?.receipt_json);
    if (
      !raw ||
      !interpretation ||
      !intact(raw, json(raw.request_json)) ||
      decision.subject_id !== raw.subject_id ||
      decision.origin_store_id !== raw.origin_store_id ||
      interpretation?.executionId !== observation.executionId ||
      interpretation.answer !== observation.answer ||
      interpretation.clarification !== observation.clarification ||
      rawReceipt?.decisionCommandId !== objectId ||
      canonicalJson(rawReceipt.observation ?? null) !== canonicalJson(observation) ||
      request.inputDigest !== raw.request_digest
    )
      return null;
    messageId = observation.messageId;
  } else if (sourceEventType !== 'message.updated') return null;
  const message = db.row('SELECT * FROM message WHERE id=? AND session_id=?', messageId, sessionId),
    source = json(message?.source_json);
  if (
    !message ||
    !source ||
    message.fork_source_message_id ||
    !['user', 'assistant'].includes(String(message.role)) ||
    !['complete', 'incomplete'].includes(String(message.status)) ||
    typeof source.content !== 'string' ||
    !message.run_id
  )
    return null;
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', message.run_id, sessionId);
  if (!run) return null;
  let model: Row | null = null,
    command: Row | null = null;
  let body: Record<string, Json> = {
    content: source.content,
    images: trajectoryMessageAttachments(source.images),
    files: trajectoryMessageAttachments(source.files),
  };
  let checkpoint: Record<string, Json> | null = null;
  if (message.role === 'user') {
    if (sourceEventType !== 'message.updated') return null;
    command = userCommand(db, message, source, run);
    if (!command) return null;
  } else {
    if (
      !Array.isArray(source.sourceIds) ||
      source.sourceIds.length === 0 ||
      source.sourceIds.length > 64 ||
      source.sourceIds.some((id) => typeof id !== 'string')
    )
      return null;
    if (source.sourceIds.length > 1) {
      if (sourceEventType !== 'message.updated' || source.modelOutput !== undefined) return null;
      for (const sourceId of source.sourceIds) {
        const contributor = db.row(
          "SELECT * FROM execution WHERE id=? AND session_id=? AND run_id=? AND kind='model'",
          String(sourceId),
          sessionId,
          run.id!,
        );
        const decision = contributor && json(contributor.decision_source_json);
        if (
          !contributor ||
          !decision ||
          contributor.origin_command_id !== run.origin_command_id ||
          decision.compressionId !== undefined ||
          decision.humanInputInterpretation !== undefined
        )
          return null;
      }
      command = db.row(
        'SELECT * FROM command WHERE id=? AND session_id=?',
        run.origin_command_id!,
        sessionId,
      );
      if (!command || command.kind === 'session.title') return null;
    } else {
      model = db.row(
        "SELECT * FROM execution WHERE id=? AND session_id=? AND run_id=? AND kind='model'",
        String(source.sourceIds[0]),
        sessionId,
        run.id!,
      );
      if (!model) return null;
      command = db.row(
        'SELECT * FROM command WHERE id=? AND session_id=?',
        model.origin_command_id!,
        sessionId,
      );
      const decisionSource = json(model.decision_source_json);
      if (
        !command ||
        decisionSource?.compressionId !== undefined ||
        command.kind === 'session.title'
      )
        return null;
      const marker = object(decisionSource?.humanInputInterpretation);
      if (decisionSource?.humanInputInterpretation !== undefined) {
        const interpreted = marker && publicInterpretation(db, message, model, marker);
        if (!interpreted) return null;
        body = interpreted;
      } else {
        if (sourceEventType !== 'message.updated') return null;
        checkpoint = {
          originStoreId: String(model.origin_store_id),
          subjectId: String(command.subject_id),
          identity: {
            executionId: String(model.id),
            sessionId,
            rootSessionId: String(model.root_session_id),
            runId: String(run.id),
            originCommandId: String(model.origin_command_id),
            rootWorkCommandId: String(model.root_work_command_id),
            rootWorkSeq: String(model.root_work_seq),
            attempt: Number(model.attempt),
            status: String(model.state),
            confirmation: model.state === 'succeeded' ? 'succeeded' : 'unconfirmed',
            modelId: String(model.adapter_id),
          },
          output: source,
        };
      }
    }
  }
  const parts = db.rows(
    'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal LIMIT 2',
    message.id!,
  );
  if (
    parts.length !== 1 ||
    parts.some(
      (part) =>
        part.kind !== 'text' ||
        String(part.content_version) !== '1' ||
        !json(part.json) ||
        canonicalJson(json(part.json)) !== canonicalJson(source),
    )
  )
    return null;
  let messageOriginStoreId: string | undefined;
  const prior = db.row(
    "SELECT cursor,scope_session_id,object_id,type,trajectory_fact_json FROM change_event WHERE scope_session_id=? AND object_id=? AND type='message.updated' ORDER BY cursor DESC LIMIT 1",
    sessionId,
    message.id!,
  );
  const fact = json(prior?.trajectory_fact_json);
  const original = trajectoryEventSchema.safeParse(fact?.event);
  if (
    fact?.format === 'kite.trajectory-fact' &&
    fact.version === 1 &&
    original.success &&
    original.data.kind === 'message' &&
    original.data.identityConfidence === 'verified_origin' &&
    original.data.sequence === String(prior?.cursor) &&
    original.data.origin.cursor === String(prior?.cursor) &&
    original.data.sourceEventType === prior?.type &&
    original.data.sourceRecordRevision === String(prior?.cursor) &&
    original.data.attributes.revision === String(prior?.cursor) &&
    original.data.eventId ===
      `te_${createHash('sha256').update(trajectoryIdentityPayload(original.data.origin)).digest('hex')}` &&
    original.data.sessionId === sessionId &&
    original.data.attributes.messageId === message.id &&
    original.data.attributes.messageId === prior?.object_id
  )
    messageOriginStoreId = original.data.messageOriginStoreId;
  else if (
    !prior &&
    sourceEventType === 'message.updated' &&
    parts.every((part) => String(part.revision) === '0')
  )
    messageOriginStoreId = currentStoreId;
  return {
    message,
    model,
    command,
    body,
    checkpoint,
    parts: parts.map((part) => ({
      ordinal: String(part.ordinal),
      kind: String(part.kind),
      contentVersion: String(part.content_version),
      revision: String(part.revision),
      value: json(part.json),
    })),
    messageOriginStoreId,
  };
}
