import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [launcher, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
type Physical = { path: string; method: string; body?: string };
const started = Date.now();
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, servicePid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
process.on('SIGTERM', () => {
  if (servicePid)
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
  app?.process().kill('SIGKILL');
  process.exitCode = 1;
});
async function launch() {
  app = await _electron.launch({
    executablePath: launcher,
    args: [`--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  assert.deepEqual(
    await app.evaluate(({ app, BrowserWindow }) => {
      const preferences = (
        BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
          getLastWebPreferences(): {
            sandbox?: boolean;
            contextIsolation?: boolean;
            nodeIntegration?: boolean;
          };
        }
      ).getLastWebPreferences();
      return {
        disabled: app.commandLine.hasSwitch('no-sandbox'),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    }),
    { disabled: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  // Observe actual Client traffic without replacing HTTP results or the formal UI consumer.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__extensionPhysical=[];globalThis.fetch=async(input,init)=>{const r=new Request(input,init);globalThis.__extensionPhysical.push({path:new URL(r.url).pathname,method:r.method,...(r.method==='POST'?{body:await r.clone().text()}:{})});return original(input,init);};})()`,
  );
  await page
    .getByRole('button', { name: 'Extension source', exact: true })
    .and(page.locator('button.session-row'))
    .waitFor();
  const children = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (row) =>
        Number(row[1]) === app!.process().pid &&
        row.slice(2).join(' ').endsWith('/terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  servicePid = Number(children[0]![0]);
  await page
    .getByRole('button', { name: 'Extension source', exact: true })
    .and(page.locator('button.session-row'))
    .click();
  await page.locator('.session-header').getByTitle('Extension source', { exact: true }).waitFor();
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  return page;
}
const state = (page: import('playwright').Page) =>
  page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
const count = async () => Number(await (await fetch(`${control}/count`)).text());
async function physical() {
  return (await app!.evaluate('globalThis.__extensionPhysical')) as Physical[];
}
async function close() {
  const owned = app!,
    pid = servicePid!;
  const exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(pid, 0));
  servicePid = undefined;
  stage('owned_service_dead', { pid });
}
async function settle(page: import('playwright').Page, previous: string[]) {
  const panel = page.locator('details[aria-label="扩展能力"]');
  let commandId = '';
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const facts = await state(page);
    const record = facts.callerSubmissions?.find(
      (value) =>
        value.request.kind === 'extension.invoke' && !previous.includes(value.request.commandId),
    );
    if (record) commandId = record.request.commandId;
    if (
      commandId &&
      (await panel.getByText(`原命令 ${commandId}：succeeded`, { exact: true }).count())
    ) {
      stage('original_extension_terminal', { commandId });
      await panel.getByRole('button', { name: '新动作', exact: true }).click();
      return commandId;
    }
    const lookup = panel.getByRole('button', { name: '查询原命令', exact: true }).first();
    if (await lookup.isEnabled()) await lookup.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error(`original_extension_not_terminal:${commandId}`);
}
try {
  let page = await launch();
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  const permissions = page.getByRole('region', { name: '权限与工作区信任', exact: true });
  await permissions
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await permissions.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await permissions.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await permissions.getByRole('radio', { name: 'Full', exact: true }).check();
  await permissions.getByRole('button', { name: '保存模式选择', exact: true }).click();
  await permissions.getByText(/^当前模式：full；默认模式：/).waitFor();
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('Create the saved source for a review');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  await page
    .locator('.agent-turn-final')
    .getByText('Original extension source result', { exact: true })
    .waitFor();
  const source = await state(page),
    run = source.selection!.runs.find((value) => value.status === 'completed')!,
    model = source.selection!.executions.find(
      (value) => value.kind === 'model' && value.runId === run.id && value.status === 'succeeded',
    )!;
  assert.ok(run && model);
  assert.equal(source.selection!.storeId, storeId);
  assert.equal(await count(), 1);
  await app!.evaluate('globalThis.__extensionPhysical=[]');
  let panel = page.locator('details[aria-label="扩展能力"]');
  await panel.locator('summary').click();
  const extension = panel
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'fixture.mini-review · 1', exact: true }) });
  await extension.waitFor();
  const analyze = extension
      .locator('div')
      .filter({
        has: page.getByRole('heading', {
          name: 'Analyze one authorized source result using a new explicit business identity',
          exact: true,
        }),
      })
      .first(),
    query = extension
      .locator('div')
      .filter({
        has: page.getByRole('heading', {
          name: 'Read saved results with a generic public presentation',
          exact: true,
        }),
      })
      .first(),
    commands: string[] = [];
  async function analyzeNew(businessKey: string) {
    await analyze.getByRole('textbox', { name: 'businessKey', exact: true }).fill(businessKey);
    await analyze.getByRole('textbox', { name: 'sourceRunId', exact: true }).fill(run.id);
    await analyze.getByRole('textbox', { name: 'sourceExecutionId', exact: true }).fill(model.id);
    await analyze.getByRole('button', { name: '执行动作', exact: true }).click();
    commands.push(await settle(page, commands));
  }
  async function results(summary: string) {
    await query.getByRole('button', { name: '读取结果', exact: true }).click();
    await panel.getByText(summary, { exact: true }).waitFor();
  }
  await analyzeNew('native-review-one');
  await results('Review native-review-one: unmarked');
  assert.ok((await panel.innerText()).includes('Check the saved source result.'));
  assert.ok((await panel.innerText()).includes(model.id));
  assert.ok((await panel.innerText()).includes(run.id));
  await panel.getByRole('button', { name: 'Mark', exact: true }).click();
  commands.push(await settle(page, commands));
  await results('Review native-review-one: marked');
  await analyzeNew('native-review-two');
  await results('Review native-review-two: unmarked');
  assert.equal(await count(), 1);
  const rows = await physical(),
    posts = rows.filter((value) => value.method === 'POST');
  assert.equal(posts.length, 3);
  assert.deepEqual(
    posts.map((value) => JSON.parse(value.body!).actionId),
    ['fixture.mini-review.analyze', 'fixture.mini-review.mark', 'fixture.mini-review.analyze'],
  );
  const after = await state(page);
  assert.equal(after.selection!.runs.length, 1);
  assert.equal(
    after.selection!.executions.filter(
      (value) =>
        value.definitionId === 'fixture.mini-review.fixed-analysis' && value.status === 'succeeded',
    ).length,
    2,
  );
  stage('formal_source_analyze_finding_mark_new_identity', {
    runId: run.id,
    modelExecutionId: model.id,
    commands,
    extensionPosts: posts.length,
    modelCalls: await count(),
  });
  await page.context().tracing.stop({ path: join(home, 'extension-window.zip') });
  await close();
  page = await launch();
  panel = page.locator('details[aria-label="扩展能力"]');
  await panel.locator('summary').click();
  await panel.getByRole('heading', { name: 'fixture.mini-review · 1', exact: true }).waitFor();
  for (const commandId of commands) {
    const record = panel.locator('p').filter({ hasText: commandId });
    await record.getByRole('button', { name: '查询原命令', exact: true }).click();
    await panel
      .getByRole('status')
      .getByText(`原命令 ${commandId}：succeeded`, { exact: true })
      .waitFor();
  }
  const coldQuery = panel
    .locator('div')
    .filter({
      has: page.getByRole('heading', {
        name: 'Read saved results with a generic public presentation',
        exact: true,
      }),
    })
    .first();
  await coldQuery.getByRole('button', { name: '读取结果', exact: true }).click();
  await panel.getByText('Review native-review-one: marked', { exact: true }).waitFor();
  await panel.getByText('Review native-review-two: unmarked', { exact: true }).waitFor();
  const coldRows = await physical();
  assert.ok(coldRows.length > 0 && coldRows.every((value) => value.method === 'GET'));
  assert.equal(await count(), 1);
  stage('cold_original_commands_and_views_without_replay', {
    commandIds: commands,
    posts: 0,
    modelCalls: await count(),
  });
  await close();
} catch (error) {
  console.error(error);
  if (app)
    try {
      const page = await app.firstWindow();
      writeFileSync(join(home, 'extension-failure.txt'), await page.locator('body').innerText());
      await page.screenshot({ path: join(home, 'extension-failure.png'), fullPage: true });
    } catch {}
  process.exitCode = 1;
} finally {
  if (app)
    try {
      await close();
    } catch (error) {
      console.error(error);
      app.process().kill('SIGKILL');
      process.exitCode = 1;
    }
}
