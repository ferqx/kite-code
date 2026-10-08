import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';

const [candidate, home, control, database] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
const locks = async () => await (await fetch(`${control}/locks`)).json();
try {
  const original = readFileSync(database),
    originalCount = await (await fetch(`${control}/count`)).text(),
    reportPath = join(home, 'startup-report.json'),
    existing = join(home, 'existing.json');
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const save = page.getByRole('button', { name: '保存诊断', exact: true });
  await save.waitFor();
  assert.equal(await page.locator('.shell').count(), 0);
  assert.match(await page.getByRole('alert').innerText(), /required_capability_missing/);
  assert.deepEqual(readFileSync(database), original);
  assert.deepEqual(await locks(), { outer: false, inner: false });
  await app.evaluate(
    ({ dialog }, { existing, reportPath }) => {
      const destinations = [null, existing, reportPath];
      Reflect.set(globalThis, 'ownedSaveSelections', []);
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        (Reflect.get(globalThis, 'ownedSaveSelections') as unknown[]).push(args.at(-1));
        const path = destinations.shift();
        return { canceled: path === null, filePath: path ?? '' };
      }) as typeof dialog.showSaveDialog;
    },
    { existing, reportPath },
  );
  // Only the native dialog selection callback is controlled. Production Main,
  // Service, preload, renderer and writeFile flags are the unchanged candidate.
  await save.click();
  await page.waitForFunction(async () => {
    const status = await window.kiteNative!.startupStatus!();
    return status.diagnosticAvailable;
  });
  assert.equal(existsSync(reportPath), false);
  await save.click();
  await page.getByRole('alert').filter({ hasText: '保存启动诊断失败' }).waitFor();
  assert.equal(readFileSync(existing, 'utf8'), 'existing file must not be overwritten');
  await save.click();
  await page.waitForFunction(() => !document.body.textContent!.includes('保存启动诊断失败'));
  const savedBy = Date.now() + 10000;
  while (!existsSync(reportPath) || !readFileSync(reportPath, 'utf8').endsWith('\n')) {
    assert.ok(Date.now() < savedBy, 'the selected diagnostic report was not saved');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const report = readFileSync(reportPath, 'utf8');
  assert.deepEqual(JSON.parse(report), {
    schema: 'kite.startup-diagnostic.v1',
    code: 'data_unavailable',
    stage: 'opening_store',
    actualSchema: null,
    expectedSchema: null,
    retryable: true,
    actions: [
      'verify_profile_storage_access',
      'retry_after_resolving_condition',
      'save_diagnostic',
    ],
  });
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  for (const privateValue of [
    home,
    database,
    'private-corrupt-database',
    'credential',
    'session-content',
  ])
    assert.equal(report.includes(privateValue), false);
  assert.deepEqual(readFileSync(database), original);
  const prompts = await app.evaluate(() => Reflect.get(globalThis, 'ownedSaveSelections'));
  assert.deepEqual(
    prompts,
    Array.from({ length: 3 }, () => ({
      title: '保存启动诊断',
      defaultPath: 'kite-startup-diagnostic.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })),
  );
  console.log(
    'native_startup_diagnostic_stage: real Store failure, retained save UI, cancel, no overwrite, closed private report',
  );

  // External repair is a test action; the desktop must preserve the original
  // failed database. Its explicit retry creates a new launch and observation.
  renameSync(database, `${database}.original`);
  await page.getByRole('button', { name: '重新尝试', exact: true }).click();
  await page.locator('.session-header').waitFor();
  assert.equal(await page.locator('main[aria-label="kite 启动页"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.kiteNative!.startupStatus!()), {
    diagnosticAvailable: false,
  });
  assert.deepEqual(readFileSync(`${database}.original`), original);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  assert.equal(await (await fetch(`${control}/count`)).text(), originalCount);
  await app.close();
  app = undefined;
  assert.deepEqual(await locks(), { outer: false, inner: false });
  assert.equal(await (await fetch(`${control}/count`)).text(), originalCount);
  console.log(
    'native_startup_diagnostic_stage: same-window explicit retry after external repair, zero Model, normal owned close',
  );
} finally {
  await app?.close().catch(() => {});
}
