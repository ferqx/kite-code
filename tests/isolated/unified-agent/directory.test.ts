import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '../../../apps/service/src';
import { startDevelopmentWeb } from '../../../apps/service/src/development-web';
import { semanticDigest } from '../../../packages/agent/src/json';
import type { Json } from '../../../packages/agent/src/storage/types';
import { gitWorktreeRecordDefinition } from '../../../packages/agent/src/tools/git-worktree';
import {
  buildWorkerCommand,
  digest,
  parseGitWorktreeInput,
  resolveDefaultWorktreeTarget,
  type WorktreePlan,
  type WorktreeRequest,
} from '../../../packages/agent/src/tools/git-worktree/protocol';
import { temporaryDirectory } from '../../fixtures/test-filesystem';

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
test('actual SQLite/HTTP Native and cookie Browser directories exhaust >200 exact roots and workspaces at fixed original upper without writes or Model', async () => {
  const root = temporaryDirectory('kite-directory-'),
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
        rootUri: pathToFileURL(`${root}/${i}`).href,
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
    expect(first.items.every((item) => item.activity?.updatedAt === null)).toBe(true);
    expect(first.items.every((item) => item.activity?.run === null)).toBe(true);
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
      rootUri: pathToFileURL(`${root}/late`).href,
    });
    expect(
      await errorCode(
        client.listSessionDirectory({
          storeId,
          afterSeq: first.nextAfterSeq!,
          upperSeq: first.upperSeq,
          snapshotCursor: first.snapshotCursor,
        }),
      ),
    ).toBe('directory_changed');
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
    const summaries = await client.listAllSessionDirectory();
    expect(summaries.map((item) => item.session.id)).toEqual(all.map((item) => item.id));
    const beforeRename = summaries.find((item) => item.session.id === 's-0')!;
    await Bun.sleep(2);
    await client.renameSession('s-0', {
      expectedStoreId: storeId,
      commandId: 'rename-s-0',
      ifRevision: beforeRename.session.controlRevision,
      title: 'Renamed without a Run',
    });
    const renamed = (await client.listAllSessionDirectory()).find(
      (item) => item.session.id === 's-0',
    )!;
    const logs = await store.getSessionLogs({
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 's-0',
      afterCursor: '0',
    });
    expect(logs.entries.at(-1)!.occurredAt).toBeGreaterThan(0);
    expect(renamed.activity!.updatedAt).toBe(beforeRename.activity!.updatedAt);
    expect(renamed.activity!.updatedAt).toBeNull();
    expect(renamed.activity!.run).toBeNull();
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
    const browserSummaries = await browser.listAllSessionDirectory();
    expect(browserSummaries).toEqual(await client.listAllSessionDirectory());
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

