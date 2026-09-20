import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
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
const LIVE_TIMEOUT_MS = Number(process.env.KITE_LIVE_BACKGROUND_TIMEOUT_MS ?? 180_000);
const POLL_INTERVAL_MS = 250;
const SUITE_DEADLINE_AT = Date.now() + LIVE_TIMEOUT_MS;

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
const startupInjection = join(root, '.bashrc');
const startupMarker = join(workspace, 'startup-injection-ran');
const sessionA = 'live-background-session-a';
const sessionB = 'live-background-session-b';
const sessionC = 'live-background-session-c';
const requiredGateA = join(workspace, 'required-gate-a');
const requiredGateB = join(workspace, 'required-gate-b');
const afterTurnGate = join(workspace, 'after-turn-gate');
const settledInteractions = new Set<string>();
let requiredGateACreated = false;
let requiredGateBCreated = false;
let afterTurnGateCreated = false;
let requiredGateAReleased = false;
let requiredGateBReleased = false;
let afterTurnGateReleased = false;
const serviceEntrypoint = join(
  import.meta.dir,
  '../../../qualification/fixtures/isolated-store-service.ts',
);
const packagedServiceExecutable = process.env.KITE_LIVE_BACKGROUND_SERVICE_EXECUTABLE;

function openConnection(label: string) {
  const transport = new BunStdioChildRuntimeClientTransport({
    argv: packagedServiceExecutable
      ? [packagedServiceExecutable, 'app-server', 'run-stdio']
      : [process.execPath, serviceEntrypoint, 'app-server', 'run-stdio'],
    cwd: join(import.meta.dir, '../../../..'),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      USERPROFILE: root,
      BASH_ENV: startupInjection,
      ENV: startupInjection,
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

async function assertRequestedModelAvailable(): Promise<void> {
  const endpoint = new URL(`${baseURL.replace(/\/$/u, '')}/models`);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, SUITE_DEADLINE_AT - Date.now()))),
  });
  if (!response.ok) {
    throw new Error(
      `DeepSeek model preflight failed with HTTP ${response.status}; no model prompt was sent.`,
    );
  }
  const payload = (await response.json()) as {
    readonly data?: readonly { readonly id?: unknown }[];
  };
  const advertisedModels = Array.isArray(payload.data)
    ? payload.data.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []))
    : [];
  if (!advertisedModels.includes(MODEL)) {
    throw new Error(
      `DeepSeek model preflight did not advertise required model ${MODEL}; advertised model count: ${advertisedModels.length}. No model prompt was sent.`,
    );
  }
}

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
  const deadline = Math.min(Date.now() + timeoutMs, SUITE_DEADLINE_AT);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForRunTerminal(connection: Connection, sessionId: string): Promise<void> {
  await waitFor(`${sessionId} Run terminal`, async () => {
    await settlePendingInteraction(connection, sessionId);
    const current = (await projection(connection, sessionId)).currentRun;
    if (current?.status === 'failed' || current?.status === 'cancelled') {
      throw new Error(`${sessionId} ended as ${current.status}.`);
    }
    return current?.status === 'completed';
  }).catch(async (error) => {
    const session = await projection(connection, sessionId).catch(() => undefined);
    const executions = await background(connection, sessionId).catch(() => []);
    const history = await connection.history.loadSession(sessionId).catch(() => undefined);
    const facts = history ? eventCardinality(eventsOf(history)) : {};
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} run=${JSON.stringify(runDiagnostic(session?.currentRun))} executions=${JSON.stringify(executionDiagnostics(executions))} events=${JSON.stringify(facts)} rawRunErrors=${JSON.stringify(rawRunErrorDiagnostics(sessionId))} completionFacts=${JSON.stringify(completionDiagnostics(sessionId))} subagentFailures=${JSON.stringify(subagentFailureDiagnostics(sessionId))}`,
    );
  });
}

async function settlePendingInteraction(connection: Connection, sessionId: string): Promise<void> {
  const session = await projection(connection, sessionId);
  const interaction = session.interactionQueue?.interactions.find(
    (candidate) => candidate.interactionId === session.interactionQueue?.activeInteractionId,
  );
  if (!interaction || settledInteractions.has(interaction.interactionId)) return;
  if (interaction.kind !== 'approval' && interaction.kind !== 'input') return;
  const receipt =
    interaction.kind === 'approval'
      ? await connection.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: `settle-${interaction.interactionId}-${interaction.sessionRevision}`,
          type: 'respond_interaction',
          sessionId,
          expectedRevision: interaction.sessionRevision,
          interaction,
          response: { kind: 'approval', decision: 'approve_once' },
        })
      : await connection.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: `settle-${interaction.interactionId}-${interaction.sessionRevision}`,
          type: 'respond_interaction',
          sessionId,
          expectedRevision: interaction.sessionRevision,
          interaction,
          response: {
            kind: 'text',
            value: 'Continue the requested deterministic test without asking again.',
          },
        });
  if (
    receipt.status === 'conflict' ||
    (receipt.status === 'rejected' && receipt.code === 'interaction_mismatch')
  ) {
    return;
  }
  if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
    throw new Error(`Interaction response was not accepted: ${JSON.stringify(receipt)}`);
  }
  settledInteractions.add(interaction.interactionId);
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

function rootModelRequestCount(events: readonly RuntimeClientEvent[]): number {
  return events.filter((event) => event.type === 'model.requested').length;
}

type ToolQueuedEvent = Extract<RuntimeClientEvent, { readonly type: 'tool.queued' }>;

function queuedToolEvents(events: readonly RuntimeClientEvent[]): readonly ToolQueuedEvent[] {
  return events.filter((event): event is ToolQueuedEvent => event.type === 'tool.queued');
}

function taskReadCount(events: readonly RuntimeClientEvent[]): number {
  return queuedToolEvents(events).filter((event) => typeof event.arguments.task_id === 'string')
    .length;
}

function responseTexts(events: readonly RuntimeClientEvent[]): readonly string[] {
  const pending = new Map<string, string>();
  const responses: string[] = [];
  for (const event of events) {
    if (event.type === 'model.text_delta') {
      pending.set(event.requestId, `${pending.get(event.requestId) ?? ''}${event.text}`);
    } else if (event.type === 'model.response_superseded') {
      pending.delete(event.requestId);
    } else if (event.type === 'model.responded') {
      const text = pending.get(event.requestId)?.trim();
      if (text) responses.push(text);
      pending.delete(event.requestId);
    }
  }
  return responses;
}

function queuedShellCommands(events: readonly RuntimeClientEvent[]): readonly string[] {
  return queuedToolEvents(events).flatMap((event) =>
    event.toolName === 'shell_execute' && typeof event.arguments.command === 'string'
      ? [event.arguments.command]
      : [],
  );
}

function queuedTasks(events: readonly RuntimeClientEvent[]) {
  return queuedToolEvents(events).filter(
    (event) => event.toolName === 'task' && typeof event.arguments.subagent_type === 'string',
  );
}

function eventCardinality(events: readonly RuntimeClientEvent[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function runDiagnostic(run: unknown): Readonly<Record<string, unknown>> {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return {};
  const value = run as Readonly<Record<string, unknown>>;
  const waitingReason =
    value.waitingReason &&
    typeof value.waitingReason === 'object' &&
    !Array.isArray(value.waitingReason)
      ? (value.waitingReason as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof waitingReason?.kind === 'string' ? { waitingReasonKind: waitingReason.kind } : {}),
    ...(Array.isArray(waitingReason?.taskIds)
      ? { waitingTaskCount: waitingReason.taskIds.length }
      : {}),
  };
}

function executionDiagnostics(executions: readonly unknown[]): Readonly<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  let cleanupConfirmed = 0;
  for (const candidate of executions) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const execution = candidate as Readonly<Record<string, unknown>>;
    const kind = typeof execution.kind === 'string' ? execution.kind : 'unknown';
    const status = typeof execution.status === 'string' ? execution.status : 'unknown';
    counts[`${kind}:${status}`] = (counts[`${kind}:${status}`] ?? 0) + 1;
    if (execution.cleanupConfirmed === true) cleanupConfirmed += 1;
  }
  return { counts, cleanupConfirmed };
}

function runPageDiagnostics(runs: readonly unknown[]) {
  const statuses: Record<string, number> = {};
  for (const candidate of runs) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const run = candidate as Readonly<Record<string, unknown>>;
    const status = typeof run.status === 'string' ? run.status : 'unknown';
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return { total: runs.length, statuses };
}

function createEventGate(path: string): void {
  const result = Bun.spawnSync(['/usr/bin/mkfifo', path], { stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to create event gate: ${result.stderr.toString()}`);
  }
}

