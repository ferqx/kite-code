import type { Database } from 'bun:sqlite';
import { KiteHomeWriteError } from './kite-home-write';
import type {
  KiteSessionExecutionAuthority,
  KiteSessionExecutionAuthorityRecord,
  KiteSessionExecutionBinding,
} from './kite-session-execution-authority';
import type { KiteSessionMutationInput, KiteSessionMutationPort } from './kite-session-mutation';

export type KiteSessionEffectState = 'prepared' | 'terminal' | 'unknown';

export interface KiteSessionEffectRecord {
  readonly sessionId: string;
  readonly effectId: string;
  readonly ownerId: string;
  readonly leaseRevision: number;
  readonly certainty: 'certain' | 'uncertain';
  readonly expiresAtMs: number;
  readonly controllerGeneration: number;
  readonly hostInstanceId: string;
  readonly clientId: string | null;
  readonly connectionGeneration: number;
  readonly state: KiteSessionEffectState;
  readonly outcome: 'succeeded' | 'failed' | 'unknown' | null;
  readonly terminalDigest: string | null;
  readonly updatedAt: number;
}

export type KiteSessionEffectErrorCode = 'invalid_input' | 'identity_conflict' | 'stale_effect';

export class KiteSessionEffectError extends Error {
  readonly code: KiteSessionEffectErrorCode;

  constructor(code: KiteSessionEffectErrorCode, message: string) {
    super(message);
    this.name = 'KiteSessionEffectError';
    this.code = code;
  }
}

export interface KiteSessionEffectPort {
  prepare(
    input: KiteSessionMutationInput & {
      readonly effectId: string;
      readonly ownerId: string;
      readonly expiresAtMs: number;
    },
  ): { readonly status: 'prepared' | 'existing'; readonly effect: KiteSessionEffectRecord };
  renew(
    input: KiteSessionMutationInput & {
      readonly effectId: string;
      readonly ownerId: string;
      readonly expectedLeaseRevision: number;
      readonly expiresAtMs: number;
    },
  ): KiteSessionEffectRecord;
  assertDispatchable(
    input: KiteSessionExecutionBinding & {
      readonly effectId: string;
      readonly ownerId: string;
      readonly expectedLeaseRevision: number;
    },
  ): void;
  commitTerminal(
    input: KiteSessionMutationInput & {
      readonly effectId: string;
      readonly ownerId: string;
      readonly expectedLeaseRevision: number;
      readonly outcome: 'succeeded' | 'failed';
      readonly terminalDigest: string;
    },
  ): KiteSessionEffectRecord;
  markOutcomeUnknown(
    input: KiteSessionMutationInput & {
      readonly effectId: string;
      readonly ownerId: string;
      readonly expectedLeaseRevision: number;
    },
  ): {
    readonly effect: KiteSessionEffectRecord;
    readonly authority: KiteSessionExecutionAuthorityRecord;
  };
  inspect(sessionId: string, effectId: string): KiteSessionEffectRecord | null;
}

interface EffectRow {
  readonly session_id: string;
  readonly effect_id: string;
  readonly owner_id: string;
  readonly lease_revision: number;
  readonly certainty: 'certain' | 'uncertain';
  readonly expires_at_ms: number;
  readonly controller_generation: number;
  readonly host_instance_id: string;
  readonly client_id: string | null;
  readonly connection_generation: number;
  readonly state: KiteSessionEffectState;
  readonly outcome: 'succeeded' | 'failed' | 'unknown' | null;
  readonly terminal_digest: string | null;
  readonly updated_at: number;
}

