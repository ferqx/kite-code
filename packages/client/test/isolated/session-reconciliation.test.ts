import { expect, test } from 'bun:test';
import { createClient, type ReconcileSessionRequest } from '../../src';
import { backgroundSession } from '../fixtures/background-directory';

const profile = { dataRoot: '/owned', name: 'reconciliation', accessKey: 'owned' };
const report = {
  sessionId: 'root',
  storeId: 'store',
  interruptedRunIds: ['run'],
  settledExecutionIds: [],
  unknownExecutionIds: [],
  cancelledExecutionIds: [],
  partialMessageIds: [],
  snapshotCursor: '3',
};

function fixture() {
  const requests: { method: string; path: string; body?: ReconcileSessionRequest }[] = [];
  let mode = 'held',
    active = true,
    job = false,
    rootInactive = false;
  const view = (id: string) => ({
    storeId: 'store',
    snapshotCursor: '2',
    session: {
      ...backgroundSession,
      id,
      rootSessionId: 'root',
      parentSessionId: id === 'root' ? null : 'root',
      ownerGeneration: id === 'root' ? '7' : '3',
    },
    messages: [],
    executions:
      job && id === 'root'
        ? [
            {
              id: 'detached-job',
              sessionId: 'root',
              runId: null,
              kind: 'job',
              definitionId: 'fixture',
              definitionVersion: '1',
              status: 'running',
              result: null,
              resultRevision: '0',
              cancelRequestedAt: null,
            },
          ]
        : [],
    runs:
      active && !(id === 'root' && rootInactive)
        ? [
            {
              id: `run-${id}`,
              sessionId: id,
              originCommandId: 'work',
              originStoreId: 'store',
              status: 'running',
              isActive: true,
              createdAt: 0,
              finishedAt: null,
              reason: null,
            },
          ]
        : [],
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/server')
        return Response.json({
          instanceId: 'instance',
          buildId: 'build',
          apiMajor: 1,
          profile,
          capabilities: ['sessions', 'commands', 'session_reconciliation'],
          storeId: 'store',
          dataAvailability: 'available',
        });
      const body =
        request.method === 'POST' ? ((await request.json()) as ReconcileSessionRequest) : undefined;
      requests.push({ method: request.method, path, ...(body ? { body } : {}) });
      if (request.method === 'GET') return Response.json(view(path.split('/')[3]!));
      const result =
        mode === 'held'
          ? {
              storeId: 'store',
              sessionId: 'root',
              outcome: 'owner_held',
              commandId: null,
              report: null,
            }
          : {
              storeId: 'store',
              sessionId: 'root',
              outcome: 'reconciled',
              commandId: body!.commandId,
              report,
            };
      if (mode === 'wrong_store') result.storeId = 'foreign';
      if (mode === 'wrong_session') result.sessionId = 'foreign';
      if (mode === 'wrong_command') result.commandId = 'foreign';
      if (mode === 'invalid') return new Response('{');
      return Response.json(result);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'owned',
    expected: {
      apiMajor: 1,
      profile,
      instanceId: 'instance',
      buildId: 'build',
      requiredCapabilities: ['commands'],
    },
  });
  return {
    client,
    requests,
    mode: (value: string) => {
      mode = value;
    },
    active: (value: boolean) => {
      active = value;
    },
    rootInactive: (value: boolean) => {
      rootInactive = value;
    },
    job: (value: boolean) => {
      job = value;
    },
    close: async () => {
      client.disposeNetwork();
      await server.stop(true);
    },
  };
}

test('explicit state handoff freezes the observed root generation, uses a stable ID, rereads child and keeps ordinary GETs read-only', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    await f.client.getView('child');
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    f.requests.length = 0;
    expect((await f.client.reconcileSessionState('child')).session.id).toBe('child');
    expect(f.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/sessions/child/view',
      'GET /v1/sessions/root/view',
      'POST /v1/sessions/root/reconcile',
      'GET /v1/sessions/child/view',
    ]);
    const original = f.requests[2]!.body!;
    expect(original.expectedOwnerGeneration).toBe('7');
    expect(original.commandId).toMatch(/^session-reconcile-[a-f0-9]{64}$/);
    f.requests.length = 0;
    await f.client.reconcileSessionState('child');
    expect(f.requests[2]!.body).toEqual(original);
    f.requests.length = 0;
    f.active(false);
    await f.client.reconcileSessionState('child');
    expect(f.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST', 'GET']);
    f.requests.length = 0;
    f.job(true);
    await f.client.reconcileSessionState('child');
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.requests.find((request) => request.method === 'POST')?.body).toEqual(original);
    f.active(true);
    f.job(false);
    f.rootInactive(true);
    for (const selected of ['child', 'root']) {
      f.requests.length = 0;
      await f.client.reconcileSessionState(selected);
      expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      expect(f.requests.find((request) => request.method === 'POST')?.path).toBe(
        '/v1/sessions/root/reconcile',
      );
      expect(f.requests.find((request) => request.method === 'POST')?.body).toEqual(original);
    }
  } finally {
    await f.close();
  }
});

test('reconciliation rejects wrong scope before POST and invalid receipts stay unknown at the original ID', async () => {
  const f = fixture();
  const input = { expectedStoreId: 'store', commandId: 'original', expectedOwnerGeneration: '7' };
  try {
    await f.client.connect();
    await expect(
      f.client.reconcileSession('root', { ...input, expectedStoreId: 'foreign' }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    expect(f.requests).toHaveLength(0);
    for (const mode of ['wrong_store', 'wrong_session', 'wrong_command', 'invalid']) {
      f.mode(mode);
      const before = f.requests.length;
      await expect(f.client.reconcileSession('root', input)).rejects.toMatchObject({
        code: 'network_outcome_unknown',
        commandId: 'original',
      });
      expect(f.requests.length).toBe(before + 1);
      expect(f.requests.at(-1)?.body).toEqual(input);
    }
    const abort = new AbortController();
    abort.abort();
    const count = f.requests.length;
    await f.client.reconcileSessionState('child', { signal: abort.signal }).catch(() => {});
    expect(f.requests.length).toBe(count);
  } finally {
    await f.close();
  }
});
