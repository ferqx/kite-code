import { afterEach, describe, expect, test } from 'bun:test';
import type {
  ExecutionStatusSnapshot,
  KiteAppControlClient,
  KiteWorkspaceIdentity,
  ProviderModelSnapshot,
  ReleaseStatusSnapshot,
  SkillCatalogSnapshot,
  WorkspaceTrustDecisionResponse,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  MCP_ACTION_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  type NativeProviderCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RUNTIME_PROTOCOL_LIMITS, type RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  RuntimeServer,
  type RuntimeServerAdmissionDecision,
  type RuntimeServerAdmissionInput,
} from '@kite-ai/runtime-server';
import {
  createKiteServiceCarrier,
  KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONNECT_PATH,
  KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONTROL_STOP_PATH,
  KITE_SERVICE_HISTORY_LIST_EVENTS_PATH,
  KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH,
  KITE_SERVICE_HISTORY_LOAD_SESSION_PATH,
  KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME,
  type KiteServiceCarrier,
  type KiteServiceCarrierLimits,
} from '../../../src/carrier';
import { KITE_SERVICE_INSTANCE_HANDSHAKE_PATH } from '../../../src/carrier/native-loopback-carrier';
import type { KiteServiceApplicationPort } from '../../../src/carrier/ports';

const ACCESS_TOKEN = 'A'.repeat(43);
const CONTROL_TOKEN = 'B'.repeat(43);
const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-service-workspace',
  projectId: 'project-1',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const otherWorkspace: KiteWorkspaceIdentity = {
  ...workspace,
  canonicalPath: '/tmp/other-workspace',
  projectId: 'project-2',
  workspaceDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
};

const carriers: KiteServiceCarrier[] = [];

function providerSnapshot(): ProviderModelSnapshot {
  return {
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision: 'revision-1',
    providers: [],
  };
}

