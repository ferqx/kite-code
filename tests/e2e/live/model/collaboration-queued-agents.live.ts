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

const ids = ['A06-queued-two-guidance', 'A08-queued-interrupt'] as const;
export type LiveQueuedAgentCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveQueuedAgentCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type EnsureInput = Parameters<Store['ensureOperation']>[0];
type Ref = Awaited<ReturnType<Store['ensureOperation']>>;
type ControlInput = Parameters<Store['applyAgentCommand']>[0];
type ControlResult = Awaited<ReturnType<Store['applyAgentCommand']>>;
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
        abort = () => reject(Error('live_queued_agent_aborted'));
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
/** Owned isolated fixture only; all parent/child Models use the injected counted real adapter. */
export async function runLiveQueuedAgentRaces(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_queued_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-queued-agents-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const facts = Array.from({ length: 4 }, (_, index) => `slot-${index + 1}-fact-${randomUUID()}`);
    const guides = [`first-guidance-${randomUUID()}`, `second-guidance-${randomUUID()}`];
    for (const [index, fact] of facts.entries())
      writeFileSync(join(workspace, `slot-${index + 1}.txt`), `verified_fact=${fact}\n`, {
        mode: 0o600,
      });
    const checks: Result['checks'] = {};
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive';
    let reason: Result['reason'];
    let failurePoint: string | undefined;
    let retained = false;
    let store: Store | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    const firstThreeReady = gate(),
      releaseFirstThree = gate(),
      releaseControlReturn = gate();
    const reads: { sessionId: string; runId: string | null; executionId: string; slot: number }[] =
      [];
    const spawns: { input: EnsureInput; ref: Ref }[] = [];
    const controls: { input: ControlInput; result: ControlResult }[] = [];
    let spawnCalls = 0;
    let controlCommitted = false;
    let controlEntered = 0,
      controlReturned = 0;
    let readAborts = 0;
    let activatedFourthPreparedWithBothGuides = false;
    let adapterStarts = 0;
    const requireBranch = (condition: unknown, point: string) => {
      if (!condition) throw new Boundary('branch_not_reached', point);
    };
    const assert = (condition: unknown, point: string) => {
      checks[point] = Boolean(condition);
      if (!condition) throw new Boundary('oracle_violation', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      const deadline = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), options.signal);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const originalEnsure = owned.ensureOperation.bind(owned);
      owned.ensureOperation = async (input) => {
        if (input.sessionId !== 'root' || !input.collaborationCompletion)
          return originalEnsure(input);
        const index = spawnCalls++;
        if (index === 3) await wait(firstThreeReady.promise, options.signal);
        const ref = await originalEnsure(input);
        spawns[index] = { input: structuredClone(input), ref: structuredClone(ref) };
        return ref;
      };
      const originalApply = owned.applyAgentCommand.bind(owned);
      owned.applyAgentCommand = async (input) => {
        const fourth = spawns[3];
        const wanted = id === 'A06-queued-two-guidance' ? 'follow_up' : 'interrupt';
        if (
          !fourth ||
          input.sessionId !== 'root' ||
          input.agentId !== fourth.ref.childSessionId ||
          input.kind !== wanted
        )
          return originalApply(input);
        controlEntered++;
        const result = await originalApply(input);
        controls.push({ input: structuredClone(input), result: structuredClone(result) });
        if (controls.length === (id === 'A06-queued-two-guidance' ? 2 : 1)) {
          controlCommitted = true;
        }
        await wait(releaseControlReturn.promise, options.signal);
        controlReturned++;
        return result;
      };
      const reader: ToolDefinition = {
        id: 'live.queued-material',
        version: '1',
        model: { name: 'read_queued_material' },
        description:
          'Read one complete owned synthetic slot material. Initial reads may be pending; never cancel, replace or guess a pending read.',
        inputSchema: {
          type: 'object',
          properties: { slot: { type: 'integer', minimum: 1, maximum: 4 } },
          required: ['slot'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const slot = object(input).slot;
          if (
            context.sessionId === 'root' ||
            typeof slot !== 'number' ||
            !Number.isInteger(slot) ||
            slot < 1 ||
            slot > 4
          )
            return {
              outcome: 'failed',
              content: 'Only delegated children may read their assigned slot.',
            };
          reads.push({
            sessionId: context.sessionId,
            runId: context.runId,
            executionId: context.executionId,
            slot,
          });
          if (slot <= 3) {
            if (new Set(reads.filter((row) => row.slot <= 3).map((row) => row.slot)).size === 3)
              firstThreeReady.release();
            try {
              await wait(
                releaseFirstThree.promise,
                AbortSignal.any([options.signal, context.signal]),
              );
            } catch (error) {
              if (context.signal.aborted) readAborts++;
              throw error;
            }
          }
          return {
            outcome: 'succeeded',
            content: readFileSync(join(workspace, `slot-${slot}.txt`), 'utf8'),
          };
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
            spawns[3]?.ref.childSessionId === execution?.sessionId &&
            id === 'A06-queued-two-guidance'
          ) {
            const text = request.messages.map((message) => message.content).join('\n');
            if (guides.every((guide) => text.includes(guide)))
              activatedFourthPreparedWithBothGuides = true;
          }
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([options.signal, context.signal]),
          }))
            yield event;
        },
      };
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        extensions: [
          { id: 'live.queued-fixture', version: '1', apiMajor: 1, tools: [reader] },
          createTaskExtension({
            roles: [
              { id: 'worker', configurationId: 'worker', description: 'Finite owned slot worker.' },
            ],
          }),
        ],
        permissions: {
          authorize: async () => ({ allowed: true, revision: 'owned-queued-agent-fixture-only' }),
        },
        afterTurn: {
          authorize: async () => ({ allowed: true, revision: 'owned-queued-agent-fixture-only' }),
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
        buildId: 'live-queued-agents',
        subjectId: 'live-queued-owner',
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
        name: 'Owned queued agents',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Live queued agents',
      });
      const task = (slot: number) =>
        `Read your assigned material using read_queued_material slot ${slot} exactly once. Report the complete actual verified fact. Do not read another slot, delegate, send messages or call controls. Incorporate any queued same-work guidance into this original turn and include its exact markers in your final result.`;
      const instruction =
        `New task: Spawn exactly FOUR independent collaborators in order with spawn_agent, prompt only and no preset; each gets its own assignment: ${Array.from({ length: 4 }, (_, index) => `#${index + 1}: ${JSON.stringify(task(index + 1))}`).join('\n')} The first three reads may remain pending; keep creating the fourth without waiting for their results. Remember the EXACT agent_id returned for collaborator #4; never choose a different child. ` +
        (id === 'A06-queued-two-guidance'
          ? `After the fourth spawn returns, emit exactly TWO follow_up_agent calls together in ONE Tool batch in the SAME Model response, both targeting that exact fourth agent_id. Do not wait for either follow-up response before emitting the other. Emit no other Tool in this batch. One content ${JSON.stringify(`For this same queued assignment, include this exact marker in your eventual report: ${guides[0]}. Do not start another turn or reread.`)}, the other content ${JSON.stringify(`Also include this second exact marker in the same report: ${guides[1]}. Keep the first marker and original material requirement. Do not start another turn or reread.`)}. `
          : 'After the fourth spawn returns, use interrupt_agent exactly ONCE for that exact fourth agent_id, which is queued. Do not interrupt any other collaborator. ') +
        'Then observe all original collaborators through list_agents and wait_agent_events until terminal and report actual results. Never spawn replacements, repeat mutation calls, read materials yourself, alter assignments of the first three, or fabricate facts. A cancelled fourth has no material result; do not revive it.';
      await client.startRun(
        'root',
        { expectedStoreId, commandId: 'work', kind: 'run.start', content: instruction },
        { signal: options.signal },
      );
      await until(async () => (controlCommitted ? true : undefined), 'queued_control_not_reached');
      requireBranch(
        spawns.length === 4 && spawns.every(Boolean),
        'four_original_spawns_not_captured',
      );
      const fourth = spawns[3]!;
      const fourthId = fourth.ref.childSessionId!;
      assert(
        spawns.every((spawn, index) =>
          String(object(spawn.input.request.input).content).includes(
            `slot ${index + 1} exactly once`,
          ),
        ),
        'four_original_assignments_match_spawn_order_and_owned_slots',
      );
      if (id === 'A06-queued-two-guidance')
        assert(
          controls.length === 2 &&
            guides.every(
              (guide) =>
                controls.filter((control) => control.input.content?.includes(guide)).length === 1,
            ),
          'two_distinct_guidances_both_preserved_without_commit_order_requirement',
        );
      if (id === 'A06-queued-two-guidance') {
        assert(
          controlEntered === 2 && controlReturned === 0,
          'both_real_guidances_entered_and_committed_before_either_return',
        );
        const tools = await Promise.all(
          controls.map((control) => owned.getExecution(control.input.parentExecutionId)),
        );
        const source = object(tools[0]?.decisionSource).modelExecutionId;
        requireBranch(
          typeof source === 'string' &&
            tools.every((tool) => object(tool?.decisionSource).modelExecutionId === source),
          'two_guidances_not_in_same_real_model_tool_batch',
        );
        const sourceModel = await owned.getExecution(source as string);
        requireBranch(
          Array.isArray(object(sourceModel?.result).toolCalls) &&
            (object(sourceModel?.result).toolCalls as unknown[]).length === 2,
          'guidance_batch_contains_other_calls',
        );
        assert(
          new Set(tools.map((tool) => tool?.id)).size === 2 &&
            tools.every(
              (tool) =>
                tool?.definitionId === 'task.follow_up' &&
                tool.authorization?.dispatched === true &&
                ['dispatching', 'running'].includes(tool.status),
            ),
          'two_distinct_real_follow_up_tools_dispatched_together',
        );
      }
      const originalFourthCommand = await owned.getCommand(fourth.ref.commandId);
      const queuedCarrier = await owned.getExecution(fourth.ref.executionId!);
      assert(
        queuedCarrier?.childSessionId === fourthId &&
          (id === 'A06-queued-two-guidance'
            ? queuedCarrier.status === 'planned' && queuedCarrier.cancelRequestedAt === null
            : ['planned', 'cancelled'].includes(queuedCarrier.status) &&
              queuedCarrier.cancelRequestedAt !== null),
        'exact_fourth_original_carrier_queued_or_precisely_cancelled',
      );
      assert(
        (await owned.getView(fourthId)).runs.length === 0 &&
          !(await owned.listExecutions(fourthId)).some((row) => row.kind === 'model'),
        'queued_fourth_has_no_run_model_or_signed_deadline',
      );
      assert(
        new Set(reads.map((row) => row.slot)).size === 3 && reads.every((row) => row.slot <= 3),
        'only_three_original_material_tools_entered_before_control',
      );
      for (const read of reads) {
        const run = await owned.getRun(read.runId!);
        const tool = await owned.getExecution(read.executionId);
        assert(
          run?.isActive &&
            run.status !== 'cancelling' &&
            tool?.authorization?.dispatched === true &&
            ['dispatching', 'running'].includes(tool.status) &&
            tool.cancelRequestedAt === null,
          'three_default_slots_are_real_active_uncancelled_tools',
        );
      }
      for (const control of controls) {
        assert(
          control.result.receipt.accepted === true &&
            control.result.receipt.agentId === fourthId &&
            control.result.receipt.ref.executionId === fourth.ref.executionId,
          'real_control_pins_original_fourth_carrier',
        );
        if (id === 'A06-queued-two-guidance') {
          assert(
            control.result.receipt.mode === 'steer' && control.result.receipt.state === 'queued',
            'two_real_guidances_accepted_for_queued_same_work',
          );
          const pending = await owned.getCommand(`${control.input.commandId}-input`);
          assert(
            pending?.kind === 'agent.queued_input' &&
              object(pending.receipt).carrierId === fourth.ref.executionId &&
              object(JSON.parse(String(object(pending.request).content))).carrierExecutionId ===
                fourth.ref.executionId,
            'queued_guidance_pins_original_carrier_without_target_run',
          );
        } else
          assert(
            control.result.receipt.outcome === 'cancel_requested',
            'real_queued_interrupt_accepted_for_exact_fourth',
          );
      }
      const cursor = (await owned.getMetadata()).lastChangeCursor;
      const beforeIdentities = (await owned.listExecutions('root'))
        .filter((row) => row.childSessionId)
        .map((row) => row.id);
      for (const control of controls)
        assert(
          isDeepStrictEqual(await originalApply(control.input), control.result),
          'same_control_invocation_returns_exact_original_receipt',
        );
      assert(
        (await owned.getMetadata()).lastChangeCursor === cursor &&
          isDeepStrictEqual(
            (await owned.listExecutions('root'))
              .filter((row) => row.childSessionId)
              .map((row) => row.id),
            beforeIdentities,
          ) &&
          (await owned.getView(fourthId)).runs.length === 0,
        'same_invocation_replay_zero_cursor_carrier_or_run',
      );
      releaseFirstThree.release();
      releaseControlReturn.release();
      const terminal = await until(async () => {
        const carriers = (await owned.listExecutions('root')).filter((row) => row.childSessionId);
        return carriers.length === 4 &&
          carriers.every((row) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status),
          )
          ? carriers
          : undefined;
      }, 'original_four_carriers_not_terminal');
      const rootView = await until(async () => {
        const view = await owned.getView('root');
        return view.runs.length > 0 &&
          view.runs.every((run) => !run.isActive) &&
          !view.executions.some((row) =>
            ['planned', 'dispatching', 'running', 'queued'].includes(row.status),
          )
          ? view
          : undefined;
      }, 'original_parent_not_terminal');
      assert(
        terminal.length === 4 &&
          spawns.length === 4 &&
          (await owned.listExecutions('root')).filter((row) => row.childSessionId).length === 4,
        'exactly_four_original_carriers_no_replacements',
      );
      assert(
        controls.length === (id === 'A06-queued-two-guidance' ? 2 : 1),
        'only_requested_original_fourth_controls_committed',
      );
      const publicWork = await owned.getCommand('work');
      const publicReceipt = object(publicWork?.receipt);
      const hasBusinessBridge = Object.hasOwn(publicReceipt, 'businessCommandId');
      const originalBusinessId = hasBusinessBridge
        ? publicReceipt.businessCommandId
        : publicWork?.id;
      const originalRootRun =
        typeof publicReceipt.runId === 'string' ? await owned.getRun(publicReceipt.runId) : null;
      assert(
        publicWork?.id === 'work' &&
          publicWork.kind === 'run.start' &&
          typeof originalBusinessId === 'string' &&
          originalBusinessId.length > 0 &&
          originalRootRun !== null &&
          originalRootRun.id === publicReceipt.runId &&
          originalRootRun.sessionId === 'root' &&
          originalRootRun.rootWorkCommandId === 'work' &&
          originalRootRun.originCommandId === originalBusinessId,
        'public_receipt_identifies_exact_original_business_run_direct_or_bridged',
      );
      assert(
        object(originalRootRun?.configuration).maxConcurrentSubagents === 3,
        'production_default_three_child_slots_without_override',
      );
      for (const spawn of spawns.slice(0, 3)) {
        const carrier = await owned.getExecution(spawn.ref.executionId!);
        const view = await owned.getView(spawn.ref.childSessionId!);
        const read = reads.find((row) => row.sessionId === spawn.ref.childSessionId);
        assert(
          carrier?.status === 'succeeded' &&
            view.runs.length === 1 &&
            view.runs[0]?.status === 'completed' &&
            read &&
            String(object(carrier.result).content ?? '').includes(facts[read.slot - 1]!) &&
            (await owned.getExecution(read.executionId))?.status === 'succeeded',
          'first_three_real_children_complete_actual_material_once',
        );
      }
      assert(
        readAborts === 0 &&
          [1, 2, 3].every((slot) => reads.filter((row) => row.slot === slot).length === 1),
        'original_three_tools_never_aborted_or_reread',
      );
      const finalFourth = await owned.getExecution(fourth.ref.executionId!);
      const fourthView = await owned.getView(fourthId);
      const fourthRequests = [];
      for (const request of options.requests().slice(firstRequest)) {
        if ((await owned.getExecution(request.requestId))?.sessionId === fourthId)
          fourthRequests.push(request);
      }
      if (id === 'A06-queued-two-guidance') {
        const run = fourthView.runs[0];
        assert(
          finalFourth?.status === 'succeeded' &&
            fourthView.runs.length === 1 &&
            run?.status === 'completed' &&
            run.deadlineAt !== null &&
            run.deadlineAt - run.createdAt === 1_800_000,
          'fourth_activates_one_original_run_with_production_activation_deadline',
        );
        assert(
          activatedFourthPreparedWithBothGuides &&
            fourthRequests.length > 0 &&
            fourthRequests[0]!.messages.some((message) => message.content.includes(guides[0]!)) &&
            fourthRequests[0]!.messages.some((message) => message.content.includes(guides[1]!)),
          'first_actual_activated_fourth_model_contains_both_queued_guidances',
        );
        assert(
          reads.filter((row) => row.sessionId === fourthId).length === 1 &&
            reads.find((row) => row.sessionId === fourthId)?.slot === 4 &&
            String(object(finalFourth?.result).content ?? '').includes(facts[3]!) &&
            guides.every((guide) =>
              String(object(finalFourth?.result).content ?? '').includes(guide),
            ),
          'fourth_actual_result_has_original_material_and_both_guidance_markers',
        );
      } else {
        assert(
          finalFourth?.status === 'cancelled' &&
            fourthView.runs.length === 0 &&
            fourthRequests.length === 0 &&
            fourthView.executions.filter((row) => row.kind === 'model').length === 0 &&
            !reads.some((row) => row.sessionId === fourthId),
          'cancelled_queued_fourth_never_activates_after_three_real_slots_release',
        );
      }
      assert(
        isDeepStrictEqual(
          (await owned.getCommand(fourth.ref.commandId))?.request,
          originalFourthCommand?.request,
        ),
        'original_fourth_assignment_never_rewritten',
      );
      assert(
        rootView.executions.some(
          (row) => row.definitionId === 'task.list' && row.status === 'succeeded',
        ) &&
          rootView.executions.some(
            (row) => row.definitionId === 'task.events' && row.status === 'succeeded',
          ),
        'real_parent_observed_original_children_after_slot_settlement',
      );
      let acceptedSourceCount = 0;
      async function verifyAcceptedSource(carrierId: string, requiredFacts: readonly string[]) {
        const accepted = await until(async () => {
          const carrier = await owned.getExecution(carrierId);
          return carrier?.resultAcceptance
            ? { carrier, acceptance: carrier.resultAcceptance }
            : undefined;
        }, 'original_successful_carrier_result_not_accepted');
        const targetRun = accepted.acceptance.runId
          ? await owned.getRun(accepted.acceptance.runId)
          : null;
        assert(
          Boolean(targetRun) &&
            accepted.acceptance.resultRevision === accepted.carrier.resultRevision &&
            accepted.acceptance.selectionId === targetRun?.contextSelectionId,
          'original_carrier_exact_revision_has_pinned_acceptance',
        );
        const requests = await until(async () => {
          const observed: { sourceCount: number; factsPresent: boolean }[] = [];
          for (const request of options.requests().slice(firstRequest)) {
            const execution = await owned.getExecution(request.requestId);
            if (execution?.sessionId !== 'root' || execution.runId !== accepted.acceptance.runId)
              continue;
            const messages = request.messages.filter((message) =>
              message.sourceIds?.includes(accepted.acceptance.sourceId),
            );
            const sourceCount = messages.reduce(
              (count, message) =>
                count +
                (message.sourceIds?.filter((sourceId) => sourceId === accepted.acceptance.sourceId)
                  .length ?? 0),
              0,
            );
            if (sourceCount)
              observed.push({
                sourceCount,
                factsPresent: requiredFacts.every((fact) =>
                  messages.some((message) => message.content.includes(fact)),
                ),
              });
          }
          return observed.length > 0 ? observed : undefined;
        }, 'exact_accepted_source_not_prepared_in_real_parent_model');
        assert(
          requests.length > 0 && requests.every((request) => request.sourceCount === 1),
          'exact_accepted_parent_run_actual_model_has_original_source_once',
        );
        assert(
          requests.some((request) => request.factsPresent),
          'exact_accepted_source_actual_parent_model_contains_original_material_facts',
        );
        acceptedSourceCount++;
      }
      for (const spawn of spawns.slice(0, 3)) {
        const read = reads.find((row) => row.sessionId === spawn.ref.childSessionId)!;
        await verifyAcceptedSource(spawn.ref.executionId!, [facts[read.slot - 1]!]);
      }
      if (id === 'A06-queued-two-guidance')
        await verifyAcceptedSource(fourth.ref.executionId!, [facts[3]!, ...guides]);
      else
        assert(
          finalFourth?.resultAcceptance === null,
          'cancelled_queued_fourth_does_not_fabricate_result_acceptance',
        );
      checks.successfulOriginalAcceptedSourcesVerified = acceptedSourceCount;
      await until(async () => {
        const view = await owned.getView('root');
        return view.runs.every((run) => !run.isActive) &&
          !view.executions.some((row) => ['planned', 'dispatching', 'running'].includes(row.status))
          ? true
          : undefined;
      }, 'accepted_parent_models_not_terminal');
      assert(
        spawns.length === 4 &&
          (await owned.listExecutions('root')).filter((row) => row.childSessionId).length === 4,
        'no_replacement_after_actual_parent_source_delivery',
      );
      if (id === 'A08-queued-interrupt')
        assert(
          (await owned.getExecution(fourth.ref.executionId!))?.status === 'cancelled' &&
            (await owned.getView(fourthId)).runs.length === 0 &&
            !(await owned.listExecutions(fourthId)).some((row) => row.kind === 'model'),
          'late_parent_settlement_preserves_zero_fourth_activation',
        );
      assert(
        options.requests().length - firstRequest > 0 &&
          options.requests().length - firstRequest <= 40,
        'all_adapter_attempts_within_case_limit',
      );
      status = 'passed';
    } catch (error) {
      if (error instanceof Boundary) {
        status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
        reason = error.reason;
        failurePoint = error.point;
      } else {
        reason = 'execution_unavailable';
        failurePoint = options.signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
      }
      const failed = Object.entries(checks).find(([, value]) => value === false);
      if (failed) {
        status = 'failed';
        reason = 'oracle_violation';
        failurePoint = failed[0];
      }
    } finally {
      releaseFirstThree.release();
      releaseControlReturn.release();
      firstThreeReady.release();
      let closed = true;
      try {
        client?.disposeNetwork();
      } catch {
        closed = false;
      }
      let runtimeClosed = false;
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
      coverage:
        id === 'A06-queued-two-guidance'
          ? [
              'default_three_slots_then_fourth_queued',
              'two_concurrent_real_queued_same_work_guidances',
              'same_invocation_replay_zero_mutation',
              'one_activated_run_exact_guidance_and_actual_material',
              'original_accepted_source_exact_parent_run_actual_model_once',
              'activation_deadline_not_queued_deadline',
              'owned_allow_fixture_not_default_policy',
            ]
          : [
              'default_three_slots_then_fourth_queued',
              'real_exact_queued_interrupt',
              'late_slot_release_zero_fourth_model_or_run',
              'first_three_complete_actual_material',
              'owned_allow_fixture_not_default_policy',
              'no_R1_R2_or_idle_interrupt_qualification',
            ],
    });
  }
  return { cases };
}
