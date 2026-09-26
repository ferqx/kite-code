import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustWorkspace } from '../../../../apps/kite-service/src/config/workspace-trust';
import {
  BunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '../../../../packages/kite-local-runtime/src/client';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
} from '../../../../packages/kite-local-runtime/src/client/protocol-connection';

const PROVIDER = 'deepseek';
const MODEL = 'deepseek-flash';
const BASE_URL = 'https://api.deepseek.com/v1';
const SUITE_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 250;
const PARENT_SESSION_ID = 'synthetic-three-child-parent';

if (process.env.KITE_RUN_LIVE_BACKGROUND_THREE_CHILD !== '1')
  throw new Error('Live three-child suite requires KITE_RUN_LIVE_BACKGROUND_THREE_CHILD=1.');
const apiKey = process.env.KITE_LIVE_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Live three-child suite requires KITE_LIVE_DEEPSEEK_API_KEY.');
const endpoint = new URL(BASE_URL);
if (
  endpoint.protocol !== 'https:' ||
  endpoint.origin !== 'https://api.deepseek.com' ||
  endpoint.pathname !== '/v1' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Live three-child suite requires the fixed official DeepSeek endpoint.');

const deadlineAt = Date.now() + SUITE_TIMEOUT_MS;
const root = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-live-deepseek-three-child-')),
);
const configRoot = join(root, '.kite-code');
const workspace = join(root, 'workspace');
const databasePath = join(configRoot, 'kite-session.sqlite');
const serviceEntrypoint = join(
  import.meta.dir,
  '../../../qualification/fixtures/isolated-store-service.ts',
);
type Connection = ReturnType<typeof openConnection>;

function openConnection() {
  const transport = new BunStdioChildRuntimeClientTransport({
    argv: [process.execPath, serviceEntrypoint, 'app-server', 'run-stdio'],
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      USERPROFILE: root,
      NODE_ENV: 'production',
      KITE_CODE_HOME: configRoot,
      KITE_CODE_CONFIG_HOME: configRoot,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: 'synthetic-deepseek-three-child',
      KITE_QUALIFICATION_HOME: root,
    },
  });
  return createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion('synthetic-deepseek-three-child'),
    { name: 'synthetic-three-child-live-suite', version: '1', instanceId: 'sole-client' },
    KITE_APP_SERVER_PROTOCOL_METHODS_,
  );
}

