import type { Database } from 'bun:sqlite';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';

const prefix = 'workspace_deletion:';
const activeClaims = new Map<string, WeakRef<Database>>();

type FenceRecord = {
  readonly token: string;
  readonly claimId: string;
  readonly pid: number;
  readonly phase: 'running' | 'completed';
};

export function workspaceDeletionFenceKey(workspaceId: string): string {
  if (!/^workspace_[a-f0-9]{64}$/u.test(workspaceId))
    throw new TypeError('Workspace deletion fence requires a valid Workspace ID.');
  return `${prefix}${workspaceId}`;
}

export function createKiteWorkspaceDeletionFence(
  database: Database,
  writer: KiteHomeWriteTransactionPort,
) {
  const read = database.query<{ value: string }, [string]>(
    'SELECT value FROM kite_meta WHERE key=?',
  );
  const parse = (value: string): FenceRecord | null => {
    try {
      const record: unknown = JSON.parse(value);
      if (
        typeof record === 'object' &&
        record !== null &&
        'token' in record &&
        typeof record.token === 'string' &&
        record.token.length > 0 &&
        record.token.length <= 256 &&
        'claimId' in record &&
        typeof record.claimId === 'string' &&
        record.claimId.length > 0 &&
        record.claimId.length <= 256 &&
        'pid' in record &&
        typeof record.pid === 'number' &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        'phase' in record &&
        (record.phase === 'running' || record.phase === 'completed')
      )
        return record as FenceRecord;
    } catch {
      /* An invalid record cannot authorize removal or release. */
    }
    return null;
  };
  const current = (key: string): FenceRecord | null => {
    const value = read.get(key)?.value;
    return value === undefined ? null : parse(value);
  };
  const processIsAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const localClaimIsActive = (claimId: string): boolean => {
    const owner = activeClaims.get(claimId)?.deref();
    if (!owner) return false;
    try {
      owner.query('SELECT 1').get();
      return true;
    } catch {
      activeClaims.delete(claimId);
      return false;
    }
  };
  return Object.freeze({
    begin(workspaceId: string, token: string, claimId: string): 'acquired' | 'completed' {
      const key = workspaceDeletionFenceKey(workspaceId);
      if (!token || token.length > 256 || !claimId || claimId.length > 256)
        throw new TypeError('Workspace deletion token or claim is invalid.');
      return writer.run(() => {
        const persisted = read.get(key)?.value;
        const previous = persisted === undefined ? null : parse(persisted);
        if (persisted !== undefined && !previous)
          throw new Error('Workspace deletion fence record is invalid.');
        if (
          previous?.phase === 'running' &&
          (previous.pid === process.pid
            ? localClaimIsActive(previous.claimId)
            : processIsAlive(previous.pid))
        )
          throw new Error('Workspace removal is already in progress.');
        const next: FenceRecord =
          previous?.phase === 'completed'
            ? { ...previous, token }
            : { token, claimId, pid: process.pid, phase: 'running' };
        database
          .query(
            'INSERT INTO kite_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(key, JSON.stringify(next));
        if (next.phase === 'running') activeClaims.set(claimId, new WeakRef(database));
        return next.phase === 'completed' ? 'completed' : 'acquired';
      });
    },
    complete(workspaceId: string, claimId: string): void {
      const key = workspaceDeletionFenceKey(workspaceId);
      writer.run(() => {
        const previous = current(key);
        if (previous?.phase !== 'running' || previous.claimId !== claimId)
          throw new Error('Workspace deletion claim changed before completion.');
        database
          .query('UPDATE kite_meta SET value=? WHERE key=?')
          .run(JSON.stringify({ ...previous, phase: 'completed' }), key);
        activeClaims.delete(claimId);
      });
    },
    abandon(workspaceId: string, claimId: string): void {
      const key = workspaceDeletionFenceKey(workspaceId);
      writer.run(() => {
        const previous = current(key);
        if (previous?.phase === 'running' && previous.claimId === claimId)
          database.query('DELETE FROM kite_meta WHERE key=?').run(key);
        activeClaims.delete(claimId);
      });
    },
    end(workspaceId: string, token: string): void {
      const key = workspaceDeletionFenceKey(workspaceId);
      writer.run(() => {
        const previous = current(key);
        if (previous?.phase !== 'completed' || previous.token !== token)
          throw new Error('Workspace deletion has not completed for this token.');
        database.query('DELETE FROM kite_meta WHERE key=?').run(key);
      });
    },
    isActive(workspaceId: string): boolean {
      return !!read.get(workspaceDeletionFenceKey(workspaceId));
    },
    owns(workspaceId: string, claimId: string): boolean {
      const previous = current(workspaceDeletionFenceKey(workspaceId));
      return previous?.phase === 'running' && previous.claimId === claimId;
    },
  });
}
