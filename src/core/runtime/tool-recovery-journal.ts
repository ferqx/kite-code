import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isToolOutcomeV1, type ToolOutcomeV1 } from './tool-outcome';

export const TOOL_RECOVERY_JOURNAL_SCHEMA_VERSION = 1 as const;
export const TOOL_RECOVERY_QUALITY_FAILURE_LIMIT = 6;
export const TOOL_RECOVERY_QUALITY_GLOBAL_FAILURE_LIMIT = 12;
const TOOL_RECOVERY_OBSERVATION_CAP = 250;

export type ToolRecoveryAttemptModeV1 = 'model_correction' | 'automatic_retry';
export const TOOL_RECOVERY_RESOLUTIONS_V1 = [
  'recovered',
  'terminal',
  'next_response_elapsed',
  'task_closed',
  'turn_closed',
  'skipped',
  'replanned',
  'user_action',
  'provider_revision',
] as const;

export type ToolRecoveryResolutionV1 = (typeof TOOL_RECOVERY_RESOLUTIONS_V1)[number];

export function isToolRecoveryResolutionV1(value: unknown): value is ToolRecoveryResolutionV1 {
  return (
    typeof value === 'string' && (TOOL_RECOVERY_RESOLUTIONS_V1 as readonly string[]).includes(value)
  );
}

export interface ToolRecoveryFailureV1 {
  failureInstanceId: string;
  toolCallId: string;
  toolName: string;
  /** Internal-only keyed fingerprint. Never project into SessionLog/telemetry/eval. */
  invocationFingerprint: string;
  modelMessageId: string;
  taskId?: string;
  turnId?: string;
  eligibleAfterModelMessageId?: string;
  eligibleModelMessageId?: string;
  status: 'unresolved' | 'recovered' | 'exhausted';
  resolution?: ToolRecoveryResolutionV1;
  outcome: ToolOutcomeV1;
  modelCorrectionAttempts: number;
  automaticRetryAttempts: number;
  progressRevision: number;
}

export interface ToolRecoveryJournalV1 {
  schemaVersion: typeof TOOL_RECOVERY_JOURNAL_SCHEMA_VERSION;
  /** Canonical-private random HMAC key. It is durable but never projected outside Runtime state. */
  identityKey: string;
  failures: Record<string, ToolRecoveryFailureV1>;
  order: string[];
  progressRevision: number;
  qualityGuard: {
    blocked: boolean;
    /** Stable cause: ordinary loop ceiling vs persisted/private journal corruption. */
    reasonCode?: 'no_progress' | 'journal_invalid';
    observedFailures: number;
    taskId?: string;
    turnId?: string;
  };
}

export interface ToolOwnedProgressV1 {
  kind:
    | 'content_revision'
    | 'plan_revision'
    | 'capability_revision'
    | 'provider_revision'
    | 'receipt'
    | 'skipped'
    | 'replanned'
    | 'user_action';
  /** Opaque canonical Store reference; never projected to diagnostics. */
  referenceId: string;
  /** Explicit Runtime-derived failure identities resolved by this evidence. */
  resolvesFailureIds?: string[];
}

export function createToolRecoveryJournalV1(identityKey?: string): ToolRecoveryJournalV1 {
  return {
    schemaVersion: 1,
    identityKey:
      typeof identityKey === 'string' && /^[a-f0-9]{64}$/u.test(identityKey)
        ? identityKey
        : randomBytes(32).toString('hex'),
    failures: {},
    order: [],
    progressRevision: 0,
    qualityGuard: { blocked: false, observedFailures: 0 },
  };
}

