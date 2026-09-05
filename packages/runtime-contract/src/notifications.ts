import type { SubAgentFailureDiagnostic } from './presentation';
import {
  type InteractionOwner,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeClientInteraction,
  type RuntimeSessionProjection,
} from './projections';
import {
  hasExactKeys,
  hasOnlyKeys,
  isBoundedString,
  isBoundedUserText,
  isIdentifier,
  isJsonSafeValue,
  isNonNegativeSafeInteger,
  isRecord,
} from './validation';

/**
 * Closed, low-sensitivity tool categories permitted on the Runtime Client
 * boundary.  These are not provider/MCP supplied display strings: dynamic
 * tools collapse to `mcp_tool` and unknown names to `other` before crossing
 * the App projector.
 */
export const RUNTIME_TOOL_DISPLAY_NAMES_ = [
  'ask_user',
  'edit_file',
  'glob',
  'list_mcp_resources',
  'list_mcp_tools',
  'mcp_tool',
  'read_file',
  'read_mcp_resource',
  'request_plan_review',
  'search_content',
  'search_files',
  'shell_execute',
  'skill',
  'task',
  'tool_search',
  'update_plan',
  'web_fetch',
  'write_file',
  'write_plan',
  'other',
] as const;

export type RuntimeToolDisplayName = (typeof RUNTIME_TOOL_DISPLAY_NAMES_)[number];

const RUNTIME_TOOL_DISPLAY_NAME_SET = new Set<string>(RUNTIME_TOOL_DISPLAY_NAMES_);

export function isRuntimeToolDisplayName(value: unknown): value is RuntimeToolDisplayName {
  return typeof value === 'string' && RUNTIME_TOOL_DISPLAY_NAME_SET.has(value);
}

/** Closed, content-free classification for App rendering only. */
export const RUNTIME_TOOL_PRESENTATIONS_ = ['exploration', 'standalone', 'hidden'] as const;

export type RuntimeToolPresentation = (typeof RUNTIME_TOOL_PRESENTATIONS_)[number];

const RUNTIME_TOOL_PRESENTATION_SET = new Set<string>(RUNTIME_TOOL_PRESENTATIONS_);

export function isRuntimeToolPresentation(value: unknown): value is RuntimeToolPresentation {
  return typeof value === 'string' && RUNTIME_TOOL_PRESENTATION_SET.has(value);
}

/** Closed terminal result shape; internal result metadata never crosses this boundary. */
export interface RuntimeClientToolResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly status?: 'success' | 'error' | 'exhausted';
  readonly totalLines?: number;
  readonly toolTokenCount?: number;
  readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
}

export const RUNTIME_NOTIFICATION_SCHEMA_ = 'kite.runtime-notification.v2' as const;

export interface RuntimeProjectionDelta {
  readonly kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence';
  readonly session: RuntimeSessionProjection;
  /** Neutral client notification projected by the App-owned adapter. */
  readonly event?: RuntimeClientEvent;
}

export interface RuntimeClientTerminalOutcome {
  readonly status:
    | 'completed'
    | 'aborted'
    | 'blocked'
    | 'unknown'
    | 'budget_exhausted'
    | 'resource_saturated';
  readonly reasonCode: string;
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
}

export interface RuntimeClientRewindFileOutcome {
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  readonly conflicts: readonly {
    readonly path: string;
    readonly reason: 'modified_after_kite_write' | 'unverified_postimage';
  }[];
}

/**
 * Closed client event vocabulary. Unknown Runtime/domain events must be
 * omitted; they must never cross this boundary as a generic object.
 */
