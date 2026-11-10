import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createTrajectorySource } from '../../src/trajectory';

test('real source reaches generated HTTP/Client with fixed global upper, empty filtered pages and no business I/O', async () => {
  const root = temporaryDirectory('kite-trajectory-service-');
  chmodSync(root, 0o700);
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  const model = createFixedModel([]);
  const runtime = createRuntime({
    store,
    model,
    permissions: {
      async authorize() {
        throw Error('unexpected_permission_io');
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: root, name: 'test', accessKey: 'fixture' },
    buildId: 'trajectory',
    subjectId: 'actor',
    trajectory: createTrajectorySource(store),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['trajectory'],
    },
  });
  const db = new Database(join(root, 'test', 'core.db'));
  const counts = () =>
    ['command', 'run', 'execution', 'change_event'].map((table) =>
      db.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    );
  try {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'PRIVATE_NAME',
      rootUri: 'file:///PRIVATE_PATH',
    });
    for (const sessionId of ['s', 'other', 'foreign'])
      await store.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: 'PRIVATE_TITLE',
        subjectId: sessionId === 'foreign' ? 'foreign-actor' : 'actor',
      });
    for (let i = 0; i < 210; i++)
      await store.acceptCommand({
        expectedStoreId: storeId,
        commandId: `c-${i}`,
        sessionId: i < 200 ? 'other' : 's',
        subjectId: 'actor',
        request: { kind: 'run.start', content: 'PRIVATE_BODY' },
      });
    await client.connect();
    const scope = { storeId, sessionId: 's', eventKinds: ['command' as const] };
    const snapshot = await client.openTrajectory(scope);
    const before = counts(),
      metadata = await store.getMetadata();
    const first = await client.readTrajectoryEvents({
      ...scope,
      afterCursor: '0',
      upperCursor: snapshot.upperCursor,
      limit: 10,
    });
    expect(first.events).toHaveLength(0);
    expect(first.exhausted).toBe(false);
    expect(BigInt(first.scannedThrough)).toBeGreaterThan(0n);
    const all = [...first.events];
    let after = first.scannedThrough;
    for (;;) {
      const page = await client.readTrajectoryEvents({
        ...scope,
        afterCursor: after,
        upperCursor: snapshot.upperCursor,
      });
      all.push(...page.events);
      if (page.exhausted) {
        expect(page.scannedThrough).toBe(snapshot.upperCursor);
        break;
      }
      expect(BigInt(page.scannedThrough)).toBeGreaterThan(BigInt(after));
      after = page.scannedThrough;
    }
    expect(
      all.filter(
        (event) => event.kind === 'command' && event.attributes.commandId.startsWith('c-'),
      ),
    ).toHaveLength(10);
    expect(JSON.stringify(all)).not.toContain('PRIVATE_');
    expect(counts()).toEqual(before);
    expect(await store.getMetadata()).toEqual(metadata);
    expect(model.requests).toHaveLength(0);
    await store.acceptCommand({
      expectedStoreId: storeId,
      commandId: 'later',
      sessionId: 's',
      subjectId: 'actor',
      request: { kind: 'run.start', content: 'later' },
    });
    const old = await client.readTrajectoryEvents({
      ...scope,
      afterCursor: snapshot.upperCursor,
      upperCursor: snapshot.upperCursor,
    });
    expect(old.events).toEqual([]);
    expect(old.exhausted).toBe(true);
    expect((await client.openTrajectory(scope)).upperCursor).not.toBe(snapshot.upperCursor);
    await expect(client.openTrajectory({ storeId, sessionId: 'foreign' })).rejects.toMatchObject({
      code: 'trajectory_scope_denied',
      status: 403,
    });
    const request = (body: unknown, token = service.bootstrap.token) =>
      fetch(`${service.endpoint}/v1/sessions/s/trajectory/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await request({ ...scope, subjectId: 'foreign-actor' })).status).toBe(400);
    expect((await request({ ...scope, sessionId: 'other' })).status).toBe(400);
    expect((await request(scope, 'wrong')).status).toBe(401);
    const valid = await request(scope);
    expect(valid.headers.get('cache-control')).toBe('no-store');
    expect(valid.headers.get('x-content-type-options')).toBe('nosniff');
    await valid.body?.cancel();
    const abort = new AbortController();
    abort.abort();
    await expect(
      client.readTrajectoryEvents(
        { ...scope, afterCursor: '0', upperCursor: snapshot.upperCursor },
        { signal: abort.signal },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(model.requests).toHaveLength(0);
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
