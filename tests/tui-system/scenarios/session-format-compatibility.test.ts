import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_STATE26_FORMAT_EPOCH, LEGACY_STATE26_SCHEMA_VERSION } from '@kite-ai/agent-kernel';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import { SQLITE_RUNTIME_DDL, sqliteRuntimeStorePath } from '@kite-ai/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedSessionIds,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const SESSION_ID = 'legacy-session-1';
const SESSION_NAME = 'Original compatible session';
const MESSAGE = 'State 26 message remains visible';
const SECOND_SESSION_ID = 'legacy-session-2';
const SECOND_SESSION_NAME = 'Second compatible session';
const SECOND_MESSAGE = 'Second State 26 message remains visible';
const THIRD_SESSION_ID = 'legacy-session-3';
const THIRD_SESSION_NAME = 'Third compatible session';
const THIRD_MESSAGE = 'Third State 26 message remains visible';
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

function insertState26Session(
  database: Database,
  input: {
    sessionId: string;
    name: string;
    message: string;
    ordinal: number;
    workspace: string;
    projectId: string;
    workspaceDigest: string;
  },
): void {
  const messageId = `legacy-message-${input.ordinal}`;
  const eventId = `legacy-event-${input.ordinal}`;
  const turnId = `legacy-turn-${input.ordinal}`;
  const event = {
    type: 'user.message_appended',
    messageId,
    content: input.message,
  };
  const stateJson = JSON.stringify({
    schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
    formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    revision: 1,
    appliedEventIds: [eventId],
    session: {
      threadId: input.sessionId,
      userId: 'tui',
      workspace: input.workspace,
      projectId: input.projectId,
      canonicalWorkspaceDigest: input.workspaceDigest,
    },
    turn: { turnId, turnIndex: 1, status: 'completed' },
    transcript: {
      messages: [
        {
          messageId,
          turnId,
          ordinal: 0,
          createdAt: '2026-08-25T00:00:00.000Z',
          kind: 'user',
          content: input.message,
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
  database.run(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      input.sessionId,
      input.projectId,
      input.workspaceDigest,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      1,
      input.name,
      4 - input.ordinal,
    ],
  );
  database.run(
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      input.sessionId,
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
      input.sessionId,
      eventId,
      1,
      LEGACY_STATE26_SCHEMA_VERSION,
      JSON.stringify(event),
      '2026-08-25T00:00:00.000Z',
      1,
    ],
  );
}

function seedState26Session(checkpointPath: string, workspace: string): string {
  const sourcePath = sqliteRuntimeStorePath(checkpointPath);
  const seedPath = `${sourcePath}.seed`;
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
  const database = new Database(seedPath);
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
  insertState26Session(database, {
    sessionId: SECOND_SESSION_ID,
    name: SECOND_SESSION_NAME,
    message: SECOND_MESSAGE,
    ordinal: 2,
    workspace,
    projectId: identity.projectId,
    workspaceDigest: identity.workspaceDigest,
  });
  insertState26Session(database, {
    sessionId: THIRD_SESSION_ID,
    name: THIRD_SESSION_NAME,
    message: THIRD_MESSAGE,
    ordinal: 3,
    workspace,
    projectId: identity.projectId,
    workspaceDigest: identity.workspaceDigest,
  });
  // Reproduce a normal post-checkpoint SQLite source with both sidecars. A
  // read-only connection may still update SHM, so production must inspect
  // this shape only through its isolated snapshot view.
  database.run('PRAGMA journal_mode = WAL');
  database.run("UPDATE runtime_sessions SET updated_at = 2 WHERE session_id = 'legacy-session-1'");
  database.run('PRAGMA wal_checkpoint(TRUNCATE)');
  expect(existsSync(`${seedPath}-wal`)).toBe(true);
  expect(existsSync(`${seedPath}-shm`)).toBe(true);
  copyFileSync(seedPath, sourcePath);
  copyFileSync(`${seedPath}-wal`, `${sourcePath}-wal`);
  copyFileSync(`${seedPath}-shm`, `${sourcePath}-shm`);
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

describe('TUI PTY System — State 26 legacy Service source isolation', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let checkpointPath: string;
  let sourcePath: string;
  let sourceFingerprint: readonly { readonly hex: string; readonly mtimeMs: number }[];

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    checkpointPath = join(workspace.home, '.kite-code', 'checkpoints.sqlite');
    // The source is deliberately bound to this Workspace. The default Coordinator/Worker path
    // must still ignore it: Store 5 compatibility belongs only to explicit legacy Service mode.
    const historicalWorkspace = workspace.workspace;
    sourcePath = seedState26Session(checkpointPath, historicalWorkspace);
    sourceFingerprint = [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`].map((path) => ({
      hex: readFileSync(path).toString('hex'),
      mtimeMs: statSync(path).mtimeMs,
    }));
    server.setResponses([]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step('keeps legacy Store 5 sessions outside the default Worker selector', async () => {
    await submitCommand(tui, '/resume');
    const output = await waitForText(() => tui.viewport(), '会话列表', 10_000);
    expect(screenContains(output, SESSION_NAME)).toBe(false);
    expect(screenContains(output, SECOND_SESSION_NAME)).toBe(false);
    expect(screenContains(output, THIRD_SESSION_NAME)).toBe(false);
    expect(screenContains(output, '迁移')).toBe(false);
    expect(screenContains(output, '兼容')).toBe(false);
    expect(screenContains(output, '服务不可用')).toBe(false);
    expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(1);
    for (const [index, path] of [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`].entries()) {
      const expected = sourceFingerprint[index];
      if (!expected) throw new Error(`Missing source fingerprint for ${path}.`);
      expect(readFileSync(path).toString('hex')).toBe(expected.hex);
      expect(statSync(path).mtimeMs).toBe(expected.mtimeMs);
    }
    tui.write('\x1b');
    await waitForCondition(
      () => !screenContains(tui.viewport(), '会话列表') && screenContains(tui.viewport(), '❯'),
      'the current Session input to regain focus after closing the selector',
      5_000,
    );
  });

  step('continues the fresh Store 8 session without importing the source', async () => {
    server.setResponses([{ message: { content: 'Fresh Store 8 session remains usable.' } }]);
    await submitUserMessage(tui, server, 'Continue without legacy import', { timeout: 15_000 });
    const output = await waitForText(
      () => tui.viewport(),
      'Fresh Store 8 session remains usable.',
      15_000,
    );
    expect(screenContains(output, 'Continue without legacy import')).toBe(true);
    expect(screenContains(output, MESSAGE)).toBe(false);
    expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(1);
  });

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});

describe('TUI PTY System — malformed legacy Service source isolation', () => {
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

  step('does not expose the malformed source to the default Worker', async () => {
    await submitCommand(tui, '/resume');
    const output = await waitForText(() => tui.viewport(), '会话列表', 10_000);
    expect(screenContains(output, MALFORMED_SESSION_NAME)).toBe(false);
    expect(screenContains(output, '历史会话打开失败')).toBe(false);
    expect(readFileSync(sourcePath).toString('hex')).toBe(sourceHex);
    expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(1);
    tui.write('\x1b');
    await waitForCondition(
      () => !screenContains(tui.viewport(), '会话列表') && screenContains(tui.viewport(), '❯'),
      'the current Session input to regain focus after closing the selector',
      5_000,
    );
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
