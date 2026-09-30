import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_BYTES = 96 * 1024;
const IDLE_MILLISECONDS = 60_000;

export class ModelContextSnapshotCursorError extends Error {
  readonly reason: 'invalid' | 'expired';

  constructor(reason: 'invalid' | 'expired') {
    super(`Model Context snapshot cursor ${reason}.`);
    this.reason = reason;
  }
}

interface Snapshot {
  readonly id: string;
  readonly owner: object;
  readonly path: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly totalBytes: number;
  lastUsed: number;
  expired: boolean;
}

export interface ModelContextSnapshotPage {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly offset: number;
  readonly totalBytes: number;
  readonly payloadBase64: string;
  readonly nextCursor?: string;
}

/** Private disk snapshots keep large diagnostics out of long-lived heap state. */
export class ModelContextPageSnapshots {
  #directory: string | undefined;
  readonly #snapshots = new Map<string, Snapshot>();
  #sweep: ReturnType<typeof setInterval> | undefined;

  create(input: {
    readonly owner: object;
    readonly sessionId: string;
    readonly invocationId: string;
    readonly sequence: number;
    readonly json: string;
  }): ModelContextSnapshotPage {
    const bytes = Buffer.from(input.json, 'utf8');
    const id = randomUUID();
    if (!this.#directory) this.#directory = mkdtempSync(join(tmpdir(), 'kite-model-context-'));
    const directory = this.#directory;
    const path = join(directory, id);
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
    } catch (error) {
      try {
        unlinkSync(path);
      } catch {
        // The original write error is authoritative; sweep retries cleanup.
      }
      throw error;
    } finally {
      closeSync(fd);
    }
    const snapshot: Snapshot = {
      id,
      owner: input.owner,
      path,
      sessionId: input.sessionId,
      invocationId: input.invocationId,
      sequence: input.sequence,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      totalBytes: bytes.length,
      lastUsed: Date.now(),
      expired: false,
    };
    this.#snapshots.set(id, snapshot);
    if (!this.#sweep) {
      this.#sweep = setInterval(() => this.sweep(), IDLE_MILLISECONDS);
      this.#sweep.unref?.();
    }
    return this.#page(snapshot, 0);
  }

  read(
    owner: object,
    sessionId: string,
    invocationId: string,
    cursor: string,
  ): ModelContextSnapshotPage {
    const decoded = decodeCursor(cursor);
    const snapshot = this.#snapshots.get(decoded.id);
    if (!snapshot || snapshot.expired) throw new ModelContextSnapshotCursorError('expired');
    if (
      snapshot.owner !== owner ||
      snapshot.sessionId !== sessionId ||
      snapshot.invocationId !== invocationId
    ) {
      throw new ModelContextSnapshotCursorError('invalid');
    }
    if (decoded.sha256 !== snapshot.sha256 || decoded.offset >= snapshot.totalBytes) {
      throw new ModelContextSnapshotCursorError('invalid');
    }
    return this.#page(snapshot, decoded.offset);
  }

  #page(snapshot: Snapshot, offset: number): ModelContextSnapshotPage {
    const length = Math.min(PAGE_BYTES, snapshot.totalBytes - offset);
    const chunk = Buffer.allocUnsafe(length);
    const fd = openSync(snapshot.path, 'r');
    try {
      if (
        fstatSync(fd).size !== snapshot.totalBytes ||
        readSync(fd, chunk, 0, length, offset) !== length
      ) {
        throw new ModelContextSnapshotCursorError('expired');
      }
    } finally {
      closeSync(fd);
    }
    snapshot.lastUsed = Date.now();
    const nextOffset = offset + length;
    return {
      sessionId: snapshot.sessionId,
      invocationId: snapshot.invocationId,
      sequence: snapshot.sequence,
      snapshotId: snapshot.id,
      sha256: snapshot.sha256,
      offset,
      totalBytes: snapshot.totalBytes,
      payloadBase64: chunk.toString('base64'),
      ...(nextOffset < snapshot.totalBytes
        ? { nextCursor: encodeCursor(snapshot.id, nextOffset, snapshot.sha256) }
        : {}),
    };
  }

  sweep(now = Date.now()): void {
    for (const snapshot of this.#snapshots.values()) {
      if (now - snapshot.lastUsed < IDLE_MILLISECONDS) continue;
      snapshot.expired = true;
      try {
        unlinkSync(snapshot.path);
        this.#snapshots.delete(snapshot.id);
      } catch {
        // Cache cleanup is best effort and never blocks a fresh source read.
      }
    }
    this.#closeEmptyDirectory();
  }

  dispose(owner?: object): void {
    if (owner === undefined && this.#sweep) clearInterval(this.#sweep);
    if (owner === undefined) this.#sweep = undefined;
    for (const snapshot of this.#snapshots.values()) {
      if (owner !== undefined && snapshot.owner !== owner) continue;
      snapshot.expired = true;
      try {
        unlinkSync(snapshot.path);
        this.#snapshots.delete(snapshot.id);
      } catch {
        // An inaccessible private cache file does not deny source reads.
      }
    }
    this.#closeEmptyDirectory();
  }

  #closeEmptyDirectory(): void {
    if (!this.#directory || this.#snapshots.size > 0) return;
    try {
      if (readdirSync(this.#directory).length === 0) {
        rmdirSync(this.#directory);
        this.#directory = undefined;
        if (this.#sweep) clearInterval(this.#sweep);
        this.#sweep = undefined;
      }
    } catch {
      // A later sweep can reclaim an inaccessible cache directory.
    }
  }
}

function encodeCursor(id: string, offset: number, sha256: string): string {
  return Buffer.from(JSON.stringify({ id, offset, sha256 }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { id: string; offset: number; sha256: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.keys(value).sort().join(',') !== 'id,offset,sha256'
    ) {
      throw new Error('Invalid cursor shape.');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(record.id) ||
      typeof record.offset !== 'number' ||
      !Number.isSafeInteger(record.offset) ||
      record.offset <= 0 ||
      typeof record.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) {
      throw new Error('Invalid cursor values.');
    }
    return { id: record.id, offset: record.offset, sha256: record.sha256 };
  } catch {
    throw new ModelContextSnapshotCursorError('invalid');
  }
}
