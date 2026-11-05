import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { privateDirectory } from '../../../fixtures/test-filesystem';

// An explicit, synthetic-only test program. No production feature flag or live Provider.
const args = process.argv.slice(2);
const generate = args.find((arg) => arg.startsWith('--generate='))?.slice(11);
if (generate) {
  if (args.length !== 1 || !isAbsolute(generate)) throw Error('image_benchmark_arguments_invalid');
  const require = createRequire(
    new URL('../../../../packages/agent/package.json', import.meta.url),
  );
  const { createCanvas } =
    require('@napi-rs/canvas') as typeof import('../../../../packages/agent/node_modules/@napi-rs/canvas');
  for (const [name, width, height, noise, format] of [
    ['ui', 1920, 1080, false, 'png'],
    ['jpeg12mp', 4000, 3000, true, 'jpeg'],
    ['flat32mp', 8000, 4000, false, 'png'],
    ['alpha', 2048, 2048, true, 'webp'],
  ] as const) {
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    if (noise) {
      const pixels = ctx.createImageData(width, height);
      let state = 0x12345678;
      for (let at = 0; at < pixels.data.length; at++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        pixels.data[at] = at % 4 === 3 && name !== 'alpha' ? 255 : state & 255;
      }
      ctx.putImageData(pixels, 0, 0);
    } else {
      ctx.fillStyle = '#203060';
      ctx.font = '28px sans-serif';
      for (let row = 0; row < 20; row++)
        ctx.fillText(`Synthetic image benchmark row ${row}: Kite 12345`, 30, 50 + row * 45);
    }
    writeFileSync(
      join(generate, `${name}.${format}`),
      await (format === 'png' ? canvas.encode('png') : canvas.encode(format, 90)),
    );
  }
  process.exit(0);
}
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
const selectedCase = args.find((arg) => arg.startsWith('--case='))?.slice(7);
if (
  selectedCase &&
  !['ui', 'jpeg12mp', 'flat32mp', 'alpha', 'ui-soak', 'ui-batch10'].includes(selectedCase)
)
  throw Error('image_benchmark_arguments_invalid');
if (
  args.length !== (selectedCase ? 2 : 1) ||
  !output ||
  !isAbsolute(output) ||
  existsSync(output) ||
  existsSync(`${output}.workspace`)
)
  throw Error('image_benchmark_arguments_invalid');
const root = `${output}.workspace`;
privateDirectory(root);
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const generator = Bun.spawn([process.execPath, import.meta.path, `--generate=${workspace}`], {
  stdout: 'inherit',
  stderr: 'inherit',
  windowsHide: true,
});
if ((await generator.exited) !== 0) throw Error('image_benchmark_fixture_failed');
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
privateDirectory(profile.profilePath);
const user = join(profile.profilePath, 'config.jsonc');
writeFileSync(
  user,
  JSON.stringify({
    modelId: 'fixed',
    models: [
      { id: 'fixed', provider: 'compatible', model: 'unused', baseURL: 'http://127.0.0.1:9/v1' },
    ],
    tools: [{ id: 'files.view_images', definitionVersion: '1' }],
  }),
);
let path = '',
  call = true,
  received = 0,
  receivedCalls = 0,
  expectedImages = 0;
let batchPaths: string[] | undefined;
let phase = 'setup',
  activeCase = '';
const model: ModelAdapter = {
  async *stream(request) {
    if (call) {
      phase = 'provider-call';
      call = false;
      yield {
        type: 'tool_call',
        id: 'image',
        name: 'view_images',
        arguments: JSON.stringify(batchPaths ? { paths: batchPaths } : { path }),
      };
    } else {
      phase = 'provider-image';
      const image = request.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'image',
      );
      if (image?.images?.length !== (batchPaths?.length ?? 1))
        throw Error('image_benchmark_handoff_failed');
      if (
        batchPaths &&
        JSON.stringify(
          JSON.parse(image.content).images.map((item: { path: string }) => item.path),
        ) !== JSON.stringify(batchPaths)
      )
        throw Error('image_benchmark_handoff_failed');
      received += image.images.length;
      receivedCalls++;
      yield { type: 'text_delta', text: 'received' };
    }
    yield {
      type: 'finish',
      reason: call ? 'tool_calls' : 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    phase = 'settle-run';
  },
};
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: user,
  localCodex: false,
  credentialBackend: createTemporaryCredentialBackend(),
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'synthetic-benchmark' };
    },
  },
});
let toolMs = 0;
const extensions = host.extensions!.map((extension) => ({
  ...extension,
  tools: extension.tools?.map((tool) =>
    tool.id !== 'files.view_images'
      ? tool
      : {
          ...tool,
          async execute(input, context) {
            phase = 'image-tool';
            const started = performance.now();
            try {
              return await tool.execute(input, context);
            } finally {
              toolMs = performance.now() - started;
              phase = 'prepare-image';
            }
          },
        },
  ),
}));
const store = await openSqliteStore(profile),
  expectedStoreId = (await store.getMetadata()).storeId;
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile, store }),
  extensions,
  permissions: host.permissions!,
  resolveRunConfiguration: async (input) => ({
    ...(await host.resolveRunConfiguration!(input)),
    model,
  }),
});
host.permissionManagement?.(runtime);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  synthetic: true,
  providerRequests: 0,
  perImageInputLimit: 16 * 1024 * 1024,
  codecJobMemoryLimit: process.platform === 'win32' ? 512 * 1024 * 1024 : null,
  memoryScope:
    'main benchmark/Service process RSS; codec excluded, Windows codec Job limited separately',
  cases: [],
};
let index = 0,
  mainPeak = process.memoryUsage.rss(),
  maxTickMs = 0,
  previousTick = performance.now();
