import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeWebSocketLike } from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSessionProjection,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RuntimeServer, type RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import {
  createDevelopmentLoopbackCarrier,
  type DevelopmentLoopbackCarrier,
} from '#kite-service/carrier/development-loopback-carrier';
import {
  createDevelopmentRuntimeReference,
  DevelopmentRuntimeReferenceHistoryUnavailableError,
} from '#kite-service/carrier/development-runtime-reference';

const DEADLINE_MS = 1_500;
const carriers: DevelopmentLoopbackCarrier[] = [];

afterEach(async () => {
  await within(Promise.all(carriers.splice(0).map((carrier) => carrier.close())));
});

describe('development runtime reference consumer', () => {
  test('uses header-only bootstrap, reuses RuntimeClient query/index state, and retains hostile text as data', async () => {
    const hostileDisplayName = '<img src=x onerror="globalThis.pwned=true">';
    const runtime = new FakeRuntime(session('session-one', 4, hostileDisplayName));
    const carrier = track(createCarrier(runtime));
    const bootstrapBearer = carrier.bootstrapBearer;
    let capturedBootstrap: Readonly<{ url: string; init: RequestInit | undefined }> | undefined;
    let cookie = '';
    let capturedSocketUrl: string | undefined;
    const reference = createDevelopmentRuntimeReference({
      origin: carrier.origin,
      bootstrapBearer,
      clientInfo: { name: 'development-reference-test', version: '1', instanceId: 'reference' },
      fetch: async (input, init) => {
        capturedBootstrap = { url: String(input), init };
        const response = await globalThis.fetch(input, {
          ...init,
          // Bun's headless fetch does not synthesize browser Origin/cookie state;
          // the injected seam supplies it after checking the consumer request.
          headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: carrier.origin },
        });
        cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        return response;
      },
      webSocketFactory: (url) => {
        capturedSocketUrl = url;
        return new WebSocket(url, {
          headers: { Cookie: cookie, Origin: carrier.origin },
        } as unknown as string[]) as unknown as RuntimeWebSocketLike;
      },
    });

    try {
      await within(reference.connect());
      expect(capturedBootstrap).toEqual({
        url: `${carrier.origin}/_kite/bootstrap`,
        init: expect.objectContaining({ method: 'POST', credentials: 'include' }),
      });
      const bootstrap = capturedBootstrap as Readonly<{ url: string; init: RequestInit }>;
      expect(bootstrap.url).not.toContain(bootstrapBearer);
      expect(bootstrap.init.body).toBeUndefined();
      expect(Object.fromEntries(new Headers(bootstrap.init.headers))).toEqual({
        authorization: `Kite-Dev-Bootstrap ${bootstrapBearer}`,
      });
      expect(capturedSocketUrl).toBe(carrier.rpcUrl);

      await expect(within(reference.listSessions())).resolves.toMatchObject({
        status: 'ok',
        queryType: 'list_sessions',
        sessions: [{ sessionId: 'session-one', revision: 4 }],
      });
      await waitFor(() => reference.view.getSnapshot().sessionIndexReady);
      const view = reference.view.getSnapshot();
      expect(view.sessions).toEqual([
        {
          sessionId: 'session-one',
          revision: 4,
          lifecycle: 'open',
          displayName: hostileDisplayName,
        },
      ]);
      // The facade returns text data only; it creates no DOM/HTML/eval sink.
      expect(view.sessions[0]?.displayName).toBe(hostileDisplayName);
      expect(JSON.stringify(view)).not.toContain('workspace');
    } finally {
      await within(reference.close());
      await waitFor(() => runtime.subscriptionCount === 0);
    }
  });

  test('uses only an explicitly injected history client and otherwise fails closed', async () => {
    const historyCalls: string[] = [];
    const history: RuntimeHistoryClient = {
      listSessions: async () => {
        historyCalls.push('sessions');
        return { entries: [], hasMore: false };
      },
      listEvents: async () => {
        historyCalls.push('events');
        return { entries: [], hasMore: false, observedLastSequence: 0 };
      },
      loadSession: async () => {
        throw new Error('Transcript reads are not part of this reference test.');
      },
    };
    const injected = createDevelopmentRuntimeReference({
      origin: 'http://127.0.0.1:54321',
      bootstrapBearer: 'test-bearer',
      clientInfo: { name: 'history-only', version: '1', instanceId: 'history-only' },
      history,
      fetch: async () => new Response(null, { status: 204 }),
      webSocketFactory: () => {
        throw new Error('history reads must not open a WebSocket');
      },
    });
    const unavailable = createDevelopmentRuntimeReference({
      origin: 'http://127.0.0.1:54322',
      bootstrapBearer: 'test-bearer',
      clientInfo: { name: 'history-none', version: '1', instanceId: 'history-none' },
      fetch: async () => new Response(null, { status: 204 }),
      webSocketFactory: () => {
        throw new Error('history reads must not open a WebSocket');
      },
    });
    try {
      await expect(injected.listHistorySessions({ limit: 1 })).resolves.toEqual({
        entries: [],
        hasMore: false,
      });
      await expect(
        injected.listHistoryEvents({ sessionId: 'session-one', direction: 'forward', limit: 1 }),
      ).resolves.toMatchObject({ observedLastSequence: 0 });
      expect(historyCalls).toEqual(['sessions', 'events']);
      await expect(unavailable.listHistorySessions({ limit: 1 })).rejects.toBeInstanceOf(
        DevelopmentRuntimeReferenceHistoryUnavailableError,
      );
    } finally {
      await within(injected.close());
      await within(unavailable.close());
    }
  });

  test('rejects every non-exact loopback origin before any bootstrap I/O', () => {
    for (const origin of [
      'http://localhost:54321',
      'http://192.0.2.10:54321',
      'https://127.0.0.1:54321',
      'http://127.0.0.1',
      'http://127.0.0.1:54321/reference',
      'http://127.0.0.1:54321?token=secret',
      'http://user:secret@127.0.0.1:54321',
    ]) {
      expect(() => createReferenceForOrigin(origin)).toThrow(
        'exact http://127.0.0.1:<port> origin',
      );
    }
  });
});

