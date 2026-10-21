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

const ids = ['A04-active-follow-up', 'C01-spawn-response-loss'] as const;
export type LiveCommandRaceCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveCommandRaceCaseId;
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
        abort = () => reject(Error('live_command_race_aborted'));
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
/** Explicit isolated artifact; no Provider/configuration access or top-level execution. */
export async function runLiveCommandRaces(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_command_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-command-race-')),
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const firstFact = `material-${randomUUID()}`;
    const nextFact = `requirement-${randomUUID()}`;
    writeFileSync(join(workspace, 'initial.txt'), `verified_initial=${firstFact}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(workspace, 'additional.txt'), `verified_additional=${nextFact}\n`, {
      mode: 0o600,
    });
    const guidance = `Additional requirement ${nextFact}: read material additional exactly once, preserve the actual initial material fact, and include BOTH complete actual facts in your final result. Do not delegate or start another turn.`;
    const initial =
      'Use read_command_material with material initial exactly once; report its complete actual fact. Do not guess, delegate, send messages or call control tools. If same-work guidance arrives while the read is pending, retain the first read and incorporate the new requirement in this same turn.';
    const checks: Result['checks'] = {};
    let status: Result['status'] = 'inconclusive';
    let reason: Result['reason'];
    let failurePoint: string | undefined;
    let retained = false;
    const firstRequest = options.requests().length;
    const childReady = gate(),
      childRelease = gate(),
      commandRelease = gate(),
      childModelReady = gate(),
      replayRelease = gate();
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let childRead: { sessionId: string; runId: string | null; executionId: string } | undefined;
    let followInput:
      | Parameters<Awaited<ReturnType<typeof openSqliteStore>>['applyAgentCommand']>[0]
      | undefined;
    let followReceipt:
      | Awaited<ReturnType<Awaited<ReturnType<typeof openSqliteStore>>['applyAgentCommand']>>
      | undefined;
    let spawnInput:
      | Parameters<Awaited<ReturnType<typeof openSqliteStore>>['ensureOperation']>[0]
      | undefined;
    let spawnRef:
      | Awaited<ReturnType<Awaited<ReturnType<typeof openSqliteStore>>['ensureOperation']>>
      | undefined;
    let lost = 0,
      recoveredReads = 0,
      childReadAborts = 0,
      initialReads = 0,
      additionalReads = 0;
    let replayComplete = false,
      childModelHeld = false,
      followCommitted = false;
    let childAfterGuidanceWithFacts = false;
    const requireBranch = (condition: unknown, point: string) => {
      if (!condition) throw new Boundary('branch_not_reached', point);
    };
    const assert = (condition: unknown, point: string) => {
      checks[point] = Boolean(condition);
      if (!condition) throw new Boundary('oracle_violation', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      const deadline = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), options.signal);
      }
    }
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      // Private fixture observation only: the public listSessions directory excludes children.
      // Read the actual owned canonical database without changing its schema, rows or cursors.
      const sessionSnapshot = () => {
        const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return database.query('SELECT id, parent_id, root_id FROM session ORDER BY id').all() as {
            id: string;
            parent_id: string | null;
            root_id: string;
          }[];
        } finally {
          database.close();
        }
      };
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const originalEnsure = owned.ensureOperation.bind(owned);
      const originalGet = owned.getOperation.bind(owned);
      owned.getOperation = async (input) => {
        const value = await originalGet(input);
        if (
          lost &&
          spawnInput &&
          input.key === spawnInput.operationKey &&
          input.sessionId === 'root' &&
          value?.executionId === spawnRef?.executionId
        )
          recoveredReads++;
        return value;
      };
      owned.ensureOperation = async (input) => {
        const value = await originalEnsure(input);
        if (
          id === 'C01-spawn-response-loss' &&
          input.sessionId === 'root' &&
          input.collaborationCompletion &&
          lost === 0
        ) {
          spawnInput = structuredClone(input);
          spawnRef = structuredClone(value);
          assert(
            Boolean(await owned.getCommand(value.commandId)) &&
              Boolean(await owned.getExecution(value.executionId!)) &&
              Boolean(await owned.getSession(value.childSessionId!)),
            'durable_spawn_commit_exists_before_response_loss',
          );
          lost++;
          throw Error('isolated_spawn_response_lost_after_real_commit');
        }
        return value;
      };
      const originalApply = owned.applyAgentCommand.bind(owned);
      owned.applyAgentCommand = async (input) => {
        if (id !== 'A04-active-follow-up' || input.kind !== 'follow_up')
          return originalApply(input);
        await wait(childReady.promise, options.signal);
        followInput = structuredClone(input);
        followReceipt = await originalApply(input);
        followCommitted = true;
        await wait(commandRelease.promise, options.signal);
        return followReceipt;
      };
      const reader: ToolDefinition = {
        id: 'live.command-material',
        version: '1',
        model: { name: 'read_command_material' },
        description:
          'Read one actual complete owned synthetic material. The initial read may take time; never replace, cancel or fabricate a pending read.',
        inputSchema: {
          type: 'object',
          properties: { material: { type: 'string', enum: ['initial', 'additional'] } },
          required: ['material'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const material = object(input).material;
          if (context.sessionId === 'root' || !['initial', 'additional'].includes(String(material)))
            return {
              outcome: 'failed',
              content: 'Only the delegated child may read these materials.',
            };
          if (material === 'initial') {
            initialReads++;
            childRead = {
              sessionId: context.sessionId,
              runId: context.runId,
              executionId: context.executionId,
            };
            childReady.release();
            if (id === 'A04-active-follow-up') {
              try {
                await wait(childRelease.promise, AbortSignal.any([options.signal, context.signal]));
              } catch (error) {
                if (context.signal.aborted) childReadAborts++;
                throw error;
              }
            }
          } else additionalReads++;
          return {
            outcome: 'succeeded',
            content: readFileSync(
              join(workspace, material === 'initial' ? 'initial.txt' : 'additional.txt'),
              'utf8',
            ),
          };
        },
      };
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          const signal = AbortSignal.any([options.signal, context.signal]);
          const execution = await owned.getExecution(request.requestId);
          if (id === 'C01-spawn-response-loss') {
            if (execution?.sessionId !== 'root') {
              childModelHeld = true;
              childModelReady.release();
              await wait(replayRelease.promise, signal);
            } else if (lost && !replayComplete) {
              await wait(childModelReady.promise, signal);
              requireBranch(spawnInput && spawnRef, 'original_spawn_not_captured');
              const parentTools = (await owned.listExecutions('root')).filter(
                (row) => row.definitionId === 'task.spawn',
              );
              assert(
                parentTools.length === 1 && parentTools[0]?.status === 'succeeded',
                'host_recovered_original_spawn_tool',
              );
              assert(recoveredReads === 1, 'host_exact_operation_recovery_read_once');
              const before = (await owned.getMetadata()).lastChangeCursor;
              const beforeSessions = sessionSnapshot();
              const beforeRows = (await owned.getView('root')).executions
                .filter((row) => row.childSessionId)
                .map((row) => row.id);
              const beforeRuns = (await owned.getView(spawnRef!.childSessionId!)).runs.map(
                (row) => row.id,
              );
              const repeat = await originalEnsure(spawnInput!);
              assert(
                isDeepStrictEqual(repeat, spawnRef),
                'same_invocation_returns_exact_original_ref',
              );
              assert(
                (await owned.getMetadata()).lastChangeCursor === before,
                'same_invocation_replay_zero_store_cursor',
              );
              assert(
                isDeepStrictEqual(
                  (await owned.getView('root')).executions
                    .filter((row) => row.childSessionId)
                    .map((row) => row.id),
                  beforeRows,
                ) &&
                  isDeepStrictEqual(
                    (await owned.getView(spawnRef!.childSessionId!)).runs.map((row) => row.id),
                    beforeRuns,
                  ),
                'same_invocation_replay_zero_new_carrier_or_run',
              );
              assert(
                isDeepStrictEqual(sessionSnapshot(), beforeSessions),
                'same_invocation_replay_zero_new_session',
              );
              replayComplete = true;
              replayRelease.release();
            }
          }
          if (
            id === 'A04-active-follow-up' &&
            execution?.sessionId === childRead?.sessionId &&
            childRead?.runId === execution?.runId
          ) {
            const contents = request.messages.map((message) => message.content).join('\n');
            if (contents.includes(firstFact) && contents.includes(guidance))
              childAfterGuidanceWithFacts = true;
          }
          for await (const event of options.model.stream(request, { signal })) yield event;
        },
      };
      runtime = createRuntime({
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        model,
        modelId: options.modelId,
        modelConcurrency: 4,
        extensions: [
          { id: 'live.command-fixture', version: '1', apiMajor: 1, tools: [reader] },
          createTaskExtension({
            roles: [
              {
                id: 'worker',
                configurationId: 'worker',
                description: 'Finite synthetic owned-material worker.',
              },
            ],
          }),
        ],
        permissions: {
          authorize: async () => ({ allowed: true, revision: 'owned-command-race-only' }),
        },
        afterTurn: {
          authorize: async () => ({ allowed: true, revision: 'owned-command-race-only' }),
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
        buildId: 'live-command-races',
        subjectId: 'live-command-owner',
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
        name: 'Owned live command case',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 'root',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Live command race',
      });
      await client.startRun(
        'root',
        {
          expectedStoreId,
          commandId: 'work',
          kind: 'run.start',
          content: `New task: Delegate exactly ONE collaborator using spawn_agent, prompt only and no preset, with this complete assignment: ${JSON.stringify(initial)}. ${id === 'A04-active-follow-up' ? `Immediately after spawn returns, call follow_up_agent exactly once using its exact returned agent_id and this content: ${JSON.stringify(guidance)}. Do this before waiting; the child initial read may be pending. ` : ''}Then use wait_agent_events and list_agents with the exact ID to obtain the actual completed result. Do not read materials yourself, spawn replacements, send messages, interrupt, repeat mutation calls or invent facts. Keep observing finite waits until the original collaborator is terminal; then report its complete verified facts.`,
        },
        { signal: options.signal },
      );
      if (id === 'A04-active-follow-up') {
        await until(
          async () => (followCommitted ? true : undefined),
          'active_follow_up_not_committed',
        );
        requireBranch(
          childRead?.runId && followInput && followReceipt,
          'active_child_original_identity_missing',
        );
        const originalCarrier = (await owned.listExecutions('root')).find(
          (row) => row.childSessionId === childRead!.sessionId,
        );
        requireBranch(originalCarrier, 'original_carrier_missing');
        const assignment = structuredClone(
          (await owned.getCommand(originalCarrier!.originCommandId))?.request,
        );
        const pending = await owned.getCommand(`${followInput!.commandId}-input`);
        assert(
          followReceipt!.receipt.accepted === true && followReceipt!.receipt.mode === 'steer',
          'active_follow_up_receipt_is_steer',
        );
        assert(
          object(pending?.request).targetRunId === childRead!.runId &&
            object(pending?.request).contextSelectionId ===
              (await owned.getRun(childRead!.runId!))?.contextSelectionId &&
            object(JSON.parse(String(object(pending?.request).content))).carrierExecutionId ===
              originalCarrier!.id,
          'guidance_pins_exact_original_run_context_and_carrier',
        );
        const initialTool = await owned.getExecution(childRead!.executionId);
        assert(
          initialTool?.authorization?.dispatched === true &&
            ['running', 'dispatching'].includes(initialTool.status) &&
            !initialTool.cancelRequestedAt &&
            childReadAborts === 0,
          'original_dispatched_tool_remains_active_and_unaborted',
        );
        assert(
          (await owned.getView(childRead!.sessionId)).runs.length === 1 &&
            (await owned.getRun(childRead!.runId!))?.isActive,
          'no_successor_while_original_tool_held',
        );
        childRelease.release();
        commandRelease.release();
        await until(
          async () =>
            (await owned.getExecution(originalCarrier!.id))?.status === 'succeeded'
              ? true
              : undefined,
          'original_carrier_did_not_finish',
        );
        assert(
          isDeepStrictEqual(
            (await owned.getCommand(originalCarrier!.originCommandId))?.request,
            assignment,
          ),
          'original_assignment_immutable',
        );
        assert(
          childAfterGuidanceWithFacts,
          'actual_same_run_model_prepared_with_guidance_and_tool_material',
        );
      } else {
        await until(
          async () => (replayComplete ? true : undefined),
          'spawn_response_loss_recovery_not_reached',
        );
        assert(lost === 1 && childModelHeld, 'one_post_commit_loss_and_original_child_model_gate');
      }
      const carrier = await until(
        async () =>
          (await owned.listExecutions('root')).find(
            (row) =>
              row.childSessionId &&
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status),
          ) ?? undefined,
        'original_child_result_not_settled',
      );
      const leaf = carrier.childSessionId!;
      const leafView = await owned.getView(leaf);
      const rootView = await until(async () => {
        const view = await owned.getView('root');
        return view.runs.length > 0 &&
          view.runs.every((run) => !run.isActive) &&
          !view.executions.some((row) => ['planned', 'dispatching', 'running'].includes(row.status))
          ? view
          : undefined;
      }, 'parent_did_not_settle');
      const sessions = sessionSnapshot();
      assert(
        (await owned.listExecutions('root')).filter((row) => row.childSessionId).length === 1 &&
          leafView.runs.length === 1 &&
          sessions.length === 2 &&
          sessions.some(
            (session) =>
              session.id === 'root' && session.parent_id === null && session.root_id === 'root',
          ) &&
          sessions.some(
            (session) =>
              session.id === leaf && session.parent_id === 'root' && session.root_id === 'root',
          ),
        'unique_original_child_session_carrier_and_run',
      );
      assert(
        carrier.status === 'succeeded' && leafView.runs[0]?.status === 'completed',
        'original_child_run_and_carrier_completed',
      );
      assert(
        initialReads === 1 &&
          childReadAborts === 0 &&
          (await owned.getExecution(childRead!.executionId))?.status === 'succeeded',
        'original_material_tool_succeeded_once_without_abort',
      );
      const resultText = String(object(carrier.result).content ?? '');
      assert(
        resultText.includes(firstFact) &&
          (id !== 'A04-active-follow-up' || resultText.includes(nextFact)),
        'real_child_result_contains_actual_required_material_facts',
      );
      assert(
        additionalReads === (id === 'A04-active-follow-up' ? 1 : 0),
        'only_expected_actual_material_reads',
      );
      assert(
        rootView.executions.some(
          (row) => row.definitionId === 'task.events' && row.status === 'succeeded',
        ) &&
          rootView.executions.some(
            (row) => row.definitionId === 'task.list' && row.status === 'succeeded',
          ),
        'real_parent_observed_original_result_with_public_tools',
      );
      const finalCarrier = await owned.getExecution(carrier.id);
      const acceptance = finalCarrier?.resultAcceptance;
      assert(
        Boolean(acceptance?.runId) &&
          acceptance?.resultRevision === finalCarrier?.resultRevision &&
          acceptance?.selectionId === (await owned.getRun(acceptance!.runId!))?.contextSelectionId,
        'original_carrier_exact_result_revision_has_pinned_acceptance',
      );
      const acceptedRequests: { sourceCount: number; exactFacts: boolean }[] = [];
      for (const request of options.requests().slice(firstRequest)) {
        const modelExecution = await owned.getExecution(request.requestId);
        if (modelExecution?.sessionId !== 'root' || modelExecution.runId !== acceptance!.runId)
          continue;
        const messages = request.messages.filter((message) =>
          message.sourceIds?.includes(acceptance!.sourceId),
        );
        const sourceCount = messages.reduce(
          (count, message) =>
            count +
            (message.sourceIds?.filter((sourceId) => sourceId === acceptance!.sourceId).length ??
              0),
          0,
        );
        if (sourceCount === 0) continue;
        const content = messages.map((message) => message.content).join('\n');
        acceptedRequests.push({
          sourceCount,
          exactFacts:
            content.includes(firstFact) &&
            (id !== 'A04-active-follow-up' || content.includes(nextFact)),
        });
      }
      assert(
        acceptedRequests.length > 0 &&
          acceptedRequests.every((request) => request.sourceCount === 1),
        'pinned_accepted_parent_run_actual_model_contains_exact_source_once',
      );
      assert(
        acceptedRequests.some((request) => request.exactFacts),
        'exact_accepted_source_prepared_with_actual_child_material_facts',
      );
      checks.acceptedSourceModelRequests = acceptedRequests.length;
      assert(
        options.requests().length - firstRequest > 0 &&
          options.requests().length - firstRequest <= 40,
        'counted_adapter_attempts_within_case_limit',
      );
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
      const failedCheck = Object.entries(checks).find(([, value]) => value === false);
      if (failedCheck) {
        status = 'failed';
        reason = 'oracle_violation';
        failurePoint = failedCheck[0];
      }
    } finally {
      childRelease.release();
      commandRelease.release();
      replayRelease.release();
      childReady.release();
      childModelReady.release();
      let closed = true;
      try {
        client?.disposeNetwork();
      } catch {
        closed = false;
      }
      let runtimeClosed = false;
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
      coverage:
        id === 'A04-active-follow-up'
          ? [
              'active_same_work_follow_up_during_actual_tool',
              'same_run_safe_boundary',
              'owned_allow_fixture_not_default_policy',
              'no_late_R1_R2_or_cross_work_qualification',
            ]
          : [
              'spawn_real_commit_then_single_response_loss',
              'original_invocation_recovery_and_exact_store_replay',
              'owned_allow_fixture_not_default_policy',
              'no_unaccepted_unknown_follow_up_interrupt_or_new_invocation_qualification',
            ],
    });
  }
  return { cases };
}
