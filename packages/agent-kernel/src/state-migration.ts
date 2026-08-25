/**
 * Pure compatibility boundary for the one State 26 format that can be read
 * by the State 27 Kernel.
 *
 * This module deliberately does not know about SQLite, event envelopes, or
 * Host identity allocation.  It only turns a validated legacy snapshot into
 * a safe State 27 history projection.  In particular, no legacy authority is
 * copied into the current approval queue.
 */

import { assertCurrentRuntimeEvent } from './codec';
import { assertAgentStateInvariants } from './invariants';
import { createToolRecoveryJournal } from './recovery';
import {
  type AgentState,
  createInitialAgentState,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
} from './state';

export const LEGACY_STATE26_SCHEMA_VERSION = 26 as const;
export const LEGACY_STATE26_FORMAT_EPOCH = 'kite-runtime-modularization-v1-2026-08-19' as const;

export type StateFormatClassification = 'current' | 'state26' | 'unsupported';

export type StateMigrationFailure =
  | 'invalid_state26_snapshot'
  | 'invalid_session_identity'
  | 'invalid_recovery_identity';

export type StateMigrationResult =
  | {
      readonly status: 'migrated';
      readonly state: AgentState;
    }
  | {
      readonly status: 'unsupported';
      readonly reason?: StateMigrationFailure;
    };

export type LegacyRuntimeEventConversionResult =
  | {
      readonly status: 'converted';
      /** Event envelope sequence/revision/eventId are intentionally absent. */
      readonly event: Record<string, unknown>;
    }
  | { readonly status: 'ignored' };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'string') return isRecord(value) ? value : undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a decoded (or JSON-encoded) snapshot without throwing.  Unknown
 * versions and epochs are deliberately indistinguishable to callers that
 * discover sessions: both are simply unsupported and may be skipped.
 */
export function classifyStateFormat(value: unknown): StateFormatClassification {
  const candidate = parseRecord(value);
  if (!candidate) return 'unsupported';
  if (
    candidate.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION &&
    candidate.formatEpoch === RUNTIME_STATE_FORMAT_EPOCH
  )
    return 'current';
  if (
    candidate.schemaVersion === LEGACY_STATE26_SCHEMA_VERSION &&
    candidate.formatEpoch === LEGACY_STATE26_FORMAT_EPOCH
  )
    return 'state26';
  return 'unsupported';
}

export const classifyAgentStateFormat = classifyStateFormat;

export function isLegacyState26Snapshot(value: unknown): boolean {
  return classifyStateFormat(value) === 'state26';
}

/** Validate only the identity and shape needed to avoid treating arbitrary JSON as State. */
function validateState26Boundary(candidate: UnknownRecord): StateMigrationFailure | undefined {
  const session = candidate.session;
  if (
    !isRecord(session) ||
    !nonEmptyString(session.threadId) ||
    !nonEmptyString(session.userId) ||
    !nonEmptyString(session.workspace) ||
    !nonEmptyString(session.projectId) ||
    !nonEmptyString(session.canonicalWorkspaceDigest)
  ) {
    return 'invalid_session_identity';
  }

  const turn = candidate.turn;
  const toolRecovery = candidate.toolRecovery;
  if (
    !isRecord(turn) ||
    !nonEmptyString(turn.turnId) ||
    !nonNegativeInteger(turn.turnIndex) ||
    !['active', 'completed', 'aborted'].includes(String(turn.status))
  ) {
    return 'invalid_state26_snapshot';
  }
  if (
    !isRecord(toolRecovery) ||
    toolRecovery.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(String(toolRecovery.identityKey)) ||
    !isRecord(toolRecovery.failures) ||
    !Array.isArray(toolRecovery.order) ||
    !nonNegativeInteger(toolRecovery.progressRevision) ||
    !isRecord(toolRecovery.qualityGuard) ||
    typeof toolRecovery.qualityGuard.blocked !== 'boolean' ||
    !nonNegativeInteger(toolRecovery.qualityGuard.observedFailures)
  ) {
    return 'invalid_recovery_identity';
  }
  if (!['accept_edits', 'auto', 'full'].includes(String(candidate.mode))) {
    return 'invalid_state26_snapshot';
  }
  if (candidate.workspaceAccess !== undefined && candidate.workspaceAccess !== 'write') {
    return 'invalid_state26_snapshot';
  }
  if (
    !nonNegativeInteger(candidate.revision) ||
    !Array.isArray(candidate.appliedEventIds) ||
    candidate.appliedEventIds.length > 4096 ||
    candidate.appliedEventIds.some((eventId) => !nonEmptyString(eventId)) ||
    new Set(candidate.appliedEventIds).size !== candidate.appliedEventIds.length
  ) {
    return 'invalid_state26_snapshot';
  }
  if (!isRecord(candidate.transcript) || !Array.isArray(candidate.transcript.messages)) {
    return 'invalid_state26_snapshot';
  }
  if (!isRecord(candidate.context) || !isRecord(candidate.context.autoGuard)) {
    return 'invalid_state26_snapshot';
  }
  if (
    !Array.isArray(candidate.context.history) ||
    candidate.context.history.length > 128 ||
    !Array.isArray(candidate.context.autoGuard.recentAutomaticCompactions) ||
    !nonNegativeInteger(candidate.context.autoGuard.consecutiveLowGain) ||
    typeof candidate.context.autoGuard.disabledUntilManualAction !== 'boolean' ||
    typeof candidate.context.autoGuard.recoveryAttempted !== 'boolean'
  ) {
    return 'invalid_state26_snapshot';
  }
  if (!isRecord(candidate.tasks)) return 'invalid_state26_snapshot';
  return undefined;
}

