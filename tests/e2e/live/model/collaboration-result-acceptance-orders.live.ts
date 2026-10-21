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
  'R04-parent-completes-before-report-transaction',
  'R04-stop-after-acceptance-before-prepared',
  'R04-normal-completion-receives-accepted-source',
] as const;
export type LiveResultAcceptanceOrderCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveResultAcceptanceOrderCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  coverage: string[];
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type ApplyInput = Parameters<Store['applyJobReport']>[0];
type ApplyResult = Awaited<ReturnType<Store['applyJobReport']>>;
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
        abort = () => reject(Error('live_result_acceptance_aborted'));
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
/** Owned scheduling fixture. Every Model uses the caller's real counted adapter.
 * The caller supplies the common physical <=40 HTTP / 600s budget. No SDK factory,
 * credentials, synthetic Model response or direct SQL write exists in this module.
 * R04's default beforeRunComplete and narrower activeOnly-precheck race remain gaps.
 */
export async function runLiveResultAcceptanceOrders(
  options: Options,
): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_result_acceptance_evidence_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const normalCompletion = id === 'R04-normal-completion-receives-accepted-source';
    const stopBeforePrepared = id === 'R04-stop-after-acceptance-before-prepared';
    const cleanup = new AbortController();
    const signal = AbortSignal.any([options.signal, cleanup.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-result-acceptance-')),
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
      releaseTerminal = gate(),
      terminalPublished = gate(),
      releaseAcceptedReturn = gate(),
      parentPlainResponseCommitted = gate();
    let plainCommitted = false;
    const normalStages: Record<string, unknown> = {};
    const actualModels = new Map<
      string,
      { request: ModelRequest; root: boolean; toolCalls: number; finish: boolean; eof: boolean }
    >();
    let carrierRef: Awaited<ReturnType<Store['ensureOperation']>> | undefined;
    let spawnCount = 0,
      barrierCount = 0,
      readCount = 0,
      adapterStarts = 0;
    let candidateRunId: string | undefined;
    let candidateActiveAtPrepublication = false;
    let carrierFinishHeld = false,
      acceptedHeld = false,
      acceptedReturned = false;
    let accepted: { input: ApplyInput; result: ApplyResult } | undefined;
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
      function matchingPrepared(input: unknown, sourceId: string) {
        const messages = object(input).messages;
        return (
          Array.isArray(messages) &&
          messages.some(
            (message) =>
              Array.isArray(object(message).sourceIds) &&
              (object(message).sourceIds as unknown[]).includes(sourceId),
          )
        );
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
        if (normalCompletion && !plainCommitted && carrierRef && input.status === 'succeeded') {
          const actual = actualModels.get(input.executionId);
          const modelExecution = await owned.getExecution(input.executionId);
          if (
            actual?.root &&
            actual.finish &&
            actual.eof &&
            actual.toolCalls === 0 &&
            modelExecution?.runId === candidateRunId
          ) {
            // The real zero-call response and assistant message commit unchanged first.
            const result = await finish(input);
            assert(
              result.status === 'succeeded' && sourceRows().length === 0,
              'plain_parent_model_really_committed_before_any_report_source',
            );
            plainCommitted = true;
            normalStages.plainModelCommitted = {
              model: result,
              cursor: (await owned.getMetadata()).lastChangeCursor,
            };
            parentPlainResponseCommitted.release();
            // Only the independently supervised child is needed here, never same-pump admission.
            await wait(terminalPublished.promise, signal);
            normalStages.reportDurableBeforePlainModelReturn = {
              cursor: (await owned.getMetadata()).lastChangeCursor,
            };
            return result;
          }
        }
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
        if (!stopBeforePrepared && !normalCompletion) {
          // Hold BEFORE this real terminal/report-registration transaction. The
          // parent may finish naturally because no pending result exists yet.
          carrierFinishHeld = true;
          await wait(releaseTerminal.promise, signal);
        }
        if (normalCompletion) await wait(parentPlainResponseCommitted.promise, signal);
        if (stopBeforePrepared) await wait(barrierEntered.promise, signal);
        const result = await finish(input);
        terminalPublished.release();
        return result;
      };
      const apply = owned.applyJobReport.bind(owned);
      owned.applyJobReport = async (input) => {
        const original = await owned.getCommand(input.commandId);
        const matches = object(original?.request).executionId === carrierRef?.executionId;
        const result = await apply(input);
        if (
          (stopBeforePrepared || normalCompletion) &&
          !accepted &&
          matches &&
          input.activeOnly === true &&
          result.command.status === 'applied' &&
          object(result.command.receipt).mode === 'active'
        ) {
          // Acceptance and Source/target selection have really committed. This
          // pauses the owning Loop before checkpoint return, NOT at the adapter.
          accepted = { input: structuredClone(input), result: structuredClone(result) };
          acceptedHeld = true;
          await wait(releaseAcceptedReturn.promise, signal);
          acceptedReturned = true;
        }
        return result;
      };
      if (normalCompletion) {
        const finishRun = owned.finishRun.bind(owned);
        owned.finishRun = async (input) => {
          if (input.status === 'completed' && input.runId === candidateRunId) {
            // Passive assertion only: never await report admission from this same pump.
            const sourceId = object(accepted?.result.command.receipt).sourceId;
            let processed = false;
            for (const [executionId, actual] of actualModels) {
              if (
                !actual.root ||
                !actual.finish ||
                !actual.eof ||
                typeof sourceId !== 'string' ||
                !matchingPrepared(actual.request, sourceId)
              )
                continue;
              const execution = await owned.getExecution(executionId);
              processed ||= execution?.status === 'succeeded' && execution.runId === candidateRunId;
            }
            assert(
              plainCommitted && acceptedReturned && accepted && processed,
              'normal_completion_attempt_follows_actual_processing_of_accepted_source',
            );
            normalStages.normalFinishAttempt = {
              input,
              cursor: (await owned.getMetadata()).lastChangeCursor,
            };
          }
          return finishRun(input);
        };
      }
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
            await wait(
              stopBeforePrepared ? terminalPublished.promise : terminalReached.promise,
              AbortSignal.any([signal, context.signal]),
            );
          } catch (error) {
            if (context.signal.aborted)
              return { outcome: 'cancelled', content: 'cancelled_before_barrier_observation' };
            throw error;
          }
          return {
            outcome: 'succeeded',
            content: stopBeforePrepared
              ? 'The original child terminal publication has completed. Finish this parent turn without another Tool.'
              : 'The original child reached the publication barrier but its result is not published. Finish this parent turn normally without another Tool; the original child will report later.',
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
          const actual = normalCompletion
            ? {
                request: structuredClone(request),
                root: (await owned.getExecution(request.requestId))?.sessionId === 'root',
                toolCalls: 0,
                finish: false,
                eof: false,
              }
            : undefined;
          if (actual) actualModels.set(request.requestId, actual);
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([signal, context.signal]),
          })) {
            if (actual && event.type === 'tool_call') actual.toolCalls++;
            if (actual && event.type === 'finish') actual.finish = true;
            yield event;
          }
          if (actual) actual.eof = true;
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
            revision: 'owned-result-order-fixture-not-default-policy',
          }),
        },
        afterTurn: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-result-order-after-turn-not-default-policy',
          }),
        },
        extensions: [
          { id: 'live.result-order-fixture', version: '1', apiMajor: 1, tools: [read, barrier] },
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
        buildId: 'live-result-acceptance-orders',
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
        name: 'Owned result orders',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Owned acceptance orders',
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
      if (normalCompletion) {
        await until(
          async () => (acceptedHeld && accepted ? true : undefined),
          'normal_completion_active_acceptance_gate_not_reached',
        );
        const receipt = object(accepted!.result.command.receipt);
        const sourceId = String(receipt.sourceId);
        const targetRunId = String(receipt.runId);
        const sourceBefore = sourceRows();
        const childBefore = (await owned.getExecution(carrierRef!.executionId!))!;
        const reportBefore = await owned.getCommand(accepted!.input.commandId);
        const viewBefore = await owned.getView('root');
        assert(
          plainCommitted &&
            candidateActiveAtPrepublication &&
            targetRunId === candidateRunId &&
            (await owned.getRun(targetRunId))?.isActive &&
            !acceptedReturned &&
            viewBefore.runs.length === 1,
          'ordinary_response_completed_but_original_R1_still_active_at_exact_source_acceptance',
        );
        assert(
          sourceBefore.length === 1 &&
            sourceBefore[0]!.id === sourceId &&
            sourceBefore[0]!.execution_id === childBefore.id &&
            sourceBefore[0]!.result_revision === childBefore.resultRevision &&
            sourceBefore[0]!.selection_id ===
              (await owned.getRun(targetRunId))?.contextSelectionId &&
            object(JSON.parse(sourceBefore[0]!.request_json)).targetRunId === targetRunId &&
            childBefore.resultAcceptance?.sourceId === sourceId,
          'normal_checkpoint_commits_unique_exact_original_result_to_R1',
        );
        assert(
          viewBefore.executions
            .filter((execution) => execution.kind === 'model')
            .every(
              (execution) =>
                actualModels.get(execution.id)?.root === true &&
                !matchingPrepared(execution.input, sourceId) &&
                !(object(execution.decisionSource).sourceIds as unknown[] | undefined)?.includes(
                  sourceId,
                ),
            ) &&
            [...actualModels.values()].every(
              (actual) => !matchingPrepared(actual.request, sourceId),
            ),
          'normal_completion_source_accepted_before_any_new_parent_model_prepared_or_forwarded',
        );
        normalStages.acceptedBeforePrepared = {
          receipt,
          sources: sourceBefore,
          child: childBefore,
          report: reportBefore,
          rootRuns: viewBefore.runs,
          cursor: (await owned.getMetadata()).lastChangeCursor,
        };
        // Release immediately after finite reads; R1 cannot complete while its own apply return is held.
        releaseAcceptedReturn.release();
        await until(async () => {
          for (const [executionId, actual] of actualModels) {
            if (!actual.root || !actual.finish || !actual.eof) continue;
            const execution = await owned.getExecution(executionId);
            if (execution?.runId !== targetRunId || execution.status !== 'succeeded') continue;
            const messages = actual.request.messages.filter((message) =>
              message.sourceIds?.includes(sourceId),
            );
            if (!messages.length) continue;
            assert(
              messages
                .flatMap((message) => message.sourceIds ?? [])
                .filter((value) => value === sourceId).length === 1 &&
                messages.some((message) => message.content.includes(fact)),
              'normal_completion_same_R1_actual_provider_processes_source_once_with_full_fact',
            );
            normalStages.sourceProcessed = {
              execution,
              cursor: (await owned.getMetadata()).lastChangeCursor,
            };
            return true;
          }
          return undefined;
        }, 'normal_completion_did_not_process_exact_accepted_source');
        const final = await until(async () => {
          const view = await owned.getView('root');
          return view.runs.length === 1 &&
            view.runs[0]?.id === targetRunId &&
            view.runs[0].status === 'completed' &&
            !view.runs[0].isActive
            ? view
            : undefined;
        }, 'normal_completion_original_R1_not_normally_completed_after_source');
        const resultAfter = (await owned.getExecution(carrierRef!.executionId!))!;
        assert(
          acceptedReturned &&
            normalStages.normalFinishAttempt &&
            isDeepStrictEqual(sourceRows(), sourceBefore) &&
            isDeepStrictEqual(
              (await owned.getCommand(reportBefore!.id))?.receipt,
              reportBefore!.receipt,
            ) &&
            resultAfter.resultRevision === childBefore.resultRevision &&
            isDeepStrictEqual(resultAfter.result, childBefore.result) &&
            resultAfter.resultAcceptance?.runId === targetRunId &&
            final.runs.length === 1,
          'normal_checkpoint_has_no_R2_retarget_reconsume_or_original_result_rewrite',
        );
        normalStages.final = { runs: final.runs, carrier: resultAfter };
      } else if (!stopBeforePrepared) {
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
      } else {
        await until(
          async () => (acceptedHeld && accepted ? true : undefined),
          'real_active_acceptance_before_checkpoint_return_not_reached',
        );
        const receipt = object(accepted!.result.command.receipt);
        const sourceId = String(receipt.sourceId);
        const targetRunId = String(receipt.runId);
        const sourceBefore = sourceRows();
        const childBefore = (await owned.getExecution(carrierRef!.executionId!))!;
        const originalReport = await owned.getCommand(accepted!.input.commandId);
        const rootBefore = await owned.getView('root');
        const preparedBefore = rootBefore.executions.filter(
          (execution) => execution.kind === 'model' && matchingPrepared(execution.input, sourceId),
        );
        assert(
          sourceBefore.length === 1 &&
            sourceBefore[0]!.id === sourceId &&
            targetRunId === candidateRunId &&
            sourceBefore[0]!.result_revision === childBefore.resultRevision &&
            sourceBefore[0]!.selection_id ===
              (await owned.getRun(targetRunId))?.contextSelectionId &&
            object(JSON.parse(sourceBefore[0]!.request_json)).targetRunId === targetRunId &&
            (await owned.getRun(targetRunId))?.isActive &&
            !acceptedReturned &&
            preparedBefore.length === 0,
          'exact_source_committed_to_original_active_A_before_any_model_prepared',
        );
        assert(
          rootBefore.executions
            .filter((execution) => execution.kind === 'model')
            .every((execution) =>
              options
                .requests()
                .slice(requestStart)
                .some((request) => request.requestId === execution.id),
            ),
          'all_existing_parent_model_executions_already_forwarded_no_pending_prepared_model',
        );
        assert(
          options
            .requests()
            .slice(requestStart)
            .every((request) => !matchingPrepared(request, sourceId)),
          'no_actual_provider_input_has_accepted_source_before_formal_stop',
        );
        const beforeRequests = options.requests().length;
        await client.startRun(
          'root',
          { expectedStoreId, commandId: 'stop-A', kind: 'run.start', content: '停止 A。' },
          { signal },
        );
        const stop = await until(async () => {
          const raw = await owned.getCommand('stop-A');
          const decisionId = object(raw?.receipt).decisionCommandId;
          if (typeof decisionId !== 'string') return undefined;
          const decision = await owned.getCommand(decisionId);
          return decision?.status === 'applied' ? decision : undefined;
        }, 'formal_human_stop_original_A_not_applied');
        assert(
          object(object(stop.request).proposal).purpose === 'stop' &&
            object(object(stop.request).proposal).targetRootWorkCommandId === 'A',
          'formal_stop_targets_exact_original_A_work',
        );
        assert(
          isDeepStrictEqual(sourceRows(), sourceBefore) &&
            isDeepStrictEqual(
              (await owned.getCommand(originalReport!.id))?.receipt,
              originalReport?.receipt,
            ),
          'stop_preserves_accepted_source_original_target_and_report_receipt',
        );
        releaseAcceptedReturn.release();
        await until(async () => {
          const view = await owned.getView('root');
          return acceptedReturned && view.runs.every((run) => !run.isActive) ? view : undefined;
        }, 'stopped_original_parent_did_not_settle_after_checkpoint_release');
        const final = await owned.getView('root');
        const resultAfter = (await owned.getExecution(carrierRef!.executionId!))!;
        assert(
          (await owned.getRun(targetRunId))?.status === 'cancelled' &&
            final.runs.length === 1 &&
            final.executions.every(
              (execution) =>
                execution.kind !== 'model' || !matchingPrepared(execution.input, sourceId),
            ) &&
            options
              .requests()
              .slice(requestStart)
              .every((request) => !matchingPrepared(request, sourceId)),
          'accepted_but_unprepared_stopped_source_never_moves_to_R2_or_model_provider',
        );
        assert(
          options.requests().length === beforeRequests &&
            !final.executions.some(
              (execution) =>
                execution.kind === 'tool' &&
                execution.definitionId !== 'task.spawn' &&
                execution.definitionId !== barrier.id,
            ),
          'formal_direct_stop_starts_no_provider_or_new_business_tool',
        );
        assert(
          isDeepStrictEqual(sourceRows(), sourceBefore) &&
            resultAfter.resultRevision === childBefore.resultRevision &&
            isDeepStrictEqual(resultAfter.result, childBefore.result) &&
            resultAfter.rootWorkCommandId === 'A' &&
            object((await owned.getCommand(originalReport!.id))?.receipt).runId === targetRunId,
          'accepted_unprepared_source_and_complete_original_child_result_remain_historical_without_reconsume',
        );
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
      assert(
        readFileSync(materialPath, 'utf8') === material && adapterStarts <= 40,
        'owned_material_unchanged_and_adapter_attempt_limit_kept',
      );
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
      releaseAcceptedReturn.release();
      terminalReached.release();
      terminalPublished.release();
      parentPlainResponseCommitted.release();
      if (normalCompletion) {
        try {
          writeFileSync(
            join(root, 'normal-completion-stages.json'),
            JSON.stringify(
              Object.entries(normalStages).map(([stage, value]) => ({
                stage,
                sha256: createHash('sha256')
                  .update(JSON.stringify(value) ?? 'null')
                  .digest('hex'),
              })),
              null,
              2,
            ),
          );
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
        }
      }
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
      coverage: [
        normalCompletion
          ? 'ordinary_completion_checkpoint_processes_exact_committed_unprepared_source_in_same_R1_before_normal_finish_no_R2'
          : stopBeforePrepared
            ? 'real_active_source_acceptance_committed_then_human_stop_before_checkpoint_return_and_model_prepared'
            : 'original_candidate_parent_active_before_real_report_publication_then_normal_completion_before_first_acceptance_transaction',
        'exact_original_child_result_revision_source_selection_target_and_actual_provider_evidence',
        'owned_allow_and_after_turn_fixture_not_default_policy',
        'no_same_activeOnly_precheck_race_or_default_beforeRunComplete_hook_complete_R04_qualification',
        'no_restart_UI_or_other_platform_qualification',
      ],
    });
  }
  return { cases };
}
