import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, root, dataRoot, storeId, endpoint, electronExecutable, control, bunExecutable] =
  process.argv.slice(2) as [string, string, string, string, string, string, string, string];
const application = await _electron.launch({
  executablePath: electronExecutable,
  args: [outdir, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 10000,
});
let servicePid = 0;
const count = async () => Number(await (await fetch(`${control}/count`)).text());
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  const panel = page.getByRole('region', { name: '权限与工作区信任' });
  await panel.getByRole('radio', { name: 'Accept Edits', exact: true }).check();
  await panel.getByRole('checkbox', { name: '同时设为以后会话的默认模式' }).check();
  await panel.getByRole('button', { name: '保存模式选择' }).press('Enter');
  await panel
    .getByText('当前模式：accept_edits；默认模式：accept_edits', { exact: true })
    .waitFor();
  await panel.getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围' }).check();
  await panel.getByRole('button', { name: '信任所显示的范围' }).press('Enter');
  await panel.getByText(/信任状态：trusted/).waitFor();
  await panel.getByRole('button', { name: '撤销工作区信任' }).press('Enter');
  await panel.getByText(/信任状态：untrusted/).waitFor();
  assert.equal(await count(), 0);
  // Main-only network fixture: one actual public mutation reaches Service and commits,
  // but its HTTP response socket is lost before the Native SDK can decode it.
  await application.evaluate(`(() => {
    const original = globalThis.fetch;
    globalThis.__permissionOriginalFetch = original;
    globalThis.__permissionPosts = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/sessions/s/permission-mode')) return original(input, init);
      globalThis.__permissionPosts++;
      const body = Buffer.from(await request.arrayBuffer());
      const http = process.getBuiltinModule('node:http');
      return await new Promise((resolve, reject) => {
        const outgoing = http.request(request.url, {method:'POST',headers:Object.fromEntries(request.headers)}, response => {
          response.destroy(); outgoing.destroy(); reject(new TypeError('owned_fixture_response_lost'));
        });
        outgoing.on('error', reject); outgoing.end(body);
      });
    };
  })()`);
  await panel.getByRole('radio', { name: 'Full', exact: true }).check();
  await panel.getByRole('button', { name: '保存模式选择' }).press('Enter');
  await page.getByRole('button', { name: '查询原权限选择', exact: true }).waitFor();
  await openSessionTools(page);
  assert.equal(await application.evaluate('globalThis.__permissionPosts'), 1);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
  await openSessionTools(page);
  await page.getByRole('button', { name: '查询原权限选择', exact: true }).press('Enter');
  await page
    .getByRole('button', { name: '查询原权限选择', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await application.evaluate('globalThis.__permissionPosts'), 1);
  await panel
    .getByText('当前模式：accept_edits；默认模式：accept_edits', { exact: true })
    .waitFor();
  await application.evaluate('globalThis.fetch = globalThis.__permissionOriginalFetch');
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await panel.getByText('当前模式：full；默认模式：accept_edits', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await panel.getByText('当前模式：full；默认模式：accept_edits', { exact: true }).waitFor();
  assert.equal(await count(), 0);
  // A failed read cannot leave stale writable controls visible.
  await application.evaluate(`(() => {
    const original = globalThis.fetch;
    globalThis.__permissionReadFetch = original;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/permission-mode')) return Promise.reject(new TypeError('owned_fixture_read_lost'));
      return original(input, init);
    };
  })()`);
  await panel.getByRole('button', { name: '重新读取权限事实' }).press('Enter');
  await page.getByRole('button', { name: '重新核实权限事实' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存模式选择' }).count(), 0);
  await application.evaluate('globalThis.fetch = globalThis.__permissionReadFetch');
  await page.getByRole('button', { name: '重新核实权限事实' }).press('Enter');
  await panel.getByText('当前模式：full；默认模式：accept_edits', { exact: true }).waitFor();
  // A different actual user command commits after the original read and before
  // the original POST. Its stale CAS is rejected, with no silent retry.
  await application.evaluate(`(() => {
    const original = globalThis.fetch;
    globalThis.__permissionCasFetch = original;
    globalThis.__permissionCasPosts = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/sessions/s/permission-mode')) return original(input, init);
      globalThis.__permissionCasPosts++;
      const body = await request.clone().json();
      const competing = await original(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,commandId:'fixture-concurrent-mode',mode:'auto',makeDefault:false})});
      if (!competing.ok) throw new Error('fixture_competing_mutation_failed');
      return original(request);
    };
  })()`);
  await panel.getByRole('radio', { name: 'Ask', exact: true }).check();
  await panel.getByRole('button', { name: '保存模式选择' }).press('Enter');
  await page.getByText(/host_control_conflict/).waitFor();
  assert.equal(await application.evaluate('globalThis.__permissionCasPosts'), 1);
  await application.evaluate('globalThis.fetch = globalThis.__permissionCasFetch');
  await panel.getByRole('button', { name: '重新读取权限事实' }).press('Enter');
  await panel.getByText('当前模式：auto；默认模式：accept_edits', { exact: true }).waitFor();
  assert.equal(await count(), 0);
  const html = await page.content();
  assert.equal(html.includes(dataRoot!), false);
  assert.equal(html.includes(endpoint!), false);
  assert.ok(html.includes(storeId!));
  // The final closed public read verifies neither Session has any Run.
  const state = await page.evaluate(async () => {
    const attached = (await window.kiteNative!.request({ method: 'attach' })) as NativeState;
    const a = (await window.kiteNative!.request({
      method: 'select',
      generation: attached.generation,
      sessionId: 's',
    })) as NativeState;
    const b = (await window.kiteNative!.request({
      method: 'select',
      generation: attached.generation,
      sessionId: 'other',
    })) as NativeState;
    return [a.selection!.runs.length, b.selection!.runs.length];
  });
  assert.deepEqual(state, [0, 0]);
  const electronPid = await application.evaluate(() => process.pid);
  const line = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .split('\n')
    .find((line) => {
      const parts = line.trim().split(/\s+/);
      return Number(parts[1]) === electronPid && parts.slice(2).join(' ') === bunExecutable;
    });
  servicePid = Number(line?.trim().split(/\s+/)[0]);
  assert.ok(servicePid > 0);
  const exited = new Promise<void>((resolve) =>
    application.process().once('exit', () => resolve()),
  );
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  assert.throws(() => process.kill(servicePid, 0));
} catch (error) {
  console.error(
    (
      await (
        await application.firstWindow()
      )
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 2500),
  );
  application.process().kill('SIGKILL');
  throw error;
} finally {
  await application.close().catch(() => {});
}