export type RuntimeClientEvent =
  | {
      readonly type: 'user.message';
      readonly messageId: string;
      readonly kind: 'task' | 'answer' | 'resume_context';
      readonly text: string;
    }
  | { readonly type: 'model.requested'; readonly requestId: string }
  | {
      readonly type: 'reasoning.activity';
      readonly requestId: string;
      readonly state: 'streaming' | 'completed';
      readonly segmentId: string;
      readonly text: string;
    }
  | { readonly type: 'model.text_delta'; readonly requestId: string; readonly text: string }
  | {
      readonly type: 'model.responded';
      readonly requestId: string;
      readonly messageId: string;
      /** Runtime-measured invocation duration; it contains no reasoning text. */
      readonly durationMs?: number;
      /** Closed count used to retain narration until a following tool starts. */
      readonly toolCallCount: number;
      readonly summary?: string;
    }
  | {
      readonly type: 'model.retry';
      readonly requestId: string;
      readonly attempt: number;
      readonly delayMs?: number;
    }
  | {
      readonly type: 'model.cache';
      readonly inputTokens: number;
      readonly cacheHitTokens: number;
      readonly cacheMissTokens: number;
      readonly outputTokens?: number;
    }
  | {
      readonly type: 'tool.queued';
      readonly toolId: string;
      /** Opaque model-message identity used only for presentation grouping. */
      readonly presentationGroupId?: string;
      /** Closed presentation category, never a raw tool/provider string. */
      readonly toolName?: RuntimeToolDisplayName;
      /** App-owned bounded label for a dynamic tool name. */
      readonly displayLabel?: string;
      /** Closed App rendering fact; never a tool argument or execution authority. */
      readonly presentation: RuntimeToolPresentation;
      /** Bounded JSON-safe arguments after App-side credential redaction. */
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly summary: string;
    }
  | { readonly type: 'tool.started'; readonly toolId: string; readonly summary?: string }
  | {
      readonly type: 'tool.progress';
      readonly toolId: string;
      readonly summary: string;
      readonly stream?: 'stdout' | 'stderr';
      readonly lineCount?: number;
    }
  | {
      readonly type: 'tool.finished';
      readonly toolId: string;
      readonly toolName?: RuntimeToolDisplayName;
      /** App-owned bounded label for a dynamic tool name. */
      readonly displayLabel?: string;
      /** Terminal fallback when the client missed the matching queued fact. */
      readonly presentation: RuntimeToolPresentation;
      readonly result: RuntimeClientToolResult;
      readonly summary: string;
    }
  | {
      readonly type: 'tool.failed';
      readonly toolId: string;
      readonly presentation: RuntimeToolPresentation;
      readonly summary: string;
    }
  | {
      readonly type: 'tool.rejected';
      readonly toolId: string;
      readonly presentation: RuntimeToolPresentation;
      readonly summary: string;
    }
  | {
      readonly type: 'tool.cancelled';
      readonly toolId: string;
      readonly presentation: RuntimeToolPresentation;
      readonly summary?: string;
    }
  | {
      readonly type: 'tool.file_changed';
      readonly toolId: string;
      readonly change: 'added' | 'modified' | 'deleted';
      readonly summary?: string;
    }
  | { readonly type: 'interaction.available'; readonly interaction: RuntimeClientInteraction }
  | {
      readonly type: 'interaction.settled';
      readonly interactionId: string;
      readonly sessionRevision: number;
      readonly outcome: 'completed' | 'rejected' | 'cancelled' | 'expired';
    }
  | {
      readonly type: 'approval.queued';
      readonly interaction: Extract<RuntimeClientInteraction, { readonly kind: 'approval' }>;
      readonly queueSequence: number;
    }
  | {
      readonly type: 'approval.granted';
      readonly interactionId: string;
      readonly generation: number;
      readonly owner: InteractionOwner;
    }
  | {
      readonly type: 'approval.rejected';
      readonly interactionId: string;
      readonly generation: number;
      readonly owner: InteractionOwner;
      readonly summary?: string;
    }
  | {
      readonly type: 'input.requested';
      readonly interaction: Extract<RuntimeClientInteraction, { readonly kind: 'input' }>;
    }
  | { readonly type: 'input.answered'; readonly interactionId: string; readonly summary?: string }
  | { readonly type: 'input.cancelled'; readonly interactionId: string }
  | {
      readonly type: 'plan.review_requested';
      readonly interaction: Extract<RuntimeClientInteraction, { readonly kind: 'plan_review' }>;
    }
  | {
      readonly type: 'plan.progress';
      readonly planId: string;
      readonly version: number;
      readonly structuralDigest: string;
      readonly status: 'pending' | 'in_progress' | 'completed' | 'skipped';
      readonly summary?: string;
    }
  | {
      readonly type: 'plan.completed';
      readonly planId: string;
      readonly version: number;
      readonly structuralDigest: string;
      readonly summary?: string;
    }
  | {
      readonly type: 'plan.approved';
      readonly interactionId: string;
      readonly sessionRevision: number;
      readonly mode: 'accept_edits' | 'auto';
    }
  | { readonly type: 'planning.entered'; readonly taskId: string }
  | { readonly type: 'planning.exited'; readonly taskId: string }
  | {
      readonly type: 'interaction_mode.changed';
      readonly mode: 'accept_edits' | 'auto' | 'full';
    }
  | {
      readonly type: 'provider.action';
      readonly interaction: Extract<RuntimeClientInteraction, { readonly kind: 'provider_action' }>;
      readonly status: 'required' | 'started' | 'completed' | 'deferred' | 'failed';
      readonly summary?: string;
    }
  | {
      readonly type: 'verification.status';
      readonly interaction: Extract<RuntimeClientInteraction, { readonly kind: 'verification' }>;
      readonly status: 'pending' | 'running' | 'passed' | 'failed' | 'waived';
      readonly summary?: string;
    }
  | {
      readonly type: 'subagent.started';
      readonly subagentId: string;
      readonly role: 'explore' | 'plan' | 'code' | 'review';
      readonly name: string;
      /** Opaque Runtime dispatch identity shared by concurrently admitted siblings. */
      readonly concurrencyGroupId?: string;
    }
  | {
      readonly type: 'subagent.phase';
      readonly subagentId: string;
      readonly parentToolCallId: string;
      readonly status: 'running' | 'suspended';
      readonly approvalState?:
        | 'queued_auto_review'
        | 'auto_reviewing'
        | 'queued_user_approval'
        | 'awaiting_user'
        | 'authorized_queued';
      readonly interactionId?: string;
      readonly reviewId?: string;
    }
  | {
      readonly type: 'subagent.step';
      readonly subagentId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: 'started' | 'completed' | 'failed' | 'cancelled';
      readonly displayLabel?: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
      readonly totalLines?: number;
      readonly durationMs?: number;
      readonly summary?: string;
    }
  | {
      readonly type: 'subagent.review';
      readonly subagentId: string;
      readonly parentToolCallId: string;
      readonly reviewId: string;
      readonly toolCallId: string;
      readonly status: 'queued' | 'reviewing' | 'approved' | 'rejected' | 'failed';
      readonly summary?: string;
    }
  | {
      readonly type: 'subagent.completed';
      readonly subagentId: string;
      readonly summary: string;
      readonly toolCallCount: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'subagent.failed';
      readonly subagentId: string;
      readonly summary: string;
      readonly toolCallCount?: number;
      readonly durationMs?: number;
      readonly diagnostic?: Pick<SubAgentFailureDiagnostic, 'code' | 'stage'>;
    }
  | {
      readonly type: 'context.compaction';
      readonly status: 'requested' | 'completed' | 'failed' | 'reset';
      readonly usedTokens?: number;
      readonly availableTokens?: number;
      readonly summary?: string;
    }
  | {
      readonly type: 'task.terminal';
      readonly taskId: string;
      readonly status: 'completed' | 'cancelled' | 'failed';
      readonly summary?: string;
    }
  | {
      readonly type: 'turn.terminal';
      readonly turnId: string;
      readonly status: 'completed' | 'aborted' | 'failed' | 'cancelled';
      readonly cause?: 'user' | 'error';
      readonly summary?: string;
    }
  | {
      readonly type: 'run.terminal';
      readonly runId: string;
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly summary?: string;
      readonly outcome?: RuntimeClientTerminalOutcome;
    }
  | {
      readonly type: 'rewind.terminal';
      readonly rewindId: string;
      readonly commandId: string;
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
      readonly status: 'completed' | 'failed';
      readonly fileOutcome?: RuntimeClientRewindFileOutcome;
      readonly failureCode?: 'checkpoint_unavailable' | 'execution_failed';
    }
  | {
      readonly type: 'session.notice';
      readonly code: 'reconnected' | 'history_gap' | 'session_closed';
      readonly message?: string;
    }
  | {
      readonly type: 'unavailable';
      readonly reason: 'unknown_event' | 'redacted' | 'unsupported_version';
    };

/**
 * Event envelope accepted by a presentation projector.  The connection and
 * stream fences are captured at receipt time and are never inferred by Ink.
 */
export interface AcceptedPresentationEnvelope {
  readonly sessionId: string;
  readonly connectionGeneration: number;
  readonly durability: 'durable' | 'ephemeral';
  readonly revision?: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly event: RuntimeClientEvent;
  readonly stream?: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly compositionRevision: string;
    readonly streamId: string;
    readonly sequence: number;
  };
}

/**
 * Minimum lifecycle authority carried by one client event.  The event itself
 * stays deliberately small; the envelope supplies the matching identity from
 * the Runtime projection/stream.  Keeping this table next to the acceptance
 * predicate makes additions fail closed instead of silently becoming
 * session-scoped by omission.
 */
export type RuntimeClientEventIdentityScope = 'session' | 'task' | 'turn' | 'run';

