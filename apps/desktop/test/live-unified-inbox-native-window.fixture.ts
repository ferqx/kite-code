import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { NativeState } from '../src/native-bridge';

// Private Node driver for the ordinary source-free Desktop candidate. Model
// requests belong to the runner's transparent Provider proxy, never this file.
const [candidate, home, control, receiptPath, desktopPackage] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const require = createRequire(desktopPackage);
const { _electron } = require('playwright') as typeof import('playwright');
type Scenario = 'idle' | 'active';
type OrdinaryMail = {
  id: string;
  name: string;
  body: string;
  sourceSessionId: string;
  sourceExecutionId: string;
  receivedRunId: string | null;
};
type Facts = {
  sessionId: string;
  title: string;
  originalRunId: string | null;
  rootActive: boolean;
  rootCompleted: boolean;
  rootRunIds: string[];
  childCount: number;
  childDone: boolean | number;
  ordinaryPending: number;
  ordinaryReceived: number;
  resultPending: number;
  resultReceived: number;
  receiptMode: string | null;
  receivedRunId: string | null;
  sourceId: string | null;
  holds: string[];
  physicalRequests: number;
  footprint: {
    runs: number;
    executions: number;
    commands: number;
    sources: number;
    controls: number;
  };
  mode: string;
  expectedCode: string;
  ordinaryMail: OrdinaryMail | null;
};
const identities = {
  idle: { sessionId: 'inbox-idle', title: '真实模型 · 结束后接收' },
  active: { sessionId: 'inbox-active', title: '真实模型 · 本轮接收' },
} as const;
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let page: Page | undefined;
let stage = 'initializing';
let scenario: Scenario = 'idle';
const deadline = Date.now() + 600000;
const checks: Record<string, boolean | number> = {};
const scenarios: Partial<Record<Scenario, Facts>> = {};
const observations: { stage: string; scenario: Scenario; at: number; facts: Facts }[] = [];
const frames: { file: string; stage: string; scenario: Scenario; at: number; layout: unknown }[] =
  [];
const frameDirectory = join(home, 'process-frames');
mkdirSync(frameDirectory, { recursive: true });
const manifest = join(frameDirectory, 'manifest.json');
let frameTimer: ReturnType<typeof setInterval> | undefined;
let frameSaving: Promise<void> | undefined;
let frameNumber = 0;
const heldSince = new Map<string, number>();

