import { createHash } from 'node:crypto';
import {
  compressionPresentationSchema,
  type KnownTrajectoryPhase,
  type TrajectoryEvent,
  trajectoryEventSchema,
  trajectoryIdentityPayload,
} from '@kite-ai/trajectory';
import { canonicalJson } from '../../json';
import { messageTrajectoryDisplay, modelTrajectoryDisplay } from '../../trajectory/display';
import { fileChangeEvidence } from '../../trajectory/evidence-projection';
import { toolResultPresentation } from '../../trajectory/tool-result-presentation';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';
import {
  trajectoryJobDisplay,
  trajectoryToolDefinition,
  trajectoryToolDisplay,
} from './trajectory-display';
import { trajectoryMessage } from './trajectory-message';
import { trajectoryOutputPresence } from './trajectory-output-presence';

type Row = Record<string, string | number | bigint | null>;
/** Private material checkpoints never cross the event API. Their content is read by typed owners. */
export interface TrajectoryBinding {
  evidenceId: string;
  contentVersion: string;
  kind: TrajectoryEvent['evidenceRefs'][number]['kind'];
  value: Json;
}
export interface RecordedTrajectoryFact {
  format: 'kite.trajectory-fact';
  version: 1;
  event: TrajectoryEvent;
  bindings: TrajectoryBinding[];
}
/** Only the verified mutation-check owner supplies this record family, never arbitrary extension records. */
export interface VerificationTrajectoryFact {
  kind: 'verification';
  runId: string;
  executionId: string;
  targetExecutionId: string;
  verificationId: string;
  revision: string;
  outcome: 'passed' | 'failed' | 'inconclusive' | 'superseded';
  evidence: Json;
}
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function object(value: unknown): Record<string, Json> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}
function parsed(value: unknown): Json {
  return typeof value === 'string' ? (JSON.parse(value) as Json) : null;
}
/** Classification is sealed only from the original compression owner record and its exact Model. */
function compressionAttribution(db: SqliteOperations, snapshot: Row, execution?: Row | null) {
  if (!['compression_pending', 'compression'].includes(String(snapshot.kind))) return null;
  let record: Record<string, Json> | null;
  try {
    record = object(parsed(snapshot.request_json));
  } catch {
    return null;
  }
  if (
    !record ||
    record.id !== snapshot.id ||
    record.sessionId !== snapshot.session_id ||
    record.contextSelectionId !== snapshot.selection_id ||
    typeof record.modelExecutionId !== 'string' ||
    typeof record.runId !== 'string' ||
    (record.trigger !== 'automatic' && record.trigger !== 'manual')
  )
    return null;
  const model =
    execution ??
    db.row(
      "SELECT * FROM execution WHERE id=? AND session_id=? AND kind='model'",
      record.modelExecutionId,
      snapshot.session_id!,
    );
  if (
    model?.kind !== 'model' ||
    record.modelExecutionId !== model.id ||
    record.sessionId !== model.session_id ||
    record.runId !== model.run_id ||
    record.originStoreId !== model.origin_store_id ||
    (snapshot.kind === 'compression' &&
      (model.state !== 'succeeded' || record.publishedSeq !== String(snapshot.seq))) ||
    object(parsed(model.decision_source_json))?.compressionId !== record.id
  )
    return null;
  const run = db.row(
    'SELECT context_selection_id,origin_command_id FROM run WHERE id=? AND session_id=?',
    record.runId,
    snapshot.session_id!,
  );
  if (
    !run ||
    run.context_selection_id !== record.contextSelectionId ||
    run.origin_command_id !== model.origin_command_id
  )
    return null;
  return {
    compressionId: String(snapshot.id),
    compressionTrigger: record.trigger as 'automatic' | 'manual',
    executionId: String(model.id),
    compression: compressionPresentationSchema.parse({
      ...(object(record.compression) ?? {}),
      adopted: snapshot.kind === 'compression',
    }),
  };
}
/** The exact Model checkpoint, also reusable by its publication event. No future row lookup. */
function modelMaterial(db: SqliteOperations, row: Row, sessionId: string) {
  const command = db.row(
    'SELECT subject_id FROM command WHERE id=? AND session_id=?',
    row.origin_command_id!,
    sessionId,
  );
  if (!command) throw new Error('trajectory_material_scope_invalid');
  return {
    originStoreId: String(row.origin_store_id),
    subjectId: String(command.subject_id),
    identity: {
      executionId: String(row.id),
      sessionId,
      rootSessionId: String(row.root_session_id),
      runId: row.run_id === null ? null : String(row.run_id),
      originCommandId: String(row.origin_command_id),
      rootWorkCommandId: String(row.root_work_command_id),
      rootWorkSeq: String(row.root_work_seq),
      attempt: Number(row.attempt),
      status: String(row.state),
      confirmation: row.state === 'succeeded' ? 'succeeded' : 'unconfirmed',
      modelId: String(row.adapter_id),
    },
  };
}
function phase(status: string | null): KnownTrajectoryPhase {
  switch (status) {
    case 'succeeded':
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'outcome_unknown':
      return 'outcome_unknown';
    case 'planned':
    case 'dispatching':
    case 'running':
    case 'waiting_interaction':
    case 'waiting_execution':
    case 'cancelling':
      return status;
    default:
      return 'observed';
  }
}
const reasonCode = (value: unknown) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : undefined;

