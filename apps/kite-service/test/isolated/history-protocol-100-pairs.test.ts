import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteSessionAppServerStorageComposition } from '../../src/bootstrap';
import {
  createRuntimeStdioCarrier,
  type RuntimeStdioOutput,
} from '../../src/carrier/runtime-server-stdio';
import { createKiteRuntimeObserverHistoryClient } from '../../src/runtime-client/history-adapter';
import { createKiteHistoryPagePool } from '../../src/runtime-client/history-page-pool';

const GROUPS = Number(process.env.KITE_HISTORY_STRESS_GROUPS ?? 100);
const PROCESS_PAGES = process.env.KITE_HISTORY_STRESS_PROCESS_PAGES === '1';
if (!Number.isSafeInteger(GROUPS) || GROUPS < 100 || GROUPS > 2_000)
  throw new Error('KITE_HISTORY_STRESS_GROUPS must be an integer from 100 through 2000.');
const BASE_EVENTS = 205;
const LONG_EVENTS = 520;
const LARGE_TEXT = 'x'.repeat(5_000);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Transcript = Awaited<ReturnType<NonNullable<RuntimeClient['history']>['loadSession']>>;

test(
  `${GROUPS} parent-child pairs retain scoped, ordered History over the real paged client and stdio carrier`,
  async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-protocol-100-'));
    const databasePath = join(home, 'kite-session.sqlite');
    const priorHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    let storage:
      | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
      | undefined;
    let client: RuntimeClient | undefined;
    let carrier: ReturnType<typeof createRuntimeStdioCarrier> | undefined;
    let historyPagePool: ReturnType<typeof createKiteHistoryPagePool> | undefined;
    try {
      storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: 'history-protocol-100-host',
      });
      seedHistory(databasePath);
      const types = runtimeHostCurrentStateEventTypes();
      const rawHistory = createKiteRuntimeObserverHistoryClient(
        () => storage!.openHistoryLogs(types),
        (parent, child) => storage!.openChildSessionHistoryLogs(parent, child, types),
      );
      if (PROCESS_PAGES)
        historyPagePool = createKiteHistoryPagePool({
          databasePath,
          entrypointPath: resolve(import.meta.dir, '../../src/executable.ts'),
        });
      const history = {
        listSessions: (request: Parameters<typeof rawHistory.listSessions>[0]) =>
          storage!.readSnapshot(() => rawHistory.listSessions(request)),
        listEvents: (request: Parameters<typeof rawHistory.listEvents>[0]) =>
          storage!.readSnapshot(() => rawHistory.listEvents(request)),
        loadSession: (sessionId: string, throughSequence?: number) =>
          storage!.readSnapshot(() => rawHistory.loadSession(sessionId, throughSequence)),
        loadChildSession: (parent: string, child: string, throughSequence?: number) =>
          storage!.readSnapshot(() => rawHistory.loadChildSession!(parent, child, throughSequence)),
        ...(historyPagePool ? { loadSessionPage: historyPagePool.loadSessionPage } : {}),
      };
      const input = new ByteQueue();
      const output = new MessageQueue<unknown>();
      const sent = new Map<string, { method: string; params: unknown }>();
      const received = new Map<string, number>();
      const historyFrameSizes: number[] = [];
      const stdout: RuntimeStdioOutput = {
        write(chunk) {
          const frame = decoder.decode(chunk);
          expect(frame.endsWith('\n')).toBe(true);
          const message = JSON.parse(frame) as {
            id?: string;
            result?: unknown;
            error?: { data?: { code?: string } };
          };
          if (typeof message.id === 'string') {
            received.set(message.id, (received.get(message.id) ?? 0) + 1);
            if (sent.get(message.id)?.method.startsWith('history/')) {
              historyFrameSizes.push(chunk.byteLength);
              expect(chunk.byteLength).toBeLessThanOrEqual(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes);
              expect(message.error?.data?.code).not.toBe('overloaded');
            }
          }
          output.push(message);
          return true;
        },
      };
      const server = new RuntimeServer(
        {
          runtime: new IdleRuntime(),
          admission: {
            authorize: async () => ({ allowed: true, workspace: '/history-workspace' }),
          },
        },
        {
          serverInfo: { version: 'history-protocol-100', instanceId: 'history-protocol-100' },
          historyMethods: true,
          childHistoryMethods: true,
        },
      );
      carrier = createRuntimeStdioCarrier({ server, stdin: input, stdout, history });
      const transport: RuntimeClientTransport = {
        connect: async () => ({
          send: async (message) => {
            if ('id' in message && typeof message.id === 'string' && 'method' in message)
              sent.set(message.id, { method: message.method, params: message.params });
            input.push(encoder.encode(`${JSON.stringify(message)}\n`));
          },
          messages: () => output,
          close: async () => {
            input.close();
            output.close();
          },
        }),
      };
      client = new RuntimeClient({
        transport,
        history: 'protocol',
        clientInfo: { name: 'history-protocol-100', version: '1', instanceId: 'client' },
        requestTimeoutMs: 30_000,
      });
      await client.connect();
      const startedAt = performance.now();
      const requests = Array.from({ length: GROUPS }, (_, index) => ({
        parent: `parent-${index}`,
        child: `child-${index}`,
      }));
      const load = (index: number): Promise<Transcript> => {
        const { parent, child } = requests[Math.floor(index / 2)]!;
        return index % 2 === 0
          ? client!.history!.loadSession(parent)
          : client!.history!.loadChildSession!(parent, child);
      };
      const firstWavePending = Promise.allSettled(
        Array.from({ length: GROUPS * 2 }, (_, index) => load(index)),
      );
      // An unrelated Runtime query must still make progress while History work
      // is queued. This checks responsiveness as well as total throughput.
      const queryStartedAt = performance.now();
      await expect(
        client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' }),
      ).resolves.toMatchObject({ status: 'ok', sessions: [] });
      const queryMs = performance.now() - queryStartedAt;
      expect(queryMs).toBeLessThan(2_000);
      const firstWave = await firstWavePending;
      const transcripts = new Array<Transcript>(firstWave.length);
      const overloaded: number[] = [];
      for (const [index, result] of firstWave.entries()) {
        if (result.status === 'fulfilled') transcripts[index] = result.value;
        else {
          expect(result.reason).toMatchObject({ code: 'request_overloaded' });
          overloaded.push(index);
        }
      }
      if (GROUPS <= 500) expect(overloaded).toHaveLength(0);
      else expect(overloaded.length).toBeGreaterThan(0);
      // The excess callers receive a bounded rejection and can retry once the
      // admitted wave drains; they must not leave stale work in the transport.
      for (const index of overloaded) transcripts[index] = await load(index);
      const loadMs = performance.now() - startedAt;
      for (const [index, transcript] of transcripts.entries()) {
        const pair = requests[Math.floor(index / 2)]!;
        const sessionId = index % 2 === 0 ? pair.parent : pair.child;
        verifyTranscript(transcript, sessionId);
      }
      const initialPageRequests = [...sent.values()].filter(
        (request) =>
          request.method === 'history/load_session' ||
          request.method === 'history/load_child_session',
      );
      const continuationFor = (method: string, sessionId: string) =>
        initialPageRequests
          .filter((request) => {
            if (request.method !== method) return false;
            const params = request.params as {
              sessionId?: string;
              childSessionId?: string;
              page?: { afterSequence?: number };
            };
            return (
              (params.sessionId ?? params.childSessionId) === sessionId &&
              params.page?.afterSequence !== undefined
            );
          })
          .map(
            (request) =>
              (
                request.params as {
                  page: { afterSequence: number; snapshotDigest?: string };
                }
              ).page,
          );
      const largeContinuations = continuationFor('history/load_session', 'parent-0');
      expect(largeContinuations.length).toBeGreaterThan(1);
      expect(largeContinuations[0]!.afterSequence).toBeLessThan(512);
      const countContinuations = continuationFor('history/load_child_session', 'child-0');
      expect(countContinuations).toHaveLength(1);
      expect(countContinuations[0]!.afterSequence).toBe(512);
      for (const page of [...largeContinuations, ...countContinuations])
        expect(page.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
      // Repeated main/child selection must not change content or borrow the other scope.
      for (const index of [0, 37, 99, 0, 99, 37]) {
        const { parent, child } = requests[index]!;
        verifyTranscript(await client.history!.loadChildSession!(parent, child), child);
        verifyTranscript(await client.history!.loadSession(parent), parent);
      }
      await expect(client.history!.loadSession('child-0')).rejects.toThrow();
      await expect(client.history!.loadChildSession!('parent-1', 'child-0')).rejects.toThrow();
      const originalChild = transcripts[1]!;
      const rewrite = openKiteSessionStoreDatabase(databasePath);
      try {
        rewrite
          .query('UPDATE runtime_events SET event_json = ? WHERE session_id = ? AND sequence = 1')
          .run(
            JSON.stringify({
              type: 'user.message_appended',
              messageId: 'child-0-message-1',
              content: 'child-0 revised message 1',
            }),
            'child-0',
          );
      } finally {
        rewrite.close(false);
      }
      const revisedChild = await client.history!.loadChildSession!('parent-0', 'child-0');
      expect(revisedChild.session.lastSequence).toBe(LONG_EVENTS);
      expect(revisedChild.records[0]?.events).toContainEqual(
        expect.objectContaining({ type: 'user.message', text: 'child-0 revised message 1' }),
      );
      expect(revisedChild.records.slice(1)).toEqual(originalChild.records.slice(1));
      verifyTranscript(await client.history!.loadSession('parent-0'), 'parent-0');
      expect(historyFrameSizes.length).toBeGreaterThan(transcripts.length);
      const pageRequests = [...sent.values()].filter(
        (request) =>
          request.method === 'history/load_session' ||
          request.method === 'history/load_child_session',
      );
      expect(pageRequests.length).toBeGreaterThan(transcripts.length);
      expect([...received.values()].every((count) => count === 1)).toBe(true);
      expect([...sent.keys()].every((id) => received.has(id))).toBe(true);
      expect([...received.keys()].every((id) => sent.has(id))).toBe(true);
      console.info(
        `[history-protocol-100] sessions=${GROUPS * 2} processPages=${PROCESS_PAGES} loadMs=${loadMs.toFixed(1)} ` +
          `queryMs=${queryMs.toFixed(1)} ` +
          `initialOverloaded=${overloaded.length} historyRequests=${pageRequests.length} ` +
          `maxFrame=${Math.max(...historyFrameSizes)}`,
      );
    } finally {
      await client?.close();
      if (carrier) await carrier.done;
      await historyPagePool?.close();
      storage?.disposeStorage();
      if (priorHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  },
  GROUPS > 100 ? 120_000 : 30_000,
);

