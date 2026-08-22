import { sha256Hex, sha256HexBytes } from './hash';
import type { ToolOutcomeV1 } from './normalization';
import { isToolOutcomeV1 } from './normalization';

export type { ToolOutcomeStatusV1, ToolOutcomeV1 } from './normalization';

export const TOOL_RECOVERY_JOURNAL_SCHEMA_VERSION = 1 as const;
export const TOOL_RECOVERY_QUALITY_FAILURE_LIMIT = 6;
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
  readonly failureInstanceId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invocationFingerprint: string;
  readonly modelMessageId: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly eligibleAfterModelMessageId?: string;
  readonly eligibleModelMessageId?: string;
  readonly eligibleToolCallId?: string;
  readonly status: 'unresolved' | 'recovered' | 'exhausted';
  readonly resolution?: ToolRecoveryResolutionV1;
  readonly outcome: ToolOutcomeV1;
  readonly modelCorrectionAttempts: number;
  readonly automaticRetryAttempts: number;
  readonly progressRevision: number;
}
export interface ToolRecoveryJournalV1 {
  readonly schemaVersion: 1;
  readonly identityKey: string;
  readonly failures: Readonly<Record<string, ToolRecoveryFailureV1>>;
  readonly order: readonly string[];
  readonly progressRevision: number;
  readonly qualityGuard: {
    readonly blocked: boolean;
    readonly reasonCode?: 'no_progress' | 'journal_invalid';
    readonly observedFailures: number;
    readonly taskId?: string;
    readonly turnId?: string;
  };
}
export interface ToolOwnedProgressV1 {
  readonly kind:
    | 'content_revision'
    | 'plan_revision'
    | 'capability_revision'
    | 'provider_revision'
    | 'receipt'
    | 'skipped'
    | 'replanned'
    | 'user_action';
  readonly referenceId: string;
  readonly resolvesFailureIds?: readonly string[];
}
export type RecoveryAdmissionV1 =
  | { readonly admitted: true; readonly recoveryOf?: string }
  | {
      readonly admitted: false;
      readonly recoveryOf?: string;
      readonly detailCode: 'recovery_not_allowed' | 'recovery_exhausted' | 'no_progress';
    };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Recovery fact is not JSON serializable.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function stringValue(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  return typeof value?.[key] === 'string' ? (value[key] as string) : undefined;
}
function isCanonicalRecoveryIdentityKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function assertCanonicalRecoveryIdentityKey(value: unknown): asserts value is string {
  if (value === undefined || value === null) {
    throw new Error('Malformed recovery journal requires the Host-supplied identityKey.');
  }
  if (!isCanonicalRecoveryIdentityKey(value)) {
    throw new Error('Tool recovery identityKey must be a canonical host-supplied key.');
  }
}
function numberValue(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  return typeof value?.[key] === 'number' ? (value[key] as number) : undefined;
}
function failureStillBlocks(failure: ToolRecoveryFailureV1): boolean {
  return (
    failure.status !== 'recovered' &&
    failure.resolution !== 'task_closed' &&
    failure.resolution !== 'turn_closed'
  );
}
function blockedFailures(journal: ToolRecoveryJournalV1): ToolRecoveryFailureV1[] {
  return journal.order
    .map((id) => journal.failures[id])
    .filter(
      (failure): failure is ToolRecoveryFailureV1 => failure != null && failureStillBlocks(failure),
    );
}
function canonicalFailureDetail(outcome: ToolOutcomeV1): string {
  return outcome.failure?.detailCode ?? 'success';
}

/** Exact State26 failure identity; the private fingerprint is never projected. */
export function toolFailureInstanceIdV1(input: {
  readonly toolCallId: string;
  readonly invocationFingerprint: string;
  readonly outcome: ToolOutcomeV1;
}): string {
  return sha256Hex(
    stableStringify({
      toolCallId: input.toolCallId,
      invocationFingerprint: input.invocationFingerprint,
      status: input.outcome.status,
      detailCode: canonicalFailureDetail(input.outcome),
    }),
  );
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const scalar = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        bytes.push(
          0xf0 | (scalar >>> 18),
          0x80 | ((scalar >>> 12) & 0x3f),
          0x80 | ((scalar >>> 6) & 0x3f),
          0x80 | (scalar & 0x3f),
        );
        index += 1;
      } else bytes.push(0xef, 0xbf, 0xbd);
    } else if (code >= 0xdc00) bytes.push(0xef, 0xbf, 0xbd);
    else bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}