afterEach(async () => {
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

describe('Kite Service Native loopback carrier', () => {
  test('serves fixed health/readiness and separates access/control credentials', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);

    expect(await fetch(`${carrier.origin}/healthz`).then((response) => response.text())).toBe('ok');
    expect(await fetch(`${carrier.origin}/readyz`).then((response) => response.text())).toBe(
      'ready',
    );
    expect(
      await fetch(`${carrier.origin}/_kite/connect`, { method: 'POST' }).then(
        (response) => response.status,
      ),
    ).toBe(401);

    const wrongAccess = await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    });
    expect(wrongAccess.status).toBe(401);

    const connect = await connectWorkspace(carrier);
    expect(connect.response.status).toBe(200);
    expect(connect.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const accessOnControl = await fetch(`${carrier.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: '{}',
    });
    expect(accessOnControl.status).toBe(401);

    const control = await fetch(`${carrier.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
      body: '{}',
    });
    expect(control.status).toBe(200);
    expect(fixture.stopCalls).toBe(1);

    const queryToken = await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}?token=secret`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    });
    expect(queryToken.status).toBe(403);
    expect(await queryToken.text()).not.toContain('secret');

    const cookie = await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        cookie: 'session=not-supported',
      },
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    });
    expect(cookie.status).toBe(401);
  });

  test('serves an authenticated exact instance handshake and stops serving it after close', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const handshake = await fetch(`${carrier.origin}${KITE_SERVICE_INSTANCE_HANDSHAKE_PATH}`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        origin: carrier.origin,
      },
      body: '{}',
    });
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get('cache-control')).toBe('no-store');
    expect(await handshake.json()).toEqual({
      schema: 'kite.local-runtime.instance-handshake.v1',
      instanceId: 'instance-1',
      protocolVersion: 1,
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      serverVersion: 'service-test',
      buildId: 'dev:0123456789012345678901234567890123456789',
    });

    const wrongToken = await fetch(`${carrier.origin}${KITE_SERVICE_INSTANCE_HANDSHAKE_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
      body: '{}',
    });
    expect(wrongToken.status).toBe(401);

    const extra = await fetch(`${carrier.origin}${KITE_SERVICE_INSTANCE_HANDSHAKE_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ instanceId: 'caller-controlled' }),
    });
    expect(extra.status).toBe(400);

    await carrier.close();
    expect(
      await fetch(`${carrier.origin}${KITE_SERVICE_INSTANCE_HANDSHAKE_PATH}`).then(
        (response) => response.status,
        () => 0,
      ),
    ).not.toBe(200);
  });

  test('issues one-shot workspace tickets and routes RuntimeServer with per-connection admission', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const first = await connectWorkspace(carrier);
    const socket = await openSocket(carrier, first.ticket);
    const messages = new SocketMessages(socket);
    socket.send(JSON.stringify(initializeRequest()));
    expect(await messages.next()).toMatchObject({
      id: 'initialize',
      result: { protocolVersion: 1 },
    });
    expect(fixture.bound).toHaveLength(1);
    expect(fixture.bound[0]?.workspace).toEqual(workspace);

    socket.send(JSON.stringify(pingRequest()));
    expect(await messages.next()).toMatchObject({ id: 'ping', result: { status: 'ok' } });

    const replay = await expectSocketRejected(carrier, first.ticket);
    expect(replay).toBe(true);
    socket.close();
    await eventually(() => fixture.application.server.connectionCount === 0);
    expect(fixture.closed).toHaveLength(1);
    expect(fixture.closed[0]).toBe(fixture.bound[0]?.connectionId);
  });

  test('fails malformed, binary, oversized, non-loopback, and wrong-origin traffic closed', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);

    const malformedTicket = (await connectWorkspace(carrier)).ticket;
    const malformed = await openSocket(carrier, malformedTicket);
    const malformedMessages = new SocketMessages(malformed);
    malformed.send('{"payload":"secret-value"');
    expect(await malformedMessages.next()).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: 'parse_error' } },
    });
    malformed.close();

    const binary = await openSocket(carrier, (await connectWorkspace(carrier)).ticket);
    const binaryClosed = closed(binary);
    binary.send(new Uint8Array([1, 2, 3]));
    expect((await binaryClosed).code).toBe(1003);

    const oversized = await openSocket(carrier, (await connectWorkspace(carrier)).ticket);
    const oversizedClosed = closed(oversized);
    oversized.send(JSON.stringify({ value: 'x'.repeat(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) }));
    expect((await oversizedClosed).code).toBe(1009);

    const rejectedFixture = createFixture({ requestIp: () => ({ address: '192.0.2.1' }) });
    const rejectedCarrier = track(rejectedFixture.carrier);
    expect(
      await fetch(`${rejectedCarrier.origin}/healthz`).then((response) => response.status),
    ).toBe(403);

    const wrongOrigin = await fetch(`${carrier.origin}/healthz`, {
      headers: { origin: 'http://localhost:1' },
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongHost = await fetch(`${carrier.origin.replace('127.0.0.1', 'localhost')}/healthz`);
    expect(wrongHost.status).toBe(403);
  });

  test('uses exact History and App Control routes without a generic RPC or secret-bearing response', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const connect = await connectWorkspace(carrier);

    const history = await fetch(`${carrier.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ limit: 1 }),
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({ entries: [], hasMore: false });
    expect(fixture.historyCalls).toBe(1);

    const provider = await fetch(`${carrier.origin}/_kite/app/provider-model/snapshot`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace,
      }),
    });
    expect(provider.status).toBe(200);
    expect(await provider.json()).toMatchObject({
      schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
      workspace,
    });
    expect(fixture.providerCalls).toBe(1);

    const forged = await fetch(`${carrier.origin}/_kite/app/provider-model/snapshot`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace: otherWorkspace,
      }),
    });
    expect(forged.status).toBe(403);
    expect(fixture.providerCalls).toBe(1);

    const extra = await fetch(`${carrier.origin}/_kite/app/provider-model/snapshot`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace,
        apiKey: 'sk-secret',
      }),
    });
    expect(extra.status).toBe(400);
    expect(await extra.text()).not.toContain('sk-secret');

    const generic = await fetch(`${carrier.origin}/_kite/app/call`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ method: 'getProviderModelSnapshot' }),
    });
    expect(generic.status).toBe(404);

    const credential = await fetch(`${carrier.origin}/_kite/app/provider-credential/write`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({
        schema: 'kite.local-runtime-credential-request.v1',
        mutationId: 'mutation-1',
        operation: 'write_provider_api_key',
        providerId: 'openai',
        apiKey: 'sk-secret',
      }),
    });
    expect(credential.status).toBe(200);
    const credentialBody = await credential.text();
    expect(credentialBody).not.toContain('sk-secret');
    expect(credentialBody).toContain(LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_);
    expect(fixture.credentialCalls).toBe(1);
    expect(connect.ticket).toBeTruthy();
  });

  test('applies the access-origin and cookie boundary to every HTTP capability route', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const routes = [
      [KITE_SERVICE_INSTANCE_HANDSHAKE_PATH, {}],
      [KITE_SERVICE_CONNECT_PATH, { workspace: workspace.canonicalPath }],
      [KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH, { limit: 1 }],
      [
        KITE_SERVICE_HISTORY_LIST_EVENTS_PATH,
        {
          sessionId: 'session-1',
          direction: 'forward',
          limit: 1,
        },
      ],
      [KITE_SERVICE_HISTORY_LOAD_SESSION_PATH, { sessionId: 'session-1' }],
      [
        '/_kite/app/provider-model/snapshot',
        {
          schema: 'kite.app.provider-model.snapshot-request.v1',
          workspace,
        },
      ],
      [
        '/_kite/app/provider-credential/write',
        {
          schema: 'kite.local-runtime-credential-request.v1',
          mutationId: 'mutation-auth-matrix',
          operation: 'write_provider_api_key',
          providerId: 'openai',
          apiKey: 'sk-secret',
        },
      ],
      ['/_kite/app/release/status', { schema: 'kite.app.release-status.request.v1' }],
    ] as const;

    for (const [pathname, body] of routes) {
      const wrongOrigin = await fetch(`${carrier.origin}${pathname}`, {
        method: 'POST',
        headers: {
          ...jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
          origin: 'http://localhost:1',
        },
        body: JSON.stringify(body),
      });
      expect(wrongOrigin.status).toBe(401);

      const cookie = await fetch(`${carrier.origin}${pathname}`, {
        method: 'POST',
        headers: {
          ...jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
          cookie: 'session=unsupported',
        },
        body: JSON.stringify(body),
      });
      expect(cookie.status).toBe(401);

      const query = await fetch(`${carrier.origin}${pathname}?secret=query`, {
        method: 'POST',
        headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        body: JSON.stringify(body),
      });
      expect(query.status).toBe(403);
      expect(await query.text()).not.toContain('secret');
    }
  });

  test('rejects invalid WebSocket origin, protocol and upgrade headers before consuming a ticket', async () => {
    const listener = fakeListener();
    const fixture = createFixture({ serve: listener.serve });
    const carrier = fixture.carrier;
    const ticket = await fakeConnectTicket(carrier, listener);

    const wrongOrigin = await requestFakeUpgradeWithTicket(carrier, listener, ticket, {
      origin: 'http://localhost:1',
    });
    expect(wrongOrigin?.status).toBe(403);
    const protocol = await requestFakeUpgradeWithTicket(carrier, listener, ticket, {
      'sec-websocket-protocol': 'kite-v1',
    });
    expect(protocol?.status).toBe(403);
    const wrongUpgrade = await requestFakeUpgradeWithTicket(carrier, listener, ticket, {
      upgrade: 'http',
    });
    expect(wrongUpgrade?.status).toBe(403);
    expect(listener.upgrades()).toHaveLength(0);

    const accepted = await requestFakeUpgradeWithTicket(carrier, listener, ticket);
    expect(accepted).toBeUndefined();
    expect(listener.upgrades()).toHaveLength(1);
    await carrier.close();
  });

  test('rejects malformed UTF-8 and over-limit HTTP bodies without invoking an owner', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const accessHeaders = jsonHeaders(
      `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`,
    );
    const malformedUtf8 = await fetch(
      `${carrier.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`,
      {
        method: 'POST',
        headers: accessHeaders,
        body: new Uint8Array([0xc3, 0x28]),
      },
    );
    expect(malformedUtf8.status).toBe(400);

    const overLimit = await fetch(`${carrier.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`, {
      method: 'POST',
      headers: accessHeaders,
      body: JSON.stringify({
        limit: 1,
        padding: 'x'.repeat(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes),
      }),
    });
    expect(overLimit.status).toBe(400);
    expect(fixture.historyCalls).toBe(0);
  });

  test('keeps every authenticated route unavailable until the Service publishes ready', async () => {
    const fixture = createFixture({ isReady: () => false });
    const carrier = track(fixture.carrier);
    const accessHeaders = jsonHeaders(
      `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`,
    );

    expect(await fetch(`${carrier.origin}/healthz`).then((response) => response.status)).toBe(200);
    expect(await fetch(`${carrier.origin}/readyz`).then((response) => response.status)).toBe(503);
    expect(
      await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
        method: 'POST',
        headers: accessHeaders,
        body: JSON.stringify({ workspace: workspace.canonicalPath }),
      }).then((response) => response.status),
    ).toBe(503);
    expect(
      await fetch(`${carrier.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`, {
        method: 'POST',
        headers: accessHeaders,
        body: JSON.stringify({ limit: 1 }),
      }).then((response) => response.status),
    ).toBe(503);
    expect(
      await fetch(`${carrier.origin}/_kite/app/release/status`, {
        method: 'POST',
        headers: accessHeaders,
        body: JSON.stringify({ schema: 'kite.app.release-status.request.v1' }),
      }).then((response) => response.status),
    ).toBe(503);
    expect(
      await fetch(`${carrier.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`, {
        method: 'POST',
        headers: jsonHeaders(`${KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
        body: '{}',
      }).then((response) => response.status),
    ).toBe(503);
  });

  test('rejects a delegate that tries to change the ticket-bound Workspace', async () => {
    const fixture = createFixture({
      authorize: async () => ({ allowed: true, workspace: otherWorkspace.canonicalPath }),
    });
    const carrier = track(fixture.carrier);
    const socket = await openSocket(carrier, (await connectWorkspace(carrier)).ticket);
    const messages = new SocketMessages(socket);
    socket.send(JSON.stringify(initializeRequest()));

    expect(await messages.next()).toMatchObject({
      id: 'initialize',
      error: { data: { code: 'unauthorized' } },
    });
    expect(fixture.bound).toEqual([]);
    socket.close();
  });

  test('does not bind a late admission result after the socket closes', async () => {
    const authorization = deferred<RuntimeServerAdmissionDecision>();
    const entered = deferred<void>();
    const fixture = createFixture({
      authorize: async () => {
        entered.resolve();
        return authorization.promise;
      },
    });
    const carrier = track(fixture.carrier);
    const socket = await openSocket(carrier, (await connectWorkspace(carrier)).ticket);
    socket.send(JSON.stringify(initializeRequest()));
    await entered.promise;
    const socketClosed = closed(socket);
    socket.close();
    await socketClosed;
    await eventually(() => fixture.diagnostics.includes('socket_closed'));
    authorization.resolve({ allowed: true, workspace: workspace.canonicalPath });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fixture.bound).toEqual([]);
    await eventually(() => fixture.application.server.connectionCount === 0);
  });

  test('expires one-shot tickets at the exact 30 second boundary', async () => {
    let now = 1_000;
    const fixture = createFixture({ now: () => now });
    const carrier = track(fixture.carrier);
    const accepted = await connectWorkspace(carrier);
    now += 29_999;
    const socket = await openSocket(carrier, accepted.ticket);
    socket.close();

    const expired = await connectWorkspace(carrier);
    now += 30_000;
    expect(await expectSocketRejected(carrier, expired.ticket)).toBe(true);
  });

  test('does not alias a live ticket when the random source repeats', async () => {
    const fixture = createFixture({ randomBytes: (size) => new Uint8Array(size).fill(7) });
    const carrier = track(fixture.carrier);
    const first = await connectWorkspace(carrier);
    const duplicate = await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    });

    expect(duplicate.status).toBe(503);
    const socket = await openSocket(carrier, first.ticket);
    socket.close();
  });

  test('caps outstanding tickets instead of growing the in-memory authority', async () => {
    const fixture = createFixture();
    const carrier = track(fixture.carrier);
    const responses = await Promise.all(
      Array.from({ length: 1_025 }, () =>
        fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
          method: 'POST',
          headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
          body: JSON.stringify({ workspace: workspace.canonicalPath }),
        }).then((response) => response.status),
      ),
    );

    expect(responses.filter((status) => status === 200)).toHaveLength(1_024);
    expect(responses.filter((status) => status === 503)).toHaveLength(1);
  });

  test('does not issue a ticket after carrier close wins a deferred Workspace admission', async () => {
    const admission = deferred<
      | { readonly outcome: 'admitted'; readonly workspace: KiteWorkspaceIdentity }
      | { readonly outcome: 'untrusted' | 'unavailable' }
    >();
    const entered = deferred<void>();
    const drain = deferred<void>();
    const fixture = createFixture({
      admitForConnect: async () => {
        entered.resolve();
        return admission.promise;
      },
      beginDraining: () => drain.promise,
    });
    const carrier = track(fixture.carrier);
    const connecting = fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    });
    await entered.promise;
    const closing = carrier.close();
    admission.resolve({ outcome: 'admitted', workspace });

    expect((await connecting).status).toBe(503);
    drain.resolve();
    await closing;
  });

  test('does not publish deferred History, App, credential, or control results after close', async () => {
    const history = deferred<{ readonly entries: []; readonly hasMore: false }>();
    const historyEntered = deferred<void>();
    const historyDrain = deferred<void>();
    const historyFixture = createFixture({
      listSessions: async () => {
        historyEntered.resolve();
        return history.promise;
      },
      beginDraining: () => historyDrain.promise,
    });
    const historyCarrier = track(historyFixture.carrier);
    const historyResponse = fetch(
      `${historyCarrier.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`,
      {
        method: 'POST',
        headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        body: JSON.stringify({ limit: 1 }),
      },
    );
    await historyEntered.promise;
    const historyClosing = historyCarrier.close();
    history.resolve({ entries: [], hasMore: false });
    expect((await historyResponse).status).toBe(503);
    historyDrain.resolve();
    await historyClosing;

    const provider = deferred<ProviderModelSnapshot>();
    const providerEntered = deferred<void>();
    const providerDrain = deferred<void>();
    const providerFixture = createFixture({
      getProviderModelSnapshot: async () => {
        providerEntered.resolve();
        return provider.promise;
      },
      beginDraining: () => providerDrain.promise,
    });
    const providerCarrier = track(providerFixture.carrier);
    const providerResponse = fetch(`${providerCarrier.origin}/_kite/app/provider-model/snapshot`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
      body: JSON.stringify({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace,
      }),
    });
    await providerEntered.promise;
    const providerClosing = providerCarrier.close();
    provider.resolve(providerSnapshot());
    expect((await providerResponse).status).toBe(503);
    providerDrain.resolve();
    await providerClosing;

    const credential = deferred<{
      readonly schema: typeof LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_;
      readonly mutationId: string;
      readonly operation: 'write_provider_api_key';
      readonly outcome: 'applied';
      readonly credentialPresent: true;
    }>();
    const credentialEntered = deferred<void>();
    const credentialDrain = deferred<void>();
    const credentialFixture = createFixture({
      writeProviderCredential: async () => {
        credentialEntered.resolve();
        return credential.promise;
      },
      beginDraining: () => credentialDrain.promise,
    });
    const credentialCarrier = track(credentialFixture.carrier);
    const credentialResponse = fetch(
      `${credentialCarrier.origin}/_kite/app/provider-credential/write`,
      {
        method: 'POST',
        headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        body: JSON.stringify({
          schema: 'kite.local-runtime-credential-request.v1',
          mutationId: 'mutation-1',
          operation: 'write_provider_api_key',
          providerId: 'openai',
          apiKey: 'sk-secret',
        }),
      },
    );
    await credentialEntered.promise;
    const credentialClosing = credentialCarrier.close();
    credential.resolve({
      schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
      mutationId: 'mutation-1',
      operation: 'write_provider_api_key',
      outcome: 'applied',
      credentialPresent: true,
    });
    expect((await credentialResponse).status).toBe(503);
    credentialDrain.resolve();
    await credentialClosing;

    const control = deferred<{ readonly outcome: 'applied'; readonly state: 'ready' }>();
    const controlEntered = deferred<void>();
    const controlDrain = deferred<void>();
    const controlFixture = createFixture({
      stop: async () => {
        controlEntered.resolve();
        return control.promise;
      },
      beginDraining: () => controlDrain.promise,
    });
    const controlCarrier = track(controlFixture.carrier);
    const controlResponse = fetch(`${controlCarrier.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(`${KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
      body: '{}',
    });
    await controlEntered.promise;
    const controlClosing = controlCarrier.close();
    control.resolve({ outcome: 'applied', state: 'ready' });
    expect((await controlResponse).status).toBe(503);
    controlDrain.resolve();
    await controlClosing;
  });

  test('cleans a consumed ticket when the WebSocket upgrade throws or rejects', async () => {
    for (const [behavior, expectedStatus] of [
      ['throw', 503],
      ['reject', 400],
    ] as const) {
      const listener = fakeListener(undefined, behavior);
      const fixture = createFixture({ serve: listener.serve });
      const carrier = fixture.carrier;
      const ticket = await fakeConnectTicket(carrier, listener);
      const response = await requestFakeUpgradeWithTicket(carrier, listener, ticket);

      expect(response?.status).toBe(expectedStatus);
      expect(listener.upgrades()).toHaveLength(1);
      const replay = await requestFakeUpgradeWithTicket(carrier, listener, ticket);
      expect(replay?.status).toBe(401);
      expect(listener.upgrades()).toHaveLength(1);
      await carrier.close();
    }
  });

  test('heartbeat timeout is not extended by arbitrary messages or peer pings', async () => {
    let now = 0;
    const listener = fakeListener();
    const fixture = createFixture({
      serve: listener.serve,
      now: () => now,
      limits: { heartbeatIntervalMs: 5, heartbeatDeadlineMs: 15 },
    });
    const carrier = fixture.carrier;
    const data = await upgradeFakeSocket(carrier, listener);
    let closeInfo: { readonly code: number; readonly reason: string } | undefined;
    const socket = fakeServerSocket(data, (code, reason) => {
      closeInfo = { code, reason };
    });
    listener.callbacks().websocket.open(socket);
    listener.callbacks().websocket.message(socket, JSON.stringify({ arbitrary: true }));
    listener.callbacks().websocket.ping(socket, new Uint8Array());
    now = 15;

    await eventually(() => closeInfo !== undefined);
    expect(closeInfo).toEqual({ code: 1001, reason: 'heartbeat_timeout' });
    await carrier.close();
  });

  test('closes on a dropped outbound frame and waits through backpressure', async () => {
    for (const [sendResult, shouldClose] of [
      [0, true],
      [-1, false],
    ] as const) {
      const listener = fakeListener();
      const sent = deferred<void>();
      const server = {
        beginDraining: async () => undefined,
        open: (connection: {
          readonly send: (message: RuntimeProtocolMessage) => Promise<void>;
        }) => {
          void connection
            .send({
              jsonrpc: '2.0',
              id: 'outbound',
              result: { status: 'ok' },
            } as RuntimeProtocolMessage)
            .then(sent.resolve, sent.reject);
          return { state: 'open' };
        },
      } as unknown as RuntimeServer;
      const fixture = createFixture({ server, serve: listener.serve });
      const carrier = fixture.carrier;
      const data = await upgradeFakeSocket(carrier, listener);
      let closeInfo: { readonly code: number; readonly reason: string } | undefined;
      listener.callbacks().websocket.open(
        fakeServerSocket(
          data,
          (code, reason) => {
            closeInfo = { code, reason };
          },
          { sendText: () => sendResult },
        ),
      );

      if (shouldClose) {
        await expect(sent.promise).rejects.toThrow('rejected outbound');
        expect(closeInfo).toEqual({ code: 1013, reason: 'outbound_queue_full' });
      } else {
        await sent.promise;
        expect(closeInfo).toBeUndefined();
        expect(fixture.diagnostics).toContain('outbound_backpressure');
      }
      await carrier.close();
    }
  });

  test('cleans up a peer-closed socket even when the diagnostic sink throws', async () => {
    const fixture = createFixture({
      onDiagnostic: (code) => {
        if (code === 'socket_closed') throw new Error('diagnostic failed');
      },
    });
    const carrier = track(fixture.carrier);
    const socket = await openSocket(carrier, (await connectWorkspace(carrier)).ticket);
    socket.send(JSON.stringify(initializeRequest()));
    await eventually(() => fixture.bound.length === 1);
    const socketClosed = closed(socket);
    socket.close();
    await socketClosed;

    await eventually(() => fixture.application.server.connectionCount === 0);
    const boundConnection = fixture.bound[0];
    if (!boundConnection) throw new Error('socket did not bind');
    expect(fixture.closed).toEqual([boundConnection.connectionId]);
  });

  test('continues closing sockets and stops the listener when one socket close throws', async () => {
    const listener = fakeListener();
    const server = {
      beginDraining: async () => undefined,
      open: () => ({ state: 'open' }),
    } as unknown as RuntimeServer;
    const fixture = createFixture({ server, serve: listener.serve });
    const carrier = fixture.carrier;
    const firstData = await upgradeFakeSocket(carrier, listener);
    const secondData = await upgradeFakeSocket(carrier, listener);
    let firstCloseCalls = 0;
    let secondCloseCalls = 0;
    listener.callbacks().websocket.open(
      fakeServerSocket(firstData, () => {
        firstCloseCalls += 1;
        throw new Error('socket close failed');
      }),
    );
    listener.callbacks().websocket.open(
      fakeServerSocket(secondData, () => {
        secondCloseCalls += 1;
      }),
    );

    await expect(carrier.close()).rejects.toThrow('socket close failed');
    expect(firstCloseCalls).toBe(1);
    expect(secondCloseCalls).toBe(1);
    expect(listener.stopCalls()).toBe(1);
    expect(listener.stopModes()).toEqual([false]);
  });

  test('does not let a committed control response retain application and state cleanup', async () => {
    const listener = fakeListener(undefined, 'accept', async (closeActiveConnections) => {
      if (!closeActiveConnections) await new Promise<void>(() => undefined);
    });
    const fixture = createFixture({
      serve: listener.serve,
      stop: async () => ({ outcome: 'applied', state: 'draining' }),
      limits: { drainDeadlineMs: 5 },
    });
    const response = await listener.callbacks().fetch(
      new Request(`http://127.0.0.1:43210${KITE_SERVICE_CONTROL_STOP_PATH}`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:43210',
          ...jsonHeaders(`${KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME} ${CONTROL_TOKEN}`),
        },
        body: '{}',
      }),
      listener.server,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ outcome: 'applied', state: 'draining' });

    await expect(fixture.carrier.close()).resolves.toBeUndefined();
    expect(listener.stopModes()).toEqual([false]);
    await eventually(() => listener.stopModes().includes(true));
  });

  test('closes a WebSocket whose upgrade races carrier shutdown before open', async () => {
    let closing: Promise<void> | undefined;
    let carrier: KiteServiceCarrier | undefined;
    const listener = fakeListener(() => {
      if (!carrier) throw new Error('carrier was not assigned');
      closing = carrier.close();
    });
    const fixture = createFixture({ serve: listener.serve });
    carrier = fixture.carrier;
    const data = await upgradeFakeSocket(carrier, listener);
    const closes: Array<{ code: number; reason: string }> = [];
    listener
      .callbacks()
      .websocket.open(fakeServerSocket(data, (code, reason) => closes.push({ code, reason })));

    await closing;
    expect(closes).toEqual([{ code: 1012, reason: 'service_restart' }]);
    expect(listener.stopCalls()).toBe(1);
  });

  test('rejects resource limits above the fixed Service ceilings', () => {
    expect(() => createFixture({ limits: { maxHttpBodyBytes: Number.MAX_SAFE_INTEGER } })).toThrow(
      'hard ceiling',
    );
    expect(() =>
      createFixture({ limits: { maxOutboundMessages: Number.MAX_SAFE_INTEGER } }),
    ).toThrow('hard ceiling');
  });
});

