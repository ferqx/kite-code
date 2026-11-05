import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ElectronApplication } from 'playwright';
import { selectNativeFixtureModel } from './native-model-selection.fixture';

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    not: { toBe: (expected: unknown) => assert.notEqual(actual, expected) },
  };
}
const [root, firstUrl, secondUrl, executablePath, packagePath] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const { _electron } = createRequire(packagePath)('playwright') as typeof import('playwright');
let app: ElectronApplication | undefined;

const errors: string[] = [];
const origins: string[] = [];
const frames: unknown[] = [];
const launch = async (url: URL, index: number) => {
  origins.push(url.origin);
  app = await _electron.launch({
    executablePath,
    args: [
      join(root, 'main.cjs'),
      `--user-data-dir=${join(root, 'electron-data')}`,
      `--fixture-url=${url}`,
    ],
    timeout: 30000,
  });
  app.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await page.waitForSelector('[data-model-trigger]');
  await page.screenshot({ path: join(root, `loaded-${index}.png`) });
  frames.push({ index, phase: 'loaded', text: await page.locator('main').innerText() });
  return page;
};
const stop = async (index: number) => {
  for (const page of app!.windows())
    frames.push({
      index,
      samples: await page.evaluate(() => Reflect.get(window, 'modelPreferenceFrames')),
    });
  await app!.context().tracing.stop({ path: join(root, `trace-${index}.zip`) });
  const child = app!.process();
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  await app!.evaluate(({ app }) => app.quit());
  expect(await exited).toBe(0);
  app = undefined;
};
try {
  let page = await launch(new URL(firstUrl), 1);
  expect(await page.locator('[data-model-trigger]').innerText()).toBe('选择模型');
  expect(await page.getByRole('button', { name: '发送测试', exact: true }).isDisabled()).toBe(true);
  await selectNativeFixtureModel(page, 'Fixture B', 'b');
  await page.locator('[data-model-trigger]').click();
  await page.screenshot({ path: join(root, 'effort-before.png') });
  await page.getByRole('slider').focus();
  await page.keyboard.press('End');
  await page.screenshot({ path: join(root, 'effort-chosen.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() =>
    document.querySelector('[data-model-trigger]')?.textContent?.includes('Ultar'),
  );
  await page.waitForFunction(
    async () =>
      (await window.kiteNative!.readRecommendedModel!('store'))?.reasoningEffort === 'ultar',
  );
  frames.push({ phase: 'chosen', text: await page.locator('main').innerText() });
  await page.screenshot({ path: join(root, 'chosen.png') });
  await stop(1);
  page = await launch(new URL(secondUrl), 2);
  await page.waitForFunction(() =>
    document.querySelector('[data-model-trigger]')?.textContent?.includes('Fixture BUltar'),
  );
  expect(await page.getByRole('button', { name: '发送测试', exact: true }).isEnabled()).toBe(true);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  frames.push({ phase: 'cold-restored', text: await page.locator('main').innerText() });
  await page.screenshot({ path: join(root, 'cold-restored.png') });
  await page.getByRole('button', { name: '切换数据源', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-model-trigger]')?.textContent === '选择模型',
  );
  await page.screenshot({ path: join(root, 'other-store.png') });
  expect(await page.getByRole('button', { name: '发送测试', exact: true }).isDisabled()).toBe(true);
  await page.getByRole('button', { name: '切换数据源', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-model-trigger]')?.textContent?.includes('Fixture BUltar'),
  );
  expect(await page.getByRole('alert').count()).toBe(0);
  expect(errors).toEqual([]);
  expect(origins[0]).not.toBe(origins[1]);
  frames.push({ phase: 'store-restored', text: await page.locator('main').innerText() });
  await stop(2);
} finally {
  if (app) await app.close();
  await writeFile(join(root, 'report.json'), JSON.stringify({ origins, errors, frames }, null, 2));
  console.log('Model preference evidence:', root);
}
