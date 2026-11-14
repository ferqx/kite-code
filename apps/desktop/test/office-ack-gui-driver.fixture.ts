/** Opt-in real Electron/component ACK race check; synthetic accepted callback, no Service/Provider. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron, type Page } from 'playwright';

const root = resolve(process.argv[2]!);
const require = createRequire(import.meta.url);
const app = await _electron.launch({
  executablePath: require('electron') as string,
  args: [join(root, 'app'), `--fixture-root=${root}`, '--ack-race'],
});
try {
  const page = await app.firstWindow();
  await page
    .getByRole('button', { name: '请求修改', exact: true })
    .waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => {
    const zoom = document.querySelector<HTMLSelectElement>('[aria-label="预览缩放"]');
    return !!zoom && !zoom.disabled;
  });
  await page.getByRole('button', { name: '请求修改', exact: true }).click();
  let form: Page | undefined;
  const deadline = Date.now() + 15000;
  while (!form && Date.now() < deadline) {
    for (const candidate of app.windows())
      if (
        await candidate
          .locator('textarea')
          .isVisible()
          .catch(() => false)
      ) {
        form = candidate;
        break;
      }
    if (!form) await Bun.sleep(50);
  }
  assert.ok(form, 'real isolated request form appeared');
  await form.locator('textarea').fill('Synthetic ACK verification only; no model invocation.');
  await form.screenshot({ path: join(root, 'ack-form-before.png') });
  await form.locator('[data-send]').click();
  const events = () =>
    JSON.parse(readFileSync(join(root, 'events.json'), 'utf8')) as {
      method?: string;
      phase?: string;
      error?: string;
    }[];
  const end = Date.now() + 15000;
  while (
    !events().some((event) => event.method === 'outputs.preview.request.result') &&
    Date.now() < end
  )
    await Bun.sleep(50);
  const captured = events();
  assert.equal(captured.filter((event) => event.method === 'fixture.submit').length, 1);
  assert.ok(captured.some((event) => event.phase === 'accepted-controller-awaiting-poll'));
  assert.ok(captured.some((event) => event.phase === 'poll-retired-original'));
  assert.equal(
    captured.filter((event) => event.method === 'outputs.preview.request.result').length,
    1,
  );
  assert.ok(!captured.some((event) => event.error));
  await page.waitForTimeout(600); // Observe additional UI poll cycles, not model completion.
  assert.equal(events().filter((event) => event.method === 'fixture.submit').length, 1);
  assert.ok(!(await page.locator('body').innerText()).includes('预览回执暂时不可用'));
  assert.equal(form.isClosed(), true);
  await page.screenshot({ path: join(root, 'ack-completed-host.png') });
  const preview = app.windows().find((candidate) => candidate.url().startsWith('kite-preview:'));
  assert.ok(preview, 'document remains open after acknowledgement');
  await preview.screenshot({ path: join(root, 'ack-completed-preview.png') });
  writeFileSync(
    join(root, 'ack-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        providerRequests: 0,
        submissions: 1,
        scope: 'synthetic component GUI with deterministic settle delay; not real model success',
        checks: [
          'real form accepted',
          'production polling retired same request before settle returned',
          'one acknowledgement',
          'no acknowledgement error',
          'no resubmission',
          'preview retained',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
