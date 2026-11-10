import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Reuses the physically exported metadata-only package; no online Caller or Service is created.
const [fixturePath, packagePath] = process.argv.slice(2) as [string, string];
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  directory: string;
  outdir: string;
  bundle: string;
  profile: { dataRoot: string };
};
const require = createRequire(packagePath),
  { _electron } = require('playwright') as typeof import('playwright');
const hash = () => createHash('sha256').update(readFileSync(fixture.bundle)).digest('hex');
const beforeHash = hash(),
  errors: string[] = [],
  network: string[] = [],
  stages: unknown[] = [];
const app = await _electron.launch({
  executablePath: require('electron') as string,
  args: [fixture.outdir, fixture.bundle, `--user-data-dir=${join(fixture.directory, 'electron')}`],
  cwd: fixture.outdir,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  timeout: 20000,
});
const owner = app.process();
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:|^wss?:/.test(request.url())) network.push(request.url());
  });
  async function capture(name: string) {
    const dom = await page.evaluate(() => ({
      cursor: document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value,
      eventIds: [...document.querySelectorAll<HTMLElement>('[data-trajectory-event]')].map(
        (node) => node.dataset.trajectoryEvent,
      ),
      text: document.body.innerText.slice(-5000),
    }));
    stages.push({ name, dom });
    await page.screenshot({ path: join(fixture.directory, `${name}.png`) });
    writeFileSync(join(fixture.directory, `${name}.json`), JSON.stringify(dom, null, 2));
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-trajectory-event]').length > 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.kiteNative ?? {})), [
    'trajectoryFiles',
  ]);
  await page.getByRole('tab', { name: '全部事件', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-trajectory-event]').length === 28,
  );
  await capture('01-cold-facts');
  await page.getByRole('textbox', { name: '轨迹位置', exact: true }).fill('23');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-trajectory-event]').length === 21,
  );
  const row = page.locator('[data-trajectory-event]').last();
  assert.match(await row.innerText(), /#23/);
  await row.locator('button.trajectory-event-heading').click();
  await capture('02-saved-prefix');
  await row.getByRole('button', { name: /模型输出/ }).click();
  const evidence = page.getByRole('region', { name: '轨迹证据', exact: true });
  await evidence.getByText('此包未包含该材料。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', { name: '重试读取', exact: true }).count(), 0);
  assert.equal(await page.getByText('trajectory_evidence_missing', { exact: false }).count(), 0);
  assert.equal(await page.locator('[data-trajectory-event]').count(), 21);
  await capture('03-material-not-included');
  await page.getByRole('button', { name: '关闭证据', exact: true }).click();
  assert.equal(await evidence.count(), 0);
  await capture('04-material-closed');
  await page.getByRole('button', { name: '返回包内最新', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value === '30' &&
      document.querySelectorAll('[data-trajectory-event]').length === 28,
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  await capture('05-package-latest');
  assert.equal(existsSync(fixture.profile.dataRoot), false);
  assert.equal(hash(), beforeHash);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
} finally {
  await app.close();
  writeFileSync(
    join(fixture.directory, 'observations.json'),
    JSON.stringify(
      {
        stages,
        errors,
        network,
        beforeHash,
        afterHash: hash(),
        profileCreated: existsSync(fixture.profile.dataRoot),
        exitCode: owner.exitCode,
      },
      null,
      2,
    ),
  );
}
assert.equal(owner.exitCode, 0);
console.log(
  JSON.stringify({ directory: fixture.directory, stages: stages.length, errors, network }),
);
