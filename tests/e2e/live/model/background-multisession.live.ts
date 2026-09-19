import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeApprovalInteraction, RuntimeClientEvent } from '@kite-ai/runtime-contract';
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
const MODEL = 'deepseek-v4-flash';
const LIVE_TIMEOUT_MS = Number(process.env.KITE_LIVE_BACKGROUND_TIMEOUT_MS ?? 180_000);
const POLL_INTERVAL_MS = 250;

if (process.env.KITE_RUN_LIVE_BACKGROUND_MULTISESSION !== '1') {
  throw new Error(
    'Refusing network-backed execution. Set KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1 to run this opt-in suite.',
  );
}

const apiKey = process.env.KITE_LIVE_DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error('Set KITE_LIVE_DEEPSEEK_API_KEY to run the DeepSeek background suite.');
}

const baseURL = process.env.KITE_LIVE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const root = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-live-deepseek-background-')),
);
const configRoot = join(root, '.kite-code');
const workspace = join(root, 'workspace');
const sessionA = 'live-background-session-a';
const sessionB = 'live-background-session-b';
const approvedInteractions = new Set<string>();
const serviceEntrypoint = join(
  import.meta.dir,
  '../../../qualification/fixtures/isolated-store-service.ts',
);

function openConnection(label: string) {
  const transport = new BunStdioChildRuntimeClientTransport({
    argv: [process.execPath, serviceEntrypoint, 'app-server', 'run-stdio'],
    cwd: join(import.meta.dir, '../../../..'),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      USERPROFILE: root,
      NODE_ENV: 'production',
      KITE_CODE_HOME: configRoot,
      KITE_CODE_CONFIG_HOME: configRoot,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: `live-deepseek-background-${label}`,
      KITE_QUALIFICATION_HOME: root,
    },
  });
  return createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion(`live-deepseek-background-${label}`),
    { name: 'live-deepseek-background-suite', version: '1', instanceId: label },
    KITE_APP_SERVER_PROTOCOL_METHODS_,
  );
}

type Connection = ReturnType<typeof openConnection>;

async function projection(connection: Connection, sessionId: string) {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.session, `Missing projection for ${sessionId}.`);
  return result.session;
}

async function createSession(connection: Connection, sessionId: string): Promise<number> {
  const created = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: `create-${sessionId}`,
    type: 'create_session',
    workspace,
    bootstrapSessionId: sessionId,
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(created.status, 'applied');
  const createdRevision = created.revision;
  const mode = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: `mode-${sessionId}`,
    type: 'set_interaction_mode',
    sessionId,
    expectedRevision: createdRevision,
    mode: 'auto',
  });
  assert.equal(mode.status, 'applied');
  return mode.revision;
}

