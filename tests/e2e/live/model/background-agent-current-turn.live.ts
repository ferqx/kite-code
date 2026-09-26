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
const PARENT_SESSION_ID = 'synthetic-current-turn-parent';
const GATE = 'synthetic-current-turn-gate';
const RELEASE_MARKER = 'SYNTHETIC_CURRENT_TURN_GATE_RELEASED';
const FOLLOWUP_MARKER = 'SYNTHETIC_CURRENT_TURN_FOLLOWUP_DONE';
const PARENT_MARKER = 'SYNTHETIC_CURRENT_TURN_PARENT_DONE';

// This paid suite is deliberately opt-in and cannot redirect prompts to another endpoint.
if (process.env.KITE_RUN_LIVE_BACKGROUND_CURRENT_TURN !== '1')
  throw new Error('Live current_turn suite requires KITE_RUN_LIVE_BACKGROUND_CURRENT_TURN=1.');
const apiKey = process.env.KITE_LIVE_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Live current_turn suite requires KITE_LIVE_DEEPSEEK_API_KEY.');
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
  throw new Error('Live current_turn suite requires the fixed official DeepSeek endpoint.');

const deadlineAt = Date.now() + SUITE_TIMEOUT_MS;
const root = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-live-deepseek-current-turn-')),
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
      PATH: '/usr/bin:/bin',
      HOME: root,
      USERPROFILE: root,
      NODE_ENV: 'production',
      KITE_CODE_HOME: configRoot,
      KITE_CODE_CONFIG_HOME: configRoot,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: 'synthetic-deepseek-current-turn',
      KITE_QUALIFICATION_HOME: root,
    },
  });
  return createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion('synthetic-deepseek-current-turn'),
    { name: 'synthetic-current-turn-live-suite', version: '1', instanceId: 'sole-client' },
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
  assert.equal(typeof result.session.revision, 'number');
  return result.session.revision;
}

