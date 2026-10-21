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
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = [
  'A12-fixed-upper-real-followup-and-fourth-spawn',
  'A12-initial-high-sequence-fixed-upper-and-scope',
] as const;
export type LiveDirectoryBoundaryCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveDirectoryBoundaryCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  semanticReviewRequired: true;
}
const object = (v: unknown): Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
const encode = (v: unknown) =>
  JSON.stringify(v, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
/** Real Task/Store directory only. Caller owns shared 40 physical HTTP/600sec per case. */
export async function runLiveDirectoryBoundaries(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_directory_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
        options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-directory-')),
      ),
      workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const high = id === 'A12-initial-high-sequence-fixed-upper-and-scope';
    const checks: Result['checks'] = {},
      stages: Record<string, unknown> = {};
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
      runtime: ReturnType<typeof createRuntime> | undefined,
      service: Awaited<ReturnType<typeof startService>> | undefined,
      client: ReturnType<typeof createClient> | undefined;
    let storeClosed = false;
    const assert = (v: unknown, p: string) => {
      checks[p] = Boolean(v);
      if (!v) throw new Boundary('oracle_violation', p);
    };
    const branch = (v: unknown, p: string) => {
      if (!v) throw new Boundary('branch_not_reached', p);
    };
    async function until<T>(read: () => Promise<T | undefined>, p: string) {
      const end = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const v = await read();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Boundary('branch_not_reached', p);
        await Bun.sleep(20);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      const nonce = {
        left: `left-${randomUUID()}`,
        right: `right-${randomUUID()}`,
        third: `third-${randomUUID()}`,
        fourth: `fourth-${randomUUID()}`,
        foreign: `foreign-${randomUUID()}`,
        follow: `follow-${randomUUID()}`,
      };
      type Slot = keyof typeof nonce;
      for (const slot of Object.keys(nonce) as Slot[])
        writeFileSync(join(workspace, `${slot}.txt`), `actual-${nonce[slot]}\n`, { mode: 0o600 });
      const shared =
        'Inspect the exact original responsibility and preserve all source evidence. '.repeat(10);
      const assignment = (slot: Slot) =>
        `${slot === 'left' || slot === 'right' ? shared : `Distinct ${slot} responsibility. `}Responsibility selector ${nonce[slot]}. For this initial turn, read ONLY slot ${slot} exactly once using read_directory_material. Return the complete actual material verbatim and finish this turn. A later explicit follow-up may assign one new material slot for a new turn; retain this original assignment as immutable history rather than re-reading its old slot. Never delegate, write, retry, send, cancel or control anyone.`;
      const expectedAssignment = {
        left: assignment('left'),
        right: assignment('right'),
        third: assignment('third'),
        fourth: assignment('fourth'),
        foreign: assignment('foreign'),
      };
      store = await openSqliteStore(profile);
      const expectedStoreId = (await store.getMetadata()).storeId;
      // Formal setup precedes optional allocator-only seed; no business Run exists yet.
      const prep = createRuntime({
        store,
        model: options.model,
        modelId: options.modelId,
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'owned-directory-setup' };
          },
        },
      });
      runtime = prep;
      await prep.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned directory',
        rootUri: pathToFileURL(workspace).href,
      });
      for (const sessionId of ['root', 'foreign'])
        await prep.createSession({
          expectedStoreId,
          subjectId: 'live-directory-owner',
          commandId: `create-${sessionId}`,
          sessionId,
          workspaceId: 'w',
          title: 'Owned directory scope',
        });
      await prep.close();
      storeClosed = true;
      runtime = undefined;
      store = undefined;
      if (high) {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          strict: true,
        });
        try {
          const rows = (sql: string) => {
            const q = db.query(sql);
            (q as typeof q & { safeIntegers(value: boolean): typeof q }).safeIntegers(true);
            return q.all() as Record<string, unknown>[];
          };
          const tables = rows(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          ).map((r) => String(r.name));
          const snapshot = () =>
            Object.fromEntries(
              tables.map((table) => [
                table,
                rows(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`),
              ]),
            );
          const before = snapshot();
          assert(
            (before.run?.length ?? 0) === 0 &&
              (before.execution?.length ?? 0) === 0 &&
              (before.context_snapshot?.length ?? 0) === 0 &&
              (before.session?.length ?? 0) === 2,
            'highseq_seed_only_empty_formally_created_roots_before_business',
          );
          const old = before.session!.find((row) => row.id === 'root')!;
          const seed = 9007199254740993n;
          assert(BigInt(String(old.next_seq)) < seed, 'highseq_seed_strictly_monotone');
          const commandBefore = encode(before.command);
          db.run("UPDATE session SET next_seq=? WHERE id='root'", [seed]);
          const after = snapshot();
          const normalized = structuredClone(after);
          normalized.session!.find((row) => row.id === 'root')!.next_seq = old.next_seq;
          assert(
            encode(normalized) === encode(before) &&
              encode(after.command) === commandBefore &&
              String(after.session!.find((row) => row.id === 'root')!.next_seq) === String(seed),
            'highseq_prebusiness_exact_one_field_change_all_other_rows_identical',
          );
          stages.allocatorSeed = {
            seed: String(seed),
            previous: String(old.next_seq),
            beforeTablesSha256: hash(encode(before)),
            afterTablesSha256: hash(encode(after)),
            normalizedAfterSha256: hash(encode(normalized)),
            tableRows: Object.fromEntries(
              Object.entries(before).map(([name, value]) => [name, value.length]),
            ),
            noPostBusinessMutation: true,
          };
        } finally {
          db.close();
        }
      }
      store = await openSqliteStore(profile);
      storeClosed = false;
      const owned = store;
      assert(
        (await owned.getMetadata()).storeId === expectedStoreId &&
          options.requests().length === firstRequest,
        'formal_empty_setup_and_seed_zero_provider_same_store',
      );
      const reads: {
        slot: Slot;
        sessionId: string;
        runId: string;
        executionId: string;
        content: string;
      }[] = [];
      const reader: ToolDefinition = {
        id: 'live.directory-read',
        version: '1',
        model: { name: 'read_directory_material' },
        description:
          'Read exactly one assigned finite owned synthetic responsibility material; no effects.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['slot'],
          properties: { slot: { type: 'string', enum: Object.keys(nonce) } },
        },
        async execute(input, context) {
          const slot = object(input).slot as Slot;
          branch(
            slot in nonce &&
              context.sessionId !== 'root' &&
              context.sessionId !== 'foreign' &&
              context.runId,
            'actual_directory_child_read_not_reached',
          );
          const content = readFileSync(join(workspace, `${slot}.txt`), 'utf8');
          reads.push({
            slot,
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            content,
          });
          return { outcome: 'succeeded', content };
        },
      };
      const lists: {
        sessionId: string;
        runId: string | null;
        executionId: string;
        input: Json;
        result: Json;
        body: Record<string, Json>;
      }[] = [];
      const baseTask = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description: 'Read one exact responsibility material and report truthfully.',
          },
        ],
      });
      const task = {
        ...baseTask,
        tools: baseTask.tools!.map(
          (tool): ToolDefinition => ({
            ...tool,
            async execute(input, context) {
              const result = await tool.execute(input, context);
              if (tool.id === 'task.list' && result.outcome === 'succeeded') {
                let body: Record<string, Json> = {};
                try {
                  body = object(JSON.parse(result.content));
                } catch {
                  /* actual branch stays unqualified */
                }
                lists.push({
                  sessionId: context.sessionId,
                  runId: context.runId,
                  executionId: context.executionId,
                  input: structuredClone(input),
                  result: structuredClone(result) as unknown as Json,
                  body,
                });
              }
              return result;
            },
          }),
        ),
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        stream(request, context) {
          return options.model.stream(request, {
            signal: AbortSignal.any([options.signal, context.signal]),
          });
        },
      };
      const permissions = {
        async authorize() {
          return { allowed: true as const, revision: 'owned-directory-live-only-1' };
        },
      };
      const rootTools = [
        reader.id,
        ...task.tools.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      ];
      const binding = (): RunConfiguration => ({
        model,
        modelId: options.modelId,
        toolIds: rootTools,
        snapshot: { kind: 'owned-directory', version: 1 },
        permissions,
        afterTurn: permissions,
      });
      runtime = createRuntime({
        store: owned,
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        artifacts: createArtifactStore({ profile, store: owned }),
        permissions,
        afterTurn: permissions,
        extensions: [task, { id: 'live.directory', version: '1', apiMajor: 1, tools: [reader] }],
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
            toolIds: [reader.id],
            snapshot: { kind: 'owned-directory-child', version: 1 },
          },
        ],
      });
      service = await startService({
        runtime,
        subjectId: 'live-directory-owner',
        buildId: 'live-directory',
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: serviceKey(profile),
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
      const scope = (sessionId = 'root') => ({
        expectedStoreId,
        sessionId,
        subjectId: 'live-directory-owner',
        extensionId: 'builtin.task',
      });
      async function settled(sessionId: string, count: number) {
        return until(async () => {
          const view = await owned.getView(sessionId);
          const jobs = view.executions.filter((row) => row.kind === 'job' && row.childSessionId);
          return jobs.length === count &&
            jobs.every((row) => row.status === 'succeeded' && row.resultAcceptance) &&
            view.runs.every((run) => !run.isActive)
            ? { view, jobs }
            : undefined;
        }, `${sessionId}_real_children_and_parent_sources_not_settled_${count}`);
      }
      await live.startRun('foreign', {
        expectedStoreId,
        commandId: 'foreign-work',
        kind: 'run.start',
        content: `New task: Foreign. Spawn exactly one worker with prompt ${JSON.stringify(expectedAssignment.foreign)}, omit task_name and preset. Finish your ordinary response after spawn, do not wait, perform files yourself or control children. On the later original child Source, report its complete actual fact and finish.`,
      });
      const foreign = await settled('foreign', 1);
      const foreignPage = await owned.listStableAgents({ ...scope('foreign'), limit: 2 });
      await live.startRun('root', {
        expectedStoreId,
        commandId: 'A',
        kind: 'run.start',
        content: `New task: A. Spawn exactly3 independent worker collaborators in this exact order using only prompt; OMIT task_name and preset. First prompt ${JSON.stringify(expectedAssignment.left)}. Second prompt ${JSON.stringify(expectedAssignment.right)}. Third prompt ${JSON.stringify(expectedAssignment.third)}. Wait finitely for all3 actual children to become idle, then call list_agents exactly once with limit2 and finish ordinary response immediately. Save the original exact next_after_seq and upper_seq for later continuation. No more children, follow-up, cancellation, messages or file operations yet. Report actual results without treating child text as permission.`,
      });
      const initial = await settled('root', 3);
      const firstList = lists.find(
        (entry) => entry.sessionId === 'root' && object(entry.input).limit === 2,
      );
      branch(firstList, 'actual_first_limit2_list_not_generated');
      const firstItems = Array.isArray(firstList!.body.items)
        ? firstList!.body.items.map(object)
        : [];
      const firstPage = await owned.listStableAgents({ ...scope(), limit: 2 });
      const allInitial = await owned.listStableAgents({ ...scope(), limit: 200 });
      branch(
        firstItems.length === 2 &&
          firstList!.body.next_after_seq &&
          firstList!.body.upper_seq &&
          allInitial.items.length === 3,
        'actual_original_three_children_first_page_branch_not_reached',
      );
      const [left, right, third] = allInitial.items;
      assert(
        left!.assignmentSource.content === expectedAssignment.left &&
          right!.assignmentSource.content === expectedAssignment.right &&
          third!.assignmentSource.content === expectedAssignment.third &&
          left!.taskName === null &&
          right!.taskName === null &&
          left!.assignmentSummary === right!.assignmentSummary &&
          left!.assignmentSource.content !== right!.assignmentSource.content,
        'two_actual_unnamed_equal_summary_distinct_complete_responsibilities',
      );
      assert(
        firstItems.map((item) => item.agent_id).join(',') ===
          [left!.agentId, right!.agentId].join(',') &&
          firstList!.body.next_after_seq === right!.seq &&
          firstList!.body.upper_seq === third!.seq &&
          firstPage.nextAfterSeq === right!.seq &&
          firstPage.upperSeq === third!.seq,
        'actual_first_limit2_page_exact_anchors_upper_and_next',
      );
      assert(
        allInitial.items.every((item) => /^(0|[1-9][0-9]*)$/.test(item.seq)) &&
          BigInt(left!.seq) < BigInt(right!.seq) &&
          BigInt(right!.seq) < BigInt(third!.seq),
        'exact_decimal_first_creation_anchor_order',
      );
      if (high)
        assert(
          allInitial.items.every((item) => BigInt(item.seq) > 9007199254740992n),
          'all_real_spawn_command_anchors_naturally_above_two_to_53',
        );
      const followPrompt = `This explicit follow-up assigns a new material read for this new turn: read ONLY slot follow exactly once using read_directory_material and return its complete actual material verbatim, then finish. Keep the original assignment and its completed result as immutable history; do not re-read the original slot. No delegation, writes, messages, retries, cancellation or control.`;
      await live.startRun('root', {
        expectedStoreId,
        commandId: 'directory-continuation',
        kind: 'run.start',
        content: `Continue A. Look up the complete original responsibility sources for the existing unnamed collaborators with list_agents. Choose the ONE whose full original responsibility contains selector ${nonce.left}; the two short summaries are intentionally identical, so read the full source before choosing. Do not guess from list order, task_name or partial summary. Call follow_up_agent exactly once on that correct existing idle agent with content ${JSON.stringify(followPrompt)}. Then spawn exactly one NEW fourth worker with prompt ${JSON.stringify(expectedAssignment.fourth)}, OMIT task_name/preset. Wait finitely for both actual turns to finish. Then call list_agents with after_seq ${JSON.stringify(firstPage.nextAfterSeq)}, upper_seq ${JSON.stringify(firstPage.upperSeq)}, limit2, and finish your ordinary response. Preserve original directory upper/cursor. Do no other controls, children or file operations yourself.`,
      });
      const final = await settled('root', 5);
      const current = await owned.listStableAgents({ ...scope(), limit: 200 });
      assert(
        current.items.length === 4 &&
          current.items.filter((item) => item.agentId === left!.agentId).length === 1 &&
          current.items.find((item) => item.agentId === left!.agentId)?.seq === left!.seq &&
          current.items.find((item) => item.agentId === left!.agentId)?.assignmentSource.content ===
            expectedAssignment.left &&
          current.items.find((item) => item.agentId === left!.agentId)?.currentWorkSource
            .content === followPrompt,
        'followup_preserves_first_anchor_original_assignment_and_exact_current_work',
      );
      const fourth = current.items.find(
        (item) => !allInitial.items.some((before) => before.agentId === item.agentId),
      );
      branch(fourth, 'real_fourth_new_child_not_reached');
      assert(
        fourth!.assignmentSource.content === expectedAssignment.fourth &&
          BigInt(fourth!.seq) > BigInt(firstPage.upperSeq),
        'fourth_real_spawn_anchor_after_original_upper',
      );
      const secondList = lists.find(
        (entry) =>
          entry.sessionId === 'root' &&
          object(entry.input).afterSeq === firstPage.nextAfterSeq &&
          object(entry.input).upperSeq === firstPage.upperSeq &&
          object(entry.input).limit === 2,
      );
      branch(secondList, 'actual_Model_fixed_upper_second_page_not_generated');
      const secondItems = Array.isArray(secondList!.body.items)
        ? secondList!.body.items.map(object)
        : [];
      assert(
        secondItems.length === 1 &&
          secondItems[0]!.agent_id === third!.agentId &&
          secondList!.body.next_after_seq === null &&
          secondList!.body.upper_seq === firstPage.upperSeq,
        'actual_second_page_only_original_third_no_fourth_no_duplicate',
      );
      const followTools = final.view.executions.filter(
        (row) => row.definitionId === 'task.follow_up',
      );
      branch(followTools.length === 1, 'exactly_one_real_model_followup_not_reached');
      assert(
        object(followTools[0]!.input).agentId === left!.agentId &&
          String(object(followTools[0]!.result).content).includes('new_turn'),
        'actual_Model_chooses_correct_full_tail_responsibility_child',
      );
      const controlRequest = options
        .requests()
        .slice(firstRequest)
        .find((request) =>
          final.view.executions.some(
            (row) =>
              row.kind === 'model' &&
              row.id === request.requestId &&
              Array.isArray(object(row.result).toolCalls) &&
              (object(row.result).toolCalls as Json[]).some(
                (call) => object(call).name === 'task.follow_up',
              ),
          ),
        );
      branch(controlRequest, 'actual_Model_followup_request_not_identified');
      assert(
        controlRequest!.messages.some(
          (message) =>
            lists.some(
              (entry) =>
                entry.sessionId === 'root' && message.sourceIds?.includes(entry.executionId),
            ) &&
            (message.content.includes(expectedAssignment.left) ||
              message.content.includes(JSON.stringify(expectedAssignment.left).slice(1, -1))) &&
            (message.content.includes(expectedAssignment.right) ||
              message.content.includes(JSON.stringify(expectedAssignment.right).slice(1, -1))),
        ),
        'actual_selected_Model_input_has_real_directory_Tool_source_with_both_complete_original_assignment_tails',
      );
      assert(
        final.view.executions
          .filter((row) => row.kind === 'tool')
          .every((row) =>
            ['task.spawn', 'task.list', 'task.events', 'task.follow_up'].includes(row.definitionId),
          ),
        'only_real_requested_directory_spawn_followup_and_event_Tools',
      );
      if (high) {
        const rootCommands = await Promise.all(
          final.view.executions.map((row) => owned.getCommand(row.originCommandId)),
        );
        assert(
          rootCommands.every((command) => command && BigInt(command.seq) > 9007199254740992n) &&
            final.view.runs.every((run) => BigInt(run.rootWorkSeq) > 9007199254740992n),
          'all_natural_root_business_Tool_carrier_commands_and_Run_work_sequences_above_two_to_53',
        );
      }
      assert(
        initial.jobs.every((before) =>
          final.jobs.some((now) => now.id === before.id && isDeepStrictEqual(now, before)),
        ) &&
          final.jobs.filter((job) => job.childSessionId === right!.agentId).length === 1 &&
          final.jobs.filter((job) => job.childSessionId === left!.agentId).length === 2,
        'wrong_similar_child_untouched_all_original_carriers_immutable',
      );
      // Trusted Store read probes are separate from actual model Tool qualification.
      const beforeProbe = {
        cursor: (await owned.getMetadata()).lastChangeCursor,
        requests: options.requests().length,
        jobs: structuredClone(final.jobs),
      };
      const bounded = await owned.listStableAgents({
        ...scope(),
        afterSeq: firstPage.nextAfterSeq!,
        upperSeq: firstPage.upperSeq,
        limit: 2,
      });
      const exact = await owned.listStableAgents({
        ...scope(),
        agentIds: [left!.agentId, right!.agentId],
        afterSeq: '0',
        limit: 2,
      });
      const empty = await owned.listStableAgents({
        ...scope(),
        afterSeq: firstPage.upperSeq,
        upperSeq: firstPage.upperSeq,
        limit: 2,
      });
      const changedFilter = await owned.listStableAgents({
        ...scope(),
        agentIds: [right!.agentId, third!.agentId],
        afterSeq: '0',
        limit: 2,
      });
      assert(
        bounded.items.length === 1 &&
          bounded.items[0]!.agentId === third!.agentId &&
          bounded.nextAfterSeq === null &&
          exact.items.length === 2 &&
          exact.nextAfterSeq === null &&
          empty.items.length === 0 &&
          empty.nextAfterSeq === null &&
          changedFilter.items.map((item) => item.agentId).join(',') ===
            [right!.agentId, third!.agentId].join(','),
        'trusted_Store_fixed_upper_exact_limit_empty_EOF_and_filter_restart',
      );
      const foreignId = foreign.jobs[0]!.childSessionId!;
      const bads: [Record<string, unknown>, string][] = [
        ...['01', '-1', '1.5', '9223372036854775808'].map(
          (afterSeq) => [{ afterSeq }, 'invalid_cursor'] as [Record<string, unknown>, string],
        ),
        [{ afterSeq: String(BigInt(current.upperSeq) + 1n) }, 'invalid_cursor'],
        [{ upperSeq: String(BigInt(current.upperSeq) + 1n) }, 'invalid_cursor'],
        [{ agentIds: [] }, 'invalid_request'],
        [{ agentIds: [left!.agentId, left!.agentId] }, 'invalid_request'],
        [{ agentIds: [left!.agentId, foreignId], limit: 1 }, 'agent_unavailable'],
        [{ agentIds: [left!.agentId, `missing-${randomUUID()}`], limit: 1 }, 'agent_unavailable'],
        ...[0, 201, Number.NaN].map(
          (limit) => [{ limit }, 'invalid_request'] as [Record<string, unknown>, string],
        ),
      ];
      for (const [index, [input, expected]] of bads.entries()) {
        let code = '';
        try {
          await owned.listStableAgents({ ...scope(), ...input } as Parameters<
            typeof owned.listStableAgents
          >[0]);
        } catch (error) {
          code = String(object(error).code ?? '');
        }
        assert(code === expected, `trusted_Store_invalid_filter_cursor_all_or_nothing_${index}`);
      }
      const overlap = foreignPage.items[0]!.seq;
      branch(
        BigInt(overlap) <= BigInt(current.upperSeq),
        'actual_foreign_numeric_cursor_not_legal_in_both_scopes',
      );
      const sameNumberOwn = await owned.listStableAgents({
        ...scope(),
        afterSeq: overlap,
        upperSeq: current.upperSeq,
        limit: 200,
      });
      const sameNumberForeign = await owned.listStableAgents({
        ...scope('foreign'),
        afterSeq: overlap,
        upperSeq: foreignPage.upperSeq,
        limit: 200,
      });
      assert(
        sameNumberOwn.items.every(
          (item) =>
            current.items.some((own) => own.agentId === item.agentId) &&
            BigInt(item.seq) > BigInt(overlap),
        ) &&
          sameNumberForeign.items.every((item) =>
            foreignPage.items.some((own) => own.agentId === item.agentId),
          ) &&
          !sameNumberOwn.items.some((item) => item.agentId === foreignId),
        'same_legal_decimal_cursor_interpreted_in_current_scope_zero_foreign_data',
      );
      assert(
        (await owned.getMetadata()).lastChangeCursor === beforeProbe.cursor &&
          options.requests().length === beforeProbe.requests &&
          isDeepStrictEqual(
            (await owned.getView('root')).executions.filter(
              (row) => row.kind === 'job' && row.childSessionId,
            ),
            beforeProbe.jobs,
          ),
        'trusted_directory_reads_zero_Provider_consumption_or_Store_events',
      );
      const sessions = ['root', 'foreign', ...current.items.map((item) => item.agentId), foreignId];
      let checked = 0;
      for (const sessionId of sessions) {
        const view = await owned.getView(sessionId);
        for (const row of view.executions.filter(
          (row) => row.kind === 'model' && row.status === 'succeeded',
        )) {
          const actual = options
            .requests()
            .slice(firstRequest)
            .find((request) => request.requestId === row.id);
          branch(actual, 'real_Model_record_not_counted');
          const saved = await runtime.readModelInput({
            expectedStoreId,
            sessionId,
            subjectId: 'live-directory-owner',
            executionId: row.id,
          });
          const visible = structuredClone(actual!);
          for (const message of visible.messages)
            delete (message as { continuation?: unknown }).continuation;
          assert(
            isDeepStrictEqual(saved.request, visible),
            `complete_saved_actual_Model_input_${hash(row.id).slice(0, 12)}`,
          );
          checked++;
        }
      }
      for (const entry of [firstList!, secondList!])
        assert(
          options
            .requests()
            .some((request) =>
              request.messages.some(
                (message) =>
                  message.sourceIds?.includes(entry.executionId) &&
                  (message.content.includes(String(object(entry.result).content)) ||
                    message.content.includes(
                      JSON.stringify(String(object(entry.result).content)).slice(1, -1),
                    )),
              ),
            ),
          `actual_complete_list_result_prepared_${hash(entry.executionId).slice(0, 12)}`,
        );
      assert(
        options
          .requests()
          .slice(firstRequest)
          .filter((request) =>
            final.view.executions.some(
              (row) => row.kind === 'model' && row.id === request.requestId,
            ),
          )
          .every((request) =>
            request.messages.every((message) => !message.content.includes(nonce.foreign)),
          ),
        'foreign_scope_fact_absent_from_all_actual_root_Provider_inputs',
      );
      const expectedSlots = ['left', 'right', 'third', 'fourth', 'foreign', 'follow'] as Slot[];
      assert(
        expectedSlots.every((slot) => reads.filter((read) => read.slot === slot).length === 1) &&
          reads.length === 6,
        'six_real_finite_child_reads_exactly_once',
      );
      for (const read of reads) {
        const row = await owned.getExecution(read.executionId);
        const childView = await owned.getView(read.sessionId);
        assert(
          row?.status === 'succeeded' &&
            object(row.result).content === `actual-${nonce[read.slot]}\n` &&
            read.content === `actual-${nonce[read.slot]}\n` &&
            readFileSync(join(workspace, `${read.slot}.txt`), 'utf8') === read.content,
          `real_material_unchanged_${read.slot}`,
        );
        const report = childView.executions.find(
          (item) =>
            item.kind === 'model' &&
            item.runId === read.runId &&
            item.status === 'succeeded' &&
            String(object(item.result).content).includes(read.content.trim()),
        );
        const carrier = [...final.jobs, ...foreign.jobs].find(
          (item) =>
            item.childSessionId === read.sessionId && object(item.reference).runId === read.runId,
        );
        branch(report && carrier, 'real_child_actual_material_report_and_carrier_not_reached');
        assert(
          object(report!.result).content === object(carrier!.result).content &&
            carrier!.resultRevision === '1' &&
            carrier!.resultAcceptance?.resultRevision === carrier!.resultRevision,
          `actual_complete_child_Model_carrier_revision_${read.slot}`,
        );
        const body = String(object(carrier!.result).content ?? '');
        const source = carrier!.resultAcceptance!.sourceId;
        assert(
          options
            .requests()
            .some((request) =>
              request.messages.some(
                (message) =>
                  message.sourceIds?.filter((item) => item === source).length === 1 &&
                  (message.content.includes(body) ||
                    message.content.includes(JSON.stringify(body).slice(1, -1))),
              ),
            ),
          `actual_complete_child_result_Source_prepared_${read.slot}`,
        );
        if (high && read.slot !== 'foreign')
          assert(
            childView.runs
              .filter((run) => run.id === read.runId)
              .every((run) => BigInt(run.rootWorkSeq) > 9007199254740992n),
            `child_inherits_exact_high_root_work_sequence_${read.slot}`,
          );
      }
      checks.actual_Model_invalid_list_attempts = final.view.executions.filter(
        (row) => row.definitionId === 'task.list' && row.status === 'failed',
      ).length;
      assert(
        checked > 0 &&
          options.requests().length - firstRequest <= 40 &&
          options.requests().length > firstRequest,
        'counted_actual_Model_requests_within_shared_budget',
      );
      stages.final = {
        highSequence: high,
        firstListInputSha256: hash(encode(firstList!.input)),
        firstListResultSha256: hash(encode(firstList!.result)),
        secondListInputSha256: hash(encode(secondList!.input)),
        secondListResultSha256: hash(encode(secondList!.result)),
        initialAnchors: allInitial.items.map((item) => item.seq),
        finalAnchors: current.items.map((item) => item.seq),
        originalUpper: firstPage.upperSeq,
        originalNext: firstPage.nextAfterSeq,
        overlap,
        negativeReadProbes: bads.length,
        modelSnapshotsChecked: checked,
        completeLeftAssignmentSha256: hash(expectedAssignment.left),
        completeRightAssignmentSha256: hash(expectedAssignment.right),
        actualSelectedParentRequestSha256: hash(encode(controlRequest)),
        semanticReviewRequired: true,
      };
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
          await runtime.close();
          storeClosed = true;
        }
      } catch {
        closed = false;
      }
      if (!storeClosed)
        try {
          await store?.close();
        } catch {
          closed = false;
        }
      checks.resourcesClosed = closed;
      if (!closed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      if (options.evidenceRoot || status !== 'passed') {
        try {
          writeFileSync(
            join(root, 'directory-boundary-stages.json'),
            JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
            { mode: 0o600 },
          );
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
        }
      } else
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
        }
    }
    cases.push({
      id,
      status,
      checks,
      reason,
      failurePoint,
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: existsSync(root),
      semanticReviewRequired: true,
      coverage: [
        'real_Task_multi_page_fixed_upper_after_real_followup_and_fourth_spawn',
        'two_unnamed_identical_summary_full_original_tails_actual_Model_target_choice',
        'trusted_Store_negative_probes_separate_from_Model_generated_Tools',
        high
          ? 'only_prebusiness_monotone_root_allocator_seed_real_post_seed_command_anchors'
          : 'normal_command_sequence_scope',
        'not_high_event_cursor_compression_crash_Artifact_dualconsumer_or_default_UI_qualification',
      ],
    });
  }
  return { cases };
}
function serviceKey(profile: { dataRoot: string; profile: string }) {
  return resolveProfile(profile).profileAccessKey;
}
