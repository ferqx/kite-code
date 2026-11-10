import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { ExecutionResources } from '../../../../packages/agent/src/execution/resources';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

// Isolated measurement executable only. None of these hooks exist in normal clients.
interface Sample {
  sessionId: string;
  commandId: string;
  scenario: string;
  submitted: number;
  acknowledged?: number;
  resolveStarted?: number;
  resolveFinished?: number;
  activated?: number;
  providerEntered?: number;
  firstPersisted?: number;
  completed?: number;
  observedCompleted?: number;
  titleInternalStarted?: number;
  titleInternalFinished?: number;
  titleProviderEntered?: number;
  titleProviderFinished?: number;
  titleQueueMs?: number;
  titleQueueOutcome?: string;
  titleSlotHeldMs?: number;
  titlePublished?: number;
  titleOutcome?: string;
  titleReason?: string;
  calls: Record<string, { count: number; totalMs: number }>;
}
const root = temporaryDirectory('kite-lifecycle-performance-');
const profileShort = process.argv.includes('--profile-short');
const outputName = process.argv
  .find((argument) => argument.startsWith('--output-name='))
  ?.slice('--output-name='.length);
if (outputName && !/^[A-Za-z0-9._-]+\.json$/.test(outputName))
  throw Error('invalid_measurement_output_name');
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
const workspace = join(root, 'workspace');
mkdirSync(workspace);
writeFileSync(join(workspace, 'AGENTS.md'), 'Use the supplied input and return a short answer.\n');
privateDirectory(profile.profilePath);
const config = join(root, 'user.jsonc');
const samples: Sample[] = [];
const byCommand = new Map<string, Sample>();
const current = new Map<string, Sample>();
const executions = new Map<string, string>();
const runs = new Map<string, string>();
const localTitle = new AsyncLocalStorage<Sample>();
let titleActive = 0,
  titlePeak = 0,
  titleQueued = 0,
  titleQueuePeak = 0;