function hexBytes(value: string): number[] {
  return value.match(/[a-f0-9]{2}/gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
}
function hmacSha256Hex(key: string, text: string): string {
  let keyBytes = utf8Bytes(key);
  if (keyBytes.length > 64) keyBytes = hexBytes(sha256HexBytes(keyBytes));
  const padded = [...keyBytes, ...new Array<number>(64 - keyBytes.length).fill(0)];
  const inner = padded.map((byte) => byte ^ 0x36);
  const outer = padded.map((byte) => byte ^ 0x5c);
  return sha256HexBytes([...outer, ...hexBytes(sha256HexBytes([...inner, ...utf8Bytes(text)]))]);
}

export function toolInvocationFingerprintV1(input: {
  readonly key: string;
  readonly toolName: string;
  readonly parsedArgs?: unknown;
  readonly parseCode?: 'invalid_json' | 'invalid_arguments' | 'unknown_tool' | 'tool_unavailable';
  readonly pathCategory?: 'root' | 'nested' | 'none' | 'unknown';
  readonly unparsedArgs?: unknown;
  readonly identityRevision?: string;
}): string {
  const material = input.parseCode
    ? stableStringify({
        toolName: input.toolName,
        parseCode: input.parseCode,
        pathCategory: input.pathCategory ?? 'unknown',
        opaqueArgs: input.unparsedArgs,
        identityRevision: input.identityRevision ?? 'unknown',
      })
    : stableStringify({
        toolName: input.toolName,
        parsedArgs: input.parsedArgs,
        identityRevision: input.identityRevision ?? 'unknown',
      });
  return hmacSha256Hex(input.key, material);
}

function rootFailureId(
  failures: Readonly<Record<string, ToolRecoveryFailureV1>>,
  failure: ToolRecoveryFailureV1,
): string {
  let current = failure;
  const visited = new Set<string>();
  while (current.outcome.lineage?.recoveryOf && !visited.has(current.failureInstanceId)) {
    visited.add(current.failureInstanceId);
    const parent = failures[current.outcome.lineage.recoveryOf];
    if (!parent) break;
    current = parent;
  }
  return current.failureInstanceId;
}
function noProgressKey(
  failures: Readonly<Record<string, ToolRecoveryFailureV1>>,
  failure: ToolRecoveryFailureV1,
): string {
  return [
    failure.taskId ?? '',
    failure.turnId ?? '',
    rootFailureId(failures, failure),
    failure.toolName,
    String(failure.progressRevision),
  ].join('\0');
}
function journalInvalid(journal: ToolRecoveryJournalV1): boolean {
  return journal.qualityGuard.blocked && journal.qualityGuard.reasonCode === 'journal_invalid';
}
/** A corrupt recovery journal is a session-wide correctness block. */
export function isToolRecoveryJournalInvalidV1(journal: ToolRecoveryJournalV1): boolean {
  return journalInvalid(journal);
}
function qualityAfterMutation(
  journal: ToolRecoveryJournalV1,
  proposed: ToolRecoveryJournalV1['qualityGuard'],
): ToolRecoveryJournalV1['qualityGuard'] {
  return journalInvalid(journal) ? journal.qualityGuard : proposed;
}

function compactFailures(
  failures: Readonly<Record<string, ToolRecoveryFailureV1>>,
  inputOrder: readonly string[],
): { failures: Record<string, ToolRecoveryFailureV1>; order: string[] } {
  const order = [...new Set(inputOrder)].filter((id) => failures[id] != null);
  if (order.length <= 128) return { failures: { ...failures }, order };
  const prioritized = [
    ...[...order].reverse().filter((id) => failureStillBlocks(failures[id]!)),
    ...[...order].reverse().filter((id) => !failureStillBlocks(failures[id]!)),
  ];
  const retained = new Set<string>();
  for (const candidate of prioritized) {
    if (retained.has(candidate)) continue;
    const closure: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = candidate;
    while (current && !seen.has(current)) {
      const failure: ToolRecoveryFailureV1 | undefined = failures[current];
      if (!failure) break;
      seen.add(current);
      closure.push(current);
      current = failure.outcome.lineage?.recoveryOf;
    }
    if (retained.size + closure.filter((id) => !retained.has(id)).length > 128) continue;
    for (const id of closure) retained.add(id);
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
    readonly toolCallId: string;
    readonly toolName: string;
    readonly invocationFingerprint: string;
    readonly modelMessageId: string;
    readonly outcome: ToolOutcomeV1;
    readonly taskId?: string;
    readonly turnId?: string;
  },
): ToolRecoveryJournalV1 {
  if (input.outcome.status === 'success') return journal;
  const id = toolFailureInstanceIdV1(input);
  if (journal.failures[id]) return journal;
  const parent = input.outcome.lineage?.recoveryOf
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
    ...(input.outcome.recovery.disposition === 'never' ? { resolution: 'terminal' } : {}),
    outcome: { ...input.outcome, lineage: { ...input.outcome.lineage, failureInstanceId: id } },
    modelCorrectionAttempts: parent?.modelCorrectionAttempts ?? 0,
    automaticRetryAttempts: parent?.automaticRetryAttempts ?? 0,
    progressRevision: journal.progressRevision,
  };
  const failures: Record<string, ToolRecoveryFailureV1> = {
    ...journal.failures,
    ...(parent
      ? { [parent.failureInstanceId]: { ...parent, status: 'exhausted', resolution: 'terminal' } }
      : {}),
    [id]: failure,
  };
  const compacted = compactFailures(failures, [...journal.order, id]);
  const sameNoProgress = compacted.order
    .map((entry) => compacted.failures[entry])
    .filter(
      (entry): entry is ToolRecoveryFailureV1 =>
        entry != null &&
        failureStillBlocks(entry) &&
        noProgressKey(compacted.failures, entry) === noProgressKey(compacted.failures, failure),
    ).length;
  const scopeApplies =
    (journal.qualityGuard.taskId == null || journal.qualityGuard.taskId === input.taskId) &&
    (journal.qualityGuard.turnId == null || journal.qualityGuard.turnId === input.turnId);
  const observedFailures = Math.min(
    TOOL_RECOVERY_OBSERVATION_CAP,
    (scopeApplies ? journal.qualityGuard.observedFailures : 0) + 1,
  );
  const blocked =
    (scopeApplies && journal.qualityGuard.blocked) ||
    sameNoProgress >= TOOL_RECOVERY_QUALITY_FAILURE_LIMIT;
  return {
    ...journal,
    failures: compacted.failures,
    order: compacted.order,
    qualityGuard: qualityAfterMutation(journal, {
      blocked,
      ...(blocked ? { reasonCode: 'no_progress' } : {}),
      ...(blocked && input.taskId ? { taskId: input.taskId } : {}),
      ...(blocked && input.turnId ? { turnId: input.turnId } : {}),
      observedFailures,
    }),
  };
}

