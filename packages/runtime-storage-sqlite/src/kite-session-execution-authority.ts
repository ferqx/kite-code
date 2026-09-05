import type { Database } from 'bun:sqlite';
import { assertKiteSessionStoreSchema } from './kite-home-store';
import { KiteHomeWriteError, type KiteHomeWriteTransactionPort } from './kite-home-write';

export const KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA =
  'kite.session-execution-authority.v1' as const;

export type KiteSessionExecutionStatus = 'idle' | 'active' | 'detached' | 'recovery_required';

export interface KiteSessionExecutionAuthorityRecord {
  readonly sessionId: string;
  readonly status: KiteSessionExecutionStatus;
  readonly controllerGeneration: number;
  readonly hostInstanceId: string | null;
  readonly clientId: string | null;
  readonly connectionGeneration: number;
  readonly interactionGeneration: number;
  readonly leaseUntilMs: number | null;
  readonly cleanupConfirmed: boolean;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface KiteSessionExecutionBinding {
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly hostInstanceId: string;
  readonly clientId: string | null;
  readonly connectionGeneration: number;
  readonly expectedAuthorityRevision: number;
}

export interface KiteSessionInitialExecutionInput {
  readonly sessionId: string;
  readonly hostInstanceId: string;
  readonly clientId: string | null;
  readonly connectionGeneration: number;
  readonly leaseUntilMs: number;
}

export type KiteSessionExecutionAuthorityErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'revision_conflict'
  | 'stale_generation'
  | 'invalid_transition'
  | 'corrupt';

export class KiteSessionExecutionAuthorityError extends Error {
  readonly code: KiteSessionExecutionAuthorityErrorCode;

  constructor(code: KiteSessionExecutionAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'KiteSessionExecutionAuthorityError';
    this.code = code;
  }
}

export type KiteSessionAcquireResult =
  | { readonly status: 'acquired'; readonly authority: KiteSessionExecutionAuthorityRecord }
  | {
      readonly status: 'busy' | 'recovery_required';
      readonly authority: KiteSessionExecutionAuthorityRecord;
    };

export interface KiteSessionExecutionAuthority {
  read(sessionId: string): KiteSessionExecutionAuthorityRecord;
  assertActive(binding: KiteSessionExecutionBinding): KiteSessionExecutionAuthorityRecord;
  /** Caller already owns the Session mutation transaction. */
  markRecoveryRequiredInTransaction(
    binding: KiteSessionExecutionBinding,
  ): KiteSessionExecutionAuthorityRecord;
  /** Session facts were inserted earlier in this same writer transaction. */
  acquireInitialInTransaction(
    input: KiteSessionInitialExecutionInput,
  ): KiteSessionExecutionAuthorityRecord;
  /** Delete the exact active authority while the fenced Session deletion transaction is held. */
  removeInTransaction(binding: KiteSessionExecutionBinding): void;
  acquire(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly hostInstanceId: string;
    readonly clientId: string | null;
    readonly connectionGeneration: number;
    readonly leaseUntilMs: number;
  }): KiteSessionAcquireResult;
  renew(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly controllerGeneration: number;
    readonly hostInstanceId: string;
    readonly leaseUntilMs: number;
  }): KiteSessionAcquireResult;
  detach(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly controllerGeneration: number;
    readonly hostInstanceId: string;
  }): KiteSessionExecutionAuthorityRecord;
  release(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly controllerGeneration: number;
    readonly hostInstanceId: string;
    readonly cleanupConfirmed: boolean;
  }): KiteSessionExecutionAuthorityRecord;
  /** Caller already owns the writer transaction. */
  releaseInTransaction(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly controllerGeneration: number;
    readonly hostInstanceId: string;
    readonly cleanupConfirmed: boolean;
  }): KiteSessionExecutionAuthorityRecord;
  confirmRecoveryCleanup(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
  }): KiteSessionExecutionAuthorityRecord;
  /** Caller already owns the recovery reconciliation transaction. */
  confirmRecoveryCleanupInTransaction(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
  }): KiteSessionExecutionAuthorityRecord;
}

type PersistedRecord = KiteSessionExecutionAuthorityRecord & {
  readonly schema: typeof KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA;
};

