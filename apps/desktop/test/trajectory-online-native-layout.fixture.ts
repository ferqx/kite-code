import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Supplement an existing owned run. No new Model request, gate or product control is created.
const [fixturePath, packagePath] = process.argv.slice(2) as [string, string];
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  directory: string;
  outdir: string;
  profile: { dataRoot: string; profile: string };
};
const require = createRequire(packagePath),
  { _electron } = require('playwright') as typeof import('playwright');
function facts() {
  const db = new DatabaseSync(join(fixture.profile.dataRoot, fixture.profile.profile, 'core.db'), {
    readOnly: true,
  });
  try {
    return {
      metadata: db
        .prepare('SELECT store_id,CAST(last_change_cursor AS TEXT) AS cursor FROM storage_meta')
        .get(),
      executions: db
        .prepare(
          'SELECT id,kind,state,CAST(result_revision AS TEXT) AS revision FROM execution ORDER BY id',
        )
        .all(),
      commands: db.prepare('SELECT id,kind,status FROM command ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}
const before = facts(),
  errors: string[] = [];
const app = await _electron.launch({
  executablePath: require('electron') as string,
  args: [fixture.outdir, `--user-data-dir=${join(fixture.directory, 'electron-data')}`],
  cwd: fixture.outdir,
  env: {
    HOME: join(fixture.directory, 'home'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
  },
  timeout: 20000,
});
const processOwner = app.process();
try {
  const deadline = Date.now() + 20000;
  let page: import('playwright').Page | undefined;
  while (!page) {
    page = app.windows().find((target) => target.url().endsWith('/index.html'));
    if (!page) {
      if (Date.now() > deadline) throw Error('root renderer unavailable');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Trajectory A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Trajectory A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  await page.getByRole('region', { name: '执行轨迹', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Trajectory B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Trajectory B', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  const geometry = await page.evaluate(async () => {
    const samples: unknown[] = [];
    let last = '',
      stable = 0;
    for (let frame = 0; frame < 300; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const panel = document.querySelector<HTMLElement>('.trajectory-panel'),
        bounds = panel?.getBoundingClientRect();
      const value = {
        at: performance.now(),
        innerWidth,
        innerHeight,
        root: document.getElementById('root')?.getBoundingClientRect().toJSON(),
        body: document.body.getBoundingClientRect().toJSON(),
        bodyScrollWidth: document.body.scrollWidth,
        documentWidth: document.documentElement.clientWidth,
        panel: bounds?.toJSON(),
        cursor: document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value,
        loading: panel?.textContent?.includes('正在读取已保存轨迹'),
        eventCount: document.querySelectorAll('[data-trajectory-event]').length,
      };
      samples.push(value);
      const signature = JSON.stringify([bounds?.x, bounds?.y, bounds?.width, bounds?.height]);
      stable = signature === last ? stable + 1 : 0;
      last = signature;
      if (
        panel &&
        bounds &&
        bounds.width > 200 &&
        stable >= 12 &&
        !value.loading &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth + 1 &&
        bounds.bottom <= innerHeight + 1
      )
        return { samples, final: value };
    }
    throw Error('trajectory layout did not settle fully inside viewport');
  });
  const native = await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows().map((window) => ({
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
      contentSize: window.getContentSize(),
    })),
  );
  assert.equal(await page.getByText('STREAM_PREFIX_ONE', { exact: false }).count(), 0);
  assert.equal(await page.getByText('STREAM_FINAL_TAIL', { exact: false }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '轨迹证据', exact: true }).count(), 0);
  await page.screenshot({ path: join(fixture.directory, '08-other-session-layout-stable.png') });
  writeFileSync(
    join(fixture.directory, '08-other-session-layout-stable.json'),
    JSON.stringify({ geometry, native, errors }, null, 2),
  );
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
const after = facts();
assert.deepEqual(after, before, 'cold layout observation performed business work');
writeFileSync(
  join(fixture.directory, '08-cold-layout-facts.json'),
  JSON.stringify(
    {
      before,
      after,
      cleanup: {
        pid: processOwner.pid,
        exitCode: processOwner.exitCode,
        signalCode: processOwner.signalCode,
      },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    result: 'stable_session_b_layout_verified',
    directory: fixture.directory,
    zeroBusinessChanges: true,
    exitCode: processOwner.exitCode,
  }),
);