function log(next: string) {
  stage = next;
  console.log(JSON.stringify({ stage, scenario, at: Date.now() }));
}
function remaining() {
  assert.ok(Date.now() < deadline, `native_inbox_total_limit_at_${stage}`);
  for (const [gate, at] of heldSince)
    assert.ok(Date.now() - at < 55000, `native_inbox_gate_budget_${gate}_at_${stage}`);
}
async function response(path: string) {
  remaining();
  const result = await fetch(`${control}${path}`, { signal: AbortSignal.timeout(5000) });
  assert.ok(result.ok, `native_inbox_control_http_${result.status}_at_${stage}`);
  return result;
}
async function read(which = scenario): Promise<Facts> {
  const facts = (await (await response(`/state?scenario=${which}`)).json()) as Facts;
  assert.equal(facts.sessionId, identities[which].sessionId);
  assert.ok(Array.isArray(facts.holds));
  const now = Date.now();
  for (const gate of facts.holds) if (!heldSince.has(gate)) heldSince.set(gate, now);
  for (const gate of heldSince.keys()) if (!facts.holds.includes(gate)) heldSince.delete(gate);
  return facts;
}
async function until<T>(load: () => Promise<T>, predicate: (value: T) => boolean, label: string) {
  const end = Math.min(deadline, Date.now() + 45000);
  for (;;) {
    remaining();
    const value = await load();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, `native_inbox_${stage}_${label}_not_reached`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}
async function release(gate: string) {
  await response(`/release?gate=${encodeURIComponent(gate)}`);
  heldSince.delete(gate);
}
const nativeState = () =>
  page!.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
const bubbles = () => page!.locator('article[data-agent-result-source]');

async function layout() {
  return page!.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const input = document.querySelector<HTMLTextAreaElement>('textarea');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      focus: document.activeElement?.tagName,
      input: input ? { ...box(input), start: input.selectionStart, end: input.selectionEnd } : null,
      reading: [...document.querySelectorAll('.conversation-viewport')].map((element) => ({
        ...box(element),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      })),
      order: [...document.querySelectorAll('.agent-turn, article[data-agent-result-source]')].map(
        (element) => ({
          ...box(element),
          kind: element.classList.contains('agent-turn') ? 'turn' : 'result',
          sourceId: element.getAttribute('data-agent-result-source'),
          status: element.getAttribute('data-turn-status'),
        }),
      ),
      childPanels: document.querySelectorAll('.session-tab-child').length,
    };
  });
}
function startFrames() {
  frameTimer = setInterval(() => {
    if (!page || frameSaving || frameNumber >= 4000) return;
    const sample = { stage, scenario, at: Date.now() };
    const file = `${String(frameNumber++).padStart(4, '0')}-${sample.stage}.png`;
    frameSaving = (async () => {
      const geometry = await layout();
      await page!.screenshot({ path: join(frameDirectory, file), timeout: 5000 });
      frames.push({ file, ...sample, layout: geometry });
    })()
      .catch(() => {})
      .finally(() => {
        frameSaving = undefined;
      });
  }, 150);
}
async function shot(name: string, facts?: Facts) {
  remaining();
  if (facts) observations.push({ stage, scenario, at: Date.now(), facts });
  await page!.screenshot({ path: join(home, `${name}.png`), fullPage: true });
  writeFileSync(manifest, JSON.stringify(frames));
}
async function launch() {
  log('launch_process');
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  startFrames();
}
async function close() {
  clearInterval(frameTimer);
  await frameSaving;
  writeFileSync(manifest, JSON.stringify(frames));
  if (!app) return;
  const owned = app;
  const process = owned.process();
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app: electron }) => electron.quit());
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`native_inbox_exit_timeout_at_${stage}`)),
        20000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(process.exitCode, 0, 'ordinary Native process exited cleanly');
  app = undefined;
  page = undefined;
}
async function select(which: Scenario, cold = false) {
  scenario = which;
  log(`select_${which}`);
  await page!
    .getByRole('button', { name: identities[which].title, exact: true })
    .and(page!.locator('button.session-row'))
    .click();
  await page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  const confirm = page!.getByRole('button', { name: '确认项目读取范围', exact: true });
  const readiness = await until(
    async () => ({
      needsTrust: await confirm.isVisible(),
      state: await nativeState(),
    }),
    (value) =>
      value.needsTrust ||
      (value.state.selection?.session.id === identities[which].sessionId &&
        !value.state.selection.viewLoading),
    'selection_or_trust',
  );
  if (readiness.needsTrust) {
    assert.ok(!cold, 'cold reading cannot change workspace trust');
    await confirm.click();
    await page!
      .getByRole('checkbox', { name: '我已核对所显示的项目及读取范围', exact: true })
      .check();
    await page!.getByRole('button', { name: '允许读取所显示的范围', exact: true }).click();
    await confirm.waitFor({ state: 'detached' });
    checks.workspaceTrustViaOrdinaryUI = true;
  }
  await until(
    nativeState,
    (value) =>
      value.selection?.session.id === identities[which].sessionId && !value.selection.viewLoading,
    'exact_root_history',
  );
  assert.equal(await page!.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  checks.diagnosticsClosed = true;
}
async function send(which: Scenario) {
  log(`${which}_permission`);
  if ((await read()).mode !== 'full') {
    await page!.locator('[data-permission-trigger]').click();
    await page!.getByRole('menuitemradio', { name: /^(Full permission|完全访问)/ }).click();
    await page!
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(Enable Full|启用完全权限)$/ })
      .click();
    await until(read, (facts) => facts.mode === 'full', 'full_via_ui');
  }
  checks[`${which}FullViaOrdinaryUI`] = true;
  log(`${which}_send`);
  const prompt = await (await response(`/prompt?scenario=${which}`)).text();
  assert.ok(prompt.trim());
  await page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(prompt);
  const button = page!.getByRole('button', { name: '发送明确的新轮次', exact: true });
  await until(() => button.isEnabled(), Boolean, 'ordinary_send_enabled');
  await button.click();
}
async function assertBubble(sourceId: string, expectedCode: string) {
  const card = page!.locator(`article[data-agent-result-source="${sourceId}"]`);
  await card.waitFor();
  assert.equal(await bubbles().count(), 1);
  assert.equal(await card.count(), 1);
  const heading = await card.locator('.message-label').innerText();
  assert.match(heading, /Agent\s*发送/);
  const content = (await card.locator('.typeset-chat').innerText()).trim();
  assert.ok(content.length > 0, 'result body is visible independently of the parent reply');
  assert.ok(
    expectedCode && content.includes(expectedCode),
    'the actual material verification code is visible',
  );
  assert.equal(await card.evaluate((element) => !!element.closest('.agent-turn')), false);
  return { heading, content };
}