export function createKiteSessionExecutionAuthority(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly nowMs?: () => number;
}): KiteSessionExecutionAuthority {
  const now = input.nowMs ?? Date.now;
  const key = (sessionId: string): string => `session_execution/${sessionId}`;

  const ensureSession = (sessionId: string): void => {
    assertSessionId(sessionId);
    const row = input.database
      .query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM runtime_sessions WHERE session_id = ? LIMIT 1',
      )
      .get(sessionId);
    if (!row) {
      throw new KiteSessionExecutionAuthorityError(
        'session_not_found',
        'Session execution authority requires a durable Session.',
      );
    }
  };

  const readStoredTx = (sessionId: string): PersistedRecord | undefined => {
    ensureSession(sessionId);
    const row = input.database
      .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key = ? LIMIT 1')
      .get(key(sessionId));
    if (!row) return undefined;
    try {
      return parseRecord(JSON.parse(row.value) as unknown, sessionId);
    } catch (error) {
      if (error instanceof KiteSessionExecutionAuthorityError) throw error;
      throw new KiteSessionExecutionAuthorityError(
        'corrupt',
        'Session execution authority record is malformed.',
      );
    }
  };
  const readTx = (sessionId: string): PersistedRecord =>
    readStoredTx(sessionId) ?? initialRecord(sessionId);

  const writeTx = (record: PersistedRecord): void => {
    input.database
      .query('INSERT OR REPLACE INTO kite_meta(key, value) VALUES (?, ?)')
      .run(key(record.sessionId), JSON.stringify(record));
  };

  const mutate = <Result>(work: () => Result): Result => {
    assertKiteSessionStoreSchema(input.database);
    try {
      return input.writer.run(work);
    } catch (error) {
      if (
        error instanceof KiteHomeWriteError &&
        error.code === 'write_failed' &&
        error.cause instanceof KiteSessionExecutionAuthorityError
      ) {
        throw error.cause;
      }
      throw error;
    }
  };

  const read = (sessionId: string): KiteSessionExecutionAuthorityRecord => {
    assertKiteSessionStoreSchema(input.database);
    return publicRecord(readTx(sessionId));
  };

  const assertActive = (
    binding: KiteSessionExecutionBinding,
  ): KiteSessionExecutionAuthorityRecord => {
    validateBinding(binding);
    assertKiteSessionStoreSchema(input.database);
    const current = readTx(binding.sessionId);
    assertExpectedRevision(current, binding.expectedAuthorityRevision);
    if (
      current.status !== 'active' ||
      current.controllerGeneration !== binding.controllerGeneration ||
      current.hostInstanceId !== binding.hostInstanceId ||
      current.clientId !== binding.clientId ||
      current.connectionGeneration !== binding.connectionGeneration ||
      current.leaseUntilMs === null ||
      current.leaseUntilMs <= now()
    ) {
      throw new KiteSessionExecutionAuthorityError(
        'stale_generation',
        'Session execution binding is no longer active.',
      );
    }
    return publicRecord(current);
  };

  const markRecoveryRequiredInTransaction = (
    binding: KiteSessionExecutionBinding,
  ): KiteSessionExecutionAuthorityRecord => {
    if (!input.writer.inTransaction) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Recovery fencing requires the Session mutation transaction.',
      );
    }
    assertActive(binding);
    const current = readTx(binding.sessionId);
    const recovery = nextRecord(current, now(), {
      status: 'recovery_required',
      controllerGeneration: increment(current.controllerGeneration),
      hostInstanceId: null,
      clientId: null,
      connectionGeneration: 0,
      leaseUntilMs: null,
      cleanupConfirmed: false,
    });
    writeTx(recovery);
    return publicRecord(recovery);
  };

  const acquireInitialInTransaction = (
    request: KiteSessionInitialExecutionInput,
  ): KiteSessionExecutionAuthorityRecord => {
    if (!input.writer.inTransaction) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Initial Session execution authority requires the creation transaction.',
      );
    }
    assertSessionId(request.sessionId);
    assertIdentity(request.hostInstanceId, 'Host instance');
    assertNullableIdentity(request.clientId, 'Client');
    assertGeneration(request.connectionGeneration, 'Connection generation');
    assertFutureLease(request.leaseUntilMs, now());
    if (readStoredTx(request.sessionId)) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Initial Session execution authority already exists.',
      );
    }
    const acquired = nextRecord(initialRecord(request.sessionId), now(), {
      status: 'active',
      controllerGeneration: 1,
      hostInstanceId: request.hostInstanceId,
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      leaseUntilMs: request.leaseUntilMs,
      cleanupConfirmed: false,
    });
    writeTx(acquired);
    return publicRecord(acquired);
  };

  const removeInTransaction = (binding: KiteSessionExecutionBinding): void => {
    if (!input.writer.inTransaction) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Session execution authority removal requires the deletion transaction.',
      );
    }
    assertActive(binding);
    input.database.query('DELETE FROM kite_meta WHERE key = ?').run(key(binding.sessionId));
  };

  const acquire = (
    request: Parameters<KiteSessionExecutionAuthority['acquire']>[0],
  ): KiteSessionAcquireResult => {
    assertRevision(request.expectedRevision);
    assertIdentity(request.hostInstanceId, 'Host instance');
    assertNullableIdentity(request.clientId, 'Client');
    assertGeneration(request.connectionGeneration, 'Connection generation');
    assertFutureLease(request.leaseUntilMs, now());
    return mutate(() => {
      const current = readTx(request.sessionId);
      assertExpectedRevision(current, request.expectedRevision);
      if (current.status === 'recovery_required') {
        return { status: 'recovery_required', authority: publicRecord(current) };
      }
      if (
        (current.status === 'active' || current.status === 'detached') &&
        current.leaseUntilMs !== null &&
        current.leaseUntilMs > now()
      ) {
        return { status: 'busy', authority: publicRecord(current) };
      }
      if (
        (current.status === 'active' || current.status === 'detached') &&
        !current.cleanupConfirmed
      ) {
        const recovery = nextRecord(current, now(), {
          status: 'recovery_required',
          controllerGeneration: increment(current.controllerGeneration),
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          leaseUntilMs: null,
          cleanupConfirmed: false,
        });
        writeTx(recovery);
        return { status: 'recovery_required', authority: publicRecord(recovery) };
      }
      const acquired = nextRecord(current, now(), {
        status: 'active',
        controllerGeneration: increment(current.controllerGeneration),
        hostInstanceId: request.hostInstanceId,
        clientId: request.clientId,
        connectionGeneration: request.connectionGeneration,
        leaseUntilMs: request.leaseUntilMs,
        cleanupConfirmed: false,
      });
      writeTx(acquired);
      return { status: 'acquired', authority: publicRecord(acquired) };
    });
  };

  const renew = (
    request: Parameters<KiteSessionExecutionAuthority['renew']>[0],
  ): KiteSessionAcquireResult => {
    validateOwnerRequest(request);
    assertFutureLease(request.leaseUntilMs, now());
    return mutate(() => {
      const current = readTx(request.sessionId);
      assertExpectedRevision(current, request.expectedRevision);
      assertActiveOwner(current, request);
      if (current.leaseUntilMs === null || current.leaseUntilMs <= now()) {
        const recovery = nextRecord(current, now(), {
          status: 'recovery_required',
          controllerGeneration: increment(current.controllerGeneration),
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          leaseUntilMs: null,
          cleanupConfirmed: false,
        });
        writeTx(recovery);
        return { status: 'recovery_required', authority: publicRecord(recovery) };
      }
      const renewed = nextRecord(current, now(), { leaseUntilMs: request.leaseUntilMs });
      writeTx(renewed);
      return { status: 'acquired', authority: publicRecord(renewed) };
    });
  };

  const detach = (
    request: Parameters<KiteSessionExecutionAuthority['detach']>[0],
  ): KiteSessionExecutionAuthorityRecord => {
    validateOwnerRequest(request);
    return mutate(() => {
      const current = readTx(request.sessionId);
      assertExpectedRevision(current, request.expectedRevision);
      assertActiveOwner(current, request);
      const detached = nextRecord(current, now(), { status: 'detached' });
      writeTx(detached);
      return publicRecord(detached);
    });
  };

  const releaseInTransaction = (
    request: Parameters<KiteSessionExecutionAuthority['release']>[0],
  ): KiteSessionExecutionAuthorityRecord => {
    validateOwnerRequest(request);
    if (typeof request.cleanupConfirmed !== 'boolean') invalid('Cleanup confirmation is invalid.');
    if (!input.writer.inTransaction) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Session execution release requires the writer transaction.',
      );
    }
    const current = readTx(request.sessionId);
    assertExpectedRevision(current, request.expectedRevision);
    assertCurrentOwner(current, request);
    const released = nextRecord(current, now(), {
      status: request.cleanupConfirmed ? 'idle' : 'recovery_required',
      controllerGeneration: increment(current.controllerGeneration),
      hostInstanceId: null,
      clientId: null,
      connectionGeneration: 0,
      leaseUntilMs: null,
      cleanupConfirmed: request.cleanupConfirmed,
    });
    writeTx(released);
    return publicRecord(released);
  };

  const release = (
    request: Parameters<KiteSessionExecutionAuthority['release']>[0],
  ): KiteSessionExecutionAuthorityRecord => mutate(() => releaseInTransaction(request));

  const confirmRecoveryCleanupInTransaction = (
    request: Parameters<KiteSessionExecutionAuthority['confirmRecoveryCleanup']>[0],
  ): KiteSessionExecutionAuthorityRecord => {
    assertRevision(request.expectedRevision);
    if (!input.writer.inTransaction) {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Recovery cleanup confirmation requires the writer transaction.',
      );
    }
    const current = readTx(request.sessionId);
    assertExpectedRevision(current, request.expectedRevision);
    if (current.status !== 'recovery_required') {
      throw new KiteSessionExecutionAuthorityError(
        'invalid_transition',
        'Session is not waiting for recovery cleanup.',
      );
    }
    const reconciled = nextRecord(current, now(), {
      status: 'idle',
      controllerGeneration: increment(current.controllerGeneration),
      hostInstanceId: null,
      clientId: null,
      connectionGeneration: 0,
      leaseUntilMs: null,
      cleanupConfirmed: true,
    });
    writeTx(reconciled);
    return publicRecord(reconciled);
  };

  const confirmRecoveryCleanup = (
    request: Parameters<KiteSessionExecutionAuthority['confirmRecoveryCleanup']>[0],
  ): KiteSessionExecutionAuthorityRecord =>
    mutate(() => confirmRecoveryCleanupInTransaction(request));

  return Object.freeze({
    read,
    assertActive,
    markRecoveryRequiredInTransaction,
    acquireInitialInTransaction,
    removeInTransaction,
    acquire,
    renew,
    detach,
    release,
    releaseInTransaction,
    confirmRecoveryCleanup,
    confirmRecoveryCleanupInTransaction,
  });
}

