import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WebContentsView } from 'electron';
import type { _electron as ElectronLauncher } from 'playwright';
import { loopbackModelEnvironment } from '../../../tests/fixtures/loopback-model-environment';
import type { NativeState } from '../src/native-bridge';
import { selectNativeFixtureModel } from './native-model-selection.fixture';
import { nativeRootPage } from './native-root-page.fixture';

const [root, outdir, executablePath, ownerPackage, origin] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const { _electron } = createRequire(ownerPackage)('playwright') as {
  _electron: typeof ElectronLauncher;
};
const stamps: { phase: string; at: number }[] = [];
const phase = (name: string) => {
  stamps.push({ phase: name, at: Date.now() });
  console.error('browser_background_phase', name);
};
phase('launch');
const app = await _electron.launch({
  executablePath,
  args: [outdir, `--user-data-dir=${join(root, 'electron-data')}`],
  cwd: outdir,
  env: {
    HOME: root,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    ...loopbackModelEnvironment(new URL(origin)),
  },
  timeout: 15000,
});
type Facts = {
  effects: { at: number; receipt: string }[];
  requests: string[];
  runs: { id: string; status: string; completedCursor: number | null }[];
  tools: { adapterId: string; state: string; completedCursor: number | null }[];
};
const facts = () => fetch(`${origin}/facts`).then((reply) => reply.json()) as Promise<Facts>;
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, name: string) {
  const deadline = Date.now() + 18000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw Error(`${name}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

try {
  const page = await nativeRootPage(app, 15000);
  page.setDefaultTimeout(12000);
  phase('window_ready');
  const state = () =>
    page.evaluate(async () => {
      const bridge = window.kiteNative!;
      return (await bridge.request({ method: 'state', generation: 1 })) as NativeState;
    });
  const select = async (title: string, sessionId: string) => {
    const button = page.getByRole('button', { name: title, exact: true });
    await button.click();
    await page.locator('.session-header').getByText(title, { exact: true }).waitFor();
    await until(state, (value) => value.selection?.session.id === sessionId, 'selection');
  };
  const observePage = () =>
    app.evaluate(async ({ BaseWindow, webContents }, url) => {
      const matches = webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL() === url);
      const contents = matches[0];
      if (matches.length !== 1 || !contents) return null;
      const views = BaseWindow.getAllWindows().flatMap((window) => window.contentView.children);
      const view = views.find(
        (candidate): candidate is WebContentsView =>
          'webContents' in candidate && candidate.webContents === contents,
      );
      if (!view) throw Error('exact_native_view_missing');
      return {
        id: contents.id,
        visible: view.getVisible(),
        document: (await contents.executeJavaScript(
          "({started:performance.timeOrigin,result:document.querySelector('#receipt')?.textContent})",
        )) as { started: number; result: string },
      };
    }, `${origin}/page`);
  await select('Browser A', 'browser-a');
  await selectNativeFixtureModel(page, 'fixture');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill(
      `BROWSER_BACKGROUND_ACCEPTANCE: use the browser to open ${origin}/page and press the local marker button once.`,
    );
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  phase('sent_a');
  const original = await until(
    observePage,
    (value) => value?.document.result === 'Not marked' && value.visible,
    'original_page_not_open',
  );
  assert.ok(original);
  await until(facts, (value) => value.requests.includes('later-tool-gated'), 'first_tool_not_done');
  assert.equal((await facts()).effects.length, 0);
  phase('initial_browser_tool_finished');

  await select('Browser B', 'browser-b');
  const hidden = await until(
    observePage,
    (value) => value?.visible === false,
    'original_page_not_hidden',
  );
  assert.deepEqual(hidden, { ...original, visible: false });
  const selectionAudit = await page.evaluateHandle(() => {
    const target = document.querySelector('.session-header');
    if (!target) throw Error('background_header_missing');
    const sample = () =>
      target.isConnected &&
      target.querySelector('.breadcrumb strong')?.textContent?.trim() === 'Browser B';
    const audit = { sawOther: !sample(), count: 0 };
    new MutationObserver(() => {
      audit.count++;
      if (!sample()) audit.sawOther = true;
    }).observe(document.documentElement, { subtree: true, attributes: true, childList: true });
    return audit;
  });
  phase('b_visible_a_hidden');
  const baseline = await facts();
  assert.equal(baseline.effects.length, 0);
  assert.equal(baseline.runs.length, 1);
  assert.equal(baseline.runs[0]?.completedCursor, null);
  const release = await fetch(`${origin}/release`, { method: 'POST' });
  assert.equal(release.status, 204);
  const acted = await until(
    facts,
    (value) => value.effects.length > 0,
    'background_page_effect_missing',
  );
  assert.equal(acted.effects.length, 1);
  assert.equal(acted.effects[0]?.receipt, 'marked');
  assert.equal((await state()).selection?.session.id, 'browser-b');
  phase('page_effect_observed_while_b_visible');

  const terminal = await until(
    facts,
    (value) => value.runs.some((run) => run.completedCursor !== null),
    'original_run_terminal_missing',
  );
  assert.equal(terminal.runs.length, 1);
  const run = terminal.runs[0]!;
  assert.equal(run.id, baseline.runs[0]?.id);
  assert.equal(run.status, 'completed');
  const ordered = terminal.tools.filter((tool) => tool.adapterId === 'browser.execute');
  assert.deepEqual(
    ordered.map((tool) => tool.state),
    ['succeeded', 'succeeded'],
  );
  assert.ok(ordered[0]?.completedCursor && ordered[1]?.completedCursor);
  assert.ok(
    ordered[0].completedCursor < ordered[1].completedCursor &&
      ordered[1].completedCursor < run.completedCursor!,
    'the two original tool receipts precede the same run terminal event',
  );
  assert.deepEqual(terminal.requests, ['initial-tool', 'later-tool-gated', 'final']);
  assert.equal(terminal.effects.length, 1);
  const finishedHidden = await observePage();
  assert.deepEqual(finishedHidden, {
    ...original,
    visible: false,
    document: { ...original.document, result: 'Marked' },
  });
  assert.equal((await state()).selection?.session.id, 'browser-b');
  assert.equal(await page.getByText('BACKGROUND MARKER COMPLETE', { exact: true }).count(), 0);
  const audit = await selectionAudit.jsonValue();
  assert.equal(audit.sawOther, false);
  await selectionAudit.dispose();
  phase('a_terminal_under_b');

  await select('Browser A', 'browser-a');
  await page.getByText('BACKGROUND MARKER COMPLETE', { exact: true }).waitFor();
  assert.equal(await page.getByText('BACKGROUND MARKER COMPLETE', { exact: true }).count(), 1);
  const restored = await observePage();
  assert.deepEqual(restored?.document, finishedHidden?.document);
  assert.equal(restored?.id, original.id);
  assert.equal((await facts()).effects.length, 1);
  phase('same_page_restored');
  writeFileSync(
    join(root, 'browser-background-evidence.json'),
    JSON.stringify(
      { stamps, terminal, original, hidden, finishedHidden, restored, audit },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('browser_background_failure', stamps.at(-1)?.phase, error);
  console.error('browser_background_last_facts', await facts().catch(() => null));
  const page = await nativeRootPage(app, 100).catch(() => null);
  if (page) {
    await page
      .screenshot({ path: join(root, 'browser-background-failure.png'), timeout: 2000 })
      .catch(() => {});
  }
  throw error;
} finally {
  phase('quit');
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
}
