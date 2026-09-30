import { once } from 'node:events';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';
import { openKiteHistoryPageReader } from '../bootstrap';
import {
  createKiteRuntimeObserverHistoryClient,
  resolveKiteHistorySession,
} from './history-adapter';
import { historyTranscriptPage } from './history-page';
import type { KiteHistoryWorkerRequest, KiteHistoryWorkerResponse } from './history-page-pool';
import { HistoryPageSnapshotCache } from './history-page-snapshots';

const MAX_INPUT_FRAME_BYTES = 65_536;
const MAX_FULL_RESULT_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes - 65_536;

function readFailure(error: unknown): { readonly code: string; readonly message: string } {
  const raw =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const code =
    raw === 'session_not_found' ||
    raw === 'history_snapshot_changed' ||
    raw === 'history_too_large' ||
    raw === 'temporarily_unavailable' ||
    raw === 'corrupt_event' ||
    raw === 'invalid_request'
      ? raw
      : 'session_unavailable';
  return { code, message: 'History read failed.' };
}

export function isHistoryPageWorker(args: readonly string[] = process.argv.slice(2)): boolean {
  return args.length === 1 && args[0] === '--kite-internal-history-page-v1';
}

/** Private JSONL child mode. The parent supplies only its owner-derived Store path. */
export async function runHistoryPageWorker(): Promise<void> {
  let activeReader: ReturnType<typeof openKiteHistoryPageReader> | undefined;
  let snapshots: HistoryPageSnapshotCache | undefined;
  const history = createKiteRuntimeObserverHistoryClient(
    () => {
      if (!activeReader) throw new Error('History reader is unavailable.');
      return {
        getSession: activeReader.logs.getSession,
        listSessions: activeReader.logs.listSessions,
        listEvents: activeReader.logs.listEvents,
        close: () => undefined,
      };
    },
    (parentSessionId, childSessionId) => {
      if (!activeReader) throw new Error('History reader is unavailable.');
      return activeReader.childLogs(parentSessionId, childSessionId);
    },
    {
      // Pages are retained on disk, not as a second complete in-memory transcript.
      maxCacheBytes: 0,
    },
  );
  const handle = async (
    message: KiteHistoryWorkerRequest & {
      readonly databasePath: string;
      readonly snapshotDirectory: string;
    },
  ): Promise<KiteHistoryWorkerResponse> => {
    let response: KiteHistoryWorkerResponse;
    let began = false;
    try {
      activeReader = openKiteHistoryPageReader(message.databasePath);
      activeReader.database.run('BEGIN');
      began = true;
      if ('search' in message) {
        const sessions = await history.listSessions(message.search);
        response =
          Buffer.byteLength(JSON.stringify(sessions), 'utf8') > MAX_FULL_RESULT_BYTES
            ? {
                id: message.id,
                failure: {
                  code: 'history_too_large',
                  message: 'History search exceeds one frame.',
                },
              }
            : { id: message.id, sessions };
      } else {
        const request = message.request;
        if (!message.full) {
          const logs = request.parentSessionId
            ? activeReader.childLogs(request.parentSessionId, request.sessionId)
            : activeReader.logs;
          const source = resolveKiteHistorySession(
            logs,
            request.sessionId,
            request.throughSequence,
          );
          const key = JSON.stringify([
            message.databasePath,
            request.parentSessionId ?? null,
            request.sessionId,
            source.historyInstanceId ?? null,
            source.entry.lastSequence,
          ]);
          snapshots ??= new HistoryPageSnapshotCache(message.snapshotDirectory);
          const appendProof =
            source.historyRewriteGeneration !== undefined && source.historyInstanceId
              ? {
                  rewriteGeneration: source.historyRewriteGeneration,
                  instanceId: source.historyInstanceId,
                }
              : undefined;
          const fingerprint = () =>
            activeReader!.fingerprintEventRows(
              request.sessionId,
              source.entry.lastSequence,
              request.parentSessionId,
            );
          let page = snapshots.get(
            key,
            source.entry,
            source.historyGeneration,
            fingerprint,
            request.afterSequence,
            appendProof,
          );
          if (!page) {
            const transcript = await (request.parentSessionId
              ? history.loadChildSession!(
                  request.parentSessionId,
                  request.sessionId,
                  source.entry.lastSequence,
                )
              : history.loadSession(request.sessionId, source.entry.lastSequence));
            let rawPrefixDigest: string | null = null;
            try {
              if (!appendProof) rawPrefixDigest = fingerprint();
            } catch {
              // An unavailable reuse proof cannot deny this fresh read.
            }
            snapshots.set(key, transcript, source.historyGeneration, rawPrefixDigest, appendProof);
            page =
              snapshots.get(
                key,
                source.entry,
                source.historyGeneration,
                fingerprint,
                request.afterSequence,
                appendProof,
              ) ?? historyTranscriptPage(transcript, request.afterSequence);
          }
          response =
            request.afterSequence !== undefined &&
            request.snapshotDigest !== undefined &&
            page.snapshotDigest !== request.snapshotDigest
              ? {
                  id: message.id,
                  failure: {
                    code: 'history_snapshot_changed',
                    message: 'History snapshot changed during pagination.',
                  },
                }
              : { id: message.id, page };
          activeReader.database.run('COMMIT');
          began = false;
          return response;
        }
        const loaded = await (request.parentSessionId
          ? history.loadChildSession!(
              request.parentSessionId,
              request.sessionId,
              request.throughSequence,
            )
          : history.loadSession(request.sessionId, request.throughSequence)
        ).then(
          (transcript) => ({ transcript }) as const,
          (error: unknown) => ({ error }) as const,
        );
        if ('error' in loaded) {
          response = {
            id: message.id,
            failure: readFailure(loaded.error),
          };
        } else if (
          request.afterSequence !== undefined &&
          request.snapshotDigest !== undefined &&
          loaded.transcript.snapshotDigest !== request.snapshotDigest
        ) {
          response = {
            id: message.id,
            failure: {
              code: 'history_snapshot_changed',
              message: 'History snapshot changed during pagination.',
            },
          };
        } else {
          response =
            Buffer.byteLength(JSON.stringify(loaded.transcript), 'utf8') > MAX_FULL_RESULT_BYTES
              ? {
                  id: message.id,
                  failure: {
                    code: 'history_too_large',
                    message: 'History read exceeds one frame.',
                  },
                }
              : { id: message.id, transcript: loaded.transcript };
        }
      }
      activeReader.database.run('COMMIT');
      began = false;
    } catch (error) {
      if (began) {
        try {
          activeReader?.database.run('ROLLBACK');
        } catch {
          /* SQLite may already roll back. */
        }
      }
      response = {
        id: message.id,
        failure: readFailure(error),
      };
    } finally {
      activeReader?.close();
      activeReader = undefined;
    }
    return response;
  };
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for await (const chunk of process.stdin) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true });
      if (Buffer.byteLength(pending, 'utf8') > MAX_INPUT_FRAME_BYTES)
        throw new Error('History input frame is too large.');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const message = JSON.parse(line) as KiteHistoryWorkerRequest & {
          readonly databasePath: string;
          readonly snapshotDirectory: string;
        };
        const response = await handle(message);
        if (!process.stdout.write(`${JSON.stringify(response)}\n`))
          await once(process.stdout, 'drain');
      }
    }
  } finally {
    snapshots?.dispose();
  }
}
