import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SINGLE_HOST_OWNER_SCHEMA_V2 = 'kite.runtime-single-host-owner.v2' as const;

interface SingleHostOwnerRecordV2 {
  readonly schema: typeof SINGLE_HOST_OWNER_SCHEMA_V2;
  readonly ownerId: string;
  readonly pid: number;
}

export interface SingleHostLeaseV1 {
  readonly ownerId: string;
  readonly path: string;
  readonly release: () => void;
}

/** Installation/workspace bootstrap invariant: one Runtime Host owner at a time. */
export function acquireSingleHostInvariantV1(input: {
  readonly authorityPath: string;
  readonly ownerId?: string;
}): SingleHostLeaseV1 {
  const path = `${input.authorityPath}.kite-host.lock`;
  const ownerId = input.ownerId ?? `host_${randomUUID()}`;
  const owner = Object.freeze({
    schema: SINGLE_HOST_OWNER_SCHEMA_V2,
    ownerId,
    pid: process.pid,
  }) satisfies SingleHostOwnerRecordV2;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
      writeFileSync(join(path, 'owner'), `${JSON.stringify(owner)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      break;
    } catch (error) {
      if (created) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      if (attempt === 0 && reclaimDeadOwner(path)) continue;
      throw new Error(`Runtime Host single-host invariant rejected: ${readOwner(path, error)}.`);
    }
  }
  let released = false;
  return Object.freeze({
    ownerId,
    path,
    release: () => {
      if (released) return;
      const current = readOwnerRecord(path);
      if (current.ownerId !== ownerId || current.pid !== process.pid) {
        throw new Error('Runtime Host lease owner changed.');
      }
      rmSync(path, { recursive: true, force: false });
      released = true;
    },
  });
}

function readOwner(path: string, error: unknown): string {
  try {
    return readOwnerRecord(path).ownerId;
  } catch {
    return error instanceof Error ? error.message : 'another host';
  }
}

function reclaimDeadOwner(path: string): boolean {
  let owner: SingleHostOwnerRecordV2;
  try {
    owner = readOwnerRecord(path);
  } catch {
    return false;
  }
  if (isProcessAlive(owner.pid)) return false;
  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
  } catch {
    return false;
  }
  try {
    const quarantinedOwner = readOwnerRecord(quarantine);
    if (quarantinedOwner.ownerId !== owner.ownerId || quarantinedOwner.pid !== owner.pid) {
      throw new Error('Runtime Host stale lease identity changed during reclamation.');
    }
    rmSync(quarantine, { recursive: true, force: false });
    return true;
  } catch (error) {
    try {
      renameSync(quarantine, path);
    } catch {
      // Preserve the quarantined evidence when another owner won the path.
    }
    throw error;
  }
}

function readOwnerRecord(path: string): SingleHostOwnerRecordV2 {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(path, 'owner'), 'utf8'));
  } catch (error) {
    throw new Error('Runtime Host lease owner record is invalid.', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime Host lease owner record is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== ['ownerId', 'pid', 'schema'].join('\0') ||
    record.schema !== SINGLE_HOST_OWNER_SCHEMA_V2 ||
    typeof record.ownerId !== 'string' ||
    !record.ownerId ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0
  ) {
    throw new Error('Runtime Host lease owner record is invalid.');
  }
  return record as unknown as SingleHostOwnerRecordV2;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
