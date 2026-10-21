import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createAskUserExtension } from '@kite-ai/agent/ask-user';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest, ModelUsage } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';
import { createWorkspaceAssembly } from '../../../../apps/service/src/assembly';

// Explicit, isolated fixture only. No ordinary app switch can enable this driver.
if (process.env.KITE_RUN_LIVE_QUESTIONNAIRE !== '1')
  throw Error('live_questionnaire_opt_in_required');
const output = process.argv[2]?.startsWith('--output=') ? process.argv[2].slice(9) : undefined;
if (process.argv.length > 3 || (process.argv.length === 3 && (!output || !isAbsolute(output))))
  throw Error('live_questionnaire_arguments_invalid');
if (output && existsSync(output)) throw Error('live_questionnaire_output_exists');
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(`live_questionnaire_${code}`);
}
const started = Date.now();
const deadline = AbortSignal.timeout(180_000);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: process.platform,
  bunVersion: Bun.version,
  scenarios: [],
  requestLimit: 10,
  timeoutMs: 180_000,
};
const requests: ModelRequest[] = [];
const statuses: number[] = [];
const usage: ModelUsage[] = [];

async function main() {
  const configuration = createUserConfiguration();
  const value = configuration.read().value;
  const selected = (Array.isArray(value.models) ? value.models : []).find(
    (model) =>
      model && typeof model === 'object' && !Array.isArray(model) && model.id === value.modelId,
  );
  check(selected && typeof selected === 'object' && !Array.isArray(selected), 'default_missing');
  check(
    selected.enabled !== false &&
      typeof selected.model === 'string' &&
      typeof selected.baseURL === 'string',
    'default_invalid',
  );
  const protocol = selected.protocol ?? 'chat-completions';
  check(protocol === 'chat-completions' || protocol === 'responses', 'protocol_invalid');
  const vault = createCredentialVault({
    backend: createOsCredentialBackend({ service: 'kite-agent', accountNamespace: 'user-models' }),
  });
  const apiKey =
    typeof selected.credentialRef === 'string'
      ? (configuration.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined;
  const preset = parseModelPreset(selected.options);
  const fetchProvider: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      check(statuses.length < 10, 'request_budget');
      statuses.push(0);
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          deadline,
          AbortSignal.timeout(60_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      statuses[statuses.length - 1] = response.status;
      return response;
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
    presets: new Map([
      ['live', { ...preset, maxOutputTokens: Math.min(preset.maxOutputTokens ?? 4096, 4096) }],
    ]),
  });
  const model: ModelAdapter = {
    describeRequest: sdk.describeRequest?.bind(sdk),
    async *stream(request, options) {
      requests.push(structuredClone(request));
      try {
        for await (const event of sdk.stream(request, {
          signal: AbortSignal.any([deadline, options.signal]),
        })) {
          if (event.type === 'finish') usage.push(event.usage);
          yield event;
        }
      } catch {
        throw Error('live_questionnaire_provider_failed');
      }
    },
  };
  report.model = selected.model;
  report.provider = selected.provider;
  report.protocol = protocol;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-questionnaire-live-')));
  const req = createRequire(resolve('apps/desktop/package.json'));
  const { build } = await import(pathToFileURL(req.resolve('vite')).href);
  const { default: tailwind } = await import(pathToFileURL(req.resolve('@tailwindcss/vite')).href);
  const cssEntry = join(root, 'browser.css');
  writeFileSync(
    cssEntry,
    ['apps/desktop/src/native-tailwind.css', 'packages/ui/src/desktop/style.css']
      .map((path) => `@import "${resolve(path).replaceAll('\\', '/')}";`)
      .join('\n'),
  );
  const built = await build({
    root,
    configFile: false,
    plugins: [tailwind()],
    resolve: {
      alias: [{ find: 'shadcn/tailwind.css', replacement: req.resolve('shadcn/tailwind.css') }],
    },
    logLevel: 'error',
    build: { write: false, rollupOptions: { input: cssEntry } },
  });
  check(!Array.isArray(built) && 'output' in built, 'css_build_failed');
  const assets = new Map<string, string | Uint8Array<ArrayBuffer>>();
  for (const item of built.output as {
    type: string;
    fileName: string;
    source: string | Uint8Array;
  }[]) {
    if (item.type === 'asset')
      assets.set(
        `/${item.fileName}`,
        typeof item.source === 'string' ? item.source : new Uint8Array(item.source),
      );
  }
  const css = [...assets.entries()]
    .filter(([name]) => name.endsWith('.css'))
    .map(([, source]) => String(source))
    .join('\n');
  check(css.length > 0, 'css_empty');
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, 'questionnaire-browser.fixture.tsx')],
    target: 'browser',
    format: 'iife',
    minify: true,
  });
  check(bundle.success, 'browser_build_failed');
  const script = await bundle.outputs[0]!.text();
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    'Synthetic workspace. Ask for the requested design preferences before starting.',
  );
  writeFileSync(join(outside, 'AGENTS.md'), 'OUTSIDE_INSTRUCTIONS_MUST_NOT_REACH_PROVIDER');
  writeFileSync(join(outside, 'private.txt'), 'OUTSIDE_FILE_MUST_NOT_REACH_PROVIDER');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
  const store = await openSqliteStore(profile);
  const assembly = await createWorkspaceAssembly({
    workspaceRoot: workspace,
    profile,
    toolIds: ['files.read'],
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'live',
    sources: assembly.sources,
    extensions: [createAskUserExtension(), ...assembly.extensions],
    permissions: {
      authorize: async () => ({ allowed: true, revision: 'explicit-owned-live-fixture' }),
    },
  });
  const { chromium } = req('playwright');
  const browser = await chromium.launch({
    executablePath:
      process.env.KITE_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  let current:
    | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
    | undefined;
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const asset = assets.get(path);
      if (asset)
        return new Response(asset, {
          headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'font/woff2' },
        });
      if (new URL(request.url).pathname !== '/answer')
        return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      const input = (await request.json()) as {
        interactionId: string;
        revision: string;
        answer: { kind: 'question'; answers: unknown };
      };
      if (!current || input.interactionId !== current.id || input.revision !== current.revision)
        return new Response('stale', { status: 409 });
      posts++;
      await runtime.answerInteraction({
        expectedStoreId: current.originStoreId,
        commandId: `answer-${current.id}`,
        presentationSessionId: current.presentationSessionId,
        interactionId: current.id,
        expectedRevision: current.revision,
        subjectId: 'live-owner',
        answer: input.answer as never,
      });
      return new Response('saved');
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'Synthetic live questionnaire',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const scenario of ['answer', 'cancel', 'outside'] as const) {
      const first = requests.length;
      const scope = { expectedStoreId, sessionId: scenario, subjectId: 'live-owner' };
      const commandId = `run-${scenario}`;
      await runtime.createSession({
        ...scope,
        commandId: `create-${scenario}`,
        workspaceId: 'workspace',
        title: 'Synthetic live questionnaire',
      });
      await runtime.submitCommand({
        ...scope,
        commandId,
        request: {
          kind: 'run.start',
          content:
            scenario === 'outside'
              ? `This is a scope-denial test. Call read_file exactly once for the absolute path ${join(outside, 'private.txt')}. When it is rejected, explain the failure in one sentence and finish. Do not ask questions or use another tool.`
              : '我想创建一个页面，开始前必须由我决定版式和风格。请调用一次 ask_user，一次询问两个问题：版式选静态页面或仪表盘；风格选简洁风格或活泼风格。每个选项带简短说明，首项推荐。收到回答或取消后，只用一句话确认，然后结束，不创建文件，不再提问。',
        },
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      try {
        if (scenario !== 'outside') {
          while (!current || current.sessionId !== scenario) {
            const found = (await runtime.listInteractions(scope)).interactions.find(
              (card) => card.state === 'pending',
            );
            if (found) current = found;
            deadline.throwIfAborted();
            await Bun.sleep(25);
          }
          check(current.kind === 'question', 'question_kind');
          await page.goto(`http://127.0.0.1:${server.port}`);
          await page.evaluate(() => {
            document.documentElement.style.colorScheme = 'dark';
            Object.assign(document.documentElement.dataset, {
              nativeWindow: 'true',
              platform: 'windows',
              windowMaterial: 'mica',
              theme: 'dark',
            });
          });
          await page.addStyleTag({ content: css });
          await page.addScriptTag({ content: script });
          await page.evaluate(
            (card: unknown) =>
              (window as unknown as { renderQuestion(card: unknown): void }).renderQuestion(card),
            current,
          );
          await page.getByRole('form', { name: 'Questionnaire' }).waitFor();
          const before = posts;
          if (scenario === 'answer') {
            await page.getByRole('button', { name: '下一题' }).click();
            check(posts === before, 'navigation_submitted');
            check(
              await page.getByRole('button', { name: '提交回答' }).isDisabled(),
              'missing_answer_enabled',
            );
            await page.getByRole('button', { name: '上一题' }).click();
            await page.getByRole('radio').first().check();
            if (output) await page.screenshot({ path: `${output}.png` });
            await page.getByRole('button', { name: '下一题' }).click();
            await page.getByRole('radio', { name: '自由回答', exact: true }).check();
            await page
              .getByRole('textbox', { name: '自由回答' })
              .fill('  使用柔和的留白🙂\n保留原文  ');
            await page.getByRole('button', { name: '提交回答' }).click();
          } else await page.getByRole('button', { name: '取消回答', exact: true }).click();
          await page.getByText('回答已提交，正在继续…', { exact: true }).waitFor();
          check(posts === before + 1, 'answer_count');
          check(
            !(
              await page
                .getByRole('article')
                .filter({ has: page.getByRole('form', { name: 'Questionnaire' }) })
                .innerText()
            ).includes('question · pending'),
            'technical_heading_visible',
          );
        }
        const command = await runtime.waitForCommand(commandId, {
          timeoutMs: Math.max(1, 180_000 - (Date.now() - started)),
        });
        check(command.status === 'applied', 'command_failed');
        const run = await store.getRun((command.receipt as { runId: string }).runId);
        check(run?.status === 'completed', 'run_not_completed');
        const executions = await store.listExecutions(scenario);
        const tools = executions.filter((item) => item.kind === 'tool');
        check(tools.length === 1, 'unexpected_tool_count');
        check(
          tools[0]!.definitionId === (scenario === 'outside' ? 'files.read' : 'ask_user'),
          'tool_identity_mismatch',
        );
        const models = executions.filter((item) => item.kind === 'model');
        const final = models.at(-1)?.result as { content?: string } | undefined;
        check(
          models.length === 2 &&
            typeof final?.content === 'string' &&
            final.content.trim().length > 0,
          'final_reply_missing',
        );
        const result = tools[0]!.result as {
          outcome: string;
          details?: { answers?: Record<string, string>; cancelled?: boolean; code?: string };
        };
        if (scenario === 'answer') {
          const answers = Object.values(result.details?.answers ?? {});
          check(
            answers.some((answer) => answer === '静态页面'),
            'label_not_preserved',
          );
          check(
            answers.some((answer) => answer === '  使用柔和的留白🙂\n保留原文  '),
            'free_text_not_preserved',
          );
        } else if (scenario === 'cancel')
          check(result.details?.cancelled === true, 'cancel_not_delivered');
        else
          check(
            result.outcome === 'failed' && result.details?.code === 'file_path_invalid',
            'outside_file_not_denied',
          );
        check(requests.length - first === 2, 'continuation_model_missing');
        const continuation = JSON.stringify(
          requests[first + 1]!.messages.filter((message) => message.role === 'tool'),
        );
        check(
          continuation.includes(
            scenario === 'cancel'
              ? 'cancelled'
              : scenario === 'outside'
                ? 'file_path_invalid'
                : '静态页面',
          ),
          'tool_result_not_sent_to_model',
        );
        check(
          !JSON.stringify(requests).includes('OUTSIDE_INSTRUCTIONS_MUST_NOT_REACH_PROVIDER') &&
            !JSON.stringify(requests).includes('OUTSIDE_FILE_MUST_NOT_REACH_PROVIDER'),
          'outside_bytes_leaked',
        );
        (report.scenarios as unknown[]).push({
          scenario,
          status: 'passed',
          providerRequests: requests.length - first,
          answerPosts: scenario === 'outside' ? 0 : 1,
          runStatus: run.status,
        });
        console.log(JSON.stringify({ scenario, status: 'passed' }));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.stop(true);
    await runtime.close();
    await assembly.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}
try {
  await main();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error =
    error instanceof Error && /^live_questionnaire_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'live_questionnaire_unexpected_failure';
  process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - started;
  report.providerRequests = statuses.length;
  report.httpStatuses = statuses;
  report.usage = {
    inputTokens: usage.reduce((n, value) => n + (value.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((n, value) => n + (value.outputTokens ?? 0), 0),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  console.log(text);
}