/** Runs inside the original write transaction, after the business record has changed. */
export function recordTrajectoryFact(
  db: SqliteOperations,
  sessionId: string | null,
  objectId: string,
  sourceEventType: string,
  occurredAt: number,
  verification?: VerificationTrajectoryFact,
): string | null {
  if (sessionId === null) return null;
  const session = db.row('SELECT * FROM session WHERE id=?', sessionId);
  if (!session) return null;
  const meta = db.row('SELECT store_id,last_change_cursor FROM storage_meta WHERE singleton=1')!;
  const origin = { storeId: String(meta.store_id), cursor: String(meta.last_change_cursor) };
  const eventId = `te_${createHash('sha256').update(trajectoryIdentityPayload(origin)).digest('hex')}`;
  const bindings: TrajectoryBinding[] = [];
  const evidenceRefs: TrajectoryEvent['evidenceRefs'] = [];
  const bind = (
    kind: TrajectoryBinding['kind'],
    value: Json,
    availability: TrajectoryEvent['evidenceRefs'][number]['availability'] = 'available',
    mediaType = 'application/json',
  ) => {
    const contentVersion = hash(value);
    const evidenceId = `ev_${hash([eventId, kind, contentVersion])}`;
    if (availability !== 'redacted') bindings.push({ evidenceId, contentVersion, kind, value });
    const reference = {
      evidenceId,
      contentVersion,
      kind,
      availability,
      mediaType,
    };
    evidenceRefs.push(reference);
    return reference;
  };
  let row: Row | null = null;
  let kind: TrajectoryEvent['kind'] = 'unknown';
  let attributes: Record<string, Json> = { reason: 'unrecognized_source_type' };
  let compressionExecutionId: string | undefined;
  const message = trajectoryMessage(db, sessionId, objectId, sourceEventType, origin.storeId);
  // Table choices are closed owner families, never event payload or extension SQL.
  if (
    sourceEventType.startsWith('execution.') ||
    sourceEventType.startsWith('action.') ||
    sourceEventType.startsWith('authorization.')
  )
    row = db.row('SELECT * FROM execution WHERE id=? AND session_id=?', objectId, sessionId);
  if (message) {
    row = {
      ...message.message,
      execution_id: message.model?.id ?? null,
      origin_command_id: message.command.id!,
    };
    kind = 'message';
    attributes = {
      messageId: String(row.id),
      role: String(row.role),
      messageSeq: String(row.seq),
      revision: origin.cursor,
      status: String(row.status),
      display: messageTrajectoryDisplay(
        row.role as 'user' | 'assistant',
        message.body,
      ) as unknown as Json,
    };
    const reference = bind(
      'message',
      {
        subjectId: String(message.command.subject_id),
        body: message.body,
        checkpoint: message.checkpoint,
        parts: message.parts,
      },
      row.status === 'incomplete' ? 'partial' : 'available',
    );
    if (row.role === 'assistant' && message.model && message.checkpoint) {
      const presence = trajectoryOutputPresence(
        db,
        message.model,
        message.checkpoint.output,
        row.status === 'complete',
        reference,
      );
      if (presence)
        attributes.display = {
          ...object(attributes.display),
          outputPresence: presence,
        } as unknown as Json;
    }
  } else if (row) {
    kind = row.kind as 'model' | 'tool' | 'job';
    attributes = {
      definitionId: String(row.adapter_id),
      definitionVersion: String(row.definition_version),
      commandId: String(row.origin_command_id),
      rootWorkCommandId: String(row.root_work_command_id),
      rootWorkSeq: String(row.root_work_seq),
    };
    if (kind === 'model') {
      const source = object(parsed(row.decision_source_json));
      if (typeof source?.compressionId === 'string') {
        const snapshot = db.row(
          'SELECT * FROM context_snapshot WHERE id=? AND session_id=?',
          source.compressionId,
          sessionId,
        );
        const compression = snapshot ? compressionAttribution(db, snapshot, row) : null;
        if (compression) {
          attributes.compressionId = compression.compressionId;
          attributes.compressionTrigger = compression.compressionTrigger;
          attributes.compression = compression.compression as unknown as Json;
        }
      }
      const retry = object(source?.retry);
      if (retry && typeof retry.previousExecutionId === 'string') {
        const previous = db.row(
          "SELECT id,origin_store_id FROM execution WHERE id=? AND session_id=? AND origin_command_id=? AND root_work_command_id=? AND kind='model'",
          retry.previousExecutionId,
          sessionId,
          row.origin_command_id!,
          row.root_work_command_id!,
        );
        if (previous) {
          attributes.previousExecutionId = retry.previousExecutionId;
          attributes.previousExecutionOriginStoreId = String(previous.origin_store_id);
          if (
            ['provider_unavailable', 'connection_failed', 'stream_incomplete'].includes(
              String(retry.reason),
            )
          )
            attributes.retryReason = retry.reason!;
          if (
            typeof retry.attempt === 'number' &&
            Number.isSafeInteger(retry.attempt) &&
            retry.attempt >= 2
          )
            attributes.retryAttempt = retry.attempt;
          if (
            retry.maxAttempts === null ||
            (typeof retry.maxAttempts === 'number' &&
              Number.isSafeInteger(retry.maxAttempts) &&
              retry.maxAttempts >= 1)
          )
            attributes.maxAttempts = retry.maxAttempts;
        }
      }
      attributes.resultRevision = String(row.result_revision);
      const command = db.row(
        'SELECT subject_id,kind FROM command WHERE id=?',
        row.origin_command_id!,
      );
      const identity = {
        executionId: String(row.id),
        sessionId,
        rootSessionId: String(row.root_session_id),
        runId: row.run_id === null ? null : String(row.run_id),
        originCommandId: String(row.origin_command_id),
        rootWorkCommandId: String(row.root_work_command_id),
        rootWorkSeq: String(row.root_work_seq),
        attempt: Number(row.attempt),
        status: String(row.state),
        confirmation: row.state === 'succeeded' ? 'succeeded' : 'unconfirmed',
        modelId: String(row.adapter_id),
      };
      const materialScope = {
        originStoreId: String(row.origin_store_id),
        subjectId: String(command!.subject_id),
        identity,
      };
      // Model request preparation can replace an unsealed request. Seal this exact version now.
      const display = modelTrajectoryDisplay(
        parsed(row.intent_json),
        parsed(row.model_snapshot_json),
      );
      attributes.display = {
        ...display,
        ...(row.run_id === null && command!.kind === 'authorization.check'
          ? { operation: 'review' }
          : {}),
      } as unknown as Json;
      bind('model_input', {
        ...materialScope,
        input: parsed(row.intent_json),
        metadata: parsed(row.model_snapshot_json),
        receiptInputHash: object(parsed(row.result_json))?.modelInputBodyHash ?? null,
        dispatchAuthorization: parsed(row.dispatch_authorization_json),
        authorizationCheck:
          row.run_id === null && command!.kind === 'authorization.check'
            ? { sourceIds: [String(row.origin_command_id), String(row.id)] }
            : null,
      });
      const partial = db.row(
        'SELECT source_json FROM message WHERE id=? AND session_id=?',
        `partial_${row.id}`,
        sessionId,
      );
      const result = object(parsed(row.result_json));
      const prefix = object(parsed(partial?.source_json));
      const output = row.state === 'succeeded' ? result : (prefix ?? result);
      if (output) {
        const reference = bind(
          'model_output',
          { ...materialScope, output, resultRevision: String(row.result_revision) },
          row.state === 'succeeded' ? 'available' : 'partial',
        );
        const presence = trajectoryOutputPresence(
          db,
          row,
          output,
          row.state === 'succeeded',
          reference,
        );
        if (presence)
          attributes.display = {
            ...object(attributes.display),
            outputPresence: presence,
          } as unknown as Json;
      }
      const usage = object(result?.usage);
      if (usage) {
        const safe: Record<string, Json> = {};
        for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens']) {
          const value = usage[key];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
            safe[key] = String(value);
        }
        if (Object.keys(safe).length) attributes.usage = safe;
      }
    } else {
      attributes.resultRevision = String(row.result_revision);
      const definition = kind === 'tool' ? trajectoryToolDefinition(db, row) : undefined;
      const display =
        kind === 'tool'
          ? trajectoryToolDisplay(db, row, definition, null)
          : trajectoryJobDisplay(db, row);
      if (display) attributes.display = display as unknown as Json;
      if (kind === 'tool') {
        attributes.callId = String(row.call_id);
        const command = db.row(
          'SELECT subject_id FROM command WHERE id=? AND session_id=?',
          row.origin_command_id!,
          sessionId,
        );
        if (!command) throw new Error('trajectory_tool_scope_invalid');
        bind('tool_input', {
          executionId: String(row.id),
          sessionId,
          subjectId: String(command.subject_id),
          originStoreId: String(row.origin_store_id),
          definitionId: String(row.adapter_id),
          definitionVersion: String(row.definition_version),
          input: parsed(row.intent_json),
        });
      }
      if (row.result_json !== null) {
        const result = parsed(row.result_json);
        const tool = object(result);
        let presentation: ReturnType<typeof toolResultPresentation>;
        if (kind === 'tool') {
          if (typeof definition?.extensionId === 'string') {
            presentation = toolResultPresentation({
              definitionId: String(row.adapter_id),
              definitionVersion: String(row.definition_version),
              extensionId: definition.extensionId,
              executionId: String(row.id),
              input: parsed(row.intent_json),
              result,
            });
            const display = trajectoryToolDisplay(db, row, definition, result, presentation);
            if (display) attributes.display = display as unknown as Json;
          }
        }
        const command = db.row(
          'SELECT subject_id FROM command WHERE id=? AND session_id=?',
          row.origin_command_id!,
          sessionId,
        );
        bind('tool_result', {
          format: 'kite.tool-result',
          version: 1,
          result,
          subjectId: String(command!.subject_id),
          sessionId,
          executionId: String(row.id),
          originStoreId: String(row.origin_store_id),
          originCommandId: String(row.origin_command_id),
          ...(presentation ? { presentation: presentation as unknown as Json } : {}),
        });
        // Only original formally published, same-execution artifacts become previews.
        const references = [
          ...(Array.isArray(tool?.artifactRefs) ? tool.artifactRefs : []),
          ...(Array.isArray(tool?.modelImages) ? tool.modelImages : []),
        ];
        const seen = new Set<string>();
        for (const raw of references) {
          const ref = object(raw),
            scope = object(ref?.scope);
          if (
            typeof ref?.id !== 'string' ||
            seen.has(ref.id) ||
            scope?.kind !== 'execution' ||
            scope.id !== row.id
          )
            continue;
          const artifact = db.row(
            'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=? AND r.session_id=? AND r.owner_kind=? AND r.owner_id=? AND r.origin_store_id=?',
            ref.id,
            sessionId,
            'execution',
            row.id!,
            row.origin_store_id!,
          );
          const command = db.row(
            'SELECT subject_id FROM command WHERE id=? AND session_id=?',
            row.origin_command_id!,
            sessionId,
          );
          if (
            !artifact ||
            !command ||
            artifact.subject_id !== command.subject_id ||
            artifact.size !== ref.size ||
            artifact.media_type !== ref.mediaType ||
            ref.id.startsWith('model-body-') ||
            ref.id.startsWith('model-output-') ||
            artifact.media_type === 'application/vnd.kite.model-output+json'
          )
            continue;
          seen.add(ref.id);
          bind(
            'artifact',
            {
              id: ref.id,
              hash: String(artifact.blob_hash),
              size: String(artifact.size),
              mediaType: String(artifact.media_type),
              storeId: String(artifact.origin_store_id),
              sessionId,
              subjectId: String(artifact.subject_id),
              ownerKind: 'execution',
              ownerId: String(row.id),
            },
            'available',
            String(artifact.media_type),
          );
        }
        const change = object(object(tool?.details)?.fileChange);
        if (
          kind === 'tool' &&
          row.state === 'succeeded' &&
          tool?.outcome === 'succeeded' &&
          change &&
          ((row.adapter_id === 'files.write' && row.definition_version === '3') ||
            (row.adapter_id === 'files.edit' && row.definition_version === '2'))
        ) {
          const preview = fileChangeEvidence(change);
          let content: Record<string, Json> | null = null;
          try {
            content = object(parsed(tool.content));
          } catch {
            /* Unknown original receipt cannot become file evidence. */
          }
          const after = object(change.after),
            baseline = object(content?.baseline);
          if (
            preview &&
            content?.path === change.path &&
            after &&
            baseline &&
            ['hash', 'size', 'device', 'inode'].every((key) => after[key] === baseline[key])
          )
            bind('file_change', preview, change.truncated ? 'truncated' : 'available');
        }
      }
    }
    if (kind === 'job') {
      if (row.child_session_id) attributes.childSessionId = String(row.child_session_id);
      if (['pending', 'consumed', 'suppressed'].includes(String(row.delivery)))
        attributes.delivery = String(row.delivery);
      if (reasonCode(row.delivery_reason))
        attributes.deliveryReasonCode = String(row.delivery_reason);
    }
    if (kind === 'job' || sourceEventType === 'execution.output') {
      const gaps = db.rows(
        'SELECT stream,seq,through_seq,dropped_bytes FROM execution_output WHERE execution_id=? AND is_gap=1 ORDER BY stream',
        row.id!,
      );
      attributes.upperOutputSeq = String(row.output_seq);
      attributes.truncated = row.output_truncated === 1n;
      attributes.gaps = gaps.map((gap) => ({
        stream: String(gap.stream),
        fromSeq: String(gap.seq),
        throughSeq: String(gap.through_seq),
        droppedBytes: String(gap.dropped_bytes),
      }));
      bind(
        'job_output',
        {
          upperOutputSeq: String(row.output_seq),
          gaps: attributes.gaps,
          truncated: attributes.truncated,
        },
        row.output_truncated === 1n ? 'truncated' : 'available',
      );
    }
  } else if (/^(?:command\.|operation\.|input\.|context\.command_)/.test(sourceEventType)) {
    row = db.row('SELECT * FROM command WHERE id=? AND session_id=?', objectId, sessionId);
    if (row) {
      kind = 'command';
      attributes = { commandId: String(row.id), commandType: String(row.kind) };
      const receipt = object(parsed(row.receipt_json));
      const reason = reasonCode(receipt?.reason ?? receipt?.outcome);
      if (reason) attributes.reasonCode = reason;
    }
  } else if (sourceEventType.startsWith('run.')) {
    row = db.row('SELECT * FROM run WHERE id=? AND session_id=?', objectId, sessionId);
    if (row) {
      kind = 'run';
      attributes = {
        commandId: String(row.origin_command_id),
        rootWorkCommandId: String(row.root_work_command_id),
        rootWorkSeq: String(row.root_work_seq),
        cancellationRequested: row.cancel_requested === 1n,
      };
      if (reasonCode(row.reason)) attributes.reasonCode = String(row.reason);
    }
  } else if (sourceEventType.startsWith('interaction.')) {
    row = db.row(
      'SELECT * FROM interaction WHERE id=? AND (session_id=? OR presentation_session_id=?)',
      objectId,
      sessionId,
      sessionId,
    );
    if (row) {
      kind = 'interaction';
      attributes = { interactionId: objectId, revision: String(row.revision) };
      if (['approval', 'question', 'plan_review'].includes(String(row.kind)))
        attributes.interactionKind = String(row.kind);
      const decision = sourceEventType.slice('interaction.'.length);
      if (
        ['requested', 'projected', 'answered', 'accepted', 'rejected', 'cancelled'].includes(
          decision,
        )
      )
        attributes.decision = decision;
      bind('interaction', {
        kind: String(row.kind),
        request: parsed(row.request_json),
        answer: parsed(row.answer_json),
        source: parsed(row.source_json),
        acceptedDecisionRevision:
          row.accepted_decision_revision === null ? null : String(row.accepted_decision_revision),
        revision: String(row.revision),
      });
    }
  } else if (sourceEventType.startsWith('context.')) {
    row = db.row('SELECT * FROM context_snapshot WHERE id=? AND session_id=?', objectId, sessionId);
    if (row) {
      kind = 'context';
      attributes = { selectionId: String(row.selection_id), revision: origin.cursor };
      if (sourceEventType === 'context.compressed') {
        attributes.compressionId = objectId;
        attributes.action = 'compressed';
        const compression = row.kind === 'compression' ? compressionAttribution(db, row) : null;
        if (compression) {
          attributes.compressionTrigger = compression.compressionTrigger;
          attributes.compression = compression.compression as unknown as Json;
          compressionExecutionId = compression.executionId;
          const model = db.row(
            'SELECT * FROM execution WHERE id=? AND session_id=?',
            compression.executionId,
            sessionId,
          )!;
          bind('model_output', {
            ...modelMaterial(db, model, sessionId),
            output: parsed(model.result_json),
            resultRevision: String(model.result_revision),
          });
        }
      } else if (sourceEventType === 'context.selected') attributes.action = 'selected';
      else if (
        sourceEventType === 'context.result_included' ||
        sourceEventType === 'context.compression.reset'
      )
        attributes.action = 'published';
      bind('context', {
        snapshotId: objectId,
        kind: String(row.kind),
        selectionId: String(row.selection_id),
        sources: parsed(row.sources_json),
        request: parsed(row.request_json),
      });
    }
  } else if (sourceEventType === 'artifact.published') {
    row = db.row(
      'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=? AND r.session_id=?',
      objectId,
      sessionId,
    );
    if (row) {
      kind = 'artifact';
      attributes = { artifactId: objectId, mediaType: String(row.media_type) };
      bind(
        'artifact',
        {
          id: objectId,
          hash: String(row.blob_hash),
          size: String(row.size),
          mediaType: String(row.media_type),
          storeId: String(row.origin_store_id),
          sessionId,
          subjectId: String(row.subject_id),
          ownerKind: String(row.owner_kind),
          ownerId: String(row.owner_id),
        },
        objectId.startsWith('model-body-') ||
          objectId.startsWith('model-output-') ||
          row.media_type === 'application/vnd.kite.model-output+json'
          ? 'redacted'
          : 'available',
      );
    }
  }
  if (sourceEventType === 'session.recovered' || sourceEventType === 'session.reconciled') {
    row = db.row('SELECT * FROM command WHERE id=? AND session_id=?', objectId, sessionId);
    kind = 'recovery';
    attributes = { outcome: sourceEventType === 'session.recovered' ? 'interrupted' : 'unknown' };
  }
  if (verification) {
    row = db.row(
      'SELECT * FROM execution WHERE id=? AND run_id=? AND session_id=?',
      verification.executionId,
      verification.runId,
      sessionId,
    );
    if (!row) throw new Error('trajectory_verification_scope_invalid');
    kind = 'verification';
    attributes = {
      verificationId: verification.verificationId,
      method: 'required_check',
      outcome:
        verification.outcome === 'passed' || verification.outcome === 'failed'
          ? verification.outcome
          : 'unknown',
    };
    bind(
      'verification',
      {
        verificationId: verification.verificationId,
        revision: verification.revision,
        outcome: verification.outcome,
        checkerExecutionId: verification.executionId,
        targetExecutionId: verification.targetExecutionId,
        evidence: verification.evidence,
      },
      'partial',
    );
  }
  const recordedStatus = verification
    ? verification.outcome
    : row && typeof (row.state ?? row.status) === 'string'
      ? String(row.state ?? row.status)
      : null;
  const incompleteMessagePhase =
    message?.model &&
    ['failed', 'cancelled', 'outcome_unknown'].includes(String(message.model.state))
      ? phase(String(message.model.state))
      : 'running';
  const recordedPhase =
    kind === 'message'
      ? recordedStatus === 'complete'
        ? 'completed'
        : incompleteMessagePhase
      : verification || kind === 'context' || kind === 'artifact' || kind === 'recovery'
        ? 'observed'
        : kind === 'interaction' && recordedStatus === 'pending'
          ? 'waiting_interaction'
          : row?.cancel_requested === 1n &&
              (row.is_active === 1n ||
                ['planned', 'dispatching', 'running'].includes(recordedStatus ?? ''))
            ? 'cancelling'
            : phase(recordedStatus);
  const executionId = verification
    ? verification.executionId
    : ['model', 'tool', 'job'].includes(kind)
      ? String(row!.id)
      : (compressionExecutionId ?? (row?.execution_id ? String(row.execution_id) : undefined));
  const execution = executionId
    ? db.row(
        'SELECT origin_store_id,origin_command_id,run_id,parent_execution_id FROM execution WHERE id=? AND session_id=?',
        executionId,
        sessionId,
      )
    : null;
  const runId = row?.run_id
    ? String(row.run_id)
    : kind === 'run'
      ? objectId
      : execution?.run_id
        ? String(execution.run_id)
        : undefined;
  const originalRun = runId
    ? db.row('SELECT origin_store_id FROM run WHERE id=? AND session_id=?', runId, sessionId)
    : null;
  const operationId =
    kind === 'command' || kind === 'recovery'
      ? objectId
      : row?.origin_command_id
        ? String(row.origin_command_id)
        : execution?.origin_command_id
          ? String(execution.origin_command_id)
          : undefined;
  const originalCommand = operationId
    ? db.row('SELECT origin_store_id FROM command WHERE id=?', operationId)
    : null;
  const parentExecutionId = execution?.parent_execution_id
    ? String(execution.parent_execution_id)
    : undefined;
  const originalParent = parentExecutionId
    ? db.row('SELECT origin_store_id FROM execution WHERE id=?', parentExecutionId)
    : null;
  const event = trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId,
    sequence: origin.cursor,
    origin,
    workspaceId: String(session.workspace_id),
    sessionId,
    sourceEventType,
    sourceRecordRevision:
      verification?.revision ?? (kind === 'interaction' ? String(row!.revision) : origin.cursor),
    occurredAt,
    recordedStatus,
    phase: recordedPhase,
    identityConfidence: 'verified_origin',
    kind,
    attributes,
    evidenceRefs,
    ...(executionId ? { executionId } : {}),
    ...(execution ? { executionOriginStoreId: String(execution.origin_store_id) } : {}),
    ...(runId ? { runId } : {}),
    ...(originalRun ? { runOriginStoreId: String(originalRun.origin_store_id) } : {}),
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(message?.messageOriginStoreId
      ? { messageOriginStoreId: message.messageOriginStoreId }
      : {}),
    ...(originalParent
      ? { parentExecutionOriginStoreId: String(originalParent.origin_store_id) }
      : {}),
    ...(operationId ? { operationId } : {}),
    ...(originalCommand ? { operationOriginStoreId: String(originalCommand.origin_store_id) } : {}),
    ...(row?.attempt ? { attempt: Number(row.attempt) } : {}),
  });
  return canonicalJson({
    format: 'kite.trajectory-fact',
    version: 1,
    event: event as unknown as Json,
    bindings: bindings as unknown as Json,
  });
}