function createFixture(
  input: {
    readonly requestIp?: (
      request: Request,
      server: Bun.Server<unknown>,
    ) => { address: string } | null;
    readonly isReady?: () => boolean;
    readonly authorize?: (
      input: RuntimeServerAdmissionInput,
    ) => Promise<RuntimeServerAdmissionDecision>;
    readonly admitForConnect?: KiteServiceApplicationPort['workspaceAdmission']['admitForConnect'];
    readonly listSessions?: KiteServiceApplicationPort['history']['listSessions'];
    readonly getProviderModelSnapshot?: KiteAppControlClient['getProviderModelSnapshot'];
    readonly writeProviderCredential?: NonNullable<
      KiteServiceApplicationPort['credential']
    >['writeProviderCredential'];
    readonly stop?: NonNullable<KiteServiceApplicationPort['control']>['stop'];
    readonly onDiagnostic?: (code: string) => void;
    readonly beginDraining?: () => Promise<void>;
    readonly server?: RuntimeServer;
    readonly serve?: typeof Bun.serve;
    readonly now?: () => number;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly limits?: KiteServiceCarrierLimits;
  } = {},
): {
  readonly carrier: KiteServiceCarrier;
  readonly application: KiteServiceApplicationPort;
  readonly bound: Array<{ connectionId: string; workspace: KiteWorkspaceIdentity }>;
  readonly closed: string[];
  readonly stopCalls: number;
  readonly historyCalls: number;
  readonly providerCalls: number;
  readonly credentialCalls: number;
  readonly diagnostics: string[];
} {
  const bound: Array<{ connectionId: string; workspace: KiteWorkspaceIdentity }> = [];
  const closed: string[] = [];
  let stopCalls = 0;
  let historyCalls = 0;
  let providerCalls = 0;
  let credentialCalls = 0;
  const diagnostics: string[] = [];
  const runtime: RuntimeAccess = {
    command: async (command) => ({
      status: 'applied',
      commandId: command.commandId,
      sessionId: 'session-1',
      revision: 1,
    }),
    query: async (query) => ({ status: 'ok', queryType: query.type, sessions: [] }),
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => await new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
  };
  const server =
    input.server ??
    new RuntimeServer(
      {
        runtime,
        admission: {
          authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
        },
      },
      { serverInfo: { version: 'service-test', instanceId: 'instance-1' } },
    );
  if (input.beginDraining) {
    Object.defineProperty(server, 'beginDraining', { value: input.beginDraining });
  }
  const snapshots = fakeAppControl();
  const application: KiteServiceApplicationPort = {
    server,
    history: {
      listSessions:
        input.listSessions ??
        (async () => {
          historyCalls += 1;
          return { entries: [], hasMore: false };
        }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => ({
        session: {
          sessionId: 'session-1',
          displayName: 'Session',
          needsSmartName: false,
          updatedAt: 0,
          lastSequence: 0,
        },
        events: [],
        interactionMode: 'auto',
        recovery: 'normal',
      }),
    },
    workspaceAdmission: {
      admitForConnect:
        input.admitForConnect ??
        (async (requestedWorkspace) =>
          requestedWorkspace === workspace.canonicalPath
            ? { outcome: 'admitted', workspace }
            : { outcome: 'untrusted' }),
      resolveIdentity: async (candidate) =>
        sameWorkspace(candidate, workspace) ? workspace : undefined,
    },
    runtimeAdmission: {
      create: (admittedWorkspace) => ({
        authorize: async (admissionInput) => {
          if (input.authorize) return input.authorize(admissionInput);
          return { allowed: true, workspace: admittedWorkspace.canonicalPath };
        },
      }),
    },
    appControl: {
      discovery: snapshots,
      forWorkspace: () => snapshots,
    },
    credential: {
      writeProviderCredential:
        input.writeProviderCredential ??
        (async (request: NativeProviderCredentialRequest) => {
          credentialCalls += 1;
          return {
            schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
            mutationId: request.mutationId,
            operation: request.operation,
            outcome: 'applied',
            credentialPresent: true,
          };
        }),
    },
    control: {
      stop:
        input.stop ??
        (async () => {
          stopCalls += 1;
          return { outcome: 'applied', state: 'ready' };
        }),
    },
    onConnectionBound: (connectionId, admittedWorkspace) =>
      bound.push({ connectionId, workspace: admittedWorkspace }),
    onConnectionClosed: (connectionId) => closed.push(connectionId),
  };
  const carrier = createKiteServiceCarrier({
    application,
    instanceId: 'instance-1',
    serverVersion: 'service-test',
    buildId: 'dev:0123456789012345678901234567890123456789',
    accessToken: ACCESS_TOKEN,
    controlToken: CONTROL_TOKEN,
    ...(input.isReady ? { isReady: input.isReady } : {}),
    requestIp: input.requestIp,
    limits: {
      heartbeatIntervalMs: 50,
      heartbeatDeadlineMs: 150,
      drainDeadlineMs: 50,
      ...input.limits,
    },
    ...(input.now ? { now: input.now } : {}),
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
    ...(input.serve ? { serve: input.serve } : {}),
    onDiagnostic: (code) => {
      diagnostics.push(code);
      input.onDiagnostic?.(code);
    },
  });
  return {
    carrier,
    application,
    bound,
    closed,
    get stopCalls() {
      return stopCalls;
    },
    get historyCalls() {
      return historyCalls;
    },
    get providerCalls() {
      return providerCalls;
    },
    get credentialCalls() {
      return credentialCalls;
    },
    diagnostics,
  };

  function fakeAppControl(): KiteAppControlClient {
    const currentProviderSnapshot = providerSnapshot();
    const trustQuery: WorkspaceTrustQueryResponse = {
      schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
      workspace,
      status: 'trusted',
      revision: 'revision-1',
      canDecide: false,
    };
    const trustDecision: WorkspaceTrustDecisionResponse = {
      schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
      workspace,
      status: 'trusted',
      outcome: 'already_trusted',
      revision: 'revision-1',
    };
    const release: ReleaseStatusSnapshot = {
      schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
      revision: 'revision-1',
      active: true,
      production: false,
      capabilities: [],
      execution: { admitted: false },
    };
    const execution: ExecutionStatusSnapshot = {
      schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
      workspace,
      revision: 'revision-1',
      admitted: false,
      sandboxBackend: 'none',
      filesystemScope: 'none',
      networkMode: 'off',
      controllerWorktreeActive: false,
    };
    const skills: SkillCatalogSnapshot = {
      schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
      workspace,
      revision: 'revision-1',
      skills: [],
    };
    return {
      queryWorkspaceTrust: async () => trustQuery,
      decideWorkspaceTrust: async () => trustDecision,
      getProviderModelSnapshot:
        input.getProviderModelSnapshot ??
        (async () => {
          providerCalls += 1;
          return currentProviderSnapshot;
        }),
      selectProviderModel: async () => ({
        schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
        outcome: 'already_selected',
        snapshot: currentProviderSnapshot,
      }),
      getMcpSnapshot: async () => ({
        schema: 'kite.app.mcp.snapshot-response.v1',
        workspace,
        revision: 'revision-1',
        sourceRevisions: { project: 'project-1', user: 'user-1' },
        servers: [],
      }),
      applyMcpAction: async () => ({
        schema: MCP_ACTION_RESPONSE_SCHEMA_,
        outcome: 'unavailable',
        snapshot: {
          schema: 'kite.app.mcp.snapshot-response.v1',
          workspace,
          revision: 'revision-1',
          sourceRevisions: { project: 'project-1', user: 'user-1' },
          servers: [],
        },
      }),
      getSkillCatalog: async () => skills,
      getExecutionStatus: async () => execution,
      getReleaseStatus: async () => release,
    };
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function connectWorkspace(
  carrier: KiteServiceCarrier,
): Promise<{ readonly response: Response; readonly ticket: string }> {
  const response = await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
    method: 'POST',
    headers: jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
    body: JSON.stringify({ workspace: workspace.canonicalPath }),
  });
  const body = (await response.json()) as { ticket?: string };
  if (!body.ticket) throw new Error('connect response omitted ticket');
  return { response, ticket: body.ticket };
}

function track(carrier: KiteServiceCarrier): KiteServiceCarrier {
  carriers.push(carrier);
  return carrier;
}

async function openSocket(carrier: KiteServiceCarrier, ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(carrier.rpcUrl, {
      headers: {
        Authorization: `${KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME} ${ticket}`,
        Origin: carrier.origin,
      },
    } as unknown as string[]);
    const timer = setTimeout(
      () => finish(() => reject(new Error('WebSocket open timeout'))),
      1_000,
    );
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      settle();
    };
    const opened = () => finish(() => resolve(socket));
    const failed = () => finish(() => reject(new Error('WebSocket failed to open')));
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
  });
}

