// Reuse an independently prepared, dependency-installed old source tree to verify
// Store compatibility with the current checkout. This fixture never archives code,
// installs dependencies, or accesses the user's configured Kite Home. The caller
// should verify the old source commit separately. Both versions must use the same
// schema version; this does not exercise schema migration.
//
// bun run tests/qualification/session-store-schema10-cross-version.ts <old-source-root> [current-source-root]
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const importFrom = (root: string, relative: string) =>
  import(pathToFileURL(join(root, relative)).href);

const oldRootArgument = process.argv[2];
if (!oldRootArgument)
  throw new Error(
    'Usage: bun run tests/qualification/session-store-schema10-cross-version.ts <old-source-root> [current-source-root]',
  );
const oldRoot = realpathSync.native(resolve(oldRootArgument));
const newRoot = realpathSync.native(resolve(process.argv[3] ?? join(import.meta.dir, '../..')));
assert.notEqual(oldRoot, newRoot, 'old and current sources must be independent');

function checkWorkspaceDependencyPaths(root: string): number {
  let checked = 0;
  for (const parent of [
    root,
    ...['apps', 'packages'].flatMap((directory) =>
      readdirSync(join(root, directory), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, directory, entry.name)),
    ),
  ]) {
    const scope = join(parent, 'node_modules/@kite-ai');
    if (!existsSync(scope)) continue;
    for (const entry of readdirSync(scope)) {
      const dependency = join(scope, entry);
      const target = realpathSync.native(dependency);
      const relativeTarget = relative(root, target);
      assert.ok(
        relativeTarget && relativeTarget.split(/[\\/]/)[0] !== '..' && !isAbsolute(relativeTarget),
        `${dependency} resolves outside ${root}: ${target}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, `no @kite-ai workspace packages found under ${root}`);
  return checked;
}
console.log(`old @kite-ai packages inside old source: ${checkWorkspaceDependencyPaths(oldRoot)}`);
console.log(
  `current @kite-ai packages inside current source: ${checkWorkspaceDependencyPaths(newRoot)}`,
);

const oldFormat = await importFrom(
  oldRoot,
  'packages/runtime-storage-sqlite/src/kite-session-store-format.ts',
);
const currentFormat = await importFrom(
  newRoot,
  'packages/runtime-storage-sqlite/src/kite-session-store-format.ts',
);
assert.equal(oldFormat.KITE_SESSION_STORE_SCHEMA_VERSION, 10);
assert.equal(currentFormat.KITE_SESSION_STORE_SCHEMA_VERSION, 10);
assert.equal(
  oldFormat.KITE_SESSION_STORE_FORMAT_EPOCH,
  currentFormat.KITE_SESSION_STORE_FORMAT_EPOCH,
);

const { createMockModelServer } = await importFrom(newRoot, 'tests/tui-system/harness/fixtures.ts');
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-schema10-roundtrip-')));
const config = join(home, '.kite-code');
const workspace = join(home, 'workspace');
mkdirSync(config, { mode: 0o700 });
mkdirSync(workspace);
const model = createMockModelServer();
model.setResponses([
  { message: { content: 'old version answer' } },
  { message: { content: 'new version continuation' } },
  { message: { content: 'new session answer' } },
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

const oldTrust = await importFrom(oldRoot, 'apps/kite-service/src/config/workspace-trust.ts');
assert.equal(
  oldTrust.trustWorkspace({
    workspace,
    source: 'test',
    storePath: join(config, 'workspace-trust.jsonc'),
  }).status,
  'recorded',
);

async function open(root: string, label: string) {
  const local = await importFrom(root, 'packages/kite-local-runtime/src/client/index.ts');
  const protocol = await importFrom(
    root,
    'packages/kite-local-runtime/src/client/protocol-connection.ts',
  );
  const transport = new local.BunStdioChildRuntimeClientTransport({
    argv: [
      process.execPath,
      join(root, 'scripts/release/entrypoints/service.ts'),
      'app-server',
      'run-stdio',
    ],
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
  const connection = protocol.createAppServerProtocolConnection(
    transport,
    local.kiteAppServerVersion(label),
    { name: 'schema10-roundtrip', version: '1', instanceId: label },
    protocol.KITE_APP_SERVER_PROTOCOL_METHODS_,
  );
  await connection.prepareAppControl();
  return connection;
}

type Connection = Awaited<ReturnType<typeof open>>;
type TranscriptEvent = { type: string; text?: string; summary?: string };

function assertTranscript(transcript: { events: TranscriptEvent[] }, expected: [string, string][]) {
  const actual = transcript.events
    .filter((event) => event.type === 'user.message' || event.type === 'model.responded')
    .map((event) => [event.type, event.type === 'user.message' ? event.text : event.summary]);
  assert.deepEqual(actual, expected);
}

async function ids(connection: Connection): Promise<string[]> {
  const result = await connection.history.listSessions({ limit: 100 });
  return result.entries.map((entry: { sessionId: string }) => entry.sessionId).sort();
}

async function revision(connection: Connection, sessionId: string): Promise<number> {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  assert.equal(result.status, 'ok');
  return result.session.revision;
}

async function turn(connection: Connection, commandId: string, sessionId: string, input: string) {
  const before = await revision(connection, sessionId);
  const result = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'start_turn',
    sessionId,
    expectedRevision: before,
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

try {
  let connection = await open(oldRoot, 'old-47c5e4f1');
  try {
    const created = await connection.runtime.command({
      schema: 'kite.runtime-command.v1',
      commandId: 'old-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: 'original-session',
    });
    assert.equal(created.status, 'applied');
    await turn(connection, 'old-turn', 'original-session', 'first question');
    assert.deepEqual(await ids(connection), ['original-session']);
    console.log('old create and answer: pass');
  } finally {
    await connection.close();
  }

  connection = await open(newRoot, 'new-worktree');
  try {
    assert.deepEqual(await ids(connection), ['original-session']);
    await turn(connection, 'new-continue', 'original-session', 'followup question');
    const created = await connection.runtime.command({
      schema: 'kite.runtime-command.v1',
      commandId: 'new-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: 'new-session',
    });
    assert.equal(created.status, 'applied');
    await turn(connection, 'new-session-turn', 'new-session', 'second session question');
    assert.deepEqual(await ids(connection), ['new-session', 'original-session']);
    console.log('new opens original, continues original ID, creates and answers in new ID: pass');
  } finally {
    await connection.close();
  }

  connection = await open(oldRoot, 'old-47c5e4f1');
  try {
    assert.deepEqual(await ids(connection), ['new-session', 'original-session']);
    const transcript = await connection.history.loadSession('original-session');
    assertTranscript(transcript, [
      ['user.message', 'first question'],
      ['model.responded', 'old version answer'],
      ['user.message', 'followup question'],
      ['model.responded', 'new version continuation'],
    ]);
    assertTranscript(await connection.history.loadSession('new-session'), [
      ['user.message', 'second session question'],
      ['model.responded', 'new session answer'],
    ]);
    console.log('old reopens both IDs and sees both answers: pass');
  } finally {
    await connection.close();
  }

  connection = await open(newRoot, 'new-worktree');
  try {
    assert.deepEqual(await ids(connection), ['new-session', 'original-session']);
    const transcript = await connection.history.loadSession('original-session');
    assertTranscript(transcript, [
      ['user.message', 'first question'],
      ['model.responded', 'old version answer'],
      ['user.message', 'followup question'],
      ['model.responded', 'new version continuation'],
    ]);
    assertTranscript(await connection.history.loadSession('new-session'), [
      ['user.message', 'second session question'],
      ['model.responded', 'new session answer'],
    ]);
    console.log('new reopens all IDs and history: pass');
  } finally {
    await connection.close();
  }
  model.assertComplete();
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