function alternativeMatches(intent: string | undefined, toolName: string): boolean {
  return intent === 'workspace.search'
    ? toolName === 'search_files'
    : intent === 'git_inspect'
      ? toolName === 'git_inspect'
      : false;
}
function candidateFailure(
  journal: ToolRecoveryJournalV1,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly invocationFingerprint: string;
    readonly modelMessageId: string;
    readonly mode: ToolRecoveryAttemptModeV1;
    readonly taskId?: string;
    readonly turnId?: string;
  },
): ToolRecoveryFailureV1 | undefined {
  const candidates = blockedFailures(journal).reverse();
  if (input.mode === 'automatic_retry')
    return candidates.find(
      (failure) =>
        failure.invocationFingerprint === input.invocationFingerprint &&
        failure.taskId === input.taskId &&
        failure.turnId === input.turnId,
    );
  return candidates.find(
    (failure) =>
      failure.taskId === input.taskId &&
      failure.turnId === input.turnId &&
      failure.modelMessageId !== input.modelMessageId &&
      failure.eligibleToolCallId === input.toolCallId &&
      (failure.outcome.recovery.disposition === 'alternative'
        ? alternativeMatches(failure.outcome.recovery.capabilityIntent, input.toolName) &&
          (failure.eligibleModelMessageId == null ||
            failure.eligibleModelMessageId === input.modelMessageId)
        : failure.toolName === input.toolName &&
          (failure.outcome.recovery.disposition === 'correct_args' ||
            (failure.outcome.status === 'exhausted' &&
              ['recovery_not_allowed', 'recovery_exhausted', 'no_progress'].includes(
                failure.outcome.failure?.detailCode ?? '',
              )) ||
            failure.invocationFingerprint === input.invocationFingerprint)),
  );
}