const RUNTIME_CLIENT_EVENT_IDENTITY_SCOPES_ = {
  'user.message': 'turn',
  'model.requested': 'turn',
  'reasoning.activity': 'turn',
  'model.text_delta': 'turn',
  'model.responded': 'turn',
  'model.retry': 'turn',
  'model.cache': 'turn',
  'tool.queued': 'turn',
  'tool.started': 'turn',
  'tool.progress': 'turn',
  'tool.finished': 'turn',
  'tool.failed': 'turn',
  'tool.rejected': 'turn',
  'tool.cancelled': 'turn',
  'tool.file_changed': 'turn',
  'interaction.available': 'turn',
  'interaction.settled': 'turn',
  'approval.queued': 'turn',
  'approval.granted': 'turn',
  'approval.rejected': 'turn',
  'input.requested': 'turn',
  'input.answered': 'turn',
  'input.cancelled': 'turn',
  'plan.review_requested': 'turn',
  'plan.progress': 'turn',
  'plan.completed': 'turn',
  'plan.approved': 'turn',
  'planning.entered': 'task',
  'planning.exited': 'task',
  'provider.action': 'turn',
  'verification.status': 'turn',
  'subagent.started': 'turn',
  'subagent.phase': 'turn',
  'subagent.step': 'turn',
  'subagent.review': 'turn',
  'subagent.completed': 'turn',
  'subagent.failed': 'turn',
  'context.compaction': 'session',
  'task.terminal': 'task',
  'turn.terminal': 'turn',
  'run.terminal': 'run',
  'rewind.terminal': 'session',
  'session.notice': 'session',
  'interaction_mode.changed': 'session',
  unavailable: 'session',
} as const satisfies Readonly<Record<RuntimeClientEvent['type'], RuntimeClientEventIdentityScope>>;

export function runtimeClientEventIdentityScope(
  event: RuntimeClientEvent,
): RuntimeClientEventIdentityScope {
  return RUNTIME_CLIENT_EVENT_IDENTITY_SCOPES_[event.type];
}

/**
 * Validate the envelope identity required by the event's authority scope.
 * Terminal event identities are repeated in the event payload and must agree
 * exactly with the envelope so a predecessor cannot settle a successor.
 */
export function isRuntimeClientEventIdentitySatisfied(
  event: RuntimeClientEvent,
  identity: Readonly<{ runId?: unknown; taskId?: unknown; turnId?: unknown }>,
): boolean {
  const hasIdentity = (value: unknown): value is string => isIdentifier(value);
  const scope = runtimeClientEventIdentityScope(event);
  if (
    (scope === 'run' && !hasIdentity(identity.runId)) ||
    (scope === 'task' && !hasIdentity(identity.taskId)) ||
    (scope === 'turn' && !hasIdentity(identity.turnId))
  ) {
    return false;
  }
  switch (event.type) {
    case 'task.terminal':
    case 'planning.entered':
    case 'planning.exited':
      return identity.taskId === event.taskId;
    case 'turn.terminal':
      return identity.turnId === event.turnId;
    case 'run.terminal':
      return identity.runId === event.runId;
    default:
      return true;
  }
}

export function isAcceptedPresentationEnvelope(
  value: unknown,
): value is AcceptedPresentationEnvelope {
  if (!isRecord(value)) return false;
  const optional = ['revision', 'runId', 'taskId', 'turnId', 'stream'];
  if (
    !hasExactKeys(value, [
      'sessionId',
      'connectionGeneration',
      'durability',
      'event',
      ...optional.filter((key) => Object.hasOwn(value, key)),
    ]) ||
    !isIdentifier(value.sessionId) ||
    !isNonNegativeSafeInteger(value.connectionGeneration) ||
    value.connectionGeneration < 1 ||
    (value.durability !== 'durable' && value.durability !== 'ephemeral') ||
    (Object.hasOwn(value, 'revision') && !isNonNegativeSafeInteger(value.revision)) ||
    (Object.hasOwn(value, 'runId') && !isIdentifier(value.runId)) ||
    (Object.hasOwn(value, 'taskId') && !isIdentifier(value.taskId)) ||
    (Object.hasOwn(value, 'turnId') && !isIdentifier(value.turnId)) ||
    !isRuntimeClientEvent(value.event)
  ) {
    return false;
  }
  if (!isRuntimeClientEventIdentitySatisfied(value.event, value)) return false;
  if (value.durability === 'durable') {
    return Object.hasOwn(value, 'revision') && !Object.hasOwn(value, 'stream');
  }
  const stream = value.stream;
  return (
    isRecord(stream) &&
    hasExactKeys(stream, ['actorId', 'attemptId', 'compositionRevision', 'streamId', 'sequence']) &&
    isIdentifier(stream.actorId) &&
    isIdentifier(stream.attemptId) &&
    isIdentifier(stream.compositionRevision) &&
    isIdentifier(stream.streamId) &&
    isNonNegativeSafeInteger(stream.sequence)
  );
}

export function assertAcceptedPresentationEnvelope(
  value: unknown,
): asserts value is AcceptedPresentationEnvelope {
  if (!isAcceptedPresentationEnvelope(value)) {
    throw new TypeError('Invalid AcceptedPresentationEnvelope');
  }
}

export type RuntimeNotification =
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_;
      readonly durability: 'durable';
      readonly sessionId: string;
      readonly revision: number;
      /**
       * Optional exact lifecycle identity captured by the Server for this
       * source record.  Most durable records can derive identity from the
       * accompanying projection; start-turn records carry this explicitly
       * because the prompt is committed before `turn.started` is reduced.
       */
      readonly runId?: string;
      readonly taskId?: string;
      readonly turnId?: string;
      readonly projection: RuntimeProjectionDelta;
    }
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_;
      readonly durability: 'ephemeral';
      readonly sessionId: string;
      readonly workId: string;
      readonly runId?: string;
      readonly taskId?: string;
      readonly turnId: string;
      readonly actorId: string;
      readonly attemptId: string;
      readonly compositionRevision: string;
      readonly streamId: string;
      readonly sequence: number;
      /** Closed, presentation-safe event; private Runtime payloads never enter this stream. */
      readonly event: RuntimeClientEvent;
    };

/**
 * Session-index facts are a separate local stream, never a synthetic Session
 * notification. A client atomically replaces its index between matching reset
 * boundaries for one server instance and generation.
 */
export type RuntimeSessionIndexNotification =
  | {
      readonly type: 'index_reset_begin';
      readonly serverInstanceId: string;
      readonly generation: number;
      readonly indexRevision: number;
    }
  | {
      readonly type: 'session_upsert';
      readonly serverInstanceId: string;
      readonly generation: number;
      readonly indexRevision: number;
      readonly session: RuntimeSessionProjection;
    }
  | {
      readonly type: 'session_remove';
      readonly serverInstanceId: string;
      readonly generation: number;
      readonly indexRevision: number;
      readonly sessionId: string;
    }
  | {
      readonly type: 'index_reset_end';
      readonly serverInstanceId: string;
      readonly generation: number;
      readonly indexRevision: number;
    };

