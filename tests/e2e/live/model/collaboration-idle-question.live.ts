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
import type { Json, ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const id = 'R08-idle-parent-one-real-30000ms-question-observation-pending' as const;
export type LiveIdleQuestionCaseId = typeof id;
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveIdleQuestionCaseId;
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
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
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
        abort = () => reject(Error('live_idle_question_aborted'));
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
/** Idle parent question via original Task parent target and genuine finite observation timer. */
export async function runLiveIdleQuestion(options: Options): Promise<{ cases: Result[] }> {
  if (options.caseIds && !options.caseIds.includes(id)) return { cases: [] };
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('live_idle_question_evidence_root_invalid');
  options.signal.throwIfAborted();
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-idle-question-')),
    ),
    workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const nonce = `requirement-${randomUUID()}`,
    requirements = `Source nonce=${nonce}\r\nThe required theme_color is MISSING. The human must choose Blue or Green. No existing record grants either color. Do not guess a color or change settings.ini before a genuine human answer.\r\n`,
    initial = `theme_color=unset\r\nkeep=${randomUUID()}-🪁\r\n`;
  writeFileSync(join(workspace, 'requirements.txt'), requirements, { mode: 0o600 });
  writeFileSync(join(workspace, 'settings.ini'), initial, { mode: 0o600 });
  const materialGate = gate(),
    checks: Result['checks'] = {},
    stages: Record<string, unknown> = {};
  const firstRequest = options.requests().length;
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined,
    service: Awaited<ReturnType<typeof startService>> | undefined,
    client: ReturnType<typeof createClient> | undefined,
    files: ReturnType<typeof createWorkspaceFiles> | undefined;
  let parentRunId: string | undefined,
    storeClosed = false,
    filesClosed = false,
    heldRead: { sessionId: string; runId: string; executionId: string } | undefined,
    parentInitialModelCount = 0,
    openFiniteWaits = 0;
  const reads: {
    sessionId: string;
    runId: string;
    executionId: string;
    input: Json;
    result: Json;
    completedAfterParentIdle: boolean;
  }[] = [];
  const messages: {
    sessionId: string;
    runId: string | null;
    executionId: string;
    input: Json;
    result: Json;
  }[] = [];
  const observations: {
    sessionId: string;
    runId: string | null;
    executionId: string;
    input: Json;
    result?: Json;
    startedEpochMs: number;
    elapsedMs?: number;
    completed: boolean;
    failure?: 'original_Task_observation_failed' | 'observation_aborted';
    rootIdleBefore: boolean;
    rootIdleAfter?: boolean;
    questionSavedBeforeWait: boolean;
    rootModelsBefore: number;
    rootModelsAfter?: number;
  }[] = [];
  const streams = new Map<string, { finish: boolean; eof: boolean }>();
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function until<T>(read: () => Promise<T | undefined>, point: string) {
    const end = Date.now() + 100_000;
    for (;;) {
      options.signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
      await Bun.sleep(20);
    }
  }
  const closeFiles = async () => {
    if (filesClosed) return;
    await files?.close();
    filesClosed = true;
  };
  try {
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    store = await openSqliteStore(profile);
    const owned = store;
    const expectedStoreId = (await owned.getMetadata()).storeId;
    files = createWorkspaceFiles({ root: workspace });
    const originalFiles = createFileTools(files).filter((tool) =>
      ['files.read', 'files.edit'].includes(tool.id),
    );
    const fileTools: ToolDefinition[] = originalFiles.map((tool) => ({
      ...tool,
      async execute(input, context) {
        assert(context.sessionId !== 'root', 'parent_never_performs_File_work');
        const path = files!.relativePath(String(object(input).path));
        if (tool.id === 'files.read' && path === 'requirements.txt') {
          branch(context.runId, 'actual_child_read_has_no_Run');
          heldRead = {
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
          };
          await wait(materialGate.promise, AbortSignal.any([options.signal, context.signal]));
          assert(
            parentRunId &&
              (await owned.getRun(parentRunId))?.status === 'completed' &&
              !(await owned.getRun(parentRunId))?.isActive,
            'original_parent_completed_before_actual_requirements_IO',
          );
        }
        const result = await tool.execute(input, context);
        if (tool.id === 'files.read' && path === 'requirements.txt')
          reads.push({
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            input: structuredClone(input),
            result: structuredClone(result) as unknown as Json,
            completedAfterParentIdle: true,
          });
        return result;
      },
    }));
    const originalTask = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description:
            'Inspect missing human choice, one bounded parent observation, then truthful business-pending result.',
        },
      ],
    });
    const visible = originalTask.tools!.filter((tool) => !tool.model?.hidden);
    assert(
      visible.some(
        (tool) => tool.id === 'task.message' && JSON.stringify(tool.inputSchema).includes('parent'),
      ) && visible.some((tool) => tool.id === 'task.events'),
      'actual_current_Task_parent_target_and_events_API_present',
    );
    const task = {
      ...originalTask,
      tools: originalTask.tools!.map(
        (tool): ToolDefinition => ({
          ...tool,
          async execute(input, context) {
            if (tool.id === 'task.events' && context.sessionId !== 'root') {
              const priorMessage = messages.find(
                (message) => message.sessionId === context.sessionId,
              );
              const savedQuestion = priorMessage
                ? await owned.getExecution(priorMessage.executionId)
                : null;
              const before = await owned.getView('root'),
                start = performance.now();
              const observation = {
                sessionId: context.sessionId,
                runId: context.runId,
                executionId: context.executionId,
                input: structuredClone(input),
                startedEpochMs: Date.now(),
                completed: false,
                rootIdleBefore: before.runs.every((run) => !run.isActive),
                questionSavedBeforeWait: savedQuestion?.status === 'succeeded',
                rootModelsBefore: before.executions.filter((row) => row.kind === 'model').length,
              } as (typeof observations)[number];
              observations.push(observation);
              openFiniteWaits++;
              try {
                const result = await tool.execute(input, context);
                observation.elapsedMs = performance.now() - start;
                observation.result = structuredClone(result) as unknown as Json;
                const after = await owned.getView('root');
                observation.rootIdleAfter = after.runs.every((run) => !run.isActive);
                observation.rootModelsAfter = after.executions.filter(
                  (row) => row.kind === 'model',
                ).length;
                // Publish completion only after both original observation and
                // post-observation facts are ready. No await follows this write;
                // the synchronous finally releases its finite-wait count first.
                observation.completed = true;
                return result;
              } catch (error) {
                observation.failure =
                  options.signal.aborted || context.signal.aborted
                    ? 'observation_aborted'
                    : 'original_Task_observation_failed';
                throw error;
              } finally {
                openFiniteWaits--;
              }
            }
            const result = await tool.execute(input, context);
            if (tool.id === 'task.message')
              messages.push({
                sessionId: context.sessionId,
                runId: context.runId,
                executionId: context.executionId,
                input: structuredClone(input),
                result: structuredClone(result) as unknown as Json,
              });
            return result;
          },
        }),
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
        return { allowed: true as const, revision: 'owned-idle-question-only-1' };
      },
    };
    const rootToolIds = [...fileTools.map((tool) => tool.id), ...visible.map((tool) => tool.id)],
      childToolIds = [...fileTools.map((tool) => tool.id), 'task.message', 'task.events'];
    const binding = (): RunConfiguration => ({
      model,
      modelId: options.modelId,
      toolIds: rootToolIds,
      snapshot: { kind: 'owned-idle-question', version: 1 },
      permissions,
      afterTurn: permissions,
    });
    runtime = createRuntime({
      store: owned,
      model,
      modelId: options.modelId,
      modelConcurrency: 3,
      artifacts: createArtifactStore({ profile, store: owned }),
      extensions: [task, { id: 'live.idle-question', version: '1', apiMajor: 1, tools: fileTools }],
      permissions,
      afterTurn: permissions,
      resolveRunConfiguration: async () => binding(),
      resolveRecoveryRunConfiguration: async ({ run }) => {
        const saved = object(run.configuration);
        return {
          model,
          modelId: options.modelId,
          permissions,
          afterTurn: permissions,
          toolIds: Array.isArray(saved.tools)
            ? saved.tools.map((tool) => String(object(tool).id))
            : [],
          snapshot: saved.snapshot as RunConfiguration['snapshot'],
        };
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: childToolIds,
          snapshot: { kind: 'owned-idle-question-child', version: 1 },
        },
      ],
    });
    service = await startService({
      runtime,
      beforeResourceClose: closeFiles,
      subjectId: 'live-idle-question-owner',
      buildId: 'live-idle-question',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: resolveProfile(profile).profileAccessKey,
      },
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    const live = client;
    await live.connect();
    await live.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned finite idle question',
      rootUri: pathToFileURL(workspace).href,
    });
    await live.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      title: 'Idle parent finite question',
    });
    const childPrompt =
      'Read requirements.txt completely exactly once using read_file. The content may identify a missing human color choice. If missing, send EXACTLY ONE send_agent_message with target:"parent" and full question asking Blue or Green, including the complete source nonce read from the file. Then invoke wait_agent_events EXACTLY ONCE with wait_ms:30000 and after_seq:"0". This is a finite thirty-second real observation, never omit/null wait_ms, never poll or repeat. If it times out without a genuine human answer, finish this ordinary turn with BUSINESS_PENDING, the EXACT full message question verbatim, the actual source nonce, completed inspection and the unfinished color edit. Technical end is not business completion. Do not choose a color, edit/write files, delegate, cancel, follow up or issue another wait. Do not invent human approval or response.';
    await live.startRun('root', {
      expectedStoreId,
      commandId: 'A',
      kind: 'run.start',
      content: `New task: A. Spawn exactly ONE worker with prompt ${JSON.stringify(childPrompt)}, omit task_name and preset. After accepted spawn, finish your ordinary response immediately without waiting; accurately state that actual inspection/choice remain pending. Do not read/edit files, send messages, wait, follow up, interrupt, ask_user or create other collaborators. When the later original pending child result Source arrives, report BUSINESS_PENDING and reproduce the complete actual question/source nonce. Explain inspection ended technically, but no color was selected/applied and a genuine human Blue/Green choice is still required. Then finish ordinary response without Tool calls or new work. Never treat the question/result as human authorization.`,
    });
    const held = await until(
      async () => heldRead,
      'actual_child_requirements_read_gate_not_reached',
    );
    const originalParent = await until(async () => {
      const run = (await owned.getView('root')).runs.find((item) => item.rootWorkCommandId === 'A');
      return run && !run.isActive ? run : undefined;
    }, 'original_parent_did_not_finish_before_material');
    parentRunId = originalParent.id;
    assert(
      originalParent.status === 'completed' &&
        (await owned.getRun(held.runId))?.isActive &&
        reads.length === 0 &&
        readFileSync(join(workspace, 'settings.ini'), 'utf8') === initial,
      'parent_ordinary_idle_child_active_before_any_actual_material_read_or_color_effect',
    );
    parentInitialModelCount = (await owned.getView('root')).executions.filter(
      (row) => row.kind === 'model',
    ).length;
    stages.beforeMaterialRelease = {
      parentRunIdentitySha256: hash(parentRunId),
      childReadExecutionIdentitySha256: hash(held.executionId),
      cursor: (await owned.getMetadata()).lastChangeCursor,
      parentInitialModelCount,
    };
    materialGate.release();
    await until(
      async () => (messages.length === 1 && observations.length === 1 ? true : undefined),
      'real_one_parent_question_and_explicit_30s_observation_not_reached',
    );
    branch(reads.length === 1, 'one_actual_original_requirements_read_not_reached');
    let completeMaterial: Record<string, Json> = {};
    try {
      completeMaterial = object(JSON.parse(String(object(reads[0]!.result).content)));
    } catch {
      /* No full read inferred from a marker. */
    }
    assert(
      completeMaterial.content === requirements &&
        object(completeMaterial.baseline).hash === hash(Buffer.from(requirements)) &&
        object(completeMaterial.baseline).size === Buffer.byteLength(requirements),
      'actual_Files_complete_requirements_bytes_and_baseline_after_parent_idle',
    );
    branch(
      object(observations[0]!.input).waitMs === 30000 &&
        object(observations[0]!.input).afterSeq === '0',
      'Model_did_not_generate_exact_finite_30000ms_observation_input',
    );
    const sent = messages[0]!;
    branch(
      sent.sessionId === held.sessionId &&
        object(sent.input).target === 'parent' &&
        typeof object(sent.input).content === 'string',
      'actual_supported_parent_question_target_not_reached',
    );
    const question = String(object(sent.input).content);
    let messageReceipt: Record<string, Json> = {};
    try {
      messageReceipt = object(JSON.parse(String(object(sent.result).content)));
    } catch {
      /* Acceptance is not inferred from narration. */
    }
    assert(
      messageReceipt.accepted === true && messageReceipt.delivery === 'queued',
      'actual_supported_parent_message_accepted_queued_receipt',
    );
    assert(
      question.includes(nonce) &&
        /Blue/.test(question) &&
        /Green/.test(question) &&
        object(sent.result).outcome === 'succeeded',
      'actual_question_contains_complete_missing_choice_and_source_nonce',
    );
    const scope = { expectedStoreId, sessionId: 'root', subjectId: 'live-idle-question-owner' };
    const mail = (await owned.listAgentMessages(scope)).items.find(
      (item) => item.sourceSessionId === held.sessionId,
    );
    branch(mail, 'actual_original_question_mail_not_saved');
    const mailBody = new TextDecoder('utf-8', { fatal: true }).decode(
      (
        await runtime.readArtifact({
          expectedStoreId,
          refId: mail!.body.id,
          sessionId: mail!.sourceSessionId,
          subjectId: mail!.body.subjectId,
          scope: mail!.body.scope,
          signal: options.signal,
        })
      ).content,
    );
    assert(
      mailBody === question &&
        mail!.targetRunId === null &&
        (await owned.getView('root')).runs.every((run) => !run.isActive) &&
        readFileSync(join(workspace, 'settings.ini'), 'utf8') === initial,
      'actual_full_question_queued_to_idle_parent_without_wakeup_or_color_effect',
    );
    await until(async () => {
      const observation = observations[0];
      if (observation?.failure) throw new Boundary('branch_not_reached', observation.failure);
      return observation?.completed ? true : undefined;
    }, 'original_finite_30000ms_observation_did_not_complete');
    const observation = observations[0]!;
    let waitBody: Record<string, Json> = {};
    try {
      waitBody = object(JSON.parse(String(object(observation.result).content)));
    } catch {
      /* No fake timeout payload. */
    }
    branch(
      observations.length === 1 &&
        object(observation.input).waitMs === 30000 &&
        object(observation.input).afterSeq === '0' &&
        waitBody.reason === 'timeout' &&
        Array.isArray(waitBody.events) &&
        waitBody.events.length === 0,
      'actual_Model_explicit_one_30000ms_timeout_branch_not_reached',
    );
    assert(
      observation.elapsedMs !== undefined &&
        observation.elapsedMs >= 29_900 &&
        observation.elapsedMs < 90_000 &&
        observation.questionSavedBeforeWait &&
        observation.rootIdleBefore &&
        observation.rootIdleAfter &&
        observation.rootModelsBefore === parentInitialModelCount &&
        observation.rootModelsAfter === parentInitialModelCount &&
        openFiniteWaits === 0,
      'real_30s_Task_timer_no_extra_parent_Model_no_Model_response_hold',
    );
    const final = await until(async () => {
      const rootView = await owned.getView('root'),
        child = await owned.getView(held.sessionId),
        carriers = rootView.executions.filter((row) => row.kind === 'job' && row.childSessionId);
      return carriers.length === 1 &&
        carriers[0]!.status === 'succeeded' &&
        carriers[0]!.resultAcceptance &&
        rootView.runs.every((run) => !run.isActive) &&
        child.runs.every((run) => !run.isActive)
        ? { rootView, child, carrier: carriers[0]! }
        : undefined;
    }, 'actual_pending_child_result_and_parent_Source_not_finished');
    const containsExactQuestion = (value: string, question: string) => {
      if (value.includes(question)) return true;
      // Markdown quoting can wrap the complete original question without changing
      // its text. Remove only one quote marker per line, never normalize payload.
      const blocks = [...value.matchAll(/^>[^\r\n]*(?:\r?\n>[^\r\n]*)*/gm)];
      return (
        blocks.filter((block) => block[0].replace(/^> ?/gm, '').includes(question)).length === 1
      );
    };
    const body = String(object(final.carrier.result).content ?? '');
    const childReportModel = final.child.executions.find(
      (row) =>
        row.kind === 'model' &&
        row.status === 'succeeded' &&
        object(row.result).content === body &&
        options.requests().some((request) => request.requestId === row.id),
    );
    branch(childReportModel, 'actual_complete_child_pending_Model_report_not_identified');
    const fullChildOutput = await runtime.readModelOutput({
      expectedStoreId,
      sessionId: held.sessionId,
      subjectId: 'live-idle-question-owner',
      executionId: childReportModel!.id,
      signal: options.signal,
    });
    assert(
      fullChildOutput.output.complete &&
        fullChildOutput.output.content === body &&
        fullChildOutput.output.toolCalls.length === 0 &&
        streams.get(childReportModel!.id)?.finish &&
        streams.get(childReportModel!.id)?.eof,
      'complete_actual_child_Model_EOF_equals_original_pending_carrier_not_preview',
    );
    assert(
      body.includes('BUSINESS_PENDING') &&
        containsExactQuestion(body, question) &&
        body.includes(nonce) &&
        readFileSync(join(workspace, 'settings.ini'), 'utf8') === initial,
      'technical_child_success_contains_full_question_business_pending_zero_color_effect',
    );
    assert(
      final.child.runs.length === 1 &&
        final.child.runs[0]!.id === held.runId &&
        final.child.runs[0]!.status === 'completed' &&
        final.child.executions.filter((row) => row.kind === 'tool').length === 3 &&
        final.child.executions.filter((row) => row.definitionId === 'files.read').length === 1 &&
        final.child.executions.filter((row) => row.definitionId === 'task.message').length === 1 &&
        final.child.executions.filter((row) => row.definitionId === 'task.events').length === 1 &&
        messages.length === 1 &&
        observations.length === 1,
      'one_original_child_Run_three_real_Tools_no_infinite_wait_or_guessed_edit',
    );
    const source = final.carrier.resultAcceptance!,
      successor = final.rootView.runs.find((run) => run.id === source.runId);
    assert(
      successor?.status === 'completed' &&
        successor.id !== originalParent.id &&
        successor.rootWorkCommandId === 'A' &&
        successor.rootWorkSeq === originalParent.rootWorkSeq &&
        successor.contextSelectionId === source.selectionId &&
        final.rootView.runs.length === 2 &&
        final.carrier.resultRevision === '1' &&
        source.resultRevision === '1' &&
        final.carrier.delivery === 'consumed',
      'one_exact_idle_parent_successor_original_pending_result_Source_revision',
    );
    const sourceDb = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
      readonly: true,
      strict: true,
    });
    try {
      const rows = sourceDb
        .query<
          {
            id: string;
            execution_id: string;
            result_revision: string | number;
            selection_id: string;
            request_json: string;
          },
          [string]
        >(
          "SELECT id,execution_id,result_revision,selection_id,request_json FROM context_snapshot WHERE kind='result_ref' AND session_id='root' AND execution_id=? AND COALESCE(json_extract(request_json,'$.diagnostic'),0)=0",
        )
        .all(final.carrier.id);
      assert(
        rows.length === 1 &&
          rows[0]!.id === source.sourceId &&
          rows[0]!.execution_id === final.carrier.id &&
          String(rows[0]!.result_revision) === final.carrier.resultRevision &&
          rows[0]!.selection_id === source.selectionId &&
          object(JSON.parse(rows[0]!.request_json)).targetRunId === source.runId &&
          object(JSON.parse(rows[0]!.request_json)).pendingInput === false,
        'one_exact_durable_original_pending_result_Source_target_revision_prepared',
      );
    } finally {
      sourceDb.close();
    }
    assert(
      final.rootView.executions.filter((row) => row.kind === 'tool').length === 1 &&
        final.rootView.executions.find((row) => row.kind === 'tool')?.definitionId ===
          'task.spawn' &&
        readFileSync(join(workspace, 'requirements.txt'), 'utf8') === requirements,
      'parent_only_original_spawn_no_guessed_color_control_or_new_business',
    );
    let checked = 0,
      completeReadPrepared = false,
      completeSourcePrepared = false,
      timeoutPrepared = false;
    const parentAnswers: string[] = [];
    const canonicalModelEvidence = [];
    for (const view of [final.rootView, final.child])
      for (const row of view.executions.filter(
        (item) => item.kind === 'model' && item.status === 'succeeded',
      )) {
        const actual = options.requests().find((request) => request.requestId === row.id);
        branch(actual, 'successful_Model_not_real_counted_request');
        const saved = await runtime.readModelInput({
          expectedStoreId,
          sessionId: row.sessionId,
          subjectId: 'live-idle-question-owner',
          executionId: row.id,
        });
        const outputScope = {
          expectedStoreId,
          sessionId: row.sessionId,
          subjectId: 'live-idle-question-owner',
          executionId: row.id,
        };
        const canonicalOutput = await runtime.readModelOutput({
          ...outputScope,
          signal: options.signal,
        });
        assert(canonicalOutput.output.complete, 'canonical_successful_Model_output_complete');
        canonicalModelEvidence.push({ scope: outputScope, input: saved, output: canonicalOutput });
        const visibleRequest = structuredClone(actual!);
        for (const message of visibleRequest.messages)
          delete (message as { continuation?: unknown }).continuation;
        assert(
          isDeepStrictEqual(saved.request, visibleRequest) &&
            streams.get(row.id)?.finish &&
            streams.get(row.id)?.eof,
          `full_actual_ModelInput_and_real_EOF_${hash(row.id).slice(0, 12)}`,
        );
        if (row.sessionId === held.sessionId) {
          completeReadPrepared ||= saved.request.messages.some(
            (message) =>
              message.sourceIds?.includes(held.executionId) &&
              (message.content.includes(String(object(reads[0]!.result).content)) ||
                message.content.includes(
                  JSON.stringify(String(object(reads[0]!.result).content)).slice(1, -1),
                )),
          );
          timeoutPrepared ||= saved.request.messages.some(
            (message) =>
              message.sourceIds?.includes(observation.executionId) &&
              message.content.includes('timeout'),
          );
        }
        if (row.sessionId === 'root' && row.runId === source.runId) {
          const entries = saved.request.messages.filter((message) =>
            message.sourceIds?.includes(source.sourceId),
          );
          if (entries.length) {
            assert(
              entries.length === 1 &&
                (entries[0]!.content.includes(body) ||
                  entries[0]!.content.includes(JSON.stringify(body).slice(1, -1))),
              'actual_parent_exact_full_pending_carrier_Source_once',
            );
            completeSourcePrepared = true;
            const output = await runtime.readModelOutput({
              expectedStoreId,
              sessionId: 'root',
              subjectId: 'live-idle-question-owner',
              executionId: row.id,
              signal: options.signal,
            });
            assert(output.output.complete, 'actual_parent_pending_output_complete_not_preview');
            parentAnswers.push(output.output.content);
          }
        }
        checked++;
      }
    assert(
      completeReadPrepared &&
        timeoutPrepared &&
        completeSourcePrepared &&
        parentAnswers.some(
          (answer) =>
            answer.includes('BUSINESS_PENDING') &&
            answer.includes(nonce) &&
            /Blue/.test(answer) &&
            /Green/.test(answer),
        ),
      'real_child_read_timeout_and_parent_complete_pending_answer_prepared',
    );
    for (const item of [reads[0]!, sent, { ...observation, result: observation.result! }]) {
      const saved = await owned.getExecution(item.executionId);
      assert(
        saved?.status === 'succeeded' &&
          saved.originStoreId === expectedStoreId &&
          saved.sessionId === held.sessionId &&
          saved.runId === held.runId &&
          saved.rootWorkCommandId === 'A' &&
          saved.resultRevision === '1' &&
          isDeepStrictEqual(saved.input, item.input) &&
          isDeepStrictEqual(saved.result, item.result),
        `exact_original_question_Timer_read_input_result_scope_${hash(item.executionId).slice(0, 12)}`,
      );
    }
    const before = {
      cursor: (await owned.getMetadata()).lastChangeCursor,
      requests: options.requests().length,
      carrier: structuredClone(final.carrier),
    };
    const publicCarrier = await live.getExecution(final.carrier.id);
    assert(
      isDeepStrictEqual(await live.getExecution(final.carrier.id), publicCarrier) &&
        isDeepStrictEqual(await owned.getExecution(final.carrier.id), before.carrier) &&
        (await owned.getMetadata()).lastChangeCursor === before.cursor &&
        options.requests().length === before.requests &&
        openFiniteWaits === 0,
      'repeat_pending_result_read_zero_Timer_Model_Source_consumption_or_replay',
    );
    assert(
      options.requests().length - firstRequest > 0 &&
        options.requests().length - firstRequest <= 40,
      'actual_Model_calls_within_shared40HTTP600sec_budget',
    );
    stages.final = {
      mailIdentitySha256: hash(mail!.id),
      mailQuestionSha256: hash(mailBody),
      mailTargetInitiallyIdle: true,
      pendingCarrierIdentitySha256: hash(final.carrier.id),
      pendingCarrierBodySha256: hash(body),
      childFullOutputInspectorBodyHash: fullChildOutput.bodyHash,
      sourceIdentitySha256: hash(source.sourceId),
      successorRunIdentitySha256: hash(successor!.id),
      readResultSha256: digest(reads[0]!.result),
      questionToolResultSha256: digest(sent.result),
      waitToolInputSha256: digest(observation.input),
      waitToolResultSha256: digest(observation.result),
      observedWaitMs: observation.elapsedMs,
      actualParentOutputSha256: parentAnswers.map(hash),
      settingsBytesSha256: hash(Buffer.from(initial)),
      modelInputsChecked: checked,
      attachedChildJobs: final.child.executions.filter((row) => row.kind === 'job').length,
      contract73Qualified: false,
      semanticReviewRequired: true,
    };
    writeFileSync(
      join(root, 'canonical-model-evidence.json'),
      `${JSON.stringify(canonicalModelEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    stages.canonicalModelEvidenceFile = 'canonical-model-evidence.json';
    stages.canonicalModelScopes = canonicalModelEvidence.map(({ scope }) => scope);
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
    materialGate.release();
    let closed = true;
    try {
      client?.disposeNetwork();
    } catch {
      closed = false;
    }
    try {
      if (service) {
        await service.close();
        storeClosed = true;
      } else if (runtime) {
        const shutdown = runtime.tryBeginShutdown('cancel', { beforeResourceClose: closeFiles });
        if (shutdown.accepted) {
          await shutdown.completion;
          storeClosed = true;
        } else closed = false;
      }
    } catch {
      closed = false;
    }
    try {
      await closeFiles();
    } catch {
      closed = false;
    }
    if (!storeClosed)
      try {
        await store?.close();
      } catch {
        closed = false;
      }
    stages.observedFiniteWaits = observations.map((observation) => ({
      sessionIdentitySha256: hash(observation.sessionId),
      executionIdentitySha256: hash(observation.executionId),
      inputSha256: digest(observation.input),
      resultSha256: observation.result ? digest(observation.result) : null,
      startedEpochMs: observation.startedEpochMs,
      elapsedMs: observation.elapsedMs,
      completed: observation.completed,
      failure: observation.failure,
      rootIdleBefore: observation.rootIdleBefore,
      rootIdleAfter: observation.rootIdleAfter,
      questionSavedBeforeWait: observation.questionSavedBeforeWait,
      rootModelsBefore: observation.rootModelsBefore,
      rootModelsAfter: observation.rootModelsAfter,
    }));
    checks.resourcesClosed = closed && openFiniteWaits === 0;
    if (!checks.resourcesClosed) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    if (options.evidenceRoot || status !== 'passed')
      try {
        writeFileSync(
          join(root, 'idle-question-stages.json'),
          JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
          { mode: 0o600 },
        );
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
      }
    else
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
      }
  }
  return {
    cases: [
      {
        id,
        status,
        checks,
        reason,
        failurePoint,
        adapterAttempts: options.requests().length - firstRequest,
        canonicalEvidenceRetained: existsSync(root),
        semanticReviewRequired: true,
        coverage: [
          'real_parent_ordinary_idle_before_child_actual_requirements_read',
          'actual_supported_parent_message_one_real_30000ms_Task_timeout_no_Model_hold',
          'technical_child_success_business_pending_original_Source_one_parent_successor_zero_color_effect',
          'owned_allow_real_Files_Task_Model_saved_inputs_EOF_and_closed_Timer_resources',
          'not_contract73_attached_child_Job_unknown_cleanup_or_Blue_followup_compression_default_UI_qualification',
        ],
      },
    ],
  };
}
