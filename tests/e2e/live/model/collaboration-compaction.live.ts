import { Database } from 'bun:sqlite';
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
import { type CompressionInput, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createSummaryCompressor } from '@kite-ai/service/configuration';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

const ids = [
  'R10-real-parent-child-automatic-compression-stable-identity-cold-read',
  'R10-real-compression-initial-high-command-and-event-sequences',
] as const;
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class Boundary extends Error {
  readonly kind: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(kind: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.kind = kind;
    this.point = point;
  }
}

/** Current Core ContextSlot only. Pure standard token policy, actual injected Model
 * for business AND summarization; no Legacy runner, fixed summary or response edits. */
export async function runLiveCollaborationCompaction(options: Options) {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_compaction_new_absolute_root_required');
  const cases: Record<string, unknown>[] = [];
  for (const id of selected) {
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-compaction-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    let store: Store | undefined, runtime: ReturnType<typeof createRuntime> | undefined;
    let files: ReturnType<typeof createWorkspaceFiles> | undefined;
    let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
    let failurePoint: string | undefined;
    let reason: string | undefined;
    let canonicalEvidenceRetained = false;
    let canonicalEvidence: unknown;
    const evidenceErrors: string[] = [];
    const cleanupErrors: { resource: string; error: string }[] = [];
    const checks: Record<string, boolean | number> = {};
    const start = options.requests().length;
    const tokenEvents: Record<string, unknown>[] = [],
      toolEvents: Record<string, unknown>[] = [];
    const assert = (value: unknown, point: string) => {
      checks[point] = Boolean(value);
      if (!value) throw new Boundary('oracle_violation', point);
    };
    const branch = (value: unknown, point: string) => {
      if (!value) throw new Boundary('branch_not_reached', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      for (;;) {
        signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        // The outer injected request/time budget remains the only paid-work bound.
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', fail);
            resolve();
          };
          const fail = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', fail);
            reject(new Boundary('branch_not_reached', point));
          };
          const timer = setTimeout(done, 25);
          signal.addEventListener('abort', fail, { once: true });
          if (signal.aborted) fail();
        });
      }
    }
    try {
      const nonce = randomUUID(),
        requestedMail = `Original question ${nonce}\r\nWhich palette is required for the eastern inspection: Blue or Green?\r\nObserved only; no authorization to edit files.\r\n`;
      // Finite actual files, not injected token usage. Content exceeds the explicit
      // 24000-token maintenance threshold; actual projection must independently prove it.
      const long = Array.from(
        { length: 420 },
        (_, n) =>
          `${n}: recorded inspection evidence ${nonce} ${'preserve actual observed facts and uncertainty; '.repeat(7)}`,
      ).join('\n');
      const assignments = {
        east: `Inspect eastern package. Read east.txt completely with Files read(path="east.txt",limit=1000); after the read send_agent_message(target="parent") with your complete question about which palette, Blue or Green, is required for the eastern inspection, reference ${nonce}, and explicitly state that the observation grants no authorization to edit files. Then finish an honest pending result containing the exact first-line original fact from east.txt and a complete account of that unresolved question. The message and your result may phrase the question independently; do not choose an answer. Do not choose a palette or modify any file. Preserve this original responsibility on continuation.`,
        west: `Inspect western package. Read west.txt completely with Files read(path="west.txt",limit=1000); report its exact first-line original west fact and finish. Do not inspect east.txt, send mail or modify files. Preserve this original responsibility on continuation.`,
      };
      const east1 = `east-original-${nonce}`,
        west1 = `west-original-${nonce}`,
        east2 = `east-current-${randomUUID()}`;
      writeFileSync(join(workspace, 'parent.txt'), `Parent material ${nonce}\n${long}\n`);
      writeFileSync(join(workspace, 'east.txt'), `${east1}\n${long}\n`);
      writeFileSync(join(workspace, 'west.txt'), `${west1}\n${long}\n`);
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const scope = { expectedStoreId, sessionId: 'root', subjectId: 'live-compaction-owner' };
      const permissions = {
        async authorize() {
          return { allowed: true as const, revision: 'owned-compaction-fixture' };
        },
      };
      // Same pure production algorithm. Observers record original input/policy
      // decisions only; they neither force true nor fabricate summary/usage.
      const standard = createSummaryCompressor({ automatic: { thresholdTokens: 24_000 } });
      const observe = (input: CompressionInput, phase: string, extra: unknown) =>
        tokenEvents.push({
          phase,
          sessionId: input.session.id,
          runId: input.run.id,
          trigger: input.trigger,
          modelId: input.modelId,
          tokenBaseline: input.tokenBaseline,
          messagesHash: hash(input.messages),
          ...object(extra),
        });
      const compressor = {
        id: standard.id,
        version: standard.version,
        async shouldCompress(input: CompressionInput) {
          const decision = await standard.shouldCompress!(input);
          observe(input, 'trigger', { decision });
          return decision;
        },
        async prepare(input: CompressionInput) {
          const proposal = await standard.prepare(input);
          observe(input, 'prepare', { proposal });
          return proposal;
        },
        async validateSummary(input: CompressionInput & { summary: string }) {
          const valid = await standard.validateSummary!(input);
          observe(input, 'summary_validation', { valid, summaryHash: hash(input.summary) });
          return valid;
        },
      };
      files = createWorkspaceFiles({ root: workspace });
      const fileTools = createFileTools(files).map((tool) => ({
        ...tool,
        async execute(
          input: Parameters<NonNullable<typeof tool.execute>>[0],
          context: Parameters<NonNullable<typeof tool.execute>>[1],
        ) {
          const result = await tool.execute!(input, context);
          toolEvents.push({
            kind: 'files',
            definitionId: tool.id,
            input,
            sessionId: context.sessionId,
            runId: context.runId,
            executionId: context.executionId,
            result,
          });
          return result;
        },
      }));
      const task = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description:
              'Inspect the assigned eastern or western package; identities are stable and names optional.',
          },
        ],
      });
      const observedTask = {
        ...task,
        tools: task.tools!.map((tool) => ({
          ...tool,
          async execute(
            input: Parameters<NonNullable<typeof tool.execute>>[0],
            context: Parameters<NonNullable<typeof tool.execute>>[1],
          ) {
            const result = await tool.execute!(input, context);
            toolEvents.push({
              kind: 'task',
              definitionId: tool.id,
              input,
              sessionId: context.sessionId,
              runId: context.runId,
              executionId: context.executionId,
              result,
            });
            return result;
          },
        })),
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        stream(request, context) {
          return options.model.stream(request, {
            signal: AbortSignal.any([signal, context.signal]),
          });
        },
      };
      const tools = [...fileTools, ...observedTask.tools];
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        compressor,
        permissions,
        afterTurn: permissions,
        extensions: [
          { id: 'live.compaction-files', version: '1', apiMajor: 1, tools: fileTools },
          observedTask,
        ],
        childConfigurations: [
          {
            id: 'worker',
            version: '1',
            model,
            modelId: options.modelId,
            compressor,
            permissions,
            afterTurn: permissions,
            toolIds: tools.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
            snapshot: { fixture: 'real-standard-automatic-compression', thresholdTokens: 24000 },
          },
        ],
      });
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned compaction fixture',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Two unnamed inspections',
      });
      const high = id === ids[1];
      if (high) {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          safeIntegers: true,
        });
        try {
          branch((await owned.getView('root')).runs.length === 0, 'high_seed_only_before_business');
          const encode = (value: unknown) =>
            JSON.stringify(value, (_key, item) =>
              typeof item === 'bigint' ? item.toString() : item,
            );
          const tables = db
            .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((row) => String(object(row).name));
          const snapshot = () =>
            Object.fromEntries(
              tables.map((table) => [
                table,
                db.query(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all(),
              ]),
            );
          const before = snapshot();
          assert(
            (before.run?.length ?? 0) === 0 &&
              (before.execution?.length ?? 0) === 0 &&
              (before.context_snapshot?.length ?? 0) === 0,
            'high_seed_empty_execution_and_context_tables',
          );
          const oldRoot = object(before.session!.find((row) => object(row).id === 'root'));
          const oldMeta = object(before.storage_meta![0]);
          db.run("UPDATE session SET next_seq=? WHERE id='root'", [9007199254740993n]);
          db.run('UPDATE storage_meta SET last_change_cursor=? WHERE singleton=1', [
            9007199254740993n,
          ]);
          const after = JSON.parse(encode(snapshot()));
          const normalized = structuredClone(after);
          normalized.session.find((row: Record<string, unknown>) => row.id === 'root').next_seq =
            String(oldRoot.next_seq);
          normalized.storage_meta[0].last_change_cursor = String(oldMeta.last_change_cursor);
          assert(
            encode(normalized) === encode(before),
            'high_seed_changes_only_two_empty_Store_counter_cells',
          );
          writeFileSync(
            join(root, 'pre-business-high-sequence-preparation.json'),
            `${JSON.stringify({ before: JSON.parse(encode(before)), after, noBusinessOrProviderHistorySeeded: true }, null, 2)}\n`,
            { mode: 0o600 },
          );
        } finally {
          db.close();
        }
      }
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: `New task: Read parent.txt completely with Files read(path="parent.txt",limit=1000). Then spawn exactly two unnamed worker agents using only prompt, omit task_name and preset. First prompt ${JSON.stringify(assignments.east)}. Second prompt ${JSON.stringify(assignments.west)}. Wait finitely for both actual children. Report observed facts and the unresolved palette question without inventing an answer. Never write files or create more children. After both complete finish this turn; later I will provide a genuine answer.`,
        },
      });
      let minimumRootRuns = 1;
      const settled = async () => {
        const rootView = await owned.getView('root');
        const acceptedCommands = await owned.listAcceptedCommands('root', 200);
        const agents = await owned.listStableAgents({ ...scope, extensionId: task.id, limit: 200 });
        if (
          rootView.runs.some((run) => run.isActive) ||
          rootView.runs.length < minimumRootRuns ||
          acceptedCommands.length !== 0 ||
          agents.items.length !== 2 ||
          agents.items.some((agent) => agent.state !== 'idle')
        )
          return undefined;
        const carriers = await Promise.all(
          agents.items.map((agent) => owned.getExecution(agent.ref.executionId!)),
        );
        if (
          carriers.some((carrier) => !carrier?.resultAcceptance || carrier.delivery !== 'consumed')
        )
          return undefined;
        const children = await Promise.all(
          agents.items.map((agent) => owned.getView(agent.agentId)),
        );
        if (children.some((view) => view.runs.some((run) => run.isActive))) return undefined;
        return { rootView, agents, children };
      };
      const initial = await until(settled, 'initial_parent_and_two_children_terminal');
      const east = initial.agents.items.find(
          (agent) => agent.assignmentSource.content === assignments.east,
        ),
        west = initial.agents.items.find(
          (agent) => agent.assignmentSource.content === assignments.west,
        );
      branch(east && west, 'two_exact_original_assignments_created');
      assert(
        initial.agents.items.every((agent) => agent.taskName === null),
        'two_original_children_unnamed',
      );
      const mail = (await owned.listAgentMessages(scope)).items
        .filter((item) => item.kind === 'message')
        .find((item) => item.sourceSessionId === east!.agentId);
      branch(mail, 'original_east_mail_exists');
      const originalSend = toolEvents.find(
        (event) =>
          event.definitionId === 'task.message' &&
          event.executionId === mail!.sourceExecutionId &&
          event.sessionId === east!.agentId &&
          object(event.input).target === 'parent',
      );
      branch(originalSend, 'original_mail_missing_actual_Model_send_invocation');
      const originalMail = String(object(originalSend!.input).content ?? '');
      branch(originalMail.length > 0, 'original_Model_send_missing_actual_body');
      // Ordinary Model generation is reviewed for complete question facts/scope, not
      // byte copying a scripted sentence. Preserve every actual generated byte below.
      writeFileSync(
        join(root, 'original-mail-generation.json'),
        `${JSON.stringify({ requestedMail, originalMail, sourceExecutionId: mail!.sourceExecutionId, requestedBytesEqual: requestedMail === originalMail, acceptance: 'Independently review the actual complete mail and child result for the eastern palette alternatives, reference, pending status and no-edit authorization. They may phrase the question independently. Actual Tool mail bytes remain exact through Artifact, its own Source and cold reads; actual child EOF body remains exact through carrier and its own Source.', semanticReviewRequired: true }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const mailBody = new TextDecoder('utf-8', { fatal: true }).decode(
        (
          await runtime.readArtifact({
            expectedStoreId,
            sessionId: mail!.sourceSessionId,
            subjectId: mail!.body.subjectId,
            scope: mail!.body.scope,
            refId: mail!.body.id,
            signal,
          })
        ).content,
      );
      assert(mailBody === originalMail, 'original_mail_full_bytes');
      const firstCarrier = await owned.getExecution(east!.ref.executionId!);
      branch(
        firstCarrier?.status === 'succeeded' && firstCarrier.resultAcceptance,
        'east_first_carrier_accepted',
      );
      const originalSourceId = firstCarrier!.resultAcceptance!.sourceId;
      const originalChildBody = String(object(firstCarrier!.result).content ?? '');
      const initialEastView = await owned.getView(east!.agentId);
      const originalChildOutputs = await Promise.all(
        initialEastView.executions
          .filter(
            (execution) =>
              execution.kind === 'model' &&
              execution.status === 'succeeded' &&
              execution.runId === object(object(firstCarrier!.result).details).runId &&
              object(execution.result).finishReason === 'stop' &&
              options.requests().some((request) => request.requestId === execution.id),
          )
          .map((execution) =>
            runtime!.readModelOutput({
              expectedStoreId,
              sessionId: east!.agentId,
              subjectId: scope.subjectId,
              executionId: execution.id,
            }),
          ),
      );
      assert(
        originalChildBody.length > 0 &&
          originalChildOutputs.filter(
            (output) => output.output.complete && output.output.content === originalChildBody,
          ).length === 1,
        'actual_complete_original_child_EOF_body_equals_carrier',
      );
      const preparedMail = options
        .requests()
        .slice(start)
        .map((request) => ({
          requestId: request.requestId,
          messages: request.messages.filter((message) => message.sourceIds?.includes(mail!.id)),
        }))
        .filter((entry) => entry.messages.length > 0);
      assert(
        preparedMail.length > 0 &&
          preparedMail.every(
            (entry) =>
              entry.messages.length === 1 &&
              (entry.messages[0]!.content.includes(originalMail) ||
                entry.messages[0]!.content.includes(JSON.stringify(originalMail).slice(1, -1))),
          ),
        'actual_original_mail_Source_retains_complete_generated_mail_body',
      );
      const westCarrier = await owned.getExecution(west!.ref.executionId!);
      assert(
        String(object(firstCarrier!.result).content).includes(east1) &&
          String(object(westCarrier?.result).content).includes(west1),
        'both_initial_carriers_report_actual_original_Files_facts',
      );
      const initialCompression = new Map<string, unknown>();
      for (const sessionId of ['root', east!.agentId, west!.agentId]) {
        const selected = await owned.getModelContext({ expectedStoreId, sessionId });
        branch(
          selected.compression?.trigger === 'automatic',
          `${sessionId}_real_automatic_compression_published`,
        );
        initialCompression.set(sessionId, selected.compression);
        const record = selected.compression!;
        const execution = await owned.getExecution(record.modelExecutionId);
        assert(
          execution?.status === 'succeeded' &&
            execution.sessionId === sessionId &&
            execution.runId === record.runId,
          `${sessionId}_published_original_successful_Model`,
        );
        const snapshot = object(record.compressor.snapshot),
          projection = object(snapshot.tokenProjection);
        assert(
          snapshot.tokenAccounting === 'measured-input-plus-additions-v1' &&
            projection.source === 'reported_baseline' &&
            typeof projection.baselineExecutionId === 'string' &&
            Number(projection.totalInputTokens) >= 24000,
          `${sessionId}_actual_projected_threshold`,
        );
        const baseline = await owned.getExecution(String(projection.baselineExecutionId));
        assert(
          baseline?.kind === 'model' &&
            baseline.status === 'succeeded' &&
            baseline.sessionId === sessionId &&
            baseline.runId === record.runId &&
            object(object(baseline.result).usage).inputTokens === projection.measuredInputTokens,
          `${sessionId}_actual_baseline_Execution_and_measured_usage`,
        );
        const saved = await runtime.readModelInput({
          expectedStoreId,
          sessionId,
          subjectId: scope.subjectId,
          executionId: execution!.id,
        });
        assert(
          saved.request.tools.length === 0 &&
            options.requests().some((request) => request.requestId === execution!.id),
          `${sessionId}_real_summarization_not_stubbed`,
        );
        const expectedPath =
          sessionId === 'root'
            ? 'parent.txt'
            : sessionId === east!.agentId
              ? 'east.txt'
              : 'west.txt';
        const originalFile =
          expectedPath === 'parent.txt'
            ? `Parent material ${nonce}\n${long}\n`
            : `${sessionId === east!.agentId ? east1 : west1}\n${long}\n`;
        const fullReads = toolEvents
          .filter(
            (event) =>
              event.definitionId === 'files.read' &&
              event.sessionId === sessionId &&
              object(event.input).path === expectedPath,
          )
          .filter((event) => {
            try {
              return (
                object(JSON.parse(String(object(event.result).content))).content === originalFile
              );
            } catch {
              return false;
            }
          });
        // A model may legitimately reread the same unchanged file after an earlier
        // compression. Prove the selected summarizer received an exact complete read
        // Source, rather than requiring exactly one read across the entire Session.
        const preparedFullReads = fullReads.filter((event) => {
          const sourceId = String(event.executionId);
          const messages = saved.request.messages.filter((message) =>
            message.sourceIds?.includes(sourceId),
          );
          return (
            messages.length === 1 &&
            messages[0]!.sourceIds?.filter((id) => id === sourceId).length === 1 &&
            (messages[0]!.content.includes(originalFile) ||
              messages[0]!.content.includes(JSON.stringify(originalFile).slice(1, -1)))
          );
        });
        assert(
          preparedFullReads.length >= 1,
          `${sessionId}_full_original_Files_body_reached_actual_summarization_input`,
        );
        const summary = await runtime.readModelOutput({
          expectedStoreId,
          sessionId,
          subjectId: scope.subjectId,
          executionId: execution!.id,
        });
        assert(
          summary.output.complete &&
            summary.output.content.length > 0 &&
            !summary.output.toolCalls.length,
          `${sessionId}_full_summary_complete`,
        );
        const subsequent = options
          .requests()
          .filter(
            (request) =>
              request.requestId !== execution!.id &&
              request.messages.some(
                (message) =>
                  message.sourceIds?.includes(record.id) &&
                  message.content.includes(summary.output.content),
              ),
          );
        assert(subsequent.length > 0, `${sessionId}_effective_selected_request_uses_exact_summary`);
      }
      writeFileSync(join(workspace, 'east.txt'), `${east2}\nPalette: Blue\n`);
      minimumRootRuns = initial.rootView.runs.length + 1;
      const beforeAnswer = await owned.getSession('root');
      await runtime.submitCommand({
        ...scope,
        commandId: 'answer',
        request: {
          kind: 'input.follow_up',
          afterRunId: initial.rootView.runs.at(-1)!.id,
          contextSelectionId: beforeAnswer!.contextSelectionId,
          content: `Follow up: The human answers the original eastern palette question: Blue. Use list_agents to read complete original responsibilities and select the eastern inspector, not the similar western inspector. Follow up exactly that same agent_id; ask it to read east.txt again, report the actual current version and Blue, preserve the original question as history, and perform no edits. Wait finitely and report original and current facts. Do not spawn a replacement child or follow up western inspection.`,
        },
      });
      const final = await until(settled, 'follow_up_parent_and_same_children_terminal');
      const answerPublic = await owned.getCommand('answer');
      const answerReceipt = object(answerPublic?.receipt);
      const answerBusinessCommandId = answerReceipt.businessCommandId;
      const answerRunId = answerReceipt.runId;
      branch(
        typeof answerBusinessCommandId === 'string' && typeof answerRunId === 'string',
        'formal_answer_has_no_applied_business_receipt',
      );
      const answerBusiness = await owned.getCommand(String(answerBusinessCommandId));
      const answerRun = await owned.getRun(String(answerRunId));
      assert(
        answerPublic?.id === 'answer' &&
          answerPublic.status === 'applied' &&
          answerPublic.sessionId === 'root' &&
          answerPublic.originStoreId === expectedStoreId &&
          answerReceipt.outcome === 'human_input_applied' &&
          answerReceipt.sourceCommandId === answerBusinessCommandId &&
          answerBusiness !== null &&
          answerBusiness.id === answerBusinessCommandId &&
          answerBusiness.status === 'applied' &&
          answerBusiness.kind === 'input.follow_up' &&
          answerBusiness.sessionId === 'root' &&
          answerBusiness.originStoreId === expectedStoreId &&
          object(answerBusiness.receipt).runId === answerRunId &&
          answerRun !== null &&
          answerRun.id === answerRunId &&
          answerRun.sessionId === 'root' &&
          answerRun.originStoreId === expectedStoreId &&
          answerRun.originCommandId === answerBusinessCommandId &&
          answerRun.rootWorkCommandId === firstCarrier!.rootWorkCommandId &&
          answerRun.rootWorkSeq === firstCarrier!.rootWorkSeq,
        'formal_answer_receipt_exact_business_Command_Run_Store_and_original_work',
      );
      writeFileSync(
        join(root, 'answer-business-binding.json'),
        `${JSON.stringify({ answerPublic, answerBusiness, answerRun }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const follow = toolEvents.filter((event) => event.definitionId === 'task.follow_up');
      const spawns = toolEvents.filter((event) => event.definitionId === 'task.spawn');
      assert(
        spawns.length === 2 && spawns.every((event) => event.sessionId === 'root'),
        'exactly_two_root_spawns_zero_grandchild_or_replacement_creation',
      );
      branch(follow.length === 1, 'one_actual_Model_follow_up_tool');
      const actualLists = toolEvents.filter(
        (event) => event.definitionId === 'task.list' && event.sessionId === 'root',
      );
      assert(
        actualLists.some((event) => {
          const body = object(event.result);
          let value: unknown;
          try {
            value = JSON.parse(String(body.content));
          } catch {
            return false;
          }
          const items = object(value).items;
          return (
            Array.isArray(items) &&
            items.some(
              (item) =>
                object(item).agent_id === east!.agentId &&
                object(object(item).assignment_source).content === assignments.east,
            ) &&
            items.some(
              (item) =>
                object(item).agent_id === west!.agentId &&
                object(object(item).assignment_source).content === assignments.west,
            )
          );
        }),
        'actual_Model_received_complete_original_responsibilities_in_directory',
      );
      assert(
        object(follow[0]!.input).agentId === east!.agentId,
        'actual_Model_selected_exact_eastern_agent',
      );
      assert(
        final.agents.items.length === 2 &&
          final.agents.items.some((agent) => agent.agentId === east!.agentId) &&
          final.agents.items.some((agent) => agent.agentId === west!.agentId),
        'same_two_agent_ids_no_replacement',
      );
      assert(
        final.agents.items.find((agent) => agent.agentId === east!.agentId)?.assignmentSource
          .content === assignments.east,
        'original_full_delegation_unchanged',
      );
      const eastFinal = await owned.getView(east!.agentId),
        westFinal = await owned.getView(west!.agentId);
      assert(
        eastFinal.runs.length === 2 && westFinal.runs.length === 1,
        'exact_same_east_Session_new_Run_only',
      );
      const v2Reads = toolEvents.filter(
        (event) =>
          event.kind === 'files' &&
          event.sessionId === east!.agentId &&
          JSON.stringify(event.result).includes(east2),
      );
      assert(v2Reads.length === 1, 'actual_same_child_fresh_Files_v2_read_once');
      const finalOutput = await Promise.all(
        final.rootView.executions
          .filter(
            (execution) =>
              execution.kind === 'model' &&
              execution.status === 'succeeded' &&
              execution.originCommandId === answerBusinessCommandId &&
              execution.runId === answerRunId,
          )
          .map((execution) =>
            runtime!.readModelOutput({
              expectedStoreId,
              sessionId: 'root',
              subjectId: scope.subjectId,
              executionId: execution.id,
            }),
          ),
      );
      assert(
        finalOutput.some(
          (result) =>
            result.output.content.includes(east2) &&
            result.output.content.includes(east1) &&
            result.output.toolCalls.length === 0 &&
            /Blue/.test(result.output.content),
        ),
        'actual_parent_reports_current_fact_and_human_answer',
      );
      assert(
        toolEvents.every(
          (event) => !['files.write', 'files.edit'].includes(String(event.definitionId)),
        ) &&
          readFileSync(join(workspace, 'parent.txt'), 'utf8') ===
            `Parent material ${nonce}\n${long}\n` &&
          readFileSync(join(workspace, 'west.txt'), 'utf8') === `${west1}\n${long}\n` &&
          readFileSync(join(workspace, 'east.txt'), 'utf8') === `${east2}\nPalette: Blue\n`,
        'zero_Model_file_effects_actual_source_bytes_unchanged',
      );
      const source = (
        await owned.getSelectedContext({ expectedStoreId, sessionId: 'root', sourceLimit: 100 })
      ).resultSources.find((item) => item.id === originalSourceId);
      assert(
        source?.executionId === firstCarrier!.id &&
          source.resultRevision === firstCarrier!.resultRevision &&
          isDeepStrictEqual(source.result, firstCarrier!.result),
        'original_carrier_Source_full_result_revision_identity_after_compression_and_follow_up',
      );
      const preparedOriginal = options
        .requests()
        .slice(start)
        .filter((request) =>
          request.messages.some((message) => message.sourceIds?.includes(originalSourceId)),
        );
      assert(
        preparedOriginal.length > 0 &&
          preparedOriginal.every((request) => {
            const matched = request.messages.filter((message) =>
              message.sourceIds?.includes(originalSourceId),
            );
            return (
              matched.length === 1 &&
              (matched[0]!.content.includes(originalChildBody) ||
                matched[0]!.content.includes(JSON.stringify(originalChildBody).slice(1, -1)))
            );
          }),
        'actual_original_complete_child_result_Source_once_per_request',
      );
      const answerExecutionIds = new Set(
        final.rootView.executions
          .filter(
            (execution) =>
              execution.kind === 'model' &&
              execution.originCommandId === answerBusinessCommandId &&
              execution.runId === answerRunId,
          )
          .map((execution) => execution.id),
      );
      assert(
        preparedOriginal.some((request) => answerExecutionIds.has(request.requestId)),
        'post_compression_actual_parent_continuation_preserves_original_Source_id',
      );
      const finalCompression = new Map<string, string>();
      for (const sessionId of ['root', east!.agentId, west!.agentId])
        finalCompression.set(
          sessionId,
          (await owned.getModelContext({ expectedStoreId, sessionId })).compression!.id,
        );
      // Retain every attempted saved input and output, including failed attempts.
      for (const sessionId of ['root', east!.agentId, west!.agentId])
        for (const execution of await owned.listExecutions(sessionId, 1000)) {
          if (execution.kind !== 'model') continue;
          const actual = options.requests().find((request) => request.requestId === execution.id);
          const input = await runtime.readModelInput({
            expectedStoreId,
            sessionId,
            subjectId: scope.subjectId,
            executionId: execution.id,
          });
          const output = await runtime.readModelOutput({
            expectedStoreId,
            sessionId,
            subjectId: scope.subjectId,
            executionId: execution.id,
          });
          if (actual) {
            const visible = structuredClone(actual);
            for (const message of visible.messages)
              delete (message as { continuation?: unknown }).continuation;
            assert(isDeepStrictEqual(visible, input.request), `actual_saved_input_${execution.id}`);
          }
          assert(
            execution.status !== 'succeeded' || output.output.complete,
            `complete_saved_output_${execution.id}`,
          );
        }
      const eventCursor = await owned.listAgentEvents({ ...scope, extensionId: task.id, limit: 1 });
      const secondPage = await owned.listAgentEvents({
        ...scope,
        extensionId: task.id,
        afterSeq: eventCursor.nextSeq,
        limit: 200,
      });
      assert(
        eventCursor.events.length === 1 &&
          secondPage.events.length > 0 &&
          secondPage.events.every((event) => BigInt(event.seq) > BigInt(eventCursor.nextSeq)),
        'real_event_cursor_keyset_exact',
      );
      if (high)
        assert(
          [...eventCursor.events, ...secondPage.events].every(
            (event) => BigInt(event.seq) > 9007199254740992n,
          ) && final.rootView.runs.every((run) => BigInt(run.rootWorkSeq) > 9007199254740992n),
          'actual_high_event_and_work_sequences_without_number_rounding',
        );
      // Retain original inputs before the live-to-cold owner transition as well;
      // a failed close/reopen must not erase the already available evidence.
      canonicalEvidence = await saveLiveCanonicalModelEvidence({
        runtime,
        store: owned,
        requests: options.requests().slice(start),
        root,
        subjectId: scope.subjectId,
      });
      canonicalEvidenceRetained = true;
      assert(
        object(canonicalEvidence).complete === true,
        'complete_live_canonical_model_evidence_before_cold_read',
      );
      // Release the live owner before opening a fresh Store and a fresh zero-use
      // runtime. It has no auto-recover invocation or live Model credentials.
      await runtime.close();
      runtime = undefined;
      store = undefined;
      store = await openSqliteStore(profile);
      const coldStore = store;
      const liveRequestsBeforeCold = options.requests().length;
      const cursorBefore = (await coldStore.getMetadata()).lastChangeCursor;
      const sessionsBefore = await Promise.all(
        ['root', east!.agentId, west!.agentId].map((sessionId) => coldStore.getSession(sessionId)),
      );
      let coldProviderCalls = 0;
      const coldModel: ModelAdapter = {
        stream() {
          coldProviderCalls++;
          throw Error('cold_read_must_not_dispatch_Provider');
        },
      };
      runtime = createRuntime({
        store: coldStore,
        artifacts: createArtifactStore({ profile, store: coldStore }),
        model: coldModel,
        modelId: options.modelId,
        permissions,
      });
      const coldDirectory = await coldStore.listStableAgents({
        ...scope,
        extensionId: task.id,
        limit: 200,
      });
      assert(
        coldDirectory.items.length === 2 &&
          coldDirectory.items.find((agent) => agent.agentId === east!.agentId)?.assignmentSource
            .content === assignments.east,
        'cold_full_original_delegation_and_same_agent_id',
      );
      for (const [sessionId, before] of initialCompression) {
        const selected = await coldStore.getModelContext({ expectedStoreId, sessionId });
        assert(
          selected.compression?.id === finalCompression.get(sessionId),
          `${sessionId}_cold_exact_current_compression_identity`,
        );
        const origin = await runtime.getCompressionOrigin({
          expectedStoreId,
          sessionId,
          subjectId: scope.subjectId,
          compressionId: String(object(before).id),
        });
        await runtime.readModelOutput({
          expectedStoreId,
          sessionId: origin.originSessionId,
          subjectId: scope.subjectId,
          executionId: origin.modelExecutionId,
        });
      }
      const coldOriginalCarrier = await coldStore.getExecution(firstCarrier!.id);
      const coldMail = await coldStore.getAgentMessage({ ...scope, messageId: mail!.id });
      const coldMailBody = new TextDecoder('utf-8', { fatal: true }).decode(
        (
          await runtime.readArtifact({
            expectedStoreId,
            sessionId: mail!.sourceSessionId,
            subjectId: mail!.body.subjectId,
            scope: mail!.body.scope,
            refId: mail!.body.id,
            signal,
          })
        ).content,
      );
      assert(coldMailBody === originalMail, 'cold_complete_original_mail_bytes');
      const coldSource = (
        await coldStore.getSelectedContext({ expectedStoreId, sessionId: 'root', sourceLimit: 100 })
      ).resultSources.find((item) => item.id === originalSourceId);
      assert(
        isDeepStrictEqual(coldSource, source),
        'cold_exact_original_Source_body_revision_and_identity',
      );
      assert(
        coldOriginalCarrier?.resultAcceptance?.sourceId === originalSourceId &&
          coldMail?.id === mail!.id,
        'cold_original_carrier_Source_and_mail_identity',
      );
      const sessionsAfter = await Promise.all(
        ['root', east!.agentId, west!.agentId].map((sessionId) => coldStore.getSession(sessionId)),
      );
      assert(
        coldProviderCalls === 0 &&
          options.requests().length === liveRequestsBeforeCold &&
          (await coldStore.getMetadata()).lastChangeCursor === cursorBefore &&
          isDeepStrictEqual(sessionsAfter, sessionsBefore),
        'cold_zero_Provider_cursor_and_owner_unchanged',
      );
      status = 'passed';
    } catch (error) {
      status =
        error instanceof Boundary && error.kind === 'oracle_violation' ? 'failed' : 'inconclusive';
      reason =
        error instanceof Boundary
          ? error.kind
          : signal.aborted
            ? 'budget_or_abort'
            : 'execution_unavailable';
      failurePoint =
        error instanceof Boundary
          ? error.point
          : signal.aborted
            ? 'overall_budget_or_abort'
            : 'execution_unavailable';
    } finally {
      if (runtime && store) {
        try {
          canonicalEvidence = await saveLiveCanonicalModelEvidence({
            runtime,
            store,
            requests: options.requests().slice(start),
            root,
            subjectId: 'live-compaction-owner',
          });
          canonicalEvidenceRetained = true;
          checks.completeCanonicalModelEvidence = object(canonicalEvidence).complete === true;
          if (status === 'passed' && !checks.completeCanonicalModelEvidence) {
            status = 'failed';
            reason = 'oracle_violation';
            failurePoint = 'complete_canonical_model_evidence_not_retained';
          }
        } catch (error) {
          evidenceErrors.push(error instanceof Error ? error.message : String(error));
          if (status === 'passed') {
            status = 'failed';
            reason = 'oracle_violation';
            failurePoint = 'canonical_model_evidence_capture_failed';
          }
        }
      }
      // Each owned resource gets its independent close attempt. Keep an earlier
      // business/fixture failure intact; cleanup errors remain separate facts.
      let runtimeClosed = false;
      if (runtime) {
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch (error) {
          cleanupErrors.push({
            resource: 'runtime',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (files) {
        try {
          await files.close();
        } catch (error) {
          cleanupErrors.push({
            resource: 'files',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (store && !runtimeClosed) {
        try {
          await store.close();
        } catch (error) {
          cleanupErrors.push({
            resource: 'fallbackStore',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      checks.resourcesClosed = cleanupErrors.length === 0;
      if (!checks.resourcesClosed && status === 'passed') {
        status = 'failed';
        reason = 'cleanup_failed';
        failurePoint = 'resources_close';
      }
      // Observer traces and original counted requests supplement the standard
      // inspector array; no directory lookup is involved in evidence discovery.
      writeFileSync(
        join(root, 'compaction-observer-trace.json'),
        `${JSON.stringify({ observedRequests: options.requests().slice(start), tokenEvents, toolEvents }, null, 2)}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        join(root, 'observer-evidence.json'),
        `${JSON.stringify({ id, status, reason, failurePoint, checks, canonicalEvidence, canonicalEvidenceRetained, evidenceErrors, cleanupErrors }, null, 2)}\n`,
        { mode: 0o600 },
      );
      abort.abort();
    }
    cases.push({
      id,
      status,
      reason,
      failurePoint,
      checks,
      adapterAttempts: options.requests().length - start,
      canonicalEvidenceRetained,
      cleanupErrors,
      coverage: [
        'actual standard token-triggered parent and child Core summarization publication',
        'two unnamed stable identities, full original assignment/mail/Source, fresh same-child Files continuation',
        'cold Store and runtime reads zero Provider and zero persisted mutation',
      ],
      gaps: [
        'owned-allow fixture only; explicit 24000-token policy, not default 75-percent window qualification',
        'high-sequence variant seeds empty Store numeric origin; does not claim high-volume soak',
        'full semantic audit still required on retained actual summaries and business outputs',
      ],
    });
  }
  return { cases };
}
