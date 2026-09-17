// Controlled-release C08 qualification. Requires two real candidate archives:
// an older schema-10 build without the managed maintenance contract, then current.
// bun run tests/qualification/session-store-incompatible-rollback.ts <old-archive> <current-archive>
// This uses a fresh private HOME and managed prefix; no installed user release is touched.

import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  MANAGED_STORE_MAINTENANCE_MARKER,
  observeLegacyKiteStoreProcesses,
} from '../../packages/kite-local-runtime/src/service';
import { initializeKiteHomeStoreSchema } from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import {
  installOssCandidate,
  readInstallStatus,
  rollbackOssCandidate,
} from '../../scripts/release/install-oss-candidate';
import { verifyOssCandidate } from '../../scripts/release/oss-candidate';
import { createMockModelServer } from '../tui-system/harness/fixtures';

if (process.platform !== 'darwin') throw new Error('Native macOS release qualification only.');
const [oldArchive, currentArchive] = process.argv.slice(2);
if (!oldArchive || !currentArchive)
  throw new Error('Pass old and current real candidate archives.');
const old = await verifyOssCandidate(realpathSync.native(oldArchive));
const current = await verifyOssCandidate(realpathSync.native(currentArchive));
assert.notEqual(old.candidateId, current.candidateId);
assert.equal(old.manifest.storeMaintenanceContract, undefined);
assert.equal(current.manifest.storeMaintenanceContract, 'managed-release-selection-v1');
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-c08-rollback-')));
chmodSync(root, 0o700);
const prefix = join(root, 'managed');
const home = join(root, 'home');
const config = join(home, '.kite-code');
const workspace = join(root, 'workspace');
mkdirSync(config, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
const model = createMockModelServer();
model.setResponses([
  { message: { content: 'old release answer' } },
  { message: { content: 'old release stayed healthy' } },
  { message: { content: 'current release continuation' } },
  { message: { content: 'current release new session answer' } },
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
    argv: [join(prefix, 'bin', 'kite-service'), 'app-server', 'run-stdio'],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'production',
      KITE_CODE_HOME: config,
      KITE_CODE_CONFIG_HOME: config,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: label,
    },
  });
  const connection = createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion(label),
    { name: 'c08-rollback', version: '1', instanceId: label },
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

async function revision(connection: Connection, sessionId: string): Promise<number> {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.session);
  return result.session.revision;
}

async function turn(connection: Connection, commandId: string, sessionId: string, input: string) {
  const result = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'start_turn',
    sessionId,
    expectedRevision: await revision(connection, sessionId),
    input,
    phase: 'building',
  });
  assert.equal(result.status, 'applied', JSON.stringify(result));
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
  throw new Error(`${commandId} did not complete`);
}

async function create(connection: Connection, sessionId: string, commandId: string) {
  const result = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'create_session',
    workspace,
    bootstrapSessionId: sessionId,
  });
  assert.equal(result.status, 'applied');
}

async function transcript(connection: Connection, sessionId: string) {
  const result = await connection.history.loadSession(sessionId);
  return result.events
    .filter((event) => event.type === 'user.message' || event.type === 'model.responded')
    .map((event) => [event.type, event.type === 'user.message' ? event.text : event.summary]);
}

function storeHash(): string {
  const base = join(config, 'kite-session.sqlite');
  const hash = createHash('sha256');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = base + suffix;
    hash.update(suffix);
    hash.update(existsSync(path) ? readFileSync(path) : 'absent');
  }
  return hash.digest('hex');
}

