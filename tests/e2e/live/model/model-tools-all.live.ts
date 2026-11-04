import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { withBundledRipgrep } from '@kite-ai/agent/jobs/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { CODEX_BASE_URL, createCodexLocalSource } from '../../../../apps/service/src/codex-auth';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import { resolveWebTransport } from '../../../../apps/service/src/web-fetch-proxy';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import { privateDirectory } from '../../../fixtures/test-filesystem';
import { liveCodeEvidence } from './live-code-evidence';
import {
  extendedToolGroups,
  runExtendedToolCases,
  type ToolScenarioOptions,
} from './model-tools-extended-cases';

// Explicit live artifact only. No production flags, model substitution, response edits or outer retry.
const args = process.argv.slice(2);
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
const selectedScenario = args.find((arg) => arg.startsWith('--scenario='))?.slice(11);
const baselineScenarios = ['files-shell', 'question', 'planning', 'skills', 'mcp', 'web', 'agents'];
const scenarioNames = [...baselineScenarios, ...Object.keys(extendedToolGroups)];
const extended =
  args.includes('--extended') || !!(selectedScenario && selectedScenario in extendedToolGroups);
const selected = new Set(
  selectedScenario
    ? [selectedScenario]
    : extended
      ? Object.keys(extendedToolGroups)
      : baselineScenarios,
);
if (
  process.env.KITE_RUN_LIVE_MODEL_TOOLS !== '1' ||
  args.filter((arg) => arg.startsWith('--output=')).length !== 1 ||
  args.filter((arg) => arg.startsWith('--scenario=')).length > 1 ||
  args.filter((arg) => arg === '--extended').length > 1 ||
  args.length !==
    1 + Number(selectedScenario !== undefined) + Number(args.includes('--extended')) ||
  (selectedScenario !== undefined && !scenarioNames.includes(selectedScenario)) ||
  !output ||
  !isAbsolute(output) ||
  existsSync(output) ||
  existsSync(`${output}.workspace`)
)
  throw Error('all_tools_requires_opt_in_and_new_absolute_output');
if (process.platform !== 'win32') throw Error('all_tools_windows_host_fixture_required');

const modelName = 'gpt-6-luna';
const reasoningEffort = 'low';
const requestLimit = extended ? 160 : 100;
const timeoutMs = 1_200_000;
const deadline = AbortSignal.timeout(timeoutMs);
const expected = [
  'read_file',
  'write_file',
  'edit_file',
  'shell_execute',
  'shell_launch',
  'shell_read',
  'shell_wait',
  'shell_stop',
  'ask_user',
  'web_fetch',
  'spawn_agent',
  'send_agent_message',
  'follow_up_agent',
  'wait_agent_events',
  'list_agents',
  'interrupt_agent',
  'read_plan',
  'write_plan',
  'request_plan_review',
  'update_plan_progress',
  'load_skill',
  'read_skill_resource',
  'list_mcp_sources',
  'connect_mcp_server',
  'refresh_mcp_catalogue',
  'search_mcp_tools',
  'list_mcp_resources',
  'read_mcp_resource',
  'list_mcp_prompts',
  'get_mcp_prompt',
] as const;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function check(value: unknown, point: string): asserts value {
  if (!value) throw Error(`all_tools_${point}`);
}
const started = Date.now();
const wire: {
  status: number;
  model: string;
  reasoningEffort: string;
  errorCode?: string;
  errorType?: string;
}[] = [];
const scenarios: Record<string, unknown>[] = [];
const interactions: { sessionId: string; definitionId: string; kind: string; decision: string }[] =
  [];
