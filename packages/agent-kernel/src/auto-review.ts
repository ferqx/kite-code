import type { AgentAutoReviewState } from './state';

/**
 * State 25 auto-review completion authority.
 *
 * Builtin owns reviewer/model semantics and supplies this module only the
 * resulting canonical facts. Kernel owns the deterministic decision about
 * whether those facts are sufficient for an operation-bound approval or must
 * be escalated to the user. There is deliberately no event, clock, id, model,
 * gateway, or persistence authority here.
 */

export type AutoReviewGrant = 'approve_once' | 'same_command' | 'full_access';
export type AutoReviewFailureType = 'technical' | 'invalid_response';

export interface AutoReviewFacts {
  readonly reviewId: string;
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly approved: boolean;
  readonly requiresUserApproval?: true;
  readonly grant?: AutoReviewGrant;
  readonly reason?: string;
  readonly failureType?: AutoReviewFailureType;
}

export interface AutoReviewAcceptedDecision {
  readonly kind: 'accepted_approval';
  readonly reviewId: string;
  readonly toolCallId: string;
  readonly grant: Exclude<AutoReviewGrant, 'full_access'>;
  readonly reason?: string;
}

export interface AutoReviewUserApprovalDecision {
  readonly kind: 'request_user_approval';
  readonly reviewId?: string;
  readonly toolCallId?: string;
  readonly reason: string;
  readonly failureType?: AutoReviewFailureType;
}

export interface AutoReviewRejectedDecision {
  readonly kind: 'rejected';
  readonly reviewId: string;
  readonly toolCallId: string;
  readonly reason: string;
}

export type AutoReviewDecision =
  | AutoReviewAcceptedDecision
  | AutoReviewRejectedDecision
  | AutoReviewUserApprovalDecision;

export interface CircuitBreakerConfig {
  readonly maxRejections: number;
  readonly windowMs: number;
  readonly maxTotalBlocks: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG_: CircuitBreakerConfig = Object.freeze({
  maxRejections: 3,
  windowMs: 30_000,
  maxTotalBlocks: 20,
});

export const DEFAULT_AUTO_REVIEW_STATE_: AgentAutoReviewState = {
  pendingWarnings: {},
  consecutiveRejects: 0,
  rejectionHistory: [],
  circuitBreakerTripped: false,
};

export interface AutoReviewRejectionEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly reason: string;
}

export interface CircuitBreakerResult {
  readonly tripped: boolean;
  readonly reason?: string;
  readonly newConsecutiveRejects: number;
  readonly newRejectionHistory: readonly AutoReviewRejectionEntry[];
  readonly newStatus: Readonly<{ status: 'closed' | 'open' }>;
}

/** Pure State 25 auto-review breaker decision over Host-supplied time facts. */
export function evaluateAutoReviewCircuitBreaker(
  consecutiveRejects: number,
  rejectionHistory: readonly AutoReviewRejectionEntry[],
  config: CircuitBreakerConfig,
  isRejection: boolean,
  rejectionEntry?: AutoReviewRejectionEntry,
  observedAt = rejectionEntry?.timestamp ?? 0,
): CircuitBreakerResult {
  const windowStart = observedAt - config.windowMs;
  if (!isRejection) {
    return {
      tripped: false,
      newConsecutiveRejects: 0,
      newRejectionHistory: rejectionHistory.filter((entry) => entry.timestamp >= windowStart),
      newStatus: { status: 'closed' as const },
    };
  }

  const newConsecutiveRejects = consecutiveRejects + 1;
  const pruned = rejectionHistory.filter((entry) => entry.timestamp >= windowStart);
  const newRejectionHistory = rejectionEntry ? [...pruned, rejectionEntry] : pruned;
  if (newConsecutiveRejects >= config.maxRejections) {
    return {
      tripped: true,
      reason: `Circuit breaker tripped: ${newConsecutiveRejects} consecutive rejections (threshold: ${config.maxRejections})`,
      newConsecutiveRejects,
      newRejectionHistory,
      newStatus: { status: 'open' as const },
    };
  }
  if (newRejectionHistory.length >= config.maxTotalBlocks) {
    return {
      tripped: true,
      reason: `Circuit breaker tripped: ${newRejectionHistory.length} rejections within ${config.windowMs}ms (limit: ${config.maxTotalBlocks})`,
      newConsecutiveRejects,
      newRejectionHistory,
      newStatus: { status: 'open' as const },
    };
  }
  return {
    tripped: false,
    newConsecutiveRejects,
    newRejectionHistory,
    newStatus: { status: 'closed' as const },
  };
}