async function startTurn(connection: Connection, input: string, commandId: string): Promise<void> {
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

async function waitForParentCompleted(connection: Connection, ordinal: number): Promise<void> {
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

function makeGate(path: string): void {
  const result = Bun.spawnSync(['/usr/bin/mkfifo', path], { stdout: 'ignore', stderr: 'ignore' });
  if (result.exitCode !== 0) throw new Error('Unable to create isolated FIFO gate.');
}

function releaseGate(path: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ['/bin/sh', '-c', 'printf "%s\\n" "$1" > "$2"', 'release-gate', RELEASE_MARKER, path],
    { stdout: 'ignore', stderr: 'ignore' },
  );
}

let connection: Connection | undefined;
let gateReleased = false;
let gateCreated = false;
let cleanupWriter: ReturnType<typeof Bun.spawn> | undefined;
let stage = 'setup';
const watchdog = setTimeout(() => {
  process.stderr.write('Synthetic DeepSeek current_turn suite exceeded its bounded deadline.\n');
  if (gateCreated && !gateReleased) cleanupWriter = releaseGate(join(workspace, GATE));
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
  makeGate(join(workspace, GATE));
  gateCreated = true;
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
      features: {
        resourceBudget: true,
        boundedCancellation: true,
        afterTurnContinuation: true,
      },
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
    commandId: 'create-synthetic-current-turn-parent',
    type: 'create_session',
    workspace,
    bootstrapSessionId: PARENT_SESSION_ID,
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(created.status, 'applied');
  const mode = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: 'synthetic-current-turn-auto-mode',
    type: 'set_interaction_mode',
    sessionId: PARENT_SESSION_ID,
    expectedRevision: created.revision,
    mode: 'auto',
  });
  assert.equal(mode.status, 'applied');

  await startTurn(
    connection,
    [
      'This is a synthetic Service/Host acceptance test. Use only task, list_agents and followup_task in that order.',
      'Create exactly one review child with background=true and result_disposition="required".',
      `Give it this exact task: "Call shell_execute exactly once with command 'head -n 1 ${GATE}'. The named path is a FIFO, so do not use read_file. After the Shell returns, report its marker and any later followup instruction in your final answer."`,
      'After task acceptance, call list_agents exactly once. Use its direct child agent_id, not the task_id, to call followup_task exactly once.',
      `Send this exact followup message: "After the gated Shell returns, include ${FOLLOWUP_MARKER} in your final answer. Do not call more tools."`,
      `After followup_task returns, submit the final answer candidate exactly: ${PARENT_MARKER}. Runtime will wait for the required child.`,
      'The parent must never call shell_execute, task_wait, task_read, or any other tool.',
    ].join('\n'),
    'start-synthetic-current-turn-child',
  );
  await waitFor('independent child Session intent', () =>
    events(PARENT_SESSION_ID).some((event) => event.type === 'subagent.child_session_intended'),
  );
  const intended = events(PARENT_SESSION_ID).filter(
    (event) => event.type === 'subagent.child_session_intended',
  );
  assert.equal(intended.length, 1, 'Expected exactly one independent child Session.');
  const childSessionId = intended[0]?.childThreadId;
  if (typeof childSessionId !== 'string') throw new Error('Child Session identity was absent.');
  await waitFor('first real child Model and FIFO Shell gate', () => {
    const childEvents = events(childSessionId);
    if (childEvents.some((event) => event.type === 'subagent.child_terminal_sealed'))
      throw new Error('Child terminated before FIFO gate was established.');
    return (
      childEvents.some((event) => event.type === 'model.invocation_attempt_started') &&
      childEvents.some(
        (event) =>
          event.type === 'tool.queued' &&
          event.name === 'shell_execute' &&
          (event.args as { command?: unknown } | undefined)?.command === `head -n 1 ${GATE}`,
      )
    );
  });
  stage = 'child_gate';
  const initialChildRuns = events(childSessionId).filter((event) => event.type === 'turn.started');
  assert.equal(initialChildRuns.length, 1, 'Expected exactly one initial child Run.');
  const childRunId = initialChildRuns[0]?.turnId;
  if (typeof childRunId !== 'string') throw new Error('Child Run identity was absent.');
  assert.equal(eventCount(childSessionId, 'model.invocation_attempt_started'), 1);
  assert.equal(eventCount(childSessionId, 'run.completed'), 0);

  await waitFor('durably accepted followup while child Shell is gated', () =>
    events(PARENT_SESSION_ID).some(
      (event) =>
        event.type === 'agent.mail_accepted' &&
        event.mode === 'trigger_turn' &&
        event.targetAgentId === childSessionId,
    ),
  );
  stage = 'accepted_before_release';
  const beforeRelease = events(childSessionId);
  const parentBeforeRelease = events(PARENT_SESSION_ID);
  assert.equal(parentBeforeRelease.filter((event) => event.type === 'run.completed').length, 0);
  assert.equal(beforeRelease.filter((event) => event.type === 'run.completed').length, 0);
  assert.equal(
    beforeRelease.filter((event) => event.type === 'model.invocation_attempt_started').length,
    1,
  );
  assert.equal(beforeRelease.filter((event) => event.type === 'agent.followup_routed').length, 0);

  const writer = releaseGate(join(workspace, GATE));
  await writer.exited;
  gateReleased = true;
  assert.equal(writer.exitCode, 0, 'FIFO gate writer did not finish.');
  stage = 'released_gate';
  await waitFor('current_turn route and child terminal', () => {
    const childEvents = events(childSessionId);
    return (
      childEvents.some(
        (event) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
      ) && childEvents.some((event) => event.type === 'subagent.child_terminal_sealed')
    );
  });
  await waitForParentCompleted(connection, 1);
  stage = 'final_assertions';
  const childEvents = events(childSessionId);
  const sourceEvents = events(PARENT_SESSION_ID);
  const finalChildRuns = childEvents.filter((event) => event.type === 'turn.started');
  assert.equal(childEvents.filter((event) => event.type === 'agent.followup_routed').length, 1);
  const preparedMail = childEvents.filter((event) => event.type === 'agent.mail_input_prepared');
  assert.equal(preparedMail.length, 1);
  assert.equal(
    childEvents.filter((event) => event.type === 'agent.followup_turn_prepared').length,
    0,
  );
  assert.equal(finalChildRuns.length, 1, 'current_turn opened an extra child Run.');
  assert.equal(finalChildRuns[0]?.turnId, childRunId, 'Child Run identity changed.');
  assert.equal(childEvents.filter((event) => event.type === 'run.completed').length, 1);
  const modelAttempts = childEvents.filter(
    (event) => event.type === 'model.invocation_attempt_started',
  );
  assert.equal(modelAttempts.length, 2);
  assert.equal(preparedMail[0]?.invocationId, modelAttempts[1]?.invocationId);
  assert.equal((preparedMail[0]?.messageIds as unknown[] | undefined)?.length, 1);
  assert.equal(childEvents.filter((event) => event.type === 'run.error').length, 0);
  assert.equal(
    sourceEvents.filter(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    ).length,
    1,
  );
  assert.equal(sourceEvents.filter((event) => event.type === 'run.error').length, 0);
  assert.equal(sourceEvents.filter((event) => event.type === 'run.completed').length, 1);
  assert.equal(
    sourceEvents.filter((event) => event.type === 'subagent.child_terminal_imported').length,
    1,
  );
  stage = 'tool_assertions';
  const parentTools = sourceEvents.filter((event) => event.type === 'tool.queued');
  assert.deepEqual(
    parentTools.map((event) => event.name),
    ['task', 'list_agents', 'followup_task'],
    'Parent used tools outside the required task, list_agents, followup_task sequence.',
  );
  assert.equal(
    childEvents.filter(
      (event) =>
        event.type === 'tool.queued' &&
        event.name === 'shell_execute' &&
        (event.args as { command?: unknown } | undefined)?.command === `head -n 1 ${GATE}`,
    ).length,
    1,
  );
  stage = 'mail_bound_to_model';
  process.stdout.write(
    'Synthetic DeepSeek D3 current_turn: same child Run consumed the followup in its next real Model.\n',
  );
} catch (error) {
  process.stderr.write(
    `Synthetic DeepSeek D3 current_turn failed: ${error instanceof Error ? error.name : 'unknown'}; stage=${stage}; parentCompleted=${eventCountSafe(PARENT_SESSION_ID, 'run.completed')}; parentTools=${toolNamesSafe(PARENT_SESSION_ID)}; parentToolFailed=${eventCountSafe(PARENT_SESSION_ID, 'tool.failed')}; childIntents=${eventCountSafe(PARENT_SESSION_ID, 'subagent.child_session_intended')}; accepted=${eventCountSafe(PARENT_SESSION_ID, 'agent.mail_accepted')}; child=${childDiagnosticSafe()}.\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (gateCreated && !gateReleased) cleanupWriter = releaseGate(join(workspace, GATE));
  await connection?.close().catch(() => undefined);
  cleanupWriter?.kill();
  rmSync(root, { recursive: true, force: true });
}

function eventCountSafe(sessionId: string, type: string): number {
  try {
    return eventCount(sessionId, type);
  } catch {
    return 0;
  }
}

function toolNamesSafe(sessionId: string): string {
  try {
    return events(sessionId)
      .filter((event) => event.type === 'tool.queued')
      .map((event) => (typeof event.name === 'string' ? event.name : 'unknown'))
      .join(',');
  } catch {
    return 'unavailable';
  }
}

function childDiagnosticSafe(): string {
  try {
    const childId = events(PARENT_SESSION_ID).find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    if (typeof childId !== 'string') return 'absent';
    return [
      `models:${eventCountSafe(childId, 'model.invocation_attempt_started')}`,
      `tools:${toolNamesSafe(childId)}`,
      `routes:${eventCountSafe(childId, 'agent.followup_routed')}`,
      `terminals:${eventCountSafe(childId, 'subagent.child_terminal_sealed')}`,
    ].join('|');
  } catch {
    return 'unavailable';
  }
}
