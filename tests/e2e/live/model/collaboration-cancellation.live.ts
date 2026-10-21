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
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const caseIds = ['cancellation-attached-branch', 'cancellation-root-stop'] as const;
type CaseId = (typeof caseIds)[number];
export interface LiveCancellationOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
export interface LiveCancellationResult {
  id: CaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  canonicalEvidenceRetained: boolean;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
}
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  constructor(reason: 'branch_not_reached' | 'oracle_violation') {
    super(reason);
    this.reason = reason;
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function wait(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let aborted!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(Error('live_cancellation_aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
  signal.throwIfAborted();
}

/** Isolated test artifact. All root, child and grandchild events come from the supplied adapter. */
export async function runLiveCollaborationCancellation(
  options: LiveCancellationOptions,
): Promise<{ cases: LiveCancellationResult[] }> {
  const selected = caseIds.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (options.evidenceRoot && (!isAbsolute(options.evidenceRoot) || selected.length !== 1))
    throw Error('live_collaboration_evidence_root_invalid');
  const cases: LiveCancellationResult[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-cancellation-')),
    );
    const checks: Record<string, boolean | number> = {
      modelAttemptLimit: 32,
      observationTimeoutMs: 180_000,
    };
    let status: LiveCancellationResult['status'] = 'inconclusive';
    let reason: LiveCancellationResult['reason'];
    let canonicalEvidenceRetained = false;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    const localAbort = new AbortController();
    const signal = AbortSignal.any([
      options.signal,
      localAbort.signal,
      AbortSignal.timeout(180_000),
    ]);
    let modelAttempts = 0;
    const leafGate = gate(),
      siblingGate = gate(),
      parentGate = gate();
    const requestStart = options.requests().length;
    const entered: {
      sessionId: string;
      runId: string | null;
      executionId: string;
      material: string;
    }[] = [];
    const returned: { sessionId: string; executionId: string; material: string }[] = [];
    function assert(condition: unknown, name: string): asserts condition {
      checks[name] = !!condition;
      if (!condition) throw new Boundary('oracle_violation');
    }
    async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
      const end = Date.now() + 90_000;
      for (;;) {
        signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= end) throw new Boundary('branch_not_reached');
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
      }
    }
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const siblingFact = `sibling verification ${randomUUID()}\r\n`;
      const leafFact = `branch verification ${randomUUID()}\r\n`;
      writeFileSync(join(workspace, 'sibling.txt'), siblingFact, { mode: 0o600 });
      writeFileSync(join(workspace, 'branch.txt'), leafFact, { mode: 0o600 });
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const ownedStore = store;
      const expectedStoreId = (await store.getMetadata()).storeId;
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        stream(request, context) {
          signal.throwIfAborted();
          if (modelAttempts >= 32) throw Error('live_collaboration_request_budget_exhausted');
          modelAttempts++;
          return options.model.stream(request, {
            signal: AbortSignal.any([signal, context.signal]),
          });
        },
      };
      const reader: ToolDefinition = {
        id: 'live.cancellation-material',
        version: '1',
        model: { name: 'read_cancellation_material' },
        description:
          'Read actual finite synthetic material. A read may wait for an external release or interruption. parent_barrier is for the root after delegation only. Do not poll, replace, or cancel a pending read.',
        inputSchema: {
          type: 'object',
          properties: {
            material: { type: 'string', enum: ['branch_leaf', 'sibling', 'parent_barrier'] },
          },
          required: ['material'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const material = record(input).material;
          if (
            typeof material !== 'string' ||
            !['branch_leaf', 'sibling', 'parent_barrier'].includes(material)
          )
            return { outcome: 'failed', content: 'invalid_case_material' };
          entered.push({
            material,
            sessionId: context.sessionId,
            runId: context.runId,
            executionId: context.executionId,
          });
          const combined = AbortSignal.any([signal, context.signal]);
          if (material === 'parent_barrier') {
            if (context.sessionId !== 's')
              return { outcome: 'failed', content: 'root_barrier_only' };
            const released = await wait(parentGate.promise, combined).then(
              () => true,
              (error: unknown) => {
                if (combined.aborted) return false;
                throw error;
              },
            );
            if (!released) return { outcome: 'cancelled', content: 'cancelled_before_owned_read' };
            returned.push({
              material,
              sessionId: context.sessionId,
              executionId: context.executionId,
            });
            return {
              outcome: 'succeeded',
              content:
                'Both independent owned reads are actually in progress. Read the verified Agent directory to locate branch-coordinator. Continue only the requested cancellation procedure.',
            };
          }
          const released = await wait(
            material === 'branch_leaf' ? leafGate.promise : siblingGate.promise,
            combined,
          ).then(
            () => true,
            (error: unknown) => {
              if (combined.aborted) return false;
              throw error;
            },
          );
          // This fixture owns the read and can prove no readFileSync was entered.
          // Report its actual cooperative cancellation; never fabricate Store state.
          if (!released) return { outcome: 'cancelled', content: 'cancelled_before_owned_read' };
          const content = readFileSync(
            join(workspace, material === 'branch_leaf' ? 'branch.txt' : 'sibling.txt'),
            'utf8',
          );
          returned.push({
            material,
            sessionId: context.sessionId,
            executionId: context.executionId,
          });
          return { outcome: 'succeeded', content };
        },
      };
      const task = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description:
              'General collaborator. Follow the exact supplied delegation and interruption scope.',
          },
        ],
      });
      const toolIds = [
        reader.id,
        'task.spawn',
        'task.message',
        'task.follow_up',
        'task.events',
        'task.list',
        'task.interrupt',
      ];
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        maxConcurrentSubagents: 3,
        extensions: [
          { id: 'live.cancellation-fixture', version: '1', apiMajor: 1, tools: [reader] },
          task,
        ],
        // Owned read-only fixture, not default policy or OS-process cancellation qualification.
        permissions: {
          authorize: async () => ({ allowed: true, revision: 'owned-live-cancellation-1' }),
        },
        afterTurn: {
          authorize: async () => ({ allowed: true, revision: 'owned-live-cancellation-1' }),
        },
        childConfigurations: [
          { id: 'worker', version: '1', model, modelId: options.modelId, toolIds, snapshot: {} },
        ],
      });
      const selection = {
        dataRoot: realpathSync(profile.dataRoot),
        name: profile.profile,
        accessKey: resolveProfile(profile).profileAccessKey,
      };
      service = await startService({
        runtime,
        profile: selection,
        subjectId: 'live-owner',
        buildId: 'live-collaboration-cancellation',
      });
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile: selection,
          apiMajor: 1,
          requiredCapabilities: ['commands', 'sessions'],
        },
      });
      const ownedClient = client;
      await client.connect();
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned synthetic cancellation',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Synthetic cancellation',
      });
      const branchPrompt =
        'You are branch-coordinator. Delegate exactly one grandchild named branch-leaf with prompt: Call read_cancellation_material with material branch_leaf once, then report its actual complete content. Do not use any other material or spawn. After spawning, keep observing your own mailbox with wait_agent_events until the grandchild result arrives; do not finish while it is pending and do not interrupt or follow up anyone. Report its actual facts when available.';
      const siblingPrompt =
        'You are independent sibling-reader. Call read_cancellation_material with material sibling exactly once. Do not spawn, interrupt, send, or follow up anyone. Wait for the actual result and then return its exact complete content without inventing it.';
      const initial =
        `New task: Create exactly two direct collaborators, named branch-coordinator and sibling-reader, using these respective complete prompts: ${JSON.stringify(branchPrompt)} and ${JSON.stringify(siblingPrompt)}. Do not read branch_leaf or sibling yourself. After both spawns, call read_cancellation_material with material parent_barrier exactly once and wait for its real result. ` +
        (id === 'cancellation-attached-branch'
          ? 'After that barrier returns, use list_agents to locate your direct branch-coordinator by its original complete assignment and exact returned agent_id. Call interrupt_agent exactly once for branch-coordinator only. Never interrupt sibling-reader, spawn replacements or follow up anyone. Keep receiving the sibling result and report its actual facts plus the cancelled branch honestly. Acknowledgment is not stopped confirmation.'
          : 'After that barrier, keep observing your mailbox. Do not call interrupt_agent or any control tool: the human test operator will use the formal public root stop. Do not spawn replacements or follow up anyone.');
      await client.startRun(
        's',
        { expectedStoreId, commandId: 'work', kind: 'run.start', content: initial },
        { signal },
      );
      async function tree() {
        const rootSession = await ownedStore.getSession('s');
        if (
          !rootSession ||
          rootSession.parentSessionId !== null ||
          rootSession.rootSessionId !== 's'
        )
          throw new Boundary('oracle_violation');
        const sessions = [rootSession],
          seen = new Set(['s']);
        for (let index = 0; index < sessions.length; index++) {
          for (const carrier of await ownedStore.listExecutions(sessions[index]!.id)) {
            if (!carrier.childSessionId) continue;
            const child = await ownedStore.getSession(carrier.childSessionId);
            assert(
              child &&
                child.parentSessionId === sessions[index]!.id &&
                child.rootSessionId === 's' &&
                child.workspaceId === 'w' &&
                carrier.originStoreId === expectedStoreId,
              'verified_child_ancestry',
            );
            if (!seen.has(child.id)) {
              seen.add(child.id);
              sessions.push(child);
            }
            if (sessions.length > 4) throw new Boundary('oracle_violation');
          }
        }
        const views = await Promise.all(sessions.map((session) => ownedStore.getView(session.id)));
        return {
          sessions,
          views,
          executions: views.flatMap((view) => view.executions),
          runs: views.flatMap((view) => view.runs),
        };
      }
      const ready = await until(async () => {
        const leaf = entered.find((entry) => entry.material === 'branch_leaf');
        const sibling = entered.find((entry) => entry.material === 'sibling');
        const parent = entered.find(
          (entry) => entry.material === 'parent_barrier' && entry.sessionId === 's',
        );
        if (!leaf || !sibling || !parent) return undefined;
        return { leaf, sibling, parent, observed: await tree() };
      });
      assert(ready.observed.sessions.length === 4, 'actual_root_child_grandchild_and_sibling');
      assert(
        ready.observed.runs.length === 4 &&
          ready.observed.runs.every((run) => run.isActive) &&
          [ready.leaf, ready.sibling, ready.parent].every((entry) =>
            ready.observed.executions.some(
              (execution) =>
                execution.id === entry.executionId &&
                ['running', 'dispatching'].includes(execution.status) &&
                execution.cancelRequestedAt === null,
            ),
          ) &&
          returned.length === 0,
        'all_three_real_read_gates_active_before_control',
      );
      const leafSession = await store.getSession(ready.leaf.sessionId);
      const siblingSession = await store.getSession(ready.sibling.sessionId);
      assert(
        leafSession &&
          siblingSession &&
          leafSession.parentSessionId !== 's' &&
          siblingSession.parentSessionId === 's' &&
          leafSession.parentSessionId !== siblingSession.id,
        'distinct_correct_branches',
      );
      const branchId = leafSession.parentSessionId!;
      const branchSessions = new Set([branchId, leafSession.id]);
      const rootCarriers = ready.observed.executions.filter(
        (execution) => execution.sessionId === 's' && execution.childSessionId,
      );
      const branchCarrier = rootCarriers.find((execution) => execution.childSessionId === branchId);
      const siblingCarrier = rootCarriers.find(
        (execution) => execution.childSessionId === siblingSession.id,
      );
      assert(
        rootCarriers.length === 2 && branchCarrier && siblingCarrier,
        'exact_two_direct_child_carriers',
      );
      assert(
        ready.observed.executions
          .filter((execution) => execution.childSessionId)
          .every((execution) => execution.cancelWithParent),
        'all_three_carriers_attached',
      );
      assert(
        ready.observed.runs.filter((run) => run.sessionId !== 's').length === 3,
        'one_real_run_per_descendant',
      );
      assert(
        ready.observed.executions.filter(
          (execution) => execution.kind === 'model' && execution.status === 'succeeded',
        ).length >= 3,
        'real_descendant_models_established',
      );
      if (id === 'cancellation-attached-branch') {
        parentGate.release();
        const interruption = await until(async () => {
          const tools = (await ownedStore.listExecutions('s')).filter(
            (execution) => execution.definitionId === 'task.interrupt',
          );
          if (!tools.length) return undefined;
          assert(tools.length === 1, 'one_model_interrupt_invocation');
          const tool = tools[0]!;
          if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(tool.status))
            return undefined;
          return tool;
        });
        assert(record(interruption.input).agentId === branchId, 'model_chose_exact_branch_agent');
        assert(
          interruption.status === 'succeeded' &&
            record(interruption.result).outcome === 'succeeded',
          'model_interrupt_succeeded',
        );
        const body = record(JSON.parse(String(record(interruption.result).content)));
        assert(
          body.accepted === true &&
            body.agent_id === branchId &&
            body.outcome === 'cancel_requested',
          'exact_cancel_request_receipt',
        );
        await until(async () => {
          const observed = await tree();
          const affected = observed.executions.filter(
            (execution) =>
              branchSessions.has(execution.sessionId) || execution.id === branchCarrier.id,
          );
          const runs = observed.runs.filter((run) => branchSessions.has(run.sessionId));
          return runs.length === 2 &&
            runs.every((run) => !run.isActive) &&
            affected.every((execution) =>
              ['succeeded', 'failed', 'cancelled'].includes(execution.status),
            )
            ? observed
            : undefined;
        });
        const stopped = await tree();
        assert(
          (await store.getExecution(branchCarrier.id))?.status === 'cancelled',
          'branch_carrier_cancelled',
        );
        assert(
          stopped.runs
            .filter((run) => branchSessions.has(run.sessionId))
            .every((run) => run.status === 'cancelled' || run.status === 'interrupted'),
          'branch_and_grandchild_stopped',
        );
        assert(
          (await store.getRun(ready.sibling.runId!))?.isActive,
          'sibling_remains_active_after_branch_stop',
        );
        assert(
          (await store.getExecution(siblingCarrier.id))?.cancelRequestedAt === null,
          'sibling_not_cancel_requested',
        );
        const branchModelCount = stopped.executions.filter(
          (execution) => execution.kind === 'model' && branchSessions.has(execution.sessionId),
        ).length;
        leafGate.release();
        siblingGate.release();
        const succeededSibling = await until(async () => {
          const carrier = await ownedStore.getExecution(siblingCarrier.id);
          return carrier &&
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(carrier.status)
            ? carrier
            : undefined;
        });
        assert(
          succeededSibling.status === 'succeeded' &&
            JSON.stringify(succeededSibling.result).includes(siblingFact.trim()),
          'sibling_completed_with_real_random_fact',
        );
        const acceptance = await until(
          async () =>
            (await ownedStore.getExecution(siblingCarrier.id))?.resultAcceptance ?? undefined,
        );
        assert(
          acceptance.resultRevision === succeededSibling.resultRevision &&
            typeof acceptance.runId === 'string',
          'exact_sibling_result_accepted',
        );
        await until(async () => {
          const observed = await tree();
          const prepared = observed.executions.some(
            (execution) =>
              execution.kind === 'model' &&
              execution.runId === acceptance.runId &&
              options
                .requests()
                .some(
                  (request) =>
                    request.requestId === execution.id &&
                    request.messages.some(
                      (message) =>
                        message.sourceIds?.includes(acceptance.sourceId) &&
                        message.content.includes(siblingFact.trim()),
                    ),
                ),
          );
          return prepared &&
            observed.runs.every((run) => !run.isActive) &&
            observed.executions.every((execution) =>
              ['succeeded', 'failed', 'cancelled'].includes(execution.status),
            )
            ? observed
            : undefined;
        });
        const final = await tree();
        assert(
          final.executions.filter(
            (execution) => execution.kind === 'model' && branchSessions.has(execution.sessionId),
          ).length === branchModelCount,
          'late_leaf_release_creates_zero_branch_models',
        );
        assert(
          !returned.some((entry) => branchSessions.has(entry.sessionId)),
          'interrupted_branch_read_delivered_zero_fact',
        );
        assert(
          returned.filter((entry) => entry.material === 'sibling').length === 1,
          'sibling_read_completed_once',
        );
        assert(
          final.sessions.length === 4 &&
            final.executions.filter((execution) => execution.childSessionId).length === 3,
          'no_replacement_or_successor_agents',
        );
        assert(
          (await store.getRun(acceptance.runId!))?.status === 'completed',
          'parent_final_result_run_completed',
        );
      } else {
        const receipt = await ownedClient.cancelSession(
          's',
          {
            expectedStoreId,
            commandId: 'root-stop',
            kind: 'session.cancel',
            includeBackground: true,
          },
          { signal },
        );
        assert(receipt.status === 'applied', 'formal_public_root_stop_applied');
        await until(async () => {
          const observed = await tree();
          return observed.runs.every((run) => !run.isActive) &&
            observed.executions.every((execution) =>
              ['succeeded', 'failed', 'cancelled'].includes(execution.status),
            )
            ? observed
            : undefined;
        });
        const stopped = await tree();
        const countModels = stopped.executions.filter(
          (execution) => execution.kind === 'model',
        ).length;
        const countRuns = stopped.runs.length;
        assert(
          stopped.executions
            .filter((execution) => execution.childSessionId)
            .every((execution) => execution.status === 'cancelled'),
          'all_attached_descendant_carriers_cancelled',
        );
        assert(
          stopped.runs.every((run) => run.status === 'cancelled' || run.status === 'interrupted'),
          'root_and_descendant_runs_stopped',
        );
        leafGate.release();
        siblingGate.release();
        parentGate.release();
        const after = await tree();
        assert(
          after.runs.length === countRuns && after.runs.every((run) => !run.isActive),
          'late_gate_release_zero_run_revival',
        );
        assert(
          after.executions.filter((execution) => execution.kind === 'model').length === countModels,
          'late_gate_release_zero_new_models',
        );
        assert(returned.length === 0, 'root_stop_prevents_all_held_read_results');
        assert(
          after.sessions.length === 4 &&
            after.executions.filter((execution) => execution.childSessionId).length === 3,
          'root_stop_no_replacement_agents',
        );
      }
      assert(
        readFileSync(join(workspace, 'sibling.txt'), 'utf8') === siblingFact &&
          readFileSync(join(workspace, 'branch.txt'), 'utf8') === leafFact,
        'original_owned_bytes_unchanged',
      );
      const final = await tree();
      checks.actualRequests = options.requests().length - requestStart;
      checks.actualModelSessions = new Set(
        final.executions
          .filter((execution) => execution.kind === 'model' && execution.status === 'succeeded')
          .map((execution) => execution.sessionId),
      ).size;
      assert(
        checks.actualRequests > 0 && checks.actualModelSessions === 4,
        'all_four_sessions_used_real_adapter',
      );
      status = 'passed';
    } catch (error) {
      reason = error instanceof Boundary ? error.reason : 'execution_unavailable';
      status = reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    } finally {
      localAbort.abort();
      leafGate.release();
      siblingGate.release();
      parentGate.release();
      let cleanupFailed = false,
        runtimeClosed = false;
      try {
        client?.disposeNetwork();
      } catch {
        cleanupFailed = true;
      }
      if (service) {
        try {
          await service.close();
          runtimeClosed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (!runtimeClosed && runtime) {
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (!runtimeClosed && store) {
        try {
          await store.close();
        } catch {
          cleanupFailed = true;
        }
      }
      checks.resourcesClosed = !cleanupFailed;
      checks.modelAttempts = modelAttempts;
      if (cleanupFailed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      canonicalEvidenceRetained = status !== 'passed' && (!!options.evidenceRoot || cleanupFailed);
      if (!canonicalEvidenceRetained) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
          checks.resourcesClosed = false;
          canonicalEvidenceRetained = existsSync(root);
        }
      }
    }
    cases.push({
      id,
      status,
      checks,
      canonicalEvidenceRetained,
      coverage: [
        'real_root_child_grandchild_and_sibling',
        id === 'cancellation-attached-branch'
          ? 'real_model_interrupt_exact_attached_branch'
          : 'formal_public_root_group_stop',
        'finite_owned_read_gates',
        'no_detached_coverage',
        'no_cross_work_coverage',
        'no_os_process_cleanup_qualification',
        'owned_fixture_policy_not_default_policy',
      ],
      ...(reason ? { reason } : {}),
    });
  }
  return { cases };
}
