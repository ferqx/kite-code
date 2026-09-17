// Isolated client E2E for exact supported Store 9 and Store 11 conversion subsets.
// A current production App Server writes the original State/Event/Run/Artifact fixture.
// The fixture is then materialized in one older exact table layout with the historical
// authority writer (Store 9) or exact Store 11 DDL; no user Store or live model is touched.
// Test-only Service admission proves this fixture path, not production launcher admission.
// bun run tests/qualification/session-store-converted-client.ts

import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trustWorkspace } from '../../apps/kite-service/src/config/workspace-trust';
import {
  BunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '../../packages/kite-local-runtime/src/client';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
} from '../../packages/kite-local-runtime/src/client/protocol-connection';
import {
  createKiteHomeWorkspaceAuthority,
  createKiteHomeWriteTransactionPort,
  initializeKiteHomeStoreSchema,
  KITE_HOME_STORE_TABLE_COLUMNS,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from '../../packages/runtime-storage-sqlite/src';
import { KITE_SESSION_STORE11_DDL } from '../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { createMockModelServer } from '../tui-system/harness/fixtures';

const home = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-converted-client-')),
);
const config = join(home, '.kite-code');
const workspace = join(home, 'workspace');
mkdirSync(config, { mode: 0o700 });
mkdirSync(workspace);
const model = createMockModelServer();
model.setResponses([
  { message: { content: 'initial nine answer' } },
  { message: { content: 'continued nine answer' } },
  { message: { content: 'initial eleven answer' } },
  { message: { content: 'continued eleven answer' } },
]);
writeFileSync(
  join(config, 'kite-code.jsonc'),
  JSON.stringify({
    provider: {
      test: {
        type: 'openai-compatible',
        apiKey: 'fixture-only',
        baseURL: model.baseURL,
        model: 'mock-model',
        models: ['mock-model'],
      },
    },
    model: { default: { provider: 'test', name: 'mock-model' } },
    interactionMode: 'auto',
    sandbox: { enabled: false },
    mcpServers: {},
  }),
  { mode: 0o600 },
);
assert.equal(
  trustWorkspace({ workspace, source: 'test', storePath: join(config, 'workspace-trust.jsonc') })
    .status,
  'recorded',
);

async function open(label: string) {
  const transport = new BunStdioChildRuntimeClientTransport({
    argv: [
      process.execPath,
      join(import.meta.dir, 'fixtures/isolated-store-service.ts'),
      'app-server',
      'run-stdio',
    ],
    cwd: join(import.meta.dir, '../..'),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'production',
      KITE_CODE_HOME: config,
      KITE_CODE_CONFIG_HOME: config,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: label,
      KITE_QUALIFICATION_HOME: home,
    },
  });
  const connection = createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion(label),
    { name: 'converted-client-qualification', version: '1', instanceId: label },
    KITE_APP_SERVER_PROTOCOL_METHODS_,
  );
  await connection.prepareAppControl();
  return connection;
}
type Connection = Awaited<ReturnType<typeof open>>;
async function ids(connection: Connection): Promise<string[]> {
  const result = await connection.history.listSessions({ limit: 100 });
  return result.entries.map((entry) => entry.sessionId).sort();
}
async function turn(connection: Connection, sessionId: string, commandId: string, input: string) {
  const before = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  assert.equal(before.status, 'ok');
  assert.ok(before.session);
  const result = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'start_turn',
    sessionId,
    expectedRevision: before.session.revision,
    input,
    phase: 'building',
  });
  assert.equal(result.status, 'applied');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const projection = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (projection.status === 'ok' && projection.session?.currentRun?.status === 'completed')
      return;
    await Bun.sleep(50);
  }
  throw new Error('Mock turn did not complete.');
}
function transcript(connection: Connection, sessionId: string) {
  return connection.history.loadSession(sessionId);
}

