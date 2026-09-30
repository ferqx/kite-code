import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RuntimeHistorySessionTranscript,
  RuntimeLogSessionEntry,
} from '@kite-ai/runtime-contract';
import { historyTranscriptPage, type KiteHistoryPage } from './history-page';

type SnapshotMetadata = Omit<RuntimeHistorySessionTranscript, 'records' | 'events'>;
type PageLocation = Readonly<{
  lastSequence: number;
  offset: number;
  length: number;
  digest: string;
}>;
type Snapshot = {
  readonly path: string;
  readonly metadata: SnapshotMetadata;
  readonly pages: readonly PageLocation[];
  readonly rawPrefixDigest: string | null;
  readonly appendProof?: HistoryAppendProof;
  historyGeneration: number;
  expiresAt: number;
};

export type HistoryAppendProof = Readonly<{ rewriteGeneration: number; instanceId: string }>;
function validAppendProof(proof: HistoryAppendProof | undefined): proof is HistoryAppendProof {
  return (
    !!proof &&
    Number.isSafeInteger(proof.rewriteGeneration) &&
    proof.rewriteGeneration >= 0 &&
    /^[a-f0-9]{32}$/u.test(proof.instanceId)
  );
}

const SNAPSHOT_IDLE_MS = 30_000;
const MAX_SNAPSHOTS = 256;

/** Worker-local disposable projections. The parent owns cleanup after worker exit. */
export class HistoryPageSnapshotCache {
  readonly #entries = new Map<string, Snapshot>();
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  get(
    key: string,
    session: RuntimeLogSessionEntry,
    historyGeneration: number | undefined,
    fingerprintPrefix: () => string | null,
    afterSequence?: number,
    appendProof?: HistoryAppendProof,
  ): KiteHistoryPage | undefined {
    const snapshot = this.#entries.get(key);
    if (!snapshot) return undefined;
    if (
      snapshot.expiresAt <= Date.now() ||
      !Number.isSafeInteger(historyGeneration) ||
      historyGeneration! < 0
    ) {
      this.#delete(key);
      return undefined;
    }
    const tailOnly =
      validAppendProof(appendProof) &&
      validAppendProof(snapshot.appendProof) &&
      appendProof.instanceId === snapshot.appendProof.instanceId &&
      appendProof.rewriteGeneration === snapshot.appendProof.rewriteGeneration &&
      historyGeneration! >= snapshot.historyGeneration;
    if (snapshot.historyGeneration !== historyGeneration && !tailOnly) {
      let digest: string | null = null;
      try {
        digest = fingerprintPrefix();
      } catch {
        // Missing proof requires a fresh source projection.
      }
      if (!snapshot.rawPrefixDigest || digest !== snapshot.rawPrefixDigest) {
        this.#delete(key);
        return undefined;
      }
    }
    snapshot.historyGeneration = historyGeneration!;
    try {
      const cursor = afterSequence ?? 0;
      let low = 0;
      let high = snapshot.pages.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (snapshot.pages[middle]!.lastSequence <= cursor) low = middle + 1;
        else high = middle;
      }
      const location = snapshot.pages[low];
      let records: RuntimeHistorySessionTranscript['records'] = [];
      if (location) {
        const fd = openSync(snapshot.path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(location.length);
          readAll(fd, buffer, location.offset);
          if (createHash('sha256').update(buffer).digest('hex') !== location.digest)
            throw new Error('History snapshot page changed.');
          records = JSON.parse(buffer.toString('utf8'));
        } finally {
          closeSync(fd);
        }
      }
      // Reapply byte pagination with fresh Session metadata; a renamed Session
      // can make an old page envelope larger without changing its content digest.
      const page = historyTranscriptPage(
        { ...snapshot.metadata, session, records, events: [] },
        cursor,
      );
      snapshot.expiresAt = Date.now() + SNAPSHOT_IDLE_MS;
      this.#entries.delete(key);
      this.#entries.set(key, snapshot);
      if (page.nextCursor !== undefined || low + 1 >= snapshot.pages.length) return page;
      return { ...page, nextCursor: page.records.at(-1)!.sequence };
    } catch {
      // A lost or damaged disposable file must not deny a valid journal read.
      this.#delete(key);
      return undefined;
    }
  }

  set(
    key: string,
    transcript: RuntimeHistorySessionTranscript,
    historyGeneration: number | undefined,
    rawPrefixDigest: string | null,
    appendProof?: HistoryAppendProof,
  ): void {
    this.#delete(key);
    if (
      !Number.isSafeInteger(historyGeneration) ||
      historyGeneration! < 0 ||
      (!rawPrefixDigest && !validAppendProof(appendProof))
    )
      return;
    const path = join(this.directory, `${randomUUID()}.pages`);
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      const pages: PageLocation[] = [];
      let afterSequence = 0;
      let offset = 0;
      for (;;) {
        const page = historyTranscriptPage(transcript, afterSequence);
        if (page.records.length > 0) {
          const bytes = Buffer.from(JSON.stringify(page.records), 'utf8');
          writeAll(fd, bytes, offset);
          pages.push({
            lastSequence: page.records.at(-1)!.sequence,
            offset,
            length: bytes.byteLength,
            digest: createHash('sha256').update(bytes).digest('hex'),
          });
          offset += bytes.byteLength;
        }
        if (page.nextCursor === undefined) break;
        afterSequence = page.nextCursor;
      }
      closeSync(fd);
      fd = undefined;
      const { records: _records, events: _events, ...metadata } = transcript;
      this.#entries.set(key, {
        path,
        metadata,
        pages,
        historyGeneration: historyGeneration!,
        rawPrefixDigest,
        ...(validAppendProof(appendProof) ? { appendProof } : {}),
        expiresAt: Date.now() + SNAPSHOT_IDLE_MS,
      });
      this.#prune();
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* Disposable cache cleanup. */
        }
      }
      removeDisposableFile(path);
    }
  }

  dispose(): void {
    for (const key of this.#entries.keys()) this.#delete(key);
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, snapshot] of this.#entries) {
      if (snapshot.expiresAt <= now) this.#delete(key);
    }
    while (this.#entries.size > MAX_SNAPSHOTS) {
      this.#delete(this.#entries.keys().next().value!);
    }
  }

  #delete(key: string): void {
    const snapshot = this.#entries.get(key);
    if (!snapshot) return;
    this.#entries.delete(key);
    removeDisposableFile(snapshot.path);
  }
}

function removeDisposableFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* Parent reclaims the private directory after worker exit. */
  }
}

function writeAll(fd: number, bytes: Buffer, position: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(fd, bytes, written, bytes.byteLength - written, position + written);
    if (count <= 0) throw new Error('History snapshot write failed.');
    written += count;
  }
}

function readAll(fd: number, bytes: Buffer, position: number): void {
  let read = 0;
  while (read < bytes.byteLength) {
    const count = readSync(fd, bytes, read, bytes.byteLength - read, position + read);
    if (count <= 0) throw new Error('History snapshot read failed.');
    read += count;
  }
}