test('actual Core activity follows message clocks independently of mode, rename, reads and Run status; missing historical clocks stay unknown', async () => {
  const root = temporaryDirectory('kite-session-activity-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  let db: Database | undefined;
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    for (const sessionId of ['working', 'old'])
      await store.createSession({
        expectedStoreId,
        subjectId: 'owner',
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: sessionId,
      });
    const read = () => store.listSessionDirectory({ expectedStoreId, subjectId: 'owner' });
    const activity = async () =>
      (await read()).items.find((item) => item.session.id === 'working')!.activity;
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'first-work',
      sessionId: 'working',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'PRIVATE_RAW_INPUT' },
    });
    expect(await activity()).toMatchObject({ queued: true, run: null, pendingInteractions: 0 });
    const owner = (await store.acquireSessionOwner('working', 'fixture'))!;
    const first = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'first-work',
      configuration: { secret: 'PRIVATE_CONFIGURATION' },
    });
    const firstMessageTime = (await activity()).updatedAt!;
    expect(firstMessageTime).toBeGreaterThan(0);
    await Bun.sleep(2);
    const safeRequest = {
      scope: 'session',
      sessionId: 'working',
      mode: 'auto',
      ifRevision: '0',
      makeDefault: false,
      ifDefaultRevision: '0',
    };
    const mode = {
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'mode-working',
      kind: 'permission.mode' as const,
      scope: 'session:working',
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
    await store.beginHostMutation(mode);
    expect((await activity()).updatedAt).toBe(firstMessageTime);
    await store.finishHostMutation({
      expectedStoreId,
      subjectId: 'owner',
      commandId: mode.commandId,
      requestDigest: mode.requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
    expect(
      (
        await store.readHostControl({
          expectedStoreId,
          subjectId: 'owner',
          kind: 'permission.mode',
          scope: 'session:working',
        })
      ).record?.safeRequest,
    ).toMatchObject({ mode: 'auto' });
    expect((await activity()).updatedAt).toBe(firstMessageTime);
    await store.renameSession({
      expectedStoreId,
      subjectId: 'owner',
      sessionId: 'working',
      commandId: 'rename-working',
      ifRevision: (await store.getSession('working'))!.controlRevision,
      title: 'Renamed',
    });
    expect((await activity()).updatedAt).toBe(firstMessageTime);
    const beforeReads = await store.getMetadata();
    await store.getView('working');
    await store.getView('old');
    expect((await activity()).updatedAt).toBe(firstMessageTime);
    expect(await store.getMetadata()).toEqual(beforeReads);
    expect(await activity()).toMatchObject({
      queued: false,
      run: { id: first.id, status: 'running', isActive: true },
    });
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'second-work',
      sessionId: 'working',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'second' },
    });
    expect(await activity()).toMatchObject({
      queued: true,
      run: { id: first.id, status: 'running', isActive: true },
    });
    await store.finishRun({
      expectedStoreId,
      owner,
      runId: first.id,
      status: 'completed',
      requirements: [],
    });
    expect(await activity()).toMatchObject({
      queued: true,
      run: { id: first.id, status: 'completed', isActive: false },
    });
    const second = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'second-work',
      configuration: {},
    });
    const secondMessageTime = (await activity()).updatedAt!;
    expect(secondMessageTime).toBeGreaterThan(firstMessageTime);
    await store.finishRun({
      expectedStoreId,
      owner,
      runId: second.id,
      status: 'failed',
      requirements: [],
    });
    const observed = await activity();
    expect(observed).toMatchObject({
      queued: false,
      run: { id: second.id, status: 'failed', isActive: false },
    });
    const logs = await store.getSessionLogs({
      expectedStoreId,
      sessionId: 'working',
      subjectId: 'owner',
      afterCursor: '0',
    });
    expect(observed.updatedAt).toBe(secondMessageTime);
    expect(observed.updatedAt).toBe(
      logs.entries.filter((entry) => entry.type === 'message.updated').at(-1)!.occurredAt!,
    );
    const cold = await openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' });
    try {
      const beforeColdRead = await store.getMetadata();
      const page = await cold.listSessionDirectory({ expectedStoreId, subjectId: 'owner' });
      expect(page.items.find((item) => item.session.id === 'working')!.activity.updatedAt).toBe(
        secondMessageTime,
      );
      expect(await store.getMetadata()).toEqual(beforeColdRead);
    } finally {
      await cold.close();
    }
    expect(JSON.stringify(await read())).not.toContain('PRIVATE_');
    db = new Database(join(root, 'test', 'core.db'));
    const before = await store.getMetadata();
    for (const envelope of [
      { format: 'kite.session-log', version: 2, occurredAt: Date.now() },
      { format: 'kite.session-log', version: 1, occurredAt: true },
      { format: 'kite.session-log', version: true, occurredAt: Date.now() },
    ]) {
      db.run(
        "UPDATE change_event SET payload_json=? WHERE cursor=(SELECT MAX(cursor) FROM change_event WHERE scope_session_id='working' AND type='message.updated')",
        [JSON.stringify(envelope)],
      );
      expect(
        (await read()).items.find((item) => item.session.id === 'working')!.activity.updatedAt,
      ).toBeNull();
      expect(await store.getMetadata()).toEqual(before);
    }
    await store.releaseSessionOwner(owner);
  } finally {
    db?.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold readonly directory preserves original allocation upper and Store/subject scope without writing snapshot events', async () => {
  const root = temporaryDirectory('kite-readonly-directory-');
  let store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  try {
    const storeId = (await store.getMetadata()).storeId;
    const empty = await store.listWorkspaceDirectory({ expectedStoreId: storeId });
    expect(empty.upperSeq).toBe('0');
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'empty',
      name: 'Empty valid workspace',
      rootUri: pathToFileURL(root).href,
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
      ).items,
    ).toEqual(sessionPage.items);
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