function releaseEventGate(path: string, value: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['/bin/sh', '-c', 'printf "%s\\n" "$1" > "$2"', 'release-gate', value, path], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function listRuns(connection: Connection, sessionId: string) {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'list_runs',
    sessionId,
    limit: 20,
  });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok' || !result.runs) throw new Error('Run history was unavailable.');
  return result.runs;
}

function rawRunErrorDiagnostics(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      const rows = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId);
      return rows.flatMap(({ event_json }) => {
        const event = JSON.parse(event_json) as Readonly<Record<string, unknown>>;
        if (event.type !== 'run.error') return [];
        const failure =
          event.failure && typeof event.failure === 'object' && !Array.isArray(event.failure)
            ? (event.failure as Readonly<Record<string, unknown>>)
            : undefined;
        const outcome =
          event.outcome && typeof event.outcome === 'object' && !Array.isArray(event.outcome)
            ? (event.outcome as Readonly<Record<string, unknown>>)
            : undefined;
        return [
          {
            type: event.type,
            ...(typeof failure?.kind === 'string' ? { failureKind: failure.kind } : {}),
            ...(typeof failure?.code === 'string' ? { failureCode: failure.code } : {}),
            ...(typeof outcome?.reasonCode === 'string'
              ? { outcomeReasonCode: outcome.reasonCode }
              : {}),
            ...(typeof outcome?.recoveryEntry === 'string'
              ? { recoveryEntry: outcome.recoveryEntry }
              : {}),
          },
        ];
      });
    } finally {
      database.close(false);
    }
  } catch {
    return [];
  }
}

