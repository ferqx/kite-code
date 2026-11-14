import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord, InteractionRecord, SessionRecord } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { CODEX_BASE_URL, createCodexLocalSource } from '../../../../apps/service/src/codex-auth';
import { readLiveExecutionDirectory } from './approval-execution-fixture';
import { createDefaultApprovalObservation } from './approval-feedback-fixture';
import { createLivePermissionHost } from './collaboration-permissions.live';

export const planningBusinessModes = ['accept_edits', 'auto', 'full'] as const;
export type PlanningBusinessMode = (typeof planningBusinessModes)[number];
export interface PlanningBusinessCase {
  id: string;
  mode: PlanningBusinessMode;
  nextMode?: PlanningBusinessMode;
  actor: 'main' | 'general' | 'explore';
  external: boolean;
  question?: boolean;
}
export const planningBusinessCases: readonly PlanningBusinessCase[] = [
  ...planningBusinessModes.map((mode) => ({
    id: `plan-${mode}`,
    mode,
    actor: 'main' as const,
    external: mode !== 'auto',
  })),
  ...planningBusinessModes.flatMap((mode) =>
    planningBusinessModes
      .filter((next) => next !== mode)
      .map((nextMode) => ({
        id: `pending-${mode}-to-${nextMode}`,
        mode,
        nextMode,
        actor: 'main' as const,
        external: nextMode !== 'auto',
      })),
  ),
  { id: 'direct-general', mode: 'auto', actor: 'general', external: true },
  { id: 'direct-explore', mode: 'full', actor: 'explore', external: false },
  { id: 'question-full', mode: 'full', actor: 'main', external: false, question: true },
  {
    id: 'question-accept_edits',
    mode: 'accept_edits',
    actor: 'main',
    external: true,
    question: true,
  },
];
export const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intent = { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } };

export function selectPlanningBusinessCases(value: string | undefined) {
  const ids = value?.split(',');
  assert(!ids || ids.length === new Set(ids).size, 'duplicate_case');
  assert(
    !ids || ids.every((id) => planningBusinessCases.some((entry) => entry.id === id)),
    'unknown_case',
  );
  return planningBusinessCases.filter((entry) => !ids || ids.includes(entry.id));
}

export interface PlanningBusinessEvidence {
  entry: PlanningBusinessCase;
  storeId: string;
  target: string;
  marker: string;
  effect: string | null;
  records: ExecutionRecord[];
  interactions: InteractionRecord[];
  businessCardId: string;
  finalMode: string;
  runs: { id: string; status: string; isActive: boolean }[];
  sessions: SessionRecord[];
  permissionGrantCount: number;
  pendingEffectAbsent: boolean;
  originalCardSurvivedModeChange: boolean;
}

