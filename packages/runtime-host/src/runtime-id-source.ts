import { randomUUID } from 'node:crypto';

export const RUNTIME_ID_SOURCE_REVISION_V1 = 'kite.runtime-id-source.v1' as const;

export type RuntimeIdScopeV1 =
  | 'turn'
  | 'task'
  | 'kernel_runner'
  | 'kernel_effect'
  | 'model_invocation';

/** Process-local identity and clock source. It is never persisted as authority. */
export interface RuntimeIdSourceV1 {
  readonly revision: typeof RUNTIME_ID_SOURCE_REVISION_V1;
  next(scope: RuntimeIdScopeV1): string;
  now(): number;
}

export function createLiveRuntimeIdSourceV1(): RuntimeIdSourceV1 {
  return Object.freeze({
    revision: RUNTIME_ID_SOURCE_REVISION_V1,
    next: (_scope: RuntimeIdScopeV1) => randomUUID(),
    now: () => Date.now(),
  });
}

/**
 * Test-only deterministic source. Per-scope counters keep concurrent
 * actor scheduling from changing unrelated identities.
 */
export function createDeterministicRuntimeIdSourceV1(input: {
  seed: string;
  epochMs: number;
  clockStepMs?: number;
}): RuntimeIdSourceV1 {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.seed)) {
    throw new Error('Deterministic Runtime ID seed is invalid.');
  }
  if (!Number.isSafeInteger(input.epochMs) || input.epochMs < 0) {
    throw new Error('Deterministic Runtime clock epoch is invalid.');
  }
  const clockStepMs = input.clockStepMs ?? 1;
  if (!Number.isSafeInteger(clockStepMs) || clockStepMs < 1) {
    throw new Error('Deterministic Runtime clock step is invalid.');
  }
  const counters = new Map<RuntimeIdScopeV1, number>();
  let clockOrdinal = 0;
  return Object.freeze({
    revision: RUNTIME_ID_SOURCE_REVISION_V1,
    next: (scope: RuntimeIdScopeV1) => {
      const ordinal = (counters.get(scope) ?? 0) + 1;
      counters.set(scope, ordinal);
      return `${input.seed}-${scope.replaceAll('_', '-')}-${String(ordinal).padStart(4, '0')}`;
    },
    now: () => input.epochMs + clockOrdinal++ * clockStepMs,
  });
}
