import { describe, expect, test } from 'bun:test';
import {
  agentApiContextSchema,
  agentApiProblemSchema,
  agentApiServerInfoSchema,
  decodeAgentApiResponse,
} from '@kite-ai/agent-api-contract';
import {
  AGENT_API_CONNECTION_AUTHORIZATION_SCHEME,
  AGENT_API_CONTEXT_TTL_MS,
  type AgentApiCapabilityBinding,
  type AgentApiReadContext,
  createAgentApiRouteHandler,
} from '../../src/agent-api';

const OBSERVER_BINDING: AgentApiCapabilityBinding = Object.freeze({
  workerScopeId: 'worker-scope-1',
  workerInstanceId: 'worker-instance-1',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  clientId: 'client-1',
  connectionGeneration: 1,
  purpose: 'agent_api_observer',
});

function fixture(
  options: {
    readonly maxContexts?: number;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly admitWorkspace?: () => Promise<'admitted' | 'untrusted' | 'unavailable'>;
    readonly openReadContext?: (binding: AgentApiCapabilityBinding) => Promise<AgentApiReadContext>;
    readonly capabilities?: readonly ('checkpoints' | 'history' | 'sessions')[];
  } = {},
) {
  let now = Date.parse('2026-08-30T00:00:00.000Z');
  let randomValue = 1;
  const capabilities = new Map<string, AgentApiCapabilityBinding>();
  const current = new Set<string>(['client-1:1', 'client-2:1']);
  let admission: 'admitted' | 'untrusted' | 'unavailable' = 'admitted';
  const handler = createAgentApiRouteHandler({
    serverVersion: 'service-test',
    buildId: 'build-test',
    now: () => now,
    randomBytes: options.randomBytes ?? ((size) => new Uint8Array(size).fill(randomValue++)),
    consumeCapability: (secret) => {
      const binding = capabilities.get(secret);
      if (binding) capabilities.delete(secret);
      return binding;
    },
    admitWorkspace: options.admitWorkspace ?? (async () => admission),
    isClientGenerationCurrent: (clientId, generation) => current.has(`${clientId}:${generation}`),
    ...(options.openReadContext ? { openReadContext: options.openReadContext } : {}),
    capabilities: options.capabilities ?? [],
    ...(options.maxContexts === undefined ? {} : { maxContexts: options.maxContexts }),
  });
  return {
    handler,
    issue(secret: string, binding: AgentApiCapabilityBinding = OBSERVER_BINDING) {
      capabilities.set(secret, binding);
    },
    hasCapability(secret: string) {
      return capabilities.has(secret);
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    invalidate(clientId: string, generation: number) {
      current.delete(`${clientId}:${generation}`);
    },
    setAdmission(value: 'admitted' | 'untrusted' | 'unavailable') {
      admission = value;
    },
  };
}

function exchangeRequest(capability: string, body: unknown = exchangeBody()): Request {
  return new Request('http://127.0.0.1:43123/v1/auth/exchange', {
    method: 'POST',
    headers: {
      authorization: `${AGENT_API_CONNECTION_AUTHORIZATION_SCHEME} ${capability}`,
      'content-type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function exchangeBody(requiredCapabilities: readonly string[] = []) {
  return {
    schema: 'kite.agent-api.exchange.v1',
    api_version: 'v1',
    required_capabilities: requiredCapabilities,
  };
}

async function exchange(f: ReturnType<typeof fixture>, capability: string) {
  const response = await f.handler.handle(exchangeRequest(capability));
  const body = decodeAgentApiResponse(agentApiContextSchema, await response.json());
  return { response, body };
}

function bearerRequest(path: string, token: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:43123${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
}

describe('Agent API context and route shell', () => {
  test('consumes one capability, returns a hash-only context, and serves ServerInfo', async () => {
    const f = fixture();
    f.issue('A'.repeat(43));
    const created = await exchange(f, 'A'.repeat(43));
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('x-request-id')).toMatch(/^req_[A-Za-z0-9_-]{22}$/u);
    expect(created.body.role).toBe('observer');
    expect(created.body.capabilities).toEqual([]);
    expect(created.body.expires_at).toBe('2026-08-30T01:00:00.000Z');
    expect(f.hasCapability('A'.repeat(43))).toBeFalse();

    const replay = await f.handler.handle(exchangeRequest('A'.repeat(43)));
    expect(replay.status).toBe(401);

    const infoResponse = await f.handler.handle(bearerRequest('/v1', created.body.access_token));
    expect(infoResponse.status).toBe(200);
    expect(infoResponse.headers.get('kite-agent-api-version')).toBe('v1');
    expect(infoResponse.headers.get('kite-agent-api-schema-digest')).toMatch(/^[a-f0-9]{64}$/u);
    const info = decodeAgentApiResponse(agentApiServerInfoSchema, await infoResponse.json());
    expect(info).toMatchObject({
      api_version: 'v1',
      server_version: 'service-test',
      build_id: 'build-test',
      capabilities: [],
    });
  });

  test('derives controller role only from the consumed capability purpose', async () => {
    const f = fixture();
    f.issue('B'.repeat(43), {
      ...OBSERVER_BINDING,
      clientId: 'client-2',
      purpose: 'agent_api_controller',
    });
    const created = await exchange(f, 'B'.repeat(43));
    expect(created.body.role).toBe('controller');
    const unavailableMutation = await f.handler.handle(
      bearerRequest('/v1/sessions/session-1/runs', created.body.access_token, 'POST'),
    );
    expect(unavailableMutation.status).toBe(404);
    expect(
      decodeAgentApiResponse(agentApiProblemSchema, await unavailableMutation.json()).code,
    ).toBe('not_found');
  });

  test('keeps request identity valid when random base64url material starts with underscore', async () => {
    const f = fixture({ randomBytes: (size) => new Uint8Array(size).fill(255) });
    f.issue('Q'.repeat(43));
    const created = await exchange(f, 'Q'.repeat(43));
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('x-request-id')).toMatch(/^req_[A-Za-z0-9_-]{22}$/u);
  });

  test('does not consume a capability for incompatibility or overload', async () => {
    const f = fixture({ maxContexts: 1 });
    f.issue('C'.repeat(43));
    const incompatible = await f.handler.handle(
      exchangeRequest('C'.repeat(43), exchangeBody(['sessions'])),
    );
    expect(incompatible.status).toBe(426);
    expect(f.hasCapability('C'.repeat(43))).toBeTrue();
    const first = await exchange(f, 'C'.repeat(43));

    f.issue('D'.repeat(43), { ...OBSERVER_BINDING, clientId: 'client-2' });
    const overloaded = await f.handler.handle(exchangeRequest('D'.repeat(43)));
    expect(overloaded.status).toBe(429);
    expect(overloaded.headers.get('retry-after')).toBe('1');
    expect(f.hasCapability('D'.repeat(43))).toBeTrue();

    expect(
      (await f.handler.handle(bearerRequest('/v1/auth/session', first.body.access_token, 'DELETE')))
        .status,
    ).toBe(204);
    expect((await exchange(f, 'D'.repeat(43))).response.status).toBe(201);
  });

  test('rechecks Workspace Trust before consuming the one-shot capability', async () => {
    const f = fixture();
    f.issue('T'.repeat(43));
    f.setAdmission('untrusted');
    expect((await f.handler.handle(exchangeRequest('T'.repeat(43)))).status).toBe(403);
    expect(f.hasCapability('T'.repeat(43))).toBeTrue();
    f.setAdmission('unavailable');
    expect((await f.handler.handle(exchangeRequest('T'.repeat(43)))).status).toBe(503);
    expect(f.hasCapability('T'.repeat(43))).toBeTrue();
    f.setAdmission('admitted');
    expect((await exchange(f, 'T'.repeat(43))).response.status).toBe(201);
  });

  test('expires, revokes, and generation-fences contexts without recovery or persistence', async () => {
    const f = fixture();
    f.issue('E'.repeat(43));
    const first = await exchange(f, 'E'.repeat(43));
    f.advance(AGENT_API_CONTEXT_TTL_MS);
    expect((await f.handler.handle(bearerRequest('/v1', first.body.access_token))).status).toBe(
      401,
    );

    f.issue('F'.repeat(43));
    const second = await exchange(f, 'F'.repeat(43));
    f.invalidate('client-1', 1);
    expect((await f.handler.handle(bearerRequest('/v1', second.body.access_token))).status).toBe(
      401,
    );
  });

  test('rejects browser signals, malformed media, duplicate fields, and response negotiation', async () => {
    const f = fixture();
    f.issue('G'.repeat(43));
    const browser = exchangeRequest('G'.repeat(43));
    browser.headers.set('origin', 'http://127.0.0.1:43123');
    expect((await f.handler.handle(browser)).status).toBe(403);
    expect(f.hasCapability('G'.repeat(43))).toBeTrue();

    const wrongMedia = exchangeRequest('G'.repeat(43));
    wrongMedia.headers.set('content-type', 'text/plain');
    expect((await f.handler.handle(wrongMedia)).status).toBe(415);

    const duplicate = exchangeRequest(
      'G'.repeat(43),
      '{"schema":"kite.agent-api.exchange.v1","schema":"kite.agent-api.exchange.v1","api_version":"v1","required_capabilities":[]}',
    );
    expect((await f.handler.handle(duplicate)).status).toBe(400);

    const created = await exchange(f, 'G'.repeat(43));
    const unacceptable = bearerRequest('/v1', created.body.access_token);
    unacceptable.headers.set('accept', 'text/html');
    expect((await f.handler.handle(unacceptable)).status).toBe(406);
  });

  test('fails closed for oversized request metadata and duplicate context token material', async () => {
    const f = fixture({ randomBytes: (size) => new Uint8Array(size).fill(7) });
    f.issue('I'.repeat(43));
    const first = await exchange(f, 'I'.repeat(43));

    const oversized = bearerRequest('/v1', first.body.access_token);
    oversized.headers.set('x-oversized', 'x'.repeat(8 * 1_024));
    expect((await f.handler.handle(oversized)).status).toBe(400);

    f.issue('J'.repeat(43), { ...OBSERVER_BINDING, clientId: 'client-2' });
    expect((await f.handler.handle(exchangeRequest('J'.repeat(43)))).status).toBe(503);
    expect(f.hasCapability('J'.repeat(43))).toBeTrue();
    expect((await f.handler.handle(bearerRequest('/v1', first.body.access_token))).status).toBe(
      200,
    );
  });

  test('does not consume a capability when Worker drain wins pending Trust admission', async () => {
    let markAdmissionEntered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      markAdmissionEntered = resolve;
    });
    let resolveAdmission!: (value: 'admitted') => void;
    const admission = new Promise<'admitted'>((resolve) => {
      resolveAdmission = resolve;
    });
    const f = fixture({
      admitWorkspace: async () => {
        markAdmissionEntered();
        return admission;
      },
    });
    f.issue('K'.repeat(43));
    const pending = f.handler.handle(exchangeRequest('K'.repeat(43)));
    await admissionEntered;
    f.handler.close();
    resolveAdmission('admitted');

    expect((await pending).status).toBe(503);
    expect(f.hasCapability('K'.repeat(43))).toBeTrue();
  });

  test('serves the injected read context and revokes it when Workspace Trust changes', async () => {
    let readCloseCalls = 0;
    const f = fixture({
      capabilities: ['checkpoints', 'history', 'sessions'],
      openReadContext: async () => {
        const close = async () => {
          readCloseCalls += 1;
        };
        return {
          query: async (query) =>
            query.type === 'get_session_projection'
              ? {
                  status: 'ok',
                  queryType: query.type,
                  revision: 2,
                  session: {
                    schema: 'kite.runtime-projection.v1',
                    sessionId: query.sessionId,
                    revision: 2,
                    lifecycle: 'open',
                    interactionQueue: { revision: 2, interactions: [] },
                  },
                }
              : { status: 'rejected', queryType: query.type, code: 'unsupported' },
          history: {
            listSessions: async () => ({ entries: [], hasMore: false }),
            listEvents: async () => ({
              entries: [],
              hasMore: false,
              observedLastSequence: 0,
            }),
          },
          checkpoints: {
            list: () => ({ entries: [], hasMore: false }),
            get: () => undefined,
          },
          close,
          [Symbol.asyncDispose]: close,
        };
      },
    });
    f.issue('R'.repeat(43));
    const created = await exchange(f, 'R'.repeat(43));
    expect(created.body.capabilities).toEqual(['checkpoints', 'history', 'sessions']);
    const session = await f.handler.handle(
      bearerRequest('/v1/sessions/session-1', created.body.access_token),
    );
    expect(session.status).toBe(200);
    expect(session.headers.get('etag')).toBe('"session:session-1:rev:2"');

    f.setAdmission('untrusted');
    expect((await f.handler.handle(bearerRequest('/v1', created.body.access_token))).status).toBe(
      403,
    );
    expect(readCloseCalls).toBe(1);
    f.setAdmission('admitted');
    expect((await f.handler.handle(bearerRequest('/v1', created.body.access_token))).status).toBe(
      401,
    );
  });

  test('waits for a pending private read connection and closes it during Worker drain', async () => {
    let markOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      markOpening = resolve;
    });
    let resolveRead!: (value: AgentApiReadContext) => void;
    const read = new Promise<AgentApiReadContext>((resolve) => {
      resolveRead = resolve;
    });
    let readCloseCalls = 0;
    const f = fixture({
      openReadContext: async () => {
        markOpening();
        return read;
      },
    });
    f.issue('S'.repeat(43));
    const exchanging = f.handler.handle(exchangeRequest('S'.repeat(43)));
    await opening;
    const closing = f.handler.close();
    const close = async () => {
      readCloseCalls += 1;
    };
    resolveRead({
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      history: {
        listSessions: async () => ({ entries: [], hasMore: false }),
        listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      },
      checkpoints: {
        list: () => ({ entries: [], hasMore: false }),
        get: () => undefined,
      },
      close,
      [Symbol.asyncDispose]: close,
    });

    expect((await exchanging).status).toBe(503);
    await closing;
    expect(readCloseCalls).toBe(1);
  });

  test('closes all contexts on Worker drain/replacement', async () => {
    const f = fixture();
    f.issue('H'.repeat(43));
    const created = await exchange(f, 'H'.repeat(43));
    f.handler.close();
    const unavailable = await f.handler.handle(bearerRequest('/v1', created.body.access_token));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('1');
  });
});
