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
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = ['I13-running-cross-work-reuse', 'I13-queued-cross-work-reuse'] as const;
export type LiveWorkScopeCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveWorkScopeCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  coverage: string[];
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type EnsureInput = Parameters<Store['ensureOperation']>[0];
type Ref = Awaited<ReturnType<Store['ensureOperation']>>;
type ControlInput = Parameters<Store['applyAgentCommand']>[0];
type ControlResult = Awaited<ReturnType<Store['applyAgentCommand']>>;
type Attempt = {
  kind: 'follow_up' | 'message' | 'interrupt';
  executionId: string;
  errorCode: string | null;
  returned: boolean;
};
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
        abort = () => reject(Error('live_work_scope_aborted'));
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
/** Private owned-material fixture. No default-policy qualification or top-level execution. */
export async function runLiveWorkScope(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_work_scope_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-work-scope-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const queued = id === 'I13-queued-cross-work-reuse';
    const count = queued ? 4 : 2;
    const targetSlot = queued ? 4 : 1;
    const facts = Array.from({ length: count }, (_, n) => `A-slot-${n + 1}-${randomUUID()}`);
    const bFact = `B-material-${randomUUID()}`;
    const validB = `B-valid-requirement-${randomUUID()}`;
    const forbidden = {
      follow_up: `forbidden-B-guidance-${randomUUID()}`,
      message: `forbidden-B-mail-${randomUUID()}`,
    };
    for (const [n, fact] of facts.entries())
      writeFileSync(join(workspace, `A-${n + 1}.txt`), `actual_A_fact=${fact}\n`, { mode: 0o600 });
    writeFileSync(join(workspace, 'B.txt'), `actual_B_fact=${bFact}\n`, { mode: 0o600 });
    const reusePrompt = `New independent B assignment ${validB}: use read_scope_material once with phase B and slot ${targetSlot}. Report its complete actual B fact and this requirement marker. Keep your saved history but do not repeat the old A read, delegate, send messages, or use control tools.`;
    const aGates = Array.from({ length: count }, gate);
    const bGate = gate(),
      firstThreeReady = gate();
    const spawns: { input: EnsureInput; ref: Ref }[] = [];
    const attempts: Attempt[] = [];
    const reads: {
      sessionId: string;
      runId: string;
      executionId: string;
      slot: number;
      phase: 'A' | 'B';
      aborted: boolean;
      delivered: boolean;
    }[] = [];
    let reuse: { input: ControlInput; result: ControlResult } | undefined;
    let queuedUnselectedDispatchDeferrals = 0;
    let queuedContinueAIssued = false;
    let idlePhase = false,
      adapterStarts = 0,
      spawnCalls = 0,
      bChildModelStarts = 0;
    let bFirstModelHasValidGuidance = false,
      bFirstModelHasSavedAFact = false,
      targetModelsHaveForbiddenInput = false;
    const checks: Result['checks'] = {};
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let retained = false;
    const firstRequest = options.requests().length;
    let store: Store | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    const assert = (condition: unknown, point: string) => {
      checks[point] = Boolean(condition);
      if (!condition) throw new Boundary('oracle_violation', point);
    };
    const branch = (condition: unknown, point: string) => {
      if (!condition) throw new Boundary('branch_not_reached', point);
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
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      function scopeSnapshot(target: string, carrier: string) {
        const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return database
            .query(
              'SELECT id, session_id, kind, request_json, receipt_json FROM command WHERE session_id=? OR mail_target_session_id=? OR agent_carrier_execution_id=? ORDER BY id',
            )
            .all(target, target, carrier);
        } finally {
          database.close();
        }
      }
      function physicalModelCount(sessionId: string) {
        const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return Number(
            (
              database
                .query(
                  "SELECT COUNT(*) AS n FROM execution WHERE session_id=? AND kind='model' AND dispatched=1",
                )
                .get(sessionId) as { n: number }
            ).n,
          );
        } finally {
          database.close();
        }
      }
      function bScopeUncancelled(runId: string) {
        const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          const run = database.query('SELECT cancel_requested FROM run WHERE id=?').get(runId) as {
            cancel_requested: number;
          } | null;
          const cancelled = database
            .query(
              "SELECT COUNT(*) AS n FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id='root' AND r.root_work_command_id='B' AND r.cancel_requested!=0",
            )
            .get() as { n: number };
          return run?.cancel_requested === 0 && Number(cancelled.n) === 0;
        } finally {
          database.close();
        }
      }
      const originalMarkDispatching = owned.markDispatching.bind(owned);
      owned.markDispatching = async (input) => {
        try {
          return await originalMarkDispatching(input);
        } catch (error) {
          if (
            queued &&
            !queuedContinueAIssued &&
            input.executionId === spawns[targetSlot - 1]?.ref.executionId &&
            object(error).code === 'work_not_selected'
          )
            queuedUnselectedDispatchDeferrals++;
          throw error;
        }
      };
      async function rootCheckpoint(point: string) {
        const view = await owned.getView('root');
        assert(view.runs.filter((run) => run.isActive).length <= 1, point);
        return view;
      }
      async function rootIdle(point: string) {
        return until(async () => {
          const view = await rootCheckpoint(`${point}_at_most_one_active_root`);
          return view.runs.length > 0 && view.runs.every((run) => !run.isActive) ? view : undefined;
        }, point);
      }
      async function continueOriginal(work: 'A' | 'B', commandId: string, content: string) {
        await client!.startRun(
          'root',
          { expectedStoreId, commandId, kind: 'run.start', content },
          { signal },
        );
        const decision = await until(async () => {
          const raw = await owned.getCommand(commandId);
          const decisionId = object(raw?.receipt).decisionCommandId;
          if (typeof decisionId !== 'string') return undefined;
          const saved = await owned.getCommand(decisionId);
          return saved?.status === 'applied' ? saved : undefined;
        }, `formal_continue_${work}_not_applied`);
        const proposal = object(object(decision.request).proposal);
        assert(
          proposal.purpose === 'continue' &&
            proposal.targetRootWorkCommandId === work &&
            (
              await owned.readHumanWorkState({
                expectedStoreId,
                sessionId: 'root',
                subjectId: 'live-work-scope-owner',
              })
            ).selectedWork?.rootWorkCommandId === work,
          `formal_continue_${work}_selects_exact_original_work`,
        );
        await rootCheckpoint(`formal_continue_${work}_safe_root_handoff`);
      }
      const ensure = owned.ensureOperation.bind(owned);
      owned.ensureOperation = async (input) => {
        const sender = await owned.getExecution(input.parentExecutionId);
        if (
          input.sessionId !== 'root' ||
          sender?.rootWorkCommandId !== 'A' ||
          !input.collaborationCompletion
        )
          return ensure(input);
        const index = spawnCalls++;
        if (queued && index === 3) await wait(firstThreeReady.promise, signal);
        const ref = await ensure(input);
        spawns[index] = { input: structuredClone(input), ref: structuredClone(ref) };
        return ref;
      };
      const apply = owned.applyAgentCommand.bind(owned);
      owned.applyAgentCommand = async (input) => {
        const target = spawns[targetSlot - 1]?.ref.childSessionId;
        const sender = await owned.getExecution(input.parentExecutionId);
        if (!target || input.agentId !== target || sender?.rootWorkCommandId !== 'B')
          return apply(input);
        try {
          const result = await apply(input);
          if (idlePhase && input.kind === 'follow_up' && result.receipt.mode === 'new_turn') {
            assert(!reuse, 'only_one_idle_B_reuse_command');
            reuse = { input: structuredClone(input), result: structuredClone(result) };
          } else
            attempts.push({
              kind: input.kind,
              executionId: input.parentExecutionId,
              errorCode: null,
              returned: true,
            });
          return result;
        } catch (error) {
          attempts.push({
            kind: input.kind,
            executionId: input.parentExecutionId,
            errorCode: String(object(error).code ?? ''),
            returned: false,
          });
          throw error;
        }
      };
      const queueMail = owned.queueAgentMessage.bind(owned);
      owned.queueAgentMessage = async (input) => {
        const target = spawns[targetSlot - 1]?.ref.childSessionId;
        const sender = await owned.getExecution(input.sourceExecutionId);
        if (!target || input.stableTarget !== target || sender?.rootWorkCommandId !== 'B')
          return queueMail(input);
        try {
          const result = await queueMail(input);
          attempts.push({
            kind: 'message',
            executionId: input.sourceExecutionId,
            errorCode: null,
            returned: true,
          });
          return result;
        } catch (error) {
          attempts.push({
            kind: 'message',
            executionId: input.sourceExecutionId,
            errorCode: String(object(error).code ?? ''),
            returned: false,
          });
          throw error;
        }
      };
      const reader: ToolDefinition = {
        id: 'live.work-scope-material',
        version: '1',
        model: { name: 'read_scope_material' },
        description:
          'Read the complete actual owned material for your assigned phase and slot. A pending read must not be cancelled, replaced or guessed.',
        inputSchema: {
          type: 'object',
          properties: {
            phase: { type: 'string', enum: ['A', 'B'] },
            slot: { type: 'integer', minimum: 1, maximum: count },
          },
          required: ['phase', 'slot'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { phase, slot } = object(input);
          if (
            context.sessionId === 'root' ||
            !context.runId ||
            (phase !== 'A' && phase !== 'B') ||
            typeof slot !== 'number' ||
            !Number.isInteger(slot) ||
            slot < 1 ||
            slot > count
          )
            return {
              outcome: 'failed',
              content: 'Only the exact assigned collaborator may read its owned material.',
            };
          const assignment = spawns[slot - 1];
          const run = await owned.getRun(context.runId);
          if (
            assignment?.ref.childSessionId !== context.sessionId ||
            run?.rootWorkCommandId !== phase ||
            (phase === 'B' && slot !== targetSlot)
          )
            return {
              outcome: 'failed',
              content: 'Material does not match the exact current work and assignment.',
            };
          const read: (typeof reads)[number] = {
            sessionId: context.sessionId,
            runId: context.runId,
            executionId: context.executionId,
            slot,
            phase,
            aborted: false,
            delivered: false,
          };
          reads.push(read);
          if (
            queued &&
            new Set(reads.filter((r) => r.phase === 'A' && r.slot <= 3).map((r) => r.slot)).size ===
              3
          )
            firstThreeReady.release();
          try {
            await wait(
              phase === 'A' ? aGates[slot - 1]!.promise : bGate.promise,
              AbortSignal.any([signal, context.signal]),
            );
          } catch (error) {
            if (context.signal.aborted && !read.delivered) {
              read.aborted = true;
              return {
                outcome: 'cancelled',
                content: 'Owned material read cancelled before reading.',
              };
            }
            throw error;
          }
          if (context.signal.aborted) {
            read.aborted = true;
            return {
              outcome: 'cancelled',
              content: 'Owned material read cancelled before reading.',
            };
          }
          const content = readFileSync(
            join(workspace, phase === 'A' ? `A-${slot}.txt` : 'B.txt'),
            'utf8',
          );
          read.delivered = true;
          return { outcome: 'succeeded', content };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          if (adapterStarts++ >= 40)
            throw new Boundary('branch_not_reached', 'hard_40_adapter_attempt_limit');
          await rootCheckpoint('all_actual_model_checkpoints_at_most_one_active_root');
          const execution = await owned.getExecution(request.requestId);
          if (execution?.sessionId === spawns[targetSlot - 1]?.ref.childSessionId) {
            const text = request.messages.map((message) => message.content).join('\n');
            if (execution?.rootWorkCommandId === 'B' && bChildModelStarts++ === 0) {
              bFirstModelHasValidGuidance = text.includes(validB);
              bFirstModelHasSavedAFact = text.includes(facts[targetSlot - 1]!);
            }
            if (Object.values(forbidden).some((marker) => text.includes(marker)))
              targetModelsHaveForbiddenInput = true;
          }
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
        extensions: [
          { id: 'live.work-scope-fixture', version: '1', apiMajor: 1, tools: [reader] },
          createTaskExtension({
            roles: [
              {
                id: 'worker',
                configurationId: 'worker',
                description: 'Finite owned material collaborator.',
              },
            ],
          }),
        ],
        permissions: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-work-scope-only-not-default-policy',
          }),
        },
        afterTurn: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-work-scope-only-not-default-policy',
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
        buildId: 'live-work-scope',
        subjectId: 'live-work-scope-owner',
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
        name: 'Owned cross-work case',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Live cross-work case',
      });
      const start = (commandId: string, content: string) =>
        client!.startRun(
          'root',
          { expectedStoreId, commandId, kind: 'run.start', content },
          { signal },
        );
      const assignments = Array.from(
        { length: count },
        (_, n) =>
          `Collaborator ${n + 1}: read_scope_material phase A slot ${n + 1} exactly once; preserve the complete actual fact in your final result. Do not delegate, send, control or reread.`,
      );
      await start(
        'A',
        `New task: Delegate exactly ${count} collaborators, in the order below, using spawn_agent with prompt only and no preset. ${assignments.map((x, n) => `${n + 1}. ${x}`).join(' ')} Do not wait for their completion. Once all ${count} spawn receipts are returned, briefly acknowledge accepted assignments and finish your current parent turn normally. The operator will later provide an independent work request. Do not read yourself, cancel, follow up, message, poll or invent results.`,
      );
      await until(async () => {
        const view = await owned.getView('root');
        return spawns.length === count &&
          view.runs.some((run) => run.rootWorkCommandId === 'A' && run.status === 'completed') &&
          view.runs.every((run) => !run.isActive)
          ? true
          : undefined;
      }, 'A_parent_not_normally_completed_after_actual_spawns');
      const originalARootRun = (await owned.getView('root')).runs.find(
        (run) => run.rootWorkCommandId === 'A',
      )!;
      const target = spawns[targetSlot - 1]!;
      const targetId = target.ref.childSessionId!;
      const originalCarrier = await owned.getExecution(target.ref.executionId!);
      branch(originalCarrier, 'original_target_carrier_missing');
      const originalCommand = await owned.getCommand(target.ref.commandId);
      const originalSession = await owned.getSession(targetId);
      const originalQueuedStart = queued
        ? structuredClone(await owned.getCommand(`child-start-${originalCarrier!.id}`))
        : null;
      const originals = await Promise.all(
        spawns.map((spawn) => owned.getExecution(spawn.ref.executionId!)),
      );
      await until(async () => {
        const ready = reads.filter(
          (read) => read.phase === 'A' && (queued ? read.slot <= 3 : true),
        );
        return ready.length === (queued ? 3 : 2) ? true : undefined;
      }, 'A_original_material_tools_not_held');
      const targetView = await owned.getView(targetId);
      assert(
        spawns.length === count &&
          originals.every((carrier) => carrier?.rootWorkCommandId === 'A') &&
          reads.every((read) => !read.delivered && !read.aborted),
        'exact_original_A_assignments_and_held_real_tools',
      );
      if (queued) {
        const startRequest = object(originalQueuedStart?.request);
        const startReceipt = object(originalQueuedStart?.receipt);
        assert(
          originalQueuedStart?.id === `child-start-${originalCarrier!.id}` &&
            originalQueuedStart.kind === 'child.start' &&
            originalQueuedStart.status === 'accepted' &&
            originalQueuedStart.sessionId === targetId &&
            originalQueuedStart.originStoreId === expectedStoreId &&
            originalQueuedStart.subjectId === originalCommand?.subjectId &&
            originalQueuedStart.rootWorkCommandId === originalCarrier!.rootWorkCommandId &&
            originalQueuedStart.rootWorkSeq === originalCarrier!.rootWorkSeq &&
            originalQueuedStart.cancelRequestedAt === null &&
            startRequest.kind === 'child.start' &&
            startRequest.parentExecutionId === originalCarrier!.id &&
            startRequest.configurationId === originalCarrier!.childConfiguration?.id &&
            startRequest.configurationVersion === originalCarrier!.childConfiguration?.version &&
            isDeepStrictEqual(startRequest.input, target.input.request.input) &&
            startReceipt.sessionId === targetId &&
            startReceipt.executionId === originalCarrier!.id &&
            !Object.hasOwn(startReceipt, 'runId'),
          'original_queued_child_start_is_exact_accepted_command_with_receipt_but_no_activated_run',
        );
        assert(
          targetView.runs.length === 0 &&
            physicalModelCount(targetId) === 0 &&
            !reads.some((read) => read.slot === targetSlot),
          'default_three_slots_leave_exact_fourth_queued_without_model_or_run',
        );
      } else
        assert(
          targetView.runs.length === 1 &&
            targetView.runs[0]!.isActive &&
            reads.some((read) => read.slot === targetSlot && read.runId === targetView.runs[0]!.id),
          'exact_target_A_run_active_with_dispatched_tool',
        );
      const targetScopeBeforeB = scopeSnapshot(targetId, originalCarrier!.id);
      await start(
        'B',
        `New task: Independent B is an authorized synthetic API boundary check. Reuse target agent_id ${targetId} only after it truly becomes idle. First, while its original A work is still ${queued ? 'queued' : 'running'}, ATTEMPT each of these supported tools exactly once with this exact ID: follow_up_agent content ${forbidden.follow_up}; send_agent_message content ${forbidden.message}; interrupt_agent. Scope refusal is an expected real outcome; do not bypass, retry or substitute a tool. Do not spawn anyone or control another collaborator. ${queued ? 'After the three actual results, briefly report their actual refusals and finish this parent B turn normally. Do not poll or wait for A, and do not attempt idle reuse yet. The operator will explicitly continue original B later.' : `After the three actual results, use list_agents and finite wait_agent_events to observe until this original target is actually idle with a terminal original carrier. Then follow_up_agent exactly once on the SAME ID with content ${reusePrompt}. Wait for its new B work to actually complete, obtain its actual result, and report the verified B fact.`} Do not resume A, alter permission, cancel B, answer on the user's behalf, or fabricate facts.`,
      );
      await until(async () => {
        if (attempts.length < 3) return undefined;
        const tools = await Promise.all(
          attempts.map((attempt) => owned.getExecution(attempt.executionId)),
        );
        return tools.every(
          (tool) =>
            tool && ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(tool.status),
        )
          ? true
          : undefined;
      }, 'model_did_not_attempt_all_three_actual_cross_work_tools');
      assert(
        attempts.length === 3 &&
          ['follow_up', 'message', 'interrupt'].every(
            (kind) => attempts.filter((attempt) => attempt.kind === kind).length === 1,
          ),
        'exactly_one_real_attempt_of_each_cross_work_tool',
      );
      for (const attempt of attempts) {
        const expectedInternal =
          attempt.kind === 'follow_up' ? 'input_target_changed' : 'permission_denied';
        const tool = await owned.getExecution(attempt.executionId);
        let body: Record<string, unknown> = {};
        try {
          body = object(JSON.parse(String(object(tool?.result).content)));
        } catch {
          /* Oracle below rejects a missing real public refusal. */
        }
        assert(
          !attempt.returned &&
            attempt.errorCode === expectedInternal &&
            tool?.rootWorkCommandId === 'B' &&
            tool.authorization?.dispatched === true &&
            tool.status === 'failed' &&
            body.accepted === false &&
            object(body.error).code ===
              (attempt.kind === 'follow_up' ? 'target_changed' : 'permission_denied'),
          `actual_${attempt.kind}_reaches_store_scope_check_and_public_refusal`,
        );
      }
      assert(
        isDeepStrictEqual(scopeSnapshot(targetId, originalCarrier!.id), targetScopeBeforeB),
        'refusals_add_no_target_input_mail_or_control_command',
      );
      assert(
        (await owned.getExecution(originalCarrier!.id))?.cancelRequestedAt === null &&
          reads.every((read) => !read.aborted && !read.delivered),
        'refusals_do_not_cancel_or_advance_original_A_tools',
      );
      assert(
        (await owned.listExecutions('root')).filter((e) => e.childSessionId === targetId).length ===
          1 && (await owned.getView(targetId)).runs.length === targetView.runs.length,
        'refusals_add_no_target_carrier_or_run',
      );
      assert(
        (
          await owned.readHumanWorkState({
            expectedStoreId,
            sessionId: 'root',
            subjectId: 'live-work-scope-owner',
          })
        ).selectedWork?.rootWorkCommandId === 'B',
        'independent_B_selected_without_rebinding_A',
      );
      let originalBRootRun = (await owned.getView('root')).runs.find(
        (run) => run.rootWorkCommandId === 'B',
      );
      if (queued) {
        await rootIdle('initial_B_finishes_after_three_real_refusals');
        originalBRootRun = (await owned.getView('root')).runs.find(
          (run) => run.rootWorkCommandId === 'B',
        );
        aGates[0]!.release();
        await until(async () => {
          const holder = await owned.getExecution(spawns[0]!.ref.executionId!);
          const pendingTarget = await owned.getExecution(originalCarrier!.id);
          assert(
            pendingTarget &&
              !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                pendingTarget.status,
              ),
            'unselected_original_queued_T_not_failed_or_terminal_after_slot_release',
          );
          assert(
            (await owned.getView(targetId)).runs.length === 0 &&
              physicalModelCount(targetId) === 0 &&
              !reads.some((read) => read.slot === targetSlot),
            'unselected_original_queued_T_never_activates_after_slot_release',
          );
          return holder?.status === 'succeeded' && queuedUnselectedDispatchDeferrals > 0
            ? true
            : undefined;
        }, 'freed_slot_did_not_reach_real_unselected_A_dispatch_gate');
        const deferredCarrier = await owned.getExecution(originalCarrier!.id);
        const deferredView = await owned.getView(targetId);
        const deferredStart = await owned.getCommand(originalQueuedStart!.id);
        assert(
          isDeepStrictEqual(deferredStart, originalQueuedStart) &&
            deferredStart?.status === 'accepted' &&
            deferredStart.cancelRequestedAt === null &&
            !Object.hasOwn(object(deferredStart.receipt), 'runId'),
          'freed_slot_preserves_same_original_accepted_child_start_request_receipt_identity_without_activation_or_settlement',
        );
        assert(
          deferredCarrier?.status === 'planned' &&
            deferredCarrier.authorization?.dispatched !== true &&
            deferredCarrier.cancelRequestedAt === null &&
            isDeepStrictEqual(deferredCarrier.reference, originalCarrier!.reference) &&
            deferredView.runs.length === 0 &&
            physicalModelCount(targetId) === 0 &&
            isDeepStrictEqual(deferredStart, originalQueuedStart) &&
            !reads.some((read) => read.slot === targetSlot) &&
            (
              await owned.readHumanWorkState({
                expectedStoreId,
                sessionId: 'root',
                subjectId: 'live-work-scope-owner',
              })
            ).selectedWork?.rootWorkCommandId === 'B',
          'freed_slot_keeps_original_A_T_queued_unfailed_without_run_model_or_deadline_while_B_selected',
        );
        assert(
          isDeepStrictEqual(
            deferredCarrier?.childConfiguration,
            originalCarrier!.childConfiguration,
          ) &&
            deferredCarrier?.rootWorkCommandId === 'A' &&
            deferredCarrier.rootWorkSeq === originalCarrier!.rootWorkSeq &&
            isDeepStrictEqual(scopeSnapshot(targetId, originalCarrier!.id), targetScopeBeforeB),
          'real_unselected_dispatch_deferral_preserves_original_T_assignment_and_configuration',
        );
        checks.realUnselectedQueuedDispatchDeferrals = queuedUnselectedDispatchDeferrals;
        queuedContinueAIssued = true;
        await continueOriginal(
          'A',
          'continue-original-A',
          'Continue A. Preserve the original A assignments, configuration, and exact existing collaborators. Let the already queued original collaborator activate and finish its one original read. Briefly acknowledge only actual existing results and finish this parent turn normally, leaving the other original A reads pending.',
        );
        const activated = await until(async () => {
          const read = reads.find((read) => read.phase === 'A' && read.sessionId === targetId);
          if (!read) return undefined;
          const run = await owned.getRun(read.runId);
          return run?.isActive ? { read, run } : undefined;
        }, 'original_queued_T_not_activated_after_exact_human_continue_A');
        const activatedStart = await owned.getCommand(originalQueuedStart!.id);
        assert(
          activatedStart?.status === 'applied' &&
            activatedStart.id === originalQueuedStart!.id &&
            activatedStart.seq === originalQueuedStart!.seq &&
            activatedStart.sessionId === originalQueuedStart!.sessionId &&
            activatedStart.subjectId === originalQueuedStart!.subjectId &&
            activatedStart.originStoreId === originalQueuedStart!.originStoreId &&
            activatedStart.rootWorkCommandId === originalQueuedStart!.rootWorkCommandId &&
            activatedStart.rootWorkSeq === originalQueuedStart!.rootWorkSeq &&
            activatedStart.requestDigest === originalQueuedStart!.requestDigest &&
            isDeepStrictEqual(activatedStart.request, originalQueuedStart!.request) &&
            object(activatedStart.receipt).runId === activated.run.id &&
            object(activatedStart.receipt).executionId === originalCarrier!.id &&
            object(activatedStart.receipt).childSessionId === targetId,
          'formal_continue_A_activates_same_original_accepted_child_start_into_exact_original_A_run',
        );
        assert(
          activated.run.rootWorkCommandId === 'A' &&
            activated.run.originStoreId === expectedStoreId &&
            activated.run.originCommandId === `child-start-${originalCarrier!.id}` &&
            activated.run.deadlineAt !== null &&
            activated.run.deadlineAt - activated.run.createdAt === 1_800_000 &&
            (await owned.getView(targetId)).runs.length === 1 &&
            (await owned.getExecution(originalCarrier!.id))?.rootWorkCommandId === 'A',
          'only_explicit_continue_A_activates_original_T_with_fresh_original_A_run_deadline',
        );
      }
      idlePhase = true;
      aGates[targetSlot - 1]!.release();
      const oldCompleted = await until(async () => {
        const carrier = await owned.getExecution(originalCarrier!.id);
        return carrier?.status === 'succeeded' ? carrier : undefined;
      }, 'original_target_A_did_not_truly_finish_before_idle_reuse');
      assert(
        String(object(oldCompleted.result).content ?? '').includes(facts[targetSlot - 1]!) &&
          reads.filter((read) => read.phase === 'A' && read.sessionId === targetId).length === 1,
        'original_target_A_actual_result_preserves_its_material',
      );
      if (queued) {
        await rootIdle('continued_A_parent_reaches_safe_idle_after_T_result');
        assert(
          (await owned.getView('root')).runs
            .filter((run) => run.rootWorkCommandId === 'A')
            .every((run) => isDeepStrictEqual(run.configuration, originalARootRun.configuration)),
          'continue_A_preserves_original_root_run_configuration',
        );
        await continueOriginal(
          'B',
          'continue-original-B',
          `Continue B. Continue the original B boundary task after its three completed cross-work scope refusals. Target collaborator ${targetId} has now completed its original A carrier and is truly idle. Preserve original B causality and configuration. Call follow_up_agent exactly once for that same agent_id with this exact new B instruction: ${reusePrompt}. Wait for this new B round's actual result using finite wait_agent_events and report its exact B fact and requirement marker. The remaining original A reads stay pending.`,
        );
      }
      await until(
        async () =>
          reuse && reads.some((read) => read.phase === 'B' && read.sessionId === targetId)
            ? true
            : undefined,
        'real_model_did_not_reuse_same_idle_child_for_B',
      );
      branch(reuse, 'idle_reuse_receipt_missing');
      const bRead = reads.find((read) => read.phase === 'B' && read.sessionId === targetId)!;
      const newCarrier = await owned.getExecution(reuse!.result.receipt.ref.executionId!);
      const newRun = await owned.getRun(bRead.runId);
      assert(
        reuse!.result.receipt.mode === 'new_turn' &&
          reuse!.result.receipt.agentId === targetId &&
          newCarrier?.id !== originalCarrier!.id &&
          newCarrier?.childSessionId === targetId &&
          newCarrier.rootWorkCommandId === 'B' &&
          newRun?.rootWorkCommandId === 'B' &&
          newRun.isActive,
        'idle_reuse_creates_unique_exact_B_carrier_and_run_in_same_session',
      );
      assert(
        isDeepStrictEqual(newCarrier!.childConfiguration, originalCarrier!.childConfiguration) &&
          bFirstModelHasValidGuidance &&
          bFirstModelHasSavedAFact &&
          !targetModelsHaveForbiddenInput,
        'idle_reuse_preserves_configuration_and_excludes_rejected_A_injections',
      );
      assert(
        (await owned.getView(targetId)).runs.length === 2 &&
          (await owned.listExecutions('root')).filter((e) => e.childSessionId === targetId)
            .length === 2,
        'only_one_new_B_child_round',
      );
      const sentinels = spawns.filter((_, index) =>
        queued ? index === 1 || index === 2 : index === 1,
      );
      assert(
        (
          await Promise.all(sentinels.map((spawn) => owned.getExecution(spawn.ref.executionId!)))
        ).every(
          (carrier) =>
            carrier &&
            !carrier.cancelRequestedAt &&
            ['planned', 'dispatching', 'running'].includes(carrier.status),
        ),
        'real_A_sentinels_still_active_before_human_A_stop',
      );
      await start('stop-A', '停止 A。');
      const stopDecision = await until(async () => {
        const publicCommand = await owned.getCommand('stop-A');
        const decisionId = object(publicCommand?.receipt).decisionCommandId;
        if (typeof decisionId !== 'string') return undefined;
        const decision = await owned.getCommand(decisionId);
        return decision?.status === 'applied' ? decision : undefined;
      }, 'formal_human_stop_A_not_applied');
      const proposal = object(object(stopDecision.request).proposal);
      assert(
        proposal.purpose === 'stop' &&
          proposal.targetRootWorkCommandId === 'A' &&
          Array.isArray(object(stopDecision.receipt).controlCommandIds) &&
          (object(stopDecision.receipt).controlCommandIds as unknown[]).length > 0,
        'real_human_decision_stops_exact_original_A_scope',
      );
      await until(
        async () =>
          (
            await Promise.all(sentinels.map((spawn) => owned.getExecution(spawn.ref.executionId!)))
          ).every((carrier) => carrier?.status === 'cancelled')
            ? true
            : undefined,
        'human_A_stop_did_not_settle_real_A_sentinels',
      );
      const survivingB = await owned.getExecution(newCarrier!.id);
      const survivingBRun = await owned.getRun(newRun!.id);
      assert(
        survivingB?.cancelRequestedAt === null &&
          bScopeUncancelled(newRun!.id) &&
          survivingBRun?.isActive &&
          !bRead.aborted &&
          !bRead.delivered,
        'human_stop_A_does_not_cancel_new_B_child_work',
      );
      assert(
        (
          await owned.readHumanWorkState({
            expectedStoreId,
            sessionId: 'root',
            subjectId: 'live-work-scope-owner',
          })
        ).selectedWork?.rootWorkCommandId === 'B',
        'human_stop_A_preserves_selected_B',
      );
      bGate.release();
      const completedB = await until(async () => {
        const e = await owned.getExecution(newCarrier!.id);
        return e?.status === 'succeeded' && e.resultAcceptance?.runId ? e : undefined;
      }, 'B_original_carrier_result_not_accepted');
      const acceptance = completedB.resultAcceptance!;
      const acceptedRun = await owned.getRun(acceptance.runId!);
      assert(
        completedB.rootWorkCommandId === 'B' &&
          acceptance.resultRevision === completedB.resultRevision &&
          acceptedRun?.rootWorkCommandId === 'B' &&
          acceptedRun.contextSelectionId === acceptance.selectionId &&
          String(object(completedB.result).content ?? '').includes(bFact) &&
          String(object(completedB.result).content ?? '').includes(validB),
        'new_B_result_has_exact_fact_revision_and_B_acceptance',
      );
      await until(async () => {
        for (const request of options.requests().slice(firstRequest)) {
          const e = await owned.getExecution(request.requestId);
          if (e?.sessionId !== 'root' || e.runId !== acceptance.runId || e.status !== 'succeeded')
            continue;
          const messages = request.messages.filter((message) =>
            message.sourceIds?.includes(acceptance.sourceId),
          );
          if (!messages.length) continue;
          assert(
            messages.reduce(
              (n, message) =>
                n +
                (message.sourceIds?.filter((sourceId) => sourceId === acceptance.sourceId).length ??
                  0),
              0,
            ) === 1 &&
              messages.some(
                (message) => message.content.includes(bFact) && message.content.includes(validB),
              ),
            'exact_B_source_once_in_actual_accepted_B_parent_model',
          );
          return true;
        }
        return undefined;
      }, 'B_source_not_prepared_into_actual_B_parent_model');
      await until(async () => {
        const view = await owned.getView('root');
        return view.runs.some((run) => run.id === acceptance.runId && run.status === 'completed') &&
          view.runs.every((run) => !run.isActive) &&
          !view.executions.some((e) => ['planned', 'dispatching', 'running'].includes(e.status))
          ? true
          : undefined;
      }, 'parent_not_normally_settled_after_B_source_delivery');
      for (const attempt of attempts) {
        const tool = await owned.getExecution(attempt.executionId);
        let prepared = false;
        for (const request of options.requests().slice(firstRequest)) {
          const execution = await owned.getExecution(request.requestId);
          if (
            execution?.sessionId !== 'root' ||
            execution.rootWorkCommandId !== 'B' ||
            execution.status !== 'succeeded'
          )
            continue;
          prepared ||= request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.toolCallId === tool?.callId &&
              message.content.includes(String(object(tool?.result).content)),
          );
        }
        assert(prepared, `actual_B_model_processed_exact_${attempt.kind}_public_refusal`);
      }
      const oldFinal = await owned.getExecution(originalCarrier!.id);
      const sessionFinal = await owned.getSession(targetId);
      assert(
        isDeepStrictEqual(
          (await owned.getCommand(target.ref.commandId))?.request,
          originalCommand?.request,
        ) &&
          oldFinal?.status === 'succeeded' &&
          oldFinal.rootWorkCommandId === 'A' &&
          oldFinal.rootWorkSeq === originalCarrier!.rootWorkSeq &&
          oldFinal.parentExecutionId === originalCarrier!.parentExecutionId &&
          isDeepStrictEqual(oldFinal.result, oldCompleted.result) &&
          oldFinal.resultRevision === oldCompleted.resultRevision &&
          (!oldFinal.resultAcceptance ||
            (await owned.getRun(oldFinal.resultAcceptance.runId!))?.rootWorkCommandId === 'A') &&
          sessionFinal?.parentSessionId === originalSession?.parentSessionId &&
          sessionFinal?.rootSessionId === originalSession?.rootSessionId &&
          sessionFinal?.workspaceId === originalSession?.workspaceId &&
          (await owned.getCommand(target.ref.commandId))?.requestDigest ===
            originalCommand?.requestDigest &&
          (await owned.getCommand(target.ref.commandId))?.rootWorkCommandId ===
            originalCommand?.rootWorkCommandId &&
          bScopeUncancelled(newRun!.id),
        'original_A_assignment_lineage_result_and_session_identity_not_rewritten',
      );
      assert(
        attempts.length === 3 &&
          reads.filter((read) => read.phase === 'B').length === 1 &&
          bRead.delivered &&
          !bRead.aborted &&
          !targetModelsHaveForbiddenInput &&
          (await owned.getView(targetId)).runs.length === 2 &&
          (await owned.listExecutions('root')).filter((e) => e.childSessionId).length === count + 1,
        'no_hidden_repeat_injection_replacement_or_extra_B_round',
      );
      const finalRoot = await rootCheckpoint('final_at_most_one_active_root');
      assert(
        finalRoot.runs
          .filter((run) => run.rootWorkCommandId === 'B')
          .every(
            (run) =>
              originalBRootRun &&
              isDeepStrictEqual(run.configuration, originalBRootRun.configuration),
          ),
        'continued_B_preserves_original_B_root_configuration',
      );
      if (oldFinal?.resultAcceptance) {
        const oldAcceptance = oldFinal.resultAcceptance;
        const acceptingRun = await owned.getRun(oldAcceptance.runId!);
        assert(
          acceptingRun?.rootWorkCommandId === 'A' &&
            oldAcceptance.resultRevision === oldFinal.resultRevision &&
            oldAcceptance.selectionId === acceptingRun.contextSelectionId,
          'legitimate_old_A_result_acceptance_is_exact_original_A_revision_and_selection',
        );
        for (const request of options.requests().slice(firstRequest)) {
          await rootCheckpoint('all_actual_model_checkpoints_at_most_one_active_root');
          const execution = await owned.getExecution(request.requestId);
          if (execution?.sessionId === 'root' && execution.rootWorkCommandId === 'B')
            assert(
              request.messages.every(
                (message) => !message.sourceIds?.includes(oldAcceptance.sourceId),
              ),
              'old_A_source_never_rebound_into_B_parent_model',
            );
        }
      }
      assert(adapterStarts <= 40, 'counted_adapter_attempts_within_original_limit');
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
      const failed = Object.entries(checks).find(([, value]) => value === false);
      if (failed) {
        status = 'failed';
        reason = 'oracle_violation';
        failurePoint = failed[0];
      }
    } finally {
      for (const pending of aGates) pending.release();
      bGate.release();
      firstThreeReady.release();
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
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: retained,
      coverage: [
        'three_real_cross_work_tool_attempts_reach_store_scope_checks',
        queued
          ? 'default_three_slots_original_fourth_deferred_during_B_then_explicit_A_activation_and_explicit_B_reuse'
          : 'actual_running_original_target_tool',
        'same_idle_child_session_new_exact_B_carrier',
        'human_exact_A_stop_cancels_active_A_sentinels_without_B',
        'exact_B_accepted_source_in_actual_B_parent_model',
        'owned_allow_fixture_not_default_policy',
        'no_I12_untrusted_report_or_A08_R1_R2_qualification',
      ],
    });
  }
  return { cases };
}
