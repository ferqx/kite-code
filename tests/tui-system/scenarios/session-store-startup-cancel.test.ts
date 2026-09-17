import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KITE_SESSION_STORE_TABLE_COLUMNS } from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import {
  assertKiteSessionStore11Schema,
  KITE_SESSION_STORE11_DDL,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

/** Business rows come from a real TUI; only the exact known historical layout is materialized. */
function materializeStore11(home: string): string {
  const canonical = join(home, '.kite-code/kite-session.sqlite');
  const historical = join(
    home,
    '.kite-code/source-profiles',
    '1'.repeat(32),
    'kite-session.sqlite',
  );
  mkdirSync(dirname(historical), { recursive: true, mode: 0o700 });
  chmodSync(join(home, '.kite-code/source-profiles'), 0o700);
  chmodSync(dirname(historical), 0o700);
  const source = new Database(canonical, { readonly: true });
  const target = new Database(historical, { strict: true });
  chmodSync(historical, 0o600);
  try {
    for (const ddl of KITE_SESSION_STORE11_DDL) target.run(ddl);
    target.run(
      "INSERT INTO kite_meta VALUES ('schema_version','11'), ('format_epoch','kite-session-accepted-runs-2026-09-15')",
    );
    target.run('PRAGMA user_version=11');
    for (const [table, columns] of Object.entries(KITE_SESSION_STORE_TABLE_COLUMNS)) {
      if (table === 'kite_meta') continue;
      const insert = target.query(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of source
        .query<Record<string, string | number | Uint8Array | null>, []>(
          `SELECT ${columns.join(',')} FROM ${table}`,
        )
        .iterate())
        insert.run(...columns.map((column) => row[column]!));
    }
    for (const row of source
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM kite_meta WHERE key NOT IN ('schema_version','format_epoch')",
      )
      .iterate())
      target.query('INSERT INTO kite_meta VALUES (?,?)').run(row.key, row.value);
  } finally {
    source.close();
    target.close(false);
  }
  const db = new Database(historical, { strict: true });
  try {
    db.run('PRAGMA journal_mode=DELETE');
    db.run('CREATE TABLE startup_cancel_padding(bytes BLOB NOT NULL)');
    const insert = db.query('INSERT INTO startup_cancel_padding(bytes) VALUES (zeroblob(?))');
    for (let index = 0; index < 8; index++) insert.run(64 * 1024 * 1024);
    db.run('DROP TABLE startup_cancel_padding');
    assertKiteSessionStore11Schema(db);
    expect(
      db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
    ).toBe('ok');
  } finally {
    db.close(false);
  }
  expect(statSync(historical).size).toBeGreaterThanOrEqual(512 * 1024 * 1024);
  for (const path of [canonical, `${canonical}-wal`, `${canonical}-shm`])
    rmSync(path, { force: true });
  return historical;
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(process.platform !== 'darwin')(
  'TUI PTY System — startup Store preparation cancellation',
  () => {
    test('Ctrl+C in pre-Ink preparation settles safely and the original Session reopens', async () => {
      const workspace = createTestWorkspace();
      const server = createMockModelServer();
      const tuis: Array<PtyProcess | undefined> = [];
      try {
        server.setResponses([
          { message: { content: 'Historical answer survives startup cancellation.' } },
        ]);
        const first = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
        tuis.push(first);
        await submitUserMessage(first, server, 'Question before startup cancellation');
        await waitForText(
          () => first.outputSinceLastAction(),
          'Historical answer survives startup cancellation.',
          15_000,
        );
        let originalId: string | undefined;
        await waitForCondition(
          () => {
            const observed = observePersistedUserMessageSession(
              workspace,
              'Question before startup cancellation',
            );
            if (observed.status !== 'ready' || !observed.value) return false;
            originalId = observed.value.threadId;
            return true;
          },
          'original user event persisted',
          10_000,
        );
        if (!originalId) throw new Error('Original Session ID was not persisted.');
        const sessionId = originalId;
        await submitCommand(first, '/exit');
        expect(await first.waitForExit()).toBe(0);

        const sourcePath = materializeStore11(workspace.home);
        const sourceDigest = digest(sourcePath);
        const canonical = join(workspace.home, '.kite-code/kite-session.sqlite');
        const intent = join(workspace.home, '.kite-code/kite-session-publication.json');
        const preparing = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
        tuis.push(preparing);
        await waitForCondition(
          () => /正在备份、整理并核对会话数据|正在提交并复核会话数据/u.test(preparing.transcript()),
          'production TUI startup preparation progress',
          60_000,
        );
        // Pre-Ink PTY remains in canonical mode: the terminal sends SIGINT to the
        // TUI parent, whose owned-transport listener requests Service cancellation.
        preparing.write('\x03');
        await waitForCondition(
          () => preparing.exited,
          'TUI parent to exit after startup Ctrl+C',
          120_000,
        );
        const preparationExit = await preparing.waitForExit();
        expect([0, 1]).toContain(preparationExit);
        expect(existsSync(intent)).toBe(false);
        if (existsSync(sourcePath)) {
          expect(digest(sourcePath)).toBe(sourceDigest);
          expect(existsSync(canonical)).toBe(false);
        } else {
          const db = new Database(canonical, { readonly: true });
          try {
            expect(
              db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
            ).toBe(10);
            expect(
              db.query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions').all(),
            ).toEqual([{ session_id: sessionId }]);
          } finally {
            db.close();
          }
        }

        server.setResponses([]);
        const restarted = await spawnReadyTui({
          cols: 120,
          rows: 40,
          mockServer: server,
          workspace,
        });
        tuis.push(restarted);
        await submitCommand(restarted, '/resume');
        await waitForCondition(
          () =>
            screenHasSessionRow(restarted.viewport(), 'Question before startup cancellation', {
              active: false,
            }),
          'historical Session row after interrupted startup',
          15_000,
        );
        restarted.write('\x1b[B');
        await waitForCondition(
          () =>
            screenHasSessionRow(restarted.viewport(), 'Question before startup cancellation', {
              selected: true,
              active: false,
            }),
          'historical Session selection',
          5_000,
        );
        restarted.write('\r');
        await waitForCondition(
          () =>
            screenContains(
              restarted.viewport(),
              'Historical answer survives startup cancellation.',
            ) && screenContains(restarted.viewport(), 'Question before startup cancellation'),
          'original conversation replay',
          15_000,
        );
        const db = new Database(canonical, { readonly: true });
        try {
          expect(
            db.query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions').all(),
          ).toContainEqual({ session_id: sessionId });
        } finally {
          db.close();
        }
      } finally {
        await cleanupTuiSystemFixtures({ tuis, mockServers: [server], workspaces: [workspace] });
      }
    }, 180_000);
  },
);