const MAX_IDENTITY_LENGTH = 256;
const MAX_REASON_LENGTH = 4096;
const INVALID_FACTS_REASON = 'Auto-review facts are malformed; user approval is required.';
const REVIEWER_FAILURE_REASON = 'Auto-review could not produce a valid reviewer decision.';
const REVIEWER_REJECTION_REASON = 'Auto-review did not approve this operation.';

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && descriptor.enumerable,
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validFacts(value: unknown): value is AutoReviewFacts {
  if (
    !plainRecord(value) ||
    !exactKeys(
      value,
      ['reviewId', 'toolCallId', 'ok', 'approved'],
      ['grant', 'reason', 'failureType', 'requiresUserApproval'],
    )
  ) {
    return false;
  }
  return (
    boundedString(value.reviewId, MAX_IDENTITY_LENGTH) &&
    boundedString(value.toolCallId, MAX_IDENTITY_LENGTH) &&
    typeof value.ok === 'boolean' &&
    typeof value.approved === 'boolean' &&
    (value.requiresUserApproval === undefined || value.requiresUserApproval === true) &&
    !(value.approved && value.requiresUserApproval === true) &&
    (value.grant === undefined ||
      value.grant === 'approve_once' ||
      value.grant === 'same_command' ||
      value.grant === 'full_access') &&
    (value.reason === undefined || boundedString(value.reason, MAX_REASON_LENGTH)) &&
    (value.failureType === undefined ||
      value.failureType === 'technical' ||
      value.failureType === 'invalid_response')
  );
}

function safeIdentity(value: unknown): string | undefined {
  return boundedString(value, MAX_IDENTITY_LENGTH) ? value : undefined;
}

function requestUserApproval(
  input: { readonly reviewId?: unknown; readonly toolCallId?: unknown } | undefined,
  reason: string,
  failureType?: AutoReviewFailureType,
): AutoReviewUserApprovalDecision {
  const reviewId = safeIdentity(input?.reviewId);
  const toolCallId = safeIdentity(input?.toolCallId);
  return Object.freeze({
    kind: 'request_user_approval' as const,
    ...(reviewId ? { reviewId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    reason,
    ...(failureType ? { failureType } : {}),
  });
}

/**
 * Validate the exact canonical fact shape without mutating or executing it.
 * Unknown fields, accessors, custom prototypes, non-canonical identities, and
 * unsupported grants fail closed.
 */
export function isValidAutoReviewFacts(value: unknown): value is AutoReviewFacts {
  return validFacts(value);
}

/**
 * Decide one completed auto-review result.
 *
 * `ok === true`, `approved === true`, and an operation-bound grant of
 * `approve_once` or `same_command` are all required for automatic acceptance.
 * A canonical reviewer rejection is terminal unless the reviewer explicitly
 * requests user approval. Technical/invalid results and unsupported grants
 * always escalate to the user.
 */
export function decideAutoReview(value: unknown): AutoReviewDecision {
  if (!validFacts(value)) {
    return requestUserApproval(
      plainRecord(value) ? value : undefined,
      INVALID_FACTS_REASON,
      'invalid_response',
    );
  }

  if (!value.ok) {
    return requestUserApproval(
      value,
      value.reason ?? REVIEWER_FAILURE_REASON,
      value.failureType ?? 'technical',
    );
  }

  if (value.failureType !== undefined) {
    return requestUserApproval(
      value,
      value.reason ?? 'Auto-review result carried contradictory failure facts.',
      'invalid_response',
    );
  }

  if (!value.approved) {
    if (value.requiresUserApproval === true) {
      return requestUserApproval(value, value.reason ?? 'Auto-review requested user approval.');
    }
    return Object.freeze({
      kind: 'rejected' as const,
      reviewId: value.reviewId,
      toolCallId: value.toolCallId,
      reason: value.reason ?? REVIEWER_REJECTION_REASON,
    });
  }

  if (value.grant !== 'approve_once' && value.grant !== 'same_command') {
    return requestUserApproval(
      value,
      value.grant === 'full_access'
        ? 'Auto-review cannot grant full_access; user approval is required.'
        : 'Auto-review approval has no supported operation-bound grant.',
      'invalid_response',
    );
  }

  return Object.freeze({
    kind: 'accepted_approval' as const,
    reviewId: value.reviewId,
    toolCallId: value.toolCallId,
    grant: value.grant,
    ...(value.reason ? { reason: value.reason } : {}),
  });
}
