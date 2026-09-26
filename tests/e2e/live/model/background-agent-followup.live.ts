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
const SUITE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const PARENT_SESSION_ID = 'synthetic-followup-parent';
const INITIAL_MARKER = 'SYNTHETIC_CHILD_INITIAL_DONE';
const FOLLOWUP_MARKER = 'SYNTHETIC_CHILD_FOLLOWUP_DONE';

// An explicit opt-in and a fixed endpoint keep this paid live suite separate from local tests.
if (process.env.KITE_RUN_LIVE_BACKGROUND_FOLLOWUP !== '1')
  throw new Error('Live followup suite requires KITE_RUN_LIVE_BACKGROUND_FOLLOWUP=1.');
const apiKey = process.env.KITE_LIVE_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Live followup suite requires KITE_LIVE_DEEPSEEK_API_KEY.');
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
  throw new Error('Live followup suite requires the fixed official DeepSeek endpoint.');

const deadlineAt = Date.now() + SUITE_TIMEOUT_MS;
const root = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-live-deepseek-followup-')),
);
const configRoot = join(root, '.kite-code');
const workspace = join(root, 'workspace');
const databasePath = join(configRoot, 'kite-session.sqlite');
const serviceEntrypoint = join(
  import.meta.dir,
  '../../../qualification/fixtures/isolated-store-service.ts',
);
type Connection = ReturnType<typeof openConnection>;

function openConnection(): ReturnType<typeof createAppServerProtocolConnection> {
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
      KITE_APP_SERVER_BUILD_ID: 'synthetic-deepseek-followup',
      KITE_QUALIFICATION_HOME: root,
    },
  });
  return createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion('synthetic-deepseek-followup'),
    { name: 'synthetic-followup-live-suite', version: '1', instanceId: 'sole-client' },
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

function eventCount(sessionId: string, type: string): number {
  return events(sessionId).filter((event) => event.type === type).length;
}

async function waitFor(description: string, predicate: () => Promise<boolean> | boolean) {
  while (Date.now() < deadlineAt) {
    if (await predicate()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function revision(connection: Connection, sessionId: string): Promise<number> {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.session);
  const value = result.session.revision;
  assert.equal(typeof value, 'number');
  return value;
}

async function startTurn(connection: Connection, input: string, commandId: string) {
  const started = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId,
    type: 'start_turn',
    sessionId: PARENT_SESSION_ID,
    expectedRevision: await revision(connection, PARENT_SESSION_ID),
    input,
    phase: 'building',
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(started.status, 'applied', 'Synthetic parent turn was not admitted.');
}

async function waitForCompletedRun(connection: Connection, ordinal: number) {
  await waitFor(`parent Run ${ordinal}`, async () => {
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId: PARENT_SESSION_ID,
    });
    assert.equal(result.status, 'ok');
    const status = result.session?.currentRun?.status;
    if (status === 'failed' || status === 'cancelled' || status === 'recovery_required')
      throw new Error(`Synthetic parent Run ${ordinal} ended as ${status}.`);
    return eventCount(PARENT_SESSION_ID, 'run.completed') >= ordinal;
  });
}

let connection: Connection | undefined;
const watchdog = setTimeout(() => {
  process.stderr.write('Synthetic DeepSeek followup suite exceeded its bounded deadline.\n');
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
    commandId: 'create-synthetic-followup-parent',
    type: 'create_session',
    workspace,
    bootstrapSessionId: PARENT_SESSION_ID,
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(created.status, 'applied');
  const mode = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: 'synthetic-followup-auto-mode',
    type: 'set_interaction_mode',
    sessionId: PARENT_SESSION_ID,
    expectedRevision: created.revision,
    mode: 'auto',
  });
  assert.equal(mode.status, 'applied');

  await startTurn(
    connection,
    [
      'This is a synthetic Service/Host acceptance test. Use the disclosed task tool exactly once.',
      'Create one review child with background=true and result_disposition="required".',
      `Give it this exact task: "Reply ${INITIAL_MARKER} without calling tools."`,
      'After the child result arrives, finish this Run. Do not call shell tools or access files.',
    ].join('\n'),
    'start-synthetic-child-turn',
  );
  await waitForCompletedRun(connection, 1);
  const intended = events(PARENT_SESSION_ID).filter(
    (event) => event.type === 'subagent.child_session_intended',
  );
  assert.equal(intended.length, 1, 'Expected exactly one independent child Session.');
  const childSessionId = intended[0]?.childThreadId;
  if (typeof childSessionId !== 'string') throw new Error('Child Session identity was absent.');
  assert.equal(eventCount(PARENT_SESSION_ID, 'subagent.background_result_persisted'), 1);
  assert.equal(eventCount(childSessionId, 'subagent.child_terminal_sealed'), 1);

  await startTurn(
    connection,
    [
      'This is the second turn of the same synthetic acceptance test.',
      `Call followup_task exactly once with agent_id="${childSessionId}" and message="Reply ${FOLLOWUP_MARKER} without calling tools."`,
      'After followup_task returns its acceptance object, finish this Run without other tools.',
      'Do not call shell tools or access files.',
    ].join('\n'),
    'start-synthetic-followup-turn',
  );
  await waitForCompletedRun(connection, 2);
  await waitFor('durably settled followup and cross-Run reply', () => {
    const sourceEvents = events(PARENT_SESSION_ID);
    const childEvents = events(childSessionId);
    return (
      sourceEvents.some(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
      ) &&
      sourceEvents.some(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
      ) &&
      childEvents.some(
        (event) => event.type === 'agent.followup_routed' && event.route === 'new_turn',
      ) &&
      childEvents.some((event) => event.type === 'agent.followup_turn_settled')
    );
  });
  const sourceEvents = events(PARENT_SESSION_ID);
  const childEvents = events(childSessionId);
  assert.equal(
    sourceEvents.filter(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    ).length,
    1,
  );
  assert.equal(
    sourceEvents.filter((event) => event.type === 'agent.mail_accepted' && event.mode === 'reply')
      .length,
    1,
  );
  assert.equal(childEvents.filter((event) => event.type === 'agent.mail_input_prepared').length, 1);
  assert.equal(
    childEvents.filter(
      (event) => event.type === 'agent.followup_turn_settled' && event.status === 'completed',
    ).length,
    1,
  );
  assert.equal(childEvents.filter((event) => event.type === 'run.completed').length, 2);
  assert.equal(
    childEvents.filter((event) => event.type === 'model.invocation_attempt_started').length,
    2,
  );
  assert.equal(sourceEvents.filter((event) => event.type === 'run.error').length, 0);
  assert.equal(childEvents.filter((event) => event.type === 'run.error').length, 0);
  process.stdout.write(
    'Synthetic DeepSeek D3 new_turn: child Session, followup settlement, and one cross-Run reply passed.\n',
  );
} catch (error) {
  process.stderr.write(
    `Synthetic DeepSeek D3 new_turn failed: ${error instanceof Error ? error.name : 'unknown'}; parentCompleted=${eventCountSafe(PARENT_SESSION_ID, 'run.completed')}; childIntents=${eventCountSafe(PARENT_SESSION_ID, 'subagent.child_session_intended')}; accepted=${eventCountSafe(PARENT_SESSION_ID, 'agent.mail_accepted')}.\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await connection?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

function eventCountSafe(sessionId: string, type: string): number {
  try {
    return eventCount(sessionId, type);
  } catch {
    return 0;
  }
}
