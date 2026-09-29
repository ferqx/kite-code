import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  type KiteAppControlClient,
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  type NativeProviderCredentialClient,
} from '@kite-ai/kite-local-runtime/client';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RUNTIME_PROTOCOL_VERSION } from '@kite-ai/runtime-protocol';
import { RuntimeServer, type RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { WorkspaceRemovalError } from '#kite-service/app-control/workspace-removal-error';
import {
  createNodeRuntimeStdioOutput,
  createRuntimeStdioCarrier,
  type RuntimeStdioDiagnostics,
  type RuntimeStdioOutput,
  type RuntimeStdioSignals,
} from '#kite-service/carrier/runtime-server-stdio';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Runtime stdio carrier', () => {
  test('advertises History cancellation only when this carrier has a History owner', async () => {
    const server = new RuntimeServer(
      { runtime: new FakeRuntime(), admission: allowAdmission },
      { serverInfo: { version: 'test', instanceId: 'cancel-capability' }, historyMethods: true },
    );
    const peers = [false, true].map((hasHistory) => {
      const input = new BytesInput();
      const output = new FakeOutput();
      const carrier = createRuntimeStdioCarrier({
        server,
        stdin: input,
        stdout: output,
        ...(hasHistory
          ? {
              history: {
                listSessions: async () => ({ entries: [], hasMore: false }),
                listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
                loadSession: async () => {
                  throw new Error('unused');
                },
              },
            }
          : {}),
      });
      return { hasHistory, input, output, carrier };
    });
    try {
      for (const peer of peers) peer.input.pushText(initializeLine());
      await eventually(() => peers.every((peer) => protocolFrames(peer.output).length === 1));
      for (const peer of peers) {
        const frame = protocolFrames(peer.output)[0] as {
          result: { capabilities: { methods: string[] } };
        };
        expect(frame.result.capabilities.methods.includes('history/cancel')).toBe(peer.hasHistory);
      }
    } finally {
      for (const peer of peers) peer.input.close();
      await Promise.all(peers.map((peer) => peer.carrier.done));
    }
  });

  test('closing an idle Node input releases the logical connection without another request', async () => {
    const input = new PassThrough();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });
    input.write(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    // The receive loop is now waiting for a new request on a still-open pipe.
    await Bun.sleep(0);
    const closing = carrier.connection.close('test_disconnect');
    const result = await Promise.race([
      closing.then(() => 'closed'),
      Bun.sleep(100).then(() => 'timeout'),
    ]);
    input.end();
    await closing;
    await carrier.done;
    expect(result).toBe('closed');
    expect(carrier.server.connectionCount).toBe(0);
  });

  test('the concrete writable adapter flushes only after write callbacks complete', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = createNodeRuntimeStdioOutput({
      write: (_chunk, callback) => {
        completeWrite = callback;
        return true;
      },
      once: () => undefined,
    });
    await output.write(encoder.encode('one line'));
    let flushed = false;
    const completion = output.flush?.().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    completeWrite?.();
    await completion;
    expect(flushed).toBe(true);
  });

  test('decodes fragmented, multiple, CRLF JSONL frames and keeps stdout protocol-only', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });

    input.pushText('{"jsonrpc":"2.0","id":"init","method":"initial');
    input.pushText(
      `ize","params":{"protocolVersion":${RUNTIME_PROTOCOL_VERSION},"clientInfo":{"name":"test","version":"1","instanceId":"a"}}}\r\n`,
    );
    input.pushText('{"jsonrpc":"2.0","id":"ping","method":"server/ping","params":{}}\n');

    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)).toMatchObject([
      { id: 'init', result: { protocolVersion: RUNTIME_PROTOCOL_VERSION } },
      { id: 'ping', result: { status: 'ok' } },
    ]);
    expect(output.text()).toMatch(/^\{.*\}\n\{.*\}\n$/s);

    input.close();
    await carrier.done;
  });

  test('emits the standard parse_error and continues with the next line', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });

    input.pushText('{not json}\n');
    input.pushText(initializeLine());

    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)[0]).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: 'parse_error' } },
    });
    expect(protocolFrames(output)[1]).toMatchObject({
      id: 'init',
      result: { protocolVersion: RUNTIME_PROTOCOL_VERSION },
    });

    input.close();
    await carrier.done;
  });

  test('keeps History on the initialized App connection and fails closed without its owner', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });
    const history = JSON.stringify({
      jsonrpc: '2.0',
      id: 'history-1',
      method: 'history/list_sessions',
      params: { request: { limit: 10 } },
    });
    input.pushText(`${history}\n${initializeLine()}`);
    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'history-1',
          error: expect.objectContaining({ data: { code: 'not_initialized' } }),
        }),
        expect.objectContaining({
          id: 'init',
          result: expect.objectContaining({ protocolVersion: RUNTIME_PROTOCOL_VERSION }),
        }),
      ]),
    );
    input.pushText(`${history.replace('history-1', 'history-2')}\n`);
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[2]).toMatchObject({
      id: 'history-2',
      error: { data: { code: 'method_not_found' } },
    });
    input.close();
    await carrier.done;
  });

  test('routes explicit child History separately from ordinary Session History', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const reads: string[] = [];
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('ordinary child History denied');
        },
        loadChildSession: async (parentSessionId, childSessionId) => {
          reads.push(`${parentSessionId}/${childSessionId}`);
          return {
            session: {
              sessionId: childSessionId,
              displayName: 'Child',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 0,
            },
            records: [],
            events: [],
            interactionMode: 'auto',
            recovery: 'normal',
          };
        },
      },
    });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'child',
        method: 'history/load_child_session',
        params: { parentSessionId: 'parent', childSessionId: 'child', page: {} },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)[1]).toMatchObject({
      id: 'child',
      result: { type: 'history_session_page', session: { sessionId: 'child' } },
    });
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'ordinary',
        method: 'history/load_session',
        params: { sessionId: 'child' },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[2]).toMatchObject({
      id: 'ordinary',
      error: { data: { code: 'internal_error' } },
    });
    expect(reads).toEqual(['parent/child']);
    input.close();
    await carrier.done;
  });

  test('routes paged root and child reads through the bounded page owner', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const seen: unknown[] = [];
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('Full transcript load must not run for a page.');
        },
        loadChildSession: async () => {
          throw new Error('Full child transcript load must not run for a page.');
        },
        loadSessionPage: async (request, options) => {
          seen.push(request);
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return {
            type: 'history_session_page',
            session: {
              sessionId: request.sessionId,
              displayName: request.sessionId,
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 1,
            },
            records: [{ sequence: 1, events: [] }],
            interactionMode: 'auto',
            recovery: 'normal',
            snapshotDigest: 'a'.repeat(64),
          };
        },
      },
    });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'root',
        method: 'history/load_session',
        params: {
          sessionId: 'root',
          page: { throughSequence: 1 },
        },
      })}\n${JSON.stringify({
        jsonrpc: '2.0',
        id: 'child',
        method: 'history/load_child_session',
        params: {
          parentSessionId: 'root',
          childSessionId: 'child',
          page: { afterSequence: 0, throughSequence: 1 },
        },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output).slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'root',
          result: expect.objectContaining({ type: 'history_session_page' }),
        }),
        expect.objectContaining({
          id: 'child',
          result: expect.objectContaining({ type: 'history_session_page' }),
        }),
      ]),
    );
    expect(seen).toEqual([
      { sessionId: 'root', throughSequence: 1 },
      { sessionId: 'child', parentSessionId: 'root', throughSequence: 1, afterSequence: 0 },
    ]);
    input.close();
    await carrier.done;
  });

  test('routes unpaged root and child reads through the bounded full owner', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const seen: unknown[] = [];
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('Main-thread full transcript load must not run.');
        },
        loadChildSession: async () => {
          throw new Error('Main-thread child transcript load must not run.');
        },
        loadSessionFull: async (request, options) => {
          seen.push(request);
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return {
            session: {
              sessionId: request.sessionId,
              displayName: request.sessionId,
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 1,
            },
            records: [{ sequence: 1, events: [] }],
            events: [],
            interactionMode: 'auto',
            recovery: 'normal',
          };
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'root', method: 'history/load_session', params: { sessionId: 'root' } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 'child', method: 'history/load_child_session', params: { parentSessionId: 'root', childSessionId: 'child' } })}\n`,
      );
      await eventually(() => protocolFrames(output).length === 3);
      expect(protocolFrames(output).slice(1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'root',
            result: expect.objectContaining({ records: [{ sequence: 1, events: [] }] }),
          }),
          expect.objectContaining({
            id: 'child',
            result: expect.objectContaining({ records: [{ sequence: 1, events: [] }] }),
          }),
        ]),
      );
      expect(seen).toEqual([
        { sessionId: 'root' },
        { sessionId: 'child', parentSessionId: 'root' },
      ]);
    } finally {
      input.close();
      await carrier.done;
    }
  });

  test('routes searched Session lists through the cancellable read owner', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const seen: unknown[] = [];
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => {
          throw new Error('Main-thread search must not run.');
        },
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('Not used.');
        },
        searchSessions: async (request, options) => {
          seen.push(request);
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return { entries: [], hasMore: false };
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'search', method: 'history/list_sessions', params: { request: { limit: 10, query: 'needle' } } })}\n`,
      );
      await eventually(() => protocolFrames(output).length === 2);
      expect(protocolFrames(output)[1]).toMatchObject({
        id: 'search',
        result: { entries: [], hasMore: false },
      });
      expect(seen).toEqual([{ limit: 10, query: 'needle' }]);
    } finally {
      input.close();
      await carrier.done;
    }
  });

  test('resumes a sparse History page after the exact source sequence', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let snapshotDigest = 'a'.repeat(64);
    const records = Array.from({ length: 513 }, (_, index) => ({
      sequence: index * 2 + 1,
      events: [],
    }));
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => ({
          session: {
            sessionId: 'sparse',
            displayName: 'Sparse',
            needsSmartName: false,
            updatedAt: 1,
            lastSequence: 1025,
          },
          records,
          events: [],
          interactionMode: 'auto',
          recovery: 'normal',
          snapshotDigest,
        }),
      },
    });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'first-page',
        method: 'history/load_session',
        params: { sessionId: 'sparse', page: {} },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 2);
    const firstPage = protocolFrames(output)[1] as {
      result: { nextCursor?: number; records: readonly { sequence: number }[] };
    };
    expect(firstPage.result.nextCursor).toBe(1023);
    expect(firstPage.result.records).toHaveLength(512);
    expect(firstPage.result.records.at(-1)?.sequence).toBe(1023);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'next-page',
        method: 'history/load_session',
        params: {
          sessionId: 'sparse',
          page: { afterSequence: 1023, throughSequence: 1025, snapshotDigest },
        },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[2]).toMatchObject({
      result: { records: [{ sequence: 1025 }], session: { lastSequence: 1025 } },
    });
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'legacy-next-page',
        method: 'history/load_session',
        params: { sessionId: 'sparse', page: { afterSequence: 1023, throughSequence: 1025 } },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 4);
    expect(protocolFrames(output)[3]).toMatchObject({
      id: 'legacy-next-page',
      result: { records: [{ sequence: 1025 }] },
    });
    snapshotDigest = 'b'.repeat(64);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'stale-page',
        method: 'history/load_session',
        params: {
          sessionId: 'sparse',
          page: {
            afterSequence: 1023,
            throughSequence: 1025,
            snapshotDigest: 'a'.repeat(64),
          },
        },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 5);
    expect(protocolFrames(output)[4]).toMatchObject({
      error: { data: { code: 'internal_error', detailCode: 'history_snapshot_changed' } },
    });
    input.close();
    await carrier.done;
  });

  test('queues 100 parent and child History pairs without exceeding active read capacity', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let activeReads = 0;
    let peakActiveReads = 0;
    const load = async (sessionId: string) => {
      activeReads++;
      peakActiveReads = Math.max(peakActiveReads, activeReads);
      await gate;
      activeReads--;
      const recordCount = sessionId.endsWith('-0') ? 513 : 1;
      return {
        session: {
          sessionId,
          displayName: sessionId,
          needsSmartName: false,
          updatedAt: 1,
          lastSequence: recordCount,
        },
        records: Array.from({ length: recordCount }, (_, index) => ({
          sequence: index + 1,
          events: [],
        })),
        events: [],
        interactionMode: 'auto' as const,
        recovery: 'normal' as const,
        snapshotDigest: 'a'.repeat(64),
      };
    };
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: load,
        loadChildSession: async (parentSessionId, childSessionId) => {
          if (parentSessionId !== `parent-${childSessionId.slice('child-'.length)}`)
            throw new Error('unexpected child scope');
          return load(childSessionId);
        },
      },
    });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    const requests = Array.from({ length: 100 }, (_, index) => [
      {
        jsonrpc: '2.0',
        id: `parent-${index}`,
        method: 'history/load_session',
        params: { sessionId: `parent-${index}`, page: {} },
      },
      {
        jsonrpc: '2.0',
        id: `child-${index}`,
        method: 'history/load_child_session',
        params: {
          parentSessionId: `parent-${index}`,
          childSessionId: `child-${index}`,
          page: {},
        },
      },
    ]).flat();
    input.pushText(
      `${requests.map((request) => JSON.stringify(request)).join('\n')}\n${JSON.stringify({
        jsonrpc: '2.0',
        id: 'marker',
        method: 'server/ping',
        params: {},
      })}\n`,
    );
    await eventually(() =>
      protocolFrames(output).some(
        (frame) =>
          typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === 'marker',
      ),
    );
    await eventually(() => activeReads === 8);
    expect(peakActiveReads).toBe(8);
    expect(
      protocolFrames(output).filter(
        (frame) => typeof frame === 'object' && frame !== null && 'error' in frame,
      ),
    ).toHaveLength(0);
    releaseReads();
    await eventually(() => protocolFrames(output).length === 202);
    const frames = protocolFrames(output) as Array<{
      id?: string;
      result?: {
        type?: string;
        session?: { sessionId?: string };
        records?: Array<{ sequence: number; events: unknown[] }>;
        nextCursor?: number;
      };
      error?: unknown;
    }>;
    const historyFrames = frames.filter(
      (frame) => frame.id?.startsWith('parent-') || frame.id?.startsWith('child-'),
    );
    expect(historyFrames).toHaveLength(200);
    expect(new Set(historyFrames.map((frame) => frame.id)).size).toBe(200);
    for (const frame of historyFrames) {
      expect(frame.error).toBeUndefined();
      expect(frame.result).toMatchObject({
        type: 'history_session_page',
        session: { sessionId: frame.id },
      });
      if (frame.id?.endsWith('-0')) {
        expect(frame.result?.records).toHaveLength(512);
        expect(frame.result?.records?.at(-1)?.sequence).toBe(512);
        expect(frame.result?.nextCursor).toBe(512);
      } else expect(frame.result?.records).toEqual([{ sequence: 1, events: [] }]);
    }
    for (const sessionId of ['parent-0', 'child-0'])
      input.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: `continue-${sessionId}`,
          method: sessionId.startsWith('parent-')
            ? 'history/load_session'
            : 'history/load_child_session',
          params: {
            ...(sessionId.startsWith('parent-')
              ? { sessionId }
              : { parentSessionId: 'parent-0', childSessionId: sessionId }),
            page: { afterSequence: 512, throughSequence: 513, snapshotDigest: 'a'.repeat(64) },
          },
        })}\n`,
      );
    await eventually(() => protocolFrames(output).length === 204);
    const continuations = protocolFrames(output).filter(
      (
        frame,
      ): frame is {
        id: string;
        result: { records: Array<{ sequence: number; events: unknown[] }> };
      } =>
        typeof frame === 'object' &&
        frame !== null &&
        'id' in frame &&
        typeof frame.id === 'string' &&
        frame.id.startsWith('continue-'),
    );
    expect(continuations).toHaveLength(2);
    for (const continuation of continuations)
      expect(continuation.result.records).toEqual([{ sequence: 513, events: [] }]);
    input.close();
    await carrier.done;
  });

  test('bounds queued History input bytes while leaving control frames responsive', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async (sessionId) => {
          await gate;
          return {
            session: {
              sessionId,
              displayName: sessionId,
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 0,
            },
            records: [],
            events: [],
            interactionMode: 'auto',
            recovery: 'normal',
          };
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 64 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `held-${index}`,
            method: 'history/load_session',
            params: { sessionId: `held-${index}`, page: {} },
          }),
        ).join('\n')}\n`,
      );
      input.pushText(
        `${Array.from({ length: 5 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `large-${index}`,
            method: 'history/load_session',
            params: { sessionId: 'large', padding: 'x'.repeat(900_000) },
          }),
        ).join('\n')}\n`,
      );
      input.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'byte-marker',
          method: 'server/ping',
          params: {},
        })}\n`,
      );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'byte-marker',
        ),
      );
      expect(protocolFrames(output)).toContainEqual(
        expect.objectContaining({
          id: 'large-4',
          error: expect.objectContaining({ data: { code: 'overloaded' } }),
        }),
      );
    } finally {
      releaseReads();
      input.close();
      await carrier.done;
    }
  });

  test('closing a connection cancels queued History reads before they execute', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let executed = 0;
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async (sessionId) => {
          executed++;
          await gate;
          return {
            session: {
              sessionId,
              displayName: sessionId,
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 0,
            },
            records: [],
            events: [],
            interactionMode: 'auto',
            recovery: 'normal',
          };
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 65 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `close-${index}`,
            method: 'history/load_session',
            params: { sessionId: `close-${index}`, page: {} },
          }),
        ).join('\n')}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 'queued-marker',
          method: 'server/ping',
          params: {},
        })}\n`,
      );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'queued-marker',
        ),
      );
      await eventually(() => executed === 8);
      await carrier.connection.close('test_disconnect');
      releaseReads();
      await carrier.done;
      expect(executed).toBe(8);
      expect(
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === 'close-64',
        ),
      ).toBe(false);
    } finally {
      releaseReads();
      input.close();
    }
  });

  test('routes exact App Control after initialize and rejects malformed payloads', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const unavailable = async (): Promise<never> => {
      throw new Error('unexpected App Control method');
    };
    const appControl: KiteAppControlClient = {
      queryWorkspaceTrust: unavailable,
      decideWorkspaceTrust: unavailable,
      getProviderModelSnapshot: unavailable,
      selectProviderModel: unavailable,
      setProviderModelEnabled: unavailable,
      getMcpSnapshot: unavailable,
      applyMcpAction: unavailable,
      getSkillCatalog: unavailable,
      getExecutionStatus: unavailable,
      getReleaseStatus: async () => ({
        schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
        revision: 'release-1',
        active: true,
        production: false,
        capabilities: [],
        execution: { admitted: false },
      }),
    };
    const carrier = createCarrier({ input, output, appControl });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'release',
        method: 'app/release/status',
        params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
      })}\n`,
    );
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'malformed',
        method: 'app/release/status',
        params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_, extra: true } },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[0]).toMatchObject({
      result: { capabilities: { methods: expect.arrayContaining(['app/release/status']) } },
    });
    expect(protocolFrames(output)).toContainEqual(
      expect.objectContaining({
        id: 'release',
        result: {
          method: 'app/release/status',
          response: expect.objectContaining({
            schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
            revision: 'release-1',
          }),
        },
      }),
    );
    expect(protocolFrames(output)).toContainEqual(
      expect.objectContaining({
        id: 'malformed',
        error: expect.objectContaining({ data: { code: 'invalid_params' } }),
      }),
    );
    input.close();
    await carrier.done;
  });

  test('routes exact Workspace removal phases through the App Server callback', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const requests: unknown[] = [];
    const digest = `sha256:${'a'.repeat(64)}`;
    const carrier = createCarrier({
      input,
      output,
      removeWorkspace: async (request) => {
        requests.push(request);
        return { deletedSessions: request.phase === 'remove' ? 2 : 0, token: 'removal-1' };
      },
    });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    expect(protocolFrames(output)[0]).toMatchObject({
      result: { capabilities: { methods: expect.arrayContaining(['app/workspace/remove']) } },
    });
    const send = (id: string, request: Record<string, unknown>) =>
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'app/workspace/remove', params: { request } })}\n`,
      );
    send('remove', {
      phase: 'remove',
      workspace: '/trusted/workspace',
      workspaceDigest: digest,
      token: 'removal-1',
    });
    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)[1]).toMatchObject({
      id: 'remove',
      result: {
        method: 'app/workspace/remove',
        response: { deletedSessions: 2, token: 'removal-1' },
      },
    });
    send('extra', {
      phase: 'remove',
      workspace: '/trusted/workspace',
      workspaceDigest: digest,
      token: 'removal-1',
      extra: true,
    });
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[2]).toMatchObject({
      id: 'extra',
      error: { data: { code: 'invalid_params' } },
    });
    send('finalize', {
      phase: 'finalize',
      workspace: '/trusted/workspace',
      workspaceDigest: digest,
      token: 'removal-1',
    });
    await eventually(() => protocolFrames(output).length === 4);
    expect(protocolFrames(output)[3]).toMatchObject({
      id: 'finalize',
      result: {
        method: 'app/workspace/remove',
        response: { deletedSessions: 0, token: 'removal-1' },
      },
    });
    send('history-only', { phase: 'remove', workspaceDigest: digest, token: 'removal-1' });
    await eventually(() => protocolFrames(output).length === 5);
    expect(protocolFrames(output)[4]).toMatchObject({
      id: 'history-only',
      result: {
        method: 'app/workspace/remove',
        response: { deletedSessions: 2, token: 'removal-1' },
      },
    });
    send('missing-token', { phase: 'remove', workspaceDigest: digest });
    await eventually(() => protocolFrames(output).length === 6);
    expect(protocolFrames(output)[5]).toMatchObject({
      id: 'missing-token',
      error: { data: { code: 'invalid_params' } },
    });
    expect(requests).toEqual([
      {
        phase: 'remove',
        workspace: '/trusted/workspace',
        workspaceDigest: digest,
        token: 'removal-1',
      },
      {
        phase: 'finalize',
        workspace: '/trusted/workspace',
        workspaceDigest: digest,
        token: 'removal-1',
      },
      { phase: 'remove', workspaceDigest: digest, token: 'removal-1' },
    ]);
    input.close();
    await carrier.done;
  });
  test('sends only bounded Workspace removal failure facts and redacts ordinary errors', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let attempts = 0;
    const carrier = createCarrier({
      input,
      output,
      removeWorkspace: async () => {
        attempts++;
        if (attempts === 1)
          throw new WorkspaceRemovalError('workspace_cleanup_pending', 2, {
            cause: new Error('secret path /private/child-123'),
          });
        throw new Error('secret path /private/workspace-456');
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      const request = (id: string) =>
        input.pushText(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'app/workspace/remove',
            params: {
              request: {
                phase: 'remove',
                workspaceDigest: `sha256:${'a'.repeat(64)}`,
                token: 'removal-1',
              },
            },
          })}\n`,
        );
      request('partial');
      await eventually(() => protocolFrames(output).length === 2);
      expect(protocolFrames(output)[1]).toEqual({
        jsonrpc: '2.0',
        id: 'partial',
        error: {
          code: -32603,
          message: 'Internal error',
          data: {
            code: 'internal_error',
            detailCode: 'workspace_cleanup_pending',
            deletedSessions: 2,
          },
        },
      });
      request('ordinary');
      await eventually(() => protocolFrames(output).length === 3);
      expect(protocolFrames(output)[2]).toEqual({
        jsonrpc: '2.0',
        id: 'ordinary',
        error: { code: -32603, message: 'Internal error', data: { code: 'internal_error' } },
      });
      expect(JSON.stringify(protocolFrames(output))).not.toContain('/private/');
    } finally {
      input.close();
      await carrier.done;
    }
  });

  test('a pending capability read cannot block History or Runtime frames', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let release!: () => void;
    let calls = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unavailable = async (): Promise<never> => {
      throw new Error('unused');
    };
    const appControl: KiteAppControlClient = {
      queryWorkspaceTrust: unavailable,
      decideWorkspaceTrust: unavailable,
      getProviderModelSnapshot: unavailable,
      selectProviderModel: unavailable,
      setProviderModelEnabled: unavailable,
      getMcpSnapshot: unavailable,
      applyMcpAction: unavailable,
      getSkillCatalog: unavailable,
      getExecutionStatus: unavailable,
      getReleaseStatus: async () => {
        calls++;
        await held;
        return {
          schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
          revision: 'held',
          active: true,
          production: false,
          capabilities: [],
          execution: { admitted: false },
        };
      },
    };
    const carrier = createCarrier({
      input,
      output,
      appControl,
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: unavailable,
        loadSession: unavailable,
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'slow',
          method: 'app/release/status',
          params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
        })}\n`,
      );
      input.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'history',
          method: 'history/list_sessions',
          params: { request: { limit: 10 } },
        })}\n`,
      );
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'server/ping', params: {} })}\n`,
      );
      await eventually(() => protocolFrames(output).length === 3);
      expect(protocolFrames(output)).toContainEqual(
        expect.objectContaining({ id: 'history', result: { entries: [], hasMore: false } }),
      );
      expect(protocolFrames(output)).toContainEqual(expect.objectContaining({ id: 'ping' }));
      expect(protocolFrames(output)).not.toContainEqual(expect.objectContaining({ id: 'slow' }));
      for (let index = 0; index < 256; index++)
        input.pushText(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: `bounded-${index}`,
            method: 'app/release/status',
            params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
          })}\n`,
        );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'bounded-255',
        ),
      );
      await eventually(() => calls === 16);
      expect(calls).toBe(16);
      expect(protocolFrames(output)).toContainEqual(
        expect.objectContaining({
          id: 'bounded-255',
          error: expect.objectContaining({ data: { code: 'overloaded' } }),
        }),
      );
      input.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'history-after-app-saturation',
          method: 'history/list_sessions',
          params: { request: { limit: 10 } },
        })}\n`,
      );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'history-after-app-saturation',
        ),
      );
      expect(protocolFrames(output)).toContainEqual(
        expect.objectContaining({
          id: 'history-after-app-saturation',
          result: { entries: [], hasMore: false },
        }),
      );
    } finally {
      release();
      input.close();
      await carrier.done;
    }
  });

  test('bounded overload replies do not stall later ping behind blocked stdout', async () => {
    const input = new BytesInput();
    const output = new FakeOutput({ blockFirstWrite: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async () => {
          await held;
          return { entries: [], hasMore: false };
        },
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('unused');
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 1200 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `flood-${index}`,
            method: 'history/list_sessions',
            params: { request: { limit: 1 } },
          }),
        ).join('\n')}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 'after-flood-ping',
          method: 'server/ping',
          params: {},
        })}\n`,
      );
      await Bun.sleep(20);
      output.drain();
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'after-flood-ping',
        ),
      );
      const frames = protocolFrames(output);
      expect(frames).toContainEqual(expect.objectContaining({ id: 'after-flood-ping' }));
      expect(
        frames.filter(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'error' in frame &&
            (frame.error as { data?: { code?: string } }).data?.code === 'overloaded',
        ).length,
      ).toBeGreaterThan(900);
    } finally {
      release();
      input.close();
      await carrier.done;
    }
  });

  test('closes a blocked connection before output responses can grow without bound', async () => {
    const input = new BytesInput();
    const output = new FakeOutput({ blockFirstWrite: true });
    const diagnostics = new FakeDiagnostics();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const carrier = createCarrier({
      input,
      output,
      diagnostics,
      history: {
        listSessions: async () => {
          await held;
          return { entries: [], hasMore: false };
        },
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('unused');
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 3000 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `saturated-${index}`,
            method: 'history/list_sessions',
            params: { request: { limit: 1 } },
          }),
        ).join('\n')}\n`,
      );
      await eventually(() => diagnostics.text().includes('stdout_overloaded'));
      expect(output.writeCount).toBe(1);
    } finally {
      release();
      output.drain();
      input.close();
      await carrier.done;
    }
    await eventually(() => carrier.server.connectionCount === 0);
  });

  test('a saturated History queue leaves capability status capacity available', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const carrier = createCarrier({
      input,
      output,
      appControl: {
        getReleaseStatus: async () => ({
          schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
          revision: 'available',
          active: true,
          production: false,
          capabilities: [],
          execution: { admitted: false },
        }),
      } as unknown as KiteAppControlClient,
      history: {
        listSessions: async () => {
          await held;
          return { entries: [], hasMore: false };
        },
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('unused');
        },
      },
    });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 256 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `history-held-${index}`,
            method: 'history/list_sessions',
            params: { request: { limit: 1 } },
          }),
        ).join('\n')}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 'status-after-history-saturation',
          method: 'app/release/status',
          params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
        })}\n`,
      );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'status-after-history-saturation',
        ),
      );
      expect(protocolFrames(output)).toContainEqual(
        expect.objectContaining({
          id: 'status-after-history-saturation',
          result: expect.objectContaining({
            method: 'app/release/status',
            response: expect.objectContaining({ revision: 'available' }),
          }),
        }),
      );
    } finally {
      release();
      input.close();
      await carrier.done;
    }
  });

  test('bounds and fairly schedules App reads across connections', async () => {
    const server = new RuntimeServer(
      { runtime: new FakeRuntime(), admission: allowAdmission },
      { serverInfo: { version: 'test', instanceId: 'shared-app-reads' }, appMethods: true },
    );
    let held = true;
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const peers = Array.from({ length: 3 }, (_, index) => {
      const input = new BytesInput();
      const output = new FakeOutput();
      const appControl = {
        getReleaseStatus: async () => {
          started.push(index);
          active++;
          peak = Math.max(peak, active);
          if (held) await new Promise<void>((resolve) => releases.push(resolve));
          active--;
          return {
            schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
            revision: 'available',
            active: true,
            production: false,
            capabilities: [],
            execution: { admitted: false },
          };
        },
      } as unknown as KiteAppControlClient;
      const carrier = createRuntimeStdioCarrier({
        server,
        stdin: input,
        stdout: output,
        appControl,
      });
      return { index, input, output, carrier };
    });
    const read = (peer: number, index: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: `app-${peer}-${index}`,
        method: 'app/release/status',
        params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
      });
    try {
      for (const peer of peers) peer.input.pushText(initializeLine());
      await eventually(() => peers.every((peer) => protocolFrames(peer.output).length === 1));
      peers[0]!.input.pushText(
        `${Array.from({ length: 40 }, (_, index) => read(0, index)).join('\n')}\n`,
      );
      await eventually(() => active === 16);
      for (const peer of peers.slice(1))
        peer.input.pushText(
          `${Array.from({ length: 40 }, (_, index) => read(peer.index, index)).join('\n')}\n${JSON.stringify({ jsonrpc: '2.0', id: `ping-${peer.index}`, method: 'server/ping', params: {} })}\n`,
        );
      await eventually(() =>
        peers
          .slice(1)
          .every((peer) =>
            protocolFrames(peer.output).some(
              (frame) =>
                typeof frame === 'object' &&
                frame !== null &&
                'id' in frame &&
                frame.id === `ping-${peer.index}`,
            ),
          ),
      );
      expect(peak).toBe(16);
      for (const release of releases.splice(0)) release();
      await eventually(() => started.length >= 32);
      expect(new Set(started.slice(16, 32))).toEqual(new Set([0, 1, 2]));
      expect(peak).toBeLessThanOrEqual(16);
    } finally {
      held = false;
      for (const release of releases.splice(0)) release();
      for (const peer of peers) peer.input.close();
      await Promise.all(peers.map((peer) => peer.carrier.done));
    }
  });

  test('times out held App reads once without releasing their physical execution slots', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const carrier = createCarrier({
      input,
      output,
      appControl: {
        getReleaseStatus: async () => {
          started++;
          await held;
          return {
            schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
            revision: 'available',
            active: true,
            production: false,
            capabilities: [],
            execution: { admitted: false },
          };
        },
      } as unknown as KiteAppControlClient,
    });
    const read = (id: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'app/release/status',
        params: { request: { schema: RELEASE_STATUS_REQUEST_SCHEMA_ } },
      });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 16 }, (_, index) => read(`held-${index}`)).join('\n')}\n`,
      );
      await eventually(() => started === 16);
      await Bun.sleep(10_100);
      await eventually(() => protocolFrames(output).length === 17);
      expect(protocolFrames(output).slice(1)).toHaveLength(16);
      expect(
        protocolFrames(output)
          .slice(1)
          .every(
            (frame) =>
              typeof frame === 'object' &&
              frame !== null &&
              'error' in frame &&
              (frame.error as { data?: { detailCode?: string } }).data?.detailCode ===
                'temporarily_unavailable',
          ),
      ).toBe(true);
      input.pushText(
        `${read('after-timeout')}\n${JSON.stringify({ jsonrpc: '2.0', id: 'ping-after-timeout', method: 'server/ping', params: {} })}\n`,
      );
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'ping-after-timeout',
        ),
      );
      expect(started).toBe(16);
      release();
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            frame.id === 'after-timeout',
        ),
      );
      expect(
        protocolFrames(output).filter(
          (frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            'id' in frame &&
            typeof frame.id === 'string' &&
            frame.id.startsWith('held-'),
        ),
      ).toHaveLength(16);
    } finally {
      release();
      input.close();
      await carrier.done;
    }
  }, 15_000);

  test('shares a bounded fair History queue across connections and cancels disconnected reads', async () => {
    const server = new RuntimeServer(
      { runtime: new FakeRuntime(), admission: allowAdmission },
      { serverInfo: { version: 'test', instanceId: 'shared-server' } },
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const history: import('@kite-ai/runtime-client').RuntimeHistoryClient = {
      listSessions: async (request) => {
        const name = request.query ?? 'unknown';
        started.push(name);
        active++;
        peak = Math.max(peak, active);
        await held;
        active--;
        return { entries: [], hasMore: false };
      },
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => {
        throw new Error('unused');
      },
    };
    const peers = Array.from({ length: 5 }, (_, index) => {
      const input = new BytesInput();
      const output = new FakeOutput();
      const carrier = createRuntimeStdioCarrier({ server, stdin: input, stdout: output, history });
      return { index, input, output, carrier };
    });
    try {
      for (const peer of peers) peer.input.pushText(initializeLine());
      await eventually(() => peers.every((peer) => protocolFrames(peer.output).length === 1));
      for (const peer of peers.slice(0, 4)) {
        peer.input.pushText(
          `${Array.from({ length: 220 }, (_, index) =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: `peer-${peer.index}-read-${index}`,
              method: 'history/list_sessions',
              params: { request: { query: `peer-${peer.index}`, limit: 1 } },
            }),
          ).join('\n')}\n${JSON.stringify({
            jsonrpc: '2.0',
            id: `peer-${peer.index}-ping`,
            method: 'server/ping',
            params: {},
          })}\n`,
        );
      }
      await eventually(() =>
        peers
          .slice(0, 4)
          .every((peer) =>
            protocolFrames(peer.output).some(
              (frame) =>
                typeof frame === 'object' &&
                frame !== null &&
                'id' in frame &&
                frame.id === `peer-${peer.index}-ping`,
            ),
          ),
      );
      const fifth = peers[4]!;
      fifth.input.pushText(
        `${Array.from({ length: 220 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `peer-4-read-${index}`,
            method: 'history/list_sessions',
            params: { request: { query: 'peer-4', limit: 1 } },
          }),
        ).join('\n')}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 'peer-4-ping',
          method: 'server/ping',
          params: {},
        })}\n`,
      );
      await eventually(() =>
        peers.every((peer) =>
          protocolFrames(peer.output).some(
            (frame) =>
              typeof frame === 'object' &&
              frame !== null &&
              'id' in frame &&
              frame.id === `peer-${peer.index}-ping`,
          ),
        ),
      );
      await eventually(() => active === 8);
      expect(peak).toBe(8);
      expect(started.length).toBe(8);
      const disconnected = peers[4]!;
      void disconnected.carrier.connection.close('test_disconnect');
      const startedBeforeRelease = started.filter((name) => name === 'peer-4').length;
      release();
      await eventually(() => active === 0);
      await eventually(() =>
        peers
          .slice(0, 4)
          .every(
            (peer) =>
              protocolFrames(peer.output).filter(
                (frame) =>
                  typeof frame === 'object' &&
                  frame !== null &&
                  'id' in frame &&
                  typeof frame.id === 'string' &&
                  frame.id.startsWith(`peer-${peer.index}-read-`),
              ).length === 220,
          ),
      );
      expect(peak).toBeLessThanOrEqual(8);
      expect(started.filter((name) => name === 'peer-4')).toHaveLength(startedBeforeRelease);
      expect(new Set(started.slice(8, 12))).toEqual(
        new Set(['peer-0', 'peer-1', 'peer-2', 'peer-3']),
      );
      for (const peer of peers.slice(0, 4)) {
        const frames = protocolFrames(peer.output) as Array<{ id?: string; error?: unknown }>;
        expect(
          frames
            .filter((frame) => frame.id?.includes('-read-'))
            .every((frame) => frame.id?.startsWith(`peer-${peer.index}-read-`)),
        ).toBe(true);
      }
      const rejected = protocolFrames(disconnected.output).filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          'error' in frame &&
          (frame.error as { data?: { code?: string } }).data?.code === 'overloaded',
      );
      expect(rejected.length).toBeGreaterThan(0);
    } finally {
      release();
      for (const peer of peers) peer.input.close();
      await Promise.all(peers.map((peer) => peer.carrier.done));
    }
  });

  test('History cancel notifications remove queued work and release active capacity', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const carrier = createCarrier({
      input,
      output,
      history: {
        listSessions: async (request) => {
          started.push(request.query ?? 'unknown');
          await held;
          return { entries: [], hasMore: false };
        },
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
        loadSession: async () => {
          throw new Error('unused');
        },
      },
    });
    const read = (id: string, query: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'history/list_sessions',
        params: { request: { query, limit: 1 } },
      });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${Array.from({ length: 8 }, (_, index) => read(`active-${index}`, `active-${index}`)).join('\n')}\n${read('cancel-me', 'cancel-me')}\n`,
      );
      await eventually(() => started.length === 8);
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'history/cancel', params: { requestId: 'cancel-me' } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'history/cancel', params: { requestId: 'active-0' } })}\n${read('keep-me', 'keep-me')}\n`,
      );
      await eventually(() => started.includes('keep-me'));
      release();
      await eventually(() =>
        protocolFrames(output).some(
          (frame) =>
            typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === 'keep-me',
        ),
      );
      expect(started).not.toContain('cancel-me');
      expect(started).toContain('keep-me');
      expect(protocolFrames(output)).not.toContainEqual(
        expect.objectContaining({ id: 'cancel-me' }),
      );
      expect(protocolFrames(output)).not.toContainEqual(
        expect.objectContaining({ id: 'active-0' }),
      );
    } finally {
      release();
      input.close();
      await carrier.done;
    }
  });

  test('rejects an id-bearing History cancel request instead of silently consuming it', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });
    try {
      input.pushText(initializeLine());
      await eventually(() => protocolFrames(output).length === 1);
      input.pushText(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'bad-cancel', method: 'history/cancel', params: { requestId: 'other' } })}\n`,
      );
      await eventually(() => protocolFrames(output).length === 2);
      expect(protocolFrames(output)[1]).toMatchObject({
        id: 'bad-cancel',
        error: { data: { code: 'invalid_request' } },
      });
    } finally {
      input.close();
      await carrier.done;
    }
  });

  test('closing stalled History reads releases the shared execution slots', async () => {
    const server = new RuntimeServer(
      { runtime: new FakeRuntime(), admission: allowAdmission },
      { serverInfo: { version: 'test', instanceId: 'stalled-history' } },
    );
    let stalled = 0;
    const history: import('@kite-ai/runtime-client').RuntimeHistoryClient = {
      listSessions: (request) => {
        if (request.query === 'stalled') {
          stalled++;
          return new Promise(() => undefined);
        }
        return Promise.resolve({ entries: [], hasMore: false });
      },
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => {
        throw new Error('unused');
      },
    };
    const firstInput = new BytesInput();
    const firstOutput = new FakeOutput();
    const first = createRuntimeStdioCarrier({
      server,
      stdin: firstInput,
      stdout: firstOutput,
      history,
    });
    const secondInput = new BytesInput();
    const secondOutput = new FakeOutput();
    const second = createRuntimeStdioCarrier({
      server,
      stdin: secondInput,
      stdout: secondOutput,
      history,
    });
    try {
      firstInput.pushText(initializeLine());
      secondInput.pushText(initializeLine());
      await eventually(() => protocolFrames(firstOutput).length === 1);
      await eventually(() => protocolFrames(secondOutput).length === 1);
      firstInput.pushText(
        `${Array.from({ length: 8 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `stalled-${index}`,
            method: 'history/list_sessions',
            params: { request: { query: 'stalled', limit: 1 } },
          }),
        ).join('\n')}\n`,
      );
      await eventually(() => stalled === 8);
      await first.connection.close('test_disconnect');
      secondInput.pushText(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'fresh',
          method: 'history/list_sessions',
          params: { request: { limit: 1 } },
        })}\n`,
      );
      await eventually(() =>
        protocolFrames(secondOutput).some(
          (frame) =>
            typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === 'fresh',
        ),
      );
    } finally {
      firstInput.close();
      secondInput.close();
      await Promise.all([first.done, second.done]);
    }
  });

  test('bounds aggregate queued History input bytes across connections', async () => {
    const server = new RuntimeServer(
      { runtime: new FakeRuntime(), admission: allowAdmission },
      { serverInfo: { version: 'test', instanceId: 'byte-budget' } },
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    const history: import('@kite-ai/runtime-client').RuntimeHistoryClient = {
      listSessions: async (request) => {
        if (request.query === 'hold') {
          active++;
          await held;
        }
        return { entries: [], hasMore: false };
      },
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => {
        throw new Error('unused');
      },
    };
    const peers = Array.from({ length: 5 }, () => {
      const input = new BytesInput();
      const output = new FakeOutput();
      const carrier = createRuntimeStdioCarrier({ server, stdin: input, stdout: output, history });
      return { input, output, carrier };
    });
    try {
      for (const peer of peers) peer.input.pushText(initializeLine());
      await eventually(() => peers.every((peer) => protocolFrames(peer.output).length === 1));
      peers[0]!.input.pushText(
        `${Array.from({ length: 8 }, (_, index) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: `hold-${index}`,
            method: 'history/list_sessions',
            params: { request: { query: 'hold', limit: 1 } },
          }),
        ).join('\n')}\n`,
      );
      await eventually(() => active === 8);
      const largeQuery = 'x'.repeat(900_000);
      for (const [index, peer] of peers.entries()) {
        peer.input.pushText(
          `${Array.from({ length: 3 }, (_, offset) =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: `large-${index}-${offset}`,
              method: 'history/list_sessions',
              params: { request: { query: largeQuery, limit: 1 } },
            }),
          ).join('\n')}\n`,
        );
      }
      await eventually(() =>
        peers.some((peer) =>
          protocolFrames(peer.output).some(
            (frame) =>
              typeof frame === 'object' &&
              frame !== null &&
              'error' in frame &&
              (frame.error as { data?: { code?: string } }).data?.code === 'overloaded',
          ),
        ),
      );
      expect(active).toBe(8);
    } finally {
      release();
      for (const peer of peers) peer.input.close();
      await Promise.all(peers.map((peer) => peer.carrier.done));
    }
  });

  test('routes only provider credential writes and never echoes secret material', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const credential: NativeProviderCredentialClient = Object.freeze({
      writeProviderCredential: async (
        request: Parameters<NativeProviderCredentialClient['writeProviderCredential']>[0],
      ) =>
        ({
          schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
          mutationId: request.mutationId,
          operation: 'write_provider_api_key',
          outcome: 'applied',
          credentialPresent: true,
          revision: 'credential-1',
        }) as const,
    });
    const carrier = createCarrier({ input, output, credential });
    input.pushText(initializeLine());
    await eventually(() => protocolFrames(output).length === 1);
    input.pushText(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'credential',
        method: 'app/provider_credential/write',
        params: {
          request: {
            schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
            mutationId: 'credential-1',
            operation: 'write_provider_api_key',
            providerId: 'openai',
            apiKey: 'must-not-echo',
          },
        },
      })}\n`,
    );
    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)[1]).toMatchObject({
      id: 'credential',
      result: {
        method: 'app/provider_credential/write',
        response: {
          schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
          outcome: 'applied',
          credentialPresent: true,
        },
      },
    });
    expect(output.text()).not.toContain('must-not-echo');
    input.close();
    await carrier.done;
  });

  test('fails closed for invalid UTF-8 and overlong raw lines without echoing input', async () => {
    const invalidInput = new BytesInput();
    const invalidOutput = new FakeOutput();
    const invalidDiagnostics = new FakeDiagnostics();
    const invalid = createCarrier({
      input: invalidInput,
      output: invalidOutput,
      diagnostics: invalidDiagnostics,
    });
    invalidInput.push(new Uint8Array([0xc3, 0x28, 0x0a]));
    await invalid.done;
    expect(invalidOutput.text()).toBe('');
    expect(invalidDiagnostics.text()).toContain('invalid_utf8');
    expect(invalidDiagnostics.text()).not.toContain('c3');

    const overlongInput = new BytesInput();
    const overlongOutput = new FakeOutput();
    const overlongDiagnostics = new FakeDiagnostics();
    const overlong = createCarrier({
      input: overlongInput,
      output: overlongOutput,
      diagnostics: overlongDiagnostics,
      maxLineBytes: 8,
    });
    overlongInput.pushText('123456789');
    await overlong.done;
    expect(overlongOutput.text()).toBe('');
    expect(overlongDiagnostics.text()).toContain('overlong_line');
  });

  test('serializes stdout writes, waits for drain, and closes on a bounded drain timeout', async () => {
    const input = new BytesInput();
    const output = new FakeOutput({ blockFirstWrite: true });
    const carrier = createCarrier({ input, output, drainDeadlineMs: 50 });

    input.pushText('{not json}\n');
    input.pushText(initializeLine());
    await eventually(() => output.writeCount === 1);
    expect(protocolFrames(output)).toHaveLength(1);
    output.drain();
    await eventually(() => protocolFrames(output).length === 2);
    input.close();
    await carrier.done;

    const timeoutInput = new BytesInput();
    const timeoutOutput = new FakeOutput({ blockFirstWrite: true });
    const timeoutDiagnostics = new FakeDiagnostics();
    const timeout = createCarrier({
      input: timeoutInput,
      output: timeoutOutput,
      diagnostics: timeoutDiagnostics,
      drainDeadlineMs: 5,
    });
    timeoutInput.pushText('{not json}\n');
    await timeout.done;
    await eventually(() => timeout.server.connectionCount === 0);
    expect(timeoutDiagnostics.text()).toContain('stdout_failure');
  });

  test('stdin EOF releases only the Server connection, not the owner composition', async () => {
    const input = new BytesInput();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output: new FakeOutput(),
      shutdownComposition: () => {
        releases += 1;
      },
    });

    expect(carrier.server.connectionCount).toBe(1);
    input.close();
    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(releases).toBe(0);

    const reconnectInput = new BytesInput();
    const reconnectOutput = new FakeOutput();
    const reconnect = createRuntimeStdioCarrier({
      server: carrier.server,
      stdin: reconnectInput,
      stdout: reconnectOutput,
    });
    reconnectInput.pushText(initializeLine());
    await eventually(() => protocolFrames(reconnectOutput).length === 1);
    reconnectInput.close();
    await reconnect.done;
    expect(releases).toBe(0);
  });

  test('an input transport failure releases its connection without releasing composition', async () => {
    let releases = 0;
    const diagnostics = new FakeDiagnostics();
    const carrier = createCarrier({
      input: new FailingInput(),
      output: new FakeOutput(),
      diagnostics,
      shutdownComposition: () => {
        releases += 1;
      },
    });

    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(diagnostics.text()).toContain('input_failure');
    expect(releases).toBe(0);
  });

  test('stdin EOF retains owner signals until SIGTERM drains, flushes, and releases composition', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const signals = new FakeSignals();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output,
      signals,
      shutdownComposition: () => {
        releases += 1;
      },
    });

    input.close();
    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(releases).toBe(0);
    expect(signals.listenerCount()).toBe(2);

    signals.emit('SIGTERM');
    await carrier.shutdown();
    expect(releases).toBe(1);
    expect(output.flushCount).toBe(1);
    expect(signals.listenerCount()).toBe(0);
  });

  test('owner signals and explicit shutdown are idempotent, drain, flush, and release composition once', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const signals = new FakeSignals();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output,
      signals,
      shutdownComposition: async () => {
        releases += 1;
      },
    });

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await carrier.shutdown();
    await carrier.done;

    expect(releases).toBe(1);
    expect(output.flushCount).toBe(1);
    expect(protocolFrames(output)).toContainEqual(
      expect.objectContaining({ method: 'server/draining' }),
    );
    expect(signals.listenerCount()).toBe(0);
  });
});

function createCarrier(options: {
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: FakeOutput;
  readonly diagnostics?: FakeDiagnostics;
  readonly signals?: FakeSignals;
  readonly maxLineBytes?: number;
  readonly drainDeadlineMs?: number;
  readonly shutdownComposition?: () => void | Promise<void>;
  readonly appControl?: KiteAppControlClient;
  readonly removeWorkspace?: import('#kite-service/carrier/runtime-server-stdio').RuntimeStdioCarrierOptions['removeWorkspace'];
  readonly credential?: NativeProviderCredentialClient;
  readonly history?: import('@kite-ai/runtime-client').RuntimeHistoryClient &
    Partial<import('../../src/runtime-client/history-page-pool').KiteHistoryPageClient>;
}) {
  const server = new RuntimeServer(
    { runtime: new FakeRuntime(), admission: allowAdmission },
    {
      serverInfo: { version: 'test', instanceId: 'server-1' },
      ...(options.appControl || options.credential || options.removeWorkspace
        ? { appMethods: true }
        : {}),
    },
  );
  const carrier = createRuntimeStdioCarrier({
    server,
    stdin: options.input,
    stdout: options.output,
    stderr: options.diagnostics,
    signals: options.signals,
    maxLineBytes: options.maxLineBytes,
    drainDeadlineMs: options.drainDeadlineMs,
    shutdownComposition: options.shutdownComposition,
    appControl: options.appControl,
    removeWorkspace: options.removeWorkspace,
    credential: options.credential,
    history: options.history,
  });
  return { ...carrier, server };
}

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

function initializeLine(): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '1', instanceId: 'a' },
    },
  })}\n`;
}

