import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { createClient, type SessionLogPage } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startDevelopmentWeb } from '../../src/development-web';
import { startService } from '../../src/index';
import { launchPairedService } from '../../src/paired';

async function failure(read: Promise<unknown> | (() => Promise<unknown>)) {
  try {
    await (typeof read === 'function' ? read() : read);
  } catch (error) {
    return error;
  }
  throw Error('expected read refusal');
}
async function browserFor(client: ReturnType<typeof createClient>) {
  const gateway = startDevelopmentWeb({ admittedClient: client });
  const document = await fetch(gateway.endpoint);
  await document.body?.cancel();
  const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
  const requests: { method: string; authorization: string | null }[] = [];
  const browser = createBrowserClient({
    origin: gateway.endpoint,
    pageIdentity: gateway.pageIdentity,
    fetch: Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', cookie);
        headers.set('origin', gateway.endpoint);
        requests.push({
          method: init?.method ?? 'GET',
          authorization: headers.get('authorization'),
        });
        return fetch(url, { ...init, headers });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await browser.connect();
  return { gateway, browser, requests, cookie };
}
function counts(db: Database) {
  return ['command', 'run', 'execution', 'change_event'].map((table) =>
    db.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
  );
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const end = Date.now() + 10000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= end) throw Error('actual logs fixture deadline');
    await Bun.sleep(10);
  }
}