export function createKiteSessionEffectPort(input: {
  readonly database: Database;
  readonly mutations: KiteSessionMutationPort;
  readonly authority: KiteSessionExecutionAuthority;
  readonly nowMs?: () => number;
}): KiteSessionEffectPort {
  const now = input.nowMs ?? Date.now;
  const select = input.database.query<EffectRow, [string, string]>(
    'SELECT * FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? LIMIT 1',
  );
  const insert = input.database.query(
    `INSERT INTO runtime_effect_leases(
      session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms,
      controller_generation, host_instance_id, client_id, connection_generation,
      state, outcome, terminal_digest, updated_at
    ) VALUES (?, ?, ?, 1, 'certain', ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?)`,
  );
  const renewRow = input.database.query(
    `UPDATE runtime_effect_leases
      SET lease_revision = ?, expires_at_ms = ?, updated_at = ?
      WHERE session_id = ? AND effect_id = ?`,
  );
  const terminalRow = input.database.query(
    `UPDATE runtime_effect_leases
      SET state = 'terminal', outcome = ?, terminal_digest = ?, updated_at = ?
      WHERE session_id = ? AND effect_id = ?`,
  );
  const unknownRow = input.database.query(
    `UPDATE runtime_effect_leases
      SET state = 'unknown', outcome = 'unknown', certainty = 'uncertain',
        terminal_digest = NULL, updated_at = ?
      WHERE session_id = ? AND effect_id = ?`,
  );

  const inspect = (sessionId: string, effectId: string): KiteSessionEffectRecord | null => {
    assertIdentity(sessionId, 'Session');
    assertIdentity(effectId, 'Effect');
    const row = select.get(sessionId, effectId);
    return row ? record(row) : null;
  };

  const prepare: KiteSessionEffectPort['prepare'] = (request) => {
    assertIdentity(request.effectId, 'Effect');
    assertIdentity(request.ownerId, 'Effect owner');
    assertFuture(request.expiresAtMs, now());
    return runEffectMutation(input.mutations, request, () => {
      const existing = select.get(request.sessionId, request.effectId);
      if (existing) {
        assertEffectIdentity(existing, request);
        return { status: 'existing', effect: record(existing) };
      }
      insert.run(
        request.sessionId,
        request.effectId,
        request.ownerId,
        request.expiresAtMs,
        request.controllerGeneration,
        request.hostInstanceId,
        request.clientId,
        request.connectionGeneration,
        now(),
      );
      const prepared = select.get(request.sessionId, request.effectId);
      if (!prepared) stale('Prepared effect was not committed.');
      return { status: 'prepared', effect: record(prepared) };
    });
  };

  const renew: KiteSessionEffectPort['renew'] = (request) => {
    assertLeaseRequest(request);
    assertFuture(request.expiresAtMs, now());
    return runEffectMutation(input.mutations, request, () => {
      const current = requiredEffect(select, request);
      assertEffectIdentity(current, request);
      if (
        current.state !== 'prepared' ||
        current.certainty !== 'certain' ||
        current.lease_revision !== request.expectedLeaseRevision ||
        current.expires_at_ms <= now()
      ) {
        stale('Effect lease is no longer renewable.');
      }
      renewRow.run(
        increment(current.lease_revision),
        request.expiresAtMs,
        now(),
        request.sessionId,
        request.effectId,
      );
      return record(requiredEffect(select, request));
    });
  };

  const assertDispatchable: KiteSessionEffectPort['assertDispatchable'] = (request) => {
    assertLeaseRequest(request);
    input.mutations.assertDispatchable(request);
    const current = requiredEffect(select, request);
    assertEffectIdentity(current, request);
    if (
      current.state !== 'prepared' ||
      current.certainty !== 'certain' ||
      current.lease_revision !== request.expectedLeaseRevision ||
      current.expires_at_ms <= now()
    ) {
      stale('Effect is no longer dispatchable.');
    }
  };

  const commitTerminal: KiteSessionEffectPort['commitTerminal'] = (request) => {
    assertLeaseRequest(request);
    if (request.outcome !== 'succeeded' && request.outcome !== 'failed') {
      invalid('Effect terminal outcome is invalid.');
    }
    assertDigest(request.terminalDigest);
    return runEffectMutation(input.mutations, request, () => {
      const current = requiredEffect(select, request);
      assertEffectIdentity(current, request);
      if (
        current.state !== 'prepared' ||
        current.certainty !== 'certain' ||
        current.lease_revision !== request.expectedLeaseRevision ||
        current.expires_at_ms <= now()
      ) {
        stale('Effect terminal evidence is stale.');
      }
      terminalRow.run(
        request.outcome,
        request.terminalDigest,
        now(),
        request.sessionId,
        request.effectId,
      );
      return record(requiredEffect(select, request));
    });
  };

  const markOutcomeUnknown: KiteSessionEffectPort['markOutcomeUnknown'] = (request) => {
    assertLeaseRequest(request);
    return runEffectMutation(input.mutations, request, () => {
      const current = requiredEffect(select, request);
      assertEffectIdentity(current, request);
      if (
        current.state !== 'prepared' ||
        current.certainty !== 'certain' ||
        current.lease_revision !== request.expectedLeaseRevision
      ) {
        stale('Effect outcome can no longer be marked unknown.');
      }
      unknownRow.run(now(), request.sessionId, request.effectId);
      const effect = record(requiredEffect(select, request));
      const authority = input.authority.markRecoveryRequiredInTransaction(request);
      return { effect, authority };
    });
  };

  return Object.freeze({
    prepare,
    renew,
    assertDispatchable,
    commitTerminal,
    markOutcomeUnknown,
    inspect,
  });
}

