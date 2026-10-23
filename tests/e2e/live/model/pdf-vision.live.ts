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
import { rasterPdf } from '../../../fixtures/pdf';
import { privateDirectory } from '../../../fixtures/test-filesystem';

// Explicit opt-in, synthetic bytes only. No credentials, endpoints, request bodies,
// or raw provider errors enter the report. No fallback model/protocol or retry.
if (process.env.KITE_RUN_LIVE_PDF_VISION !== '1') throw Error('pdf_live_opt_in_required');
const args = process.argv.slice(2);
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
const modelId = args.find((arg) => arg.startsWith('--model-id='))?.slice(11);
if (
  !output ||
  !isAbsolute(output) ||
  existsSync(output) ||
  existsSync(`${output}.workspace`) ||
  args.length !== (modelId ? 2 : 1)
)
  throw Error('pdf_live_arguments_invalid');
const deadline = AbortSignal.timeout(120000);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: process.platform,
  bunVersion: Bun.version,
  requestLimit: 5,
  timeoutMs: 120000,
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
const code = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join('');
const canvas = createCanvas(720, 960);
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'white';
ctx.fillRect(0, 0, 720, 960);
ctx.fillStyle = 'black';
ctx.font = '36px sans-serif';
ctx.fillText('Synthetic scanned report', 40, 70);
ctx.font = 'bold 50px monospace';
ctx.fillText(`CODE ${code}`, 40, 155);
ctx.font = '30px sans-serif';
ctx.fillText('Item count', 40, 260);
ctx.fillStyle = '#d02020';
ctx.fillRect(80, 330, 120, 350);
ctx.fillStyle = '#2040d0';
ctx.fillRect(320, 530, 120, 150);
ctx.fillStyle = 'black';
ctx.fillText('7', 125, 310);
ctx.fillText('3', 365, 510);
ctx.fillText('RED', 105, 730);
ctx.fillText('BLUE', 335, 730);
const root = `${output}.workspace`;
privateDirectory(root);
const workspace = join(root, 'workspace');
mkdirSync(workspace);
writeFileSync(join(root, 'scan.png'), canvas.toBuffer('image/png'));
const source = join(workspace, 'scan.pdf');
writeFileSync(source, rasterPdf(canvas.toBuffer('image/jpeg'), 720, 960));
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
    throw Error('pdf_live_model_unavailable');
  const protocol = selected.protocol ?? 'chat-completions';
  if (protocol !== 'chat-completions' && protocol !== 'responses')
    throw Error('pdf_live_protocol_invalid');
  report.model = selected.model;
  report.protocol = protocol;
  report.provider = selected.provider;
  const vault = createCredentialVault({
    backend: createOsCredentialBackend({ service: 'kite-agent', accountNamespace: 'user-models' }),
  });
  if (selected.credentialRef !== undefined && typeof selected.credentialRef !== 'string')
    throw Error('pdf_live_credential_invalid');
  const apiKey =
    typeof selected.credentialRef === 'string'
      ? (config.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined;
  const statuses: number[] = [];
  const boundedFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (statuses.length >= 5) throw Error('pdf_live_request_limit');
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
        throw Error('pdf_live_transport_failed');
      }
    },
    { preconnect: fetch.preconnect },
  );
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
  const model: ModelAdapter = {
    describeRequest: sdk.describeRequest?.bind(sdk),
    async *stream(request, options) {
      if (++modelRequests > 5) throw Error('pdf_live_model_limit');
      toolImages += request.messages
        .filter((message) => message.role === 'tool')
        .reduce((count, message) => count + (message.images?.length ?? 0), 0);
      for await (const event of sdk.stream(request, {
        signal: AbortSignal.any([deadline, options.signal]),
      })) {
        if (event.type === 'text_delta') answer += event.text;
        if (event.type === 'tool_call') calls.push(event.name);
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
        tools: [{ id: 'files.read', definitionVersion: '5' }],
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
    sessionId: 'pdf-live',
    subjectId: 'synthetic-owner',
  };
  await runtime.createWorkspace({
    expectedStoreId: scope.expectedStoreId,
    id: 'workspace',
    name: 'Synthetic PDF',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'Synthetic PDF vision',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...scope,
    workspaceId: 'workspace',
    mode: 'full',
    trusted: true,
  });
  const file = await runtime.uploadInputFile({
    ...scope,
    id: 'scan',
    name: 'scan.pdf',
    mediaType: 'application/pdf',
    content: (async function* () {
      yield readFileSync(source);
    })(),
  });
  rmSync(source);
  await runtime.submitCommand({
    ...scope,
    commandId: 'read',
    request: {
      kind: 'run.start',
      content: `Read page 1 of the attached raster PDF using read_file with mode=image. Inspect the actual page and return JSON with code (the six-character code printed on the page), red (red bar count), blue (blue bar count). Do not guess or use text extraction for this scanned page. File: ${fileURLToPath(file.uri)}`,
      files: [file],
    },
  });
  const command = await runtime.waitForCommand('read', { timeoutMs: 110000, signal: deadline });
  const run = await store.getRun((command.receipt as { runId: string }).runId);
  const reads = (await store.listExecutions(scope.sessionId)).filter(
    (row) => row.definitionId === 'files.read',
  );
  Object.assign(report, {
    statuses,
    modelRequests,
    toolImages,
    calls,
    runStatus: run?.status,
    reads: reads.map((row) => ({
      status: row.status,
      imageCount: (row.result as { modelImages?: unknown[] } | null)?.modelImages?.length ?? 0,
    })),
    sourceRemoved: !existsSync(source),
    sourceHash: createHash('sha256')
      .update(readFileSync(fileURLToPath(file.uri)))
      .digest('hex'),
    observedCode: answer.toUpperCase().includes(code),
    redCorrect: /["']?red["']?\s*:\s*7\b/i.test(answer),
    blueCorrect: /["']?blue["']?\s*:\s*3\b/i.test(answer),
  });
  if (
    run?.status !== 'completed' ||
    toolImages < 1 ||
    !report.observedCode ||
    !report.redCorrect ||
    !report.blueCorrect ||
    !reads.some((row) => row.status === 'succeeded')
  )
    throw Error('pdf_live_visual_assertion_failed');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure =
    error instanceof Error && /^pdf_live_/.test(error.message)
      ? error.message
      : 'pdf_live_attempt_failed';
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