function initialRecord(sessionId: string): PersistedRecord {
  return {
    schema: KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA,
    sessionId,
    status: 'idle',
    controllerGeneration: 0,
    hostInstanceId: null,
    clientId: null,
    connectionGeneration: 0,
    interactionGeneration: 0,
    leaseUntilMs: null,
    cleanupConfirmed: true,
    updatedAt: 0,
    revision: 0,
  };
}

function nextRecord(
  current: PersistedRecord,
  updatedAt: number,
  patch: Partial<PersistedRecord>,
): PersistedRecord {
  return { ...current, ...patch, updatedAt, revision: increment(current.revision) };
}

function publicRecord(record: PersistedRecord): KiteSessionExecutionAuthorityRecord {
  const { schema: _schema, ...value } = record;
  return Object.freeze(value);
}

function parseRecord(value: unknown, sessionId: string): PersistedRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidRecord();
  const record = value as Record<string, unknown>;
  const expected = [
    'schema',
    'sessionId',
    'status',
    'controllerGeneration',
    'hostInstanceId',
    'clientId',
    'connectionGeneration',
    'interactionGeneration',
    'leaseUntilMs',
    'cleanupConfirmed',
    'updatedAt',
    'revision',
  ].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) invalidRecord();
  if (
    record.schema !== KITE_SESSION_EXECUTION_AUTHORITY_SCHEMA ||
    record.sessionId !== sessionId ||
    !isStatus(record.status) ||
    !isNonNegativeInteger(record.controllerGeneration) ||
    !isNullableIdentity(record.hostInstanceId) ||
    !isNullableIdentity(record.clientId) ||
    !isNonNegativeInteger(record.connectionGeneration) ||
    !isNonNegativeInteger(record.interactionGeneration) ||
    !isNullableNonNegativeInteger(record.leaseUntilMs) ||
    typeof record.cleanupConfirmed !== 'boolean' ||
    !isNonNegativeInteger(record.updatedAt) ||
    !isNonNegativeInteger(record.revision) ||
    (record.status === 'idle' &&
      (record.hostInstanceId !== null ||
        record.clientId !== null ||
        record.leaseUntilMs !== null ||
        !record.cleanupConfirmed)) ||
    ((record.status === 'active' || record.status === 'detached') &&
      (record.hostInstanceId === null ||
        record.leaseUntilMs === null ||
        record.cleanupConfirmed)) ||
    (record.status === 'recovery_required' &&
      (record.hostInstanceId !== null ||
        record.clientId !== null ||
        record.leaseUntilMs !== null ||
        record.cleanupConfirmed))
  ) {
    invalidRecord();
  }
  return record as unknown as PersistedRecord;
}

