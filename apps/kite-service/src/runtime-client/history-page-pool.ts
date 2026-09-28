import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type {
  ListRuntimeLogSessionsRequest,
  RuntimeHistorySessionTranscript,
  RuntimeLogSessionPage,
} from '@kite-ai/runtime-contract';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';
import type { KiteHistoryPage } from './history-page';

export interface KiteHistoryPageRequest {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly throughSequence?: number;
  readonly afterSequence?: number;
  readonly snapshotDigest?: string;
}

export interface KiteHistoryPageClient {
  loadSessionPage(
    request: KiteHistoryPageRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KiteHistoryPage>;
  loadSessionFull(
    request: KiteHistoryPageRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RuntimeHistorySessionTranscript>;
  searchSessions(
    request: ListRuntimeLogSessionsRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RuntimeLogSessionPage>;
}

export type KiteHistoryWorkerRequest =
  | { readonly id: number; readonly request: KiteHistoryPageRequest; readonly full?: true }
  | { readonly id: number; readonly search: ListRuntimeLogSessionsRequest };

export type KiteHistoryWorkerResponse =
  | { readonly id: number; readonly page: KiteHistoryPage }
  | { readonly id: number; readonly transcript: RuntimeHistorySessionTranscript }
  | { readonly id: number; readonly sessions: RuntimeLogSessionPage }
  | { readonly id: number; readonly failure: { readonly code: string; readonly message: string } };

const PROCESSES = 2;
const MAX_WAITING_PER_PROCESS = 64;
const MAX_READ_MS = 9_000;
const MAX_OUTPUT_FRAME_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes + 65_536;

type Job = {
  readonly kind: 'page' | 'full' | 'search';
  readonly request: KiteHistoryPageRequest | ListRuntimeLogSessionsRequest;
  readonly resolve: (
    result: KiteHistoryPage | RuntimeHistorySessionTranscript | RuntimeLogSessionPage,
  ) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
};

type HistoryChild = ChildProcessByStdio<Writable, Readable, null>;

type Lane = {
  child?: HistoryChild;
  retiring?: HistoryChild;
  retirement?: Promise<boolean>;
  unavailable?: boolean;
  active?: Job;
  timer?: ReturnType<typeof setTimeout>;
  readonly waiting: Job[];
  nextId: number;
  pendingOutput: string;
  decoder: TextDecoder;
};

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Fixed two-process pool with bounded per-process input and one active read each. */
export function createKiteHistoryPagePool(input: {
  readonly databasePath: string;
  readonly entrypointPath?: string;
  readonly standaloneEntrypoint?: boolean;
}): KiteHistoryPageClient & { close(): Promise<void>; liveChildPids(): readonly number[] } {
  const entrypointPath = input.entrypointPath ?? process.argv[1];
  if (!entrypointPath) throw new Error('History child entrypoint is unavailable.');
  const lanes: Lane[] = Array.from({ length: PROCESSES }, () => ({
    waiting: [],
    nextId: 1,
    pendingOutput: '',
    decoder: new TextDecoder(),
  }));
  let closed = false;
  let nextSearchLane = 0;
  let closePromise: Promise<void> | undefined;
  const detach = (job: Job) => {
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  };
  let startNext: (lane: Lane) => void;
  const retire = (lane: Lane, child: HistoryChild): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      startNext(lane);
      return;
    }
    lane.retiring = child;
    lane.retirement = new Promise<boolean>((resolve) => {
      const force = setTimeout(() => {
        if (child.pid) child.kill('SIGKILL');
      }, 500);
      const deadline = setTimeout(() => {
        if (lane.retiring !== child) return;
        lane.unavailable = true;
        for (const job of lane.waiting.splice(0)) {
          detach(job);
          job.reject(codedError('temporarily_unavailable', 'History child could not stop.'));
        }
        resolve(false);
      }, 2_000);
      const finished = () => {
        clearTimeout(force);
        clearTimeout(deadline);
        child.off('exit', finished);
        child.off('close', finished);
        if (lane.retiring !== child) return;
        lane.retiring = undefined;
        lane.retirement = undefined;
        resolve(true);
        startNext(lane);
      };
      child.once('exit', finished);
      child.once('close', finished);
      if (child.pid) child.kill('SIGTERM');
    });
  };
  const stopLane = (lane: Lane, error: Error, retainWaiting = false) => {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = undefined;
    if (lane.active) {
      detach(lane.active);
      lane.active.reject(error);
      lane.active = undefined;
    }
    if (!retainWaiting) {
      for (const job of lane.waiting.splice(0)) {
        detach(job);
        job.reject(error);
      }
    }
    const child = lane.child;
    lane.child = undefined;
    lane.pendingOutput = '';
    lane.decoder = new TextDecoder();
    if (child) retire(lane, child);
  };
  startNext = (lane: Lane): void => {
    if (closed || lane.unavailable || lane.retiring || lane.active || lane.waiting.length === 0)
      return;
    if (!lane.child) {
      const command =
        (input.standaloneEntrypoint ?? process.env.KITE_STANDALONE_EXECUTABLE === '1')
          ? [input.entrypointPath ?? process.execPath, '--kite-internal-history-page-v1']
          : [process.execPath, entrypointPath, '--kite-internal-history-page-v1'];
      try {
        const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
        lane.child = child;
        child.stdout.on('data', (chunk: Buffer) => {
          if (lane.child !== child) return;
          lane.pendingOutput += lane.decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(lane.pendingOutput, 'utf8') > MAX_OUTPUT_FRAME_BYTES) {
            stopLane(
              lane,
              codedError('session_unavailable', 'History child output exceeded the frame limit.'),
            );
            return;
          }
          for (;;) {
            const newline = lane.pendingOutput.indexOf('\n');
            if (newline < 0) break;
            const line = lane.pendingOutput.slice(0, newline);
            lane.pendingOutput = lane.pendingOutput.slice(newline + 1);
            let response: KiteHistoryWorkerResponse;
            try {
              response = JSON.parse(line) as KiteHistoryWorkerResponse;
            } catch {
              stopLane(
                lane,
                codedError('session_unavailable', 'History child response is malformed.'),
              );
              return;
            }
            if (
              !lane.active ||
              response.id !== lane.nextId - 1 ||
              !(
                'page' in response ||
                'transcript' in response ||
                'sessions' in response ||
                'failure' in response
              ) ||
              ('page' in response && lane.active.kind !== 'page') ||
              ('transcript' in response && lane.active.kind !== 'full') ||
              ('sessions' in response && lane.active.kind !== 'search')
            ) {
              stopLane(
                lane,
                codedError('session_unavailable', 'History child response identity is invalid.'),
              );
              return;
            }
            if (lane.timer) clearTimeout(lane.timer);
            lane.timer = undefined;
            const job = lane.active;
            lane.active = undefined;
            detach(job);
            if ('failure' in response)
              job.reject(codedError(response.failure.code, response.failure.message));
            else
              job.resolve(
                'page' in response
                  ? response.page
                  : 'transcript' in response
                    ? response.transcript
                    : response.sessions,
              );
            startNext(lane);
          }
        });
        child.on('error', () => {
          if (lane.child === child)
            stopLane(lane, codedError('temporarily_unavailable', 'History child failed.'));
        });
        child.stdin.on('error', () => {
          if (lane.child === child)
            stopLane(lane, codedError('temporarily_unavailable', 'History child input failed.'));
        });
        child.stdout.on('error', () => {
          if (lane.child === child)
            stopLane(lane, codedError('temporarily_unavailable', 'History child output failed.'));
        });
        child.on('exit', () => {
          if (lane.child === child)
            stopLane(lane, codedError('temporarily_unavailable', 'History child exited.'));
        });
      } catch {
        stopLane(lane, codedError('temporarily_unavailable', 'History child could not start.'));
        return;
      }
    }
    const job = lane.waiting.shift()!;
    lane.active = job;
    const id = lane.nextId++;
    lane.timer = setTimeout(
      () => stopLane(lane, codedError('temporarily_unavailable', 'History read timed out.')),
      MAX_READ_MS,
    );
    const frame = JSON.stringify(
      job.kind === 'search'
        ? { id, search: job.request, databasePath: input.databasePath }
        : {
            id,
            request: job.request,
            ...(job.kind === 'full' ? { full: true } : {}),
            databasePath: input.databasePath,
          },
    );
    if (Buffer.byteLength(frame, 'utf8') > 65_535) {
      stopLane(lane, codedError('invalid_request', 'History request is too large.'));
      return;
    }
    lane.child!.stdin.write(`${frame}\n`, (error) => {
      if (error && lane.active === job)
        stopLane(lane, codedError('temporarily_unavailable', 'History child input failed.'));
    });
  };
  const indexFor = (key: string) => {
    let hash = 2_166_136_261;
    for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
    return (hash >>> 0) % PROCESSES;
  };
  const load = (
    request: KiteHistoryPageRequest | ListRuntimeLogSessionsRequest,
    kind: Job['kind'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<KiteHistoryPage | RuntimeHistorySessionTranscript | RuntimeLogSessionPage> => {
    if (closed)
      return Promise.reject(codedError('session_unavailable', 'History child pool is closed.'));
    if (options?.signal?.aborted)
      return Promise.reject(codedError('temporarily_unavailable', 'History read was cancelled.'));
    const lane =
      lanes[
        'sessionId' in request
          ? indexFor(`${request.parentSessionId ?? ''}\0${request.sessionId}`)
          : nextSearchLane++ % PROCESSES
      ]!;
    if (lane.unavailable)
      return Promise.reject(codedError('temporarily_unavailable', 'History child is unavailable.'));
    if (lane.waiting.length >= MAX_WAITING_PER_PROCESS) {
      return Promise.reject(codedError('temporarily_unavailable', 'History child queue is full.'));
    }
    return new Promise<KiteHistoryPage | RuntimeHistorySessionTranscript | RuntimeLogSessionPage>(
      (resolve, reject) => {
        const job: Job = {
          kind,
          request,
          resolve,
          reject,
          ...(options?.signal ? { signal: options.signal } : {}),
        };
        const onAbort = () => {
          if (lane.active === job) {
            stopLane(
              lane,
              codedError('temporarily_unavailable', 'History read was cancelled.'),
              true,
            );
            startNext(lane);
            return;
          }
          const index = lane.waiting.indexOf(job);
          if (index >= 0) {
            lane.waiting.splice(index, 1);
            detach(job);
            reject(codedError('temporarily_unavailable', 'History read was cancelled.'));
          }
        };
        if (options?.signal) {
          job.onAbort = onAbort;
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
        lane.waiting.push(job);
        startNext(lane);
      },
    );
  };
  return {
    loadSessionPage: (request, options) =>
      load(request, 'page', options) as Promise<KiteHistoryPage>,
    loadSessionFull: (request, options) =>
      load(request, 'full', options) as Promise<RuntimeHistorySessionTranscript>,
    searchSessions: (request, options) =>
      load(request, 'search', options) as Promise<RuntimeLogSessionPage>,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const lane of lanes)
          stopLane(lane, codedError('session_unavailable', 'History child pool is closed.'));
        const retired = await Promise.all(
          lanes.flatMap((lane) => (lane.retirement ? [lane.retirement] : [])),
        );
        if (retired.some((result) => !result))
          throw codedError('temporarily_unavailable', 'History child could not stop.');
      })();
      return closePromise;
    },
    liveChildPids() {
      return lanes
        .flatMap((lane) => [lane.child?.pid, lane.retiring?.pid])
        .filter((pid): pid is number => pid !== undefined);
    },
  };
}
