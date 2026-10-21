import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { JobDefinition, JobHandle, Json, ToolDefinition } from '@kite-ai/agent/extensions';
import { createShellJob } from '@kite-ai/agent/jobs/shell';
import { createShellExtension } from '@kite-ai/agent/shell';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { observeContextPreparation } from './live-context-prepare-evidence';

export const liveAttachedShellCaseIds = [
  'L03-real-attached-Shell-after-child-Model-EOF-natural-settlement',
  'C05-real-attached-Shell-observation-fault-unknown-original-stop-no-replay',
] as const;
type CaseId = (typeof liveAttachedShellCaseIds)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: CaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  semanticReviewRequired: true;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
}
const object = (value: unknown): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
const terminal = (state: string) =>
  ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(state);
/** Isolated real POSIX Shell; private observation exception, never synthetic terminal/Model output. */
export async function runLiveAttachedShell(options: Options): Promise<{ cases: Result[] }> {
  const selected = liveAttachedShellCaseIds.filter(
    (id) => !options.caseIds || options.caseIds.includes(id),
  );
  if (selected.length > 1 && options.evidenceRoot)
    throw Error('one_attached_shell_case_per_evidence_root');
  const cases: Result[] = [];
  for (const id of selected) cases.push(await sample(id, options));
  return { cases };
}
async function sample(id: CaseId, options: Options): Promise<Result> {
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('attached_shell_invalid_evidence_root');
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return {
      id,
      status: 'inconclusive',
      checks: {},
      coverage: [],
      adapterAttempts: 0,
      canonicalEvidenceRetained: false,
      semanticReviewRequired: true,
      reason: 'branch_not_reached',
      failurePoint: 'POSIX_shell_platform_required',
    };
  options.signal.throwIfAborted();
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
    options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-attached-shell-')),
  );
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const nonce = randomUUID(),
    marker = `REAL_SHELL_EFFECT_${nonce}`,
    endMarker = `REAL_SHELL_END_${nonce}`;
  // Fully fixed owned fixture command; Model must pass these exact bytes, no substituted shell program.
  const command = `printf '%s\\n' '${marker}' >> effect.txt; printf '%s\\n' '${marker}'; n=0; while [ ! -f release-job ] && [ "$n" -lt 2400 ]; do sleep 0.1; n=$((n+1)); done; if [ ! -f release-job ]; then exit 74; fi; printf '%s\\n' '${endMarker}'`;
  const unknownCase = id === liveAttachedShellCaseIds[1];
  const fault = gate();
  const checks: Result['checks'] = {},
    stages: Record<string, unknown> = {},
    canonical: unknown[] = [],
    jobEvents: unknown[] = [];
  const streams = new Map<string, { finish: boolean; eof: boolean }>();
  const firstRequest = options.requests().length;
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, point: string) {
    const deadline = Date.now() + 150000;
    for (;;) {
      options.signal.throwIfAborted();
      const value = await read();
      if (test(value)) return value;
      if (Date.now() >= deadline) throw new Boundary('branch_not_reached', point);
      await Bun.sleep(20);
    }
  }
  async function hold() {
    options.signal.throwIfAborted();
    let abort!: () => void;
    try {
      await Promise.race([
        fault.promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(Error('attached_shell_aborted'));
          options.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined;
  let shell: JobDefinition | undefined, handle: JobHandle | undefined;
  let preparation: ReturnType<typeof observeContextPreparation> | undefined;
  let starts = 0,
    spawnCalls = 0,
    launchCalls = 0,
    observationFaults = 0,
    disposeCalls = 0,
    disposeCompleted = 0,
    observeEOF = false,
    effectOutput = '';
  const stops: unknown[] = [];
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let childSessionId: string | undefined,
    modelEvidenceRetained = false;
  try {
    const built = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      outdir: join(root, 'assets'),
      target: 'bun',
      naming: 'shell-supervisor.js',
    });
    branch(built.success && built.outputs.length === 1, 'original_guardian_build_failed');
    stages.guardian = {
      source: 'packages/agent/src/platform/process/shell-supervisor.ts',
      builtPath: built.outputs[0]!.path,
      sha256: hash(readFileSync(built.outputs[0]!.path, 'utf8')),
    };
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    store = await openSqliteStore(profile);
    preparation = observeContextPreparation(store);
    store = preparation.store;
    const owned = store,
      expectedStoreId = (await owned.getMetadata()).storeId;
    shell = createShellJob({
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath: built.outputs[0]!.path,
    });
    const realShell = shell;
    const instrumented: JobDefinition = {
      ...realShell,
      async start(input, context) {
        starts++;
        assert(
          starts === 1 && object(input).command === command,
          'one_real_exact_Shell_start_no_substituted_program_or_retry',
        );
        handle = await realShell.start(input, context);
        stages.handle = structuredClone(handle.reference);
        return handle;
      },
      async *observe(original) {
        assert(original === handle, 'observe_exact_original_real_Shell_handle');
        for await (const event of realShell.observe(original)) {
          jobEvents.push(structuredClone(event));
          yield event;
          if (event.type === 'output' && event.stream === 'stdout') {
            effectOutput += event.content;
            if (effectOutput.includes(marker)) {
              if (unknownCase) {
                await hold();
                observationFaults++;
                // Only observation fails. Runtime itself determines unknown, invokes actual
                // original cancellation and persists its real stop confirmation.
                throw Error('isolated_attached_shell_observation_disconnected_after_real_output');
              }
            }
          }
        }
        observeEOF = true;
      },
      async cancel(original) {
        const result = await realShell.cancel(original);
        stops.push(structuredClone(result));
        return result;
      },
      async dispose(original) {
        disposeCalls++;
        await realShell.dispose(original);
        disposeCompleted++;
      },
    };
    const originalShell = createShellExtension({ job: instrumented });
    const shellTools = originalShell
      .tools!.filter((tool) => tool.id === 'shell.launch')
      .map(
        (tool): ToolDefinition => ({
          ...tool,
          async execute(input, context) {
            launchCalls++;
            branch(launchCalls === 1, 'Model_repeated_Shell_launch');
            assert(
              context.sessionId !== 'root' &&
                object(input).cancellation === 'attached' &&
                object(input).command === command,
              'actual_child_explicit_attached_original_Shell_command',
            );
            return tool.execute(input, context);
          },
        }),
      );
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description:
            'Launch exactly one real attached Shell and report honestly that accepted Shell work is still pending.',
        },
      ],
    });
    const originalSpawn = task.tools!.find((tool) => tool.id === 'task.spawn')!;
    branch(originalSpawn, 'public_six_tool_spawn_not_available');
    const taskExtension = {
      ...task,
      tools: task.tools!.map(
        (tool): ToolDefinition =>
          tool.id !== 'task.spawn'
            ? tool
            : {
                ...tool,
                async execute(input, context) {
                  spawnCalls++;
                  branch(spawnCalls === 1, 'Model_repeated_original_spawn');
                  assert(context.sessionId === 'root', 'only_parent_spawns_one_real_child');
                  return tool.execute(input, context);
                },
              },
      ),
    };
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      async *stream(request, context) {
        const trace = { finish: false, eof: false };
        streams.set(request.requestId, trace);
        for await (const event of options.model.stream(request, {
          ...context,
          signal: AbortSignal.any([options.signal, context.signal]),
        })) {
          if (event.type === 'finish') trace.finish = true;
          yield event;
        }
        trace.eof = true;
      },
    };
    const permissions = {
      async authorize() {
        return { allowed: true as const, revision: 'isolated-attached-shell-v1' };
      },
    };
    const rootToolIds = [
      ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      ...shellTools.map((tool) => tool.id),
    ];
    runtime = createRuntime({
      store: owned,
      model,
      modelId: options.modelId,
      modelConcurrency: 3,
      processConcurrency: 1,
      artifacts: createArtifactStore({ profile, store: owned }),
      extensions: [taskExtension, { ...originalShell, tools: shellTools }],
      permissions,
      afterTurn: permissions,
      resolveRunConfiguration: async () => ({
        model,
        modelId: options.modelId,
        toolIds: rootToolIds,
        snapshot: { kind: 'isolated-real-attached-shell', version: 1 },
        permissions,
        afterTurn: permissions,
      }),
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: shellTools.map((tool) => tool.id),
          snapshot: { kind: 'isolated-real-attached-shell-child', version: 1 },
        },
      ],
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private attached Shell',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      workspaceId: 'w',
      commandId: 'create',
      title: id,
    });
    const childPrompt = `Call shell_launch exactly once with key="one", cancellation="attached", and command exactly these bytes:\n${command}\nThen give a truthful final answer that only launch acceptance is known, the attached Shell is still pending, and no business completion/cleanup is verified. Do not wait, read, cancel, re-launch, or use any other Tool. Do not claim stdout or terminal results you have not received.`;
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: `Use spawn_agent exactly once, worker preset if required, with this full child task:\n${childPrompt}\nDo not execute Shell yourself. After acceptance finish this ordinary turn truthfully as pending. When a real child result arrives distinguish child Model ended, business pending, actual external effects unknown and cleanup status; never retry or pretend unknown is succeeded.`,
      },
    });
    const parentBefore = await until(
      () => owned.getView('root'),
      (view) => view.executions.some((row) => Boolean(row.childSessionId)),
      'real_original_child_not_created',
    );
    const carrier = parentBefore.executions.find((row) => Boolean(row.childSessionId))!;
    childSessionId = carrier.childSessionId!;
    const childBefore = await until(
      () => owned.getView(childSessionId!),
      (view) =>
        view.runs.some((run) => run.status === 'completed' && !run.isActive) &&
        view.executions.some(
          (row) =>
            row.kind === 'job' && row.definitionId === 'shell.command' && row.status === 'running',
        ),
      'child_Model_Run_complete_while_real_attached_Shell_running_not_reached',
    );
    await until(
      async () => effectOutput,
      (value) => value.includes(marker),
      'actual_real_Shell_stdout_marker_not_seen',
    );
    const job = childBefore.executions.find(
      (row) => row.kind === 'job' && row.definitionId === 'shell.command',
    )!;
    const launchingTool = job.parentExecutionId
      ? await owned.getExecution(job.parentExecutionId)
      : undefined;
    branch(
      launchingTool?.kind === 'tool' &&
        launchingTool.definitionId === 'shell.launch' &&
        launchingTool.sessionId === childSessionId &&
        launchingTool.runId,
      'original_attached_Shell_missing_actual_launch_Tool_Run',
    );
    const childRun = childBefore.runs.find((run) => run.id === launchingTool!.runId);
    branch(childRun, 'original_launch_Tool_child_Run_missing');
    const beforeCarrier = (await owned.getExecution(carrier.id))!;
    const selectedBefore = await owned.getSelectedContext({ expectedStoreId, sessionId: 'root' });
    assert(
      childRun!.status === 'completed' &&
        !childRun!.isActive &&
        job.cancelWithParent &&
        job.status === 'running' &&
        beforeCarrier.status === 'running' &&
        beforeCarrier.resultAcceptance === null &&
        !selectedBefore.resultSources.some((source) => source.executionId === carrier.id),
      'actual_Model_Run_EOF_does_not_finish_attached_Job_or_accept_carrier',
    );
    const realGroup = Number(object(handle!.reference).processGroupId),
      supervisorPid = Number(object(handle!.reference).supervisorPid);
    const alive = (pid: number, group = false) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(group ? -pid : pid, 0);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'ESRCH') return false;
        throw error;
      }
    };
    assert(
      alive(realGroup, true) &&
        alive(supervisorPid) &&
        readFileSync(join(workspace, 'effect.txt'), 'utf8') === `${marker}\n`,
      'original_real_process_group_alive_and_single_harmless_effect_before_settlement',
    );
    stages.before = {
      carrier: beforeCarrier,
      child: childBefore,
      parent: await owned.getView('root'),
      selected: selectedBefore,
      job,
      childRun,
      launchingTool,
      processGroupId: realGroup,
      supervisorPid,
      starts,
      launchCalls,
    };
    if (unknownCase) fault.release();
    else
      writeFileSync(join(workspace, 'release-job'), 'explicit private controller release\n', {
        mode: 0o600,
      });
    const settled = await until(
      () => owned.getExecution(carrier.id),
      (row) => Boolean(row && terminal(row.status)),
      'carrier_not_settled_after_real_job_boundary',
    );
    const jobFinal = (await until(
      () => owned.getExecution(job.id),
      (row) => Boolean(row && terminal(row.status)),
      'original_Shell_job_not_settled',
    ))!;
    await until(
      async () => !alive(realGroup, true) && !alive(supervisorPid),
      Boolean,
      'original_real_Shell_group_or_guardian_not_stopped',
    );
    assert(
      starts === 1 &&
        launchCalls === 1 &&
        readFileSync(join(workspace, 'effect.txt'), 'utf8') === `${marker}\n`,
      'no_effect_or_Shell_start_replay_after_natural_or_unknown_settlement',
    );
    assert(
      isDeepStrictEqual(await owned.getRun(childRun!.id), childRun),
      'original_completed_child_Run_metadata_not_rewritten_by_later_Job_settlement',
    );
    if (unknownCase) {
      const result = object(jobFinal.result),
        details = object(result.details),
        stop = object(details.stopConfirmation);
      assert(
        observationFaults === 1 &&
          jobFinal.status === 'outcome_unknown' &&
          result.outcome === 'outcome_unknown' &&
          details.adapterAttempted === true &&
          ['stopped', 'already_finished'].includes(String(stop.status)),
        'Runtime_forms_real_attempted_Job_unknown_despite_original_actual_stop_confirmation',
      );
      assert(
        settled!.status === 'outcome_unknown' &&
          object(object(settled!.result).details).childSettlement === 'attached_effect_unknown' &&
          settled!.resultAcceptance === null,
        'attached_unknown_prevents_successful_carrier_acceptance',
      );
      assert(
        !jobEvents.some((value) => object(value).type === 'terminal') && !observeEOF,
        'fault_is_observation_exception_without_synthetic_terminal_or_EOF',
      );
    } else {
      assert(
        observationFaults === 0 &&
          observeEOF &&
          jobFinal.status === 'succeeded' &&
          settled!.status === 'succeeded' &&
          jobEvents.some(
            (value) =>
              object(value).type === 'terminal' &&
              object(value).supervision === 'ended' &&
              object(object(value).result).outcome === 'succeeded',
          ),
        'real_natural_terminal_and_EOF_before_successful_attached_carrier',
      );
      assert(
        effectOutput.includes(endMarker),
        'actual_complete_Shell_stdout_contains_natural_end_marker',
      );
    }
    const frozenJob = structuredClone(jobFinal),
      frozenCarrier = structuredClone(settled);
    // Let the original reliable report path settle; never create a replacement Run or POST a retry.
    await until(
      () => owned.getExecution(carrier.id),
      (row) => Boolean(row && (row.delivery === 'consumed' || row.delivery === 'suppressed')),
      'original_report_delivery_not_settled',
    );
    await until(
      async () => disposeCompleted,
      (count) => count >= 1,
      'original_Job_dispose_not_completed',
    );
    const parentFinal = await until(
      () => owned.getView('root'),
      (view) => view.runs.every((run) => !run.isActive),
      'original_parent_report_not_idle',
    );
    const cursor = (await owned.getMetadata()).lastChangeCursor,
      requestsBeforeRead = options.requests().length;
    await owned.getExecution(job.id);
    await owned.getExecution(carrier.id);
    assert(
      (await owned.getMetadata()).lastChangeCursor === cursor &&
        options.requests().length === requestsBeforeRead &&
        isDeepStrictEqual(await owned.getExecution(job.id), frozenJob),
      'original_Execution_read_only_lookup_zero_Model_zero_effect_unknown_not_rewritten',
    );
    stages.final = {
      job: await owned.getExecution(job.id),
      carrier: await owned.getExecution(carrier.id),
      child: await owned.getView(childSessionId),
      parent: parentFinal,
      selected: await owned.getSelectedContext({ expectedStoreId, sessionId: 'root' }),
      frozenJob,
      frozenCarrier,
      stops,
      groupAlive: alive(realGroup, true),
      guardianAlive: alive(supervisorPid),
    };
    assert(
      isDeepStrictEqual(await owned.getExecution(job.id), frozenJob) &&
        (await owned.getExecution(carrier.id))!.status === frozenCarrier!.status &&
        starts === 1,
      'later_report_or_cleanup_never_promotes_unknown_or_restarts_effect',
    );
    if (unknownCase) {
      const finalCarrier = await owned.getExecution(carrier.id);
      const finalContext = await owned.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      assert(
        finalCarrier?.resultAcceptance === null &&
          !finalContext.resultSources.some((source) => source.executionId === carrier.id),
        'unknown_remains_unaccepted_and_has_no_automatic_Source_after_report_and_cleanup',
      );
    }
    let completeOriginalSourcePrepared = false;
    const acceptedCarrier = (await owned.getExecution(carrier.id))!;
    for (const view of [parentFinal, await owned.getView(childSessionId)])
      for (const row of view.executions.filter((entry) => entry.kind === 'model')) {
        const actual = options.requests().find((request) => request.requestId === row.id);
        if (!actual) {
          branch(row.status !== 'succeeded', 'successful_Model_not_in_counted_actual_requests');
          continue;
        }
        const scope = {
          expectedStoreId,
          subjectId: 'owner',
          sessionId: row.sessionId,
          executionId: row.id,
        };
        const input = await runtime.readModelInput(scope);
        const output =
          row.status === 'succeeded'
            ? await runtime.readModelOutput({ ...scope, signal: options.signal })
            : undefined;
        const visible = structuredClone(actual!);
        for (const message of visible.messages)
          delete (message as { continuation?: unknown }).continuation;
        assert(
          isDeepStrictEqual(input.request, visible) &&
            (!output ||
              (output.output.complete && streams.get(row.id)?.finish && streams.get(row.id)?.eof)),
          `complete_actual_Model_inspector_EOF_${hash(row.id).slice(0, 12)}`,
        );
        canonical.push({ scope, input, output });
        if (unknownCase) {
          const prepared = preparation.prepared.get(row.id);
          assert(
            prepared?.runId === row.runId &&
              prepared.sessionId === row.sessionId &&
              !prepared.sources.some((source) => source.executionId === carrier.id),
            'actual_unknown_case_inputs_never_prepare_original_unknown_as_accepted_result_Source',
          );
        }

        if (!unknownCase && acceptedCarrier.resultAcceptance) {
          const sourceId = acceptedCarrier.resultAcceptance.sourceId;
          const messages = input.request.messages.filter((message) =>
            message.sourceIds?.includes(sourceId),
          );
          const prepared = preparation.prepared.get(row.id);
          assert(
            prepared?.runId === row.runId && prepared.sessionId === row.sessionId,
            'actual_Model_has_exact_observed_real_history_prepare_scope',
          );
          const eligible = prepared!.sources.some(
            (entry) => entry.id === sourceId && entry.executionId === carrier.id,
          );
          assert(
            messages.length === (eligible ? 1 : 0),
            'each_actual_Model_Source_count_matches_its_original_prepare_eligibility',
          );
          if (eligible) {
            const body = String(object(acceptedCarrier.result).content);
            assert(
              row.sessionId === 'root' &&
                row.runId === acceptedCarrier.resultAcceptance.runId &&
                messages.length === 1 &&
                (messages[0]!.content.includes(body) ||
                  messages[0]!.content.includes(JSON.stringify(body).slice(1, -1))),
              'complete_original_child_result_Source_once_in_exact_actual_parent_Model',
            );
            completeOriginalSourcePrepared = true;
          }
        }
      }
    branch(canonical.length >= 4, 'full_real_parent_child_Model_evidence_missing');
    if (!unknownCase)
      assert(
        completeOriginalSourcePrepared,
        'natural_child_result_reaches_real_parent_Model_after_attached_settlement',
      );
    status = 'passed';
  } catch (error) {
    status =
      error instanceof Boundary && error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    reason = error instanceof Boundary ? error.reason : 'execution_unavailable';
    failurePoint = error instanceof Boundary ? error.point : String(error);
  } finally {
    fault.release();
    // Original handle only: make a best-effort actual stop, record proof separately; never rewrite result.
    const cleanupErrors: string[] = [];
    if (shell && handle) {
      try {
        const stop = await shell.cancel(handle);
        stages.finalOriginalHandleStop = stop;
        if (!['stopped', 'already_finished'].includes(stop.status))
          cleanupErrors.push(`original_shell_stop_unconfirmed: ${stop.status}`);
      } catch (error) {
        cleanupErrors.push(`original_shell_cancel: ${String(error)}`);
      }
      try {
        await shell.dispose(handle);
      } catch (error) {
        cleanupErrors.push(`original_shell_dispose: ${String(error)}`);
      }
    }
    if (store && runtime) {
      try {
        const saved = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: options.requests().slice(firstRequest),
          root,
          subjectId: 'owner',
        });
        stages.canonical = saved;
        modelEvidenceRetained = true;
        if (status === 'passed' && !saved.complete) {
          status = 'failed';
          reason = 'execution_unavailable';
          failurePoint = 'canonical_actual_request_capture_incomplete';
        }
      } catch (error) {
        stages.partialEvidenceError = String(error);
        if (status === 'passed') {
          status = 'failed';
          reason = 'execution_unavailable';
          failurePoint = 'canonical_actual_request_capture_failed';
        }
      }
    }
    stages.actualPreparation = preparation ? [...preparation.prepared] : [];
    stages.verifiedActualModels = canonical;
    let runtimeClosed = false;
    try {
      await runtime?.close();
      runtimeClosed = Boolean(runtime);
    } catch (error) {
      cleanupErrors.push(`runtime_close: ${String(error)}`);
    }
    if (!runtimeClosed)
      try {
        await store?.close();
      } catch (error) {
        cleanupErrors.push(`store_close: ${String(error)}`);
      }
    checks.resourcesClosed = cleanupErrors.length === 0;
    stages.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length && status === 'passed') {
      status = 'failed';
      reason = 'cleanup_failed';
      failurePoint = 'resources_close';
    }
    writeFileSync(
      join(root, 'evidence.json'),
      `${JSON.stringify({ version: 1, id, platform: process.platform, nonce, command, marker, endMarker, checks, stages, starts, spawnCalls, launchCalls, observationFaults, observeEOF, disposeCalls, disposeCompleted, stops, jobEvents, effectOutput, streams: Object.fromEntries(streams), status, reason, failurePoint }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return {
    id,
    status,
    checks,
    coverage: [
      'contract73/L03 exact real POSIX attached Shell after child Model/Run EOF',
      ...(unknownCase
        ? [
            'C05 attached GenericJob real observation exception, Runtime unknown, original actual stop proof, zero replay',
          ]
        : ['natural real Shell EOF/group stop before carrier success']),
    ],
    adapterAttempts: options.requests().length - firstRequest,
    canonicalEvidenceRetained: modelEvidenceRetained,
    semanticReviewRequired: true,
    ...(reason ? { reason } : {}),
    ...(failurePoint ? { failurePoint } : {}),
  };
}
