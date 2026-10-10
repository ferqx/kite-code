import { expect, test } from 'bun:test';
import { createClient, type HostStatus, type ServerInfo } from '../src';

const info: ServerInfo = {
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  profile: { dataRoot: '/chosen', name: 'owned', accessKey: 'key' },
  dataAvailability: 'available',
  storeId: 'store',
  capabilities: ['host_status', 'events'],
};
function status(identity = info): HostStatus {
  return {
    version: 1,
    identity: {
      instanceId: identity.instanceId,
      buildId: identity.buildId,
      apiMajor: 1,
      profileAccessKey: identity.profile.accessKey,
      dataAvailability: identity.dataAvailability,
      storeId: identity.storeId ?? null,
    },
    scope: { workspaceId: null, sessionId: null },
    execution: {
      state: 'available',
      reason: null,
      sandbox: { backend: 'none', available: false, qualification: 'unqualified' },
      shell: {
        configured: false,
        available: false,
        supervision: 'none',
        qualification: 'not_configured',
        reason: 'shell_not_configured',
      },
      permissions: {
        state: 'unbound',
        scope: 'default',
        mode: 'auto',
        defaultMode: 'auto',
        workspaceTrust: 'unbound',
        reason: null,
      },
    },
    release: {
      state: 'available',
      active: false,
      production: null,
      qualification: 'unverified',
      reason: 'release_manifest_not_bound',
    },
    telemetry: {
      state: 'available',
      enabled: false,
      exporterConfigured: false,
      diskSpool: false,
      reason: 'exporter_not_configured',
    },
  };
}
function fixture(identity = info) {
  let facts = status(identity),
    streamClosed = false;
  const queries: URL[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer owned');
      const url = new URL(request.url);
      if (url.pathname === '/v1/server') return Response.json(identity);
      if (url.pathname === '/v1/diagnostics/host-status') {
        queries.push(url);
        return Response.json(facts);
      }
      if (url.pathname === '/v1/events')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: ready\ndata: {"storeId":"store","replayFloor":"0","highWaterCursor":"7"}\n\n',
                ),
              );
            },
            cancel() {
              streamClosed = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      throw Error('unexpected_host_status_request');
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'owned',
    expected: {
      apiMajor: 1,
      profile: identity.profile,
      instanceId: identity.instanceId,
      buildId: identity.buildId,
      requiredCapabilities: ['host_status'],
    },
  });
  return {
    client,
    queries,
    set: (next: HostStatus) => {
      facts = next;
    },
    get streamClosed() {
      return streamClosed;
    },
    close() {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}

test('host status freezes scope, omits undefined query and preserves an active observation/cursor', async () => {
  const f = fixture();
  let ready!: () => void;
  const observed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let observation: Promise<void> | undefined;
  try {
    await f.client.connect();
    observation = f.client.observe({
      reconnect: false,
      onReady() {
        ready();
      },
      onChange() {},
    });
    await observed;
    const cursor = f.client.lastAppliedCursor;
    expect(await f.client.getHostStatus({ workspaceId: undefined, sessionId: undefined })).toEqual(
      status(),
    );
    expect(f.queries[0]!.search).toBe('');
    const target = { workspaceId: 'original', sessionId: 'original-session' };
    f.set({ ...status(), scope: { ...target } });
    const read = f.client.getHostStatus(target);
    target.workspaceId = 'changed';
    expect((await read).scope.workspaceId).toBe('original');
    expect(f.queries[1]!.searchParams.get('workspaceId')).toBe('original');
    expect(f.client.lastAppliedCursor).toEqual(cursor);
    expect(f.streamClosed).toBe(false);
    await expect(f.client.getHostStatus({ subjectId: 'spoof' } as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.queries).toHaveLength(2);
  } finally {
    f.close();
    await observation?.catch(() => {});
  }
});

test('host status rejects wrong identity/Store/target and closed authority forgery without re-request', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    for (const [changed, code] of [
      [{ instanceId: 'wrong' }, 'connection_identity_mismatch'],
      [{ buildId: 'wrong' }, 'connection_identity_mismatch'],
      [{ profileAccessKey: 'wrong' }, 'connection_identity_mismatch'],
      [{ storeId: 'wrong' }, 'store_identity_mismatch'],
    ] as const) {
      f.set({ ...status(), identity: { ...status().identity, ...changed } });
      await expect(f.client.getHostStatus()).rejects.toMatchObject({ code });
    }
    f.set({ ...status(), scope: { workspaceId: 'unsolicited', sessionId: null } });
    await expect(f.client.getHostStatus()).rejects.toMatchObject({
      code: 'diagnostic_scope_mismatch',
    });
    f.set({ ...status(), release: { ...status().release, active: true } } as unknown as HostStatus);
    await expect(f.client.getHostStatus()).rejects.toMatchObject({ code: 'invalid_response' });
    f.set({
      ...status(),
      telemetry: { ...status().telemetry, endpoint: 'secret-endpoint' },
    } as unknown as HostStatus);
    await expect(f.client.getHostStatus()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.queries).toHaveLength(7);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    f.close();
  }
});

test('admitted diagnostic data unavailable can read host facts without Store access', async () => {
  const diagnostic: ServerInfo = { ...info, dataAvailability: 'unavailable', storeId: undefined };
  const f = fixture(diagnostic);
  try {
    await f.client.connect();
    const facts = await f.client.getHostStatus();
    expect(facts.identity).toMatchObject({ dataAvailability: 'unavailable', storeId: null });
    expect(f.queries).toHaveLength(1);
    expect(() => f.client.getView('s')).toThrow('data_unavailable');
    expect(f.queries).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('Linux namespace status preserves pending qualification and rejects a promoted sandbox claim', async () => {
  const f = fixture();
  const facts = status();
  facts.execution.sandbox = {
    backend: 'linux_bubblewrap',
    available: true,
    qualification: 'host_scope_unqualified',
  };
  facts.execution.shell = {
    configured: true,
    available: true,
    supervision: 'linux_pid_namespace',
    qualification: 'linux_host_boundary_unqualified',
    reason: null,
  };
  try {
    await f.client.connect();
    f.set(facts);
    expect(await f.client.getHostStatus()).toEqual(facts);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    f.set({
      ...facts,
      execution: {
        ...facts.execution,
        sandbox: { ...facts.execution.sandbox, qualification: 'host_scope' },
      },
    } as unknown as HostStatus);
    await expect(f.client.getHostStatus()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.queries).toHaveLength(2);
  } finally {
    f.close();
  }
});