function prepareThroughInstalledCli() {
  return Bun.spawnSync(
    [
      join(prefix, 'bin', 'kite'),
      'run',
      '--task',
      'qualification-only',
      '--execution-status',
      '--trust-workspace',
      '--workspace',
      workspace,
      '--kite-home',
      config,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

try {
  const installedOld = await installOssCandidate({ archivePath: old.archivePath, prefix });
  assert.equal(installedOld.currentCandidateId, old.candidateId);
  let connection = await open(old.candidateId);
  try {
    await create(connection, 'original-session', 'old-create');
    await turn(connection, 'old-turn', 'original-session', 'first question');
    assert.deepEqual(await ids(connection), ['original-session']);
    // A supported legacy source makes the new release actually enter maintenance preparation.
    // The old release's Store 10 already contains N; this empty Store 9 is additional history.
    const historicalPath = join(config, 'kite.sqlite');
    const historical = new Database(historicalPath, { strict: true });
    try {
      initializeKiteHomeStoreSchema(historical);
      historical.run('PRAGMA journal_mode=DELETE');
    } finally {
      historical.close(false);
    }
    chmodSync(historicalPath, 0o600);
    const installedCurrent = await installOssCandidate({
      archivePath: current.archivePath,
      prefix,
    });
    assert.equal(installedCurrent.currentCandidateId, current.candidateId);
    const observed = observeLegacyKiteStoreProcesses({ managedInstallPrefixes: [prefix] });
    assert.equal(observed.status, 'busy', 'The live old Service must be visible before admission.');
    if (observed.status === 'busy')
      assert.ok(observed.matches.some((match) => match.kind === 'service'));
    const beforeRejectedPreparation = storeHash();
    const refused = prepareThroughInstalledCli();
    assert.notEqual(refused.exitCode, 0, 'New CLI admitted migration while old Service was live.');
    assert.equal(readInstallStatus(prefix).currentCandidateId, current.candidateId);
    assert.equal(storeHash(), beforeRejectedPreparation);
    assert.equal(existsSync(historicalPath), true);
    // The failed admission must not terminate or fence the old writer.
    await turn(connection, 'old-still-live', 'original-session', 'old writer still active');
  } finally {
    await connection.close();
  }
  // This installed CLI is the supported parent lineage for Service maintenance admission.
  const prepared = prepareThroughInstalledCli();
  assert.equal(prepared.exitCode, 0, new TextDecoder().decode(prepared.stderr).slice(0, 500));
  const historicalPath = join(config, 'kite.sqlite');
  connection = await open(current.candidateId);
  try {
    assert.deepEqual(await ids(connection), ['original-session']);
    await turn(connection, 'current-continue', 'original-session', 'followup question');
    await create(connection, 'new-session', 'current-create');
    await turn(connection, 'current-new-turn', 'new-session', 'second session question');
    assert.deepEqual(await ids(connection), ['new-session', 'original-session']);
  } finally {
    await connection.close();
  }
  assert.equal(existsSync(join(prefix, MANAGED_STORE_MAINTENANCE_MARKER)), true);
  assert.equal(existsSync(historicalPath), false);
  const beforeRollback = storeHash();
  let rejected = false;
  try {
    rollbackOssCandidate(prefix);
  } catch (error) {
    rejected = true;
    assert.match(String(error), /maintenance-aware candidate/u);
  }
  assert.equal(rejected, true, 'Uncontracted old release must not be selected.');
  assert.equal(readInstallStatus(prefix).currentCandidateId, current.candidateId);
  assert.equal(storeHash(), beforeRollback, 'Rejected rollback changed Store bytes.');

  connection = await open(current.candidateId);
  try {
    assert.deepEqual(await ids(connection), ['new-session', 'original-session']);
    assert.deepEqual(await transcript(connection, 'original-session'), [
      ['user.message', 'first question'],
      ['model.responded', 'old release answer'],
      ['user.message', 'old writer still active'],
      ['model.responded', 'old release stayed healthy'],
      ['user.message', 'followup question'],
      ['model.responded', 'current release continuation'],
    ]);
    assert.deepEqual(await transcript(connection, 'new-session'), [
      ['user.message', 'second session question'],
      ['model.responded', 'current release new session answer'],
    ]);
  } finally {
    await connection.close();
  }
  using db = new Database(join(config, 'kite-session.sqlite'), { readonly: true });
  assert.equal(
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
    10,
  );
  model.assertComplete();
  console.log(
    JSON.stringify({
      status: 'qualified',
      old: old.candidateId,
      current: current.candidateId,
      sessions: 2,
    }),
  );
} finally {
  model.stop();
  rmSync(root, { recursive: true, force: true });
}