const failures: { scenario: string; point: string }[] = [];
const report: Record<string, unknown> = {
  model: modelName,
  reasoningEffort,
  provider: 'codex-local-session',
  protocol: 'responses',
  platform: process.platform,
  bun: Bun.version,
  startedAt: new Date().toISOString(),
  selectedScenario: selectedScenario ?? (extended ? 'extended' : 'all'),
  requestLimit,
  timeoutMs,
  code: liveCodeEvidence(),
  scenarios,
  wire,
  interactions,
  failures,
  status: 'failed',
  cleanupConfirmed: false,
};
const cleanup: { name: string; close(): void | Promise<void> }[] = [];
const requests: { request: ModelRequest; events: ModelEvent[] }[] = [];
const names = new Set<string>();
const called = new Set<string>();
const callNames = new Map<string, string>();
const succeededCalls = new Set<string>();
const consumedCalls = new Set<string>();
const rpc: string[] = [];
try {
  mkdirSync(dirname(output), { recursive: true });
  privateDirectory(`${output}.workspace`);
  const root = realpathSync.native(`${output}.workspace`);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  mkdirSync(join(workspace, 'skill'));
  const control = join(root, 'control');
  privateDirectory(control);
  const marker = randomUUID();
  writeFileSync(join(workspace, 'source.txt'), 'message=before\nmode=test\n');
  writeFileSync(join(workspace, 'docs/sample.md'), 'literal needle [a-z]+\n');
  writeFileSync(join(root, 'external.txt'), `external-${marker}\n`);
  writeFileSync(
    join(workspace, 'skill/SKILL.md'),
    '---\nname: Synthetic knowledge\ndescription: Bounded tool coverage knowledge\n---\nRead [reference](reference.txt) and report its token. Knowledge only.\n',
  );
  writeFileSync(join(workspace, 'skill/reference.txt'), `skill-${marker}\n`);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live-all-tools' });
  privateDirectory(profile.profilePath);
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = object(await request.json());
      if (body.id === undefined) return new Response(null, { status: 202 });
      const method = String(body.method);
      const params = object(body.params);
      rpc.push(method);
      let result: unknown;
      switch (body.method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'synthetic-tools', version: '1' },
            capabilities: { tools: {}, resources: {}, prompts: {} },
          };
          break;
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'echo_probe',
                description: 'Echo a bounded synthetic coverage value',
                inputSchema: {
                  type: 'object',
                  properties: { value: { type: 'string', const: 'verified' } },
                  required: ['value'],
                  additionalProperties: false,
                },
              },
            ],
          };
          break;
        case 'tools/call':
          check(
            params.name === 'echo_probe' && object(params.arguments).value === 'verified',
            'mcp_call_arguments',
          );
          result = { content: [{ type: 'text', text: `mcp-call-${marker}` }] };
          break;
        case 'resources/list':
          result = {
            resources: [
              { uri: 'synthetic://coverage/note', name: 'Coverage note', mimeType: 'text/plain' },
            ],
          };
          break;
        case 'resources/read':
          check(params.uri === 'synthetic://coverage/note', 'mcp_resource_arguments');
          result = {
            contents: [
              {
                uri: 'synthetic://coverage/note',
                mimeType: 'text/plain',
                text: `resource-${marker}`,
              },
            ],
          };
          break;
        case 'prompts/list':
          result = {
            prompts: [
              {
                name: 'coverage_prompt',
                description: 'Synthetic coverage prompt',
                arguments: [{ name: 'subject', required: true }],
              },
            ],
          };
          break;
        case 'prompts/get':
          check(
            params.name === 'coverage_prompt' && object(params.arguments).subject === 'verified',
            'mcp_prompt_arguments',
          );
          result = {
            messages: [{ role: 'user', content: { type: 'text', text: `prompt-${marker}` } }],
          };
          break;
        default:
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Method not found' },
          });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  cleanup.push({ name: 'mcp_server', close: () => remote.stop(true) });
  writeFileSync(
    join(profile.profilePath, 'mcp.json'),
    JSON.stringify({
      mcpServers: { synthetic: { type: 'http', url: remote.url.href, auth: { type: 'none' } } },
    }),
  );

  const wrap = (adapter: ModelAdapter): ModelAdapter => ({
    describeRequest: adapter.describeRequest?.bind(adapter),
    async *stream(request, options) {
      deadline.throwIfAborted();
      const trace = { request: structuredClone(request), events: [] as ModelEvent[] };
      requests.push(trace);
      for (const tool of request.tools) names.add(tool.id);
      for (const message of request.messages)
        if (message.role === 'tool' && message.toolCallId) consumedCalls.add(message.toolCallId);
      console.log(
        JSON.stringify({ phase: 'model', request: requests.length, tools: request.tools.length }),
      );
      try {
        for await (const event of adapter.stream(request, {
          signal: AbortSignal.any([deadline, options.signal]),
        })) {
          trace.events.push(structuredClone(event));
          if (event.type === 'tool_call') {
            called.add(event.name);
            callNames.set(event.id, event.name);
          }
          yield event;
        }
      } finally {
        writeFileSync(
          join(root, `model-${requests.indexOf(trace) + 1}.json`),
          JSON.stringify(trace, null, 2),
        );
      }
    },
  });
  function instrument(binding: RunConfiguration): RunConfiguration {
    return {
      ...binding,
      ...(binding.model ? { model: wrap(binding.model) } : {}),
    };
  }
  const transport = await resolveWebTransport(undefined);
  check(!transport.unavailableReason, 'registered_proxy_unavailable');
  report.modelTransport = transport.proxy?.https ? 'registered-user-https-proxy' : 'direct';
  const source = createCodexLocalSource({
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        check(wire.length < requestLimit, 'request_budget');
        const body = object(JSON.parse(String(init?.body)));
        check(
          body.model === modelName && object(body.reasoning).effort === reasoningEffort,
          'wire_model_settings',
        );
        const observed: (typeof wire)[number] = { status: 0, model: modelName, reasoningEffort };
        wire.push(observed);
        const response = await fetch(input, {
          ...init,
          proxy: transport.proxy?.https,
          signal: AbortSignal.any([
            deadline,
            AbortSignal.timeout(120_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        observed.status = response.status;
        if (!response.ok) {
          const error = object(
            object(
              await response
                .clone()
                .json()
                .catch(() => ({})),
            ).error,
          );
          if (typeof error.code === 'string' && /^[a-z0-9_-]+$/i.test(error.code))
            observed.errorCode = error.code;
          if (typeof error.type === 'string' && /^[a-z0-9_-]+$/i.test(error.type))
            observed.errorType = error.type;
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const discovery = source.discover();
  check(discovery, 'local_session_unavailable');
  check(
    discovery.models.some((model) => model.name === modelName),
    'model_not_available',
  );
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configurationPath,
    JSON.stringify({
      modelId: 'live',
      models: [
        {
          id: 'live',
          provider: 'codex',
          providerName: discovery.alias,
          model: modelName,
          baseURL: CODEX_BASE_URL,
          protocol: 'responses',
          options: { reasoningEffort },
        },
      ],
      skills: [{ id: 'synthetic-knowledge', path: 'skill' }],
      tools: [
        'skills.load',
        'skills.resource',
        'mcp.catalogue.refresh',
        'mcp.resources.list',
        'mcp.resources.read',
        'mcp.prompts.list',
        'mcp.prompts.get',
      ].map((id) => ({ id })),
    }),
  );
  const assets = await windowsShellFixture();
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configurationPath,
    localCodex: source,
    ordinaryHostTools: true,
    observerSubjectId: 'owner',
    credentialBackend: createTemporaryCredentialBackend(),
    mcpSources: { http: { allowLoopbackForTests: true } },
    afterTurn: {
      async authorize() {
        return {
          allowed: false,
          revision: 'owned-live-explicit-observation',
          reason: 'explicit_follow_up_only',
        };
      },
    },
    shell: {
      platform: 'win32',
      configurationId: 'owned-live-windows-shell',
      env: withBundledRipgrep(
        Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]),
          ),
        ),
      ).env,
      supervisorPath: assets.runner,
      bunExecutable: process.execPath,
      shellExecutable: assets.shell,
      windows: {
        coreutilsPath: assets.coreutils,
        fullShellExecutable: assets.fullShell,
        stateRoot: assets.stateRoot,
      },
      host: {
        controlBase: control,
        protectedRoots: [profile.dataRoot, control],
        readonlyAssets: [],
        runtimeReadOnlyRoots: [],
      },
    },
  });
  const store = await openSqliteStore(profile);
  cleanup.push({ name: 'store', close: () => store.close() });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const resolveRun = host.resolveRunConfiguration!;
  const resolveChild = host.resolveChildRunConfiguration!;
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  cleanup.push({ name: 'workspace_locks', close: () => workspaceSerialLocks.close() });
  host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
  const runtime = createRuntime({
    ...host,
    store,
    workspaceSerialLocks,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions,
    permissions: host.permissions!,
    supportsExtensionInputs: host.supportsExtensionInputs,
    supportsSelectedSkills: host.supportsSelectedSkills,
    async resolveRunConfiguration(input) {
      const binding = await resolveRun(input);
      return instrument(binding);
    },
    childConfigurations: host.childConfigurations,
    async resolveChildRunConfiguration(input) {
      const binding = await resolveChild(input);
      return instrument(binding);
    },
  });
  const permissions = host.permissionManagement!(runtime);
  cleanup.push({ name: 'runtime', close: () => runtime.close() });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    permissionManagement: permissions,
    subjectId: 'owner',
    buildId: 'owned-live-all-tools',
  });
  cleanup.push({ name: 'service', close: () => service.close() });
  const transportEvents: { method: string; path: string; cut?: boolean }[] = [];
  let cutStart = false;
  let endpoint = service.endpoint;
  if (selected.has('client-reconnect')) {
    const proxy = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(Buffer.from(chunk));
        const body = parts.length ? Buffer.concat(parts) : undefined;
        const event = { method: req.method ?? 'GET', path: req.url ?? '/', cut: false };
        transportEvents.push(event);
        const response = await fetch(service.endpoint + event.path, {
          method: event.method,
          headers: {
            authorization: req.headers.authorization ?? '',
            'content-type': 'application/json',
          },
          ...(body ? { body } : {}),
          signal: deadline,
        });
        const bytes = await response.arrayBuffer();
        if (
          cutStart &&
          event.method === 'POST' &&
          event.path === '/v1/sessions/client-reconnect/commands' &&
          response.ok
        ) {
          cutStart = false;
          event.cut = true;
          req.socket.destroy();
          return;
        }
        res.writeHead(response.status, {
          'content-type': response.headers.get('content-type') ?? 'application/json',
        });
        res.end(Buffer.from(bytes));
      } catch {
        req.socket.destroy();
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    cleanup.push({
      name: 'client_proxy',
      close: () =>
        new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        ),
    });
  }
  report.clientTransport = transportEvents;
  const makeClient = () =>
    createClient({
      endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        apiMajor: 1,
        requiredCapabilities: [
          'commands',
          'interactions',
          'run_skill_selection',
          'run_extension_inputs',
        ],
      },
    });
  let client = makeClient();
  cleanup.push({ name: 'client', close: () => client.disposeNetwork() });
  const answered = new Set<string>();
  async function answerPending(sessionId: string, options: ToolScenarioOptions) {
    const page = await client.listInteractions(sessionId, {
      storeId: expectedStoreId,
      origin: 'all',
      state: 'pending',
    });
    for (const card of page.interactions) {
      if (answered.has(card.id)) continue;
      answered.add(card.id);
      let answer: Parameters<typeof client.answerInteraction>[2]['answer'];
      if (card.kind === 'approval') {
        await options.beforeApproval?.();
        answer =
          options.approval === 'deny'
            ? { kind: 'approval', decision: 'deny' }
            : { kind: 'approval', decision: 'approve', grant: 'approve_once' };
      } else if (card.kind === 'plan_review')
        answer = { kind: 'plan_review', decision: 'approve', mode: 'accept_edits' };
      else if (card.kind === 'question') answer = { kind: 'question', answers: { q1: 'q1-o1' } };
      else throw Error('all_tools_unexpected_interaction');
      await client.answerInteraction(sessionId, card.id, {
        expectedStoreId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer,
      });
      interactions.push({
        sessionId,
        definitionId: card.definitionId,
        kind: card.kind,
        decision: 'decision' in answer ? answer.decision : 'first_choice',
      });
    }
  }
  async function waitForRun(id: string, commandId: string, options: ToolScenarioOptions = {}) {
    const until = Date.now() + 180_000;
    for (;;) {
      deadline.throwIfAborted();
      check(Date.now() < until, `${id}_scenario_deadline`);
      await answerPending(id, options);
      const command = await client.getCommand(commandId);
      const runId = object(command.receipt).runId;
      if (typeof runId === 'string') {
        const run = await store.getRun(runId);
        if (run) {
          if (!run.isActive) return run;
          await options.onTick?.(run);
        }
      } else
        check(
          !['failed', 'rejected', 'outcome_unknown'].includes(command.status),
          'command_failed',
        );
      await delay(80, undefined, { signal: deadline });
    }
  }
  async function scenario(
    id: string,
    prompt: string,
    plan = false,
    options: ToolScenarioOptions = {},
  ) {
    const begin = Date.now();
    const firstRequest = requests.length;
    await client.createSession({
      expectedStoreId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'workspace',
      title: id,
    });
    await initializeLivePermissionFixture({
      profile,
      runtime,
      expectedStoreId,
      subjectId: 'owner',
      sessionId: id,
      workspaceId: 'workspace',
      mode: options.mode ?? 'full',
      trusted: true,
    });
    const commandId = `run-${id}`;
    if (id === 'client-reconnect') cutStart = true;
    const start = client.startRun(id, {
      expectedStoreId,
      commandId,
      kind: 'run.start',
      content: prompt,
      ...(plan
        ? {
            extensionInputs: [
              { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
            ],
          }
        : {}),
      ...(id === 'skills' ? { selectedSkills: ['synthetic-knowledge'] } : {}),
    });
    if (id === 'client-reconnect') {
      const error = await start.catch((error: unknown) => error);
      check(object(error).code === 'network_outcome_unknown', 'lost_response_not_reached');
    } else await start;
    const run = await waitForRun(id, commandId, options);
    const executions = await store.listExecutions(id, 1000);
    const tools = executions.filter((execution) => execution.kind === 'tool');
    for (const tool of tools) if (tool.status === 'succeeded') succeededCalls.add(tool.callId);
    const summary = {
      name: id,
      status: run.status,
      verified: false,
      requests: requests.length - firstRequest,
      durationMs: Date.now() - begin,
      tools: tools.map((tool) => ({
        id: tool.definitionId,
        status: tool.status,
        result: tool.result,
      })),
    };
    writeFileSync(join(root, `${id}-executions.json`), JSON.stringify(executions, null, 2));
    scenarios.push(summary);
    check(run.status === (options.expectedStatus ?? 'completed'), `${id}_run_${run.status}`);
    check(
      tools.every((tool) => tool.status === 'succeeded' || options.expectedFailure?.(tool)),
      `${id}_tool_failed`,
    );
    return { executions, run };
  }
  async function runCase(
    id: string,
    prompt: string,
    plan = false,
    options: ToolScenarioOptions = {},
  ) {
    if (!selected.has(id)) return;
    try {
      const { executions, run } = await scenario(id, prompt, plan, options);
      if (id === 'files-shell') {
        check(
          readFileSync(join(workspace, 'source.txt'), 'utf8') === 'message=after\nmode=test\n',
          'edit_effect',
        );
        check(readFileSync(join(workspace, 'result.txt'), 'utf8') === 'verified\n', 'write_effect');
        const launch = executions.find((execution) => execution.definitionId === 'shell.launch');
        const backgroundId = object(object(object(launch?.result).details).ref).executionId;
        const background = executions.find((execution) => execution.id === backgroundId);
        check(
          background?.status === 'cancelled' &&
            object(object(background.result).details).cleanupConfirmed === true &&
            object(object(background.result).details).processTreeStopped === true,
          'shell_stop_not_confirmed',
        );
      }
      if (id === 'question') {
        const question = executions.find((execution) => execution.definitionId === 'ask_user');
        check(
          object(object(question?.result).details).answer === 'Alpha',
          'question_actual_answer',
        );
      }
      if (id === 'skills') {
        const reference = executions.find(
          (execution) => execution.definitionId === 'skills.resource',
        );
        check(object(reference?.result).content === `skill-${marker}\n`, 'skill_actual_resource');
      }
      if (id === 'planning') {
        const update = executions.find((execution) => execution.definitionId === 'planning.update');
        const progress = object(JSON.parse(String(object(update?.result).content)));
        check(
          progress.completePlan === true &&
            object(object(progress.steps).verify).status === 'completed',
          'plan_actual_completion',
        );
      }
      if (id === 'agents') {
        const carriers = executions.filter(
          (execution) => execution.kind === 'job' && execution.childSessionId,
        );
        check(
          carriers.length === 2 && carriers.every((carrier) => carrier.status === 'succeeded'),
          'agent_both_runs_succeeded',
        );
        const childId = carriers[0]!.childSessionId!;
        check(
          carriers.every((carrier) => carrier.childSessionId === childId),
          'agent_identity_changed',
        );
        const messages = await store.listMessages(childId, { limit: 1000 });
        check(
          ['323', '667'].every((answer) =>
            messages.some(
              (message) => message.role === 'assistant' && message.content.trim() === answer,
            ),
          ),
          'agent_actual_answers_missing',
        );
      }
      const checks = await options.verify?.(executions, run);
      const summary = scenarios.find((item) => item.name === id)!;
      if (checks) summary.checks = checks;
      summary.verified = true;
      console.log(
        JSON.stringify({
          phase: 'scenario',
          name: id,
          status: 'passed',
          runStatus: run.status,
          tools: executions.filter((entry) => entry.kind === 'tool').length,
        }),
      );
    } catch (error) {
      const point =
        error instanceof Error && /^[a-z0-9_-]+$/.test(error.message)
          ? error.message
          : 'all_tools_scenario_failed';
      failures.push({ scenario: id, point });
      if (!scenarios.some((item) => item.name === id))
        scenarios.push({ name: id, status: 'failed', point });
      else {
        const summary = scenarios.find((item) => item.name === id)!;
        summary.runStatus = summary.status;
        summary.status = 'failed';
        summary.point = point;
      }
      console.log(JSON.stringify({ phase: 'scenario_failure', name: id, point }));
      await client
        .cancelCommand(id, {
          expectedStoreId,
          commandId: `cleanup-${id}`,
          kind: 'command.cancel',
          targetCommandId: `run-${id}`,
        })
        .catch(() => {});
      if (deadline.aborted || wire.some((entry) => entry.status !== 200)) throw error;
    }
  }
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'Synthetic all-tools',
    rootUri: pathToFileURL(workspace).href,
  });
  await runCase(
    'files-shell',
    `Use the actual tools for this synthetic test. With shell_execute run ls, rg --files docs, and rg -n -F -- '[a-z]+' docs; use permissions {filesystem:"workspace_write",network:"none"}. Read source.txt via read_file, edit message=before to message=after using its exact complete-file baseline, and create result.txt containing exactly verified followed by a newline using write_file. Also use read_file to read the absolute external file ${JSON.stringify(join(root, 'external.txt'))}. Then shell_launch one command: echo BACKGROUND_STARTED; sleep 120 with the same workspace/no-network permissions. Using its returned shell_id, call shell_read, shell_wait with wait_timeout_ms:0, shell_stop with command_id:"stop-background-once" (a new cancellation intent ID, not ref.commandId), then shell_wait until its actual cancellation is terminal. Use all five Shell tools and all three file tools. Only shell_id and existing resource IDs must come from prior results; the cancellation command_id is the new literal specified above. Do not relaunch an existing command. Finally report observed search and file results, the external token, and confirmed background stop. Be concise.`,
  );
  await runCase(
    'question',
    'Ask one material synthetic choice with ask_user: choose Alpha or Beta, put Alpha first with a description. Wait for the answer and report the actual selected label. Do not answer the question yourself or use other tools.',
  );
  await runCase(
    'planning',
    'Use all four planning tools. First read_plan. Then write_plan with plan_id coverage, expected_version:null, title Coverage plan, body One bounded verification step, steps:[{id:"verify",title:"Run the synthetic check"}]. Read the saved plan and run_id with read_plan, then request_plan_review for its exact version/digest. Wait for approval. After approval use shell_execute to run printf "PLAN_VERIFIED\\n" with workspace_write/no-network permissions. Mark verify completed with update_plan_progress using the actual successful shell_execute execution_id as evidence, the exact run_id and plan identity, expected_progress_revision:null and complete_plan:true. Read the final plan and report actual completion. Never invent an execution identity.',
    true,
  );
  await runCase(
    'skills',
    'Use load_skill for the selected synthetic-knowledge skill, then read_skill_resource to read its declared reference.txt. Report the exact reference token from the actual tool result. Do not use read_file or Shell to replace either Skill tool.',
  );
  await runCase(
    'mcp',
    'Use all MCP capabilities in this bounded test. First list_mcp_sources and connect_mcp_server to the synthetic server with its actual returned server_id and a fresh key. Use refresh_mcp_catalogue with its exact connection binding, then search_mcp_tools for "Echo" and call the discovered dynamic echo_probe tool with value:"verified". Use list_mcp_resources followed by read_mcp_resource for synthetic://coverage/note, supplying exact connection and catalogue descriptor bindings from actual results. Use list_mcp_prompts followed by get_mcp_prompt for coverage_prompt with arguments:{subject:"verified"} and the exact prompt descriptor binding. Both list_mcp_resources and list_mcp_prompts require ALL FOUR connection fields: server_id, connection_key, config_digest, generation. Read/get additionally require the catalogue_execution_id and descriptor_digest from the corresponding list response. Report the three actual tokens returned by the dynamic tool, resource and prompt. Do not guess binding IDs or skip any of these eight named MCP tools.',
  );
  await runCase(
    'web',
    'Use web_fetch to fetch https://example.com/ and report the actual page title and one sentence explaining its stated purpose. Do not use Shell or memory to replace the fetch.',
  );
  await runCase(
    'agents',
    'Use all six collaborator tools. Spawn exactly one collaborator with prompt:"Calculate 17 * 19; reply with exactly 323." Wait for completion with wait_agent_events and list_agents for the returned agent_id, reading its complete result. Once idle, send_agent_message to that same agent_id with "For your next turn, preserve the first answer in history"; this alone must not start a turn. Call interrupt_agent on the idle collaborator and inspect the idle result. Then follow_up_agent on the SAME agent_id with "Calculate 23 * 29; reply with exactly 667." Wait for its second completion with wait_agent_events using the prior next_seq and list_agents for the same ID. Read the complete second result. Do not create a second agent, use a preset, invent IDs or use old tool names. If a child fails, immediately report that failure without retries, more messages or more waits. Finally report both actual answers only if both child turns succeeded.',
  );
  if (extended)
    await runExtendedToolCases({
      root,
      workspace,
      marker,
      store,
      storeId: expectedStoreId,
      client: () => client,
      async reconnect() {
        client.disposeNetwork();
        client = makeClient();
        await client.connect();
      },
      waitForRun,
      run: runCase,
      requests,
      interactions,
      transport: transportEvents,
      rpc,
    });
  const groups: Record<string, readonly string[]> = {
    'files-shell': [
      'read_file',
      'write_file',
      'edit_file',
      'shell_execute',
      'shell_launch',
      'shell_read',
      'shell_wait',
      'shell_stop',
    ],
    question: ['ask_user'],
    planning: ['read_plan', 'write_plan', 'request_plan_review', 'update_plan_progress'],
    skills: ['load_skill', 'read_skill_resource'],
    mcp: expected.filter((name) => name.includes('mcp')),
    web: ['web_fetch'],
    agents: expected.filter(
      (name) =>
        name.endsWith('_agent') ||
        name.endsWith('_agents') ||
        name === 'send_agent_message' ||
        name === 'wait_agent_events',
    ),
  };
  const required = selectedScenario
    ? (groups[selectedScenario] ?? extendedToolGroups[selectedScenario]!)
    : extended
      ? [...new Set(Object.values(extendedToolGroups).flat())]
      : expected;
  check(failures.length === 0, 'scenario_failed');
  check(
    required.every((name) =>
      [...succeededCalls].some((id) => callNames.get(id) === name && consumedCalls.has(id)),
    ),
    'expected_tool_missing',
  );
  const dynamic = [...called].filter((name) => name.startsWith('mcp_'));
  const baselineMcp = selectedScenario === 'mcp' || (!selectedScenario && !extended);
  if (baselineMcp) check(dynamic.length === 1, 'dynamic_tool_missing');
  check(
    [...names].every(
      (name) => expected.includes(name as (typeof expected)[number]) || dynamic.includes(name),
    ),
    'unaccounted_registered_tool',
  );
  if (baselineMcp)
    check(
      ['tools/call', 'resources/read', 'prompts/get'].every((method) => rpc.includes(method)),
      'mcp_effect_missing',
    );
  check(
    wire.every((entry) => entry.status === 200),
    'provider_http_failed',
  );
  report.status = 'passed';
} catch (error) {
  report.error =
    error instanceof Error && /^[a-z0-9_-]+$/.test(error.message)
      ? error.message
      : 'all_tools_attempt_failed';
  process.exitCode = 1;
} finally {
  for (const resource of cleanup.reverse()) {
    try {
      await resource.close();
    } catch {
      report.cleanupError = `${resource.name}_close_failed`;
    }
  }
  report.cleanupConfirmed = !report.cleanupError;
  if (report.cleanupError) {
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.coverage = expected.map((name) => ({
    name,
    disclosed: names.has(name),
    called: called.has(name),
    succeeded: [...succeededCalls].some((id) => callNames.get(id) === name),
    resultConsumed: [...succeededCalls].some(
      (id) => callNames.get(id) === name && consumedCalls.has(id),
    ),
  }));
  const dynamicTools = [...called].filter((name) => name.startsWith('mcp_'));
  report.dynamicTools = dynamicTools;
  report.unexpectedTools = [...names].filter(
    (name) => !expected.includes(name as (typeof expected)[number]) && !dynamicTools.includes(name),
  );
  report.rpc = rpc;
  report.durationMs = Date.now() - started;
  report.requestCount = requests.length;
  report.codeUnchanged = JSON.stringify(report.code) === JSON.stringify(liveCodeEvidence());
  if (!report.codeUnchanged) {
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.evidenceDigest = createHash('sha256').update(JSON.stringify(scenarios)).digest('hex');
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(
    JSON.stringify({
      status: report.status,
      error: report.error,
      called: [...called],
      requests: requests.length,
      cleanupConfirmed: report.cleanupConfirmed,
    }),
  );
}
