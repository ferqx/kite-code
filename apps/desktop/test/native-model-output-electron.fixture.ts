import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

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
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
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
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
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
  expect(await count()).toBe(1);
  process.kill(servicePid, 0);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
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
      "window.kiteNative.request({method:'modelOutput.open',generation:1,readId:'foreign',expectedStoreId:'foreign',sessionId:'s',executionId:'foreign'}).then(()=> 'success',e=>e.code||e.message)",
    );
    window.destroy();
    return result;
  }, foreignId);
  expect(denied).toBe('native_sender_denied');
  expect(await count()).toBe(1);
  await fetch(`${control}/release`);
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  // Full body stays absent until an explicit user read. The current view keeps only a preview.
  expect(await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).count()).toBe(0);
  const fullButton = page.getByRole('button', {
    name: 'Read complete recorded Model output',
    exact: true,
  });
  await fullButton.waitFor();
  await fullButton.focus();
  await page.keyboard.press('Enter');
  await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).waitFor({ timeout: 30000 });
  expect(await count()).toBe(1);
  process.kill(servicePid, 0);
  await page.getByRole('button', { name: 'Close full Model output', exact: true }).click();
  expect(await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).count()).toBe(0);
  // Exercise the actual closed IPC parser and exact sequential offsets, then release this read.
  const protocol = await page.evaluate(async (storeId) => {
    const generation = ((await window.kiteNative!.request({ method: 'attach' })) as NativeState)
      .generation;
    const state = (await window.kiteNative!.request({
      method: 'select',
      generation,
      sessionId: 's',
    })) as NativeState;
    const executionId = state.selection!.executions.find(
      (execution) => execution.kind === 'model',
    )!.id;
    const readId = 'probe-read';
    const opened = (await window.kiteNative!.request({
      method: 'modelOutput.open',
      generation,
      readId,
      expectedStoreId: storeId,
      sessionId: 's',
      executionId,
    })) as { wireBytes: string };
    const first = (await window.kiteNative!.request({
      method: 'modelOutput.read',
      generation,
      readId,
      offset: 0,
      limit: 65536,
    })) as { nextOffset: number };
    let bad = 'success';
    try {
      await window.kiteNative!.request({
        method: 'modelOutput.read',
        generation,
        readId,
        offset: 0,
        limit: 1,
      });
    } catch (error) {
      bad = (error as Error).message;
    }
    await window.kiteNative!.request({ method: 'modelOutput.close', generation, readId });
    let closed = 'success';
    try {
      await window.kiteNative!.request({
        method: 'modelOutput.read',
        generation,
        readId,
        offset: first.nextOffset,
        limit: 1,
      });
    } catch (error) {
      closed = (error as Error).message;
    }
    const late = 'late-read';
    await window.kiteNative!.request({
      method: 'modelOutput.open',
      generation,
      readId: late,
      expectedStoreId: storeId,
      sessionId: 's',
      executionId,
    });
    await window.kiteNative!.request({ method: 'detach', generation });
    let stale = 'success';
    try {
      await window.kiteNative!.request({
        method: 'modelOutput.read',
        generation,
        readId: late,
        offset: 0,
        limit: 1,
      });
    } catch (error) {
      stale = (error as Error).message;
    }
    return { wireBytes: opened.wireBytes, bad, closed, stale };
  }, storeId);
  expect(Number(protocol.wireBytes)).toBeGreaterThan(17 * 1048576);
  expect(protocol.bad).toBe('model_output_offset_invalid');
  expect(protocol.closed).toBe('model_output_read_missing');
  expect(protocol.stale).toBe('native_generation_changed');
  expect(await count()).toBe(1);
  process.kill(servicePid, 0);
  await page.reload();
  await page.getByRole('button', { name: 'Native A', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  expect(await page.getByText('MODEL OUTPUT COMPLETE TAIL', { exact: true }).count()).toBe(0);
  await page
    .getByRole('button', { name: 'Read complete recorded Model output', exact: true })
    .waitFor();
  expect(await count()).toBe(1);
  process.kill(servicePid, 0);
  const lookup = await page.getByRole('button', { name: '查询原命令', exact: true }).first();
  await lookup.click();
  await page.getByText(/原命令 native-original：terminal/).waitFor();
  expect(await count()).toBe(1);
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