function validateOwnerRequest(request: {
  readonly expectedRevision: number;
  readonly controllerGeneration: number;
  readonly hostInstanceId: string;
}): void {
  assertRevision(request.expectedRevision);
  assertGeneration(request.controllerGeneration, 'Controller generation');
  assertIdentity(request.hostInstanceId, 'Host instance');
}

function validateBinding(binding: KiteSessionExecutionBinding): void {
  assertSessionId(binding.sessionId);
  assertGeneration(binding.controllerGeneration, 'Controller generation');
  assertIdentity(binding.hostInstanceId, 'Host instance');
  assertNullableIdentity(binding.clientId, 'Client');
  assertGeneration(binding.connectionGeneration, 'Connection generation');
  assertRevision(binding.expectedAuthorityRevision);
}

function assertExpectedRevision(current: PersistedRecord, expected: number): void {
  if (current.revision !== expected) {
    throw new KiteSessionExecutionAuthorityError(
      'revision_conflict',
      'Session execution authority revision has changed.',
    );
  }
}

function assertActiveOwner(
  current: PersistedRecord,
  expected: { readonly controllerGeneration: number; readonly hostInstanceId: string },
): void {
  if (current.status !== 'active') {
    throw new KiteSessionExecutionAuthorityError(
      'invalid_transition',
      'Session execution authority is not active.',
    );
  }
  assertCurrentOwner(current, expected);
}