function blockedRecoveryJournalV1(
  observedFailures = 0,
  scope?: { taskId?: string; turnId?: string },
): ToolRecoveryJournalV1 {
  return {
    ...createToolRecoveryJournalV1(),
    qualityGuard: {
      blocked: true,
      reasonCode: 'journal_invalid',
      observedFailures: Math.max(0, Math.floor(observedFailures)),
      ...(scope?.taskId ? { taskId: scope.taskId } : {}),
      ...(scope?.turnId ? { turnId: scope.turnId } : {}),
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/** Canonical private identity. The caller must use the per-thread key and never export the result. */
export function toolInvocationFingerprintV1(input: {
  key: string;
  toolName: string;
  parsedArgs?: unknown;
  parseCode?: 'invalid_json' | 'invalid_arguments' | 'unknown_tool' | 'tool_unavailable';
  pathCategory?: 'root' | 'nested' | 'none' | 'unknown';
  /** Pre-parse private material. It is HMACed immediately and never persisted or projected. */
  unparsedArgs?: unknown;
  /** Current ToolSpec descriptor or Runtime binding revision. */
  identityRevision?: string;
}): string {
  const material = input.parseCode
    ? canonicalJson({
        toolName: input.toolName,
        parseCode: input.parseCode,
        pathCategory: input.pathCategory ?? 'unknown',
        opaqueArgs: input.unparsedArgs,
        identityRevision: input.identityRevision ?? 'unknown',
      })
    : canonicalJson({
        toolName: input.toolName,
        parsedArgs: input.parsedArgs,
        identityRevision: input.identityRevision ?? 'unknown',
      });
  return createHmac('sha256', input.key).update(material).digest('hex');
}

export function toolFailureInstanceIdV1(input: {
  toolCallId: string;
  invocationFingerprint: string;
  outcome: ToolOutcomeV1;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        toolCallId: input.toolCallId,
        invocationFingerprint: input.invocationFingerprint,
        status: input.outcome.status,
        detailCode: input.outcome.failure?.detailCode ?? 'success',
      }),
    )
    .digest('hex');
}

function failureStillBlocks(failure: ToolRecoveryFailureV1): boolean {
  if (failure.status === 'recovered') return false;
  return failure.resolution !== 'task_closed' && failure.resolution !== 'turn_closed';
}

function blockingFailures(journal: ToolRecoveryJournalV1): ToolRecoveryFailureV1[] {
  return journal.order
    .map((id) => journal.failures[id])
    .filter((entry): entry is ToolRecoveryFailureV1 => entry != null && failureStillBlocks(entry));
}

function journalInvalidQualityGuardV1(journal: ToolRecoveryJournalV1): boolean {
  return journal.qualityGuard.blocked && journal.qualityGuard.reasonCode === 'journal_invalid';
}

/** A corrupt journal is a session-wide correctness block, independent of task/turn scope. */
export function isToolRecoveryJournalInvalidV1(journal: ToolRecoveryJournalV1): boolean {
  return journalInvalidQualityGuardV1(journal);
}

function qualityGuardAfterMutationV1(
  journal: ToolRecoveryJournalV1,
  proposed: ToolRecoveryJournalV1['qualityGuard'],
): ToolRecoveryJournalV1['qualityGuard'] {
  return journalInvalidQualityGuardV1(journal) ? journal.qualityGuard : proposed;
}

/** Retain recent/active records together with their complete recoveryOf ancestor closure. */
function compactRecoveryFailuresV1(
  failures: Record<string, ToolRecoveryFailureV1>,
  inputOrder: string[],
): { failures: Record<string, ToolRecoveryFailureV1>; order: string[] } {
  const order = [...new Set(inputOrder)].filter((id) => failures[id] != null);
  if (order.length <= 128) return { failures, order };
  const newestFirst = [...order].reverse();
  const prioritized = [
    ...newestFirst.filter((id) => failureStillBlocks(failures[id]!)),
    ...newestFirst.filter((id) => !failureStillBlocks(failures[id]!)),
  ];
  const retained = new Set<string>();
  for (const candidateId of prioritized) {
    if (retained.has(candidateId)) continue;
    const closure: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = candidateId;
    while (currentId && !seen.has(currentId)) {
      const current: ToolRecoveryFailureV1 | undefined = failures[currentId];
      if (!current) break;
      seen.add(currentId);
      closure.push(currentId);
      currentId = current.outcome.lineage?.recoveryOf;
    }
    const additions = closure.filter((id) => !retained.has(id));
    if (retained.size + additions.length > 128) continue;
    for (const id of additions) retained.add(id);
    if (retained.size === 128) break;
  }
  const retainedOrder = order.filter((id) => retained.has(id));
  return {
    order: retainedOrder,
    failures: Object.fromEntries(retainedOrder.map((id) => [id, failures[id]!])),
  };
}

export function recordRecoveryFailureV1(
  journal: ToolRecoveryJournalV1,
  input: {
    toolCallId: string;
    toolName: string;
    invocationFingerprint: string;
    modelMessageId: string;
    outcome: ToolOutcomeV1;
    taskId?: string;
    turnId?: string;
  },
): ToolRecoveryJournalV1 {
  if (input.outcome.status === 'success') return journal;
  const id = toolFailureInstanceIdV1(input);
  if (journal.failures[id]) return journal;
  const recoveryParent = input.outcome.lineage?.recoveryOf
    ? journal.failures[input.outcome.lineage.recoveryOf]
    : undefined;
  const failure: ToolRecoveryFailureV1 = {
    failureInstanceId: id,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    invocationFingerprint: input.invocationFingerprint,
    modelMessageId: input.modelMessageId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    eligibleAfterModelMessageId: input.modelMessageId,
    status: input.outcome.recovery.disposition === 'never' ? 'exhausted' : 'unresolved',
    ...(input.outcome.recovery.disposition === 'never' ? { resolution: 'terminal' as const } : {}),
    outcome: {
      ...input.outcome,
      lineage: { ...input.outcome.lineage, failureInstanceId: id },
    },
    modelCorrectionAttempts: recoveryParent?.modelCorrectionAttempts ?? 0,
    automaticRetryAttempts: recoveryParent?.automaticRetryAttempts ?? 0,
    progressRevision: journal.progressRevision,
  };
  const failures = {
    ...journal.failures,
    ...(recoveryParent
      ? {
          [recoveryParent.failureInstanceId]: {
            ...recoveryParent,
            status: 'exhausted' as const,
            resolution: 'terminal' as const,
          },
        }
      : {}),
    [id]: failure,
  };
  const compacted = compactRecoveryFailuresV1(failures, [...journal.order, id]);
  const order = compacted.order;
  const sameNoProgress = order
    .map((entryId) => compacted.failures[entryId])
    .filter(
      (entry) =>
        entry?.status === 'unresolved' &&
        entry.taskId === input.taskId &&
        entry.turnId === input.turnId &&
        entry.invocationFingerprint === input.invocationFingerprint &&
        entry.progressRevision === journal.progressRevision,
    ).length;
  const existingQualityApplies =
    (journal.qualityGuard.taskId == null || journal.qualityGuard.taskId === input.taskId) &&
    (journal.qualityGuard.turnId == null || journal.qualityGuard.turnId === input.turnId);
  const nextObservedFailures = Math.min(
    TOOL_RECOVERY_OBSERVATION_CAP,
    (existingQualityApplies ? journal.qualityGuard.observedFailures : 0) +
      (failure.status === 'unresolved' ? 1 : 0),
  );
  const blocked =
    (existingQualityApplies && journal.qualityGuard.blocked) ||
    sameNoProgress >= TOOL_RECOVERY_QUALITY_FAILURE_LIMIT ||
    nextObservedFailures >= TOOL_RECOVERY_QUALITY_GLOBAL_FAILURE_LIMIT;
  return {
    ...journal,
    failures: compacted.failures,
    order,
    qualityGuard: qualityGuardAfterMutationV1(journal, {
      blocked,
      ...(blocked ? { reasonCode: 'no_progress' as const } : {}),
      ...(blocked && input.taskId ? { taskId: input.taskId } : {}),
      ...(blocked && input.turnId ? { turnId: input.turnId } : {}),
      observedFailures: nextObservedFailures,
    }),
  };
}

function candidateFailure(
  journal: ToolRecoveryJournalV1,
  input: {
    toolName: string;
    invocationFingerprint: string;
    modelMessageId: string;
    mode: ToolRecoveryAttemptModeV1;
    taskId?: string;
    turnId?: string;
  },
): ToolRecoveryFailureV1 | undefined {
  const reversed = blockingFailures(journal).reverse();
  if (input.mode === 'automatic_retry') {
    return reversed.find(
      (failure) =>
        failure.invocationFingerprint === input.invocationFingerprint &&
        failure.taskId === input.taskId &&
        failure.turnId === input.turnId,
    );
  }
  return reversed.find((failure) => {
    if (
      failure.taskId !== input.taskId ||
      failure.turnId !== input.turnId ||
      failure.modelMessageId === input.modelMessageId
    ) {
      return false;
    }
    if (failure.outcome.recovery.disposition === 'alternative') {
      return (
        failure.eligibleModelMessageId == null ||
        failure.eligibleModelMessageId === input.modelMessageId
      );
    }
    if (failure.toolName !== input.toolName) return false;
    return failure.outcome.recovery.disposition === 'correct_args'
      ? true
      : failure.invocationFingerprint === input.invocationFingerprint;
  });
}

export type RecoveryAdmissionV1 =
  | { admitted: true; recoveryOf?: string }
  | {
      admitted: false;
      recoveryOf?: string;
      detailCode: 'recovery_not_allowed' | 'recovery_exhausted' | 'no_progress';
    };

export function admitRecoveryAttemptV1(
  journal: ToolRecoveryJournalV1,
  input: {
    toolCallId: string;
    toolName: string;
    invocationFingerprint: string;
    modelMessageId: string;
    mode: ToolRecoveryAttemptModeV1;
    taskId?: string;
    turnId?: string;
  },
): RecoveryAdmissionV1 {
  // Corrupt recovery state is a session-wide hard block. Its recorded task/turn
  // scope is diagnostic provenance, not an admission escape hatch.
  if (journalInvalidQualityGuardV1(journal)) {
    return { admitted: false, detailCode: 'no_progress' };
  }
  const escapeTool = ['write_plan', 'update_plan', 'read_plan', 'ask_user', 'tool_search'].includes(
    input.toolName,
  );
  const qualityApplies =
    journal.qualityGuard.blocked &&
    (journal.qualityGuard.taskId == null || journal.qualityGuard.taskId === input.taskId) &&
    (journal.qualityGuard.turnId == null || journal.qualityGuard.turnId === input.turnId);
  if (qualityApplies && !escapeTool) return { admitted: false, detailCode: 'no_progress' };
  const failure = candidateFailure(journal, input);
  if (!failure) return { admitted: true };
  const recovery = failure.outcome.recovery;
  if (
    input.mode === 'model_correction' &&
    failure.eligibleModelMessageId != null &&
    failure.eligibleModelMessageId !== input.modelMessageId
  ) {
    return { admitted: true };
  }
  const allowedDisposition =
    input.mode === 'model_correction'
      ? recovery.disposition === 'correct_args' || recovery.disposition === 'alternative'
      : recovery.disposition === 'retry_once' && recovery.safeAutomaticRetry;
  if (!allowedDisposition || recovery.maximumAdditionalCalls === 0) {
    return {
      admitted: false,
      recoveryOf: failure.failureInstanceId,
      detailCode: 'recovery_not_allowed',
    };
  }
  const attempts =
    input.mode === 'model_correction'
      ? failure.modelCorrectionAttempts
      : failure.automaticRetryAttempts;
  if (attempts >= recovery.maximumAdditionalCalls) {
    return {
      admitted: false,
      recoveryOf: failure.failureInstanceId,
      detailCode: 'recovery_exhausted',
    };
  }
  return { admitted: true, recoveryOf: failure.failureInstanceId };
}

export function recordRecoveryInvocationV1(
  journal: ToolRecoveryJournalV1,
  input: { toolCallId: string; recoveryOf: string; mode: ToolRecoveryAttemptModeV1 },
): ToolRecoveryJournalV1 {
  const failure = journal.failures[input.recoveryOf];
  if (failure?.status !== 'unresolved') return journal;
  return {
    ...journal,
    failures: {
      ...journal.failures,
      [input.recoveryOf]: {
        ...failure,
        ...(input.mode === 'model_correction'
          ? { modelCorrectionAttempts: failure.modelCorrectionAttempts + 1 }
          : { automaticRetryAttempts: failure.automaticRetryAttempts + 1 }),
      },
    },
  };
}

export function recordToolOwnedProgressV1(
  journal: ToolRecoveryJournalV1,
  progress: ToolOwnedProgressV1,
): ToolRecoveryJournalV1 {
  if (!progress.referenceId) return journal;
  const progressRevision = journal.progressRevision + 1;
  const resolved = new Set(progress.resolvesFailureIds ?? []);
  const resolution: ToolRecoveryResolutionV1 =
    progress.kind === 'skipped'
      ? 'skipped'
      : progress.kind === 'replanned' || progress.kind === 'plan_revision'
        ? 'replanned'
        : progress.kind === 'user_action'
          ? 'user_action'
          : progress.kind === 'provider_revision' || progress.kind === 'capability_revision'
            ? 'provider_revision'
            : 'recovered';
  const failures = Object.fromEntries(
    Object.entries(journal.failures).map(([id, failure]) => [
      id,
      failure.status !== 'recovered' && resolved.has(id)
        ? { ...failure, status: 'recovered' as const, resolution }
        : failure,
    ]),
  );
  return {
    ...journal,
    failures,
    progressRevision,
    qualityGuard: qualityGuardAfterMutationV1(journal, {
      blocked: false,
      observedFailures: 0,
    }),
  };
}

export function hasUnresolvedToolFailuresV1(journal: ToolRecoveryJournalV1): boolean {
  return blockingFailures(journal).length > 0;
}

export function hasActiveUnresolvedToolFailuresV1(
  journal: ToolRecoveryJournalV1,
  scope: { taskId?: string | null; turnId?: string },
): boolean {
  return blockingFailures(journal).some(
    (failure) =>
      (scope.taskId == null || failure.taskId === scope.taskId) &&
      (scope.turnId == null || failure.turnId === scope.turnId),
  );
}

export function isToolRecoveryQualityBlockedV1(
  journal: ToolRecoveryJournalV1,
  scope: { taskId?: string | null; turnId?: string },
): boolean {
  // journal_invalid is an absorbing session-wide condition. Scope only limits
  // the ordinary no_progress guard so historical task ceilings do not leak.
  if (journalInvalidQualityGuardV1(journal)) return true;
  return (
    journal.qualityGuard.blocked &&
    (journal.qualityGuard.taskId == null || journal.qualityGuard.taskId === scope.taskId) &&
    (journal.qualityGuard.turnId == null || journal.qualityGuard.turnId === scope.turnId)
  );
}

function closeFailuresV1(
  journal: ToolRecoveryJournalV1,
  predicate: (failure: ToolRecoveryFailureV1) => boolean,
  resolution: ToolRecoveryResolutionV1,
): ToolRecoveryJournalV1 {
  let changed = false;
  const failures = Object.fromEntries(
    Object.entries(journal.failures).map(([id, failure]) => {
      if (failure.status === 'recovered' || !predicate(failure)) return [id, failure];
      changed = true;
      const explicitlyResolved = [
        'skipped',
        'replanned',
        'user_action',
        'provider_revision',
      ].includes(resolution);
      return [
        id,
        {
          ...failure,
          status: explicitlyResolved ? ('recovered' as const) : ('exhausted' as const),
          resolution,
        },
      ];
    }),
  );
  if (!changed) return journal;
  return {
    ...journal,
    failures,
    qualityGuard: qualityGuardAfterMutationV1(journal, {
      blocked: false,
      observedFailures: 0,
    }),
  };
}

/** Bind model-fixable failures to exactly the immediately following response. */
export function advanceToolRecoveryResponseV1(
  journal: ToolRecoveryJournalV1,
  input: {
    taskId?: string | null;
    turnId: string;
    modelMessageId: string;
    hasToolCalls: boolean;
    toolNames?: readonly string[];
  },
): ToolRecoveryJournalV1 {
  let next = journal;
  let changed = false;
  const failures = { ...journal.failures };
  for (const id of journal.order) {
    const failure = failures[id];
    if (
      !failure ||
      !failureStillBlocks(failure) ||
      failure.taskId !== (input.taskId ?? undefined) ||
      failure.turnId !== input.turnId ||
      failure.outcome.recovery.disposition === 'retry_once' ||
      failure.modelMessageId === input.modelMessageId
    ) {
      continue;
    }
    if (failure.eligibleModelMessageId == null) {
      const hasMatchingCorrection =
        failure.outcome.recovery.disposition === 'alternative'
          ? input.hasToolCalls
          : (input.toolNames?.includes(failure.toolName) ?? input.hasToolCalls);
      failures[id] = hasMatchingCorrection
        ? { ...failure, eligibleModelMessageId: input.modelMessageId }
        : {
            ...failure,
            eligibleModelMessageId: input.modelMessageId,
            status: 'exhausted',
            resolution: 'next_response_elapsed',
          };
      changed = true;
    } else if (failure.eligibleModelMessageId !== input.modelMessageId) {
      failures[id] = { ...failure, status: 'exhausted', resolution: 'next_response_elapsed' };
      changed = true;
    }
  }
  if (changed) next = { ...journal, failures };
  if (!input.hasToolCalls) {
    next = closeFailuresV1(
      next,
      (failure) =>
        failure.taskId === (input.taskId ?? undefined) &&
        failure.turnId === input.turnId &&
        failure.eligibleModelMessageId === input.modelMessageId,
      'next_response_elapsed',
    );
  }
  return next;
}

export function closeToolRecoveryScopeV1(
  journal: ToolRecoveryJournalV1,
  input:
    | { kind: 'task'; taskId: string }
    | { kind: 'turn'; turnId: string }
    | { kind: 'failure'; failureIds: string[]; resolution: ToolRecoveryResolutionV1 },
): ToolRecoveryJournalV1 {
  if (input.kind === 'task') {
    return closeFailuresV1(journal, (failure) => failure.taskId === input.taskId, 'task_closed');
  }
  if (input.kind === 'turn') {
    return closeFailuresV1(journal, (failure) => failure.turnId === input.turnId, 'turn_closed');
  }
  const ids = new Set(input.failureIds);
  return closeFailuresV1(
    journal,
    (failure) => ids.has(failure.failureInstanceId),
    input.resolution,
  );
}

/** Legacy exhaustion becomes a typed, scope-bound quality terminal instead of bypassing V1. */
export function recordRecoveryExhaustionV1(
  journal: ToolRecoveryJournalV1,
  input: Parameters<typeof recordRecoveryFailureV1>[1],
): ToolRecoveryJournalV1 {
  const next = recordRecoveryFailureV1(journal, input);
  if (journalInvalidQualityGuardV1(next)) return next;
  return {
    ...next,
    qualityGuard: {
      blocked: true,
      reasonCode: 'no_progress',
      observedFailures: Math.max(
        TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
        next.qualityGuard.observedFailures,
      ),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
  };
}

/** Merge a child journal into the canonical parent journal without exporting fingerprints. */
export function mergeToolRecoveryJournalsV1(
  parent: ToolRecoveryJournalV1,
  child: ToolRecoveryJournalV1,
  scope?: { taskId?: string; turnId?: string },
): ToolRecoveryJournalV1 {
  if (child.identityKey !== parent.identityKey) {
    return {
      ...parent,
      qualityGuard: {
        blocked: true,
        reasonCode: 'journal_invalid',
        observedFailures: Math.max(
          TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
          parent.qualityGuard.observedFailures,
        ),
        ...(scope?.taskId ? { taskId: scope.taskId } : {}),
        ...(scope?.turnId ? { turnId: scope.turnId } : {}),
      },
    };
  }
  const combinedOrder = [...parent.order, ...child.order.filter((id) => !parent.failures[id])];
  const combinedFailures = Object.fromEntries(
    combinedOrder.flatMap((id) => {
      const parentFailure = parent.failures[id];
      const childFailure = child.failures[id];
      const failure =
        parentFailure ??
        (childFailure
          ? {
              ...childFailure,
              ...(scope?.taskId ? { taskId: scope.taskId } : {}),
              ...(scope?.turnId ? { turnId: scope.turnId } : {}),
            }
          : undefined);
      return failure ? [[id, failure] as const] : [];
    }),
  );
  const compacted = compactRecoveryFailuresV1(combinedFailures, combinedOrder);
  return {
    schemaVersion: 1,
    identityKey: parent.identityKey,
    failures: compacted.failures,
    order: compacted.order,
    progressRevision: Math.max(parent.progressRevision, child.progressRevision),
    qualityGuard: {
      blocked: parent.qualityGuard.blocked || child.qualityGuard.blocked,
      ...(parent.qualityGuard.blocked || child.qualityGuard.blocked
        ? {
            reasonCode:
              parent.qualityGuard.reasonCode === 'journal_invalid' ||
              child.qualityGuard.reasonCode === 'journal_invalid'
                ? ('journal_invalid' as const)
                : ('no_progress' as const),
          }
        : {}),
      ...((parent.qualityGuard.taskId ?? scope?.taskId)
        ? { taskId: parent.qualityGuard.taskId ?? scope?.taskId }
        : {}),
      ...((parent.qualityGuard.turnId ?? scope?.turnId)
        ? { turnId: parent.qualityGuard.turnId ?? scope?.turnId }
        : {}),
      observedFailures: Math.min(
        TOOL_RECOVERY_OBSERVATION_CAP,
        parent.qualityGuard.observedFailures + child.qualityGuard.observedFailures,
      ),
    },
  };
}

export function normalizeToolRecoveryJournalV1(
  value: unknown,
  options: { allowMissingLegacy?: boolean } = {},
): ToolRecoveryJournalV1 {
  if (value == null) {
    return options.allowMissingLegacy ? createToolRecoveryJournalV1() : blockedRecoveryJournalV1();
  }
  if (typeof value !== 'object' || Array.isArray(value)) return blockedRecoveryJournalV1();
  const candidate = value as Partial<ToolRecoveryJournalV1>;
  const malformed = () => {
    const rawFailures =
      candidate.failures && typeof candidate.failures === 'object'
        ? Object.values(candidate.failures)
        : [];
    const uniqueScope = (key: 'taskId' | 'turnId'): string | undefined => {
      const values = new Set(
        rawFailures.flatMap((failure) => {
          if (!failure || typeof failure !== 'object') return [];
          const value = failure[key];
          return typeof value === 'string' ? [value] : [];
        }),
      );
      return values.size === 1 ? [...values][0] : undefined;
    };
    const taskId =
      typeof candidate.qualityGuard?.taskId === 'string'
        ? candidate.qualityGuard.taskId
        : uniqueScope('taskId');
    const turnId =
      typeof candidate.qualityGuard?.turnId === 'string'
        ? candidate.qualityGuard.turnId
        : uniqueScope('turnId');
    return blockedRecoveryJournalV1(
      typeof candidate.qualityGuard?.observedFailures === 'number'
        ? candidate.qualityGuard.observedFailures
        : 0,
      {
        ...(taskId ? { taskId } : {}),
        ...(turnId ? { turnId } : {}),
      },
    );
  };
  const topKeys = Object.keys(candidate);
  const qualityKeys =
    candidate.qualityGuard && typeof candidate.qualityGuard === 'object'
      ? Object.keys(candidate.qualityGuard)
      : [];
  if (
    topKeys.some(
      (key) =>
        ![
          'schemaVersion',
          'identityKey',
          'failures',
          'order',
          'progressRevision',
          'qualityGuard',
        ].includes(key),
    ) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.identityKey !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.identityKey) ||
    !candidate.failures ||
    typeof candidate.failures !== 'object' ||
    !Array.isArray(candidate.order) ||
    !candidate.qualityGuard ||
    qualityKeys.some(
      (key) => !['blocked', 'reasonCode', 'observedFailures', 'taskId', 'turnId'].includes(key),
    ) ||
    typeof candidate.progressRevision !== 'number' ||
    !Number.isSafeInteger(candidate.progressRevision) ||
    candidate.progressRevision < 0 ||
    typeof candidate.qualityGuard.blocked !== 'boolean' ||
    !Number.isSafeInteger(candidate.qualityGuard.observedFailures) ||
    candidate.qualityGuard.observedFailures < 0 ||
    candidate.qualityGuard.observedFailures > TOOL_RECOVERY_OBSERVATION_CAP ||
    (candidate.qualityGuard.blocked
      ? !['no_progress', 'journal_invalid'].includes(String(candidate.qualityGuard.reasonCode))
      : candidate.qualityGuard.reasonCode != null ||
        candidate.qualityGuard.taskId != null ||
        candidate.qualityGuard.turnId != null) ||
    (candidate.qualityGuard.taskId != null && typeof candidate.qualityGuard.taskId !== 'string') ||
    (candidate.qualityGuard.turnId != null && typeof candidate.qualityGuard.turnId !== 'string')
  ) {
    return malformed();
  }
  const order = candidate.order;
  if (
    order.length > 128 ||
    new Set(order).size !== order.length ||
    order.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) ||
    Object.keys(candidate.failures).some((id) => !order.includes(id))
  ) {
    return malformed();
  }
  const failures: Record<string, ToolRecoveryFailureV1> = {};
  for (const id of order) {
    const failure = candidate.failures[id];
    const failureKeys = failure ? Object.keys(failure) : [];
    if (
      !failure ||
      failureKeys.some(
        (key) =>
          ![
            'failureInstanceId',
            'toolCallId',
            'toolName',
            'invocationFingerprint',
            'modelMessageId',
            'taskId',
            'turnId',
            'eligibleAfterModelMessageId',
            'eligibleModelMessageId',
            'status',
            'resolution',
            'outcome',
            'modelCorrectionAttempts',
            'automaticRetryAttempts',
            'progressRevision',
          ].includes(key),
      ) ||
      failure.failureInstanceId !== id ||
      typeof failure.toolCallId !== 'string' ||
      typeof failure.toolName !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(failure.invocationFingerprint) ||
      typeof failure.modelMessageId !== 'string' ||
      (failure.taskId != null && typeof failure.taskId !== 'string') ||
      (failure.turnId != null && typeof failure.turnId !== 'string') ||
      (failure.eligibleAfterModelMessageId != null &&
        typeof failure.eligibleAfterModelMessageId !== 'string') ||
      (failure.eligibleModelMessageId != null &&
        typeof failure.eligibleModelMessageId !== 'string') ||
      !['unresolved', 'recovered', 'exhausted'].includes(failure.status) ||
      (failure.resolution != null &&
        ![
          'recovered',
          'terminal',
          'next_response_elapsed',
          'task_closed',
          'turn_closed',
          'skipped',
          'replanned',
          'user_action',
          'provider_revision',
        ].includes(failure.resolution)) ||
      !isToolOutcomeV1(failure.outcome) ||
      toolFailureInstanceIdV1({
        toolCallId: failure.toolCallId,
        invocationFingerprint: failure.invocationFingerprint,
        outcome: failure.outcome,
      }) !== id ||
      (failure.status === 'unresolved' &&
        (failure.resolution != null || failure.outcome.recovery.disposition === 'never')) ||
      (failure.status === 'recovered' &&
        !['recovered', 'skipped', 'replanned', 'user_action', 'provider_revision'].includes(
          String(failure.resolution),
        )) ||
      (failure.status === 'exhausted' &&
        !['terminal', 'next_response_elapsed', 'task_closed', 'turn_closed'].includes(
          String(failure.resolution),
        )) ||
      failure.outcome.lineage?.failureInstanceId !== id ||
      !Number.isInteger(failure.modelCorrectionAttempts) ||
      failure.modelCorrectionAttempts < 0 ||
      failure.modelCorrectionAttempts > 1 ||
      !Number.isInteger(failure.automaticRetryAttempts) ||
      failure.automaticRetryAttempts < 0 ||
      failure.automaticRetryAttempts > 1 ||
      !Number.isInteger(failure.progressRevision) ||
      failure.progressRevision < 0 ||
      failure.progressRevision > candidate.progressRevision
    ) {
      return malformed();
    }
    failures[id] =
      failure.turnId == null
        ? { ...failure, status: 'exhausted', resolution: 'terminal' }
        : failure;
  }
  for (const [index, id] of order.entries()) {
    const failure = failures[id]!;
    const recoveryOf = failure.outcome.lineage?.recoveryOf;
    if (recoveryOf == null) continue;
    const parentIndex = order.indexOf(recoveryOf);
    const parent = failures[recoveryOf];
    if (
      recoveryOf === id ||
      !parent ||
      parentIndex < 0 ||
      parentIndex >= index ||
      parent.progressRevision > failure.progressRevision ||
      parent.modelCorrectionAttempts > failure.modelCorrectionAttempts ||
      parent.automaticRetryAttempts > failure.automaticRetryAttempts ||
      failure.modelCorrectionAttempts - parent.modelCorrectionAttempts > 1 ||
      failure.automaticRetryAttempts - parent.automaticRetryAttempts > 1
    ) {
      return malformed();
    }
  }
  const observedFailures = Math.min(
    TOOL_RECOVERY_OBSERVATION_CAP,
    Math.floor(candidate.qualityGuard.observedFailures),
  );
  const sameIdentityWithoutProgress = Object.values(failures).reduce<Record<string, number>>(
    (counts, failure) => {
      if (failure.status !== 'unresolved') return counts;
      const identity = `${failure.invocationFingerprint}:${failure.progressRevision}`;
      counts[identity] = (counts[identity] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const blocked =
    candidate.qualityGuard.blocked ||
    observedFailures >= TOOL_RECOVERY_QUALITY_GLOBAL_FAILURE_LIMIT ||
    Object.values(sameIdentityWithoutProgress).some(
      (count) => count >= TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
    );
  return {
    schemaVersion: 1,
    identityKey: candidate.identityKey,
    failures,
    order,
    progressRevision: Math.max(0, Math.floor(candidate.progressRevision)),
    qualityGuard: {
      blocked,
      ...(blocked
        ? {
            reasonCode:
              candidate.qualityGuard.reasonCode === 'journal_invalid'
                ? ('journal_invalid' as const)
                : ('no_progress' as const),
          }
        : {}),
      observedFailures,
      ...(candidate.qualityGuard.taskId ? { taskId: candidate.qualityGuard.taskId } : {}),
      ...(candidate.qualityGuard.turnId ? { turnId: candidate.qualityGuard.turnId } : {}),
    },
  };
}
