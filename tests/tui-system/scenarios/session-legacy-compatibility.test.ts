import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_STATE26_FORMAT_EPOCH, LEGACY_STATE26_SCHEMA_VERSION } from '@kite/agent-kernel';
import { resolveProjectIdentity } from '@kite/runtime-host';
import {
  SQLITE_RUNTIME_DDL,
  sqliteCurrentRuntimeStorePath,
  sqliteRuntimeStorePath,
} from '@kite/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const SESSION_ID = 'legacy-session-1';
const SESSION_NAME = 'Original compatible session';
const MESSAGE = 'State 26 message remains visible';
const MALFORMED_SESSION_ID = 'malformed-legacy-session';
const MALFORMED_SESSION_NAME = 'Broken compatible session';

function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function seedState26Session(checkpointPath: string, workspace: string): string {
  const sourcePath = sqliteRuntimeStorePath(checkpointPath);
  const identity = resolveProjectIdentity(workspace);
  const event = {
    type: 'user.message_appended',
    messageId: 'legacy-message-1',
    content: MESSAGE,
  };
  const stateJson = JSON.stringify({
    schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
    formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    revision: 1,
    appliedEventIds: ['legacy-event-1'],
    session: {
      threadId: SESSION_ID,
      userId: 'tui',
      workspace,
      projectId: identity.projectId,
      canonicalWorkspaceDigest: identity.workspaceDigest,
    },
    turn: { turnId: 'legacy-turn-1', turnIndex: 1, status: 'completed' },
    transcript: {
      messages: [
        {
          messageId: 'legacy-message-1',
          turnId: 'legacy-turn-1',
          ordinal: 0,
          createdAt: '2026-08-25T00:00:00.000Z',
          kind: 'user',
          content: MESSAGE,
        },
      ],
    },
    context: {
      history: [],
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    toolRecovery: {
      schemaVersion: 1,
      identityKey: 'e'.repeat(64),
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: false, observedFailures: 0 },
    },
    mode: 'accept_edits',
    workspaceAccess: 'write',
    tasks: {},
  });
  const database = new Database(sourcePath);
  for (const ddl of SQLITE_RUNTIME_DDL) database.run(ddl);
  database.run(
    "INSERT INTO runtime_store_meta (key, value) VALUES ('format_version', '5'), ('runtime_format_epoch', ?)",
    [LEGACY_STATE26_FORMAT_EPOCH],
  );
  database.run(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      SESSION_ID,
      identity.projectId,
      identity.workspaceDigest,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      1,
      SESSION_NAME,
      1,
    ],
  );
  database.run(
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      SESSION_ID,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      1,
      stateJson,
      1,
      checksum(stateJson),
      1,
    ],
  );
  database.run(
    'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      SESSION_ID,
      'legacy-event-1',
      1,
      LEGACY_STATE26_SCHEMA_VERSION,
      JSON.stringify(event),
      '2026-08-25T00:00:00.000Z',
      1,
    ],
  );
  database.close();
  return sourcePath;
}

function seedMalformedState26Session(checkpointPath: string, workspace: string): string {
  const sourcePath = sqliteRuntimeStorePath(checkpointPath);
  const identity = resolveProjectIdentity(workspace);
  const stateJson = '{}';
  const database = new Database(sourcePath);
  for (const ddl of SQLITE_RUNTIME_DDL) database.run(ddl);
  database.run(
    "INSERT INTO runtime_store_meta (key, value) VALUES ('format_version', '5'), ('runtime_format_epoch', ?)",
    [LEGACY_STATE26_FORMAT_EPOCH],
  );
  database.run(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      MALFORMED_SESSION_ID,
      identity.projectId,
      identity.workspaceDigest,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      0,
      MALFORMED_SESSION_NAME,
      1,
    ],
  );
  database.run(
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      MALFORMED_SESSION_ID,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      0,
      stateJson,
      0,
      checksum(stateJson),
      1,
    ],
  );
  database.close();
  return sourcePath;
}

function currentStoreHasLegacySession(checkpointPath: string): boolean {
  const database = new Database(sqliteCurrentRuntimeStorePath(checkpointPath), { readonly: true });
  try {
    return Boolean(
      database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE session_id = ?',
        )
        .get(SESSION_ID)?.count,
    );
  } finally {
    database.close();
  }
}

describe('TUI PTY System — State 26 Session Compatibility', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let checkpointPath: string;
  let sourcePath: string;
  let sourceHex: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    checkpointPath = join(workspace.home, '.kite-code', 'checkpoints.sqlite');
    sourcePath = seedState26Session(checkpointPath, workspace.workspace);
    sourceHex = readFileSync(sourcePath).toString('hex');
    server.setResponses([]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step('lists the known old session without compatibility or migration messaging', async () => {
    await submitCommand(tui, '/resume');
    const output = await waitForText(() => tui.viewport(), SESSION_NAME, 10_000);
    expect(screenContains(output, SESSION_NAME)).toBe(true);
    expect(screenContains(output, '迁移')).toBe(false);
    expect(screenContains(output, '兼容')).toBe(false);
    expect(screenContains(output, '服务不可用')).toBe(false);
  });

  step('imports only after Enter and restores the original message silently', async () => {
    expect(existsSync(sqliteCurrentRuntimeStorePath(checkpointPath))).toBe(true);
    expect(currentStoreHasLegacySession(checkpointPath)).toBe(false);
    tui.write('\r');
    const output = await waitForText(() => tui.viewport(), MESSAGE, 15_000);
    expect(screenContains(output, MESSAGE)).toBe(true);
    expect(screenContains(output, '历史会话打开失败')).toBe(false);
    expect(currentStoreHasLegacySession(checkpointPath)).toBe(true);
    expect(readFileSync(sourcePath).toString('hex')).toBe(sourceHex);
  });

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

describe('TUI PTY System — malformed compatible session isolation', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sourcePath: string;
  let sourceHex: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    sourcePath = seedMalformedState26Session(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
      workspace.workspace,
    );
    sourceHex = readFileSync(sourcePath).toString('hex');
    server.setResponses([{ message: { content: 'Fresh session remains usable.' } }]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step('fails only the selected malformed session with a generic message', async () => {
    await submitCommand(tui, '/resume');
    await waitForText(() => tui.viewport(), MALFORMED_SESSION_NAME, 10_000);
    tui.write('\r');
    const output = await waitForText(() => tui.viewport(), '历史会话打开失败', 15_000);
    expect(screenContains(output, '当前会话未受影响')).toBe(true);
    expect(screenContains(output, '历史会话服务不可用')).toBe(false);
    expect(screenContains(output, '❯')).toBe(true);
    expect(readFileSync(sourcePath).toString('hex')).toBe(sourceHex);
  });

  step('continues the fresh session after the isolated failure', async () => {
    await submitUserMessage(tui, server, 'Continue after broken history', { timeout: 15_000 });
    const output = await waitForText(() => tui.viewport(), 'Fresh session remains usable.', 15_000);
    expect(screenContains(output, 'Continue after broken history')).toBe(true);
    expect(screenContains(output, 'Fresh session remains usable.')).toBe(true);
  });

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
