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
import type { ModelAdapter, ModelRequest, ModelToolCall } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const caseId = 'A08-pinned-old-receipt-new-run' as const;
export type LiveInterruptGenerationCaseId = typeof caseId;
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveInterruptGenerationCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  originalError?: { name: string; code?: string };
  canonicalEvidenceRetained: boolean;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type ControlInput = Parameters<Store['applyAgentCommand']>[0];
type ControlResult = Awaited<ReturnType<Store['applyAgentCommand']>>;
type Execution = NonNullable<Awaited<ReturnType<Store['getExecution']>>>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
        abort = () => reject(Error('live_interrupt_generation_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
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
/** Owned scheduling fixture; not a default permission/approval or UI qualification.
 * The caller owns the shared physical HTTP <=40 / 600s budget and counted real adapter.
 * No Model event, Tool arguments, Store result or persisted Source is manufactured.
 */
export async function runLiveInterruptGeneration(options: Options): Promise<{ cases: Result[] }> {
  if (options.caseIds && !options.caseIds.includes(caseId)) return { cases: [] };
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('live_interrupt_generation_evidence_root_invalid');
  options.signal.throwIfAborted();
  const deadlineSignal = AbortSignal.timeout(600_000);
  const cleanupAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, deadlineSignal, cleanupAbort.signal]);
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
    options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-interrupt-generation-')),
  );
  const checks: Result['checks'] = {};
  const firstRequest = options.requests().length;
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let store: Store | undefined, runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  const releaseParentContinuation = gate(),
    releaseOldReturn = gate(),
    releaseNewRead = gate(),
    firstEntered = gate();
  const reads: {
    sessionId: string;
    runId: string | null;
    executionId: string;
    round: number;
    aborted: boolean;
  }[] = [];
  const batches: { requestId: string; calls: ModelToolCall[]; finished: boolean }[] = [];
  let spawn:
    | {
        input: Parameters<Store['ensureOperation']>[0];
        ref: Awaited<ReturnType<Store['ensureOperation']>>;
      }
    | undefined;
  let old: { input: ControlInput; result: ControlResult } | undefined;
  let successor: { input: ControlInput; result: ControlResult } | undefined;
  let oldReturned = false,
    adapterStarts = 0,
    spawnCount = 0,
    interruptCount = 0,
    followupCount = 0;
  const original: { run?: Awaited<ReturnType<Store['getRun']>>; carrier?: Execution | null } = {};
  let continuationPrepared: ModelRequest | undefined;
  let retained = true;
  let originalError: Result['originalError'];
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new Boundary('branch_not_reached', point);
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
    }
  }
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const nonce = `generation-two-fact-${randomUUID()}`;
    const material = join(workspace, 'generation-two.txt');
    writeFileSync(material, `verified_fact=${nonce}\r\n`, { mode: 0o600 });
    const initialPrompt =
      'Use read_generation_material with round 1 exactly once. The read may wait; do not retry or replace it. Report only actual returned material. Do not delegate or control any collaborator.';
    const followupPrompt =
      'This is explicit new work after your previous turn stops. Use read_generation_material with round 2 exactly once, then report the entire exact verified_fact returned. Do not reuse old material, delegate, call controls, retry, or guess.';
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    store = await openSqliteStore(profile);
    const owned = store;
    const expectedStoreId = (await owned.getMetadata()).storeId;
    const originalEnsure = owned.ensureOperation.bind(owned);
    owned.ensureOperation = async (input) => {
      const result = await originalEnsure(input);
      if (input.sessionId === 'root' && input.collaborationCompletion) {
        spawnCount++;
        if (!spawn) {
          spawn = { input: structuredClone(input), ref: structuredClone(result) };
        }
      }
      return result;
    };
    const originalApply = owned.applyAgentCommand.bind(owned);
    owned.applyAgentCommand = async (input) => {
      if (input.sessionId !== 'root' || input.agentId !== spawn?.ref.childSessionId)
        return originalApply(input);
      if (input.kind === 'follow_up') {
        followupCount++;
        // This is a separately generated real Tool. Only its entry to the original
        // method is gated; its arguments, sender, namespace and permission are intact.
        await until(async () => {
          const first = reads.find((read) => read.round === 1);
          if (!old || !first?.runId) return undefined;
          const run = await owned.getRun(first.runId);
          const carrier = await owned.getExecution(spawn!.ref.executionId!);
          return run && !run.isActive && carrier?.status === 'cancelled' ? true : undefined;
        }, 'first_real_cancelled_run_not_terminal_before_followup');
        const result = await originalApply(input);
        successor = { input: structuredClone(input), result: structuredClone(result) };
        return result;
      }
      interruptCount++;
      const first = reads.find((read) => read.round === 1);
      branch(first?.runId, 'first_real_run_not_entered');
      original.run = await owned.getRun(first!.runId!);
      original.carrier = await owned.getExecution(spawn!.ref.executionId!);
      branch(
        original.run?.isActive && original.carrier?.status === 'running',
        'first_real_run_not_active_at_interrupt',
      );
      const result = await originalApply(input);
      old = { input: structuredClone(input), result: structuredClone(result) };
      // The precise selection and cancellation have really COMMITTED. Holding a
      // pre-transaction invocation would not prove that the operation was pinned.
      await wait(releaseOldReturn.promise, signal);
      oldReturned = true;
      return result;
    };
    const reader: ToolDefinition = {
      id: 'live.generation-material',
      version: '1',
      model: { name: 'read_generation_material' },
      description:
        'Read one complete owned synthetic round material; a pending read must not be retried.',
      inputSchema: {
        type: 'object',
        properties: { round: { type: 'integer', enum: [1, 2] } },
        required: ['round'],
        additionalProperties: false,
      },
      async execute(input, context) {
        const round = object(input).round;
        if (context.sessionId === 'root' || (round !== 1 && round !== 2))
          return { outcome: 'failed', content: 'Only the delegated child may read round 1 or 2.' };
        const read = {
          sessionId: context.sessionId,
          runId: context.runId,
          executionId: context.executionId,
          round,
          aborted: false,
        };
        reads.push(read);
        const aborted = () => {
          read.aborted = true;
        };
        context.signal.addEventListener('abort', aborted, { once: true });
        try {
          if (round === 1) {
            firstEntered.release();
            // R1 really remains in a dispatched Tool until its original cancel domain
            // aborts it. A timer or fixture-produced success cannot stand in for stop.
            const stoppedBeforeRead = await wait(
              new Promise<void>(() => {}),
              AbortSignal.any([signal, context.signal]),
            ).then(
              () => false,
              (error: unknown) => {
                if (context.signal.aborted) return true;
                throw error;
              },
            );
            // This private Tool owns its entire implementation: no readFileSync,
            // external request, resource acquisition or effect has begun. A real
            // Tool-signal abort therefore has an exact cooperative terminal fact.
            // Return it through Core; never edit the Execution/Run/carrier state.
            if (stoppedBeforeRead)
              return { outcome: 'cancelled', content: 'cancelled_before_owned_read' };
          } else {
            await wait(releaseNewRead.promise, AbortSignal.any([signal, context.signal]));
          }
          return { outcome: 'succeeded', content: readFileSync(material, 'utf8') };
        } finally {
          context.signal.removeEventListener('abort', aborted);
        }
      },
    };
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      async *stream(request, context) {
        if (adapterStarts++ >= 40)
          throw new Boundary('branch_not_reached', 'hard_40_adapter_start_budget_reached');
        const execution = await owned.getExecution(request.requestId);
        if (
          execution?.sessionId === 'root' &&
          oldReturned &&
          old &&
          successor &&
          !continuationPrepared
        ) {
          // Core has sealed its actual next Model input. Briefly hold only forwarding
          // to the real Provider while the two child generations are stationary and
          // the original invocation is replayed; then forward the exact same request.
          continuationPrepared = request;
          await wait(releaseParentContinuation.promise, AbortSignal.any([signal, context.signal]));
        }
        const batch = {
          requestId: request.requestId,
          calls: [] as ModelToolCall[],
          finished: false,
        };
        batches.push(batch);
        for await (const event of options.model.stream(request, {
          signal: AbortSignal.any([signal, context.signal]),
        })) {
          if (event.type === 'tool_call')
            batch.calls.push({ id: event.id, name: event.name, arguments: event.arguments });
          if (event.type === 'finish') batch.finished = event.reason === 'tool_calls';
          yield event;
        }
      },
    };
    const tasks = createTaskExtension({
      roles: [
        { id: 'worker', configurationId: 'worker', description: 'Owned finite round worker.' },
      ],
    });
    const gatedTasks = {
      ...tasks,
      tools: tasks.tools?.map((tool) =>
        tool.id !== 'task.spawn'
          ? tool
          : ({
              ...tool,
              async execute(input, context) {
                // ensureOperation must return before Host can activate the carrier.
                // Hold the already-real spawn Tool result only after its original execute
                // has started that activation, never inside the Store ensure call.
                const result = await tool.execute(input, context);
                await wait(firstEntered.promise, AbortSignal.any([signal, context.signal]));
                return result;
              },
            } satisfies ToolDefinition),
      ),
    };
    runtime = createRuntime({
      store: owned,
      artifacts: createArtifactStore({ profile, store: owned }),
      model,
      modelId: options.modelId,
      modelConcurrency: 4,
      extensions: [
        { id: 'live.generation-fixture', version: '1', apiMajor: 1, tools: [reader] },
        gatedTasks,
      ],
      permissions: {
        authorize: async () => ({
          allowed: true,
          revision: 'owned-generation-scheduling-fixture-only',
        }),
      },
      afterTurn: {
        authorize: async () => ({
          allowed: true,
          revision: 'owned-generation-scheduling-fixture-only',
        }),
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
    const serviceProfile = {
      dataRoot: realpathSync(profile.dataRoot),
      name: profile.profile,
      accessKey: resolveProfile(profile).profileAccessKey,
    };
    service = await startService({
      runtime,
      profile: serviceProfile,
      buildId: 'live-interrupt-generation',
      subjectId: 'live-generation-owner',
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
      name: 'Owned generation boundary',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      commandId: 'create',
      title: 'Live generation boundary',
    });
    await client.startRun(
      'root',
      {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: `New task: Spawn exactly ONE collaborator using spawn_agent, prompt only, no preset: ${JSON.stringify(initialPrompt)}. Once spawn returns, emit exactly TWO Tools together in ONE batch in the SAME Model reply, targeting the exact returned agent_id: interrupt_agent and follow_up_agent. The follow-up content must be exactly ${JSON.stringify(followupPrompt)}. Do not wait for the interrupt response before issuing follow_up_agent. Do not emit other Tools in that two-call batch. This fixture orders the new follow-up after the old turn has truly stopped. Then use list_agents and wait_agent_events to observe this same collaborator until the new turn completes, and report its complete actual new verified_fact. Do not create replacements, send other guidance, call interrupt/follow-up twice, read the material yourself or fabricate facts.`,
      },
      { signal },
    );
    await until(
      async () => (old && successor && reads.some((read) => read.round === 2) ? true : undefined),
      'real_parallel_old_interrupt_and_new_round_not_reached',
    );
    branch(spawn && old && successor, 'original_controls_missing');
    const first = reads.find((read) => read.round === 1)!;
    const second = reads.find((read) => read.round === 2)!;
    const childId = spawn!.ref.childSessionId!;
    const r2 = await owned.getRun(second.runId!);
    const c2 = await owned.getExecution(successor!.result.receipt.ref.executionId!);
    const t1 = await owned.getExecution(old!.input.parentExecutionId);
    const t2 = await owned.getExecution(successor!.input.parentExecutionId);
    const batch = batches.find(
      (item) =>
        item.finished &&
        item.calls.length === 2 &&
        item.calls.some((call) => call.id === t1?.callId) &&
        item.calls.some((call) => call.id === t2?.callId),
    );
    branch(
      batch && t1?.runId === t2?.runId && t1?.sessionId === 'root',
      'both_controls_not_from_one_finished_real_model_reply',
    );
    const batchExecution = await owned.getExecution(batch!.requestId);
    assert(
      batchExecution?.kind === 'model' &&
        batchExecution.sessionId === 'root' &&
        batchExecution.runId === t1?.runId &&
        batchExecution.originStoreId === expectedStoreId,
      'both_real_control_calls_come_from_exact_original_parent_model_run',
    );
    assert(
      batch!.calls.some((call) => ['interrupt_agent', 'task.interrupt'].includes(call.name)) &&
        batch!.calls.some((call) => ['follow_up_agent', 'task.follow_up'].includes(call.name)),
      'same_actual_model_reply_declares_both_original_control_calls',
    );
    assert(
      spawnCount === 1 && interruptCount === 1 && followupCount === 1,
      'one_real_spawn_interrupt_and_followup_no_replacement',
    );
    assert(
      !oldReturned &&
        second.sessionId === first.sessionId &&
        second.runId !== first.runId &&
        r2?.isActive &&
        c2?.status === 'running',
      'old_committed_return_held_until_same_session_new_run_active',
    );
    const secondTool = await owned.getExecution(second.executionId);
    const secondCommand = r2 ? await owned.getCommand(r2.originCommandId) : null;
    assert(
      r2?.originCommandId === `child-start-${c2?.id}` &&
        secondCommand?.originStoreId === expectedStoreId &&
        c2?.originStoreId === expectedStoreId &&
        c2.childSessionId === childId &&
        c2.sessionId === 'root' &&
        c2.rootWorkCommandId === original.run?.rootWorkCommandId &&
        r2.rootWorkSeq === original.run?.rootWorkSeq,
      'R2_activates_once_from_exact_C2_original_store_and_root_work',
    );
    assert(
      secondTool?.authorization?.dispatched === true &&
        ['dispatching', 'running'].includes(secondTool.status) &&
        !second.aborted,
      'R2_actual_model_and_dispatched_tool_active_without_abort',
    );
    const childSession = await runtime.getSession(childId);
    assert(
      childSession?.parentSessionId === 'root' &&
        childSession.rootSessionId === 'root' &&
        childSession.workspaceId === 'w',
      'child_exact_parent_root_and_workspace',
    );
    assert(
      old!.result.receipt.outcome === 'cancel_requested' &&
        old!.result.receipt.ref.executionId === spawn!.ref.executionId &&
        successor!.result.receipt.mode === 'new_turn' &&
        c2?.id !== spawn!.ref.executionId,
      'committed_old_receipt_pins_C1_and_followup_creates_C2',
    );
    const oldCommand = await owned.getCommand(old!.input.commandId);
    const assignmentCommand = await owned.getCommand(spawn!.ref.commandId);
    const originalChildCommand = await owned.getCommand(original.run!.originCommandId);
    branch(
      String(object(spawn!.input.request.input).content) === initialPrompt &&
        successor!.input.content === followupPrompt,
      'real_model_did_not_preserve_both_exact_round_instructions',
    );
    assert(
      originalChildCommand?.originStoreId === expectedStoreId &&
        originalChildCommand.rootWorkCommandId === r2?.rootWorkCommandId,
      'original_assignment_and_real_followup_content_keep_exact_original_work',
    );
    const cancelCommand = await owned.getCommand(`${old!.input.commandId}-cancel`);
    assert(
      object(cancelCommand?.request).executionId === spawn!.ref.executionId &&
        isDeepStrictEqual(oldCommand?.receipt, old!.result.receipt),
      'durable_old_control_and_cancel_domain_target_only_C1',
    );
    assert(
      first.aborted &&
        (await owned.getRun(first.runId!))?.status === 'cancelled' &&
        (await owned.getExecution(spawn!.ref.executionId!))?.status === 'cancelled',
      'R1_real_tool_abort_and_original_run_carrier_cancelled',
    );
    assert(
      c2?.cancelRequestedAt === null &&
        secondTool?.cancelRequestedAt === null &&
        (await owned.getCommand(r2!.originCommandId))?.cancelRequestedAt === null,
      'R2_original_command_carrier_tool_have_no_cancel_request',
    );
    assert(
      r2?.originStoreId === expectedStoreId &&
        r2.rootWorkCommandId === original.run?.rootWorkCommandId &&
        r2.contextSelectionId === original.run?.contextSelectionId &&
        isDeepStrictEqual(c2?.childConfiguration, original.carrier?.childConfiguration) &&
        isDeepStrictEqual(r2.configuration, original.run?.configuration),
      'new_run_keeps_original_store_work_selection_and_configuration',
    );
    assert(
      r2 !== null && r2.deadlineAt !== null && r2.deadlineAt - r2.createdAt === 1_800_000,
      'new_run_has_its_own_activation_deadline',
    );
    await until(async () => {
      const followupTool = await owned.getExecution(successor!.input.parentExecutionId);
      const oldRead = await owned.getExecution(first.executionId);
      const newRead = await owned.getExecution(second.executionId);
      return followupTool?.status === 'succeeded' &&
        oldRead?.status === 'cancelled' &&
        newRead?.authorization?.dispatched === true &&
        ['dispatching', 'running'].includes(newRead.status) &&
        newRead.runId === second.runId &&
        newRead.cancelRequestedAt === null &&
        !second.aborted
        ? true
        : undefined;
    }, 'real_followup_and_both_tool_states_not_settled_before_replay');
    releaseOldReturn.release();
    await until(async () => {
      const interruptTool = await owned.getExecution(old!.input.parentExecutionId);
      return oldReturned && interruptTool?.status === 'succeeded' && continuationPrepared
        ? true
        : undefined;
    }, 'original_interrupt_not_returned_into_real_parent_prepared_checkpoint');
    const before = (await owned.getMetadata()).lastChangeCursor;
    const requestsBefore = options.requests().length;
    const childBefore = await owned.getView(childId);
    const rootBefore = await owned.getView('root');
    const replay = await originalApply(old!.input);
    assert(
      isDeepStrictEqual(replay, old!.result) &&
        isDeepStrictEqual(
          (await owned.getCommand(old!.input.commandId))?.receipt,
          oldCommand?.receipt,
        ),
      'same_original_invocation_replay_returns_identical_R1_receipt',
    );
    assert(
      (await owned.getMetadata()).lastChangeCursor === before &&
        options.requests().length === requestsBefore &&
        isDeepStrictEqual(await owned.getView(childId), childBefore) &&
        isDeepStrictEqual(await owned.getView('root'), rootBefore),
      'old_replay_zero_cursor_model_run_carrier_or_source_mutation',
    );
    assert(
      continuationPrepared !== undefined,
      'original_return_reached_exact_parent_model_preparation',
    );
    // R2 stays gated through original return and replay; its cancellation state cannot
    // be hidden by a quick successful finish.
    assert(
      (await owned.getRun(second.runId!))?.isActive &&
        !second.aborted &&
        (await owned.getExecution(c2!.id))?.cancelRequestedAt === null,
      'R2_remains_active_uncancelled_after_old_return_and_replay',
    );
    releaseParentContinuation.release();
    releaseNewRead.release();
    const finalChild = await until(async () => {
      const view = await owned.getView(childId);
      return view.runs.length === 2 &&
        view.runs.every((run) => !run.isActive) &&
        (await owned.getExecution(c2!.id))?.status === 'succeeded'
        ? view
        : undefined;
    }, 'real_successor_result_not_terminal');
    const finalCarrier = await owned.getExecution(c2!.id);
    assert(
      finalChild.executions.every(
        (execution) => !['planned', 'dispatching', 'running', 'queued'].includes(execution.status),
      ) &&
        finalChild.runs.length === 2 &&
        finalChild.runs.find((run) => run.id === second.runId)?.status === 'completed' &&
        reads.length === 2 &&
        !second.aborted,
      'exactly_two_child_activations_old_cancelled_new_completed_no_R2_abort',
    );
    assert(
      String(object(finalCarrier?.result).content ?? '').includes(nonce) &&
        (await owned.getExecution(second.executionId))?.status === 'succeeded',
      'real_successor_result_contains_complete_actual_material',
    );
    const accepted = await until(async () => {
      const carrier = await owned.getExecution(c2!.id);
      return carrier?.resultAcceptance
        ? { carrier, acceptance: carrier.resultAcceptance }
        : undefined;
    }, 'successor_result_not_accepted');
    const prepared = await until(async () => {
      const found: ModelRequest[] = [];
      for (const request of options.requests().slice(firstRequest)) {
        const execution = await owned.getExecution(request.requestId);
        if (
          execution?.sessionId === 'root' &&
          execution.runId === accepted.acceptance.runId &&
          request.messages.some((message) =>
            message.sourceIds?.includes(accepted.acceptance.sourceId),
          )
        )
          found.push(request);
      }
      return found.length ? found : undefined;
    }, 'accepted_successor_source_not_in_actual_parent_model');
    const acceptedRun = accepted.acceptance.runId
      ? await owned.getRun(accepted.acceptance.runId)
      : null;
    assert(
      acceptedRun?.contextSelectionId === accepted.acceptance.selectionId &&
        accepted.acceptance.resultRevision === accepted.carrier.resultRevision &&
        prepared.every(
          (request) =>
            request.messages.reduce(
              (count, message) =>
                count +
                (message.sourceIds?.filter((source) => source === accepted.acceptance.sourceId)
                  .length ?? 0),
              0,
            ) === 1,
        ) &&
        prepared.some((request) =>
          request.messages.some(
            (message) =>
              message.sourceIds?.includes(accepted.acceptance.sourceId) &&
              message.content.includes(nonce),
          ),
        ),
      'exact_parent_run_prepared_unique_original_successor_source_revision_and_fact',
    );
    const pairedPrepared = options
      .requests()
      .slice(firstRequest)
      .some((request) => {
        const declared = request.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.toolCalls?.length === 2 &&
            message.toolCalls.some((call) => call.id === t1!.callId) &&
            message.toolCalls.some((call) => call.id === t2!.callId),
        );
        return (
          declared &&
          [t1!.callId, t2!.callId].every(
            (callId) =>
              request.messages.filter(
                (message) => message.role === 'tool' && message.toolCallId === callId,
              ).length === 1,
          )
        );
      });
    assert(
      pairedPrepared,
      'actual_parent_prepared_input_has_complete_exact_original_control_pairs_once',
    );
    assert(
      (await owned.getExecution(spawn!.ref.executionId!))?.status === 'cancelled' &&
        (await owned.getRun(first.runId!))?.status === 'cancelled',
      'original_R1_cancellation_not_relabelled_success_by_R2_delivery',
    );
    await until(async () => {
      const view = await owned.getView('root');
      return view.runs.length > 0 &&
        view.runs.every((run) => !run.isActive) &&
        view.executions.every(
          (execution) =>
            !['planned', 'dispatching', 'running', 'queued'].includes(execution.status),
        )
        ? true
        : undefined;
    }, 'all_parent_work_not_terminal');
    const finalRoot = await owned.getView('root');
    assert(
      finalRoot.executions.filter((execution) => execution.childSessionId).length === 2 &&
        spawnCount === 1 &&
        interruptCount === 1 &&
        followupCount === 1,
      'only_original_C1_C2_and_original_control_invocations',
    );
    assert(
      isDeepStrictEqual(
        (await owned.getCommand(old!.input.commandId))?.receipt,
        oldCommand?.receipt,
      ) &&
        isDeepStrictEqual(
          (await owned.getRun(first.runId!))?.configuration,
          original.run?.configuration,
        ) &&
        isDeepStrictEqual(
          (await owned.getExecution(spawn!.ref.executionId!))?.childConfiguration,
          original.carrier?.childConfiguration,
        ),
      'original_receipt_and_R1_configuration_never_rewritten',
    );
    assert(
      isDeepStrictEqual(
        (await owned.getCommand(spawn!.ref.commandId))?.request,
        assignmentCommand?.request,
      ) &&
        isDeepStrictEqual(
          (await owned.getCommand(original.run!.originCommandId))?.request,
          originalChildCommand?.request,
        ),
      'original_assignment_and_child_start_requests_not_rewritten',
    );
    assert(
      readFileSync(material, 'utf8') === `verified_fact=${nonce}\r\n`,
      'owned_material_unchanged',
    );
    status = 'passed';
  } catch (error) {
    const candidate = object(error);
    const safeCode =
      typeof candidate.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(candidate.code)
        ? candidate.code
        : undefined;
    originalError = {
      name:
        error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name)
          ? error.name
          : 'UnknownError',
      ...(safeCode ? { code: safeCode } : {}),
    };
    if (error instanceof Boundary) {
      reason = error.reason;
      failurePoint = error.point;
      status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    } else {
      reason = 'execution_unavailable';
      failurePoint = signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
    }
    if (Object.values(checks).includes(false)) status = 'failed';
  } finally {
    cleanupAbort.abort();
    releaseParentContinuation.release();
    releaseOldReturn.release();
    releaseNewRead.release();
    firstEntered.release();
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
  return {
    cases: [
      {
        id: caseId,
        status,
        checks,
        reason,
        failurePoint,
        originalError,
        adapterAttempts: options.requests().length - firstRequest,
        canonicalEvidenceRetained: retained,
        coverage: [
          'ordinary_six_tools_real_same_reply_interrupt_and_followup',
          'real_committed_C1_pin_delayed_return_while_C2_R2_active',
          'same_invocation_replay_no_retarget_or_mutation',
          'same_child_two_real_runs_original_cancel_domain_isolated',
          'actual_parent_model_unique_accepted_successor_source_and_complete_fact',
          'owned_allow_scheduling_fixture_not_default_policy_or_UI',
          'no_precommit_old_targetRunId_or_all_A08_variants_qualification',
        ],
      },
    ],
  };
}
