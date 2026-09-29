import { once } from 'node:events';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';
import { openKiteHistoryPageReader } from '../bootstrap';
import { createKiteRuntimeObserverHistoryClient } from './history-adapter';
import { historyTranscriptPage } from './history-page';
import type { KiteHistoryWorkerRequest, KiteHistoryWorkerResponse } from './history-page-pool';

const MAX_HISTORY_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_PROJECTED_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_RECORDS = 50_000;
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
      maxSourceBytes: MAX_HISTORY_SOURCE_BYTES,
      maxProjectedBytes: MAX_HISTORY_PROJECTED_BYTES,
      maxRecords: MAX_HISTORY_RECORDS,
      maxCacheBytes: 32 * 1024 * 1024,
      fingerprintEventRows: (sessionId, throughSequence, parentSessionId) => {
        if (!activeReader) throw new Error('History reader is unavailable.');
        return activeReader.fingerprintEventRows(sessionId, throughSequence, parentSessionId, {
          maxRecords: MAX_HISTORY_RECORDS,
          maxSourceBytes: MAX_HISTORY_SOURCE_BYTES,
        });
      },
    },
  );
  const handle = async (
    message: KiteHistoryWorkerRequest & { readonly databasePath: string },
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
        } else if (message.full) {
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
        } else {
          response = {
            id: message.id,
            page: historyTranscriptPage(loaded.transcript, request.afterSequence),
          };
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
      };
      const response = await handle(message);
      if (!process.stdout.write(`${JSON.stringify(response)}\n`))
        await once(process.stdout, 'drain');
    }
  }
}