async function startTurn(
  connection: Connection,
  sessionId: string,
  expectedRevision: number,
  input: string,
) {
  const started = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: `turn-${sessionId}-${expectedRevision}`,
    type: 'start_turn',
    sessionId,
    expectedRevision,
    input,
    phase: 'building',
    model: { provider: PROVIDER, name: MODEL },
  });
  assert.equal(started.status, 'applied');
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForRunTerminal(connection: Connection, sessionId: string): Promise<void> {
  await waitFor(`${sessionId} Run terminal`, async () => {
    const current = (await projection(connection, sessionId)).currentRun;
    if (current?.status === 'failed' || current?.status === 'cancelled') {
      throw new Error(`${sessionId} ended as ${current.status}.`);
    }
    return current?.status === 'completed';
  }).catch(async (error) => {
    const session = await projection(connection, sessionId).catch(() => undefined);
    const executions = await background(connection, sessionId).catch(() => []);
    const history = await connection.history.loadSession(sessionId).catch(() => undefined);
    const facts = history
      ? eventsOf(history).map((event) => ({
          type: event.type,
          ...('toolName' in event ? { toolName: event.toolName } : {}),
          ...('status' in event ? { status: event.status } : {}),
        }))
      : [];
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} run=${JSON.stringify(session?.currentRun)} executions=${JSON.stringify(executions)} events=${JSON.stringify(facts)}`,
    );
  });
}

async function approvePendingInteraction(connection: Connection, sessionId: string): Promise<void> {
  const session = await projection(connection, sessionId);
  const interaction = session.interactionQueue?.interactions.find(
    (candidate): candidate is RuntimeApprovalInteraction =>
      candidate.kind === 'approval' &&
      candidate.interactionId === session.interactionQueue?.activeInteractionId,
  );
  if (!interaction || approvedInteractions.has(interaction.interactionId)) return;
  const receipt = await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: `approve-${interaction.interactionId}-${interaction.sessionRevision}`,
    type: 'respond_interaction',
    sessionId,
    expectedRevision: interaction.sessionRevision,
    interaction,
    response: { kind: 'approval', decision: 'approve_once' },
  });
  if (
    receipt.status === 'conflict' ||
    (receipt.status === 'rejected' && receipt.code === 'interaction_mismatch')
  ) {
    return;
  }
  if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
    throw new Error(`Approval was not accepted: ${JSON.stringify(receipt)}`);
  }
  approvedInteractions.add(interaction.interactionId);
}

async function background(connection: Connection, sessionId: string) {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'list_background_executions',
    sessionId,
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.backgroundSnapshot, `Missing background snapshot for ${sessionId}.`);
  return result.backgroundSnapshot.executions;
}

function eventsOf(history: Awaited<ReturnType<Connection['history']['loadSession']>>) {
  return history.events as readonly RuntimeClientEvent[];
}

function includesEvent(events: readonly RuntimeClientEvent[], type: RuntimeClientEvent['type']) {
  return events.some((event) => event.type === type);
}

let connection: Connection | undefined;
const suiteDeadline = setTimeout(() => {
  process.stderr.write(`DeepSeek background suite exceeded ${LIVE_TIMEOUT_MS}ms.\n`);
  process.exitCode = 1;
}, LIVE_TIMEOUT_MS + 10_000);

try {
  mkdirSync(configRoot, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, 'probe-a.txt'), 'session-a-child-marker\n', { mode: 0o600 });
  writeFileSync(join(workspace, 'probe-b.txt'), 'session-b-marker\n', { mode: 0o600 });
  writeFileSync(
    join(configRoot, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        [PROVIDER]: {
          type: 'deepseek',
          apiKey,
          baseURL,
          model: MODEL,
          models: [MODEL],
        },
      },
      model: { default: { provider: PROVIDER, name: MODEL } },
      interactionMode: 'full',
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

  connection = openConnection('first');
  await connection.prepareAppControl();

  const revisionA = await createSession(connection, sessionA);
  await startTurn(
    connection,
    sessionA,
    revisionA,
    [
      'This is a deterministic live E2E. Perform two background operations sequentially, never in the same model response:',
      '1. First dispatch one explore task with background true. Do not set result_disposition and do not call any other tool in that response. The child must read probe-a.txt, wait before its final answer by doing additional read-only workspace inspection, and report the exact marker.',
      '2. Only after the task tool returns its accepted task id, in your next model response call shell_execute with exactly {"command":"sleep 25; printf shell-a-done","yield_ms":0}.',
      '3. After shell_execute returns its shell_id, call shell_read with that exact id and wait_until terminal. Do not call task_read. After both required operations settle, reply exactly: session-a-completed',
    ].join('\n'),
  );

  await waitFor('Session A Shell and subagent to be running', async () => {
    await approvePendingInteraction(connection!, sessionA);
    const executions = await background(connection!, sessionA);
    return ['shell', 'subagent'].every((kind) =>
      executions.some((execution) => execution.kind === kind && execution.status === 'running'),
    );
  }).catch(async (error) => {
    const executions = await background(connection!, sessionA).catch(() => []);
    const history = await connection!.history.loadSession(sessionA).catch(() => undefined);
    const facts = history
      ? eventsOf(history).map((event) => ({
          type: event.type,
          ...('toolName' in event ? { toolName: event.toolName } : {}),
          ...('status' in event ? { status: event.status } : {}),
        }))
      : [];
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} executions=${JSON.stringify(executions)} events=${JSON.stringify(facts)}`,
    );
  });
  assert.ok(
    ['queued', 'running', 'waiting'].includes(
      (await projection(connection, sessionA)).currentRun?.status ?? '',
    ),
    'Session A was already terminal before switching to Session B.',
  );

  const initialAHistory = await connection.history.loadSession(sessionA);
  const initialAEvents = eventsOf(initialAHistory);
  assert.ok(
    includesEvent(initialAEvents, 'subagent.started'),
    'Session A did not start a subagent.',
  );
  assert.ok(
    initialAEvents.some(
      (event) => event.type === 'tool.queued' && event.toolName === 'shell_execute',
    ),
    'Session A did not queue shell_execute.',
  );
  const beforeSwitch = await background(connection, sessionA);
  assert.ok(
    beforeSwitch.some(
      (execution) =>
        (execution.kind === 'shell' || execution.kind === 'subagent') &&
        ['running', 'stopping'].includes(execution.status),
    ),
    `Session A had no live background execution before switching: ${JSON.stringify(beforeSwitch)}`,
  );

  const revisionB = await createSession(connection, sessionB);
  await startTurn(
    connection,
    sessionB,
    revisionB,
    'Read probe-b.txt with read_file and then reply exactly: session-b-interacted',
  );
  await waitForRunTerminal(connection, sessionB);
  await waitForRunTerminal(connection, sessionA);

  const historyB = await connection.history.loadSession(sessionB);
  const eventsB = eventsOf(historyB);
  assert.ok(
    eventsB.some((event) => event.type === 'tool.finished' && event.toolName === 'read_file'),
    'Session B did not finish read_file.',
  );
  assert.ok(includesEvent(eventsB, 'model.responded'), 'Session B has no model response.');
  assert.ok(
    !includesEvent(eventsB, 'subagent.started'),
    'Session A subagent leaked into Session B.',
  );
  assert.ok(
    !(await background(connection, sessionB)).some(
      (execution) => execution.kind === 'shell' || execution.kind === 'subagent',
    ),
    'Session A background execution leaked into Session B projection.',
  );

  await waitFor('Session A shell and subagent terminal states', async () => {
    const executions = await background(connection!, sessionA);
    const shell = executions.find((execution) => execution.kind === 'shell');
    const subagent = executions.find((execution) => execution.kind === 'subagent');
    return shell?.status === 'completed' && subagent?.status === 'completed';
  });

  // Hot re-entry: load A again after B was selected and completed, without restarting the Service.
  const reenteredA = await connection.history.loadSession(sessionA);
  const reenteredAEvents = eventsOf(reenteredA);
  assert.ok(
    reenteredAEvents.some(
      (event) => event.type === 'tool.finished' && event.result.stdout.includes('shell-a-done'),
    ),
    'Hot re-entry did not project the background Shell terminal result.',
  );
  assert.ok(
    includesEvent(reenteredAEvents, 'subagent.completed'),
    'Hot re-entry did not project the background subagent terminal result.',
  );
  assert.ok(
    !reenteredAEvents.some(
      (event) => event.type === 'user.message' && event.text.includes('probe-b.txt'),
    ),
    'Session B input leaked into Session A history.',
  );

  assert.deepEqual((await projection(connection, sessionA)).model, {
    provider: PROVIDER,
    name: MODEL,
  });
  assert.deepEqual((await projection(connection, sessionB)).model, {
    provider: PROVIDER,
    name: MODEL,
  });

  console.log(
    JSON.stringify({
      ok: true,
      provider: PROVIDER,
      model: MODEL,
      scenarios: [
        'single-session-background-shell-and-subagent',
        'switch-to-session-b-and-interact-while-a-runs',
        'session-a-and-b-isolation',
        'return-to-session-a-terminal-state',
        'hot-reentry-history-projection',
      ],
    }),
  );
} finally {
  clearTimeout(suiteDeadline);
  await connection?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