export function admitRecoveryAttemptV1(
  journal: ToolRecoveryJournalV1,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly invocationFingerprint: string;
    readonly modelMessageId: string;
    readonly mode: ToolRecoveryAttemptModeV1;
    readonly taskId?: string;
    readonly turnId?: string;
  },
): RecoveryAdmissionV1 {
  if (journalInvalid(journal)) return { admitted: false, detailCode: 'no_progress' };
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
  if (
    input.mode === 'model_correction' &&
    failure.eligibleModelMessageId != null &&
    failure.eligibleModelMessageId !== input.modelMessageId
  )
    return { admitted: true };
  const recovery = failure.outcome.recovery;
  const allowed =
    input.mode === 'model_correction'
      ? recovery.disposition === 'correct_args' || recovery.disposition === 'alternative'
      : recovery.disposition === 'retry_once' && recovery.safeAutomaticRetry;
  if (!allowed || recovery.maximumAdditionalCalls === 0)
    return {
      admitted: false,
      recoveryOf: failure.failureInstanceId,
      detailCode: 'recovery_not_allowed',
    };
  const attempts =
    input.mode === 'model_correction'
      ? failure.modelCorrectionAttempts
      : failure.automaticRetryAttempts;
  if (attempts >= recovery.maximumAdditionalCalls)
    return {
      admitted: false,
      recoveryOf: failure.failureInstanceId,
      detailCode: 'recovery_exhausted',
    };
  return { admitted: true, recoveryOf: failure.failureInstanceId };
}

export function recordRecoveryInvocationV1(
  journal: ToolRecoveryJournalV1,
  input: {
    readonly toolCallId: string;
    readonly recoveryOf: string;
    readonly mode: ToolRecoveryAttemptModeV1;
  },
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
  const resolved = new Set(
    (progress.resolvesFailureIds ?? []).filter(
      (id) => journal.failures[id] != null && failureStillBlocks(journal.failures[id]!),
    ),
  );
  if (resolved.size === 0) return journal;
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
  return {
    ...journal,
    failures: Object.fromEntries(
      Object.entries(journal.failures).map(([id, failure]) => [
        id,
        failure.status !== 'recovered' && resolved.has(id)
          ? { ...failure, status: 'recovered', resolution }
          : failure,
      ]),
    ),
    progressRevision: journal.progressRevision + 1,
    qualityGuard: qualityAfterMutation(journal, { blocked: false, observedFailures: 0 }),
  };
}
export function hasUnresolvedToolFailuresV1(journal: ToolRecoveryJournalV1): boolean {
  return blockedFailures(journal).length > 0;
}
export function hasActiveUnresolvedToolFailuresV1(
  journal: ToolRecoveryJournalV1,
  scope: { readonly taskId?: string | null; readonly turnId?: string },
): boolean {
  return blockedFailures(journal).some(
    (failure) =>
      (scope.taskId == null || failure.taskId === scope.taskId) &&
      (scope.turnId == null || failure.turnId === scope.turnId),
  );
}
export function isToolRecoveryQualityBlockedV1(
  journal: ToolRecoveryJournalV1,
  scope: { readonly taskId?: string | null; readonly turnId?: string },
): boolean {
  return (
    journalInvalid(journal) ||
    (journal.qualityGuard.blocked &&
      (journal.qualityGuard.taskId == null || journal.qualityGuard.taskId === scope.taskId) &&
      (journal.qualityGuard.turnId == null || journal.qualityGuard.turnId === scope.turnId))
  );
}
function closeFailures(
  journal: ToolRecoveryJournalV1,
  predicate: (failure: ToolRecoveryFailureV1) => boolean,
  resolution: ToolRecoveryResolutionV1,
): ToolRecoveryJournalV1 {
  let changed = false;
  const failures = Object.fromEntries(
    Object.entries(journal.failures).map(([id, failure]) => {
      if (failure.status === 'recovered' || !predicate(failure)) return [id, failure];
      changed = true;
      const recover = ['skipped', 'replanned', 'user_action', 'provider_revision'].includes(
        resolution,
      );
      return [id, { ...failure, status: recover ? 'recovered' : 'exhausted', resolution }];
    }),
  );
  return changed
    ? {
        ...journal,
        failures,
        qualityGuard: qualityAfterMutation(journal, { blocked: false, observedFailures: 0 }),
      }
    : journal;
}
export function closeToolRecoveryScopeV1(
  journal: ToolRecoveryJournalV1,
  input:
    | { readonly kind: 'task'; readonly taskId: string }
    | { readonly kind: 'turn'; readonly turnId: string }
    | {
        readonly kind: 'failure';
        readonly failureIds: readonly string[];
        readonly resolution: ToolRecoveryResolutionV1;
      },
): ToolRecoveryJournalV1 {
  return input.kind === 'task'
    ? closeFailures(journal, (failure) => failure.taskId === input.taskId, 'task_closed')
    : input.kind === 'turn'
      ? closeFailures(journal, (failure) => failure.turnId === input.turnId, 'turn_closed')
      : closeFailures(
          journal,
          (failure) => input.failureIds.includes(failure.failureInstanceId),
          input.resolution,
        );
}

