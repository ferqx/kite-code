import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ipcMain } from 'electron';

const childProcess = require('node:child_process') as typeof import('node:child_process');
const origin = performance.now();
const capacity = 128;
type RecordEntry = {
  phase: string;
  event: string;
  elapsedMs: number;
  sequence?: number;
  durationMs?: number;
  method?: 'attach' | 'directory' | 'state' | 'other';
  ok?: boolean;
  generation?: number;
  code?: string | number | null;
  status?: number;
  signal?: NodeJS.Signals | null;
};
const observation = {
  installedAtMainMs: origin,
  capacity,
  overflow: 0,
  records: [] as RecordEntry[],
};
Object.assign(globalThis, { nativeStartupEarlyObservation: observation });
let sequence = 0;
function record(
  phase: string,
  event: string,
  details: Omit<RecordEntry, 'phase' | 'event' | 'elapsedMs'> = {},
) {
  if (observation.records.length === capacity) {
    observation.overflow++;
    return;
  }
  observation.records.push({ phase, event, elapsedMs: performance.now() - origin, ...details });
}
record('observer', 'installed');

const originalHandle = ipcMain.handle;
ipcMain.handle = function (channel, handler) {
  if (channel !== 'kite:native:request') return originalHandle.call(this, channel, handler);
  return originalHandle.call(this, channel, function (this: unknown, event, payload: unknown) {
    const requested = (payload as { method?: unknown } | null)?.method;
    const method =
      requested === 'attach' || requested === 'directory' || requested === 'state'
        ? requested
        : 'other';
    const current = ++sequence,
      start = performance.now();
    record('ipc', 'enter', { sequence: current, method });
    const pending = handler.call(this, event, payload);
    void Promise.resolve(pending)
      .then(
        (reply: { ok?: boolean; code?: unknown; value?: { generation?: unknown } } | null) =>
          record('ipc', 'end', {
            sequence: current,
            method,
            durationMs: performance.now() - start,
            ok: reply?.ok === true,
            ...(typeof reply?.value?.generation === 'number' &&
            Number.isSafeInteger(reply.value.generation)
              ? { generation: reply.value.generation }
              : {}),
            ...(reply?.ok === false &&
            typeof reply.code === 'string' &&
            /^[a-z][a-z0-9_]{0,80}$/.test(reply.code)
              ? { code: reply.code }
              : {}),
          }),
        () =>
          record('ipc', 'error', {
            sequence: current,
            method,
            durationMs: performance.now() - start,
          }),
      )
      .catch(() => {});
    return pending;
  });
};

const originalSpawn = childProcess.spawn;
childProcess.spawn = function (this: unknown, ...args: Parameters<typeof originalSpawn>) {
  const name = basename(args[1]?.[0] ?? '');
  const phase =
    name === 'artifact-access.js'
      ? 'artifact_lease'
      : name === 'profile-access.js'
        ? 'private_lease'
        : basename(args[0]) === 'bun'
          ? 'service'
          : undefined;
  const current = ++sequence,
    start = performance.now();
  if (phase) record(phase, 'begin', { sequence: current });
  const child = originalSpawn.apply(this, args);
  if (phase) {
    child.once('close', (code, signal) =>
      record(phase, 'end', {
        sequence: current,
        durationMs: performance.now() - start,
        code,
        signal,
      }),
    );
    child.once('error', () =>
      record(phase, 'error', {
        sequence: current,
        durationMs: performance.now() - start,
        code: 'spawn_failed',
      }),
    );
  }
  return child;
} as typeof originalSpawn;

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  function (this: unknown, ...args: Parameters<typeof originalFetch>) {
    const [input, init] = args;
    let phase: string | undefined;
    try {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (method === 'GET')
        phase =
          path === '/v1/server'
            ? 'admission'
            : path === '/v1/workspace-directory'
              ? 'workspaces'
              : path === '/v1/session-directory'
                ? 'sessions'
                : path === '/v1/events'
                  ? 'observation'
                  : undefined;
    } catch {
      // Only classify known GETs; fetch retains validation and the original result.
    }
    const current = ++sequence,
      start = performance.now();
    if (phase) record(phase, 'begin', { sequence: current });
    const pending = originalFetch.apply(this, args);
    if (phase) {
      const observed = phase;
      void pending
        .then(
          (response) =>
            record(observed, 'headers', {
              sequence: current,
              durationMs: performance.now() - start,
              status: response.status,
            }),
          (error: unknown) =>
            record(observed, 'error', {
              sequence: current,
              durationMs: performance.now() - start,
              code:
                error instanceof Error && error.name === 'AbortError'
                  ? 'aborted'
                  : 'transport_failure',
            }),
        )
        .catch(() => {});
    }
    return pending;
  },
  { preconnect: originalFetch.preconnect },
);
