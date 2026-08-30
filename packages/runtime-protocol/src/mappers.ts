import type {
  RuntimeAccessNotification,
  RuntimeClientEvent,
  RuntimeClientInteraction,
  RuntimeCommand,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import {
  RUNTIME_PROTOCOL_COMMAND_SCHEMA_,
  RUNTIME_PROTOCOL_EVENT_SCHEMA_,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
  RUNTIME_PROTOCOL_SESSION_SCHEMA_,
  type RuntimeProtocolCommand,
  type RuntimeProtocolEvent,
  type RuntimeProtocolQuery,
  type RuntimeProtocolResult,
  type RuntimeSubscriptionMessage,
} from './codecs';

/** App-owned facts that the wire protocol intentionally does not accept. */
export interface RuntimeProtocolCommandContext {
  readonly workspace: string;
}

/** Maps the frozen Protocol command vocabulary into the private Contract. */
export function mapProtocolCommandToRuntimeCommand(
  command: RuntimeProtocolCommand,
  context: RuntimeProtocolCommandContext,
): RuntimeCommand {
  switch (command.type) {
    case 'create_session':
      return { ...command, workspace: context.workspace };
    case 'resume_session':
    case 'start_turn':
    case 'cancel_turn':
    case 'respond_interaction':
    case 'set_interaction_mode':
    case 'compact_session':
    case 'rewind_session':
    case 'fork_session':
    case 'close_session':
    case 'clear_session_command_grants':
    case 'delete_session':
      return command as RuntimeCommand;
  }
}

/** Explicit reverse mapper: Contract additions are never automatically exposed. */
export function mapRuntimeCommandToProtocol(
  command: RuntimeCommand,
): RuntimeProtocolCommand | undefined {
  switch (command.type) {
    case 'create_session': {
      const { workspace: _workspace, ...wire } = command;
      return wire;
    }
    case 'resume_session':
    case 'start_turn':
    case 'cancel_turn':
    case 'respond_interaction':
    case 'set_interaction_mode':
    case 'compact_session':
    case 'rewind_session':
    case 'fork_session':
    case 'close_session':
    case 'clear_session_command_grants':
    case 'delete_session':
      return RUNTIME_PROTOCOL_COMMAND_SCHEMA_.safeParse(command).data;
    default:
      return undefined;
  }
}

export function mapProtocolQueryToRuntimeQuery(query: RuntimeProtocolQuery): RuntimeQuery {
  switch (query.type) {
    case 'list_sessions':
    case 'get_session_projection':
    case 'get_context_status':
    case 'list_checkpoints':
    case 'get_rewind_preview':
    case 'get_run':
    case 'list_runs':
      return query;
  }
}

export function mapRuntimeQueryToProtocol(query: RuntimeQuery): RuntimeProtocolQuery | undefined {
  switch (query.type) {
    case 'list_sessions':
    case 'get_session_projection':
    case 'get_context_status':
    case 'list_checkpoints':
    case 'get_rewind_preview':
    case 'get_run':
    case 'list_runs':
      return query;
    default:
      return undefined;
  }
}

/** Explicit safe projection of a Contract event. New discriminants default-deny. */
export function mapRuntimeClientEventToProtocol(
  event: RuntimeClientEvent,
): RuntimeProtocolEvent | undefined {
  const validate = (candidate: unknown): RuntimeProtocolEvent | undefined =>
    RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse(candidate).data;
  switch (event.type) {
    case 'model.text_delta':
    case 'reasoning.activity':
      return validate(event);
    case 'tool.queued':
      // Revalidate the closed presentation fact at the Contract-to-wire seam;
      // never recreate it from hidden tool arguments.
      return validate(event);
    case 'tool.started':
    case 'tool.progress':
    case 'tool.finished':
      return validate(event);
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
    case 'tool.file_changed':
    case 'user.message':
    case 'model.requested':
    case 'model.responded':
    case 'model.retry':
    case 'model.cache':
    case 'interaction.settled':
    case 'approval.queued':
    case 'approval.granted':
    case 'approval.rejected':
    case 'input.requested':
    case 'input.answered':
    case 'input.cancelled':
    case 'plan.review_requested':
    case 'plan.approved':
    case 'plan.progress':
    case 'plan.completed':
    case 'planning.entered':
    case 'planning.exited':
    case 'interaction_mode.changed':
    case 'provider.action':
    case 'verification.status':
    case 'subagent.started':
    case 'subagent.step':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'context.compaction':
    case 'task.terminal':
    case 'turn.terminal':
    case 'run.terminal':
    case 'run.failure':
    case 'rewind.terminal':
    case 'interaction.available':
    case 'session.notice':
    case 'unavailable':
      return validate(event);
    default:
      return undefined;
  }
}

function mapSession(session: RuntimeSessionProjection) {
  const activeTurn = session.activeWork?.activeTurn;
  const activeWork =
    session.activeWork === undefined
      ? undefined
      : {
          workId: session.activeWork.workId,
          phase: session.activeWork.phase,
          status: session.activeWork.status,
          ...(session.activeWork.title === undefined ? {} : { title: session.activeWork.title }),
          ...(activeTurn === undefined
            ? {}
            : {
                activeTurn: {
                  turnId: activeTurn.turnId,
                  status: activeTurn.status,
                  ...(activeTurn.summary === undefined ? {} : { summary: activeTurn.summary }),
                  ...(activeTurn.interaction === undefined
                    ? {}
                    : { interaction: mapInteraction(activeTurn.interaction) }),
                  ...(activeTurn.evidence === undefined
                    ? {}
                    : {
                        evidence: activeTurn.evidence.map((evidence) => ({
                          kind: evidence.kind,
                          status: evidence.status,
                          ...(evidence.digest === undefined ? {} : { digest: evidence.digest }),
                        })),
                      }),
                },
              }),
        };
  return RUNTIME_PROTOCOL_SESSION_SCHEMA_.parse({
    schema: session.schema,
    sessionId: session.sessionId,
    revision: session.revision,
    ...(session.displayName === undefined ? {} : { displayName: session.displayName }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    lifecycle: session.lifecycle,
    ...(session.model === undefined ? {} : { model: session.model }),
    sessionCommandGrantCount: session.sessionCommandGrantCount ?? 0,
    interactionQueue: {
      revision: session.interactionQueue.revision,
      ...(session.interactionQueue.activeInteractionId === undefined
        ? {}
        : { activeInteractionId: session.interactionQueue.activeInteractionId }),
      interactions: session.interactionQueue.interactions.map(mapInteraction),
    },
    ...(activeWork === undefined ? {} : { activeWork }),
  });
}

function mapInteraction(interaction: RuntimeClientInteraction): RuntimeClientInteraction {
  const base = {
    interactionId: interaction.interactionId,
    sessionRevision: interaction.sessionRevision,
    ...(interaction.title === undefined ? {} : { title: interaction.title }),
    ...(interaction.summary === undefined ? {} : { summary: interaction.summary }),
  };
  switch (interaction.kind) {
    case 'approval':
      return {
        ...base,
        kind: interaction.kind,
        generation: interaction.generation,
        grants: [...interaction.grants],
        ...(interaction.command === undefined ? {} : { command: interaction.command }),
      };
    case 'input':
      return {
        ...base,
        kind: interaction.kind,
        question: interaction.question,
        allowFreeText: interaction.allowFreeText,
        ...(interaction.options === undefined
          ? {}
          : { options: interaction.options.map((option) => ({ ...option })) }),
      };
    case 'plan_review':
      return { ...base, kind: interaction.kind, plan: { ...interaction.plan } };
    case 'provider_action':
      return {
        ...base,
        kind: interaction.kind,
        provider: { ...interaction.provider },
        action: interaction.action,
      };
    case 'verification':
      return { ...base, kind: interaction.kind, verification: { ...interaction.verification } };
  }
}

/** Drops workspace and every unknown future field at the only Contract-to-wire notification seam. */
export function mapRuntimeNotificationToSubscriptionMessage(
  notification: RuntimeNotification,
): RuntimeSubscriptionMessage {
  if (notification.durability === 'durable') {
    const event =
      notification.projection.event === undefined
        ? undefined
        : mapRuntimeClientEventToProtocol(notification.projection.event);
    return RUNTIME_PROTOCOL_EVENT_SCHEMA_.safeParse(event).success || event === undefined
      ? {
          type: 'notification',
          durability: 'durable',
          sessionId: notification.sessionId,
          revision: notification.revision,
          session: mapSession(notification.projection.session),
          ...(event === undefined ? {} : { event }),
        }
      : {
          type: 'notification',
          durability: 'durable',
          sessionId: notification.sessionId,
          revision: notification.revision,
          session: mapSession(notification.projection.session),
        };
  }
  const event = mapRuntimeClientEventToProtocol(notification.event) ?? {
    type: 'unavailable',
    reason: 'unknown_event' as const,
  };
  return {
    type: 'notification',
    durability: 'ephemeral',
    sessionId: notification.sessionId,
    workId: notification.workId,
    turnId: notification.turnId,
    actorId: notification.actorId,
    attemptId: notification.attemptId,
    compositionRevision: notification.compositionRevision,
    streamId: notification.streamId,
    sequence: notification.sequence,
    event,
  };
}

/** Maps both RuntimeAccess streams; index reset boundaries retain their exact identity. */
export function mapRuntimeAccessNotificationToSubscriptionMessage(
  notification: RuntimeAccessNotification,
): RuntimeSubscriptionMessage {
  if ('schema' in notification) return mapRuntimeNotificationToSubscriptionMessage(notification);
  switch (notification.type) {
    case 'index_reset_begin':
    case 'index_reset_end':
    case 'session_remove':
      return notification;
    case 'session_upsert':
      return { ...notification, session: mapSession(notification.session) };
    default:
      return undefined as never;
  }
}

/**
 * Client-store input reconstructed only from the closed wire union. It is not
 * a RuntimeAccess notification: protocol notifications intentionally omit
 * Host-only projection fields and workspace authority.
 */
export type RuntimeProtocolClientUpdate =
  | Extract<RuntimeSubscriptionMessage, { type: 'ready' | 'reset' }>
  | Extract<
      RuntimeSubscriptionMessage,
      {
        type: 'index_reset_begin' | 'session_upsert' | 'session_remove' | 'index_reset_end';
      }
    >
  | Extract<RuntimeSubscriptionMessage, { type: 'notification' }>;

export function mapSubscriptionMessageToClientUpdate(
  message: RuntimeSubscriptionMessage,
): RuntimeProtocolClientUpdate {
  switch (message.type) {
    case 'ready':
    case 'reset':
    case 'notification':
    case 'index_reset_begin':
    case 'session_upsert':
    case 'session_remove':
    case 'index_reset_end':
      return message;
  }
}

/** Closed result projection; it prevents workspace paths from entering query responses. */
export function mapRuntimeQueryResultToProtocol(
  result: RuntimeQueryResult,
): RuntimeProtocolResult | undefined {
  if (result.status !== 'ok') return RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse(result).data;
  switch (result.queryType) {
    case 'list_sessions':
      return RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        status: 'ok',
        queryType: result.queryType,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
        sessions: (result.sessions ?? []).map(mapSession),
      }).data;
    case 'get_session_projection':
      return result.session === undefined
        ? undefined
        : RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
            status: 'ok',
            queryType: result.queryType,
            ...(result.revision === undefined ? {} : { revision: result.revision }),
            session: mapSession(result.session),
          }).data;
    case 'get_context_status':
      return result.context === undefined
        ? undefined
        : RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
            status: 'ok',
            queryType: result.queryType,
            ...(result.revision === undefined ? {} : { revision: result.revision }),
            context: result.context,
          }).data;
    case 'list_checkpoints':
      return RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        status: 'ok',
        queryType: result.queryType,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
        checkpoints: result.checkpoints ?? [],
      }).data;
    case 'get_rewind_preview':
      return result.rewindPreview === undefined
        ? undefined
        : RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
            status: 'ok',
            queryType: result.queryType,
            ...(result.revision === undefined ? {} : { revision: result.revision }),
            rewindPreview: result.rewindPreview,
          }).data;
    case 'get_run':
      return result.run === undefined
        ? undefined
        : RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
            status: 'ok',
            queryType: result.queryType,
            ...(result.revision === undefined ? {} : { revision: result.revision }),
            run: result.run,
          }).data;
    case 'list_runs':
      return RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse({
        status: 'ok',
        queryType: result.queryType,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
        runs: result.runs ?? [],
        ...(result.nextRunCursor === undefined ? {} : { nextRunCursor: result.nextRunCursor }),
      }).data;
    default:
      return undefined;
  }
}
