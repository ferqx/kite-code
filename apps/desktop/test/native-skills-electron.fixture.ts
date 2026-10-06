import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

type Physical = {
  path: string;
  query: string;
  method: string;
  bytes?: number;
  entries?: number;
  complete?: boolean;
  revision?: string;
};
type FixtureGlobals = typeof globalThis & { skillsPhysical: Physical[] };
const [candidate, home, storeId] = process.argv.slice(2) as string[];
const started = Date.now(),
  pids: number[] = [],
  physical: Physical[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
const profile = join(home!, '.kite-code/unified-agent/default');
const workspace = join(home!, 'workspace');
const originalUser = readFileSync(join(profile, 'config.jsonc'), 'utf8');
const originalProject = readFileSync(join(workspace, 'kite-agent.jsonc'), 'utf8');
async function launch() {
  app = await _electron.launch({
    executablePath: join(candidate!, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate!, 'app'), `--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: home,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Skills Window', exact: true }).waitFor();
  childPid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((value) => value.trim().split(/\s+/))
      .find(
        (value) =>
          Number(value[1]) === app!.process().pid &&
          value.slice(2).join(' ') === join(candidate!, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(childPid);
  pids.push(childPid);
  stage('owned_service', { childPid, electronPid: app.process().pid });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await app.evaluate(() => {
    const t = globalThis as FixtureGlobals;
    t.skillsPhysical = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        const row: Physical = {
          path: url.pathname,
          query: url.search,
          method: args[1]?.method ?? 'GET',
        };
        t.skillsPhysical.push(row);
        const response = await original(...args);
        if (/\/skills$/.test(url.pathname) && response.ok) {
          const body = await response.clone().text();
          const dto = JSON.parse(body);
          Object.assign(row, {
            bytes: Buffer.byteLength(body),
            entries: dto.entries?.length,
            complete: dto.complete,
            revision: dto.revision,
          });
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  return page;
}
async function close() {
  if (!app) return;
  const owned = app,
    exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  stage('ordinary_exit_service_absent', { childPid });
  childPid = undefined;
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  const panel = () => page.getByRole('region', { name: 'Skills 目录', exact: true });
  async function select(name: string, workspaceId: string) {
    await page.getByRole('button', { name, exact: true }).click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    const observed = await state();
    assert.equal(observed.selection?.storeId, storeId);
    assert.equal(observed.selection?.session.workspaceId, workspaceId);
    assert.equal(observed.selection?.runs.length, 0);
    assert.equal(observed.selection?.executions.length, 0);
  }
  async function trust(workspaceId: string) {
    await page
      .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
      .check();
    await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
    await page
      .getByText(new RegExp(`^工作区：${workspaceId}；信任状态：trusted；版本：`))
      .waitFor();
  }
  async function skills() {
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
  }
  async function complete(count: number) {
    await panel().getByText(`已完整读取 ${count} 项 Skill。`, { exact: true }).waitFor();
    await panel()
      .getByRole('status')
      .filter({ hasText: '正在读取完整' })
      .waitFor({ state: 'hidden' });
    assert.equal(await panel().locator('li').count(), count);
  }
  async function refresh(count: number) {
    await panel().getByRole('button', { name: '刷新 Skills 目录', exact: true }).click();
    await complete(count);
  }
  async function details(summary: string, expected: string[]) {
    const entry = panel()
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: summary }) });
    assert.equal(await entry.count(), 1);
    if ((await entry.getAttribute('open')) === null) await entry.locator('summary').click();
    const text = await entry.innerText();
    for (const value of expected)
      assert.ok(text.includes(value), JSON.stringify({ summary, value, text }));
    assert.ok(!text.includes(home!));
    assert.ok(!text.includes('PRIVATE_SKILL_BODY'));
  }
  await select('Skills Window', 'w');
  await skills();
  await panel().getByRole('alert').filter({ hasText: 'workspace_untrusted' }).waitFor();
  assert.equal(await panel().locator('li').count(), 0);
  stage('untrusted_read_rejected');
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await trust('w');
  await skills();
  await complete(306);
  await details('Skill 000 · 可用', [
    '配置 ID：skill-000',
    'LONG_DESCRIPTION_TAIL_000',
    '配置来源：项目 · .agents',
  ]);
  await details('Kite metadata · 可用', ['配置 ID：kite', '配置来源：项目 · .kite-code']);
  await details('Profile metadata · 可用', ['配置 ID：profile', '配置来源：用户 · Profile Skills']);
  await details('Configured metadata · 可用', ['配置 ID：configured', '配置来源：项目 · 配置位置']);
  await details('disabled · 已禁用', [
    '配置 ID：disabled',
    '摘要未记录',
    '配置来源：项目 · .agents',
  ]);
  await details('missing · 不可用', ['配置 ID：missing', '配置来源：项目 · 配置位置', '原因：']);
  const first = await app!.evaluate(() =>
    (globalThis as FixtureGlobals).skillsPhysical.filter(
      (row) => row.path === '/v1/workspaces/w/skills' && row.bytes !== undefined,
    ),
  );
  assert.ok(first.length > 2, JSON.stringify(first));
  assert.equal(
    first.reduce((sum, row) => sum + row.entries!, 0),
    306,
  );
  assert.equal(new Set(first.map((row) => row.revision)).size, 1);
  assert.equal(first.at(-1)!.complete, true);
  assert.ok(
    first.some((row) => row.entries! < 256 && row.complete === false),
    'real byte-budget paging',
  );
  assert.ok(
    first.some((row) => row.query.includes('afterId=')),
    'real cursor GETs',
  );
  stage('complete_byte_paged_directory', { count: 306, pages: first.length, pagesEvidence: first });
  writeFileSync(
    join(workspace, '.agents/skills/skill-000/SKILL.md'),
    '---\nname: Refreshed metadata\ndescription: OWNED_FILE_REFRESH_TAIL\n---\nPRIVATE_SKILL_BODY',
  );
  await refresh(306);
  await panel().locator('summary').filter({ hasText: 'Refreshed metadata · 可用' }).waitFor();
  await details('Refreshed metadata · 可用', ['OWNED_FILE_REFRESH_TAIL']);
  const edited = JSON.parse(originalProject);
  edited.skills.push({ id: 'config-refresh', path: 'absent-refresh' });
  writeFileSync(join(workspace, 'kite-agent.jsonc'), JSON.stringify(edited));
  await refresh(307);
  await details('config-refresh · 不可用', ['配置 ID：config-refresh']);
  stage('owned_file_and_configuration_refresh');
  writeFileSync(join(workspace, 'kite-agent.jsonc'), '{ malformed');
  await panel().getByRole('button', { name: '刷新 Skills 目录', exact: true }).click();
  await panel()
    .getByRole('status')
    .filter({ hasText: 'Skills 目录当前不可用：configuration_unavailable' })
    .waitFor();
  assert.equal(await panel().locator('li').count(), 0);
  writeFileSync(join(workspace, 'kite-agent.jsonc'), JSON.stringify({ models: [], skills: [] }));
  writeFileSync(join(profile, 'config.jsonc'), JSON.stringify({ models: [], skills: [] }));
  await refresh(0);
  await panel().getByText('当前工作区没有可发现的 Skill。', { exact: true }).waitFor();
  assert.equal(
    await panel()
      .getByText(/Skills 目录当前不可用/)
      .count(),
    0,
  );
  stage('configuration_unavailable_and_true_empty_distinguished');
  writeFileSync(join(workspace, 'kite-agent.jsonc'), originalProject);
  writeFileSync(join(profile, 'config.jsonc'), originalUser);
  await refresh(306);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await select('Second Skills Window', 'w2');
  await trust('w2');
  await skills();
  await complete(2);
  await details('Second workspace · 可用', [
    '配置 ID：second',
    'SECOND_SCOPE_TAIL',
    '配置来源：项目 · .kite-code',
  ]);
  assert.equal(
    await panel().locator('summary').filter({ hasText: 'Refreshed metadata' }).count(),
    0,
  );
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await select('Skills Window', 'w');
  await skills();
  await complete(306);
  await panel().locator('summary').filter({ hasText: 'Refreshed metadata · 可用' }).waitFor();
  await page.getByRole('button', { name: '模型', exact: true }).click();
  assert.equal(await panel().count(), 0);
  await skills();
  await complete(306);
  stage('two_workspace_scopes_and_page_reopen');
  physical.push(...(await app!.evaluate(() => (globalThis as FixtureGlobals).skillsPhysical)));
  assert.ok(
    physical.every(
      (row) => row.method === 'GET' || (row.method === 'POST' && /\/trust$/.test(row.path)),
    ),
    JSON.stringify(physical.filter((row) => row.method !== 'GET')),
  );
  await page.context().tracing.stop({ path: join(home!, 'window-trace.zip') });
  await close();
  page = await launch();
  await select('Skills Window', 'w');
  await skills();
  await complete(306);
  await panel().locator('summary').filter({ hasText: 'Refreshed metadata · 可用' }).waitFor();
  const coldPhysical = await app!.evaluate(() => (globalThis as FixtureGlobals).skillsPhysical);
  assert.equal(coldPhysical.filter((row) => row.method !== 'GET').length, 0);
  const persisted = await app!.evaluate((_, home) => {
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const privateDb = new DatabaseSync(
      `${home}/.kite-code/unified-agent/default/desktop-private/data.sqlite`,
      { readOnly: true },
    );
    const core = new DatabaseSync(`${home}/.kite-code/unified-agent/default/core.db`, {
      readOnly: true,
    });
    try {
      return {
        version: privateDb.prepare('PRAGMA user_version').get()!.user_version,
        modelRoutes: privateDb.prepare('SELECT count(*) AS n FROM model_routes').get()!.n,
        configurationIntents: privateDb
          .prepare('SELECT count(*) AS n FROM configuration_intents')
          .get()!.n,
        runs: core.prepare('SELECT count(*) AS n FROM run').get()!.n,
        executions: core.prepare('SELECT count(*) AS n FROM execution').get()!.n,
      };
    } finally {
      privateDb.close();
      core.close();
    }
  }, home!);
  assert.deepEqual(persisted, {
    version: 7,
    modelRoutes: 0,
    configurationIntents: 0,
    runs: 0,
    executions: 0,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'config.jsonc'), 'utf8')).models, []);
  await page.context().tracing.stop({ path: join(home!, 'cold-trace.zip') });
  await close();
  writeFileSync(
    join(home!, 'skills-report.json'),
    JSON.stringify({ pids, physical, coldPhysical, persisted, count: 306, bytePages: first }),
  );
  stage('complete', {
    coldDatabase: persisted,
    ordinaryServiceExits: pids.length,
    businessPosts: 0,
  });
} catch (error) {
  if (app) {
    try {
      const page = app.windows()[0]!;
      writeFileSync(join(home!, 'window-failure.txt'), await page.locator('body').innerText());
      await page.screenshot({ path: join(home!, 'window-failure.png'), fullPage: true });
      await page.context().tracing.stop({ path: join(home!, 'window-failure-trace.zip') });
      stage('failure', {
        error: String(error),
        state: await page.evaluate(
          async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
        ),
      });
    } catch {}
    try {
      await close();
    } catch {}
  }
  throw error;
} finally {
  writeFileSync(join(home!, 'skills-owned-pids.json'), JSON.stringify(pids));
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  if (app) {
    const owned = app,
      timer = setTimeout(() => owned.process().kill('SIGKILL'), 2000);
    try {
      await owned.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
