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
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = [
  'R03-simultaneous-results',
  'R03-started-parent-second-result-and-B-deferred',
  'R03-dispatched-parent-second-result-and-B-deferred',
] as const;
export type LiveResultCoalescingCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveResultCoalescingCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
}
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
        abort = () => reject(Error('live_coalescing_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
/** Explicit owned allow fixture. Common owns the physical 40 HTTP / 600s budget. */
export async function runLiveResultCoalescing(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_coalescing_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-result-coalescing-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const slots = ['C1', 'C2', 'C3'] as const;
    type Slot = (typeof slots)[number];
    const materials = Object.fromEntries(
      slots.map((slot) => [slot, `verified-${slot}-${randomUUID()}\n`]),
    ) as Record<Slot, string>;
    for (const slot of slots)
      writeFileSync(join(workspace, `${slot}.txt`), materials[slot], { mode: 0o600 });
    const releases = Object.fromEntries(slots.map((slot) => [slot, gate()])) as Record<
      Slot,
      ReturnType<typeof gate>
    >;
    const reportRelease = gate();
    const firstProviderRelease = gate();
    const afterProvider = id === 'R03-dispatched-parent-second-result-and-B-deferred';
    let firstProviderHeld = false;
    let heldParentRequestId: string | undefined;
    let firstProviderObservedCursor: string | undefined;
    const checks: Result['checks'] = {};
    const stages: Record<string, unknown> = {};
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let retained = false,
      armed = false,
      beforeApplyHeld = false,
      startedApplyHeld = false;
    let automaticRunId: string | undefined;
    const reads = new Map<
      Slot,
      { sessionId: string; runId: string; executionId: string; count: number; completed: boolean }
    >();
    const actualParentRequests: {
      requestId: string;
      runId: string | null;
      rootWorkCommandId: string;
      sourceIds: string[];
      completeContents: string[];
      eof: boolean;
      finish: boolean;
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
        options.signal.throwIfAborted();
        const result = await read();
        if (result !== undefined) return result;
        if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((done) => setTimeout(done, 15)), options.signal);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const dbRead = <T>(read: (db: Database) => T) => {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return read(db);
        } finally {
          db.close();
        }
      };
      const originalApply = owned.applyJobReport.bind(owned);
      owned.applyJobReport = async (input) => {
        const command = await owned.getCommand(input.commandId);
        const original =
          command?.sessionId === 'root' &&
          command.kind === 'job.report' &&
          command.rootWorkCommandId === 'A';
        if (armed && original && id === 'R03-simultaneous-results' && !beforeApplyHeld) {
          beforeApplyHeld = true;
          stages.firstOriginalReportCall = {
            commandId: command.id,
            cursor: (await owned.getMetadata()).lastChangeCursor,
          };
          await wait(reportRelease.promise, options.signal);
        }
        const result = await originalApply(input);
        if (
          armed &&
          original &&
          result.started &&
          result.run &&
          id === 'R03-started-parent-second-result-and-B-deferred' &&
          !startedApplyHeld
        ) {
          automaticRunId = result.run.id;
          startedApplyHeld = true;
          stages.firstReportStartedOriginalRun = structuredClone(result);
          stages.firstReportStartedCursor = (await owned.getMetadata()).lastChangeCursor;
          const untouched = structuredClone(result);
          await wait(reportRelease.promise, options.signal);
          assert(isDeepStrictEqual(result, untouched), 'started_report_original_return_unmodified');
        }
        if (original && result.started && result.run) automaticRunId ??= result.run.id;
        return result;
      };
      const reader: ToolDefinition = {
        id: 'live.coalescing-read',
        version: '1',
        model: { name: 'read_coalescing_material' },
        description:
          'Read one complete owned finite material for your assigned slot. Exactly once; do not retry or cancel a pending read.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['slot'],
          properties: { slot: { type: 'string', enum: [...slots] } },
        },
        async execute(input, context) {
          const slot = object(input).slot as Slot;
          branch(
            slots.includes(slot) && context.sessionId !== 'root',
            'actual_child_read_slot_not_reached',
          );
          const before = reads.get(slot);
          if (before) {
            before.count++;
            throw new Boundary('oracle_violation', 'duplicate_child_material_read');
          }
          branch(context.runId, 'child_read_has_no_exact_run');
          const run = await owned.getRun(context.runId!);
          assert(
            run?.rootWorkCommandId === (slot === 'C3' ? 'B' : 'A'),
            `slot_original_work_${slot}`,
          );
          const content = readFileSync(join(workspace, `${slot}.txt`), 'utf8');
          assert(content === materials[slot], `actual_complete_material_${slot}`);
          const entry = {
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            count: 1,
            completed: false,
          };
          reads.set(slot, entry);
          await wait(releases[slot].promise, context.signal);
          context.signal.throwIfAborted();
          entry.completed = true;
          return { outcome: 'succeeded', content };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          const execution = await owned.getExecution(request.requestId);
          const entry =
            execution?.sessionId === 'root'
              ? {
                  requestId: request.requestId,
                  runId: execution.runId,
                  rootWorkCommandId: execution.rootWorkCommandId,
                  sourceIds: request.messages.flatMap((message) => message.sourceIds ?? []),
                  completeContents: request.messages.map((message) => message.content),
                  eof: false,
                  finish: false,
                }
              : undefined;
          if (entry) actualParentRequests.push(entry);
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([options.signal, context.signal]),
          })) {
            if (afterProvider && entry && entry.runId === automaticRunId && !firstProviderHeld) {
              const current = await owned.getExecution(request.requestId);
              const dispatch = dbRead((db) =>
                db
                  .query<{ cursor: number; dispatched: number }, [string]>(
                    "SELECT c.cursor,e.dispatched FROM change_event c JOIN execution e ON e.id=c.object_id WHERE c.object_id=? AND c.type='execution.dispatching' ORDER BY c.cursor",
                  )
                  .all(request.requestId),
              );
              assert(
                current?.kind === 'model' &&
                  dispatch[0]?.dispatched === 1 &&
                  current.runId === automaticRunId &&
                  current.rootWorkCommandId === 'A' &&
                  current.originStoreId === expectedStoreId &&
                  options.requests().some((actual) => actual.requestId === request.requestId) &&
                  dispatch.length === 1,
                'R_actual_counted_provider_first_event_after_exact_dispatch',
              );
              heldParentRequestId = request.requestId;
              firstProviderObservedCursor = (await owned.getMetadata()).lastChangeCursor;
              stages.firstActualRProviderEvent = {
                requestIdentitySha256: createHash('sha256').update(request.requestId).digest('hex'),
                runIdentitySha256: createHash('sha256').update(automaticRunId!).digest('hex'),
                dispatchCursor: String(dispatch[0]!.cursor),
                observedCursor: firstProviderObservedCursor,
                eventType: event.type,
              };
              firstProviderHeld = true;
              await wait(firstProviderRelease.promise, options.signal);
              assert(
                (await owned.getExecution(request.requestId))?.runId === automaticRunId,
                'held_original_provider_event_keeps_original_R',
              );
            }
            if (entry && event.type === 'finish') entry.finish = true;
            yield event;
          }
          if (entry) entry.eof = true;
        },
      };
      const permissions = {
        async authorize() {
          return { allowed: true as const, revision: 'owned-result-coalescing-only-1' };
        },
      };
      const task = createTaskExtension({
        roles: [
          { id: 'worker', configurationId: 'worker', description: 'Finite owned material reader.' },
        ],
      });
      const rootToolIds = [
        reader.id,
        ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      ];
      const rootBinding = (): RunConfiguration => ({
        model,
        modelId: options.modelId,
        toolIds: rootToolIds,
        snapshot: { kind: 'owned-result-coalescing-only', version: 1 },
        permissions,
        afterTurn: permissions,
      });
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        permissions,
        afterTurn: permissions,
        extensions: [{ id: 'live.coalescing', version: '1', apiMajor: 1, tools: [reader] }, task],
        resolveRunConfiguration: async () => rootBinding(),
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
            snapshot: { kind: 'owned-result-coalescing-child', version: 1 },
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
        buildId: 'live-result-coalescing',
        subjectId: 'live-coalescing-owner',
      });
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: { profile: serviceProfile, apiMajor: 1, requiredCapabilities: ['commands'] },
      });
      const live = client;
      await live.connect();
      await live.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned coalescing',
        rootUri: pathToFileURL(workspace).href,
      });
      await live.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        title: 'Result coalescing',
      });
      const assignment = (slot: Slot) =>
        `Use read_coalescing_material exactly once with slot ${slot}. Report the complete actual material verbatim and finish. Never delegate, send messages, follow up, interrupt, write files, retry or cancel pending work.`;
      const start = async (work: 'A' | 'B', assigned: readonly Slot[]) => {
        await live.startRun('root', {
          expectedStoreId,
          commandId: work,
          kind: 'run.start',
          content: `New task: ${work}. Make exactly ${assigned.length} independent spawn_agent calls. Each child gets one exact assignment: ${assigned.map((slot) => JSON.stringify(assignment(slot))).join('; ')}. Use only prompt and omit preset. Preserve the exact returned IDs. After the spawns finish your ordinary response immediately, stating results are pending. Do not wait, send, follow up, interrupt, read files yourself or spawn replacements. On later original result sources, report every complete actual verified fact available, then finish your ordinary response; do not start more work.`,
        });
      };
      const originalParent = async (work: 'A' | 'B') =>
        until(async () => {
          const view = await owned.getView('root');
          // Later public starts have a derived business command; rootWork retains the exact public work ID.
          const run = view.runs.find((item) => item.rootWorkCommandId === work);
          return run && !run.isActive ? run : undefined;
        }, `original_${work}_parent_not_terminal`);
      const childFor = async (slot: Slot) => {
        const read = reads.get(slot)!;
        const carrier = (await owned.listExecutions('root')).find(
          (row) => row.childSessionId === read.sessionId,
        );
        branch(carrier, `original_carrier_missing_${slot}`);
        return carrier!;
      };
      const durableReport = async (slot: Slot) =>
        until(async () => {
          const carrier = await childFor(slot);
          const commands = dbRead((db) =>
            db
              .query<{ id: string }, [string]>(
                "SELECT id FROM command WHERE kind='job.report' AND json_extract(request_json,'$.executionId')=? ORDER BY rowid",
              )
              .all(carrier.id),
          );
          if (!commands.length) return undefined;
          assert(
            commands.length === 1 && carrier.status === 'succeeded',
            `exact_one_durable_terminal_report_${slot}`,
          );
          const command = await owned.getCommand(commands[0]!.id);
          branch(command, `durable_report_command_not_readable_${slot}`);
          return {
            carrier,
            command: command!,
            cursor: (await owned.getMetadata()).lastChangeCursor,
          };
        }, `actual_complete_report_not_durable_${slot}`);
      let bInitial: Awaited<ReturnType<typeof originalParent>> | undefined;
      if (id === 'R03-started-parent-second-result-and-B-deferred' || afterProvider) {
        await start('B', ['C3']);
        await until(
          async () => (reads.has('C3') ? true : undefined),
          'B_original_child_not_reading',
        );
        bInitial = await originalParent('B');
        branch(bInitial.status === 'completed', 'B_original_parent_not_normally_completed');
      }
      await start('A', ['C1', 'C2']);
      await until(
        async () => (reads.has('C1') && reads.has('C2') ? true : undefined),
        'two_A_children_not_reading',
      );
      const aInitial = await originalParent('A');
      branch(aInitial.status === 'completed', 'A_original_parent_not_normally_completed');
      assert(
        (await owned.getView('root')).runs.every((run) => !run.isActive),
        'original_parents_completed_before_results',
      );
      assert(
        new Set([...reads.values()].map((read) => read.sessionId)).size === reads.size,
        'independent_original_child_sessions',
      );
      const childBaselines = await Promise.all(
        [...reads].map(async ([slot, read]) => ({
          slot,
          run: await owned.getRun(read.runId),
          carrier: await childFor(slot),
        })),
      );
      stages.originalBeforeRelease = { aInitial, bInitial, children: childBaselines };
      armed = true;
      releases.C1.release();
      if (id === 'R03-simultaneous-results') {
        releases.C2.release();
        await until(
          async () => (beforeApplyHeld ? true : undefined),
          'first_real_report_apply_not_held',
        );
        const reports = await Promise.all([durableReport('C1'), durableReport('C2')]);
        assert(
          reports.every(
            ({ carrier, command }) =>
              carrier.resultAcceptance === null && command.status === 'accepted',
          ),
          'both_reports_durable_and_unaccepted_before_first_original_apply',
        );
        assert(
          (await owned.getView('root')).runs.length === 1,
          'no_report_parent_started_before_both_durable_results',
        );
        stages.bothDurableBeforeFirstApply = reports;
      } else if (afterProvider) {
        await until(
          async () => (firstProviderHeld ? true : undefined),
          'first_actual_R_provider_event_not_reached',
        );
        const active = (await owned.getView('root')).runs.filter((run) => run.isActive);
        assert(
          active.length === 1 &&
            active[0]!.id === automaticRunId &&
            active[0]!.rootWorkCommandId === 'A' &&
            active[0]!.originCommandId === (await durableReport('C1')).command.id,
          'C1_report_started_exact_R_before_actual_provider_dispatch',
        );
        assert(
          (await childFor('C2')).status === 'running' &&
            (await childFor('C3')).status === 'running' &&
            !reads.get('C2')!.completed &&
            !reads.get('C3')!.completed,
          'C2_and_B_still_original_pending_reads_at_R_actual_provider_event',
        );
        releases.C2.release();
        releases.C3.release();
        const laterReports = await Promise.all([durableReport('C2'), durableReport('C3')]);
        assert(
          laterReports.every(
            ({ carrier, command }) =>
              carrier.resultAcceptance === null && command.status === 'accepted',
          ),
          'post_dispatch_reports_durable_pending_while_original_R_event_held',
        );
        for (const { carrier } of laterReports) {
          const terminal = dbRead((db) =>
            db
              .query<{ cursor: number }, [string]>(
                "SELECT cursor FROM change_event WHERE object_id=? AND type='execution.finished' ORDER BY cursor",
              )
              .all(carrier.id),
          );
          assert(
            terminal.length === 1 &&
              BigInt(terminal[0]!.cursor) > BigInt(firstProviderObservedCursor!),
            'later_original_child_terminal_after_real_R_provider_event_' +
              carrier.rootWorkCommandId,
          );
        }
        const held = await owned.getExecution(heldParentRequestId!);
        const heldDispatch = dbRead((db) =>
          db
            .query<{ dispatched: number }, [string]>('SELECT dispatched FROM execution WHERE id=?')
            .get(heldParentRequestId!),
        );
        assert(
          held &&
            heldDispatch?.dispatched === 1 &&
            held.runId === automaticRunId &&
            !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(held.status),
          'original_dispatched_R_model_still_unfinished_at_later_report_durability',
        );
        stages.postDispatchReportDurability = laterReports.map(({ carrier, command, cursor }) => ({
          carrierIdentitySha256: createHash('sha256').update(carrier.id).digest('hex'),
          reportIdentitySha256: createHash('sha256').update(command.id).digest('hex'),
          resultRevision: carrier.resultRevision,
          status: command.status,
          cursor,
        }));
        // The root Session pump is busy with R. Only durability can be required here;
        // its normal safe checkpoint accepts C2 after the original event is released.
        firstProviderRelease.release();
      } else {
        await until(
          async () => (startedApplyHeld ? true : undefined),
          'first_report_did_not_start_accurate_parent_R',
        );
        const active = (await owned.getView('root')).runs.filter((run) => run.isActive);
        assert(
          active.length === 1 &&
            active[0]!.id === automaticRunId &&
            active[0]!.rootWorkCommandId === 'A' &&
            active[0]!.originCommandId === (await durableReport('C1')).command.id,
          'C1_original_report_started_exact_A_parent_R',
        );
        assert(
          !actualParentRequests.some((request) => request.runId === automaticRunId),
          'R_started_before_second_result_and_before_first_model_checkpoint',
        );
        assert(
          (await childFor('C2')).status === 'running' &&
            (await childFor('C3')).status === 'running',
          'second_same_work_and_other_work_still_original_running_children',
        );
        releases.C2.release();
        releases.C3.release();
        stages.laterDurableBeforeFirstRCheckpoint = await Promise.all([
          durableReport('C2'),
          durableReport('C3'),
        ]);
      }
      reportRelease.release();
      await until(async () => {
        const view = await owned.getView('root');
        return automaticRunId &&
          view.runs.some((run) => run.id === automaticRunId && !run.isActive) &&
          view.runs.every((run) => !run.isActive)
          ? view
          : undefined;
      }, 'automatic_parent_R_not_terminal');
      const aReports = await Promise.all([durableReport('C1'), durableReport('C2')]);
      const accepted = await Promise.all(
        aReports.map(async ({ carrier }) => (await owned.getExecution(carrier.id))!),
      );
      const rootView = await owned.getView('root');
      assert(
        rootView.executions.filter((row) => row.childSessionId).length === (bInitial ? 3 : 2),
        'only_original_expected_child_carriers',
      );
      assert(
        rootView.executions
          .filter((row) => row.kind === 'tool')
          .every((row) => row.definitionId === 'task.spawn') &&
          rootView.executions.filter((row) => row.definitionId === 'task.spawn').length ===
            (bInitial ? 3 : 2),
        'only_initial_real_spawn_tools_no_control_or_replacement_work',
      );
      const aRuns = rootView.runs.filter((run) => run.rootWorkCommandId === 'A');
      const r = aRuns.find((run) => run.id === automaticRunId)!;
      assert(
        aRuns.length === 2 &&
          r?.status === 'completed' &&
          r.originCommandId !== 'A' &&
          r.rootWorkSeq === aInitial.rootWorkSeq &&
          r.contextSelectionId === aInitial.contextSelectionId &&
          r.deadlineAt === aInitial.deadlineAt &&
          isDeepStrictEqual(r.configuration, aInitial.configuration),
        'exactly_one_automatic_completed_A_run_with_original_configuration',
      );
      assert(
        rootView.runs.length === (bInitial ? 3 : 2) && rootView.runs.every((run) => !run.isActive),
        'no_extra_root_runs_or_active_parent',
      );
      const sources: string[] = [];
      for (const [index, slot] of (['C1', 'C2'] as const).entries()) {
        const carrier = accepted[index]!;
        const acceptance = carrier.resultAcceptance;
        const body = String(object(carrier.result).content ?? '');
        assert(
          carrier.status === 'succeeded' &&
            body.includes(materials[slot].trim()) &&
            carrier.resultRevision === aReports[index]!.carrier.resultRevision &&
            carrier.rootWorkCommandId === 'A' &&
            carrier.rootWorkSeq === aInitial.rootWorkSeq,
          `accurate_original_child_result_revision_${slot}`,
        );
        assert(
          acceptance?.runId === r.id &&
            acceptance.resultRevision === carrier.resultRevision &&
            r.rootWorkCommandId === 'A' &&
            acceptance.selectionId === aInitial.contextSelectionId,
          `same_parent_R_accurate_acceptance_${slot}`,
        );
        sources.push(acceptance!.sourceId);
        const sourceRows = dbRead((db) =>
          db
            .query<
              {
                id: string;
                request_json: string;
                result_revision: string | number;
                selection_id: string;
                session_id: string;
                execution_id: string;
              },
              [string]
            >(
              "SELECT id,request_json,result_revision,selection_id,session_id,execution_id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?",
            )
            .all(carrier.id),
        );
        assert(
          sourceRows.length === 1 &&
            sourceRows[0]!.id === acceptance!.sourceId &&
            String(sourceRows[0]!.result_revision) === carrier.resultRevision &&
            sourceRows[0]!.selection_id === acceptance!.selectionId &&
            sourceRows[0]!.session_id === 'root' &&
            sourceRows[0]!.execution_id === carrier.id &&
            object(JSON.parse(sourceRows[0]!.request_json)).targetRunId === r.id,
          `exactly_one_original_source_${slot}`,
        );
        const requests = actualParentRequests.filter(
          (request) => request.runId === r.id && request.sourceIds.includes(acceptance!.sourceId),
        );
        assert(
          requests.length > 0 &&
            requests.every(
              (request) =>
                request.finish &&
                request.eof &&
                request.sourceIds.filter((source) => source === acceptance!.sourceId).length ===
                  1 &&
                request.completeContents.some(
                  (content) =>
                    content.includes(body) || content.includes(JSON.stringify(body).slice(1, -1)),
                ),
            ),
          `actual_provider_parent_R_prepared_complete_source_${slot}`,
        );
        const reportCommand = await owned.getCommand(aReports[index]!.command.id);
        assert(
          reportCommand?.status === 'applied' &&
            object(reportCommand.receipt).runId === r.id &&
            object(reportCommand.receipt).sourceId === acceptance!.sourceId,
          `durable_report_receipt_same_R_${slot}`,
        );
      }
      if (afterProvider) {
        const originalRequest = actualParentRequests.find(
          (request) => request.requestId === heldParentRequestId,
        );
        const secondSource = accepted[1]!.resultAcceptance!.sourceId;
        assert(
          originalRequest?.runId === r.id &&
            originalRequest.finish &&
            originalRequest.eof &&
            !originalRequest.sourceIds.includes(secondSource) &&
            !originalRequest.completeContents.some((content) =>
              content.includes(materials.C2.trim()),
            ),
          'first_dispatched_R_request_precedes_and_excludes_C2_fact',
        );
        const laterRequests = actualParentRequests.filter(
          (request) =>
            request.runId === r.id &&
            request.requestId !== heldParentRequestId &&
            request.sourceIds.includes(secondSource),
        );
        assert(
          laterRequests.length > 0 &&
            laterRequests.every((request) => request.finish && request.eof) &&
            laterRequests.some(
              (request) =>
                request.completeContents.some(
                  (content) =>
                    content.includes(materials.C1.trim()) && content.includes(materials.C2.trim()),
                ) ||
                (request.completeContents.some((content) =>
                  content.includes(materials.C1.trim()),
                ) &&
                  request.completeContents.some((content) =>
                    content.includes(materials.C2.trim()),
                  )),
            ),
          'same_R_later_actual_provider_receives_both_complete_child_facts',
        );
      }
      assert(
        new Set(sources).size === 2 &&
          (await owned.getCommand(r.originCommandId))?.kind === 'job.report',
        'distinct_result_keys_and_sources_share_original_report_parent',
      );
      if (bInitial) {
        const c3 = await durableReport('C3');
        await until(
          async () =>
            object((await owned.getCommand(c3.command.id))?.receipt).reason === 'work_not_selected'
              ? true
              : undefined,
          'B_original_report_not_durably_deferred',
        );
        const current = (await owned.getExecution(c3.carrier.id))!;
        const sourceCount = dbRead(
          (db) =>
            db
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM context_snapshot WHERE kind='result_ref' AND execution_id=?",
              )
              .get(current.id)!.count,
        );
        assert(
          current.rootWorkCommandId === 'B' &&
            current.resultAcceptance === null &&
            sourceCount === 0 &&
            String(object(current.result).content).includes(materials.C3.trim()),
          'other_work_B_result_preserved_deferred_without_A_source',
        );
        assert(
          actualParentRequests
            .filter((request) => request.rootWorkCommandId === 'A')
            .every(
              (request) =>
                !request.completeContents.some((content) => content.includes(materials.C3.trim())),
            ),
          'no_B_result_material_in_any_actual_A_provider_input',
        );
        assert(
          (
            await owned.readHumanWorkState({
              expectedStoreId,
              sessionId: 'root',
              subjectId: 'live-coalescing-owner',
            })
          ).selectedWork?.rootWorkCommandId === 'A',
          'B_result_does_not_switch_selected_A',
        );
        stages.finalDeferredB = { carrier: current, report: await owned.getCommand(c3.command.id) };
      }
      for (const baseline of childBaselines) {
        const read = reads.get(baseline.slot)!;
        const view = await owned.getView(read.sessionId);
        const readTool = await owned.getExecution(read.executionId);
        const childModels = view.executions.filter(
          (row) => row.kind === 'model' && row.status === 'succeeded',
        );
        const carrier = await childFor(baseline.slot);
        assert(
          read.count === 1 &&
            read.completed &&
            view.runs.length === 1 &&
            view.runs[0]!.id === read.runId &&
            view.runs[0]!.status === 'completed' &&
            isDeepStrictEqual(view.runs[0]!.configuration, baseline.run!.configuration),
          `original_child_one_run_configuration_unchanged_${baseline.slot}`,
        );
        assert(
          readTool?.status === 'succeeded' &&
            object(readTool.result).content === materials[baseline.slot] &&
            childModels.some(
              (row) =>
                object(row.result).content === object(carrier.result).content &&
                options.requests().some((request) => request.requestId === row.id),
            ),
          `real_child_read_and_model_report_verbatim_${baseline.slot}`,
        );
        assert(
          view.executions.filter((row) => row.kind === 'tool').length === 1 &&
            readFileSync(join(workspace, `${baseline.slot}.txt`), 'utf8') ===
              materials[baseline.slot],
          `single_actual_finite_read_and_unchanged_file_${baseline.slot}`,
        );
      }
      const concurrency = dbRead((db) =>
        db
          .query<{ object_id: string; type: string }, []>(
            "SELECT object_id,type FROM change_event WHERE scope_session_id='root' AND type IN('run.started','run.finished') ORDER BY cursor",
          )
          .all(),
      );
      const active = new Set<string>();
      let maxActive = 0;
      for (const event of concurrency) {
        if (event.type === 'run.started') active.add(event.object_id);
        else active.delete(event.object_id);
        maxActive = Math.max(maxActive, active.size);
      }
      assert(
        maxActive === 1 && active.size === 0,
        'canonical_entire_parent_timeline_at_most_one_active_run',
      );
      assert(
        options.requests().length - firstRequest > 0 &&
          options.requests().length - firstRequest <= 40,
        'counted_real_model_requests_within_common_case_budget',
      );
      stages.final = { rootRuns: rootView.runs, accepted, actualParentRequests, concurrency };
      const bad = Object.entries(checks).find(([, value]) => value === false);
      if (bad) throw new Boundary('oracle_violation', bad[0]);
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
      reportRelease.release();
      firstProviderRelease.release();
      for (const slot of slots) releases[slot].release();
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
      if (retained) {
        try {
          writeFileSync(
            join(root, 'coalescing-stages.json'),
            JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
            { mode: 0o600 },
          );
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
          failurePoint = 'canonical_stage_evidence_not_saved';
        }
      } else {
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
      reason,
      failurePoint,
      checks,
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: retained,
      coverage: [
        'owned_allow_formal_service_client_real_parent_and_children',
        id === 'R03-simultaneous-results'
          ? 'two_original_results_durable_before_first_report_apply'
          : afterProvider
            ? 'R_actual_counted_provider_first_event_then_C2_and_B_reports_durable_same_R_later_provider_consumption'
            : 'first_report_starts_R_then_second_same_work_and_other_B_reports_durable_before_R_safe_checkpoint',
        'two_exact_result_revisions_unique_sources_receipts_in_one_automatic_parent_R',
        'not_default_approval_or_crash_recovery_or_other_interleavings_qualification',
      ],
    });
  }
  return { cases };
}
