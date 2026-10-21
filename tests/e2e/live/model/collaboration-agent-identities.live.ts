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
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = ['A09-same-name-missing-id-and-owned-store-negative-probes'] as const;
export type LiveAgentIdentityCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type Control = Parameters<Store['applyAgentCommand']>[0];
type Dispatch = Parameters<Store['markDispatching']>[0];
type Ref = Awaited<ReturnType<Store['ensureOperation']>>;
interface Result {
  id: LiveAgentIdentityCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  modelBranches: {
    kind: 'same_display_name' | 'nonexistent_id';
    attempted: boolean;
    rejected: boolean;
    actualToolResultSha256?: string;
  }[];
  trustedStorePortProbes: { kind: string; reached: boolean; code: string; unchanged: boolean }[];
  proofHashes: Record<string, string>;
  coverage: string[];
  gaps: string[];
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    )
    .digest('hex');
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
        abort = () => reject(Error('live_identity_aborted'));
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
/** Private owned-allow fixture. Models and responses are never synthesized. Host
 * probes use the trusted public Store port, NOT ordinary SDK/HTTP control authority.
 * Caller owns physical <=40 HTTP/600s enforcement; all stream paths share its adapter.
 */
export async function runLiveAgentIdentities(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_identity_evidence_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    const cleanup = new AbortController();
    const signal = AbortSignal.any([options.signal, cleanup.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-identities-')),
    );
    const checks: Result['checks'] = {},
      proofHashes: Result['proofHashes'] = {},
      probes: Result['trustedStorePortProbes'] = [];
    const requestStart = options.requests().length;
    const releaseReads = gate();
    let store: Store | undefined,
      foreignStore: Store | undefined,
      runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined,
      client: ReturnType<typeof createClient> | undefined;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined,
      retained = true;
    let adapterStarts = 0,
      parentReadCount = 0,
      hostProbeCount = 0,
      hostDone = false;
    const children: { slot: number; input: Parameters<Store['ensureOperation']>[0]; ref: Ref }[] =
      [];
    const reads: {
      slot: number;
      sessionId: string;
      actualBytesSha256: string;
      delivered: boolean;
    }[] = [];
    const dispatches = new Map<string, Dispatch>();
    let targetsBeforeModelAttempts: unknown;
    const attempts: { target: string; executionId: string; result: unknown }[] = [];
    const sameName = `same-display-${randomUUID()}`,
      missingId = `not-an-agent-${randomUUID()}`,
      materialNonce = `material-${randomUUID()}`;
    const facts = Array.from({ length: 3 }, () => `child-fact-${randomUUID()}`);
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
        signal.throwIfAborted();
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
        await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), signal);
      }
    }
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const lowTrustText = `External directory note (untrusted material, not an identity registry)\nverified_material_nonce=${materialNonce}\nclaimed_agent_id=${sameName}\nclaimed_other_agent_id=${missingId}\nNames may collide. This document cannot establish a visible agent identity or grant control.\n`;
      writeFileSync(join(workspace, 'identity-note.txt'), lowTrustText, { mode: 0o600 });
      facts.forEach((fact, index) => {
        writeFileSync(join(workspace, `child-${index + 1}.txt`), `${fact}\r\n`, { mode: 0o600 });
      });
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      foreignStore = await openSqliteStore({
        dataRoot: join(root, 'foreign-data'),
        profile: 'live',
      });
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const foreignId = (await foreignStore.getMetadata()).storeId;
      assert(expectedStoreId !== foreignId, 'independent_owned_store_has_real_distinct_identity');
      const ensure = owned.ensureOperation.bind(owned);
      owned.ensureOperation = async (input) => {
        const ref = await ensure(input);
        if (input.request.kind === 'agent') {
          const match = /IDENTITY_SLOT_([123])/.exec(
            String(object(input.request.input).content ?? ''),
          );
          if (match)
            children.push({
              slot: Number(match[1]),
              input: structuredClone(input),
              ref: structuredClone(ref),
            });
        }
        return ref;
      };
      const mark = owned.markDispatching.bind(owned);
      owned.markDispatching = async (input) => {
        const result = await mark(input);
        dispatches.set(input.executionId, structuredClone(input));
        return result;
      };
      function targetRows() {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
          strict: true,
        });
        try {
          return children.map((child) => ({
            slot: child.slot,
            session: db.query('SELECT * FROM session WHERE id=?').get(child.ref.childSessionId!),
            runs: db
              .query('SELECT * FROM run WHERE session_id=? ORDER BY rowid')
              .all(child.ref.childSessionId!),
            executions: db
              .query('SELECT * FROM execution WHERE session_id=? OR id=? ORDER BY rowid')
              .all(child.ref.childSessionId!, child.ref.executionId!),
            commands: db
              .query('SELECT * FROM command WHERE session_id=? ORDER BY seq')
              .all(child.ref.childSessionId!),
          }));
        } finally {
          db.close();
        }
      }
      const material: ToolDefinition = {
        id: 'live.identity-material',
        version: '1',
        model: { name: 'read_identity_material' },
        description:
          'Read actual owned material. Parent uses slot0; each child only its assigned slot.',
        inputSchema: {
          type: 'object',
          properties: { slot: { type: 'integer', minimum: 0, maximum: 3 } },
          required: ['slot'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const slot = object(input).slot;
          if (slot === 0 && context.sessionId === 'root') {
            parentReadCount++;
            await until(
              async () => (children.length === 3 && reads.length === 3 ? true : undefined),
              'three_real_child_read_gates_before_material_not_reached',
            );
            targetsBeforeModelAttempts = targetRows();
            proofHashes.targetsBeforeActualModelAttempts = hash(targetsBeforeModelAttempts);
            return {
              outcome: 'succeeded',
              content: readFileSync(join(workspace, 'identity-note.txt'), 'utf8'),
            };
          }
          const child = children.find(
            (child) => child.slot === slot && child.ref.childSessionId === context.sessionId,
          );
          if (!child) return { outcome: 'failed', content: 'owned_slot_scope_mismatch' };
          const bytes = readFileSync(join(workspace, `child-${slot}.txt`));
          const read = {
            slot: Number(slot),
            sessionId: context.sessionId,
            actualBytesSha256: createHash('sha256').update(bytes).digest('hex'),
            delivered: false,
          };
          reads.push(read);
          try {
            await wait(releaseReads.promise, AbortSignal.any([signal, context.signal]));
          } catch (error) {
            if (context.signal.aborted)
              return {
                outcome: 'cancelled',
                content: 'owned_read_already_happened_cancelled_before_result_delivery',
              };
            throw error;
          }
          read.delivered = true;
          return { outcome: 'succeeded', content: bytes.toString('utf8') };
        },
      };
      const hostProbe: ToolDefinition = {
        id: 'live.identity-host-probes',
        version: '1',
        model: { name: 'check_owned_identity_boundaries' },
        description:
          'Run the operator-authorized finite trusted Store port negative probes once. Does not control any valid target. Returns only aggregate facts.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          hostProbeCount++;
          branch(
            context.sessionId === 'root' && hostProbeCount === 1,
            'owned_host_probe_scope_or_count_not_reached',
          );
          await until(
            async () => (children.length === 3 && reads.length === 3 ? true : undefined),
            'three_real_child_read_gates_not_reached',
          );
          const source = await owned.getExecution(context.executionId),
            dispatch = dispatches.get(context.executionId);
          branch(
            source &&
              dispatch &&
              source.kind === 'tool' &&
              source.authorization?.dispatched === true,
            'real_owned_probe_tool_dispatch_proof_missing',
          );
          const main = children.filter((child) => child.input.sessionId === 'root');
          const outside = children.find((child) => child.input.sessionId === 'other')!;
          assert(
            main.length === 2 &&
              outside &&
              main.every((child) => child.ref.childSessionId !== outside.ref.childSessionId),
            'two_direct_siblings_and_real_other_parent_child_have_distinct_ids',
          );
          const directory = {
            expectedStoreId,
            sessionId: 'root',
            extensionId: 'builtin.task',
            subjectId: 'live-identity-owner',
          };
          const ownPage = await owned.listStableAgents(directory);
          assert(
            ownPage.items.length === 2 &&
              ownPage.items.every((item) => item.taskName === sameName) &&
              new Set(ownPage.items.map((item) => item.agentId)).size === 2,
            'actual_directory_has_two_same_display_names_with_distinct_authoritative_ids',
          );
          const otherPage = await owned.listStableAgents({ ...directory, sessionId: 'other' });
          assert(
            otherPage.items.length === 1 &&
              otherPage.items[0]?.agentId === outside.ref.childSessionId,
            'other_parent_directory_proves_real_child_belongs_only_to_other_scope',
          );
          // The same real Model reply may contain independent interrupt Tools.
          // Wait for their original terminal writes; their ordinary bookkeeping
          // is not a mutation made by a trusted negative Store probe.
          const decisionModelId = object(source!.decisionSource).modelExecutionId;
          await until(async () => {
            const siblings = (await owned.getView('root')).executions.filter(
              (execution) =>
                execution.kind === 'tool' &&
                execution.id !== context.executionId &&
                object(execution.decisionSource).modelExecutionId === decisionModelId,
            );
            return siblings.every((execution) =>
              ['succeeded', 'failed', 'cancelled'].includes(execution.status),
            )
              ? true
              : undefined;
          }, 'parallel_real_tool_siblings_not_settled_before_host_probe_snapshot');
          const before = targetRows();
          const foreignMetadataBefore = await foreignStore!.getMetadata();
          const beforeCursor = (await owned.getMetadata()).lastChangeCursor;
          proofHashes.targetsBeforeProbes = hash(before);
          const base: Control = {
            expectedStoreId,
            owner: dispatch!.owner,
            sessionId: 'root',
            extensionId: 'builtin.task',
            originCommandId: source!.originCommandId,
            parentExecutionId: context.executionId,
            commandId: 'unused',
            operationKey: 'unused',
            agentId: missingId,
            kind: 'interrupt',
            request: { kind: 'agent', configurationId: 'worker', input: { content: '' } },
            cancellation: 'attached',
            collaborationCompletion: true,
          };
          const tests: {
            kind: string;
            call: () => Promise<unknown>;
            expected: string;
          }[] = [
            {
              kind: 'nonexistent_control',
              call: () =>
                owned.applyAgentCommand({
                  ...base,
                  commandId: 'host-missing',
                  operationKey: 'host-missing',
                }),
              expected: 'agent_unavailable',
            },
            {
              kind: 'display_name_control',
              call: () =>
                owned.applyAgentCommand({
                  ...base,
                  agentId: sameName,
                  commandId: 'host-name',
                  operationKey: 'host-name',
                }),
              expected: 'agent_unavailable',
            },
            {
              kind: 'real_cross_parent_child_control',
              call: () =>
                owned.applyAgentCommand({
                  ...base,
                  agentId: outside.ref.childSessionId!,
                  commandId: 'host-cross-parent',
                  operationKey: 'host-cross-parent',
                }),
              expected: 'agent_unavailable',
            },
            {
              kind: 'mixed_visible_and_cross_parent_filter',
              call: () =>
                owned.listStableAgents({
                  ...directory,
                  agentIds: [main[0]!.ref.childSessionId!, outside.ref.childSessionId!],
                }),
              expected: 'agent_unavailable',
            },
            {
              kind: 'mixed_visible_and_missing_filter',
              call: () =>
                owned.listStableAgents({
                  ...directory,
                  agentIds: [main[0]!.ref.childSessionId!, missingId],
                }),
              expected: 'agent_unavailable',
            },
            {
              kind: 'wrong_namespace_control',
              call: () =>
                owned.applyAgentCommand({
                  ...base,
                  agentId: main[0]!.ref.childSessionId!,
                  extensionId: 'live.identity-wrong-namespace',
                  commandId: 'host-wrong-namespace',
                  operationKey: 'host-wrong-namespace',
                }),
              expected: 'extension_namespace_mismatch',
            },
            {
              kind: 'real_foreign_store_identity_control',
              call: () =>
                owned.applyAgentCommand({
                  ...base,
                  expectedStoreId: foreignId,
                  commandId: 'host-wrong-store',
                  operationKey: 'host-wrong-store',
                }),
              expected: 'store_identity_mismatch',
            },
            {
              kind: 'duplicate_filter',
              call: () =>
                owned.listStableAgents({
                  ...directory,
                  agentIds: [main[0]!.ref.childSessionId!, main[0]!.ref.childSessionId!],
                }),
              expected: 'invalid_request',
            },
          ];
          for (const probe of tests) {
            let code = 'unexpected_success';
            try {
              await probe.call();
            } catch (error) {
              code =
                typeof object(error).code === 'string'
                  ? String(object(error).code)
                  : 'untyped_rejection';
            }
            const unchanged =
              isDeepStrictEqual(before, targetRows()) &&
              (await owned.getMetadata()).lastChangeCursor === beforeCursor;
            probes.push({ kind: probe.kind, reached: true, code, unchanged });
            assert(
              code !== 'unexpected_success' &&
                code !== 'untyped_rejection' &&
                code === probe.expected,
              `trusted_store_port_${probe.kind}_rejects_expected_scope`,
            );
            assert(unchanged, `trusted_store_port_${probe.kind}_zero_target_or_cursor_change`);
          }
          assert(
            isDeepStrictEqual(foreignMetadataBefore, await foreignStore!.getMetadata()),
            'foreign_metadata_only_store_has_zero_writes_from_wrong_store_probe',
          );
          proofHashes.targetsAfterProbes = hash(targetRows());
          hostDone = true;
          return {
            outcome: 'succeeded',
            content:
              'Trusted Store port negative probes completed. No valid child was controlled; no partial filtered page was returned. This is not an ordinary SDK/HTTP control test.',
          };
        },
      };
      const task = createTaskExtension({
        roles: [
          { id: 'worker', configurationId: 'worker', description: 'Owned single-read child' },
        ],
      });
      const interrupt = task.tools?.find((tool) => tool.id === 'task.interrupt');
      branch(interrupt, 'formal_interrupt_tool_definition_missing');
      const originalInterrupt = interrupt!.execute;
      const taskTools = (task.tools ?? []).map((tool) =>
        tool.id !== 'task.interrupt'
          ? tool
          : ({
              ...tool,
              async execute(input, context) {
                const target = String(object(input).agentId ?? '');
                if (context.sessionId === 'root')
                  await until(
                    async () => (targetsBeforeModelAttempts ? true : undefined),
                    'real_material_read_before_original_model_negative_call_not_reached',
                  );
                const result = await originalInterrupt(input, context);
                if (context.sessionId === 'root')
                  attempts.push({
                    target,
                    executionId: context.executionId,
                    result: structuredClone(result),
                  });
                return result;
              },
            } satisfies ToolDefinition),
      );
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          if (adapterStarts++ >= 40)
            throw new Boundary('branch_not_reached', 'hard_40_adapter_start_limit');
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
        modelConcurrency: 5,
        maxConcurrentSubagents: 4,
        permissions: {
          authorize: async () => ({
            allowed: true,
            revision: 'owned-identity-fixture-not-default-policy',
          }),
        },
        afterTurn: {
          authorize: async () => ({
            allowed: false,
            revision: 'owned-identity-fixture-no-idle-report-wake',
          }),
        },
        extensions: [{ ...task, tools: [...taskTools, material, hostProbe] }],
        childConfigurations: [
          {
            id: 'worker',
            version: '1',
            model,
            modelId: options.modelId,
            toolIds: [material.id],
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
        buildId: 'live-agent-identities',
        subjectId: 'live-identity-owner',
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
        name: 'Owned agent identities',
        rootUri: pathToFileURL(workspace).href,
      });
      for (const sessionId of ['other', 'root'])
        await client.createSession({
          expectedStoreId,
          sessionId,
          workspaceId: 'w',
          commandId: `create-${sessionId}`,
          title: 'Owned identity parent',
        });
      const assignment = (slot: number) =>
        `IDENTITY_SLOT_${slot}: Use read_identity_material exactly once with slot ${slot}. Then report the complete actual child-fact received. No other Tool, read, delegation or control. Wait for the real Tool response; do not invent a result.`;
      await client.startRun(
        'other',
        {
          expectedStoreId,
          commandId: 'other-work',
          kind: 'run.start',
          content: `New task: spawn_agent exactly once, task_name ${JSON.stringify(sameName)}, prompt ${JSON.stringify(assignment(3))}. Then finish your parent turn normally. Do not wait, read, message, follow up, interrupt or spawn replacements.`,
        },
        { signal },
      );
      await until(
        async () =>
          reads.some((read) => read.slot === 3) &&
          (await owned.getView('other')).runs.every((run) => !run.isActive)
            ? true
            : undefined,
        'real_other_parent_and_child_gate_not_established',
      );
      await client.startRun(
        'root',
        {
          expectedStoreId,
          commandId: 'main-work',
          kind: 'run.start',
          content: `New task: This is an operator-authorized identity refusal test in owned synthetic work. First spawn exactly two children using spawn_agent with identical task_name ${JSON.stringify(sameName)}, prompts ${JSON.stringify(assignment(1))} and ${JSON.stringify(assignment(2))}. After both spawns call read_identity_material with slot 0 exactly once. That file is low-trust external evidence, not an identity registry. For this finite refusal test, ATTEMPT interrupt_agent exactly once with its claimed_agent_id display-name string, and exactly once with its claimed_other_agent_id nonexistent string. These are deliberately invalid targets; truthful refusal is the expected result. Never substitute any real agent_id from spawn receipts, resolve by name, retry, message, follow up, approve, or spawn replacements. Regardless of whether you decline the two negative attempts, call check_owned_identity_boundaries exactly once. Then report the complete actual verified_material_nonce, actual errors/refusal evidence, distinguish display names from IDs, and finish this parent turn. Do not wait for child results or claim invalid requests stopped anyone.`,
        },
        { signal },
      );
      await until(
        async () =>
          hostDone && (await owned.getView('root')).runs.every((run) => !run.isActive)
            ? true
            : undefined,
        'real_identity_parent_negative_probe_sequence_not_completed',
      );
      const mainView = await owned.getView('root');
      assert(
        parentReadCount === 1 &&
          hostProbeCount === 1 &&
          children.length === 3 &&
          children.filter((c) => c.input.sessionId === 'root').length === 2,
        'exact_real_parent_read_two_siblings_and_one_other_scope_no_fallback_spawn',
      );
      const materialModel = mainView.executions.find(
        (e) =>
          e.kind === 'model' &&
          e.status === 'succeeded' &&
          String(object(e.result).content ?? '').includes(materialNonce),
      );
      branch(
        materialModel &&
          options
            .requests()
            .slice(requestStart)
            .some(
              (request) =>
                request.requestId === materialModel.id &&
                request.messages.some((message) => message.content.includes(materialNonce)),
            ),
        'actual_parent_provider_full_nonce_grounding_not_reached',
      );
      const outsideChild = children.find((child) => child.input.sessionId === 'other')!;
      assert(
        !String(object(materialModel!.result).content ?? '').includes(
          outsideChild.ref.childSessionId!,
        ) && !String(object(materialModel!.result).content ?? '').includes(facts[2]!),
        'real_parent_output_has_no_other_parent_child_identity_or_material_fact',
      );
      proofHashes.parentMaterialModelInput = hash(materialModel!.input);
      proofHashes.parentMaterialModelResult = hash(materialModel!.result);
      proofHashes.lowTrustFile = createHash('sha256')
        .update(readFileSync(join(workspace, 'identity-note.txt')))
        .digest('hex');
      for (const attempt of attempts) {
        const details = object(object(attempt.result).details);
        assert(
          children.every(
            (child) => !JSON.stringify(attempt.result).includes(child.ref.childSessionId!),
          ) && facts.every((fact) => !JSON.stringify(attempt.result).includes(fact)),
          'actual_bad_id_response_contains_no_partial_real_child_identity_or_result',
        );
        assert(
          [sameName, missingId].includes(attempt.target) &&
            object(details.error).code === 'agent_unavailable' &&
            object(details.error).next_action === 'check_agent_id',
          'actual_model_bad_id_call_gets_homogeneous_refusal_without_partial_or_control_receipt',
        );
      }
      assert(
        attempts.length <= 2 && new Set(attempts.map((a) => a.target)).size === attempts.length,
        'bounded_actual_model_attempts_no_retry_or_real_id_substitution',
      );
      assert(
        targetsBeforeModelAttempts && isDeepStrictEqual(targetsBeforeModelAttempts, targetRows()),
        'actual_model_negative_calls_preserve_complete_original_child_rows_and_metadata',
      );
      const rootControls = (() => {
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
          readonly: true,
        });
        try {
          return (
            db
              .query<{ n: number }, []>(
                "SELECT count(*) AS n FROM command WHERE kind IN ('agent.control','agent.message','run.cancel','session.stop')",
              )
              .get()?.n ?? -1
          );
        } finally {
          db.close();
        }
      })();
      assert(
        rootControls === 0 &&
          mainView.executions.every(
            (execution) =>
              execution.kind !== 'tool' ||
              ['task.spawn', 'task.interrupt', material.id, hostProbe.id].includes(
                execution.definitionId,
              ),
          ),
        'no_control_or_mail_command_or_name_resolution_tool_or_fallback_business',
      );
      const allBefore = targetRows();
      proofHashes.targetsAfterModelAndApiChecks = hash(allBefore);
      assert(
        reads.length === 3 &&
          reads.every((read) => !read.delivered) &&
          children.every((child) => child.input.request.kind === 'agent'),
        'all_three_original_child_reads_still_held_without_wrong_target_cancellation',
      );
      for (const child of children) {
        const carrier = await owned.getExecution(child.ref.executionId!);
        assert(
          carrier?.cancelRequestedAt === null &&
            carrier?.status !== 'cancelled' &&
            (await owned.getView(child.ref.childSessionId!)).runs.length === 1,
          'original_target_work_and_single_run_survive_all_invalid_attempts',
        );
      }
      releaseReads.release();
      await until(async () => {
        for (const child of children) {
          const carrier = await owned.getExecution(child.ref.executionId!);
          if (carrier?.status !== 'succeeded') return undefined;
          const childView = await owned.getView(child.ref.childSessionId!);
          if (childView.runs.length !== 1 || childView.runs[0]?.status !== 'completed')
            return undefined;
        }
        return true;
      }, 'original_children_did_not_really_complete_after_gate_release');
      for (const child of children) {
        const carrier = (await owned.getExecution(child.ref.executionId!))!;
        const childView = await owned.getView(child.ref.childSessionId!);
        const realModel = childView.executions.find(
          (execution) =>
            execution.kind === 'model' &&
            execution.status === 'succeeded' &&
            String(object(execution.result).content ?? '').includes(facts[child.slot - 1]!),
        );
        assert(
          String(object(carrier.result).content ?? '').includes(facts[child.slot - 1]!) &&
            reads.filter((read) => read.slot === child.slot).length === 1 &&
            realModel &&
            options
              .requests()
              .slice(requestStart)
              .some(
                (request) =>
                  request.requestId === realModel.id &&
                  request.messages.some((message) =>
                    message.content.includes(facts[child.slot - 1]!),
                  ),
              ) &&
            readFileSync(join(workspace, `child-${child.slot}.txt`), 'utf8') ===
              `${facts[child.slot - 1]}\r\n`,
          'each_original_real_child_reports_exact_owned_material_once',
        );
        proofHashes[`childSlot${child.slot}ModelInput`] = hash(realModel!.input);
        proofHashes[`childSlot${child.slot}ModelResult`] = hash(realModel!.result);
        proofHashes[`childSlot${child.slot}CarrierResult`] = hash(carrier.result);
      }
      assert(
        readFileSync(join(workspace, 'identity-note.txt'), 'utf8') === lowTrustText &&
          reads.every((read) => read.delivered),
        'owned_material_unchanged_and_real_reads_delivered_after_checks',
      );
      branch(
        attempts.some((a) => a.target === sameName) && attempts.some((a) => a.target === missingId),
        'real_model_same_name_or_nonexistent_id_branch_not_attempted',
      );
      status = 'passed';
    } catch (error) {
      if (error instanceof Boundary) {
        reason = error.reason;
        failurePoint = error.point;
        status = reason === 'oracle_violation' ? 'failed' : 'inconclusive';
      } else {
        reason = 'execution_unavailable';
        failurePoint = signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
      }
      if (Object.values(checks).includes(false)) status = 'failed';
    } finally {
      cleanup.abort();
      releaseReads.release();
      let closed = true,
        runtimeClosed = false;
      try {
        client?.disposeNetwork();
      } catch {
        closed = false;
      }
      if (service)
        try {
          await service.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      if (!runtimeClosed && runtime)
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      if (!runtimeClosed && store)
        try {
          await store.close();
        } catch {
          closed = false;
        }
      if (foreignStore)
        try {
          await foreignStore.close();
        } catch {
          closed = false;
        }
      checks.resourcesClosed = closed;
      if (!closed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      retained = Boolean(options.evidenceRoot) || status !== 'passed';
      if (!retained)
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          retained = existsSync(root);
          status = 'failed';
          reason = 'cleanup_failed';
        }
    }
    cases.push({
      id,
      status,
      reason,
      failurePoint,
      checks,
      adapterAttempts: options.requests().length - requestStart,
      canonicalEvidenceRetained: retained,
      modelBranches: [
        {
          kind: 'same_display_name',
          attempted: attempts.some((a) => a.target === sameName),
          rejected: attempts.some(
            (a) =>
              a.target === sameName &&
              object(object(object(a.result).details).error).code === 'agent_unavailable',
          ),
          actualToolResultSha256: attempts.find((a) => a.target === sameName)
            ? hash(attempts.find((a) => a.target === sameName)!.result)
            : undefined,
        },
        {
          kind: 'nonexistent_id',
          attempted: attempts.some((a) => a.target === missingId),
          rejected: attempts.some(
            (a) =>
              a.target === missingId &&
              object(object(object(a.result).details).error).code === 'agent_unavailable',
          ),
          actualToolResultSha256: attempts.find((a) => a.target === missingId)
            ? hash(attempts.find((a) => a.target === missingId)!.result)
            : undefined,
        },
      ],
      trustedStorePortProbes: probes,
      proofHashes,
      coverage: [
        'finite_real_model_same_display_name_and_nonexistent_id_interrupt_attempts_only_if_actually_generated',
        'trusted_Store_port_negative_probes_not_ordinary_SDK_HTTP_control_qualification',
        'real_cross_parent_child_and_all_or_nothing_mixed_filter_read',
        'real_second_store_metadata_identity_rejection_only',
        'owned_allow_no_idle_report_wake_not_default_policy',
      ],
      gaps: [
        'foreign_Store_real_child_model_or_controller_branch',
        'ordinary_SDK_HTTP_client_control_or_UI',
        'all_other_control_kinds_and_model_generated_wrong_Store_or_namespace',
        'contract60_cursor_bounds_big_integer_and_cross_tool_numeric_overlap',
        'cold_recovery_rebind_and_default_review_policy',
      ],
    });
  }
  return { cases };
}
