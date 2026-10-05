import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import {
  type Command,
  canonicalCallerCommandRequest,
  createClient,
  type ServerInfo,
} from '@kite-ai/client';
import type { TuiCallerRequest } from '@kite-ai/ui/tui';
import { callerDigest, callerRequestDigest, parseCallerIntent } from '../../host/caller-intents';
import { openCallerJournal } from '../../host/caller-journal';
import { createTuiCallerPort } from '../../host/caller-port';

const scope = { storeId: 'store', sessionId: 's', workspaceId: 'w' };
function request(
  actionId:
    | 'mcp.auth.login'
    | 'mcp.auth.refresh'
    | 'mcp.auth.clear'
    | 'mcp.auth.revoke' = 'mcp.auth.login',
  commandId = 'auth-original',
): Extract<TuiCallerRequest, { kind: 'extension.invoke' }> {
  const read = (kind: 'user' | 'workspace') => ({
    identity: { kind, pathDigest: 'a'.repeat(64), rootIdentity: 'b'.repeat(64) },
    etag: null,
    error: null,
  });
  return {
    expectedStoreId: scope.storeId,
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId,
    definitionVersion: '1',
    input: {
      serverId: 'source-id',
      expectedReadSet: {
        scopeDigest: 'c'.repeat(64),
        user: read('user'),
        workspace: read('workspace'),
        approvalEtag: null,
        bindingEtag: null,
        variablesDigest: 'd'.repeat(64),
      },
    },
  };
}
function intent(r = request()) {
  return {
    scope,
    request: r,
    subjectId: 'subject',
    target: { kind: 'session' as const, id: 's' },
    bodyDigest: callerDigest(r),
    requestDigest: callerRequestDigest(r),
  };
}