async function assertModelAvailable(): Promise<void> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.min(30_000, Math.max(1, deadlineAt - Date.now()))),
  });
  if (!response.ok) throw new Error(`DeepSeek model preflight failed: HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    readonly data?: readonly { readonly id?: unknown }[];
  };
  if (!payload.data?.some((candidate) => candidate.id === MODEL))
    throw new Error('DeepSeek model preflight did not advertise deepseek-flash.');
}

function events(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ event_json: string }, [string]>(
        'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
      )
      .all(sessionId)
      .map(({ event_json }) => JSON.parse(event_json) as Readonly<Record<string, unknown>>);
  } finally {
    database.close(false);
  }
}

function count(sessionId: string, type: string): number {
  return events(sessionId).filter((event) => event.type === type).length;
}

function safeCount(sessionId: string, type: string): number {
  try {
    return count(sessionId, type);
  } catch {
    return 0;
  }
}

async function waitFor(description: string, predicate: () => Promise<boolean> | boolean) {
  while (Date.now() < deadlineAt) {
    if (await predicate()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

let connection: Connection | undefined;
const watchdog = setTimeout(() => {
  process.stderr.write('Synthetic DeepSeek three-child suite exceeded its bounded deadline.\n');
  void Promise.race([
    connection?.close().catch(() => undefined) ?? Promise.resolve(),
    Bun.sleep(2_000),
  ])
    .catch(() => undefined)
    .finally(() => {
      rmSync(root, { recursive: true, force: true });
      process.exit(1);
    });
}, SUITE_TIMEOUT_MS + 10_000);

try {
  await assertModelAvailable();
  mkdirSync(configRoot, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    join(configRoot, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        [PROVIDER]: {
          type: PROVIDER,
          apiKey,
          baseURL: BASE_URL,
          model: MODEL,
          models: [{ name: MODEL, contextWindow: 131_072, maxOutputTokens: 4_096 }],
        },
      },
      model: { default: { provider: PROVIDER, name: MODEL } },
      interactionMode: 'auto',
      features: { resourceBudget: true, boundedCancellation: true },
      sandbox: { enabled: false },
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  assert.equal(
    trustWorkspace({
      workspace,
      source: 'test',
      storePath: join(configRoot, 'workspace-trust.jsonc'),
    }).status,
    'recorded',
  );

  connection = openConnection();
  await connection.prepareAppControl();
  const created = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: 'create-synthetic-three-child-parent',
    type: 'create_session',
    workspace,
    bootstrapSessionId: PARENT_SESSION_ID,
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(created.status, 'applied');
  const mode = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: 'synthetic-three-child-auto-mode',
    type: 'set_interaction_mode',
    sessionId: PARENT_SESSION_ID,
    expectedRevision: created.revision,
    mode: 'auto',
  });
  assert.equal(mode.status, 'applied');
  const started = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: 'start-synthetic-three-child-turn',
    type: 'start_turn',
    sessionId: PARENT_SESSION_ID,
    expectedRevision: mode.revision,
    input: [
      'This is a synthetic Service/Host test of three independent background children.',
      'The built-in task tool is disclosed in your tool schema. In one response, call task exactly three times for three independent review children named Alpha, Beta, and Gamma.',
      'For each call set background=true and result_disposition="required".',
      'Alpha task: Reply "synthetic alpha done" without tools.',
      'Beta task: Reply "synthetic beta done" without tools.',
      'Gamma task: Reply "synthetic gamma done" without tools.',
      'After all three task acceptance objects return, finish with a short sentence. Do not use any other tool or access files.',
    ].join('\n'),
    phase: 'building',
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(started.status, 'applied', 'Synthetic parent turn was not admitted.');

  await waitFor('parent Run and three child terminals', async () => {
    const result = await connection!.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId: PARENT_SESSION_ID,
    });
    assert.equal(result.status, 'ok');
    const status = result.session?.currentRun?.status;
    if (status === 'failed' || status === 'cancelled' || status === 'recovery_required')
      throw new Error(`Synthetic parent Run ended as ${status}.`);
    return count(PARENT_SESSION_ID, 'run.completed') === 1;
  });

  const parentEvents = events(PARENT_SESSION_ID);
  const intents = parentEvents.filter((event) => event.type === 'subagent.child_session_intended');
  assert.equal(intents.length, 3, 'Expected three independent child Session intents.');
  const childSessionIds = intents.map((event) => event.childThreadId);
  assert.ok(childSessionIds.every((id) => typeof id === 'string'));
  assert.equal(new Set(childSessionIds).size, 3);
  assert.equal(new Set(intents.map((event) => event.childInvocationId)).size, 3);
  const originRunIds = new Set(intents.map((event) => event.originRunId));
  const originTurnIds = new Set(intents.map((event) => event.originTurnId));
  assert.equal(originRunIds.size, 1);
  assert.equal(originTurnIds.size, 1);

  const imported = parentEvents.filter(
    (event) => event.type === 'subagent.child_terminal_imported',
  );
  const results = parentEvents.filter(
    (event) => event.type === 'subagent.background_result_persisted',
  );
  assert.equal(imported.length, 3, 'Each child must be imported once.');
  assert.equal(results.length, 3, 'Each required child must produce one parent result.');
  assert.deepEqual(new Set(imported.map((event) => event.childThreadId)), new Set(childSessionIds));
  assert.deepEqual(
    new Set(results.map((event) => event.taskId)),
    new Set(intents.map((event) => event.childInvocationId)),
  );
  assert.ok(imported.every((event) => event.status === 'completed'));
  for (const childSessionId of childSessionIds) {
    if (typeof childSessionId !== 'string') throw new Error('Missing child Session identity.');
    const childEvents = events(childSessionId);
    assert.ok(
      childEvents.some((event) => event.type === 'model.invocation_attempt_started'),
      'Each child must have an actual Provider model attempt.',
    );
    assert.equal(
      childEvents.filter((event) => event.type === 'subagent.child_terminal_sealed').length,
      1,
      'Each child must seal one terminal.',
    );
    assert.equal(childEvents.filter((event) => event.type === 'run.completed').length, 1);
    assert.equal(childEvents.filter((event) => event.type === 'run.error').length, 0);
  }
  assert.equal(parentEvents.filter((event) => event.type === 'run.completed').length, 1);
  assert.equal(parentEvents.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal(parentEvents.filter((event) => event.type === 'run.error').length, 0);
  assert.equal(parentEvents.filter((event) => event.type === 'turn.aborted').length, 0);
  const listed = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'list_sessions',
  });
  assert.equal(listed.status, 'ok');
  if (listed.status !== 'ok') throw new Error('Root Session list failed.');
  assert.deepEqual(
    listed.sessions?.map((session) => session.sessionId),
    [PARENT_SESSION_ID],
  );
  process.stdout.write(
    'Synthetic DeepSeek D0 three-child: independent Sessions, three Provider attempts and parent imports, one parent Run/Turn, and root-only list passed.\n',
  );
} catch (error) {
  process.stderr.write(
    `Synthetic DeepSeek D0 three-child failed: ${error instanceof Error ? error.name : 'unknown'}; parentCompleted=${safeCount(PARENT_SESSION_ID, 'run.completed')}; childIntents=${safeCount(PARENT_SESSION_ID, 'subagent.child_session_intended')}; imported=${safeCount(PARENT_SESSION_ID, 'subagent.child_terminal_imported')}.\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await connection?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
