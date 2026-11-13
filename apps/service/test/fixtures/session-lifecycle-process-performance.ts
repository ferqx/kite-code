import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import { spawn as spawnProcess } from '../../../../scripts/tooling/process';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

// Explicit isolated process measurement. Timing, local Provider and fixed
// credentials are test composition only; no ordinary client gets a debug entry.
const root = temporaryDirectory('kite-lifecycle-process-');
const repository = resolve(import.meta.dirname, '../../../..');
const countArgument = process.argv.find((value) => value.startsWith('--samples='));
const count = countArgument ? Number(countArgument.slice('--samples='.length)) : 20;
if (!Number.isSafeInteger(count) || count < 1 || count > 100)
  throw Error('invalid_process_samples');
const workspace = join(root, 'workspace');
privateDirectory(workspace);
writeFileSync(join(workspace, 'AGENTS.md'), 'Return a short answer to the supplied task.\n');
const tracePath = join(root, 'process-trace.jsonl');
const append = (entry: object) =>
  appendFileSync(
    tracePath,
    `${JSON.stringify({ pid: process.pid, monotonicAt: performance.now(), ...entry })}\n`,
  );
const source = (path: string) => pathToFileURL(join(repository, path)).href;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
interface Sample {
  scenario: string;
  profile: string;
  began: number;
  beganWallAt: number;
  cliPid?: number;
  completedAt?: number | null;
  accepted?: number;
  terminal?: number;
  answer?: number;
  ended?: number;
  provider?: number;
  titleProvider?: number;
  titleFinished?: number;
  titleCancelled?: number;
  mainCalls: number;
  titleCalls: number;
  titleDelay: number;
  code?: number;
  stdout?: string;
  stderr?: string;
  closedFacts?: unknown;
}
const samples: Sample[] = [];
let current: Sample | undefined;
const provider = await fixtureServe({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    const naming = body.messages.some(
      (message) =>
        message.role === 'system' &&
        String(message.content).includes('readable conversation title'),
    );
    const sample = current;
    if (!sample) throw Error('process_provider_without_sample');
    if (naming) {
      sample.titleProvider = performance.now();
      sample.titleCalls++;
    } else {
      sample.provider = performance.now();
      sample.mainCalls++;
    }
    let cancelled = false;
    const encoder = new TextEncoder();
    const chunk = (text: string, finish: string | null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: 'process-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`,
      );
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const until = performance.now() + (naming ? sample.titleDelay : 10);
            while (!cancelled && performance.now() < until) {
              controller.enqueue(encoder.encode(': isolated Provider heartbeat\n\n'));
              await sleepTimer(Math.min(100, Math.max(1, until - performance.now())));
            }
            if (cancelled) return;
            controller.enqueue(chunk(naming ? '进程性能测量' : 'process complete answer', null));
            controller.enqueue(chunk('', 'stop'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            if (naming) sample.titleFinished = performance.now();
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel() {
          cancelled = true;
          if (naming) sample.titleCancelled = performance.now();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
const configurationPath = join(root, 'user.jsonc');
writeFileSync(
  configurationPath,
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
const serviceEntrypoint = join(root, 'service.js');
writeFileSync(
  serviceEntrypoint,
  `
import {appendFileSync} from 'node:fs';
const record=e=>appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({pid:process.pid,at:Date.now(),monotonicAt:performance.now(),...e})+'\\n');
record({phase:'service_entry'});
const [{runServiceProcess},{createDefaultProcessConfiguration},{selectProfile}]=await Promise.all([import(${JSON.stringify(source('apps/service/src/main.ts'))}),import(${JSON.stringify(source('apps/service/src/configuration.ts'))}),import(${JSON.stringify(source('packages/agent/src/profile.ts'))})]);
record({phase:'service_imported'});
await runServiceProcess({configure(startup,context){record({phase:'service_configuration',profile:startup.profile.profile});return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),observerSubjectId:context.subjectId,userConfigurationPath:${JSON.stringify(configurationPath)},localCodex:false,credentialBackend:{kind:'temporary',put:async()=>{},remove:async()=>{},resolve:async()=>null}});},beforeResourceClose:async()=>record({phase:'service_resource_close'})});
record({phase:'service_closed'});
`,
);
const artifact = {
  entrypoint: serviceEntrypoint,
  entrypointSha256: sha(serviceEntrypoint),
  executable: process.execPath,
  executableSha256: sha(process.execPath),
  buildId: 'lifecycle-process-fixture',
  apiMajor: 1,
};
const driver = join(root, 'cli.js');
writeFileSync(
  driver,
  `
import {appendFileSync} from 'node:fs';
const record=e=>appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({pid:process.pid,at:Date.now(),monotonicAt:performance.now(),...e})+'\\n');
record({phase:'cli_entry',profile:process.argv[2]});
const [{runCLIProcess},{AgentClient}]=await Promise.all([import(${JSON.stringify(source('apps/cli/host/main.ts'))}),import(${JSON.stringify(source('packages/client/src/index.ts'))})]);
record({phase:'cli_imported',profile:process.argv[2]});
const connect=AgentClient.prototype.connect;
AgentClient.prototype.connect=async function(...args){record({phase:'client_connect_begin',profile:process.argv[2]});const value=await connect.apply(this,args);record({phase:'client_admitted',profile:process.argv[2]});return value;};
try{process.exitCode=await runCLIProcess({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(join(root, 'data'))},profile:process.argv[2],cwd:${JSON.stringify(workspace)},argv:process.argv.slice(3)});}catch(error){process.stderr.write(String(error?.code??'process_fixture_failed')+'\\n');process.exitCode=1;}
record({phase:'cli_returned',profile:process.argv[2],code:process.exitCode});
`,
);
async function run(scenario: string, profileName: string, titleDelay = 100) {
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: profileName });
  privateDirectory(profile.profilePath);
  const sample: Sample = {
    scenario,
    profile: profileName,
    began: performance.now(),
    beganWallAt: Date.now(),
    mainCalls: 0,
    titleCalls: 0,
    titleDelay,
  };
  samples.push(sample);
  current = sample;
  const child = spawnProcess(
    [
      process.execPath,
      driver,
      profileName,
      'run',
      '--task',
      `probe:process-${scenario}`,
      '--thread',
      'original',
      '--auto',
      '--workspace',
      workspace,
    ],
    {
      cwd: workspace,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', BUN_OPTIONS: '' },
    },
  );
  sample.cliPid = child.pid;
  child.stdin.end();
  const output = (async () => {
    const reader = child.stdout.getReader();
    let pending = '',
      all = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const text = new TextDecoder().decode(next.value);
        all += text;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith('accepted ')) sample.accepted = performance.now();
          if (line.startsWith('terminal ')) sample.terminal = performance.now();
          if (line.startsWith('answer ')) sample.answer = performance.now();
        }
      }
    } finally {
      reader.releaseLock();
    }
    return all;
  })();
  const stderr = new Response(child.stderr).text();
  // This is an isolation watchdog, not a reported product shutdown deadline.
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    sample.code = await child.exited;
    sample.ended = performance.now();
    sample.stdout = await output;
    sample.stderr = await stderr;
  } finally {
    clearTimeout(timer);
  }
  if (
    sample.code !== 0 ||
    !sample.stdout?.includes('process complete answer') ||
    !sample.terminal ||
    sample.mainCalls !== 1
  )
    throw Error(`process_sample_failed:${scenario}:${sample.stderr}`);
  const closed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  try {
    const view = await closed.getView('original');
    const runs = view?.runs ?? [];
    if (!runs.length || runs.some((run) => run.isActive || run.status !== 'completed'))
      throw Error('process_closed_run_not_completed');
    const commandId = sample.stdout!.match(/^accepted (\S+)$/m)?.[1];
    sample.completedAt = runs.find((run) => run.originCommandId === commandId)?.finishedAt;
    if (!sample.completedAt) throw Error('process_original_run_missing');
    const titleAttempt = await closed.getExtensionRecord({
      extensionId: 'builtin.session-title',
      sessionId: 'original',
      key: 'automatic-title-attempt',
    });
    const publication =
      titleAttempt?.value &&
      typeof titleAttempt.value === 'object' &&
      !Array.isArray(titleAttempt.value)
        ? titleAttempt.value.publication
        : undefined;
    if (publication !== 'published' && publication !== 'closed')
      throw Error('process_title_not_settled');
    sample.closedFacts = {
      title: view?.session.title,
      titleAttempt: titleAttempt?.value,
      runs: runs.map(({ id, status }) => ({ id, status })),
      executions: view?.executions.map(
        ({ id, kind, runId, parentExecutionId, definitionId, status, deliveryReason }) => ({
          id,
          kind,
          runId,
          parentExecutionId,
          definitionId,
          status,
          deliveryReason,
        }),
      ),
    };
  } finally {
    await closed.close();
  }
  append({ phase: 'sample_verified', at: Date.now(), scenario, profile: profileName });
  console.log(
    JSON.stringify({
      scenario,
      startToProviderMs: sample.provider! - sample.began,
      terminalMs: sample.terminal - sample.began,
      exitMs: sample.ended! - sample.began,
      titleCalls: sample.titleCalls,
      code: sample.code,
    }),
  );
}
let failure: unknown;
try {
  for (let index = 0; index < count; index++) await run('fresh-profile', `fresh-${index}`);
  for (let index = 0; index < count; index++) await run('reopened-profile', 'fresh-0');
  await run('title-delay-3s', 'title-3s', 3000);
  await run('title-delay-10s', 'title-10s', 10000);
} catch (error) {
  failure = error;
} finally {
  provider.stop(true);
  const output = resolve(
    repository,
    '.cache',
    `session-lifecycle-process-${count}-${randomUUID()}.json`,
  );
  writeFileSync(
    output,
    JSON.stringify(
      {
        environment: {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          timing:
            'launch/provider/terminal/exit use the parent monotonic clock; child phases use their own process monotonic clock; wall timestamps correlate identities only',
        },
        root,
        processTrace: readFileSync(tracePath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        samples,
        failure: failure instanceof Error ? failure.message : (failure ?? null),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, root, samples: samples.length, failed: !!failure }));
}
if (failure) throw failure;