async function assertOrdinaryMail(facts: Facts, expectedRunId: string, screenshot?: string) {
  const mail = facts.ordinaryMail;
  assert.ok(mail, 'the runner found the actual send_agent_message input and receipt');
  assert.ok(mail.id && mail.name && mail.body.trim());
  assert.notEqual(mail.sourceSessionId, facts.sessionId);
  assert.ok(mail.sourceExecutionId);
  assert.equal(mail.receivedRunId, expectedRunId);
  assert.equal(facts.ordinaryReceived, 1);
  const summaries = page!.locator('.agent-turn-summary[aria-expanded]');
  const opened = new Set<number>();
  const reading = await page!
    .locator('.conversation-viewport')
    .evaluateAll((elements) => elements.map((element) => element.scrollTop));
  try {
    const card = page!.locator(`article[data-agent-message-id="${mail.id}"]`);
    await until(
      async () => {
        // Store completion can precede the renderer's terminal regrouping.
        // Wait for that projection, then reopen only collapsed processes on
        // each attempt in case settlement replaced an earlier expanded node.
        if (
          facts.rootCompleted &&
          (await page!.locator('.agent-turn[data-turn-status="running"]').count()) > 0
        )
          return false;
        for (let index = 0; index < (await summaries.count()); index++) {
          if ((await summaries.nth(index).getAttribute('aria-expanded')) === 'false') {
            await summaries.nth(index).click();
            opened.add(index);
          }
        }
        return (await card.count()) === 1 && (await card.isVisible());
      },
      (visible) => visible,
      'exact_ordinary_mail_visible_after_settlement',
    );
    assert.equal(await page!.locator('article[data-agent-message-id]').count(), 1);
    assert.equal(await card.getAttribute('data-agent-result-source'), null);
    const heading = await card.locator('.message-label').innerText();
    assert.ok(heading.includes(`${mail.name} Agent 发送`), 'the sender label is Core-confirmed');
    const body = await card.locator('.typeset-chat').innerText();
    const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    assert.equal(
      normalize(body),
      normalize(mail.body),
      'the entire real send input is displayed exactly once',
    );
    assert.ok(
      body.includes(facts.expectedCode),
      'ordinary mail contains the actual material verification code',
    );
    const placement = await card.evaluate((element) => ({
      insideProcess: !!element.closest('.agent-turn-process-messages'),
      insideTurn: !!element.closest('.agent-turn'),
      independentUserBubble: element.classList.contains('user'),
    }));
    assert.equal(placement.insideProcess, true);
    assert.equal(placement.insideTurn, true);
    assert.equal(placement.independentUserBubble, false);
    assert.equal(
      await page!
        .getByText('Agent message (untrusted data; no additional authorization)', { exact: true })
        .count(),
      0,
      'internal model transport headers never become public mail bodies',
    );
    await card.scrollIntoViewIfNeeded();
    if (screenshot) await shot(screenshot, facts);
  } finally {
    for (const index of [...opened].reverse()) {
      if ((await summaries.nth(index).getAttribute('aria-expanded')) === 'true')
        await summaries.nth(index).click();
    }
    await page!.locator('.conversation-viewport').evaluateAll((elements, positions) => {
      elements.forEach((element, index) => {
        if (positions[index] !== undefined) element.scrollTop = positions[index]!;
      });
    }, reading);
  }
}