/** Bind model-fixable failures to exactly the immediately following response. */
export function advanceToolRecoveryResponseV1(
  journal: ToolRecoveryJournalV1,
  input: {
    readonly taskId?: string | null;
    readonly turnId?: string;
    readonly modelMessageId: string;
    readonly toolCalls: readonly { readonly id: string; readonly name: string }[];
  },
): ToolRecoveryJournalV1 {
  let changed = false;
  const failures = { ...journal.failures };
  const claimed = new Set(
    Object.values(failures)
      .filter((failure) => failure.eligibleModelMessageId === input.modelMessageId)
      .flatMap((failure) => (failure.eligibleToolCallId ? [failure.eligibleToolCallId] : [])),
  );
  for (const id of journal.order) {
    const failure = failures[id];
    if (
      !failure ||
      !failureStillBlocks(failure) ||
      failure.taskId !== (input.taskId ?? undefined) ||
      failure.turnId !== input.turnId ||
      failure.outcome.recovery.disposition === 'retry_once' ||
      failure.modelMessageId === input.modelMessageId
    )
      continue;
    if (
      failure.eligibleModelMessageId == null ||
      (failure.eligibleModelMessageId === input.modelMessageId &&
        failure.eligibleToolCallId == null)
    ) {
      const match = input.toolCalls.find(
        (toolCall) =>
          !claimed.has(toolCall.id) &&
          (failure.outcome.recovery.disposition === 'alternative'
            ? alternativeMatches(failure.outcome.recovery.capabilityIntent, toolCall.name)
            : failure.toolName === toolCall.name),
      );
      if (match) claimed.add(match.id);
      failures[id] = match
        ? { ...failure, eligibleModelMessageId: input.modelMessageId, eligibleToolCallId: match.id }
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
  return changed ? { ...journal, failures } : journal;
}

/** Legacy exhaustion is a typed, scope-bound quality terminal. */
export function recordRecoveryExhaustionV1(
  journal: ToolRecoveryJournalV1,
  input: Parameters<typeof recordRecoveryFailureV1>[1],
): ToolRecoveryJournalV1 {
  const next = recordRecoveryFailureV1(journal, input);
  if (journalInvalid(next)) return next;
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

/** Merge a child journal into the canonical parent while preserving identity and closure. */
export function mergeToolRecoveryJournalsV1(
  parent: ToolRecoveryJournalV1,
  child: ToolRecoveryJournalV1,
  hostIdentityKey: string,
  scope?: { readonly taskId?: string; readonly turnId?: string },
): ToolRecoveryJournalV1 {
  assertCanonicalRecoveryIdentityKey(hostIdentityKey);
  const normalized = normalizeToolRecoveryJournalV1(child, hostIdentityKey);
  if (
    journalInvalid(normalized) ||
    hostIdentityKey !== parent.identityKey ||
    normalized.identityKey !== parent.identityKey
  ) {
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
  const combinedOrder = [...parent.order, ...normalized.order.filter((id) => !parent.failures[id])];
  const combinedFailures: Record<string, ToolRecoveryFailureV1> = {};
  for (const id of combinedOrder) {
    const failure = parent.failures[id] ?? normalized.failures[id];
    if (failure)
      combinedFailures[id] = parent.failures[id]
        ? failure
        : {
            ...failure,
            ...(scope?.taskId ? { taskId: scope.taskId } : {}),
            ...(scope?.turnId ? { turnId: scope.turnId } : {}),
          };
  }
  const compacted = compactFailures(combinedFailures, combinedOrder);
  const qualityBlocked = parent.qualityGuard.blocked || normalized.qualityGuard.blocked;
  const invalidReason =
    parent.qualityGuard.reasonCode === 'journal_invalid' ||
    normalized.qualityGuard.reasonCode === 'journal_invalid';
  return {
    schemaVersion: 1,
    identityKey: parent.identityKey,
    failures: compacted.failures,
    order: compacted.order,
    progressRevision: Math.max(parent.progressRevision, normalized.progressRevision),
    qualityGuard: {
      blocked: qualityBlocked,
      ...(qualityBlocked ? { reasonCode: invalidReason ? 'journal_invalid' : 'no_progress' } : {}),
      observedFailures: Math.min(
        TOOL_RECOVERY_OBSERVATION_CAP,
        parent.qualityGuard.observedFailures + normalized.qualityGuard.observedFailures,
      ),
      ...(qualityBlocked && (parent.qualityGuard.taskId ?? scope?.taskId)
        ? { taskId: parent.qualityGuard.taskId ?? scope?.taskId }
        : {}),
      ...(qualityBlocked && (parent.qualityGuard.turnId ?? scope?.turnId)
        ? { turnId: parent.qualityGuard.turnId ?? scope?.turnId }
        : {}),
    },
  };
}

export function normalizeToolRecoveryJournalV1(
  value: unknown,
  hostIdentityKey: string,
): ToolRecoveryJournalV1 {
  assertCanonicalRecoveryIdentityKey(hostIdentityKey);
  const candidate = record(value);
  const identityKey = hostIdentityKey;
  const blocked = (
    observedFailures = 0,
    scope?: { taskId?: string; turnId?: string },
  ): ToolRecoveryJournalV1 => ({
    schemaVersion: 1,
    identityKey,
    failures: {},
    order: [],
    progressRevision: 0,
    qualityGuard: {
      blocked: true,
      reasonCode: 'journal_invalid',
      observedFailures: Math.max(0, Math.min(250, Math.floor(observedFailures))),
      ...(scope?.taskId ? { taskId: scope.taskId } : {}),
      ...(scope?.turnId ? { turnId: scope.turnId } : {}),
    },
  });
  const topKeys = candidate == null ? [] : Object.keys(candidate);
  const qualityCandidate = record(candidate?.qualityGuard);
  const qualityKeys = qualityCandidate == null ? [] : Object.keys(qualityCandidate);
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
    candidate?.schemaVersion !== 1 ||
    typeof candidate.identityKey !== 'string' ||
    candidate.identityKey !== identityKey ||
    !/^[a-f0-9]{64}$/u.test(candidate.identityKey) ||
    !record(candidate.failures) ||
    !Array.isArray(candidate.order) ||
    !record(candidate.qualityGuard) ||
    qualityKeys.some(
      (key) => !['blocked', 'reasonCode', 'observedFailures', 'taskId', 'turnId'].includes(key),
    ) ||
    !Number.isSafeInteger(candidate.progressRevision) ||
    (candidate.progressRevision as number) < 0
  )
    return blocked(numberValue(record(candidate?.qualityGuard), 'observedFailures') ?? 0);
  const quality = candidate.qualityGuard as Readonly<Record<string, unknown>>;
  if (
    typeof quality.blocked !== 'boolean' ||
    !Number.isSafeInteger(quality.observedFailures) ||
    (quality.observedFailures as number) < 0 ||
    (quality.observedFailures as number) > 250 ||
    (quality.blocked && !['no_progress', 'journal_invalid'].includes(String(quality.reasonCode))) ||
    (!quality.blocked &&
      (quality.reasonCode != null || quality.taskId != null || quality.turnId != null)) ||
    (quality.taskId != null && typeof quality.taskId !== 'string') ||
    (quality.turnId != null && typeof quality.turnId !== 'string')
  )
    return blocked(numberValue(quality, 'observedFailures'));
  const order = candidate.order as readonly unknown[];
  const failuresRecord = candidate.failures as Readonly<Record<string, unknown>>;
  if (
    order.length > 128 ||
    new Set(order).size !== order.length ||
    order.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) ||
    Object.keys(failuresRecord).some((id) => !order.includes(id))
  )
    return blocked(numberValue(quality, 'observedFailures'));
  const candidateProgressRevision = numberValue(candidate, 'progressRevision') ?? -1;
  const failures: Record<string, ToolRecoveryFailureV1> = {};
  const claims = new Set<string>();
  for (const id of order as readonly string[]) {
    const failure = record(failuresRecord[id]);
    if (!failure || !exactFailureKeys(failure))
      return blocked(numberValue(quality, 'observedFailures'));

    const failureInstanceId = stringValue(failure, 'failureInstanceId');
    const toolCallId = stringValue(failure, 'toolCallId');
    const toolName = stringValue(failure, 'toolName');
    const invocationFingerprint = stringValue(failure, 'invocationFingerprint');
    const modelMessageId = stringValue(failure, 'modelMessageId');
    const taskId = typeof failure.taskId === 'string' ? failure.taskId : undefined;
    const turnId = typeof failure.turnId === 'string' ? failure.turnId : undefined;
    const eligibleAfterModelMessageId =
      typeof failure.eligibleAfterModelMessageId === 'string'
        ? failure.eligibleAfterModelMessageId
        : undefined;
    const eligibleModelMessageId =
      typeof failure.eligibleModelMessageId === 'string'
        ? failure.eligibleModelMessageId
        : undefined;
    const eligibleToolCallId =
      typeof failure.eligibleToolCallId === 'string' ? failure.eligibleToolCallId : undefined;
    const status = stringValue(failure, 'status');
    const resolution = stringValue(failure, 'resolution');
    const modelCorrectionAttempts = numberValue(failure, 'modelCorrectionAttempts');
    const automaticRetryAttempts = numberValue(failure, 'automaticRetryAttempts');
    const progressRevision = numberValue(failure, 'progressRevision');
    const outcome = failure.outcome;
    if (
      failureInstanceId !== id ||
      !validNonEmpty(toolCallId) ||
      !validNonEmpty(toolName) ||
      !/^[a-f0-9]{64}$/u.test(invocationFingerprint ?? '') ||
      modelMessageId == null ||
      (failure.taskId != null && taskId == null) ||
      (failure.turnId != null && turnId == null) ||
      (failure.eligibleAfterModelMessageId != null && eligibleAfterModelMessageId == null) ||
      (failure.eligibleModelMessageId != null && eligibleModelMessageId == null) ||
      (failure.eligibleToolCallId != null &&
        (eligibleToolCallId == null ||
          eligibleToolCallId.length === 0 ||
          eligibleModelMessageId == null)) ||
      !isToolRecoveryFailureStatus(status) ||
      (failure.resolution != null && !isToolRecoveryResolutionV1(resolution)) ||
      !isToolOutcomeV1(outcome) ||
      !isNonNegativeInteger(modelCorrectionAttempts) ||
      modelCorrectionAttempts > 1 ||
      !isNonNegativeInteger(automaticRetryAttempts) ||
      automaticRetryAttempts > 1 ||
      !isNonNegativeInteger(progressRevision) ||
      progressRevision > candidateProgressRevision ||
      toolFailureInstanceIdV1({
        toolCallId,
        invocationFingerprint: invocationFingerprint!,
        outcome,
      }) !== id ||
      (status === 'unresolved' &&
        (resolution != null || outcome.recovery.disposition === 'never')) ||
      (status === 'recovered' &&
        !['recovered', 'skipped', 'replanned', 'user_action', 'provider_revision'].includes(
          String(resolution),
        )) ||
      (status === 'exhausted' &&
        !['terminal', 'next_response_elapsed', 'task_closed', 'turn_closed'].includes(
          String(resolution),
        )) ||
      outcome.lineage?.failureInstanceId !== id
    )
      return blocked(numberValue(quality, 'observedFailures'), { taskId, turnId });
    if (eligibleToolCallId != null) {
      const claim = `${eligibleModelMessageId}\0${eligibleToolCallId}`;
      if (claims.has(claim)) return blocked(numberValue(quality, 'observedFailures'));
      claims.add(claim);
    }
    const normalizedFailureValue =
      status === 'unresolved' && eligibleModelMessageId != null && eligibleToolCallId == null
        ? { ...failure, status: 'exhausted', resolution: 'next_response_elapsed' }
        : turnId == null
          ? { ...failure, status: 'exhausted', resolution: 'terminal' }
          : failure;
    if (!isToolRecoveryFailureV1(normalizedFailureValue))
      return blocked(numberValue(quality, 'observedFailures'), { taskId, turnId });
    failures[id] = normalizedFailureValue;
  }
  for (const [index, id] of (order as readonly string[]).entries()) {
    const failure = failures[id]!;
    const parentId = failure.outcome.lineage?.recoveryOf;
    if (!parentId) continue;
    const parentIndex = order.indexOf(parentId);
    const parent = failures[parentId];
    if (
      !parent ||
      parentId === id ||
      parentIndex < 0 ||
      parentIndex >= index ||
      parent.progressRevision > failure.progressRevision ||
      parent.modelCorrectionAttempts > failure.modelCorrectionAttempts ||
      parent.automaticRetryAttempts > failure.automaticRetryAttempts ||
      failure.modelCorrectionAttempts - parent.modelCorrectionAttempts > 1 ||
      failure.automaticRetryAttempts - parent.automaticRetryAttempts > 1
    )
      return blocked(numberValue(quality, 'observedFailures'));
  }
  const derived = new Map<string, { count: number; taskId?: string; turnId?: string }>();
  for (const failure of Object.values(failures))
    if (failureStillBlocks(failure)) {
      const key = noProgressKey(failures, failure);
      const prior = derived.get(key);
      derived.set(key, {
        count: (prior?.count ?? 0) + 1,
        ...(failure.taskId ? { taskId: failure.taskId } : {}),
        ...(failure.turnId ? { turnId: failure.turnId } : {}),
      });
    }
  const groups = [...derived.values()].filter(
    (entry) => entry.count >= TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
  );
  if (
    !quality.blocked &&
    new Set(groups.map((entry) => `${entry.taskId ?? ''}\0${entry.turnId ?? ''}`)).size > 1
  )
    return blocked(numberValue(quality, 'observedFailures'));
  const first = groups[0];
  const blockedState = quality.blocked || groups.length > 0;
  const reasonCode = blockedState
    ? quality.reasonCode === 'journal_invalid'
      ? 'journal_invalid'
      : 'no_progress'
    : undefined;
  return {
    schemaVersion: 1,
    identityKey,
    failures,
    order: order as string[],
    progressRevision: candidate.progressRevision as number,
    qualityGuard: {
      blocked: blockedState,
      ...(reasonCode ? { reasonCode } : {}),
      observedFailures: Math.min(TOOL_RECOVERY_OBSERVATION_CAP, quality.observedFailures as number),
      ...(reasonCode === 'no_progress' && (stringValue(quality, 'taskId') ?? first?.taskId)
        ? { taskId: stringValue(quality, 'taskId') ?? first?.taskId }
        : {}),
      ...(reasonCode === 'no_progress' && (stringValue(quality, 'turnId') ?? first?.turnId)
        ? { turnId: stringValue(quality, 'turnId') ?? first?.turnId }
        : {}),
    },
  };
}
function validNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isToolRecoveryFailureStatus(value: unknown): value is ToolRecoveryFailureV1['status'] {
  return ['unresolved', 'recovered', 'exhausted'].includes(String(value));
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function exactFailureKeys(value: Readonly<Record<string, unknown>>): boolean {
  const allowed = [
    'failureInstanceId',
    'toolCallId',
    'toolName',
    'invocationFingerprint',
    'modelMessageId',
    'taskId',
    'turnId',
    'eligibleAfterModelMessageId',
    'eligibleModelMessageId',
    'eligibleToolCallId',
    'status',
    'resolution',
    'outcome',
    'modelCorrectionAttempts',
    'automaticRetryAttempts',
    'progressRevision',
  ];
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isToolRecoveryFailureV1(value: unknown): value is ToolRecoveryFailureV1 {
  const failure = record(value);
  if (!failure || !exactFailureKeys(failure)) return false;
  const resolution = stringValue(failure, 'resolution');
  const eligibleModelMessageId = stringValue(failure, 'eligibleModelMessageId');
  const eligibleToolCallId = stringValue(failure, 'eligibleToolCallId');
  return (
    validNonEmpty(stringValue(failure, 'failureInstanceId')) &&
    validNonEmpty(stringValue(failure, 'toolCallId')) &&
    validNonEmpty(stringValue(failure, 'toolName')) &&
    /^[a-f0-9]{64}$/u.test(stringValue(failure, 'invocationFingerprint') ?? '') &&
    typeof failure.modelMessageId === 'string' &&
    (failure.taskId === undefined || typeof failure.taskId === 'string') &&
    (failure.turnId === undefined || typeof failure.turnId === 'string') &&
    (failure.eligibleAfterModelMessageId === undefined ||
      typeof failure.eligibleAfterModelMessageId === 'string') &&
    (failure.eligibleModelMessageId === undefined || eligibleModelMessageId !== undefined) &&
    (failure.eligibleToolCallId === undefined ||
      (eligibleToolCallId !== undefined &&
        eligibleToolCallId.length > 0 &&
        eligibleModelMessageId != null)) &&
    isToolRecoveryFailureStatus(stringValue(failure, 'status')) &&
    (failure.resolution === undefined || isToolRecoveryResolutionV1(resolution)) &&
    isToolOutcomeV1(failure.outcome) &&
    isNonNegativeInteger(numberValue(failure, 'modelCorrectionAttempts')) &&
    numberValue(failure, 'modelCorrectionAttempts')! <= 1 &&
    isNonNegativeInteger(numberValue(failure, 'automaticRetryAttempts')) &&
    numberValue(failure, 'automaticRetryAttempts')! <= 1 &&
    isNonNegativeInteger(numberValue(failure, 'progressRevision'))
  );
}

export function createToolRecoveryJournalV1(identityKey: string): ToolRecoveryJournalV1 {
  if (!/^[a-f0-9]{64}$/u.test(identityKey))
    throw new Error('Tool recovery identityKey must be a canonical host-supplied key.');
  return {
    schemaVersion: 1,
    identityKey,
    failures: {},
    order: [],
    progressRevision: 0,
    qualityGuard: { blocked: false, observedFailures: 0 },
  };
}