function copySafeTranscript(candidate: UnknownRecord): AgentState['transcript'] | undefined {
  const transcript = isRecord(candidate.transcript) ? candidate.transcript : undefined;
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  const safeMessages: UnknownRecord[] = [];
  for (const message of messages) {
    if (!isRecord(message)) return undefined;
    if (
      nonEmptyString(message.messageId) &&
      nonEmptyString(message.turnId) &&
      nonNegativeInteger(message.ordinal) &&
      typeof message.createdAt === 'string' &&
      Number.isFinite(Date.parse(message.createdAt))
    ) {
      safeMessages.push(message);
      continue;
    }
    return undefined;
  }
  return {
    messages: safeMessages,
    ...(typeof transcript?.final === 'string' ? { final: transcript.final } : {}),
  } as unknown as AgentState['transcript'];
}

function copySafeContext(candidate: UnknownRecord): AgentState['context'] {
  const source = isRecord(candidate.context) ? candidate.context : undefined;
  const autoGuard = isRecord(source?.autoGuard) ? source.autoGuard : undefined;
  return {
    history: source?.history ?? [],
    autoGuard: {
      recentAutomaticCompactions: autoGuard?.recentAutomaticCompactions ?? [],
      consecutiveLowGain: nonNegativeInteger(autoGuard?.consecutiveLowGain)
        ? autoGuard.consecutiveLowGain
        : 0,
      disabledUntilManualAction: autoGuard?.disabledUntilManualAction === true,
      recoveryAttempted: autoGuard?.recoveryAttempted === true,
    },
  } as unknown as AgentState['context'];
}

function safeRevision(candidate: UnknownRecord): {
  readonly revision: number;
  readonly appliedEventIds: readonly string[];
  readonly lastAppliedEventId?: string;
} {
  const revision = nonNegativeInteger(candidate.revision) ? candidate.revision : 0;
  const supplied = Array.isArray(candidate.appliedEventIds) ? candidate.appliedEventIds : [];
  const unique = [...new Set(supplied.filter(nonEmptyString))].slice(-4096);
  const lastAppliedEventId = nonEmptyString(candidate.lastAppliedEventId)
    ? candidate.lastAppliedEventId
    : undefined;
  return {
    revision,
    appliedEventIds: unique,
    ...(lastAppliedEventId && unique.includes(lastAppliedEventId) ? { lastAppliedEventId } : {}),
  };
}

