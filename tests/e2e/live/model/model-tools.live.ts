import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Extension } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest, ModelToolCall, ModelUsage } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';

// This runner is deliberately excluded from default test discovery. Only synthetic
// fixture content reaches the selected Provider; request bodies and keys stay in memory.
const enabled = process.env.KITE_RUN_LIVE_MODEL_TOOLS === '1';
const args = process.argv.slice(2);
const output = args[0]?.startsWith('--output=') ? args[0].slice(9) : undefined;
if (args.length > 1 || (args.length && (!output || !isAbsolute(output))))
  throw Error('live_tools_arguments_invalid');
if (!enabled) throw Error('live_tools_requires_KITE_RUN_LIVE_MODEL_TOOLS_1');

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(`live_tools_${code}`);
}
function visibleRequest(request: ModelRequest): ModelRequest {
  const visible = structuredClone(request);
  for (const message of visible.messages)
    delete (message as { continuation?: unknown }).continuation;
  return visible;
}
const started = Date.now();
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
  scenarios: [],
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

  for (const scenario of ['files', 'agents'] as const) {
    const begin = Date.now();
    const firstRequest = requests.length;
    const firstCall = calls.length;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-tools-live-')));
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
    });
    let closed = false;
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
              'Create exactly one background worker sub-agent to calculate 17 * 19 and return 323. Use key arithmetic and input {"content":"Calculate 17 * 19; reply with exactly 323."}, with background result delivery. Then wait for that specific task using the dedicated task wait tool, read the completed child result, and confirm 323. Do not use polling or an event/mailbox wait. Do not create another task.',
            ];
      for (const [index, content] of prompts.entries()) {
        const commandId = `run-${index}`;
        await runtime.submitCommand({
          ...scope,
          commandId,
          request: { kind: 'run.start', content },
        });
        const command = await runtime.waitForCommand(commandId, {
          timeoutMs: Math.max(1, 240_000 - (Date.now() - started)),
        });
        check(command.status === 'applied', 'command_not_applied');
        const run = await store.getRun((command.receipt as { runId: string }).runId);
        check(run?.status === 'completed', 'run_not_completed');
      }
      const executions = await store.listExecutions('session');
      const tools = executions.filter((row) => row.kind === 'tool');
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
          : ['spawn_agent', 'wait_agents', 'read_agent'];
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
        const waits = observedCalls.filter((call) => call.name === 'wait_agents');
        check(
          observedCalls.filter((call) => call.name === 'spawn_agent').length === 1,
          'extra_child',
        );
        check(waits.length === 1, 'repeated_wait');
        check(
          isDeepStrictEqual(JSON.parse(waits[0]!.arguments).task_ids, ['arithmetic']),
          'wait_targets_mismatch',
        );
        check(
          !requests
            .slice(firstRequest)
            .some((request) => request.tools.some((tool) => tool.id === 'task_wait')),
          'hidden_wait_exposed',
        );
        const read = tools.find((row) => row.definitionId === 'task_read');
        const readCall = observedCalls.find((call) => call.name === 'read_agent')!;
        check(JSON.parse(readCall.arguments).task_id === 'arithmetic', 'read_target_mismatch');
        const details = read?.result as unknown as {
          details?: {
            agent?: {
              execution: { status: string; result: { outcome: string; content: string } | null };
              run: { status: string } | null;
            };
          };
        };
        const agent = details?.details?.agent;
        check(
          agent?.execution.status === 'succeeded' && agent.run?.status === 'completed',
          'child_not_completed',
        );
        check(
          agent.execution.result?.outcome === 'succeeded' &&
            agent.execution.result.content.trim() === '323',
          'child_result_mismatch',
        );
      }
      const snapshots = requests
        .slice(firstRequest)
        .filter((request) => executions.some((row) => row.id === request.requestId));
      for (const request of snapshots) {
        const saved = await runtime.readModelInput({ ...scope, executionId: request.requestId });
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
        const saved = await cold.readModelInput({ ...scope, executionId: request.requestId });
        check(isDeepStrictEqual(saved.request, visibleRequest(request)), 'cold_snapshot_mismatch');
      }
      check(wire.length === beforeColdRead, 'cold_read_called_provider');
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
      rmSync(root, { recursive: true, force: true });
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
  report.providerRequests = wire.length;
  report.httpStatuses = wire.map((attempt) => attempt.status);
  report.toolCalls = calls.map((call) => ({
    name: call.name,
    fields: (() => {
      try {
        return Object.keys(JSON.parse(call.arguments));
      } catch {
        return [];
      }
    })(),
  }));
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
