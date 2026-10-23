import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { simplePdf } from '../../../tests/fixtures/pdf';
import { privateDirectory } from '../../../tests/fixtures/test-filesystem';
import { initializeLivePermissionFixture } from '../../service/test/fixtures/live-permission-fixture';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import { memoryPrivateData } from './private-data.fixture';

// No production switch: this standalone artifact owns only its temporary Profile and mock Provider.
const resume = process.argv.find((arg) => arg.startsWith('--resume='))?.slice(9);
const root = resume ? resolve(resume) : resolve('.cache', `session-files-browser-${randomUUID()}`);
if (
  dirname(root) !== resolve('.cache') ||
  !/^session-files-browser-[a-f0-9-]{36}$/.test(basename(root))
)
  throw Error('fixture_root_invalid');
privateDirectory(root);
const workspace = join(root, 'workspace');
if (!resume) mkdirSync(workspace);
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
privateDirectory(profile.profilePath);
const source = join(root, 'sources');
if (!resume) {
  mkdirSync(source);
  writeFileSync(join(source, '说明.txt'), '上传中文原件\r\nSOURCE_ORIGINAL');
  writeFileSync(join(source, 'sample.pdf'), simplePdf());
  const { createCanvas } = createRequire(
    new URL('../../../packages/agent/package.json', import.meta.url),
  )('@napi-rs/canvas');
  const canvas = createCanvas(120, 80),
    brush = canvas.getContext('2d');
  brush.fillStyle = '#2968c8';
  brush.fillRect(0, 0, 120, 80);
  brush.fillStyle = 'white';
  brush.font = '18px sans-serif';
  brush.fillText('Saved image', 6, 42);
  writeFileSync(join(source, 'pixel.png'), canvas.toBuffer('image/png'));
}
const store = await openSqliteStore(profile),
  storeId = (await store.getMetadata()).storeId;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const outputPath = join(
  profile.profilePath,
  'files',
  hash(storeId),
  hash('s'),
  'outputs',
  'report.md',
);
const steps = new Map<string, number>();
let runtime: ReturnType<typeof createRuntime>;
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
    const texts = body.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
            ? m.content.filter((part) => part.type === 'text').map((part) => String(part.text))
            : [],
      );
    let answer = '',
      call: { name: string; input: unknown } | null = null;
    const internal = texts.find((text) => {
      try {
        return JSON.parse(text).purpose === 'authorization_check';
      } catch {
        return false;
      }
    });
    if (internal)
      answer = JSON.stringify({
        decision: 'approve_once',
        reason: 'isolated fixture exact file action',
      });
    else {
      const user =
        [...texts].reverse().find((text) => /^(UPLOAD|EDIT|PLAN|REOPEN)/.test(text)) ?? 'UPLOAD';
      const phase = user.split(/[\s\n]/)[0]!;
      const step = steps.get(phase) ?? 0;
      steps.set(phase, step + 1);
      const tool = body.messages.filter((m) => m.role === 'tool').at(-1);
      let previous: Record<string, unknown> = {};
      try {
        previous = JSON.parse(String(tool?.content));
      } catch {}
      if (phase === 'UPLOAD') {
        const attachmentText = texts.find((text) => text.includes('Attached file references'));
        const files = attachmentText
          ? (JSON.parse(
              attachmentText.slice(
                attachmentText.indexOf('[{', attachmentText.indexOf('Attached file references')),
              ),
            ) as { name: string; uri: string }[])
          : [];
        const file = (ext: string) => fileURLToPath(files.find((f) => f.name.endsWith(ext))!.uri);
        if (step === 0) call = { name: 'read_file', input: { path: file('.txt') } };
        if (step === 1)
          call = { name: 'read_file', input: { path: file('.pdf'), mode: 'text', pages: '1' } };
        if (step === 2)
          call = { name: 'read_file', input: { path: file('.pdf'), mode: 'image', pages: '1' } };
        if (step === 3)
          call = {
            name: 'write_file',
            input: {
              path: outputPath,
              base: null,
              content: '# 首次报告\n保存的原件可继续读取。\n',
            },
          };
        answer = `已读取文本与 PDF，并保存 [报告](${outputPath})。`;
      } else if (phase === 'EDIT' || phase === 'REOPEN') {
        if (step === 0) call = { name: 'read_file', input: { path: outputPath } };
        if (step === 1 && phase === 'EDIT')
          call = {
            name: 'edit_file',
            input: {
              path: outputPath,
              base: previous.baseline,
              old_text: '首次报告',
              new_text: '修改后的报告',
              expected_matches: 1,
            },
          };
        answer = phase === 'EDIT' ? '报告已修改，旧交付保留原版本。' : '重开后仍可读取报告。';
      } else if (phase === 'PLAN') {
        if (step === 0)
          call = {
            name: 'write_plan',
            input: {
              plan_id: 'fixture',
              expected_version: null,
              title: '持久方案',
              body: '# 初始方案\n核对上传原件，再完善报告。',
              steps: [{ id: 'review', title: '核对报告' }],
            },
          };
        const views = step
          ? await runtime.queryExtension({
              expectedStoreId: storeId,
              sessionId: 's',
              subjectId: 'user',
              extensionId: 'builtin.planning',
              queryId: 'planning.file',
              input: {},
            })
          : [];
        const plan = views[0]?.payload as { path?: string } | undefined;
        if (step === 1) call = { name: 'read_file', input: { path: plan?.path } };
        if (step === 2)
          call = {
            name: 'write_file',
            input: {
              path: plan?.path,
              base: previous.baseline,
              content: '# 修订方案\n核对已保存原件，保留历史报告，然后重新审阅。',
            },
          };
        if (step === 3) {
          const current = (
            await store.getExtensionRecord({
              extensionId: 'builtin.planning',
              sessionId: 's',
              key: 'plan.current',
            })
          )?.value as { digest: string };
          call = {
            name: 'request_plan_review',
            input: { plan_id: 'fixture', version: 2, digest: current.digest },
          };
        }
        if (step === 4)
          call = {
            name: 'write_file',
            input: { path: 'reviewed-report.txt', base: null, content: 'approved exact plan' },
          };
        if (step === 5) {
          const current = (await store.getExtensionRecord({
            extensionId: 'builtin.planning',
            sessionId: 's',
            key: 'plan.current',
          }))!.value as { digest: string };
          call = {
            name: 'update_plan_progress',
            input: {
              run_id: previous.runId,
              plan_id: 'fixture',
              version: 2,
              digest: current.digest,
              expected_progress_revision: null,
              step_id: 'review',
              status: 'completed',
              execution_id: previous.executionId,
              complete_plan: true,
            },
          };
        }
        answer = '方案文件已保存为修订版。';
      }
    }
    await Bun.sleep(500);
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            },
          ],
        }
      : { content: answer };
    const chunk = {
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
const config = join(profile.profilePath, 'config.jsonc');
writeFileSync(
  config,
  JSON.stringify({
    modelId: 'fixture',
    models: [
      {
        id: 'fixture',
        provider: 'compatible',
        model: 'fixture',
        baseURL: `${provider.url.origin}/v1`,
      },
    ],
    tools: [
      'files.read',
      'files.write',
      'files.edit',
      'planning.write',
      'planning.review',
      'planning.read',
      'planning.update',
    ].map((id) => ({ id })),
  }),
);
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: config,
  credentialBackend: createTemporaryCredentialBackend(),
});
const locks = createWorkspaceSerialLocks(profile);
host.bindWorkspaceSerialLocks!(locks);
runtime = createRuntime({
  ...host,
  permissions: host.permissions!,
  store,
  artifacts: createArtifactStore({ profile, store }),
  workspaceSerialLocks: locks,
});
host.permissionManagement?.(runtime);
if (!resume) {
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: '会话文件验收',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'user',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: '上传、输出与 Plan',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId: storeId,
    subjectId: 'user',
    sessionId: 's',
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
}
const service = await startService({
  runtime,
  profile: {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  },
  subjectId: 'user',
  buildId: 'session-files-browser',
  configurationManagement: host.configurationManagement!(runtime),
  permissionManagement: host.permissionManagement!(runtime),
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['commands', 'input_files', 'configuration_management'],
  },
});
await client.connect();
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
const caller = new NativeCaller(
  client,
  (event) => {
    for (const listener of listeners)
      try {
        listener.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        listeners.delete(listener);
      }
  },
  memoryPrivateData(),
  [profile.dataRoot],
);
const output = join(root, 'dist');
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  logLevel: 'error',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: join(import.meta.dir, 'session-files-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
const key = randomUUID();
const web = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/events') {
      let owner: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream({
          start(controller) {
            owner = controller;
            listeners.add(controller);
            controller.enqueue(new TextEncoder().encode(': ready\n\n'));
          },
          cancel() {
            listeners.delete(owner);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (url.pathname === '/rpc') {
      if (request.headers.get('x-fixture-key') !== key) return new Response(null, { status: 403 });
      try {
        const input = JSON.parse(await request.text(), (_key, value) =>
          value && Array.isArray(value.fixtureBytes) ? Uint8Array.from(value.fixtureBytes) : value,
        );
        // Isolated fixture only: pause an actual chunk handoff so source mutation
        // or UI cancellation can be observed while the browser File is still open.
        const control = join(root, 'hold-request.json');
        if (
          existsSync(control) &&
          JSON.parse(readFileSync(control, 'utf8')).method === input.method
        ) {
          unlinkSync(control);
          const held = join(root, 'held-request.json');
          writeFileSync(held, JSON.stringify({ method: input.method, id: input.id }));
          const deadline = Date.now() + 60000;
          while (existsSync(held)) {
            if (Date.now() > deadline) throw Error('fixture_hold_deadline');
            await Bun.sleep(25);
          }
        }
        return Response.json({ ok: true, value: await caller.invoke(decodeNativeRequest(input)) });
      } catch (error) {
        console.error('fixture-rpc', error);
        return Response.json({
          ok: false,
          code: (error as { code?: string }).code ?? String(error),
        });
      }
    }
    if (url.pathname === '/')
      return new Response(
        `<!doctype html><html><head><meta name="fixture-key" content="${key}"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    const path = resolve(output, `.${url.pathname}`);
    if (!path.startsWith(output + '\\') && !path.startsWith(output + '/'))
      return new Response(null, { status: 404 });
    return new Response(Bun.file(path));
  },
});
console.log(JSON.stringify({ url: web.url.href, root, source, outputPath, storeId }));
process.on('SIGINT', async () => {
  web.stop(true);
  await caller.close();
  await service.close();
  await runtime.close();
  await locks.close();
  provider.stop(true);
  process.exit();
});