function completionDiagnostics(sessionId: string): readonly Readonly<Record<string, unknown>>[] {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      return database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId)
        .flatMap(({ event_json }) => {
          const event = JSON.parse(event_json) as Readonly<Record<string, unknown>>;
          if (event.type !== 'completion.blocked') return [];
          return [
            {
              type: event.type,
              ...(typeof event.nextAction === 'string' ? { nextAction: event.nextAction } : {}),
              ...(Array.isArray(event.backgroundTaskIds)
                ? { backgroundTaskCount: event.backgroundTaskIds.length }
                : {}),
            },
          ];
        });
    } finally {
      database.close(false);
    }
  } catch {
    return [];
  }
}

function afterTurnContinuationRunId(sessionId: string, originRunId: string): string | undefined {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      const candidates = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId)
        .flatMap(({ event_json }) => {
          const event = JSON.parse(event_json) as Readonly<Record<string, unknown>>;
          if (
            event.type !== 'subagent.background_result_persisted' ||
            event.originRunId !== originRunId ||
            !event.afterTurn ||
            typeof event.afterTurn !== 'object' ||
            Array.isArray(event.afterTurn)
          ) {
            return [];
          }
          const runId = (event.afterTurn as Readonly<Record<string, unknown>>).runId;
          return typeof runId === 'string' ? [runId] : [];
        });
      return [...new Set(candidates)].length === 1 ? candidates[0] : undefined;
    } finally {
      database.close(false);
    }
  } catch {
    return undefined;
  }
}

function afterTurnLineageDiagnostics(
  sessionId: string,
  originRunId: string,
): Readonly<Record<string, number>> {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      const events = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId)
        .map(({ event_json }) => JSON.parse(event_json) as Readonly<Record<string, unknown>>)
        .filter((event) => event.type === 'subagent.background_result_persisted');
      const originMatches = events.filter((event) => event.originRunId === originRunId);
      const continuationIdentities = originMatches.filter(
        (event) =>
          event.afterTurn &&
          typeof event.afterTurn === 'object' &&
          !Array.isArray(event.afterTurn) &&
          typeof (event.afterTurn as Readonly<Record<string, unknown>>).runId === 'string',
      );
      return {
        persistedResults: events.length,
        originMatches: originMatches.length,
        continuationIdentities: continuationIdentities.length,
      };
    } finally {
      database.close(false);
    }
  } catch {
    return {};
  }
}

