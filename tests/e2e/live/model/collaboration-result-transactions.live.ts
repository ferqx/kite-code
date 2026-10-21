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
  'R05-child-terminal-report-registration-rollback',
  'R05-idle-report-committed-response-loss',
] as const;
export type LiveResultTransactionCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveResultTransactionCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  coverage: string[];
  operationSequence: string[];
  injectionPoint: string;
  injectionDefinitionSha256: string;
  proofHashes: Record<string, string>;
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
/** Owned allow/after-turn scheduling fixture, not default policy qualification.
 * Models use only the caller's counted real adapter and shared signal. The caller
 * supplies the common physical <=40 HTTP / 600s budget. Only private SQLite DDL
 * injects a transaction failure; no result, response, status or decision is forged.
 * Terminal rollback has no automatic safe retry and remains inconclusive.
 */
export async function runLiveResultTransactions(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_result_transactions_evidence_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const rollbackCase = id === 'R05-child-terminal-report-registration-rollback';
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
      releaseTerminal = gate(),
      transactionFailed = gate();
    let carrierRef: Awaited<ReturnType<Store['ensureOperation']>> | undefined;
    let spawnCount = 0,
      barrierCount = 0,
      readCount = 0,
      adapterStarts = 0;
    let candidateRunId: string | undefined;
    let candidateActiveAtPrepublication = false;
    let carrierFinishHeld = false;
    let saved: { input: ApplyInput; result: ApplyResult } | undefined;
    let lost = false,
      replayCount = 0,
      faultThrown = false;
    let rollbackBefore: unknown, rollbackAfter: unknown;
    let requestsAtRollback: number | undefined;
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
    let faultWriter: Database | undefined;
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
      function terminalSnapshot() {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return {
            execution: db.query('SELECT * FROM execution WHERE id=?').get(carrierRef!.executionId),
            reports: db
              .query(
                "SELECT * FROM command WHERE kind='job.report' AND json_extract(request_json,'$.executionId')=? ORDER BY seq",
              )
              .all(carrierRef!.executionId),
            sources: sourceRows(),
            sessionSequence: db
              .query("SELECT CAST(next_seq AS TEXT) AS next_seq FROM session WHERE id='root'")
              .get(),
            events: db
              .query(
                "SELECT cursor,type,object_id FROM change_event WHERE object_id=? OR (type='job.report_registered' AND object_id IN (SELECT id FROM command WHERE kind='job.report' AND json_extract(request_json,'$.executionId')=?)) ORDER BY cursor",
              )
              .all(carrierRef!.executionId, carrierRef!.executionId),
          };
        } finally {
          db.close();
        }
      }
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
        if (!rollbackCase) return finish(input);
        operationSequence.push(
          'real_successful_child_finishExecution_input_held_before_original_transaction',
        );
        const actualChild = await owned.getView(carrierRef!.childSessionId!);
        assert(
          readCount === 1 &&
            String(object(input.result).content ?? '').includes(fact) &&
            actualChild.runs.length === 1 &&
            actualChild.runs[0]?.status === 'completed' &&
            actualChild.executions.some(
              (execution) =>
                execution.kind === 'model' &&
                execution.status === 'succeeded' &&
                String(object(execution.result).content ?? '').includes(fact),
            ),
          'transaction_fault_follows_complete_real_child_read_and_successful_model_terminal',
        );
        rollbackBefore = terminalSnapshot();
        proofHashes.originalRealTerminalInput = hashProof(input);
        proofHashes.rollbackBefore = hashProof(rollbackBefore);
        faultWriter = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
        // The original finishExecution transaction already writes the real terminal
        // result/revision and report command before this final registration event.
        faultWriter.run(
          "CREATE TRIGGER live_result_terminal_fault BEFORE INSERT ON change_event WHEN NEW.type='job.report_registered' BEGIN SELECT RAISE(ABORT,'live_owned_report_registration_fault'); END",
        );
        operationSequence.push('private_trigger_installed_at_job_report_registered');
        try {
          return await finish(input);
        } catch (error) {
          faultThrown =
            error instanceof Error &&
            error.message.includes('live_owned_report_registration_fault');
          rollbackAfter = terminalSnapshot();
          proofHashes.rollbackAfter = hashProof(rollbackAfter);
          requestsAtRollback = options.requests().length;
          operationSequence.push('original_finishExecution_threw_after_real_sql_abort');
          transactionFailed.release();
          throw error; // Core sees the real failure. Never replay a terminal write here.
        } finally {
          faultWriter.run('DROP TRIGGER IF EXISTS live_result_terminal_fault');
          operationSequence.push('private_trigger_removed_before_runtime_cleanup');
          faultWriter.close();
          faultWriter = undefined;
        }
      };
      const apply = owned.applyJobReport.bind(owned);
      owned.applyJobReport = async (input) => {
        const original = await owned.getCommand(input.commandId);
        const matches = object(original?.request).executionId === carrierRef?.executionId;
        if (saved && input.commandId === saved.input.commandId) {
          replayCount++;
          assert(
            isDeepStrictEqual(input, saved.input),
            'formal_runtime_readback_reuses_exact_original_input_owner_and_report_key',
          );
          operationSequence.push('formal_runtime_original_key_readback');
          proofHashes.formalReadbackInput = hashProof(input);
        }
        const result = await apply(input);
        if (saved && input.commandId === saved.input.commandId) {
          assert(
            result.started === false &&
              result.run?.id === saved.result.run?.id &&
              isDeepStrictEqual(result.command.receipt, saved.result.command.receipt) &&
              sourceRows().length === 1,
            'formal_store_readback_started_false_preserves_committed_run_source_and_receipt',
          );
          proofHashes.formalReadbackResult = hashProof(result);
        }
        if (!rollbackCase && !lost && matches && result.command.status === 'applied') {
          branch(
            object(result.command.receipt).mode === 'idle_new_turn',
            'report_was_not_first_accepted_from_idle',
          );
          saved = { input: structuredClone(input), result: structuredClone(result) };
          lost = true;
          proofHashes.originalCommittedInput = hashProof(input);
          proofHashes.originalCommittedResult = hashProof(result);
          operationSequence.push('original_applyJobReport_idle_transaction_committed');
          throw Error('live_owned_apply_report_response_lost_after_commit');
        }
        return result;
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
            revision: 'owned-result-transaction-fixture-not-default-policy',
          }),
        },
        afterTurn: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-result-transaction-after-turn-not-default-policy',
          }),
        },
        extensions: [
          {
            id: 'live.result-transaction-fixture',
            version: '1',
            apiMajor: 1,
            tools: [read, barrier],
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
        buildId: 'live-result-transactions-orders',
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
        name: 'Owned result transactions',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Owned result transactions',
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
        releaseTerminal.release();
        if (rollbackCase) {
          await wait(transactionFailed.promise, signal);
          assert(faultThrown, 'real_original_terminal_transaction_hit_exact_private_sql_abort');
          assert(
            isDeepStrictEqual(rollbackBefore, rollbackAfter),
            'terminal_result_revision_report_source_sequence_and_events_fully_rolled_back',
          );
          assert(
            object(rollbackAfter).execution !== null && sourceRows().length === 0,
            'original_carrier_history_retained_without_source_or_false_report',
          );
          const original = await owned.getExecution(carrierRef!.executionId!);
          assert(
            original?.status !== 'succeeded' && original?.resultAcceptance === null,
            'failed_terminal_commit_never_claims_success_or_consumption',
          );
          checks.child_terminal_rollback_proven = true;
          checks.formal_original_carrier_recovery_completed = 0;
          // The formal job supervisor has no original-terminal retry. Propagating
          // its actual storage error is essential; no wrapper retry/reconcile is invented.
          throw new Boundary(
            'branch_not_reached',
            'terminal_rollback_proven_but_formal_safe_recovery_not_available',
          );
        }
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
        lost && saved && replayCount === 1,
        'formal_runtime_recovers_exact_committed_report_once_after_lost_response',
      );
      assert(
        isDeepStrictEqual(
          (await owned.getCommand(saved!.input.commandId))?.receipt,
          saved!.result.command.receipt,
        ) &&
          (await owned.getRun(saved!.result.run!.id))?.id === saved!.result.run!.id &&
          object(saved!.result.command.receipt).mode === 'idle_new_turn',
        'saved_committed_receipt_run_source_and_first_target_remain_exact',
      );
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

      terminalReached.release();
      try {
        faultWriter?.run('DROP TRIGGER IF EXISTS live_result_terminal_fault');
        faultWriter?.close();
      } catch {
        checks.trigger_cleanup_failed = true;
      }
      let closed = checks.trigger_cleanup_failed !== true,
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
      if (rollbackCase && requestsAtRollback !== undefined) {
        checks.no_provider_retry_after_terminal_storage_failure =
          options.requests().length === requestsAtRollback;
        if (!checks.no_provider_retry_after_terminal_storage_failure) {
          closed = false;
          failurePoint = 'provider_started_after_terminal_storage_failure';
        }
      }
      if (rollbackCase && faultThrown && closed) {
        try {
          const db = new Database(join(root, 'data', 'live', 'core.db'), { readonly: true });
          try {
            const row = object(
              db.query('SELECT state FROM execution WHERE id=?').get(carrierRef!.executionId),
            );
            checks.closedOriginalCarrierUnknown = row.state === 'outcome_unknown' ? 1 : 0;
            checks.closedOriginalCarrierUnsettled = ['planned', 'dispatching', 'running'].includes(
              String(row.state),
            )
              ? 1
              : 0;
            operationSequence.push(
              'closed_canonical_actual_carrier_state_retained_without_fixture_terminal_rewrite',
            );
          } finally {
            db.close();
          }
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
      operationSequence,
      proofHashes,
      injectionDefinitionSha256: createHash('sha256')
        .update(
          rollbackCase
            ? "CREATE TRIGGER live_result_terminal_fault BEFORE INSERT ON change_event WHEN NEW.type='job.report_registered' BEGIN SELECT RAISE(ABORT,'live_owned_report_registration_fault'); END"
            : 'original applyJobReport awaited; saved original input/result; throw after idle_new_turn commit; Runtime exact original-key readback',
        )
        .digest('hex'),
      injectionPoint: rollbackCase
        ? 'finishExecution.tx/registerJobReport/job.report_registered:before_insert_change_event'
        : 'applyJobReport:after_idle_commit_before_original_response',
      coverage: [
        rollbackCase
          ? 'actual_child_terminal_and_report_registration_atomic_rollback_no_formal_recovery_qualification'
          : 'real_idle_report_postcommit_response_loss_formal_exact_key_readback_unique_run_source_actual_provider',
        'owned_allow_and_after_turn_fixture_not_default_policy',
        'no_all_terminal_writes_active_admission_crash_or_other_R05_writepoint_qualification',
      ],
    });
  }
  return { cases };
}