/** Complete local RuntimeAccess notification vocabulary. */
export type RuntimeAccessNotification = RuntimeNotification | RuntimeSessionIndexNotification;

/** Serializable subscription selector. This is the only subscription shape a wire codec may accept. */
export type RuntimeSubscriptionSpec =
  | {
      readonly scope: 'session';
      readonly sessionId: string;
      readonly afterRevision?: number;
      readonly includeEphemeral?: boolean;
    }
  | { readonly scope: 'sessions' };

/** Local subscription: cancellation remains local and non-serializable. */
export interface RuntimeSubscription {
  readonly spec: RuntimeSubscriptionSpec;
  readonly signal?: AbortSignal;
}

export function isRuntimeSubscriptionSpec(value: unknown): value is RuntimeSubscriptionSpec {
  if (!isRecord(value) || typeof value.scope !== 'string') return false;
  if (value.scope === 'sessions') return hasExactKeys(value, ['scope']);
  return (
    value.scope === 'session' &&
    hasOnlyKeys(value, ['scope', 'sessionId', 'afterRevision', 'includeEphemeral']) &&
    isIdentifier(value.sessionId) &&
    (!Object.hasOwn(value, 'afterRevision') || isNonNegativeSafeInteger(value.afterRevision)) &&
    (!Object.hasOwn(value, 'includeEphemeral') || typeof value.includeEphemeral === 'boolean')
  );
}

export function assertRuntimeSubscriptionSpec(
  value: unknown,
): asserts value is RuntimeSubscriptionSpec {
  if (!isRuntimeSubscriptionSpec(value)) throw new TypeError('Invalid RuntimeSubscriptionSpec');
}

export function isRuntimeClientInteraction(value: unknown): value is RuntimeClientInteraction {
  if (
    !isRecord(value) ||
    !isIdentifier(value.interactionId) ||
    !isNonNegativeSafeInteger(value.sessionRevision)
  ) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      'kind',
      'interactionId',
      'sessionRevision',
      'title',
      'summary',
      'generation',
      'grants',
      'owner',
      'command',
      'question',
      'allowFreeText',
      'options',
      'plan',
      'provider',
      'action',
      'verification',
    ]) ||
    (Object.hasOwn(value, 'title') && !isBoundedUserText(value.title)) ||
    (Object.hasOwn(value, 'summary') && !isBoundedUserText(value.summary))
  ) {
    return false;
  }
  switch (value.kind) {
    case 'approval':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['kind', 'interactionId', 'sessionRevision', 'generation', 'grants', 'owner'],
            ['title', 'summary', 'command'],
          ),
        ) &&
        (!Object.hasOwn(value, 'command') || isBoundedUserText(value.command)) &&
        isNonNegativeSafeInteger(value.generation) &&
        Array.isArray(value.grants) &&
        value.grants.length > 0 &&
        value.grants.length <= 2 &&
        value.grants.every((grant) => grant === 'approve_once' || grant === 'same_command') &&
        new Set(value.grants).size === value.grants.length &&
        isRuntimeInteractionOwner(value.owner)
      );
    case 'input':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['kind', 'interactionId', 'sessionRevision', 'question', 'allowFreeText'],
            ['title', 'summary', 'options'],
          ),
        ) &&
        isBoundedUserText(value.question) &&
        typeof value.allowFreeText === 'boolean' &&
        (!Object.hasOwn(value, 'options') || isInputOptions(value.options))
      );
    case 'plan_review':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['kind', 'interactionId', 'sessionRevision', 'plan'],
            ['title', 'summary'],
          ),
        ) && isPlanIdentity(value.plan)
      );
    case 'provider_action':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['kind', 'interactionId', 'sessionRevision', 'provider', 'action'],
            ['title', 'summary'],
          ),
        ) &&
        isProviderIdentity(value.provider) &&
        (value.action === 'login' || value.action === 'approve' || value.action === 'retry')
      );
    case 'verification':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['kind', 'interactionId', 'sessionRevision', 'verification'],
            ['title', 'summary'],
          ),
        ) && isVerificationIdentity(value.verification)
      );
    default:
      return false;
  }
}

export function assertRuntimeClientInteraction(
  value: unknown,
): asserts value is RuntimeClientInteraction {
  if (!isRuntimeClientInteraction(value)) throw new TypeError('Invalid RuntimeClientInteraction');
}

function isRuntimeClientSubagentDiagnostic(
  value: unknown,
): value is Pick<SubAgentFailureDiagnostic, 'code' | 'stage'> {
  if (!isRecord(value) || !hasExactKeys(value, ['code', 'stage'])) return false;
  const validCode =
    value.code === 'aborted' ||
    value.code === 'timed_out' ||
    value.code === 'invalid_input' ||
    value.code === 'consumer_protocol' ||
    value.code === 'model_step_failed' ||
    value.code === 'internal_error';
  const validStage =
    value.stage === 'initialization' ||
    value.stage === 'next_round_preparation' ||
    value.stage === 'model_step' ||
    value.stage === 'model_response_validation' ||
    value.stage === 'tool_consumption' ||
    value.stage === 'transcript_validation' ||
    value.stage === 'terminal_projection';
  return validCode && validStage;
}