function modelUsageDiagnostics(sessionId: string): Readonly<Record<string, unknown>> {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      const reservationRows = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId);
      const inputUpperBounds = reservationRows.flatMap(({ event_json }) => {
        const event = JSON.parse(event_json) as {
          readonly type?: unknown;
          readonly reservation?: {
            readonly executableUpperBound?: {
              readonly counters?: { readonly inputTokens?: unknown };
            };
          };
        };
        const value = event.reservation?.executableUpperBound?.counters?.inputTokens;
        return event.type === 'resource_budget.reserved' && typeof value === 'number'
          ? [value]
          : [];
      });
      const responseRows = database
        .query<{ canonical_json: string }, []>(
          "SELECT canonical_json FROM model_artifacts WHERE kind = 'model_response' ORDER BY created_at",
        )
        .all();
      const actualInputTokens = responseRows.flatMap(({ canonical_json }) => {
        const record = JSON.parse(canonical_json) as {
          readonly response?: { readonly usage?: { readonly inputTokens?: unknown } };
        };
        const value = record.response?.usage?.inputTokens;
        return typeof value === 'number' ? [value] : [];
      });
      const surfaceRows = database
        .query<{ canonical_json: string }, []>(
          "SELECT canonical_json FROM model_artifacts WHERE kind = 'model_surface' ORDER BY created_at",
        )
        .all();
      const toolNamesBySurface = surfaceRows.map(({ canonical_json }) => {
        const surface = JSON.parse(canonical_json) as {
          readonly request?: { readonly tools?: readonly { readonly name?: unknown }[] };
        };
        return (surface.request?.tools ?? []).flatMap((tool) =>
          typeof tool.name === 'string' ? [tool.name] : [],
        );
      });
      return { inputUpperBounds, actualInputTokens, toolNamesBySurface };
    } finally {
      database.close(false);
    }
  } catch {
    return {};
  }
}

function subagentFailureDiagnostics(
  sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
  try {
    const database = new Database(join(configRoot, 'kite-session.sqlite'), { readonly: true });
    try {
      const rows = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId);
      const eventDiagnostics = rows.flatMap(({ event_json }) => {
        const event = JSON.parse(event_json) as Readonly<Record<string, unknown>>;
        if (event.type === 'subagent.background_result_persisted') {
          const afterTurn =
            event.afterTurn &&
            typeof event.afterTurn === 'object' &&
            !Array.isArray(event.afterTurn)
              ? (event.afterTurn as Readonly<Record<string, unknown>>)
              : undefined;
          return [
            {
              type: event.type,
              ...(typeof afterTurn?.status === 'string' ? { status: afterTurn.status } : {}),
            },
          ];
        }
        if (event.type === 'tool.failed') {
          const failure =
            event.failure && typeof event.failure === 'object' && !Array.isArray(event.failure)
              ? (event.failure as Readonly<Record<string, unknown>>)
              : undefined;
          return [
            {
              type: event.type,
              ...(typeof failure?.kind === 'string' ? { failureKind: failure.kind } : {}),
              ...(typeof failure?.code === 'string' ? { failureCode: failure.code } : {}),
            },
          ];
        }
        if (event.type !== 'subagent.failed') return [];
        const subagent =
          event.subagent && typeof event.subagent === 'object' && !Array.isArray(event.subagent)
            ? (event.subagent as Readonly<Record<string, unknown>>)
            : undefined;
        const diagnostic =
          subagent?.diagnostic &&
          typeof subagent.diagnostic === 'object' &&
          !Array.isArray(subagent.diagnostic)
            ? (subagent.diagnostic as Readonly<Record<string, unknown>>)
            : undefined;
        return [
          {
            type: event.type,
            ...(typeof subagent?.status === 'string' ? { status: subagent.status } : {}),
            ...(typeof diagnostic?.code === 'string' ? { failureCode: diagnostic.code } : {}),
            ...(typeof diagnostic?.stage === 'string' ? { failureStage: diagnostic.stage } : {}),
          },
        ];
      });
      const artifactDiagnostics = database
        .query<{ canonical_json: string }, []>(
          "SELECT canonical_json FROM subagent_task_artifacts WHERE kind = 'subagent_task' ORDER BY created_at",
        )
        .all()
        .flatMap(({ canonical_json }) => {
          const artifact = JSON.parse(canonical_json) as {
            readonly result?: Readonly<Record<string, unknown>>;
          };
          const result = artifact.result;
          if (result?.ok !== false) return [];
          const diagnostic =
            result.failureDiagnostic &&
            typeof result.failureDiagnostic === 'object' &&
            !Array.isArray(result.failureDiagnostic)
              ? (result.failureDiagnostic as Readonly<Record<string, unknown>>)
              : undefined;
          return [
            {
              type: 'subagent.result_artifact',
              ...(typeof result.terminalStatus === 'string'
                ? { status: result.terminalStatus }
                : {}),
              ...(typeof diagnostic?.code === 'string' ? { failureCode: diagnostic.code } : {}),
              ...(typeof diagnostic?.stage === 'string' ? { failureStage: diagnostic.stage } : {}),
            },
          ];
        });
      return [...eventDiagnostics, ...artifactDiagnostics];
    } finally {
      database.close(false);
    }
  } catch {
    return [];
  }
}

