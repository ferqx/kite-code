import { digestCapabilityValueV1 } from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import { isMcpProviderError, mcpProviderFailurePolicyFactsV1 } from '@kite/builtin-runtime/mcp';
import { type ClassifiedFailure, classifyFailure } from './failures';
import type { RuntimeEvent, RuntimeState } from './state26-runtime';

type ProviderReadinessRuntimeRecordV1 = RuntimeState['providerReadiness'][string];

const DEFAULT_READINESS_TTL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const CALLABLE_PROVIDER_STATUSES = new Set(['ready', 'degraded'] as const);

export interface ProviderReadinessPersistenceV1 {
  getState(): Readonly<RuntimeState>;
  persistEvent(event: RuntimeEvent): Promise<boolean>;
}

export interface ProviderReadinessRequestV1 {
  providerId: string;
  routeRevision: string;
  executionBoundaryDigest: string;
  toolCallId: string;
  /** A separately acknowledged tool.retry_recorded event is the only retry authority. */
  retryAuthorized?: boolean;
  signal?: AbortSignal;
}

export interface ProviderReadinessReceiptV1 {
  readinessKey: string;
  lifecycleId: string;
  providerId: string;
  routeRevision: string;
  executionBoundaryDigest: string;
  providerDirectoryRevision: string;
  readyAt: string;
  expiresAt: string;
}

export class ProviderReadinessPersistenceError extends Error {
  readonly code = 'PROVIDER_READINESS_PERSISTENCE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderReadinessPersistenceError';
  }
}

export class ProviderReadinessUnknownError extends Error {
  readonly code = 'PROVIDER_READINESS_UNKNOWN';
  readonly readinessKey: string;

  constructor(readinessKey: string) {
    super('Provider readiness may have been attempted without a durable terminal receipt.');
    this.name = 'ProviderReadinessUnknownError';
    this.readinessKey = readinessKey;
  }
}

export class ProviderReadinessUnavailableError extends Error {
  readonly code = 'PROVIDER_READINESS_UNAVAILABLE';
  readonly failure: ClassifiedFailure;

  constructor(failure: ClassifiedFailure) {
    super(failure.message);
    this.name = 'ProviderReadinessUnavailableError';
    this.failure = failure;
  }
}

interface InFlightReadinessV1 {
  lifecycleId: string;
  intentReady: Promise<void>;
  result: Promise<ProviderReadinessReceiptV1>;
}

export function providerReadinessKeyV1(input: {
  providerId: string;
  routeRevision: string;
  executionBoundaryDigest: string;
}): string {
  return digestCapabilityValueV1({
    schema: 'kite.provider-readiness-key.v1',
    providerId: requiredIdentity(input.providerId, 'providerId'),
    routeRevision: requiredIdentity(input.routeRevision, 'routeRevision'),
    executionBoundaryDigest: requiredIdentity(
      input.executionBoundaryDigest,
      'executionBoundaryDigest',
    ),
  });
}

/**
 * Runtime-owned coalescing boundary for provider readiness. The adapter is never
 * called before intent, waiter, and attempt acknowledgements have all succeeded.
 */
export class ProviderReadinessCoordinatorV1 {
  private readonly inFlight = new Map<string, InFlightReadinessV1>();
  private readonly provider: McpRuntimeProvider | undefined;
  private readonly options: {
    now?: () => number;
    ttlMs?: number;
    maxAttempts?: number;
  };

  constructor(
    provider: McpRuntimeProvider | undefined,
    options: {
      now?: () => number;
      ttlMs?: number;
      maxAttempts?: number;
    } = {},
  ) {
    this.provider = provider;
    this.options = options;
  }

