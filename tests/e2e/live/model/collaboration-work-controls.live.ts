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
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { agentContractSource } from '@kite-ai/agent/sources';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

const ids = [
  'I14-pause-continue-before-result',
  'I14-pause-result-before-continue',
  'I14-stop-continue-late-report',
  'R06-revoked-report-terminal-binding-release-idle',
] as const;
export type LiveWorkControlCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveWorkControlCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
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
        abort = () => reject(Error('live_work_controls_aborted'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  signal.throwIfAborted();
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
/** Private owned-read fixture; no default-policy or ordinary-window qualification. */
export async function runLiveWorkControls(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_work_controls_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-work-controls-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const material = `complete-owned-work-A-fact=${randomUUID()}\n`;
    const materialPath = join(workspace, 'A.txt');
    writeFileSync(materialPath, material, { mode: 0o600 });
    const readRelease = gate(),
      reportRelease = gate();
    const revokedProbe = id === 'R06-revoked-report-terminal-binding-release-idle';
    const stopped = id === 'I14-stop-continue-late-report' || revokedProbe;
    const beforeResult = id === 'I14-pause-continue-before-result';
    const checks: Result['checks'] = {};
    const stages: Record<string, unknown> = {};
    const bindings: { id: string; commandId: string; disposals: number }[] = [];
    let reportApplyAttempts = 0;
    let permissionChecks = 0;
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let store: Store | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let retained = false,
      reportHeld = false,
      readCount = 0,
      adapterStarts = 0;
    let child:
      | { sessionId: string; runId: string; executionId: string; returned: boolean }
      | undefined;
    const parentRequests: {
      requestId: string;
      runId: string | null;
      request: ModelRequest;
      finish: boolean;
      eof: boolean;
    }[] = [];
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
        await wait(new Promise<void>((done) => setTimeout(done, 20)), signal);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      function sql<T>(read: (db: Database) => T): T {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return read(db);
        } finally {
          db.close();
        }
      }
      const reportCommands = async (executionId: string) => {
        const rows = sql((db) =>
          db
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM command WHERE kind IN('job.report','job.report.qualification','job.report.continue') AND (json_extract(request_json,'$.executionId')=? OR json_extract(request_json,'$.carrierExecutionId')=?) ORDER BY seq",
            )
            .all(executionId, executionId),
        );
        return Promise.all(rows.map((row) => owned.getCommand(row.id)));
      };
      async function rootIdle(point: string) {
        return until(async () => {
          const view = await owned.getView('root');
          assert(view.runs.filter((run) => run.isActive).length <= 1, `${point}_one_active_max`);
          return view.runs.length && view.runs.every((run) => !run.isActive) ? view : undefined;
        }, point);
      }
      async function carrier() {
        branch(child, 'real_child_read_not_started');
        const rows = (await owned.listExecutions('root')).filter(
          (row) => row.childSessionId === child!.sessionId,
        );
        assert(rows.length === 1, 'exact_one_original_child_carrier');
        return rows[0]!;
      }
      async function control(commandId: string, purpose: 'pause' | 'continue' | 'stop') {
        await client!.startRun(
          'root',
          {
            expectedStoreId,
            commandId,
            kind: 'run.start',
            content: `${purpose === 'pause' ? '暂停' : purpose === 'stop' ? '停止' : '继续'}当前任务 A。${purpose === 'continue' ? '保留原有子任务，不创建新子任务，不延长原期限。已有结果只如实汇总，没有结果则确认等待并正常结束本轮。' : ''}`,
          },
          { signal },
        );
        const decision = await until(async () => {
          const command = await owned.getCommand(commandId);
          const decisionId = object(command?.receipt).decisionCommandId;
          if (typeof decisionId !== 'string') return undefined;
          const saved = await owned.getCommand(decisionId);
          return saved?.status === 'applied' ? saved : undefined;
        }, `formal_${purpose}_decision_not_applied`);
        const proposal = object(object(decision.request).proposal);
        assert(
          proposal.purpose === purpose && proposal.targetRootWorkCommandId === 'A',
          `formal_${purpose}_exact_original_A`,
        );
        const publicCommand = await owned.getCommand(commandId);
        const rawId = object(publicCommand?.receipt).humanInputCommandId;
        branch(typeof rawId === 'string', `formal_${purpose}_raw_identity_missing`);
        const raw = await owned.getCommand(rawId as string);
        assert(
          raw?.kind === 'human.input' &&
            raw.sessionId === 'root' &&
            raw.originStoreId === expectedStoreId &&
            object(raw.receipt).state === 'decided' &&
            object(raw.receipt).decisionCommandId === decision.id,
          `formal_${purpose}_accurate_saved_raw_decision_chain`,
        );
        stages[purpose] = {
          publicCommand,
          raw,
          decision,
          cursor: (await owned.getMetadata()).lastChangeCursor,
        };
        return decision;
      }
      const originalApply = owned.applyJobReport.bind(owned);
      owned.applyJobReport = async (input) => {
        reportApplyAttempts++;
        const command = await owned.getCommand(input.commandId);
        if (
          stopped &&
          command?.kind === 'job.report' &&
          command.sessionId === 'root' &&
          command.rootWorkCommandId === 'A' &&
          !reportHeld
        ) {
          reportHeld = true;
          stages.originalReportBeforeApply = {
            command,
            carrier: await carrier(),
            cursor: (await owned.getMetadata()).lastChangeCursor,
          };
          await wait(reportRelease.promise, signal);
        }
        const result = await originalApply(input);
        if (command?.rootWorkCommandId === 'A')
          stages[`applied_${command.id}`] = structuredClone(result);
        return result;
      };
      const reader: ToolDefinition = {
        id: 'live.work-controls-read',
        version: '1',
        model: { name: 'read_work_control_material' },
        description:
          'Read the exact complete owned A material once. Pending reads return naturally; do not retry or cancel.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          assert(context.sessionId !== 'root', 'parent_does_not_execute_owned_child_read');
          branch(
            context.sessionId !== 'root' && context.runId,
            'real_child_owned_read_not_reached',
          );
          assert(++readCount === 1, 'one_actual_material_read');
          const run = await owned.getRun(context.runId!);
          const execution = await owned.getExecution(context.executionId);
          assert(
            run?.rootWorkCommandId === 'A' &&
              run.isActive &&
              execution?.runId === run.id &&
              execution.authorization?.dispatched === true &&
              ['dispatching', 'running'].includes(execution.status),
            'exact_child_dispatched_actual_read_body',
          );
          const content = readFileSync(materialPath, 'utf8');
          assert(content === material, 'complete_actual_owned_material_read');
          child = {
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            returned: false,
          };
          stages.actualReadBeforeReturn = {
            run,
            execution,
            cursor: (await owned.getMetadata()).lastChangeCursor,
          };
          await wait(readRelease.promise, AbortSignal.any([signal, context.signal]));
          child.returned = true;
          return { outcome: 'succeeded', content };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          if (++adapterStarts > 40)
            throw new Boundary('branch_not_reached', 'hard_40_adapter_attempt_limit');
          const execution = await owned.getExecution(request.requestId);
          const view = await owned.getView('root');
          assert(
            view.runs.filter((run) => run.isActive).length <= 1,
            'all_actual_model_requests_one_active_parent_max',
          );
          const entry =
            execution?.sessionId === 'root'
              ? {
                  requestId: request.requestId,
                  runId: execution.runId,
                  request: structuredClone(request),
                  finish: false,
                  eof: false,
                }
              : undefined;
          if (entry) parentRequests.push(entry);
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([signal, context.signal]),
          })) {
            if (entry && event.type === 'finish') entry.finish = true;
            yield event;
          }
          if (entry) entry.eof = true;
        },
      };
      const permissions = {
        async authorize() {
          permissionChecks++;
          return {
            allowed: true as const,
            revision: 'owned-work-controls-only-not-default-policy',
          };
        },
      };
      const task = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description: 'Finite actual owned material reader.',
          },
        ],
      });
      const rootTools = [
        reader.id,
        ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      ];
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        permissions,
        afterTurn: permissions,
        extensions: [
          { id: 'live.work-controls', version: '1', apiMajor: 1, tools: [reader] },
          task,
        ],
        ...(revokedProbe
          ? {
              sources: {
                async capture() {
                  return [agentContractSource(workspace)];
                },
              },
            }
          : {}),
        resolveRunConfiguration: async ({ command }) => {
          const binding = revokedProbe
            ? { id: randomUUID(), commandId: command.id, disposals: 0 }
            : undefined;
          if (binding) bindings.push(binding);
          return {
            model,
            modelId: options.modelId,
            toolIds: rootTools,
            snapshot: { kind: 'owned-work-controls', version: 1 },
            permissions,
            afterTurn: permissions,
            ...(revokedProbe
              ? {
                  async dispose() {
                    binding!.disposals++;
                  },
                }
              : {}),
          };
        },
        resolveRecoveryRunConfiguration: async ({ run }) => {
          const manifest = object(run.configuration);
          return {
            model,
            modelId: options.modelId,
            permissions,
            afterTurn: permissions,
            toolIds: Array.isArray(manifest.tools)
              ? manifest.tools.map((tool) => String(object(tool).id))
              : [],
            snapshot: manifest.snapshot as RunConfiguration['snapshot'],
          };
        },
        childConfigurations: [
          {
            id: 'worker',
            version: '1',
            model,
            modelId: options.modelId,
            toolIds: [reader.id],
            snapshot: { kind: 'owned-work-controls-child', version: 1 },
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
        buildId: 'live-work-controls',
        subjectId: 'live-work-controls-owner',
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
        name: 'Owned work control material',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        title: 'Work control timing',
      });
      const assignment =
        'Use read_work_control_material exactly once with empty arguments. Report the complete actual returned material verbatim and finish. Never delegate, send messages, follow up, interrupt, retry, cancel or invent a fact.';
      await client.startRun(
        'root',
        {
          expectedStoreId,
          commandId: 'A',
          kind: 'run.start',
          content: `New task A. Call spawn_agent exactly once, arguments containing only prompt, with this assignment: ${JSON.stringify(assignment)}. Preserve the original child identity. Immediately after spawn returns, finish your ordinary response stating its result is pending. Do not wait, read, delegate again, send, follow up or interrupt. On later original results report the full actual fact and finish, without more tools. Human continue before any result means acknowledge waiting and finish the ordinary parent turn; preserve the same child and its original deadline.`,
        },
        { signal },
      );
      await until(async () => (child ? true : undefined), 'original_child_not_reading');
      const initialView = await rootIdle('original_A_parent_not_completed_before_control');
      const initial = initialView.runs.find((run) => run.rootWorkCommandId === 'A')!;
      branch(initial?.status === 'completed', 'initial_A_parent_did_not_complete_normally');
      const initialCarrier = structuredClone(await carrier());
      const initialChildRun = structuredClone(await owned.getRun(child!.runId));
      const startCommand = await owned.getCommand(`child-start-${initialCarrier.id}`);
      branch(
        initialChildRun?.isActive && initialChildRun.deadlineAt !== null && startCommand,
        'original_child_run_or_start_identity_missing',
      );
      assert(
        initialCarrier.resultRevision === '0' &&
          initialCarrier.result === null &&
          ['dispatching', 'running'].includes(initialCarrier.status) &&
          !child!.returned,
        'original_child_no_result_before_control',
      );
      stages.originalBaseline = { initial, initialCarrier, initialChildRun, startCommand };
      const originalBinding = revokedProbe
        ? bindings.find((binding) => binding.commandId === 'A')
        : undefined;
      if (revokedProbe) {
        branch(originalBinding, 'original_A_dynamic_binding_not_observed');
        assert(originalBinding!.disposals === 0, 'original_A_binding_retained_for_unsettled_child');
      }
      let historicalSuppressed: Awaited<ReturnType<Store['getCommand']>> | undefined;
      let suppressedCarrier: Awaited<ReturnType<typeof carrier>> | undefined;
      let continuationDecision: Awaited<ReturnType<typeof control>> | undefined;
      if (!stopped) {
        await control('pause-A', 'pause');
        await rootIdle('pause_processing_not_closed');
        const paused = await carrier();
        assert(
          !child!.returned &&
            paused.resultRevision === '0' &&
            paused.result === null &&
            paused.cancelRequestedAt === null &&
            (await owned.getRun(child!.runId))?.isActive,
          'pause_preserves_original_pending_child_without_result_or_cancel',
        );
        if (beforeResult) {
          continuationDecision = await control('continue-A', 'continue');
          await rootIdle('continue_before_result_parent_not_closed');
          const pending = await carrier();
          const qualifications = (await reportCommands(pending.id)).filter(
            (command) => command?.kind === 'job.report.qualification',
          );
          assert(
            qualifications.length === 1 &&
              pending.resultRevision === '0' &&
              pending.result === null &&
              !child!.returned &&
              (await owned.getRun(child!.runId))?.deadlineAt === initialChildRun!.deadlineAt,
            'future_qualification_before_real_result_without_child_rebuild_or_deadline_renewal',
          );
          stages.futureQualificationBeforeResult = qualifications;
        }
        readRelease.release();
        if (!beforeResult) {
          historicalSuppressed = await until(async () => {
            const saved = await carrier();
            const report = (await reportCommands(saved.id)).find(
              (command) =>
                command?.kind === 'job.report' &&
                command.status === 'rejected' &&
                object(command.receipt).reason === 'work_paused',
            );
            return saved.status === 'succeeded' &&
              saved.delivery === 'suppressed' &&
              saved.resultAcceptance === null &&
              report
              ? structuredClone(report)
              : undefined;
          }, 'real_original_result_not_suppressed_while_paused');
          suppressedCarrier = structuredClone(await carrier());
          stages.historicalSuppressed = {
            command: historicalSuppressed,
            carrier: suppressedCarrier,
          };
          continuationDecision = await control('continue-A', 'continue');
        }
        const accepted = await until(async () => {
          const saved = await carrier();
          return saved.status === 'succeeded' && saved.resultAcceptance?.runId ? saved : undefined;
        }, 'original_result_not_legitimately_accepted_after_continue');
        const acceptance = accepted.resultAcceptance!;
        const acceptingRun = await owned.getRun(acceptance.runId!);
        const reports = (await reportCommands(accepted.id)).filter((command) => command !== null);
        const qualifications = reports.filter(
          (command) => command.kind === 'job.report.qualification',
        );
        const continued = reports.filter(
          (command) => command.kind === 'job.report.continue' && command.status === 'applied',
        );
        assert(
          qualifications.length === 1 && continued.length === 1,
          'exact_one_new_qualification_and_applied_report_admission',
        );
        const continuedRequest = object(continued[0]!.request);
        assert(
          continuedRequest.continuationCommandId === qualifications[0]!.id &&
            continuedRequest.executionId === accepted.id &&
            object(continued[0]!.receipt).sourceId === acceptance.sourceId &&
            object(continued[0]!.receipt).runId === acceptance.runId &&
            object(continued[0]!.receipt).resultRevision === accepted.resultRevision,
          'new_admission_exact_original_result_revision_and_source',
        );
        const qualificationRequest = object(qualifications[0]!.request);
        assert(
          qualificationRequest.continueDecisionCommandId === continuationDecision!.id &&
            qualificationRequest.carrierExecutionId === accepted.id &&
            qualificationRequest.startCommandId === startCommand!.id &&
            qualificationRequest.startRequestDigest === startCommand!.requestDigest,
          'qualification_bound_to_actual_human_continue_decision',
        );
        assert(
          accepted.delivery === 'consumed' &&
            acceptance.resultRevision === accepted.resultRevision &&
            acceptingRun?.rootWorkCommandId === 'A' &&
            acceptingRun.rootWorkSeq === initial.rootWorkSeq &&
            acceptingRun.contextSelectionId === acceptance.selectionId &&
            isDeepStrictEqual(acceptingRun.configuration, initial.configuration),
          'exact_original_A_configuration_selection_result_acceptance',
        );
        assert(
          String(object(accepted.result).content ?? '').includes(material.trim()),
          'actual_child_report_contains_complete_read_fact',
        );
        await until(async () => {
          for (const entry of parentRequests) {
            if (entry.runId !== acceptance.runId || !entry.finish || !entry.eof) continue;
            const execution = await owned.getExecution(entry.requestId);
            if (execution?.status !== 'succeeded') continue;
            const messages = entry.request.messages.filter((message) =>
              message.sourceIds?.includes(acceptance.sourceId),
            );
            if (!messages.length) continue;
            assert(
              messages
                .flatMap((message) => message.sourceIds ?? [])
                .filter((source) => source === acceptance.sourceId).length === 1 &&
                messages.some((message) => message.content.includes(material.trim())),
              'complete_exact_source_once_in_actual_successful_parent_provider_input',
            );
            return true;
          }
          return undefined;
        }, 'accepted_source_not_processed_by_actual_parent_provider');
        await rootIdle('accepted_original_result_parent_not_normally_closed');
        const finalParentView = await owned.getView('root');
        const continueBusinessId = object(continuationDecision!.receipt).businessCommandId;
        assert(
          finalParentView.runs
            .filter((run) => run.rootWorkCommandId === 'A')
            .every(
              (run) =>
                run.id === initial.id ||
                run.id === acceptance.runId ||
                run.originCommandId === continueBusinessId,
            ),
          'no_extra_original_A_business_or_automatic_parent_run',
        );
        assert(
          (await owned.getRun(acceptance.runId!))?.status === 'completed',
          'actual_source_parent_completed_causal_checkpoint',
        );
        const originalReport = reports.find((command) => command.kind === 'job.report');
        assert(
          originalReport !== undefined &&
            originalReport.id === continuedRequest.originalReportCommandId &&
            originalReport.status === 'rejected' &&
            object(originalReport.request).executionId === accepted.id &&
            object(originalReport.request).resultRevision === accepted.resultRevision,
          'new_admission_references_accurate_original_historical_report',
        );
        if (historicalSuppressed)
          assert(
            isDeepStrictEqual(
              await owned.getCommand(historicalSuppressed.id),
              historicalSuppressed,
            ) &&
              isDeepStrictEqual(accepted.result, suppressedCarrier!.result) &&
              accepted.resultRevision === suppressedCarrier!.resultRevision,
            'historical_suppressed_receipt_status_result_revision_unchanged',
          );
        const sourceRows = sql((db) =>
          db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM context_snapshot WHERE kind='result_ref' AND execution_id=?",
            )
            .get(accepted.id),
        );
        assert(Number(sourceRows?.n) === 1, 'one_durable_exact_result_source');
        stages.finalAcceptance = { carrier: accepted, acceptingRun, reports };
      } else {
        readRelease.release();
        await until(
          async () => (reportHeld ? true : undefined),
          'real_original_report_not_held_before_apply',
        );
        const terminal = structuredClone(await carrier());
        assert(
          terminal.status === 'succeeded' &&
            terminal.resultAcceptance === null &&
            BigInt(terminal.resultRevision) > 0n &&
            terminal.result !== null &&
            String(object(terminal.result).content ?? '').includes(material.trim()),
          'real_child_complete_result_durable_before_late_report_control',
        );
        await control('stop-A', 'stop');
        const runsAfterStop = (await owned.getView('root')).runs;
        const parentRequestsAfterStop = parentRequests.length;
        const rejected = await client.startRun(
          'root',
          {
            expectedStoreId,
            commandId: 'continue-stopped-A',
            kind: 'run.start',
            content: '继续当前任务 A。',
          },
          { signal },
        );
        const savedRejected = await owned.getCommand('continue-stopped-A');
        const rejection = object(savedRejected?.receipt);
        const rejectedRaw =
          typeof rejection.humanInputCommandId === 'string'
            ? await owned.getCommand(rejection.humanInputCommandId)
            : null;
        const rejectedDecision =
          typeof rejection.decisionCommandId === 'string'
            ? await owned.getCommand(rejection.decisionCommandId)
            : null;
        // Rejection is a durable public outcome, with no orphan pending raw or
        // redundant interpretation Model. It grants no continuation qualification.
        assert(
          rejected.status === 'rejected' &&
            savedRejected?.status === 'rejected' &&
            rejection.outcome === 'human_input_rejected' &&
            rejection.reason === 'work_resume_unavailable' &&
            rejection.revocationReason === 'work_stopped' &&
            rejection.runId === null &&
            rejection.businessCommandId === null &&
            rejectedRaw?.kind === 'human.input' &&
            object(rejectedRaw.request).content === '继续当前任务 A。' &&
            object(rejectedRaw.receipt).state === 'decided' &&
            object(rejectedRaw.receipt).applicationState === 'rejected' &&
            object(rejectedRaw.receipt).decisionCommandId === rejectedDecision?.id &&
            rejectedDecision?.kind === 'human.input.decision' &&
            rejectedDecision.status === 'rejected' &&
            object(object(rejectedDecision.request).proposal).purpose === 'continue' &&
            object(object(rejectedDecision.request).proposal).targetRootWorkCommandId === 'A' &&
            object(rejectedDecision.receipt).selectionEffect === 'keep' &&
            object(rejectedDecision.receipt).businessCommandId === null &&
            !(
              await owned.readHumanWorkState({
                expectedStoreId,
                sessionId: 'root',
                subjectId: 'live-work-controls-owner',
              })
            ).pendingInputIds.includes(rejectedRaw.id),
          'ordinary_stopped_continue_has_exact_sealed_rejection_without_pending_or_business',
        );
        stages.stoppedContinue = {
          publicCommand: savedRejected,
          raw: rejectedRaw,
          decision: rejectedDecision,
          cursor: (await owned.getMetadata()).lastChangeCursor,
        };
        reportRelease.release();
        const suppressed = await until(async () => {
          const rows = await reportCommands(terminal.id);
          const original = rows.find((command) => command?.kind === 'job.report');
          return original?.status === 'rejected' ? original : undefined;
        }, 'late_original_report_not_durably_rejected_after_stop');
        await rootIdle('late_report_did_not_return_to_safe_idle');
        const final = await carrier();
        const finalReports = (await reportCommands(final.id)).filter((command) => command !== null);
        assert(
          final.resultAcceptance === null &&
            final.delivery === 'suppressed' &&
            isDeepStrictEqual(final.result, terminal.result) &&
            final.resultRevision === terminal.resultRevision &&
            typeof object(suppressed.receipt).reason === 'string' &&
            ['work_stopped', 'parent_stopped', 'cancelled'].includes(
              String(object(suppressed.receipt).reason),
            ),
          'late_report_preserves_original_result_and_stop_suppression_reason',
        );
        assert(
          finalReports.every((command) => command.kind === 'job.report') &&
            (await owned.getView('root')).runs.length === runsAfterStop.length,
          'ordinary_continue_and_late_report_create_no_qualification_or_parent_revival',
        );
        assert(
          parentRequests.length === parentRequestsAfterStop,
          'ordinary_rejected_continue_and_late_report_zero_new_parent_provider',
        );
        const n = sql((db) =>
          db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM context_snapshot WHERE kind='result_ref' AND execution_id=?",
            )
            .get(final.id),
        );
        assert(Number(n?.n) === 0, 'stopped_original_result_zero_durable_source');
        stages.lateReportAfterStop = { final, suppressed, finalReports };
        if (revokedProbe) {
          const childModels = (await owned.listExecutions(child!.sessionId)).filter(
            (execution) => execution.kind === 'model' && execution.status === 'succeeded',
          );
          const childOutputs = await Promise.all(
            childModels.map((execution) =>
              runtime!.readModelOutput({
                expectedStoreId,
                sessionId: child!.sessionId,
                subjectId: 'live-work-controls-owner',
                executionId: execution.id,
              }),
            ),
          );
          assert(
            childOutputs.some(
              (output) =>
                output.output.complete &&
                output.output.toolCalls.length === 0 &&
                output.output.content === String(object(final.result).content ?? ''),
            ),
            'full_original_actual_child_Model_EOF_equals_preserved_carrier_body',
          );
          stages.actualChildOutputs = childOutputs;
          const held = object(stages.originalReportBeforeApply);
          const heldCommand = object(held.command);
          assert(
            heldCommand.id === suppressed.id &&
              heldCommand.status === 'accepted' &&
              object(suppressed.receipt).reason === 'work_stopped' &&
              final.deliveryReason === 'work_stopped',
            'exact_accepted_original_report_revoked_to_durable_work_stopped',
          );
          await until(async () => {
            const session = await owned.getSession('root');
            return originalBinding!.disposals === 1 &&
              !runtime!.getLifecycleState().busy &&
              session?.ownerInstanceId === null
              ? true
              : undefined;
          }, 'revoked_report_binding_or_owner_not_released_before_close');
          const pending = await owned.listPendingJobReports({
            expectedStoreId,
            sessionId: 'root',
            limit: 100,
          });
          assert(
            pending.nextAfterSeq === null && pending.commands.length === 0,
            'revoked_report_exits_formal_runnable_queue',
          );
          const stable = {
            cursor: (await owned.getMetadata()).lastChangeCursor,
            attempts: reportApplyAttempts,
            permissionChecks,
            adapterStarts,
            requests: options.requests().length,
            view: await owned.getView('root'),
            child: await owned.getView(child!.sessionId),
            report: await owned.getCommand(suppressed.id),
            carrier: await carrier(),
            bindings: structuredClone(bindings),
          };
          await wait(new Promise<void>((done) => setTimeout(done, 3000)), signal);
          const quiet = {
            cursor: (await owned.getMetadata()).lastChangeCursor,
            attempts: reportApplyAttempts,
            permissionChecks,
            adapterStarts,
            requests: options.requests().length,
            view: await owned.getView('root'),
            child: await owned.getView(child!.sessionId),
            report: await owned.getCommand(suppressed.id),
            carrier: await carrier(),
            bindings: structuredClone(bindings),
          };
          assert(
            isDeepStrictEqual(stable, quiet) &&
              originalBinding!.disposals === 1 &&
              !runtime!.getLifecycleState().busy,
            'finite_3s_revoked_report_zero_self_reapply_policy_Model_Run_effect_or_owner_leak',
          );
          stages.revokedBindingAndIdle = { originalBinding, pending, stable, quiet };
          writeFileSync(
            join(root, 'revoked-report-binding-idle-evidence.json'),
            `${JSON.stringify(stages, null, 2)}\n`,
            { mode: 0o600 },
          );
        }
      }
      const finalCarrier = await carrier();
      const finalChild = await owned.getRun(child!.runId);
      const finalStart = await owned.getCommand(startCommand!.id);
      assert(
        readCount === 1 &&
          (await owned.getView(child!.sessionId)).runs.length === 1 &&
          (await owned.listExecutions('root')).filter((execution) => execution.childSessionId)
            .length === 1,
        'zero_replacement_child_or_new_child_round',
      );
      assert(
        finalChild?.id === initialChildRun!.id &&
          finalChild.deadlineAt === initialChildRun!.deadlineAt &&
          finalChild.createdAt === initialChildRun!.createdAt &&
          isDeepStrictEqual(finalChild.configuration, initialChildRun!.configuration) &&
          isDeepStrictEqual(finalCarrier.childConfiguration, initialCarrier.childConfiguration) &&
          isDeepStrictEqual(finalCarrier.reference, initialCarrier.reference) &&
          isDeepStrictEqual(finalCarrier.afterTurn, initialCarrier.afterTurn) &&
          finalCarrier.rootWorkCommandId === 'A' &&
          finalCarrier.rootWorkSeq === initialCarrier.rootWorkSeq &&
          isDeepStrictEqual(finalStart?.request, startCommand!.request) &&
          finalStart?.requestDigest === startCommand!.requestDigest,
        'original_child_identity_configuration_start_subscription_and_deadline_not_rewritten',
      );
      assert(adapterStarts <= 40, 'adapter_attempts_within_original_40_limit');
      status = 'passed';
    } catch (error) {
      if (revokedProbe)
        writeFileSync(
          join(root, 'execution-error.json'),
          `${JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null })}\n`,
          { mode: 0o600 },
        );
      if (error instanceof Boundary) {
        reason = error.reason;
        failurePoint = error.point;
        status = reason === 'oracle_violation' ? 'failed' : 'inconclusive';
      } else {
        reason = 'execution_unavailable';
        failurePoint = signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
      }
      const failed = Object.entries(checks).find(([, value]) => value === false);
      if (failed) {
        status = 'failed';
        reason = 'oracle_violation';
        failurePoint = failed[0];
      }
    } finally {
      readRelease.release();
      reportRelease.release();
      if (revokedProbe && runtime && store) {
        try {
          writeFileSync(
            join(root, 'actual-model-requests.json'),
            `${JSON.stringify(options.requests().slice(firstRequest), null, 2)}\n`,
            { mode: 0o600 },
          );
          writeFileSync(
            join(root, 'revoked-report-stages.json'),
            `${JSON.stringify(stages, null, 2)}\n`,
            { mode: 0o600 },
          );
          const canonical = await saveLiveCanonicalModelEvidence({
            runtime,
            store,
            requests: options.requests().slice(firstRequest),
            root,
            subjectId: 'live-work-controls-owner',
          });
          checks.canonicalActualInputsComplete = canonical.complete;
          stages.canonical = canonical;
          if (!canonical.complete) {
            status = 'failed';
            reason = 'oracle_violation';
            failurePoint = 'actual_Model_input_or_successful_output_evidence_unavailable';
          }
        } catch (error) {
          writeFileSync(
            join(root, 'canonical-evidence-capture-error.json'),
            `${JSON.stringify({ error: String(error) })}\n`,
            { mode: 0o600 },
          );
          status = 'failed';
          reason = 'oracle_violation';
          failurePoint = 'canonical_capture_error_original_Store_retained';
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
      try {
        writeFileSync(
          join(root, 'work-control-stages.json'),
          JSON.stringify(
            {
              id,
              checks,
              stageProofs: Object.entries(stages).map(([stage, value], index) => ({
                stage: stage.startsWith('applied_') ? `applied_report_${index}` : stage,
                sha256: createHash('sha256')
                  .update(JSON.stringify(value) ?? 'null')
                  .digest('hex'),
              })),
              status,
              reason,
              failurePoint,
              adapterStarts,
            },
            null,
            2,
          ),
        );
      } catch {
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
        beforeResult
          ? 'exact_pause_then_continue_before_original_result_revision_exists'
          : stopped
            ? 'real_result_durable_original_report_apply_after_exact_stop_and_rejected_ordinary_continue'
            : 'exact_pause_original_suppressed_result_then_unique_new_continue_admission_historical_receipt_unchanged',
        ...(revokedProbe
          ? [
              'exact_revoked_accepted_report_terminal_disposal_before_Runtime_close',
              'finite_3s_idle_zero_self_reapply_policy_or_Provider',
            ]
          : []),
        'formal_SDK_human_input_actual_Store_decisions',
        'same_counted_adapter_root_child_recovery_no_review_path',
        'owned_allow_not_default_policy',
        'not_full_I14_no_replace_root_stop_Rewind_delete_unknown_or_post_stop_provider_success',
      ],
    });
  }
  return { cases };
}