let connection: Connection | undefined;
const suiteDeadline = setTimeout(() => {
  process.stderr.write(`DeepSeek background suite exceeded ${LIVE_TIMEOUT_MS}ms.\n`);
  const emergencyReleases = [
    ...(requiredGateACreated && !requiredGateAReleased
      ? [releaseEventGate(requiredGateA, 'cleanup')]
      : []),
    ...(requiredGateBCreated && !requiredGateBReleased
      ? [releaseEventGate(requiredGateB, 'cleanup')]
      : []),
    ...(afterTurnGateCreated && !afterTurnGateReleased
      ? [releaseEventGate(afterTurnGate, 'cleanup')]
      : []),
  ];
  void Promise.race([connection?.close() ?? Promise.resolve(), Bun.sleep(5_000)]).finally(() => {
    for (const release of emergencyReleases) release.kill();
    process.exit(1);
  });
}, LIVE_TIMEOUT_MS + 10_000);

try {
  await assertRequestedModelAvailable();
  mkdirSync(configRoot, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, 'probe-a.txt'), 'session-a-child-marker\n', { mode: 0o600 });
  writeFileSync(join(workspace, 'probe-b.txt'), 'session-b-marker\n', { mode: 0o600 });
  createEventGate(requiredGateA);
  requiredGateACreated = true;
  createEventGate(requiredGateB);
  requiredGateBCreated = true;
  createEventGate(afterTurnGate);
  afterTurnGateCreated = true;
  writeFileSync(
    startupInjection,
    `printf 'unexpected startup injection\\n' >&2\ntouch '${startupMarker}'\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configRoot, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        [PROVIDER]: {
          type: 'deepseek',
          apiKey,
          baseURL,
          model: MODEL,
          models: [{ name: MODEL, contextWindow: 131_072, maxOutputTokens: 4_096 }],
        },
      },
      model: { default: { provider: PROVIDER, name: MODEL } },
      interactionMode: 'full',
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

  connection = openConnection('first');
  await connection.prepareAppControl();

  const revisionA = await createSession(connection, sessionA);
  await startTurn(
    connection,
    sessionA,
    revisionA,
    [
      'This is a deterministic live E2E for required background delegation.',
      'The built-in task tool is directly disclosed in your tool schema. In one response, dispatch exactly two independent explore task calls with background=true and result_disposition="required". Do not call tool_search, task_read, or any other parent tool.',
      'Task A must make exactly one shell_execute call with the read-only command `head -n 1 required-gate-a`, then report the gate marker after that command returns. The path is a FIFO, so do not substitute read_file.',
      'Task B must make exactly one shell_execute call with the read-only command `head -n 1 required-gate-b`, then report the gate marker after that command returns. The path is a FIFO, so do not substitute read_file.',
      'After dispatching, do not poll, sleep, or finish early. Let Runtime wait for both required results, then reply exactly: session-a-completed',
    ].join('\n'),
  );

  let waitingA: Awaited<ReturnType<typeof projection>> | undefined;
  await waitFor('Session A required background waiting admission', async () => {
    await settlePendingInteraction(connection!, sessionA);
    const candidate = await projection(connection!, sessionA);
    if (
      candidate.currentRun?.status === 'failed' ||
      candidate.currentRun?.status === 'cancelled' ||
      candidate.currentRun?.status === 'recovery_required'
    ) {
      throw new Error(`Session A terminated before required background waiting admission.`);
    }
    const executions = await background(connection!, sessionA);
    if (
      executions.some((execution) => execution.kind === 'subagent' && execution.status === 'failed')
    ) {
      throw new Error('Session A subagent failed before required background waiting admission.');
    }
    if (
      executions.filter((execution) => execution.kind === 'subagent').length >= 2 &&
      executions
        .filter((execution) => execution.kind === 'subagent')
        .every((execution) => execution.status !== 'running')
    ) {
      throw new Error(
        'Session A subagents terminated before required background waiting admission.',
      );
    }
    if (
      candidate.currentRun?.status === 'waiting' &&
      candidate.currentRun.waitingReason?.kind === 'required_background' &&
      candidate.currentRun.waitingReason.taskIds.length === 2 &&
      executions.filter(
        (execution) => execution.kind === 'subagent' && execution.status === 'running',
      ).length === 2
    ) {
      waitingA = candidate;
      return true;
    }
    return false;
  }).catch(async (error) => {
    const executions = await background(connection!, sessionA).catch(() => []);
    const session = await projection(connection!, sessionA).catch(() => undefined);
    const history = await connection!.history.loadSession(sessionA).catch(() => undefined);
    const rawRunErrors = rawRunErrorDiagnostics(sessionA);
    const completionFacts = completionDiagnostics(sessionA);
    const modelUsage = modelUsageDiagnostics(sessionA);
    const subagentFailures = subagentFailureDiagnostics(sessionA);
    const facts = history ? eventCardinality(eventsOf(history)) : {};
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} run=${JSON.stringify(runDiagnostic(session?.currentRun))} executions=${JSON.stringify(executionDiagnostics(executions))} events=${JSON.stringify(facts)} rawRunErrors=${JSON.stringify(rawRunErrors)} completionFacts=${JSON.stringify(completionFacts)} modelUsage=${JSON.stringify(modelUsage)} subagentFailures=${JSON.stringify(subagentFailures)}`,
    );
  });
  assert.ok(waitingA?.currentRun, 'Session A waiting projection was not captured.');

  const initialAHistory = await connection.history.loadSession(sessionA);
  const initialAEvents = eventsOf(initialAHistory);
  const requiredCalls = queuedTasks(initialAEvents);
  assert.equal(requiredCalls.length, 2, 'Required scenario did not establish two task calls.');
  for (const call of requiredCalls) {
    assert.equal(call.arguments.background, true);
    assert.equal(call.arguments.result_disposition, 'required');
  }
  assert.equal(
    new Set(waitingA.currentRun.waitingReason?.taskIds).size,
    2,
    'Required waiting identities were not distinct.',
  );
  const waitingRunId = waitingA.currentRun.runId;
  const requiredRequestBaseline = rootModelRequestCount(initialAEvents);
  const requiredReadBaseline = taskReadCount(initialAEvents);

  const revisionB = await createSession(connection, sessionB);
  await startTurn(
    connection,
    sessionB,
    revisionB,
    'Read probe-b.txt with read_file and then reply exactly: session-b-interacted',
  );
  await waitForRunTerminal(connection, sessionB);

  const stillWaitingA = await projection(connection, sessionA);
  assert.equal(stillWaitingA.currentRun?.runId, waitingRunId);
  if (stillWaitingA.currentRun?.status !== 'waiting') {
    throw new Error(
      `Session A left managed waiting while Session B ran. run=${JSON.stringify(runDiagnostic(stillWaitingA.currentRun))} executions=${JSON.stringify(executionDiagnostics(await background(connection, sessionA)))} rawRunErrors=${JSON.stringify(rawRunErrorDiagnostics(sessionA))} completionFacts=${JSON.stringify(completionDiagnostics(sessionA))} subagentFailures=${JSON.stringify(subagentFailureDiagnostics(sessionA))}`,
    );
  }
  const quietAEvents = eventsOf(await connection.history.loadSession(sessionA));
  assert.equal(rootModelRequestCount(quietAEvents), requiredRequestBaseline);
  assert.equal(taskReadCount(quietAEvents), requiredReadBaseline);

  const requiredReleaseA = releaseEventGate(requiredGateA, 'required-a-released');
  const requiredReleaseB = releaseEventGate(requiredGateB, 'required-b-released');
  await Promise.all([requiredReleaseA.exited, requiredReleaseB.exited]);
  requiredGateAReleased = true;
  requiredGateBReleased = true;
  await waitForRunTerminal(connection, sessionA);

  const historyB = await connection.history.loadSession(sessionB);
  const eventsB = eventsOf(historyB);
  assert.ok(
    eventsB.some((event) => event.type === 'tool.finished' && event.toolName === 'read_file'),
    'Session B did not finish read_file.',
  );
  assert.ok(includesEvent(eventsB, 'model.responded'), 'Session B has no model response.');
  assert.equal(responseTexts(eventsB).at(-1), 'session-b-interacted');
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

  await waitFor('Session A required subagent durable terminal events', async () => {
    const events = eventsOf(await connection!.history.loadSession(sessionA));
    return events.filter((event) => event.type === 'subagent.completed').length === 2;
  });

  // Hot re-entry: load A again after B was selected and completed, without restarting the Service.
  const reenteredA = await connection.history.loadSession(sessionA);
  const reenteredAEvents = eventsOf(reenteredA);
  assert.equal(await Bun.file(startupMarker).exists(), false);
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
  assert.equal(responseTexts(reenteredAEvents).at(-1), 'session-a-completed');
  const requiredChildSummaries = reenteredAEvents.flatMap((event) =>
    event.type === 'subagent.completed' ? [event.summary] : [],
  );
  assert.ok(requiredChildSummaries.some((summary) => summary.includes('required-a-released')));
  assert.ok(requiredChildSummaries.some((summary) => summary.includes('required-b-released')));
  assert.deepEqual(
    queuedShellCommands(reenteredAEvents)
      .filter((command) => command.includes('required-gate-'))
      .sort(),
    ['head -n 1 required-gate-a', 'head -n 1 required-gate-b'],
  );

  const revisionC = await createSession(connection, sessionC);
  await startTurn(
    connection,
    sessionC,
    revisionC,
    [
      'This is a deterministic live E2E for authorized after-turn delivery.',
      'Dispatch exactly one explore task with background=true and result_disposition="after_turn". The child must make exactly one shell_execute call with the read-only command `head -n 1 after-turn-gate`, then report the gate marker after it returns. The path is a FIFO, so do not substitute read_file.',
      'After the task is accepted, complete this Run without task_read, sleep, or waiting and reply exactly: session-c-accepted',
    ].join('\n'),
  );
  await waitFor('Session C origin Run completed before child terminal', async () => {
    await settlePendingInteraction(connection!, sessionC);
    const candidate = await projection(connection!, sessionC);
    const executions = await background(connection!, sessionC);
    return (
      candidate.currentRun?.status === 'completed' &&
      executions.some(
        (execution) => execution.kind === 'subagent' && execution.status === 'running',
      )
    );
  });
  const afterTurnOrigin = await projection(connection, sessionC);
  assert.ok(afterTurnOrigin.currentRun, 'After-turn origin Run was not projected.');
  const afterTurnOriginRunId = afterTurnOrigin.currentRun.runId;
  const afterTurnOriginEvents = eventsOf(await connection.history.loadSession(sessionC));
  const afterTurnCalls = queuedTasks(afterTurnOriginEvents);
  assert.equal(afterTurnCalls.length, 1, 'After-turn scenario did not establish one task call.');
  assert.equal(afterTurnCalls[0]?.arguments.background, true);
  assert.equal(afterTurnCalls[0]?.arguments.result_disposition, 'after_turn');
  assert.equal(taskReadCount(afterTurnOriginEvents), 0);

  const afterTurnRelease = releaseEventGate(afterTurnGate, 'after-turn-released');
  await afterTurnRelease.exited;
  afterTurnGateReleased = true;
  let afterTurnContinuationId: string | undefined;
  await waitFor(
    'one after-turn continuation Run',
    async () => {
      const expectedRunId = afterTurnContinuationRunId(sessionC, afterTurnOriginRunId);
      if (!expectedRunId) return false;
      const runs = await listRuns(connection!, sessionC);
      const continuations = runs.filter((run) => run.runId !== afterTurnOriginRunId);
      if (continuations.length !== 1 || continuations[0]?.runId !== expectedRunId) return false;
      afterTurnContinuationId = expectedRunId;
      return true;
    },
    Math.min(LIVE_TIMEOUT_MS, 180_000),
  ).catch(async (error) => {
    const runs = await listRuns(connection!, sessionC).catch(() => []);
    const session = await projection(connection!, sessionC).catch(() => undefined);
    const executions = await background(connection!, sessionC).catch(() => []);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} run=${JSON.stringify(runDiagnostic(session?.currentRun))} runs=${JSON.stringify(runPageDiagnostics(runs))} executions=${JSON.stringify(executionDiagnostics(executions))} lineage=${JSON.stringify(afterTurnLineageDiagnostics(sessionC, afterTurnOriginRunId))} rawRunErrors=${JSON.stringify(rawRunErrorDiagnostics(sessionC))} completionFacts=${JSON.stringify(completionDiagnostics(sessionC))} subagentFailures=${JSON.stringify(subagentFailureDiagnostics(sessionC))}`,
    );
  });
  await waitForRunTerminal(connection, sessionC);
  const afterTurnRuns = await listRuns(connection, sessionC);
  const continuations = afterTurnRuns.filter((run) => run.runId !== afterTurnOriginRunId);
  assert.ok(afterTurnContinuationId, 'After-turn continuation identity was not persisted.');
  assert.equal(
    continuations.length,
    1,
    'After-turn result created more than one continuation Run.',
  );
  assert.equal(continuations[0]?.status, 'completed');
  assert.equal(continuations[0]?.runId, afterTurnContinuationId);
  assert.equal(
    afterTurnRuns.find((run) => run.runId === afterTurnOriginRunId)?.status,
    'completed',
  );
  const finalAfterTurnEvents = eventsOf(await connection.history.loadSession(sessionC));
  assert.ok(responseTexts(finalAfterTurnEvents).includes('session-c-accepted'));
  assert.ok(
    finalAfterTurnEvents.some(
      (event) =>
        event.type === 'subagent.completed' && event.summary.includes('after-turn-released'),
    ),
    'The after-turn child result did not preserve its gate marker.',
  );
  assert.deepEqual(
    queuedShellCommands(finalAfterTurnEvents).filter((command) =>
      command.includes('after-turn-gate'),
    ),
    ['head -n 1 after-turn-gate'],
  );
  assert.equal(settledInteractions.size, 0, 'The deterministic scenario requested an interaction.');

  assert.deepEqual((await projection(connection, sessionA)).model, {
    provider: PROVIDER,
    name: MODEL,
  });
  assert.deepEqual((await projection(connection, sessionB)).model, {
    provider: PROVIDER,
    name: MODEL,
  });
  assert.deepEqual((await projection(connection, sessionC)).model, {
    provider: PROVIDER,
    name: MODEL,
  });

  console.log(
    JSON.stringify({
      ok: true,
      provider: PROVIDER,
      model: MODEL,
      seed: null,
      scenarios: [
        'required-background-managed-wait-with-zero-parent-polling',
        'switch-to-session-b-and-interact-while-a-waits',
        'session-a-and-b-isolation',
        'authorized-after-turn-exactly-one-continuation',
        'hot-reentry-history-projection',
      ],
      redactedTrace: {
        required: {
          taskCalls: requiredCalls.length,
          waitingTaskCount: waitingA.currentRun.waitingReason?.taskIds.length,
          modelRequestsAtWaitingAdmission: requiredRequestBaseline,
          modelRequestsBeforeRelease: rootModelRequestCount(quietAEvents),
          taskReadsAtWaitingAdmission: requiredReadBaseline,
          taskReadsBeforeRelease: taskReadCount(quietAEvents),
          runIdentityPreserved: stillWaitingA.currentRun?.runId === waitingRunId,
        },
        afterTurn: {
          taskCalls: afterTurnCalls.length,
          originCompletedBeforeChildTerminal: true,
          originTaskReads: taskReadCount(afterTurnOriginEvents),
          continuationRuns: continuations.length,
        },
        isolation: {
          sessionBModelResponses: eventsB.filter((event) => event.type === 'model.responded')
            .length,
          sessionBSubagentEvents: eventsB.filter((event) => event.type === 'subagent.started')
            .length,
        },
      },
    }),
  );
} finally {
  clearTimeout(suiteDeadline);
  const cleanupReleases = [
    ...(requiredGateACreated && !requiredGateAReleased
      ? [releaseEventGate(requiredGateA, 'cleanup')]
      : []),
    ...(requiredGateBCreated && !requiredGateBReleased
      ? [releaseEventGate(requiredGateB, 'cleanup')]
      : []),
    ...(afterTurnGateCreated && !afterTurnGateReleased
      ? [releaseEventGate(afterTurnGate, 'cleanup')]
      : []),
  ];
  await connection?.close().catch(() => undefined);
  for (const cleanupRelease of cleanupReleases) {
    cleanupRelease.kill();
    await cleanupRelease.exited.catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true });
}
