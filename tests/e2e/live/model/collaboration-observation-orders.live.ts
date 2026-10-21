import { Database } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = [
  'A02-wait-first',
  'A02-other-work-completed-before-wait',
  'C02-identical-new-invocations',
] as const;
export type LiveObservationOrderCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveObservationOrderCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function wait(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(Error('live_observation_order_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
/** Explicit isolated artifact only. The common live runner owns credentials, HTTP and 40/600s budgets. */
export async function runLiveObservationOrders(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_observation_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-observation-order-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const childFact = `verified-child-${randomUUID()}`;
    const parentFact = `verified-parent-${randomUUID()}`;
    writeFileSync(join(workspace, 'child.txt'), `${childFact}\n`, { mode: 0o600 });
    writeFileSync(join(workspace, 'parent.txt'), `${parentFact}\n`, { mode: 0o600 });
    const assignment =
      'Use read_order_material exactly once with material child. Report its complete actual fact verbatim, then finish. Never delegate, send messages, mutate files or use control tools.';
    const checks: Result['checks'] = {};
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    const firstRequest = options.requests().length;
    const childReady = gate(),
      childRelease = gate(),
      replayRelease = gate();
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    type OwnedStore = Awaited<ReturnType<typeof openSqliteStore>>;
    type EnsureInput = Parameters<OwnedStore['ensureOperation']>[0];
    type Ref = Awaited<ReturnType<OwnedStore['ensureOperation']>>;
    const spawns: { input: EnsureInput; ref: Ref }[] = [];
    const childAdapterEntries = new Set<string>();
    const heldChildRequestIds = new Set<string>();
    const childReads = new Map<string, { runId: string; executionId: string; count: number }>();
    let parentReadExecutionId: string | undefined;
    let parentReads = 0,
      parentReadActive = false,
      parentReadDone = false,
      childAborts = 0;
    let replayDone = false,
      replayRunning = false,
      waitGateObserved = false;
    let firstSnapshotObserved = false,
      eventCalls = 0,
      hostWaits = 0;
    type EventScope = {
      executionId: string;
      sessionId: string;
      positiveFiniteWait: boolean;
      emptyPageObserved: boolean;
      firstExecution: boolean;
      hostWaits: number;
    };
    const eventScope = new AsyncLocalStorage<EventScope>();
    let eventExecutions = 0;
    let firstCompletedExecutionReturned = false;
    let firstCompletedExecutionWaits: number | undefined;
    let replayFailure: Boundary | undefined;
    let retained = false;
    const assert = (condition: unknown, point: string) => {
      checks[point] = Boolean(condition);
      if (!condition) throw new Boundary('oracle_violation', point);
    };
    const requireBranch = (condition: unknown, point: string) => {
      if (!condition) throw new Boundary('branch_not_reached', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      const end = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 15)), options.signal);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const sessionSnapshot = () => {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return db.query('SELECT id,parent_id,root_id FROM session ORDER BY id').all();
        } finally {
          db.close();
        }
      };
      const canonicalIdentitySnapshot = () => {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return Object.fromEntries(
            ['command', 'execution', 'run', 'context_snapshot'].map((table) => [
              table,
              db.query(`SELECT id FROM ${table} ORDER BY id`).all(),
            ]),
          );
        } finally {
          db.close();
        }
      };
      const resultSourceCount = (executionId: string) => {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM context_snapshot WHERE kind='result_ref' AND execution_id=?",
            )
            .get(executionId)!.count;
        } finally {
          db.close();
        }
      };
      const fullIdentitySnapshot = async () => ({
        canonicalIdentities: canonicalIdentitySnapshot(),
        cursor: (await owned.getMetadata()).lastChangeCursor,
        sessions: sessionSnapshot(),
        rootRuns: (await owned.getView('root')).runs.map((run) => run.id).sort(),
        carriers: (await owned.listExecutions('root'))
          .filter((row) => row.childSessionId)
          .map((row) => row.id)
          .sort(),
        childRuns: await Promise.all(
          spawns.map(async ({ ref }) => ({
            sessionId: ref.childSessionId,
            runs: (await owned.getView(ref.childSessionId!)).runs.map((run) => run.id).sort(),
          })),
        ),
        providerRequests: options.requests().length,
      });
      const originalEnsure = owned.ensureOperation.bind(owned);
      owned.ensureOperation = async (input) => {
        const ref = await originalEnsure(input);
        if (
          input.sessionId === 'root' &&
          input.collaborationCompletion &&
          !spawns.some((entry) => entry.input.parentExecutionId === input.parentExecutionId)
        ) {
          spawns.push({ input: structuredClone(input), ref: structuredClone(ref) });
        }
        return ref;
      };
      const issuedSpawnCalls = async () =>
        (await owned.listExecutions('root'))
          .filter((row) => row.kind === 'model' && row.status === 'succeeded')
          .flatMap((row) => {
            const calls = object(row.result).toolCalls;
            return Array.isArray(calls)
              ? calls
                  .map(object)
                  .filter(
                    (call) =>
                      call.name === 'task.spawn' && object(call.model).name === 'spawn_agent',
                  )
              : [];
          });
      const originalEvents = owned.listAgentEvents.bind(owned);
      owned.listAgentEvents = async (input) => {
        const scope = eventScope.getStore();
        if (
          input.sessionId !== 'root' ||
          input.extensionId !== 'builtin.task' ||
          scope?.sessionId !== 'root'
        )
          return originalEvents(input);
        if (id === 'A02-wait-first') await wait(childReady.promise, options.signal);
        const current = await owned.getExecution(scope.executionId);
        requireBranch(
          current?.definitionId === 'task.events' &&
            ['dispatching', 'running'].includes(current.status),
          'exact_original_parent_event_tool_not_active',
        );
        const positiveFiniteWait = scope.positiveFiniteWait;
        eventCalls++;
        if (
          id === 'A02-other-work-completed-before-wait' &&
          scope.firstExecution &&
          eventCalls === 1
        ) {
          requireBranch(spawns.length === 1, 'original_spawn_not_available_at_first_wait');
          assert(parentReadDone, 'actual_parent_other_work_precedes_first_wait');
          assert(
            (await owned.getExecution(spawns[0]!.ref.executionId!))?.status === 'succeeded',
            'child_carrier_terminal_before_first_mailbox_snapshot',
          );
          requireBranch(positiveFiniteWait, 'model_did_not_choose_positive_finite_wait');
        }
        const page = await originalEvents(input);
        scope.emptyPageObserved = page.events.length === 0;
        if (
          id === 'A02-other-work-completed-before-wait' &&
          scope.firstExecution &&
          eventCalls === 1
        ) {
          assert(
            page.events.some(
              (event) =>
                event.agentId === spawns[0]!.ref.childSessionId &&
                event.kind === 'completed' &&
                event.outcome === 'succeeded',
            ),
            'first_durable_snapshot_contains_original_completed_event',
          );
          firstSnapshotObserved = true;
        }
        if (id === 'A02-wait-first' && page.events.length === 0 && !waitGateObserved) {
          requireBranch(
            spawns.length === 1 && childReads.size === 1,
            'original_child_read_not_held_before_wait',
          );
          assert(
            (await owned.getExecution(spawns[0]!.ref.executionId!))?.status === 'running',
            'original_child_still_active_at_empty_mailbox',
          );
        }
        return page;
      };
      const reader: ToolDefinition = {
        id: 'live.order-material',
        version: '1',
        model: { name: 'read_order_material' },
        description:
          'Read an actual complete owned synthetic material. child is child-only. parent is root-only and may take time; never cancel or replace a pending read.',
        inputSchema: {
          type: 'object',
          properties: { material: { type: 'string', enum: ['child', 'parent'] } },
          required: ['material'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const material = object(input).material;
          if (
            material === 'parent' &&
            context.sessionId === 'root' &&
            id === 'A02-other-work-completed-before-wait'
          ) {
            parentReads++;
            parentReadExecutionId = context.executionId;
            parentReadActive = true;
            const content = readFileSync(join(workspace, 'parent.txt'), 'utf8');
            await wait(childReady.promise, AbortSignal.any([options.signal, context.signal]));
            assert(eventCalls === 0, 'parent_other_work_started_before_any_wait');
            assert(
              spawns.length === 1 &&
                (await owned.getExecution(spawns[0]!.ref.executionId!))?.status === 'running',
              'child_is_actually_active_while_parent_does_other_work',
            );
            childRelease.release();
            await until(
              async () =>
                (await owned.getExecution(spawns[0]!.ref.executionId!))?.status === 'succeeded'
                  ? true
                  : undefined,
              'child_not_terminal_during_other_work',
            );
            parentReadActive = false;
            parentReadDone = true;
            return { outcome: 'succeeded', content };
          }
          if (material !== 'child' || context.sessionId === 'root' || !context.runId)
            return { outcome: 'failed', content: 'invalid_owned_material_scope' };
          const prior = childReads.get(context.sessionId);
          childReads.set(context.sessionId, {
            runId: context.runId,
            executionId: context.executionId,
            count: (prior?.count ?? 0) + 1,
          });
          childReady.release();
          if (id !== 'C02-identical-new-invocations') {
            try {
              await wait(childRelease.promise, AbortSignal.any([options.signal, context.signal]));
            } catch (error) {
              if (context.signal.aborted) childAborts++;
              throw error;
            }
          }
          return {
            outcome: 'succeeded',
            content: readFileSync(join(workspace, 'child.txt'), 'utf8'),
          };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          const signal = AbortSignal.any([options.signal, context.signal]);
          const execution = await owned.getExecution(request.requestId);
          if (id === 'C02-identical-new-invocations' && !replayDone) {
            if (execution?.sessionId && execution.sessionId !== 'root') {
              childAdapterEntries.add(execution.sessionId);
              heldChildRequestIds.add(request.requestId);
              await wait(replayRelease.promise, signal);
            } else if (
              execution?.sessionId === 'root' &&
              !replayRunning &&
              (await issuedSpawnCalls()).length >= 2
            ) {
              replayRunning = true;
              try {
                const issued = await issuedSpawnCalls();
                requireBranch(
                  issued.length === 2,
                  'model_did_not_make_exactly_two_spawn_invocations',
                );
                // Canonical arguments use internal names; model is presentation metadata,
                // not a second response body. A prompt-only object has no renamed key.
                let canonicalInputs: Record<string, unknown>[];
                try {
                  canonicalInputs = issued.map((call) =>
                    object(JSON.parse(String(call.arguments))),
                  );
                } catch {
                  throw new Boundary(
                    'branch_not_reached',
                    'model_spawn_arguments_are_not_valid_json',
                  );
                }
                requireBranch(
                  canonicalInputs.every(
                    (input) => Object.keys(input).length === 1 && typeof input.prompt === 'string',
                  ) &&
                    canonicalInputs[0]!.prompt === canonicalInputs[1]!.prompt &&
                    issued[0]!.arguments === issued[1]!.arguments,
                  'model_calls_are_not_identical_prompt_only_inputs',
                );
                assert(
                  spawns.length === 2,
                  'two_actual_model_calls_reach_two_original_invocations',
                );
                const prompts = spawns.map(
                  ({ input }) =>
                    object(input.request.kind === 'agent' ? input.request.input : {}).content,
                );
                requireBranch(
                  typeof prompts[0] === 'string' && prompts[0] === prompts[1],
                  'two_new_invocations_do_not_have_identical_prompt_bytes',
                );
                const tools = (await owned.listExecutions('root')).filter(
                  (row) => row.definitionId === 'task.spawn',
                );
                requireBranch(
                  tools.every(
                    (tool) =>
                      Object.keys(object(tool.input)).length === 1 &&
                      typeof object(tool.input).prompt === 'string',
                  ),
                  'new_spawn_calls_are_not_prompt_only',
                );
                assert(
                  tools.length === 2 &&
                    tools.every((row) => row.status === 'succeeded') &&
                    new Set(tools.map((row) => row.id)).size === 2 &&
                    new Set(tools.map((row) => row.callId)).size === 2,
                  'two_real_distinct_model_spawn_calls_and_tool_executions',
                );
                assert(
                  new Set(spawns.map(({ input }) => input.operationKey)).size === 2 &&
                    new Set(spawns.map(({ ref }) => ref.commandId)).size === 2 &&
                    new Set(spawns.map(({ ref }) => ref.executionId)).size === 2 &&
                    new Set(spawns.map(({ ref }) => ref.childSessionId)).size === 2,
                  'identical_new_calls_have_distinct_command_carrier_and_child',
                );
                await until(
                  async () => (childAdapterEntries.size === 2 ? true : undefined),
                  'two_real_child_adapters_not_held',
                );
                assert(
                  heldChildRequestIds.size === 2 &&
                    options
                      .requests()
                      .every(
                        (seen) =>
                          !heldChildRequestIds.has(seen.requestId) &&
                          seen.requestId !== request.requestId,
                      ),
                  'two_child_and_parent_adapters_held_before_provider_forward',
                );
                const before = await fullIdentitySnapshot();
                const original = spawns[0]!;
                const repeat = await originalEnsure(original.input);
                assert(
                  isDeepStrictEqual(repeat, original.ref),
                  'original_invocation_replay_returns_exact_original_ref',
                );
                const command = await owned.getCommand(original.ref.commandId);
                assert(
                  command?.id === original.ref.commandId,
                  'original_command_read_returns_original_identity',
                );
                const after = await fullIdentitySnapshot();
                assert(
                  isDeepStrictEqual(after, before),
                  'exact_replay_and_command_read_zero_cursor_identity_or_provider_change',
                );
                replayDone = true;
                replayRelease.release();
              } catch (error) {
                if (error instanceof Boundary) replayFailure = error;
                throw error;
              }
            }
          }
          for await (const event of options.model.stream(request, { signal })) yield event;
        },
      };
      const taskExtension = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description: 'Finite actual owned material reader.',
          },
        ],
      });
      const eventTool = taskExtension.tools!.find((tool) => tool.id === 'task.events')!;
      const originalExecuteEvents = eventTool.execute;
      eventTool.execute = async function (input, context) {
        if (context.sessionId !== 'root') return originalExecuteEvents.call(this, input, context);
        const waitMs = object(input).waitMs;
        const scope: EventScope = {
          executionId: context.executionId,
          sessionId: context.sessionId,
          positiveFiniteWait: typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0,
          emptyPageObserved: false,
          firstExecution: ++eventExecutions === 1,
          hostWaits: 0,
        };
        return eventScope.run(scope, async () => {
          const result = await originalExecuteEvents.call(this, input, context);
          if (id === 'A02-other-work-completed-before-wait' && scope.firstExecution) {
            firstCompletedExecutionWaits = scope.hostWaits;
            firstCompletedExecutionReturned = result.outcome === 'succeeded';
            assert(scope.hostWaits === 0, 'first_completed_snapshot_execution_has_no_host_wait');
          }
          return result;
        });
      };
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        extensions: [
          { id: 'live.observation-order-fixture', version: '1', apiMajor: 1, tools: [reader] },
          taskExtension,
        ],
        permissions: {
          authorize: async () => ({ allowed: true, revision: 'owned-observation-order-only' }),
        },
        afterTurn: {
          authorize: async () => ({ allowed: true, revision: 'owned-observation-order-only' }),
        },
        childConfigurations: [
          {
            id: 'worker',
            version: '1',
            model,
            modelId: options.modelId,
            toolIds: [reader.id],
            snapshot: {},
          },
        ],
      });
      const waits = (
        runtime as unknown as {
          changeWaits: {
            wait(cursor: string, signal: AbortSignal, timeoutMs: number): Promise<unknown>;
          };
        }
      ).changeWaits;
      const originalWait = waits.wait;
      waits.wait = function (cursor, signal, timeoutMs) {
        const promise = originalWait.call(this, cursor, signal, timeoutMs);
        const scope = eventScope.getStore();
        if (scope?.sessionId === 'root') {
          scope.hostWaits++;
          hostWaits++;
          if (id === 'A02-wait-first' && scope.emptyPageObserved && !waitGateObserved) {
            requireBranch(scope.positiveFiniteWait, 'model_did_not_choose_positive_finite_wait');
            checks.actualParentWaitExecutionObserved = Boolean(scope.executionId);
            waitGateObserved = true;
            childRelease.release();
          }
        }
        return promise;
      };
      const serviceProfile = {
        dataRoot: realpathSync(profile.dataRoot),
        name: profile.profile,
        accessKey: resolveProfile(profile).profileAccessKey,
      };
      service = await startService({
        runtime,
        profile: serviceProfile,
        buildId: 'live-observation-orders',
        subjectId: 'live-order-owner',
      });
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: { profile: serviceProfile, apiMajor: 1, requiredCapabilities: ['commands'] },
      });
      await client.connect();
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned observation order',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Live observation order',
      });
      const order =
        id === 'C02-identical-new-invocations'
          ? `Make exactly TWO independent spawn_agent calls, with byte-identical JSON arguments objects containing exactly the prompt field. Omit task_name, taskName, preset, and every other field. Use the exact identical prompt bytes ${JSON.stringify(assignment)}. These are two genuinely new calls, not retries. Preserve both returned agent IDs. Then wait_agent_events and list_agents to obtain BOTH actual terminal complete results.`
          : `Make exactly ONE spawn_agent call with only prompt ${JSON.stringify(assignment)}. Preserve its exact returned agent_id. ${id === 'A02-other-work-completed-before-wait' ? 'Then use read_order_material with material parent exactly once before your FIRST wait_agent_events call. Never cancel the parent read; it can take time.' : 'Do no other work: wait for the child with wait_agent_events before its result exists.'} Use wait_agent_events with a finite positive wait_ms of 30000 and after_seq initially "0", then advance only to the actual returned next_seq. Even if the child result has already arrived, perform the requested wait observation. After observing completion, use list_agents on the exact original ID to obtain the complete result.`;
      await client.startRun(
        'root',
        {
          expectedStoreId,
          commandId: 'work',
          kind: 'run.start',
          content: `New task: ${order} Keep observing finite waits until the original child work is truly terminal. Do not spawn replacements, follow up, send messages, interrupt, retry mutations, modify files or invent facts. Finally report the complete actual child fact${id === 'A02-other-work-completed-before-wait' ? ' and complete actual parent material fact' : ''}.`,
        },
        { signal: options.signal },
      );
      if (id === 'A02-wait-first')
        await until(
          async () => (waitGateObserved ? true : undefined),
          'real_empty_mailbox_wait_gate_not_reached',
        );
      if (id === 'A02-other-work-completed-before-wait')
        await until(
          async () => (firstSnapshotObserved ? true : undefined),
          'completed_child_initial_snapshot_not_observed',
        );
      if (id === 'C02-identical-new-invocations')
        await until(async () => {
          if (replayFailure) throw replayFailure;
          return replayDone ? true : undefined;
        }, 'new_call_and_old_invocation_replay_not_completed');
      const expectedChildren = id === 'C02-identical-new-invocations' ? 2 : 1;
      const rootView = await until(async () => {
        const view = await owned.getView('root');
        const carriers = view.executions.filter((row) => row.childSessionId);
        return carriers.length === expectedChildren &&
          carriers.every((row) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status),
          ) &&
          view.runs.length > 0 &&
          view.runs.every((run) => !run.isActive) &&
          !view.executions.some((row) => ['planned', 'dispatching', 'running'].includes(row.status))
          ? view
          : undefined;
      }, 'original_parent_and_children_not_settled');
      const carriers = rootView.executions.filter((row) => row.childSessionId);
      assert(
        carriers.length === expectedChildren &&
          spawns.length === expectedChildren &&
          sessionSnapshot().length === expectedChildren + 1,
        'exact_expected_new_child_sessions_and_carriers',
      );
      assert(
        childReads.size === expectedChildren &&
          [...childReads.values()].every((read) => read.count === 1) &&
          childAborts === 0,
        'each_original_child_read_once_without_abort',
      );
      assert(
        parentReads === (id === 'A02-other-work-completed-before-wait' ? 1 : 0) &&
          !parentReadActive,
        'only_expected_parent_material_work',
      );
      assert(
        readFileSync(join(workspace, 'child.txt'), 'utf8') === `${childFact}\n` &&
          readFileSync(join(workspace, 'parent.txt'), 'utf8') === `${parentFact}\n`,
        'actual_owned_materials_unchanged',
      );
      if (id === 'A02-wait-first')
        assert(
          waitGateObserved && hostWaits >= 1,
          'wait_registered_before_original_child_completion',
        );
      if (id === 'A02-other-work-completed-before-wait')
        assert(
          firstSnapshotObserved &&
            firstCompletedExecutionReturned &&
            firstCompletedExecutionWaits === 0,
          'completed_result_found_in_snapshot_without_host_wait',
        );
      for (const carrier of carriers) {
        const childView = await owned.getView(carrier.childSessionId!);
        assert(
          carrier.status === 'succeeded' &&
            childView.runs.length === 1 &&
            childView.runs[0]?.status === 'completed',
          `original_child_completed_${carrier.childSessionId}`,
        );
        assert(
          String(object(carrier.result).content ?? '').includes(childFact),
          `actual_child_result_fact_${carrier.childSessionId}`,
        );
        const finalCarrier = await owned.getExecution(carrier.id);
        const acceptance = finalCarrier?.resultAcceptance;
        assert(
          resultSourceCount(carrier.id) === 1,
          `one_persisted_result_source_${carrier.childSessionId}`,
        );
        assert(
          acceptance?.resultRevision === finalCarrier?.resultRevision &&
            Boolean(acceptance?.sourceId) &&
            Boolean(acceptance?.runId),
          `exact_result_revision_acceptance_${carrier.childSessionId}`,
        );
        assert(
          (await owned.getRun(acceptance!.runId!))?.contextSelectionId === acceptance!.selectionId,
          `exact_acceptance_run_selection_${carrier.childSessionId}`,
        );
        let prepared = false;
        for (const request of options.requests().slice(firstRequest)) {
          const execution = await owned.getExecution(request.requestId);
          if (execution?.sessionId !== 'root' || execution.runId !== acceptance!.runId) continue;
          const messages = request.messages.filter((message) =>
            message.sourceIds?.includes(acceptance!.sourceId),
          );
          if (!messages.length) continue;
          assert(
            messages.reduce(
              (n, message) =>
                n +
                (message.sourceIds?.filter((sourceId) => sourceId === acceptance!.sourceId)
                  .length ?? 0),
              0,
            ) === 1,
            `exact_source_once_per_actual_model_${carrier.childSessionId}`,
          );
          if (messages.some((message) => message.content.includes(childFact))) prepared = true;
        }
        assert(prepared, `exact_source_and_fact_in_actual_parent_model_${carrier.childSessionId}`);
      }
      assert(
        new Set(carriers.map((carrier) => carrier.resultAcceptance?.sourceId)).size ===
          expectedChildren,
        'distinct_original_results_have_distinct_sources',
      );
      const eventTools = rootView.executions.filter(
        (row) => row.definitionId === 'task.events' && row.status === 'succeeded',
      );
      const listTools = rootView.executions.filter(
        (row) => row.definitionId === 'task.list' && row.status === 'succeeded',
      );
      assert(
        eventTools.length > 0 && listTools.length > 0,
        'actual_public_wait_and_directory_tools_succeeded',
      );
      assert(
        [...eventTools, ...listTools].every(
          (row) =>
            !Object.hasOwn(object(object(row.result).details), 'accepted') &&
            !Object.hasOwn(
              object(JSON.parse(String(object(row.result).content ?? '{}'))),
              'accepted',
            ),
        ),
        'readonly_observation_results_do_not_claim_accepted',
      );
      if (id === 'A02-other-work-completed-before-wait') {
        let parentPrepared = false;
        for (const request of options.requests().slice(firstRequest))
          if (
            (await owned.getExecution(request.requestId))?.sessionId === 'root' &&
            request.messages.some(
              (message) =>
                message.sourceIds?.includes(parentReadExecutionId!) &&
                message.content.includes(parentFact),
            )
          )
            parentPrepared = true;
        assert(
          parentReadExecutionId &&
            (await owned.getExecution(parentReadExecutionId))?.status === 'succeeded' &&
            parentPrepared,
          'actual_parent_model_prepared_with_other_work_material',
        );
      }
      const bad = Object.entries(checks).find(([, value]) => value === false);
      if (bad) throw new Boundary('oracle_violation', bad[0]);
      assert(
        options.requests().length - firstRequest > 0 &&
          options.requests().length - firstRequest <= 40,
        'counted_actual_adapter_requests_within_case_limit',
      );
      checks.hostWaitCalls = hostWaits;
      checks.mailboxScans = eventCalls;
      checks.parentEventExecutions = eventExecutions;
      if (firstCompletedExecutionWaits !== undefined)
        checks.firstCompletedExecutionHostWaits = firstCompletedExecutionWaits;
      checks.originalChildCount = expectedChildren;
      status = 'passed';
    } catch (error) {
      if (error instanceof Boundary) {
        reason = error.reason;
        failurePoint = error.point;
        status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
      } else {
        reason = 'execution_unavailable';
        failurePoint = options.signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
      }
      const bad = Object.entries(checks).find(([, value]) => value === false);
      if (bad) {
        status = 'failed';
        reason = 'oracle_violation';
        failurePoint = bad[0];
      }
    } finally {
      childReady.release();
      childRelease.release();
      replayRelease.release();
      let closed = true,
        runtimeClosed = false;
      try {
        client?.disposeNetwork();
      } catch {
        closed = false;
      }
      if (service) {
        try {
          await service.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      }
      if (!runtimeClosed && runtime) {
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      }
      if (!runtimeClosed && store) {
        try {
          await store.close();
        } catch {
          closed = false;
        }
      }
      checks.resourcesClosed = closed;
      if (!closed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      retained = Boolean(options.evidenceRoot) || status !== 'passed';
      if (!retained) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          retained = existsSync(root);
          status = 'failed';
          reason = 'cleanup_failed';
        }
      }
    }
    cases.push({
      id,
      status,
      checks,
      reason,
      failurePoint,
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: retained,
      coverage: [
        id === 'C02-identical-new-invocations'
          ? 'two_identical_prompt_new_model_invocations_vs_exact_original_store_replay'
          : id === 'A02-wait-first'
            ? 'actual_empty_mailbox_wait_precedes_child_completion'
            : 'actual_parent_other_work_and_completed_child_before_first_wait_snapshot',
        'actual_original_result_revision_source_and_parent_model_input',
        'owned_allow_fixture_not_default_policy_or_ordinary_window',
        'no_complete_contract58_error_or_network_failure_qualification',
      ],
    });
  }
  return { cases };
}
