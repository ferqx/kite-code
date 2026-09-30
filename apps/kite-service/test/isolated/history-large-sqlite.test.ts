import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteHistoryPagePool } from '../../src/runtime-client/history-page-pool';

test('real SQLite History reuses fixed pages beyond former quotas while every continuation has a tail append', async () => {
  const started = performance.now();
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-large-'));
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
        'large-workspace',
        '/large-workspace',
        `sha256:${'a'.repeat(64)}`,
        'large-project',
        `sha256:${'b'.repeat(64)}`,
        'Large workspace',
      );
    database
      .query(`INSERT INTO runtime_sessions (
        session_id, workspace_id, project_id, workspace_digest, state_schema,
        format_epoch, revision, name, updated_at, run_index_from_revision, parent_session_id
      ) VALUES ('large', 'large-workspace', 'large-project', ?, ?, 'history-fixture', 0,
        'large', 1, 0, NULL)`)
      .run(`sha256:${'b'.repeat(64)}`, SQLITE_RUNTIME_STATE_SCHEMA_VERSION);
    const count = 50_001;
    const content = 'h'.repeat(900);
    const insert = database.query(`INSERT INTO runtime_events (
      session_id, event_id, sequence, schema_version, event_json, created_at
    ) VALUES ('large', ?, ?, ?, ?, ?)`);
    let sourceBytes = 0;
    database.run('BEGIN');
    for (let sequence = 1; sequence <= count; sequence++) {
      const event = JSON.stringify({
        type: 'user.message_appended',
        messageId: `large-${sequence}`,
        content,
      });
      sourceBytes += Buffer.byteLength(event, 'utf8');
      insert.run(
        `large-${sequence}`,
        sequence,
        SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        event,
        sequence,
      );
    }
    database.run('COMMIT');
    expect(sourceBytes).toBeGreaterThan(40 * 1024 * 1024);

    pool = createKiteHistoryPagePool({
      databasePath,
      entrypointPath:
        process.env.KITE_HISTORY_TEST_ENTRYPOINT ??
        resolve(import.meta.dir, '../../src/executable.ts'),
      ...(process.env.KITE_HISTORY_TEST_COMPILED === '1' ? { standaloneEntrypoint: true } : {}),
    });
    let afterSequence: number | undefined;
    let throughSequence: number | undefined;
    let snapshotDigest: string | undefined;
    let total = 0;
    let pages = 0;
    const readStarted = performance.now();
    let firstPageMs = 0;
    let snapshotDirectory = '';
    let retainedFiles: string[] = [];
    for (;;) {
      if (afterSequence !== undefined) {
        const sequence = count + pages;
        insert.run(
          `append-${sequence}`,
          sequence,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          JSON.stringify({
            type: 'user.message_appended',
            messageId: `append-${sequence}`,
            content: 'live-tail',
          }),
          sequence,
        );
      }
      const page = await pool.loadSessionPage({
        sessionId: 'large',
        ...(throughSequence === undefined ? {} : { throughSequence }),
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(snapshotDigest === undefined ? {} : { snapshotDigest }),
      });
      throughSequence ??= page.session.lastSequence;
      snapshotDigest ??= page.snapshotDigest;
      expect(page.snapshotDigest).toBe(snapshotDigest);
      expect(page.records[0]?.sequence).toBe((afterSequence ?? 0) + 1);
      total += page.records.length;
      pages++;
      if (pages === 1) {
        firstPageMs = performance.now() - readStarted;
        snapshotDirectory = pool.liveSnapshotDirectories()[0]!;
        retainedFiles = readdirSync(snapshotDirectory);
        expect(retainedFiles).toHaveLength(1);
      }
      if (page.nextCursor === undefined) break;
      afterSequence = page.nextCursor;
    }
    expect(total).toBe(count);
    expect(pages).toBe(98);
    expect(
      database
        .query<{ history_rewrite_generation: number }, []>(
          'SELECT history_rewrite_generation FROM runtime_sessions',
        )
        .get()?.history_rewrite_generation,
    ).toBe(0);
    const paginationMs = performance.now() - readStarted;
    const continuationMs = paginationMs - firstPageMs;
    // Every continuation must reuse the same disk projection. The relative
    // timing guard catches the old 97 repeated full scans without a whole-run SLO.
    expect(readdirSync(snapshotDirectory)).toEqual(retainedFiles);
    expect(continuationMs).toBeLessThan(Math.max(1_000, firstPageMs * 3));
    console.log(
      JSON.stringify({
        fixtureMs: readStarted - started,
        pages,
        firstPageMs,
        continuationMs,
        paginationMs,
      }),
    );
  } finally {
    await pool?.close();
    database.close(false);
    rmSync(home, { recursive: true, force: true });
  }
}, 180_000);