async function expectSocketRejected(carrier: KiteServiceCarrier, ticket: string): Promise<boolean> {
  const socket = new WebSocket(carrier.rpcUrl, {
    headers: {
      Authorization: `${KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME} ${ticket}`,
      Origin: carrier.origin,
    },
  } as unknown as string[]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error('WebSocket rejection timeout'))),
      1_000,
    );
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', rejected);
      socket.removeEventListener('close', rejected);
      settle();
    };
    const opened = () => finish(() => reject(new Error('replayed ticket opened')));
    const rejected = () => finish(() => resolve(true));
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', rejected, { once: true });
    socket.addEventListener('close', rejected, { once: true });
  });
}

function jsonHeaders(authorization: string): Record<string, string> {
  return { authorization, 'content-type': 'application/json' };
}

function initializeRequest() {
  return {
    jsonrpc: '2.0' as const,
    id: 'initialize',
    method: 'initialize' as const,
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'carrier-test', version: '1', instanceId: 'client-1' },
    },
  };
}

function pingRequest() {
  return { jsonrpc: '2.0' as const, id: 'ping', method: 'server/ping' as const, params: {} };
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), 1_000);
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

class SocketMessages {
  readonly #messages: unknown[] = [];
  readonly #waiters = new Set<(value: unknown) => void>();

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data)) as unknown;
      const waiter = this.#waiters.values().next().value;
      if (waiter) {
        this.#waiters.delete(waiter);
        waiter(value);
      } else {
        this.#messages.push(value);
      }
    });
  }

  next(): Promise<unknown> {
    const value = this.#messages.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const waiter = (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error('WebSocket message timeout'));
      }, 1_000);
      this.#waiters.add(waiter);
    });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('eventual condition timeout');
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