try {
  await launch();
  await select('idle');
  await send('idle');
  log('idle_parent_ended_child_running');
  const ended = await until(
    read,
    (facts) =>
      facts.holds.includes('idle-child-first') &&
      facts.rootCompleted &&
      !facts.rootActive &&
      facts.childCount === 1,
    'parent_ended_child_gate',
  );
  assert.equal(ended.resultReceived, 0);
  await shot('01-parent-ended-child-running', ended);
  await release('idle-child-first');
  log('idle_ordinary_mail_queued');
  const queued = await until(
    read,
    (facts) => facts.holds.includes('idle-child-final') && facts.ordinaryPending === 1,
    'ordinary_mail_queue_only',
  );
  assert.equal(queued.ordinaryReceived, 0);
  assert.equal(queued.rootActive, false);
  assert.deepEqual(queued.rootRunIds, [ended.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  assert.equal(await page!.locator('article[data-agent-message-id]').count(), 0);
  await shot('02-ordinary-mail-queued', queued);
  checks.idleOrdinaryMailDoesNotWake = true;
  await release('idle-child-final');
  log('idle_result_before_parent_reply');
  const idleReceived = await until(
    read,
    (facts) =>
      facts.holds.includes('idle-parent-result') &&
      facts.resultReceived === 1 &&
      facts.ordinaryReceived === 1 &&
      facts.receiptMode === 'idle_new_turn' &&
      facts.rootActive,
    'conditional_idle_result_received',
  );
  assert.ok(idleReceived.sourceId);
  assert.ok(idleReceived.receivedRunId && idleReceived.receivedRunId !== ended.originalRunId);
  assert.equal(idleReceived.rootRunIds.length, 2);
  const idleBody = await assertBubble(idleReceived.sourceId, idleReceived.expectedCode);
  await assertOrdinaryMail(idleReceived, idleReceived.receivedRunId);
  checks.ordinaryMailNotRenderedAsUserPlaceholder = true;
  checks.idleOrdinarySenderAndEntireBodyVisibleOnce = true;
  await shot('03-idle-result-before-parent-reply', idleReceived);
  checks.idleConditionalContinuation = true;
  checks.idleResultVisibleBeforeParentReply = true;
  await release('idle-parent-result');
  log('idle_complete');
  scenarios.idle = await until(
    read,
    (facts) =>
      facts.rootCompleted && !facts.rootActive && !!facts.childDone && facts.resultReceived === 1,
    'idle_all_terminal',
  );
  assert.deepEqual(await assertBubble(idleReceived.sourceId, idleReceived.expectedCode), idleBody);
  await assertOrdinaryMail(scenarios.idle, idleReceived.receivedRunId);
  await shot('04-idle-complete', scenarios.idle);

  await select('active');
  await send('active');
  log('active_parent_running');
  const running = await until(
    read,
    (facts) =>
      facts.holds.includes('active-parent-checkpoint') &&
      facts.holds.includes('active-child-first') &&
      facts.rootActive &&
      facts.childCount === 1,
    'both_active_gates',
  );
  assert.ok(running.originalRunId);
  await shot('05-parent-running', running);
  await release('active-child-first');
  log('active_ordinary_mail_queued');
  await until(
    read,
    (facts) => facts.holds.includes('active-child-final') && facts.ordinaryPending === 1,
    'active_ordinary_mail_pending',
  );
  await release('active-child-final');
  log('active_child_completed_parent_inflight');
  const pending = await until(
    read,
    (facts) =>
      !!facts.childDone &&
      facts.resultPending === 1 &&
      facts.resultReceived === 0 &&
      facts.holds.includes('active-parent-checkpoint'),
    'result_waits_for_parent_checkpoint',
  );
  assert.equal(pending.rootActive, true);
  assert.deepEqual(pending.rootRunIds, [running.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  await shot('06-child-completed-parent-inflight', pending);
  await release('active-parent-checkpoint');
  log('active_received_in_process');
  const activeReceived = await until(
    read,
    (facts) =>
      facts.holds.includes('active-parent-result') &&
      facts.resultReceived === 1 &&
      facts.ordinaryReceived === 1 &&
      facts.receiptMode === 'active' &&
      facts.receivedRunId === facts.originalRunId &&
      facts.rootActive,
    'same_run_result_received',
  );
  assert.ok(activeReceived.sourceId);
  assert.deepEqual(activeReceived.rootRunIds, [running.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  const activeProcesses = page!.locator('.agent-turn[data-turn-status="running"]');
  checks.activeSingleProcessForOriginalRun = (await activeProcesses.count()) === 1;
  assert.equal(
    checks.activeSingleProcessForOriginalRun,
    true,
    'mail stays inline in the original parent process',
  );
  await assertOrdinaryMail(activeReceived, running.originalRunId, '12-active-ordinary-mail-detail');
  checks.activeOrdinarySenderAndEntireBodyVisibleOnce = true;
  const events = page!
    .locator('.agent-turn[data-turn-status="running"] .tool-activity-summary')
    .filter({ hasText: '等待 Agent 事件' })
    .last();
  await events.waitFor();
  await events.click();
  await until(
    () => activeProcesses.allTextContents().then((texts) => texts.join('\n')),
    (text) => text.includes('"kind":"completed"'),
    'completed_wait_agent_events_visible',
  );
  await shot('07-active-received-in-process', activeReceived);
  checks.activeResultOnlyInOriginalProcess = true;
  await events.click();
  log('active_child_result_detail');
  await page!
    .getByRole('button', { name: /^查看子 Agent 详情：/ })
    .last()
    .click();
  const detail = page!.locator('.session-tab-child');
  await detail.waitFor();
  const finalReply = detail
    .locator('article[data-final-reply="true"]')
    .last()
    .locator('.typeset-chat');
  await until(
    () => finalReply.allTextContents().then((texts) => texts.join('\n')),
    (text) => !!activeReceived.expectedCode && text.includes(activeReceived.expectedCode),
    'actual_child_final_reply',
  );
  assert.equal(await bubbles().count(), 0);
  await shot('08-active-child-result-detail', activeReceived);
  await page!.getByRole('button', { name: '收起标签栏', exact: true }).click();
  checks.activeChildResultDetailVisible = true;
  await release('active-parent-result');
  log('active_completed');
  scenarios.active = await until(
    read,
    (facts) =>
      facts.rootCompleted && !facts.rootActive && !!facts.childDone && facts.resultReceived === 1,
    'active_all_terminal',
  );
  assert.deepEqual(scenarios.active.rootRunIds, [running.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  assert.equal(await page!.locator('.agent-turn').count(), 1);
  await assertOrdinaryMail(scenarios.active, running.originalRunId);
  await shot('09-active-completed', scenarios.active);
  checks.activeNoRetroactiveBubble = true;

  log('cold_close');
  const before = { idle: await read('idle'), active: await read('active') };
  await close();
  checks.firstCleanExit = true;
  heldSince.clear();
  await launch();
  for (const which of ['idle', 'active'] as const) {
    await select(which, true);
    log(`cold_${which}`);
    await until(
      () => page!.locator('article[data-final-reply="true"]').count(),
      (count) => count > 0,
      'cold_parent_final_reply_loaded',
    );
    if (which === 'idle')
      assert.deepEqual(
        await assertBubble(idleReceived.sourceId, idleReceived.expectedCode),
        idleBody,
      );
    else assert.equal(await bubbles().count(), 0);
    const after = await read(which);
    assert.equal(after.physicalRequests, before[which].physicalRequests);
    assert.deepEqual(after.footprint, before[which].footprint);
    assert.deepEqual(after.rootRunIds, before[which].rootRunIds);
    assert.equal(after.sourceId, before[which].sourceId);
    assert.equal(after.resultReceived, 1);
    const expectedRun = which === 'idle' ? idleReceived.receivedRunId : running.originalRunId;
    await assertOrdinaryMail(after, expectedRun);
    if (which === 'active') assert.equal(await page!.locator('.agent-turn').count(), 1);
    await shot(which === 'idle' ? '10-cold-idle' : '11-cold-active', after);
  }
  checks.coldNoProviderReplay = true;
  checks.coldNoRunExecutionCommandSourceControlMutation = true;
  checks.ordinaryMailCompleteAndColdNoDuplicate = true;
  await close();
  checks.cleanWindowExit = true;
  checks.continuousFrames = frames.length;
  log('complete');
  const passed = Object.values(checks).every((value) => value !== false);
  writeFileSync(
    receiptPath,
    JSON.stringify({
      passed,
      stage,
      failurePoint: passed ? null : 'ordinary_mail_public_projection_and_turn_grouping',
      checks,
      scenarios,
      observations,
      frames: { count: frames.length, manifest },
    }),
  );
} catch (error) {
  if (page) {
    try {
      await page.screenshot({ path: join(home, 'failure.png'), fullPage: true, timeout: 5000 });
      writeFileSync(manifest, JSON.stringify(frames));
    } catch {}
  }
  writeFileSync(
    receiptPath,
    JSON.stringify({
      passed: false,
      stage,
      checks,
      scenarios,
      observations,
      frames: { count: frames.length, manifest },
      failureKind: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await close();
  } catch {
    process.exitCode = 1;
  }
}
