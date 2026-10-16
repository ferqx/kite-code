import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { verifyDesktopScheduleRows } from '../../../src/maintenance/desktop-schedules';
import { excluded, parseManifest } from '../../../src/maintenance/manifest';

const capturedAt = '2026-10-15T00:00:00.000Z',
  hash = 'a'.repeat(64);
function manifest() {
  const assets: Record<string, unknown> = {
    vaultExcluded: true,
    configurationMayContainSensitiveContent: true,
  };
  for (const [key, path, format] of [
    ['configuration', 'config.jsonc', false],
    ['skillWorkflowConfiguration', 'skill-workflow.jsonc', false],
    ['desktopUi', 'desktop-private/data.sqlite', true],
    ['tuiUi', 'ui/tui.json', true],
    ['tuiPreferences', 'ui/preferences.jsonc', false],
    ['tuiRecovery', 'ui/recovery.json', true],
    ['callerIntents', 'ui/caller-intents.json', true],
    ['fileRecoveryIntents', 'ui/file-recovery-intents.json', true],
    ['mcpSelectionIntents', 'ui/mcp-selection-intents.json', true],
    ['mcpConnectionIntents', 'ui/mcp-connection-intents.json', true],
    ['mcpSourceApprovalIntents', 'ui/mcp-source-approval-intents.json', true],
    ['mcpReconnectionIntents', 'ui/mcp-reconnection-intents.json', true],
    ['mcpSourceMutationIntents', 'ui/mcp-source-mutation-intents.json', true],
    ['mcpConfiguration', 'mcp.json', false],
    ['mcpApprovals', 'mcp-approvals.json', false],
    ['mcpAuthBindings', 'mcp-auth-bindings.json', false],
  ] as const)
    assets[key] = {
      path,
      capturedAt,
      present: false,
      proof: null,
      ...(format ? { format: null } : {}),
    };
  assets.desktopUi = {
    path: 'desktop-private/data.sqlite',
    capturedAt,
    present: true,
    proof: { sha256: hash, byteLength: '1' },
    format: { applicationId: 1263888689, userVersion: 10 },
  };
  return {
    version: 19,
    kind: 'profile_backup',
    createdAt: capturedAt,
    source: {
      storeId: 'store',
      formatMajor: 1,
      snapshotCursor: '0',
      profileAccessKey: hash,
      migrationChecksum: hash,
    },
    engine: { version: 'sqlite', sourceId: 'source' },
    database: { path: 'core.db', sha256: hash, byteLength: '1' },
    media: {
      inventory: 'media.jsonl',
      sha256: hash,
      byteLength: '0',
      blobCount: '0',
      referenceCount: '0',
    },
    assets,
    consistency: 'sqlite_snapshot_with_verified_media_and_separate_assets',
    excluded: [...excluded],
  };
}
test('closed manifest19 requires real DB10; earlier manifests cannot relabel schedule metadata', () => {
  const value = manifest();
  expect(parseManifest(value).version).toBe(19);
  for (const version of [2, 7, 14, 15, 16, 17, 18])
    expect(() => parseManifest({ ...value, version })).toThrow('backup_invalid_manifest');
  for (const userVersion of [7, 8, 9, 11]) {
    const changed = structuredClone(value);
    (changed.assets.desktopUi as { format: { userVersion: number } }).format.userVersion =
      userVersion;
    expect(() => parseManifest(changed)).toThrow('backup_invalid_manifest');
  }
  const absent = structuredClone(value);
  absent.assets.desktopUi = {
    path: 'desktop-private/data.sqlite',
    capturedAt,
    present: false,
    proof: null,
    format: null,
  };
  expect(() => parseManifest(absent)).toThrow('backup_invalid_manifest');
  const extra = structuredClone(value);
  extra.assets.unlisted = {};
  expect(() => parseManifest(extra)).toThrow('backup_invalid_manifest');
});