interface FakeListenerCallbacks {
  readonly fetch: (
    request: Request,
    server: Bun.Server<never>,
  ) => Response | Promise<Response> | undefined;
  readonly websocket: {
    readonly open: (socket: unknown) => void;
    readonly message: (socket: unknown, message: string | Buffer) => void;
    readonly ping: (socket: unknown, data: Uint8Array) => void;
  };
}

interface FakeListener {
  readonly serve: typeof Bun.serve;
  readonly server: Bun.Server<never>;
  readonly callbacks: () => FakeListenerCallbacks;
  readonly upgrades: () => readonly unknown[];
  readonly stopCalls: () => number;
  readonly stopModes: () => readonly boolean[];
}

function fakeListener(
  onUpgrade?: () => void,
  upgradeBehavior: 'accept' | 'reject' | 'throw' = 'accept',
  stopBehavior?: (closeActiveConnections: boolean) => Promise<void>,
): FakeListener {
  let callbacks: FakeListenerCallbacks | undefined;
  let stops = 0;
  const stopModes: boolean[] = [];
  const upgradeData: unknown[] = [];
  const server = {
    port: 43_210,
    requestIP: () => ({ address: '127.0.0.1', port: 1, family: 'IPv4' }),
    upgrade: (_request: Request, input: { readonly data: unknown }) => {
      upgradeData.push(input.data);
      onUpgrade?.();
      if (upgradeBehavior === 'throw') throw new Error('upgrade failed');
      return upgradeBehavior === 'accept';
    },
    stop: async (closeActiveConnections?: boolean) => {
      stops += 1;
      const closeActive = closeActiveConnections === true;
      stopModes.push(closeActive);
      await stopBehavior?.(closeActive);
    },
  } as unknown as Bun.Server<never>;
  const serve = ((options: unknown) => {
    callbacks = options as FakeListenerCallbacks;
    return server;
  }) as typeof Bun.serve;
  return {
    serve,
    server,
    callbacks: () => {
      if (!callbacks) throw new Error('listener callbacks were not installed');
      return callbacks;
    },
    upgrades: () => upgradeData,
    stopCalls: () => stops,
    stopModes: () => [...stopModes],
  };
}

