import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

async function openSettings(page: import('playwright').Page) {
  if (!(await page.locator('.desktop-settings-dialog').isVisible()))
    await page
      .locator('.session-header')
      .getByRole('button', { name: '设置', exact: true })
      .click();
}
async function closeSettings(page: import('playwright').Page) {
  if (await page.locator('.desktop-settings-dialog').isVisible())
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
}

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

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
const [candidate, home, storeId, userConfiguration] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const started = Date.now(),
  pids: number[] = [],
  physical: Physical[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
const workspace = join(home!, 'workspace');
const userRoot = dirname(userConfiguration);
const originalUser = readFileSync(userConfiguration, 'utf8');
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
  await openSessionTools(page);
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
    await closeSettings(page);
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
  async function skills() {
    await openSettings(page);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
  }
  async function complete(count: number) {
    await page.waitForFunction((expected) => {
      const catalogue = document.querySelector('[aria-label="Skills 目录"]');
      return (
        catalogue &&
        catalogue.getAttribute('aria-busy') !== 'true' &&
        catalogue.querySelectorAll('li').length === expected
      );
    }, count);
    assert.equal(await panel().locator('li').count(), count);
  }
  async function refresh(count: number) {
    await panel().getByRole('button', { name: '刷新 Skills 目录', exact: true }).click();
    await complete(count);
  }
  async function details(summary: string, expected: string[]) {
    const separator = summary.lastIndexOf(' · ');
    const name = summary.slice(0, separator);
    const state = summary.slice(separator + 3);
    const row = panel().getByRole('button', { name: `查看 ${name} 详情`, exact: true });
    assert.equal(await row.count(), 1);
    assert.ok((await row.innerText()).includes(state));
    await row.click();
    const entry = page
      .locator('.settings-editor-panel')
      .getByRole('complementary', { name: `${name} 详情`, exact: true });
    await entry.waitFor();
    assert.equal(await entry.locator('details').count(), 0);
    const text = await entry.innerText();
    for (const value of expected)
      assert.ok(text.includes(value), JSON.stringify({ summary, value, text }));
    for (const hidden of ['技术详情', '配置 ID：', '版本：', '只读目录信息'])
      assert.ok(!text.includes(hidden), JSON.stringify({ summary, hidden, text }));
    assert.ok(!text.includes(home!));
    assert.ok(!text.includes('PRIVATE_SKILL_BODY'));
    await entry.getByRole('button', { name: '返回列表', exact: true }).click();
    await entry.waitFor({ state: 'hidden' });
  }
  assert.equal((await state()).selection, undefined);
  await skills();
  await complete(306);
  await details('Skill 000 · 可用', [
    'Skill 000',
    'LONG_DESCRIPTION_TAIL_000',
    '配置来源：用户 · .agents',
  ]);
  await details('Kite metadata · 可用', ['Kite metadata', '配置来源：用户 · .kite-code']);
  await details('Profile metadata · 可用', ['Profile metadata', '配置来源：用户 · Profile Skills']);
  await details('Configured metadata · 可用', ['Configured metadata', '配置来源：用户 · 配置位置']);
  await details('disabled · 已禁用', ['disabled', '摘要未记录', '配置来源：用户 · .agents']);
  await details('missing · 不可用', ['missing', '配置来源：用户 · 配置位置', '原因：']);
  const first = await app!.evaluate(() =>
    (globalThis as FixtureGlobals).skillsPhysical.filter(
      (row) => row.path === '/v1/config/user/skills' && row.bytes !== undefined,
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
    join(userRoot, '.agents/skills/skill-000/SKILL.md'),
    '---\nname: Refreshed metadata\ndescription: OWNED_FILE_REFRESH_TAIL\n---\nPRIVATE_SKILL_BODY',
  );
  await refresh(306);
  await panel()
    .getByRole('button', { name: '查看 Refreshed metadata 详情', exact: true })
    .waitFor();
  await details('Refreshed metadata · 可用', ['OWNED_FILE_REFRESH_TAIL']);
  const edited = JSON.parse(originalUser);
  edited.skills.push({ id: 'config-refresh', path: 'absent-refresh' });
  writeFileSync(userConfiguration, JSON.stringify(edited));
  await refresh(307);
  await details('config-refresh · 不可用', ['config-refresh']);
  stage('owned_file_and_configuration_refresh');
  writeFileSync(userConfiguration, '{ malformed');
  await panel().getByRole('button', { name: '刷新 Skills 目录', exact: true }).click();
  await panel().getByRole('alert').filter({ hasText: 'configuration_unavailable' }).waitFor();
  assert.equal(await panel().locator('li').count(), 307);
  assert.ok((await panel().innerText()).includes('保留上次完整目录，尚未确认最新状态'));
  writeFileSync(join(workspace, 'kite-agent.jsonc'), JSON.stringify({ models: [], skills: [] }));
  writeFileSync(userConfiguration, JSON.stringify({ models: [], skills: [] }));
  await refresh(0);
  await panel().getByText('尚未配置用户 Skill。', { exact: true }).waitFor();
  assert.equal(
    await panel()
      .getByText(/Skills 目录当前不可用/)
      .count(),
    0,
  );
  stage('configuration_unavailable_and_true_empty_distinguished');
  writeFileSync(join(workspace, 'kite-agent.jsonc'), originalProject);
  writeFileSync(userConfiguration, originalUser);
  await refresh(306);
  // Project JSONC is deliberately broken while the user directory stays readable.
  writeFileSync(join(workspace, 'kite-agent.jsonc'), '{ malformed project config');
  await refresh(306);
  const beforeSelection = await app!.evaluate(() => (globalThis as FixtureGlobals).skillsPhysical);
  assert.ok(
    beforeSelection.every((row) => row.method === 'GET'),
    JSON.stringify(beforeSelection),
  );
  stage('global_settings_gets_only', { requests: beforeSelection.length });
  await select('Second Skills Window', 'w2');
  await skills();
  await complete(306);
  await details('Refreshed metadata · 可用', ['OWNED_FILE_REFRESH_TAIL']);
  assert.equal(
    await panel().getByRole('button', { name: '查看 Second workspace 详情', exact: true }).count(),
    0,
  );
  await select('Skills Window', 'w');
  await skills();
  await complete(306);
  await panel()
    .getByRole('button', { name: '查看 Refreshed metadata 详情', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '模型', exact: true }).click();
  assert.equal(await panel().count(), 0);
  await skills();
  await complete(306);
  stage('user_scope_survives_session_and_workspace_switches');
  physical.push(...(await app!.evaluate(() => (globalThis as FixtureGlobals).skillsPhysical)));
  assert.ok(
    physical.every(
      (row) =>
        row.method === 'GET' ||
        (row.method === 'POST' &&
          /^\/v1\/sessions\/(skills-window|second-skills-window)\/reconcile$/.test(row.path)),
    ),
    JSON.stringify(physical.filter((row) => row.method !== 'GET')),
  );
  assert.equal(physical.filter((row) => row.method === 'POST').length, 2);
  await page.context().tracing.stop({ path: join(home!, 'window-trace.zip') });
  await close();
  page = await launch();
  await skills();
  await complete(306);
  await panel()
    .getByRole('button', { name: '查看 Refreshed metadata 详情', exact: true })
    .waitFor();
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
  assert.deepEqual(JSON.parse(readFileSync(userConfiguration, 'utf8')).models, []);
  await page.context().tracing.stop({ path: join(home!, 'cold-trace.zip') });
  await close();
  writeFileSync(
    join(home!, 'skills-report.json'),
    JSON.stringify({ pids, physical, coldPhysical, persisted, count: 306, bytePages: first }),
  );
  stage('complete', {
    coldDatabase: persisted,
    ordinaryServiceExits: pids.length,
    skillCataloguePosts: 0,
    sessionReconciliations: 2,
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
