import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { sampleSoakResources } from '../../../../scripts/runtime/unified-soak-cases';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { observeContextPreparation } from './live-context-prepare-evidence';
import { createLiveLoadModelFixture } from './live-load-model-fixture';

export const providerLoadCases = [
  'L01-real-provider-attached-cancel-isolation',
  'L02-real-provider-original-three-stages',
] as const;
type CaseId = (typeof providerLoadCases)[number];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
class Boundary extends Error {
  readonly point: string;
  readonly violation: boolean;
  constructor(point: string, violation = false) {
    super(point);
    this.point = point;
    this.violation = violation;
  }
}
/** Opt-in only; no import-time credential, configuration, network, or Model access. */
export async function runLiveProviderLoad(options: { caseId: CaseId; output: string }) {
  if (
    !providerLoadCases.includes(options.caseId) ||
    !isAbsolute(options.output) ||
    existsSync(options.output) ||
    existsSync(`${options.output}.workspace`)
  )
    throw Error('live_provider_load_arguments_invalid');
  const heavy = options.caseId.startsWith('L02');
  const budget = heavy ? 120 : 40;
  const root = `${options.output}.workspace`;
  mkdirSync(root, { mode: 0o700 });
  const code = liveCodeEvidence();
  const stages: Record<string, unknown>[] = [];
  let used = 0,
    allClosed = true;
  for (const spec of heavy
    ? [
        { roots: 4, children: 3, slots: 4 },
        { roots: 4, children: 3, slots: 16 },
        { roots: 8, children: 3, slots: 32 },
      ]
    : [{ roots: 2, children: 1, slots: 4 }]) {
    const stageRoot = join(root, `slots-${spec.slots}`);
    mkdirSync(stageRoot, { mode: 0o700 });
    const started = performance.now();
    const resources: { phase: string; observation: ReturnType<typeof sampleSoakResources> }[] = [];
    const checks: Record<string, boolean> = {};
    const privateEvidence: Record<string, unknown> = {};
    let fixture: Awaited<ReturnType<typeof createLiveLoadModelFixture>> | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let preparation: ReturnType<typeof observeContextPreparation> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
      reason: string | null = null;
    let naturalDrain = false,
      cleanupClosed = true,
      readFailures = 0,
      bodyReads = 0,
      abortedReads = 0,
      observerReady = 0,
      observerChanges = 0;
    const healthLatencies: number[] = [];
    const observerErrors: unknown[] = [];
    const telemetry: Record<string, unknown>[] = [];
    let previous = performance.now(),
      lagMaxMs = 0;
    const telemetryTimer = setInterval(() => {
      const now = performance.now();
      lagMaxMs = Math.max(lagMaxMs, now - previous - 100);
      previous = now;
      telemetry.push({ at: now, memory: process.memoryUsage(), cpu: process.cpuUsage(), lagMaxMs });
    }, 100);
    const observers: { abort: AbortController; promise: Promise<void> }[] = [];
    const streams = new Map<
      string,
      { finish: boolean; eof: boolean; reason: string | null; aborted: boolean }
    >();
    function assert(value: unknown, key: string): asserts value {
      checks[key] = !!value;
      if (!value) throw new Boundary(key, true);
    }
    const roots = Array.from({ length: spec.roots }, (_, index) => `root-${index}`);
    const sample = (phase: string) => resources.push({ phase, observation: sampleSoakResources() });
    async function until<T>(
      read: () => Promise<T | undefined>,
      point: string,
      deadline: number,
    ): Promise<T> {
      for (;;) {
        if (performance.now() >= deadline) throw new Boundary(point);
        const value = await read();
        if (value !== undefined) return value;
        await Bun.sleep(10);
      }
    }
    try {
      if (used >= budget) throw new Boundary('physical_HTTP_budget_exhausted_before_stage');
      fixture = await createLiveLoadModelFixture({
        requestLimit: budget - used,
        timeoutMs: 90_000,
      });
      const live = fixture;
      if (
        record(live.metadata.settings).maxOutputTokens !== 4096 ||
        record(live.metadata.settings).reasoningEffort !== 'medium'
      )
        throw new Boundary('original_4096_medium_configured_preset_not_present_no_override');
      const deadline = started + 90_000;
      const workspace = join(stageRoot, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const profile = { dataRoot: join(stageRoot, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      preparation = observeContextPreparation(store);
      store = preparation.store;
      const owned = store;
      const expectedStoreId = (await store.getMetadata()).storeId;
      const subjectId = 'live-provider-load-owner';
      const model: ModelAdapter = {
        ...(live.model.describeRequest
          ? { describeRequest: live.model.describeRequest.bind(live.model) }
          : {}),
        async *stream(request, context) {
          const trace = {
            finish: false,
            eof: false,
            reason: null as string | null,
            aborted: false,
          };
          streams.set(request.requestId, trace);
          try {
            for await (const event of live.model.stream(request, context)) {
              if (event.type === 'finish') {
                trace.finish = true;
                trace.reason = event.reason;
              }
              yield event;
            }
            trace.eof = true;
          } finally {
            trace.aborted = context.signal.aborted;
          }
        },
      };
      const task = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'load-worker',
            description: 'Independent original finite report writer.',
          },
        ],
      });
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        model,
        modelId: live.modelId,
        modelConcurrency: spec.slots,
        maxConcurrentSubagents: spec.children,
        extensions: [
          {
            ...task,
            tools: task.tools!.map((tool) =>
              tool.id !== 'task.spawn'
                ? tool
                : {
                    ...tool,
                    async execute(input, context) {
                      // Same trusted fixture-only detached policy as the original load fixture.
                      // Never add a detached switch to the model-visible schema.
                      const detached =
                        heavy && String(record(input).prompt ?? '').startsWith('load-root-1 ');
                      return tool.execute(input, {
                        ...context,
                        operations: {
                          ...context.operations,
                          ensure(value) {
                            return context.operations.ensure({
                              ...value,
                              cancellation: detached ? 'detached' : 'attached',
                            });
                          },
                        },
                      });
                    },
                  },
            ),
          },
        ],
        childConfigurations: [
          {
            id: 'load-worker',
            version: '1',
            model,
            modelId: live.modelId,
            toolIds: [],
            snapshot: { fixture: true },
          },
        ],
        permissions: {
          authorize: async () => ({ allowed: true, revision: 'owned-provider-load-only' }),
        },
        afterTurn: {
          authorize: async () => ({ allowed: true, revision: 'owned-provider-load-only' }),
        },
      });
      const selection = {
        dataRoot: realpathSync(profile.dataRoot),
        name: profile.profile,
        accessKey: resolveProfile(profile).profileAccessKey,
      };
      service = await startService({
        runtime,
        profile: selection,
        subjectId,
        buildId: 'live-provider-load',
      });
      const connection = {
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile: selection,
          apiMajor: 1,
          requiredCapabilities: ['commands', 'sessions', 'model_outputs', 'events'],
        },
      };
      client = createClient(connection);
      const api = client;
      await api.connect();
      await api.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned real Provider concurrency',
        rootUri: pathToFileURL(workspace).href,
      });
      await Promise.all(
        roots.map(async (id) => {
          await api.createSession({
            expectedStoreId,
            sessionId: id,
            workspaceId: 'w',
            commandId: `create-${id}`,
            title: id,
          });
          const assignments = Array.from(
            { length: spec.children },
            (_, index) =>
              `load-${id} child-${index}: Write an original finite technical report of about 2500 words on a distinct harmless computational topic. Include a clear final conclusion. Do not call tools, spawn, send, wait or modify anything. Finish normally.`,
          );
          await api.startRun(
            id,
            {
              expectedStoreId,
              commandId: `work-${id}`,
              kind: 'run.start',
              content: `New task: Make exactly ${spec.children} independent spawn_agent calls, preferably in the same tool response, one for each exact assignment below. Include the load-root prefix in each assignment. Then immediately write your own original finite technical report of about 2500 words while the children work; do not wait or poll. Later reports must truthfully summarize each child's actual generated result. Do not spawn again, follow up, interrupt, or send. Assignments:\n${assignments.join('\n')}`,
            },
            { signal: live.signal },
          );
        }),
      );
      const allViews = async () => {
        const carriers = await api.listAllBackgroundExecutions({ signal: live.signal });
        const sessions = [
          ...roots,
          ...carriers
            .map((item) => item.execution.childSessionId)
            .filter((id): id is string => !!id),
        ];
        return {
          carriers,
          views: await Promise.all(
            [...new Set(sessions)].map((id) => api.getView(id, { signal: live.signal })),
          ),
        };
      };
      const topology = await until(
        async () => {
          const state = await allViews();
          return state.carriers.length === spec.roots * spec.children ? state : undefined;
        },
        'real_model_did_not_dispatch_exact_child_topology',
        deadline,
      );
      assert(
        topology.carriers.every(
          (item) =>
            roots.includes(item.session.id) && item.execution.originStoreId === expectedStoreId,
        ),
        'all_child_carriers_accurate_direct_parent_and_Store',
      );
      // Resolve real actors, then reject a stale snapshot if any original stream
      // ended or another began during the Store reads. Never hold Provider IO.
      const currentActors = async () => {
        const attempts = live.physical.active().map((attempt) => ({ ...attempt }));
        const executions = await Promise.all(
          attempts.map((attempt) => owned.getExecution(attempt.requestId ?? '')),
        );
        const current = live.physical.active();
        if (
          attempts.length !== current.length ||
          !attempts.every((attempt, index) => attempt.index === current[index]?.index)
        )
          return undefined;
        return { attempts, sessions: executions.map((execution) => execution?.sessionId) };
      };
      const active = heavy
        ? await until(
            async () => {
              const actors = await currentActors();
              if (!actors || actors.attempts.length !== spec.slots) return undefined;
              const parentSessions = actors.sessions.filter(
                (session): session is string => !!session && roots.includes(session),
              );
              const expectedChildren = spec.slots === 4 ? 0 : spec.roots * 3;
              return parentSessions.length === spec.roots &&
                roots.every((root) => parentSessions.includes(root)) &&
                actors.sessions.every((session) => session !== undefined) &&
                actors.attempts.length - parentSessions.length === expectedChildren
                ? actors.attempts
                : undefined;
            },
            'original_stage_all_roots_dispatching_real_streams_not_reached',
            deadline,
          )
        : await until(
            async () =>
              live.physical.active().length >= 2
                ? live.physical.active().map((attempt) => ({ ...attempt }))
                : undefined,
            'real_physical_stream_concurrency_not_reached',
            deadline,
          );
      privateEvidence.active = active;
      assert(
        active.every((attempt) => attempt.requestId !== null),
        'all_real_HTTP_attempts_bound_to_actual_Model_request',
      );
      if (heavy) {
        assert(active.length === spec.slots, 'exact_original_stage_physical_stream_count');
        const activeExecutions = await Promise.all(
          active.map((attempt) => owned.getExecution(attempt.requestId!)),
        );
        const parentCount = activeExecutions.filter(
          (execution) => execution && roots.includes(execution.sessionId),
        ).length;
        if (parentCount !== spec.roots)
          throw new Boundary('original_stage_all_roots_dispatching_real_streams_not_reached');
        assert(
          active.length - parentCount === (spec.slots === 4 ? 0 : spec.roots * 3),
          'original_stage_child_real_stream_count',
        );
      }
      const checkHealth = async () => {
        const before = performance.now();
        const response = await fetch(`${service!.endpoint}/v1/lifecycle`, {
          headers: { authorization: `Bearer ${service!.bootstrap.token}` },
          signal: AbortSignal.any([live.signal, AbortSignal.timeout(2000)]),
        });
        assert(response.status === 200, 'health_HTTP_200');
        await response.arrayBuffer();
        healthLatencies.push(performance.now() - before);
        assert(healthLatencies.at(-1)! < 2000, 'original_health_under_2000ms');
      };
      const startObserver = () => {
        const observer = createClient(connection),
          abort = new AbortController();
        const promise = observer
          .connect()
          .then(() =>
            observer.observe({
              signal: abort.signal,
              onReady() {
                observerReady++;
              },
              onChange() {
                observerChanges++;
              },
            }),
          )
          .catch((error: unknown) => {
            if (!abort.signal.aborted) observerErrors.push(error);
          })
          .finally(() => observer.disposeNetwork());
        observers.push({ abort, promise });
      };
      startObserver();
      startObserver();
      startObserver();
      const bodyReadProof: Record<string, unknown>[] = [];
      privateEvidence.bodyReadProof = bodyReadProof;
      const readCompleteBody = async (sessionId: string, executionId: string) => {
        const at = performance.now();
        const activeBefore = live.physical.active().map((attempt) => attempt.index);
        const full = await api.getModelOutput(sessionId, executionId, {
          expectedStoreId,
          signal: live.signal,
        });
        assert(
          full.status === 'succeeded' && full.output.complete,
          'actual_original_Model_full_body_complete_before_counting_reader',
        );
        bodyReadProof.push({
          sessionId,
          executionId,
          at,
          finishedAt: performance.now(),
          activeBefore,
          activeAfter: live.physical.active().map((attempt) => attempt.index),
          bodyHash: full.bodyHash,
          bodyBytes: full.bodyBytes,
          complete: full.output.complete,
        });
        bodyReads++;
      };
      let batches = 0;
      const initialObservers = observers.slice();
      const readBatch = async () => {
        try {
          const beforeBodyReads = bodyReads;
          await Promise.all(
            Array.from(
              { length: 6 },
              (_, index) => topology.carriers[(batches * 6 + index) % topology.carriers.length]!,
            ).map(async (item) => {
              const child = item.execution.childSessionId!;
              const messages = await api.listMessages(child, { signal: live.signal });
              const message = messages.find((entry) => entry.outputBody?.complete);
              if (message?.outputBody)
                await readCompleteBody(child, message.outputBody.executionId);
            }),
          );
          // Children may all still be streaming, and legitimate inline outputs have no
          // message.outputBody descriptor. Read an already succeeded original root
          // Model by its exact Execution identity; no Model/Provider is started.
          if (bodyReads === beforeBodyReads)
            await Promise.all(
              roots.map(async (sessionId) => {
                const view = await api.getView(sessionId, { signal: live.signal });
                const original = view.executions.find(
                  (execution) => execution.kind === 'model' && execution.status === 'succeeded',
                );
                if (original) await readCompleteBody(sessionId, original.id);
              }),
            );
          await checkHealth();
          const abort = new AbortController();
          const pending = api
            .listMessages(topology.carriers[0]!.execution.childSessionId!, { signal: abort.signal })
            .then(
              () => false,
              () => true,
            );
          abort.abort();
          assert(await pending, 'real_aborted_read_rejected');
          abortedReads++;
          batches++;
          if (heavy && batches === 3) {
            for (const observer of initialObservers) observer.abort.abort();
            startObserver();
            startObserver();
          }
          if (heavy && spec.slots === 32 && batches > 12 && batches % 24 === 0) {
            for (const observer of observers) observer.abort.abort();
            startObserver();
            startObserver();
          }
        } catch (error) {
          readFailures++;
          throw error;
        }
      };
      sample('warmup');
      for (let index = 0; index < (heavy ? 12 : 1); index++) {
        await readBatch();
        if (heavy) await Bun.sleep(100);
      }
      if (heavy) {
        const state = await allViews();
        assert(
          state.views
            .filter((view) => roots.includes(view.session.id))
            .every(
              (view) =>
                view.runs.some((run) => run.isActive && run.status === 'running') &&
                view.executions.some(
                  (execution) => execution.kind === 'model' && execution.status === 'dispatching',
                ),
            ),
          'original_public_root_health',
        );
        const childViews = state.views.filter((view) => !roots.includes(view.session.id));
        if (spec.slots > 4) {
          // Original >64KiB checkpoint requirement is retained. Natural Provider inability is inconclusive, not a weakened gate.
          if (
            !childViews.every(
              (view) =>
                view.runs.some((run) => run.isActive && run.status === 'running') &&
                view.executions.some(
                  (execution) => execution.kind === 'model' && execution.status === 'dispatching',
                ) &&
                view.messages.some(
                  (message) =>
                    message.outputBody && BigInt(message.outputBody.contentBytes) > 65536n,
                ),
            )
          )
            throw new Boundary('original_child_live_health_or_64KiB_output_checkpoint_not_reached');
        } else
          assert(
            childViews.every(
              (view) =>
                !view.executions.some(
                  (execution) => execution.kind === 'model' && execution.status === 'dispatching',
                ),
            ),
            'original_4slot_children_not_dispatching',
          );
        if (spec.slots === 32) {
          const steadyStart = performance.now();
          let middle = false;
          while (performance.now() - steadyStart < 30_000) {
            if (performance.now() >= deadline)
              throw new Boundary('original_90second_budget_before_steady_complete');
            if (
              live.physical.active().length !== 32 ||
              active.some(
                (attempt) =>
                  !live.physical.active().some((current) => current.index === attempt.index),
              )
            )
              throw new Boundary('32_real_streams_not_continuous_during_30second_steady');
            await readBatch();
            if (!middle && performance.now() - steadyStart >= 15_000) {
              sample('middle');
              middle = true;
            }
            await Bun.sleep(100);
          }
          assert(
            live.physical.longest(32) >= 30_000,
            'exact_transition_timeline_proves_continuous_32_for_30000ms',
          );
          assert(
            active.every(
              (attempt) =>
                live.physical.active().some((current) => current.index === attempt.index) &&
                live.physical.attempts[attempt.index]!.chunks > attempt.chunks,
            ),
            'all_original_real_streams_advanced_during_steady',
          );
        }
        sample('tail');
      }
      // Cancel only the original attached root. The other root(s) stay under their original authority.
      if (!heavy) {
        const cancellationActors = await until(
          async () => {
            const actors = await currentActors();
            if (!actors) return undefined;
            return roots.every((root) =>
              topology.carriers.some(
                (item) =>
                  item.session.id === root &&
                  actors.sessions.includes(item.execution.childSessionId ?? undefined),
              ),
            )
              ? actors
              : undefined;
          },
          'both_real_child_streams_not_simultaneously_active_at_cancel',
          deadline,
        );
        privateEvidence.cancellationActorGate = {
          at: performance.now(),
          ...cancellationActors,
        };
      }
      await api.cancelCommand('root-0', {
        expectedStoreId,
        commandId: 'cancel-attached-root',
        kind: 'command.cancel',
        targetCommandId: 'work-root-0',
      });
      await until(
        async () => {
          const view = await api.getView('root-0', { signal: live.signal });
          const items = await api.listAllBackgroundExecutions({ signal: live.signal });
          return view.runs.every((run) => !run.isActive) &&
            items
              .filter((item) => item.session.id === 'root-0')
              .every((item) => item.execution.status === 'cancelled')
            ? true
            : undefined;
        },
        'attached_root_and_children_cancellation_not_settled',
        deadline,
      );
      let detachedTarget: string | null = null;
      if (heavy) {
        const survivors = (await api.listAllBackgroundExecutions({ signal: live.signal })).filter(
          (item) => item.session.id === 'root-1',
        );
        assert(
          survivors.length === 3 && survivors.every((item) => item.execution.status === 'running'),
          'original_detached_children_running_before_parent_cancel',
        );
        await api.cancelCommand('root-1', {
          expectedStoreId,
          commandId: 'cancel-detached-parent',
          kind: 'command.cancel',
          targetCommandId: 'work-root-1',
        });
        await until(
          async () =>
            (await api.getView('root-1', { signal: live.signal })).runs.every(
              (run) => !run.isActive,
            )
              ? true
              : undefined,
          'detached_parent_cancel_not_terminal',
          deadline,
        );
        assert(
          (await api.listAllBackgroundExecutions({ signal: live.signal }))
            .filter((item) => item.session.id === 'root-1')
            .every((item) => item.execution.status === 'running'),
          'original_detached_children_unchanged_after_parent_cancel',
        );
        detachedTarget = survivors[0]!.execution.id;
        await api.cancelExecution('root-1', {
          expectedStoreId,
          commandId: 'cancel-one-detached-child',
          kind: 'execution.cancel',
          executionId: detachedTarget,
        });
        await until(
          async () =>
            (await api.listAllBackgroundExecutions({ signal: live.signal })).find(
              (item) => item.execution.id === detachedTarget,
            )?.execution.status === 'cancelled'
              ? true
              : undefined,
          'exact_detached_child_cancel_not_terminal',
          deadline,
        );
        assert(
          (await api.listAllBackgroundExecutions({ signal: live.signal }))
            .filter((item) => item.session.id === 'root-1' && item.execution.id !== detachedTarget)
            .every((item) => item.execution.status === 'running'),
          'original_two_detached_siblings_still_running',
        );
      }
      for (const observer of observers) observer.abort.abort();
      await Promise.all(observers.map((observer) => observer.promise));
      assert(
        observerErrors.length === 0 &&
          observerReady >= (heavy ? 5 : 3) &&
          readFailures === 0 &&
          abortedReads === batches &&
          abortedReads >= (heavy ? 12 : 1) &&
          bodyReads > 0,
        'real_reads_observers_and_aborts_completed_without_task_cancel',
      );
      const drainDeadline = heavy ? Math.min(deadline, performance.now() + 3000) : deadline;
      const settled = await until(
        async () => {
          const state = await allViews();
          return !live.physical.active().length &&
            state.views.every((view) => view.runs.every((run) => !run.isActive)) &&
            state.carriers.every((item) =>
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                item.execution.status,
              ),
            )
            ? state
            : undefined;
        },
        heavy
          ? 'original_3second_natural_drain_not_reached'
          : 'unrelated_root_did_not_naturally_complete_within_original_budget',
        drainDeadline,
      );
      naturalDrain = true;
      assert(
        settled.carriers.every(
          (item) =>
            item.execution.status ===
            (item.session.id === 'root-0' || item.execution.id === detachedTarget
              ? 'cancelled'
              : 'succeeded'),
        ),
        'all_carrier_statuses_match_exact_cancel_domains',
      );
      assert(
        settled.views.every(
          (view) =>
            view.runs.every(
              (run) => !run.isActive && ['completed', 'cancelled'].includes(run.status),
            ) &&
            view.executions
              .filter((execution) => execution.kind === 'model')
              .every((execution) => ['succeeded', 'cancelled'].includes(execution.status)),
        ),
        'all_runs_and_models_original_terminal_statuses',
      );
      const actualInputs = [];
      for (const actual of live.requests) {
        const execution = await owned.getExecution(actual.requestId);
        assert(execution?.kind === 'model', 'every_actual_request_has_original_Model_execution');
        const input = await runtime.readModelInput({
          expectedStoreId,
          subjectId,
          sessionId: execution.sessionId,
          executionId: execution.id,
        });
        const visible = structuredClone(actual);
        for (const message of visible.messages)
          delete (message as { continuation?: unknown }).continuation;
        assert(
          isDeepStrictEqual(input.request, visible),
          'full_actual_request_equals_native_saved_input',
        );
        const prepared = preparation.prepared.get(execution.id);
        assert(
          prepared?.sessionId === execution.sessionId && prepared.runId === execution.runId,
          'actual_Model_has_exact_observed_real_history_prepare_scope',
        );
        if (execution.status === 'succeeded') {
          const output = await runtime.readModelOutput({
            expectedStoreId,
            subjectId,
            sessionId: execution.sessionId,
            executionId: execution.id,
          });
          assert(
            output.output.complete &&
              streams.get(execution.id)?.finish &&
              streams.get(execution.id)?.eof,
            'every_successful_actual_Model_has_native_complete_output_real_finish_and_EOF',
          );
        }
        actualInputs.push({ execution, input, prepared });
      }
      const outputProof = [];
      for (const item of settled.carriers.filter(
        (entry) => entry.execution.status === 'succeeded',
      )) {
        const childId = item.execution.childSessionId!;
        const view = settled.views.find((entry) => entry.session.id === childId)!;
        const final = view.executions
          .filter((execution) => execution.kind === 'model' && execution.status === 'succeeded')
          .at(-1);
        assert(final, 'successful_child_has_actual_Model');
        const trace = streams.get(final.id);
        const full = await runtime.readModelOutput({
          expectedStoreId,
          subjectId,
          sessionId: childId,
          executionId: final.id,
        });
        assert(
          trace?.finish &&
            trace.eof &&
            trace.reason === 'stop' &&
            full.output.complete &&
            full.output.content.length > 0 &&
            full.output.toolCalls.length === 0,
          'actual_child_complete_full_output_finish_and_EOF',
        );
        const originalCarrier = await owned.getExecution(item.execution.id);
        assert(originalCarrier, 'original_carrier_exists_in_canonical_Store');
        const body = record(originalCarrier.result).content;
        // Finite reports use the ordinary inline carrier. An unexpected Artifact requires its real scoped reader, never a preview comparison.
        if (record(originalCarrier.result).modelContent !== undefined || typeof body !== 'string')
          throw new Boundary('actual_carrier_Artifact_requires_full_scoped_reader');
        assert(
          body === full.output.content,
          'original_carrier_equals_entire_actual_generated_child_body',
        );
        const acceptance = originalCarrier.resultAcceptance;
        const requests = acceptance
          ? live.requests.filter((request) =>
              request.messages.some(
                (message) =>
                  message.sourceIds?.includes(acceptance.sourceId) &&
                  (message.content.includes(body) ||
                    message.content.includes(JSON.stringify(body).slice(1, -1))),
              ),
            )
          : [];
        for (const { execution, input, prepared } of actualInputs) {
          if (!acceptance) continue;
          const eligible = prepared.sources.some(
            (entry) =>
              entry.id === acceptance.sourceId &&
              entry.executionId === originalCarrier.id &&
              entry.resultRevision === originalCarrier.resultRevision,
          );
          const messages = input.request.messages.filter((message) =>
            message.sourceIds?.includes(acceptance.sourceId),
          );
          assert(
            messages.length === (eligible ? 1 : 0) &&
              (!eligible ||
                (execution.sessionId === item.session.id &&
                  (messages[0]!.content.includes(body) ||
                    messages[0]!.content.includes(JSON.stringify(body).slice(1, -1))))),
            'every_actual_input_exact_Source_once_iff_eligible_at_original_prepare',
          );
        }
        if (heavy && item.session.id === 'root-1') {
          const selected = await owned.getSelectedContext({
            expectedStoreId,
            sessionId: item.session.id,
          });
          assert(
            !acceptance &&
              !selected.resultSources.some((source) => source.executionId === originalCarrier.id),
            'cancelled_detached_parent_has_no_new_acceptance_or_Source_for_later_child_result',
          );
        }
        // Detached children whose parent was cancelled cannot legally gain a new parent input.
        if (item.session.id !== 'root-1' || !heavy)
          assert(
            acceptance && requests.length > 0,
            'full_original_child_carrier_Source_in_actual_parent_Provider_input',
          );
        outputProof.push({
          carrier: originalCarrier,
          model: final,
          output: full,
          trace,
          actualParentRequests: requests.map((request) => request.requestId),
        });
      }
      privateEvidence.outputProof = outputProof;
      sample('quiescent');
      assert(
        live.physical.active().length === 0,
        'zero_real_active_HTTP_streams_at_natural_quiescence',
      );
      assert(performance.now() - started <= 90_000, 'original_90second_stage_budget');
      status = 'passed';
    } catch (error) {
      reason =
        error instanceof Boundary
          ? error.point
          : 'execution_unavailable_original_error_retained_private';
      status = error instanceof Boundary && error.violation ? 'failed' : 'inconclusive';
      privateEvidence.failure =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error);
    } finally {
      const workloadDurationMs = performance.now() - started;
      clearInterval(telemetryTimer);
      privateEvidence.telemetry = telemetry;
      privateEvidence.observerErrors = observerErrors.map(String);
      for (const observer of observers) observer.abort.abort();
      const observerResults = await Promise.allSettled(
        observers.map((observer) => observer.promise),
      );
      if (observerErrors.length || observerResults.some((result) => result.status === 'rejected'))
        cleanupClosed = false;
      // Canonical evidence is captured before close. Cancel cleanup is recorded separately from natural drain.
      if (runtime && store && fixture) {
        try {
          privateEvidence.canonical = await saveLiveCanonicalModelEvidence({
            runtime,
            store,
            requests: fixture.requests,
            root: stageRoot,
            subjectId: 'live-provider-load-owner',
          });
        } catch (error) {
          cleanupClosed = false;
          privateEvidence.canonicalFailure = String(error);
        }
      }
      privateEvidence.actualPreparation = preparation ? [...preparation.prepared] : [];
      privateEvidence.beforeCleanup = structuredClone({
        naturalDrain,
        physical: fixture?.physical.attempts,
        transitions: fixture?.physical.transitions,
        streams: [...streams],
        requests: fixture?.requests,
        usage: fixture?.usage,
        metadata: fixture?.metadata,
        resources,
      });
      try {
        client?.disposeNetwork();
      } catch {
        cleanupClosed = false;
      }
      try {
        if (service) await service.close();
        else if (runtime) {
          const close = runtime.tryBeginShutdown('cancel');
          if (close.accepted) await close.completion;
          else cleanupClosed = false;
        } else await store?.close();
      } catch (error) {
        cleanupClosed = false;
        privateEvidence.cleanupFailure = String(error);
      }
      if (fixture?.physical.active().length) cleanupClosed = false;
      privateEvidence.afterCleanup = {
        physical: fixture?.physical.attempts,
        transitions: fixture?.physical.transitions,
        resources: sampleSoakResources(),
      };
      const privateBody = `${JSON.stringify(privateEvidence, null, 2)}\n`;
      writeFileSync(join(stageRoot, 'private-evidence.json'), privateBody, { mode: 0o600 });
      used += fixture?.wire.length ?? 0;
      allClosed &&= cleanupClosed;
      stages.push({
        spec,
        status,
        reason,
        checks,
        workloadDurationMs,
        totalDurationMs: performance.now() - started,
        naturalDrainWithinOriginalWindow: naturalDrain,
        cleanupClosed,
        HTTP: fixture?.wire.length ?? 0,
        actualPeakPhysicalStreams: Math.max(
          0,
          ...(fixture?.physical.transitions.map((entry) => entry.active) ?? []),
        ),
        longest32Ms: fixture?.physical.longest(32) ?? 0,
        readFailures,
        bodyReads,
        abortedReads,
        observerReady,
        observerChanges,
        maxHealthLatencyMs: Math.max(0, ...healthLatencies),
        privateEvidenceSha256: sha(privateBody),
        cost: 'unknown',
        remoteComputeConcurrency: 'not_observable',
        rawBodyPublic: false,
      });
    }
    if (status !== 'passed') break;
  }
  const complete = stages.length === (heavy ? 3 : 1);
  const status =
    !allClosed || stages.some((stage) => stage.status === 'failed')
      ? 'failed'
      : complete && stages.every((stage) => stage.status === 'passed')
        ? 'passed'
        : 'inconclusive';
  const report = {
    caseId: options.caseId,
    status,
    code,
    scriptSha256: sha(readFileSync(import.meta.path, 'utf8')),
    stages,
    requestCount: used,
    requestLimit: budget,
    originalModelSettings:
      'configured Provider, configured reasoning, max4096 output, each HTTP60s',
    stageBudgetMs: 90_000,
    contract25PairedProcessGateQualified: false,
    scope:
      'actual Provider local HTTP stream concurrency, actual Core child/carrier/full body/Source, original three stages for L02',
    resources:
      'in-process Runtime+Service sampled by existing unified-soak observer; not separate paired-service process exit qualification',
    qualification: heavy
      ? 'Contract25 original paired-service whole-file still independently required; this runner never replaces its process-exit/telemetry gate'
      : 'L01 original collaboration concurrent isolation subset; lifecycle observations remain disabled by default',
    cleanupConfirmed: allClosed,
    semanticReviewRequired: true,
    cost: 'unknown',
  };
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return report;
}
