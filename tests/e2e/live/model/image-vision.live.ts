import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import {
  createDefaultProcessConfiguration,
  createUserConfiguration,
  parseModelPreset,
} from '@kite-ai/service/configuration';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { privateDirectory } from '../../../fixtures/test-filesystem';

// Explicit opt-in, synthetic bytes only. No credentials, endpoints, request bodies,
// or raw provider errors enter the report. No fallback model/protocol or retry.
if (process.env.KITE_RUN_LIVE_IMAGE_VISION !== '1') throw Error('image_live_opt_in_required');
const args = process.argv.slice(2);
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
const modelId = args.find((arg) => arg.startsWith('--model-id='))?.slice(11);
const imagesArgument = args.find((arg) => arg.startsWith('--images='))?.slice(9);
if (imagesArgument !== undefined && !['1', '10'].includes(imagesArgument))
  throw Error('image_live_arguments_invalid');
const imageCount = Number(imagesArgument ?? 1);
if (
  !output ||
  !isAbsolute(output) ||
  existsSync(output) ||
  existsSync(`${output}.workspace`) ||
  args.length !== 1 + (modelId ? 1 : 0) + (imagesArgument ? 1 : 0)
)
  throw Error('image_live_arguments_invalid');
const deadline = AbortSignal.timeout(120000);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: process.platform,
  nodeVersion: process.versions.node,
  requestLimit: 5,
  timeoutMs: 120000,
  imageCount,
};
const require = createRequire(new URL('../../../../packages/agent/package.json', import.meta.url));
const { createCanvas } = require('@napi-rs/canvas') as {
  createCanvas(
    width: number,
    height: number,
  ): {
    toBuffer(format: 'image/png' | 'image/jpeg'): Buffer;
    getContext(kind: '2d'): {
      fillStyle: string;
      font: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      fillText(text: string, x: number, y: number): void;
    };
  };
};
const alphabet = 'ACDEFGHJKMNPRTWXY';
const fixtures = Array.from({ length: imageCount }, (_, index) => ({
  name: imageCount === 1 ? 'scan.png' : `scan-${String(index + 1).padStart(2, '0')}.png`,
  code: [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join(''),
  red: ((index * 3 + 6) % 9) + 1,
  blue: ((index * 5 + 2) % 9) + 1,
}));
if (new Set(fixtures.map((fixture) => fixture.code)).size !== imageCount)
  throw Error('image_live_fixture_collision');
function pixels(fixture: (typeof fixtures)[number]) {
  const canvas = createCanvas(720, 960),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 720, 960);
  ctx.fillStyle = 'black';
  ctx.font = '36px sans-serif';
  ctx.fillText('Synthetic scanned report', 40, 70);
  ctx.font = 'bold 50px monospace';
  ctx.fillText(`CODE ${fixture.code}`, 40, 155);
  ctx.font = '30px sans-serif';
  ctx.fillText('Item count', 40, 260);
  ctx.fillStyle = '#d02020';
  const base = imageCount === 1 ? 680 : 780;
  ctx.fillRect(80, base - fixture.red * 50, 120, fixture.red * 50);
  ctx.fillStyle = '#2040d0';
  ctx.fillRect(320, base - fixture.blue * 50, 120, fixture.blue * 50);
  ctx.fillStyle = 'black';
  ctx.fillText(String(fixture.red), 125, base - fixture.red * 50 - 20);
  ctx.fillText(String(fixture.blue), 365, base - fixture.blue * 50 - 20);
  ctx.fillText('RED', 105, base + 50);
  ctx.fillText('BLUE', 335, base + 50);
  return canvas.toBuffer('image/png');
}
const root = `${output}.workspace`;
privateDirectory(root);
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const sources = fixtures.map((fixture) => {
  const bytes = pixels(fixture),
    source = join(workspace, fixture.name);
  writeFileSync(join(root, fixture.name), bytes);
  writeFileSync(source, bytes);
  return source;
});
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
privateDirectory(profile.profilePath);
let runtime: ReturnType<typeof createRuntime> | undefined;
let host: ReturnType<typeof createDefaultProcessConfiguration> | undefined;
let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
try {
  const config = createUserConfiguration();
  const value = config.read().value;
  const selected = (Array.isArray(value.models) ? value.models : []).find(
    (model) =>
      model &&
      typeof model === 'object' &&
      !Array.isArray(model) &&
      model.id === (modelId ?? value.modelId),
  );
  if (
    !selected ||
    typeof selected !== 'object' ||
    Array.isArray(selected) ||
    selected.enabled === false ||
    typeof selected.baseURL !== 'string' ||
    typeof selected.model !== 'string' ||
    typeof selected.id !== 'string' ||
    typeof selected.provider !== 'string'
  )
    throw Error('image_live_model_unavailable');
  const protocol = selected.protocol ?? 'chat-completions';
  if (protocol !== 'chat-completions' && protocol !== 'responses')
    throw Error('image_live_protocol_invalid');
  report.model = selected.model;
  report.protocol = protocol;
  report.provider = selected.provider;
  const vault = createCredentialVault({
    backend: createOsCredentialBackend({ service: 'kite-agent', accountNamespace: 'user-models' }),
  });
  if (selected.credentialRef !== undefined && typeof selected.credentialRef !== 'string')
    throw Error('image_live_credential_invalid');
  const apiKey =
    typeof selected.credentialRef === 'string'
      ? (config.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined;
  const statuses: number[] = [];
  const boundedFetch: typeof fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (statuses.length >= 5) throw Error('image_live_request_limit');
    statuses.push(0);
    const index = statuses.length - 1;
    try {
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          deadline,
          AbortSignal.timeout(45000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      statuses[index] = response.status;
      return response;
    } catch {
      throw Error('image_live_transport_failed');
    }
  };
  const sdk = createSdkModelAdapter({
    models: new Map([
      [
        selected.id,
        createCompatibleModelBinding({
          name: selected.provider,
          baseURL: selected.baseURL,
          modelId: selected.model,
          protocol,
          apiKey,
          fetch: boundedFetch,
        }),
      ],
    ]),
    presets: new Map([
      [selected.id, { ...parseModelPreset(selected.options), maxOutputTokens: 2048 }],
    ]),
  });
  let answer = '',
    modelRequests = 0,
    toolImages = 0;
  const calls: string[] = [];
  const callInputs: unknown[] = [],
    imageCounts: number[] = [];
  const model: ModelAdapter = {
    describeRequest: sdk.describeRequest?.bind(sdk),
    async *stream(request, options) {
      if (++modelRequests > 5) throw Error('image_live_model_limit');
      answer = '';
      const count = request.messages
        .filter((message) => message.role === 'tool')
        .reduce((count, message) => count + (message.images?.length ?? 0), 0);
      toolImages += count;
      imageCounts.push(count);
      for await (const event of sdk.stream(request, {
        signal: AbortSignal.any([deadline, options.signal]),
      })) {
        if (event.type === 'text_delta') answer += event.text;
        if (event.type === 'tool_call') {
          calls.push(event.name);
          try {
            callInputs.push(JSON.parse(event.arguments));
          } catch {
            callInputs.push(null);
          }
        }
        yield event;
      }
    },
  };
  // Real default file/permission/planning assembly; only the SDK transport is bounded.
  host = createDefaultProcessConfiguration({
    profile,
    planning: { requirePlan: false },
    hostConfiguration: {
      configuration: {
        modelId: selected.id,
        tools: [{ id: 'files.view_images', definitionVersion: '1' }],
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'synthetic-live-owner' };
      },
    },
  });
  store = await openSqliteStore(profile);
  locks = createWorkspaceSerialLocks(profile);
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: async (input) => ({
      ...(await host!.resolveRunConfiguration!(input)),
      model,
    }),
  });
  host.permissionManagement?.(runtime);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 'image-live',
    subjectId: 'synthetic-owner',
  };
  await runtime.createWorkspace({
    expectedStoreId: scope.expectedStoreId,
    id: 'workspace',
    name: 'Synthetic image',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'Synthetic image vision',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...scope,
    workspaceId: 'workspace',
    mode: 'full',
    trusted: true,
  });
  const files = [];
  for (const [index, fixture] of fixtures.entries()) {
    const file = await runtime.uploadInputFile({
      ...scope,
      id: `scan-${index + 1}`,
      name: fixture.name,
      mediaType: 'image/png',
      content: (async function* () {
        yield readFileSync(sources[index]!);
      })(),
    });
    files.push(file);
    rmSync(sources[index]!);
  }
  const paths = files.map((file) => fileURLToPath(file.uri));
  await runtime.submitCommand({
    ...scope,
    commandId: 'read',
    request: {
      kind: 'run.start',
      content:
        imageCount === 1
          ? `Read the attached image using view_images. Inspect the actual image and return only JSON with code (the six-character code printed on the page), red (red bar count), blue (blue bar count). Do not guess or use text extraction for this scanned page. File: ${paths[0]}`
          : `Read all ${imageCount} attached images in exactly one view_images call using paths in the listed order. Inspect the actual images. Return only JSON {"images":[{"code":"...","red":0,"blue":0},...]} with exactly ${imageCount} objects in the same image order. code is the six-character code printed on that image; red and blue are its labelled bar counts. Do not guess or use text extraction. Files in order: ${JSON.stringify(paths)}`,
      files,
    },
  });
  const command = await runtime.waitForCommand('read', { timeoutMs: 110000, signal: deadline });
  const run = await store.getRun((command.receipt as { runId: string }).runId);
  const reads = (await store.listExecutions(scope.sessionId)).filter(
    (row) => row.definitionId === 'files.view_images',
  );
  let parsed: unknown;
  const start = answer.search(/[[{]/),
    end = Math.max(answer.lastIndexOf('}'), answer.lastIndexOf(']'));
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    parsed = null;
  }
  const rows: unknown[] =
    imageCount === 1
      ? [parsed]
      : parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Array.isArray((parsed as { images?: unknown }).images)
        ? (parsed as { images: unknown[] }).images
        : [];
  const checks = fixtures.map((fixture, index) => {
    const row =
      rows[index] && typeof rows[index] === 'object'
        ? (rows[index] as Record<string, unknown>)
        : {};
    return {
      index: index + 1,
      observedCode: typeof row.code === 'string' && row.code.trim().toUpperCase() === fixture.code,
      redCorrect: Number(row.red) === fixture.red,
      blueCorrect: Number(row.blue) === fixture.blue,
    };
  });
  const requestedInOrder =
    imageCount === 1 ||
    (callInputs.length === 1 &&
      JSON.stringify((callInputs[0] as { paths?: unknown } | null)?.paths) ===
        JSON.stringify(paths));
  Object.assign(report, {
    statuses,
    modelRequests,
    toolImages,
    calls,
    imageCounts,
    requestedInOrder,
    answerCount: rows.length,
    checkedImages: checks,
    runStatus: run?.status,
    reads: reads.map((row) => ({
      status: row.status,
      imageCount: (row.result as { modelImages?: unknown[] } | null)?.modelImages?.length ?? 0,
    })),
    sourceRemoved: sources.every((source) => !existsSync(source)),
    sourceHashes: paths.map((path) =>
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    ),
    observedCode: checks.every((check) => check.observedCode),
    redCorrect: checks.every((check) => check.redCorrect),
    blueCorrect: checks.every((check) => check.blueCorrect),
  });
  if (
    run?.status !== 'completed' ||
    toolImages < imageCount ||
    !requestedInOrder ||
    rows.length !== imageCount ||
    calls.length !== 1 ||
    calls[0] !== 'view_images' ||
    !report.observedCode ||
    !report.redCorrect ||
    !report.blueCorrect ||
    reads.length !== 1 ||
    reads[0]!.status !== 'succeeded' ||
    (reads[0]!.result as { modelImages?: unknown[] })?.modelImages?.length !== imageCount
  )
    throw Error('image_live_visual_assertion_failed');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure =
    error instanceof Error && /^image_live_/.test(error.message)
      ? error.message
      : 'image_live_attempt_failed';
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z_]{1,80}$/.test(code)) report.errorCode = code;
  process.exitCode = 1;
} finally {
  try {
    await runtime?.close();
    await locks?.close();
  } catch {
    report.cleanupFailed = true;
    process.exitCode = 1;
  }
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