function protocolFrames(output: FakeOutput): unknown[] {
  return output
    .text()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

class BytesInput implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters = new Set<(result: IteratorResult<Uint8Array>) => void>();
  #closed = false;

  push(value: Uint8Array): void {
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  pushText(value: string): void {
    this.push(encoder.encode(value));
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<Uint8Array>>((resolve) => this.#waiters.add(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

class FailingInput implements AsyncIterable<Uint8Array> {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        throw new Error('simulated child transport failure');
      },
    };
  }
}

class FakeOutput implements RuntimeStdioOutput {
  readonly #chunks: Uint8Array[] = [];
  readonly #blockFirstWrite: boolean;
  #drainPromise: Promise<void> | undefined;
  #resolveDrain: (() => void) | undefined;
  writeCount = 0;
  flushCount = 0;

  constructor(options: { readonly blockFirstWrite?: boolean } = {}) {
    this.#blockFirstWrite = options.blockFirstWrite ?? false;
  }

  write(chunk: Uint8Array): boolean {
    this.writeCount += 1;
    this.#chunks.push(new Uint8Array(chunk));
    if (this.#blockFirstWrite && this.writeCount === 1) {
      this.#drainPromise ??= new Promise<void>((resolve) => {
        this.#resolveDrain = resolve;
      });
      return false;
    }
    return true;
  }

  waitForDrain(): Promise<void> {
    return this.#drainPromise ?? Promise.resolve();
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  drain(): void {
    this.#resolveDrain?.();
  }

  text(): string {
    return decoder.decode(concat(this.#chunks));
  }
}

class FakeDiagnostics implements RuntimeStdioDiagnostics {
  readonly #messages: string[] = [];

  write(message: string): void {
    this.#messages.push(message);
  }

  text(): string {
    return this.#messages.join('');
  }
}

class FakeSignals implements RuntimeStdioSignals {
  readonly #listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();

  subscribe(signal: 'SIGINT' | 'SIGTERM', listener: () => void): () => void {
    const listeners = this.#listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
    return () => listeners.delete(listener);
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class FakeRuntime implements RuntimeAccess {
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

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Condition did not settle.');
}