function copySafeTasks(
  candidate: UnknownRecord,
):
  | { readonly tasks: Readonly<Record<string, UnknownRecord>>; readonly activeTaskId: null }
  | undefined {
  const source = candidate.tasks;
  if (source === undefined) return { tasks: {}, activeTaskId: null };
  if (!isRecord(source)) return undefined;
  const tasks: Record<string, UnknownRecord> = {};
  for (const [taskId, rawTask] of Object.entries(source)) {
    if (
      !isRecord(rawTask) ||
      rawTask.taskId !== taskId ||
      !safeString(rawTask.userGoal) ||
      !['active', 'completed', 'cancelled'].includes(String(rawTask.status)) ||
      !nonEmptyString(rawTask.startedAtTurnId) ||
      typeof rawTask.sideEffectsStarted !== 'boolean' ||
      !isRecord(rawTask.planning) ||
      !Array.isArray(rawTask.planHistory) ||
      (rawTask.executionMode !== undefined &&
        !['auto', 'accept_edits'].includes(String(rawTask.executionMode)))
    ) {
      return undefined;
    }
    // An active State 26 task is tied to the aborted old turn and must not be
    // selected as the current task. The durable plan remains history.
    tasks[taskId] = {
      ...rawTask,
      status: rawTask.status === 'active' ? 'cancelled' : rawTask.status,
    };
  }
  return { tasks, activeTaskId: null };
}

/**
 * Migrate the safe history projection of an exact State 26 snapshot.
 *
 * The operation is intentionally lossy at authority/effect boundaries:
 * pending approvals, grants, receipts, active tools, provider admissions,
 * capabilities, and recovery journals are not resumed from the old format.
 */
export function migrateState26To27(value: unknown): StateMigrationResult {
  const candidate = parseRecord(value);
  if (classifyStateFormat(candidate) !== 'state26' || !candidate) {
    return { status: 'unsupported' };
  }
  const boundaryFailure = validateState26Boundary(candidate);
  if (boundaryFailure) return { status: 'unsupported', reason: boundaryFailure };

  const session = candidate.session as UnknownRecord;
  const turn = candidate.turn as UnknownRecord;
  const identityKey = (candidate.toolRecovery as UnknownRecord).identityKey as string;
  let migrated: AgentState;
  try {
    migrated = createInitialAgentState({
      threadId: session.threadId as string,
      userId: session.userId as string,
      workspace: session.workspace as string,
      projectId: session.projectId as string,
      canonicalWorkspaceDigest: session.canonicalWorkspaceDigest as string,
      turnId: turn.turnId as string,
      recoveryIdentityKey: identityKey,
      // State 26's full authority is never resumed in State 27.
      interactionMode:
        candidate.mode === 'auto' &&
        !(isRecord(candidate.authorization) && candidate.authorization.mode === 'full_access')
          ? 'auto'
          : 'accept_edits',
      workspaceAccess: 'write',
    });
  } catch {
    return { status: 'unsupported', reason: 'invalid_state26_snapshot' };
  }

  const revision = safeRevision(candidate);
  const transcript = copySafeTranscript(candidate);
  const tasks = copySafeTasks(candidate);
  if (!transcript || !tasks) return { status: 'unsupported', reason: 'invalid_state26_snapshot' };
  // An active State 26 turn may have an effect/authority event between the
  // last snapshot and the next event. It is never resumed optimistically.
  const interrupted = turn.status === 'active';
  migrated = {
    ...migrated,
    ...revision,
    turn: interrupted
      ? {
          turnId: turn.turnId as string,
          turnIndex: turn.turnIndex as number,
          status: 'aborted',
          abortReason: 'legacy_state_migrated',
          abortCause: 'error',
        }
      : {
          turnId: turn.turnId as string,
          turnIndex: turn.turnIndex as number,
          status: turn.status as 'active' | 'completed' | 'aborted',
          ...(typeof turn.abortReason === 'string' ? { abortReason: turn.abortReason } : {}),
          ...(turn.abortCause === 'user' || turn.abortCause === 'error'
            ? { abortCause: turn.abortCause }
            : {}),
        },
    transcript,
    context: copySafeContext(candidate),
    // These are deliberately reset rather than copied from State 26.  They
    // can contain an old effect lease or a pending authority decision.
    resourceBudget: { status: 'unconfigured', reservations: {} },
    modelInvocations: {},
    providerReadiness: {},
    completionGuard: { correctionAttempts: 0 },
    activeTaskId: tasks.activeTaskId,
    tasks: tasks.tasks as unknown as AgentState['tasks'],
    interactions: { kind: 'idle' },
    tools: { calls: {}, queue: [], active: [] },
    toolRecovery: createToolRecoveryJournal(identityKey),
    capabilities: {
      catalogRevision: '',
      bindings: {},
      disclosures: {},
      loadedCapabilities: {},
      invocations: {},
    },
    skills: { catalogRevision: '', frames: {} },
    verification: { records: {} },
    providerAdmission: { pending: [], waivers: {} },
    suspendedSubagents: {},
    autoReview: {
      pendingWarnings: {},
      consecutiveRejects: 0,
      rejectionHistory: [],
      circuitBreakerTripped: false,
    },
    doomLoop: {},
    pendingApprovals: new Map(),
    activeApprovalId: null,
    nextQueueSequence: 0,
    approvalGeneration: 0,
    sessionCommandGrants: new Map(),
    approvalReceipts: new Map(),
  };

  try {
    assertAgentStateInvariants(migrated);
  } catch {
    return { status: 'unsupported', reason: 'invalid_state26_snapshot' };
  }
  return {
    status: 'migrated',
    state: migrated,
  };
}