export function isRuntimeClientEvent(value: unknown): value is RuntimeClientEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'user.message':
      return (
        hasExactKeys(value, ['type', 'messageId', 'kind', 'text']) &&
        isIdentifier(value.messageId) &&
        (value.kind === 'task' || value.kind === 'answer' || value.kind === 'resume_context') &&
        isBoundedUserText(value.text)
      );
    case 'model.requested':
      return hasExactKeys(value, ['type', 'requestId']) && isIdentifier(value.requestId);
    case 'reasoning.activity':
      return (
        hasExactKeys(value, ['type', 'requestId', 'state', 'segmentId', 'text']) &&
        isIdentifier(value.requestId) &&
        (value.state === 'streaming' || value.state === 'completed') &&
        isIdentifier(value.segmentId) &&
        isBoundedUserText(value.text)
      );
    case 'model.text_delta':
      return (
        hasExactKeys(value, ['type', 'requestId', 'text']) &&
        isIdentifier(value.requestId) &&
        isBoundedUserText(value.text)
      );
    case 'model.responded':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'requestId', 'messageId', 'toolCallCount'],
            ['durationMs', 'summary'],
          ),
        ) &&
        isIdentifier(value.requestId) &&
        isIdentifier(value.messageId) &&
        isNonNegativeSafeInteger(value.toolCallCount) &&
        (!Object.hasOwn(value, 'durationMs') || isNonNegativeSafeInteger(value.durationMs)) &&
        (!Object.hasOwn(value, 'summary') || isBoundedUserText(value.summary))
      );
    case 'model.retry':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'requestId', 'attempt'], ['delayMs'])) &&
        isIdentifier(value.requestId) &&
        isPositiveInteger(value.attempt) &&
        (!Object.hasOwn(value, 'delayMs') || isNonNegativeSafeInteger(value.delayMs))
      );
    case 'model.cache':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'inputTokens', 'cacheHitTokens', 'cacheMissTokens'],
            ['outputTokens'],
          ),
        ) &&
        nonNegativeFields(value, [
          'inputTokens',
          'cacheHitTokens',
          'cacheMissTokens',
          'outputTokens',
        ])
      );
    case 'tool.queued':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'toolId', 'presentation', 'arguments', 'summary'],
            ['presentationGroupId', 'toolName', 'displayLabel'],
          ),
        ) &&
        isIdentifier(value.toolId) &&
        (!Object.hasOwn(value, 'presentationGroupId') || isIdentifier(value.presentationGroupId)) &&
        isBoundedString(value.summary) &&
        isRuntimeToolPresentation(value.presentation) &&
        isRecord(value.arguments) &&
        isJsonSafeValue(value.arguments) &&
        (!Object.hasOwn(value, 'toolName') || isRuntimeToolDisplayName(value.toolName)) &&
        (!Object.hasOwn(value, 'displayLabel') || isBoundedUserText(value.displayLabel, 512))
      );
    case 'tool.failed':
    case 'tool.rejected':
      return (
        hasExactKeys(value, ['type', 'toolId', 'presentation', 'summary']) &&
        isIdentifier(value.toolId) &&
        isRuntimeToolPresentation(value.presentation) &&
        isBoundedString(value.summary)
      );
    case 'tool.cancelled':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'toolId', 'presentation'], ['summary'])) &&
        isIdentifier(value.toolId) &&
        isRuntimeToolPresentation(value.presentation) &&
        (!Object.hasOwn(value, 'summary') || isBoundedString(value.summary))
      );
    case 'tool.finished':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'toolId', 'presentation', 'result', 'summary'],
            ['toolName', 'displayLabel'],
          ),
        ) &&
        isIdentifier(value.toolId) &&
        isBoundedString(value.summary) &&
        isRuntimeToolPresentation(value.presentation) &&
        isRuntimeClientToolResult(value.result) &&
        (!Object.hasOwn(value, 'toolName') || isRuntimeToolDisplayName(value.toolName)) &&
        (!Object.hasOwn(value, 'displayLabel') || isBoundedUserText(value.displayLabel, 512))
      );
    case 'tool.started':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'toolId'], ['summary'])) &&
        isIdentifier(value.toolId) &&
        optionalSummary(value)
      );
    case 'tool.progress':
      return (
        hasExactKeys(
          value,
          presentKeys(value, ['type', 'toolId', 'summary'], ['stream', 'lineCount']),
        ) &&
        isIdentifier(value.toolId) &&
        isBoundedUserText(value.summary) &&
        (!Object.hasOwn(value, 'stream') ||
          value.stream === 'stdout' ||
          value.stream === 'stderr') &&
        (!Object.hasOwn(value, 'lineCount') || isNonNegativeSafeInteger(value.lineCount))
      );
    case 'tool.file_changed':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'toolId', 'change'], ['summary'])) &&
        isIdentifier(value.toolId) &&
        (value.change === 'added' || value.change === 'modified' || value.change === 'deleted') &&
        optionalSummary(value)
      );
    case 'interaction.available':
      return (
        hasExactKeys(value, ['type', 'interaction']) &&
        isRuntimeClientInteraction(value.interaction)
      );
    case 'interaction.settled':
      return (
        hasExactKeys(value, ['type', 'interactionId', 'sessionRevision', 'outcome']) &&
        isIdentifier(value.interactionId) &&
        isNonNegativeSafeInteger(value.sessionRevision) &&
        (value.outcome === 'completed' ||
          value.outcome === 'rejected' ||
          value.outcome === 'cancelled' ||
          value.outcome === 'expired')
      );
    case 'approval.queued':
      return (
        hasExactKeys(value, ['type', 'interaction', 'queueSequence']) &&
        isRuntimeClientInteraction(value.interaction) &&
        value.interaction.kind === 'approval' &&
        isNonNegativeSafeInteger(value.queueSequence)
      );
    case 'approval.granted':
      return exactInteractionGeneration(value) && isRuntimeInteractionOwner(value.owner);
    case 'approval.rejected':
      return (
        hasExactKeys(
          value,
          presentKeys(value, ['type', 'interactionId', 'generation', 'owner'], ['summary']),
        ) &&
        isIdentifier(value.interactionId) &&
        isNonNegativeSafeInteger(value.generation) &&
        isRuntimeInteractionOwner(value.owner) &&
        optionalSummary(value)
      );
    case 'input.requested':
      return (
        hasExactKeys(value, ['type', 'interaction']) &&
        isRuntimeClientInteraction(value.interaction) &&
        value.interaction.kind === 'input'
      );
    case 'input.answered':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'interactionId'], ['summary'])) &&
        isIdentifier(value.interactionId) &&
        optionalSummary(value)
      );
    case 'input.cancelled':
      return hasExactKeys(value, ['type', 'interactionId']) && isIdentifier(value.interactionId);
    case 'plan.review_requested':
      return (
        hasExactKeys(value, ['type', 'interaction']) &&
        isRuntimeClientInteraction(value.interaction) &&
        value.interaction.kind === 'plan_review'
      );
    case 'plan.progress':
      return isPlanEvent(value, true);
    case 'plan.completed':
      return isPlanEvent(value, false);
    case 'plan.approved':
      return (
        hasExactKeys(value, ['type', 'interactionId', 'sessionRevision', 'mode']) &&
        isIdentifier(value.interactionId) &&
        isNonNegativeSafeInteger(value.sessionRevision) &&
        (value.mode === 'accept_edits' || value.mode === 'auto')
      );
    case 'planning.entered':
    case 'planning.exited':
      return hasExactKeys(value, ['type', 'taskId']) && isIdentifier(value.taskId);
    case 'interaction_mode.changed':
      return (
        hasExactKeys(value, ['type', 'mode']) &&
        (value.mode === 'accept_edits' || value.mode === 'auto' || value.mode === 'full')
      );
    case 'provider.action':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'interaction', 'status'], ['summary'])) &&
        isRuntimeClientInteraction(value.interaction) &&
        value.interaction.kind === 'provider_action' &&
        (value.status === 'required' ||
          value.status === 'started' ||
          value.status === 'completed' ||
          value.status === 'deferred' ||
          value.status === 'failed') &&
        optionalSummary(value)
      );
    case 'verification.status':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'interaction', 'status'], ['summary'])) &&
        isRuntimeClientInteraction(value.interaction) &&
        value.interaction.kind === 'verification' &&
        (value.status === 'pending' ||
          value.status === 'running' ||
          value.status === 'passed' ||
          value.status === 'failed' ||
          value.status === 'waived') &&
        optionalSummary(value)
      );
    case 'subagent.started':
      return (
        hasExactKeys(
          value,
          presentKeys(value, ['type', 'subagentId', 'role', 'name'], ['concurrencyGroupId']),
        ) &&
        isIdentifier(value.subagentId) &&
        (!Object.hasOwn(value, 'concurrencyGroupId') || isIdentifier(value.concurrencyGroupId)) &&
        (value.role === 'explore' ||
          value.role === 'plan' ||
          value.role === 'code' ||
          value.role === 'review') &&
        isBoundedString(value.name)
      );
    case 'subagent.phase':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'subagentId', 'parentToolCallId', 'status'],
            ['approvalState', 'interactionId', 'reviewId'],
          ),
        ) &&
        isIdentifier(value.subagentId) &&
        isIdentifier(value.parentToolCallId) &&
        (value.status === 'running' || value.status === 'suspended') &&
        (!Object.hasOwn(value, 'approvalState') ||
          value.approvalState === 'queued_auto_review' ||
          value.approvalState === 'auto_reviewing' ||
          value.approvalState === 'queued_user_approval' ||
          value.approvalState === 'awaiting_user' ||
          value.approvalState === 'authorized_queued') &&
        (!Object.hasOwn(value, 'interactionId') || isIdentifier(value.interactionId)) &&
        (!Object.hasOwn(value, 'reviewId') || isIdentifier(value.reviewId))
      );
    case 'subagent.step':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'subagentId', 'stepId', 'toolCallId', 'toolName', 'status'],
            ['displayLabel', 'arguments', 'summary', 'totalLines', 'durationMs'],
          ),
        ) &&
        isIdentifier(value.subagentId) &&
        isIdentifier(value.stepId) &&
        isIdentifier(value.toolCallId) &&
        isBoundedString(value.toolName) &&
        (value.status === 'started' ||
          value.status === 'completed' ||
          value.status === 'failed' ||
          value.status === 'cancelled') &&
        optionalSummary(value) &&
        (!Object.hasOwn(value, 'displayLabel') || isBoundedUserText(value.displayLabel, 512)) &&
        (!Object.hasOwn(value, 'arguments') ||
          (isRecord(value.arguments) && isJsonSafeValue(value.arguments))) &&
        (!Object.hasOwn(value, 'totalLines') || isNonNegativeSafeInteger(value.totalLines)) &&
        (!Object.hasOwn(value, 'durationMs') || isNonNegativeSafeInteger(value.durationMs))
      );
    case 'subagent.review':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'subagentId', 'parentToolCallId', 'reviewId', 'toolCallId', 'status'],
            ['summary'],
          ),
        ) &&
        isIdentifier(value.subagentId) &&
        isIdentifier(value.parentToolCallId) &&
        isIdentifier(value.reviewId) &&
        isIdentifier(value.toolCallId) &&
        (value.status === 'queued' ||
          value.status === 'reviewing' ||
          value.status === 'approved' ||
          value.status === 'rejected' ||
          value.status === 'failed') &&
        optionalSummary(value)
      );
    case 'subagent.completed':
      return (
        hasExactKeys(value, ['type', 'subagentId', 'summary', 'toolCallCount', 'durationMs']) &&
        isIdentifier(value.subagentId) &&
        isBoundedString(value.summary) &&
        isNonNegativeSafeInteger(value.toolCallCount) &&
        isNonNegativeSafeInteger(value.durationMs)
      );
    case 'subagent.failed':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'subagentId', 'summary'],
            ['toolCallCount', 'durationMs', 'diagnostic'],
          ),
        ) &&
        isIdentifier(value.subagentId) &&
        isBoundedString(value.summary) &&
        (!Object.hasOwn(value, 'toolCallCount') || isNonNegativeSafeInteger(value.toolCallCount)) &&
        (!Object.hasOwn(value, 'durationMs') || isNonNegativeSafeInteger(value.durationMs)) &&
        (!Object.hasOwn(value, 'diagnostic') || isRuntimeClientSubagentDiagnostic(value.diagnostic))
      );
    case 'context.compaction':
      return (
        hasExactKeys(
          value,
          presentKeys(value, ['type', 'status'], ['usedTokens', 'availableTokens', 'summary']),
        ) &&
        (value.status === 'requested' ||
          value.status === 'completed' ||
          value.status === 'failed' ||
          value.status === 'reset') &&
        nonNegativeFields(value, ['usedTokens', 'availableTokens']) &&
        optionalSummary(value)
      );
    case 'task.terminal':
      return isTerminalEvent(value, 'taskId', ['completed', 'cancelled', 'failed']);
    case 'turn.terminal':
      return (
        isTerminalEvent(
          value,
          'turnId',
          ['completed', 'aborted', 'failed', 'cancelled'],
          ['cause'],
        ) &&
        (!Object.hasOwn(value, 'cause') || value.cause === 'user' || value.cause === 'error')
      );
    case 'run.terminal':
      return (
        isTerminalEvent(value, 'runId', ['completed', 'failed', 'cancelled'], ['outcome']) &&
        (!Object.hasOwn(value, 'outcome') || isRuntimeClientTerminalOutcome(value.outcome))
      );
    case 'rewind.terminal':
      return (
        hasExactKeys(
          value,
          presentKeys(
            value,
            ['type', 'rewindId', 'commandId', 'sourceSessionId', 'targetSessionId', 'status'],
            ['fileOutcome', 'failureCode'],
          ),
        ) &&
        isIdentifier(value.rewindId) &&
        isIdentifier(value.commandId) &&
        isIdentifier(value.sourceSessionId) &&
        isIdentifier(value.targetSessionId) &&
        (value.status === 'completed' || value.status === 'failed') &&
        (!Object.hasOwn(value, 'fileOutcome') ||
          isRuntimeClientRewindFileOutcome(value.fileOutcome)) &&
        (!Object.hasOwn(value, 'failureCode') ||
          value.failureCode === 'checkpoint_unavailable' ||
          value.failureCode === 'execution_failed')
      );
    case 'session.notice':
      return (
        hasExactKeys(value, presentKeys(value, ['type', 'code'], ['message'])) &&
        (value.code === 'reconnected' ||
          value.code === 'history_gap' ||
          value.code === 'session_closed') &&
        (!Object.hasOwn(value, 'message') || isBoundedString(value.message))
      );
    case 'unavailable':
      return (
        hasExactKeys(value, ['type', 'reason']) &&
        (value.reason === 'unknown_event' ||
          value.reason === 'redacted' ||
          value.reason === 'unsupported_version')
      );
    default:
      return false;
  }
}

