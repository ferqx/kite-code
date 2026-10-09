import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function openCompletedProcess(page: import('playwright').Page) {
  phase('process_toggle_begin');
  const toggle = page
    .locator('.agent-turn-summary-row')
    .getByRole('button', { name: /，(?:展开|收起)本轮处理过程$/ });
  await toggle.waitFor();
  const expanded = await toggle.getAttribute('aria-expanded');
  phase(
    expanded === 'true'
      ? 'process_toggle_expanded_true'
      : expanded === 'false'
        ? 'process_toggle_expanded_false'
        : 'process_toggle_expanded_missing',
  );
  if (expanded !== 'true') await toggle.click();
  await page
    .locator('.agent-turn-summary-row')
    .getByRole('button', { name: /，收起本轮处理过程$/ })
    .waitFor();
  phase('process_toggle_complete');
}

const [outdir, root, _dataRoot, _storeId, _endpoint, electronExecutable, control, bunExecutable] =
  process.argv.slice(2) as string[];
const phase = (phase: string) =>
  console.log(JSON.stringify({ stage: 'native_history_phase', phase, at: Date.now(), root }));
phase('launch_begin');
const app = await _electron.launch({
  executablePath: electronExecutable,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 10000,
});
console.log(
  JSON.stringify({
    stage: 'native_history_phase',
    phase: 'launch_complete',
    at: Date.now(),
    root,
    mainPID: app.process().pid,
  }),
);
let assertions = 0;
function eq(actual: unknown, expected: unknown) {
  assert.equal(actual, expected);
  assertions++;
}
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  phase('initial_read_begin');
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByText('LARGE_HISTORY_TAIL_5051', { exact: false }).first().waitFor();
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
    .waitFor();
  await openCompletedProcess(page);
  eq(await page.locator('article').count(), 5051);
  phase('initial_complete_5051');
  eq(
    await page
      .locator('article .typeset-chat > p')
      .getByText('STORED_SHORT_1', { exact: true })
      .count(),
    1,
  );
  eq(
    await page
      .locator('article .typeset-chat > p')
      .getByText('STORED_SHORT_5001', { exact: true })
      .count(),
    1,
  );
  eq((await page.locator('main').textContent())!.includes('LARGE_HISTORY_TAIL_5051'), true);
  eq(Number(await (await fetch(`${control}/count`)).text()), 0);
  phase('failed_refresh_begin');
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__historyOriginal=original;globalThis.__historyFail=true;globalThis.fetch=(input,init)=>{const request=new Request(input,init);if(globalThis.__historyFail&&request.method==='GET'&&new URL(request.url).pathname.endsWith('/sessions/s/messages')){globalThis.__historyFail=false;return Promise.reject(new TypeError('owned_history_page_failed'));}return original(input,init);};})()`,
  );
  await page.evaluate(async () => {
    const facts = await window.kiteNative!.request({
      method: 'session.observe',
      generation: 1,
      sessionId: 's',
    });
    if (!facts || !('observationId' in facts))
      throw Error('history_notification_scope_unavailable');
    await window.kiteNative!.request({
      method: 'session.rename',
      generation: 1,
      observationId: facts.observationId,
      title: 'Native A',
    });
  });
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史尚未完整校准；已有正文仍可阅读，当前执行事实不可用。$/ })
    .waitFor();
  eq(await page.locator('article').count(), 5051);
  eq((await page.locator('main').textContent())!.includes('LARGE_HISTORY_TAIL_5051'), true);
  eq(await page.getByRole('button', { name: '发送明确的新轮次' }).isEnabled(), false);
  phase('failure_original_body_retained');
  phase('reload_begin');
  await page.getByRole('button', { name: '重新加载会话', exact: true }).click();
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
    .waitFor();
  await openCompletedProcess(page);
  phase('reload_complete');
  phase('held_refresh_begin');
  await app.evaluate(
    `(()=>{globalThis.__historyHeld=false;globalThis.__historyRelease=undefined;globalThis.fetch=async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);const response=await globalThis.__historyOriginal(input,init);if(!globalThis.__historyHeld&&url.pathname.endsWith('/sessions/s/messages')&&Number(url.searchParams.get('afterSeq'))>=200){globalThis.__historyHeld=true;await new Promise(resolve=>globalThis.__historyRelease=resolve);}return response;};})()`,
  );
  await page.evaluate(async () => {
    const facts = await window.kiteNative!.request({
      method: 'session.observe',
      generation: 1,
      sessionId: 's',
    });
    if (!facts || !('observationId' in facts))
      throw Error('history_notification_scope_unavailable');
    await window.kiteNative!.request({
      method: 'session.rename',
      generation: 1,
      observationId: facts.observationId,
      title: 'Native A',
    });
  });
  const deadline = Date.now() + 10000;
  while (!(await app.evaluate('globalThis.__historyHeld'))) {
    if (Date.now() >= deadline) throw Error('history_barrier_timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
  phase('history_page_held');
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
  await openSessionTools(page);
  await app.evaluate('globalThis.__historyRelease();globalThis.fetch=globalThis.__historyOriginal');
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
    .waitFor();
  eq(await page.locator('article').count(), 0);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByText('LARGE_HISTORY_TAIL_5051', { exact: false }).first().waitFor();
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
    .waitFor();
  await openCompletedProcess(page);
  eq(await page.locator('article').count(), 5051);
  eq(Number(await (await fetch(`${control}/count`)).text()), 0);
  phase('held_switchback_complete_5051');
  // Disconnect the owned real SSE socket, commit a real HTTP change while disconnected,
  // then advance only this fixture's replay floor. No reset/ready callback is injected.
  type NetworkFacts = {
    events: { after: string; status: number }[];
    ready: number;
    changes: number;
    posts: string[];
    messages: { session: string; after: string; upper: string }[];
    paused: boolean;
    held: boolean;
  };
  const network = (): Promise<NetworkFacts> =>
    app.evaluate(
      `(()=>{const n=globalThis.__nativeHistoryNetwork;return {events:n.events,ready:n.ready,changes:n.changes,posts:n.posts,messages:n.messages,paused:!!n.release,held:n.held};})()`,
    ) as Promise<NetworkFacts>;
  async function until(expression: string) {
    const deadline = Date.now() + 10000;
    while (!(await app.evaluate(expression))) {
      if (Date.now() >= deadline) throw Error(`physical_gap_barrier_timeout:${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  async function rename(title: string) {
    await page.evaluate(async (title) => {
      const facts = await window.kiteNative!.request({
        method: 'session.observe',
        generation: 1,
        sessionId: 's',
      });
      if (!facts || !('observationId' in facts)) throw Error('gap_rename_scope_unavailable');
      await window.kiteNative!.request({
        method: 'session.rename',
        generation: 1,
        observationId: facts.observationId,
        title,
      });
    }, title);
  }
  const beforeGap = await network();
  eq(beforeGap.ready >= 1, true);
  const gapFacts: unknown[] = [];
  for (const switchDuringRead of [false, true]) {
    const before = await network();
    const gap = switchDuringRead ? 'sse_two' : 'sse_one';
    phase(`${gap}_reset_begin`);
    await app.evaluate(
      `(()=>{const n=globalThis.__nativeHistoryNetwork;n.pause=true;n.release=undefined;n.held=false;n.abort.abort();})()`,
    );
    await until('!!globalThis.__nativeHistoryNetwork.release');
    await rename(switchDuringRead ? 'Native A gap two' : 'Native A gap one');
    const floor = await (await fetch(`${control}/expire-history-cursor`)).json();
    eq(floor.store_id, _storeId);
    eq(floor.replay_floor, floor.last_change_cursor);
    await app.evaluate(
      `(()=>{const n=globalThis.__nativeHistoryNetwork;n.holdHistory=${switchDuringRead};n.pause=false;const release=n.release;n.release=undefined;release();})()`,
    );
    await until(
      `globalThis.__nativeHistoryNetwork.events.slice(${before.events.length}).some(e=>e.status===410)`,
    );
    phase(`${gap}_reset_410`);
    if (switchDuringRead) {
      await until('globalThis.__nativeHistoryNetwork.held');
      const held = await network();
      eq(held.ready, before.ready);
      eq(await page.locator('article').count(), 5051);
      eq((await page.locator('main').textContent())!.includes('LARGE_HISTORY_TAIL_5051'), true);
      eq(await page.getByRole('button', { name: '发送明确的新轮次' }).isEnabled(), false);
      await page.getByRole('button', { name: 'Native B', exact: true }).click();
      await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
      await openSessionTools(page);
      await app.evaluate('globalThis.__nativeHistoryNetwork.releaseHistory()');
    }
    phase(`${gap}_ready_begin`);
    await until(`globalThis.__nativeHistoryNetwork.ready>${before.ready}`);
    phase(`${gap}_ready_complete`);
    await page
      .locator('[role="status"]')
      .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
      .waitFor();
    if (switchDuringRead) {
      eq(await page.locator('article').count(), 0);
      eq((await page.locator('main').textContent())!.includes('LARGE_HISTORY_TAIL_5051'), false);
      await page.getByRole('button', { name: 'Native A gap two', exact: true }).click();
      await page.getByText('LARGE_HISTORY_TAIL_5051', { exact: false }).first().waitFor();
      await page
        .locator('[role="status"]')
        .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
        .waitFor();
    }
    await openCompletedProcess(page);
    eq(await page.locator('article').count(), 5051);
    eq(
      await page
        .locator('article .typeset-chat > p')
        .getByText('STORED_SHORT_1', { exact: true })
        .count(),
      1,
    );
    eq(
      await page
        .locator('article .typeset-chat > p')
        .getByText('STORED_SHORT_5001', { exact: true })
        .count(),
      1,
    );
    phase(`${gap}_history_complete_5051`);
    const after = await network();
    eq(after.posts.length, before.posts.length + 1);
    const expired = after.events.slice(before.events.length).find((event) => event.status === 410)!;
    eq(BigInt(expired.after) < BigInt(floor.replay_floor), true);
    eq(
      after.events
        .slice(before.events.length)
        .some((event) => event.status === 200 && BigInt(event.after) >= BigInt(floor.replay_floor)),
      true,
    );
    await page.waitForFunction(async () => {
      const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
      return state && 'selection' in state && state.selection?.permissionUnavailable === false;
    });
    const reads = after.messages
      .slice(before.messages.length)
      .filter((read) => read.session === 's');
    eq(
      reads.some((read) => read.after === '0'),
      true,
    );
    eq(
      reads.some((read) => Number(read.after) > 5001),
      true,
    );
    gapFacts.push({
      floor,
      reconnects: after.events.slice(before.events.length),
      ready: after.ready,
      readPages: reads.length,
      switchDuringRead,
    });
  }
  // A fresh business HTTP event must still refresh this exact selected view after new ready.
  const beforeLive = await network();
  phase('live_rename_begin');
  await rename('Native A after physical gap');
  await until(`globalThis.__nativeHistoryNetwork.changes>${beforeLive.changes}`);
  await page
    .locator('.session-header')
    .getByTitle('Native A after physical gap', { exact: true })
    .waitFor();
  await openSessionTools(page);
  await page
    .locator('[role="status"]')
    .filter({ hasText: /^历史已完整读取至固定高水位；当前执行事实仍须核实。$/ })
    .waitFor();
  eq((await network()).posts.length, beforeLive.posts.length + 1);
  eq((await network()).posts.length, beforeGap.posts.length + 3);
  eq(
    (await network()).posts.every((path) => path === '/v1/sessions/s/rename'),
    true,
  );
  await openCompletedProcess(page);
  eq(await page.locator('article').count(), 5051);
  eq(Number(await (await fetch(`${control}/count`)).text()), 0);
  phase('live_rename_complete_5051');
  console.log('Physical SSE gap facts:', JSON.stringify(gapFacts));
  const parent = await app.evaluate(() => process.pid);
  const line = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .split('\n')
    .find((line) => {
      const parts = line.trim().split(/\s+/);
      return Number(parts[1]) === parent && parts.slice(2).join(' ') === bunExecutable;
    });
  const pid = Number(line?.trim().split(/\s+/)[0]);
  eq(pid > 0, true);
  phase('app_quit_begin');
  await app.evaluate(({ app }) => app.quit());
  phase('app_quit_complete');
  phase('app_close_begin');
  await app.close();
  phase('app_close_complete');
  let stopped = false;
  try {
    process.kill(pid, 0);
  } catch {
    stopped = true;
  }
  eq(stopped, true);
  phase('service_pid_stopped');
  console.log(
    'Native History Node assertions:',
    assertions,
    JSON.stringify({ pid, stopped, storedShortMessages: 5001, providerCalls: 0 }),
  );
} catch (error) {
  phase('failure_catch');
  console.error(error);
  console.error(
    'physical_network',
    await app
      .evaluate(
        'JSON.stringify(globalThis.__nativeHistoryNetwork,(key,value)=>["abort","release","releaseHistory"].includes(key)?undefined:value)',
      )
      .catch(() => 'unavailable'),
  );
  console.error(
    'history_last_article',
    await app
      .windows()[0]
      ?.locator('article')
      .last()
      .textContent()
      .then((text) => text?.slice(-200))
      .catch(() => 'unavailable'),
  );
  console.error(
    'history_has_tail',
    await app
      .windows()[0]
      ?.locator('main')
      .textContent()
      .then((text) => text?.includes('LARGE_HISTORY_TAIL_5051'))
      .catch(() => false),
  );
  console.error(
    'history_dom',
    await app
      .windows()[0]
      ?.locator('main')
      .innerText()
      .then((text) => text.slice(0, 1200))
      .catch(() => 'unavailable'),
  );
  console.error(
    'history_status',
    await app
      .windows()[0]
      ?.getByRole('status')
      .allTextContents()
      .catch(() => []),
  );
  console.error(
    'history_articles',
    await app
      .windows()[0]
      ?.locator('article')
      .count()
      .catch(() => -1),
  );
  phase('failure_close_begin');
  await app.close().catch(() => {});
  phase('failure_close_complete');
  throw error;
}