/** Evidence oracle: neither a saved answer nor a successful outer Tool proves an effect. */
export function verifyPlanningBusinessEvidence(evidence: PlanningBusinessEvidence) {
  const { entry, records, interactions } = evidence;
  assert(evidence.businessCardId, 'business_approval_not_reached');
  assert(evidence.pendingEffectAbsent, 'effect_before_business_approval');
  assert(evidence.originalCardSurvivedModeChange, 'business_card_replaced_on_mode_change');
  assert.equal(
    evidence.finalMode,
    entry.nextMode ?? entry.mode,
    'business_answer_changed_permission_mode',
  );
  assert(
    evidence.runs.length > 0 &&
      evidence.runs.every((run) => run.status === 'completed' && !run.isActive),
    'run_not_completed',
  );
  assert(
    !records.some((row) =>
      ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(row.status),
    ),
    'nonterminal_or_unknown',
  );
  const card = interactions.find((row) => row.id === evidence.businessCardId);
  assert(
    card && card.kind === (entry.question ? 'question' : 'plan_review'),
    'original_business_card_missing',
  );
  assert.equal(card.state, 'answered');
  assert(card.acceptedDecisionRevision, 'saved_answer_not_accepted');
  assert.equal(card.originStoreId, evidence.storeId);
  assert(!Object.hasOwn(object(card.request), 'allowedModes'), 'retired_allowed_modes');
  assert(!Object.hasOwn(object(card.answer), 'mode'), 'retired_answer_mode');
  const review = records.find((row) => row.id === card.executionId);
  assert(review?.status === 'succeeded', 'business_review_tool_failed');
  assert.equal(review.interactionBinding, null, 'business_receipt_became_tool_permission');
  assert.equal(evidence.permissionGrantCount, 0, 'business_receipt_created_reusable_grant');
  assert.equal(
    evidence.sessions.length,
    entry.actor === 'main' ? 1 : 2,
    'unexpected_grandchild_or_missing_direct_child',
  );
  if (entry.actor !== 'main') {
    const child = evidence.sessions.find((session) => session.id !== 's');
    assert.equal(child?.parentSessionId, 's', 'direct_child_lineage_missing');
    const carrier = records.find(
      (row) => row.definitionId === 'task.spawn' && row.status === 'succeeded',
    );
    assert(
      carrier && (object(carrier.input).preset ?? 'general') === entry.actor,
      'wrong_actual_child_role',
    );
    assert.equal(object(object(carrier.result).details).agent_id, child!.id);
    const agent = records.find((row) => row.kind === 'job' && row.childSessionId === child!.id);
    assert(
      agent && agent.parentExecutionId === carrier.id && agent.status === 'succeeded',
      'direct_child_carrier_not_terminal',
    );
  }
  if (!entry.question) {
    assert.equal(object(card.answer).decision, 'approve');
    assert.equal(object(object(review.result).details).decision, 'approve');
    assert(!Object.hasOwn(object(object(review.result).details), 'mode'), 'retired_result_mode');
  }
  const shells = records.filter(
    (row) => row.kind === 'tool' && row.definitionId === 'shell.execute',
  );
  assert.equal(shells.length, 1, 'shell_tool_not_unique');
  assert.equal(shells[0]!.status, 'succeeded');
  assert.equal(shells[0]!.authorization?.dispatched, true);
  if (entry.actor === 'explore')
    assert(
      JSON.stringify(shells[0]!.result).includes(evidence.marker.trim()),
      'read_only_original_output_missing',
    );
  const jobs = records.filter((row) => row.kind === 'job' && row.definitionId === 'shell.command');
  assert.equal(jobs.length, 1, 'own_shell_job_not_unique');
  const job = jobs[0]!;
  assert.equal(job.parentExecutionId, shells[0]!.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.authorization?.dispatched, true);
  const details = object(object(job.result).details),
    native = object(details.ownedProcesses);
  assert.equal(details.exitCode, 0);
  assert.equal(object(native.coalition).processTreeStopped, true);
  assert.equal(object(native.coalition).registrationRemoved, true);
  assert.equal(object(object(native.broker).exit).reaped, true);
  assert.equal(
    evidence.effect,
    entry.actor === 'explore' ? null : evidence.marker,
    'exact_effect_count_or_bytes',
  );
  const checks = records.filter((row) => row.kind === 'model' && row.runId === null);
  assert.equal(
    checks.length,
    (entry.nextMode ?? entry.mode) === 'auto' ? 1 : 0,
    'exact_default_review_count',
  );
  for (const check of checks) {
    assert.equal(check.status, 'succeeded', 'reviewer_failed_or_timed_out');
    const output = object(object(check.result).authorizationCheckOutput);
    assert.equal(output.version, 1);
    assert.equal(object(output.answer).decision, 'approve_once');
    assert.equal(object(output.target).executionId, shells[0]!.id, 'review_target_mismatch');
    assert.equal(object(object(check.result).timing).budgetMs, 8000);
  }
  const targetDecisions = interactions.filter((row) => row.kind === 'approval');
  assert.equal(
    targetDecisions.length,
    (entry.nextMode ?? entry.mode) === 'accept_edits' && entry.external ? 2 : 0,
    'exact_tool_approval_count',
  );
  return { checks: checks.length, toolCards: targetDecisions.length, nativeJobs: jobs.length };
}

