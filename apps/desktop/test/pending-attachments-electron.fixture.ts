import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';
import { selectNativeFixtureModel } from './native-model-selection.fixture';
import { nativeRootPage } from './native-root-page.fixture';

const [outdir, root, electronExecutable, control, bunExecutable, databasePath, evidence] =
  process.argv.slice(2) as string[];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQ6zlBEmIY1TCqYfhqAAAKOnIQcJ63FQAAAABJRU5ErkJggg==',
  'base64',
);
const processes: { main: number; service: number; stopped?: boolean }[] = [];
const stages: unknown[] = [];
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let page!: import('playwright').Page;
function servicePid(app: Awaited<ReturnType<typeof _electron.launch>>) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const row = rows.find((line) => {
    const fields = line.trim().split(/\s+/);
    return Number(fields[1]) === app.process().pid && fields.slice(2).join(' ') === bunExecutable;
  });
  assert.ok(row, 'isolated owned Service must exist');
  return Number(row.trim().split(/\s+/)[0]);
}
async function openSession(name = 'Attachments A') {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('[aria-label="当前会话私有草稿"]');
    return input instanceof HTMLTextAreaElement
      ? !input.disabled && !input.readOnly
      : input?.getAttribute('contenteditable') === 'true';
  });
}
async function launch() {
  application = await _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  page = await nativeRootPage(application, 20000);
  page.setDefaultTimeout(15000);
  await application.evaluate(({ ipcMain }) => {
    type Payload = { method?: string; generation?: number };
    type Reply = { ok: boolean; code?: string };
    type Handler = (event: unknown, payload: Payload) => Promise<Reply>;
    const host = globalThis as typeof globalThis & {
      __attachmentTrace: { request: Payload; result: Reply }[];
      __attachmentGeneration?: number;
      __attachmentTransfers: number;
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const handler = handlers.get('kite:native:request')!;
    host.__attachmentTrace = [];
    host.__attachmentTransfers = 0;
    handlers.set('kite:native:request', async (event, payload) => {
      if (
        /^input\.(images|files)\.(begin|append|finish)$/.test(payload.method ?? '') ||
        payload.method === 'input.attachments.write'
      )
        host.__attachmentTransfers++;
      if (payload.method === 'submit')
        host.__attachmentTrace.push({
          request: payload,
          result: { ok: true, code: 'fixture_submit_entered' },
        });
      const result = await handler(event, payload);
      if (result.ok && Number.isSafeInteger(payload.generation))
        host.__attachmentGeneration = payload.generation;
      if (
        (payload.method === 'submit' || String(payload.method).startsWith('input.')) &&
        (payload.method === 'submit' || payload.method === 'input.attachments.write' || !result.ok)
      )
        host.__attachmentTrace.push({ request: payload, result });
      return result;
    });
  });
  await page.evaluate(() => {
    const target = window as unknown as { attachmentFrames: unknown[] };
    target.attachmentFrames = [];
    let previous = '';
    const sample = () => {
      const input = document.querySelector(
        '[aria-label="当前会话私有草稿"]',
      ) as HTMLTextAreaElement | null;
      const current = {
        text: input?.value,
        images: document.querySelectorAll(
          '.composer-attachments[aria-label="待发送附件"] [aria-label^="移除图片 "]',
        ).length,
        files: document.querySelectorAll(
          '.composer-attachments[aria-label="待发送附件"] [aria-label^="移除附件 "]',
        ).length,
        imageReady: [
          ...document.querySelectorAll<HTMLImageElement>(
            '.composer-attachments[aria-label="待发送附件"] img',
          ),
        ].filter((item) => item.complete && item.naturalWidth > 0).length,
        errors: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
      };
      const signature = JSON.stringify(current);
      if (signature !== previous && target.attachmentFrames.length < 256) {
        target.attachmentFrames.push({ time: performance.now(), ...current });
        previous = signature;
      }
    };
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener('input', sample);
    document.addEventListener('load', sample, true);
    sample();
  });
  await openSession();
  const process = { main: application.process().pid!, service: servicePid(application) };
  assert.ok(
    !processes.some((prior) => prior.main === process.main || prior.service === process.service),
  );
  processes.push(process);
}
async function quit() {
  const app = application!;
  const exit = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app }) => app.quit());
  await exit;
  const last = processes.at(-1)!;
  assert.throws(() => process.kill(last.main, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(last.service, 0), { code: 'ESRCH' });
  last.stopped = true;
  application = undefined;
}
async function persisted() {
  const generation = (await application!.evaluate('globalThis.__attachmentGeneration')) as number;
  assert.ok(Number.isSafeInteger(generation));
  return await page.evaluate(async (generation) => {
    const bridge = window.kiteNative!;
    return (await bridge.request({
      method: 'input.attachments.read',
      generation,
      sessionId: 's',
    })) as {
      revision: number;
      attachments: { id: string; name: string; state: string; kind: string; error?: string }[];
    };
  }, generation);
}
async function awaitSaved(count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await persisted();
    if (result.attachments.length === count) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`attachment_count_not_saved:${count}`);
}
async function count() {
  return Number(await (await fetch(`${control}/count`)).text());
}
async function sample(label: string) {
  stages.push({
    label,
    provider: await count(),
    saved: await persisted(),
    ui: await page.locator('.composer-attachments[aria-label="待发送附件"]').allTextContents(),
    processes: structuredClone(processes),
    frames: await page.evaluate(
      () => (window as unknown as { attachmentFrames: unknown[] }).attachmentFrames,
    ),
  });
  await page.screenshot({ path: join(evidence!, `${label}.png`) });
  writeFileSync(join(evidence!, 'stages.json'), JSON.stringify(stages, null, 2));
}
async function attachFiles() {
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '添加文件', exact: true }).click();
  // Memory-backed chooser payloads deliberately exercise the no-local-path copy branch,
  // not the distinct local path-reference contract. Production hook and Main IPC are real.
  await (await chooser).setFiles([
    { name: 'restart.png', mimeType: 'image/png', buffer: png },
    {
      name: 'restart.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE ATTACHMENT BYTES\n'),
    },
  ]);
  await page.getByRole('button', { name: '移除附件 restart.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: '移除图片 restart.png', exact: true }).waitFor();
  const result = await awaitSaved(2);
  assert.deepEqual(result.attachments.map((entry) => entry.kind).sort(), ['file', 'image']);
  assert.ok(
    result.attachments.every((entry) => entry.state === 'ready'),
    JSON.stringify(result),
  );
  await page.waitForFunction(() => {
    const image = document.querySelector(
      '.composer-attachments[aria-label="待发送附件"] img',
    ) as HTMLImageElement | null;
    return image?.complete && image.naturalWidth > 0;
  });
  return result;
}
async function rejectedBatch(mode: 'picker' | 'drop' | 'paste', oversized: 'image' | 'file') {
  const before = await persisted();
  const input = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
  const text = await input.inputValue();
  const transfers = await application!.evaluate('globalThis.__attachmentTransfers');
  if (mode === 'picker') {
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: '添加文件', exact: true }).click();
    await chooser;
  }
  await page.evaluate(
    ({ mode, oversized }) => {
      const good = new File(['good'], 'valid-batch.txt', { type: 'text/plain' });
      const invalid = new File(
        ['tiny fixture body'],
        oversized === 'image' ? 'oversized.png' : 'oversized.txt',
        { type: oversized === 'image' ? 'image/png' : 'text/plain' },
      );
      // Renderer admission test: metadata alone rejects before any byte read/IPC. No huge allocation.
      Object.defineProperty(invalid, 'size', {
        value: (oversized === 'image' ? 16 : 256) * 1024 * 1024 + 1,
      });
      const files = [good, invalid];
      if (mode === 'picker') {
        const chooser = document.querySelector<HTMLInputElement>(
          'input[type="file"][aria-label="选择文件"]',
        )!;
        Object.defineProperty(chooser, 'files', { configurable: true, value: files });
        chooser.dispatchEvent(new Event('change', { bubbles: true }));
        Reflect.deleteProperty(chooser, 'files');
      } else {
        const transfer = new DataTransfer();
        Object.defineProperty(transfer, 'files', { value: files });
        const event =
          mode === 'drop'
            ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
            : new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: transfer,
              });
        document.querySelector('[aria-label="当前会话私有草稿"]')!.dispatchEvent(event);
      }
    },
    { mode, oversized },
  );
  const message =
    oversized === 'image'
      ? '图片为空或超过 16 MiB，请缩小后重试。'
      : '文件超过 256 MiB，请缩小后重试。';
  const dialog = page.getByRole('alertdialog', { name: '无法添加附件', exact: true });
  await dialog.waitFor();
  await dialog.getByText(message, { exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole('button', { name: '知道了', exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  assert.equal(await page.locator('.native-toast-card').count(), 0);
  await sample(`limit-${mode}-${oversized}-dialog`);
  if (mode === 'drop') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: '知道了', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(await persisted(), before);
  assert.equal(await input.inputValue(), text);
  assert.equal(await application!.evaluate('globalThis.__attachmentTransfers'), transfers);
  assert.equal(await page.locator('.composer-input-error').count(), 0);
  assert.equal(await count(), 0);
  await sample(`limit-${mode}-${oversized}`);
}

try {
  await launch();
  await selectNativeFixtureModel(page, 'local');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('Persist these attachments, do not send yet.');
  const original = await attachFiles();
  await sample('01-added');
  await rejectedBatch('picker', 'image');
  await rejectedBatch('drop', 'file');
  await rejectedBatch('paste', 'image');
  assert.equal(await count(), 0);
  await quit();
  await launch();
  await page.getByRole('button', { name: '移除附件 restart.txt', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector(
      '.composer-attachments[aria-label="待发送附件"] img',
    ) as HTMLImageElement | null;
    return image?.complete && image.naturalWidth > 0;
  });
  assert.deepEqual((await persisted()).attachments, original.attachments);
  assert.equal(await count(), 0);
  await sample('02-cold-restored');
  await openSession('Attachments B');
  assert.equal(await page.locator('.composer-attachments[aria-label="待发送附件"]').count(), 0);
  await openSession();
  await page.getByRole('button', { name: '移除图片 restart.png', exact: true }).waitFor();
  assert.equal(await count(), 0);
  await sample('03-returned');
  await selectNativeFixtureModel(page, 'local');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('Explicitly submit these restored attachments now.');
  // An ordinary file deliberately obstructs this disposable workspace's derived import directory.
  // This exercises real Main -> Service -> native Files preparation failure, not a renderer mock.
  const obstruction = join(root!, 'workspace', '.kite-inputs');
  const retained = await persisted();
  writeFileSync(obstruction, 'isolated input preparation obstruction', { flag: 'wx', mode: 0o600 });
  try {
    await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
    await page.locator('.native-toast-card').filter({ hasText: '发送失败' }).waitFor();
    assert.equal(await page.locator('.message.user').count(), 0);
    assert.equal(
      await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).inputValue(),
      'Explicitly submit these restored attachments now.',
    );
    assert.deepEqual(await persisted(), retained);
    assert.equal(await count(), 0);
    const trace = (await application!.evaluate('globalThis.__attachmentTrace')) as {
      request: { method: string };
      result: { ok: boolean; code?: string; value?: { phase?: string; error?: string } };
    }[];
    const result = [...trace]
      .reverse()
      .find(
        (entry) =>
          entry.request.method === 'submit' && entry.result.code !== 'fixture_submit_entered',
      )!.result;
    assert.equal(result.ok, true);
    assert.equal(result.value?.phase, 'failed');
    writeFileSync(join(evidence!, 'predispatch-result.json'), JSON.stringify(result, null, 2));
    await sample('04-pre-dispatch-failed');
  } finally {
    unlinkSync(obstruction);
  }
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  const confirm = page.getByRole('button', { name: '确定', exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await page.getByText('ATTACHMENT RECEIVED', { exact: true }).waitFor();
  assert.equal(await page.locator('.message.user').count(), 1);
  const consumed = await awaitSaved(0);
  assert.ok(consumed.revision > original.revision);
  assert.equal(await count(), 1);
  await sample('04-explicitly-accepted');
  await quit();
  await launch();
  assert.equal((await persisted()).attachments.length, 0);
  assert.equal(await page.locator('.composer-attachments[aria-label="待发送附件"]').count(), 0);
  assert.equal(await count(), 1);
  await sample('05-consumed-after-restart');
  await attachFiles();
  await page.getByRole('button', { name: '移除附件 restart.txt', exact: true }).click();
  await page.getByRole('button', { name: '移除图片 restart.png', exact: true }).click();
  await awaitSaved(0);
  await quit();
  await launch();
  assert.equal((await persisted()).attachments.length, 0);
  assert.equal(await page.locator('.composer-attachments[aria-label="待发送附件"]').count(), 0);
  await sample('06-removed-after-restart');
  const beforeCorruption = await attachFiles();
  const imageId = beforeCorruption.attachments.find((entry) => entry.kind === 'image')!.id;
  await quit();
  // Only mutate this fixture's closed private database, never a user's profile.
  const db = new DatabaseSync(databasePath!);
  const change = db
    .prepare('UPDATE pending_attachment_chunks SET bytes=? WHERE attachment_id=? AND offset=0')
    .run(Buffer.from('CORRUPTED'), imageId);
  assert.equal(change.changes, 1);
  db.close();
  await launch();
  await page.getByText('附件已失效，请移除后重新添加。', { exact: true }).waitFor();
  await selectNativeFixtureModel(page, 'local');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('Do not submit the damaged attachment.');
  assert.equal(
    (await persisted()).attachments.find((entry) => entry.id === imageId)!.state,
    'error',
  );
  assert.equal(
    (await persisted()).attachments.find((entry) => entry.kind === 'file')!.state,
    'ready',
  );
  assert.equal(
    await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await count(), 1);
  await sample('07-corrupt-image-visible');
  await page.getByRole('button', { name: '移除图片 restart.png', exact: true }).click();
  await awaitSaved(1);
  await sample('08-corrupt-image-removed');
  await quit();
  console.log('pending attachments: cold restart, consume, removal, corruption verified');
  console.log(JSON.stringify(processes));
} catch (error) {
  if (application && page!) {
    writeFileSync(
      join(evidence!, 'failure-state.json'),
      JSON.stringify(
        await page
          .evaluate(
            async (generation) => window.kiteNative!.request({ method: 'state', generation }),
            (await application.evaluate('globalThis.__attachmentGeneration')) as number,
          )
          .catch(String),
        null,
        2,
      ),
    );
    writeFileSync(
      join(evidence!, 'failure-saved.json'),
      JSON.stringify(await persisted().catch(String), null, 2),
    );
    writeFileSync(
      join(evidence!, 'failure-ipc.json'),
      JSON.stringify(await application.evaluate('globalThis.__attachmentTrace'), null, 2),
    );
    await page.screenshot({ path: join(evidence!, 'failure.png') }).catch(() => {});
    writeFileSync(
      join(evidence!, 'failure.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => 'unavailable'),
    );
  }
  throw error;
} finally {
  if (application) await application.close();
  writeFileSync(join(evidence!, 'processes.json'), JSON.stringify(processes, null, 2));
}
