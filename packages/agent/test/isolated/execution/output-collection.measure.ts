/** Bounded local measurement, not a platform qualification or Provider benchmark.
 * Run: bun packages/agent/test/isolated/execution/output-collection.measure.ts /absolute/evidence-dir
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import {
  prepareOutputDirectory,
  withOutputCollection,
} from '../../../src/business/output-collection';
import type { JobDefinition, JobEvent, JobHandle } from '../../../src/extensions';
import { launchIdentityAsync } from '../../../src/jobs/launch-identity';
import { type AgentRuntime, createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

import { createShellExtension } from '../../../src/tools/shell';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;

async function measure(enabled: boolean, bytes: number) {
  const root = await mkdtemp(join(tmpdir(), 'kite-output-measure-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ store, profile });
  const marks: Record<string, number> = {};
  const samples: Array<{ atMs: number; rss: number; heapUsed: number; external: number }> = [];
  const mark = (key: string) => {
    marks[key] = performance.now();
  };
  const sample = () => {
    const { rss, heapUsed, external } = process.memoryUsage();
    samples.push({ atMs: performance.now(), rss, heapUsed, external });
  };
  let producerId = '';
  let ready!: () => void;
  const collected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finishExecution = store.finishExecution.bind(store);
  store.finishExecution = async (input) => {
    const result = await finishExecution(input);
    if (input.executionId === producerId) {
      mark('producerTerminalPersisted');
      sample();
    }
    return result;
  };
  const mutate = store.mutateOutputCollection.bind(store);
  store.mutateOutputCollection = async (input) => {
    const result = await mutate(input);
    if (input.mutation.kind === 'settle') {
      assert.equal(result.state, 'ready');
      mark('collectionReadyPersisted');
      sample();
      ready();
    }
    return result;
  };
  const command = bytes ? `head -c ${bytes} /dev/zero > "$KITE_OUTPUT_DIR/payload.bin"` : 'true';
  let runtime!: AgentRuntime;
  const handles = new WeakMap<JobHandle, Promise<number>>();
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Real bounded subprocess measurement fixture',
    inputSchema: { type: 'object' },
    async start(input, context) {
      producerId = context.executionId;
      const path = await mkdtemp(join(root, 'job-'));
      mark('hostPreparationStart');
      const env = enabled
        ? (await runtime.prepareOutputCollection(context, await launchIdentityAsync(path))).env
        : {};
      mark('hostPreparationEnd');
      const task = new Promise<number>((resolve, reject) => {
        const child = spawn('/bin/bash', ['-c', (input as { command: string }).command], {
          env: { ...process.env, ...env },
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          mark('producerProcessExit');
          resolve(code ?? 1);
        });
      });
      const handle = { reference: { path } };
      handles.set(handle, task);
      return handle;
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      const code = await handles.get(handle)!;
      assert.equal(code, 0);
      mark('producerTerminalYield');
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: 'succeeded',
          content: 'finished',
          details: { exitCode: code, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'unknown' };
    },
    async dispose() {},
  };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        name: 'shell_execute',
        id: 'generate',
        arguments: JSON.stringify({ command }),
      },
      { ...finish, reason: 'tool_calls' },
    ] as ModelEvent[],
    [{ type: 'text_delta', text: 'Done' }, finish],
  ]);
  const files = { id: 'builtin.files', version: '1', apiMajor: 1 as const };
  runtime = createRuntime({
    ...(enabled
      ? {
          outputCollections: {
            prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
          },
        }
      : {}),
    store,
    artifacts: {
      ...artifacts,
      async publishStream(input) {
        mark('artifactPublishStart');
        const result = await artifacts.publishStream(input);
        mark('artifactPublished');
        return result;
      },
    },
    model,
    modelId: 'fixed',
    extensions: [
      createShellExtension({ job }),
      enabled ? withOutputCollection(files, () => runtime) : files,
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const base = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  await runtime.createWorkspace({
    expectedStoreId: base.expectedStoreId,
    id: 'w',
    name: 'work',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'output' });
  sample();
  const sampler = setInterval(sample, 2);
  const cpuBefore = process.cpuUsage();
  try {
    mark('commandStart');
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Create deliverables' },
    });
    await runtime.waitForCommand('work');
    mark('runCompleted');
    if (enabled) await collected;
    mark('measurementEnd');
    sample();
    clearInterval(sampler);
    const cpu = process.cpuUsage(cpuBefore);
    const page = await runtime.queryOutputFiles(base);
    assert.equal(page.items.length, bytes ? 1 : 0);
    assert.equal(model.requests.length, 2);
    const requests = model.requests;
    const requestText = JSON.stringify(requests);
    assert(!requestText.includes('output-file-'));
    assert(!requestText.includes('collection_registered'));
    assert(!requestText.includes('output_collection_ready'));
    for (const item of page.items) {
      assert(!requestText.includes(item.fileId));
      assert.equal(Number(item.size), bytes);
      const record = await runtime.resolveOutputFile({ ...base, target: item });
      let readBytes = 0;
      for await (const chunk of artifacts.readStream({
        ...base,
        refId: record.reference.id,
        scope: record.reference.scope,
      }))
        readBytes += chunk.byteLength;
      assert.equal(readBytes, bytes);
    }
    const collectionSamples = samples.filter(
      (s) =>
        s.atMs >= marks.producerTerminalPersisted! && s.atMs <= marks.collectionReadyPersisted!,
    );
    const peak = (key: 'rss' | 'heapUsed' | 'external') =>
      Math.max(...collectionSamples.map((s) => s[key]));
    // Only opaque execution/request/source IDs and fixture paths differ between fresh stores.
    // Keep original bodies in the evidence; normalize those known nondeterministic fields for comparison.
    const normalized = requests.map(({ requestId: _requestId, messages, ...rest }) => ({
      ...rest,
      messages: messages.map(({ sourceIds: _sourceIds, ...message }) => ({
        ...message,
        content: message.content
          .replaceAll(root, '<fixture-root>')
          .replace(/^execution_id: "[^"]+"$/gm, 'execution_id: "<execution>"')
          .replace(/^shell_id: "[^"]+"$/gm, 'shell_id: "<shell>"'),
      })),
    }));
    return {
      enabled,
      bytes,
      command,
      marks,
      durationsMs: {
        hostPreparation: marks.hostPreparationEnd! - marks.hostPreparationStart!,
        commandToRunComplete: marks.runCompleted! - marks.commandStart!,
        commandToAllReady: marks.measurementEnd! - marks.commandStart!,
        terminalToReady: enabled
          ? marks.collectionReadyPersisted! - marks.producerTerminalPersisted!
          : null,
        terminalToPublished: bytes
          ? marks.artifactPublished! - marks.producerTerminalPersisted!
          : null,
        publishStream: bytes ? marks.artifactPublished! - marks.artifactPublishStart! : null,
      },
      cpuMicroseconds: cpu,
      collectionMemory: collectionSamples.length
        ? {
            samples: collectionSamples.length,
            terminalRss: collectionSamples[0]!.rss,
            peakRss: peak('rss'),
            rssIncrease: peak('rss') - collectionSamples[0]!.rss,
            peakHeapUsed: peak('heapUsed'),
            peakExternal: peak('external'),
          }
        : null,
      sampledMemory: samples,
      requestCount: requests.length,
      requestHashes: requests.map((r) => digest(JSON.stringify(r))),
      normalizedRequestHashes: normalized.map((r) => digest(JSON.stringify(r))),
      requests,
      files: page.items,
      notes: [
        'Usage counters are fixed fixture values, not measured Provider tokens.',
        'RSS is sampled every 2ms in the Bun host process, including SQLite Worker/native memory; excludes producer subprocess.',
        'Terminal is the completion of the producer finishExecution transaction; ready is completion of the collection settle transaction.',
        'Measurements exclude runtime startup and post-measurement full Artifact stream verification.',
        'Real Bash subprocess does not qualify managed bwrap/macOS/Windows execution.',
      ],
    };
  } finally {
    clearInterval(sampler);
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--case') {
  const timer = setTimeout(() => {
    throw new Error('measurement_timeout');
  }, 30000);
  const result = await measure(args[2] === 'enabled', Number(args[3]));
  clearTimeout(timer);
  await writeFile(args[1]!, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert(args[0], 'An evidence directory is required');
  const evidence = resolve(args[0]!);
  await mkdir(evidence, { recursive: true });
  const cases: Array<{ name: string; enabled: boolean; bytes: number }> = [];
  for (let run = 1; run <= 5; run++) {
    for (const enabled of run % 2 ? [false, true] : [true, false])
      cases.push({
        name: `${run}-${enabled ? 'empty-enabled' : 'empty-baseline'}`,
        enabled,
        bytes: 0,
      });
  }
  for (let run = 1; run <= 3; run++)
    for (const mib of [32, 64])
      cases.push({ name: `${run}-${mib}MiB`, enabled: true, bytes: mib * 1024 * 1024 });
  const results = [];
  for (const item of cases) {
    const path = join(evidence, `${item.name}.json`);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(import.meta.url),
        '--case',
        path,
        item.enabled ? 'enabled' : 'baseline',
        String(item.bytes),
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    );
    assert.equal(await child.exited, 0, item.name);
    const result = JSON.parse(await readFile(path, 'utf8')) as Awaited<ReturnType<typeof measure>>;
    results.push({ name: item.name, ...result });
    console.log(`${item.name}: ${JSON.stringify(result.durationsMs)}`);
  }
  const baseline = results.find((r) => !r.enabled)!;
  const summary = {
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      date: new Date().toISOString(),
    },
    normalizedEmptyRequestBodiesEqual: results
      .filter((r) => !r.bytes)
      .every(
        (r) =>
          JSON.stringify(r.normalizedRequestHashes) ===
          JSON.stringify(baseline.normalizedRequestHashes),
      ),
    results: results.map(
      ({ sampledMemory: _sampledMemory, requests: _requests, ...result }) => result,
    ),
  };
  await writeFile(join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `Evidence: ${evidence}; normalized empty requests equal: ${summary.normalizedEmptyRequestBodiesEqual}`,
  );
}