function runEffectMutation<Result>(
  mutations: KiteSessionMutationPort,
  request: KiteSessionMutationInput,
  operation: () => Result,
): Result {
  try {
    return mutations.run(request, operation);
  } catch (error) {
    if (
      error instanceof KiteHomeWriteError &&
      error.code === 'write_failed' &&
      error.cause instanceof KiteSessionEffectError
    ) {
      throw error.cause;
    }
    throw error;
  }
}

function requiredEffect(
  select: { get(sessionId: string, effectId: string): EffectRow | null },
  request: { readonly sessionId: string; readonly effectId: string },
): EffectRow {
  const current = select.get(request.sessionId, request.effectId);
  if (!current) stale('Effect preparation is missing.');
  return current;
}

function assertEffectIdentity(
  row: EffectRow,
  request: KiteSessionExecutionBinding & { readonly ownerId: string },
): void {
  if (
    row.owner_id !== request.ownerId ||
    row.controller_generation !== request.controllerGeneration ||
    row.host_instance_id !== request.hostInstanceId ||
    row.client_id !== request.clientId ||
    row.connection_generation !== request.connectionGeneration
  ) {
    throw new KiteSessionEffectError(
      'identity_conflict',
      'Effect identity belongs to another Session execution generation.',
    );
  }
}

function record(row: EffectRow): KiteSessionEffectRecord {
  return Object.freeze({
    sessionId: row.session_id,
    effectId: row.effect_id,
    ownerId: row.owner_id,
    leaseRevision: row.lease_revision,
    certainty: row.certainty,
    expiresAtMs: row.expires_at_ms,
    controllerGeneration: row.controller_generation,
    hostInstanceId: row.host_instance_id,
    clientId: row.client_id,
    connectionGeneration: row.connection_generation,
    state: row.state,
    outcome: row.outcome,
    terminalDigest: row.terminal_digest,
    updatedAt: row.updated_at,
  });
}

function assertLeaseRequest(request: {
  readonly sessionId: string;
  readonly effectId: string;
  readonly ownerId: string;
  readonly expectedLeaseRevision: number;
}): void {
  assertIdentity(request.sessionId, 'Session');
  assertIdentity(request.effectId, 'Effect');
  assertIdentity(request.ownerId, 'Effect owner');
  if (!Number.isSafeInteger(request.expectedLeaseRevision) || request.expectedLeaseRevision < 1) {
    invalid('Effect lease revision is invalid.');
  }
}

function assertIdentity(value: string, label: string): void {
  if (!value || value.length > 256 || /\p{Cc}/u.test(value))
    invalid(`${label} identity is invalid.`);
}

function assertFuture(value: number, now: number): void {
  if (!Number.isSafeInteger(value) || value <= now) invalid('Effect lease deadline is invalid.');
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) invalid('Effect terminal digest is invalid.');
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) invalid('Effect lease revision is exhausted.');
  return value + 1;
}

function invalid(message: string): never {
  throw new KiteSessionEffectError('invalid_input', message);
}

function stale(message: string): never {
  throw new KiteSessionEffectError('stale_effect', message);
}