export const migrateCompatibleAgentState = migrateState26To27;
export const migrateLegacyAgentState = migrateState26To27;

const LEGACY_AUTHORIZATION_EVENT_TYPES = new Set([
  'authorization.changed',
  'interaction_mode.changed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.command_replaced',
  'approval.batch_released',
  'approval.session_grants_cleared',
  'auto_review.requested',
  'auto_review.completed',
]);

function isLegacyModelRetryWithoutInvocationIdentity(event: UnknownRecord): boolean {
  return (
    event.type === 'model.retry' &&
    event.invocationId === undefined &&
    nonNegativeInteger(event.attempt) &&
    nonNegativeInteger(event.maxAttempts) &&
    typeof event.error === 'string' &&
    nonNegativeInteger(event.delayMs)
  );
}

function isLegacyAuthorizationEvent(event: UnknownRecord): boolean {
  return typeof event.type === 'string' && LEGACY_AUTHORIZATION_EVENT_TYPES.has(event.type);
}

function ignoredAuthorizationEvent(): Record<string, unknown> {
  return {
    type: 'runtime.action_ignored',
    reason: 'legacy_authorization_compatibility',
  };
}

function ignoredUnknownLegacyEvent(): Record<string, unknown> {
  return {
    type: 'runtime.action_ignored',
    reason: 'legacy_unknown_event_compatibility',
  };
}

/**
 * Convert one State 26 event payload. The returned event is a current
 * reducer-safe no-op for every legacy authority/review fact and for unknown
 * legacy event types. This keeps the known session's journal contiguous while
 * ensuring an event whose semantics are not known can never regain authority.
 * Malformed JSON/records remain unsupported at the per-session boundary.
 * Event sequence, revision, and eventId remain the envelope owner's
 * responsibility and are never synthesized here.
 */
export function convertLegacyRuntimeEvent(value: unknown): LegacyRuntimeEventConversionResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { status: 'ignored' };
  if (isLegacyAuthorizationEvent(value)) {
    return { status: 'converted', event: ignoredAuthorizationEvent() };
  }
  // Early State 26 retry facts predate invocation identity. They are useful
  // only as historical UI telemetry and cannot safely be rebound to a live
  // State 27 model invocation, so preserve the journal position as a no-op.
  if (isLegacyModelRetryWithoutInvocationIdentity(value)) {
    return {
      status: 'converted',
      event: { type: 'runtime.action_ignored', reason: 'legacy_model_retry_compatibility' },
    };
  }
  try {
    assertCurrentRuntimeEvent(value);
    const event: Record<string, unknown> = { ...value };
    delete event.sequence;
    delete event.revision;
    delete event.eventId;
    return { status: 'converted', event };
  } catch {
    return { status: 'converted', event: ignoredUnknownLegacyEvent() };
  }
}

export const convertState26RuntimeEvent = convertLegacyRuntimeEvent;
export const migrateState26Event = convertLegacyRuntimeEvent;

export function convertLegacyRuntimeEventJson(
  serialized: string,
): LegacyRuntimeEventConversionResult {
  try {
    return convertLegacyRuntimeEvent(JSON.parse(serialized) as unknown);
  } catch {
    return { status: 'ignored' };
  }
}