export async function runPlanningBusinessCase(options: {
  entry: PlanningBusinessCase;
  root: string;
  provider: 'fixed-loopback' | 'luna';
  signal: AbortSignal;
  /** Controlled negative only: attempt an unavailable Tool through the actual model surface. */
  attemptUnavailableGrandchild?: boolean;
}) {
  const { entry, root, signal } = options;
  assert(
    !options.attemptUnavailableGrandchild ||
      (options.provider === 'fixed-loopback' && entry.actor === 'general'),
    'grandchild_negative_requires_fixed_general',
  );
  mkdirSync(root, { mode: 0o700 });
  const workspace = join(root, 'workspace'),
    external = join(root, 'external');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(external, { mode: 0o700 });
  const target = join(entry.external ? external : workspace, 'effect.txt');
  const marker = `owned-${crypto.randomUUID()}\n`;
  writeFileSync(join(workspace, 'source.txt'), marker, { mode: 0o600 });
  const command =
    entry.actor === 'explore'
      ? `cat ${quote(join(workspace, 'source.txt'))}`
      : `printf %s ${quote(marker)} >> ${quote(target)}`;
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'business' });
  const steps = new Map<string, number>();
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let expectedStoreId = '';
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let restore: (() => void) | undefined;
  const requests: unknown[] = [],
    timeline: unknown[] = [];
  const dispatchObservations: {
    executionId: string;
    authorization: Json;
    began: number;
    ended?: number;
    failure?: { code: unknown; stack: string | undefined };
  }[] = [];
  const storeFailures: { method: string; at: number; code: unknown; stack: string | undefined }[] =
    [];
  const permissionObservations: {
    executionId: string;
    definitionId: string;
    runId: string | null | undefined;
    decision?: unknown;
    failure?: string;
  }[] = [];
  let cleanupConfirmed = false;
  const cleanupFailures: { phase: string; message: string }[] = [];
  let evidence: PlanningBusinessEvidence | undefined;
  let originalRunsForCold: unknown[] = [];
  let failure: unknown;
  const nativeTools = ['files.read', 'shell.execute', 'shell.read', 'shell.wait', 'shell.stop'];
  const childTools = ['task.spawn', 'task.events', 'task.list'];
  async function ownedSessions() {
    assert(store);
    // The ordinary Session directory intentionally hides internal children.
    // Follow only original carrier pointers from this owned root instead.
    const queue = ['s'],
      seen = new Set<string>(),
      sessions: SessionRecord[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      assert(seen.size <= 16, 'unexpected_owned_tree_size');
      const session = await store.getSession(id);
      assert(session, 'original_owned_session_missing');
      sessions.push(session);
      const { executions: rows } = await readLiveExecutionDirectory(store, {
        expectedStoreId,
        sessionId: id,
        subjectId: 'owned-user',
      });
      for (const row of rows) if (row.childSessionId) queue.push(row.childSessionId);
    }
    return sessions;
  }
  async function fixedCall(body: Record<string, Json>) {
    assert(store);
    const names = (body.tools as Json[]).map((tool) => object(object(tool).function).name);
    const child = entry.actor !== 'main' && !names.includes('spawn_agent');
    const actor = child ? 'child' : 'root',
      step = steps.get(actor) ?? 0;
    steps.set(actor, step + 1);
    if (child && options.attemptUnavailableGrandchild && step === 0)
      return {
        name: 'spawn_agent',
        input: { prompt: 'Forbidden grandchild must not be created.' },
      };
    if (child)
      return step === (options.attemptUnavailableGrandchild ? 1 : 0)
        ? {
            name: 'shell_execute',
            input: {
              command,
              filesystem: entry.external ? 'full_access' : 'workspace_write',
              network: 'none',
            },
          }
        : null;
    const sessions = await ownedSessions();
    const sessionId = 's';
    const planWrite = (await store.listExecutions('s'))
      .filter((row) => row.definitionId === 'planning.write' && row.status === 'succeeded')
      .at(-1);
    const planRef = (planWrite?.result as { details?: Record<string, Json> } | undefined)?.details
      ?.plan_ref;
    if (entry.question) {
      if (step === 0)
        return {
          name: 'ask_user',
          input: {
            questions: [
              {
                question: 'Approve the exact owned effect?',
                options: [
                  { label: 'Approve', description: 'Perform the requested effect' },
                  { label: 'Deny', description: 'Do not perform it' },
                ],
              },
            ],
          },
        };
      if (step === 1)
        return {
          name: 'shell_execute',
          input: {
            command,
            filesystem: entry.external ? 'full_access' : 'workspace_write',
            network: 'none',
          },
        };
      return null;
    }
    if (step === 0)
      return {
        name: 'write_plan',
        input: {
          plan_id: 'owned',

          title: 'One owned operation',
          body: 'Ask the human before the exact owned operation.',
          steps: [{ id: 'effect', title: 'Perform the exact owned operation' }],
        },
      };
    if (step === 1)
      return {
        name: 'request_plan_review',
        input: { plan_ref: planRef! },
      };
    if (step === 2)
      return entry.actor === 'main'
        ? {
            name: 'shell_execute',
            input: {
              command,
              filesystem: entry.external ? 'full_access' : 'workspace_write',
              network: 'none',
            },
          }
        : {
            name: 'spawn_agent',
            input: {
              preset: entry.actor,
              prompt: `Perform only this owned command: ${command}. ${entry.actor === 'explore' ? 'Read only; do not write.' : 'Append exactly once.'} Do not spawn another agent.`,
            },
          };
    if (step >= 3) {
      const progress = object(
        (
          await store.getExtensionRecord({
            sessionId,
            extensionId: 'builtin.planning',
            key: 'progress/owned/1',
          })
        )?.value,
      );
      if (progress.completePlan === true) return null;
      if (entry.actor !== 'main') {
        const childRuns = (
          await Promise.all(
            sessions
              .filter((session) => session.id !== 's')
              .map((session) => store!.getView(session.id)),
          )
        ).flatMap((view) => view.runs);
        if (!childRuns.length || childRuns.some((run) => run.isActive))
          return { name: 'wait_agent_events', input: { wait_ms: 1000 } };
      }
      const rows = await store.listExecutions('s');
      const operation = rows.find(
        (row) =>
          row.definitionId === (entry.actor === 'main' ? 'shell.execute' : 'task.spawn') &&
          row.status === 'succeeded',
      );
      // Preserve the actual failed Tool receipt in the evidence instead of
      // throwing from Bun's test-provider callback before the owner can close.
      if (!operation) return null;
      assert(sessions.length >= 1);
      return {
        name: 'update_plan_progress',
        input: {
          plan_ref: planRef!,
          progress_ref: null,
          step_id: 'effect',
          status: 'completed',
          execution_id: operation.id,
          complete_plan: true,
        },
      };
    }
    return null;
  }
  const provider =
    options.provider === 'fixed-loopback'
      ? Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const body = (await request.json()) as Record<string, Json>;
            const messages = body.messages as Json[];
            let reviewer = false;
            try {
              reviewer = ['shell_risk', 'authorization_check'].includes(
                String(
                  object(
                    JSON.parse(
                      String(
                        object(
                          messages
                            .slice()
                            .reverse()
                            .find((message) => object(message).role === 'user'),
                        ).content,
                      ),
                    ),
                  ).purpose,
                ),
              );
            } catch {}
            requests.push({ role: reviewer ? 'reviewer' : 'business', body });
            const call = reviewer ? null : await fixedCall(body);
            const chunk = {
              id: crypto.randomUUID(),
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixed-local',
              choices: [
                {
                  index: 0,
                  delta: call
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: crypto.randomUUID(),
                            type: 'function',
                            function: { name: call.name, arguments: JSON.stringify(call.input) },
                          },
                        ],
                      }
                    : {
                        content: reviewer
                          ? JSON.stringify({
                              risk: 'ordinary',
                              reason: 'Exact owned local fixture operation.',
                            })
                          : 'Observed the actual original tool result.',
                      },
                  finish_reason: null,
                },
              ],
            };
            return new Response(
              `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            );
          },
        })
      : undefined;
  const observation = createDefaultApprovalObservation({
    modelId: 'business',
    signal,
    metadata: {
      qualification:
        options.provider === 'luna'
          ? 'original-production-adapters-luna-medium-reviewer-low'
          : 'fixed-loopback-business-and-reviewer-not-real-model',
      model: options.provider === 'luna' ? 'gpt-6-luna' : 'fixed-local',
    },
  });
  try {
    const source = options.provider === 'luna' ? createCodexLocalSource() : false;
    const discovery = source ? source.discover() : null;
    assert(!source || discovery, 'original_codex_session_unavailable');
    const configuredModel = source
      ? {
          id: 'business',
          provider: 'codex',
          providerName: discovery!.alias,
          model: 'gpt-6-luna',
          baseURL: CODEX_BASE_URL,
          protocol: 'responses',
          enabled: true,
          options: { reasoningEffort: 'medium' },
        }
      : {
          id: 'business',
          provider: 'compatible',
          model: 'fixed-local',
          baseURL: `http://127.0.0.1:${provider!.port}/v1`,
          options: { reasoningEffort: 'medium' },
        };
    const host = await createLivePermissionHost({
      root,
      profile,
      modelId: 'business',
      toolIds: [
        ...nativeTools,
        ...(entry.actor !== 'main' ? childTools : []),
        ...(entry.question ? ['ask_user'] : []),
      ],
      hostModel: {
        configuration: { modelId: 'business', models: [configuredModel] } as Json,
        localCodex: source,
      },
    });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    store = new Proxy(store, {
      get(target, key) {
        if (key === 'markDispatching')
          return (input: Parameters<typeof target.markDispatching>[0]) => {
            const observed: (typeof dispatchObservations)[number] = {
              executionId: input.executionId,
              authorization: structuredClone(input.authorization) as unknown as Json,
              began: Date.now(),
            };
            dispatchObservations.push(observed);
            const original = target.markDispatching(input);
            // Observation only: preserve the original native Promise and rejection.
            void original.then(
              () => {
                observed.ended = Date.now();
              },
              (error) => {
                observed.ended = Date.now();
                observed.failure = {
                  code: object(error).code,
                  stack: error instanceof Error ? error.stack : String(error),
                };
              },
            );
            return original;
          };
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const failed = (error: unknown) => {
            storeFailures.push({
              method: String(key),
              at: Date.now(),
              code: object(error).code,
              stack: error instanceof Error ? error.stack : String(error),
            });
          };
          let original: unknown;
          try {
            original = Reflect.apply(value, target, args);
          } catch (error) {
            failed(error);
            throw error;
          }
          if (original instanceof Promise) void original.then(() => {}, failed);
          return original;
        };
      },
    });
    expectedStoreId = (await store.getMetadata()).storeId;
    locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    const instrument = (binding: RunConfiguration): RunConfiguration => ({
      ...binding,
      ...(binding.model ? { model: observation.wrap(binding.model, 'business') } : {}),
      ...(binding.authorizationCheck
        ? {
            authorizationCheck: {
              ...binding.authorizationCheck,
              model: observation.wrap(binding.authorizationCheck.model, 'reviewer'),
            },
          }
        : {}),
      permissions: {
        ...binding.permissions!,
        async authorize(request) {
          const input = object(request.input);
          if (
            (['shell.execute', 'shell.command'].includes(request.definitionId) &&
              input.command !== command) ||
            (request.definitionId.startsWith('files.') &&
              input.path !== join(workspace, 'source.txt') &&
              input.path !== 'source.txt')
          )
            return {
              allowed: false,
              revision: 'owned-business-probe-1',
              reason: 'owned_probe_out_of_scope',
            };
          try {
            const decision = await binding.permissions!.authorize(request);
            permissionObservations.push({
              executionId: request.executionId,
              definitionId: request.definitionId,
              runId: request.runId,
              decision: structuredClone(decision),
            });
            return decision;
          } catch (error) {
            permissionObservations.push({
              executionId: request.executionId,
              definitionId: request.definitionId,
              runId: request.runId,
              failure: error instanceof Error ? error.stack : String(error),
            });
            throw error;
          }
        },
      },
    });
    restore = observation.install();
    runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      resolveRunConfiguration: async (input) =>
        instrument(await host.resolveRunConfiguration!(input)),
      resolveChildRunConfiguration: async (input) =>
        instrument(await host.resolveChildRunConfiguration!(input)),
    });
    const serviceProfile = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      profile: serviceProfile,
      subjectId: 'owned-user',
      buildId: 'planning-business-validation',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: serviceProfile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'interactions', 'permission_controls'],
      },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned planning probe',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: entry.id,
    });
    let revision = 0;
    const setMode = async (mode: PlanningBusinessMode) => {
      const current = await client!.getPermissionMode('s', { storeId: expectedStoreId });
      const result = await client!.setPermissionMode('s', {
        expectedStoreId,
        commandId: `mode-${++revision}`,
        mode,
        makeDefault: false,
        ifRevision: current.revision,
        ifDefaultRevision: current.defaultRevision,
      });
      assert.equal(result.state, 'applied');
      timeline.push({ at: Date.now(), phase: 'mode', mode });
    };
    const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId,
      commandId: 'trust',
      trusted: true,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    await setMode(entry.mode);
    const task = entry.question
      ? `Before any effect ask me one Approve/Deny question with ask_user. Wait for my original answer. If approved execute exactly ${command} with ${entry.external ? 'full_access' : 'workspace_write'}/no-network. No other command or effect.`
      : `This is one bounded tool/permission verification. Save a plan with one step effect; request_plan_review for the exact plan version/digest and wait for my answer. Do not choose or change permission mode. After approval ${entry.actor === 'main' ? `execute exactly ${command} with ${entry.external ? 'full_access' : 'workspace_write'}/no-network` : `spawn exactly one ${entry.actor} agent to execute only ${command}; it must ${entry.actor === 'explore' ? 'read only' : 'append exactly once'}, and cannot spawn. Wait for its actual terminal result`}. Complete the plan step using the actual successful original ${entry.actor === 'main' ? 'shell_execute' : 'spawn_agent'} execution receipt. The completion execution_id must be the real Execution UUID, never shell_id or an operation key. Use the original receipt visible in context. If its identity is unavailable, report the missing evidence rather than inventing an ID or re-executing the effect. Do not repeat the effect. No other paths, network or effects. Tool/permission results matter; no special final response format is required.`;
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: task,
      ...(!entry.question ? { extensionInputs: [intent] } : {}),
    });
    let businessCardId = '',
      pendingEffectAbsent = false,
      originalCardSurvivedModeChange = false;
    const answered = new Set<string>();
    for (;;) {
      signal.throwIfAborted();
      const sessions = await ownedSessions();
      for (const session of sessions) {
        const page: Awaited<ReturnType<ReturnType<typeof createClient>['listInteractions']>> =
          await client.listInteractions(session.id, {
            storeId: expectedStoreId,
            state: 'pending',
          });
        for (const card of page.interactions) {
          if (answered.has(card.id)) continue;
          timeline.push({ at: Date.now(), phase: 'pending', card });
          const execution: ExecutionRecord | null = await store.getExecution(card.executionId);
          assert(execution);
          if (card.kind === 'plan_review' || card.kind === 'question') {
            assert.equal(businessCardId, '', 'unexpected_extra_business_card');
            businessCardId = card.id;
            pendingEffectAbsent = !existsSync(target);
            assert(pendingEffectAbsent);
            assert(!Object.hasOwn(object(card.request), 'allowedModes'), 'retired_allowed_modes');
            if (entry.nextMode) await setMode(entry.nextMode);
            const same: Awaited<ReturnType<ReturnType<typeof createClient>['getInteraction']>> =
              await client.getInteraction(card.sessionId, card.id, {
                storeId: expectedStoreId,
              });
            assert.equal(same.state, 'pending');
            assert.deepEqual(same.request, card.request);
            assert.equal(same.revision, card.revision);
            originalCardSurvivedModeChange = true;
            let answer:
              | { kind: 'plan_review'; decision: 'approve' }
              | { kind: 'question'; answers: Json } = { kind: 'plan_review', decision: 'approve' };
            if (card.kind === 'question') {
              const branch = object((object(object(card.request).schema).oneOf as Json[])[0]);
              answer = {
                kind: 'question',
                answers: Object.fromEntries(
                  Object.entries(object(branch.properties)).map(([key, value]) => [
                    key,
                    object((object(value).anyOf as Json[])[0]).const!,
                  ]),
                ),
              };
            }
            await client.answerInteraction(card.presentationSessionId, card.id, {
              expectedStoreId,
              commandId: `answer-${card.id}`,
              expectedRevision: card.revision,
              answer,
            });
          } else {
            assert(
              ['shell.execute', 'shell.command', 'task.spawn'].includes(execution.definitionId!),
              'unexpected_tool_approval',
            );
            if (execution.definitionId !== 'task.spawn')
              assert.equal(object(execution.input).command, command);
            assert(businessCardId, 'effect_permission_before_business_card');
            await client.answerInteraction(card.presentationSessionId, card.id, {
              expectedStoreId,
              commandId: `answer-${card.id}`,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            });
          }
          answered.add(card.id);
        }
      }
      const runs = (
        await Promise.all(sessions.map((session) => store!.getView(session.id)))
      ).flatMap((view) => view.runs);
      if (runs.length && runs.every((run) => !run.isActive)) {
        const rows = (
          await Promise.all(
            sessions.map((session) =>
              readLiveExecutionDirectory(store!, {
                expectedStoreId,
                sessionId: session.id,
                subjectId: 'owned-user',
                signal,
              }),
            ),
          )
        ).flatMap((page) => page.executions);
        const publicInteractions = (
          await Promise.all(
            sessions.map((session) =>
              client!.listInteractions(session.id, { storeId: expectedStoreId }),
            ),
          )
        ).flatMap((page) => page.interactions);
        const interactions = await Promise.all(
          publicInteractions.map(async (card) => {
            const actual = await store!.getInteraction({
              expectedStoreId,
              sessionId: card.sessionId,
              interactionId: card.id,
            });
            assert(actual, 'original_interaction_missing');
            return actual;
          }),
        );
        const completed: PlanningBusinessEvidence = {
          entry,
          storeId: expectedStoreId,
          target,
          marker,
          effect: existsSync(target) ? readFileSync(target, 'utf8') : null,
          records: rows,
          interactions,
          // Private model connection configuration stays in the original Store,
          // never in this report. Cold comparison below still checks every byte.
          runs: runs.map((run) => ({ id: run.id, status: run.status, isActive: run.isActive })),
          sessions,
          permissionGrantCount: (
            await Promise.all(
              sessions.map((session) =>
                store!.listPermissionGrants({
                  expectedStoreId,
                  sessionId: session.id,
                  subjectId: 'owned-user',
                  limit: 200,
                }),
              ),
            )
          ).reduce((count, page) => count + page.items.length, 0),
          businessCardId,
          pendingEffectAbsent,
          originalCardSurvivedModeChange,
          finalMode: (await client.getPermissionMode('s', { storeId: expectedStoreId })).mode,
        };
        originalRunsForCold = runs;
        evidence = completed;
        verifyPlanningBusinessEvidence(completed);
        break;
      }
      await Bun.sleep(10);
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const [phase, close] of [
      ['service', () => service?.close()],
      ['runtime', () => runtime?.close()],
      ['workspace-locks', () => locks?.close()],
      ['client-network', () => client?.disposeNetwork()],
    ] as const) {
      try {
        await close();
      } catch (error) {
        failure ??= error;
        cleanupFailures.push({
          phase,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    cleanupConfirmed = cleanupFailures.length === 0;
    restore?.();
    provider?.stop(true);
  }
  let cold: unknown = null;
  if (cleanupConfirmed && evidence) {
    const reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    try {
      const beforeColdRequests = observation.logical.length;
      const originals = (
        await Promise.all(
          evidence.sessions.map((session) =>
            readLiveExecutionDirectory(reader, {
              expectedStoreId: evidence!.storeId,
              sessionId: session.id,
              subjectId: 'owned-user',
            }),
          ),
        )
      ).flatMap((page) => page.executions);
      assert(isDeepStrictEqual(originals, evidence.records), 'cold_execution_changed');
      const coldRuns = await Promise.all(evidence.runs.map((run) => reader.getRun(run.id)));
      assert(isDeepStrictEqual(coldRuns, originalRunsForCold), 'cold_run_changed');
      assert.equal(existsSync(target) ? readFileSync(target, 'utf8') : null, evidence.effect);
      assert.equal(observation.logical.length, beforeColdRequests, 'cold_model_replayed');
      cold = {
        executions: originals.length,
        runs: coldRuns.length,
        runDigest: hash(coldRuns),
        digest: hash(originals),
        sameRows: true,
        sameEffects: true,
        providerRequests: 0,
      };
    } catch (error) {
      failure ??= error;
    } finally {
      await reader.close();
    }
  }
  const reportEvidence: PlanningBusinessEvidence | undefined = evidence
    ? {
        ...evidence,
        records: evidence.records.map((row) => ({
          ...row,
          ...(row.childConfiguration
            ? {
                childConfiguration: {
                  ...row.childConfiguration,
                  snapshot: {
                    privateConfigurationOmitted: true,
                    sha256: hash(row.childConfiguration.snapshot),
                  },
                },
              }
            : {}),
          ...(object(row.afterTurn).configuration
            ? {
                afterTurn: {
                  ...object(row.afterTurn),
                  configuration: {
                    privateConfigurationOmitted: true,
                    sha256: hash(object(row.afterTurn).configuration),
                  },
                },
              }
            : {}),
        })),
      }
    : undefined;
  const result = {
    id: entry.id,
    cohort: options.attemptUnavailableGrandchild
      ? 'controlled-negative-grandchild-boundary-not-positive-denominator'
      : 'positive-planning-business',
    qualification:
      options.provider === 'luna'
        ? 'actual-luna-medium-original-production-bindings'
        : 'fixed-loopback-not-Luna-real-Service-SQLite-native-Shell',
    status: failure ? 'failed' : 'passed',
    failure:
      failure instanceof Error
        ? { name: failure.name, message: failure.message }
        : failure
          ? String(failure)
          : null,
    cleanupConfirmed,
    cleanupFailures,
    cold,
    evidence: reportEvidence,
    configurationQualification:
      'Connection configuration remains in the original owned Store. Report omits Run configuration and seals child/after-turn private configuration by digest; cold equality covers original complete rows.',
    timeline,
    dispatchObservations,
    storeFailures,
    permissionObservations,
    requests,
    logical: observation.logical,
    physical: observation.physical,
    modelRequests: observation.requests,
    calls: observation.calls,
    usage: observation.usage,
  };
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}
