import type { Database } from 'bun:sqlite';
import type { EffectLeasePort } from '@kite-ai/runtime-host/storage';

export interface SqliteEffectLeaseStore {
  readonly port: EffectLeasePort;
  hasLease(sessionId: string, effectId: string, ownerId: string, observedAtMs: number): boolean;
}

export function createSqliteEffectLeaseStore(
  db: Database,
  isClosed: () => boolean,
  beforeWrite?: () => void,
): SqliteEffectLeaseStore {
  const deleteExpired = db.query(
    'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND expires_at_ms <= ?',
  );
  const insert = db.query(
    "INSERT OR IGNORE INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, 0, 'certain', ?)",
  );
  const select = db.query<{ owner_id: string }, [string, string, string, number]>(
    'SELECT owner_id FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
  );
  const renew = db.query(
    'UPDATE runtime_effect_leases SET expires_at_ms = ?, lease_revision = lease_revision + 1 WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
  );
  const release = db.query(
    'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ?',
  );
  const hasLease = (sessionId: string, effectId: string, ownerId: string, observedAtMs: number) =>
    Boolean(select.get(sessionId, effectId, ownerId, observedAtMs));
  const port: EffectLeasePort = Object.freeze({
    tryAcquireEffectLease: (
      sessionId: string,
      effectId: string,
      ownerId: string,
      expiresAtMs: number,
    ): boolean => {
      if (isClosed() || expiresAtMs <= Date.now()) return false;
      const now = Date.now();
      beforeWrite?.();
      return db.transaction(() => {
        deleteExpired.run(sessionId, effectId, now);
        insert.run(sessionId, effectId, ownerId, expiresAtMs);
        return hasLease(sessionId, effectId, ownerId, now);
      })();
    },
    renewEffectLease: (
      sessionId: string,
      effectId: string,
      ownerId: string,
      expiresAtMs: number,
    ): boolean => {
      if (isClosed() || expiresAtMs <= Date.now()) return false;
      const now = Date.now();
      beforeWrite?.();
      renew.run(expiresAtMs, sessionId, effectId, ownerId, now);
      return hasLease(sessionId, effectId, ownerId, now);
    },
    releaseEffectLease: (sessionId: string, effectId: string, ownerId: string): void => {
      if (!isClosed()) {
        beforeWrite?.();
        release.run(sessionId, effectId, ownerId);
      }
    },
  });
  return Object.freeze({ port, hasLease });
}