const gaps: unknown[] = [];
const sampler = setInterval(() => {
  mainPeak = Math.max(mainPeak, process.memoryUsage.rss());
  const now = performance.now();
  maxTickMs = Math.max(maxTickMs, now - previousTick);
  if (now - previousTick > 100) gaps.push({ ms: now - previousTick, phase, name: activeCase });
  previousTick = now;
}, 10);
try {
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'benchmark',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const [name, file, count] of [
    ['ui', 'ui.png', 6],
    ['jpeg12mp', 'jpeg12mp.jpeg', 6],
    ['flat32mp', 'flat32mp.png', 6],
    ['alpha', 'alpha.webp', 6],
    ['ui-soak', 'ui.png', 30],
    ['ui-batch10', 'ui.png', 6],
  ] as const) {
    if (selectedCase && selectedCase !== name) continue;
    activeCase = name;
    path = join(workspace, file);
    batchPaths =
      name === 'ui-batch10'
        ? Array.from({ length: 10 }, (_, i) => join(workspace, `batch-${i}.png`))
        : undefined;
    batchPaths?.forEach((target) => {
      copyFileSync(path, target);
    });
    const source = readFileSync(path),
      samples: { totalMs: number; toolMs: number }[] = [];
    const before = process.memoryUsage.rss();
    let outputBytes = 0,
      dimensions: unknown;
    for (let sample = 0; sample < count; sample++) {
      phase = 'session-setup';
      const sessionId = `s-${++index}`,
        commandId = `run-${index}`,
        scope = { expectedStoreId, sessionId, subjectId: 'owner' };
      await runtime.createSession({
        ...scope,
        commandId: `create-${index}`,
        workspaceId: 'w',
        title: name,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        ...scope,
        workspaceId: 'w',
        mode: 'full',
        trusted: true,
      });
      call = true;
      expectedImages += batchPaths?.length ?? 1;
      phase = 'prepare-call';
      const started = performance.now();
      await runtime.submitCommand({
        ...scope,
        commandId,
        request: { kind: 'run.start', content: 'Read the exact synthetic image with view_images.' },
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 45000 });
      const run = await store.getRun((command.receipt as { runId: string }).runId);
      if (run?.status !== 'completed') throw Error(`image_benchmark_run_failed:${run?.status}`);
      samples.push({ totalMs: performance.now() - started, toolMs });
      const execution = (await store.listExecutions(sessionId)).find(
        (x) => x.definitionId === 'files.view_images',
      );
      if (execution?.status !== 'succeeded') throw Error('image_benchmark_tool_failed');
      const value = JSON.parse((execution.result as { content: string }).content);
      outputBytes = batchPaths
        ? value.images.reduce((sum: number, image: { size: number }) => sum + image.size, 0)
        : value.size;
      dimensions = batchPaths
        ? value.images.map((image: { width: number; height: number }) => [
            image.width,
            image.height,
          ])
        : [value.width, value.height];
    }
    const sorted = samples.map((s) => s.totalMs).sort((a, b) => a - b),
      tools = samples.map((s) => s.toolMs).sort((a, b) => a - b);
    const item = {
      name,
      sourceBytes: source.length,
      sourceHash: createHash('sha256').update(source).digest('hex'),
      outputBytes,
      dimensions,
      count,
      imagesPerCall: batchPaths?.length ?? 1,
      coldMs: samples[0],
      totalP50Ms: sorted[Math.ceil(count * 0.5) - 1],
      totalP95Ms: sorted[Math.ceil(count * 0.95) - 1],
      toolP50Ms: tools[Math.ceil(count * 0.5) - 1],
      toolP95Ms: tools[Math.ceil(count * 0.95) - 1],
      mainRssBefore: before,
      mainRssAfter: process.memoryUsage.rss(),
      samples,
    };
    (report.cases as unknown[]).push(item);
    console.log(JSON.stringify({ name, count, p50Ms: item.totalP50Ms, p95Ms: item.totalP95Ms }));
  }
  report.receivedImages = received;
  report.passed = receivedCalls === index && received === expectedImages && index > 0;
} catch (error) {
  report.passed = false;
  report.failure =
    error instanceof Error && /^image_benchmark_/.test(error.message)
      ? error.message
      : 'image_benchmark_failed';
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  report.mainPeakRss = mainPeak;
  report.max10msTimerGap = maxTickMs;
  report.timerGapsOver100ms = gaps;
  try {
    await runtime.close();
  } catch {
    report.cleanupFailed = true;
    process.exitCode = 1;
  }
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ passed: report.passed, mainPeakRss: mainPeak, max10msTimerGap: maxTickMs }),
  );
}
