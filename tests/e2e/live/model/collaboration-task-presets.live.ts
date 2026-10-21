import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

export const taskPresetCaseId = 'A11-trusted-read-only-preset-same-child-followup';
export const taskPresetCaseIds = [
  taskPresetCaseId,
  'A11-trusted-catalogue-omitted-preset-default-same-child-followup',
];
interface Options {
  caseId?: string;
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  evidenceRoot?: string;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
class Boundary extends Error {
  readonly violation: boolean;
  constructor(message: string, violation = false) {
    super(message);
    this.violation = violation;
  }
}
/** Owned trusted factory, ordinary unchanged six Tools; external runner owns 40/600/4096-medium. */
export async function runLiveTaskPreset(options: Options) {
  const id = options.caseId ?? taskPresetCaseId;
  if (!taskPresetCaseIds.includes(id)) throw Error('task_preset_known_case_required');
  const selectedPreset = id === taskPresetCaseId;
  if (
    !options.evidenceRoot ||
    !isAbsolute(options.evidenceRoot) ||
    existsSync(options.evidenceRoot)
  )
    throw Error('task_preset_new_absolute_evidence_root_required');
  mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(options.evidenceRoot),
    workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const facts = [1, 2].map((n) => `preset-current-round-${n}-${crypto.randomUUID()}-🪁`);
  for (let n = 0; n < 2; n++)
    writeFileSync(join(workspace, `round${n + 1}.txt`), `${facts[n]}\r\n`);
  const profile = { dataRoot: join(root, 'data'), profile: 'live' };
  const store = await openSqliteStore(profile),
    files = createWorkspaceFiles({ root: workspace });
  const requestStart = options.requests().length,
    deadline = Date.now() + 600000;
  const checks: Record<string, boolean> = {},
    stages: Record<string, unknown> = {};
  const traces: Record<string, { finish: boolean; eof: boolean; error: string | null }> = {};
  let runtime: ReturnType<typeof createRuntime> | undefined,
    adapterStarts = 0;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
    failure: string | undefined;
  const cleanupErrors: string[] = [];
  function assert(v: unknown, point: string): asserts v {
    checks[point] = !!v;
    if (!v) throw new Boundary(point, true);
  }
  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    for (;;) {
      options.signal.throwIfAborted();
      const v = await read();
      if (v !== undefined) return v;
      if (Date.now() >= deadline) throw new Boundary('original_600second_branch_not_reached');
      await Bun.sleep(10);
    }
  }
  try {
    const task = createTaskExtension({
      roles: [
        { id: 'worker', configurationId: 'worker', description: 'Default general owned child' },
        {
          id: 'read_only',
          configurationId: 'read_only',
          description: 'Trusted preset: read existing owned files only; no writes',
        },
      ],
      presets: ['read_only'],
    });
    const fileTools = createFileTools(files).filter((t) =>
      ['files.read', 'files.write'].includes(t.id),
    );
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      async *stream(request, context) {
        if (adapterStarts++ >= 40) throw new Boundary('hard_40_adapter_start_limit');
        const trace = { finish: false, eof: false, error: null as string | null };
        traces[request.requestId] = trace;
        try {
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([options.signal, context.signal]),
          })) {
            if (event.type === 'finish') trace.finish = true;
            yield event;
          }
          trace.eof = true;
        } catch (error) {
          trace.error = String(error);
          throw error;
        } finally {
          writeFileSync(join(root, 'adapter-events.json'), JSON.stringify(traces, null, 2));
        }
      },
    };
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: options.modelId,
      modelConcurrency: 2,
      maxConcurrentSubagents: 1,
      extensions: [task, { id: 'builtin.files', version: '1', apiMajor: 1, tools: fileTools }],
      permissions: {
        authorize: async () => ({
          allowed: true,
          revision: 'owned-preset-only-not-default-policy',
        }),
      },
      afterTurn: {
        authorize: async () => ({ allowed: false, revision: 'owned-preset-no-idle-wake' }),
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: ['files.read', 'files.write'],
          snapshot: { ownedPreset: 'worker' },
        },
        {
          id: 'read_only',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: ['files.read'],
          snapshot: { ownedPreset: 'read_only' },
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned preset comparison',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Trusted preset bounded probe',
    });
    stages.declaredTrustedConfigurationContrast = {
      worker: ['files.read', 'files.write'],
      read_only: ['files.read'],
      scope:
        'Host declaration only; actual Model selection and actual child tools checked separately below',
    };
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: `New task: Use spawn_agent exactly ONCE ${selectedPreset ? 'with preset read_only' : 'omitting preset entirely although the trusted catalogue also offers read_only'}, omit task_name, and prompt: Read round1.txt exactly once using read_file, quote its complete actual one-line fact, then finish; no other Tool, edit, delegation or guesses. Retain its exact returned agent_id. Use finite wait_agent_events and list_agents to confirm its actual idle/completed first result. Then call follow_up_agent exactly ONCE on that SAME agent_id, content: Read round2.txt exactly once using read_file, quote its complete actual one-line fact, then finish; no edit, other Tool, delegation or guesses. Observe along the returned event cursor and current-work/result sources until the second work actually completes; historical first completion is not proof of second completion. Finally quote both complete actual facts with their round and child source. Do not read/write files yourself, spawn a replacement, send messages, interrupt, request approvals, choose a different preset or repeat mutation calls.`,
      },
    });
    await until(async () => {
      const v = await store.getView('root');
      return v.runs.length > 0 && v.runs.every((r) => !r.isActive) ? v : undefined;
    });
    const parent = await store.getView('root'),
      tools = parent.executions.filter((e) => e.kind === 'tool');
    if (parent.runs.some((run) => run.status !== 'completed'))
      throw new Boundary('actual_parent_business_not_completed');
    const spawns = tools.filter((e) => e.definitionId === 'task.spawn'),
      follows = tools.filter((e) => e.definitionId === 'task.follow_up');
    if (spawns.length !== 1 || follows.length !== 1)
      throw new Boundary('real_Model_exact_one_preset_spawn_and_followup_not_reached');
    const spawnInput = object(spawns[0]!.input); // Persisted input is checked against actual Model Tool call below.
    const calls = options
      .requests()
      .slice(requestStart)
      .filter((r) => parent.executions.some((e) => e.id === r.requestId))
      .flatMap((r) => r.messages.flatMap((m) => m.toolCalls ?? []));
    const uniqueCalls = [...new Map(calls.map((c) => [c.id, c])).values()];
    const spawnCalls = uniqueCalls.filter((c) => c.name === 'spawn_agent');
    assert(
      spawnCalls.length === 1 &&
        (selectedPreset
          ? object(JSON.parse(spawnCalls[0]!.arguments)).preset === 'read_only'
          : !Object.hasOwn(object(JSON.parse(spawnCalls[0]!.arguments)), 'preset')),
      'actual_original_Model_preset_choice_matches_variant',
    );
    stages.originalSpawnInput = spawnInput;
    const agents = await store.listStableAgents({ ...identity, extensionId: task.id });
    assert(agents.items.length === 1, 'exact_one_stable_child_no_fallback');
    const agent = agents.items[0]!,
      child = await store.getView(agent.agentId);
    assert(
      child.runs.length === 2 && child.runs.every((r) => r.status === 'completed'),
      'same_child_two_actual_completed_Runs',
    );
    const carriers = parent.executions.filter((e) => e.childSessionId === agent.agentId);
    assert(
      carriers.length === 2 && carriers.every((e) => e.status === 'succeeded'),
      'two_exact_original_succeeded_child_carriers',
    );
    for (const carrier of carriers) {
      const body = String(object(carrier.result).content ?? ''),
        acceptance = carrier.resultAcceptance;
      assert(
        body.length > 0 && acceptance?.resultRevision === carrier.resultRevision,
        'original_carrier_revision_and_full_body',
      );
      const parents = options
        .requests()
        .slice(requestStart)
        .filter(
          (r) =>
            parent.executions.some((e) => e.id === r.requestId) &&
            r.messages.some((m) => m.sourceIds?.includes(acceptance.sourceId)),
        );
      assert(
        parents.length > 0 &&
          parents.every((r) => {
            const messages = r.messages.filter((m) => m.sourceIds?.includes(acceptance.sourceId));
            return (
              messages.length === 1 &&
              messages[0]!.sourceIds?.filter((id) => id === acceptance.sourceId).length === 1 &&
              (messages[0]!.content.includes(body) ||
                messages[0]!.content.includes(JSON.stringify(body).slice(1, -1)))
            );
          }),
        'complete_original_Source_once_in_actual_parent_input',
      );
    }
    const configurations = child.runs.map((r) => r.configuration);
    assert(
      isDeepStrictEqual(configurations[0], configurations[1]),
      'followup_exact_original_configuration_unchanged',
    );
    assert(
      object(object(configurations[0]).snapshot).ownedPreset ===
        (selectedPreset ? 'read_only' : 'worker'),
      'actual_configuration_identity_matches_declared_variant',
    );
    const childRequests = options
      .requests()
      .slice(requestStart)
      .filter((r) => child.executions.some((e) => e.id === r.requestId));
    assert(
      childRequests.length >= 4 &&
        childRequests.every((r) =>
          isDeepStrictEqual(
            r.tools.map((t) => t.id).sort(),
            selectedPreset ? ['read_file'] : ['read_file', 'write_file'],
          ),
        ),
      'all_actual_child_inputs_exact_declared_tool_upper',
    );
    const reads = child.executions.filter((e) => e.kind === 'tool');
    assert(
      reads.length === 2 &&
        reads.every((e) => e.definitionId === 'files.read' && e.status === 'succeeded'),
      'two_actual_reads_no_write_or_other_child_Tool',
    );
    assert(
      !tools.some((e) => e.definitionId.startsWith('files.')),
      'parent_did_not_read_or_write_for_child',
    );
    const childOutputs = child.executions.filter(
      (e) => e.kind === 'model' && e.status === 'succeeded',
    );
    for (let n = 0; n < 2; n++) {
      assert(
        childOutputs.some((e) => String(object(e.result).content ?? '').includes(facts[n]!)),
        `actual_child_round_${n + 1}_file_fact`,
      );
      assert(
        parent.executions.some(
          (e) =>
            e.kind === 'model' &&
            e.status === 'succeeded' &&
            String(object(e.result).content ?? '').includes(facts[n]!),
        ),
        `actual_parent_round_${n + 1}_fact_from_child`,
      );
      assert(
        readFileSync(join(workspace, `round${n + 1}.txt`), 'utf8') === `${facts[n]}\r\n`,
        `original_file_${n + 1}_unchanged`,
      );
    }
    assert(
      Object.values(traces).every((trace) => trace.finish && trace.eof && trace.error === null),
      'all_original_actual_Model_finish_EOF_no_failed_attempt',
    );
    stages.final = {
      parent,
      child,
      agents,
      configurations,
      actualChildRequests: childRequests,
      facts,
    };
    status = 'passed';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    status = error instanceof Boundary && error.violation ? 'failed' : 'inconclusive';
  } finally {
    stages.actualRequests = options.requests().slice(requestStart);
    if (runtime)
      try {
        stages.canonical = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: options.requests().slice(requestStart),
          root,
          subjectId: 'owner',
        });
        if (!object(stages.canonical).complete) {
          status = 'failed';
          failure ??= 'complete_original_canonical_unavailable';
        }
      } catch (e) {
        cleanupErrors.push(`canonical:${String(e)}`);
        status = 'failed';
        failure ??= 'canonical_save_failed';
      }
    for (const [name, close] of [
      ['runtime', () => runtime?.close()],
      ['files', () => files.close()],
      ['store', () => store.close()],
    ] as const)
      try {
        await close();
      } catch (e) {
        cleanupErrors.push(`${name}:${String(e)}`);
      }
    if (cleanupErrors.length) {
      status = 'failed';
      failure ??= 'cleanup_unconfirmed';
    }
    checks.resourcesClosed = cleanupErrors.length === 0;
    writeFileSync(
      join(root, 'evidence.json'),
      JSON.stringify(
        {
          checks,
          stages,
          failure,
          cleanupErrors,
          scope:
            'Real Model preset selection/read upper/same-child followup only; host schema/typed/unavailable/custom-input negative probes are separate, not random Model errors.',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return {
    cases: [
      {
        id,
        status,
        checks,
        reason: failure,
        canonicalEvidenceRetained: true,
        resourcesClosed: cleanupErrors.length === 0,
        cleanupErrors,
      },
    ],
  };
}
