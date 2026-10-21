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
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension, Json, OperationRef, ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

export const liveMailAdoptionCaseIds = [
  'R11-idle-child-dual-upper-late-confirm-late-send-old-explicit-Run',
  'R11-idle-child-dual-upper-receive-rollback-two-idempotent-consumers',
] as const;
type CaseId = (typeof liveMailAdoptionCaseIds)[number];
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const success = (value: unknown) => ({
  outcome: 'succeeded' as const,
  content: JSON.stringify(value),
});
const schema = { type: 'object', additionalProperties: false, properties: {} };
const object = (value: unknown): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
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
/** Owns only live.mail-adoption refs. Never borrows the public task extension namespace. */
export async function runLiveMailAdoption(options: Options): Promise<{ cases: Result[] }> {
  const selected = liveMailAdoptionCaseIds.filter(
    (id) => !options.caseIds || options.caseIds.includes(id),
  );
  if (selected.length > 1 && options.evidenceRoot)
    throw Error('mail_adoption_one_case_per_retained_root');
  const cases: Result[] = [];
  for (const id of selected) cases.push(await sample(id, options));
  return { cases };
}
async function sample(id: CaseId, options: Options): Promise<Result> {
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('mail_adoption_invalid_evidence_root');
  options.signal.throwIfAborted();
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
    options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-mail-adoption-')),
  );
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const nonce = randomUUID();
  const facts = [1, 2, 3].map((n) => `actual-round-${n}-${randomUUID()}-🪁`);
  facts.forEach((fact, i) => {
    writeFileSync(join(workspace, `round${i + 1}.txt`), `${fact}\r\n`, { mode: 0o600 });
  });
  const earlyHead = `EARLY_HEAD_${nonce}`,
    earlyMiddle = `EARLY_MIDDLE_${nonce}`,
    earlyTail = `EARLY_TAIL_${nonce}`;
  const earlyBody = `${earlyHead}\n${'完整私有邮件🙂'.repeat(350)}\n${earlyMiddle}\n${'尾段🪁'.repeat(350)}\n${earlyTail}`;
  const lateConfirmBody = `LATE_CONFIRM_${nonce}`,
    lateSendBody = `LATE_SEND_${nonce}`,
    hardBody = `EXPLICIT_OLD_RUN_${nonce}`;
  const read1 = gate(),
    read2 = gate(),
    entered1 = gate(),
    entered2 = gate();
  const checks: Result['checks'] = {},
    stages: Record<string, unknown> = {};
  const firstRequest = options.requests().length;
  const streams = new Map<string, { finish: boolean; eof: boolean }>();
  const fileTrace: unknown[] = [],
    canonical: unknown[] = [];
  const calls = new Map<string, number>();
  const parentToolOrder = ['create_original', 'queue_early', 'seal_followup', 'later_followup'];
  let parentRunId: string | undefined;
  let originalStable: unknown;
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function wait(promise: Promise<unknown>) {
    options.signal.throwIfAborted();
    let abort!: () => void;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(Error('mail_adoption_aborted'));
          options.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let files: ReturnType<typeof createWorkspaceFiles> | undefined;
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let old!: OperationRef, second!: OperationRef, third!: OperationRef;
  let originalRun = '',
    selection = '',
    early = '',
    lateConfirm = '',
    lateSend = '',
    hard = '';
  let childRead1Run = '',
    childRead2Run = '',
    rollbackHit = false;
  let modelEvidenceRetained = false;
  try {
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    store = await openSqliteStore(profile);
    const owned = store,
      expectedStoreId = (await owned.getMetadata()).storeId;
    assert(
      Buffer.byteLength(earlyBody) > 4096,
      'early_private_body_exceeds_4KiB_without_summary_substitution',
    );
    const dbFile = join(profile.dataRoot, profile.profile, 'core.db');
    const raw = (mailId: string) => {
      const db = new Database(dbFile, { readonly: true, strict: true });
      try {
        return db
          .query<Record<string, string | number | null>, [string]>(
            `SELECT c.id,c.request_json,c.origin_store_id,c.subject_id,c.root_work_command_id,CAST(c.root_work_seq AS TEXT) AS root_work_seq,c.agent_source_execution_id,CAST(c.rowid AS TEXT) AS mail_seq,c.mail_target_run_id,c.mail_received_run_id,c.mail_received_message_id,c.mail_confirmed,e.state AS source_state,CAST(e.completed_cursor AS TEXT) AS source_completed_cursor FROM command c JOIN execution e ON e.id=c.agent_source_execution_id WHERE c.id=?`,
          )
          .get(mailId)!;
      } finally {
        db.close();
      }
    };
    const seal = (ref: OperationRef) => {
      const db = new Database(dbFile, { readonly: true, strict: true });
      try {
        return db
          .query<Record<string, string | null>, [string]>(
            'SELECT c.id,c.origin_store_id,c.subject_id,c.root_work_command_id,CAST(c.root_work_seq AS TEXT) AS root_work_seq,CAST(c.mail_adoption_upper_seq AS TEXT) AS upper_seq,CAST(c.mail_adoption_cursor AS TEXT) AS cursor,c.agent_carrier_execution_id,c.input_context_selection_id,e.predecessor_execution_id FROM command c JOIN execution e ON e.id=c.agent_carrier_execution_id WHERE c.id=?',
          )
          .get(`child-start-${ref.executionId}`)!;
      } finally {
        db.close();
      }
    };
    const mail = (messageId: string) =>
      owned.getAgentMessage({
        expectedStoreId,
        subjectId: 'owner',
        sessionId: old.childSessionId!,
        messageId,
      });
    const receiveOriginal = owned.receiveAgentMessages.bind(owned);
    if (id === liveMailAdoptionCaseIds[1]) {
      owned.receiveAgentMessages = async (input) => {
        if (
          !rollbackHit &&
          early &&
          input.messageIds.includes(early) &&
          input.runId !== originalRun
        ) {
          rollbackHit = true;
          const cursor = (await owned.getMetadata()).lastChangeCursor;
          const db = new Database(dbFile, { strict: true });
          assert(/^[A-Za-z0-9_-]+$/.test(early), 'exact_SQL_fault_id_safe');
          let failed = false;
          try {
            db.exec(
              `CREATE TRIGGER live_mail_exact_receive_fault BEFORE INSERT ON message WHEN NEW.id='agent-mail-${early}' BEGIN SELECT RAISE(ABORT,'isolated live receive rollback'); END`,
            );
            try {
              await receiveOriginal(input);
            } catch {
              failed = true;
            }
            assert(
              failed &&
                (await mail(early))!.receivedMessageId === null &&
                (await owned.getMetadata()).lastChangeCursor === cursor,
              'exact_receive_transaction_failure_rolls_back_mail_and_cursor',
            );
          } finally {
            db.exec('DROP TRIGGER IF EXISTS live_mail_exact_receive_fault');
            db.close();
          }
          const committed = await receiveOriginal(input);
          const after = (await owned.getMetadata()).lastChangeCursor;
          const consumers = await Promise.all([receiveOriginal(input), receiveOriginal(input)]);
          assert(
            consumers.every((value) => isDeepStrictEqual(value, committed)) &&
              (await owned.getMetadata()).lastChangeCursor === after,
            'two_real_consumers_return_original_committed_ack_without_duplicate_write',
          );
          stages.receive = {
            input: structuredClone(input),
            committed,
            consumers,
            rollbackCursor: cursor,
            committedCursor: after,
          };
          return committed;
        }
        return receiveOriginal(input);
      };
    }
    files = createWorkspaceFiles({ root: workspace });
    const fileTools: ToolDefinition[] = createFileTools(files)
      .filter((tool) => tool.id === 'files.read')
      .map((tool) => ({
        ...tool,
        async execute(input, ctx) {
          assert(ctx.sessionId !== 'root', 'root_only_owned_Operations_no_child_Files_work');
          const path = files!.relativePath(String(object(input).path));
          if (path === 'round1.txt' && !childRead1Run) {
            childRead1Run = ctx.runId!;
            entered1.release();
            await wait(read1.promise);
          }
          if (path === 'round2.txt' && !childRead2Run) {
            childRead2Run = ctx.runId!;
            entered2.release();
            await wait(read2.promise);
          }
          const result = await tool.execute(input, ctx);
          fileTrace.push({
            toolId: tool.id,
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            executionId: ctx.executionId,
            input,
            result,
          });
          return result;
        },
      }));
    const childPrompt = (n: number) =>
      `Real work round ${n}. Call Files read for round${n}.txt exactly once, use its actual bytes, then final answer quote the actual file fact verbatim. Do not edit files, start agents, or invent tools. ${n === 2 ? 'Also quote EARLY_HEAD, EARLY_MIDDLE and EARLY_TAIL facts from the complete current private inbox mail; late confirmation/send and EXPLICIT_OLD_RUN mail must not be invented.' : n === 3 ? 'Also quote LATE_CONFIRM and LATE_SEND facts from the newly delivered private inbox mail. Do not claim EXPLICIT_OLD_RUN was delivered.' : 'Finish truthfully after reading.'}`;
    const tool = (
      name: string,
      description: string,
      execute: ToolDefinition['execute'],
    ): ToolDefinition => ({
      id: `live.mail-adoption.${name}`,
      version: '1',
      description,
      inputSchema: schema,
      model: { name },
      async execute(input, ctx) {
        const current = await owned.getExecution(ctx.executionId);
        branch(current?.runId, 'owned_parent_Tool_missing_actual_Run');
        parentRunId ??= current!.runId!;
        const view = await owned.getView('root');
        const actualModel = view.executions.find(
          (row) =>
            row.kind === 'model' &&
            row.status === 'succeeded' &&
            row.stepId === current!.stepId &&
            Array.isArray(object(row.result).toolCalls) &&
            (object(row.result).toolCalls as Json[]).some(
              (call) => object(call).id === current!.callId,
            ),
        );
        branch(
          actualModel && (object(actualModel.result).toolCalls as Json[]).length === 1,
          'one_actual_Model_Tool_call_per_parent_step_required',
        );
        branch(
          ctx.sessionId === 'root' &&
            current!.runId === parentRunId &&
            current!.rootWorkCommandId === 'work',
          'all_owned_parent_Tools_same_original_Run_and_work',
        );
        branch(name === parentToolOrder[calls.size], 'actual_Model_Tool_order_not_reached');
        calls.set(name, (calls.get(name) ?? 0) + 1);
        branch(calls.get(name) === 1, `${name}_repeated_Model_tool_call`);
        return execute(input, ctx);
      },
    });
    const waitOperation = async (
      ctx: Parameters<ToolDefinition['execute']>[1],
      ref: OperationRef,
    ) => {
      const deadline = Date.now() + 150000;
      for (;;) {
        try {
          return await ctx.operations.wait(ref, { timeoutMs: 30000, signal: options.signal });
        } catch (error) {
          if ((error as { code?: string }).code !== 'wait_timeout' || Date.now() >= deadline)
            throw error;
        }
      }
    };
    const tools = [
      tool(
        'create_original',
        'Create the original real child, wait its actual first file work and completion. Call once before queue_early.',
        async (_input, ctx) => {
          old = await ctx.operations.ensure({
            key: 'original',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: childPrompt(1) },
            },
            cancellation: 'detached',
          });
          await wait(entered1.promise);
          const target = await ctx.operations.readAgent(old);
          branch(target.run?.id === childRead1Run, 'original_live_child_Run_not_reached');
          originalRun = target.run!.id;
          selection = target.contextSelectionId;
          const receipt = await ctx.operations.sendAgentMessage!(old, {
            key: 'hard-old-run',
            content: hardBody,
            contextSelectionId: selection,
            targetRunId: originalRun,
          });
          hard = receipt.commandId;
          assert(
            (await mail(hard))!.state === 'pending_sender',
            'explicit_old_Run_mail_is_real_pending_sender',
          );
          read1.release();
          await waitOperation(ctx, old);
          const complete = await ctx.operations.readAgent(old);
          branch(
            complete.run?.status === 'completed' && !complete.run.isActive,
            'original_child_not_completed',
          );
          stages.original = { old, complete, hardBeforeSenderTerminal: raw(hard) };
          return success(old);
        },
      ),
      tool(
        'queue_early',
        'After create_original returns, queue the complete early private mail to the idle child. Call exactly once, wait for its real Tool result, then call seal_followup in the next Model step of this same parent Run.',
        async (_input, ctx) => {
          branch(old && originalRun, 'queue_before_original');
          const target = await ctx.operations.readAgentMessageTarget!(old);
          assert(target.targetRunId === null, 'early_mail_target_is_idle_null');
          early = (
            await ctx.operations.sendAgentMessage!(old, {
              key: 'early',
              content: earlyBody,
              contextSelectionId: target.contextSelectionId,
            })
          ).commandId;
          assert(
            (await mail(early))!.state === 'pending_sender',
            'early_pending_until_genuine_sender_Tool_terminal',
          );
          return success({
            messageId: early,
            utf8Bytes: Buffer.byteLength(earlyBody),
            sha256: hash(earlyBody),
          });
        },
      ),
      tool(
        'seal_followup',
        'After queue_early truly returned, create one genuine child follow_up and exercise same invocation retry. Call only this Tool in its Model step; after it returns call later_followup in the next step of this same parent Run.',
        async (_input, ctx) => {
          branch((await mail(early))?.state === 'accepted', 'early_mail_not_confirmed_before_seal');
          originalStable = {
            run: await owned.getRun(originalRun),
            carrier: await owned.getExecution(old.executionId!),
          };
          lateConfirm = (
            await ctx.operations.sendAgentMessage!(old, {
              key: 'late-confirm',
              content: lateConfirmBody,
              contextSelectionId: selection,
            })
          ).commandId;
          const pending = raw(lateConfirm);
          assert(
            pending.source_state === 'dispatching' &&
              !pending.mail_confirmed &&
              pending.source_completed_cursor === null,
            'sealing_sender_really_unsettled',
          );
          const input = {
            mode: 'follow_up' as const,
            key: 'second',
            afterRunId: originalRun,
            contextSelectionId: selection,
            content: childPrompt(2),
          };
          const first = await ctx.operations.sendAgentInput(old, input);
          second = (first.receipt as unknown as { ref: OperationRef }).ref;
          await wait(entered2.promise);
          const frozen = seal(second);
          branch(frozen.upper_seq !== null && frozen.cursor !== null, 'dual_uppers_not_sealed');
          assert(
            frozen.predecessor_execution_id === old.executionId &&
              frozen.input_context_selection_id === selection &&
              frozen.origin_store_id === expectedStoreId &&
              frozen.subject_id === 'owner',
            'actual_seal_has_exact_original_predecessor_selection_store_subject',
          );
          lateSend = (
            await ctx.operations.sendAgentMessage!(old, {
              key: 'late-send',
              content: lateSendBody,
              contextSelectionId: selection,
            })
          ).commandId;
          const before = (await owned.getMetadata()).lastChangeCursor;
          const replay = await ctx.operations.sendAgentInput(old, input);
          assert(
            isDeepStrictEqual(first, replay),
            'formal_same_invocation_same_key_receipt_unchanged',
          );
          assert(
            (await owned.getMetadata()).lastChangeCursor === before &&
              isDeepStrictEqual(seal(second), frozen),
            'replay_no_write_and_both_sealed_uppers_immutable',
          );
          stages.seal = {
            input,
            first,
            replay,
            frozen,
            before,
            pendingLateConfirm: pending,
            early: raw(early),
            lateSend: raw(lateSend),
            sourceExecutionId: ctx.executionId,
          };
          return success(second);
        },
      ),
      tool(
        'later_followup',
        'After seal_followup truly returned, wait for the actual second child round to finish, then create a NEW legal follow_up using the exact original ref, old completed predecessor and current selection. Wait real third child completion.',
        async (_input, ctx) => {
          branch(second, 'later_followup_before_real_second_carrier');
          await waitOperation(ctx, second);
          branch(
            (await ctx.operations.readAgent(second)).run?.status === 'completed',
            'round_two_not_complete',
          );
          const receipt = await ctx.operations.sendAgentInput(old, {
            mode: 'follow_up',
            key: 'third',
            afterRunId: originalRun,
            contextSelectionId: selection,
            content: childPrompt(3),
          });
          third = (receipt.receipt as unknown as { ref: OperationRef }).ref;
          await waitOperation(ctx, third);
          const target = await ctx.operations.readAgent(third);
          branch(
            target.run?.status === 'completed' && !target.run.isActive,
            'round_three_not_complete',
          );
          stages.later = { receipt, target, frozen: seal(third) };
          return success(third);
        },
      ),
    ];
    const extension: Extension = {
      id: 'live.mail-adoption',
      version: '1',
      apiMajor: 1,
      tools: [...tools, ...fileTools],
    };
    const model: ModelAdapter = {
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
        return { allowed: true as const, revision: 'owned-live-mail-adoption-v1' };
      },
    };
    runtime = createRuntime({
      store: owned,
      artifacts: createArtifactStore({ profile, store: owned }),
      model,
      modelId: options.modelId,
      modelConcurrency: 3,
      extensions: [extension],
      permissions,
      afterTurn: permissions,
      resolveRunConfiguration: async () => ({
        model,
        modelId: options.modelId,
        toolIds: [...tools, ...fileTools].map((entry) => entry.id),
        snapshot: { kind: 'owned-live-mail-adoption', version: 1 },
        permissions,
        afterTurn: permissions,
      }),
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: fileTools.map((entry) => entry.id),
          snapshot: { kind: 'owned-live-mail-adoption-child', version: 1 },
        },
      ],
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private live mail adoption',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: id,
    });
    // One genuine ordinary parent Run; all four calls come from the real Model.
    // No second run.start/human interpretation or forged work/selection transition.
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: {
        kind: 'run.start',
        content:
          'Complete this single ordinary work Run using exactly these four Tools in order: create_original, queue_early, seal_followup, later_followup. Call each exactly once and one Tool per Model step. Wait for each genuine Tool result before deciding and calling the next Tool in a later step. queue_early genuinely confirms an early mail on Tool completion; seal_followup creates the second child round and returns while actual Files IO may remain pending; later_followup itself waits for that second round and then creates/waits the third round. Finish only after later_followup returns. Do not call Files yourself, add other Tools, batch calls together, ask for human input or create new parent work. Report only actual receipts, preserving pending/completed distinctions and no hidden facts.',
      },
    });
    const sealDeadline = Date.now() + 150000;
    for (;;) {
      options.signal.throwIfAborted();
      const sealExecutionId = String(object(stages.seal).sourceExecutionId ?? '');
      const sealExecution = sealExecutionId ? await owned.getExecution(sealExecutionId) : null;
      if (
        sealExecution?.status === 'succeeded' &&
        lateConfirm &&
        lateSend &&
        (await mail(lateConfirm))?.state === 'accepted' &&
        (await mail(lateSend))?.state === 'accepted'
      )
        break;
      const parent = await owned.getView('root');
      branch(
        !parent.runs.some((run) => !run.isActive),
        'parent_ended_before_real_seal_Tool_confirmation',
      );
      if (Date.now() >= sealDeadline)
        throw new Boundary(
          'branch_not_reached',
          'real_seal_Tool_success_and_late_confirmation_not_reached',
        );
      await Bun.sleep(20);
    }
    branch(second && lateConfirm && lateSend && childRead2Run, 'seal_followup_branch_not_reached');
    assert(
      early && (await mail(early))!.receivedRunId === childRead2Run,
      'genuine_early_confirmation_adopted_before_host_releases_child_two_IO',
    );
    assert(
      parentRunId && (await owned.getRun(parentRunId))?.isActive,
      'original_parent_Run_remains_active_for_ordered_four_Tools',
    );
    const frozen = seal(second),
      a = raw(early),
      b = raw(lateConfirm),
      c = raw(lateSend);
    assert(
      BigInt(a.mail_seq!) <= BigInt(frozen.upper_seq!) &&
        BigInt(a.source_completed_cursor!) <= BigInt(frozen.cursor!),
      'early_fits_both_immutable_uppers',
    );
    assert(
      BigInt(b.mail_seq!) <= BigInt(frozen.upper_seq!) &&
        BigInt(b.source_completed_cursor!) > BigInt(frozen.cursor!),
      'late_confirmation_excluded_by_cursor_despite_lower_sequence',
    );
    assert(BigInt(c.mail_seq!) > BigInt(frozen.upper_seq!), 'late_send_excluded_by_sequence_upper');
    assert(
      (await mail(early))!.receivedRunId === childRead2Run &&
        (await mail(lateConfirm))!.receivedRunId === null &&
        (await mail(lateSend))!.receivedRunId === null &&
        (await mail(hard))!.receivedRunId === null,
      'round_two_exact_adoption_and_exclusions',
    );
    stages.afterSealToolConfirmation = {
      frozen,
      parentRunId,
      sealExecution: await owned.getExecution(String(object(stages.seal).sourceExecutionId)),
      early: a,
      lateConfirm: b,
      lateSend: c,
      explicitOldRun: raw(hard),
    };
    read2.release();
    await runtime.waitForCommand('work', { timeoutMs: 150000, signal: options.signal });
    const parentFinal = await owned.getView('root');
    branch(
      parentFinal.runs.length === 1 &&
        parentFinal.runs[0]!.id === parentRunId &&
        parentFinal.runs[0]!.status === 'completed' &&
        !parentFinal.runs[0]!.isActive,
      'one_original_parent_Run_completed_after_four_real_Tools',
    );
    assert(
      parentToolOrder.every((name) => calls.get(name) === 1) && calls.size === 4,
      'four_ordered_real_Model_Tools_once_in_single_parent_Run',
    );
    branch(
      (await owned.getView(old.childSessionId!)).runs.some(
        (run) => run.id === childRead2Run && run.status === 'completed',
      ),
      'round_two_complete_not_reached',
    );
    branch(third, 'later_legal_followup_not_reached');
    assert(
      isDeepStrictEqual(originalStable, {
        run: await owned.getRun(originalRun),
        carrier: await owned.getExecution(old.executionId!),
      }),
      'original_completed_Run_carrier_metadata_and_result_unchanged',
    );
    const child = await owned.getView(old.childSessionId!);
    const thirdRun = child.runs.find(
      (run) => run.originCommandId === `child-start-${third.executionId}`,
    )!;
    const finalSeal = seal(third);
    assert(
      finalSeal.predecessor_execution_id === old.executionId &&
        finalSeal.input_context_selection_id === selection &&
        finalSeal.origin_store_id === expectedStoreId,
      'later_legal_seal_still_exact_original_predecessor_selection_store',
    );
    assert(
      child.runs.length === 3 &&
        thirdRun?.status === 'completed' &&
        (await mail(lateConfirm))!.receivedRunId === thirdRun.id &&
        (await mail(lateSend))!.receivedRunId === thirdRun.id,
      'new_legal_original_predecessor_seal_adopts_both_late_mails_once',
    );
    assert(
      (await mail(hard))!.targetRunId === originalRun &&
        (await mail(hard))!.receivedRunId === null &&
        (await mail(early))!.receivedRunId === childRead2Run,
      'old_explicit_Run_never_retargeted_and_early_not_readopted',
    );
    stages.final = {
      child,
      root: await owned.getView('root'),
      original: old,
      second,
      third,
      early: await mail(early),
      lateConfirm: await mail(lateConfirm),
      lateSend: await mail(lateSend),
      explicitOldRun: await mail(hard),
      finalSeal: seal(second),
    };
    assert(
      isDeepStrictEqual(seal(second), frozen),
      'old_sealed_dual_upper_still_immutable_after_new_legal_round',
    );
    let earlyPrepared = false,
      latePrepared = false;
    for (const view of [await owned.getView('root'), child])
      for (const row of view.executions.filter((entry) => entry.kind === 'model')) {
        const actual = options.requests().find((request) => request.requestId === row.id);
        if (!actual) {
          branch(row.status !== 'succeeded', 'canonical_Model_has_no_actual_counted_request');
          continue;
        }
        const scope = {
          expectedStoreId,
          subjectId: 'owner',
          sessionId: row.sessionId,
          executionId: row.id,
        };
        const input = await runtime.readModelInput(scope);
        const visible = structuredClone(actual!);
        for (const message of visible.messages)
          delete (message as { continuation?: unknown }).continuation;
        assert(
          isDeepStrictEqual(input.request, visible),
          `actual_Model_input_equals_counted_request_${hash(row.id).slice(0, 12)}`,
        );
        if (row.status === 'succeeded') {
          const output = await runtime.readModelOutput({ ...scope, signal: options.signal });
          assert(
            output.output.complete && streams.get(row.id)?.finish && streams.get(row.id)?.eof,
            `complete_actual_Model_inspector_and_EOF_${hash(row.id).slice(0, 12)}`,
          );
          canonical.push({ scope, input, output });
        }
        if (row.sessionId !== old.childSessionId) continue;
        const sources = (mailId: string) =>
          input.request.messages.filter((message) => message.sourceIds?.includes(mailId));
        const contains = (content: string, body: string) =>
          content.includes(body) || content.includes(JSON.stringify(body).slice(1, -1));
        assert(sources(hard).length === 0, 'old_explicit_Run_never_prepared_for_new_Model');
        if (row.runId === childRead2Run) {
          assert(
            sources(lateConfirm).length === 0 && sources(lateSend).length === 0,
            'no_late_mail_Source_in_actual_round_two_Model',
          );
          assert(
            sources(early).length === 1 && contains(sources(early)[0]!.content, earlyBody),
            'complete_over_4KiB_early_mail_once_per_actual_round_two_input',
          );
          earlyPrepared = true;
        }
        if (row.runId === thirdRun.id) {
          assert(
            sources(lateConfirm).length === 1 &&
              sources(lateSend).length === 1 &&
              contains(sources(lateConfirm)[0]!.content, lateConfirmBody) &&
              contains(sources(lateSend)[0]!.content, lateSendBody),
            'both_full_late_mails_once_per_actual_round_three_input',
          );
          latePrepared = true;
        }
      }
    assert(
      earlyPrepared && latePrepared,
      'complete_original_mail_Sources_reach_exact_new_actual_Model_inputs',
    );
    for (let n = 1; n <= 3; n++) {
      const run = n === 1 ? originalRun : n === 2 ? childRead2Run : thirdRun.id;
      const finals = canonical
        .map(
          (value) =>
            value as { scope: { executionId: string }; output: { output: { content: string } } },
        )
        .filter((entry) =>
          child.executions.some((row) => row.id === entry.scope.executionId && row.runId === run),
        );
      if (n === 2)
        assert(
          finals.some((entry) =>
            [earlyHead, earlyMiddle, earlyTail].every((fact) =>
              entry.output.output.content.includes(fact),
            ),
          ),
          'complete_real_round_two_output_uses_all_three_early_body_facts',
        );
      if (n === 3)
        assert(
          finals.some((entry) =>
            [lateConfirmBody, lateSendBody].every((fact) =>
              entry.output.output.content.includes(fact),
            ),
          ),
          'complete_real_round_three_output_uses_both_new_late_facts',
        );
      assert(
        finals.some((entry) => entry.output.output.content.includes(facts[n - 1]!)),
        `actual_round_${n}_file_fact_in_complete_real_child_output`,
      );
    }
    if (id === liveMailAdoptionCaseIds[1])
      assert(rollbackHit, 'actual_new_Run_receive_fault_and_consumers_branch_hit');
    facts.forEach((fact, i) => {
      assert(
        readFileSync(join(workspace, `round${i + 1}.txt`), 'utf8') === `${fact}\r\n`,
        `round_${i + 1}_original_file_bytes_unchanged`,
      );
    });
    status = 'passed';
  } catch (error) {
    status =
      error instanceof Boundary && error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    reason = error instanceof Boundary ? error.reason : 'execution_unavailable';
    failurePoint = error instanceof Boundary ? error.point : String(error);
  } finally {
    read1.release();
    read2.release();
    // Keep original failed and in-flight executions/inputs as well as complete outputs.
    // Capture failure never turns a missing original inspector into synthetic evidence.
    writeFileSync(
      join(root, 'canonical-model-evidence.json'),
      `${JSON.stringify(canonical, null, 2)}\n`,
      { mode: 0o600 },
    );
    modelEvidenceRetained = canonical.length > 0;
    if (store && runtime) {
      try {
        const retained = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          root,
          subjectId: 'owner',
          requests: options.requests().slice(firstRequest),
        });
        stages.canonicalModelEvidence = retained;
        modelEvidenceRetained = retained.models > 0;
      } catch (error) {
        stages.partialEvidenceError = String(error);
      }
    }
    const cleanupErrors: string[] = [];
    let runtimeClosed = false;
    try {
      await runtime?.close();
      runtimeClosed = Boolean(runtime);
    } catch (error) {
      cleanupErrors.push(`runtime: ${String(error)}`);
    }
    try {
      await files?.close();
    } catch (error) {
      cleanupErrors.push(`files: ${String(error)}`);
    }
    if (!runtimeClosed) {
      try {
        await store?.close();
      } catch (error) {
        cleanupErrors.push(`store: ${String(error)}`);
      }
    }
    checks.resourcesClosed = cleanupErrors.length === 0;
    if (cleanupErrors.length) {
      stages.cleanupErrors = cleanupErrors;
      if (status === 'passed') {
        status = 'failed';
        reason = 'cleanup_failed';
        failurePoint = 'resources_close';
      }
    }
    writeFileSync(
      join(root, 'evidence.json'),
      `${JSON.stringify({ version: 1, id, nonce, facts, bodies: { earlyBody, lateConfirmBody, lateSendBody, hardBody }, checks, calls: Object.fromEntries(calls), fileTrace, stages, streams: Object.fromEntries(streams), canonicalEvidencePath: join(root, 'canonical-model-evidence.json'), status, reason, failurePoint }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return {
    id,
    status,
    checks,
    coverage: [
      'R11/17 trusted Operations exact idle-child dual sequence/cursor sealing',
      'real late-confirm and late-send exclusion; formal same-invocation same-key replay',
      'later explicit original-predecessor legal follow_up; old explicit Run stays fixed',
      ...(id === liveMailAdoptionCaseIds[1]
        ? ['isolated exact receive transaction rollback and two real idempotent consumers']
        : []),
    ],
    adapterAttempts: options.requests().length - firstRequest,
    canonicalEvidenceRetained: modelEvidenceRetained,
    semanticReviewRequired: true,
    ...(reason ? { reason } : {}),
    ...(failurePoint ? { failurePoint } : {}),
  };
}
