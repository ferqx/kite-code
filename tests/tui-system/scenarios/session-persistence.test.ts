/**
 * PTY System Test — Session Persistence (跨进程恢复)
 *
 * Verifies that after the TUI exits and restarts on the same workspace,
 * previous sessions and their data can be recovered from the SQLite
 * checkpoint database.
 *
 * Core scenario:
 * 1. Start TUI instance 1, send a message, get model response
 * 2. Exit TUI (graceful shutdown via /exit)
 * 3. Start TUI instance 2 on the same workspace (shared checkpoint DB)
 * 4. Open /resume — verify previous session appears in the list
 * 5. Load the historical session — verify messages are replayed correctly
 * 6. Type and submit a follow-up prompt in the restored session
 *
 * IMPORTANT: Both TUI instances share the same isolated HOME and workspace,
 * so they resolve the same production Runtime Store path.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createKiteHomeWorkspaceAuthority,
  createKiteHomeWriteTransactionPort,
} from '../../../packages/runtime-storage-sqlite/src';
import {
  assertKiteHomeStoreSchema,
  initializeKiteHomeStoreSchema,
  KITE_HOME_STORE_TABLE_COLUMNS,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import {
  assertKiteSessionStore11Schema,
  KITE_SESSION_STORE11_DDL,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe.each([
  10, 9, 11,
] as const)('TUI PTY System - Session Persistence from Store %i', (sourceSchema) => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui1: PtyProcess;
  let tui2: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let persistedThreadId: string | undefined;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([{ message: { content: 'Hello from session!' }, delay: 50 }]);

    tui1 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui1, tui2],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 1 — Message
  // ═══════════════════════════════════════════════════════════

  step(
    'send message in tui1 → model responds, checkpoint written',
    async () => {
      await submitUserMessage(tui1, server, 'Message before restart', { timeout: 15000 });

      // Wait for the mock model response to appear in the TUI
      await waitForText(() => tui1.outputSinceLastAction(), 'Hello from session!', 15000);

      const output = tui1.viewport();
      expect(screenContains(output, 'Message before restart')).toBe(true);
      expect(screenContains(output, 'Hello from session!')).toBe(true);
      // Prompt should still be visible
      expect(screenContains(output, '❯')).toBe(true);

      await waitForCondition(
        () => {
          const observation = observePersistedUserMessageSession(
            workspace,
            'Message before restart',
          );
          if (observation.status !== 'ready' || !observation.value) return false;
          persistedThreadId = observation.value.threadId;
          return true;
        },
        'exact user.message_appended event to be durable before exit',
        10_000,
      );
      expect(persistedThreadId).toBeTruthy();
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // Exit tui1 + Restart tui2 on same workspace
  // ═══════════════════════════════════════════════════════════

  step(
    'exit tui1, restart tui2 on same workspace → prompt visible',
    async () => {
      // Graceful exit via /exit command
      await submitCommand(tui1, '/exit');

      // Wait for tui1 process to exit (handleExit calls process.exit(0) after 300ms)
      const exitCode = await tui1.waitForExit();
      console.log(`  tui1 exit code: ${exitCode}`);
      expect(exitCode).toBe(0);
      if (sourceSchema !== 10) materializeHistoricalStore(workspace.home, sourceSchema);

      // Restart and session selection do not call the model.
      server.setResponses([]);

      // Spawn tui2 on the SAME workspace — shares checkpoint DB
      tui2 = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

      // Wait for TUI to finish rendering
      // Enable raw mode for tui2

      const output = tui2.viewport();
      const clean = stripAnsi(output);
      console.log('  tui2 startup output:', clean.slice(-300));
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ═══════════════════════════════════════════════════════════
  // TUI Instance 2 — Verify session persistence
  // ═══════════════════════════════════════════════════════════

  step(
    'open /resume → previous session appears in session list',
    async () => {
      // Open SessionSelector
      await submitCommand(tui2, '/resume');

      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenHasSessionRow(viewport, 'Message before restart', { active: false }) &&
            screenContains(viewport, '会话列表') &&
            screenContains(viewport, '搜索') &&
            screenContains(viewport, '导航') &&
            !screenContains(viewport, 'Loading...')
          );
        },
        'fresh current row plus persisted session row and selector chrome to render',
        10_000,
      );

      const output = tui2.viewport();
      const clean = stripAnsi(output);
      console.log('  tui2 output after /resume:', clean.slice(-500));

      // Verify panel UI elements are visible
      expect(screenContains(output, '会话列表')).toBe(true);
      expect(screenContains(output, '搜索')).toBe(true);
      expect(screenContains(output, '导航')).toBe(true);

      // The session from tui1 should appear in the list.
      // Session name defaults to threadId; after smart naming, it becomes
      // the first user message text (truncated to 30 chars).
      expect(screenHasSessionRow(output, 'Message before restart', { active: false })).toBe(true);
      const persisted = observePersistedUserMessageSession(workspace, 'Message before restart');
      expect(persisted.status).toBe('ready');
      expect(persisted.status === 'ready' ? persisted.value?.threadId : undefined).toBe(
        persistedThreadId,
      );
    },
    TIMEOUT,
  );

  step(
    'load historical session → message content restored from checkpoint DB',
    async () => {
      // Runtime Server V1 creates a fresh current row before listing history.
      // Move from that row to the persisted historical row before loading it.
      console.log('  pressing Enter to load historical session...');
      tui2.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(tui2.viewport(), 'Message before restart', {
            selected: true,
            active: false,
          }),
        'persisted historical session row to become selected',
        5_000,
      );
      tui2.write('\r');

      // Wait for the historical session content to be replayed.
      // Both the user message and model response should be restored.
      await waitForCondition(
        () => {
          const viewport = tui2.viewport();
          return (
            screenContains(viewport, 'Message before restart') &&
            screenContains(viewport, 'Hello from session!') &&
            screenContains(viewport, '❯')
          );
        },
        'historical user and assistant messages to finish replaying in the viewport',
        15000,
      );

      const output = tui2.viewport();
      console.log('  tui2 output after loading session:', stripAnsi(output).slice(-500));

      // Verify historical user message is visible (replayed from DB)
      expect(screenContains(output, 'Message before restart')).toBe(true);
      // Verify historical model response is visible (replayed from DB)
      expect(screenContains(output, 'Hello from session!')).toBe(true);
      // TUI must remain responsive with prompt visible
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  step(
    'restored session accepts and submits a follow-up prompt',
    async () => {
      server.setResponses([
        { message: { content: 'Follow-up after restart received.' }, delay: 50 },
      ]);

      await submitUserMessage(tui2, server, 'Message after restart', { timeout: 15000 });
      await waitForText(
        () => tui2.outputSinceLastAction(),
        'Follow-up after restart received.',
        15000,
      );

      const output = tui2.viewport();
      expect(screenContains(output, 'Message after restart')).toBe(true);
      expect(screenContains(output, 'Follow-up after restart received.')).toBe(true);
      await waitForCondition(
        () => {
          const saved = observePersistedUserMessageSession(workspace, 'Message after restart');
          return saved.status === 'ready' && saved.value?.threadId === persistedThreadId;
        },
        'follow-up remains in the exact pre-upgrade Session',
        10_000,
      );
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

/** Exact supported layout fixture; all business rows were written by the first real TUI. */
function materializeHistoricalStore(home: string, version: 9 | 11): void {
  const canonical = join(home, '.kite-code/kite-session.sqlite');
  const historical =
    version === 9
      ? join(home, '.kite-code/kite.sqlite')
      : join(home, '.kite-code/source-profiles', '1'.repeat(32), 'kite-session.sqlite');
  mkdirSync(dirname(historical), { recursive: true, mode: 0o700 });
  if (version === 11) chmodSync(join(home, '.kite-code/source-profiles'), 0o700);
  chmodSync(dirname(historical), 0o700);
  const source = new Database(canonical, { readonly: true });
  const target = new Database(historical, { strict: true });
  chmodSync(historical, 0o600);
  try {
    if (version === 9) initializeKiteHomeStoreSchema(target);
    else {
      for (const ddl of KITE_SESSION_STORE11_DDL) target.run(ddl);
      target.run(
        "INSERT INTO kite_meta VALUES ('schema_version','11'), ('format_epoch','kite-session-accepted-runs-2026-09-15')",
      );
      target.run('PRAGMA user_version=11');
    }
    const tableColumns =
      version === 9 ? KITE_HOME_STORE_TABLE_COLUMNS : KITE_SESSION_STORE_TABLE_COLUMNS;
    for (const [table, columns] of Object.entries(tableColumns)) {
      if (table === 'kite_meta') continue;
      const insert = target.query(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of source
        .query<Record<string, string | number | Uint8Array | null>, []>(
          `SELECT ${columns.join(',')} FROM ${table}`,
        )
        .iterate()) {
        insert.run(...columns.map((column: string) => row[column]!));
      }
    }
    for (const row of source
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM kite_meta WHERE key NOT IN ('schema_version','format_epoch')",
      )
      .iterate()) {
      if (version === 9 && row.key.startsWith('session_execution/')) continue;
      target.query('INSERT INTO kite_meta VALUES (?,?)').run(row.key, row.value);
    }
    if (version === 9) {
      writeReleasedStore9Authority(target);
      assertKiteHomeStoreSchema(target);
    } else assertKiteSessionStore11Schema(target);
    expect(
      target.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
        ?.integrity_check,
    ).toBe('ok');
  } finally {
    source.close();
    target.close(false);
  }
  for (const path of [canonical, `${canonical}-wal`, `${canonical}-shm`])
    rmSync(path, { force: true });
}