async function upgradeFakeSocket(
  carrier: KiteServiceCarrier,
  listener: FakeListener,
): Promise<unknown> {
  const upgraded = await requestFakeUpgrade(carrier, listener);
  if (upgraded !== undefined) throw new Error(`upgrade returned HTTP ${upgraded.status}`);
  const data = listener.upgrades().at(-1);
  if (!data) throw new Error('upgrade omitted socket data');
  return data;
}

async function requestFakeUpgrade(
  carrier: KiteServiceCarrier,
  listener: FakeListener,
): Promise<Response | undefined> {
  const ticket = await fakeConnectTicket(carrier, listener);
  return requestFakeUpgradeWithTicket(carrier, listener, ticket);
}

async function fakeConnectTicket(
  carrier: KiteServiceCarrier,
  listener: FakeListener,
): Promise<string> {
  const connect = await listener.callbacks().fetch(
    new Request(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(`${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`),
        host: new URL(carrier.origin).host,
      },
      body: JSON.stringify({ workspace: workspace.canonicalPath }),
    }),
    listener.server,
  );
  if (!connect) throw new Error('connect returned no response');
  const connectText = await connect.text();
  if (connect.status !== 200) {
    throw new Error(`connect returned HTTP ${connect.status}: ${connectText}`);
  }
  const ticket = (JSON.parse(connectText) as { readonly ticket?: string }).ticket;
  if (!ticket) throw new Error('connect response omitted ticket');
  return ticket;
}

async function requestFakeUpgradeWithTicket(
  carrier: KiteServiceCarrier,
  listener: FakeListener,
  ticket: string,
  overrides: Record<string, string> = {},
): Promise<Response | undefined> {
  return listener.callbacks().fetch(
    new Request(carrier.rpcUrl, {
      headers: {
        authorization: `${KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME} ${ticket}`,
        host: new URL(carrier.origin).host,
        origin: carrier.origin,
        upgrade: 'websocket',
        ...overrides,
      },
    }),
    listener.server,
  );
}

function fakeServerSocket(
  data: unknown,
  close: (code: number, reason: string) => void,
  input: {
    readonly bufferedAmount?: () => number;
    readonly sendText?: (payload: string) => number;
    readonly ping?: () => void;
  } = {},
): unknown {
  return {
    data,
    close,
    getBufferedAmount: input.bufferedAmount ?? (() => 0),
    sendText: input.sendText ?? (() => 1),
    ping: input.ping ?? (() => undefined),
    pong: () => undefined,
  };
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}
