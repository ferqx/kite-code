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
import { AgentError, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Extension } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest, ModelToolCall, ModelUsage } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';
import { liveCodeEvidence } from './live-code-evidence';
import { summarizeLiveToolCalls } from './live-model-fixture';

// This runner is deliberately excluded from default test discovery. Only synthetic
// fixture content reaches the selected Provider; request bodies and keys stay in memory.
const enabled = process.env.KITE_RUN_LIVE_MODEL_TOOLS === '1';
const args = process.argv.slice(2);
const outputArgs = args.filter((arg) => arg.startsWith('--output='));
const scenarioArgs = args.filter((arg) => arg.startsWith('--scenario='));
const output = outputArgs[0]?.slice(9);
const selectedScenario = scenarioArgs[0]?.slice(11);
if (
  outputArgs.length > 1 ||
  scenarioArgs.length > 1 ||
  args.length !== outputArgs.length + scenarioArgs.length ||
  (output !== undefined &&
    (!isAbsolute(output) || existsSync(output) || existsSync(`${output}.workspace`))) ||
  (selectedScenario !== undefined && !['files', 'agents'].includes(selectedScenario))
)
  throw Error('live_tools_arguments_invalid');
if (!enabled) throw Error('live_tools_requires_KITE_RUN_LIVE_MODEL_TOOLS_1');

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(`live_tools_${code}`);
}
function toolDetails(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'result_invalid');
  const result = value as Record<string, unknown>;
  check(result.outcome === 'succeeded' && typeof result.content === 'string', 'result_failed');
  return JSON.parse(result.content) as Record<string, unknown>;
}
function visibleRequest(request: ModelRequest): ModelRequest {
  const visible = structuredClone(request);
  for (const message of visible.messages)
    delete (message as { continuation?: unknown }).continuation;
  return visible;
}
const started = Date.now();
const monotonicStarted = performance.now();
const deadline = AbortSignal.timeout(240_000);
const requests: ModelRequest[] = [];
const calls: ModelToolCall[] = [];
const usage: ModelUsage[] = [];
const wire: { status: number; tools: string[] }[] = [];
const report: Record<string, unknown> = {
  version: 1,
  date: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  network: 'configured-provider-direct-no-fallback',
  command: 'KITE_RUN_LIVE_MODEL_TOOLS=1 bun run test:model:tools:live',
  requestLimit: 20,
  timeoutMs: 240_000,
  selectedScenario: selectedScenario ?? 'all',
  scenarios: [],
  code: liveCodeEvidence(),
};

