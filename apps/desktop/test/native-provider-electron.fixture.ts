import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const [candidate, home, control, storeId] = process.argv.slice(2) as string[];
const started = Date.now();
const stage = (name: string, facts = {}) =>
  console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started, ...facts }));
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let childPid: number | undefined;
const pids: number[] = [],
  originals: any[] = [],
  runs: any[] = [],
  steers: any[] = [];
const configPath = join(home!, '.kite-code/unified-agent/default/config.jsonc');
const counts: any[] = [];
async function launch() {
  app = await _electron.launch({
    executablePath: join(candidate!, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate!, 'app'), `--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: home,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Provider A', exact: true }).waitFor();
  await openSessionTools(page);
  childPid = Number(
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((x) => x.trim().split(/\s+/))
      .find(
        (x) =>
          Number(x[1]) === app!.process().pid &&
          x.slice(2).join(' ') === join(candidate!, 'terminal/runtime/bun'),
      )?.[0],
  );
  assert.ok(childPid);
  pids.push(childPid!);
  stage('owned_service', { electronPid: app.process().pid, childPid });
  await app.evaluate(() => {
    const t = globalThis as any;
    t.providerPhysical = [];
    t.dropProviderSave = false;
    t.ownedTransport = undefined;
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0])),
          method = args[1]?.method ?? 'GET';
        if (
          url.pathname === '/v1/config/user/providers' ||
          url.pathname.startsWith('/v1/host-mutations/')
        )
          t.providerPhysical.push({ path: url.pathname, method });
        if (url.pathname === '/v1/config/user/providers')
          t.ownedTransport = { base: url.origin, headers: args[1]?.headers };
        if (url.pathname === '/v1/config/user/providers' && method === 'POST') {
          const response = await original(...args);
          if (t.dropProviderSave) {
            t.dropProviderSave = false;
            await response.arrayBuffer();
            throw new TypeError('fixture dropped one completed save response');
          }
          return response;
        }
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  return page;
}
async function close() {
  const owned = app!;
  const exit = new Promise<void>((resolve) => owned.process().once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app }) => app.quit());
  await exit;
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  stage('owned_service_dead', { childPid });
  childPid = undefined;
}
try {
  let page = await launch();
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string) {
    const end = Date.now() + 15000;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      assert.ok(Date.now() < end, label);
      await page.waitForTimeout(20);
    }
  }
  async function select(id: string) {
    await closeSettings(page);
    await page.getByRole('button', { name: `Provider ${id.toUpperCase()}`, exact: true }).click();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    assert.equal((await state()).selection?.session.id, id);
  }
  await select('a');
  assert.equal((await state()).selection?.storeId, storeId);
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await openSettings(page);
  await page.getByRole('button', { name: '提供商', exact: true }).click();
  const aliases = [
    ['compatible', 'OpenAI-compatible', 'model-a'],
    ['ollama', 'Ollama', ''],
    ['openai', 'OpenAI', 'model-openai'],
    ['deepseek', 'DeepSeek', 'model-deepseek'],
  ] as const;
  for (const [alias, label, name] of aliases) {
    await page.getByRole('button', { name: `配置 ${label}`, exact: true }).click();
    await page
      .getByRole('textbox', { name: '服务地址', exact: true })
      .fill(`${control}/${alias}/v1`);
    if (alias === 'openai' || alias === 'deepseek')
      await page
        .getByRole('textbox', { name: 'API key', exact: true })
        .fill(`owned-fixture-${alias}-nonpaid`);
    else await page.getByRole('combobox', { name: '凭据处理', exact: true }).selectOption('none');
    await page.getByRole('textbox', { name: '模型名称', exact: true }).fill(name);
    await page.getByRole('button', { name: '保存提供商配置', exact: true }).click();
    const saved = await until(
      state,
      (v) =>
        !!v.providerSettingsSubmissions?.some(
          (s) => s.operation.provider === alias && ['applied', 'failed'].includes(s.phase),
        ),
      `${alias} save not terminal`,
    );
    const row = saved.providerSettingsSubmissions!.find((s) => s.operation.provider === alias)!;
    originals.push(row);
    stage('provider_save', {
      alias,
      phase: row.phase,
      credentialState: row.credentialState,
      configurationState: row.configurationState,
      error: row.error,
    });
    assert.equal(
      row.phase,
      'applied',
      `${alias} default OS vault qualification failed: ${row.error}`,
    );
    assert.equal(row.configurationState, 'published');
    assert.equal(
      row.credentialState,
      alias === 'openai' || alias === 'deepseek' ? 'stored' : 'unchanged',
    );
    await page.getByRole('button', { name: '关闭提供商配置', exact: true }).click();
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const models = config.models as any[];
  assert.equal(models.length, 4);
  assert.ok(models.every((m) => m.enabled === false));
  const id = (alias: string) => models.find((m) => m.provider === alias).id;
  await openSettings(page);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '读取用户模型配置', exact: true }).click();
  for (const m of models) {
    assert.equal(
      await page.getByRole('button', { name: `设为默认 ${m.id}`, exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: `启用模型 ${m.id}`, exact: true }).click();
    await page.getByRole('button', { name: `禁用模型 ${m.id}`, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: `设为默认 ${id('compatible')}`, exact: true }).click();
  await until(
    async () => JSON.parse(readFileSync(configPath, 'utf8')).modelId,
    (v) => v === id('compatible'),
    'default A absent',
  );
  assert.equal(
    await page
      .getByRole('button', { name: `禁用模型 ${id('compatible')}`, exact: true })
      .isDisabled(),
    true,
  );
  async function choose(alias: string) {
    await closeSettings(page);
    const picker = page.getByRole('region', { name: '下一轮模型选择', exact: true });
    const popup = page.getByRole('dialog', { name: '模型与思考程度', exact: true });
    if (!(await popup.count())) await picker.getByRole('button', { name: /^模型：/ }).click();
    await popup.getByRole('button', { name: /^选择模型，当前/ }).click();
    await popup
      .getByRole('tablist', { name: '模型提供商', exact: true })
      .getByRole('tab', { name: alias, exact: true })
      .click();
    await popup.getByRole('option', { name: `选择模型 ${id(alias)}`, exact: true }).click();
  }
  async function effort(value: string) {
    const picker = page.getByRole('region', { name: '下一轮模型选择', exact: true });
    const popup = page.getByRole('dialog', { name: '模型与思考程度', exact: true });
    if (!(await popup.count())) await picker.getByRole('button', { name: /^模型：/ }).click();
    const label = ({ low: '低', high: '高' } as Record<string, string>)[value];
    assert.ok(label, 'fixture requests an explicit supported effort');
    const slider = popup.getByRole('slider', { name: '思考程度', exact: true });
    await slider.press('Home');
    for (let step = 0; step < 6 && (await slider.getAttribute('aria-valuetext')) !== label; step++)
      await slider.press('ArrowRight');
    assert.equal(await slider.getAttribute('aria-valuetext'), label);
    await popup.press('Escape');
  }
  async function send(marker: string) {
    await closeSettings(page);
    const preparing =
      (await page.getByRole('textbox', { name: '新对话草稿', exact: true }).count()) > 0;
    await page
      .getByRole('textbox', { name: preparing ? '新对话草稿' : '当前会话私有草稿', exact: true })
      .fill(marker);
    const button = page.getByRole('button', {
      name: preparing ? '发送首条消息' : '发送明确的新轮次',
      exact: true,
    });
    await button.click();
    const v = await until(
      state,
      (v) =>
        !!v.selection?.runs.some(
          (r) => r.status === 'completed' && !runs.some((x) => x.id === r.id),
        ),
      `${marker} run missing`,
    );
    const run = v.selection!.runs.find(
      (r) => r.status === 'completed' && !runs.some((x) => x.id === r.id),
    )!;
    runs.push({
      id: run.id,
      sessionId: v.selection!.session.id,
      marker,
      modelId: id(marker.split('_')[1]!),
    });
    stage('run_complete', { marker, runId: run.id });
  }
  await choose('openai');
  await effort('high');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).modelId, id('compatible'));
  await select('b');
  assert.match(await page.getByRole('region', { name: '下一轮模型选择' }).innerText(), /model-a/);
  await select('a');
  await send('NATIVE_openai_effort');
  await choose('ollama');
  await send('NATIVE_ollama_noeffort');
  await choose('deepseek');
  await send('NATIVE_deepseek_noeffort');
  await choose('compatible');
  await effort('low');
  await send('NATIVE_compatible_effort');
  await closeSettings(page);
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('NATIVE_compatible_held');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  const held = await until(
    state,
    (v) => v.selection!.runs.some((r) => r.isActive),
    'held A missing',
  );
  const heldRun = held.selection!.runs.find((r) => r.isActive)!;
  await until(
    async () => Number(await (await fetch(`${control}/count`)).text()),
    (v) => v === 5,
    'original physical A not held',
  );
  await choose('openai');
  await effort('high');
  await openSettings(page);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '读取用户模型配置', exact: true }).click();
  await page.getByRole('button', { name: '设为默认 ' + id('openai'), exact: true }).click();
  await until(
    async () => JSON.parse(readFileSync(configPath, 'utf8')).modelId,
    (v) => v === id('openai'),
    'changed default B absent',
  );
  await closeSettings(page);
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('NATIVE_plain_steer');
  await page.getByRole('button', { name: '引导当前轮次', exact: true }).click();
  const steered = await until(
    state,
    (v) => v.callerSubmissions!.some((row) => row.request.kind === 'input.steer'),
    'original steer missing',
  );
  steers.push(steered.callerSubmissions!.find((row) => row.request.kind === 'input.steer'));
  await fetch(`${control}/release`);
  await until(
    state,
    (v) => v.selection!.runs.some((r) => r.id === heldRun.id && r.status === 'completed'),
    'original held A incomplete',
  );
  runs.push({
    id: heldRun.id,
    sessionId: 'a',
    marker: 'NATIVE_compatible_held',
    modelId: id('compatible'),
  });
  await send('NATIVE_openai_next');
  await openSettings(page);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '读取用户模型配置', exact: true }).click();
  await page.getByRole('button', { name: `设为默认 ${id('compatible')}`, exact: true }).click();
  await until(
    async () => JSON.parse(readFileSync(configPath, 'utf8')).modelId,
    (v) => v === id('compatible'),
    'new session default A missing',
  );
  const beforeCreate = Number(await (await fetch(`${control}/count`)).text());
  await closeSettings(page);
  await page.getByRole('button', { name: '在 Providers 中新建对话', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.session-header').getByText('新对话', { exact: true }).waitFor();
  await openSessionTools(page);
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), beforeCreate);
  assert.equal(await page.getByRole('textbox', { name: '新对话草稿', exact: true }).count(), 1);
  // This inspection replaces the reader's observation; let the picker finish its own GET first.
  await page
    .getByRole('region', { name: '下一轮模型选择', exact: true })
    .getByRole('button', { name: /^模型：model-a/ })
    .waitFor();
  const unbound = await page.evaluate(
    async () =>
      await window.kiteNative!.request({ method: 'conversation.models.read', generation: 1 }),
  );
  assert.equal((unbound as { selectedModelId?: string }).selectedModelId, undefined);
  await choose('openai');
  await send('NATIVE_openai_newsession');
  await select('a');
  // Drop exactly the first completed physical save response; never replace its Service result.
  await openSettings(page);
  await page.getByRole('button', { name: '提供商', exact: true }).click();
  await page.getByRole('button', { name: '编辑 OpenAI-compatible', exact: true }).click();
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('model-a');
  await app!.evaluate(() => {
    (globalThis as any).dropProviderSave = true;
  });
  await page.getByRole('button', { name: '保存提供商配置', exact: true }).click();
  const unknown = await until(
    state,
    (v) => !!v.providerSettingsSubmissions?.some((s) => s.phase === 'unknown'),
    'dropped response did not retain original',
  );
  const original = unknown.providerSettingsSubmissions!.find((s) => s.phase === 'unknown')!;
  originals.push(original);
  counts.push(await app!.evaluate(() => (globalThis as any).providerPhysical));
  assert.equal(counts[0].filter((x: any) => x.method === 'POST').length, 5);
  assert.equal(counts[0].filter((x: any) => x.path.includes('/host-mutations/')).length, 0);
  const persisted = await app!.evaluate(
    (_, { home, commandId }) => {
      const { DatabaseSync } = process.getBuiltinModule(
        'node:sqlite',
      ) as typeof import('node:sqlite');
      const db = new DatabaseSync(
        `${home}/.kite-code/unified-agent/default/desktop-private/data.sqlite`,
        { readOnly: true },
      );
      try {
        return {
          version: db.prepare('PRAGMA user_version').get()!.user_version,
          mcpRows: db.prepare('SELECT COUNT(*) AS count FROM mcp_intents').get()!.count,
          row: db
            .prepare('SELECT state FROM configuration_intents WHERE command_id=?')
            .get(commandId)?.state,
        };
      } finally {
        db.close();
      }
    },
    { home, commandId: original.commandId },
  );
  assert.equal(persisted.version, 7);
  assert.equal(persisted.mcpRows, 0);
  assert.equal(typeof persisted.row, 'string');
  const safeRow = JSON.parse(persisted.row as string);
  assert.equal(safeRow.input.commandId, original.commandId);
  assert.equal(safeRow.state.phase, 'unknown');
  assert.equal('secret' in safeRow.input, false);
  assert.equal(JSON.stringify(safeRow).includes('owned-fixture-'), false);
  stage('cold_safe_original', { commandId: original.commandId, version: persisted.version });
  await close();
  page = await launch();
  await select('a');
  const coldRoute = await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'input.models.read', generation: 1 }),
  );
  assert.equal((coldRoute as { selectedModelId?: string }).selectedModelId, id('openai'));
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).modelId, id('compatible'));
  const before = Number(await (await fetch(`${control}/count`)).text());
  await openSettings(page);
  await page.getByRole('button', { name: '提供商', exact: true }).click();
  await page.getByRole('button', { name: '查询原提供商提交', exact: true }).click();
  await until(
    state,
    (v) =>
      v.providerSettingsSubmissions?.find((s) => s.commandId === original.commandId)?.phase ===
      'applied',
    'cold original explicit lookup missing',
  );
  counts.push(await app!.evaluate(() => (globalThis as any).providerPhysical));
  assert.equal(counts[1].filter((x: any) => x.method === 'POST').length, 0);
  assert.equal(
    counts[1].filter((x: any) => x.path === `/v1/host-mutations/${original.commandId}`).length,
    1,
  );
  assert.equal(Number(await (await fetch(`${control}/count`)).text()), before);
  await closeSettings(page);
  await page
    .getByRole('region', { name: '下一轮模型选择' })
    .getByRole('button', { name: '模型：model-openai，思考程度：默认', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: '下一轮模型选择' })
      .getByRole('button', { name: '模型：model-openai，思考程度：默认', exact: true })
      .count(),
    1,
  );
  // Only revoke this fixture's exact generated opaque references through the owned Service.
  const refs = models.flatMap((m) => (m.credentialRef ? [m.credentialRef] : []));
  // Capture authenticated transport with an explicit provider metadata GET during cold read.
  await app!.evaluate(async () => {
    const t = globalThis as any;
    const existing = t.fetch;
    let transport: any;
    t.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const u = new URL(String(args[0]));
        if (u.pathname === '/v1/config/user/providers')
          transport = { base: u.origin, headers: args[1]?.headers };
        return existing(...args);
      },
      { preconnect: existing.preconnect },
    );
    t.cleanupTransport = () => transport;
  });
  await openSettings(page);
  await page.getByRole('button', { name: '提供商', exact: true }).click();
  await page.getByRole('button', { name: '刷新提供商配置', exact: true }).click();
  await page.waitForTimeout(100);
  await app!.evaluate(
    async (_, { refs, storeId }) => {
      const t = (globalThis as any).cleanupTransport();
      if (!t) throw Error('missing owned transport');
      for (const ref of refs) {
        const r = await fetch(`${t.base}/v1/credentials/${encodeURIComponent(ref)}/revoke`, {
          method: 'POST',
          headers: { ...t.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: crypto.randomUUID(), expectedStoreId: storeId }),
        });
        if (!r.ok) throw Error(`owned credential cleanup ${r.status}`);
        const receipt = await r.json();
        if (receipt.state !== 'applied') throw Error('owned credential revoke not applied');
      }
    },
    { refs, storeId },
  );
  await close();
  writeFileSync(
    join(home!, 'provider-report.json'),
    JSON.stringify({ pids, originals, runs, steers, counts, models, refsRevoked: refs.length }),
  );
  stage('complete', {
    runs: runs.length,
    physicalSavePosts: 5,
    explicitColdGets: 1,
    refsRevoked: refs.length,
  });
} catch (error) {
  if (app)
    try {
      const refs = JSON.parse(readFileSync(configPath, 'utf8')).models.flatMap((m: any) =>
        m.credentialRef ? [m.credentialRef] : [],
      );
      await app
        .windows()[0]!
        .evaluate(
          async () =>
            await window.kiteNative!.request({ method: 'settings.providers.read', generation: 1 }),
        );
      await app.evaluate(
        async (_, { refs, storeId }) => {
          const t = (globalThis as any).ownedTransport;
          if (!t && refs.length) throw Error('missing owned cleanup transport');
          for (const ref of refs) {
            const response = await fetch(
              `${t.base}/v1/credentials/${encodeURIComponent(ref)}/revoke`,
              {
                method: 'POST',
                headers: { ...t.headers, 'content-type': 'application/json' },
                body: JSON.stringify({ commandId: crypto.randomUUID(), expectedStoreId: storeId }),
              },
            );
            const receipt = await response.json();
            if (!response.ok || receipt.state !== 'applied') throw Error('owned revoke failed');
          }
        },
        { refs, storeId },
      );
      stage('failed_fixture_owned_credentials_revoked', { count: refs.length });
    } catch (cleanup) {
      console.error('owned_cleanup_failure', String(cleanup));
    }
  if (app)
    try {
      console.error(
        'provider_actual_failure',
        JSON.stringify({ visible: await app.windows()[0]!.locator('body').innerText() }),
      );
    } catch {}
  throw error;
} finally {
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  if (app) {
    const owned = app;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            owned.process().kill('SIGKILL');
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