const tableOrder = [
  'workspaces',
  'runtime_sessions',
  'runtime_events',
  'runtime_snapshots',
  'runtime_named_snapshots',
  'runtime_file_preimages',
  'runtime_command_receipts',
  'runtime_runs',
  'runtime_session_tombstones',
  'model_artifacts',
  'plan_artifacts',
  'capability_artifacts',
  'filesystem_preimage_artifacts',
  'sandbox_preparation_artifacts',
  'subagent_task_artifacts',
  'subagent_lifecycle_artifacts',
  'subagent_continuation_artifacts',
  'runtime_effect_leases',
] as const;
function copyBusiness(source: Database, target: Database, legacy9: boolean) {
  const mapping = legacy9 ? KITE_HOME_STORE_TABLE_COLUMNS : KITE_SESSION_STORE_TABLE_COLUMNS;
  for (const table of tableOrder) {
    const columns = mapping[table];
    const rows = source
      .query<Record<string, string | number | Uint8Array | null>, []>(
        `SELECT ${columns.join(',')} FROM ${table}`,
      )
      .all();
    const insert = target.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    );
    for (const row of rows) insert.run(...columns.map((column) => row[column]!));
  }
}
function downgrade(version: 9 | 11) {
  const canonical = join(config, 'kite-session.sqlite');
  const source = new Database(canonical, { readonly: true });
  const targetPath =
    version === 9
      ? join(config, 'kite.sqlite')
      : join(config, 'source-profiles', '1'.repeat(32), 'kite-session.sqlite');
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const target = new Database(targetPath, { strict: true });
  chmodSync(targetPath, 0o600);
  try {
    if (version === 9) initializeKiteHomeStoreSchema(target);
    else {
      for (const sql of KITE_SESSION_STORE11_DDL) target.run(sql);
      target.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
      target
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run('format_epoch', 'kite-session-accepted-runs-2026-09-15');
      target.run('PRAGMA user_version=11');
    }
    copyBusiness(source, target, version === 9);
    for (const row of source
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM kite_meta WHERE key NOT IN ('schema_version','format_epoch')",
      )
      .iterate()) {
      if (version === 9 && row.key.startsWith('session_execution/')) continue;
      target.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(row.key, row.value);
    }
    if (version === 9) {
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
          resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString(
            'base64url',
          ),
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
  } finally {
    source.close();
    target.close(false);
  }
  rmSync(canonical, { force: true });
  rmSync(`${canonical}-wal`, { force: true });
  rmSync(`${canonical}-shm`, { force: true });
}

try {
  for (const version of [9, 11] as const) {
    const sessionId = `original-${version}`;
    let connection = await open(`create-${version}`);
    try {
      const created = await connection.runtime.command({
        schema: 'kite.runtime-command.v1',
        commandId: `create-${version}`,
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
      });
      assert.equal(created.status, 'applied');
      await turn(connection, sessionId, `initial-${version}`, `initial ${version}`);
      assert.ok((await ids(connection)).includes(sessionId));
    } finally {
      await connection.close();
    }
    downgrade(version);
    connection = await open(`convert-${version}`);
    try {
      assert.ok((await ids(connection)).includes(sessionId));
      const history = await transcript(connection, sessionId);
      assert.ok(history.events.some((event) => event.type === 'model.responded'));
      await turn(connection, sessionId, `continue-${version}`, `continue ${version}`);
    } finally {
      await connection.close();
    }
    connection = await open(`restart-${version}`);
    try {
      assert.ok((await ids(connection)).includes(sessionId));
      const history = await transcript(connection, sessionId);
      assert.equal(history.events.filter((event) => event.type === 'model.responded').length, 2);
    } finally {
      await connection.close();
    }
    console.log(JSON.stringify({ schema: version, status: 'client-reopened-and-continued' }));
    rmSync(join(config, 'kite-session.sqlite'), { force: true });
    rmSync(join(config, 'kite-session.sqlite-wal'), { force: true });
    rmSync(join(config, 'kite-session.sqlite-shm'), { force: true });
    rmSync(join(config, 'session-store-recovery'), { recursive: true, force: true });
  }
  model.assertComplete();
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