async function main() {
  const configuration = createUserConfiguration();
  const value = configuration.read().value;
  const selected = (Array.isArray(value.models) ? value.models : []).find(
    (model) =>
      model && typeof model === 'object' && !Array.isArray(model) && model.id === value.modelId,
  );
  check(selected && typeof selected === 'object' && !Array.isArray(selected), 'default_missing');
  check(selected.enabled !== false, 'default_disabled');
  check(
    typeof selected.model === 'string' && typeof selected.baseURL === 'string',
    'model_invalid',
  );
  check(
    ['openai', 'deepseek', 'compatible', 'ollama'].includes(String(selected.provider)),
    'provider_invalid',
  );
  const protocol = selected.protocol ?? 'chat-completions';
  check(protocol === 'chat-completions' || protocol === 'responses', 'protocol_invalid');
  const configuredPreset = parseModelPreset(selected.options);
  const preset = {
    ...configuredPreset,
    maxOutputTokens: Math.min(configuredPreset.maxOutputTokens ?? 4096, 4096),
  };
  report.model = selected.model;
  report.provider = selected.provider;
  report.protocol = protocol;
  report.settings = preset;
  const vault = createCredentialVault({
    backend: createOsCredentialBackend({ service: 'kite-agent', accountNamespace: 'user-models' }),
  });
  check(
    selected.credentialRef === undefined || typeof selected.credentialRef === 'string',
    'credential_invalid',
  );
  const apiKey =
    typeof selected.credentialRef === 'string'
      ? (configuration.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined;
  const fetchProvider: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      check(wire.length < 20, 'request_budget_exhausted');
      deadline.throwIfAborted();
      const body = JSON.parse(String(init?.body)) as {
        tools?: { type: string; name?: string; function?: { name: string } }[];
      };
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
      check(
        tools.every((name) => /^[a-z][a-z0-9_]{0,63}$/.test(name)),
        'wire_name_invalid',
      );
      const observation = { status: 0, tools };
      wire.push(observation);
      try {
        const response = await fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            deadline,
            AbortSignal.timeout(60_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        observation.status = response.status;
        return response;
      } catch {
        throw Error('live_tools_transport_failed');
      }
    },
    { preconnect: fetch.preconnect },
  );
  const sdk = createSdkModelAdapter({
    models: new Map([
      [
        'live',
        createCompatibleModelBinding({
          name: String(selected.provider),
          baseURL: selected.baseURL,
          modelId: selected.model,
          protocol,
          apiKey,
          fetch: fetchProvider,
        }),
      ],
    ]),
    presets: new Map([['live', preset]]),
  });
  const model: ModelAdapter = {
    describeRequest: sdk.describeRequest?.bind(sdk),
    async *stream(request, options) {
      deadline.throwIfAborted();
      check(requests.length < 20, 'request_budget_exhausted');
      requests.push(structuredClone(request));
      const signal = AbortSignal.any([deadline, options.signal]);
      try {
        for await (const event of sdk.stream(request, { signal })) {
          if (event.type === 'tool_call') calls.push(structuredClone(event));
          if (event.type === 'finish') usage.push(event.usage);
          yield event;
        }
      } catch {
        // Fail this live attempt immediately. Do not retry or change model/protocol.
        throw Error('live_tools_provider_attempt_failed');
      }
    },
  };

  for (const scenario of (['files', 'agents'] as const).filter(
    (name) => selectedScenario === undefined || name === selectedScenario,
  )) {
    const begin = Date.now();
    const firstRequest = requests.length;
    const firstCall = calls.length;
    const root = output
      ? (() => {
          const path = `${output}.workspace`;
          mkdirSync(path, { mode: 0o700 });
          return realpathSync(path);
        })()
      : realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-tools-live-')));
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'docs'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'source.txt'), 'message=before\nmode=test\n');
    writeFileSync(join(workspace, 'docs', 'sample.md'), 'literal needle [a-z]+\n');
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    const store = await openSqliteStore(profile);
    const files = createWorkspaceFiles({ root: workspace });
    const authorizations: AuthorizationRequest[] = [];
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description: 'Answer one bounded arithmetic task. Input must contain content.',
        },
      ],
    });
    const extensions: Extension[] =
      scenario === 'files'
        ? [{ id: 'live.files', version: '1', apiMajor: 1, tools: createFileTools(files) }]
        : [task];
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'live',
      modelConcurrency: 2,
      extensions,
      permissions: {
        async authorize(request) {
          authorizations.push(request);
          return { allowed: true, revision: 'explicit-owned-live-fixture' };
        },
      },
      childConfigurations:
        scenario === 'agents'
          ? [{ id: 'worker', version: '1', model, modelId: 'live', toolIds: [], snapshot: {} }]
          : [],
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'explicit-owned-live-completion' };
        },
      },
    });
    let closed = false;
    let passed = false;
    let cold: ReturnType<typeof createRuntime> | undefined;
    try {
      const storeId = (await store.getMetadata()).storeId;
      const scope = { expectedStoreId: storeId, sessionId: 'session', subjectId: 'live-owner' };
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        name: 'Synthetic live tools',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...scope,
        workspaceId: 'workspace',
        commandId: 'create',
        title: 'Synthetic tool test',
      });
      const prompts =
        scenario === 'files'
          ? [
              'Work only in this synthetic workspace. List the root directory; glob docs/**/*.md; search docs for the literal text [a-z]+. Read source.txt starting at line 1 (at most 20 lines). Use its exact returned complete-file baseline to edit message=before to message=after with exactly one match. Create result.txt with exactly verified and a trailing newline, using the tool for creating files. Complete all steps with the provided tools, then briefly confirm.',
              'Read source.txt and result.txt again using the tools and confirm their actual contents. Keep the final response short.',
            ]
          : [
              'Use the six collaborator tools to perform this bounded synthetic test. First spawn exactly one collaborator with only prompt: "Calculate 17 * 19; reply with exactly 323." Retain its returned agent_id. Wait for its completion using wait_agent_events with a finite wait_ms, then list_agents filtered to that agent_id and read its complete result, which must be 323. Once it is truly idle, send_agent_message to it with "For your next turn, preserve the first answer in your history"; this message alone must not start a turn. Use interrupt_agent on that idle collaborator and observe the idle outcome. Then follow_up_agent on the SAME agent_id with "Calculate 23 * 29; reply with exactly 667." Wait for the second completion using wait_agent_events with the previous next_seq, then list_agents for the same ID and read the new complete result. Do not create a second collaborator, use a preset, use old tool names or invent IDs. Finally briefly report both verified answers.',
            ];
      for (const [index, content] of prompts.entries()) {
        const commandId = `run-${index}`;
        await runtime.submitCommand({
          ...scope,
          commandId,
          request: { kind: 'run.start', content },
        });
        let command: Awaited<ReturnType<typeof runtime.waitForCommand>> | undefined;
        while (!command) {
          deadline.throwIfAborted();
          const current = await store.getCommand(commandId);
          check(
            (current?.receipt as { outcome?: string } | null)?.outcome !== 'human_input_unresolved',
            'human_input_unresolved',
          );
          try {
            command = await runtime.waitForCommand(commandId, {
              timeoutMs: Math.min(100, Math.max(1, 240_000 - (Date.now() - started))),
              signal: deadline,
            });
          } catch (error) {
            if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
          }
        }
        check(command.status === 'applied', 'command_not_applied');
        const run = await store.getRun((command.receipt as { runId: string }).runId);
        check(run?.status === 'completed', 'run_not_completed');
      }
      const executions = await store.listExecutions('session');
      const tools = executions.filter((row) => row.kind === 'tool');
      const spawnResult = tools.find((row) => row.definitionId === 'task.spawn')?.result;
      const spawnedAgentId = spawnResult ? toolDetails(spawnResult).agent_id : null;
      report.toolExecutions = tools.map((row) => {
        const result =
          row.result && typeof row.result === 'object' && !Array.isArray(row.result)
            ? row.result
            : {};
        let details: Record<string, unknown> = {};
        try {
          if (typeof result.content === 'string')
            details = JSON.parse(result.content) as Record<string, unknown>;
        } catch {}
        const failure =
          details.error && typeof details.error === 'object' && !Array.isArray(details.error)
            ? (details.error as Record<string, unknown>).code
            : result.code;
        const input =
          row.input && typeof row.input === 'object' && !Array.isArray(row.input) ? row.input : {};
        return {
          definitionId: row.definitionId,
          status: row.status,
          outcome: result.outcome,
          errorCode:
            typeof failure === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(failure) ? failure : null,
          targetMatchesSpawn:
            typeof input.agentId === 'string' ? input.agentId === spawnedAgentId : null,
        };
      });
      check(
        tools.every((row) => row.status === 'succeeded'),
        'tool_failed',
      );
      const observedCalls = calls.slice(firstCall);
      const expected =
        scenario === 'files'
          ? [
              'list_directory',
              'glob_files',
              'search_content',
              'read_file',
              'edit_file',
              'write_file',
            ]
          : [
              'spawn_agent',
              'wait_agent_events',
              'list_agents',
              'send_agent_message',
              'interrupt_agent',
              'follow_up_agent',
            ];
      check(
        expected.every((name) => observedCalls.some((call) => call.name === name)),
        'required_tool_missing',
      );
      if (scenario === 'files') {
        check(
          readFileSync(join(workspace, 'source.txt'), 'utf8') === 'message=after\nmode=test\n',
          'edit_effect_mismatch',
        );
        check(
          readFileSync(join(workspace, 'result.txt'), 'utf8') === 'verified\n',
          'write_effect_mismatch',
        );
        const edit = tools.find((row) => row.definitionId === 'files.edit');
        check(
          edit?.input &&
            typeof edit.input === 'object' &&
            !Array.isArray(edit.input) &&
            edit.input.find === 'message=before' &&
            edit.input.replace === 'message=after',
          'internal_edit_mismatch',
        );
        check(
          authorizations.some((request) => request.definitionId === 'files.edit'),
          'internal_authorization_missing',
        );
        const editCall = observedCalls.find((call) => call.name === 'edit_file')!;
        check(JSON.parse(editCall.arguments).old_text === 'message=before', 'public_edit_mismatch');
      } else {
        check(
          observedCalls.filter((call) => call.name === 'spawn_agent').length === 1,
          'extra_child',
        );
        const spawn = tools.find((row) => row.definitionId === 'task.spawn');
        check(spawn, 'spawn_record_missing');
        const agentId = toolDetails(spawn.result).agent_id;
        check(typeof agentId === 'string', 'agent_id_missing');
        const agentPage = await store.listStableAgents({
          ...scope,
          extensionId: 'builtin.task',
          agentIds: [agentId],
          limit: 1,
        });
        const agent = agentPage.items[0];
        check(agentPage.items.length === 1 && agentPage.nextAfterSeq === null, 'directory_invalid');
        check(agent?.agentId === agentId && agent.state === 'idle', 'child_not_idle');
        check(
          agent.lastOutcome === 'succeeded' &&
            agent.configurationId === 'worker' &&
            agent.lastResultSource !== null,
          'child_configuration_mismatch',
        );
        const result = JSON.parse(agent.lastResultSource.content) as {
          outcome: string;
          content: string;
        };
        check(
          result.outcome === 'succeeded' && result.content.trim() === '667',
          'child_result_mismatch',
        );
        const carriers = executions.filter((row) => row.childSessionId === agentId);
        check(carriers.length === 2, 'carrier_count_mismatch');
        check(
          carriers.every((row) => row.status === 'succeeded'),
          'carrier_not_succeeded',
        );
        check(
          (carriers[0]!.result as { content: string }).content.trim() === '323' &&
            (carriers[1]!.result as { content: string }).content.trim() === '667',
          'carrier_result_mismatch',
        );
        check(
          carriers.every((row) => row.childConfiguration?.id === 'worker'),
          'carrier_configuration_mismatch',
        );
        const childExecutions = await store.listExecutions(agentId);
        const childModels = childExecutions.filter((row) => row.kind === 'model');
        check(
          childModels.length === 2 && childModels.every((row) => row.status === 'succeeded'),
          'child_model_count_mismatch',
        );
        check(new Set(childModels.map((row) => row.runId)).size === 2, 'child_run_not_reused');
        for (const row of childModels)
          check((await store.getRun(row.runId!))?.status === 'completed', 'child_not_completed');
        const mails = await store.listAgentMessages({ ...scope, sessionId: agentId });
        check(mails.items.length === 1 && mails.nextAfterSeq === null, 'idle_mail_count_mismatch');
        const mail = mails.items[0]!;
        const childRequests = requests
          .slice(firstRequest)
          .filter((request) => childModels.some((row) => row.id === request.requestId));
        const receivingRequest = childRequests.find((request) =>
          request.messages.some((message) => message.sourceIds?.includes(mail.id)),
        );
        check(
          mail.state === 'received' &&
            mail.targetRunId === null &&
            receivingRequest &&
            childModels.find((row) => row.id === receivingRequest.requestId)?.runId ===
              mail.receivedRunId &&
            receivingRequest.messages.filter((message) => message.sourceIds?.includes(mail.id))
              .length === 1 &&
            childRequests.filter((request) =>
              request.messages.some((message) => message.sourceIds?.includes(mail.id)),
            ).length === 1 &&
            (await store.listMessages(agentId)).filter((message) =>
              message.sourceIds?.includes(mail.id),
            ).length === 1,
          'idle_mail_adoption_mismatch',
        );
        report.idleMailAdoptedOnce = true;
        const followUps = tools.filter((row) => row.definitionId === 'task.follow_up');
        check(followUps.length === 1, 'follow_up_count_mismatch');
        check(
          toolDetails(followUps[0]!.result).mode === 'new_turn' &&
            toolDetails(followUps[0]!.result).agent_id === agentId,
          'follow_up_target_mismatch',
        );
        const interrupt = tools.find((row) => row.definitionId === 'task.interrupt');
        check(
          interrupt && toolDetails(interrupt.result).outcome === 'idle',
          'idle_interrupt_mismatch',
        );
        const names = [
          'follow_up_agent',
          'interrupt_agent',
          'list_agents',
          'send_agent_message',
          'spawn_agent',
          'wait_agent_events',
        ];
        const processingIds = new Set<string>();
        for (const row of executions.filter((row) => row.kind === 'model')) {
          check(row.runId, 'model_run_missing');
          const savedRun = await store.getRun(row.runId);
          const configuration = savedRun?.configuration as {
            snapshot?: { kind?: string };
          };
          if (configuration?.snapshot?.kind === 'human_input_processing') processingIds.add(row.id);
        }
        const parentRequests = requests
          .slice(firstRequest)
          .filter((request) => executions.some((row) => row.id === request.requestId));
        check(
          parentRequests
            .filter((request) => !processingIds.has(request.requestId))
            .every((request) =>
              isDeepStrictEqual(request.tools.map((tool) => tool.id).sort(), names),
            ),
          'collaboration_schema_mismatch',
        );
        check(
          parentRequests
            .filter((request) => processingIds.has(request.requestId))
            .every((request) => request.tools.length === 0),
          'input_processing_exposed_tools',
        );
        report.inputProcessingRequests = processingIds.size;
        for (const carrier of carriers) {
          const acceptance = carrier.resultAcceptance;
          check(
            acceptance && acceptance.resultRevision === carrier.resultRevision,
            'result_acceptance_missing',
          );
          check(
            requests
              .slice(firstRequest)
              .some((request) =>
                request.messages.some((message) =>
                  message.sourceIds?.includes(acceptance.sourceId),
                ),
              ),
            'accepted_source_not_prepared',
          );
        }
        executions.push(...childExecutions);
      }
      const snapshots = requests
        .slice(firstRequest)
        .filter((request) => executions.some((row) => row.id === request.requestId));
      for (const request of snapshots) {
        const execution = executions.find((row) => row.id === request.requestId)!;
        const saved = await runtime.readModelInput({
          ...scope,
          sessionId: execution.sessionId,
          executionId: request.requestId,
        });
        const visible = visibleRequest(request);
        if (!isDeepStrictEqual(saved.request, visible)) {
          report.snapshotComparison = {
            toolsEqual: isDeepStrictEqual(saved.request.tools, visible.tools),
            messagesEqual: isDeepStrictEqual(saved.request.messages, visible.messages),
            modelIdEqual: saved.request.modelId === visible.modelId,
            requestIdEqual: saved.request.requestId === visible.requestId,
          };
          check(false, 'public_snapshot_mismatch');
        }
      }
      check(
        snapshots.some((request) => request.messages.some((message) => message.toolCalls?.length)),
        'public_history_missing',
      );
      await runtime.close();
      closed = true;
      const reader = await openSqliteStore({ ...profile, mode: 'readonly' });
      cold = createRuntime({
        store: reader,
        artifacts: createArtifactStore({ profile, store: reader }),
        permissions: { authorize: async () => ({ allowed: false, revision: 'readonly' }) },
      });
      const beforeColdRead = wire.length;
      for (const request of snapshots) {
        const execution = executions.find((row) => row.id === request.requestId)!;
        const saved = await cold.readModelInput({
          ...scope,
          sessionId: execution.sessionId,
          executionId: request.requestId,
        });
        check(isDeepStrictEqual(saved.request, visibleRequest(request)), 'cold_snapshot_mismatch');
      }
      check(wire.length === beforeColdRead, 'cold_read_called_provider');
      passed = true;
      (report.scenarios as unknown[]).push({
        name: scenario,
        status: 'passed',
        providerRequests: requests.length - firstRequest,
        toolCalls: observedCalls.length,
        tools: [...new Set(observedCalls.map((call) => call.name))],
        snapshots: snapshots.length,
        durationMs: Date.now() - begin,
      });
      console.log(
        JSON.stringify({
          scenario,
          status: 'passed',
          providerRequests: requests.length - firstRequest,
        }),
      );
    } finally {
      if (!closed) await runtime.close();
      await cold?.close();
      await files.close();
      if (passed || !output) rmSync(root, { recursive: true, force: true });
      else report.failedCanonicalStoreRetained = true;
    }
  }
}

try {
  await main();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error =
    error instanceof Error && /^live_tools_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'live_tools_unexpected_failure';
  process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - started;
  report.monotonicDurationMs = performance.now() - monotonicStarted;
  report.finishedAt = new Date().toISOString();
  report.providerRequests = wire.length;
  report.httpStatuses = wire.map((attempt) => attempt.status);
  report.toolCalls = summarizeLiveToolCalls(requests, calls);
  report.usage = {
    inputTokens: usage.reduce((total, item) => total + (item.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
    requestsWithUsage: usage.length,
    requestsWithInputTokens: usage.filter((item) => item.inputTokens !== null).length,
    requestsWithOutputTokens: usage.filter((item) => item.outputTokens !== null).length,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  console.log(text);
}
