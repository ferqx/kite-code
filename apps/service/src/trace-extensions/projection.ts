import { createHmac } from 'node:crypto';
import {
  type TraceEventView,
  type TrajectoryEvent,
  traceEventViewSchema,
} from '@kite-ai/trajectory';
import type { TraceGrant } from './types';

const safeStatuses = new Set([
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
  'waiting_interaction',
  'waiting_execution',
  'cancelling',
  'completed',
  'interrupted',
  'accepted',
  'applied',
  'rejected',
  'needs_review',
  'pending',
  'requested',
  'projected',
  'answered',
  'open',
  'closed',
]);

/** Installation-local stable mapping. Ref values correlate facts but confer no read permission. */
export function traceReference(
  key: string,
  purpose: string,
  identity: string,
  namespace?: string,
): string {
  return `tr_${createHmac('sha256', key)
    .update(
      JSON.stringify(
        namespace === undefined ? [purpose, identity] : [purpose, namespace, identity],
      ),
    )
    .digest('hex')}`;
}
export function projectTraceEvent(
  event: TrajectoryEvent,
  grant: TraceGrant,
  key: string,
  readStoreId: string,
): TraceEventView {
  const ref = (purpose: string, id: string, namespace = readStoreId) =>
    traceReference(key, purpose, id, namespace);
  const storeRef = (storeId: string) => traceReference(key, 'store', storeId);
  const optional = (purpose: string, id: string | undefined) =>
    id === undefined ? undefined : ref(purpose, id);
  const scope = {
    storeRef: storeRef(readStoreId),
    sessionRef: ref('session', event.sessionId),
    workspaceRef: ref('workspace', event.workspaceId),
    ...(event.runId
      ? {
          runRef: ref('run', event.runId, event.runOriginStoreId ?? readStoreId),
          ...(event.runOriginStoreId
            ? { runOriginStoreRef: storeRef(event.runOriginStoreId) }
            : {}),
        }
      : {}),
    ...(event.executionId
      ? {
          executionRef: ref(
            'execution',
            event.executionId,
            event.executionOriginStoreId ?? readStoreId,
          ),
          ...(event.executionOriginStoreId
            ? { executionOriginStoreRef: storeRef(event.executionOriginStoreId) }
            : {}),
        }
      : {}),
    ...(event.parentExecutionId
      ? {
          parentExecutionRef: ref(
            'execution',
            event.parentExecutionId,
            event.parentExecutionOriginStoreId ?? readStoreId,
          ),
          ...(event.parentExecutionOriginStoreId
            ? { parentExecutionOriginStoreRef: storeRef(event.parentExecutionOriginStoreId) }
            : {}),
        }
      : {}),
    ...(event.operationId
      ? {
          operationRef: ref(
            'operation',
            event.operationId,
            event.operationOriginStoreId ?? readStoreId,
          ),
          ...(event.operationOriginStoreId
            ? { operationOriginStoreRef: storeRef(event.operationOriginStoreId) }
            : {}),
        }
      : {}),
  };
  const envelope = {
    schema: 'kite.trace-event-view',
    schemaVersion: 1,
    eventId: event.eventId,
    sequence: event.sequence,
    scope,
    origin: { storeRef: storeRef(event.origin.storeId), cursor: event.origin.cursor },
    // The required type remains a closed safe classification, not arbitrary source payload text.
    sourceEventType:
      event.kind === 'run' && event.sourceEventType === 'run.started'
        ? 'run.started'
        : `${event.kind}.${event.phase}`,
    sourceRecordRevision: event.sourceRecordRevision,
    phase: event.phase,
    recordedStatus: safeStatuses.has(event.recordedStatus ?? '') ? event.recordedStatus : null,
    occurredAt: grant.metadata.includes('timing') ? event.occurredAt : null,
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    identityConfidence: event.identityConfidence,
    evidenceRefs: event.evidenceRefs
      .filter((item) => grant.evidenceKinds.includes(item.kind))
      .map((item) => ({
        evidenceId: ref('evidence', item.evidenceId),
        contentVersion: ref('evidence-version', item.contentVersion),
        kind: item.kind,
        availability: item.availability,
        mediaType: 'application/octet-stream',
        ...(item.visibleBytes === undefined ? {} : { visibleBytes: item.visibleBytes }),
      })),
    ...(grant.originalIdentity
      ? {
          originalIdentity: {
            storeId: event.origin.storeId,
            sessionId: event.sessionId,
            workspaceId: event.workspaceId,
            ...(event.executionId ? { executionId: event.executionId } : {}),
            ...(event.runId ? { runId: event.runId } : {}),
            ...(event.parentExecutionId ? { parentExecutionId: event.parentExecutionId } : {}),
            ...(event.operationId ? { operationId: event.operationId } : {}),
          },
        }
      : {}),
  };
  const attrs = event.attributes;
  const attribution =
    'commandId' in attrs || 'rootWorkCommandId' in attrs || 'definitionId' in attrs
      ? {
          ...('commandId' in attrs && attrs.commandId
            ? { commandRef: optional('command', attrs.commandId) }
            : {}),
          ...('rootWorkCommandId' in attrs && attrs.rootWorkCommandId
            ? { rootWorkCommandRef: optional('command', attrs.rootWorkCommandId) }
            : {}),
          ...('rootWorkSeq' in attrs && attrs.rootWorkSeq
            ? { rootWorkSeq: attrs.rootWorkSeq }
            : {}),
          ...('definitionId' in attrs && attrs.definitionId
            ? { definitionRef: optional('definition', attrs.definitionId) }
            : {}),
        }
      : {};
  let attributes: unknown;
  switch (event.kind) {
    case 'message':
      attributes = {
        messageRef: ref(
          'message',
          event.attributes.messageId,
          event.messageOriginStoreId ?? readStoreId,
        ),
        role: event.attributes.role,
        messageSeq: event.attributes.messageSeq,
        revision: event.attributes.revision,
        status: event.attributes.status,
      };
      break;
    case 'command':
      attributes = { commandRef: ref('command', event.attributes.commandId) };
      break;
    case 'run':
      attributes = {
        ...attribution,
        ...(event.attributes.cancellationRequested === undefined
          ? {}
          : { cancellationRequested: event.attributes.cancellationRequested }),
      };
      break;
    case 'model':
      attributes = {
        ...attribution,
        ...(event.attributes.previousExecutionId
          ? {
              previousExecutionRef: ref(
                'execution',
                event.attributes.previousExecutionId,
                event.attributes.previousExecutionOriginStoreId ?? readStoreId,
              ),
              ...(event.attributes.previousExecutionOriginStoreId
                ? {
                    previousExecutionOriginStoreRef: storeRef(
                      event.attributes.previousExecutionOriginStoreId,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(event.attributes.retryReason ? { retryReason: event.attributes.retryReason } : {}),
        ...(grant.metadata.includes('usage') && event.attributes.usage
          ? { usage: event.attributes.usage }
          : {}),
      };
      break;
    case 'tool':
      attributes = {
        ...attribution,
        ...(event.attributes.callId ? { callRef: ref('call', event.attributes.callId) } : {}),
        ...(event.attributes.resultRevision
          ? { resultRevision: event.attributes.resultRevision }
          : {}),
      };
      break;
    case 'job':
      attributes = {
        ...attribution,
        ...(event.attributes.childSessionId
          ? { childSessionRef: ref('session', event.attributes.childSessionId) }
          : {}),
        ...(event.attributes.resultRevision
          ? { resultRevision: event.attributes.resultRevision }
          : {}),
        ...(grant.metadata.includes('output_checkpoint')
          ? {
              ...(event.attributes.upperOutputSeq
                ? { upperOutputSeq: event.attributes.upperOutputSeq }
                : {}),
              ...(event.attributes.stream ? { stream: event.attributes.stream } : {}),
              ...(event.attributes.gaps ? { gaps: event.attributes.gaps } : {}),
              ...(event.attributes.droppedBytes
                ? { droppedBytes: event.attributes.droppedBytes }
                : {}),
              ...(event.attributes.truncated === undefined
                ? {}
                : { truncated: event.attributes.truncated }),
            }
          : {}),
      };
      break;
    case 'interaction':
      attributes = {
        interactionRef: ref('interaction', event.attributes.interactionId),
        revision: event.attributes.revision,
        ...(event.attributes.decision ? { decision: event.attributes.decision } : {}),
      };
      break;
    case 'child':
      attributes = {
        childSessionRef: ref('session', event.attributes.childSessionId),
        carrierExecutionRef: ref('execution', event.attributes.carrierExecutionId),
        ...(event.attributes.childRunId
          ? { childRunRef: ref('run', event.attributes.childRunId) }
          : {}),
        ...(event.attributes.delivery ? { delivery: event.attributes.delivery } : {}),
      };
      break;
    case 'context':
      attributes = {
        ...(event.attributes.selectionId
          ? { selectionRef: ref('selection', event.attributes.selectionId) }
          : {}),
        ...(event.attributes.compressionId
          ? { compressionRef: ref('compression', event.attributes.compressionId) }
          : {}),
        ...(event.attributes.revision ? { revision: event.attributes.revision } : {}),
        ...(event.attributes.action ? { action: event.attributes.action } : {}),
      };
      break;
    case 'recovery':
      attributes = event.attributes.outcome ? { outcome: event.attributes.outcome } : {};
      break;
    case 'artifact':
      attributes = { artifactRef: ref('artifact', event.attributes.artifactId) };
      break;
    case 'verification':
      attributes = {
        verificationRef: ref('verification', event.attributes.verificationId),
        outcome: event.attributes.outcome,
        method: event.attributes.method,
      };
      break;
    case 'unknown':
      attributes = { reason: event.attributes.reason };
      break;
  }
  return traceEventViewSchema.parse({ ...envelope, kind: event.kind, attributes });
}
