import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState, NativeUserMcpSubmission } from '../src/native-bridge';

type Physical = { path: string; method: string };
type FixtureGlobals = typeof globalThis & { mcpPhysical: Physical[]; mcpDropNext?: boolean };
const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const submissions: NativeUserMcpSubmission[] = [],
  pids: number[] = [];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, servicePid: number | undefined;
const stage = (name: string, facts = {}) => console.log(JSON.stringify({ stage: name, ...facts }));
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
  await page.getByRole('button', { name: 'MCP Window', exact: true }).waitFor();
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
    const t = globalThis as FixtureGlobals,
      original = globalThis.fetch;
    t.mcpPhysical = [];
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0])),
          method = args[1]?.method ?? 'GET';
        t.mcpPhysical.push({ path: url.pathname, method });
        const response = await original(...args);
        if (t.mcpDropNext && method === 'POST' && url.pathname === '/v1/config/user/mcp') {
          t.mcpDropNext = false;
          throw Error('owned_reply_lost');
        }
        return response;
      },
      { preconnect: original.preconnect },
    );
  });
  return page;
}
async function close(trace: string) {
  if (!app) return;
  await (await app.firstWindow()).context().tracing.stop({ path: join(home, trace) });
  const owned = app,
    exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(servicePid!, 0));
  servicePid = undefined;
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
  async function settings() {
    if (!(await page.locator('.desktop-settings-dialog').isVisible()))
      await page
        .locator('.session-header')
        .getByRole('button', { name: '设置', exact: true })
        .click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await panel().getByRole('heading', { name: '我的 MCP', exact: true }).waitFor();
    await panel()
      .getByRole('button', { name: '新增 MCP', exact: true })
      .waitFor({ state: 'visible' });
  }
  async function ready() {
    await panel().getByRole('button', { name: 'Refresh MCP settings', exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>('[aria-label="Refresh MCP settings"]')?.disabled,
    );
  }
  async function refresh() {
    await ready();
    await panel().getByRole('button', { name: 'Refresh MCP settings', exact: true }).click();
    await ready();
  }
  async function manage(name: string) {
    if (await editor().count())
      await editor().getByRole('button', { name: '关闭', exact: true }).click();
    await panel()
      .getByRole('button', { name: `管理 ${name}`, exact: true })
      .click();
  }
  async function settle(kind: NativeUserMcpSubmission['operation']['kind'], phase = 'completed') {
    const deadline = Date.now() + 20000;
    for (;;) {
      const row = (await state()).userMcpSubmissions
        ?.filter(
          (value) =>
            value.operation.kind === kind &&
            !submissions.some((old) => old.commandId === value.commandId),
        )
        .at(-1);
      if (row && !['pending', 'submitting', 'outcome_unknown'].includes(row.phase)) {
        assert.equal(row.phase, phase, JSON.stringify(row));
        submissions.push(row);
        await ready();
        return row;
      }
      if (row) {
        const button = panel().getByRole('button', { name: '查看结果', exact: true }).last();
        if (await button.count()) await button.click({ timeout: 500 }).catch(() => {});
      }
      assert.ok(Date.now() < deadline, `global operation did not settle: ${JSON.stringify(row)}`);
      await page.waitForTimeout(80);
    }
  }
  async function add(name: string, transport: 'http' | 'stdio', address: string) {
    await refresh();
    await panel().getByRole('button', { name: '新增 MCP', exact: true }).click();
    assert.equal(await editor().getByRole('combobox', { name: 'Scope', exact: true }).count(), 0);
    await editor().getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await editor()
      .getByRole('combobox', { name: 'Transport', exact: true })
      .selectOption(transport);
    await editor().getByRole('textbox', { name: 'URL or command', exact: true }).fill(address);
    await editor().getByRole('button', { name: '添加', exact: true }).click();
    await editor()
      .getByRole('button', { name: 'Confirm exact MCP operation', exact: true })
      .click();
    await settle('add');
    await refresh();
  }
  async function operation(
    name: string,
    label: string,
    kind: NativeUserMcpSubmission['operation']['kind'],
    confirm = false,
  ) {
    await refresh();
    await manage(name);
    await editor().getByRole('button', { name: label, exact: true }).click();
    if (confirm)
      await editor()
        .getByRole('button', { name: 'Confirm exact MCP operation', exact: true })
        .click();
    return settle(kind);
  }
  assert.equal((await state()).selection, undefined);
  await settings();
  await ready();
  assert.ok(!(await panel().innerText()).includes('选择会话'));
  assert.ok(!(await panel().innerText()).includes('window-project'));
  await page.screenshot({ path: join(home, 'global-no-session.png'), fullPage: true });
  stage('global_without_session');
  await add('window-http', 'http', `${control}/mcp`);
  await operation('window-http', '停用', 'enabled');
  await operation('window-http', '启用', 'enabled');
  await operation('window-http', '建立连接', 'connect');
  await refresh();
  await manage('window-http');
  await editor().getByRole('button', { name: '查看工具', exact: true }).click();
  await editor().getByText('owned_effect', { exact: true }).waitFor();
  assert.ok((await editor().innerText()).includes('UNICODE_FULL_TAIL'));
  await editor().getByRole('button', { name: '查看参数', exact: true }).first().click();
  const schema = JSON.parse(await editor().locator('[data-mcp-schema="input"]').innerText());
  assert.equal(schema.properties.value.type, 'string');
  assert.deepEqual(schema.required, ['value']);
  await editor().locator('[data-mcp-schema="input"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(home, 'global-tools-schema.png'), fullPage: true });
  await editor().getByRole('button', { name: '下一页', exact: true }).click();
  await editor().getByText('owned_tool_33', { exact: true }).waitFor();
  assert.ok((await editor().innerText()).includes('owned_effect'));
  await page.screenshot({ path: join(home, 'global-tools-pages.png'), fullPage: true });
  stage('global_tools_schema_and_continuous_pages');
  await operation('window-http', '刷新工具', 'refresh');
  await operation('window-http', '重新连接', 'reconnect', true);
  await operation('window-http', '断开连接', 'disconnect');
  await add('window-stdio', 'stdio', join(home, 'mcp-stdio'));
  await manage('window-stdio');
  if (await editor().getByRole('button', { name: '启用', exact: true }).count())
    await operation('window-stdio', '启用', 'enabled');
  await operation('window-stdio', '建立连接', 'connect');
  await operation('window-stdio', '重新连接', 'reconnect', true);
  await operation('window-stdio', '断开连接', 'disconnect');
  await operation('window-stdio', '删除 MCP', 'remove', true);
  await refresh();
  if (await editor().count())
    await editor().getByRole('button', { name: '关闭', exact: true }).click();
  await panel().getByRole('button', { name: '新增 MCP', exact: true }).click();
  await editor().getByRole('textbox', { name: 'Name', exact: true }).fill('unsaved-preserved');
  const beforeSelection = await app!.evaluate(
    () =>
      (globalThis as FixtureGlobals).mcpPhysical.filter(
        (r) => r.path === '/v1/config/user/mcp' && r.method === 'GET',
      ).length,
  );
  await page.evaluate(
    async () =>
      await window.kiteNative!.request({
        method: 'select',
        generation: 1,
        sessionId: 'mcp-window',
      }),
  );
  await page.waitForTimeout(150);
  assert.equal(
    await editor().getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'unsaved-preserved',
  );
  assert.equal(
    await app!.evaluate(
      () =>
        (globalThis as FixtureGlobals).mcpPhysical.filter(
          (r) => r.path === '/v1/config/user/mcp' && r.method === 'GET',
        ).length,
    ),
    beforeSelection,
  );
  assert.ok(!(await panel().innerText()).includes('window-project'));
  await page.screenshot({ path: join(home, 'global-selection-stable.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await editor().waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
  await settings();
  await refresh();
  await manage('window-http');
  await app!.evaluate(() => {
    (globalThis as FixtureGlobals).mcpDropNext = true;
  });
  await editor().getByRole('button', { name: '建立连接', exact: true }).click();
  const lost = await settle('connect');
  for (const row of submissions) assert.equal(row.storeId, storeId);
  const physical = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
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
  for (const row of persisted.rows) {
    const value = JSON.parse(String(row.state));
    assert.equal(value.version, 2);
    assert.equal(value.scope, 'user');
    assert.ok(!('sessionId' in value));
  }
  await close('global-window-trace.zip');
  page = await launch();
  await settings();
  await page.screenshot({ path: join(home, 'global-cold-originals.png'), fullPage: true });
  assert.equal(await panel().getByText('操作结果待确认。', { exact: false }).count(), 0);
  const before = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
  assert.equal(before.filter((r) => r.method === 'POST').length, 0);
  assert.equal(before.filter((r) => /\/operations\//.test(r.path)).length, 0);
  // Cold verification is explicit and reads the original global ID only.
  await page.evaluate(
    async (commandId) =>
      await window.kiteNative!.request({
        method: 'settings.userMcp.lookup',
        generation: 1,
        commandId,
      }),
    lost.commandId,
  );
  const after = await app!.evaluate(() => (globalThis as FixtureGlobals).mcpPhysical);
  assert.equal(after.filter((r) => r.method === 'POST').length, 0);
  assert.equal(after.filter((r) => r.path.endsWith(`/operations/${lost.commandId}`)).length, 1);
  await close('global-cold-trace.zip');
  writeFileSync(
    join(home, 'mcp-report.json'),
    JSON.stringify({
      pids,
      submissions,
      physical,
      persisted,
      after,
      noSession: true,
      stableSelection: true,
      schema,
      continuousTools: true,
    }),
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    writeFileSync(join(home, 'global-window-failure.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: join(home, 'global-window-failure.png'), fullPage: true });
    await close('global-failure-trace.zip').catch(() => {});
  }
  throw error;
}