let titleDelayMs = 100;
const acquireTitle = ExecutionResources.prototype.acquireTitleModel;
ExecutionResources.prototype.acquireTitleModel = async function (signal) {
  const sample = localTitle.getStore();
  const began = performance.now();
  titleQueued++;
  titleQueuePeak = Math.max(titleQueuePeak, titleQueued);
  let release: () => void;
  try {
    release = await acquireTitle.call(this, signal);
    if (sample) sample.titleQueueOutcome = 'admitted';
  } catch (error) {
    if (sample) {
      sample.titleQueueMs = performance.now() - began;
      sample.titleQueueOutcome =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed';
    }
    throw error;
  } finally {
    titleQueued--;
  }
  const acquired = performance.now();
  if (sample) sample.titleQueueMs = acquired - began;
  titleActive++;
  titlePeak = Math.max(titlePeak, titleActive);
  return () => {
    if (sample) sample.titleSlotHeldMs = performance.now() - acquired;
    titleActive--;
    release();
  };
};
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    const naming = body.messages.some(
      (message) =>
        message.role === 'system' && message.content.includes('readable conversation title'),
    );
    const input = body.messages
      .slice()
      .reverse()
      .find(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.startsWith('probe:'),
      )?.content;
    const sample = input ? byCommand.get(input.split(':')[2]!) : undefined;
    if (!sample) throw Error('unattributed_provider_request');
    if (naming) sample.titleProviderEntered = performance.now();
    else sample.providerEntered = performance.now();
    const chunk = (content: string, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'performance-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
    await Bun.sleep(naming ? titleDelayMs : 10);
    if (naming) sample.titleProviderFinished = performance.now();
    return new Response(
      `${chunk(naming ? '会话性能测量' : '完成', null)}${chunk('', 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
writeFileSync(
  config,
  JSON.stringify({
    modelId: 'fixture',
    tools: [],
    models: [
      {
        id: 'fixture',
        provider: 'compatible',
        model: 'local-fixture',
        baseURL: `${provider.url.href}v1`,
        options: { maxOutputTokens: 64, temperature: 0 },
      },
    ],
  }),
);
const hostStarted = performance.now();
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: config,
  observerSubjectId: 'owner',
  credentialBackend: {
    kind: 'temporary',
    put: async () => {},
    remove: async () => {},
    resolve: async () => null,
  },
});
const dbTimings: {
  operation: string;
  queueWaitMs: number;
  sqlDurationMs?: number;
  totalMs: number;
}[] = [];
const storeOpened = performance.now();
const store = await openSqliteStore({
  dataRoot: profile.dataRoot,
  profile: profile.profile,
  onTiming: (timing) => {
    dbTimings.push(timing);
  },
});
const storeReady = performance.now();
const instrumented = new Proxy(store, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function' || typeof key !== 'string') return value;
    return async (...args: unknown[]) => {
      const input = args[0] as
        | {
            sessionId?: string;
            commandId?: string;
            executionId?: string;
            parentExecutionId?: string;
            runId?: string;
            status?: string;
          }
        | undefined;
      const sessionId =
        typeof input === 'string'
          ? input
          : (input?.sessionId ??
            (input?.commandId ? byCommand.get(input.commandId)?.sessionId : undefined) ??
            (input?.executionId ? executions.get(input.executionId) : undefined) ??
            (input?.parentExecutionId ? executions.get(input.parentExecutionId) : undefined) ??
            (input?.runId ? runs.get(input.runId) : undefined));
      const sample = sessionId ? current.get(sessionId) : undefined;
      const preparing =
        sample?.resolveStarted !== undefined && sample.resolveFinished === undefined;
      const began = performance.now();
      try {
        const result = await value.apply(target, args);
        const fact = result as {
          id?: string;
          sessionId?: string;
          runId?: string;
          executionId?: string;
          execution?: { id: string; sessionId: string };
          record?: { value: { publication?: string } };
          value?: { publication?: string; closedReason?: string };
        } | null;
        if (fact?.id && fact.sessionId) {
          if (key === 'startRun') runs.set(fact.id, fact.sessionId);
          else if (['getExecution', 'planExecution', 'markRunning'].includes(key))
            executions.set(fact.id, fact.sessionId);
        }
        if (fact?.execution) executions.set(fact.execution.id, fact.execution.sessionId);
        if (fact?.executionId && sessionId) executions.set(fact.executionId, sessionId);
        if (sample) {
          const now = performance.now();
          if (key === 'startRun') sample.activated = now;
          if (key === 'persistModelPartial') sample.firstPersisted ??= now;
          if (key === 'finishRun' && input?.status === 'completed') sample.completed = now;
          if (key === 'publishAutomaticSessionTitle') {
            sample.titlePublished = now;
            sample.titleOutcome = fact?.record?.value.publication;
          }
          if (key === 'closeAutomaticSessionTitle') {
            sample.titleOutcome = fact?.value?.publication;
            sample.titleReason = fact?.value?.closedReason;
          }
        }
        return result;
      } finally {
        if (sample) {
          sample.calls[key] ??= { count: 0, totalMs: 0 };
          const metric = sample.calls[key];
          metric.count++;
          metric.totalMs += performance.now() - began;
          if (preparing) {
            const preparedKey = `prepare:${key}`;
            sample.calls[preparedKey] ??= { count: 0, totalMs: 0 };
            const preparedMetric = sample.calls[preparedKey];
            preparedMetric.count++;
            preparedMetric.totalMs += performance.now() - began;
          }
        }
      }
    };
  },
}) as Store;
const runtime = createRuntime({
  ...host,
  store: instrumented,
  permissions: host.permissions!,
  instanceId: 'performance-fixture',
  modelConcurrency: 4,
  resolveRunConfiguration: async (input) => {
    const sample = current.get(input.session.id);
    if (sample) sample.resolveStarted = performance.now();
    try {
      return await host.resolveRunConfiguration!(input);
    } finally {
      if (sample) sample.resolveFinished = performance.now();
    }
  },
});
host.permissionManagement?.(runtime);
const internalModel = runtime.runInternalModel.bind(runtime);
runtime.runInternalModel = (input) => {
  const sample = current.get(executions.get(input.parentExecutionId)!);
  if (!sample) throw Error('unattributed_title_model');
  sample.titleInternalStarted = performance.now();
  return localTitle.run(sample, () =>
    internalModel(input).finally(() => {
      sample.titleInternalFinished = performance.now();
    }),
  );
};
const storeId = (await store.getMetadata()).storeId;
await runtime.createWorkspace({
  expectedStoreId: storeId,
  id: 'w',
  name: 'Performance',
  rootUri: pathToFileURL(workspace).href,
});
const service = await startService({
  runtime,
  subjectId: 'owner',
  buildId: 'performance-fixture',
  profile: {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  },
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['commands', 'sessions'],
  },
});
await client.connect();
const connected = performance.now();
let command = 0;
async function create(sessionId: string, automatic = false) {
  await client.createSession({
    expectedStoreId: storeId,
    commandId: `create-${sessionId}`,
    sessionId,
    workspaceId: 'w',
    title: automatic ? '' : '性能测试',
  });
}
async function submit(sessionId: string, scenario: string) {
  const commandId = `work-${++command}`;
  const sample: Sample = {
    sessionId,
    commandId,
    scenario,
    submitted: performance.now(),
    calls: {},
  };
  samples.push(sample);
  byCommand.set(commandId, sample);
  current.set(sessionId, sample);
  await client.startRun(sessionId, {
    expectedStoreId: storeId,
    commandId,
    kind: 'run.start',
    content: `probe:${sessionId}:${commandId}`,
  });
  sample.acknowledged = performance.now();
  await runtime.waitForCommand(commandId, { timeoutMs: 15000 });
  const view = await client.getView(sessionId);
  if (view.runs.find((run) => run.originCommandId === commandId)?.status !== 'completed')
    throw Error('run_not_completed');
  sample.observedCompleted = performance.now();
  return sample;
}
async function titleSettled(sessionId: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const record = await store.getExtensionRecord({
      extensionId: 'builtin.session-title',
      sessionId,
      key: 'automatic-title-attempt',
    });
    const attempt = record?.value as { publication?: string; jobExecutionId?: string } | undefined;
    const job = attempt?.jobExecutionId ? await store.getExecution(attempt.jobExecutionId) : null;
    if (
      attempt?.publication !== 'pending' &&
      job &&
      ['succeeded', 'failed', 'cancelled'].includes(job.status)
    )
      return;
    if (Date.now() >= deadline) throw Error('title_not_settled');
    await Bun.sleep(10);
  }
}
let drainMs: number | undefined;
try {
  await create('history');
  await submit('history', 'first-run');
  for (let i = 0; i < 20; i++) await submit('history', 'warm-short');
  if (!profileShort) {
    for (let i = 0; i < 100; i++) await submit('history', 'seed');
    for (let i = 0; i < 20; i++) await submit('history', 'warm-long');
    for (let i = 0; i < 8; i++) {
      const id = `normal-${i}`;
      await create(id, true);
      await submit(id, 'title-normal');
      await titleSettled(id);
    }
    for (const [count, latency] of [
      [8, 100],
      [32, 1000],
      [40, 1000],
    ] as const) {
      titleDelayMs = latency;
      const ids = Array.from({ length: count }, (_, i) => `burst-${count}-${i}`);
      for (const id of ids) await create(id, true);
      await Promise.all(ids.map((id) => submit(id, `title-burst-${count}-${latency}ms`)));
      await Promise.all(ids.map(titleSettled));
    }
  }
  client.disposeNetwork();
  const began = performance.now();
  await service.close();
  drainMs = performance.now() - began;
  const output = {
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      model: 'local compatible fixture',
      mainLatencyMs: 10,
      titleLatencyMs: [100, 1000],
      modelConcurrency: 4,
      scope:
        'one in-process cold profile; warm default Service/SDK/SQLite HTTP runs; final getView observation includes 20ms waitForCommand polling; no real client paint or remote Provider qualification',
    },
    startup: {
      hostAssemblyToStoreMs: storeOpened - hostStarted,
      storeOpenMs: storeReady - storeOpened,
      storeReadyToConnectedMs: connected - storeReady,
    },
    titlePeak,
    titleQueuePeak,
    drainMs,
    samples: samples.filter((sample) => sample.scenario !== 'seed'),
    dbTimings,
  };
  const destination = join(
    process.cwd(),
    '.cache',
    outputName ??
      (profileShort
        ? 'session-lifecycle-performance.short-profile.json'
        : 'session-lifecycle-performance.after-first-run-query.json'),
  );
  mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
  writeFileSync(destination, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify({
      output: destination,
      samples: output.samples.length,
      titlePeak,
      titleQueuePeak,
      drainMs,
    }),
  );
} finally {
  client.disposeNetwork();
  await service.close();
  ExecutionResources.prototype.acquireTitleModel = acquireTitle;
  provider.stop(true);
  rmSync(root, { recursive: true, force: true });
}
