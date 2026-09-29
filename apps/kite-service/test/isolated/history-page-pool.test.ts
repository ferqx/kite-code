import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteHistoryPagePool } from '../../src/runtime-client/history-page-pool';

test('bounded child-process pages retain root and child scope and detect same-sequence rewrite', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-worker-'));
  const databasePath = join(home, 'kite-session.sqlite');
  const database = openKiteSessionStoreDatabase(databasePath);
  let pool: ReturnType<typeof createKiteHistoryPagePool> | undefined;
  try {
    database.run('PRAGMA foreign_keys=ON');
    database
      .query(`INSERT INTO workspaces (
      workspace_id, canonical_path, workspace_identity_digest, project_id,
      workspace_digest, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`)
      .run(
        'history-workspace',
        '/history-workspace',
        `sha256:${'a'.repeat(64)}`,
        'history-project',
        `sha256:${'b'.repeat(64)}`,
        'History workspace',
      );
    const insertSession = database.query(`INSERT INTO runtime_sessions (
      session_id, workspace_id, project_id, workspace_digest, state_schema,
      format_epoch, revision, name, updated_at, run_index_from_revision, parent_session_id
    ) VALUES (?, 'history-workspace', 'history-project', ?, ?, 'history-fixture', 0, ?, 1, 0, ?)`);
    const insertEvent = database.query(`INSERT INTO runtime_events (
      session_id, event_id, sequence, schema_version, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [sessionId, parentId] of [
      ['parent', null],
      ['child', 'parent'],
    ] as const) {
      insertSession.run(
        sessionId,
        `sha256:${'b'.repeat(64)}`,
        SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        sessionId,
        parentId,
      );
      for (let sequence = 1; sequence <= 520; sequence++) {
        insertEvent.run(
          sessionId,
          `${sessionId}-${sequence}`,
          sequence,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          JSON.stringify({
            type: 'user.message_appended',
            messageId: `${sessionId}-${sequence}`,
            content: `message ${sequence}`,
          }),
          sequence,
        );
      }
    }
    pool = createKiteHistoryPagePool({
      databasePath,
      entrypointPath:
        process.env.KITE_HISTORY_TEST_ENTRYPOINT ??
        resolve(import.meta.dir, '../../src/executable.ts'),
      ...(process.env.KITE_HISTORY_TEST_COMPILED === '1' ? { standaloneEntrypoint: true } : {}),
    });
    const first = await pool.loadSessionPage({ sessionId: 'parent' });
    expect(first.records).toHaveLength(512);
    expect(first.nextCursor).toBe(512);
    expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    const complete = await pool.loadSessionFull({ sessionId: 'parent' });
    expect(complete.records).toHaveLength(520);
    expect(complete.events).toHaveLength(520);
    await expect(pool.searchSessions({ limit: 1, query: 'message 1' })).resolves.toMatchObject({
      entries: [{ sessionId: 'parent' }],
      hasMore: false,
    });
    await expect(pool.searchSessions({ limit: 1, query: 'child' })).resolves.toMatchObject({
      entries: [],
      hasMore: false,
    });
    insertSession.run(
      'second',
      `sha256:${'b'.repeat(64)}`,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      'second',
      null,
    );
    database.query('UPDATE runtime_sessions SET updated_at = 0 WHERE session_id = ?').run('second');
    insertEvent.run(
      'second',
      'second-1',
      1,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      JSON.stringify({
        type: 'user.message_appended',
        messageId: 'second-1',
        content: 'message 1',
      }),
      1,
    );
    const searchFirst = await pool.searchSessions({ limit: 1, query: 'message 1' });
    expect(searchFirst).toMatchObject({
      entries: [{ sessionId: 'parent' }],
      hasMore: true,
      nextCursor: { updatedAt: 1, sessionId: 'parent' },
    });
    await expect(
      pool.searchSessions({ limit: 1, query: 'message 1', cursor: searchFirst.nextCursor }),
    ).resolves.toMatchObject({ entries: [{ sessionId: 'second' }], hasMore: false });
    const second = await pool.loadSessionPage({
      sessionId: 'parent',
      throughSequence: first.session.lastSequence,
      afterSequence: first.nextCursor,
      snapshotDigest: first.snapshotDigest,
    });
    expect(second.records).toHaveLength(8);
    expect(second.nextCursor).toBeUndefined();
    insertEvent.run(
      'parent',
      'parent-521',
      521,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      JSON.stringify({
        type: 'user.message_appended',
        messageId: 'parent-521',
        content: 'appended after first-page watermark',
      }),
      521,
    );
    const appendedContinuation = await pool.loadSessionPage({
      sessionId: 'parent',
      throughSequence: first.session.lastSequence,
      afterSequence: first.nextCursor,
      snapshotDigest: first.snapshotDigest,
    });
    expect(appendedContinuation.records).toEqual(second.records);
    expect(appendedContinuation.snapshotDigest).toBe(first.snapshotDigest);
    expect((await pool.loadSessionPage({ sessionId: 'parent' })).session.lastSequence).toBe(521);
    await expect(pool.loadSessionPage({ sessionId: 'child' })).rejects.toMatchObject({
      code: 'session_not_found',
    });
    await expect(
      pool.loadSessionPage({ sessionId: 'child', parentSessionId: 'wrong' }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    const child = await pool.loadSessionPage({ sessionId: 'child', parentSessionId: 'parent' });
    expect(child.records).toHaveLength(512);
    await expect(
      pool.loadSessionFull({ sessionId: 'child', parentSessionId: 'parent' }),
    ).resolves.toMatchObject({ session: { sessionId: 'child' } });
    database
      .query('UPDATE runtime_events SET event_json = ? WHERE session_id = ? AND sequence = 1')
      .run(
        JSON.stringify({ type: 'user.message_appended', messageId: 'child-1', content: 'revised' }),
        'child',
      );
    const revised = await pool.loadSessionPage({ sessionId: 'child', parentSessionId: 'parent' });
    expect(revised.snapshotDigest).not.toBe(child.snapshotDigest);
    const activeController = new AbortController();
    const cancelledActive = pool.loadSessionPage(
      { sessionId: 'parent' },
      { signal: activeController.signal },
    );
    const survivingQueued = pool.loadSessionPage({ sessionId: 'parent' });
    activeController.abort();
    await expect(cancelledActive).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    await expect(survivingQueued).resolves.toMatchObject({ type: 'history_session_page' });
    const queuedController = new AbortController();
    const independent = pool.loadSessionPage({ sessionId: 'parent' });
    const cancelledQueued = pool.loadSessionPage(
      { sessionId: 'parent' },
      { signal: queuedController.signal },
    );
    queuedController.abort();
    await expect(cancelledQueued).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    await expect(independent).resolves.toMatchObject({ type: 'history_session_page' });
    let maxLiveChildren = 0;
    const sample = () => {
      maxLiveChildren = Math.max(maxLiveChildren, pool!.liveChildPids().length);
    };
    const monitor = setInterval(sample, 1);
    try {
      for (let index = 0; index < 20; index++) {
        const controller = new AbortController();
        const cancelled = pool.loadSessionPage(
          { sessionId: 'parent' },
          { signal: controller.signal },
        );
        const survivor = pool.loadSessionPage({ sessionId: 'parent' });
        controller.abort();
        sample();
        await expect(cancelled).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        await expect(survivor).resolves.toMatchObject({ type: 'history_session_page' });
        sample();
      }
    } finally {
      clearInterval(monitor);
    }
    expect(maxLiveChildren).toBeLessThanOrEqual(2);
    insertSession.run(
      'wide',
      `sha256:${'b'.repeat(64)}`,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      'wide',
      null,
    );
    for (let sequence = 1; sequence <= 200; sequence++) {
      insertEvent.run(
        'wide',
        `wide-${sequence}`,
        sequence,
        SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        JSON.stringify({
          type: 'user.message_appended',
          messageId: `wide-${sequence}`,
          content: 'w'.repeat(6_000),
        }),
        sequence,
      );
    }
    await expect(pool.loadSessionFull({ sessionId: 'wide' })).rejects.toMatchObject({
      code: 'history_too_large',
    });
    await expect(pool.loadSessionPage({ sessionId: 'wide' })).resolves.toMatchObject({
      type: 'history_session_page',
      nextCursor: expect.any(Number),
    });
    insertSession.run(
      'oversized',
      `sha256:${'b'.repeat(64)}`,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      'oversized',
      null,
    );
    insertEvent.run(
      'oversized',
      'oversized-1',
      1,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      JSON.stringify({
        type: 'user.message_appended',
        messageId: 'oversized-1',
        content: 'x'.repeat(33 * 1024 * 1024),
      }),
      1,
    );
    await expect(pool.loadSessionPage({ sessionId: 'oversized' })).rejects.toMatchObject({
      code: 'history_too_large',
    });
    await expect(pool.loadSessionPage({ sessionId: 'parent' })).resolves.toMatchObject({
      type: 'history_session_page',
    });
    const closing = pool.close();
    expect(pool.close()).toBe(closing);
    await closing;
    expect(pool.liveChildPids()).toHaveLength(0);
    await expect(pool.loadSessionPage({ sessionId: 'parent' })).rejects.toMatchObject({
      code: 'session_unavailable',
    });
  } finally {
    await pool?.close();
    database.close(false);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('failed child spawn settles and closes without waiting for an exit event', async () => {
  const pool = createKiteHistoryPagePool({
    databasePath: '/nonexistent/history.sqlite',
    entrypointPath: '/nonexistent/kite-history-child',
    standaloneEntrypoint: true,
  });
  try {
    await expect(pool.loadSessionPage({ sessionId: 'missing' })).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    });
  } finally {
    await pool.close();
  }
  expect(pool.liveChildPids()).toHaveLength(0);
}, 5_000);
