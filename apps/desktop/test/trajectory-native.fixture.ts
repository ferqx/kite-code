import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [fixturePath, packagePath] = process.argv.slice(2) as [string, string];
const { _electron } = createRequire(packagePath)('playwright') as typeof import('playwright');
const electron = createRequire(packagePath)('electron') as string;
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  directory: string;
  outdir: string;
  profile: { dataRoot: string };
  bundle: string;
};
const app = await _electron.launch({
  executablePath: electron,
  args: [
    fixture.outdir,
    fixture.bundle,
    `--user-data-dir=${join(fixture.directory, 'electron-data')}`,
  ],
  cwd: fixture.outdir,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  timeout: 20000,
});
const errors: string[] = [],
  requests: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  page.setDefaultTimeout(12000);
  await page.waitForFunction(() => !!document.querySelector('.trajectory-event'));
  await page.screenshot({ path: join(fixture.directory, 'cold-open.png') });
  assert.equal(
    existsSync(fixture.profile.dataRoot),
    false,
    'cold viewer must not create a Runtime profile',
  );
  const bridge = await page.evaluate(() => ({
    keys: Object.keys(window.kiteNative ?? {}),
    url: location.href,
  }));
  assert.deepEqual(bridge.keys, ['trajectoryFiles']);
  assert.match(bridge.url, /trajectory\.html$/);
  const buttons = await page.getByRole('button').allTextContents();
  writeFileSync(
    join(fixture.directory, 'cold-initial.json'),
    JSON.stringify({ bridge, buttons, errors, requests }, null, 2),
  );
  await page.locator('.trajectory-event > button').first().click();
  await page.screenshot({ path: join(fixture.directory, 'cold-expanded.png') });
  await page
    .getByRole('button', { name: /模型输出/ })
    .first()
    .click();
  await page.getByText('COLD ORIGINAL MATERIAL 雪', { exact: false }).waitFor();
  await page.screenshot({ path: join(fixture.directory, 'cold-evidence.png') });
  await page.getByRole('button', { name: '轨迹上一步', exact: true }).click();
  await page.waitForFunction(
    () =>
      (document.querySelector('.trajectory-position input') as HTMLInputElement | null)?.value ===
      '0',
  );
  assert.equal(await page.getByRole('region', { name: '轨迹证据' }).count(), 0);
  await page.screenshot({ path: join(fixture.directory, 'cold-step-back.png') });
  await page.getByRole('button', { name: '播放轨迹', exact: true }).click();
  await page.waitForFunction(
    () =>
      (document.querySelector('.trajectory-position input') as HTMLInputElement | null)?.value ===
      '9007199254740993',
  );
  await page.screenshot({ path: join(fixture.directory, 'cold-played.png') });
  assert.equal(existsSync(fixture.profile.dataRoot), false);
  assert.deepEqual(errors, []);
  assert.equal(
    requests.some((url) => /^https?:|^wss?:/.test(url)),
    false,
  );
  const facts = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
  }));
  writeFileSync(
    join(fixture.directory, 'cold-final.json'),
    JSON.stringify(
      { bridge, facts, errors, requests, profileCreated: existsSync(fixture.profile.dataRoot) },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ...facts,
      directory: resolve(fixture.directory),
      profileCreated: false,
      errors,
    }),
  );
} catch (error) {
  const page = app.windows()[0];
  if (page) {
    await page.screenshot({ path: join(fixture.directory, 'cold-failure.png') });
    writeFileSync(
      join(fixture.directory, 'cold-failure.json'),
      JSON.stringify(
        {
          errors,
          requests,
          buttons: await page.getByRole('button').allTextContents(),
          text: (await page.locator('body').innerText()).slice(0, 1500),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await app.close();
}
