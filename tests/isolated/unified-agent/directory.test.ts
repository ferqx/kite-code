import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '../../../apps/service/src';
import { startDevelopmentWeb } from '../../../apps/service/src/development-web';

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
test('actual SQLite/HTTP Native and cookie Browser directories exhaust >200 exact roots and workspaces at fixed original upper without writes or Model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-directory-')),
    store = await openSqliteStore({ dataRoot: root, profile: 'test' }),
    storeId = (await store.getMetadata()).storeId;
  let models = 0;
  const runtime = createRuntime({
    store,
    model: {
      async *stream() {
        models++;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'deny' };
      },
    },
  });
  const profile = { dataRoot: root, name: 'test', accessKey: 'directory-fixture' };
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let web: ReturnType<typeof startDevelopmentWeb> | undefined;
  let peer: Awaited<ReturnType<typeof startService>> | undefined;
  let peerClient: ReturnType<typeof createClient> | undefined;
  try {
    service = await startService({ runtime, profile, buildId: 'directory', subjectId: 'owner' });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    for (let i = 0; i < 205; i++)
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: `w-${i}`,
        name: `Workspace ${i}`,
        rootUri: `file://${root}/${i}`,
      });
    for (let i = 0; i < 205; i++)
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${i}`,
        sessionId: `s-${i}`,
        workspaceId: i === 204 ? 'w-204' : 'w-0',
        title: `Session ${i}`,
      });
    await store.createSession({
      expectedStoreId: storeId,
      commandId: 'foreign-create',
      sessionId: 'foreign',
      workspaceId: 'w-0',
      title: 'Private foreign subject',
      subjectId: 'foreign-owner',
    });
    const first = await client.listSessionDirectory({ storeId, limit: 200 }),
      workspaces = await client.listWorkspaceDirectory({ storeId, limit: 200 });
    expect(first.items).toHaveLength(200);
    expect(workspaces.items).toHaveLength(200);
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'late-create',
      sessionId: 'late',
      workspaceId: 'w-0',
      title: 'late',
    });
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'late-w',
      name: 'late',
      rootUri: `file://${root}/late`,
    });
    const second = await client.listSessionDirectory({
      storeId,
      afterSeq: first.nextAfterSeq!,
      upperSeq: first.upperSeq,
    });
    expect(second.items).toHaveLength(5);
    expect(second.nextAfterSeq).toBeNull();
    expect(second.items.some((item) => item.session.id === 'late')).toBe(false);
    const secondWorkspaces = await client.listWorkspaceDirectory({
      storeId,
      afterSeq: workspaces.nextAfterSeq!,
      upperSeq: workspaces.upperSeq,
    });
    expect(secondWorkspaces.items).toHaveLength(5);
    const all = await client.listAllSessions();
    expect(all).toHaveLength(206);
    expect(all.some((item) => item.id === 'foreign')).toBe(false);
    expect(new Set(all.map((item) => item.id)).size).toBe(206);
    expect((await client.listAllSessions({ workspaceId: 'w-204' })).map((item) => item.id)).toEqual(
      ['s-204'],
    );
    expect(await errorCode(client.listSessionDirectory({ storeId: 'wrong' }))).toBe(
      'store_identity_mismatch',
    );
    expect(
      await errorCode(client.listSessionDirectory({ storeId, afterSeq: '2', upperSeq: '1' })),
    ).toBe('invalid_cursor');
    expect(
      await errorCode(client.listWorkspaceDirectory({ storeId, upperSeq: '9223372036854775807' })),
    ).toBe('invalid_page');
    const raw = await fetch(
      `${service.endpoint}/v1/session-directory?storeId=${storeId}&subjectId=foreign-owner`,
      { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
    );
    expect(raw.status).toBe(400);
    await raw.body?.cancel();
    const foreign = await store.listSessionDirectory({
      expectedStoreId: storeId,
      subjectId: 'foreign-owner',
    });
    expect(foreign.items.map((item) => item.session.id)).toEqual(['foreign']);
    const empty = await store.listSessionDirectory({
      expectedStoreId: storeId,
      subjectId: 'unrelated',
    });
    expect(empty.items).toHaveLength(0);
    peer = await startService({
      runtime,
      profile,
      buildId: 'directory-peer',
      subjectId: 'foreign-owner',
    });
    peerClient = createClient({
      endpoint: peer.endpoint,
      token: peer.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
      bootstrap: peer.bootstrap,
    });
    await peerClient.connect();
    expect((await peerClient.listAllSessions()).map((item) => item.id)).toEqual(['foreign']);
    web = startDevelopmentWeb({ admittedClient: client });
    const shell = await fetch(web.endpoint),
      cookie = shell.headers.get('set-cookie')!.split(';')[0]!;
    await shell.body?.cancel();
    const browserFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', cookie);
        headers.set('origin', web!.endpoint);
        expect(headers.has('authorization')).toBe(false);
        return fetch(input, { ...init, headers });
      },
      { preconnect() {} },
    ) as typeof fetch;
    const browser = createBrowserClient({
      origin: web.endpoint,
      pageIdentity: web.pageIdentity,
      fetch: browserFetch,
    });
    await browser.connect();
    const before = (await store.getMetadata()).lastChangeCursor;
    const browserSessions = await browser.listAllSessions(),
      browserWorkspaces = await browser.listAllWorkspaces();
    expect(browserSessions.map((item) => item.id)).toEqual(all.map((item) => item.id));
    expect(browserWorkspaces).toHaveLength(206);
    expect(browserWorkspaces.some((item) => item.id === 'w-203')).toBe(true);
    expect(JSON.stringify(browserWorkspaces)).not.toContain('rootUri');
    expect(
      (await browser.listAllSessions({ workspaceId: 'w-204' })).map((item) => item.id),
    ).toEqual(['s-204']);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect(models).toBe(0);
    await browser.closeBrowserSession();
  } finally {
    await web?.close();
    peerClient?.disposeNetwork();
    await peer?.close();
    client?.disposeNetwork();
    await service?.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('cold readonly directory preserves original allocation upper and Store/subject scope without writing snapshot events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-readonly-directory-'));
  let store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  try {
    const storeId = (await store.getMetadata()).storeId;
    const empty = await store.listWorkspaceDirectory({ expectedStoreId: storeId });
    expect(empty.upperSeq).toBe('0');
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'empty',
      name: 'Empty valid workspace',
      rootUri: `file://${root}`,
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'one-create',
      sessionId: 'one',
      workspaceId: 'empty',
      title: 'one',
    });
    const sessionPage = await store.listSessionDirectory({
        expectedStoreId: storeId,
        subjectId: 'owner',
      }),
      cursor = (await store.getMetadata()).lastChangeCursor;
    await store.close();
    store = await openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' });
    expect(
      (
        await store.listSessionDirectory({
          expectedStoreId: storeId,
          subjectId: 'owner',
          upperSeq: sessionPage.upperSeq,
        })
      ).items.map((item) => item.session.id),
    ).toEqual(['one']);
    expect(
      (await store.listWorkspaceDirectory({ expectedStoreId: storeId, upperSeq: empty.upperSeq }))
        .items,
    ).toHaveLength(0);
    expect(
      (await store.listWorkspaceDirectory({ expectedStoreId: storeId })).items.map(
        (item) => item.workspace.id,
      ),
    ).toEqual(['empty']);
    expect(
      (await store.listSessionDirectory({ expectedStoreId: storeId, subjectId: 'unrelated' }))
        .items,
    ).toHaveLength(0);
    expect(
      await errorCode(store.listSessionDirectory({ expectedStoreId: 'other', subjectId: 'owner' })),
    ).toBe('store_identity_mismatch');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