function scheduleTask(storeId = 'original-store') {
  return {
    id: 'daily',
    name: 'Daily review',
    prompt: 'Original é🙂 task',
    workspaceId: 'workspace',
    modelId: 'provider/model',
    storeId,
    schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
    enabled: true,
    nextRunAt: 86400000,
    createdAt: 0,
    updatedAt: 0,
  };
}
function scheduleRun() {
  return {
    id: 'original-run',
    taskId: 'daily',
    task: scheduleTask(),
    occurrenceAt: 86400000,
    sessionId: 'session',
    createCommandId: 'create-command',
    startCommandId: 'start-command',
    status: 'unknown',
    createdAt: 86400000,
    updatedAt: 86400000,
  };
}
function scheduleRows(work: (db: Database) => void) {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
    db.run(
      'CREATE TABLE scheduled_task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,occurrence_at INTEGER NOT NULL,state TEXT NOT NULL)',
    );
    db.query('INSERT INTO scheduled_tasks VALUES(?,?)').run(
      'daily',
      JSON.stringify(scheduleTask()),
    );
    db.query('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)').run(
      'original-run',
      'daily',
      86400000,
      JSON.stringify(scheduleRun()),
    );
    work(db);
  } finally {
    db.close(true);
  }
}

test('DB10 maintenance preserves unknown and unverified terminal metadata without inventing settlement', () => {
  scheduleRows((db) => {
    const original = db.query('SELECT * FROM scheduled_task_runs').all();
    expect(() => verifyDesktopScheduleRows(db)).not.toThrow();
    expect(db.query('SELECT * FROM scheduled_task_runs').all()).toEqual(original);
    for (const status of ['completed', 'failed', 'cancelled']) {
      const run = { ...scheduleRun(), status };
      db.query('UPDATE scheduled_task_runs SET state=?').run(JSON.stringify(run));
      expect(() => verifyDesktopScheduleRows(db)).not.toThrow();
      expect(db.query('SELECT state FROM scheduled_task_runs').get()).toEqual({
        state: JSON.stringify(run),
      });
      db.query('UPDATE scheduled_task_runs SET state=?').run(
        JSON.stringify({ ...run, settlementVersion: 1 }),
      );
      expect(() => verifyDesktopScheduleRows(db)).not.toThrow();
    }
  });
});

test('DB10 maintenance rejects coercible enum arrays, unknown fields and invalid settlement markers', () => {
  for (const frequency of [['daily'], ['weekly'], 'future'])
    scheduleRows((db) => {
      const task = {
        ...scheduleTask(),
        schedule: { ...scheduleTask().schedule, frequency, weekday: 1 },
      };
      db.query('UPDATE scheduled_tasks SET state=?').run(JSON.stringify(task));
      expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
    });
  for (const patch of [
    { status: ['unknown'] },
    { status: ['completed'], settlementVersion: 1 },
    { status: 'future' },
    { settlementVersion: 1 },
    { status: 'completed', settlementVersion: 2 },
    { future: true },
    { task: { ...scheduleTask(), future: true } },
    { task: { ...scheduleTask(), schedule: { ...scheduleTask().schedule, timeZone: '+01:00' } } },
  ])
    scheduleRows((db) => {
      db.query('UPDATE scheduled_task_runs SET state=?').run(
        JSON.stringify({ ...scheduleRun(), ...patch }),
      );
      expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
    });
});

test('DB10 maintenance checks SQL bindings, complete UTF8 and one active run per original Store', () => {
  for (const sql of [
    "UPDATE scheduled_tasks SET id='different'",
    "UPDATE scheduled_task_runs SET task_id='different'",
    'UPDATE scheduled_task_runs SET occurrence_at=1',
    "UPDATE scheduled_task_runs SET state=CAST(X'80' AS TEXT)",
    'DELETE FROM scheduled_tasks',
  ])
    scheduleRows((db) => {
      db.run(sql);
      expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
    });
  for (const storeId of ['original-store', 'new-store'])
    scheduleRows((db) => {
      const other = { ...scheduleRun(), id: 'other-run', task: scheduleTask(storeId) };
      db.query('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)').run(
        other.id,
        other.taskId,
        other.occurrenceAt,
        JSON.stringify(other),
      );
      db.query('UPDATE scheduled_tasks SET state=?').run(JSON.stringify(scheduleTask(storeId)));
      if (storeId === 'original-store')
        expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
      else expect(() => verifyDesktopScheduleRows(db)).not.toThrow();
    });
});
