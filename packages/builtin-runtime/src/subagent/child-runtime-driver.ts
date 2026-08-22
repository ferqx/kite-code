import type { SubagentDelegationGrantV1, SubagentResumeGrantV1 } from '@kite/runtime-spi';
import type { LocalSubagentDriverResultV1, LocalSubagentLifecycleDriverV1 } from './local-provider';

const DEFAULT_PENDING_REGISTRATION_TTL_MS = 5 * 60_000;
const MAX_PENDING_REGISTRATIONS = 256;

interface ChildRuntimeRegistrationIdentityV1 {
  readonly childInvocationId: string;
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly expiresAtMs?: number;
}

export interface BuiltinChildRuntimeStartRegistrationV1 extends ChildRuntimeRegistrationIdentityV1 {
  readonly run: (
    grant: Readonly<SubagentDelegationGrantV1>,
    task: string,
    signal: AbortSignal,
  ) => Promise<LocalSubagentDriverResultV1>;
}

export interface BuiltinChildRuntimeResumeRegistrationV1
  extends ChildRuntimeRegistrationIdentityV1 {
  readonly run: (
    grant: Readonly<SubagentResumeGrantV1>,
    task: string,
    signal: AbortSignal,
  ) => Promise<LocalSubagentDriverResultV1>;
}

interface StoredRegistrationV1<T> {
  readonly registration: T;
  readonly expiresAtMs: number;
}

/**
 * Builtin-owned child lifecycle Driver. Model execution stays behind the
 * invocation-scoped callback until RMV1-15; registration, expiry, single-use
 * dispatch and abandon ownership live here.
 */
export class BuiltinChildRuntimeDriverV1 implements LocalSubagentLifecycleDriverV1 {
  readonly #starts = new Map<
    string,
    StoredRegistrationV1<BuiltinChildRuntimeStartRegistrationV1>
  >();
  readonly #resumes = new Map<
    string,
    StoredRegistrationV1<BuiltinChildRuntimeResumeRegistrationV1>
  >();
  readonly #now: () => number;
  readonly #maxPendingRegistrations: number;
  #clockHighWaterMs = -1;

  constructor(
    options: { readonly now?: () => number; readonly maxPendingRegistrations?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#maxPendingRegistrations = options.maxPendingRegistrations ?? MAX_PENDING_REGISTRATIONS;
    if (
      !Number.isSafeInteger(this.#maxPendingRegistrations) ||
      this.#maxPendingRegistrations < 1 ||
      this.#maxPendingRegistrations > MAX_PENDING_REGISTRATIONS
    ) {
      throw new Error('Child Runtime pending-registration capacity is invalid.');
    }
    this.#effectiveNow();
  }

  registerStart(grantId: string, registration: BuiltinChildRuntimeStartRegistrationV1): void {
    this.#register(this.#starts, grantId, registration);
  }

  registerResume(grantId: string, registration: BuiltinChildRuntimeResumeRegistrationV1): void {
    this.#register(this.#resumes, grantId, registration);
  }

  abandon(grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>): boolean {
    this.#pruneExpired();
    const registrations = grant.purpose === 'start' ? this.#starts : this.#resumes;
    const stored = registrations.get(grant.grantId);
    if (!stored || !matchesGrantV1(stored.registration, grant)) return false;
    registrations.delete(grant.grantId);
    return true;
  }

  pendingRegistrationCountV1(): number {
    this.#pruneExpired();
    return this.#starts.size + this.#resumes.size;
  }

  async start(
    grant: Readonly<SubagentDelegationGrantV1>,
    task: string,
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1> {
    this.#pruneExpired();
    const stored = this.#starts.get(grant.grantId);
    this.#starts.delete(grant.grantId);
    if (!stored || !matchesGrantV1(stored.registration, grant)) {
      throw new Error('Child Runtime start context is unavailable.');
    }
    return stored.registration.run(grant, task, signal);
  }

  async resume(
    grant: Readonly<SubagentResumeGrantV1>,
    task: string,
    signal: AbortSignal,
  ): Promise<LocalSubagentDriverResultV1> {
    this.#pruneExpired();
    const stored = this.#resumes.get(grant.grantId);
    this.#resumes.delete(grant.grantId);
    if (!stored || !matchesGrantV1(stored.registration, grant)) {
      throw new Error('Child Runtime resume context is stale.');
    }
    return stored.registration.run(grant, task, signal);
  }

  #register<T extends ChildRuntimeRegistrationIdentityV1>(
    target: Map<string, StoredRegistrationV1<T>>,
    grantId: string,
    registration: T,
  ): void {
    this.#pruneExpired();
    if (this.#starts.has(grantId) || this.#resumes.has(grantId)) {
      throw new Error('Child Runtime grant registration collided.');
    }
    if (this.#starts.size + this.#resumes.size >= this.#maxPendingRegistrations) {
      throw new Error('Child Runtime pending-registration capacity is exhausted.');
    }
    const now = this.#effectiveNow();
    const expiresAtMs = registration.expiresAtMs ?? now + DEFAULT_PENDING_REGISTRATION_TTL_MS;
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= now ||
      expiresAtMs - now > DEFAULT_PENDING_REGISTRATION_TTL_MS
    ) {
      throw new Error('Child Runtime pending-registration expiry is invalid.');
    }
    target.set(grantId, { registration, expiresAtMs });
  }

  #pruneExpired(): void {
    const now = this.#effectiveNow();
    for (const registrations of [this.#starts, this.#resumes]) {
      for (const [grantId, registration] of registrations) {
        if (registration.expiresAtMs <= now) registrations.delete(grantId);
      }
    }
  }

  #effectiveNow(): number {
    const current = this.#now();
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new Error('Child Runtime clock is invalid.');
    }
    if (current > this.#clockHighWaterMs) this.#clockHighWaterMs = current;
    return this.#clockHighWaterMs;
  }
}

function matchesGrantV1(
  registration: ChildRuntimeRegistrationIdentityV1,
  grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
): boolean {
  return (
    registration.childInvocationId === grant.childInvocationId &&
    registration.parentInvocationId === grant.parentInvocationId &&
    registration.parentToolCallId === grant.parentToolCallId &&
    registration.parentAttempt === grant.parentAttempt
  );
}