function verifyTranscript(
  transcript: Awaited<ReturnType<NonNullable<RuntimeClient['history']>['loadSession']>>,
  sessionId: string,
): void {
  const count = sessionId.endsWith('-0') ? LONG_EVENTS : BASE_EVENTS;
  expect(transcript.session.sessionId).toBe(sessionId);
  expect(transcript.session.lastSequence).toBe(count);
  expect(transcript.records).toHaveLength(count);
  for (let sequence = 1; sequence <= count; sequence++) {
    const record = transcript.records[sequence - 1]!;
    const content = `${sessionId} message ${sequence}${sessionId === 'parent-0' ? LARGE_TEXT : ''}`;
    expect(record.sequence).toBe(sequence);
    expect(record.events).toContainEqual(
      expect.objectContaining({ type: 'user.message', text: content }),
    );
  }
}

function seedHistory(databasePath: string): void {
  const database = openKiteSessionStoreDatabase(databasePath);
  try {
    database.run('PRAGMA foreign_keys=ON');
    database
      .query(`INSERT INTO workspaces (
        workspace_id, canonical_path, workspace_identity_digest, project_id,
        workspace_digest, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`)
      .run(
        'history-workspace',
        '/history-workspace',
        `sha256:${'a'.repeat(64)}`,
        'history-project',
        `sha256:${'b'.repeat(64)}`,
        'History workspace',
      );
    const insertSession = database.query(`INSERT INTO runtime_sessions (
      session_id, workspace_id, project_id, workspace_digest, state_schema,
      format_epoch, revision, name, updated_at, run_index_from_revision, parent_session_id
    ) VALUES (?, 'history-workspace', 'history-project', ?, ?, 'history-fixture', 0, ?, 1, 0, ?)`);
    const insertEvent = database.query(`INSERT INTO runtime_events (
      session_id, event_id, sequence, schema_version, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    database.run('BEGIN');
    try {
      for (let index = 0; index < GROUPS; index++) {
        const parent = `parent-${index}`;
        const child = `child-${index}`;
        insertSession.run(
          parent,
          `sha256:${'b'.repeat(64)}`,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          parent,
          null,
        );
        insertSession.run(
          child,
          `sha256:${'b'.repeat(64)}`,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          child,
          parent,
        );
        for (const sessionId of [parent, child]) {
          const count = index === 0 ? LONG_EVENTS : BASE_EVENTS;
          for (let sequence = 1; sequence <= count; sequence++) {
            insertEvent.run(
              sessionId,
              `${sessionId}-event-${sequence}`,
              sequence,
              SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
              JSON.stringify({
                type: 'user.message_appended',
                messageId: `${sessionId}-message-${sequence}`,
                content: `${sessionId} message ${sequence}${sessionId === 'parent-0' ? LARGE_TEXT : ''}`,
              }),
              sequence,
            );
          }
        }
      }
      database.run('COMMIT');
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  } finally {
    database.close(false);
  }
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #queue = new MessageQueue<Uint8Array>();
  push(chunk: Uint8Array): void {
    this.#queue.push(chunk);
  }
  close(): void {
    this.#queue.close();
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#queue[Symbol.asyncIterator]();
  }
}

class MessageQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: IteratorResult<T>) => void)[] = [];
  #closed = false;
  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#items.push(value);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#items.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class IdleRuntime implements RuntimeAccess {
  command(_command: RuntimeCommand) {
    return Promise.resolve({
      status: 'applied' as const,
      commandId: 'unused',
      sessionId: 'unused',
      revision: 1,
    });
  }
  query(_query: RuntimeQuery) {
    return Promise.resolve({
      status: 'ok' as const,
      queryType: 'list_sessions' as const,
      sessions: [],
    });
  }
  subscribe(_subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<RuntimeAccessNotification>>(() => undefined),
      }),
    };
  }
}
