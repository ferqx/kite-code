import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
  'R12-all-optional-observers-absent',
  'R12-slow-throwing-observer-disabled-durable-report',
] as const;
export type LiveNotificationReliabilityCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveNotificationReliabilityCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  semanticReviewRequired: true;
  coverage: string[];
  operationSequence: string[];
  injectionPoint: string;
  injectionDefinitionSha256: string;
  proofHashes: Record<string, string>;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
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
        abort = () => reject(Error('live_result_transactions_aborted'));
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
/** Private owned Service/Runtime fixture. All Models use the caller's counted real adapter.
 * Caller must enforce <=40 physical HTTP / 600s; this module also bounds adapter starts.
 * Observer faults affect only actual callback delivery. No Model response, SQL fact or
 * business result is rewritten. No overflow claim: production observer capacities stay 128/16.
 */
export async function runLiveNotificationReliability(
  options: Options,
): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_result_transactions_evidence_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const observersInstalled = id === 'R12-slow-throwing-observer-disabled-durable-report';
    const cleanup = new AbortController();
    const signal = AbortSignal.any([options.signal, cleanup.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-result-transactions-')),
    );
    const checks: Result['checks'] = {};
    const requestStart = options.requests().length;
    let store: Store | undefined, runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let retained = true;
    const barrierEntered = gate(),
      terminalReached = gate(),
      releaseTerminal = gate();
    let carrierRef: Awaited<ReturnType<Store['ensureOperation']>> | undefined;
    let spawnCount = 0,
      barrierCount = 0,
      readCount = 0,
      adapterStarts = 0;
    let candidateRunId: string | undefined;
    let candidateActiveAtPrepublication = false;
    let carrierFinishHeld = false;
    const observerGate = gate();
    const observed: { eventId: string; type: string; originCommandId: string }[] = [];
    const hookSelections: { phase: string; commandId: string; kind: string }[] = [];
    const hookEffects: string[] = [];
    let observerThrew = false;
    const operationSequence: string[] = [];
    const proofHashes: Record<string, string> = {};
    const hashProof = (value: unknown) =>
      createHash('sha256')
        .update(
          JSON.stringify(value, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item,
          ),
        )
        .digest('hex');
    const assert = (value: unknown, point: string) => {
      checks[point] = Boolean(value);
      if (!value) throw new Boundary('oracle_violation', point);
    };
    const branch = (value: unknown, point: string) => {
      if (!value) throw new Boundary('branch_not_reached', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      const end = Date.now() + 90_000;
      for (;;) {
        signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
      }
    }
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const fact = `actual-result-${randomUUID()}`;
      const material = `verified_fact=${fact}\r\n`;
      const materialPath = join(workspace, 'owned-material.txt');
      writeFileSync(materialPath, material, { mode: 0o600 });
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      function sourceRows() {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return db
            .query(
              "SELECT id,session_id,execution_id,CAST(result_revision AS TEXT) AS result_revision,selection_id,request_json FROM context_snapshot WHERE kind='result_ref' AND execution_id=? ORDER BY seq",
            )
            .all(carrierRef?.executionId ?? '') as {
            id: string;
            session_id: string;
            execution_id: string;
            result_revision: string;
            selection_id: string;
            request_json: string;
          }[];
        } finally {
          db.close();
        }
      }
      const ensure = owned.ensureOperation.bind(owned);
      owned.ensureOperation = async (input) => {
        const ref = await ensure(input);
        if (input.sessionId === 'root' && input.collaborationCompletion) {
          spawnCount++;
          if (!carrierRef) carrierRef = structuredClone(ref);
        }
        return ref;
      };
      const finish = owned.finishExecution.bind(owned);
      owned.finishExecution = async (input) => {
        if (
          input.executionId !== carrierRef?.executionId ||
          object(input.result).outcome !== 'succeeded'
        )
          return finish(input);
        const carrier = await owned.getExecution(input.executionId);
        const parentId = object(carrier?.afterTurn).parentRunId;
        if (typeof parentId === 'string') {
          candidateRunId = parentId;
          candidateActiveAtPrepublication = (await owned.getRun(parentId))?.isActive === true;
        }
        terminalReached.release();
        carrierFinishHeld = true;
        await wait(releaseTerminal.promise, signal);
        return finish(input);
      };
      const observe = async (
        event: Readonly<{ eventId: string; type: string; originCommandId: string }>,
      ) => {
        observed.push({
          eventId: event.eventId,
          type: event.type,
          originCommandId: event.originCommandId,
        });
        await wait(observerGate.promise, signal);
        observerThrew = true;
        throw Error('owned_live_observer_failure');
      };
      const read: ToolDefinition = {
        id: 'live.result-material',
        version: '1',
        model: { name: 'read_result_material' },
        description: 'Read the complete one owned synthetic child material exactly once.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          if (context.sessionId === 'root')
            return { outcome: 'failed', content: 'Delegated child only.' };
          readCount++;
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'cancelled_before_owned_read' };
          return { outcome: 'succeeded', content: readFileSync(materialPath, 'utf8') };
        },
      };
      const barrier: ToolDefinition = {
        id: 'live.parent-publication-barrier',
        version: '1',
        model: { name: 'observe_child_publication_barrier' },
        description:
          'Observe the exact original child publication barrier once. This returns scheduling facts only, never child result text. Finish the current parent turn after this observation.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          if (context.sessionId !== 'root')
            return { outcome: 'failed', content: 'Original parent only.' };
          barrierCount++;
          barrierEntered.release();
          try {
            await wait(terminalReached.promise, AbortSignal.any([signal, context.signal]));
          } catch (error) {
            if (context.signal.aborted)
              return { outcome: 'cancelled', content: 'cancelled_before_barrier_observation' };
            throw error;
          }
          return {
            outcome: 'succeeded',
            content:
              'The original child reached the publication barrier but its result is not published. Finish this parent turn normally without another Tool; the original child will report later.',
          };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          if (adapterStarts++ >= 40)
            throw new Boundary('branch_not_reached', 'hard_40_adapter_start_limit');
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([signal, context.signal]),
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
        permissions: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-notification-fixture-not-default-policy',
          }),
        },
        afterTurn: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-notification-after-turn-not-default-policy',
          }),
        },
        extensions: [
          {
            id: 'live.notification-fixture',
            version: '1',
            apiMajor: 1,
            tools: [read, barrier],
          },
          {
            id: 'live.lifecycle-proof',
            version: '1',
            apiMajor: 1,
            lifecycle: {
              async beforeRun(event) {
                hookSelections.push({
                  phase: 'before',
                  commandId: event.command.id,
                  kind: event.command.kind,
                });
                return event.command.id === 'A'
                  ? { actionId: 'count', definitionVersion: '1', input: { phase: 'before' } }
                  : null;
              },
              async beforeRunComplete(event) {
                hookSelections.push({
                  phase: 'complete',
                  commandId: event.command.id,
                  kind: event.command.kind,
                });
                return event.command.id === 'A'
                  ? { actionId: 'count', definitionVersion: '1', input: { phase: 'complete' } }
                  : null;
              },
              ...(observersInstalled
                ? {
                    onRunStart: observe,
                    onRunEnd: observe,
                    onModelStart: observe,
                    onModelEnd: observe,
                  }
                : {}),
            },
            actions: [
              {
                id: 'count',
                version: '1',
                description: 'Finite real lifecycle Action count.',
                inputSchema: { type: 'object' },
                async prepare(input) {
                  return input;
                },
                async execute(input) {
                  hookEffects.push(String(object(input).phase));
                  return { outcome: 'succeeded', content: 'Lifecycle count committed.' };
                },
              },
            ],
          },
          createTaskExtension({
            roles: [
              {
                id: 'worker',
                configurationId: 'worker',
                description: 'Owned finite result reader.',
              },
            ],
          }),
        ],
        childConfigurations: [
          {
            id: 'worker',
            version: '1',
            model,
            modelId: options.modelId,
            toolIds: [read.id],
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
        buildId: 'live-notification-reliability',
        subjectId: 'live-result-owner',
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
        name: 'Owned reliable notification',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Owned reliable notification',
      });
      await client.startRun(
        'root',
        {
          expectedStoreId,
          commandId: 'A',
          kind: 'run.start',
          content:
            'New task: Create exactly ONE collaborator using spawn_agent with prompt only and no preset. Its exact instruction: use read_result_material exactly once, then report the complete actual verified_fact from the Tool, with no other Tools, delegation, controls, retries or guesses. After spawn returns, call observe_child_publication_barrier exactly ONCE and then finish your current parent turn normally with a brief scheduling acknowledgment and no further Tool. Do not wait for or read the child yourself, cancel, follow up, message or spawn replacements. If an actual child report reaches you at a later ordinary Model boundary or a later Run, report its complete actual verified_fact and finish; never delegate or observe the barrier again.',
        },
        { signal },
      );
      {
        await until(
          async () => (carrierFinishHeld && candidateRunId ? true : undefined),
          'real_child_terminal_pretransaction_gate_not_reached',
        );
        branch(
          candidateActiveAtPrepublication,
          'original_candidate_parent_already_ended_before_publication_gate',
        );
        assert(
          sourceRows().length === 0 &&
            (await owned.getExecution(carrierRef!.executionId!))?.resultAcceptance === null,
          'no_result_or_target_source_sealed_before_original_parent_ends',
        );
        const originalParent = await until(async () => {
          const run = await owned.getRun(candidateRunId!);
          return run?.status === 'completed' && !run.isActive ? run : undefined;
        }, 'original_active_candidate_parent_did_not_complete_normally');
        assert(
          barrierCount === 1 &&
            (await owned.getView('root')).runs.length === 1 &&
            sourceRows().length === 0,
          'real_parent_normal_completion_precedes_first_report_source_transaction',
        );
        const held = await owned.getExecution(carrierRef!.executionId!);
        const heldChild = await owned.getView(carrierRef!.childSessionId!);
        assert(
          held?.kind === 'job' &&
            ['running', 'dispatching'].includes(held.status) &&
            held.resultAcceptance === null &&
            heldChild.runs.length === 1 &&
            heldChild.runs[0]?.status === 'completed' &&
            sourceRows().length === 0,
          'real_attached_agent_carrier_not_terminal_or_delivered_when_child_and_parent_models_and_runs_completed',
        );
        if (observersInstalled) {
          assert(
            observed.length === 1 && !observerThrew,
            'actual_callback_slow_while_original_parent_and_child_finish_independently',
          );
          observerGate.release();
          await until(
            async () => (observerThrew ? true : undefined),
            'original_callback_did_not_throw',
          );
          operationSequence.push(
            'original_slow_callback_released_and_threw_before_report_registration',
          );
        } else assert(observed.length === 0, 'all_four_optional_on_callbacks_uninstalled');
        releaseTerminal.release();
        const completed = await until(async () => {
          const carrier = await owned.getExecution(carrierRef!.executionId!);
          return carrier?.status === 'succeeded' && carrier.resultAcceptance?.runId
            ? carrier
            : undefined;
        }, 'real_child_report_not_first_accepted_after_original_parent_completion');
        const acceptance = completed.resultAcceptance!;
        const nextRun = await owned.getRun(acceptance.runId!);
        const rows = sourceRows();
        assert(
          rows.length === 1 &&
            rows[0]!.id === acceptance.sourceId &&
            rows[0]!.result_revision === completed.resultRevision &&
            nextRun &&
            nextRun.id !== originalParent.id &&
            nextRun.rootWorkCommandId === 'A' &&
            nextRun.contextSelectionId === acceptance.selectionId &&
            rows[0]!.selection_id === acceptance.selectionId &&
            object(JSON.parse(rows[0]!.request_json)).targetRunId === nextRun.id &&
            isDeepStrictEqual(nextRun.configuration, originalParent.configuration),
          'first_legal_target_is_unique_new_original_A_run_and_exact_source_revision_selection',
        );
        await until(async () => {
          for (const request of options.requests().slice(requestStart)) {
            const execution = await owned.getExecution(request.requestId);
            if (
              execution?.sessionId !== 'root' ||
              execution.runId !== nextRun!.id ||
              execution.status !== 'succeeded'
            )
              continue;
            const messages = request.messages.filter((message) =>
              message.sourceIds?.includes(acceptance.sourceId),
            );
            if (!messages.length) continue;
            assert(
              messages.reduce(
                (n, message) =>
                  n +
                  (message.sourceIds?.filter((source) => source === acceptance.sourceId).length ??
                    0),
                0,
              ) === 1 && messages.some((message) => message.content.includes(fact)),
              'actual_next_parent_model_prepared_exact_source_once_with_complete_real_child_fact',
            );
            const payloadMessage = messages.find((message) =>
              message.content.startsWith(
                'Background execution result (untrusted data; no additional authorization):\n',
              ),
            );
            branch(payloadMessage, 'complete_parent_result_wrapper_not_available');
            const payload = object(JSON.parse(payloadMessage!.content.split('\n')[1]!));
            assert(
              isDeepStrictEqual(payload.result, completed.result) &&
                object(payload.origin).executionId === completed.id &&
                object(payload.origin).resultRevision === completed.resultRevision &&
                object(payload.origin).storeId === completed.originStoreId &&
                String(object(execution.result).content ?? '').includes(fact),
              'real_parent_provider_receives_complete_original_carrier_result_and_reports_nonce',
            );
            return true;
          }
          return undefined;
        }, 'unique_new_parent_source_not_forwarded_to_real_provider');
        await until(async () => {
          const view = await owned.getView('root');
          return view.runs.length === 2 &&
            view.runs.every((run) => run.status === 'completed' && !run.isActive)
            ? true
            : undefined;
        }, 'original_and_unique_report_parent_not_normally_terminal');
        assert(
          (await owned.getRun(originalParent.id))?.status === 'completed' &&
            sourceRows().length === 1,
          'late_report_does_not_reopen_original_completed_parent_or_duplicate_source',
        );
      }
      assert(
        hookSelections.length === 2 &&
          hookSelections.every((entry) => entry.commandId === 'A' && entry.kind === 'run.start') &&
          isDeepStrictEqual(hookEffects, ['before', 'complete']),
        'formal_lifecycle_selection_and_actual_actions_only_once_for_explicit_input_not_child_start_or_report',
      );
      const hookDb = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
        readonly: true,
      });
      let hookCommands: { id: string; status: string }[];
      try {
        hookCommands = hookDb
          .query(
            "SELECT id,status FROM command WHERE kind='extension.invoke' AND json_extract(request_json,'$.extensionId')='live.lifecycle-proof'",
          )
          .all() as { id: string; status: string }[];
      } finally {
        hookDb.close();
      }
      const exactHookCommands = await Promise.all(
        hookCommands.map((command) => owned.getCommand(command.id)),
      );
      const hookIds = new Set(hookCommands.map((command) => command.id));
      const hookExecutions = (await owned.listExecutions('root')).filter((execution) =>
        hookIds.has(execution.originCommandId),
      );
      assert(
        hookCommands.length === 2 &&
          hookCommands.every((command) => command.status === 'applied') &&
          hookExecutions.length === 2 &&
          exactHookCommands.every((command) => {
            if (!command) return false;
            const request = object(command.request);
            const receipt = object(command.receipt);
            const execution = hookExecutions.find((row) => row.id === receipt.executionId);
            return (
              command.kind === 'extension.invoke' &&
              command.status === 'applied' &&
              command.originStoreId === expectedStoreId &&
              command.sessionId === 'root' &&
              command.subjectId === 'live-result-owner' &&
              command.rootWorkCommandId === command.id &&
              request.extensionId === 'live.lifecycle-proof' &&
              request.actionId === 'count' &&
              request.definitionVersion === '1' &&
              ['before', 'complete'].includes(String(object(request.input).phase)) &&
              receipt.status === 'succeeded' &&
              execution?.kind === 'job' &&
              execution.definitionId === 'live.lifecycle-proof/count' &&
              execution.definitionVersion === '1' &&
              execution.status === 'succeeded' &&
              execution.originStoreId === command.originStoreId &&
              execution.originCommandId === command.id &&
              execution.sessionId === command.sessionId &&
              execution.runId === null &&
              execution.rootWorkCommandId === command.rootWorkCommandId &&
              execution.rootWorkSeq === command.rootWorkSeq &&
              execution.parentExecutionId === null
            );
          }),
        'two_actual_lifecycle_action_commands_and_executions_committed_once',
      );
      proofHashes.actualLifecycleActions = hashProof({
        hookCommands,
        hookExecutions,
        hookSelections,
        hookEffects,
      });
      const parentRuns = (await owned.getView('root')).runs;
      const reportRun = parentRuns.find((run) => run.originCommandId !== 'A');
      assert(
        reportRun?.status === 'completed' && !reportRun.isActive,
        'durable_report_parent_terminal_committed',
      );
      if (observersInstalled) {
        assert(
          observerThrew &&
            observed.length === 1 &&
            !observed.some((event) => event.originCommandId === reportRun!.originCommandId),
          'throw_disabled_original_callback_and_discarded_later_real_report_run_and_model_observations',
        );
        proofHashes.actualObserverDelivery = hashProof(observed);
        proofHashes.laterDurableReportRun = hashProof(reportRun);
        const laterModels = (await owned.listExecutions('root')).filter(
          (execution) => execution.kind === 'model' && execution.runId === reportRun!.id,
        );
        const expectedLaterEvents = [
          JSON.stringify(['run.started', expectedStoreId, reportRun!.id]),
          ...laterModels.map((execution) =>
            JSON.stringify(['model.started', expectedStoreId, execution.id]),
          ),
        ];
        assert(
          laterModels.some((execution) => execution.status === 'succeeded') &&
            expectedLaterEvents.every(
              (eventId) => !observed.some((event) => event.eventId === eventId),
            ),
          'exact_real_post_throw_report_run_and_successful_model_start_events_not_delivered',
        );
        proofHashes.actualUndeliveredEventIdentities = hashProof(expectedLaterEvents);
      }
      const child = (await owned.getExecution(carrierRef!.executionId!))!;
      const childView = await owned.getView(carrierRef!.childSessionId!);
      assert(
        spawnCount === 1 &&
          readCount === 1 &&
          barrierCount === 1 &&
          child.status === 'succeeded' &&
          String(object(child.result).content ?? '').includes(fact) &&
          childView.runs.length === 1 &&
          childView.runs[0]?.status === 'completed' &&
          childView.executions.every(
            (execution) => !['planned', 'dispatching', 'running'].includes(execution.status),
          ) &&
          (await owned.listExecutions('root')).filter((execution) => execution.childSessionId)
            .length === 1,
        'one_original_child_actual_material_report_and_fully_terminal_scope_no_replacement',
      );
      const childModels = childView.executions.filter(
        (execution) => execution.kind === 'model' && execution.status === 'succeeded',
      );
      const childFinal = childModels.at(-1);
      assert(
        childFinal &&
          object(childFinal.result).content === object(child.result).content &&
          childView.executions
            .filter(
              (execution) => execution.definitionId === read.id && execution.status === 'succeeded',
            )
            .some((execution) => object(execution.result).content === material),
        'complete_actual_child_model_carrier_body_and_owned_read_match_original_material',
      );
      proofHashes.completeChildResult = hashProof(child.result);
      assert(
        readFileSync(materialPath, 'utf8') === material && adapterStarts <= 40,
        'owned_material_unchanged_and_adapter_attempt_limit_kept',
      );
      const canonicalModelEvidence = [];
      for (const execution of [...(await owned.listExecutions('root')), ...childModels].filter(
        (row) => row.kind === 'model' && row.status === 'succeeded',
      )) {
        const scope = {
          expectedStoreId,
          sessionId: execution.sessionId,
          subjectId: 'live-result-owner',
          executionId: execution.id,
        };
        const input = await runtime.readModelInput({ ...scope, signal });
        const output = await runtime.readModelOutput({ ...scope, signal });
        assert(output.output.complete, 'canonical_successful_Model_output_complete');
        if (execution.id === childFinal!.id)
          assert(
            output.output.content === object(child.result).content,
            'canonical_full_child_Model_output_equals_original_carrier',
          );
        canonicalModelEvidence.push({ scope, input, output });
      }
      writeFileSync(
        join(root, 'canonical-model-evidence.json'),
        `${JSON.stringify(canonicalModelEvidence, null, 2)}\n`,
        { mode: 0o600 },
      );
      proofHashes.canonicalModels = hashProof(canonicalModelEvidence);
      const observerEvidence = {
        id,
        observersInstalled,
        observerThrew,
        observed,
        callbackDefinition: observersInstalled
          ? 'same_callback_all_four_hooks_wait_then_throw'
          : 'all_four_on_properties_absent',
        productionQueueCapacities: { global: 128, perCallbackPending: 16, overridden: false },
        hookSelections,
        hookEffects,
        hookCommands,
        hookExecutions,
        laterDurableReportRun: reportRun,
        laterDurableModels: (await owned.listExecutions('root')).filter(
          (execution) => execution.kind === 'model' && execution.runId === reportRun!.id,
        ),
        carrier: child,
        childFinalModel: childFinal,
        canonicalModelEvidenceFile: 'canonical-model-evidence.json',
        canonicalModelScopes: canonicalModelEvidence.map(({ scope }) => scope),
      };
      writeFileSync(
        join(root, 'observer-evidence.json'),
        `${JSON.stringify(observerEvidence, null, 2)}\n`,
        { mode: 0o600 },
      );
      proofHashes.observerEvidence = hashProof(observerEvidence);
      checks.actual_callback_deliveries = observed.length;
      checks.actual_callback_throw_count = Number(observerThrew);
      assert(observerThrew === observersInstalled, 'actual_observer_throw_matches_registered_case');
      checks.observer_evidence_file_written = true;
      status = 'passed';
    } catch (error) {
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
      cleanup.abort();
      barrierEntered.release();
      releaseTerminal.release();

      terminalReached.release();
      observerGate.release();
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
      adapterAttempts: options.requests().length - requestStart,
      canonicalEvidenceRetained: retained,
      semanticReviewRequired: true,
      operationSequence,
      proofHashes,
      injectionDefinitionSha256: hashProof(
        observersInstalled
          ? 'one actual callback shared by all four lifecycle on* waits original private gate then throws; real LifecycleObservers disables and discards queue'
          : 'all four optional lifecycle on* properties absent',
      ),
      injectionPoint: observersInstalled
        ? 'formal lifecycle callback delivery only; no SQL or business return mutation'
        : 'formal extension registration omits optional lifecycle observer properties',
      coverage: [
        'real_service_client_task_child_single_durable_parent_source_complete_provider_body',
        'explicit_lifecycle_actions_no_child_start_or_job_report_recursion',
        observersInstalled
          ? 'actual_slow_callback_and_throw_disable_with_later_durable_events_unobserved'
          : 'all_four_optional_lifecycle_observers_uninstalled',
        'finite_attached_agent_job_terminal_hold_not_general_jobs_or_cleanup_confirmation',
        'owned_allow_after_turn_not_default_policy_or_production_title_hook_assembly',
        'no_observer_capacity_overflow_all_job_types_cold_recovery_or_full_R12_qualification',
      ],
    });
  }
  return { cases };
}
