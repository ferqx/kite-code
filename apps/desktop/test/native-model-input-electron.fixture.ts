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
function expect(value: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(value, expected);
    },
    toBeGreaterThan(expected: number) {
      assert.ok(Number(value) > expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      for (const [key, child] of Object.entries(expected))
        assert.equal((value as Record<string, unknown>)[key], child);
    },
  };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_driver_timeout')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function count() {
  return Number(await (await fetch(`${control}/count`)).text());
}
async function waitForModel() {
  await bounded(fetch(`${control}/entered`));
}
const application = await _electron.launch({
  timeout: 10000,
  executablePath: electronExecutable,
  args: [outdir, `--user-data-dir=${join(root, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
});
let servicePid: number | undefined;
const diagnostics: string[] = [];
application.process().stderr?.on('data', (chunk) => diagnostics.push(String(chunk).slice(0, 1000)));
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('console', (message) => console.error('renderer', message.text().slice(0, 300)));
  page.on('pageerror', (error) => console.error('renderer_error', error.message.slice(0, 300)));
  await page.getByRole('button', { name: 'Native A', exact: true }).waitFor();
  await openSessionTools(page);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  await page.evaluate(async () => {
    const first = (await window.kiteNative!.request({ method: 'attach' })) as NativeState;
    return (await window.kiteNative!.request({
      method: 'select',
      generation: first.generation,
      sessionId: 's',
    })) as NativeState;
  });
  // Reattach is a real main/preload operation. Reload restores the renderer's own generation.
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).waitFor();
  await openSessionTools(page);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  const generation = await page.evaluate(
    async () =>
      ((await window.kiteNative!.request({ method: 'attach' })) as NativeState).generation,
  );
  const selected = await page.evaluate(
    async (generation) =>
      (await window.kiteNative!.request({
        method: 'select',
        generation,
        sessionId: 's',
      })) as NativeState,
    generation,
  );
  expect(selected.selection!.storeId).toBe(storeId);
  const mode = selected.selection!.permissions!;
  await page.evaluate(
    async ({ generation, mode }) =>
      await window.kiteNative!.request({
        method: 'permission.mode',
        generation,
        observationId: mode.observationId,
        mode: 'full',
        makeDefault: false,
      }),
    { generation, mode },
  );
  const refreshed = await page.evaluate(
    async (generation) =>
      (await window.kiteNative!.request({
        method: 'permission.refresh',
        generation,
      })) as NativeState,
    generation,
  );
  await page.evaluate(
    async ({ generation, observationId }) =>
      await window.kiteNative!.request({
        method: 'permission.trust',
        generation,
        observationId,
        trusted: true,
      }),
    { generation, observationId: refreshed.selection!.permissions!.observationId },
  );
  await page.evaluate(
    async (generation) =>
      await window.kiteNative!.request({
        method: 'draft.write',
        generation,
        sessionId: 's',
        revision: 0,
        content: 'PRIVATE NATIVE DRAFT',
      }),
    generation,
  );
  const start = await page.evaluate(
    async ({ generation, storeId }) =>
      await window.kiteNative!.request({
        method: 'submit',
        generation,
        sessionId: 's',
        intent: {
          kind: 'run.start',
          expectedStoreId: storeId,
          commandId: 'native-original',
          content: 'harmless local model',
        },
      }),
    { generation, storeId },
  );
  expect(start).toMatchObject({ sessionId: 's' });
  await waitForModel();
  expect(await count()).toBe(1);
  const large = await page.evaluate(async (generation) => {
    try {
      await window.kiteNative!.request({
        method: 'draft.write',
        generation,
        sessionId: 's',
        revision: 1,
        content: 'x'.repeat(1048576),
      });
      return 'success';
    } catch (error) {
      return (
        (error as { code?: string; message?: string }).code ??
        (error as { message?: string }).message
      );
    }
  }, generation);
  expect(large).toBe('native_request_too_large');
  expect(await count()).toBe(1);
  const electronPid = await application.evaluate(() => process.pid);
  const ps = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']));
  const line = ps.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    return Number(parts[1]) === electronPid && parts.slice(2).join(' ') === bunExecutable;
  });
  servicePid = line ? Number(line.trim().split(/\s+/)[0]) : 0;
  expect(servicePid).toBeGreaterThan(0);
  process.kill(servicePid, 0);
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).waitFor();
  await openSessionTools(page);
  expect(await count()).toBe(1);
  process.kill(servicePid, 0);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  expect(await page.getByRole('textbox', { name: '当前会话私有草稿' }).inputValue()).toBe(
    'PRIVATE NATIVE DRAFT',
  );
  // A second real BrowserWindow with the same preload/document is still not the admitted sender.
  const foreignId = await application.evaluate(({ BrowserWindow }, outdir) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: `${outdir}/preload.cjs`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void window.loadFile(`${outdir}/index.html`);
    return window.id;
  }, outdir);
  // Verify the foreign authority directly through its actual renderer JS context after load.
  const denied = await application.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)!;
    await new Promise<void>((resolve) =>
      window.webContents.isLoading()
        ? window.webContents.once('did-finish-load', () => resolve())
        : resolve(),
    );
    const result = await window.webContents.executeJavaScript(
      "window.kiteNative.request({method:'attach'}).then(()=> 'success',e=>e.code||e.message)",
    );
    window.destroy();
    return result;
  }, foreignId);
  expect(denied).toBe('native_sender_denied');
  expect(await count()).toBe(1);
  await fetch(`${control}/release`);
  await page
    .getByText('NATIVE STREAM START NATIVE STREAM END', { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  const lookup = await page.getByRole('button', { name: '查询原命令', exact: true }).first();
  await lookup.click();
  await page.getByText(/原命令 native-original：terminal/).waitFor();
  expect(await count()).toBe(1);
  // A read counter belongs only to this main's real public HTTP client.
  await application.evaluate(`(() => {
    const original=globalThis.fetch;globalThis.__inputReads=0;
    globalThis.fetch=(input,init)=>{const request=new Request(input,init);if(new URL(request.url).pathname.endsWith('/model-input'))globalThis.__inputReads++;return original(input,init);};
  })()`);
  const logs = page.getByRole('region', { name: 'Runtime logs' });
  const log = logs.locator('details').first();
  await log.locator('summary').click();
  await log.getByRole('button', { name: /检查原 Model 输入/ }).press('Enter');
  await page.getByRole('button', { name: 'Confirm read original input', exact: true }).waitFor();
  await openSessionTools(page);
  assert.equal(await application.evaluate('globalThis.__inputReads'), 0);
  await page
    .getByRole('button', { name: 'Confirm read original input', exact: true })
    .press('Enter');
  const inspector = page.getByRole('region', { name: 'Model calls' });
  await inspector.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  assert.ok((await inspector.innerText()).includes('harmless local model'));
  assert.ok((await inspector.innerText()).includes('Adapter kite.sdk / 1'));
  assert.ok((await inspector.innerText()).includes('Provider openai-compatible / local'));
  assert.ok((await inspector.innerText()).includes('Final dispatch authorization'));
  assert.ok((await inspector.innerText()).includes('native-original'));
  assert.equal(await application.evaluate('globalThis.__inputReads'), 1);
  assert.equal(await count(), 1);
  await inspector
    .getByRole('button', { name: 'Close Model inspector', exact: true })
    .press('Enter');
  assert.equal(await inspector.getByRole('heading', { name: 'Overview', exact: true }).count(), 0);
  // Clicking the same original log after closing opens a fresh confirmation only.
  await log.getByRole('button', { name: /检查原 Model 输入/ }).press('Enter');
  await inspector
    .getByRole('button', { name: 'Confirm read original input', exact: true })
    .waitFor();
  assert.equal(await application.evaluate('globalThis.__inputReads'), 1);
  await application.evaluate(`(() => {
    const original=globalThis.fetch;
    globalThis.__inputEntered=new Promise(resolve=>globalThis.__inputEnter=resolve);
    const gate=new Promise(resolve=>globalThis.__inputRelease=resolve);
    globalThis.fetch=async(input,init)=>{const request=new Request(input,init);const response=await original(input,init);if(new URL(request.url).pathname.endsWith('/model-input')){globalThis.__inputEnter();await gate;}return response;};
  })()`);
  await inspector
    .getByRole('button', { name: 'Confirm read original input', exact: true })
    .press('Enter');
  await application.evaluate('globalThis.__inputEntered');
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
  await openSessionTools(page);
  await application.evaluate('globalThis.__inputRelease()');
  assert.equal(await application.evaluate('globalThis.__inputReads'), 2);
  assert.equal(await page.getByRole('heading', { name: 'Overview', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Model calls', exact: true }).press('Enter');
  await page.getByText('No recorded Model calls', { exact: true }).waitFor();
  assert.equal(await count(), 1);
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Overview', exact: true }).count(), 0);
  assert.equal(await count(), 1);
  const html = await page.content();
  expect(html.includes(dataRoot)).toBe(false);
  expect(html.includes(endpoint)).toBe(false);
  const exited = new Promise<void>((resolve) =>
    application.process().once('exit', () => resolve()),
  );
  await application
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => {});
  await bounded(exited);
  let stopped = false;
  try {
    process.kill(servicePid, 0);
  } catch {
    stopped = true;
  }
  expect(stopped).toBe(true);
} catch (error) {
  console.error(
    'native_attach',
    await (await application.firstWindow()).evaluate(async () => {
      try {
        return await window.kiteNative!.request({ method: 'attach' });
      } catch (error) {
        return String(error);
      }
    }),
  );
  console.error(
    'native_page',
    (
      await (
        await application.firstWindow()
      )
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 1500),
  );
  application.process().kill('SIGKILL');
  console.error(diagnostics.join('\n').slice(0, 4000));
  throw error;
} finally {
  await fetch(`${control}/release`);
  await application.close().catch(() => {});
}
