import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
    const initialSnapshotDirectories = pool.liveSnapshotDirectories();
    expect(initialSnapshotDirectories).toHaveLength(1);
    const parentSnapshotDirectory = initialSnapshotDirectories[0]!;
    expect(existsSync(parentSnapshotDirectory)).toBe(true);
    expect(first.records).toHaveLength(512);
    expect(first.nextCursor).toBe(512);
    expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    const queuedPages = await Promise.all(
      Array.from({ length: 80 }, () => pool!.loadSessionPage({ sessionId: 'parent' })),
    );
    expect(queuedPages).toHaveLength(80);
    expect(queuedPages.every((page) => page.snapshotDigest === first.snapshotDigest)).toBe(true);
    expect(pool.liveChildPids().length).toBeLessThanOrEqual(2);
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
    database
      .query('UPDATE runtime_sessions SET name = ?, updated_at = ? WHERE session_id = ?')
      .run('renamed parent', 9, 'parent');
    const second = await pool.loadSessionPage({
      sessionId: 'parent',
      throughSequence: first.session.lastSequence,
      afterSequence: first.nextCursor,
      snapshotDigest: first.snapshotDigest,
    });
    expect(second.records).toHaveLength(8);
    expect(second.nextCursor).toBeUndefined();
    expect(second.session).toMatchObject({ displayName: 'renamed parent', updatedAt: 9 });
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    for (const afterSequence of [500, 510]) {
      let cursor = afterSequence;
      const seen: number[] = [];
      for (;;) {
        const arbitrary = await pool.loadSessionPage({
          sessionId: 'parent',
          throughSequence: first.session.lastSequence,
          afterSequence: cursor,
          snapshotDigest: first.snapshotDigest,
        });
        seen.push(...arbitrary.records.map((record) => record.sequence));
        expect(arbitrary.session).toMatchObject({ displayName: 'renamed parent', updatedAt: 9 });
        expect(arbitrary.snapshotDigest).toBe(first.snapshotDigest);
        if (arbitrary.nextCursor === undefined) break;
        expect(arbitrary.nextCursor).toBeGreaterThan(cursor);
        cursor = arbitrary.nextCursor;
      }
      expect(seen).toEqual(
        Array.from({ length: 520 - afterSequence }, (_, index) => afterSequence + index + 1),
      );
    }
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
    database
      .query('UPDATE runtime_events SET event_json = ? WHERE session_id = ? AND sequence = 1')
      .run(
        JSON.stringify({
          type: 'user.message_appended',
          messageId: 'parent-1',
          content: 'rewritten inside pinned prefix',
        }),
        'parent',
      );
    await expect(
      pool.loadSessionPage({
        sessionId: 'parent',
        throughSequence: first.session.lastSequence,
        afterSequence: first.nextCursor,
        snapshotDigest: first.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: 'history_snapshot_changed' });
    const rewritten = await pool.loadSessionPage({ sessionId: 'parent' });
    expect(rewritten.snapshotDigest).not.toBe(first.snapshotDigest);
    database
      .query('DELETE FROM runtime_events WHERE session_id = ? AND sequence = ?')
      .run('parent', 2);
    await expect(
      pool.loadSessionPage({
        sessionId: 'parent',
        throughSequence: rewritten.session.lastSequence,
        afterSequence: rewritten.nextCursor,
        snapshotDigest: rewritten.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: 'history_snapshot_changed' });
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
    insertSession.run(
      'new-parent',
      `sha256:${'b'.repeat(64)}`,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      'new parent',
      null,
    );
    database
      .query('UPDATE runtime_sessions SET parent_session_id = ? WHERE session_id = ?')
      .run('new-parent', 'child');
    await expect(
      pool.loadSessionPage({
        sessionId: 'child',
        parentSessionId: 'parent',
        throughSequence: revised.session.lastSequence,
        afterSequence: revised.nextCursor,
        snapshotDigest: revised.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    const reparented = await pool.loadSessionPage({
      sessionId: 'child',
      parentSessionId: 'new-parent',
    });
    expect(reparented).toMatchObject({
      type: 'history_session_page',
      session: { sessionId: 'child' },
    });
    expect(reparented.records[0]).toMatchObject({ sequence: 1 });
    const activeController = new AbortController();
    const cancelledActive = pool.loadSessionPage(
      { sessionId: 'parent' },
      { signal: activeController.signal },
    );
    const survivingQueued = pool.loadSessionPage({ sessionId: 'parent' });
    activeController.abort();
    await expect(cancelledActive).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    await expect(survivingQueued).resolves.toMatchObject({ type: 'history_session_page' });
    expect(existsSync(parentSnapshotDirectory)).toBe(false);
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
    await expect(pool.loadSessionPage({ sessionId: 'oversized' })).resolves.toMatchObject({
      type: 'history_session_page',
      records: [expect.objectContaining({ sequence: 1 })],
    });
    await expect(pool.loadSessionPage({ sessionId: 'parent' })).resolves.toMatchObject({
      type: 'history_session_page',
    });
    const closing = pool.close();
    const directoriesAtClose = pool.liveSnapshotDirectories();
    expect(pool.close()).toBe(closing);
    await closing;
    expect(pool.liveChildPids()).toHaveLength(0);
    expect(pool.liveSnapshotDirectories()).toHaveLength(0);
    for (const directory of directoriesAtClose) expect(existsSync(directory)).toBe(false);
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