function createReferenceForOrigin(origin: string) {
  return createDevelopmentRuntimeReference({
    origin,
    bootstrapBearer: 'test-bearer',
    clientInfo: { name: 'origin-rejection', version: '1', instanceId: 'origin-rejection' },
    fetch: async () => new Response(null, { status: 204 }),
    webSocketFactory: () => {
      throw new Error('invalid origins must not reach WebSocket creation');
    },
  });
}

function createCarrier(runtime: FakeRuntime): DevelopmentLoopbackCarrier {
  return createDevelopmentLoopbackCarrier({
    server: new RuntimeServer(
      { runtime, admission: allowAdmission },
      { serverInfo: { version: 'reference-test', instanceId: 'reference-server' } },
    ),
    limits: { heartbeatIntervalMs: 200, heartbeatDeadlineMs: 600 },
  });
}

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

function track(carrier: DevelopmentLoopbackCarrier): DevelopmentLoopbackCarrier {
  carriers.push(carrier);
  return carrier;
}

function session(
  sessionId: string,
  revision: number,
  displayName?: string,
): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v2',
    sessionId,
    revision,
    ...(displayName === undefined ? {} : { displayName }),
    lifecycle: 'open',
    interactionQueue: { revision, interactions: [] },
  };
}

class FakeRuntime implements RuntimeAccess {
  readonly #session: RuntimeSessionProjection;
  readonly #subscriptions = new Set<ReferenceStream>();

  constructor(value: RuntimeSessionProjection) {
    this.#session = value;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  command(command: RuntimeCommand) {
    return Promise.resolve({
      status: 'applied' as const,
      commandId: command.commandId,
      sessionId: this.#session.sessionId,
      revision: this.#session.revision,
    });
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (query.type === 'get_session_projection') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#session.revision,
        session: this.#session,
      });
    }
    return Promise.resolve({
      status: 'ok',
      queryType: query.type,
      sessions: [this.#session],
    });
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const initial =
      subscription.spec.scope === 'sessions' ? indexReset(this.#session) : [durable(this.#session)];
    const stream = new ReferenceStream(initial, () => this.#subscriptions.delete(stream));
    this.#subscriptions.add(stream);
    return stream;
  }
}

function indexReset(value: RuntimeSessionProjection): RuntimeAccessNotification[] {
  return [
    {
      type: 'index_reset_begin',
      serverInstanceId: 'reference-server',
      generation: 1,
      indexRevision: 1,
    },
    {
      type: 'session_upsert',
      serverInstanceId: 'reference-server',
      generation: 1,
      indexRevision: 1,
      session: value,
    },
    {
      type: 'index_reset_end',
      serverInstanceId: 'reference-server',
      generation: 1,
      indexRevision: 1,
    },
  ];
}

function durable(value: RuntimeSessionProjection): RuntimeAccessNotification {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'durable',
    sessionId: value.sessionId,
    revision: value.revision,
    projection: { kind: 'session', session: value },
  };
}

class ReferenceStream implements AsyncIterable<RuntimeAccessNotification> {
  readonly #values: RuntimeAccessNotification[];
  readonly #onReturn: () => void;
  #closed = false;
  #resolve: ((value: IteratorResult<RuntimeAccessNotification>) => void) | undefined;

  constructor(values: RuntimeAccessNotification[], onReturn: () => void) {
    this.#values = [...values];
    this.#onReturn = onReturn;
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeAccessNotification> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false as const, value });
        if (this.#closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<RuntimeAccessNotification>>((resolve) => {
          this.#resolve = resolve;
        });
      },
      return: async () => {
        this.#close();
        return { done: true, value: undefined };
      },
    };
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.length = 0;
    this.#onReturn();
    this.#resolve?.({ done: true, value: undefined });
    this.#resolve = undefined;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a bounded condition.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bounded operation timed out.')), DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