/** Use the historical authority writer, never a fabricated settled lease row. */
function writeReleasedStore9Authority(target: Database): void {
  const writer = createKiteHomeWriteTransactionPort(target);
  const workspaceRow = target
    .query<
      {
        workspace_id: string;
        canonical_path: string;
        workspace_identity_digest: string;
        project_id: string;
        workspace_digest: string;
        display_name: string;
      },
      []
    >(
      'SELECT workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name FROM workspaces',
    )
    .get();
  if (!workspaceRow) throw new Error('Workspace fixture is missing.');
  const authority = createKiteHomeWorkspaceAuthority({
    database: target,
    writer,
    workspace: {
      workspaceId: workspaceRow.workspace_id,
      canonicalPath: workspaceRow.canonical_path,
      workspaceIdentityDigest: workspaceRow.workspace_identity_digest,
      projectId: workspaceRow.project_id,
      workspaceDigest: workspaceRow.workspace_digest,
      displayName: workspaceRow.display_name,
    },
    nowMs: () => 10,
  });
  for (const row of target
    .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
    .iterate()) {
    const acquired = authority.controller.requestControl({
      sessionId: row.session_id,
      requestId: `fixture-acquire-${row.session_id}`,
      requestDigest: '1'.repeat(64),
      clientId: 'fixture-client',
      connectionGeneration: 1,
      workerInstanceId: 'fixture-service',
      resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url'),
      resumeExpiresAtMs: 100,
    });
    assert.equal(acquired.status, 'applied');
    assert.ok(acquired.lease);
    const released = authority.controller.releaseControl({
      ...acquired.lease,
      requestId: `fixture-release-${row.session_id}`,
      requestDigest: '2'.repeat(64),
    });
    assert.equal(released.status, 'applied');
  }
}