function assertCurrentOwner(
  current: PersistedRecord,
  expected: { readonly controllerGeneration: number; readonly hostInstanceId: string },
): void {
  if (
    current.controllerGeneration !== expected.controllerGeneration ||
    current.hostInstanceId !== expected.hostInstanceId
  ) {
    throw new KiteSessionExecutionAuthorityError(
      'stale_generation',
      'Session execution generation is no longer owned by this Host.',
    );
  }
}

function assertSessionId(value: string): void {
  assertIdentity(value, 'Session');
}

function assertIdentity(value: string, label: string): void {
  if (!isIdentity(value)) invalid(`${label} identity is invalid.`);
}

function assertNullableIdentity(value: string | null, label: string): void {
  if (value !== null) assertIdentity(value, label);
}

function assertRevision(value: number): void {
  assertGeneration(value, 'Authority revision');
}

function assertGeneration(value: number, label: string): void {
  if (!isNonNegativeInteger(value)) invalid(`${label} is invalid.`);
}

function assertFutureLease(value: number, now: number): void {
  if (!isNonNegativeInteger(value) || value <= now) invalid('Session lease deadline is invalid.');
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/\p{Cc}/u.test(value)
  );
}

function isNullableIdentity(value: unknown): value is string | null {
  return value === null || isIdentity(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isStatus(value: unknown): value is KiteSessionExecutionStatus {
  return (
    value === 'idle' || value === 'active' || value === 'detached' || value === 'recovery_required'
  );
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) invalid('Session execution counter is exhausted.');
  return value + 1;
}

function invalid(message: string): never {
  throw new KiteSessionExecutionAuthorityError('invalid_input', message);
}

function invalidRecord(): never {
  throw new KiteSessionExecutionAuthorityError(
    'corrupt',
    'Session execution authority record is invalid.',
  );
}
