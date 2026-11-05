import { AgentError } from '../storage/types';

/** Larger delays overflow the host timer and can fire immediately. */
export const maximumAuthorizationCheckTimeoutMs = 2_147_483_647;

/** Mutable only at Core's actual preparation, permit and Provider boundaries. */
export interface AuthorizationTimingState {
  startedAt: number;
  budgetMs: number;
  queueStartedAt?: number;
  queueFinishedAt?: number;
  providerStartedAt?: number;
}

export interface AuthorizationTimingSnapshot {
  startedAt: number;
  budgetMs: number;
  deadlineAt: number;
  prepareMs: number;
  queueMs: number;
  providerMs: number;
  totalMs: number;
}

/** A snapshot, never a new budget. Preparation includes work after acquiring the permit. */
export function authorizationTimingSnapshot(
  state: AuthorizationTimingState,
  now = Date.now(),
): AuthorizationTimingSnapshot {
  const timestamps = [
    state.startedAt,
    now,
    state.queueStartedAt,
    state.queueFinishedAt,
    state.providerStartedAt,
  ].filter((value): value is number => value !== undefined);
  if (
    timestamps.some((value) => !Number.isSafeInteger(value)) ||
    !Number.isSafeInteger(state.budgetMs) ||
    state.budgetMs <= 0 ||
    !Number.isSafeInteger(state.startedAt + state.budgetMs)
  )
    throw new AgentError('invalid_authorization_timing');
  const end = Math.max(state.startedAt, now);
  const clamp = (value: number, minimum: number) => Math.min(end, Math.max(minimum, value));
  const queueStart = clamp(state.queueStartedAt ?? state.startedAt, state.startedAt);
  const queueEnd = clamp(state.queueFinishedAt ?? state.providerStartedAt ?? end, queueStart);
  const providerStart = clamp(
    state.providerStartedAt ?? end,
    state.queueStartedAt === undefined ? state.startedAt : queueEnd,
  );
  const totalMs = end - state.startedAt;
  const queueMs = state.queueStartedAt === undefined ? 0 : queueEnd - queueStart;
  const providerMs = state.providerStartedAt === undefined ? 0 : end - providerStart;
  return {
    startedAt: state.startedAt,
    budgetMs: state.budgetMs,
    deadlineAt: state.startedAt + state.budgetMs,
    prepareMs: totalMs - queueMs - providerMs,
    queueMs,
    providerMs,
    totalMs,
  };
}