  async ensureReady(
    request: ProviderReadinessRequestV1,
    persistence: ProviderReadinessPersistenceV1,
  ): Promise<ProviderReadinessReceiptV1> {
    const identity = {
      providerId: requiredIdentity(request.providerId, 'providerId'),
      routeRevision: requiredIdentity(request.routeRevision, 'routeRevision'),
      executionBoundaryDigest: requiredIdentity(
        request.executionBoundaryDigest,
        'executionBoundaryDigest',
      ),
    };
    const toolCallId = requiredIdentity(request.toolCallId, 'toolCallId');
    const readinessKey = providerReadinessKeyV1(identity);
    const now = this.now();
    const current = persistence.getState().providerReadiness[readinessKey];
    const callable = this.providerIsCallable(identity.providerId);

    if (current?.status === 'ready' && callable && !expired(current.expiresAt, now)) {
      await this.registerWaiter(current, readinessKey, toolCallId, persistence);
      return receiptFromRecord(current);
    }

    const existing = this.inFlight.get(readinessKey);
    if (existing) {
      await existing.intentReady;
      const active = persistence.getState().providerReadiness[readinessKey];
      if (!active || active.lifecycleId !== existing.lifecycleId) {
        throw new ProviderReadinessPersistenceError(
          'Provider readiness lifecycle changed before waiter registration.',
        );
      }
      await this.registerWaiter(active, readinessKey, toolCallId, persistence);
      return existing.result;
    }

    if (current?.status === 'attempted') {
      throw new ProviderReadinessUnknownError(readinessKey);
    }
    if (
      current?.status === 'failed' &&
      !expired(current.expiresAt, now) &&
      (!request.retryAuthorized || current.attempts >= current.maxAttempts)
    ) {
      throw new ProviderReadinessUnavailableError(
        current.failure ?? classifyFailure('provider_unavailable', 'Provider readiness failed.'),
      );
    }

    const reuse =
      current &&
      !expired(current.expiresAt, now) &&
      (current.status === 'prepared' ||
        (current.status === 'failed' &&
          request.retryAuthorized === true &&
          current.attempts < current.maxAttempts));
    const requestedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.ttlMs()).toISOString();
    const lifecycleId = reuse
      ? current.lifecycleId
      : digestCapabilityValueV1({
          schema: 'kite.provider-readiness-lifecycle.v1',
          readinessKey,
          requestedAt,
          predecessorLifecycleId: current?.lifecycleId ?? null,
        });
    const intentReady = reuse
      ? Promise.resolve()
      : this.persist(
          persistence,
          {
            type: 'provider.readiness_intent_recorded',
            readinessKey,
            lifecycleId,
            ...identity,
            requestedAt,
            expiresAt,
            maxAttempts: this.maxAttempts(),
          },
          'Provider readiness intent was not durably acknowledged.',
        );
    const entry = {} as InFlightReadinessV1;
    entry.lifecycleId = lifecycleId;
    entry.intentReady = intentReady;
    entry.result = (async () => {
      await intentReady;
      const active = persistence.getState().providerReadiness[readinessKey];
      if (!active || active.lifecycleId !== lifecycleId) {
        throw new ProviderReadinessPersistenceError(
          'Provider readiness intent did not produce the expected durable lifecycle.',
        );
      }
      await this.registerWaiter(active, readinessKey, toolCallId, persistence);
      return this.runLifecycle(active, identity, request.signal, persistence);
    })();
    this.inFlight.set(readinessKey, entry);
    try {
      return await entry.result;
    } finally {
      if (this.inFlight.get(readinessKey) === entry) this.inFlight.delete(readinessKey);
    }
  }

  private async runLifecycle(
    record: Readonly<ProviderReadinessRuntimeRecordV1>,
    identity: {
      providerId: string;
      routeRevision: string;
      executionBoundaryDigest: string;
    },
    signal: AbortSignal | undefined,
    persistence: ProviderReadinessPersistenceV1,
  ): Promise<ProviderReadinessReceiptV1> {
    throwIfAborted(signal);
    if (this.providerIsCallable(identity.providerId)) {
      return this.persistSuccess(record, identity, persistence);
    }
    if (!this.provider?.ensureProviderReady) {
      const failure = classifyFailure(
        'provider_unavailable',
        `Provider '${identity.providerId}' has no readiness adapter.`,
      );
      await this.persist(
        persistence,
        {
          type: 'provider.readiness_failed',
          readinessKey: record.readinessKey,
          lifecycleId: record.lifecycleId,
          failure,
          dispatchCertainty: 'none',
          failedAt: new Date(this.now()).toISOString(),
        },
        'Provider readiness failure was not durably acknowledged.',
      );
      throw new ProviderReadinessUnavailableError(failure);
    }

    const attempt = record.attempts + 1;
    if (attempt > record.maxAttempts) {
      throw new ProviderReadinessUnavailableError(
        record.failure ?? classifyFailure('provider_unavailable', 'Provider readiness exhausted.'),
      );
    }
    await this.persist(
      persistence,
      {
        type: 'provider.readiness_attempt_started',
        readinessKey: record.readinessKey,
        lifecycleId: record.lifecycleId,
        attempt,
        maxAttempts: record.maxAttempts,
        startedAt: new Date(this.now()).toISOString(),
      },
      'Provider readiness attempt was not durably acknowledged.',
    );

    try {
      await this.provider.ensureProviderReady(identity.providerId, this.ttlMs(), signal);
      const attempted = persistence.getState().providerReadiness[record.readinessKey];
      if (attempted?.status !== 'attempted') {
        throw new ProviderReadinessUnknownError(record.readinessKey);
      }
      return await this.persistSuccess(attempted, identity, persistence);
    } catch (error) {
      if (error instanceof ProviderReadinessUnknownError) throw error;
      if (error instanceof ProviderReadinessPersistenceError) {
        throw new ProviderReadinessUnknownError(record.readinessKey);
      }
      const failure = readinessFailure(error);
      try {
        await this.persist(
          persistence,
          {
            type: 'provider.readiness_failed',
            readinessKey: record.readinessKey,
            lifecycleId: record.lifecycleId,
            failure,
            dispatchCertainty: 'attempted',
            failedAt: new Date(this.now()).toISOString(),
          },
          'Provider readiness failure receipt was not durably acknowledged.',
        );
      } catch {
        throw new ProviderReadinessUnknownError(record.readinessKey);
      }
      throw error;
    }
  }

  private async persistSuccess(
    record: Readonly<ProviderReadinessRuntimeRecordV1>,
    identity: {
      providerId: string;
      routeRevision: string;
      executionBoundaryDigest: string;
    },
    persistence: ProviderReadinessPersistenceV1,
  ): Promise<ProviderReadinessReceiptV1> {
    const readyAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.ttlMs()).toISOString();
    const providerDirectoryRevision =
      this.provider?.getProviderDirectorySnapshot().revision ?? 'provider-directory-unavailable';
    await this.persist(
      persistence,
      {
        type: 'provider.readiness_succeeded',
        readinessKey: record.readinessKey,
        lifecycleId: record.lifecycleId,
        providerDirectoryRevision,
        readyAt,
        expiresAt,
      },
      'Provider readiness success receipt was not durably acknowledged.',
    );
    return {
      readinessKey: record.readinessKey,
      lifecycleId: record.lifecycleId,
      ...identity,
      providerDirectoryRevision,
      readyAt,
      expiresAt,
    };
  }

  private async registerWaiter(
    record: Readonly<ProviderReadinessRuntimeRecordV1>,
    readinessKey: string,
    toolCallId: string,
    persistence: ProviderReadinessPersistenceV1,
  ): Promise<void> {
    const waiterId = digestCapabilityValueV1({
      schema: 'kite.provider-readiness-waiter.v1',
      lifecycleId: record.lifecycleId,
      toolCallId,
    });
    if (record.waiters[waiterId]) return;
    await this.persist(
      persistence,
      {
        type: 'provider.readiness_waiter_registered',
        readinessKey,
        lifecycleId: record.lifecycleId,
        waiterId,
        toolCallId,
        registeredAt: new Date(this.now()).toISOString(),
      },
      'Provider readiness waiter was not durably acknowledged.',
    );
  }

  private providerIsCallable(providerId: string): boolean {
    const entry = this.provider
      ?.getProviderDirectorySnapshot()
      .entries.find((candidate) => candidate.providerId === providerId);
    return entry ? CALLABLE_PROVIDER_STATUSES.has(entry.status as 'ready' | 'degraded') : false;
  }

  private async persist(
    persistence: ProviderReadinessPersistenceV1,
    event: RuntimeEvent,
    message: string,
  ): Promise<void> {
    let applied = false;
    try {
      applied = await persistence.persistEvent(event);
    } catch {
      throw new ProviderReadinessPersistenceError(message);
    }
    if (!applied) throw new ProviderReadinessPersistenceError(message);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return positiveInteger(this.options.ttlMs ?? DEFAULT_READINESS_TTL_MS, 'ttlMs');
  }

  private maxAttempts(): number {
    return positiveInteger(this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  }
}

function readinessFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ProviderReadinessUnavailableError) return error.failure;
  if (isMcpProviderError(error)) {
    const facts = mcpProviderFailurePolicyFactsV1(error);
    return { ...classifyFailure(facts.kind, facts.message), ...facts };
  }
  return classifyFailure(
    'provider_unavailable',
    error instanceof Error ? error.message : 'Provider readiness failed.',
  );
}

function receiptFromRecord(
  record: Readonly<ProviderReadinessRuntimeRecordV1>,
): ProviderReadinessReceiptV1 {
  if (record.status !== 'ready' || !record.providerDirectoryRevision) {
    throw new ProviderReadinessUnknownError(record.readinessKey);
  }
  return {
    readinessKey: record.readinessKey,
    lifecycleId: record.lifecycleId,
    providerId: record.providerId,
    routeRevision: record.routeRevision,
    executionBoundaryDigest: record.executionBoundaryDigest,
    providerDirectoryRevision: record.providerDirectoryRevision,
    readyAt: record.readyAt ?? record.requestedAt,
    expiresAt: record.expiresAt,
  };
}

function expired(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

function requiredIdentity(value: string, field: string): string {
  if (!value || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${field} must be a bounded non-empty identity.`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Provider readiness aborted.');
}