test('actual SQLite >200 events reach Native and Cookie Browser with fixed upper, private scope and cold zero-write observation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-logs-public-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  const model = createFixedModel([]);
  const runtime = createRuntime({
    store,
    model,
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'readonly-fixture' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'temporary' },
    buildId: 'actual-logs',
    subjectId: 'owner',
    sessionLogs: (query, observer) => readSessionLogs(store, query, observer),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['session_logs'],
    },
  });
  const db = new Database(profile.databasePath);
  let web: Awaited<ReturnType<typeof browserFor>> | undefined;
  let closed = false;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'PRIVATE_TITLE_SENTINEL',
      rootUri: 'file:///PRIVATE_PATH_SENTINEL',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      title: 'PRIVATE_SESSION_SENTINEL',
    });
    await store.createSession({
      expectedStoreId: storeId,
      commandId: 'create-foreign',
      sessionId: 'foreign',
      workspaceId: 'w',
      title: 'private',
      subjectId: 'intruder',
    });
    for (let i = 0; i < 205; i++)
      await store.acceptCommand({
        expectedStoreId: storeId,
        commandId: `original-${i}`,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'PRIVATE_REQUEST_CONFIG_SECRET_SENTINEL' },
      });
    web = await browserFor(client);
    const before = counts(db),
      metadata = await store.getMetadata();
    const first = await client.listSessionLogs('s', {
      expectedStoreId: storeId,
      afterCursor: '0',
      upperCursor: undefined,
      limit: undefined,
    });
    expect(first.entries).toHaveLength(200);
    expect(first.complete).toBe(false);
    expect(
      await web.browser.listSessionLogs('s', { afterCursor: '0', upperCursor: first.upperCursor }),
    ).toEqual(first);
    expect(
      await web.browser.listSessionLogs('s', {
        afterCursor: '0',
        upperCursor: undefined,
        limit: undefined,
      }),
    ).toEqual(first);
    expect(
      first.entries.every((entry) => entry.sessionId === 's' && entry.modelExecutionId === null),
    ).toBe(true);
    expect(first.entries.find((entry) => entry.objectId === 'original-0')).toMatchObject({
      recordedStatus: 'accepted',
      details: { commandId: 'original-0' },
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      commandId: 'concurrent-new',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'PRIVATE_NEW_SENTINEL' },
    });
    const second = await web.browser.listSessionLogs('s', {
      afterCursor: first.nextAfterCursor!,
      upperCursor: first.upperCursor,
    });
    expect(second.complete).toBe(true);
    expect(first.entries.length + second.entries.length).toBeGreaterThan(200);
    expect(second.upperCursor).toBe(first.upperCursor);
    expect(second.entries.some((entry) => entry.objectId === 'concurrent-new')).toBe(false);
    const fresh = await client.listSessionLogs('s', {
      expectedStoreId: storeId,
      afterCursor: first.upperCursor,
    });
    expect(fresh.entries.some((entry) => entry.objectId === 'concurrent-new')).toBe(true);
    expect(JSON.stringify([first, second, fresh])).not.toContain('PRIVATE_');
    expect(JSON.stringify(first)).not.toContain('ownerGeneration');
    expect(JSON.stringify(first)).not.toContain('payload');
    const stable = counts(db),
      stableMetadata = await store.getMetadata();
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await failure(web.browser.listSessionLogs('s', { afterCursor: '0', signal: aborted.signal })),
    ).toBeInstanceOf(Error);
    expect(
      await failure(
        readSessionLogs(
          store,
          { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's', afterCursor: '0' },
          { signal: aborted.signal },
        ),
      ),
    ).toBeInstanceOf(Error);
    const cancelledObservation = new AbortController();
    const observation = readSessionLogs(
      store,
      { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's', afterCursor: '0' },
      { signal: cancelledObservation.signal },
    );
    cancelledObservation.abort();
    expect(await failure(observation)).toBeInstanceOf(Error);
    expect(
      await failure(
        client.listSessionLogs('foreign', { expectedStoreId: storeId, afterCursor: '0' }),
      ),
    ).toMatchObject({ code: 'model_input_scope_denied' });
    expect(
      await failure(
        client.listSessionLogs('missing', { expectedStoreId: storeId, afterCursor: '0' }),
      ),
    ).toMatchObject({ code: 'session_not_found' });
    expect(
      await failure(() =>
        client.listSessionLogs('s', { expectedStoreId: 'wrong', afterCursor: '0' }),
      ),
    ).toBeInstanceOf(Error);
    const raw = (query: string, auth = true) =>
      fetch(`${service.endpoint}/v1/sessions/s/logs?${query}`, {
        headers: auth ? { authorization: `Bearer ${service.bootstrap.token}` } : {},
      });
    expect((await raw(`storeId=${storeId}&afterCursor=0`, false)).status).toBe(401);
    const wrongStore = await raw('storeId=wrong&afterCursor=0');
    expect(wrongStore.status).toBe(409);
    expect(await wrongStore.json()).toMatchObject({ code: 'store_identity_mismatch' });
    expect((await raw(`storeId=${storeId}&afterCursor=0&extra=unknown`)).status).toBe(400);
    expect((await raw(`storeId=${storeId}&afterCursor=0&afterCursor=1`)).status).toBe(400);
    const response = await raw(`storeId=${storeId}&afterCursor=0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await response.body?.cancel();
    const posts = await fetch(`${web.gateway.endpoint}/browser/v1/sessions/s/logs?afterCursor=0`, {
      method: 'POST',
      headers: { cookie: web.cookie, origin: web.gateway.endpoint },
    });
    expect(posts.status).toBe(405);
    expect(counts(db)).toEqual(stable);
    expect(await store.getMetadata()).toEqual(stableMetadata);
    expect(before[1]).toEqual({ count: 0 });
    expect(stable[1]).toEqual({ count: 0 });
    expect(stable[2]).toEqual({ count: 0 });
    expect(model.requests).toHaveLength(0);
    expect(BigInt(stableMetadata.lastChangeCursor)).toBeGreaterThan(
      BigInt(metadata.lastChangeCursor),
    );
    expect(
      web.requests.every((request) => request.method === 'GET' && request.authorization === null),
    ).toBe(true);
    await web.gateway.close();
    await service.close();
    closed = true;
    const cold = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    try {
      const prior = await cold.getMetadata();
      const saved = await readSessionLogs(cold, {
        expectedStoreId: storeId,
        subjectId: 'owner',
        sessionId: 's',
        afterCursor: '0',
        upperCursor: first.upperCursor,
      });
      expect(saved.entries).toEqual(first.entries);
      expect(await cold.getMetadata()).toEqual(prior);
      expect(model.requests).toHaveLength(0);
    } finally {
      await cold.close();
    }
  } finally {
    await web?.gateway.close();
    if (!closed) await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('checked HTTP Decimal64/replay-floor SQL fault probes preserve exact watermarks and expire without writes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-logs-fault-')));
  const profile = selectProfile({ dataRoot: root, profile: 'owned' });
  const store = await openSqliteStore({ dataRoot: root, profile: 'owned' });
  const storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    model: createFixedModel([]),
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'readonly-fixture' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: root, name: 'owned', accessKey: 'temporary' },
    subjectId: 'owner',
    buildId: 'fault-probe',
    sessionLogs: (query, observer) => readSessionLogs(store, query, observer),
  });
  const db = new Database(profile.databasePath);
  try {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: 'file:///owned',
    });
    await store.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'owned',
      subjectId: 'owner',
    });
    // Explicit storage fault injection, not a claim of ordinary business reaching 2^53 events.
    const cursor = '9007199254740993';
    db.query('UPDATE storage_meta SET last_change_cursor=?').run(cursor);
    await store.acceptCommand({
      expectedStoreId: storeId,
      commandId: 'probe',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'private' },
    });
    const get = (after: string) =>
      fetch(`${service.endpoint}/v1/sessions/s/logs?storeId=${storeId}&afterCursor=${after}`, {
        headers: { authorization: `Bearer ${service.bootstrap.token}` },
      });
    const page = (await (await get(cursor)).json()) as SessionLogPage;
    expect(page.upperCursor).toBe('9007199254740994');
    expect(page.entries[0]!.cursor).toBe('9007199254740994');
    db.query('UPDATE storage_meta SET replay_floor=?').run(cursor);
    const before = counts(db),
      metadata = await store.getMetadata();
    const expired = await get('0');
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: 'cursor_expired' });
    expect((await get(cursor)).status).toBe(200);
    expect(counts(db)).toEqual(before);
    expect(await store.getMetadata()).toEqual(metadata);
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('default paired main exposes actual Model logs and complete original >64KiB input through SDK, cold read never replays Provider', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-logs-default-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const originalSource =
    'PRIVATE_ORIGINAL_SOURCE_SENTINEL\nAnswer the owned fixture without Tools.';
  writeFileSync(join(workspace, 'AGENTS.md'), originalSource);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'actual-logs-model', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame({ content: 'ACTUAL_LOGS_DONE' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      tools: [],
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
    }),
  );
  const launch = (id: string) =>
    launchPairedService({
      entrypoint: join(import.meta.dir, '../../src/main.ts'),
      profile,
      instanceId: id,
      buildId: 'default-source-main',
      apiMajor: 1,
      requiredCapabilities: ['session_logs', 'model_inputs'],
    });
  let child: Awaited<ReturnType<typeof launch>> | undefined;
  let web: Awaited<ReturnType<typeof browserFor>> | undefined;
  let db: Database | undefined;
  try {
    child = await launch('live');
    const client = child.client,
      storeId = child.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const sessionId of ['s', 'other'])
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: 'owned',
      });
    const mode = await client.getPermissionMode('s', { storeId });
    expect(
      (
        await client.setPermissionMode('s', {
          expectedStoreId: storeId,
          commandId: 'mode',
          mode: 'full',
          ifRevision: mode.revision,
          makeDefault: false,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trust = await client.getWorkspaceTrust('w', { storeId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    const original = `PRIVATE_ORIGINAL_REQUEST_BEGIN\n${'complete original α '.repeat(5000)}\nPRIVATE_ORIGINAL_REQUEST_END`;
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: original,
    });
    const view = await until(
      () => client.getView('s'),
      (value) => value.runs.some((run) => run.status === 'completed'),
    );
    const model = view.executions.find((execution) => execution.kind === 'model')!;
    expect(model.status).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools ?? []).toEqual([]);
    web = await browserFor(client);
    db = new Database(profile.databasePath, { readonly: true });
    const before = counts(db);
    const logs = await web.browser.listSessionLogs('s', {
      afterCursor: '0',
      upperCursor: undefined,
      limit: undefined,
    });
    const nav = logs.entries.find((entry) => entry.modelExecutionId === model.id)!;
    expect(nav).toBeDefined();
    expect(nav.details.kind).toBe('model');
    expect(nav.details.executionId).toBe(model.id);
    expect(nav.sessionId).toBe('s');
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
    expect(JSON.stringify(logs)).not.toContain('baseURL');
    expect(JSON.stringify(logs)).not.toContain('model_body');
    const snapshot = await web.browser.getModelInput('s', nav.modelExecutionId!);
    expect(snapshot.executionId).toBe(model.id);
    expect(snapshot.sessionId).toBe('s');
    expect(BigInt(snapshot.bodyBytes)).toBeGreaterThan(65536n);
    expect(snapshot.request.messages.some((message) => message.content === original)).toBe(true);
    expect(snapshot.metadata.context?.transformationId).toBe('kite.model-request');
    expect(snapshot.metadata.context?.sources.length).toBeGreaterThan(0);
    expect(
      snapshot.metadata.context?.sources.some(
        (source) => source.digest === createHash('sha256').update(originalSource).digest('hex'),
      ),
    ).toBe(true);
    expect(snapshot.request.messages.some((message) => message.content === originalSource)).toBe(
      true,
    );
    expect(await failure(web.browser.getModelInput('other', model.id))).toBeInstanceOf(Error);
    expect(
      (await web.browser.listSessionLogs('other', { afterCursor: '0' })).entries.every(
        (entry) => entry.modelExecutionId !== model.id,
      ),
    ).toBe(true);
    expect(counts(db)).toEqual(before);
    expect(requests).toHaveLength(1);
    await web.gateway.close();
    web = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    writeFileSync(
      join(workspace, 'AGENTS.md'),
      'Changed current source cannot replace original sealed input.',
    );
    child = await launch('cold');
    const coldLogs = await child.client.listSessionLogs('s', {
      expectedStoreId: storeId,
      afterCursor: '0',
      upperCursor: logs.upperCursor,
    });
    expect(coldLogs.entries).toEqual(logs.entries);
    const coldInput = await child.client.getModelInput('s', model.id);
    expect(coldInput.request).toEqual(snapshot.request);
    expect(coldInput.metadata).toEqual(snapshot.metadata);
    expect(requests).toHaveLength(1);
    expect(counts(db)).toEqual(before);
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
  } finally {
    await web?.gateway.close();
    await child?.close();
    db?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
