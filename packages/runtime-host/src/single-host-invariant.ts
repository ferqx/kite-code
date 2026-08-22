import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    throw new Error(`Runtime Host single-host invariant rejected: ${readOwner(path, error)}.`);
  }
  writeFileSync(join(path, 'owner'), `${ownerId}\n`, { mode: 0o600 });
  let released = false;
  return Object.freeze({
    ownerId,
    path,
    release: () => {
      if (released) return;
      released = true;
      const current = readFileSync(join(path, 'owner'), 'utf8').trim();
      if (current !== ownerId) throw new Error('Runtime Host lease owner changed.');
      rmSync(path, { recursive: true, force: false });
    },
  });
}

function readOwner(path: string, error: unknown): string {
  try {
    return readFileSync(join(path, 'owner'), 'utf8').trim() || 'another host';
  } catch {
    return error instanceof Error ? error.message : 'another host';
  }
}