test('worktree creation history reaches HTTP directories, survives removal and cold reads, and excludes unconfirmed, unrelated and Fork records', async () => {
  // This fixture seeds persisted receipts only; it does not create or remove Git worktrees.
  const root = temporaryDirectory('kite-directory-worktree-');
  const options = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(options);
  let models = 0;
  const runtime = createRuntime({
    store,
    model: {
      async *stream() {
        models++;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    extensions: [
      {
        id: 'builtin.shell',
        version: '1',
        apiMajor: 1,
        records: [gitWorktreeRecordDefinition],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'deny' };
      },
    },
  });
  let db: Database | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    const names = [
      'created',
      'none',
      'unknown',
      'failed',
      'unfinished',
      'list',
      'remove',
      'wrong-extension',
      'wrong-key',
      'wrong-type',
      'wrong-version',
      'fork-copy',
      'wrong-owner',
      'malformed',
      'invalid-schema',
      'parent',
      'child',
    ];
    for (const sessionId of names)
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'owner',
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: sessionId,
      });
    db = new Database(join(root, 'test', 'core.db'));
    db.run("UPDATE session SET parent_id='parent',root_id='parent' WHERE id='child'");
    const receipt = (action = 'create') => ({
      schemaVersion: 1,
      ownerExecutionId: 'original-tool',
      requestDigest: 'request',
      request: { action, key: 'original' },
      configurationIdentity: 'configuration',
      acceptedAt: '2026-11-06T00:00:00.000Z',
      deadlineAt: '2026-11-06T00:02:00.000Z',
      phase: 'completed',
      steps: {},
      stableResult: {
        outcome: 'succeeded',
        content: 'original receipt',
        details: {
          action,
          key: 'original',
          mutation: 'completed',
          cwdChanged: false,
          operation: { ownerExecutionId: 'original-tool' },
        },
      },
    });
    const insert = (
      sessionId: string,
      value: unknown,
      overrides: {
        extension?: string;
        key?: string;
        type?: string;
        version?: number;
        fork?: string;
      } = {},
    ) =>
      db!.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json,fork_provenance_json) VALUES(?,'session',?,?,1,?,?,?,?,?)",
        [
          overrides.extension ?? 'builtin.shell',
          sessionId,
          overrides.key ?? 'git-worktree/original',
          overrides.type ?? gitWorktreeRecordDefinition.contentType,
          overrides.version ?? 1,
          storeId,
          typeof value === 'string' ? value : JSON.stringify(value),
          overrides.fork ?? null,
        ],
      );
    for (const sessionId of ['created', 'child']) insert(sessionId, receipt());
    for (const outcome of ['outcome_unknown', 'failed']) {
      const value = receipt();
      value.stableResult.outcome = outcome;
      insert(outcome === 'failed' ? 'failed' : 'unknown', value);
    }
    const unfinished = receipt();
    unfinished.phase = 'unresolved';
    insert('unfinished', unfinished);
    insert('list', receipt('list'));
    insert('remove', receipt('remove'));
    insert('wrong-extension', receipt(), { extension: 'fixture' });
    insert('wrong-key', receipt(), { key: 'ordinary-shell/original' });
    insert('wrong-type', receipt(), { type: 'fixture.result' });
    insert('wrong-version', receipt(), { version: 2 });
    insert('fork-copy', receipt(), { fork: '{}' });
    const wrongOwner = receipt();
    wrongOwner.stableResult.details.operation.ownerExecutionId = 'another-tool';
    insert('wrong-owner', wrongOwner);
    insert('malformed', '{');
    insert('invalid-schema', { ...receipt(), schemaVersion: true });
    const read = () => store.listSessionDirectory({ expectedStoreId: storeId, subjectId: 'owner' });
    const beforeRead = await store.getMetadata();
    expect(
      (await read()).items
        .filter((item) => item.activity.hasCreatedWorktree)
        .map((item) => item.session.id),
    ).toEqual(['created']);
    expect(await store.getMetadata()).toEqual(beforeRead);
    // A later remove receipt does not erase the original create history.
    insert('created', receipt('remove'), { key: 'git-worktree/remove' });
    await runtime.forkSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'fork-created',
      sourceSessionId: 'created',
      expectedContextSelectionId: (await store.getSession('created'))!.contextSelectionId,
      newSessionId: 'forked',
      title: 'forked',
    });
    expect(
      await store.listExtensionRecords({ extensionId: 'builtin.shell', sessionId: 'forked' }),
    ).toEqual([]);
    const profile = { dataRoot: root, name: 'test', accessKey: 'worktree-directory' };
    service = await startService({
      runtime,
      profile,
      buildId: 'worktree-directory',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
    });
    await client.connect();
    const metadata = await store.getMetadata();
    const publicItems = await client.listAllSessionDirectory();
    expect(
      publicItems
        .filter((item) => item.activity?.hasCreatedWorktree)
        .map((item) => item.session.id),
    ).toEqual(['created']);
    expect(
      publicItems.find((item) => item.session.id === 'created')!.activity!.updatedAt,
    ).toBeNull();
    expect(publicItems.some((item) => item.session.id === 'child')).toBe(false);
    expect(await store.getMetadata()).toEqual(metadata);
    const cold = await openSqliteStore({ ...options, mode: 'readonly' });
    try {
      const coldItems = (
        await cold.listSessionDirectory({ expectedStoreId: storeId, subjectId: 'owner' })
      ).items;
      expect(
        coldItems.filter((item) => item.activity.hasCreatedWorktree).map((item) => item.session.id),
      ).toEqual(['created']);
      expect(await cold.getMetadata()).toEqual(metadata);
    } finally {
      await cold.close();
    }
    expect(models).toBe(0);
  } finally {
    client?.disposeNetwork();
    await service?.close();
    db?.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree navigation provenance requires a unique visible original create and survives cold HTTP reads without granting execution', async () => {
  // Seed persisted Tool/Job receipts, not a Git repository or a new filesystem mutation.
  const root = temporaryDirectory('kite-directory-worktree-source-');
  const options = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(options);
  const storeId = (await store.getMetadata()).storeId;
  const db = new Database(join(root, 'test', 'core.db'));
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
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const sourcePath = join(root, 'source with spaces');
    const targetPath = join(root, 'linked with spaces');
    for (const [id, path] of [
      ['source-w', sourcePath],
      ['target-w', targetPath],
      ['nested-w', join(targetPath, 'nested')],
    ])
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: id!,
        name: id!,
        rootUri: pathToFileURL(path!).href,
      });
    for (const [id, workspaceId, subjectId] of [
      ['source', 'source-w', 'owner'],
      ['another-source', 'source-w', 'owner'],
      ['foreign-source', 'source-w', 'other'],
      ['target', 'target-w', 'owner'],
      ['target-two', 'target-w', 'owner'],
      ['nested', 'nested-w', 'owner'],
    ])
      await store.createSession({
        expectedStoreId: storeId,
        commandId: `create-${id}`,
        sessionId: id!,
        workspaceId: workspaceId!,
        title: id!,
        subjectId: subjectId!,
      });
    const seed = async (sessionId: string, key: string, implicit = false) => {
      const defaultRoot = join(root, 'default-worktrees');
      const createdPath = implicit
        ? resolveDefaultWorktreeTarget({ defaultRoot, sourceCwd: sourcePath, sessionId, key })
        : targetPath;
      const commandId = `work-${key}`,
        toolId = `tool-${key}`;
      await store.acceptCommand({
        expectedStoreId: storeId,
        commandId,
        sessionId,
        subjectId: sessionId === 'foreign-source' ? 'other' : 'owner',
        request: { kind: 'run.start', content: 'saved worktree create' },
      });
      const owner = (await store.acquireSessionOwner(sessionId, 'directory-fixture'))!;
      const run = await store.startRun({
        expectedStoreId: storeId,
        owner,
        commandId,
        configuration: {
          tools: [{ id: 'git.worktree', version: '1', extensionId: 'builtin.shell' }],
          extensions: [{ id: 'builtin.shell', version: '1' }],
        },
      });
      const request = parseGitWorktreeInput({
        action: 'create',
        key,
        // Real Windows calls may preserve forward slashes while the worker freezes resolve(path).
        ...(!implicit
          ? { path: process.platform === 'win32' ? createdPath.replaceAll('\\', '/') : createdPath }
          : {}),
      })!;
      const requestDigest = digest({ input: request, sourceCwd: sourcePath });
      const recordKey = `git-worktree/${key}`;
      const token = digest({ sessionId, executionId: toolId, key: recordKey, requestDigest });
      const identity = { dev: '1', ino: '2', ctimeNs: '3', birthtimeNs: '4' };
      const plan: WorktreePlan = {
        action: 'create',
        sourceCwd: sourcePath,
        sourceRoot: sourcePath,
        commonDir: join(sourcePath, '.git'),
        targetPath: createdPath,
        baseRef: 'HEAD',
        baseOid: 'f'.repeat(40),
        evidence: {
          repository: {
            root: sourcePath,
            gitDir: join(sourcePath, '.git'),
            commonDir: join(sourcePath, '.git'),
            bare: false,
            rootIdentity: identity,
            commonIdentity: identity,
          },
          parent: {
            path: root,
            identity,
            ...(implicit ? { defaultRoot, missingParents: [] } : {}),
          },
        },
      };
      const configuration = {
        configurationId: 'fixture',
        sourceCwd: sourcePath,
        bunPath: join(root, 'bun'),
        workerPath: join(root, 'worker.js'),
        configPath: join(root, 'bunfig.toml'),
        hooksPath: join(root, 'hooks'),
        git: { path: join(root, 'git'), sha256: 'a'.repeat(64) },
      };
      const worker: WorktreeRequest = {
        schemaVersion: 1,
        configurationId: 'fixture',
        operationToken: token,
        phase: 'create',
        sourceCwd: sourcePath,
        git: configuration.git,
        hooksPath: configuration.hooksPath,
        plan,
        planDigest: digest(plan),
      };
      const input = {
        command: buildWorkerCommand(configuration, worker),
        permissions: { filesystem: 'workspace_write', network: 'none' },
      };
      await store.planExecution({
        expectedStoreId: storeId,
        owner,
        executionId: toolId,
        sessionId,
        runId: run.id,
        originCommandId: commandId,
        stepId: toolId,
        callId: toolId,
        kind: 'tool',
        definitionId: 'git.worktree',
        definitionVersion: '1',
        input: request as unknown as Json,
        decisionSource: {},
      });
      db.run("UPDATE execution SET state='running',dispatched=1 WHERE id=?", [toolId]);
      const operationKey = `git-worktree-${digest({ token, kind: 'mutation' })}`;
      const ref = await store.ensureOperation({
        expectedStoreId: storeId,
        owner,
        sessionId,
        extensionId: 'builtin.shell',
        originCommandId: commandId,
        parentExecutionId: toolId,
        operationKey,
        request: { kind: 'job', definitionId: 'shell.command', definitionVersion: '1', input },
      });
      await store.planExecution({
        expectedStoreId: storeId,
        owner,
        executionId: ref.executionId!,
        sessionId,
        runId: null,
        originCommandId: ref.commandId,
        parentExecutionId: toolId,
        stepId: `operation-${ref.commandId}`,
        callId: ref.commandId,
        kind: 'job',
        definitionId: 'shell.command',
        definitionVersion: '1',
        input,
        decisionSource: {},
      });
      const stableResult = {
        outcome: 'succeeded',
        content: 'original success',
        details: {
          action: 'create',
          key,
          path: createdPath,
          head: 'f'.repeat(40),
          baseCommit: 'f'.repeat(40),
          baseRef: 'HEAD',
          branch: null,
          detached: true,
          mutation: 'completed',
          cwdChanged: false,
          observedAt: '2026-11-06T00:00:01.000Z',
          repository: { root: sourcePath, commonDir: join(sourcePath, '.git') },
          observed: { pathExists: true, registered: true },
          operation: { ownerExecutionId: toolId, ref },
        },
      };
      const value = {
        schemaVersion: 1,
        ownerExecutionId: toolId,
        requestDigest,
        request,
        ...(implicit ? { resolvedTarget: { path: createdPath, defaultRoot } } : {}),
        configurationIdentity: digest(configuration),
        acceptedAt: '2026-11-06T00:00:00.000Z',
        deadlineAt: '2026-11-06T00:02:00.000Z',
        phase: 'completed',
        plan,
        planDigest: digest(plan),
        steps: {
          mutation: {
            operationKey,
            request: worker,
            input,
            inputDigest: digest(input),
            timeoutMs: 120000,
            ref,
          },
        },
        stableResult,
      };
      db.run("UPDATE execution SET state='succeeded',dispatched=1,result_json=? WHERE id=?", [
        JSON.stringify(stableResult),
        toolId,
      ]);
      db.run("UPDATE execution SET state='succeeded',dispatched=1,result_json=? WHERE id=?", [
        JSON.stringify({ outcome: 'succeeded', content: 'original Job completion' }),
        ref.executionId!,
      ]);
      db.run("UPDATE run SET status='completed',is_active=0 WHERE id=?", [run.id]);
      db.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('builtin.shell','session',?,?,1,?,1,?,?)",
        [
          sessionId,
          recordKey,
          gitWorktreeRecordDefinition.contentType,
          storeId,
          JSON.stringify(value),
        ],
      );
      await store.releaseSessionOwner(owner);
      return {
        value,
        toolId,
        runId: run.id,
        jobId: ref.executionId!,
        recordKey,
        sessionId,
        createdPath,
      };
    };
    const saved = await seed('source', 'original');
    const read = () =>
      store.listSessionDirectory({
        expectedStoreId: storeId,
        subjectId: 'owner',
        workspaceId: 'target-w',
        limit: 1,
      });
    const source = { sessionId: 'source', workspaceId: 'source-w' };
    expect((await read()).items[0]!.worktreeSource).toEqual(source);
    expect(
      (
        await store.listSessionDirectory({
          expectedStoreId: storeId,
          subjectId: 'owner',
          workspaceId: 'nested-w',
        })
      ).items[0]!.worktreeSource,
    ).toBeUndefined();
    const first = await read();
    expect(
      (
        await store.listSessionDirectory({
          expectedStoreId: storeId,
          subjectId: 'owner',
          workspaceId: 'target-w',
          afterSeq: first.nextAfterSeq!,
          upperSeq: first.upperSeq,
          snapshotCursor: first.snapshotCursor,
        })
      ).items[0]!.worktreeSource,
    ).toEqual(source);
    const negative = async (sql: string, args: (string | number | null)[], undo: () => void) => {
      db.run(sql, args);
      try {
        expect((await read()).items[0]!.worktreeSource).toBeUndefined();
      } finally {
        undo();
      }
      expect((await read()).items[0]!.worktreeSource).toEqual(source);
    };
    const restoreRecord = () =>
      db.run(
        "UPDATE extension_record SET json=?,origin_store_id=?,fork_provenance_json=NULL,content_version=1 WHERE scope_id='source' AND key=?",
        [JSON.stringify(saved.value), storeId, saved.recordKey],
      );
    for (const [fields, replacement] of [
      [['stableResult', 'outcome'], 'outcome_unknown'],
      [['stableResult', 'details', 'mutation'], 'partial'],
      [['stableResult', 'details', 'path'], join(targetPath, 'other')],
      [['stableResult', 'details', 'cwdChanged'], true],
      [['stableResult', 'details', 'operation', 'ownerExecutionId'], 'different'],
      [['steps', 'mutation', 'ref', 'executionId'], 'different'],
      [['schemaVersion'], true],
      [['plan', 'action'], { toString: null, valueOf: null }],
      [['plan'], undefined],
      [['stableResult', 'details', 'observedAt'], undefined],
      [['stableResult', 'details', 'head'], undefined],
    ] as [string[], Json | undefined][]) {
      const value = structuredClone(saved.value) as unknown as Record<string, Json>;
      let nested = value;
      for (const field of fields.slice(0, -1)) nested = nested[field] as Record<string, Json>;
      if (replacement === undefined) delete nested[fields.at(-1)!];
      else nested[fields.at(-1)!] = replacement;
      await negative(
        "UPDATE extension_record SET json=? WHERE scope_id='source' AND key=?",
        [JSON.stringify(value), saved.recordKey],
        restoreRecord,
      );
    }
    for (const [column, value] of [
      ['origin_store_id', 'old-store'],
      ['fork_provenance_json', '{}'],
      ['content_version', 2],
    ] as const)
      await negative(
        `UPDATE extension_record SET ${column}=? WHERE scope_id='source' AND key=?`,
        [value, saved.recordKey],
        restoreRecord,
      );
    await negative('UPDATE execution SET dispatched=0 WHERE id=?', [saved.toolId], () =>
      db.run('UPDATE execution SET dispatched=1 WHERE id=?', [saved.toolId]),
    );
    await negative("UPDATE execution SET state='outcome_unknown' WHERE id=?", [saved.jobId], () =>
      db.run("UPDATE execution SET state='succeeded' WHERE id=?", [saved.jobId]),
    );
    await negative(
      'UPDATE run SET config_json=? WHERE id=?',
      [
        JSON.stringify({ tools: [{ id: 'git.worktree', version: '1', extensionId: 'other' }] }),
        saved.runId,
      ],
      () =>
        db.run('UPDATE run SET config_json=? WHERE id=?', [
          JSON.stringify({
            tools: [{ id: 'git.worktree', version: '1', extensionId: 'builtin.shell' }],
            extensions: [{ id: 'builtin.shell', version: '1' }],
          }),
          saved.runId,
        ]),
    );
    await negative("UPDATE command SET subject_id='other' WHERE id='create-source'", [], () =>
      db.run("UPDATE command SET subject_id='owner' WHERE id='create-source'"),
    );
    await negative("UPDATE session SET delete_requested=1 WHERE id='source'", [], () =>
      db.run("UPDATE session SET delete_requested=0 WHERE id='source'"),
    );
    await negative(
      "UPDATE session SET parent_id='another-source',root_id='another-source' WHERE id='source'",
      [],
      () => db.run("UPDATE session SET parent_id=NULL,root_id='source' WHERE id='source'"),
    );
    await negative(
      "UPDATE workspace SET metadata_json=? WHERE id='source-w'",
      [JSON.stringify({ removal: { commandId: 'removed' } })],
      () => db.run("UPDATE workspace SET metadata_json='{}' WHERE id='source-w'"),
    );
    await negative(
      "UPDATE workspace SET root_uri=? WHERE id='source-w'",
      [pathToFileURL(join(sourcePath, 'different')).href],
      () =>
        db.run("UPDATE workspace SET root_uri=? WHERE id='source-w'", [
          pathToFileURL(sourcePath).href,
        ]),
    );
    await negative(
      "UPDATE workspace SET root_uri='https://example.invalid/linked' WHERE id='target-w'",
      [],
      () =>
        db.run("UPDATE workspace SET root_uri=? WHERE id='target-w'", [
          pathToFileURL(targetPath).href,
        ]),
    );
    // Original Tool resume changes its generation; the settled Job retains the original one.
    db.run('UPDATE execution SET owner_generation=owner_generation+1 WHERE id=?', [saved.toolId]);
    expect((await read()).items[0]!.worktreeSource).toEqual(source);
    const recoveredCold = await openSqliteStore({ ...options, mode: 'readonly' });
    try {
      expect(
        (
          await recoveredCold.listSessionDirectory({
            expectedStoreId: storeId,
            subjectId: 'owner',
            workspaceId: 'target-w',
          })
        ).items[0]!.worktreeSource,
      ).toEqual(source);
    } finally {
      await recoveredCold.close();
    }
    await negative('UPDATE execution SET parent_execution_id=NULL WHERE id=?', [saved.jobId], () =>
      db.run('UPDATE execution SET parent_execution_id=? WHERE id=?', [saved.toolId, saved.jobId]),
    );
    await negative("UPDATE execution SET adapter_id='fixture/job' WHERE id=?", [saved.jobId], () =>
      db.run("UPDATE execution SET adapter_id='shell.command' WHERE id=?", [saved.jobId]),
    );
    await seed('source', 'same-relation');
    expect((await read()).items[0]!.worktreeSource).toEqual(source);
    await seed('foreign-source', 'foreign-relation');
    expect((await read()).items[0]!.worktreeSource).toEqual(source);
    const implicit = await seed('source', 'implicit', true);
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'implicit-w',
      name: 'implicit',
      rootUri: pathToFileURL(implicit.createdPath).href,
    });
    await store.createSession({
      expectedStoreId: storeId,
      commandId: 'create-implicit-target',
      sessionId: 'implicit-target',
      workspaceId: 'implicit-w',
      title: 'implicit target',
      subjectId: 'owner',
    });
    expect(
      (
        await store.listSessionDirectory({
          expectedStoreId: storeId,
          subjectId: 'owner',
          workspaceId: 'implicit-w',
        })
      ).items[0]!.worktreeSource,
    ).toEqual(source);
    const ambiguous = await seed('another-source', 'ambiguous');
    expect((await read()).items[0]!.worktreeSource).toBeUndefined();
    db.run('DELETE FROM extension_record WHERE scope_id=? AND key=?', [
      ambiguous.sessionId,
      ambiguous.recordKey,
    ]);
    const profile = { dataRoot: root, name: 'test', accessKey: 'worktree-source-directory' };
    service = await startService({
      runtime,
      profile,
      buildId: 'worktree-source-directory',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
    });
    await client.connect();
    const before = await store.getMetadata();
    const publicItems = await client.listAllSessionDirectory();
    expect(publicItems.find((item) => item.session.id === 'target')!.worktreeSource).toEqual(
      source,
    );
    expect(
      publicItems.find((item) => item.session.id === 'source')!.worktreeSource,
    ).toBeUndefined();
    expect(
      publicItems.find((item) => item.session.id === 'source')!.activity!.hasCreatedWorktree,
    ).toBe(true);
    expect(JSON.stringify(publicItems)).not.toMatch(
      /original success|operationToken|sourceCwd|worker\.js|PRIVATE_/,
    );
    const cold = await openSqliteStore({ ...options, mode: 'readonly' });
    try {
      expect(
        (
          await cold.listSessionDirectory({
            expectedStoreId: storeId,
            subjectId: 'owner',
            workspaceId: 'target-w',
          })
        ).items.every((item) => JSON.stringify(item.worktreeSource) === JSON.stringify(source)),
      ).toBe(true);
    } finally {
      await cold.close();
    }
    expect(await store.getMetadata()).toEqual(before);
    expect(models).toBe(0);
  } finally {
    client?.disposeNetwork();
    await service?.close();
    db.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