export function assertRuntimeClientEvent(value: unknown): asserts value is RuntimeClientEvent {
  if (!isRuntimeClientEvent(value)) throw new TypeError('Invalid RuntimeClientEvent');
}

export function isRuntimeSessionIndexNotification(
  value: unknown,
): value is RuntimeSessionIndexNotification {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const identity =
    isIdentifier(value.serverInstanceId) &&
    isNonNegativeSafeInteger(value.generation) &&
    isNonNegativeSafeInteger(value.indexRevision);
  switch (value.type) {
    case 'index_reset_begin':
    case 'index_reset_end':
      return (
        hasExactKeys(value, ['type', 'serverInstanceId', 'generation', 'indexRevision']) && identity
      );
    case 'session_upsert':
      return (
        hasExactKeys(value, [
          'type',
          'serverInstanceId',
          'generation',
          'indexRevision',
          'session',
        ]) &&
        identity &&
        isRuntimeSessionProjection(value.session)
      );
    case 'session_remove':
      return (
        hasExactKeys(value, [
          'type',
          'serverInstanceId',
          'generation',
          'indexRevision',
          'sessionId',
        ]) &&
        identity &&
        isIdentifier(value.sessionId)
      );
    default:
      return false;
  }
}

export function assertRuntimeSessionIndexNotification(
  value: unknown,
): asserts value is RuntimeSessionIndexNotification {
  if (!isRuntimeSessionIndexNotification(value)) {
    throw new TypeError('Invalid RuntimeSessionIndexNotification');
  }
}

function presentKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): readonly string[] {
  return [...required, ...optional.filter((key) => Object.hasOwn(value, key))];
}

function optionalSummary(value: Record<string, unknown>): boolean {
  return !Object.hasOwn(value, 'summary') || isBoundedUserText(value.summary, 8_192);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isRuntimeClientToolResult(value: unknown): value is RuntimeClientToolResult {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      presentKeys(
        value,
        ['ok', 'exitCode', 'stdout', 'stderr'],
        ['status', 'totalLines', 'toolTokenCount', 'terminationReason'],
      ),
    ) &&
    typeof value.ok === 'boolean' &&
    typeof value.exitCode === 'number' &&
    Number.isSafeInteger(value.exitCode) &&
    isBoundedOutputText(value.stdout) &&
    isBoundedOutputText(value.stderr) &&
    (!Object.hasOwn(value, 'status') ||
      value.status === 'success' ||
      value.status === 'error' ||
      value.status === 'exhausted') &&
    (!Object.hasOwn(value, 'totalLines') || isNonNegativeSafeInteger(value.totalLines)) &&
    (!Object.hasOwn(value, 'toolTokenCount') || isNonNegativeSafeInteger(value.toolTokenCount)) &&
    (!Object.hasOwn(value, 'terminationReason') ||
      value.terminationReason === 'timed_out' ||
      value.terminationReason === 'cancelled' ||
      value.terminationReason === 'sandbox_denied')
  );
}

function isBoundedOutputText(value: unknown): value is string {
  return value === '' || isBoundedUserText(value);
}

function nonNegativeFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(
    (field) => !Object.hasOwn(value, field) || isNonNegativeSafeInteger(value[field]),
  );
}

function isRuntimeInteractionOwner(value: unknown): value is InteractionOwner {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'root_tool') {
    return hasExactKeys(value, ['kind', 'toolCallId']) && isIdentifier(value.toolCallId);
  }
  return (
    value.kind === 'subagent_tool' &&
    hasExactKeys(value, ['kind', 'toolCallId', 'subagentId', 'parentToolCallId']) &&
    isIdentifier(value.toolCallId) &&
    isIdentifier(value.subagentId) &&
    isIdentifier(value.parentToolCallId)
  );
}

function exactInteractionGeneration(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, ['type', 'interactionId', 'generation', 'owner']) &&
    isIdentifier(value.interactionId) &&
    isNonNegativeSafeInteger(value.generation)
  );
}

function isPlanEvent(value: Record<string, unknown>, progress: boolean): boolean {
  const required = progress
    ? ['type', 'planId', 'version', 'structuralDigest', 'status']
    : ['type', 'planId', 'version', 'structuralDigest'];
  return (
    hasExactKeys(value, presentKeys(value, required, ['summary'])) &&
    isIdentifier(value.planId) &&
    isPositiveInteger(value.version) &&
    isIdentifier(value.structuralDigest) &&
    (!progress ||
      value.status === 'pending' ||
      value.status === 'in_progress' ||
      value.status === 'completed' ||
      value.status === 'skipped') &&
    optionalSummary(value)
  );
}

function isTerminalEvent(
  value: Record<string, unknown>,
  identifier: 'taskId' | 'turnId' | 'runId',
  statuses: readonly string[],
  additionalOptional: readonly string[] = [],
): boolean {
  return (
    hasExactKeys(
      value,
      presentKeys(value, ['type', identifier, 'status'], ['summary', ...additionalOptional]),
    ) &&
    isIdentifier(value[identifier]) &&
    typeof value.status === 'string' &&
    statuses.includes(value.status) &&
    optionalSummary(value)
  );
}

function isRuntimeClientTerminalOutcome(value: unknown): value is RuntimeClientTerminalOutcome {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['status', 'reasonCode', 'safeRetry', 'recoveryEntry']) &&
    (value.status === 'completed' ||
      value.status === 'aborted' ||
      value.status === 'blocked' ||
      value.status === 'unknown' ||
      value.status === 'budget_exhausted' ||
      value.status === 'resource_saturated') &&
    isIdentifier(value.reasonCode) &&
    typeof value.safeRetry === 'boolean' &&
    (value.recoveryEntry === 'none' ||
      value.recoveryEntry === 'retry' ||
      value.recoveryEntry === 'reconcile' ||
      value.recoveryEntry === 'new_run' ||
      value.recoveryEntry === 'operator_action')
  );
}

function isRuntimeClientRewindFileOutcome(value: unknown): value is RuntimeClientRewindFileOutcome {
  if (!isRecord(value) || !hasExactKeys(value, ['restored', 'deleted', 'failed', 'conflicts'])) {
    return false;
  }
  const paths = (candidate: unknown): candidate is readonly string[] =>
    Array.isArray(candidate) && candidate.length <= 10_000 && candidate.every(isBoundedString);
  return (
    paths(value.restored) &&
    paths(value.deleted) &&
    Array.isArray(value.failed) &&
    value.failed.length <= 10_000 &&
    value.failed.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['path', 'error']) &&
        isBoundedString(entry.path) &&
        isBoundedString(entry.error),
    ) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.length <= 10_000 &&
    value.conflicts.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['path', 'reason']) &&
        isBoundedString(entry.path) &&
        (entry.reason === 'modified_after_kite_write' || entry.reason === 'unverified_postimage'),
    )
  );
}

