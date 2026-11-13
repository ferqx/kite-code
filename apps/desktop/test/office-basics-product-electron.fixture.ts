/** Isolated, opt-in production Renderer/Main/Service fixture. Its model is deterministic, not a real Provider. */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officeEnvironment } from '@kite-ai/agent/documents';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { loopbackModelEnvironment } from '../../../tests/fixtures/loopback-model-environment';
import { ownedUserConfiguration } from '../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../scripts/build-native';
import { officeFixtureDecision } from './office-model-decision.fixture';

const root = process.env.KITE_OFFICE_PRODUCT_FIXTURE_DIRECTORY;
if (!root?.startsWith('/workspace/shared/'))
  throw Error('explicit_owned_fixture_directory_required');
const repo = resolve(import.meta.dir, '../../..');
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'office-fixture' });
const workspace = join(root, 'workspace');
const outdir = join(root, 'app');
const serviceOutdir = join(root, 'apps/service/dist');
const serviceEntrypoint = join(serviceOutdir, 'service.js');
const config = ownedUserConfiguration(root);
const bunExecutable = realpathSync(process.execPath);
if (process.argv.includes('--prepare') || process.argv.includes('--rebuild')) {
  mkdirSync(workspace, { recursive: true });
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  if (!process.argv.includes('--rebuild')) {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'office-workspace',
      name: 'Office fixture workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const sessionId of ['office-session', 'other-session'])
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'office-workspace',
        title: sessionId === 'office-session' ? '办公文件真实链路' : '切换验证会话',
      });
  }
  await store.close();
  mkdirSync(serviceOutdir, { recursive: true });
  if (!existsSync(join(root, 'apps/service/node_modules')))
    symlinkSync(
      join(repo, 'apps/service/node_modules'),
      join(root, 'apps/service/node_modules'),
      'dir',
    );
  // Match packaged resolution: source Shell intentionally refuses .ts assets.
  const stagedAgent = join(serviceOutdir, 'node_modules/@kite-ai/agent');
  mkdirSync(stagedAgent, { recursive: true });
  cpSync(realpathSync(join(repo, 'packages/agent/dist')), stagedAgent, { recursive: true });
  const agentPackage = JSON.parse(readFileSync(join(repo, 'packages/agent/package.json'), 'utf8'));
  agentPackage.exports = Object.fromEntries(
    Object.entries(agentPackage.exports as Record<string, string>).map(([key, value]) => [
      key,
      value.replace('./src/', './').replace(/\.ts$/, '.js'),
    ]),
  );
  writeFileSync(join(stagedAgent, 'package.json'), JSON.stringify(agentPackage));
  if (!existsSync(join(stagedAgent, 'node_modules')))
    symlinkSync(
      join(repo, 'packages/agent/node_modules'),
      join(stagedAgent, 'node_modules'),
      'dir',
    );
  const built = await Bun.build({
    entrypoints: [join(repo, 'apps/service/src/main.ts')],
    target: 'bun',
    format: 'esm',
    packages: 'external',
    outdir: serviceOutdir,
    naming: 'service.js',
  });
  if (!built.success) throw new AggregateError(built.logs, 'service_build_failed');
  Bun.gc(true);
  await buildNativeDesktop(
    {
      serviceEntrypoint,
      bunExecutable,
      serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
      bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
      buildId: 'isolated-office-product-fixture',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
      profile: { dataRoot: profile.dataRoot, profile: profile.profile },
    },
    outdir,
    { testDiagnostics: true },
  );
  writeFileSync(
    join(root, 'prepared.json'),
    JSON.stringify(
      {
        storeId,
        workspace,
        outdir,
        profile,
        model: 'deterministic compatible SSE; not a real Provider',
      },
      null,
      2,
    ),
  );
  console.log('Prepared isolated product fixture:', outdir);
} else if (process.argv.includes('--run')) {
  let count = 0;
  const requestDirectory = join(root, `requests-${Date.now()}`);
  mkdirSync(requestDirectory);
  console.log('Model request evidence:', requestDirectory);
  const binary = join(
    serviceOutdir,
    'node_modules/@kite-ai/agent/tools/documents/office-assets/officecli',
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const env = Object.entries(officeEnvironment())
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(' ');
  const cli = `${env} ${quote(binary)}`;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('fixture_model_only', { status: 404 });
      const body = (await request.json()) as {
        tools?: { function?: { name?: string } }[];
        messages: { role: string; content?: unknown; tool_call_id?: string }[];
      };
      count++;
      writeFileSync(
        join(requestDirectory, `model-request-${count}.json`),
        JSON.stringify(body, null, 2),
      );
      const shell = body.tools?.find((tool) => /shell_execute/.test(tool.function?.name ?? ''))
        ?.function?.name;
      if (!shell)
        return new Response('shell tool unavailable; fixture refuses a fabricated completion', {
          status: 503,
        });
      const verify = [...body.messages]
        .reverse()
        .findIndex(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('Verify attached office revision.'),
        );
      const decision =
        verify >= 0
          ? { toolId: 'office-verify', toolTurn: false, editing: false, workingPath: undefined }
          : officeFixtureDecision(body.messages);
      const { toolId, toolTurn, editing, workingPath } = decision;
      const pdfSpec = quote(
        JSON.stringify({
          operation: 'create',
          pages: [
            {
              blocks: [
                { type: 'title', text: '中文报告' },
                { type: 'text', text: '这是包含中文和 English 的固定模板。' },
              ],
            },
            { blocks: [{ type: 'title', text: 'PAGE TWO - Native PDF pagination' }] },
          ],
        }),
      );
      const command = !editing
        ? `${cli} create "$KITE_OUTPUT_DIR/report.docx" && ${cli} add "$KITE_OUTPUT_DIR/report.docx" /body --type paragraph --prop 'text=第一轮原始报告：中文文件交付' && ${cli} create "$KITE_OUTPUT_DIR/budget.xlsx" && ${cli} set "$KITE_OUTPUT_DIR/budget.xlsx" /Sheet1/A1 --prop 'value=原值A1' && ${cli} set "$KITE_OUTPUT_DIR/budget.xlsx" /Sheet1/B1 --prop 'value=20' && ${cli} set "$KITE_OUTPUT_DIR/budget.xlsx" /Sheet1/A2 --prop 'value=项目二' && ${cli} set "$KITE_OUTPUT_DIR/budget.xlsx" /Sheet1/B2 --prop 'value=40' && ${cli} add "$KITE_OUTPUT_DIR/budget.xlsx" / --type sheet --prop name=Details && ${cli} set "$KITE_OUTPUT_DIR/budget.xlsx" /Details/A1 --prop 'value=第二表原值' && ${cli} create "$KITE_OUTPUT_DIR/deck.pptx" && ${cli} add "$KITE_OUTPUT_DIR/deck.pptx" / --type slide && ${cli} add "$KITE_OUTPUT_DIR/deck.pptx" '/slide[1]' --type textbox --prop 'text=原始幻灯片' --prop x=2cm --prop y=2cm --prop width=18cm --prop height=3cm && printf '%s' ${pdfSpec} | "$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf --input - --out "$KITE_OUTPUT_DIR/preview.pdf" && printf '实际文本预览\\n原始内容' > "$KITE_OUTPUT_DIR/notes.txt"`
        : `source=${quote(workingPath!)}; test -f "$source" && ${cli} add "$source" /body --type paragraph --prop 'text=第二轮基于工作副本新增内容' && cp "$source" "$KITE_OUTPUT_DIR/report.docx"`;
      const delta = toolTurn
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: toolId,
                type: 'function',
                function: { name: shell, arguments: JSON.stringify({ command }) },
              },
            ],
          }
        : {
            role: 'assistant',
            content: '工具已返回；交付文件和实际错误以工具记录及文件卡片为准。',
          };
      const chunk = {
        id: `${toolId}-${toolTurn ? 'call' : 'final'}`,
        object: 'chat.completion.chunk',
        model: 'office-fixture',
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      const done = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    config.path,
    JSON.stringify({
      modelId: 'office-fixture',
      models: [
        {
          id: 'office-fixture',
          provider: 'compatible',
          model: 'office-fixture',
          baseURL: `${provider.url.origin}/v1`,
        },
      ],
    }),
  );
  const require = createRequire(import.meta.url);
  const child = Bun.spawn(
    [require('electron') as string, outdir, `--user-data-dir=${join(root, 'electron-profile')}`],
    {
      env: { ...process.env, ...config.homeEnvironment, ...loopbackModelEnvironment(provider.url) },
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    },
  );
  console.log('Fixture launched with actual desktop DISPLAY:', process.env.DISPLAY);
  const code = await child.exited;
  provider.stop(true);
  process.exitCode = code;
} else throw Error('choose_prepare_rebuild_or_run');
