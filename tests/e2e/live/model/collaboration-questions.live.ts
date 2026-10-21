import { Database } from 'bun:sqlite';
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
import { createAskUserExtension } from '@kite-ai/agent/ask-user';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

export type CollaborationQuestionCaseId = 'R02' | 'R09';
export interface CollaborationQuestionOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly CollaborationQuestionCaseId[];
  evidenceRoot?: string;
}
export interface CollaborationQuestionResult {
  caseId: CollaborationQuestionCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  assertions: string[];
  coverage: string[];
  providerRequests: number;
  failureCategory: 'oracle' | 'branch_not_hit' | 'aborted' | 'execution' | 'cleanup' | null;
  cleanup: 'closed' | 'failed';
  canonicalEvidenceRetained: boolean;
  failurePoint?:
    | 'setup'
    | 'material'
    | 'question_mail'
    | 'question_context'
    | 'human_answer'
    | 'follow_up';
}
class QuestionBoundary extends Error {
  readonly category: 'oracle' | 'branch_not_hit';
  readonly assertion: string;
  constructor(category: 'oracle' | 'branch_not_hit', assertion: string) {
    super(assertion);
    this.category = category;
    this.assertion = assertion;
  }
}
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
async function waitSignal(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('live_question_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** No configuration lookup or top-level network calls; all actors use the injected model. */
export async function runCollaborationQuestionCases(
  options: CollaborationQuestionOptions,
): Promise<CollaborationQuestionResult[]> {
  const ids = options.caseIds ?? ['R02', 'R09'];
  if (options.evidenceRoot !== undefined && (!isAbsolute(options.evidenceRoot) || ids.length !== 1))
    throw new Error('live_question_evidence_requires_absolute_new_single_case_root');
  const results: CollaborationQuestionResult[] = [];
  for (const id of ids) {
    if (options.signal.aborted) break;
    results.push(await runQuestion(id, options));
  }
  return results;
}

async function runQuestion(
  caseId: CollaborationQuestionCaseId,
  options: CollaborationQuestionOptions,
): Promise<CollaborationQuestionResult> {
  const result: CollaborationQuestionResult = {
    caseId,
    status: 'inconclusive',
    assertions: [],
    coverage:
      caseId === 'R02'
        ? ['idle_parent_single_child_completion']
        : ['R07_active_parent_question', 'R09_pending_child_same_session_follow_up'],
    providerRequests: 0,
    failureCategory: null,
    cleanup: 'closed',
    canonicalEvidenceRetained: false,
  };
  const firstRequest = options.requests().length;
  let failurePoint: NonNullable<CollaborationQuestionResult['failurePoint']> = 'setup';
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const materialGate = gate();
  const root = options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-question-'));
  if (options.evidenceRoot) {
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch {
      throw new Error('live_question_evidence_new_root_creation_failed');
    }
  }
  const canonicalRoot = realpathSync(root);
  const workspace = join(canonicalRoot, 'workspace');
  const selected = { dataRoot: join(canonicalRoot, 'data'), profile: 'live' };
  const nonce = randomUUID();
  const originalBytes = `# 合成资料 🪁\r\ntheme_color=unset\r\nkeep=${nonce}\r\n`;
  const expectedBytes = originalBytes.replace('theme_color=unset', 'theme_color=Blue');
  const requirement =
    caseId === 'R02'
      ? `已核定配色 Blue，合成编号 ${nonce}。请报告这两个真实事实，不修改文件。\n`
      : `合成编号 ${nonce}。配色尚未决定。可用值：Blue（蓝色）或 Green（绿色）。必须取得真实人类选择，不能自行决定；确认后只修改 shared/settings.ini 的 theme_color，其他字节不变。\n`;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let db: Database | undefined;
  let ownedFiles: ReturnType<typeof createWorkspaceFiles> | undefined;
  const reads: { sessionId: string; runId: string | null; executionId: string }[] = [];
  const assert = (condition: unknown, name: string) => {
    if (!condition) throw new QuestionBoundary('oracle', name);
    result.assertions.push(name);
  };
  const branch = (condition: unknown, name: string) => {
    if (!condition) throw new QuestionBoundary('branch_not_hit', name);
  };
  async function until<T>(read: () => Promise<T | undefined>, name: string): Promise<T> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new QuestionBoundary('branch_not_hit', name);
      await waitSignal(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
    }
  }
  try {
    mkdirSync(join(workspace, 'shared'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'requirements.txt'), requirement);
    writeFileSync(join(workspace, 'shared/settings.ini'), originalBytes);
    store = await openSqliteStore(selected);
    const ownedStore = store;
    db = new Database(join(selected.dataRoot, selected.profile, 'core.db'), { readonly: true });
    const ownedDb = db;
    const expectedStoreId = (await ownedStore.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 'root', subjectId: 'live-question-owner' };
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      stream(request, context) {
        return options.model.stream(request, { signal: AbortSignal.any([signal, context.signal]) });
      },
    };
    const material: ToolDefinition = {
      id: 'live.question-material',
      version: '1',
      model: { name: 'read_case_material' },
      description:
        'Read the complete real synthetic requirements.txt. This read may take time; do not invent its contents or duplicate a pending read.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_input, context) {
        reads.push({
          sessionId: context.sessionId,
          runId: context.runId,
          executionId: context.executionId,
        });
        if (context.sessionId !== 'root')
          await waitSignal(materialGate.promise, AbortSignal.any([signal, context.signal]));
        return {
          outcome: 'succeeded',
          content: readFileSync(join(workspace, 'requirements.txt'), 'utf8'),
        };
      },
    };
    ownedFiles = createWorkspaceFiles({ root: workspace });
    const files = createFileTools(ownedFiles);
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description:
            'Inspect real synthetic requirements; ask parent about missing decisions and preserve exact file bytes.',
        },
      ],
    });
    const childTools = [
      material.id,
      ...files.map((tool) => tool.id),
      ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
    ];
    runtime = createRuntime({
      store: ownedStore,
      model,
      modelId: options.modelId,
      modelConcurrency: 4,
      artifacts: createArtifactStore({ profile: selected, store: ownedStore }),
      extensions: [
        { id: 'live.question-fixture', version: '1', apiMajor: 1, tools: [material, ...files] },
        task,
        createAskUserExtension(),
      ],
      // Explicit owned-file fixture; not default approval-mode qualification.
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned-live-question-fixture' };
        },
      },
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'owned-live-question-fixture' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: childTools,
          snapshot: {},
        },
      ],
    });
    const profile = {
      dataRoot: realpathSync(selected.dataRoot),
      name: selected.profile,
      accessKey: resolveProfile(selected).profileAccessKey,
    };
    service = await startService({
      runtime,
      profile,
      buildId: 'live-collaboration-questions',
      subjectId: scope.subjectId,
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['commands', 'interactions'] },
    });
    const ownedClient = client;
    await ownedClient.connect();
    await ownedClient.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned question case',
      rootUri: pathToFileURL(workspace).href,
    });
    await ownedClient.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      commandId: 'create',
      title: 'Live question',
    });
    const prompt =
      caseId === 'R02'
        ? '请将配色资料检查委派给恰好一位协作者，让它用 read_case_material 读取完整资料，报告其中实际配色与合成编号，不修改文件。告诉我分工之后，你本轮先正常结束，不等待协作者；协作者结果回来后再准确汇总完整事实，不再新建协作者。'
        : '请将配色资料检查委派给恰好一位协作者，让它先用 read_case_material 读取完整 requirements.txt。要求它发现缺失决定时必须先给父 Agent 发消息询问，至多用一次有限 wait_agent_events 观察；未得到真实人类答案就如实交付待决结果并结束本轮，不能无限等待。你在当前轮等待协作者消息和本轮结束，把它实际发现的缺失决定通过 ask_user 问我，不自行选。真实人类回答后用 follow_up_agent 让同一协作者继续，只按确认颜色英文值修改 shared/settings.ini 的 theme_color，保持其他字节不变，在最终结果保留读取到的实际合成编号，并由你验证后汇总。不要创建替代协作者。';
    await ownedClient.startRun(
      'root',
      { expectedStoreId, commandId: 'work', kind: 'run.start', content: prompt },
      { signal },
    );
    const firstRead = await until(
      async () => reads.find((read) => read.sessionId !== 'root'),
      'real_child_material_gate_not_entered',
    );
    failurePoint = 'material';
    const carrier = (await ownedStore.getView('root')).executions.find(
      (execution) => execution.childSessionId === firstRead.sessionId,
    );
    branch(carrier, 'real_child_carrier_missing');
    const firstCarrier = carrier!;
    const originalRun = (await ownedStore.getView('root')).runs.find(
      (run) => run.rootWorkCommandId === 'work',
    );
    branch(originalRun, 'original_parent_run_missing');
    assert(
      (await ownedStore.getRun(firstRead.runId!))?.isActive,
      'real_child_active_at_material_gate',
    );
    const reportRows = () =>
      ownedDb
        .query(
          "SELECT id,status,receipt_json FROM command WHERE kind='job.report' AND session_id='root' ORDER BY seq",
        )
        .all()
        .map((row) => {
          const item = object(row);
          return {
            id: String(item.id),
            status: String(item.status),
            receipt: object(JSON.parse(String(item.receipt_json))),
          };
        });
    const idle = () =>
      until(async () => {
        const parent = await ownedStore.getView('root');
        const child = await ownedStore.getView(firstRead.sessionId);
        return parent.runs.every((run) => !run.isActive) &&
          child.runs.every((run) => !run.isActive) &&
          parent.session.ownerInstanceId === null &&
          child.session.ownerInstanceId === null
          ? parent
          : undefined;
      }, 'parent_child_not_idle');

    const rootRequests = async () => {
      const executions = await ownedStore.listExecutions('root');
      return options
        .requests()
        .slice(firstRequest)
        .filter((request) =>
          executions.some(
            (execution) => execution.kind === 'model' && execution.id === request.requestId,
          ),
        );
    };
    async function assertSavedSource(
      request: ModelRequest,
      sourceId: string,
      expectedContent: string,
    ) {
      const actual = request.messages.filter((message) => message.sourceIds?.includes(sourceId));
      assert(actual.length === 1, 'exact_source_once_per_real_parent_request');
      const saved = await runtime!.readModelInput({ ...scope, executionId: request.requestId });
      const persisted = saved.request.messages.filter((message) =>
        message.sourceIds?.includes(sourceId),
      );
      assert(
        persisted.length === 1 &&
          persisted[0]!.content === expectedContent &&
          isDeepStrictEqual(persisted[0]!.sourceIds, actual[0]!.sourceIds),
        'saved_parent_model_has_exact_complete_source_once',
      );
    }
    async function assertResultPrepared(
      carrier: NonNullable<Awaited<ReturnType<typeof ownedStore.getExecution>>>,
    ) {
      const acceptance = carrier.resultAcceptance;
      assert(
        acceptance &&
          acceptance.resultRevision === carrier.resultRevision &&
          carrier.delivery === 'consumed',
        'exact_carrier_result_revision_consumed',
      );
      const proof = acceptance!;
      const rows = ownedDb
        .query(
          "SELECT id,execution_id,result_revision,selection_id,request_json FROM context_snapshot WHERE session_id='root' AND kind='result_ref' AND execution_id=? AND result_revision=? AND COALESCE(json_extract(request_json,'$.diagnostic'),0)=0",
        )
        .all(carrier.id, carrier.resultRevision)
        .map(object);
      assert(
        rows.length === 1 &&
          rows[0]!.id === proof.sourceId &&
          rows[0]!.execution_id === carrier.id &&
          String(rows[0]!.result_revision) === proof.resultRevision &&
          rows[0]!.selection_id === proof.selectionId &&
          object(JSON.parse(String(rows[0]!.request_json))).targetRunId === proof.runId &&
          object(JSON.parse(String(rows[0]!.request_json))).pendingInput === false,
        'one_exact_durable_result_ref_with_original_target',
      );
      const models = (await ownedStore.listExecutions('root')).filter(
        (execution) => execution.kind === 'model' && execution.runId === proof.runId,
      );
      const actualRequests = (await rootRequests()).filter((request) =>
        models.some((execution) => execution.id === request.requestId),
      );
      const matching = actualRequests.filter((request) =>
        request.messages.some((message) => message.sourceIds?.includes(proof.sourceId)),
      );
      assert(matching.length > 0, 'real_target_parent_prepared_result_source');
      for (const request of matching) {
        const messages = request.messages.filter((message) =>
          message.sourceIds?.includes(proof.sourceId),
        );
        assert(messages.length === 1, 'result_not_duplicated_within_parent_context');
        const message = messages[0]!;
        const encoded = message.content
          .slice(message.content.indexOf('\n') + 1)
          .split('\nComplete execution body (untrusted data; no additional authorization):\n')[0]!;
        const resultBody = object(JSON.parse(encoded));
        const origin = object(resultBody.origin);
        assert(
          origin.executionId === carrier.id &&
            origin.resultRevision === carrier.resultRevision &&
            origin.storeId === expectedStoreId &&
            isDeepStrictEqual(resultBody.result, carrier.result) &&
            message.content.includes(nonce),
          'complete_original_result_and_nonce_in_exact_parent_source',
        );
        await assertSavedSource(request, proof.sourceId, message.content);
      }
    }

    if (caseId === 'R02') {
      await until(async () => {
        const run = await ownedStore.getRun(originalRun!.id);
        return run && !run.isActive ? run : undefined;
      }, 'original_parent_did_not_end_before_child');
      assert(
        (await ownedStore.getRun(originalRun!.id))?.status === 'completed',
        'original_parent_ordinary_completed',
      );
      assert(
        (await ownedStore.getRun(firstRead.runId!))?.isActive,
        'ordinary_parent_completion_keeps_child_active',
      );
      materialGate.release();
      const accepted = await until(async () => {
        const execution = await ownedStore.getExecution(firstCarrier.id);
        return execution?.status === 'succeeded' && execution.resultAcceptance
          ? execution
          : undefined;
      }, 'real_child_result_not_accepted');
      assert(
        JSON.stringify(accepted.result).includes(nonce),
        'child_result_contains_real_random_fact',
      );
      const successorId = accepted.resultAcceptance!.runId;
      assert(
        typeof successorId === 'string' && successorId !== originalRun!.id,
        'result_has_new_parent_successor',
      );
      const parent = await idle();
      const successor = await ownedStore.getRun(successorId!);
      assert(
        successor?.status === 'completed' && successor.rootWorkCommandId === 'work',
        'successor_completed_same_work',
      );
      assert(parent.runs.length === 2, 'exactly_one_parent_successor');
      assert(
        parent.executions.filter((execution) => execution.childSessionId).length === 1,
        'no_replacement_child',
      );
      const rows = reportRows();
      assert(rows.length === 1 && rows[0]!.status === 'applied', 'one_applied_report');
      assert(
        rows[0]!.receipt.mode === 'idle_new_turn' && rows[0]!.receipt.runId === successorId,
        'report_pins_original_idle_successor',
      );
      const sourceId = accepted.resultAcceptance!.sourceId;
      assert(rows[0]!.receipt.sourceId === sourceId, 'receipt_and_result_agree_on_source');
      await assertResultPrepared((await ownedStore.getExecution(firstCarrier.id))!);
      assert(
        parent.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.runId === successorId &&
            message.content.includes(nonce),
        ),
        'successor_response_preserves_verified_fact',
      );
      assert(
        readFileSync(join(workspace, 'shared/settings.ini'), 'utf8') === originalBytes,
        'inspection_has_zero_file_changes',
      );
      const before = options.requests().length;
      await ownedClient.getView('root', { signal });
      await ownedClient.getCommand(rows[0]!.id, { signal });
      assert(
        options.requests().length === before && reportRows().length === 1,
        'repeat_read_no_new_model_or_report',
      );
    } else {
      branch(
        (await ownedStore.getRun(originalRun!.id))?.isActive,
        'parent_not_active_before_child_question',
      );
      materialGate.release();
      const question = await until(
        async () =>
          (await ownedStore.listInteractions({ ...scope, state: 'pending' })).interactions.find(
            (interaction) => interaction.definitionId === 'ask_user',
          ),
        'real_parent_question_not_created',
      );
      branch(question.runId === originalRun!.id, 'question_not_in_original_active_parent');
      assert(
        readFileSync(join(workspace, 'shared/settings.ini'), 'utf8') === originalBytes,
        'no_color_effect_before_human_answer',
      );
      const initialChild = await until(async () => {
        const execution = await ownedStore.getExecution(firstCarrier.id);
        return execution && !['queued', 'running'].includes(execution.status)
          ? execution
          : undefined;
      }, 'child_did_not_finish_pending_round');
      assert(initialChild.status === 'succeeded', 'child_pending_round_technically_succeeded');
      assert(
        (await ownedStore.getView(firstRead.sessionId)).runs.every((run) => !run.isActive),
        'pending_child_idle_before_human_answer',
      );
      const mail = (await ownedStore.listAgentMessages(scope)).items.find(
        (item) => item.sourceSessionId === firstRead.sessionId,
      );
      branch(mail, 'real_child_question_mail_missing');
      assert(
        mail!.targetRunId === originalRun!.id,
        'child_question_targets_original_active_parent',
      );
      failurePoint = 'question_mail';
      const mailCommand = await ownedStore.getCommand(mail!.id);
      const carried = object(object(mailCommand?.receipt).carriedByResult);
      const firstAcceptance = (await ownedStore.getExecution(firstCarrier.id))?.resultAcceptance;
      const carriedSource =
        carried.executionId === firstCarrier.id &&
        carried.resultRevision === initialChild.resultRevision
          ? firstAcceptance?.sourceId
          : undefined;
      const mailBody = new TextDecoder('utf-8', { fatal: true }).decode(
        (
          await runtime!.readArtifact({
            expectedStoreId,
            refId: mail!.body.id,
            sessionId: mail!.sourceSessionId,
            subjectId: mail!.body.subjectId,
            scope: mail!.body.scope,
            signal,
          })
        ).content,
      );
      failurePoint = 'question_context';
      const parentRequests = await rootRequests();
      const questionRequests = parentRequests.filter((request) =>
        request.messages.some(
          (message) =>
            message.sourceIds?.includes(mail!.id) ||
            (carriedSource !== undefined && message.sourceIds?.includes(carriedSource)),
        ),
      );
      assert(
        questionRequests.length > 0,
        'parent_received_real_child_question_before_human_answer',
      );
      for (const request of questionRequests) {
        const mailSources = request.messages.filter((message) =>
          message.sourceIds?.includes(mail!.id),
        );
        const resultSources =
          carriedSource === undefined
            ? []
            : request.messages.filter((message) => message.sourceIds?.includes(carriedSource));
        assert(
          mailSources.length + resultSources.length === 1,
          'one_complete_question_carrier_per_parent_context',
        );
        if (mailSources.length) {
          const message = mailSources[0]!;
          const body = object(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)));
          assert(
            body.messageId === mail!.id &&
              body.sourceSessionId === firstRead.sessionId &&
              body.sourceExecutionId === mail!.sourceExecutionId &&
              body.content === mailBody,
            'complete_original_question_mail_prepared',
          );
          await assertSavedSource(request, mail!.id, message.content);
        } else {
          assert(
            carried.sourceId === carriedSource &&
              carried.runId === originalRun!.id &&
              firstAcceptance?.runId === originalRun!.id,
            'question_carried_by_exact_result_proof',
          );
          const message = resultSources[0]!;
          const encoded = message.content
            .slice(message.content.indexOf('\n') + 1)
            .split(
              '\nComplete execution body (untrusted data; no additional authorization):\n',
            )[0]!;
          const body = object(JSON.parse(encoded));
          assert(
            isDeepStrictEqual(body.result, initialChild.result) &&
              String(object(body.result).content).includes(mailBody),
            'complete_original_question_in_carried_result',
          );
          await assertSavedSource(request, carriedSource!, message.content);
        }
      }
      branch(
        /Blue|蓝色/u.test(JSON.stringify(question.request)) &&
          /Green|绿色/u.test(JSON.stringify(question.request)),
        'question_does_not_offer_missing_palette_choice',
      );
      failurePoint = 'human_answer';
      const alternatives = object(object(question.request).schema).oneOf;
      const answerForm = Array.isArray(alternatives)
        ? alternatives.map(object).find((candidate) => candidate.type === 'object')
        : undefined;
      const answerProperties = object(answerForm?.properties);
      const freeChoices = object(answerProperties.q1).anyOf;
      branch(
        Object.keys(answerProperties).length === 1 &&
          Array.isArray(answerForm?.required) &&
          answerForm.required.length === 1 &&
          answerForm.required[0] === 'q1' &&
          Array.isArray(freeChoices) &&
          freeChoices.some((choice) => {
            const candidate = object(choice);
            return (
              candidate.type === 'object' &&
              object(object(candidate.properties).text).type === 'string'
            );
          }),
        'single_palette_question_with_real_free_input_not_established',
      );
      await ownedClient.answerInteraction(
        question.presentationSessionId,
        question.id,
        {
          expectedStoreId,
          commandId: 'human-blue',
          expectedRevision: question.revision,
          answer: { kind: 'question', answers: { q1: { text: 'Blue（蓝色）' } } },
        },
        { signal },
      );
      await until(async () => {
        const command = await ownedStore.getCommand('human-blue');
        return command?.status === 'applied' ? command : undefined;
      }, 'public_human_answer_not_applied');
      const secondCarrier = await until(async () => {
        const execution = (await ownedStore.getView('root')).executions.find(
          (item) => item.id !== firstCarrier.id && item.childSessionId === firstRead.sessionId,
        );
        return execution?.status === 'succeeded' && execution.resultAcceptance
          ? execution
          : undefined;
      }, 'same_child_follow_up_result_not_accepted');
      const parent = await idle();
      const child = await ownedStore.getView(firstRead.sessionId);
      assert(
        child.runs.length === 2 && child.runs.every((run) => run.status === 'completed'),
        'same_child_two_completed_runs',
      );
      assert(
        new Set(
          parent.executions
            .filter((execution) => execution.childSessionId)
            .map((execution) => execution.childSessionId),
        ).size === 1,
        'stable_agent_session_no_replacement',
      );
      assert(
        parent.executions.filter((execution) => execution.childSessionId).length === 2,
        'one_follow_up_carrier',
      );
      assert(
        readFileSync(join(workspace, 'shared/settings.ini'), 'utf8') === expectedBytes,
        'real_files_blue_other_bytes_exact',
      );
      assert(
        /Blue|蓝色/u.test(JSON.stringify(secondCarrier.result)),
        'child_reports_actual_confirmed_blue',
      );
      assert(
        child.executions.some(
          (execution) =>
            execution.kind === 'tool' &&
            ['files.edit', 'files.write'].includes(execution.definitionId) &&
            execution.status === 'succeeded',
        ),
        'real_child_files_edit_succeeded',
      );
      assert(
        child.executions.filter(
          (execution) =>
            execution.kind === 'tool' &&
            ['files.edit', 'files.write'].includes(execution.definitionId) &&
            execution.status === 'succeeded',
        ).length === 1,
        'one_successful_color_edit',
      );
      for (const request of await rootRequests())
        assert(
          request.messages.filter((message) => message.sourceIds?.includes(mail!.id)).length <= 1,
          'question_mail_once_per_parent_context',
        );
      await assertResultPrepared((await ownedStore.getExecution(secondCarrier.id))!);
      assert(
        parent.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.runId === secondCarrier.resultAcceptance!.runId &&
            /Blue|蓝色/u.test(message.content),
        ),
        'parent_summary_preserves_verified_blue',
      );
      assert(
        (await ownedStore.getCommand('human-blue'))?.sessionId === question.presentationSessionId,
        'answer_saved_in_exact_presentation_scope',
      );
    }
    assert(
      readFileSync(join(workspace, 'requirements.txt'), 'utf8') === requirement,
      'requirements_remain_exact',
    );
    result.status = 'passed';
  } catch (error) {
    result.failurePoint = failurePoint;
    result.status =
      error instanceof QuestionBoundary && error.category === 'oracle' ? 'failed' : 'inconclusive';
    result.failureCategory = signal.aborted
      ? 'aborted'
      : error instanceof QuestionBoundary
        ? error.category
        : 'execution';
    if (error instanceof QuestionBoundary)
      result.assertions.push(`not_satisfied:${error.assertion}`);
  } finally {
    controller.abort();
    materialGate.release();
    client?.disposeNetwork();
    let failed = false;
    try {
      if (service) await service.close();
      else await runtime?.close();
    } catch {
      failed = true;
      try {
        await runtime?.close();
      } catch {
        failed = true;
      }
    }
    try {
      await ownedFiles?.close();
    } catch {
      failed = true;
    }
    try {
      db?.close();
    } catch {
      failed = true;
    }
    try {
      await store?.close();
    } catch {
      failed = true;
    }
    if (failed) {
      result.status = 'failed';
      result.cleanup = 'failed';
      result.failureCategory = 'cleanup';
    }
    if (options.evidenceRoot && result.status !== 'passed')
      result.canonicalEvidenceRetained = existsSync(canonicalRoot);
    else {
      try {
        rmSync(canonicalRoot, { recursive: true, force: true });
      } catch {
        result.status = 'failed';
        result.cleanup = 'failed';
        result.failureCategory = 'cleanup';
        result.canonicalEvidenceRetained = !!options.evidenceRoot && existsSync(canonicalRoot);
      }
    }
    result.providerRequests = options.requests().length - firstRequest;
  }
  return result;
}
