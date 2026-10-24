import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState, NativeUserMcpSubmission } from '../src/native-bridge';

type Physical = { path: string; method: string };
type Globals = typeof globalThis & { mcpBrowserPhysical: Physical[] };
const [candidate, home, control, storeId, serverId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const pids: number[] = [],
  submissions: NativeUserMcpSubmission[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, servicePid: number | undefined;
const stage = (name: string, facts = {}) => console.log(JSON.stringify({ stage: name, ...facts }));
const counts = async () =>
  (await (await fetch(`${control}/counts`)).json()) as Record<string, number>;
async function launch() {
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 15000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'MCP Browser', exact: true }).waitFor();
  servicePid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(
        (parts) =>
          Number(parts[1]) === app!.process().pid &&
          parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(servicePid);
  pids.push(servicePid);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await app.evaluate(() => {
    const t = globalThis as Globals,
      original = globalThis.fetch;
    t.mcpBrowserPhysical = [];
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        t.mcpBrowserPhysical.push({ path: url.pathname, method: args[1]?.method ?? 'GET' });
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  return page;
}
async function close(trace: string) {
  if (!app) return;
  const owned = app,
    pid = servicePid!;
  await (await owned.firstWindow()).context().tracing.stop({ path: join(home, trace) });
  const exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  servicePid = undefined;
  assert.throws(() => process.kill(pid, 0));
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  const panel = () => page.getByRole('region', { name: 'MCP settings', exact: true });
  const editor = () => page.locator('.settings-editor-panel').getByRole('complementary');
  async function ready() {
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh MCP settings"]',
      );
      return !!button && !button.disabled;
    });
  }
  async function settings() {
    if (!(await page.locator('.desktop-settings-dialog').isVisible()))
      await page
        .locator('.session-header')
        .getByRole('button', { name: '设置', exact: true })
        .click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await panel().getByRole('heading', { name: '我的 MCP', exact: true }).waitFor();
    await ready();
  }
  async function refresh() {
    await ready();
    await panel().getByRole('button', { name: 'Refresh MCP settings', exact: true }).click();
    await ready();
  }
  async function manage() {
    if (await editor().count())
      await editor().getByRole('button', { name: '关闭', exact: true }).click();
    await panel().getByRole('button', { name: '管理 window-oauth', exact: true }).click();
  }
  async function settle(
    kind: NativeUserMcpSubmission['operation']['kind'],
    cancelWhenAuthorized = false,
  ) {
    const deadline = Date.now() + 130000;
    let cancelled = false;
    for (;;) {
      const row = (await state()).userMcpSubmissions
        ?.filter(
          (value) =>
            value.operation.kind === kind &&
            !submissions.some((old) => old.commandId === value.commandId),
        )
        .at(-1);
      if (row && cancelWhenAuthorized && !cancelled && (await counts()).held! > 0) {
        await panel().getByRole('button', { name: '取消操作', exact: true }).last().click();
        cancelled = true;
      }
      if (row && !['pending', 'submitting', 'outcome_unknown'].includes(row.phase)) {
        assert.equal(
          row.phase,
          cancelWhenAuthorized ? 'cancelled' : 'completed',
          JSON.stringify(row),
        );
        submissions.push(row);
        await ready();
        return row;
      }
      if (row) {
        const button = panel().getByRole('button', { name: '查看结果', exact: true }).last();
        if (await button.count()) await button.click({ timeout: 500 }).catch(() => {});
      }
      assert.ok(
        Date.now() < deadline,
        `global OAuth original did not settle: ${JSON.stringify(row)}`,
      );
      await page.waitForTimeout(100);
    }
  }
  async function auth(
    label: string,
    kind: NativeUserMcpSubmission['operation']['kind'],
    cancel = false,
  ) {
    await refresh();
    await manage();
    await editor().getByRole('button', { name: label, exact: true }).click();
    if (kind === 'clear' || kind === 'revoke')
      await editor()
        .getByRole('button', { name: 'Confirm exact MCP operation', exact: true })
        .click();
    return settle(kind, cancel);
  }
  async function presence(expected: boolean) {
    await refresh();
    await manage();
    await editor()
      .getByText(expected ? '已登录' : '未登录', { exact: true })
      .waitFor();
  }
  async function confirmColdOriginals() {
    for (const original of submissions)
      await page.evaluate(
        async (commandId) =>
          await window.kiteNative!.request({
            method: 'settings.userMcp.lookup',
            generation: 1,
            commandId,
          }),
        original.commandId,
      );
  }
  assert.equal((await state()).selection, undefined);
  await settings();
  assert.equal(await panel().getByText('window-oauth', { exact: true }).count(), 1);
  await auth('检查状态', 'authStatus');
  await presence(false);
  stage('default_browser_login_ready');
  await auth('登录', 'login');
  await presence(true);
  const first = await counts();
  assert.equal(first.authorize, 1);
  assert.equal(first.codeExchange, 1);
  assert.equal(first.register, 1);
  assert.equal(first.initialize, 0);
  stage('default_browser_pkce_complete', { counts: first, connectionStillIndependent: true });
  await close('browser-login-trace.zip');
  page = await launch();
  await settings();
  const coldBefore = await counts();
  const before = await app!.evaluate(() => (globalThis as Globals).mcpBrowserPhysical);
  assert.equal(before.filter((row) => row.method === 'POST').length, 0);
  assert.equal(before.filter((row) => row.path.includes('/operations/')).length, 0);
  await confirmColdOriginals();
  await presence(true);
  assert.deepEqual(await counts(), coldBefore);
  const physical = await app!.evaluate(() => (globalThis as Globals).mcpBrowserPhysical);
  assert.equal(physical.filter((row) => row.method === 'POST').length, 0);
  for (const original of submissions)
    assert.equal(
      physical.filter((row) => row.path.endsWith(`/operations/${original.commandId}`)).length,
      1,
    );
  await auth('建立连接', 'connect');
  const afterConnect = await counts();
  assert.equal(afterConnect.authorize, 1);
  assert.equal(afterConnect.register, 1);
  assert.equal(afterConnect.codeExchange, 1);
  assert.equal(afterConnect.initialize, 1);
  assert.equal(afterConnect.list, 1);
  stage('fresh_service_default_vault_resume', { counts: afterConnect, coldPosts: 0 });
  await auth('刷新登录', 'authRefresh');
  const refreshed = await counts();
  assert.equal(refreshed.refresh, 1);
  assert.equal(refreshed.authorize, 1);
  await auth('清除登录', 'clear');
  await presence(false);
  assert.equal((await counts()).revoke, 0);
  await auth('登录', 'login');
  await presence(true);
  await auth('撤销登录', 'revoke');
  await presence(false);
  const revoked = await counts();
  assert.equal(revoked.revoke, 1);
  assert.equal(revoked.authorize, 2);
  assert.equal(revoked.codeExchange, 2);
  await fetch(`${control}/hold`, { method: 'POST' });
  await auth('登录', 'login', true);
  const cancelled = await counts();
  assert.equal(cancelled.held, 1);
  assert.equal(cancelled.codeExchange, 2);
  await presence(false);
  await auth('清除登录', 'clear');
  await presence(false);
  for (const row of submissions) {
    assert.equal(row.storeId, storeId);
    assert.equal('serverId' in row.operation ? row.operation.serverId : undefined, serverId);
  }
  await close('browser-actions-trace.zip');
  page = await launch();
  await settings();
  const absenceBefore = await counts();
  await presence(false);
  assert.deepEqual(await counts(), absenceBefore);
  const persisted = await app!.evaluate((_, root) => {
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(
      `${root}/.kite-code/unified-agent/default/desktop-private/data.sqlite`,
      { readOnly: true },
    );
    try {
      return {
        version: db.prepare('PRAGMA user_version').get()!.user_version,
        rows: db.prepare('SELECT command_id,state FROM mcp_intents').all(),
      };
    } finally {
      db.close();
    }
  }, home);
  assert.equal(persisted.version, 7);
  for (const row of persisted.rows) assert.equal(JSON.parse(String(row.state)).version, 2);
  await close('browser-absence-trace.zip');
  writeFileSync(
    join(home, 'browser-report.json'),
    JSON.stringify({
      pids,
      submissions,
      first,
      afterConnect,
      refreshed,
      revoked,
      cancelled,
      physical,
      persisted,
    }),
  );
  stage('complete', { counts: await counts(), services: pids.length });
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    writeFileSync(join(home, 'browser-window-failure.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: join(home, 'browser-window-failure.png'), fullPage: true });
    await close('browser-failure-trace.zip').catch(() => {});
  }
  throw error;
} finally {
  writeFileSync(join(home, 'browser-owned-pids.json'), JSON.stringify(pids));
}