function isRuntimeSessionProjection(value: unknown): value is RuntimeSessionProjection {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(
      value,
      presentKeys(
        value,
        ['schema', 'sessionId', 'revision', 'lifecycle', 'interactionQueue'],
        [
          'displayName',
          'updatedAt',
          'sessionCommandGrantCount',
          'activeTask',
          'currentRun',
          'model',
        ],
      ),
    ) &&
    value.schema === RUNTIME_PROJECTION_SCHEMA_ &&
    isIdentifier(value.sessionId) &&
    isNonNegativeSafeInteger(value.revision) &&
    (!Object.hasOwn(value, 'sessionCommandGrantCount') ||
      isNonNegativeSafeInteger(value.sessionCommandGrantCount)) &&
    (value.lifecycle === 'open' ||
      value.lifecycle === 'closed' ||
      value.lifecycle === 'unavailable') &&
    (!Object.hasOwn(value, 'displayName') || isBoundedString(value.displayName)) &&
    (!Object.hasOwn(value, 'updatedAt') || isBoundedString(value.updatedAt)) &&
    (!Object.hasOwn(value, 'model') ||
      (isRecord(value.model) &&
        hasExactKeys(
          value.model,
          presentKeys(value.model, ['provider', 'name'], ['reasoningEnabled']),
        ) &&
        isBoundedString(value.model.provider) &&
        isBoundedString(value.model.name) &&
        (!Object.hasOwn(value.model, 'reasoningEnabled') ||
          typeof value.model.reasoningEnabled === 'boolean'))) &&
    isRuntimeInteractionQueueProjection(value.interactionQueue) &&
    (value.interactionQueue as { readonly revision: unknown }).revision === value.revision &&
    (!Object.hasOwn(value, 'activeTask') || isRuntimeSessionTaskProjection(value.activeTask)) &&
    (!Object.hasOwn(value, 'currentRun') || isRuntimeSessionRunProjection(value.currentRun)) &&
    activeInteractionMatchesQueue(value)
  );
}

function activeInteractionMatchesQueue(value: Record<string, unknown>): boolean {
  const queue = value.interactionQueue as {
    readonly activeInteractionId?: string;
    readonly interactions: readonly RuntimeClientInteraction[];
  };
  const currentRun = value.currentRun as { readonly activeInteractionId?: string } | undefined;
  const queuedInteraction =
    queue.activeInteractionId === undefined
      ? undefined
      : queue.interactions.find(
          (candidate) => candidate.interactionId === queue.activeInteractionId,
        );
  return (
    (currentRun === undefined || queue.activeInteractionId === currentRun.activeInteractionId) &&
    (queue.activeInteractionId === undefined || queuedInteraction !== undefined)
  );
}

function isRuntimeSessionTaskProjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['taskId', 'phase']) &&
    isIdentifier(value.taskId) &&
    (value.phase === 'planning' || value.phase === 'building')
  );
}

function isRuntimeSessionRunProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = value.status;
  const active = status === 'queued' || status === 'running' || status === 'waiting';
  const recovery = status === 'recovery_required';
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return (
    hasExactKeys(
      value,
      presentKeys(
        value,
        ['runId', 'initialTurnId', 'status', 'revision'],
        ['activeTurnId', 'taskId', 'activeInteractionId', 'outcome'],
      ),
    ) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.initialTurnId) &&
    (!Object.hasOwn(value, 'activeTurnId') || isIdentifier(value.activeTurnId)) &&
    (!Object.hasOwn(value, 'taskId') || isIdentifier(value.taskId)) &&
    (!Object.hasOwn(value, 'activeInteractionId') || isIdentifier(value.activeInteractionId)) &&
    isNonNegativeSafeInteger(value.revision) &&
    (active || recovery || terminal) &&
    (!Object.hasOwn(value, 'outcome') || isRuntimeRunTerminalProjection(value.outcome)) &&
    (!active || Object.hasOwn(value, 'activeTurnId')) &&
    (!recovery || Object.hasOwn(value, 'outcome'))
  );
}

function isRuntimeRunTerminalProjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      presentKeys(value, ['reasonCode', 'safeRetry', 'recoveryEntry'], ['outcomeId']),
    ) &&
    isBoundedString(value.reasonCode) &&
    typeof value.safeRetry === 'boolean' &&
    (value.recoveryEntry === 'none' ||
      value.recoveryEntry === 'retry' ||
      value.recoveryEntry === 'reconcile' ||
      value.recoveryEntry === 'new_run' ||
      value.recoveryEntry === 'operator_action') &&
    (!Object.hasOwn(value, 'outcomeId') || isBoundedString(value.outcomeId))
  );
}

function isRuntimeInteractionQueueProjection(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      presentKeys(value, ['revision', 'interactions'], ['activeInteractionId']),
    ) ||
    !isNonNegativeSafeInteger(value.revision) ||
    !Array.isArray(value.interactions) ||
    value.interactions.length > 256 ||
    !value.interactions.every(isRuntimeClientInteraction) ||
    (Object.hasOwn(value, 'activeInteractionId') && !isIdentifier(value.activeInteractionId))
  ) {
    return false;
  }
  const ids = value.interactions.map((interaction) => interaction.interactionId);
  return (
    new Set(ids).size === ids.length &&
    value.interactions.every((interaction) => interaction.sessionRevision === value.revision) &&
    (!Object.hasOwn(value, 'activeInteractionId') ||
      ids.includes(value.activeInteractionId as string))
  );
}

function isInputOptions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (option) =>
        isRecord(option) &&
        hasExactKeys(option, presentKeys(option, ['id', 'label'], ['description'])) &&
        isIdentifier(option.id) &&
        isBoundedUserText(option.label) &&
        (!Object.hasOwn(option, 'description') || isBoundedUserText(option.description)),
    )
  );
}

function isPlanIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['planId', 'version', 'structuralDigest']) &&
    isIdentifier(value.planId) &&
    isNonNegativeSafeInteger(value.version) &&
    value.version > 0 &&
    isIdentifier(value.structuralDigest)
  );
}

function isProviderIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, presentKeys(value, ['providerId'], ['directoryRevision'])) &&
    isIdentifier(value.providerId) &&
    (!Object.hasOwn(value, 'directoryRevision') || isIdentifier(value.directoryRevision))
  );
}

function isVerificationIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['verificationId', 'revision']) &&
    isIdentifier(value.verificationId) &&
    isIdentifier(value.revision)
  );
}