// Actual HTTP/SDK and private journal transport contract. The loopback responder is not an OAuth producer or effect proof.
async function fixture(storeId = 'store', subjectId = 'subject') {
  const root = mkdtempSync('/private/tmp/kite-auth-caller-');
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const journal = openCallerJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  const info: ServerInfo = {
    profile: { dataRoot: '/owned', name: 'owned', accessKey: 'owned' },
    instanceId: 'i',
    buildId: 'b',
    apiMajor: 1,
    capabilities: ['commands', 'extensions_actions'],
    dataAvailability: 'available',
    storeId,
    subjectId,
  };
  const calls: { method: string; path: string }[] = [];
  let command: Command = {
    id: 'auth-original',
    originStoreId: 'store',
    sessionId: 's',
    kind: 'extension.invoke',
    status: 'accepted',
    receipt: null,
    subjectId: 'subject',
    requestDigest: callerRequestDigest(request()),
    cancelRequestedAt: null,
  };
  let mode: 'lost' | 'accepted' | 'applied' | 'missing' | 'wrong' = 'lost';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path });
      if (path === '/v1/server') return Response.json(info);
      if (path.endsWith('/view'))
        return Response.json({
          session: {
            id: 's',
            workspaceId: 'w',
            parentSessionId: null,
            title: '',
            controlRevision: '0',
            contextSelectionId: 'c',
            nextSeq: '0',
            deletedAt: null,
          },
          runs: [],
          executions: [],
          messages: [],
          snapshotCursor: '0',
          storeId: 'store',
        });
      if (req.method === 'POST') {
        const body = await req.json();
        expect(body).toEqual(request());
        if (mode === 'lost')
          return Response.json(
            { code: 'owned_reply_failure', message: 'owned_reply_failure' },
            { status: 500 },
          );
        return Response.json(command);
      }
      if (path.startsWith('/v1/commands/')) return Response.json(command);
      if (path.startsWith('/v1/executions/')) {
        if (mode === 'missing')
          return Response.json(
            { code: 'execution_not_found', message: 'execution_not_found' },
            { status: 404 },
          );
        return Response.json({
          id: 'e',
          originStoreId: mode === 'wrong' ? 'other' : 'store',
          sessionId: 's',
          runId: null,
          kind: 'job',
          definitionId: 'builtin.mcp.sources/mcp.auth.login',
          definitionVersion: '1',
          status: 'succeeded',
          result: null,
          resultRevision: '1',
          cancelRequestedAt: null,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: 'owned-test',
    expected: { profile: info.profile, apiMajor: 1, requiredCapabilities: [] },
  });
  await client.connect();
  return {
    root,
    access,
    journal,
    client,
    calls,
    port: createTuiCallerPort({ client, storeId, journal }),
    setMode(next: typeof mode) {
      mode = next;
      if (next !== 'lost' && next !== 'accepted')
        command = {
          ...command,
          status: 'applied',
          receipt: { executionId: 'e', preparingNextAttempt: false },
        };
    },
    close() {
      client.disposeNetwork();
      server.stop(true);
      journal.close();
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('four fixed auth requests bind full read set; recomputing hashes does not admit extra action/version/credential or draft', () => {
  for (const action of [
    'mcp.auth.login',
    'mcp.auth.refresh',
    'mcp.auth.clear',
    'mcp.auth.revoke',
  ] as const)
    expect(parseCallerIntent(intent(request(action))).request).toEqual(request(action));
  const mutations = [
    (r: ReturnType<typeof request>) => {
      Object.assign(r, { extensionId: 'other' });
    },
    (r: ReturnType<typeof request>) => {
      Object.assign(r, { actionId: 'mcp.source.approve' });
    },
    (r: ReturnType<typeof request>) => {
      Object.assign(r, { definitionVersion: '2' });
    },
    (r: ReturnType<typeof request>) => {
      Object.assign(r.input, { credential: 'forbidden' });
    },
    (r: ReturnType<typeof request>) => {
      Object.assign(r.input.expectedReadSet.user.identity, { extra: true });
    },
  ];
  for (const mutate of mutations) {
    const r = request();
    mutate(r);
    expect(() => canonicalCallerCommandRequest(r)).toThrow();
  }
  const old = intent();
  const changed = structuredClone(old);
  changed.request.input.expectedReadSet.scopeDigest = 'f'.repeat(64);
  expect(() => parseCallerIntent(changed)).toThrow();
  expect(() =>
    parseCallerIntent({
      ...old,
      draft: { id: 'a'.repeat(64), revision: '1', textDigest: 'b'.repeat(64) },
    }),
  ).toThrow();
});

test('durable prepare precedes one real POST; lost reply and cold duplicate submit only original GET; applied is Command only', async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof openCallerJournal> | undefined;
  try {
    const prepared = await f.port.prepare(scope, request());
    expect(
      JSON.parse(readFileSync(join(f.access.profilePath, 'ui/caller-intents.json'), 'utf8'))
        .records[0].intent,
    ).toEqual(prepared);
    expect((await f.port.submit(prepared)).phase).toBe('unknown');
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    f.journal.close();
    reopened = openCallerJournal({
      access: f.access,
      acquireWriteLock: () => acquireProfileDataLock(f.access, 'tui_private'),
    });
    const cold = createTuiCallerPort({ client: f.client, storeId: 'store', journal: reopened });
    expect((await cold.list())[0]?.phase).toBe('unknown');
    expect((await cold.submit(prepared)).phase).toBe('accepted');
    f.setMode('missing');
    expect((await cold.lookup(prepared, new AbortController().signal)).phase).toBe('unknown');
    f.setMode('wrong');
    expect((await cold.lookup(prepared, new AbortController().signal)).phase).toBe('unknown');
    f.setMode('applied');
    const applied = await cold.lookup(prepared, new AbortController().signal);
    expect(applied.phase).toBe('applied');
    expect(Object.hasOwn(applied, 'authenticated')).toBe(false);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    reopened.close();
  } finally {
    reopened?.close();
    f.close();
  }
}, 5000);

for (const [storeId, subjectId] of [
  ['other', 'subject'],
  ['store', 'other'],
] as const)
  test(`foreign admitted ${storeId === 'other' ? 'Store' : 'subject'} preserves original bytes and refuses lookup/duplicate before all HTTP`, async () => {
    const f = await fixture(storeId, subjectId);
    try {
      const original = intent();
      f.journal.prepare(original);
      const before = readFileSync(join(f.access.profilePath, 'ui/caller-intents.json'));
      const count = f.calls.length;
      expect((await f.port.list())[0]?.intent).toEqual(original);
      expect((await f.port.lookup(original, new AbortController().signal)).phase).toBe('unknown');
      expect((await f.port.submit(original)).phase).toBe('unknown');
      await expect(f.port.prepare(scope, request())).rejects.toThrow();
      expect(f.calls.length).toBe(count);
      expect(readFileSync(join(f.access.profilePath, 'ui/caller-intents.json'))).toEqual(before);
    } finally {
      f.close();
    }
  }, 5000);
